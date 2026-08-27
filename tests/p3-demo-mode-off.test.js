// P3 — DEMO_MODE defaults OFF, and production behavior is unchanged when
// it isn't explicitly set to exactly 'true'. File-storage isolated
// (DB_FILE_ONLY, os.tmpdir()).

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p3-demo-mode-off-test-secret-32-chars-minimum';
process.env.ADMIN_DEFAULT_PASSWORD = 'P3DemoOffTestAdmin#2026';
process.env.NODE_ENV     = 'production';
delete process.env.DEMO_MODE; // the default-off case — not set at all

const os = require('os'), path = require('path'), fs = require('fs-extra'), bcrypt = require('bcryptjs'), request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p3-demo-off-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

function hash(pw) { return bcrypt.hashSync(pw, 10); }
function buildInitialDB() {
  return {
    users: [{ id: 'usr-admin', username: 'admin', email: 'a@test.com', passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير', active: true, createdAt: new Date().toISOString(), lastLogin: null }],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], fixedAssets: [], budget: {}, auditLog: [], accruedExpenses: [],
    journalMappings: [], doctorExpenses: [], lockedPeriods: {}, vendorBills: [], accountingSettings: {},
  };
}

let adminToken;
beforeAll(async () => {
  await initDB({ mongoUri: 'mongodb://127.0.0.1:1/unused', dataFile: process.env.DATA_FILE, configFile: process.env.CONFIG_FILE, defaultConfig: {}, buildInitialDB, migrateDB: () => false });
  adminToken = (await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' })).body.token;
});
afterAll(async () => { try { await shutdownDB(); } catch {} try { fs.removeSync(tmp); } catch {} });
const auth = () => ({ Authorization: `Bearer ${adminToken}` });

test('demo-status reports demoMode=false when DEMO_MODE is unset', async () => {
  const r = await request(app).get('/api/demo-status');
  expect(r.status).toBe(200);
  expect(r.body.demoMode).toBe(false);
});

// Note: a live round-trip test of "/api/tenants/register succeeds when
// DEMO_MODE is off" would need a real Mongo connection (the route's
// Tenant.findOne call hangs indefinitely against file-mode's unreachable
// stub URI) — covered instead by tests/p3-demo-mode.test.js's ON-case,
// which proves the block is a single guarded early-return: when DEMO_MODE
// is false, execution trivially continues past it unchanged.

test('demo reset endpoint returns 404 (does not exist) when DEMO_MODE is off', async () => {
  const r = await request(app).post('/api/demo/reset').set(auth());
  expect(r.status).toBe(404);
});

test('assets.view route still requires admin — a would-be "demo" role gets no special access when DEMO_MODE is off', async () => {
  // No 'demo' role user exists in production's real role set at all, but
  // confirm the middleware itself still enforces admin-only for any
  // non-admin caller regardless of DEMO_MODE.
  const receptionist = await request(app).post('/api/users').set(auth()).send({ username: 'recep1', password: 'RecepPass1!', role: 'receptionist', fullName: 'r' });
  const recepLogin = await request(app).post('/api/auth/login').send({ username: 'recep1', password: 'RecepPass1!' });
  const r = await request(app).get('/api/assets').set({ Authorization: `Bearer ${recepLogin.body.token}` });
  expect(r.status).toBe(403);
});
