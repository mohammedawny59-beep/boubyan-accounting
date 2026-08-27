// P3 — proves the demo seed is already canonical from the repair suite's
// own point of view: after a fresh seed, running the EXACT SAME
// runAutoRepairSuite() a real production/demo boot runs (exercised here via
// POST /api/repair/auto, the pre-existing admin-only manual-trigger route
// for that same function — never re-implemented or bypassed) applies ZERO
// changes. Specifically closes the vnd-pearl-1 double-posting found during
// live P3 validation: the vendor's opening balance is now represented via
// a dedicated JE-VND-OPEN-<id> entry (the exact id/shape
// setVendorOpening() itself produces), so the repair suite's own
// vendor-opening-restored existence check already finds it satisfied.
//
// Real isolated Mongo (mongodb-memory-server via mongoTestHarness), same
// pattern as tests/p3-demo-reset-mongo.test.js. No production reference
// anywhere in this file.

process.env.DEMO_MODE = 'true';
process.env.JWT_SECRET = 'p3-demo-seed-canonical-test-secret-32min';
process.env.ADMIN_DEFAULT_PASSWORD = 'P3SeedCanonicalTestAdmin#2026';
process.env.NODE_ENV = 'production';
delete process.env.DB_FILE_ONLY;

const { startIsolatedMongo } = require('./helpers/mongoTestHarness');

async function bootAgainst(mongoUri) {
  jest.resetModules();
  process.env.MONGO_URI = mongoUri;
  const request = require('supertest');
  const app = require('../server');
  const { initDB, shutdownDB } = require('../lib/database');
  const { DEFAULT_COA } = require('../lib/defaults');
  await initDB({
    mongoUri, dataFile: '/unused', configFile: '/unused', defaultConfig: {},
    buildInitialDB: () => ({ chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })), users: [], roles: {}, journalEntries: [], vendors: [], doctors: [], employees: [], patients: [], fixedAssets: [], auditLog: [] }),
    migrateDB: () => false,
  });
  return { request, app, shutdownDB };
}

describe('P3 — demo seed is already canonical (zero repair-suite changes on a fresh boot)', () => {
  let mongo, request, app, shutdownDB, adminToken;

  beforeAll(async () => {
    mongo = await startIsolatedMongo('demo');
    ({ request, app, shutdownDB } = await bootAgainst(mongo.uri));
    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'P3SeedCanonicalTestAdmin#2026' });
    adminToken = login.body.token;
    // Establish the canonical seed exactly as a real first boot / reset does.
    const seedRes = await request(app).post('/api/demo/reset').set({ Authorization: `Bearer ${adminToken}` });
    expect(seedRes.status).toBe(200);
  });

  afterAll(async () => { try { await shutdownDB(); } catch {} try { await mongo.stop(); } catch {} });
  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('runAutoRepairSuite() (via POST /api/repair/auto) applies ZERO changes against the fresh seed', async () => {
    const before = await request(app).get('/api/journal?pageSize=1').set(auth());
    const beforeCount = before.body.total;

    const repair = await request(app).post('/api/repair/auto').set(auth());
    expect(repair.status).toBe(200);
    expect(repair.body.fixed).toBe(0);
    expect(repair.body.applied).toEqual([]);

    const after = await request(app).get('/api/journal?pageSize=1').set(auth());
    expect(after.body.total).toBe(beforeCount); // no new entries created by the repair pass
  });

  test('vendor vnd-pearl-1 (شركة اللؤلؤة للمستلزمات الطبية) GL balance is exactly 620.500, not doubled', async () => {
    await request(app).post('/api/repair/auto').set(auth()); // idempotent — safe to run again
    const tb = await request(app).get('/api/trial-balance').set(auth());
    const row = tb.body.rows.find(r => r.code === '2101');
    expect(row).toBeTruthy();
    expect(row.netCredit).toBe(620.5);
    expect(row.netDebit).toBe(0);
  });

  test('the vendor statement for vnd-pearl-1 reconciles exactly to GL, with exactly one opening row', async () => {
    const vendors = await request(app).get('/api/vendors').set(auth());
    const vendor = vendors.body.find(v => v.accountId === '2101');
    expect(vendor).toBeTruthy();
    const stmt = await request(app).get(`/api/vendors/${vendor.id}/statement`).set(auth());
    expect(stmt.body.endingBalance).toBe(620.5);
    expect(stmt.body.reconciliation.glBalance).toBe(620.5);
    expect(stmt.body.reconciliation.difference).toBe(0);
    expect(stmt.body.reconciliation.reconciled).toBe(true);
    expect(stmt.body.rows.filter(r => r.direction === 'credit' && r.amount === 620.5).length).toBe(1); // not duplicated
  });

  test('Trial Balance and Balance Sheet remain balanced after the repair pass', async () => {
    const tb = await request(app).get('/api/trial-balance').set(auth());
    expect(tb.body.isBalanced).toBe(true);
    const bs = await request(app).get('/api/reports/balance-sheet').set(auth());
    expect(bs.body.balanced).toBe(true);
  });

  test('AP aging is coherent — vnd-pearl-1 appears exactly once, at 620.500', async () => {
    const ap = await request(app).get('/api/ap-aging').set(auth());
    const rows = ap.body.rows.filter(r => r.vendor.includes('اللؤلؤة'));
    expect(rows.length).toBe(1);
    expect(rows[0].total).toBe(620.5);
  });

  test('reset remains deterministic: two resets after the repair pass produce identical totals', async () => {
    const r1 = await request(app).post('/api/demo/reset').set(auth());
    const tb1 = await request(app).get('/api/trial-balance').set(auth());
    const r2 = await request(app).post('/api/demo/reset').set(auth());
    const tb2 = await request(app).get('/api/trial-balance').set(auth());
    expect(r1.body.journalEntryCount).toBe(r2.body.journalEntryCount);
    expect(tb1.body.grandDebit).toBe(tb2.body.grandDebit);
    expect(tb1.body.grandCredit).toBe(tb2.body.grandCredit);
    expect(r1.body.balanced).toBe(true);
    expect(r2.body.balanced).toBe(true);
  });
});
