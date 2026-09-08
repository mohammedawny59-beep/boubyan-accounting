#!/usr/bin/env node
'use strict';
/**
 * استعادة نسخة احتياطية لمستأجر واحد فقط — Tenant-Scoped Restore
 *
 * التشغيل:
 *   node scripts/tenant-restore.js <ملف النسخة> --tenant=<المعرّف> --target=<اسم الوجهة> [--yes] [--force-unlock]
 *
 * ⚠️ خطير: يستبدل بيانات هذا المستأجر فقط. لا يمسّ أي مستأجر آخر، ولا يمسّ
 *    scripts/restore.js أو npm run restore بأي شكل.
 *
 * حالة هذا الملف: يطبّق حتى نهاية Step 3 (التجهيز غير المتصل بدون أي كتابة
 * حية على Mongo) — specs/002.../tasks.md Phases E+F. مراحل G/H (نقطة الحفظ،
 * تأكيد الكتابة، التطبيق الفعلي) تُبنى لاحقاً على نفس هذا الملف.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const readline = require('readline');
const { validateTenantBackupFile, stripMongoMeta, computeCategoryDigest } = require('../lib/backupValidation');
const { appendAuditEvent } = require('../lib/auditLog');
const { _atomicWriteJsonSync } = require('../lib/database');
const User = require('../models/User');
const EntityChunk = require('../models/EntityChunk');
const AppConfig = require('../models/AppConfig');

const ROOT = path.join(__dirname, '..');
const MONGO_URI = process.env.MONGO_URI;
// BACKUP_DIR-relative, exactly like scripts/tenant-backup.js's own BACKUP_DIR
// — so a test (or an operator) that redirects backups elsewhere gets the
// checkpoint/lock directory redirected identically, not left pointed at the
// real project's backups/ directory regardless.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'backups');
const CHECKPOINTS_DIR = path.join(BACKUP_DIR, '.restore-checkpoints');

// Mirrors lib/database.js:427-429's own _defaultTenantFilter verbatim — see
// scripts/tenant-backup.js's identical comment for why this is reproduced
// here rather than exported from that module.
const _defaultTenantFilter = {
  $or: [{ tenantId: 'default' }, { tenantId: { $exists: false } }, { tenantId: null }],
};

class RestoreFailure extends Error {
  constructor(message, outcome) { super(message); this.outcome = outcome || 'failure'; }
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}

function parseArgs(argv) {
  const positional = argv.find(a => !a.startsWith('--'));
  const tenantArg = argv.find(a => a.startsWith('--tenant='));
  const targetArg = argv.find(a => a.startsWith('--target='));
  return {
    file: positional || null,
    tenantId: tenantArg ? tenantArg.slice('--tenant='.length).trim() || null : null,
    target: targetArg ? targetArg.slice('--target='.length).trim() || null : null,
    yes: argv.includes('--yes') || process.env.RESTORE_YES === '1',
    forceUnlock: argv.includes('--force-unlock'),
  };
}

// Step -1 — Pre-Restore Quiesce Warning (research.md Decision 19, tasks.md
// T040a). MUST print before anything else, including before argument
// parsing decides whether to reject and exit — never skippable by any
// early-exit path. Stable substring asserted by tests/tenant-restore.test.js.
function printQuiesceWarning(tenantId) {
  const label = tenantId || '(غير محدد بعد)';
  console.warn(`⚠️ تحذير قبل البدء: أوقف حركة الطلبات الحية للمستأجر "${label}" الآن (أو أوقف السيرفر الذي يخدمه) قبل متابعة هذه الاستعادة. أي كتابة تصل أثناء التطبيق قد تُفسد الاستعادة نفسها، لا أن تُلغيها لاحقاً فقط.`);
}

function checkpointPath(tenantId) {
  return path.join(CHECKPOINTS_DIR, `${tenantId}.json`);
}
function lockFilePath(tenantId) {
  return path.join(CHECKPOINTS_DIR, `${tenantId}.lock`);
}
const STAGING_DIR = path.join(BACKUP_DIR, '.restore-staging');
function stagingFilePath(tenantId) {
  return path.join(STAGING_DIR, `${tenantId}.json`);
}

// Step 3.3 — ownership check (research.md Decision 6): a sanitized record's
// own tenantId must be consistent with the restore target. For 'default',
// this mirrors _defaultTenantFilter's own shape — an explicit 'default', a
// genuinely-absent field, or null all count as "belongs to default" (the
// same three shapes lib/database.js's own Mongo queries already treat as
// equivalent for legacy pre-multi-tenancy documents).
function ownershipConsistent(record, targetTenantId) {
  const rid = record.tenantId;
  if (targetTenantId === 'default') return rid === 'default' || rid === undefined || rid === null;
  return rid === targetTenantId;
}

// Step 3 — offline/logical staging (research.md Decision 6, tasks.md
// T047-T050). Sanitizes the already-validated backup's collections into
// memory, re-verifies count+digest against the backup's own recorded
// values (a second, independent check beyond Step 1's file-level one, now
// against the actually-sanitized data), validates per-record ownership,
// and writes the result to a local, tenant-keyed staging file. NO live-
// Mongo write of any kind happens anywhere in this function.
function stageBackup(backup, targetTenantId) {
  const staged = {
    users: (backup.collections.users || []).map(stripMongoMeta),
    entityChunks: (backup.collections.entityChunks || []).map(stripMongoMeta),
    appConfigs: (backup.collections.appConfigs || []).map(stripMongoMeta),
  };

  for (const cat of ['users', 'entityChunks', 'appConfigs']) {
    const count = staged[cat].length;
    const digest = computeCategoryDigest(staged[cat]);
    if (count !== backup.recordCounts?.[cat]) {
      throw new RestoreFailure(`staging: recomputed count for "${cat}" (${count}) does not match the backup's own recordCounts.${cat} (${backup.recordCounts?.[cat]})`);
    }
    if (digest !== backup.categoryDigests?.[cat]) {
      throw new RestoreFailure(`staging: recomputed digest for "${cat}" does not match the backup's own categoryDigests.${cat}`);
    }
  }

  for (const cat of ['users', 'entityChunks', 'appConfigs']) {
    for (const record of staged[cat]) {
      if (!ownershipConsistent(record, targetTenantId)) {
        throw new RestoreFailure(`staging: a record in "${cat}" has a tenantId inconsistent with the restore target "${targetTenantId}"`);
      }
    }
  }

  fs.mkdirSync(STAGING_DIR, { recursive: true });
  _atomicWriteJsonSync(stagingFilePath(targetTenantId), staged);

  return staged;
}

function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

// Step 0 — Restore Lock (research.md Decision 11, tasks.md T041). Reuses
// EntityChunk's existing {tenantId,key} compound unique index — a plain
// create() that hits the index atomically on a concurrent attempt (Mongo
// duplicate-key error 11000). --force-unlock is a single, non-looping,
// compare-and-delete-then-create sequence — never a bare unconditional
// delete-then-create (see the decision for the exact race this closes).
async function acquireLockMongo(target, runId, forceUnlock) {
  const lockDoc = { tenantId: target, key: '__restoreLock__', data: { runId, pid: process.pid, acquiredAt: new Date().toISOString() } };
  try {
    await EntityChunk.create(lockDoc);
    return { acquired: true };
  } catch (e) {
    if (e.code !== 11000) throw e;
    const existing = await EntityChunk.findOne({ tenantId: target, key: '__restoreLock__' }).lean();
    if (!forceUnlock) return { acquired: false, existing };
    if (existing) {
      await EntityChunk.deleteOne({ tenantId: target, key: '__restoreLock__', 'data.runId': existing.data?.runId });
    }
    try {
      await EntityChunk.create(lockDoc);
      return { acquired: true, forcedFrom: existing };
    } catch (e2) {
      if (e2.code !== 11000) throw e2;
      const stillExisting = await EntityChunk.findOne({ tenantId: target, key: '__restoreLock__' }).lean();
      return { acquired: false, existing: stillExisting, forceAttempted: true };
    }
  }
}

async function releaseLockMongo(target, runId) {
  await EntityChunk.deleteOne({ tenantId: target, key: '__restoreLock__', 'data.runId': runId });
}

function acquireLockFile(target, runId, forceUnlock) {
  fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  const fp = lockFilePath(target);
  const doc = { runId, pid: process.pid, acquiredAt: new Date().toISOString() };
  const write = () => fs.writeFileSync(fp, JSON.stringify(doc), { flag: 'wx' });
  try {
    write();
    return { acquired: true };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const existing = readJsonSafe(fp);
    if (!forceUnlock) return { acquired: false, existing };
    try { fs.unlinkSync(fp); } catch {}
    try {
      write();
      return { acquired: true, forcedFrom: existing };
    } catch (e2) {
      if (e2.code !== 'EEXIST') throw e2;
      return { acquired: false, existing: readJsonSafe(fp), forceAttempted: true };
    }
  }
}

function releaseLockFile(target) {
  try { fs.unlinkSync(lockFilePath(target)); } catch {}
}

// Step 2 — default-tenant duplicate pre-flight (research.md Decision 16),
// run against the LIVE DATABASE (mirrors scripts/tenant-backup.js's own
// pre-flight, which runs the identical check against the same live data
// before a backup is written — tasks.md T044 explicitly mirrors T031).
async function findDefaultDuplicatesLive() {
  const problems = [];
  const users = await User.find(_defaultTenantFilter).lean();
  const usersById = new Map();
  for (const u of users) {
    if (!usersById.has(u.id)) usersById.set(u.id, []);
    usersById.get(u.id).push(u);
  }
  for (const [id, docs] of usersById) {
    if (docs.length > 1) problems.push({ category: 'users', identity: id, ids: docs.map(d => String(d._id)) });
  }
  for (const [category, Model] of [['entityChunks', EntityChunk], ['appConfigs', AppConfig]]) {
    const docs = await Model.find(_defaultTenantFilter).lean();
    const byKey = new Map();
    for (const d of docs) {
      if (!byKey.has(d.key)) byKey.set(d.key, []);
      byKey.get(d.key).push(d);
    }
    for (const [key, ds] of byKey) {
      if (ds.length > 1) problems.push({ category, identity: key, ids: ds.map(d => String(d._id)) });
    }
  }
  return problems;
}

async function recordAuditEvent(target, isMongoMode, outcome, metadata) {
  const opts = {
    req: { tenantId: target },
    action: 'tenant.restore',
    resourceType: 'tenant',
    resourceId: target,
    outcome,
    metadata,
  };
  try {
    if (isMongoMode) {
      const doc = await EntityChunk.findOne({ tenantId: 'default', key: 'auditLog' }).lean();
      const container = { auditLog: doc?.data || [] };
      appendAuditEvent(container, opts);
      await EntityChunk.findOneAndUpdate(
        { tenantId: 'default', key: 'auditLog' },
        { $set: { tenantId: 'default', data: container.auditLog, updatedAt: new Date() } },
        { upsert: true },
      );
    } else {
      const dataFile = process.env.DATA_FILE || path.join(ROOT, 'data', 'database.json');
      const db = readJsonSafe(dataFile) || {};
      db.auditLog = db.auditLog || [];
      appendAuditEvent(db, opts);
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8');
    }
  } catch (e) {
    console.warn(`⚠️ تعذّر تسجيل حدث التدقيق: ${e.message}`);
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  // Step -1 — unconditional, before any exit path below, including this
  // function's own argument-validity checks (tasks.md T040a).
  printQuiesceWarning(args.tenantId);

  if (!args.file || !args.tenantId || !args.target) {
    console.error('الاستخدام: node scripts/tenant-restore.js <ملف النسخة> --tenant=<المعرّف> --target=<اسم الوجهة> [--yes] [--force-unlock]');
    process.exitCode = 1;
    return;
  }

  const { file, tenantId: target, target: targetLabel, yes, forceUnlock } = args;
  const isMongoMode = !!MONGO_URI;
  const runId = crypto.randomBytes(8).toString('hex');

  if (isMongoMode) await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  let lockAcquired = false;
  try {
    // Step 0 — restore lock, first state-changing action, before validation.
    const lockResult = isMongoMode
      ? await acquireLockMongo(target, runId, forceUnlock)
      : acquireLockFile(target, runId, forceUnlock);

    if (!lockResult.acquired) {
      const existing = lockResult.existing;
      const age = existing?.acquiredAt || existing?.data?.acquiredAt;
      console.error(`❌ قفل استعادة موجود بالفعل للمستأجر "${target}" — runId=${existing?.data?.runId || existing?.runId || '?'} pid=${existing?.data?.pid || existing?.pid || '?'} منذ ${age || '?'}.`);
      console.error('   استخدم --force-unlock فقط بعد التأكد أن لا استعادة أخرى تعمل فعلياً الآن.');
      process.exitCode = 1;
      return;
    }
    lockAcquired = true;

    // Step 1 — validation gate (tasks.md T042), sub-steps 1-7 via the shared,
    // exported validateTenantBackupFile(); sub-step 1.8 (fingerprint) below.
    const validation = validateTenantBackupFile(file, target);
    if (!validation.ok) {
      console.error(`❌ ملف النسخة غير صالح للاستعادة — رُفضت العملية (لم تُكتب أي بيانات):`);
      for (const p of validation.problems) console.error(`   - ${p}`);
      await recordAuditEvent(target, isMongoMode, 'failure', { reason: 'validation_failed', problems: validation.problems });
      process.exitCode = 1;
      return;
    }

    // Step 1.8 — backup-fingerprint check against any existing, non-completed
    // checkpoint for this tenant (research.md Decision 13, last sub-step,
    // deliberately). No checkpoint exists yet until Phase F/G writes one —
    // this is forward-looking-correct plumbing for those phases.
    const existingCheckpoint = readJsonSafe(checkpointPath(target));
    if (existingCheckpoint && existingCheckpoint.stage !== 'completed') {
      if (existingCheckpoint.backupFingerprint !== validation.checksum) {
        console.error(`❌ عدم تطابق بصمة النسخة الاحتياطية عند الاستئناف — الملف الحالي "${path.basename(file)}" لا يطابق النسخة التي بدأ بها التشغيل السابق (checkpoint: ${checkpointPath(target)}).`);
        await recordAuditEvent(target, isMongoMode, 'failure', { reason: 'fingerprint_mismatch' });
        process.exitCode = 1;
        return;
      }
    }

    // Step 2 — default-tenant duplicate pre-flight, against the LIVE
    // database (tasks.md T044). Mongo-mode only, mirroring the backup
    // tool's own equivalent (file-mode has no way to hold two physical
    // documents for the same identity).
    if (target === 'default' && isMongoMode) {
      const dupes = await findDefaultDuplicatesLive();
      if (dupes.length) {
        for (const d of dupes) {
          console.error(`❌ هوية مكرّرة (${d.category}): "${d.identity}" — مستندات: ${d.ids.join(', ')}`);
        }
        console.error('❌ توجد هويات مكرّرة للعيادة الافتراضية في قاعدة البيانات الحية — رُفضت الاستعادة، لم تُكتب أي بيانات.');
        await recordAuditEvent(target, isMongoMode, 'failure', { reason: 'default_duplicate_identity', duplicates: dupes });
        process.exitCode = 1;
        return;
      }
    }

    // Step 3 — offline/logical staging (tasks.md T047-T050, Phase F). No
    // live-Mongo write happens in this step or anything before it.
    stageBackup(validation.backup, target);

    // Phase F's own scope ends here (tasks.md T051 checkpoint). Steps 4
    // (checkpoint write), 4a (typed confirmation), 5 (apply), 6 (finalize)
    // attach here in Phase G, built on this same staged file.
    console.log(`🎯 الوجهة المُعلَنة: ${targetLabel}`);
    console.log(`✅ اكتمل التجهيز غير المتصل (Step 3) للمستأجر "${target}" — لم تُطبَّق أي بيانات على قاعدة البيانات الحية بعد (نقطة الحفظ والتطبيق الفعلي في مرحلة لاحقة).`);
    void yes; // consumed by Step 4a in a later phase — parsed now per tasks.md T040
  } catch (e) {
    // Staging (Step 3) is a defense-in-depth double-check that should never
    // actually fire for any backup that already passed Step 1 — its own
    // digest recompute is a no-op re-strip of the same content Step 1 just
    // verified — so a RestoreFailure reaching here means something is
    // genuinely, unexpectedly wrong. Not one of the four audited terminal-
    // outcome families the contract names (Step 1/2/4a/5-6), so no
    // dedicated audit call here — just a clean, non-zero exit.
    console.error('❌ فشل التجهيز:', e.message);
    process.exitCode = 1;
  } finally {
    if (lockAcquired) {
      if (isMongoMode) { try { await releaseLockMongo(target, runId); } catch {} }
      else releaseLockFile(target);
    }
    if (isMongoMode) { try { await mongoose.connection.close(); } catch {} }
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  run, parseArgs, printQuiesceWarning,
  // Exported for direct unit-testing of Step 3's own redundant digest-check
  // and ownership-check layers in isolation (tasks.md T046, bullets 3/4) —
  // both are, by construction, unreachable via the real CLI for any file
  // that already passed Step 1's identical checks, so testing them through
  // the full file/CLI pipeline can never actually exercise their own
  // rejection branch.
  stageBackup, ownershipConsistent, stagingFilePath,
};
