#!/usr/bin/env node
'use strict';
/**
 * استعادة نسخة احتياطية لمستأجر واحد فقط — Tenant-Scoped Restore
 *
 * التشغيل:
 *   node scripts/tenant-restore.js <ملف النسخة> --tenant=<المعرّف> --target=<اسم الوجهة> [--yes] [--force-unlock --expected-lock-run-id=<RUN_ID>]
 *
 * --force-unlock يتطلب دائماً --expected-lock-run-id=<RUN_ID> صراحةً — هوية
 * القفل المحدد الذي تنوي استبداله بالضبط (تحصل عليها من رسالة رفض محاولة
 * عادية سابقة). لا تخمين، ولا إعادة قراءة القفل الحالي واستبدال أياً كان
 * موجوداً فعلاً وقت التنفيذ.
 *
 * ⚠️ خطير: يستبدل بيانات هذا المستأجر فقط. لا يمسّ أي مستأجر آخر، ولا يمسّ
 *    scripts/restore.js أو npm run restore بأي شكل.
 *
 * حالة هذا الملف: يطبّق كامل السلسلة Steps -1 إلى 6 (القفل، التحقق، فحص
 * التكرار، التجهيز غير المتصل، نقطة الحفظ، تأكيد الكتابة، التطبيق الفعلي،
 * الإنهاء) — specs/002.../tasks.md Phases E-G.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const readline = require('readline');
const { validateTenantBackupFile, stripMongoMeta, computeCategoryDigest } = require('../lib/backupValidation');
const { appendAuditEvent } = require('../lib/auditLog');
const { _atomicWriteJsonSync, _tenantFilePath, _setDataFileForTooling, TENANT_BACKUP_ENTITY_KEYS } = require('../lib/database');
const { sanitizeTenantIdForPath } = require('../lib/tenantIdPathSanitizer');
const User = require('../models/User');
const EntityChunk = require('../models/EntityChunk');
const AppConfig = require('../models/AppConfig');
const IdempotencyRecord = require('../models/IdempotencyRecord');

const ROOT = path.join(__dirname, '..');
const MONGO_URI = process.env.MONGO_URI;
// BACKUP_DIR-relative, exactly like scripts/tenant-backup.js's own BACKUP_DIR
// — so a test (or an operator) that redirects backups elsewhere gets the
// checkpoint/lock directory redirected identically, not left pointed at the
// real project's backups/ directory regardless.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'backups');
const CHECKPOINTS_DIR = path.join(BACKUP_DIR, '.restore-checkpoints');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'database.json');
// Lets _tenantFilePath() (from lib/database.js) resolve a non-default
// tenant's file-mode blob path — see scripts/tenant-backup.js's identical
// call for why this is needed instead of running the full initDB().
_setDataFileForTooling(DATA_FILE);

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
  const expectedLockRunIdArg = argv.find(a => a.startsWith('--expected-lock-run-id='));
  return {
    file: positional || null,
    tenantId: tenantArg ? tenantArg.slice('--tenant='.length).trim() || null : null,
    target: targetArg ? targetArg.slice('--target='.length).trim() || null : null,
    yes: argv.includes('--yes') || process.env.RESTORE_YES === '1',
    forceUnlock: argv.includes('--force-unlock'),
    // The ONLY input that may ever authorize a force-takeover — the exact
    // lock identity the operator intends to replace, normally copied from
    // a plain (non-force) attempt's own rejection message a moment
    // earlier. There is deliberately no way to force-unlock "whatever
    // lock currently exists" without naming it.
    expectedLockRunId: expectedLockRunIdArg ? expectedLockRunIdArg.slice('--expected-lock-run-id='.length).trim() || null : null,
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
  return path.join(CHECKPOINTS_DIR, `${sanitizeTenantIdForPath(tenantId)}.json`);
}
function lockFilePath(tenantId) {
  return path.join(CHECKPOINTS_DIR, `${sanitizeTenantIdForPath(tenantId)}.lock`);
}
const STAGING_DIR = path.join(BACKUP_DIR, '.restore-staging');
function stagingFilePath(tenantId) {
  return path.join(STAGING_DIR, `${sanitizeTenantIdForPath(tenantId)}.json`);
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

// Step 4 — checkpoint (research.md Decisions 14/15, tasks.md T053). Always
// written via _atomicWriteJsonSync (tmp-file + rename), never a plain
// fs.writeFileSync — the same crash-safety primitive this codebase already
// trusts for data/database.json.
function writeCheckpoint(tenantId, checkpoint) {
  fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  checkpoint.updatedAt = new Date().toISOString();
  _atomicWriteJsonSync(checkpointPath(tenantId), checkpoint);
  return checkpoint;
}

// Step 4a — explicit typed confirmation (research.md Decision 25, tasks.md
// T053a), mirroring scripts/restore.js:104-107's own gate exactly.
async function confirmApply(target, targetLabel, yes) {
  if (yes) return true;
  const ans = await ask(`اكتب "نعم" للتأكيد أنك تريد استعادة المستأجر "${target}" إلى "${targetLabel}": `);
  return ans === 'نعم';
}

const CATEGORY_ORDER = ['users', 'entityChunks', 'appConfigs'];
const CATEGORY_MODELS = { users: User, entityChunks: EntityChunk, appConfigs: AppConfig };

// Step 5, point 1/2 (research.md Decision 12): the SAME filter is used for
// both the live digest re-check and the destructive delete, for every
// category — entityChunks additionally scoped by key so it can never touch
// the restore lock or the tenant's own live idempotencyRecords document
// (both live in this same collection, under this same tenantId); for
// 'default', every category substitutes _defaultTenantFilter so legacy
// no-tenantId-field documents are correctly counted and cleared.
function categoryLiveFilter(category, target) {
  const base = target === 'default' ? _defaultTenantFilter : { tenantId: target };
  if (category === 'entityChunks') return { ...base, key: { $in: TENANT_BACKUP_ENTITY_KEYS } };
  if (category === 'appConfigs') return { ...base, key: 'config' };
  return base;
}

async function liveCategoryDigest(category, target) {
  const docs = await CATEGORY_MODELS[category].find(categoryLiveFilter(category, target)).lean();
  return { count: docs.length, digest: computeCategoryDigest(docs) };
}

// Step 5, point 2: tenant-scoped delete, never a bare deleteMany({}), then
// insert the staged records with the REAL target tenantId (no synthetic
// identity — there is nothing to repoint anymore). {ordered:false} on
// entityChunks specifically (mirrors scripts/restore.js:41's precedent) so
// one unexpected record can never abort unrelated ones in the same batch.
async function applyCategory(category, target, records) {
  const Model = CATEGORY_MODELS[category];
  await Model.deleteMany(categoryLiveFilter(category, target));
  if (records.length) {
    const withRealTenant = records.map(r => ({ ...r, tenantId: target }));
    await Model.insertMany(withRealTenant, category === 'entityChunks' ? { ordered: false } : {});
  }
}

// Documented, test-only crash/failure-injection hooks (tasks.md T057/T058)
// — both are no-ops unless their specific env var is set, which real
// operator invocations never do. Two DISTINCT windows, deliberately:
//
// T058 needs the genuine crash window Decision 12's digest-based resume
// exists to close — between a category's DB write SUCCEEDING and its OWN
// checkpoint entry being written — so this hook runs right after the DB
// write, before that category is pushed to categoriesApplied/the
// checkpoint is rewritten. It first writes a marker file so an external
// test harness can detect the exact moment and send a real SIGKILL,
// deterministically rather than via a flaky wall-clock guess.
async function _testCrashWindowHook(category) {
  if (process.env.__TENANT_RESTORE_TEST_KILL_AFTER__ === category && process.env.__TENANT_RESTORE_TEST_KILL_MARKER__) {
    fs.writeFileSync(process.env.__TENANT_RESTORE_TEST_KILL_MARKER__, String(process.pid));
    await new Promise(r => setTimeout(r, 5000));
  }
}

// T057 needs a clean, catchable failure BETWEEN two categories — after the
// first one's DB write AND checkpoint write have both already landed, but
// before the next category's own apply begins — so this hook runs after
// the checkpoint rewrite for the named category.
async function _testBetweenCategoriesFailHook(category) {
  if (process.env.__TENANT_RESTORE_TEST_FAIL_AFTER__ === category) {
    throw new RestoreFailure(`test-only forced failure after category "${category}" completed`);
  }
}

function loadTenantFileBlob(target) {
  if (target === 'default') {
    return readJsonSafe(DATA_FILE) || {};
  }
  return readJsonSafe(_tenantFilePath(target)) || {};
}

// Step 6 — idempotency-staleness count (research.md Decision 20, sixth
// pass, tasks.md T056b): Mongo mode queries the DEDICATED IdempotencyRecord
// collection specifically, never the EntityChunk{key:'idempotencyRecords'}-
// embedded array (the two can briefly disagree — see the decision). File
// mode has no dedicated collection, so the embedded array is the only
// representation that backend has.
async function countStaleIdempotency(target, backupCreatedAt, isMongoMode) {
  if (isMongoMode) {
    return IdempotencyRecord.countDocuments({ tenantId: target, status: 'COMPLETED', completedAt: { $gt: new Date(backupCreatedAt) } });
  }
  const blob = loadTenantFileBlob(target);
  const records = blob.idempotencyRecords || [];
  return records.filter(r => r.status === 'COMPLETED' && r.completedAt && new Date(r.completedAt) > new Date(backupCreatedAt)).length;
}

const RECOVERY_MESSAGE = '↻ الاستئناف: أعد تشغيل نفس الأمر بنفس ملف النسخة. إذا كانت هذه العملية أُوقفت قسراً لا بخطأ عادي، فقفل الاستعادة لهذا المستأجر لا يزال محجوزاً — ستُرفض إعادة التشغيل العادية وتُخبرك برسالة الرفض بهوية القفل الحالي (runId)؛ أعد التشغيل بإضافة --force-unlock --expected-lock-run-id=<runId الذي ظهر> فقط بعد التأكد أن لا استعادة أخرى لهذا المستأجر تعمل فعلياً الآن. لا يوجد تراجع تلقائي (rollback) عن فئة سبق تطبيقها — أعد الاستعادة من نسخة أقدم عند الحاجة.';

// Owner-review history — kept for traceability; read alongside research.md
// Decision 11. The lock mechanism went through three designs before this
// one:
//
// (1) ORIGINAL: findOne() -> a separately-conditioned deleteOne() ->
//     create(). NOT atomic across two concurrent --force-unlock
//     invocations: if process A's entire sequence (including its own
//     create()) completed before process B's findOne() ever ran, B would
//     observe A's BRAND-NEW legitimate lock, and B's own conditioned
//     delete would match and remove A's real lock, letting B's create()
//     steal it. Empirically reproduced (8/12 failures in a tight local
//     loop, and on this PR's own CI run).
//
// (2) CAS-ONLY: a single atomic findOneAndUpdate() compare-and-swap
//     (_forceUnlockTakeover, below), conditioned on a runId the function
//     itself had just read via its own findOne(). This closed the race for
//     two processes racing the identical original stale lock, but was
//     STILL not enough on its own: nothing distinguished "the stale lock
//     both processes are trying to replace" from "a legitimate lock
//     someone else acquired a moment ago" — both look identical to a bare
//     read. If A's entire observe-then-CAS sequence completed before B's
//     own findOne() ran, B would accurately observe A's fresh lock and its
//     own CAS, conditioned on THAT runId, would succeed — silently
//     stealing A's real, active lock. Empirically reproduced via direct
//     instrumentation (a 7-millisecond-apart takeover chain).
//
// (3) CAS + wall-clock age gate: a minimum-age check on the self-observed
//     `existing` lock before attempting the CAS, reasoning that a lock
//     younger than some threshold is very likely a legitimate concurrent
//     acquirer. REJECTED on independent owner re-review: this makes the
//     mutual-exclusion guarantee depend on process/network timing rather
//     than lock identity — no fixed millisecond threshold can be proven to
//     separate "a genuine concurrent acquirer" from "a truly abandoned
//     lock" under different latency/load conditions than whatever
//     environment happened to calibrate it. Two independent reviews
//     confirmed the property was TIMING_DEPENDENT_UNSAFE, not merely
//     defense-in-depth on an already-safe primitive.
//
// FINAL DESIGN (this one): force-unlock never self-observes "the current
// lock" and decides on its own that it looks stale/replaceable — no
// findOne() result is ever fed into a CAS as its own expected value. The
// caller (an operator, or automation acting on an operator's own decision)
// must name the EXACT lock identity (runId) they intend to replace —
// always the runId reported by a plain acquireLockMongo() rejection
// moments earlier (see forceTakeoverLockMongo(), below). The
// compare-and-swap can then ONLY ever replace that exact document state;
// it is structurally incapable of "helpfully" reforcing whatever happens
// to currently exist instead. This closes both race shapes with NO
// wall-clock reasoning anywhere in the safety argument:
//   - Two callers racing the SAME expected old runId (e.g. two operators
//     force-unlocking near-simultaneously, both having read the same
//     stale lock): MongoDB's per-document atomicity guarantees exactly one
//     findOneAndUpdate() lands; the loser's identical filter no longer
//     matches once the winner's write is applied, and it fails cleanly —
//     see test (B) below.
//   - A caller whose expected old runId is no longer current (someone
//     else already replaced OR released the lock it names): the filter
//     cannot match the document's current state under any timing, so the
//     takeover fails closed — it can never touch a lock other than the
//     exact one it named — see test (C) below.
// `acquiredAt` is still recorded on every lock document and still
// surfaced to the operator as a diagnostic aid ("does this look
// abandoned?") — it is deliberately never read by any code path here to
// make a replace/no-replace decision.
function _forceUnlockTakeover(target, expectedOldRunId, newLockData) {
  // Bare, identity-only compare-and-swap: replace the __restoreLock__
  // document for this tenant ONLY if its CURRENT data.runId is still
  // exactly expectedOldRunId — a value the CALLER supplies (an operator's
  // own --expected-lock-run-id=, or a test's direct argument), never a
  // value this function or its caller just observed for itself. No other
  // signal (age, pid, or anything else) ever factors into this match.
  return EntityChunk.findOneAndUpdate(
    { tenantId: target, key: '__restoreLock__', 'data.runId': expectedOldRunId },
    { $set: { data: newLockData } },
    { new: true },
  ).lean();
}

// Step 0 — Restore Lock (research.md Decision 11, tasks.md T041). Reuses
// EntityChunk's existing {tenantId,key} compound unique index — a plain
// create() that hits the index atomically on a concurrent attempt (Mongo
// duplicate-key error 11000).
//
// This is a PLAIN acquisition attempt only — it NEVER replaces an existing
// lock, however old it looks. If a lock already exists, this fails closed
// and reports the existing lock's identity so a human (or automation
// acting on a human's decision) can choose to call
// forceTakeoverLockMongo() below with that EXACT identity.
async function acquireLockMongo(target, runId) {
  const lockDoc = { tenantId: target, key: '__restoreLock__', data: { runId, pid: process.pid, acquiredAt: new Date().toISOString() } };
  try {
    await EntityChunk.create(lockDoc);
    return { acquired: true };
  } catch (e) {
    if (e.code !== 11000) throw e;
    const existing = await EntityChunk.findOne({ tenantId: target, key: '__restoreLock__' }).lean();
    return { acquired: false, existing };
  }
}

// The ONLY way to override an existing lock. Requires the caller to name
// the exact lock identity (expectedOldRunId) they intend to replace — see
// the design note above _forceUnlockTakeover for why this, and never a
// self-observed "current lock", is what makes this race-safe without any
// wall-clock reasoning.
async function forceTakeoverLockMongo(target, runId, expectedOldRunId) {
  if (!expectedOldRunId) {
    // Defensive: parseArgs()/run() already reject a bare --force-unlock
    // (missing --expected-lock-run-id=) before Step 0 is ever reached —
    // see run()'s own argument validation. This function is also called
    // directly by tests and must refuse on its own rather than risk an
    // undefined-valued Mongo query.
    return { acquired: false, rejected: 'missing_expected_run_id' };
  }
  const newLockData = { runId, pid: process.pid, acquiredAt: new Date().toISOString() };
  const takeover = await _forceUnlockTakeover(target, expectedOldRunId, newLockData);
  if (takeover) return { acquired: true };
  const existing = await EntityChunk.findOne({ tenantId: target, key: '__restoreLock__' }).lean();
  return { acquired: false, existing };
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
      const db = readJsonSafe(DATA_FILE) || {};
      db.auditLog = db.auditLog || [];
      appendAuditEvent(db, opts);
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      // Owner-review finding (lean review, post-implementation): this
      // rewrites default's ENTIRE live database.json, not just the audit
      // log — a plain fs.writeFileSync here (unlike everywhere else in
      // this feature, including the identical call site in
      // scripts/tenant-backup.js) risked a truncated/corrupt file if the
      // process were killed mid-write. _atomicWriteJsonSync (tmp-file +
      // rename) is already imported and used for the checkpoint/staging
      // writes below — this call site must use the same primitive.
      _atomicWriteJsonSync(DATA_FILE, db);
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
    console.error('الاستخدام: node scripts/tenant-restore.js <ملف النسخة> --tenant=<المعرّف> --target=<اسم الوجهة> [--yes] [--force-unlock --expected-lock-run-id=<RUN_ID>]');
    process.exitCode = 1;
    return;
  }

  // Design decision (owner-mandated redesign, post-lean-review): --force-
  // unlock must never silently infer which lock to replace by rereading
  // whatever currently exists — it must always be paired with an explicit
  // --expected-lock-run-id=, named by the operator, BEFORE Step 0 is ever
  // reached (before any lock/backup-file work at all, let alone apply).
  if (args.forceUnlock && !args.expectedLockRunId) {
    console.error('❌ --force-unlock يتطلب تحديد هوية القفل المتوقع صراحةً: أضف --expected-lock-run-id=<RUN_ID> (احصل على RUN_ID من رسالة رفض محاولة عادية سابقة — لن يُخمَّن أو يُعاد قراءة القفل الحالي تلقائياً).');
    process.exitCode = 1;
    return;
  }

  const { file, tenantId: target, target: targetLabel, yes, forceUnlock, expectedLockRunId } = args;
  const isMongoMode = !!MONGO_URI;
  const runId = crypto.randomBytes(8).toString('hex');

  // Owner-review finding (lean review, post-implementation): Step 5's apply
  // (categoryLiveFilter/liveCategoryDigest/applyCategory) always queries the
  // raw Mongoose User/EntityChunk/AppConfig models — there is no file-mode
  // equivalent, unlike Step 0's lock and Step 6's idempotency count, which
  // both correctly branch on backend. scripts/tenant-backup.js DOES support
  // file-mode backup for any tenant (tested), so a file-mode backup could
  // otherwise be created successfully and then be impossible to ever
  // restore — silently hanging for ~10s on a Mongoose command-buffering
  // timeout instead of failing immediately and honestly. Rejecting here,
  // before Step 0's lock is even acquired, turns that into an instant,
  // clear, audited-free (nothing was attempted) rejection. File-mode tenant
  // restore is a real, currently out-of-scope gap — see
  // docs/PRODUCTION_RUNBOOK.md §7.1.
  if (!isMongoMode) {
    console.error('❌ الاستعادة الخاصة بمستأجر واحد غير مدعومة في وضع الملفات (بدون MONGO_URI) — التطبيق الفعلي (Step 5) لهذه الأداة يعمل على MongoDB فقط حالياً. استخدم اتصال MongoDB حقيقي، أو راجع docs/PRODUCTION_RUNBOOK.md.');
    process.exitCode = 1;
    return;
  }

  if (isMongoMode) {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    // Owner-review finding (final PR review, part of the CRITICAL lock fix):
    // Mongoose builds a schema's indexes in the BACKGROUND after first use
    // unless explicitly awaited (the same class of gap this codebase's own
    // P0.12 milestone already found and fixed for IdempotencyRecord's own
    // unique index, lib/database.js's initDB()). Step 0's entire lock-
    // acquisition atomicity guarantee (acquireLockMongo(), below) depends
    // on EntityChunk's {tenantId,key} unique index actually being enforced
    // — on a genuinely fresh MongoDB deployment this script is the very
    // first thing to touch, that index might not exist yet, silently
    // defeating the atomicity this fix relies on. In the normal, expected
    // topology (an already-running application server sharing the same
    // database) this index was already built long ago — this call is then
    // a fast no-op — but it must never be skipped on the theoretical fresh-
    // database path either.
    await EntityChunk.init();
  }

  let lockAcquired = false;
  try {
    // Step 0 — restore lock, first state-changing action, before validation.
    let lockResult;
    if (isMongoMode) {
      lockResult = await acquireLockMongo(target, runId);
      if (!lockResult.acquired && forceUnlock) {
        // expectedLockRunId is guaranteed non-empty here — validated above,
        // before Step -1's warning even printed. This is the ONLY call
        // site that may ever replace an existing lock, and it replaces
        // ONLY the exact identity named — never "whatever is there now".
        lockResult = await forceTakeoverLockMongo(target, runId, expectedLockRunId);
      }
    } else {
      lockResult = acquireLockFile(target, runId, forceUnlock);
    }

    if (!lockResult.acquired) {
      const existing = lockResult.existing;
      const existingRunId = existing?.data?.runId || existing?.runId || null;
      const existingPid = existing?.data?.pid ?? existing?.pid ?? '?';
      const existingAcquiredAt = existing?.data?.acquiredAt || existing?.acquiredAt || '?';
      console.error(`❌ قفل استعادة موجود بالفعل للمستأجر "${target}":`);
      console.error(`   runId=${existingRunId || '?'} pid=${existingPid} acquiredAt=${existingAcquiredAt}`);
      const existingCheckpoint = readJsonSafe(checkpointPath(target));
      if (existingCheckpoint) {
        console.error(`   آخر نقطة حفظ معروفة لهذا المستأجر: stage=${existingCheckpoint.stage || '?'} runId=${existingCheckpoint.runId || '?'} categoriesApplied=${(existingCheckpoint.categoriesApplied || []).join('،') || '(لا شيء)'}`);
      }
      if (forceUnlock) {
        console.error(`   ⚠️ تعذّر --force-unlock: القفل الحالي (runId=${existingRunId || '?'}) لا يطابق الهوية المتوقعة (--expected-lock-run-id=${expectedLockRunId}) — تغيّر منذ آخر قراءة لك (استُبدل أو حُرِّر)، ولم تُلمس بياناته الحالية إطلاقاً. تحقق من الحالة أعلاه ثم قرّر مجدداً — لا تُعِد المحاولة بهوية مخمَّنة.`);
      } else if (existingRunId) {
        console.error(`   تأكد أولاً أن لا استعادة أخرى تعمل فعلياً الآن لهذا المستأجر، ثم لأخذ القفل عنوة بالضبط: أعد التشغيل بإضافة --force-unlock --expected-lock-run-id=${existingRunId}`);
      } else {
        console.error('   تعذّرت قراءة هوية القفل الحالي بدقة — تحقق يدوياً من حالة قاعدة البيانات قبل أي محاولة عنوة.');
      }
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
      await recordAuditEvent(target, isMongoMode, 'failure', {
        backupFingerprint: validation.checksum, createdAt: validation.backup?.createdAt, categoriesApplied: [],
        reason: 'validation_failed', problems: validation.problems,
      });
      process.exitCode = 1;
      return;
    }
    const backup = validation.backup;

    // Step 1.8 — backup-fingerprint check against any existing, non-completed
    // checkpoint for this tenant (research.md Decision 13, last sub-step,
    // deliberately).
    const existingCheckpoint = readJsonSafe(checkpointPath(target));
    if (existingCheckpoint && existingCheckpoint.stage !== 'completed') {
      if (existingCheckpoint.backupFingerprint !== validation.checksum) {
        console.error(`❌ عدم تطابق بصمة النسخة الاحتياطية عند الاستئناف — الملف الحالي "${path.basename(file)}" لا يطابق النسخة التي بدأ بها التشغيل السابق (checkpoint: ${checkpointPath(target)}).`);
        await recordAuditEvent(target, isMongoMode, 'failure', {
          backupFingerprint: validation.checksum, createdAt: backup.createdAt, categoriesApplied: [], reason: 'fingerprint_mismatch',
        });
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
        await recordAuditEvent(target, isMongoMode, 'failure', {
          backupFingerprint: validation.checksum, createdAt: backup.createdAt, categoriesApplied: [],
          reason: 'default_duplicate_identity', duplicates: dupes,
        });
        process.exitCode = 1;
        return;
      }
    }

    // Step 3 — offline/logical staging (tasks.md T047-T050). No live-Mongo
    // write happens in this step or anything before it.
    const staged = stageBackup(backup, target);

    // Step 4 — checkpoint (tasks.md T053).
    const checkpoint = writeCheckpoint(target, {
      runId, targetTenantId: target, backupFile: file, backupFingerprint: validation.checksum,
      expected: {
        users: { count: backup.recordCounts.users, digest: backup.categoryDigests.users },
        entityChunks: { count: backup.recordCounts.entityChunks, digest: backup.categoryDigests.entityChunks },
        appConfigs: { count: backup.recordCounts.appConfigs, digest: backup.categoryDigests.appConfigs },
      },
      startedAt: new Date().toISOString(),
      stage: 'staged',
      categoriesApplied: [],
      error: null,
    });

    console.log(`🎯 الوجهة المُعلَنة: ${targetLabel} (المستأجر: ${target})`);

    // Step 4a — explicit typed confirmation (tasks.md T053a). MUST NOT be
    // defaulted, weakened, or bypassed by anything other than --yes/RESTORE_YES=1.
    const confirmed = await confirmApply(target, targetLabel, yes);
    if (!confirmed) {
      console.log('أُلغيت الاستعادة.');
      await recordAuditEvent(target, isMongoMode, 'cancelled', {
        backupFingerprint: validation.checksum, createdAt: backup.createdAt, categoriesApplied: [],
      });
      return; // exit 0 — nothing destructive was attempted; checkpoint stays at 'staged'
    }

    // Step 5 — apply, fixed order users -> entityChunks -> appConfigs. The
    // ONLY step that writes to the real target tenant.
    checkpoint.stage = 'applying';
    writeCheckpoint(target, checkpoint);

    try {
      for (const category of CATEGORY_ORDER) {
        const live = await liveCategoryDigest(category, target);
        const exp = checkpoint.expected[category];
        if (live.count !== exp.count || live.digest !== exp.digest) {
          await applyCategory(category, target, staged[category]);
        } // else: already correct — no destructive operation performed, regardless of prior checkpoint state
        await _testCrashWindowHook(category); // test-only (T058), no-op in real operation
        checkpoint.categoriesApplied.push(category);
        writeCheckpoint(target, checkpoint);
        await _testBetweenCategoriesFailHook(category); // test-only (T057), no-op in real operation
      }
    } catch (applyErr) {
      checkpoint.stage = 'failed';
      checkpoint.error = applyErr.message;
      writeCheckpoint(target, checkpoint);
      console.error('❌ فشل التطبيق:', applyErr.message);
      console.log(RECOVERY_MESSAGE);
      await recordAuditEvent(target, isMongoMode, 'failure', {
        backupFingerprint: validation.checksum, createdAt: backup.createdAt, categoriesApplied: checkpoint.categoriesApplied,
      });
      process.exitCode = 1;
      return;
    }

    // Step 6 — finalize.
    checkpoint.stage = 'completed';
    writeCheckpoint(target, checkpoint);

    const staleCount = await countStaleIdempotency(target, backup.createdAt, isMongoMode);
    try { fs.unlinkSync(stagingFilePath(target)); } catch (e) { if (e.code !== 'ENOENT') console.warn(`⚠️ تعذّر حذف ملف التجهيز المؤقت: ${e.message}`); }

    console.log(`✅ اكتملت استعادة المستأجر "${target}" فقط، عبر فلاتر مخصّصة لهذا المستأجر — لم تُكتب بيانات أي مستأجر آخر في هذه العملية.`);
    console.log('⚠️ مهم: أي عملية سيرفر تخدم هذا المستأجر حالياً تحتفظ بذاكرة مؤقتة (cache) قديمة ويجب إعادة تشغيلها الآن، قبل أي كتابة أخرى لهذا المستأجر، وإلا فقد تُلغى هذه الاستعادة صمتاً.');
    if (staleCount > 0) {
      console.log(`ℹ️ ملاحظة: يوجد ${staleCount} سجل(ات) idempotency لهذا المستأجر اكتملت بعد وقت أخذ النسخة المستعادة. أي طلب متكرر يطابق أحدها سيُعاد له نفس النتيجة المخزّنة (عبر sourceId أو journalId) حتى لو لم يعد الكيان الأصلي موجوداً بعد الاستعادة. هذا خطر متبقٍّ معروف ومُبلَّغ عنه فقط (بدون إصلاح تلقائي) — راجع docs/PRODUCTION_RUNBOOK.md.`);
    } else {
      console.log('ℹ️ لا يوجد أي سجل idempotency معرّض للخطر (0).');
    }

    await recordAuditEvent(target, isMongoMode, 'success', {
      backupFingerprint: validation.checksum, createdAt: backup.createdAt, categoriesApplied: checkpoint.categoriesApplied,
    });
  } catch (e) {
    // Genuinely unexpected failures only reach here — every named terminal
    // outcome the contract audits (Step 1, Step 2, Step 4a's decline, Step
    // 5/6's own success-or-failure) already returns from inside the try
    // block above with its own audit call. Step 3's own digest/ownership
    // checks are a defense-in-depth double-check that should never actually
    // fire for any backup that already passed Step 1 (its recompute is a
    // no-op re-strip of the same content Step 1 just verified) — a
    // RestoreFailure reaching here means something is genuinely wrong and
    // isn't one of the four audited families, so no dedicated audit call.
    console.error('❌ فشل غير متوقع:', e.message);
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
  stageBackup, ownershipConsistent, stagingFilePath, checkpointPath,
  applyCategory, liveCategoryDigest, categoryLiveFilter, CATEGORY_ORDER,
  // Exported for direct unit-testing of the lock's own ownership/atomicity
  // guarantees — precise, fast, and independent of real-process spawn
  // timing. _forceUnlockTakeover specifically lets a test simulate a
  // stale-vs-fresh race deterministically: capture a runId before a
  // takeover happens, then attempt the SAME compare-and-swap against it
  // afterward, proving it correctly fails rather than stealing the new
  // legitimate lock.
  acquireLockMongo, forceTakeoverLockMongo, releaseLockMongo, _forceUnlockTakeover,
};
