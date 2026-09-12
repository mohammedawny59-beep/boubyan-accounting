// P4 — Phase E: Restore Lock + Validation Gate (T037-T045)
// specs/002-tenant-isolation-backup-hardening/contracts/tenant-restore-contract.md
// Steps -1, 0, 1 (incl. 1.8), 2 only — staging/checkpoint-write/apply do not
// exist yet (tasks.md T045's own checkpoint). scripts/tenant-restore.js is
// spawned as a real child process (execSync), same established precedent as
// tests/tenant-backup.test.js and tests/r3-mongo-backup-restore.test.js.

process.env.JWT_SECRET = 'p4-tenant-restore-secret';
process.env.NODE_ENV   = 'test';

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const mongoose = require('mongoose');
const { execSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p4-tenant-restore-'));
const DATA_FILE = path.join(tmp, 'database.json');
const CONFIG_FILE = path.join(tmp, 'config.json');
const backupDir = path.join(tmp, 'backups');
// Set BEFORE any require('../scripts/tenant-restore') in this process — that
// module reads process.env.BACKUP_DIR into module-level consts (STAGING_DIR/
// CHECKPOINTS_DIR) at require-time, exactly like scripts/tenant-backup.js
// does for BACKUP_DIR itself. Without this, an in-process stageBackup()/
// applyCategory() unit call (used later in this file) would resolve those
// paths against the REAL project's backups/ directory instead of this
// file's own isolated tmp dir.
process.env.BACKUP_DIR = backupDir;

const { validateBackupObject, validateTenantBackupObject, computeCategoryDigest } = require('../lib/backupValidation');
const { _setDataFileForTooling } = require('../lib/database');
const User = require('../models/User');
const EntityChunk = require('../models/EntityChunk');
const AppConfig = require('../models/AppConfig');
const Tenant = require('../models/Tenant');
const { startIsolatedMongo } = require('./helpers/mongoTestHarness');

_setDataFileForTooling(DATA_FILE);

async function seedActiveTenant(tenantId) {
  await Tenant.create({ tenantId, name: tenantId, slug: tenantId, email: `${tenantId}@example.com`, status: 'active' });
}

function runBackup(tenantId, envOverrides) {
  return execSync(`node scripts/tenant-backup.js --tenant=${tenantId}`, {
    cwd: ROOT, env: { ...process.env, BACKUP_DIR: backupDir, ...envOverrides }, stdio: 'pipe',
  }).toString();
}

function latestTenantBackupFile(tenantId) {
  const files = fs.readdirSync(backupDir).filter(f => f.startsWith(`tenant-${tenantId}-`) && f.endsWith('.json')).sort();
  return files.length ? path.join(backupDir, files[files.length - 1]) : null;
}

function runRestore(argsString, envOverrides) {
  try {
    const out = execSync(`node scripts/tenant-restore.js ${argsString}`, {
      cwd: ROOT, env: { ...process.env, RESTORE_YES: '1', ...envOverrides }, stdio: 'pipe',
    });
    return { status: 0, stdout: out.toString() };
  } catch (e) {
    return { status: e.status, stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '' };
  }
}

// Backup filenames carry a second-precision stamp — two backups for the
// same tenant created within the same second would collide on filename.
// Mirrors tests/tenant-backup.test.js's own identical helper.
function waitPastSecondBoundary() {
  const now = Date.now();
  while (Date.now() - now < 1100) { /* busy-wait */ }
}

// T053a: no RESTORE_YES default here — used to exercise Step 4a's own
// interactive prompt by piping typed input on stdin.
function runRestoreInteractive(argsString, envOverrides, stdinInput) {
  const env = { ...process.env, ...envOverrides };
  delete env.RESTORE_YES;
  try {
    const out = execSync(`node scripts/tenant-restore.js ${argsString}`, {
      cwd: ROOT, env, stdio: 'pipe', input: stdinInput,
    });
    return { status: 0, stdout: out.toString() };
  } catch (e) {
    return { status: e.status, stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '' };
  }
}

const QUIESCE_SUBSTRING = 'تحذير قبل البدء: أوقف حركة الطلبات الحية';

async function getDefaultAuditEvents() {
  const doc = await EntityChunk.findOne({ tenantId: 'default', key: 'auditLog' }).lean();
  return doc?.data || [];
}

function readCheckpoint(tenantId) {
  return fs.readJsonSync(path.join(backupDir, '.restore-checkpoints', `${tenantId}.json`));
}

function checkpointFilePath(tenantId) {
  return path.join(backupDir, '.restore-checkpoints', `${tenantId}.json`);
}

function stagingFileOnDisk(tenantId) {
  return path.join(backupDir, '.restore-staging', `${tenantId}.json`);
}

describe('P4 Phase E — tenant-restore.js Steps -1/0/1/2 (T037-T045)', () => {
  let mongoInstance;
  let mongoEnv;

  beforeAll(async () => {
    mongoInstance = await startIsolatedMongo('p4-tenant-restore');
    await mongoose.connect(mongoInstance.uri);
    // Owner-review finding (final PR review): Mongoose builds a schema's
    // indexes in the background unless explicitly awaited (this codebase's
    // own P0.12 precedent, IdempotencyRecord.init()). The lock-contention
    // tests below depend on EntityChunk's {tenantId,key} unique index being
    // fully enforced from their very first write — without this, the
    // earliest iterations of a tight concurrency stress loop against a
    // freshly-connected instance could race ahead of index construction and
    // spuriously observe two "winners," independent of tenant-restore.js's
    // own actual lock-acquisition logic.
    await EntityChunk.init();
    // Belt-and-suspenders on top of init(): actually EXERCISE the unique
    // index once (a real duplicate-key attempt) before any real test runs.
    // init()'s own promise resolving does not, by itself, fully rule out a
    // narrow window where the index isn't yet enforced against a query from
    // a DIFFERENT, freshly-connecting client (exactly the shape of failure
    // this file's own lock-contention stress test would otherwise spuriously
    // exhibit only on its very first iteration).
    await EntityChunk.create({ tenantId: '__warmup__', key: '__warmup__', data: {} });
    await EntityChunk.create({ tenantId: '__warmup__', key: '__warmup__', data: {} }).then(
      () => { throw new Error('unique index warm-up: a duplicate insert unexpectedly succeeded'); },
      (e) => { if (e.code !== 11000) throw e; },
    );
    await EntityChunk.deleteMany({ tenantId: '__warmup__' });
    mongoEnv = { ...process.env, MONGO_URI: mongoInstance.uri, DATA_FILE, CONFIG_FILE, BACKUP_DIR: backupDir };
  }, 120000);

  afterAll(async () => {
    try { await mongoose.connection.close(); } catch {}
    if (mongoInstance) { try { await mongoInstance.stop(); } catch {} }
    try { fs.removeSync(tmp); } catch {}
  });

  // ── T040a: Step -1 quiesce warning, unconditional ──────────────────────
  describe('Step -1: pre-restore quiesce warning', () => {
    test('prints on an invocation missing required flags (before argument-parsing rejects)', () => {
      const res = runRestore('', mongoEnv);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(QUIESCE_SUBSTRING);
    });

    test('prints on an invocation that fails at Step 0 (lock contention)', async () => {
      await seedActiveTenant('e-warn-lock');
      const backupFile = latestBackupOrCreate('e-warn-lock', mongoEnv);
      // Hold the lock first via a raw EntityChunk insert, simulating an in-flight restore.
      await EntityChunk.create({ tenantId: 'e-warn-lock', key: '__restoreLock__', data: { runId: 'held-by-other', pid: 999999, acquiredAt: new Date().toISOString() } });
      const res = runRestore(`"${backupFile}" --tenant=e-warn-lock --target=t1`, mongoEnv);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(QUIESCE_SUBSTRING);
      await EntityChunk.deleteOne({ tenantId: 'e-warn-lock', key: '__restoreLock__' });
    });

    test('prints on an invocation that fails at Step 1 (malformed backup file)', () => {
      const badFile = path.join(tmp, 'not-a-real-backup.json');
      fs.writeJsonSync(badFile, { hello: 'world' });
      const res = runRestore(`"${badFile}" --tenant=whatever --target=t1`, mongoEnv);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(QUIESCE_SUBSTRING);
    });
  });

  function latestBackupOrCreate(tenantId, env) {
    runBackup(tenantId, env);
    return latestTenantBackupFile(tenantId);
  }

  // Owner-review finding (lean review, post-implementation): Step 5's apply
  // has no file-mode implementation — a file-mode tenant backup (fully
  // supported and tested by tenant-backup.js) could otherwise never be
  // restored, hanging on a raw Mongoose command-buffering timeout instead
  // of failing immediately and honestly. tenant-restore.js now rejects a
  // file-mode invocation (no MONGO_URI) instantly, before Step 0's lock is
  // even acquired.
  describe('File-mode restore is rejected immediately, not left to hang on a Mongoose timeout', () => {
    test('a file-mode invocation (no MONGO_URI) is rejected instantly, before any lock is acquired, with a clear Arabic message', async () => {
      await seedActiveTenant('j-file-mode-guard');
      const file = latestBackupOrCreate('j-file-mode-guard', mongoEnv);

      const fileModeEnv = { ...mongoEnv };
      delete fileModeEnv.MONGO_URI;

      const start = Date.now();
      const res = runRestore(`"${file}" --tenant=j-file-mode-guard --target=t1`, fileModeEnv);
      const elapsedMs = Date.now() - start;

      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('وضع الملفات');
      expect(elapsedMs).toBeLessThan(5000); // instant rejection, not the ~10s Mongoose buffering timeout

      // No lock was ever acquired for this rejected, file-mode attempt —
      // confirmed against the REAL (Mongo-mode) tenant, since a file-mode
      // run never even connects to it.
      const lockDoc = await EntityChunk.findOne({ tenantId: 'j-file-mode-guard', key: '__restoreLock__' }).lean();
      expect(lockDoc).toBeNull();
    });
  });

  // ── T041: Step 0 restore lock ───────────────────────────────────────────
  describe('Step 0: restore lock', () => {
    test('acquires cleanly when no lock is held, and releases it on completion', async () => {
      await seedActiveTenant('e-lock-clean');
      const file = latestBackupOrCreate('e-lock-clean', mongoEnv);
      const res = runRestore(`"${file}" --tenant=e-lock-clean --target=t1`, mongoEnv);
      expect(res.status).toBe(0);
      const lockDoc = await EntityChunk.findOne({ tenantId: 'e-lock-clean', key: '__restoreLock__' }).lean();
      expect(lockDoc).toBeNull(); // released on the clean exit
    });

    test('a second invocation is rejected while a lock is held, before the backup file is even read', async () => {
      await seedActiveTenant('e-lock-contend');
      const file = latestBackupOrCreate('e-lock-contend', mongoEnv);
      await EntityChunk.create({ tenantId: 'e-lock-contend', key: '__restoreLock__', data: { runId: 'other-run', pid: 123, acquiredAt: new Date().toISOString() } });

      const res = runRestore(`"${file}" --tenant=e-lock-contend --target=t1`, mongoEnv);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('قفل استعادة موجود');
      // still exactly the ORIGINAL lock — never overwritten by the rejected attempt
      const lockDoc = await EntityChunk.findOne({ tenantId: 'e-lock-contend', key: '__restoreLock__' }).lean();
      expect(lockDoc.data.runId).toBe('other-run');

      await EntityChunk.deleteOne({ tenantId: 'e-lock-contend', key: '__restoreLock__' });
    });

    test('--force-unlock, given the exact reported lock identity, recovers a stale lock via an identity-bound compare-and-swap, then proceeds', async () => {
      await seedActiveTenant('e-lock-force');
      const file = latestBackupOrCreate('e-lock-force', mongoEnv);
      await EntityChunk.create({ tenantId: 'e-lock-force', key: '__restoreLock__', data: { runId: 'stale-crashed-run', pid: 1, acquiredAt: new Date().toISOString() } });

      const withoutForce = runRestore(`"${file}" --tenant=e-lock-force --target=t1`, mongoEnv);
      expect(withoutForce.status).not.toBe(0); // plain re-run still rejected — no silent auto-recovery
      expect(withoutForce.stderr).toContain('runId=stale-crashed-run'); // the exact identity to force is reported, never left to guesswork

      // A bare --force-unlock (no expected identity) must be rejected before Step 0.
      const bareForce = runRestore(`"${file}" --tenant=e-lock-force --target=t1 --force-unlock`, mongoEnv);
      expect(bareForce.status).not.toBe(0);
      expect(bareForce.stderr).toContain('--expected-lock-run-id=');
      const lockDocStillStale = await EntityChunk.findOne({ tenantId: 'e-lock-force', key: '__restoreLock__' }).lean();
      expect(lockDocStillStale.data.runId).toBe('stale-crashed-run'); // untouched by the rejected bare attempt

      const withForce = runRestore(`"${file}" --tenant=e-lock-force --target=t1 --force-unlock --expected-lock-run-id=stale-crashed-run`, mongoEnv);
      expect(withForce.status).toBe(0);
      const lockDoc = await EntityChunk.findOne({ tenantId: 'e-lock-force', key: '__restoreLock__' }).lean();
      expect(lockDoc).toBeNull(); // released again after the forced run completed cleanly
    });
  });

  // ── T038/T042: Step 1 validation gate ──────────────────────────────────
  describe('Step 1: validation gate', () => {
    test('a genuinely valid tenant backup passes Step 1 and the run completes successfully', async () => {
      await seedActiveTenant('e-valid');
      const file = latestBackupOrCreate('e-valid', mongoEnv);
      const res = runRestore(`"${file}" --tenant=e-valid --target=t1`, mongoEnv);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('اكتملت استعادة المستأجر');
    });

    test('a whole-instance backup file (no scope) fed to tenant-restore.js is rejected at Step 1.2', async () => {
      const wholeInstanceFile = path.join(tmp, 'whole-instance-style.json');
      fs.writeJsonSync(wholeInstanceFile, { createdAt: new Date().toISOString(), version: 2, source: 'file', database: {} });
      const res = runRestore(`"${wholeInstanceFile}" --tenant=whatever --target=t1`, mongoEnv);
      expect(res.status).not.toBe(0);
    });

    test('a tenant-mismatched backup (backup.tenantId !== --tenant=) is rejected', async () => {
      await seedActiveTenant('e-mismatch-a');
      const file = latestBackupOrCreate('e-mismatch-a', mongoEnv);
      const res = runRestore(`"${file}" --tenant=some-other-tenant --target=t1`, mongoEnv);
      expect(res.status).not.toBe(0);
    });

    test('whole-instance separation: real validators reject each format for the OTHER tool (cross-feed, no reimplementation)', async () => {
      await seedActiveTenant('e-crossfeed');
      const file = latestBackupOrCreate('e-crossfeed', mongoEnv);
      const tenantBackup = fs.readJsonSync(file);
      expect(validateBackupObject(tenantBackup).ok).toBe(false); // whole-instance validator rejects a tenant-scoped file

      const wholeInstance = { createdAt: new Date().toISOString(), version: 2, source: 'file', database: {} };
      expect(validateTenantBackupObject(wholeInstance, 'e-crossfeed').ok).toBe(false); // tenant validator rejects a whole-instance shape
    });
  });

  // ── T043: Step 1.8 fingerprint check ────────────────────────────────────
  describe('Step 1.8: backup-fingerprint check against an existing checkpoint', () => {
    test('a mismatched fingerprint against a pre-existing, non-completed checkpoint is hard-rejected', async () => {
      await seedActiveTenant('e-fingerprint');
      const file = latestBackupOrCreate('e-fingerprint', mongoEnv);

      const checkpointDir = path.join(backupDir, '.restore-checkpoints');
      fs.ensureDirSync(checkpointDir);
      const checkpointFile = path.join(checkpointDir, 'e-fingerprint.json');
      fs.writeJsonSync(checkpointFile, { targetTenantId: 'e-fingerprint', stage: 'staged', backupFingerprint: 'deliberately-wrong-fingerprint' });

      try {
        const res = runRestore(`"${file}" --tenant=e-fingerprint --target=t1`, mongoEnv);
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('بصمة');
      } finally {
        try { fs.removeSync(checkpointFile); } catch {}
      }
    });
  });

  // ── T044: Step 2 default-tenant duplicate pre-flight (live database) ──
  describe('Step 2: default-tenant duplicate pre-flight against the live database', () => {
    test('a genuine duplicate default identity in the live database hard-fails, names the identity, writes nothing further', async () => {
      const file = latestBackupOrCreate('default', mongoEnv);

      await User.collection.insertOne({ id: 'restore-dup-1', username: 'legacy', passwordHash: 'x', role: 'admin', active: true });
      await User.create({ tenantId: 'default', id: 'restore-dup-1', username: 'explicit', passwordHash: 'x', role: 'admin', active: true });

      const res = runRestore(`"${file}" --tenant=default --target=t1`, mongoEnv);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('restore-dup-1');

      await User.deleteMany({ id: 'restore-dup-1' });
    });
  });

  // ── T046-T051: Phase F — offline/logical restore staging ───────────────
  describe('Step 3: offline/logical staging (no live-Mongo writes)', () => {
    // Direct stageBackup() unit calls, not the full CLI: Phase G's Steps 4-6
    // now run to completion after Step 3 (given a valid, confirmed backup),
    // and Step 6 deletes the staging file on success (T056c) — so "the
    // staging file exists" / "nothing live was touched" are only meaningful
    // as claims about Step 3 ITSELF, tested in isolation, exactly like the
    // digest-check/ownership-check tests below already do.
    test('sanitization strips _id/__v from every staged record, and the staging file is written at the tenant-keyed path', async () => {
      const { stageBackup, stagingFilePath } = require('../scripts/tenant-restore');
      await seedActiveTenant('f-stage-basic');
      await EntityChunk.create({ tenantId: 'f-stage-basic', key: 'vendors', data: [{ id: 'V1' }] });
      const file = latestBackupOrCreate('f-stage-basic', mongoEnv);
      const backup = fs.readJsonSync(file); // Mongo-sourced — collections.entityChunks still carries real _id/__v, per Decision 9

      const staged = stageBackup(backup, 'f-stage-basic');
      const allRecords = [...staged.users, ...staged.entityChunks, ...staged.appConfigs];
      expect(allRecords.length).toBeGreaterThan(0);
      for (const r of allRecords) {
        expect('_id' in r).toBe(false);
        expect('__v' in r).toBe(false);
      }

      const stagingFile = stagingFilePath('f-stage-basic');
      expect(fs.existsSync(stagingFile)).toBe(true);
      expect(fs.readJsonSync(stagingFile)).toEqual(staged);
    });

    test('stageBackup() makes zero live database writes — the full live document set is unchanged before/after a direct call', async () => {
      const { stageBackup } = require('../scripts/tenant-restore');
      await seedActiveTenant('f-stage-noop');
      await EntityChunk.create({ tenantId: 'f-stage-noop', key: 'vendors', data: [{ id: 'V1' }] });
      const file = latestBackupOrCreate('f-stage-noop', mongoEnv);
      const backup = fs.readJsonSync(file);

      const usersBefore = await User.find({}).lean();
      const chunksBefore = await EntityChunk.find({}).lean();
      const configsBefore = await AppConfig.find({}).lean();

      stageBackup(backup, 'f-stage-noop'); // pure — no Mongo call anywhere in its own implementation

      const usersAfter = await User.find({}).lean();
      const chunksAfter = await EntityChunk.find({}).lean();
      const configsAfter = await AppConfig.find({}).lean();

      const sortById = arr => [...arr].map(d => JSON.stringify(d)).sort();
      expect(sortById(usersAfter)).toEqual(sortById(usersBefore));
      expect(sortById(configsAfter)).toEqual(sortById(configsBefore));
      expect(sortById(chunksAfter)).toEqual(sortById(chunksBefore));
    });

    test('the recomputed digest check catches tampered collections content independently of Step 1 (direct unit call)', async () => {
      const { stageBackup } = require('../scripts/tenant-restore');
      const users = [{ id: 'u1', tenantId: 'f-digest-unit', username: 'x' }];
      const entityChunks = [];
      const appConfigs = [];
      const backup = {
        scope: 'tenant', schemaVersion: 1, tenantId: 'f-digest-unit', createdAt: new Date().toISOString(), source: 'mongodb',
        recordCounts: { users: 1, entityChunks: 0, appConfigs: 0 },
        // deliberately WRONG digest for a non-empty users array — the
        // real backup tool would never produce this; a hand-edited or
        // corrupted file could.
        categoryDigests: { users: computeCategoryDigest([]), entityChunks: computeCategoryDigest([]), appConfigs: computeCategoryDigest([]) },
        collections: { users, entityChunks, appConfigs },
      };
      expect(() => stageBackup(backup, 'f-digest-unit')).toThrow(/digest/);
    });

    test('ownership validation catches an internally-inconsistent record (direct unit call)', async () => {
      const { stageBackup } = require('../scripts/tenant-restore');
      // A record whose OWN tenantId belongs to a different tenant than the
      // restore target, with categoryDigests/recordCounts correctly
      // matching this tampered content (so Step 3's digest check alone
      // would NOT catch it) — isolates the ownership check specifically.
      const users = [{ id: 'u1', tenantId: 'some-other-tenant', username: 'x' }];
      const entityChunks = [];
      const appConfigs = [];
      const backup = {
        scope: 'tenant', schemaVersion: 1, tenantId: 'f-ownership-unit', createdAt: new Date().toISOString(), source: 'mongodb',
        recordCounts: { users: 1, entityChunks: 0, appConfigs: 0 },
        categoryDigests: {
          users: computeCategoryDigest(users), entityChunks: computeCategoryDigest([]), appConfigs: computeCategoryDigest([]),
        },
        collections: { users, entityChunks, appConfigs },
      };
      expect(() => stageBackup(backup, 'f-ownership-unit')).toThrow(/tenantId inconsistent/);
    });
  });

  // ── T052/T053: checkpoint lifecycle ─────────────────────────────────────
  describe('Step 4: checkpoint lifecycle', () => {
    test('a completed run leaves a checkpoint at the tenant-keyed path with runId as a field, expected, and backupFingerprint', async () => {
      await seedActiveTenant('g-checkpoint');
      const file = latestBackupOrCreate('g-checkpoint', mongoEnv);
      const res = runRestore(`"${file}" --tenant=g-checkpoint --target=t1`, mongoEnv);
      expect(res.status).toBe(0);

      const cp = readCheckpoint('g-checkpoint');
      expect(cp.targetTenantId).toBe('g-checkpoint');
      expect(typeof cp.runId).toBe('string');
      expect(cp.expected.users).toBeTruthy();
      expect(cp.expected.entityChunks).toBeTruthy();
      expect(cp.expected.appConfigs).toBeTruthy();
      expect(cp.backupFingerprint).toBeTruthy();
      expect(cp.stage).toBe('completed');
    });

    test('a corrupted checkpoint is treated as no reliable prior record — the run proceeds as fresh, not rejected', async () => {
      await seedActiveTenant('g-corrupt-checkpoint');
      const file = latestBackupOrCreate('g-corrupt-checkpoint', mongoEnv);

      fs.ensureDirSync(path.dirname(checkpointFilePath('g-corrupt-checkpoint')));
      fs.writeFileSync(checkpointFilePath('g-corrupt-checkpoint'), '{not valid json!!!');

      const res = runRestore(`"${file}" --tenant=g-corrupt-checkpoint --target=t1`, mongoEnv);
      expect(res.status).toBe(0); // not rejected by the corrupt file
      const cp = readCheckpoint('g-corrupt-checkpoint');
      expect(cp.stage).toBe('completed'); // overwritten with a fresh, valid checkpoint
    });
  });

  // ── T053a: Step 4a typed confirmation gate ──────────────────────────────
  describe('Step 4a: explicit typed confirmation gate', () => {
    test('no --yes/RESTORE_YES + a non-نعم response cancels cleanly: exit 0, checkpoint stays staged, one outcome:cancelled audit event', async () => {
      await seedActiveTenant('g-decline');
      await EntityChunk.create({ tenantId: 'g-decline', key: 'vendors', data: [{ id: 'V1' }] });
      const file = latestBackupOrCreate('g-decline', mongoEnv);

      const res = runRestoreInteractive(`"${file}" --tenant=g-decline --target=t1`, mongoEnv, 'لا\n');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('أُلغيت الاستعادة');

      const cp = readCheckpoint('g-decline');
      expect(cp.stage).toBe('staged'); // Step 5 never ran

      const events = await getDefaultAuditEvents();
      const cancelled = events.find(e => e.action === 'tenant.restore' && e.resourceId === 'g-decline' && e.outcome === 'cancelled');
      expect(cancelled).toBeTruthy();
      expect(cancelled.tenantId).toBe('g-decline');

      // No lock left behind — released on this clean (non-error) exit too.
      const lockDoc = await EntityChunk.findOne({ tenantId: 'g-decline', key: '__restoreLock__' }).lean();
      expect(lockDoc).toBeNull();
    });

    test('no --yes/RESTORE_YES + typing نعم proceeds to Step 5/6 — no cancelled event', async () => {
      await seedActiveTenant('g-confirm');
      const file = latestBackupOrCreate('g-confirm', mongoEnv);

      const res = runRestoreInteractive(`"${file}" --tenant=g-confirm --target=t1`, mongoEnv, 'نعم\n');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('اكتملت استعادة المستأجر');

      const events = await getDefaultAuditEvents();
      const cancelled = events.find(e => e.action === 'tenant.restore' && e.resourceId === 'g-confirm' && e.outcome === 'cancelled');
      expect(cancelled).toBeFalsy();
    });

    test('--yes skips the prompt non-interactively — no cancelled event', async () => {
      await seedActiveTenant('g-yes-flag');
      const file = latestBackupOrCreate('g-yes-flag', mongoEnv);
      const res = runRestoreInteractive(`"${file}" --tenant=g-yes-flag --target=t1 --yes`, mongoEnv, undefined);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('اكتملت استعادة المستأجر');
    });

    test('RESTORE_YES=1 skips the prompt non-interactively — no cancelled event', async () => {
      await seedActiveTenant('g-restore-yes-env');
      const file = latestBackupOrCreate('g-restore-yes-env', mongoEnv);
      const res = runRestore(`"${file}" --tenant=g-restore-yes-env --target=t1`, mongoEnv); // runRestore's own default sets RESTORE_YES=1
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('اكتملت استعادة المستأجر');
    });

    test('the prompt text contains the target tenant identifier and the --target= label', async () => {
      await seedActiveTenant('g-prompt-text');
      const file = latestBackupOrCreate('g-prompt-text', mongoEnv);
      const res = runRestoreInteractive(`"${file}" --tenant=g-prompt-text --target=staging-label`, mongoEnv, 'نعم\n');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('g-prompt-text');
      expect(res.stdout).toContain('staging-label');
    });
  });

  // ── T054/T055: digest-gated apply ───────────────────────────────────────
  describe('Step 5: digest-gated apply', () => {
    test('a category whose live content already matches the backup is skipped entirely — no destructive operation', async () => {
      await seedActiveTenant('g-skip-match');
      await EntityChunk.create({ tenantId: 'g-skip-match', key: 'vendors', data: [{ id: 'V1', name: 'unchanged' }] });
      const file = latestBackupOrCreate('g-skip-match', mongoEnv);

      const before = await EntityChunk.findOne({ tenantId: 'g-skip-match', key: 'vendors' }).lean();
      const res = runRestore(`"${file}" --tenant=g-skip-match --target=t1`, mongoEnv);
      expect(res.status).toBe(0);
      const after = await EntityChunk.findOne({ tenantId: 'g-skip-match', key: 'vendors' }).lean();
      // A delete+insert always mints a fresh _id — an unchanged _id proves the category was skipped, not redundantly re-applied.
      expect(String(after._id)).toBe(String(before._id));
    });

    test('a category whose live content differs from the backup gets deleted and re-inserted', async () => {
      await seedActiveTenant('g-apply-mismatch');
      await EntityChunk.create({ tenantId: 'g-apply-mismatch', key: 'vendors', data: [{ id: 'V1', name: 'original' }] });
      const file = latestBackupOrCreate('g-apply-mismatch', mongoEnv);

      const before = await EntityChunk.findOne({ tenantId: 'g-apply-mismatch', key: 'vendors' }).lean();
      await EntityChunk.updateOne({ tenantId: 'g-apply-mismatch', key: 'vendors' }, { $set: { data: [{ id: 'V1', name: 'CORRUPTED' }] } });

      const res = runRestore(`"${file}" --tenant=g-apply-mismatch --target=t1`, mongoEnv);
      expect(res.status).toBe(0);
      const after = await EntityChunk.findOne({ tenantId: 'g-apply-mismatch', key: 'vendors' }).lean();
      expect(after.data).toEqual([{ id: 'V1', name: 'original' }]); // reverted to the backup's own content
      expect(String(after._id)).not.toBe(String(before._id)); // a genuinely new document, not an in-place update
    });

    test('entityChunks delete/digest scoping by key: the restore lock (transient) and a live idempotencyRecords document both survive an entityChunks apply', async () => {
      await seedActiveTenant('g-scoped-delete');
      await EntityChunk.create({ tenantId: 'g-scoped-delete', key: 'vendors', data: [{ id: 'V1' }] });
      const file = latestBackupOrCreate('g-scoped-delete', mongoEnv);

      // idempotencyRecords is excluded from every tenant backup/restore payload —
      // it must survive Step 5's entityChunks delete+insert untouched.
      await EntityChunk.create({ tenantId: 'g-scoped-delete', key: 'idempotencyRecords', data: [{ sentinel: 'must-survive' }] });

      // Change vendors so entityChunks is NOT skipped (forces a real delete+insert).
      await EntityChunk.updateOne({ tenantId: 'g-scoped-delete', key: 'vendors' }, { $set: { data: [{ id: 'V1', name: 'changed' }] } });

      const res = runRestore(`"${file}" --tenant=g-scoped-delete --target=t1`, mongoEnv);
      expect(res.status).toBe(0);

      const idempotencyChunk = await EntityChunk.findOne({ tenantId: 'g-scoped-delete', key: 'idempotencyRecords' }).lean();
      expect(idempotencyChunk).toBeTruthy();
      expect(idempotencyChunk.data).toEqual([{ sentinel: 'must-survive' }]);

      const lockDoc = await EntityChunk.findOne({ tenantId: 'g-scoped-delete', key: '__restoreLock__' }).lean();
      expect(lockDoc).toBeNull(); // released cleanly, not swept away mid-run — the run completed
    });

    test('for default, the live-digest check uses _defaultTenantFilter — a legacy no-tenantId-field record already matching the backup is correctly skipped, not spuriously re-applied', async () => {
      // Seed a legacy default user (no tenantId field) directly, then back it up.
      await User.collection.insertOne({ id: 'g-legacy-user', username: 'legacy', passwordHash: 'x', role: 'admin', active: true });
      const file = latestBackupOrCreate('default', mongoEnv);

      const before = await User.findOne({ id: 'g-legacy-user' }).lean();
      expect('tenantId' in before).toBe(false); // still genuinely legacy going into the restore

      const res = runRestore(`"${file}" --tenant=default --target=t1`, mongoEnv);
      expect(res.status).toBe(0);

      const after = await User.findOne({ id: 'g-legacy-user' }).lean();
      // If the digest check had used a bare {tenantId:'default'} filter, it
      // would have UNDER-counted (missed this legacy doc entirely),
      // reported a spurious mismatch, and delete+re-inserted — minting a
      // new _id. An unchanged _id proves _defaultTenantFilter was used and
      // the category was correctly recognized as already-matching.
      expect(String(after._id)).toBe(String(before._id));

      await User.deleteOne({ id: 'g-legacy-user' });
    });

    test('entityChunks insert uses {ordered:false} — one deliberately-invalid record among valid ones never aborts the valid ones (direct unit call)', async () => {
      const { applyCategory } = require('../scripts/tenant-restore');
      await seedActiveTenant('g-ordered-false');

      const records = [
        { tenantId: 'g-ordered-false', key: 'vendors', data: [{ id: 'V1' }] }, // valid
        { tenantId: 'g-ordered-false', key: 'invoices' }, // INVALID — missing required `data` field
        { tenantId: 'g-ordered-false', key: 'expenses', data: [{ id: 'E1' }] }, // valid
      ];
      // {ordered:false}'s whole point: the call resolves (does not abort the
      // batch) even though one record is invalid — confirmed empirically
      // against this codebase's actual Mongoose/MongoDB version, which
      // silently skips only the invalid document rather than rejecting the
      // overall insertMany() call.
      await expect(applyCategory('entityChunks', 'g-ordered-false', records)).resolves.not.toThrow();

      const vendors = await EntityChunk.findOne({ tenantId: 'g-ordered-false', key: 'vendors' }).lean();
      const expenses = await EntityChunk.findOne({ tenantId: 'g-ordered-false', key: 'expenses' }).lean();
      expect(vendors).toBeTruthy(); // landed despite the invalid sibling record
      expect(expenses).toBeTruthy();
      const invoices = await EntityChunk.findOne({ tenantId: 'g-ordered-false', key: 'invoices' }).lean();
      expect(invoices).toBeNull(); // the invalid one alone was skipped, silently
    });
  });

  // ── T056/T056a: Step 6 finalize + restart-message ───────────────────────
  describe('Step 6: finalize', () => {
    test('success output names the target tenant, claims a tenant-scoped restore path, and instructs a server restart (T056a, stable substring)', async () => {
      await seedActiveTenant('g-finalize-msg');
      const file = latestBackupOrCreate('g-finalize-msg', mongoEnv);
      const res = runRestore(`"${file}" --tenant=g-finalize-msg --target=t1`, mongoEnv);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('g-finalize-msg');
      expect(res.stdout).toContain('اكتملت استعادة المستأجر');
      expect(res.stdout).toContain('يجب إعادة تشغيلها الآن'); // T056a: the mandatory restart-requirement message
    });
  });

  // ── T056b: idempotency-staleness count ──────────────────────────────────
  describe('Step 6: idempotency-staleness count', () => {
    test('a non-zero count is printed, sourced from the DEDICATED IdempotencyRecord collection, not the embedded array', async () => {
      const IdempotencyRecord = require('../models/IdempotencyRecord');
      await seedActiveTenant('g-idem-stale');
      const file = latestBackupOrCreate('g-idem-stale', mongoEnv);
      const backupCreatedAt = fs.readJsonSync(file).createdAt;

      // A dedicated-collection record completed AFTER the backup — should count.
      await IdempotencyRecord.create({
        tenantId: 'g-idem-stale', operationScope: 'vendor:create', key: 'k1', fingerprint: 'f1',
        status: 'COMPLETED', completedAt: new Date(new Date(backupCreatedAt).getTime() + 60000),
      });
      // A stale EMBEDDED-array-only record (never in the dedicated collection) must NOT be counted.
      await EntityChunk.create({
        tenantId: 'g-idem-stale', key: 'idempotencyRecords',
        data: [{ status: 'COMPLETED', completedAt: new Date(new Date(backupCreatedAt).getTime() + 60000).toISOString() }],
      });

      const res = runRestore(`"${file}" --tenant=g-idem-stale --target=t1`, mongoEnv);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('يوجد 1 سجل');
    });

    test('a zero count is printed explicitly, not omitted', async () => {
      await seedActiveTenant('g-idem-zero');
      const file = latestBackupOrCreate('g-idem-zero', mongoEnv);
      const res = runRestore(`"${file}" --tenant=g-idem-zero --target=t1`, mongoEnv);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('لا يوجد أي سجل idempotency معرّض للخطر (0)');
    });
  });

  // ── T056c: staging-file cleanup ──────────────────────────────────────────
  describe('Step 6: staging-file cleanup', () => {
    test('the local staging file is deleted on success', async () => {
      await seedActiveTenant('g-staging-cleanup-ok');
      const file = latestBackupOrCreate('g-staging-cleanup-ok', mongoEnv);
      const res = runRestore(`"${file}" --tenant=g-staging-cleanup-ok --target=t1`, mongoEnv);
      expect(res.status).toBe(0);
      expect(fs.existsSync(stagingFileOnDisk('g-staging-cleanup-ok'))).toBe(false);
    });

    test('the local staging file is preserved on a failed apply (forensic artifact)', async () => {
      await seedActiveTenant('g-staging-cleanup-fail');
      const file = latestBackupOrCreate('g-staging-cleanup-fail', mongoEnv);
      const res = runRestore(`"${file}" --tenant=g-staging-cleanup-fail --target=t1`, {
        ...mongoEnv, __TENANT_RESTORE_TEST_FAIL_AFTER__: 'users',
      });
      expect(res.status).not.toBe(0);
      expect(fs.existsSync(stagingFileOnDisk('g-staging-cleanup-fail'))).toBe(true);
    });
  });

  // ── T056d: mandatory audit event, all four terminal-outcome families ────
  describe('Step 6: mandatory audit event (T056d)', () => {
    test('a Step 5 apply failure appends exactly one outcome:failure event with categoriesApplied reflecting what actually landed', async () => {
      await seedActiveTenant('g-audit-apply-fail');
      const file = latestBackupOrCreate('g-audit-apply-fail', mongoEnv);
      const res = runRestore(`"${file}" --tenant=g-audit-apply-fail --target=t1`, {
        ...mongoEnv, __TENANT_RESTORE_TEST_FAIL_AFTER__: 'users',
      });
      expect(res.status).not.toBe(0);

      const events = await getDefaultAuditEvents();
      const matching = events.filter(e => e.action === 'tenant.restore' && e.resourceId === 'g-audit-apply-fail');
      expect(matching.length).toBe(1);
      expect(matching[0].outcome).toBe('failure');
      expect(matching[0].tenantId).toBe('g-audit-apply-fail');
      expect(matching[0].metadata.categoriesApplied).toEqual(['users']);

      // Never written to the target tenant's own log.
      const targetOwn = await EntityChunk.findOne({ tenantId: 'g-audit-apply-fail', key: 'auditLog' }).lean();
      expect(targetOwn).toBeNull();
    });

    test('a default-target restore leaves default\'s own auditLog byte-unchanged except for the one new event appended', async () => {
      await seedActiveTenant('g-audit-default-survives'); // unrelated tenant, just to have created SOME prior audit history
      latestBackupOrCreate('g-audit-default-survives', mongoEnv);

      // Snapshot AFTER creating the 'default' backup file itself — backing
      // up 'default' also appends its own 'tenant.backup' event to this
      // same log (Phase D), so "before" must reflect that, not precede it.
      const file = latestBackupOrCreate('default', mongoEnv);
      const before = await getDefaultAuditEvents();
      expect(before.length).toBeGreaterThan(0); // real prior history exists from earlier tests in this run

      const res = runRestore(`"${file}" --tenant=default --target=t1`, mongoEnv);
      expect(res.status).toBe(0);

      const after = await getDefaultAuditEvents();
      expect(after.length).toBe(before.length + 1);
      // Every prior event survives byte-for-byte (appendAuditEvent unshifts, so prior events are a suffix of the new array).
      expect(after.slice(1)).toEqual(before);
      expect(after[0].action).toBe('tenant.restore');
      expect(after[0].resourceId).toBe('default');
      expect(after[0].outcome).toBe('success');
    });
  });

  // ── T057: MANDATORY failure-injection, documented hook ──────────────────
  describe('T057: failure-injection mid-apply (documented test-only hook)', () => {
    test('a clean failure between users and entityChunks leaves Tenant B untouched, entityChunks/appConfigs at pre-restore state, users matching the backup, checkpoint failed with categoriesApplied:[users], and a plain re-run (no --force-unlock) succeeds', async () => {
      await seedActiveTenant('g-t057-a');
      await seedActiveTenant('g-t057-b');
      await User.create({ tenantId: 'g-t057-a', id: 'ua1', username: 'a-user', passwordHash: 'x', role: 'admin', active: true });
      await EntityChunk.create({ tenantId: 'g-t057-a', key: 'vendors', data: [{ id: 'VA1' }] });
      await EntityChunk.create({ tenantId: 'g-t057-b', key: 'vendors', data: [{ id: 'VB1', sentinel: 'tenant-b-untouched' }] });

      const file = latestBackupOrCreate('g-t057-a', mongoEnv);

      // Corrupt A's own live data post-backup so BOTH users and entityChunks
      // will genuinely need re-applying (not skipped as already-matching).
      await User.updateOne({ tenantId: 'g-t057-a', id: 'ua1' }, { $set: { username: 'CORRUPTED' } });
      await EntityChunk.updateOne({ tenantId: 'g-t057-a', key: 'vendors' }, { $set: { data: [{ id: 'VA1', corrupted: true }] } });
      const entityChunksBefore = await EntityChunk.findOne({ tenantId: 'g-t057-a', key: 'vendors' }).lean();

      const res = runRestore(`"${file}" --tenant=g-t057-a --target=t1`, {
        ...mongoEnv, __TENANT_RESTORE_TEST_FAIL_AFTER__: 'users',
      });
      expect(res.status).not.toBe(0);

      const bAfter = await EntityChunk.findOne({ tenantId: 'g-t057-b', key: 'vendors' }).lean();
      expect(bAfter.data).toEqual([{ id: 'VB1', sentinel: 'tenant-b-untouched' }]); // Tenant B never touched

      const entityChunksAfter = await EntityChunk.findOne({ tenantId: 'g-t057-a', key: 'vendors' }).lean();
      expect(String(entityChunksAfter._id)).toBe(String(entityChunksBefore._id)); // untouched pre-restore state

      const userAfter = await User.findOne({ tenantId: 'g-t057-a', id: 'ua1' }).lean();
      expect(userAfter.username).toBe('a-user'); // users WAS applied — matches the backup

      const cp = readCheckpoint('g-t057-a');
      expect(cp.stage).toBe('failed');
      expect(cp.categoriesApplied).toEqual(['users']);

      // A clean (caught) failure releases the lock — a plain re-run works.
      const rerun = runRestore(`"${file}" --tenant=g-t057-a --target=t1`, mongoEnv);
      expect(rerun.status).toBe(0);
    });
  });

  // ── T058: MANDATORY digest-based crash-window test, real SIGKILL ───────
  describe('T058: digest-based resume across a real process kill (crash window)', () => {
    test('a real SIGKILL between the users DB write and its checkpoint entry requires --force-unlock to resume, and does not redundantly re-apply users', async () => {
      await seedActiveTenant('g-t058');
      await User.create({ tenantId: 'g-t058', id: 'u1', username: 'orig', passwordHash: 'x', role: 'admin', active: true });
      await EntityChunk.create({ tenantId: 'g-t058', key: 'vendors', data: [{ id: 'V1' }] });
      const file = latestBackupOrCreate('g-t058', mongoEnv);

      // Force BOTH categories to need a real apply (not a skip).
      await User.updateOne({ tenantId: 'g-t058', id: 'u1' }, { $set: { username: 'CORRUPTED' } });
      await EntityChunk.updateOne({ tenantId: 'g-t058', key: 'vendors' }, { $set: { data: [{ id: 'V1', corrupted: true }] } });

      const markerPath = path.join(tmp, 'g-t058-kill-marker');
      try { fs.removeSync(markerPath); } catch {}

      const child = spawn('node', ['scripts/tenant-restore.js', file, '--tenant=g-t058', '--target=t1'], {
        cwd: ROOT,
        env: {
          ...mongoEnv, RESTORE_YES: '1',
          __TENANT_RESTORE_TEST_KILL_AFTER__: 'users',
          __TENANT_RESTORE_TEST_KILL_MARKER__: markerPath,
        },
        stdio: 'ignore',
      });

      const deadline = Date.now() + 15000;
      while (!fs.existsSync(markerPath) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(fs.existsSync(markerPath)).toBe(true); // the child genuinely reached the crash window
      child.kill('SIGKILL');
      await new Promise(r => setTimeout(r, 500)); // let the OS actually reap the process

      // users' OWN DB write landed before the kill (that's the whole point
      // of this window) — confirm it directly.
      const userMidCrash = await User.findOne({ tenantId: 'g-t058', id: 'u1' }).lean();
      expect(userMidCrash.username).toBe('orig');

      // The lock was never released (a real kill, not a clean exit) — a
      // plain re-run must be rejected at Step 0, and must report the
      // crashed run's own lock identity so the operator can force-unlock
      // it EXACTLY (never by guessing/inferring).
      const plainRerun = runRestore(`"${file}" --tenant=g-t058 --target=t1`, mongoEnv);
      expect(plainRerun.status).not.toBe(0);
      expect(plainRerun.stderr).toContain('قفل استعادة موجود');
      const staleRunIdMatch = plainRerun.stderr.match(/runId=([0-9a-f]+)/);
      expect(staleRunIdMatch).not.toBeNull();
      const staleRunId = staleRunIdMatch[1];

      // --force-unlock, given the EXACT crashed runId, resumes correctly:
      // users is NOT redundantly re-applied (its _id stays the one the
      // pre-kill write produced), entityChunks proceeds and the whole run
      // completes.
      const userBeforeResume = await User.findOne({ tenantId: 'g-t058', id: 'u1' }).lean();
      const resumed = runRestore(`"${file}" --tenant=g-t058 --target=t1 --force-unlock --expected-lock-run-id=${staleRunId}`, mongoEnv);
      expect(resumed.status).toBe(0);

      const userAfterResume = await User.findOne({ tenantId: 'g-t058', id: 'u1' }).lean();
      expect(String(userAfterResume._id)).toBe(String(userBeforeResume._id)); // not redundantly re-applied
      const vendorsAfterResume = await EntityChunk.findOne({ tenantId: 'g-t058', key: 'vendors' }).lean();
      expect(vendorsAfterResume.data).toEqual([{ id: 'V1' }]); // entityChunks DID get applied on resume

      const cp = readCheckpoint('g-t058');
      expect(cp.stage).toBe('completed');

      // T062: resume after the crash-window scenario completes fully, with
      // no leftover local staging file.
      expect(cp.categoriesApplied).toEqual(['users', 'entityChunks', 'appConfigs']);
      expect(fs.existsSync(stagingFileOnDisk('g-t058'))).toBe(false);
    }, 30000);
  });

  // ── T060: Phase H — recovery behavior, lock contention ──────────────────
  describe('Phase H: recovery behavior and restore lock contention (T060)', () => {
    function spawnRestore(args, envOverrides) {
      return new Promise(resolve => {
        const child = spawn('node', ['scripts/tenant-restore.js', ...args], {
          cwd: ROOT, env: { ...mongoEnv, RESTORE_YES: '1', ...envOverrides }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('close', code => resolve({ code, stdout, stderr }));
      });
    }

    test('(a) MANDATORY: two real concurrent processes against the same tenant — exactly one acquires the lock, the other is rejected before opening the backup file', async () => {
      await seedActiveTenant('h-concurrent');
      const file = latestBackupOrCreate('h-concurrent', mongoEnv);
      const args = [file, '--tenant=h-concurrent', '--target=t1'];

      const [r1, r2] = await Promise.all([spawnRestore(args), spawnRestore(args)]);
      const results = [r1, r2];
      const winners = results.filter(r => r.code === 0);
      const losers = results.filter(r => r.code !== 0);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      expect(losers[0].stderr).toContain('قفل استعادة موجود بالفعل');
    });

    // Test F (owner-mandated deterministic-lock redesign): a bare
    // --force-unlock, with no explicit --expected-lock-run-id=, must fail
    // BEFORE Step 0 — before the lock is even touched, let alone the
    // backup file opened or anything applied.
    test('Test F (redesign-mandated): a bare --force-unlock without an explicit --expected-lock-run-id= is rejected before Step 0', async () => {
      await seedActiveTenant('h-bare-force');
      const file = latestBackupOrCreate('h-bare-force', mongoEnv);
      await EntityChunk.create({ tenantId: 'h-bare-force', key: '__restoreLock__', data: { runId: 'whatever-is-there', pid: 1, acquiredAt: new Date().toISOString() } });

      const res = runRestore(`"${file}" --tenant=h-bare-force --target=t1 --force-unlock`, mongoEnv);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('--expected-lock-run-id=');

      // Never touched — rejected before Step 0 ever ran.
      const lockDoc = await EntityChunk.findOne({ tenantId: 'h-bare-force', key: '__restoreLock__' }).lean();
      expect(lockDoc.data.runId).toBe('whatever-is-there');
      await EntityChunk.deleteOne({ tenantId: 'h-bare-force', key: '__restoreLock__' });
    });

    test('(d) MANDATORY: resuming with a DIFFERENT backup file than the one that partially applied is rejected before any further write', async () => {
      await seedActiveTenant('h-diff-file');
      await EntityChunk.create({ tenantId: 'h-diff-file', key: 'vendors', data: [{ id: 'V1' }] });
      const file1 = latestBackupOrCreate('h-diff-file', mongoEnv);

      const failRes = runRestore(`"${file1}" --tenant=h-diff-file --target=t1`, {
        ...mongoEnv, __TENANT_RESTORE_TEST_FAIL_AFTER__: 'users',
      });
      expect(failRes.status).not.toBe(0); // clean failure — lock released, checkpoint left at 'failed'

      waitPastSecondBoundary();
      await EntityChunk.updateOne({ tenantId: 'h-diff-file', key: 'vendors' }, { $set: { data: [{ id: 'V1', changed: true }] } });
      const file2 = latestBackupOrCreate('h-diff-file', mongoEnv);
      expect(file2).not.toBe(file1);

      // No --force-unlock needed here: the prior run's clean (caught)
      // failure already released the lock in its own finally block — this
      // resume attempt is rejected by Step 1.8's fingerprint check alone.
      const resumeRes = runRestore(`"${file2}" --tenant=h-diff-file --target=t1`, mongoEnv);
      expect(resumeRes.status).not.toBe(0);
      expect(resumeRes.stderr).toContain('بصمة');
    });

    // Owner-review history — this test went through the same three lock
    // designs documented at scripts/tenant-restore.js's own
    // _forceUnlockTakeover comment: (1) a non-atomic delete-then-create
    // (empirically 8/12 failures locally and on CI), (2) a CAS-only fix
    // that spawned two full CLI processes and asserted "exactly one exits
    // 0" — which turned out to be a flaky TEST ASSUMPTION, not a
    // concurrency defect: a fast-completing winner could finish and
    // release its lock before the loser even finished deciding, so both
    // legitimately exited 0 with no lock ever actually stolen, and (3) a
    // wall-clock age-gate fix that an independent owner re-review rejected
    // as TIMING_DEPENDENT_UNSAFE (mutual exclusion must not depend on
    // process timing).
    //
    // FINAL DESIGN under test below: force-takeover requires the caller to
    // name the EXACT lock identity to replace (forceTakeoverLockMongo's
    // expectedOldRunId) — never a self-observed "current lock". Tests B-E
    // below are the redesign's own required regression suite.

    // Test B (redesign-mandated): same stale token race — A and B both
    // force-takeover using the IDENTICAL expected old runId, racing at the
    // real Mongo server. Exactly one succeeds, purely via MongoDB's own
    // per-document atomicity — no wall-clock reasoning anywhere in this
    // path. Stress-tested (not run once) since a single pass proves
    // nothing about a race.
    test('Test B (redesign-mandated): same stale token race — A and B both force-takeover with the identical expected old runId, exactly one succeeds (stress-tested, 20 iterations)', async () => {
      const { forceTakeoverLockMongo, releaseLockMongo } = require('../scripts/tenant-restore');
      const ITERATIONS = 20;
      for (let i = 0; i < ITERATIONS; i++) {
        const tenantId = `h-force-race-${i}`;
        // A genuinely stale lock — acquired well in the past, not "just now".
        await EntityChunk.create({
          tenantId, key: '__restoreLock__',
          data: { runId: 'OLD', pid: 1, acquiredAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
        });

        const runIdA = `race-a-${i}`;
        const runIdB = `race-b-${i}`;
        const [rA, rB] = await Promise.all([
          forceTakeoverLockMongo(tenantId, runIdA, 'OLD'),
          forceTakeoverLockMongo(tenantId, runIdB, 'OLD'),
        ]);
        const results = [rA, rB];
        const winners = results.filter(r => r.acquired === true);
        const losers = results.filter(r => r.acquired === false);
        expect(winners.length).toBe(1); // iteration ${i}
        expect(losers.length).toBe(1);

        // The final lock belongs to exactly the winner — the loser never
        // deleted or overwrote it, and never got a second, different
        // "stale" lock to fall back on.
        const winnerRunId = rA.acquired ? runIdA : runIdB;
        const lockDoc = await EntityChunk.findOne({ tenantId, key: '__restoreLock__' }).lean();
        expect(lockDoc).not.toBeNull();
        expect(lockDoc.data.runId).toBe(winnerRunId);

        await releaseLockMongo(tenantId, winnerRunId);
        const afterRelease = await EntityChunk.findOne({ tenantId, key: '__restoreLock__' }).lean();
        expect(afterRelease).toBeNull();
      }
    }, 60000);

    // Test C (redesign-mandated): the deterministic regression test for the
    // previously-unsafe "Case 2" (see _forceUnlockTakeover's own comment).
    // A already replaced the stale lock with a fresh one; B, holding the
    // OLD expected identity it always intended to replace, attempts force
    // ONLY AFTER A has completed. B must fail, and A's fresh lock must
    // remain completely untouched. No artificial delay or timing is used
    // or needed — simply sequencing the two calls IS the test,
    // deterministically, on every run.
    test('Test C (redesign-mandated): delayed second process — a force-takeover using an old expected runId cannot touch a lock someone else already replaced', async () => {
      const { forceTakeoverLockMongo, releaseLockMongo } = require('../scripts/tenant-restore');
      const tenantId = 'h-delayed-second';

      await EntityChunk.create({
        tenantId, key: '__restoreLock__',
        data: { runId: 'OLD', pid: 1, acquiredAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
      });

      // A successfully replaces OLD with NEW-A.
      const resultA = await forceTakeoverLockMongo(tenantId, 'NEW-A', 'OLD');
      expect(resultA.acquired).toBe(true);

      // ONLY AFTER A has completed, B attempts force using the SAME OLD
      // expected identity it always held (it never re-read the lock in
      // between) — this must fail, and NEW-A must remain untouched.
      const resultB = await forceTakeoverLockMongo(tenantId, 'NEW-B', 'OLD');
      expect(resultB.acquired).toBe(false);

      const lockDoc = await EntityChunk.findOne({ tenantId, key: '__restoreLock__' }).lean();
      expect(lockDoc.data.runId).toBe('NEW-A'); // completely untouched by B's failed attempt

      await releaseLockMongo(tenantId, 'NEW-A');
    });

    // Test D (redesign-mandated): wrong expected token — the current lock
    // is REAL; a force-takeover naming a WRONG expected identity must fail
    // without mutating anything, purely via the CAS filter's own identity
    // match (no age/timing signal involved at all).
    test('Test D (redesign-mandated): force-takeover with a wrong expected runId fails without mutation', async () => {
      const { forceTakeoverLockMongo, releaseLockMongo } = require('../scripts/tenant-restore');
      const tenantId = 'h-wrong-token';

      await EntityChunk.create({
        tenantId, key: '__restoreLock__',
        data: { runId: 'REAL', pid: 1, acquiredAt: new Date().toISOString() },
      });

      const result = await forceTakeoverLockMongo(tenantId, 'attacker-run', 'WRONG');
      expect(result.acquired).toBe(false);

      const lockDoc = await EntityChunk.findOne({ tenantId, key: '__restoreLock__' }).lean();
      expect(lockDoc.data.runId).toBe('REAL'); // untouched

      await releaseLockMongo(tenantId, 'REAL');
    });

    // Test E (redesign-mandated, = former (c)): release is ownership-
    // protected — a wrong runId can never release another process's lock.
    // Unaffected by the redesign (releaseLockMongo's own signature/logic
    // never changed) — re-verified here against the new acquireLockMongo()
    // 2-arg signature.
    test('Test E (redesign-mandated): release is ownership-protected — a wrong runId can never release another process\'s lock (direct unit call)', async () => {
      const { acquireLockMongo, releaseLockMongo } = require('../scripts/tenant-restore');
      const tenantId = 'h-release-protect';

      const resultA = await acquireLockMongo(tenantId, 'runId-A');
      expect(resultA.acquired).toBe(true);

      // Process B, holding a DIFFERENT (wrong) ownership token, attempts to
      // release — must be a complete no-op against A's real lock.
      await releaseLockMongo(tenantId, 'runId-B-wrong-token');

      const lockDoc = await EntityChunk.findOne({ tenantId, key: '__restoreLock__' }).lean();
      expect(lockDoc).toBeTruthy(); // A's lock survives, untouched
      expect(lockDoc.data.runId).toBe('runId-A');

      await releaseLockMongo(tenantId, 'runId-A'); // correct token — cleans up
      const afterCleanup = await EntityChunk.findOne({ tenantId, key: '__restoreLock__' }).lean();
      expect(afterCleanup).toBeNull();
    });

    test('(f) NEW: a prior fully-completed checkpoint does not block a new restore using a different, later, valid backup', async () => {
      await seedActiveTenant('h-completed-ok');
      await EntityChunk.create({ tenantId: 'h-completed-ok', key: 'vendors', data: [{ id: 'V1' }] });
      const file1 = latestBackupOrCreate('h-completed-ok', mongoEnv);

      const res1 = runRestore(`"${file1}" --tenant=h-completed-ok --target=t1`, mongoEnv);
      expect(res1.status).toBe(0);
      expect(readCheckpoint('h-completed-ok').stage).toBe('completed');

      waitPastSecondBoundary();
      await EntityChunk.updateOne({ tenantId: 'h-completed-ok', key: 'vendors' }, { $set: { data: [{ id: 'V1', v: 2 }] } });
      const file2 = latestBackupOrCreate('h-completed-ok', mongoEnv);
      expect(file2).not.toBe(file1);

      // No --force-unlock needed — the prior run completed cleanly and
      // released its own lock; a completed checkpoint is never compared
      // against Step 1.8's fingerprint check (only a non-completed one is).
      const res2 = runRestore(`"${file2}" --tenant=h-completed-ok --target=t1`, mongoEnv);
      expect(res2.status).toBe(0);
    });
  });

  // ── T066-T068: Phase I — default tenant restore, real production case ──
  describe('Phase I: default tenant restore — real production compatibility (T066)', () => {
    test('a legacy default User/EntityChunk/AppConfig (no tenantId field) is backed up then restored exactly once, normalized forward, no duplicate pair, no other tenant touched', async () => {
      await seedActiveTenant('i066-other-tenant');
      await User.create({ tenantId: 'i066-other-tenant', id: 'i066-other-user', username: 'other', passwordHash: 'x', role: 'admin', active: true });

      // Raw-driver seeded, no tenantId field at all (spec.md FR-027) — never
      // Model.create(), which would silently apply the schema's own
      // default:'default' and defeat the whole point of this fixture. Uses
      // 'bankRecons' (a real, but in this test file otherwise-unused,
      // ENTITY_KEYS member) — plain 'vendors'/'expenses' collide with other
      // tenants' own chunks of the same key elsewhere in this shared Mongo
      // instance, and a bare {key:...} query with no tenantId scoping would
      // match the WRONG tenant's document. AppConfig's own {tenantId,key}
      // unique index means only one 'config' document can ever be
      // tenantId-less at a time — safe without an equivalent key swap.
      await User.collection.insertOne({ id: 'i066-legacy-user', username: 'legacy-user', passwordHash: 'x', role: 'admin', active: true });
      await EntityChunk.collection.insertOne({ key: 'bankRecons', data: [{ id: 'X1' }], updatedAt: new Date() });
      await AppConfig.collection.insertOne({ key: 'config', data: { companyName: 'Legacy Co' }, updatedAt: new Date() });

      const uPre = await User.collection.findOne({ id: 'i066-legacy-user', tenantId: { $exists: false } });
      expect(uPre).toBeTruthy();
      const cPre = await EntityChunk.collection.findOne({ key: 'bankRecons', tenantId: { $exists: false } });
      expect(cPre).toBeTruthy();
      const aPre = await AppConfig.collection.findOne({ key: 'config', tenantId: { $exists: false } });
      expect(aPre).toBeTruthy();

      const file = latestBackupOrCreate('default', mongoEnv);
      const backup = fs.readJsonSync(file);
      expect(backup.collections.users.some(u => u.id === 'i066-legacy-user')).toBe(true);
      expect(backup.collections.entityChunks.some(c => c.key === 'bankRecons')).toBe(true);
      expect(backup.collections.appConfigs.some(c => c.key === 'config')).toBe(true);

      // Simulated disaster — mutate ALL THREE post-backup, so Step 5
      // genuinely re-applies every category (a category whose live content
      // already matches the backup is correctly SKIPPED, per Decision 12 —
      // it would stay in its original, un-normalized shape, which is
      // exactly right for an untouched record but would defeat this test's
      // own "normalized forward" assertion below).
      await User.collection.updateOne({ id: 'i066-legacy-user' }, { $set: { username: 'CORRUPTED' } });
      await EntityChunk.collection.updateOne({ key: 'bankRecons', tenantId: { $exists: false } }, { $set: { data: [{ id: 'X1', corrupted: true }] } });
      await AppConfig.collection.updateOne({ key: 'config', tenantId: { $exists: false } }, { $set: { data: { companyName: 'CORRUPTED' } } });

      const res = runRestore(`"${file}" --tenant=default --target=t1`, mongoEnv);
      expect(res.status).toBe(0);

      const uMatches = await User.find({ id: 'i066-legacy-user' }).lean();
      expect(uMatches).toHaveLength(1); // no duplicate pair
      expect(uMatches[0].tenantId).toBe('default'); // normalized forward
      expect(uMatches[0].username).toBe('legacy-user'); // reverted to the backup's own content

      const cMatches = await EntityChunk.find({ key: 'bankRecons' }).lean();
      expect(cMatches).toHaveLength(1);
      expect(cMatches[0].tenantId).toBe('default');

      const aMatches = await AppConfig.find({ key: 'config' }).lean();
      expect(aMatches).toHaveLength(1);
      expect(aMatches[0].tenantId).toBe('default');

      const otherUser = await User.findOne({ tenantId: 'i066-other-tenant', id: 'i066-other-user' }).lean();
      expect(otherUser.username).toBe('other'); // a genuinely different tenant, completely untouched
    });

    test('the genuine-duplicate-identity case hard-blocks end-to-end on BOTH the backup side (T031) and the restore side (T044) for the same seeded conflict', async () => {
      await User.collection.insertOne({ id: 'i066-dup', username: 'legacy-dup', passwordHash: 'x', role: 'admin', active: true });
      await User.create({ tenantId: 'default', id: 'i066-dup', username: 'explicit-dup', passwordHash: 'x', role: 'admin', active: true });

      // Backup side (T031): its own default-duplicate pre-flight rejects.
      let backupRes;
      try {
        execSync('node scripts/tenant-backup.js --tenant=default', { cwd: ROOT, env: mongoEnv, stdio: 'pipe' });
        backupRes = { status: 0 };
      } catch (e) {
        backupRes = { status: e.status, stderr: e.stderr?.toString() || '' };
      }
      expect(backupRes.status).not.toBe(0);
      expect(backupRes.stderr).toContain('i066-dup');

      // Restore side (T044): a still-valid EARLIER default backup (taken
      // before this duplicate existed) is used — proving it is Step 2's own
      // LIVE-database check, not the backup file's content, that blocks it.
      const priorFile = latestTenantBackupFile('default');
      const restoreRes = runRestore(`"${priorFile}" --tenant=default --target=t1`, mongoEnv);
      expect(restoreRes.status).not.toBe(0);
      expect(restoreRes.stderr).toContain('i066-dup');

      await User.deleteMany({ id: 'i066-dup' });
    });
  });
});
