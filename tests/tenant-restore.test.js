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
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p4-tenant-restore-'));
const DATA_FILE = path.join(tmp, 'database.json');
const CONFIG_FILE = path.join(tmp, 'config.json');
const backupDir = path.join(tmp, 'backups');

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

const QUIESCE_SUBSTRING = 'تحذير قبل البدء: أوقف حركة الطلبات الحية';

describe('P4 Phase E — tenant-restore.js Steps -1/0/1/2 (T037-T045)', () => {
  let mongoInstance;
  let mongoEnv;

  beforeAll(async () => {
    mongoInstance = await startIsolatedMongo('p4-tenant-restore');
    await mongoose.connect(mongoInstance.uri);
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

    test('--force-unlock recovers a stale lock via compare-and-delete, then proceeds', async () => {
      await seedActiveTenant('e-lock-force');
      const file = latestBackupOrCreate('e-lock-force', mongoEnv);
      await EntityChunk.create({ tenantId: 'e-lock-force', key: '__restoreLock__', data: { runId: 'stale-crashed-run', pid: 1, acquiredAt: new Date().toISOString() } });

      const withoutForce = runRestore(`"${file}" --tenant=e-lock-force --target=t1`, mongoEnv);
      expect(withoutForce.status).not.toBe(0); // plain re-run still rejected — no silent auto-recovery

      const withForce = runRestore(`"${file}" --tenant=e-lock-force --target=t1 --force-unlock`, mongoEnv);
      expect(withForce.status).toBe(0);
      const lockDoc = await EntityChunk.findOne({ tenantId: 'e-lock-force', key: '__restoreLock__' }).lean();
      expect(lockDoc).toBeNull(); // released again after the forced run completed cleanly
    });
  });

  // ── T038/T042: Step 1 validation gate ──────────────────────────────────
  describe('Step 1: validation gate', () => {
    test('a genuinely valid tenant backup passes Step 1 and reaches the "not yet applied" message', async () => {
      await seedActiveTenant('e-valid');
      const file = latestBackupOrCreate('e-valid', mongoEnv);
      const res = runRestore(`"${file}" --tenant=e-valid --target=t1`, mongoEnv);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('اكتمل التجهيز');
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
    test('sanitization strips _id/__v from every staged record, and the staging file is written at the tenant-keyed path', async () => {
      await seedActiveTenant('f-stage-basic');
      await EntityChunk.create({ tenantId: 'f-stage-basic', key: 'vendors', data: [{ id: 'V1' }] });
      const file = latestBackupOrCreate('f-stage-basic', mongoEnv);

      const res = runRestore(`"${file}" --tenant=f-stage-basic --target=t1`, mongoEnv);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('اكتمل التجهيز');

      const stagingFile = path.join(backupDir, '.restore-staging', 'f-stage-basic.json');
      expect(fs.existsSync(stagingFile)).toBe(true);
      const staged = fs.readJsonSync(stagingFile);
      const allRecords = [...staged.users, ...staged.entityChunks, ...staged.appConfigs];
      expect(allRecords.length).toBeGreaterThan(0);
      for (const r of allRecords) {
        expect('_id' in r).toBe(false);
        expect('__v' in r).toBe(false);
      }
    });

    test('no live document under any identity is created, modified, or left behind during staging', async () => {
      await seedActiveTenant('f-stage-noop');
      await EntityChunk.create({ tenantId: 'f-stage-noop', key: 'vendors', data: [{ id: 'V1' }] });
      const file = latestBackupOrCreate('f-stage-noop', mongoEnv);

      const usersBefore = await User.find({}).lean();
      const chunksBefore = await EntityChunk.find({}).lean();
      const configsBefore = await AppConfig.find({}).lean();

      const res = runRestore(`"${file}" --tenant=f-stage-noop --target=t1`, mongoEnv);
      expect(res.status).toBe(0);

      const usersAfter = await User.find({}).lean();
      const chunksAfter = await EntityChunk.find({}).lean();
      const configsAfter = await AppConfig.find({}).lean();

      const sortById = arr => [...arr].map(d => JSON.stringify(d)).sort();
      expect(sortById(usersAfter)).toEqual(sortById(usersBefore));
      expect(sortById(configsAfter)).toEqual(sortById(configsBefore));
      // entityChunks: the restore lock is created AND released within this
      // same run (acquire -> stage -> release) — the live document SET must
      // be byte-identical to before, proving nothing else was touched and
      // the transient lock left no residue.
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
});
