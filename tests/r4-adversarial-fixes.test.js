// R4 — fixes arising from the Part W 6-persona adversarial review (the
// review's own automated verify phase hit a session-limit mid-run, so these
// findings were verified manually against the real code before being acted
// on — see the "Accountant" persona findings in the workflow transcript).
//
// This file covers the CRITICAL finding: processDailyIncomeUpload()
// deleted a month's OLD auto-income journal entry unconditionally, before
// building/validating its replacement. A rejection while building the
// replacement (most realistically PERIOD_LOCKED — a correction upload
// touching an already-closed month) aborted the function with the old
// entry already spliced out of the live in-memory db and never restored.
// Fixed with prepare-then-commit ordering: validate the candidate entry
// first, only delete the old one once the replacement is known-good.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'r4-adversarial-fixes-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');
const XLSX    = require('xlsx');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-r4-adv-'));
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

function dailyIncomeBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Date', 'Cash', 'K-Net', 'Visa', 'Master', 'Insurance', 'Cheque', 'Link', 'Total', 'Advance'],
    ...rows,
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function uploadMonth(rows) {
  const buf = dailyIncomeBuffer(rows);
  return request(app).post('/api/upload').set(auth()).attach('file', buf, 'DailyIncome.xlsx');
}

async function getDb() {
  let db; await runAsTenant('default', async () => { db = loadDB(); });
  return db;
}

describe('R4 adversarial-review fix — daily-income month rebuild no longer deletes-before-validate', () => {
  test('AdvFix A: a correction upload rejected for PERIOD_LOCKED leaves the existing month entry completely untouched', async () => {
    // Post a real, valid month first (period open).
    const first = await uploadMonth([['05/04/2071', 100, 0, 0, 0, 0, 0, 0, 100, 0]]);
    expect(first.status).toBe(200);
    let db = await getDb();
    const originalJe = db.journalEntries.find(j => j.ref === 'INCOME-2071-04');
    expect(originalJe).toBeTruthy();
    const originalSnapshot = JSON.parse(JSON.stringify(originalJe));

    // Lock the period after the fact (simulates a month-end close).
    const lockRes = await request(app).post('/api/period-lock').set(auth()).send({ period: '2071-04', locked: true });
    expect(lockRes.status).toBe(200);

    // A correction upload touching the SAME (now-locked) month must be
    // rejected — and must NOT touch the existing entry in the process.
    const correction = await uploadMonth([['06/04/2071', 50, 0, 0, 0, 0, 0, 0, 50, 0]]);
    expect(correction.status).toBe(409);
    expect(correction.body.code).toBe('PERIOD_LOCKED');

    db = await getDb();
    const afterJe = db.journalEntries.find(j => j.ref === 'INCOME-2071-04');
    expect(afterJe).toBeTruthy(); // still exists — this is the actual regression check
    expect(afterJe).toEqual(originalSnapshot); // byte-for-byte unchanged, not silently rebuilt/dropped
    // The corrective day must not have been merged into dailyData either —
    // the whole operation is rejected, not partially applied (this is the
    // second half of the fix: the dailyData merge itself is now deferred
    // until after every affected month's candidate journal entry validates).
    expect(db.dailyData.some(d => d.date === '2071-04-06')).toBe(false);
  });

  test('AdvFix B: an unrelated later request (different, open period) does not silently persist a corruption from the rejected upload', async () => {
    // Regression guard for the exact failure mode described in the finding:
    // trigger ANY other saveDB()-performing request in a DIFFERENT, open
    // period (2071-04 is deliberately still locked from Test A), then
    // confirm the month-04 entry is still present and unchanged afterward.
    const unrelated = await request(app).post('/api/expenses').set(auth()).send({
      desc: 'مصروف غير مرتبط', date: '2071-06-10', amount: 5, cat: 'أخرى', payMethod: 'cash',
    });
    expect(unrelated.status).toBe(200);
    const db = await getDb();
    expect(db.journalEntries.some(j => j.ref === 'INCOME-2071-04')).toBe(true);
  });

  test('AdvFix C: a normal (non-locked) correction to the same month still rebuilds correctly end-to-end', async () => {
    // Sanity check that the reordering didn't break the legitimate rebuild
    // path — unlock the period and confirm a correction now merges cleanly.
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2071-04', locked: false });
    const correction = await uploadMonth([['06/04/2071', 50, 0, 0, 0, 0, 0, 0, 50, 0]]);
    expect(correction.status).toBe(200);
    const db = await getDb();
    const je = db.journalEntries.find(j => j.ref === 'INCOME-2071-04');
    expect(je.totalDebit).toBeCloseTo(150, 3); // 100 (day 05) + 50 (day 06)
    expect(db.dailyData.some(d => d.date === '2071-04-06')).toBe(true);
  });
});

describe('R4 adversarial-review fix — accrued-expense PUT no longer allows amount/month/account mass-assignment', () => {
  test('AdvFix E: a direct PUT with amount/month/accountCode is silently ignored server-side — the GL and subledger stay in sync', async () => {
    const create = await request(app).post('/api/accrued-expenses').set(auth()).send({
      description: 'مصروف تحقق أمان التعديل', amount: 100, month: '2072-01', dueDate: '2072-01-15', vendor: 'Vendor-AdvFixE', accountCode: '5900',
    });
    expect(create.status).toBe(200);
    const item = create.body.item;

    // Bypass the UI entirely — send the fields editAccrued() disables.
    const tamper = await request(app).put(`/api/accrued-expenses/${item.id}`).set(auth()).send({
      description: 'وصف مُعدَّل بأمان', amount: 5000, month: '2072-02', accountCode: '5999', accountName: 'حساب آخر',
    });
    expect(tamper.status).toBe(200);

    const list = await request(app).get('/api/accrued-expenses').set(auth());
    const updated = list.body.accruedExpenses.find(a => a.id === item.id);
    expect(updated.description).toBe('وصف مُعدَّل بأمان'); // safe field — did apply
    expect(updated.amount).toBe(100);          // financial field — untouched
    expect(updated.month).toBe('2072-01');      // financial field — untouched
    expect(updated.accountCode).toBe('5900');   // financial field — untouched (R5: accountCode is now required+validated at create, so the stored value is the caller's original '5900', not the old implicit '2900' default)

    const db = await getDb();
    const je = db.journalEntries.find(j => j.id === item.jeId);
    expect(je.totalDebit).toBeCloseTo(100, 3); // the original accrual JE still matches the untouched subledger amount
  });
});
