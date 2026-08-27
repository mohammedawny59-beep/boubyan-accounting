// R5 (staging validation) — GET /api/stats vs month-end close regression.
//
// Reproduces a real, high-severity bug found while staging-testing a 3-month
// synthetic company: after even ONE period close, the dashboard's headline
// GET /api/stats totalExpenses/totalPayroll/netIncome silently collapsed to
// ~0 (or, for netIncome, silently equalled totalRevenue as if there were no
// expenses at all) — while every other report (GET /api/reports/pnl,
// GET /api/trial-balance) remained correct. Root cause: the route summed a
// signed net (debit-credit) across every 5xxx-coded journal line with NO
// type:'closing' exclusion, so the closing entry's large CREDIT to each
// expense account (zeroing it into 3300) became a large NEGATIVE "expense"
// that cancelled out the real expense postings for the same accounts.
// totalRevenue happened to stay correct only because that loop counts
// CREDIT-only lines on 4xxx accounts, and a closing entry DEBITS (not
// credits) revenue accounts — an accidental, fragile correctness, not a
// real exclusion. GET /api/reports/pnl already excludes type:'closing' for
// this exact reason; this endpoint did not.
//
// Isolated, real-app test (DB_FILE_ONLY, os.tmpdir()) via supertest against
// the real exported Express app — no production data, no real network.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'r5-stats-closing-secret-32-chars-x';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-r5-stats-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [{ id: 'usr-admin', username: 'admin', email: 'admin@test.com', passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير', active: true, createdAt: new Date().toISOString(), lastLogin: null }],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], fixedAssets: [], budget: {}, auditLog: [], accruedExpenses: [],
    journalMappings: [], doctorExpenses: [], lockedPeriods: {}, vendorBills: [], accountingSettings: {},
    patientAR: [], patients: [], patientReceivables: [],
    bankRecons: [], bankCommittedLineKeys: [], bankMatchedLineIds: [], networkReceivableCleared: { knet: 0, card: 0 },
  };
}

let token;
beforeAll(async () => {
  await initDB({ mongoUri: null, dataFile: process.env.DATA_FILE, configFile: process.env.CONFIG_FILE, defaultConfig: {}, buildInitialDB, migrateDB: (db) => false });
  const r = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
  token = r.body.token;
});
afterAll(async () => { await shutdownDB(); });
function auth() { return { Authorization: 'Bearer ' + token }; }

describe('R5 — GET /api/stats survives a period-end close', () => {
  test('Stats A: totalExpenses/netIncome remain correct (non-zero, matching PNL) after /api/close/run-all posts a closing entry for the same month', async () => {
    // Real revenue via the same route real patient revenue uses (sets
    // accountId on its lines, unlike a raw manual journal entry — this
    // is what actually exercises the revenue-counting loop below).
    const patient = await request(app).post('/api/patients').set(auth()).send({ name: 'Stats Test Patient' });
    expect(patient.status).toBe(200);
    const rev = await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.body.patient.id, serviceDate: '2053-02-10', description: 'إيراد اختبار', amount: 500,
    });
    expect(rev.status).toBe(200);
    const exp = await request(app).post('/api/expenses').set(auth()).send({
      date: '2053-02-12', desc: 'مصروف اختبار', cat: 'إيجار', amount: 300, payMethodCode: 'cash',
    });
    expect(exp.status).toBe(200);

    const beforeClose = await request(app).get('/api/stats').set(auth());
    expect(beforeClose.body.totalRevenue).toBeCloseTo(500, 2);
    expect(beforeClose.body.totalExpenses).toBeCloseTo(300, 2);
    expect(beforeClose.body.netIncome).toBeCloseTo(200, 2);

    const close = await request(app).post('/api/close/run-all').set(auth()).send({ month: '2053-02', options: { depreciation: false, pifss: false, eos: false, closing: true, lock: false } });
    expect(close.status).toBe(200);

    const afterClose = await request(app).get('/api/stats').set(auth());
    // This is the exact regression: before the fix, totalExpenses collapsed
    // to ~0 and netIncome equalled totalRevenue, even though nothing about
    // the real revenue/expense activity changed.
    expect(afterClose.body.totalRevenue).toBeCloseTo(500, 2);
    expect(afterClose.body.totalExpenses).toBeCloseTo(300, 2);
    expect(afterClose.body.netIncome).toBeCloseTo(200, 2);

    // Cross-check against the report that was already correct, proving both
    // now agree instead of silently diverging.
    const pnl = await request(app).get('/api/reports/pnl').set(auth()).query({ from: '2053-02-01', to: '2053-02-28' });
    expect(pnl.body.totalExpenses).toBeCloseTo(afterClose.body.totalExpenses, 2);
    expect(pnl.body.netIncome).toBeCloseTo(afterClose.body.netIncome, 2);
  });

  test('Stats B: a second, later month\'s activity is unaffected by an earlier month\'s closing entry (no cross-period cancellation)', async () => {
    const exp2 = await request(app).post('/api/expenses').set(auth()).send({
      date: '2053-03-05', desc: 'مصروف شهر لاحق', cat: 'صيانة', amount: 120, payMethodCode: 'cash',
    });
    expect(exp2.status).toBe(200);
    const stats = await request(app).get('/api/stats').set(auth());
    // Life-to-date total must include BOTH months' real expenses (300 + 120)
    // with the prior month's closing entry still correctly excluded.
    expect(stats.body.totalExpenses).toBeCloseTo(420, 2);
  });
});

describe('R5 — period lock via /api/close/run-all is audit-logged', () => {
  test('Audit A: locking a period through month-end close writes a period.locked event, matching the standalone POST /api/period-lock route', async () => {
    // Reproduces a real audit-trail completeness gap found while staging-
    // testing: db.lockedPeriods[month]=true was set directly inside
    // /api/close/run-all's lock step with NO appendAuditEvent call — a real
    // 3-month staging run showed GET /api/audit-log?action=period.locked
    // returning total:0 despite 3 real month-end locks having happened,
    // while the standalone POST /api/period-lock route (used far less often
    // in practice than the one-button month-end close) correctly logs it.
    const before = await request(app).get('/api/audit-log').set(auth()).query({ action: 'period.locked' });
    const beforeCount = before.body.total;

    const close = await request(app).post('/api/close/run-all').set(auth()).send({
      month: '2053-05', options: { depreciation: false, pifss: false, eos: false, closing: false, lock: true, confirmEmptyClose: true },
    });
    expect(close.status).toBe(200);
    expect(close.body.locked).toBe(true);

    const after = await request(app).get('/api/audit-log').set(auth()).query({ action: 'period.locked' });
    expect(after.body.total).toBe(beforeCount + 1);
    const event = after.body.logs.find(l => l.resourceId === '2053-05');
    expect(event).toBeTruthy();
    expect(event.action).toBe('period.locked');
    expect(event.after).toEqual({ locked: true });
  });
});
