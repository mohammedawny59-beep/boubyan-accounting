// R3 — Part I: Mongo backup/restore verification against a REAL, isolated,
// disposable mongod (mongodb-memory-server — never a shared/remote/
// production instance; see tests/helpers/mongoTestHarness.js). R1 flagged
// this exact path ("Mongo restore mode has zero tests") as a go-live
// blocker feeding NEW-R1-BACKUP — this closes it.
//
// Full cycle: seed real financial data into isolated Mongo via the actual
// app → scripts/backup.js (spawned as a real child process, same as
// tests/backup-restore.test.js's established pattern) → deliberately wipe
// the journal via the app's own connection (simulated disaster) →
// scripts/restore.js → force a genuine reload (shutdownDB+initDB, not an
// in-memory replay) → the canonical financial state is back.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'r3-mongo-backup-restore-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-r3-mongobak-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
const backupDir = path.join(tmp, 'backups');

const app = require('../server');
const { initDB, shutdownDB, isFileFallbackMode, runAsTenant, loadDB, saveDB } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');
const { startIsolatedMongo } = require('./helpers/mongoTestHarness');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [
      { id: 'usr-admin', username: 'admin', email: 'admin@test.com', passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير', active: true, createdAt: new Date().toISOString(), lastLogin: null },
    ],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], fixedAssets: [], budget: {}, auditLog: [], accruedExpenses: [],
    journalMappings: [], doctorExpenses: [], lockedPeriods: {}, vendorBills: [], accountingSettings: {},
    patients: [], patientReceivables: [],
  };
}

describe('R3 Part I — Mongo backup/restore, proven against a real isolated mongod', () => {
  let mongoInstance;
  let adminToken;

  beforeAll(async () => {
    mongoInstance = await startIsolatedMongo('r3-mongobak');
    process.env.DB_FILE_ONLY = 'false';
    try {
      await initDB({
        mongoUri: mongoInstance.uri,
        dataFile: process.env.DATA_FILE,
        configFile: process.env.CONFIG_FILE,
        defaultConfig: {},
        buildInitialDB,
        migrateDB: () => false,
      });
    } finally {
      process.env.DB_FILE_ONLY = 'true';
    }
    expect(isFileFallbackMode()).toBe(false); // genuinely Mongo-backed

    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
    expect(login.status).toBe(200);
    adminToken = login.body.token;
  }, 120000);

  afterAll(async () => {
    try { await shutdownDB(); } catch {}
    if (mongoInstance) { try { await mongoInstance.stop(); } catch {} }
    try { fs.removeSync(tmp); } catch {}
  });

  test('Mongo Backup/Restore A: a real financial journal entry posted through the app survives backup -> disaster -> restore -> genuine reload', async () => {
    const auth = { Authorization: `Bearer ${adminToken}` };

    // 1) Seed real financial data via the actual app (not a direct DB poke)
    //    — a balanced manual journal entry, the canonical financial primitive.
    const je = await request(app).post('/api/journal').set(auth).send({
      date: '2052-01-10', desc: 'R3 Mongo backup/restore proof entry',
      lines: [
        { accountCode: '1100', debit: 250, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 250 },
      ],
    });
    expect(je.status).toBe(200);
    const jeId = je.body.entry?.id || je.body.id;
    expect(jeId).toBeTruthy();

    let before; await runAsTenant('default', async () => { before = loadDB(); });
    expect(before.journalEntries.some(j => j.id === jeId)).toBe(true);

    // 2) Real backup — spawned as an actual child process against the SAME
    //    isolated Mongo URI, exactly as scripts/backup-scheduled-example.sh
    //    and the new in-process scheduler both invoke it.
    const env = { ...process.env, MONGO_URI: mongoInstance.uri, BACKUP_DIR: backupDir, BACKUP_KEEP: '5' };
    execSync('node scripts/backup.js', { cwd: ROOT, env, stdio: 'pipe' });

    const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('backup-') && f.endsWith('.json'));
    expect(backups.length).toBe(1);
    const backupFile = path.join(backupDir, backups[0]);
    const payload = fs.readJsonSync(backupFile);
    expect(payload.source).toBe('mongodb');
    expect(Array.isArray(payload.collections.entityChunks)).toBe(true);
    expect(payload.collections.entityChunks.length).toBeGreaterThan(0); // journal/COA/etc. mirror is not empty

    // 2b) Integrity verification after creation (R3's own requirement) —
    //     the checksum sidecar must independently validate, not just exist.
    expect(() => execSync(`node scripts/verify-backup.js "${backupFile}"`, { cwd: ROOT, env, stdio: 'pipe' })).not.toThrow();

    // 3) Simulated disaster — wipe the journal via the app's OWN live
    //    connection to the SAME isolated Mongo (not a separate process).
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.journalEntries = [];
      await saveDB(db, { durable: true });
    });
    let wiped; await runAsTenant('default', async () => { wiped = loadDB(); });
    expect(wiped.journalEntries.length).toBe(0);

    // 4) Restore — a separate child process, same MONGO_URI, non-interactive
    //    (RESTORE_YES=1, matching the established backup-restore.test.js
    //    convention for isolated/automated restores).
    const restoreEnv = { ...env, RESTORE_YES: '1' };
    execSync(`node scripts/restore.js "${backupFile}" --target=r3-mongo-isolated-test`, { cwd: ROOT, env: restoreEnv, stdio: 'pipe' });

    // 5) Force a GENUINE reload — close and reopen the connection, exactly
    //    like the P0.11 restart() pattern — proving the restore actually
    //    persisted to Mongo, not that an in-memory cache happened to survive.
    await shutdownDB();
    process.env.DB_FILE_ONLY = 'false';
    try {
      await initDB({
        mongoUri: mongoInstance.uri,
        dataFile: process.env.DATA_FILE,
        configFile: process.env.CONFIG_FILE,
        defaultConfig: {},
        buildInitialDB,
        migrateDB: () => false,
      });
    } finally {
      process.env.DB_FILE_ONLY = 'true';
    }
    let restored; await runAsTenant('default', async () => { restored = loadDB(); });
    expect(restored).not.toBe(wiped); // genuinely a fresh object, not a stale reference
    const restoredJe = restored.journalEntries.find(j => j.id === jeId);
    expect(restoredJe).toBeTruthy();
    expect(restoredJe.desc).toBe('R3 Mongo backup/restore proof entry');
    expect(restoredJe.lines.find(l => l.accountCode === '1100').debit).toBe(250);
    expect(restoredJe.lines.find(l => l.accountCode === '4100').credit).toBe(250);

    // Chart of accounts (a different ENTITY_KEYS root) also survived intact.
    expect(restored.chartOfAccounts.some(a => a.code === '1100')).toBe(true);

    // Re-authenticate to confirm the users collection round-tripped too —
    // a restore that loses the admin account would be its own disaster.
    const reLogin = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
    expect(reLogin.status).toBe(200);
  }, 120000);
});

// ═══════════════════════════════════════════════════════════════════════
// R3 Part J — P6-037: self-service tenant registration must actually be
// reachable without auth (public/landing.html already ships a signup form
// wired to this exact endpoint — this is real, currently-shipped scope).
// Own fully isolated mongod (Tenant/Subscription are real Mongoose models —
// this route is meaningless in file-fallback mode), deliberately NOT
// sharing the first describe block's connection lifecycle/state.
// ═══════════════════════════════════════════════════════════════════════
describe('R3 Part J — P6-037: POST /api/tenants/register is genuinely public and provisions a full tenant', () => {
  let mongoInstance2;
  let registeredTenantId;

  beforeAll(async () => {
    await shutdownDB().catch(() => {});
    mongoInstance2 = await startIsolatedMongo('r3-p6037');
    process.env.DB_FILE_ONLY = 'false';
    try {
      await initDB({
        mongoUri: mongoInstance2.uri,
        dataFile: process.env.DATA_FILE,
        configFile: process.env.CONFIG_FILE,
        defaultConfig: {},
        buildInitialDB,
        migrateDB: () => false,
      });
    } finally {
      process.env.DB_FILE_ONLY = 'true';
    }
    expect(isFileFallbackMode()).toBe(false);
  }, 120000);

  afterAll(async () => {
    try { await shutdownDB(); } catch {}
    if (mongoInstance2) { try { await mongoInstance2.stop(); } catch {} }
  });

  test('P6037 A: an anonymous request (no Authorization header) succeeds — was previously blocked by the global auth gate', async () => {
    const res = await request(app).post('/api/tenants/register').send({
      name: 'Test Clinic R3', email: 'owner-r3@example.com', password: 'OwnerPass1!', slug: 'test-clinic-r3',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.tenantId).toContain('test-clinic-r3');
    registeredTenantId = res.body.tenantId;
  });

  test('P6037 B: the new tenant is auto-provisioned with a full COA + roles + a working admin login (onboarding, not an empty shell)', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'owner-r3@example.com', password: 'OwnerPass1!', tenantId: registeredTenantId });
    expect(login.status).toBe(200);
    const token = login.body.token;
    const coa = await request(app).get('/api/coa').set({ Authorization: `Bearer ${token}` });
    expect(coa.status).toBe(200);
    expect(coa.body.length).toBeGreaterThan(10); // real seeded chart of accounts, not empty
  });

  test('P6037 C: a duplicate slug is rejected (409), not silently overwritten', async () => {
    const res = await request(app).post('/api/tenants/register').send({
      name: 'Duplicate Clinic', email: 'dup@example.com', password: 'DupPass1!', slug: 'test-clinic-r3',
    });
    expect(res.status).toBe(409);
  });

  test('P6037 D: a weak (<8 char) password is rejected before any tenant/user is created', async () => {
    const res = await request(app).post('/api/tenants/register').send({
      name: 'Weak Pw Clinic', email: 'weak@example.com', password: 'short', slug: 'weak-pw-clinic',
    });
    expect(res.status).toBe(400);
  });
});
