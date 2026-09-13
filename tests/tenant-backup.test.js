// P4 — Phase D: Tenant-Scoped Backup (T026)
// specs/002-tenant-isolation-backup-hardening/contracts/tenant-backup-contract.md's
// own canonical Test contract, cases 1-12 plus 8a/12a (14 total).
//
// scripts/tenant-backup.js is exercised the SAME way the codebase's own
// established precedent already does for scripts/backup.js/restore.js
// (tests/r3-mongo-backup-restore.test.js, tests/backup-restore.test.js):
// spawned as a real child process via execSync, against a real, isolated,
// disposable mongod for every Mongo-mode case. The test process itself
// connects mongoose directly (bypassing initDB()'s heavy bootstrap/admin
// creation) so fixture record counts stay exact and predictable.

process.env.JWT_SECRET = 'p4-tenant-backup-secret';
process.env.NODE_ENV   = 'test';

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const mongoose = require('mongoose');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p4-tenant-backup-'));
const DATA_FILE = path.join(tmp, 'database.json');
const CONFIG_FILE = path.join(tmp, 'config.json');
const backupDirMongo     = path.join(tmp, 'backups-mongo');
const backupDirFile      = path.join(tmp, 'backups-file');
const backupDirRetention = path.join(tmp, 'backups-retention');

const { TENANT_BACKUP_ENTITY_KEYS, _tenantFilePath, _tenantConfigFilePath, _setDataFileForTooling } = require('../lib/database');
const User = require('../models/User');
const EntityChunk = require('../models/EntityChunk');
const AppConfig = require('../models/AppConfig');
const Tenant = require('../models/Tenant');
const Subscription = require('../models/Subscription');
const IdempotencyRecord = require('../models/IdempotencyRecord');
const { startIsolatedMongo, withRetryOnTransientMongoError } = require('./helpers/mongoTestHarness');

_setDataFileForTooling(DATA_FILE); // lets this process's own _tenantFilePath() calls resolve, for file-mode fixture seeding

function tenantFilePath(tid) { return _tenantFilePath(tid); }
function tenantConfigFilePath(tid) { return _tenantConfigFilePath(tid); }

// CI stability pass: every spawned CLI child gets a hard wall-clock bound.
// execSync's own `timeout` option (unlike a Jest per-test timeout, which
// cannot interrupt a synchronous, event-loop-blocking call) actually sends
// SIGTERM once exceeded — this is what prevents a genuinely stuck child
// from blocking the whole Jest worker (and by extension the CI job)
// indefinitely. 30s is comfortably above the 20s Mongo connect timeout
// (scripts/tenant-backup.js) plus normal operation time.
const EXEC_TIMEOUT_MS = 30000;

async function seedActiveTenant(tenantId) {
  await Tenant.create({ tenantId, name: tenantId, slug: tenantId, email: `${tenantId}@example.com`, status: 'active' });
}

function runBackupOnce(tenantId, envOverrides) {
  try {
    const out = execSync(`node scripts/tenant-backup.js --tenant=${tenantId}`, {
      cwd: ROOT, env: { ...process.env, ...envOverrides }, stdio: 'pipe', timeout: EXEC_TIMEOUT_MS,
    });
    return { status: 0, stdout: out.toString() };
  } catch (e) {
    return { status: e.status, stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '' };
  }
}

// CI reliability pass: retries ONLY the diagnosed transient-infrastructure
// signature (a real "Server selection timed out" under CI host contention,
// confirmed from an actual CI failure log) — every call site is unaffected,
// no test needed to change. A genuine application-level failure still
// returns on the very first attempt, unmasked.
function runBackup(tenantId, envOverrides) {
  return withRetryOnTransientMongoError(() => runBackupOnce(tenantId, envOverrides));
}

function runBackupRawOnce(argsString, envOverrides) {
  try {
    const out = execSync(`node scripts/tenant-backup.js ${argsString}`, {
      cwd: ROOT, env: { ...process.env, ...envOverrides }, stdio: 'pipe', timeout: EXEC_TIMEOUT_MS,
    });
    return { status: 0, stdout: out.toString() };
  } catch (e) {
    return { status: e.status, stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '' };
  }
}

function runBackupRaw(argsString, envOverrides) {
  return withRetryOnTransientMongoError(() => runBackupRawOnce(argsString, envOverrides));
}

function latestTenantBackupFile(dir, tenantId) {
  const files = fs.readdirSync(dir).filter(f => f.startsWith(`tenant-${tenantId}-`) && f.endsWith('.json')).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

function waitPastSecondBoundary() {
  const now = Date.now();
  while (Date.now() - now < 1100) { /* busy-wait, mirrors tests/backup-restore.test.js's own precedent */ }
}

describe('P4 Phase D — tenant-backup.js (T026, contract cases 1-12 + 8a/12a)', () => {
  let mongoInstance;
  let mongoEnv;

  beforeAll(async () => {
    mongoInstance = await startIsolatedMongo('p4-tenant-backup');
    await mongoose.connect(mongoInstance.uri);
    await IdempotencyRecord.init();
    mongoEnv = { ...process.env, MONGO_URI: mongoInstance.uri, BACKUP_DIR: backupDirMongo };
  }, 120000);

  afterAll(async () => {
    try { await mongoose.connection.close(); } catch {}
    if (mongoInstance) { try { await mongoInstance.stop(); } catch {} }
    try { fs.removeSync(tmp); } catch {}
  });

  test('case 3: missing --tenant= exits non-zero, writes nothing', () => {
    fs.ensureDirSync(backupDirMongo);
    const before = fs.readdirSync(backupDirMongo).length;
    const res = runBackupRaw('', mongoEnv);
    expect(res.status).not.toBe(0);
    const after = fs.readdirSync(backupDirMongo).length;
    expect(after).toBe(before);
  });

  test('case 1: cross-tenant leakage — backing up A never includes B\'s colliding id/key', async () => {
    await seedActiveTenant('c1-tenant-a');
    await User.create({ tenantId: 'c1-tenant-a', id: 'shared-id', username: 'a-user', passwordHash: 'x', role: 'admin', active: true });
    await User.create({ tenantId: 'c1-tenant-b', id: 'shared-id', username: 'b-user', passwordHash: 'x', role: 'admin', active: true });
    await EntityChunk.create({ tenantId: 'c1-tenant-a', key: 'vendors', data: [{ id: 'V-A' }] });
    await EntityChunk.create({ tenantId: 'c1-tenant-b', key: 'vendors', data: [{ id: 'V-B' }] });

    const res = runBackup('c1-tenant-a', mongoEnv);
    expect(res.status).toBe(0);
    const file = latestTenantBackupFile(backupDirMongo, 'c1-tenant-a');
    const payload = fs.readJsonSync(file);
    expect(payload.collections.users.every(u => u.username !== 'b-user')).toBe(true);
    const vendorsChunk = payload.collections.entityChunks.find(c => c.key === 'vendors');
    expect(vendorsChunk.data).toEqual([{ id: 'V-A' }]);
  });

  test('case 2: legacy no-tenantId default user is included in a default backup', async () => {
    await User.collection.insertOne({ id: 'legacy-default-1', username: 'legacy-default-user', passwordHash: 'x', role: 'admin', active: true });
    const preCheck = await User.collection.findOne({ id: 'legacy-default-1' });
    expect('tenantId' in preCheck).toBe(false); // fixture validity (research.md Decision 17)

    const res = runBackup('default', mongoEnv);
    expect(res.status).toBe(0);
    const file = latestTenantBackupFile(backupDirMongo, 'default');
    const payload = fs.readJsonSync(file);
    expect(payload.collections.users.some(u => u.id === 'legacy-default-1')).toBe(true);
  });

  test('case 5: default-duplicate pre-flight hard-fails, names the identity, writes no file', async () => {
    await User.collection.insertOne({ id: 'dup-identity-1', username: 'dup-legacy', passwordHash: 'x', role: 'admin', active: true });
    await User.create({ tenantId: 'default', id: 'dup-identity-1', username: 'dup-explicit', passwordHash: 'x', role: 'admin', active: true });

    const before = new Set(fs.readdirSync(backupDirMongo));
    const res = runBackup('default', mongoEnv);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('dup-identity-1');
    const after = new Set(fs.readdirSync(backupDirMongo));
    expect(after).toEqual(before); // zero new files written

    await User.deleteMany({ id: 'dup-identity-1' }); // clean up so later default-tenant cases in this file are unaffected
  });

  test('case 6: no tenants/subscriptions key at all, for default or a real tenant that has both rows', async () => {
    await seedActiveTenant('c6-tenant');
    await Subscription.create({ tenantId: 'c6-tenant', plan: 'starter', status: 'active' });
    await EntityChunk.create({ tenantId: 'c6-tenant', key: 'vendors', data: [] });

    const resDefault = runBackup('default', mongoEnv);
    expect(resDefault.status).toBe(0);
    const defaultPayload = fs.readJsonSync(latestTenantBackupFile(backupDirMongo, 'default'));
    expect('tenants' in defaultPayload).toBe(false);
    expect('subscriptions' in defaultPayload).toBe(false);
    expect('tenants' in defaultPayload.collections).toBe(false);
    expect('subscriptions' in defaultPayload.collections).toBe(false);

    const resTenant = runBackup('c6-tenant', mongoEnv);
    expect(resTenant.status).toBe(0);
    const tenantPayload = fs.readJsonSync(latestTenantBackupFile(backupDirMongo, 'c6-tenant'));
    expect('tenants' in tenantPayload).toBe(false);
    expect('subscriptions' in tenantPayload).toBe(false);
    expect('tenants' in tenantPayload.collections).toBe(false);
    expect('subscriptions' in tenantPayload.collections).toBe(false);
  });

  test('case 4: idempotency exclusion — neither an IdempotencyRecord doc nor an entityChunks "idempotencyRecords" key appear', async () => {
    expect(TENANT_BACKUP_ENTITY_KEYS.includes('idempotencyRecords')).toBe(false); // confirm the real, imported constant, not a re-implementation

    await seedActiveTenant('c4-tenant');
    await IdempotencyRecord.create({ tenantId: 'c4-tenant', operationScope: 'vendor:create', key: 'k1', fingerprint: 'f1', status: 'COMPLETED' });
    await EntityChunk.create({ tenantId: 'c4-tenant', key: 'idempotencyRecords', data: [{ foo: 'bar' }] });
    await EntityChunk.create({ tenantId: 'c4-tenant', key: 'vendors', data: [] });

    const res = runBackup('c4-tenant', mongoEnv);
    expect(res.status).toBe(0);
    const payload = fs.readJsonSync(latestTenantBackupFile(backupDirMongo, 'c4-tenant'));
    expect(payload.collections.entityChunks.some(c => c.key === 'idempotencyRecords')).toBe(false);
    expect(JSON.stringify(payload).includes('operationScope')).toBe(false);
  });

  test('case 8: a stray __restoreLock__ EntityChunk is never included', async () => {
    await seedActiveTenant('c8-tenant');
    await EntityChunk.create({ tenantId: 'c8-tenant', key: '__restoreLock__', data: { runId: 'stale-run', pid: 1, acquiredAt: new Date().toISOString() } });
    await EntityChunk.create({ tenantId: 'c8-tenant', key: 'vendors', data: [] });

    const res = runBackup('c8-tenant', mongoEnv);
    expect(res.status).toBe(0);
    const payload = fs.readJsonSync(latestTenantBackupFile(backupDirMongo, 'c8-tenant'));
    expect(payload.collections.entityChunks.some(c => c.key === '__restoreLock__')).toBe(false);
  });

  test('case 8a: a real auditLog EntityChunk is never included', async () => {
    await seedActiveTenant('c8a-tenant');
    await EntityChunk.create({ tenantId: 'c8a-tenant', key: 'auditLog', data: [{ id: 'AUD-1', action: 'journal.create' }] });
    await EntityChunk.create({ tenantId: 'c8a-tenant', key: 'vendors', data: [] });

    const res = runBackup('c8a-tenant', mongoEnv);
    expect(res.status).toBe(0);
    const payload = fs.readJsonSync(latestTenantBackupFile(backupDirMongo, 'c8a-tenant'));
    expect(payload.collections.entityChunks.some(c => c.key === 'auditLog')).toBe(false);
  });

  test('case 9: non-default existence/active-status pre-check, Mongo mode', async () => {
    const nonExistent = runBackup('c9-nonexistent', mongoEnv);
    expect(nonExistent.status).not.toBe(0);
    expect(nonExistent.stderr).toContain('c9-nonexistent');

    await Tenant.create({ tenantId: 'c9-suspended', name: 'x', slug: 'c9-suspended', email: 'x@example.com', status: 'suspended' });
    const suspended = runBackup('c9-suspended', mongoEnv);
    expect(suspended.status).not.toBe(0);

    await Tenant.create({ tenantId: 'c9-cancelled', name: 'x', slug: 'c9-cancelled', email: 'x@example.com', status: 'cancelled' });
    const cancelled = runBackup('c9-cancelled', mongoEnv);
    expect(cancelled.status).not.toBe(0);

    const defaultTenantRow = await Tenant.findOne({ tenantId: 'default' }).lean();
    expect(defaultTenantRow).toBeNull(); // default has no registry row at all (research.md Decision 5)
    const defaultRes = runBackup('default', mongoEnv);
    expect(defaultRes.status).toBe(0); // succeeds regardless
  });

  test('case 11: audit event — success writes one event with the target\'s own tenantId, absent from the target\'s own log; a hard-fail writes outcome:failure', async () => {
    await seedActiveTenant('c11-tenant');
    await EntityChunk.create({ tenantId: 'c11-tenant', key: 'vendors', data: [] });

    const res = runBackup('c11-tenant', mongoEnv);
    expect(res.status).toBe(0);

    const defaultAuditDoc = await EntityChunk.findOne({ tenantId: 'default', key: 'auditLog' }).lean();
    const events = defaultAuditDoc?.data || [];
    const successEvent = events.find(e => e.action === 'tenant.backup' && e.resourceId === 'c11-tenant' && e.outcome === 'success');
    expect(successEvent).toBeTruthy();
    expect(successEvent.tenantId).toBe('c11-tenant'); // synthetic req:{tenantId} actually wired in, not silently 'default'
    expect(successEvent.metadata?.backupFingerprint).toBeTruthy();
    expect(successEvent.metadata?.recordCounts).toBeTruthy();
    expect(successEvent.metadata?.categoryDigests).toBeTruthy();

    const targetOwnAuditDoc = await EntityChunk.findOne({ tenantId: 'c11-tenant', key: 'auditLog' }).lean();
    expect(targetOwnAuditDoc).toBeNull(); // never written to the target's own log

    const failRes = runBackup('c11-nonexistent-for-audit', mongoEnv);
    expect(failRes.status).not.toBe(0);
    const defaultAuditDoc2 = await EntityChunk.findOne({ tenantId: 'default', key: 'auditLog' }).lean();
    const failEvent = (defaultAuditDoc2?.data || []).find(e => e.action === 'tenant.backup' && e.resourceId === 'c11-nonexistent-for-audit');
    expect(failEvent?.outcome).toBe('failure');

    // NOTE: the contract's own ninth-pass addendum to this case asks for a
    // default-target backup-then-restore cycle to prove auditLog survives a
    // restore byte-for-byte. scripts/tenant-restore.js does not exist yet —
    // tasks.md's own Phase D checkpoint (T036) requires backup to be
    // "complete and independently testable before restore work begins," so
    // that half is deliberately deferred to Phase E's own restore test
    // suite, which re-verifies this exact TENANT_BACKUP_ENTITY_KEYS
    // exclusion from the restore side once restore exists.
  });

  test('case 12: backup-file retention — TENANT_BACKUP_KEEP bounds one tenant\'s own files, others unaffected', async () => {
    fs.ensureDirSync(backupDirRetention);
    await seedActiveTenant('c12-tenant');
    await seedActiveTenant('c12-other-tenant');
    await EntityChunk.create({ tenantId: 'c12-tenant', key: 'vendors', data: [] });
    await EntityChunk.create({ tenantId: 'c12-other-tenant', key: 'vendors', data: [] });

    const retentionEnv = { ...mongoEnv, BACKUP_DIR: backupDirRetention, TENANT_BACKUP_KEEP: '3' };
    const otherRes = runBackup('c12-other-tenant', retentionEnv);
    if (otherRes.status !== 0) console.error('case 12 setup backup failed:', otherRes.stderr);
    expect(otherRes.status).toBe(0);

    for (let i = 0; i < 5; i++) {
      const r = runBackup('c12-tenant', retentionEnv);
      // CI reliability pass: surface the child process's own stderr on an
      // unexpected failure — this assertion previously gave no visibility
      // into WHY the spawned tenant-backup.js exited non-zero, making a
      // CI-only failure impossible to root-cause from the Jest output alone.
      if (r.status !== 0) console.error(`case 12 iteration ${i} backup failed:`, r.stderr);
      expect(r.status).toBe(0);
      waitPastSecondBoundary();
    }

    const c12Files = fs.readdirSync(backupDirRetention).filter(f => f.startsWith('tenant-c12-tenant-') && f.endsWith('.json'));
    expect(c12Files.length).toBe(3);
    const otherFiles = fs.readdirSync(backupDirRetention).filter(f => f.startsWith('tenant-c12-other-tenant-') && f.endsWith('.json'));
    expect(otherFiles.length).toBe(1); // a different tenant's own backup is completely unaffected
  });

  test('case 12a: retention matching is exact-equality, immune to a hyphen-prefix collision (acme vs acme-corp)', async () => {
    const dir = path.join(tmp, 'backups-retention-collision');
    fs.ensureDirSync(dir);
    await seedActiveTenant('c12a-acme');
    await seedActiveTenant('c12a-acme-corp');
    await EntityChunk.create({ tenantId: 'c12a-acme', key: 'vendors', data: [] });
    await EntityChunk.create({ tenantId: 'c12a-acme-corp', key: 'vendors', data: [] });

    const env = { ...mongoEnv, BACKUP_DIR: dir, TENANT_BACKUP_KEEP: '3' };

    for (let i = 0; i < 5; i++) {
      const r = runBackup('c12a-acme-corp', env);
      if (r.status !== 0) console.error(`case 12a iteration ${i} backup failed:`, r.stderr);
      expect(r.status).toBe(0);
      waitPastSecondBoundary();
    }
    const acmeRes = runBackup('c12a-acme', env);
    if (acmeRes.status !== 0) console.error('case 12a final backup failed:', acmeRes.stderr);
    expect(acmeRes.status).toBe(0);

    const acmeCorpFiles = fs.readdirSync(dir).filter(f => f.startsWith('tenant-c12a-acme-corp-') && f.endsWith('.json'));
    expect(acmeCorpFiles.length).toBe(3); // its own rotation, unaffected by acme's single backup
    const acmeFiles = fs.readdirSync(dir).filter(f => f.startsWith('tenant-c12a-acme-') && f.endsWith('.json') && !f.startsWith('tenant-c12a-acme-corp-'));
    expect(acmeFiles.length).toBe(1); // acme's own single backup, untouched by acme-corp's rotation
  });

  // ── File-mode cases (no MONGO_URI) ─────────────────────────────────────
  describe('file mode', () => {
    let fileEnv;
    beforeAll(() => {
      fs.ensureDirSync(backupDirFile);
      fileEnv = { ...process.env, MONGO_URI: '', DATA_FILE, CONFIG_FILE, BACKUP_DIR: backupDirFile };
      delete fileEnv.MONGO_URI;
    });

    test('case 7: file-mode undefined-key handling — no passwordResets/errorLog entry, ever (not a data:undefined one)', () => {
      const tid = 'c7-file-tenant';
      const fp = tenantFilePath(tid);
      fs.ensureDirSync(path.dirname(fp));
      fs.writeJsonSync(fp, { users: [{ id: 'u1', username: 'file-user' }], vendors: [{ id: 'V1' }] });

      const res = runBackup(tid, fileEnv);
      expect(res.status).toBe(0);
      const payload = fs.readJsonSync(latestTenantBackupFile(backupDirFile, tid));
      expect(payload.collections.entityChunks.some(c => c.key === 'passwordResets')).toBe(false);
      expect(payload.collections.entityChunks.some(c => c.key === 'errorLog')).toBe(false);
      expect(payload.recordCounts.entityChunks).toBe(payload.collections.entityChunks.length);
      expect(payload.collections.entityChunks.some(c => c.key === 'vendors')).toBe(true);
    });

    test('case 10: file-mode existence check is not enforced — a tenant that never persisted anything backs up with zero records', () => {
      const tid = 'c10-never-persisted';
      const fp = tenantFilePath(tid);
      expect(fs.existsSync(fp)).toBe(false); // genuinely no file on disk

      const res = runBackup(tid, fileEnv);
      expect(res.status).toBe(0); // succeeds — not a hard failure
      const payload = fs.readJsonSync(latestTenantBackupFile(backupDirFile, tid));
      expect(payload.recordCounts.users).toBe(0);
      expect(payload.recordCounts.entityChunks).toBe(0);
      expect(payload.recordCounts.appConfigs).toBe(0);
    });
  });
});
