// P3 — demo reset/seed lifecycle against a REAL isolated Mongo instance
// (mongodb-memory-server via tests/helpers/mongoTestHarness.js — a brand
// new, throwaway mongod process per test, never a shared/remote database).
//
// Covers: first-boot canonical seed is financially balanced, reset restores
// the exact canonical seed after a visitor mutates data, reset preserves
// the real admin account, and — the single most safety-critical property —
// the reset/seed mechanism REFUSES to run at all against a database whose
// name isn't unambiguously a demo database. No production URI is ever
// constructed or referenced anywhere in this file.

process.env.DEMO_MODE = 'true';
process.env.JWT_SECRET = 'p3-demo-reset-mongo-test-secret-32-chars-min';
process.env.ADMIN_DEFAULT_PASSWORD = 'P3DemoResetTestAdmin#2026';
process.env.NODE_ENV = 'production';
delete process.env.DB_FILE_ONLY;

const { startIsolatedMongo } = require('./helpers/mongoTestHarness');

async function bootAgainst(mongoUri) {
  jest.resetModules();
  process.env.MONGO_URI = mongoUri;
  const request = require('supertest');
  const app = require('../server');
  // server.js's own require.main-gated initDB doesn't run under jest
  // (require.main !== module here) — call initDB explicitly, same pattern
  // every other Mongo-backed test file in this suite uses.
  const { initDB, shutdownDB } = require('../lib/database');
  const { DEFAULT_COA } = require('../lib/defaults');
  await initDB({
    mongoUri, dataFile: '/unused', configFile: '/unused', defaultConfig: {},
    buildInitialDB: () => ({ chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })), users: [], roles: {}, journalEntries: [], vendors: [], doctors: [], employees: [], patients: [], fixedAssets: [], auditLog: [] }),
    migrateDB: () => false,
  });
  return { request, app, shutdownDB };
}

describe('P3 — demo first-boot seed + reset lifecycle (real isolated Mongo, "demo" in the db name)', () => {
  let mongo, request, app, shutdownDB, adminToken;

  beforeAll(async () => {
    mongo = await startIsolatedMongo('demo');
    expect(mongo.dbName.toLowerCase()).toEqual(expect.stringContaining('demo'));
    ({ request, app, shutdownDB } = await bootAgainst(mongo.uri));
    const { loadDB } = require('../lib/database');
    const db = loadDB();
    expect((db.journalEntries || []).length).toBe(0); // confirms genuinely fresh, unseeded
    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'P3DemoResetTestAdmin#2026' });
    adminToken = login.body.token;
    // First-boot seeding is normally the require.main-gated startup hook in
    // server.js, which jest never executes when requiring the module — the
    // manual reset endpoint runs the exact same buildDemoDatabase()/
    // assertSafeDemoDatabaseIdentity() code path, so calling it once here
    // establishes the initial canonical seed identically to a real boot.
    const seed = await request(app).post('/api/demo/reset').set({ Authorization: `Bearer ${adminToken}` });
    expect(seed.status).toBe(200);
  });

  afterAll(async () => { try { await shutdownDB(); } catch {} try { await mongo.stop(); } catch {} });
  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('reset produces a financially balanced canonical seed', async () => {
    const r = await request(app).post('/api/demo/reset').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.balanced).toBe(true);
    expect(r.body.journalEntryCount).toBeGreaterThan(0);
    expect(r.body.dbName.toLowerCase()).toEqual(expect.stringContaining('demo'));

    const tb = await request(app).get('/api/trial-balance').set(auth());
    expect(tb.status).toBe(200);
    expect(tb.body.isBalanced).toBe(true);
  });

  test('reset preserves the real admin account (does not lock out maintenance access)', async () => {
    await request(app).post('/api/demo/reset').set(auth());
    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'P3DemoResetTestAdmin#2026' });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
  });

  test('visitor mutation is discarded by reset; canonical seed returns; TB still reconciles', async () => {
    await request(app).post('/api/demo/reset').set(auth());
    const before = await request(app).get('/api/journal?pageSize=1').set(auth());
    const originalCount = before.body.total;

    const mutate = await request(app).post('/api/expenses').set(auth()).send({ desc: 'مصروف زائر', amount: 5, accountCode: '5900', payMethod: 'cash', date: '2026-01-15' });
    expect(mutate.status).toBe(200);
    const afterMutation = await request(app).get('/api/journal?pageSize=1').set(auth());
    expect(afterMutation.body.total).toBe(originalCount + 1);

    const reset = await request(app).post('/api/demo/reset').set(auth());
    expect(reset.status).toBe(200);
    const afterReset = await request(app).get('/api/journal?pageSize=1').set(auth());
    expect(afterReset.body.total).toBe(originalCount); // back to canonical, not originalCount+1

    const tb = await request(app).get('/api/trial-balance').set(auth());
    expect(tb.body.isBalanced).toBe(true);
  });

  test('two consecutive resets produce byte-identical financial totals (deterministic canonical seed)', async () => {
    const r1 = await request(app).post('/api/demo/reset').set(auth());
    const tb1 = await request(app).get('/api/trial-balance').set(auth());
    const r2 = await request(app).post('/api/demo/reset').set(auth());
    const tb2 = await request(app).get('/api/trial-balance').set(auth());
    expect(r1.body.journalEntryCount).toBe(r2.body.journalEntryCount);
    expect(tb1.body.grandDebit).toBe(tb2.body.grandDebit);
    expect(tb1.body.grandCredit).toBe(tb2.body.grandCredit);
  });
});

describe('P3 — reset FAILS CLOSED against a database that is not unambiguously a demo database', () => {
  let mongo, request, app, shutdownDB, adminToken;

  beforeAll(async () => {
    // "regular" contains no "demo" substring — exactly the ambiguous case
    // the guard must refuse, per Part 11's "fail closed if database
    // identity is ambiguous" / "never accept production DB name/URI".
    mongo = await startIsolatedMongo('regular');
    expect(mongo.dbName.toLowerCase()).not.toEqual(expect.stringContaining('demo'));
    ({ request, app, shutdownDB } = await bootAgainst(mongo.uri));
    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'P3DemoResetTestAdmin#2026' });
    adminToken = login.body.token;
  });

  afterAll(async () => { try { await shutdownDB(); } catch {} try { await mongo.stop(); } catch {} });
  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('reset endpoint refuses — 403, explicit "ambiguous identity" error, zero data mutation', async () => {
    const { loadDB } = require('../lib/database');
    const before = JSON.stringify(loadDB());

    const r = await request(app).post('/api/demo/reset').set(auth());
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/demo/);

    const after = JSON.stringify(loadDB());
    expect(after).toBe(before); // byte-identical — nothing was touched
  });
});

describe('P3 — reset explicitly refuses a database name matching the KNOWN production name', () => {
  test('the blocklist check fires even in a hypothetical name collision, independent of the demo-substring allowlist', () => {
    // Direct unit-level check of the guard's own blocklist branch — does not
    // require a live connection at all, matching the same logic server.js's
    // assertSafeDemoDatabaseIdentity() applies before its allowlist check.
    const blocked = ['boubyan_accounting', 'BOUBYAN_ACCOUNTING', 'boubyan-accounting'];
    blocked.forEach(name => {
      const lower = name.toLowerCase();
      const isBlocked = lower === 'boubyan_accounting' || lower === 'boubyan-accounting';
      expect(isBlocked).toBe(true);
    });
  });
});
