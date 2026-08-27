// R4 — Part C: journal source-traceability tags. Payroll, accrued-expense,
// and bank-reconciliation journal entries had NO source/sourceModule tag at
// all before this milestone — the new frontend journal-detail "go to
// source" feature (public/index.html — journalSourceInfo()) depends on
// these being present. Proves each JE-creation path now carries them.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'r4-source-tags-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-r4-source-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

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

let adminToken;

beforeAll(async () => {
  await initDB({
    mongoUri: 'mongodb://127.0.0.1:1/unused',
    dataFile: process.env.DATA_FILE,
    configFile: process.env.CONFIG_FILE,
    defaultConfig: {},
    buildInitialDB,
    migrateDB: () => false,
  });
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
  adminToken = login.body.token;
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

async function findJE(pred) {
  let db; await runAsTenant('default', async () => { db = loadDB(); });
  return (db.journalEntries || []).find(pred);
}

describe('R4 Part C — journal source-traceability tags', () => {
  test('Source A: a new payroll accrual JE carries source=payroll/sourceModule=payroll/sourceId=<payroll record id>', async () => {
    const res = await request(app).post('/api/payroll').set(auth()).send({
      month: '2061-01', entries: [{ name: 'موظف تتبع أ', role: 'admin', basicSalary: 400, allowances: 0, deductions: 0 }],
    });
    expect(res.status).toBe(200);
    const je = await findJE(j => j.ref === 'PAY-ACC-2061-01');
    expect(je).toBeTruthy();
    expect(je.source).toBe('payroll');
    expect(je.sourceModule).toBe('payroll');
    expect(je.sourceId).toBe(res.body.record.id);
  });

  test('Source B: marking a payroll record paid (PUT /api/payroll/:id/status) tags the payment JE the same way', async () => {
    const list = await request(app).get('/api/payroll').set(auth());
    const rec = list.body.find(p => p.month === '2061-01');
    const res = await request(app).put(`/api/payroll/${rec.id}/status`).set(auth()).send({
      status: 'paid', paidDate: '2061-01-28', payMethod: 'cash',
    });
    expect(res.status).toBe(200);
    const je = await findJE(j => j.ref === 'PAY-PMT-2061-01');
    expect(je).toBeTruthy();
    expect(je.source).toBe('payroll');
    expect(je.sourceModule).toBe('payroll');
  });

  test('Source C: a new accrued-expense JE carries source=accrued-expense/sourceModule=expenses', async () => {
    const res = await request(app).post('/api/accrued-expenses').set(auth()).send({
      description: 'مصروف تتبع المصدر', amount: 300, month: '2061-02', dueDate: '2061-02-15', vendor: 'Src-Vendor', accountCode: '5900',
    });
    expect(res.status).toBe(200);
    const item = res.body.item;
    const je = await findJE(j => j.id === item.jeId);
    expect(je).toBeTruthy();
    expect(je.source).toBe('accrued-expense');
    expect(je.sourceModule).toBe('expenses');
    expect(je.sourceId).toBe(item.id);
  });

  test('Source D: settling an accrued expense tags the payment JE the same way', async () => {
    const list = await request(app).get('/api/accrued-expenses').set(auth());
    const item = list.body.accruedExpenses.find(a => a.description === 'مصروف تتبع المصدر');
    const res = await request(app).put(`/api/accrued-expenses/${item.id}`).set(auth()).send({ status: 'paid', paidDate: '2061-02-20' });
    expect(res.status).toBe(200);
    const je = await findJE(j => j.type === 'accrued-expense-payment' && j.ref === `${item.number || item.id}-PAY`);
    expect(je).toBeTruthy();
    expect(je.source).toBe('accrued-expense');
    expect(je.sourceId).toBe(item.id);
  });

  test('Source E: a committed bank-reconciliation settlement JE carries source=bank-recon/sourceModule=bankrecon', async () => {
    const res = await request(app).post('/api/bank/reconcile-commit').set(auth()).send({
      proposals: [{ kind: 'settlement', srcKey: 'src-tag-settle-1', bucket: 'knet', net: 40, settleAccount: '1125', bankAccount: '1110', bankDate: '2061-03-05', bankDesc: 'source-tag test settlement' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(1);
    const je = await findJE(j => j.type === 'bank-settlement' && j._srcKey === 'src-tag-settle-1');
    expect(je).toBeTruthy();
    expect(je.source).toBe('bank-recon');
    expect(je.sourceModule).toBe('bankrecon');
  });
});
