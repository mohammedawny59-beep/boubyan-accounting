// P3 — DEMO_MODE=true behaviors: demo-status, demo role restrictions,
// tenant-registration block, assets.view read access for the demo role.
// File-storage isolated (DB_FILE_ONLY, os.tmpdir()) — the reset/seed
// lifecycle itself (which requires a real Mongo identity check) is covered
// separately in tests/p3-demo-reset-mongo.test.js.

process.env.DB_FILE_ONLY = 'true';
process.env.DEMO_MODE    = 'true';
process.env.JWT_SECRET   = 'p3-demo-mode-test-secret-at-least-32-chars-long';
process.env.ADMIN_DEFAULT_PASSWORD = 'P3DemoTestAdmin#2026Strong';
process.env.NODE_ENV     = 'production';

const os = require('os'), path = require('path'), fs = require('fs-extra'), bcrypt = require('bcryptjs'), request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p3-demo-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

function hash(pw) { return bcrypt.hashSync(pw, 10); }
function buildInitialDB() {
  return {
    users: [
      { id: 'usr-admin', username: 'admin', email: 'a@test.com', passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير', active: true, createdAt: new Date().toISOString(), lastLogin: null },
      { id: 'usr-demo', username: 'demo', email: 'demo@test.com', passwordHash: hash('DemoPass1!'), role: 'demo', fullName: 'زائر تجريبي', active: true, createdAt: new Date().toISOString(), lastLogin: null },
    ],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], fixedAssets: [{ id: 'ast-1', code: 'FA-1', name: 'كرسي', cost: 500, coaAccount: '1510', accDepAccount: '1590', depExpAccount: '5800', status: 'active' }],
    budget: {}, auditLog: [], accruedExpenses: [], journalMappings: [], doctorExpenses: [],
    lockedPeriods: {}, vendorBills: [], accountingSettings: {},
  };
}

let adminToken, demoToken;
beforeAll(async () => {
  await initDB({ mongoUri: 'mongodb://127.0.0.1:1/unused', dataFile: process.env.DATA_FILE, configFile: process.env.CONFIG_FILE, defaultConfig: {}, buildInitialDB, migrateDB: () => false });
  adminToken = (await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' })).body.token;
  demoToken = (await request(app).post('/api/auth/login').send({ username: 'demo', password: 'DemoPass1!' })).body.token;
});
afterAll(async () => { try { await shutdownDB(); } catch {} try { fs.removeSync(tmp); } catch {} });
const authA = () => ({ Authorization: `Bearer ${adminToken}` });
const authD = () => ({ Authorization: `Bearer ${demoToken}` });

test('demo-status: publicly reports demoMode=true, no auth required', async () => {
  const r = await request(app).get('/api/demo-status');
  expect(r.status).toBe(200);
  expect(r.body.demoMode).toBe(true);
});

test('demo role: CAN view assets (list, detail, reconciliation) via requireAdminOrDemoView', async () => {
  const list = await request(app).get('/api/assets').set(authD());
  expect(list.status).toBe(200);
  expect(Array.isArray(list.body)).toBe(true);
  const detail = await request(app).get('/api/assets/ast-1').set(authD());
  expect(detail.status).toBe(200);
  const recon = await request(app).get('/api/assets/reconciliation').set(authD());
  expect(recon.status).toBe(200);
});

test('demo role: CANNOT create/update/delete/dispose assets (mutating requireAdminAction still admin-only)', async () => {
  const create = await request(app).post('/api/assets').set(authD()).send({ name: 'x', cost: 100, coaAccount: '1510' });
  expect(create.status).toBe(403);
  const update = await request(app).put('/api/assets/ast-1').set(authD()).send({ name: 'y' });
  expect(update.status).toBe(403);
  const del = await request(app).delete('/api/assets/ast-1').set(authD());
  expect(del.status).toBe(403);
});

test('demo role: CANNOT reach user management, roles, backup, reset-data, settings (all admin-only, untouched)', async () => {
  expect((await request(app).get('/api/users').set(authD())).status).toBe(403);
  expect((await request(app).get('/api/roles').set(authD())).status).toBe(403);
  expect((await request(app).get('/api/admin/backup').set(authD())).status).toBe(403);
  expect((await request(app).post('/api/reset-data').set(authD()).send({ scope: 'all' })).status).toBe(403);
  expect((await request(app).put('/api/accounting-settings').set(authD()).send({})).status).toBe(403);
  expect((await request(app).get('/api/audit-log').set(authD())).status).toBe(403);
});

test('demo role: CAN view dashboard-adjacent read routes (journal, coa, financials)', async () => {
  expect((await request(app).get('/api/journal').set(authD())).status).toBe(200);
  expect((await request(app).get('/api/coa').set(authD())).status).toBe(200);
  expect((await request(app).get('/api/trial-balance').set(authD())).status).toBe(200);
});

test('tenant registration: blocked when DEMO_MODE=true, before any Mongoose/Tenant call', async () => {
  const r = await request(app).post('/api/tenants/register').send({ name: 'x', email: 'x@example.com', password: 'password123' });
  expect(r.status).toBe(403);
  expect(r.body.error).toBe('التسجيل غير متاح في البيئة التجريبية');
});

test('demo reset endpoint: exists but refuses in file-fallback mode (no Mongo database identity to verify — fails closed)', async () => {
  const r = await request(app).post('/api/demo/reset').set(authA());
  expect(r.status).toBe(403);
  expect(r.body.error).toMatch(/وضع الملف المحلي/);
});
