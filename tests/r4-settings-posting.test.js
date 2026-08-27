// R4 — Part N: settings → posting verification. Maps the accounting-related
// config fields that the daily-income posting math actually reads
// (processDailyIncomeUpload, server.js ~1452-1458: insDeductionRate,
// feeKnet, feeCard) and proves changing them through PUT /api/config
// changes the amounts on the NEXT posted journal entry — not just that the
// fields are read, but that a real config change produces a real,
// different, correctly-computed financial posting.
//
// While building this test it was discovered that PUT /api/config had NO
// write path at all for these fields (its merge whitelist only covered
// brand/modules/labels/nav/commissionFormula/dashboard/importTemplates/
// automation) — R1/R3 had only flagged "no UI" for these settings, but the
// backend route to change them didn't exist either. Fixed as a small,
// additive, same-pattern scalar-merge addition (server.js, PUT /api/config)
// with no change to the calculation logic or its defaults when unset — see
// the code comment there for the exact rationale.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'r4-settings-posting-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');
const XLSX    = require('xlsx');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-r4-settings-'));
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
  // The route detects the dailyincome branch purely from the filename
  // containing "dailyincome" (server.js: fileName.includes('dailyincome')) —
  // any other name silently uploads with zero rows parsed and still
  // returns 200, which is exactly the kind of dead-end "success" response
  // Part H/E care about; named correctly here so this test exercises the
  // real posting path instead of a silent no-op.
  const r = await request(app).post('/api/upload').set(auth()).attach('file', buf, 'DailyIncome.xlsx');
  expect(r.status).toBe(200);
}

async function getJe(ref) {
  let db; await runAsTenant('default', async () => { db = loadDB(); });
  return db.journalEntries.find(j => j.ref === ref);
}

function lineByCode(je, code) { return (je.lines || []).find(l => l.accountCode === code); }

describe('R4 Part N — settings changes flow through to real journal-entry postings', () => {
  test('Settings A: PUT /api/config now persists feeKnet/feeCard/insDeductionRate/hesabiStartMonth (previously silently dropped)', async () => {
    const r = await request(app).put('/api/config').set(auth()).send({ feeKnet: 0.02, feeCard: 0.03, insDeductionRate: 0.2, hesabiStartMonth: '2020-01' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const g = await request(app).get('/api/config').set(auth());
    expect(g.body.feeKnet).toBeCloseTo(0.02, 5);
    expect(g.body.feeCard).toBeCloseTo(0.03, 5);
    expect(g.body.insDeductionRate).toBeCloseTo(0.2, 5);
    expect(g.body.hesabiStartMonth).toBe('2020-01');
  });

  test('Settings B: a 2% K-Net fee posts a 2%-of-gross fee line and (gross - fee) net to the clearing account', async () => {
    await request(app).put('/api/config').set(auth()).send({ feeKnet: 0.02 });
    await uploadMonth([['05/01/2031', 0, 1000, 0, 0, 0, 0, 0, 1000, 0]]);
    const je = await getJe('INCOME-2031-01');
    expect(je).toBeTruthy();
    const fee = lineByCode(je, '5750');
    const clearing = lineByCode(je, '1125');
    expect(fee.debit).toBeCloseTo(1000 * 0.02, 3);
    expect(clearing.debit).toBeCloseTo(1000 - 1000 * 0.02, 3);
  });

  test('Settings C: changing feeKnet to 5% and posting a NEW month reflects the new rate, not the old one', async () => {
    await request(app).put('/api/config').set(auth()).send({ feeKnet: 0.05 });
    await uploadMonth([['06/02/2031', 0, 1000, 0, 0, 0, 0, 0, 1000, 0]]);
    const je = await getJe('INCOME-2031-02');
    expect(je).toBeTruthy();
    const fee = lineByCode(je, '5750');
    const clearing = lineByCode(je, '1125');
    expect(fee.debit).toBeCloseTo(1000 * 0.05, 3);       // 50, not the old 2%'s 20
    expect(clearing.debit).toBeCloseTo(1000 - 1000 * 0.05, 3);
  });

  test('Settings D: the ORIGINAL month (Settings B) is unaffected by the later rate change — settings apply forward, not retroactively rewriting old months on their own', async () => {
    // Re-reading month 2031-01 without re-uploading it must still show the 2%
    // fee it was posted with — proves the settings change in Test C only
    // affected the month it was applied to (2031-02), not silently mutating
    // every existing journal entry in the database.
    const je = await getJe('INCOME-2031-01');
    const fee = lineByCode(je, '5750');
    expect(fee.debit).toBeCloseTo(1000 * 0.02, 3);
  });

  test('Settings E: a higher insurance-deduction rate increases the back-calculated gross and the deduction-expense line for the same net insurance value', async () => {
    await request(app).put('/api/config').set(auth()).send({ insDeductionRate: 0.25 });
    await uploadMonth([['10/03/2031', 0, 0, 0, 0, 750, 0, 0, 750, 0]]);
    const je = await getJe('INCOME-2031-03');
    expect(je).toBeTruthy();
    const insNet = lineByCode(je, '1130');
    const insDeduction = lineByCode(je, '5760');
    // net(750) = gross * (1 - 0.25) -> gross = 1000, deduction = 250
    expect(insNet.debit).toBeCloseTo(750, 3);
    expect(insDeduction.debit).toBeCloseTo(250, 3);
  });
});
