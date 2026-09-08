// P4 — Phase A: Tenant Write Isolation (research.md Decision 1, CLAUDE.md بند 2)
//
// persistUsers()/persistEntityKey() are the ONLY functions default's own
// save cycle (flushToMongo()) calls to persist User/EntityChunk documents to
// MongoDB — before this milestone, NEITHER had any tenant scoping at all, so
// an ordinary default-tenant save could silently delete or overwrite a
// DIFFERENT real SaaS tenant's own document sharing the same `id`/`key`.
// This is a real, isolated MongoDB instance (mongodb-memory-server via
// tests/helpers/mongoTestHarness.js) — not a mock — because the bug this
// suite exists to catch is about the ACTUAL Mongo query MongoDB itself
// executes, which a mocked model can't meaningfully reproduce.

process.env.DB_FILE_ONLY = 'true'; // flipped to false only inside initDB() below, same pattern as P0.11/P0.12
process.env.JWT_SECRET   = 'p4-tenant-write-isolation-secret';
process.env.NODE_ENV     = 'test';

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p4-write-iso-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const {
  initDB, shutdownDB, isFileFallbackMode, loadDB, saveDB, runAsTenant,
} = require('../lib/database');
const { startIsolatedMongo } = require('./helpers/mongoTestHarness');
const User        = require('../models/User');
const EntityChunk = require('../models/EntityChunk');

function buildInitialDB() {
  return {
    users: [], roles: { admin: { tabs: [], actions: {} } }, doctors: [], dailyData: [],
    paymentsData: [], commissionHistory: [], uploadedFiles: [], expenses: [], journalEntries: [],
    chartOfAccounts: [], vendors: [], invItems: [], invCategories: [], invMovements: [],
    recurringExpenses: [], companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [],
    insuranceClaims: [], payroll: [], employees: [], assets: [], budget: {}, auditLog: [],
    accruedExpenses: [], journalMappings: [], doctorExpenses: [],
  };
}

describe('P4 Phase A — persistUsers()/persistEntityKey() tenant scoping (Critical, real Mongo)', () => {
  let mongoInstance;

  beforeAll(async () => {
    mongoInstance = await startIsolatedMongo('p4-write-iso');
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
    expect(isFileFallbackMode()).toBe(false); // genuinely Mongo-backed, not a silent fallback
  }, 120000);

  afterAll(async () => {
    try { await shutdownDB(); } catch {}
    if (mongoInstance) { try { await mongoInstance.stop(); } catch {} }
    try { fs.removeSync(tmp); } catch {}
  });

  test('default save does not delete a Tenant B user sharing the same id', async () => {
    await User.create({ tenantId: 'tenant-b', id: 'usr-shared-1', username: 'b-user-1', passwordHash: 'x', role: 'admin', active: true });

    await runAsTenant('default', async () => {
      const db = loadDB();
      db.users = [{ id: 'usr-default-1', username: 'default-user', role: 'admin', active: true }];
      await saveDB(db, { durable: true });
    });

    const stillThere = await User.findOne({ tenantId: 'tenant-b', id: 'usr-shared-1' }).lean();
    expect(stillThere).toBeTruthy();
    expect(stillThere.username).toBe('b-user-1');
  });

  test('default upsert does not overwrite a Tenant B user sharing the same id', async () => {
    await User.create({ tenantId: 'tenant-b', id: 'usr-shared-2', username: 'b-user-2-original', passwordHash: 'x', role: 'accountant', active: true });

    await runAsTenant('default', async () => {
      const db = loadDB();
      db.users = [
        ...db.users,
        { id: 'usr-shared-2', username: 'default-impersonator', role: 'admin', active: true },
      ];
      await saveDB(db, { durable: true });
    });

    // Tenant B's own document, sharing the same `id`, must be completely unaffected.
    const bDoc = await User.findOne({ tenantId: 'tenant-b', id: 'usr-shared-2' }).lean();
    expect(bDoc.username).toBe('b-user-2-original');
    expect(bDoc.role).toBe('accountant');

    // A SEPARATE default-tenant document for the same `id` must have been created/updated instead.
    const defaultDoc = await User.findOne({ tenantId: 'default', id: 'usr-shared-2' }).lean();
    expect(defaultDoc).toBeTruthy();
    expect(defaultDoc.username).toBe('default-impersonator');
  });

  test('default entity save does not overwrite a Tenant B EntityChunk sharing the same key', async () => {
    await EntityChunk.create({ tenantId: 'tenant-b', key: 'chartOfAccounts', data: [{ code: '9999', name: 'B-secret-account' }] });

    await runAsTenant('default', async () => {
      const db = loadDB();
      db.chartOfAccounts = [{ code: '1100', name: 'Default-account' }];
      await saveDB(db, { durable: true });
    });

    const bChunk = await EntityChunk.findOne({ tenantId: 'tenant-b', key: 'chartOfAccounts' }).lean();
    expect(bChunk.data).toEqual([{ code: '9999', name: 'B-secret-account' }]);

    const defaultChunk = await EntityChunk.findOne({ tenantId: 'default', key: 'chartOfAccounts' }).lean();
    expect(defaultChunk.data).toEqual([{ code: '1100', name: 'Default-account' }]);
  });

  test('a legacy default User with no tenantId field is updated in place, not duplicated', async () => {
    // Raw-driver seed — no tenantId field at all (spec.md FR-027 — never Model.create(), which would apply the schema's own default:'default').
    await User.collection.insertOne({ id: 'usr-legacy-1', username: 'legacy-user', role: 'admin', active: true });

    const preCheck = await User.collection.findOne({ id: 'usr-legacy-1' });
    expect('tenantId' in preCheck).toBe(false); // explicit absence assertion before exercising the behavior under test

    await runAsTenant('default', async () => {
      const db = loadDB();
      db.users = [
        ...db.users.filter(u => u.id !== 'usr-legacy-1'),
        { id: 'usr-legacy-1', username: 'legacy-user-renamed', role: 'admin', active: true },
      ];
      await saveDB(db, { durable: true });
    });

    const matches = await User.find({ id: 'usr-legacy-1' }).lean();
    expect(matches).toHaveLength(1); // updated in place, never duplicated
    expect(matches[0].tenantId).toBe('default'); // normalized forward
    expect(matches[0].username).toBe('legacy-user-renamed');
  });

  test('a legacy default EntityChunk with no tenantId field is updated in place, not duplicated', async () => {
    // 'vouchers' already has a real tenantId:'default' chunk from initDB()'s
    // own bootstrap persistAll() sweep (every ENTITY_KEYS member is persisted
    // at first boot) — remove it first so the raw-driver insert below is
    // genuinely the only 'vouchers' chunk, reproducing a real pre-multi-
    // tenancy document rather than colliding with the already-normalized one.
    await EntityChunk.deleteMany({ key: 'vouchers' });
    await EntityChunk.collection.insertOne({ key: 'vouchers', data: [{ id: 'V-legacy' }], updatedAt: new Date() });

    const preCheck = await EntityChunk.collection.findOne({ key: 'vouchers' });
    expect('tenantId' in preCheck).toBe(false);

    await runAsTenant('default', async () => {
      const db = loadDB();
      db.vouchers = [{ id: 'V-legacy' }, { id: 'V-new' }];
      await saveDB(db, { durable: true });
    });

    const matches = await EntityChunk.find({ key: 'vouchers' }).lean();
    expect(matches).toHaveLength(1);
    expect(matches[0].tenantId).toBe('default');
    expect(matches[0].data).toEqual([{ id: 'V-legacy' }, { id: 'V-new' }]);
  });

  test('no duplicate default document is created for an existing legacy identity across repeated saves', async () => {
    await User.collection.insertOne({ id: 'usr-legacy-2', username: 'legacy-2', role: 'accountant', active: true });

    for (let i = 0; i < 3; i++) {
      await runAsTenant('default', async () => {
        const db = loadDB();
        db.users = [
          ...db.users.filter(u => u.id !== 'usr-legacy-2'),
          { id: 'usr-legacy-2', username: `legacy-2-rev${i}`, role: 'accountant', active: true },
        ];
        await saveDB(db, { durable: true });
      });
    }

    const matches = await User.find({ id: 'usr-legacy-2' }).lean();
    expect(matches).toHaveLength(1);
    expect(matches[0].username).toBe('legacy-2-rev2');
  });
});
