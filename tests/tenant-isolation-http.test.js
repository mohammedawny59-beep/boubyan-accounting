// P0.1 — Multi-tenant isolation, proven over the REAL Express app + REAL
// middleware stack (Supertest), not by calling the low-level runAsTenant()
// primitive directly (that's what tests/tenant-isolation.test.js already
// does, and — per the forensic audit — it cannot detect that the primitive
// wasn't actually wired into the live HTTP request pipeline).
//
// Safety: forces DB_FILE_ONLY=true (no MongoDB connection is ever attempted)
// and points DATA_FILE/CONFIG_FILE at a throwaway temp directory created for
// this run only. No production data, no real tenant data, nothing outside
// os.tmpdir() is touched. The temp directory is removed in afterAll().

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-1-http-integration-test-secret';
process.env.NODE_ENV     = 'test';

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');
const jwt  = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-http-iso-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

// Loading server.js only registers routes on `app` — it does NOT auto-connect
// a database, start the Telegram bot, run startup auto-repair, or bind a
// real port (guarded behind `require.main === module` — see server.js).
const app = require('../server');

const {
  initDB, shutdownDB, runAsTenant, loadDB, saveDB, warmTenantCache,
} = require('../lib/database');

const JWT_SECRET = process.env.JWT_SECRET;

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function baseCoa() {
  return [
    { id: '1100', code: '1100', name: 'الصندوق', type: 'asset',   isGroup: false },
    { id: '4100', code: '4100', name: 'إيرادات',  type: 'revenue', isGroup: false },
  ];
}

function buildInitialDB() {
  return {
    users: [{
      id: 'usr-default-admin', username: 'default-admin', email: 'default@clinic.com',
      passwordHash: hash('DefaultPass1!'), role: 'admin', fullName: 'مدير العيادة',
      active: true, createdAt: new Date().toISOString(), lastLogin: null,
    }],
    roles: {
      admin: { id: 'admin', tabs: ['*'], actions: {} },
    },
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [],
    journalEntries: [{
      id: 'JE-DEFAULT-1', date: '2026-01-05',
      desc: 'DEFAULT_TENANT_ONLY_JOURNAL', description: 'DEFAULT_TENANT_ONLY_JOURNAL',
      lines: [
        { accountId: '1100', accountCode: '1100', debit: 20, credit: 0 },
        { accountId: '4100', accountCode: '4100', debit: 0, credit: 20 },
      ],
    }],
    chartOfAccounts: baseCoa(),
    vendors: [{ id: 'VND-DEFAULT-1', name: 'DEFAULT_TENANT_ONLY_VENDOR', accountId: '2101' }],
    invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: { name: 'عيادة بوبيان' }, scheduleConfig: {},
    vouchers: [], cashReconciliation: [], insuranceClaims: [], payroll: [], employees: [],
    assets: [], budget: {}, auditLog: [], accruedExpenses: [], journalMappings: [],
    doctorExpenses: [],
  };
}

async function seedTenant(tenantId, { username, password, vendorName, journalDesc, revenueAmount }) {
  await runAsTenant(tenantId, async () => {
    await warmTenantCache(tenantId);
    const db = loadDB();
    db.users = [{
      id: `usr-${tenantId}`, tenantId, username, email: `${username}@example.com`,
      passwordHash: hash(password), role: 'admin', fullName: username,
      active: true, createdAt: new Date().toISOString(), lastLogin: null,
    }];
    db.chartOfAccounts = baseCoa();
    db.vendors = [{ id: `VND-${tenantId}-1`, name: vendorName, accountId: '2101' }];
    db.journalEntries = [{
      id: `JE-${tenantId}-1`, date: '2026-02-10',
      desc: journalDesc, description: journalDesc,
      lines: [
        { accountId: '1100', accountCode: '1100', debit: revenueAmount, credit: 0 },
        { accountId: '4100', accountCode: '4100', debit: 0, credit: revenueAmount },
      ],
    }];
    saveDB(db);
  });
}

beforeAll(async () => {
  await initDB({
    mongoUri: 'mongodb://127.0.0.1:1/unused',
    dataFile: process.env.DATA_FILE,
    configFile: process.env.CONFIG_FILE,
    defaultConfig: {},
    buildInitialDB,
    migrateDB: () => false,
  });

  await seedTenant('tenant-a', {
    username: 'owner-a', password: 'PassA1234!',
    vendorName: 'TENANT_A_ONLY_VENDOR', journalDesc: 'TENANT_A_ONLY_JOURNAL', revenueAmount: 100,
  });
  await seedTenant('tenant-b', {
    username: 'owner-b', password: 'PassB1234!',
    vendorName: 'TENANT_B_ONLY_VENDOR', journalDesc: 'TENANT_B_ONLY_JOURNAL', revenueAmount: 55,
  });
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

async function login(username, password, tenantId) {
  const body = { username, password };
  if (tenantId) body.tenantId = tenantId;
  return request(app).post('/api/auth/login').send(body);
}

describe('P0.1 — Tenant-aware login', () => {
  test('Test 1: Tenant A logs in and receives a JWT tagged tenantId=tenant-a', async () => {
    const res = await login('owner-a', 'PassA1234!', 'tenant-a');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.tenantId).toBe('tenant-a');
    expect(decoded.username).toBe('owner-a');
  });

  test('Test 2: Tenant B logs in and receives a JWT tagged tenantId=tenant-b', async () => {
    const res = await login('owner-b', 'PassB1234!', 'tenant-b');
    expect(res.status).toBe(200);
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.tenantId).toBe('tenant-b');
  });

  test('Test 9: default/legacy clinic login (no tenantId field) still works exactly as before', async () => {
    const res = await login('default-admin', 'DefaultPass1!');
    expect(res.status).toBe(200);
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.tenantId).toBe('default');
  });

  test('wrong password for a real tenant user still fails with the generic message', async () => {
    const res = await login('owner-a', 'wrong-password', 'tenant-a');
    expect(res.status).toBe(401);
  });

  test("tenant A's username does not exist under tenant B — cross-tenant login must fail", async () => {
    const res = await login('owner-a', 'PassA1234!', 'tenant-b');
    expect(res.status).toBe(401);
  });
});

describe('P0.1 — Read isolation over real HTTP routes', () => {
  let tokenA, tokenB, tokenDefault;

  beforeAll(async () => {
    tokenA = (await login('owner-a', 'PassA1234!', 'tenant-a')).body.token;
    tokenB = (await login('owner-b', 'PassB1234!', 'tenant-b')).body.token;
    tokenDefault = (await login('default-admin', 'DefaultPass1!')).body.token;
  });

  test('Test 3: vendor read isolation — A never sees B, B never sees A, neither sees the default clinic', async () => {
    const resA = await request(app).get('/api/vendors').set('Authorization', `Bearer ${tokenA}`);
    const resB = await request(app).get('/api/vendors').set('Authorization', `Bearer ${tokenB}`);
    const namesA = resA.body.map(v => v.name);
    const namesB = resB.body.map(v => v.name);

    expect(namesA).toContain('TENANT_A_ONLY_VENDOR');
    expect(namesA).not.toContain('TENANT_B_ONLY_VENDOR');
    expect(namesA).not.toContain('DEFAULT_TENANT_ONLY_VENDOR');

    expect(namesB).toContain('TENANT_B_ONLY_VENDOR');
    expect(namesB).not.toContain('TENANT_A_ONLY_VENDOR');
    expect(namesB).not.toContain('DEFAULT_TENANT_ONLY_VENDOR');
  });

  test('Test 4: journal isolation via GET /api/data', async () => {
    const resA = await request(app).get('/api/data').set('Authorization', `Bearer ${tokenA}`);
    const descsA = resA.body.journalEntries.map(e => e.desc);
    expect(descsA).toContain('TENANT_A_ONLY_JOURNAL');
    expect(descsA).not.toContain('TENANT_B_ONLY_JOURNAL');
    expect(descsA).not.toContain('DEFAULT_TENANT_ONLY_JOURNAL');

    const resDefault = await request(app).get('/api/data').set('Authorization', `Bearer ${tokenDefault}`);
    const descsDefault = resDefault.body.journalEntries.map(e => e.desc);
    expect(descsDefault).toContain('DEFAULT_TENANT_ONLY_JOURNAL');
    expect(descsDefault).not.toContain('TENANT_A_ONLY_JOURNAL');
    expect(descsDefault).not.toContain('TENANT_B_ONLY_JOURNAL');
  });

  test('Test 7: financial statements (P&L) reflect only the active tenant\'s own journal data', async () => {
    const q = '?from=2000-01-01&to=2999-12-31';
    const resA = await request(app).get('/api/reports/pnl' + q).set('Authorization', `Bearer ${tokenA}`);
    const resB = await request(app).get('/api/reports/pnl' + q).set('Authorization', `Bearer ${tokenB}`);

    expect(resA.body.totalRevenue).toBe(100);
    expect(resB.body.totalRevenue).toBe(55);
  });

  test('Step 9 security check: a tenantId supplied in the query string post-auth is ignored — active tenant always comes from the verified JWT', async () => {
    const res = await request(app)
      .get('/api/vendors?tenantId=tenant-b')
      .set('Authorization', `Bearer ${tokenA}`);
    const names = res.body.map(v => v.name);
    expect(names).toContain('TENANT_A_ONLY_VENDOR');
    expect(names).not.toContain('TENANT_B_ONLY_VENDOR');
  });
});

describe('P0.1 — Write isolation over real HTTP routes', () => {
  let tokenA, tokenB;

  beforeAll(async () => {
    tokenA = (await login('owner-a', 'PassA1234!', 'tenant-a')).body.token;
    tokenB = (await login('owner-b', 'PassB1234!', 'tenant-b')).body.token;
  });

  test('Test 5: a vendor created with Tenant A\'s token only exists for Tenant A', async () => {
    const create = await request(app)
      .post('/api/vendors')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'TENANT_A_WRITE_TEST_VENDOR' });
    expect(create.status).toBe(200);
    expect(create.body.success).toBe(true);

    const listA = await request(app).get('/api/vendors').set('Authorization', `Bearer ${tokenA}`);
    const listB = await request(app).get('/api/vendors').set('Authorization', `Bearer ${tokenB}`);
    expect(listA.body.map(v => v.name)).toContain('TENANT_A_WRITE_TEST_VENDOR');
    expect(listB.body.map(v => v.name)).not.toContain('TENANT_A_WRITE_TEST_VENDOR');
  });

  test('Test 6: an account created in Tenant A\'s chart of accounts does not appear for Tenant B', async () => {
    const create = await request(app)
      .post('/api/coa/account')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ code: '4200', name: 'TENANT_A_ONLY_ACCOUNT', type: 'revenue' });
    expect(create.status).toBe(200);
    expect(create.body.success).toBe(true);

    const coaA = await request(app).get('/api/coa').set('Authorization', `Bearer ${tokenA}`);
    const coaB = await request(app).get('/api/coa').set('Authorization', `Bearer ${tokenB}`);
    expect(coaA.body.map(a => a.code)).toContain('4200');
    expect(coaB.body.map(a => a.code)).not.toContain('4200');
  });
});

describe('P0.1 — Fail-closed on invalid tenant identity (Step 6/8)', () => {
  test('Test 8: a JWT carrying a tenantId that does not correspond to any real tenant never returns another tenant\'s data', async () => {
    const ghostToken = jwt.sign(
      { id: 'ghost', username: 'ghost', role: 'admin', tenantId: 'nonexistent-tenant-xyz' },
      JWT_SECRET, { expiresIn: '1h' },
    );
    const res = await request(app).get('/api/vendors').set('Authorization', `Bearer ${ghostToken}`);
    // P0.4 — Step 4 strengthened this further: a JWT whose user id doesn't
    // match any real (live) user record in the resolved tenant context is
    // now rejected outright (401) by tenantMiddleware's live-user check,
    // before the route ever runs — an even stronger guarantee than "returns
    // an empty array" (there is now no code path that returns ANY data,
    // empty or otherwise, for a forged/stale user id).
    expect(res.status).toBe(401);
  });

  test('a request with no Authorization header is rejected (401) rather than defaulting to any tenant', async () => {
    const res = await request(app).get('/api/vendors');
    expect(res.status).toBe(401);
  });

  test('a malformed/expired JWT is rejected (401)', async () => {
    const res = await request(app)
      .get('/api/vendors')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});
