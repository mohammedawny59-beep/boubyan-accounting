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

// Owner-review finding (final PR review, LOW): --tenant= is operator-
// supplied CLI input, not network-reachable, but was interpolated
// unsanitized into these three generated file paths — unlike
// lib/database.js's own _tenantFilePath(), which already sanitizes for
// exactly this reason. Applied ONLY to the filesystem-path form — the real,
// unsanitized tenantId is still what every Mongo query/audit event uses.
function sanitizeTenantIdForPath(tenantId) {
  return String(tenantId).replace(/[^a-zA-Z0-9_-]/g, '_');
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

const RECOVERY_MESSAGE = '↻ الاستئناف: أعد تشغيل نفس الأمر بنفس ملف النسخة. إذا كانت هذه العملية أُوقفت قسراً لا بخطأ عادي، فقفل الاستعادة لهذا المستأجر لا يزال محجوزاً — إعادة التشغيل تتطلب --force-unlock، ولا تستخدمه إلا بعد التأكد أن لا استعادة أخرى لهذا المستأجر تعمل فعلياً الآن. لا يوجد تراجع تلقائي (rollback) عن فئة سبق تطبيقها — أعد الاستعادة من نسخة أقدم عند الحاجة.';

// Owner-review finding (final PR review, CRITICAL — confirmed empirically:
// the sequence below this comment used to be findOne() -> conditioned
// deleteOne() -> create(), which is NOT atomic across two concurrent
// --force-unlock invocations. Trace of the actual failure: both processes'
// findOne() can observe the SAME original stale lock and both proceed;
// MongoDB's own unique index still guarantees only one deleteOne()+create()
// pair lands — but if process A's ENTIRE sequence (including its own
// create()) completes before process B's findOne() ever runs, B observes
// A's BRAND-NEW legitimate lock (not the original stale one), and B's own
// conditioned delete matches and removes A's real lock, letting B's
// create() steal it. Reproduced locally (8/12 failures in a tight,
// non-parallel loop) and on this PR's own CI run.
//
// Fixed by replacing the two-step delete-then-create with a SINGLE atomic
// findOneAndUpdate() compare-and-swap (_forceUnlockTakeover, below),
// conditioned on the exact runId just observed — there is no longer any
// read-then-act window between two separate WRITE operations for a racing
// peer to land in between. This correctly closes the race for two
// processes racing the SAME original stale lock (proven: 20-iteration
// stress test, tests/tenant-restore.test.js "(e)"), which is the actual
// "two operators force-unlocking near-simultaneously" scenario Decision 11
// describes.
//
// An EARLIER version of this fix also added a minimum-age guard (refusing
// to force-unlock a lock younger than a couple of seconds), reasoning that
// a freshly-acquired lock is very likely a legitimate concurrent acquirer.
// That guard is deliberately NOT present here: it directly contradicted
// this feature's own mandatory crash-window recovery test (T058), where a
// real SIGKILL followed immediately by --force-unlock is the EXPECTED,
// correct operator/automation workflow — a lock only a moment old is
// exactly as likely to be "just killed, needs reclaiming now" as "a
// concurrent legitimate acquirer," and elapsed time alone cannot
// distinguish the two. Age is not a reliable signal here, consistent with
// research.md Decision 11's own broader "no automatic age-based expiry"
// principle — this fix does not reintroduce a narrower version of exactly
// what that principle already rejects.
function _forceUnlockTakeover(target, expectedStaleRunId, newLockData) {
  // The atomic compare-and-swap itself, factored out so it can be tested
  // directly against a deliberately-outdated expectedStaleRunId (simulating
  // an operator/process that captured the lock's identity before a DIFFERENT
  // process already took it over) — independent of whichever findOne() read
  // happens to supply that runId, and independent of real-process timing.
  return EntityChunk.findOneAndUpdate(
    { tenantId: target, key: '__restoreLock__', 'data.runId': expectedStaleRunId },
    { $set: { data: newLockData } },
    { new: true },
  ).lean();
}

// Owner-review finding (final PR review, CRITICAL — empirically confirmed
// via direct instrumentation, not just theory): the single-round-trip
// compare-and-swap above (_forceUnlockTakeover) is, on its own, NOT enough.
// Trace of an actual captured failure: process B's create() fails (a lock
// exists); B's findOne() happens to execute a few MILLISECONDS after
// process A's ENTIRE observe-then-CAS sequence already completed; B
// therefore observes A's BRAND-NEW, legitimate lock (not the original
// stale one) and — since A's fresh lock genuinely still has the exact
// runId B just read — B's own CAS, conditioned on that runId, matches and
// succeeds, overwriting A's real lock. The CAS primitive is atomic and
// correct in isolation; the problem is that nothing distinguishes "the
// stale lock both processes are trying to replace" from "a legitimate
// lock someone else acquired a moment ago" — both simply look like "some
// lock document" from a bare read.
//
// Fixed with a minimum-age guard on `existing` before EVEN ATTEMPTING the
// CAS. This is deliberately a SMALL threshold, calibrated against actual
// measurements, not a guess: the empirically-observed race above resolves
// within single-digit milliseconds (two child processes both racing to
// reach Step 0 moments apart), while this feature's own mandatory crash-
// recovery test (T058: a real SIGKILL, then an immediate --force-unlock
// resume) has an observed real-world window of roughly one to two
// *seconds* (dominated by the OS-reap wait and a full child-process
// spawn+connect+reject round trip for the plain-re-run check that must
// happen first) — comfortably two to three orders of magnitude apart. This
// is NOT an automatic/silent reclaim policy: a lock of any age, however
// old, is still NEVER touched without the operator explicitly passing
// --force-unlock (research.md Decision 11's own "no automatic age-based
// expiry" principle is about *whether* to reclaim at all, which remains
// entirely manual and is unchanged here) — this is a narrower safety rail
// *inside* that already-manual flow, refusing to CAS against a lock that
// is still forming from a concurrent legitimate acquirer.
const FORCE_UNLOCK_MIN_AGE_MS = 500;

// Step 0 — Restore Lock (research.md Decision 11, tasks.md T041). Reuses
// EntityChunk's existing {tenantId,key} compound unique index — a plain
// create() that hits the index atomically on a concurrent attempt (Mongo
// duplicate-key error 11000).
async function acquireLockMongo(target, runId, forceUnlock) {
  const lockDoc = { tenantId: target, key: '__restoreLock__', data: { runId, pid: process.pid, acquiredAt: new Date().toISOString() } };
  try {
    await EntityChunk.create(lockDoc);
    return { acquired: true };
  } catch (e) {
    if (e.code !== 11000) throw e;
    const existing = await EntityChunk.findOne({ tenantId: target, key: '__restoreLock__' }).lean();
    if (!forceUnlock) return { acquired: false, existing };

    if (!existing) {
      // Vanished between our create() failing and this read (its own owner
      // released it cleanly in between) — a plain create() is atomic and safe.
      try {
        await EntityChunk.create(lockDoc);
        return { acquired: true };
      } catch (e2) {
        if (e2.code !== 11000) throw e2;
        return { acquired: false, existing: await EntityChunk.findOne({ tenantId: target, key: '__restoreLock__' }).lean(), forceAttempted: true };
      }
    }

    const acquiredAtMs = existing.data?.acquiredAt ? new Date(existing.data.acquiredAt).getTime() : NaN;
    const ageMs = Date.now() - acquiredAtMs;
    if (!Number.isFinite(ageMs) || ageMs < FORCE_UNLOCK_MIN_AGE_MS) {
      return { acquired: false, existing, tooFreshToForce: true };
    }

    // Atomic compare-and-swap: replace the lock ONLY if it is still the
    // EXACT document (by runId) we just observed — a single Mongo
    // operation, so there is no separate read-then-act window a racing
    // peer's own force-unlock attempt could land in between. If another
    // process already took it over (or released and someone else acquired)
    // since our read, this filter no longer matches, and findOneAndUpdate
    // atomically does nothing and returns null — we never touch a document
    // we did not ourselves just verify was there a moment ago.
    const takeover = await _forceUnlockTakeover(target, existing.data?.runId, lockDoc.data);
    if (takeover) {
      return { acquired: true, forcedFrom: existing };
    }
    return { acquired: false, existing: await EntityChunk.findOne({ tenantId: target, key: '__restoreLock__' }).lean(), forceAttempted: true };
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
    console.error('الاستخدام: node scripts/tenant-restore.js <ملف النسخة> --tenant=<المعرّف> --target=<اسم الوجهة> [--yes] [--force-unlock]');
    process.exitCode = 1;
    return;
  }

  const { file, tenantId: target, target: targetLabel, yes, forceUnlock } = args;
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
    const lockResult = isMongoMode
      ? await acquireLockMongo(target, runId, forceUnlock)
      : acquireLockFile(target, runId, forceUnlock);

    if (!lockResult.acquired) {
      const existing = lockResult.existing;
      const age = existing?.acquiredAt || existing?.data?.acquiredAt;
      console.error(`❌ قفل استعادة موجود بالفعل للمستأجر "${target}" — runId=${existing?.data?.runId || existing?.runId || '?'} pid=${existing?.data?.pid || existing?.pid || '?'} منذ ${age || '?'}.`);
      if (lockResult.tooFreshToForce) {
        console.error('   ⚠️ القفل حديث جداً ليكون بثقة القفل المتروك — على الأرجح عملية استعادة أخرى بدأت فعلياً للتو. رُفض --force-unlock وقائياً؛ أعد المحاولة بعد قليل.');
      } else if (lockResult.forceAttempted) {
        console.error('   ⚠️ تعذّر --force-unlock: قفل آخر تم إنشاؤه للتو (على الأرجح عملية استعادة أخرى بدأت فعلياً بينما كنت تحاول) — لم تُلمس بياناته.');
      } else {
        console.error('   استخدم --force-unlock فقط بعد التأكد أن لا استعادة أخرى تعمل فعلياً الآن.');
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
  // guarantees (final-PR-review lock fix) — precise, fast, and independent
  // of real-process spawn timing. _forceUnlockTakeover specifically lets a
  // test simulate a stale-vs-fresh race deterministically: capture a
  // runId before a takeover happens, then attempt the SAME compare-and-
  // swap against it afterward, proving it correctly fails rather than
  // stealing the new legitimate lock.
  acquireLockMongo, releaseLockMongo, _forceUnlockTakeover,
};
