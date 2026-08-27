// P0.6B — Remaining P0 Accounting Closure & Financial Lifecycle Integrity.
//
// Isolated, real-app tests (DB_FILE_ONLY, os.tmpdir()) via supertest against
// the real exported Express app — no production data, no real network calls
// (Telegram network is mocked). Covers: P6-017 (anomaly/Excel amounts),
// P6-027 (AP aging), P6-030 (doctor commission liability), P6-034 (EOS
// >5yr formula), P6-044 (unified period close), NEW-A (bank-recon
// checklist source), NEW-B (Telegram anomaly/chat-id dead-field fix).

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-6b-accounting-closure-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');
const XLSX    = require('xlsx');

jest.mock('node-telegram-bot-api', () => jest.fn().mockImplementation(() => ({
  on: jest.fn(),
  onText: jest.fn(),
  sendMessage: jest.fn().mockResolvedValue({}),
  getFileLink: jest.fn(),
  stopPolling: jest.fn().mockResolvedValue({}),
})));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p06b-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB, loadConfig, saveConfig } = require('../lib/database');
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
    journalMappings: [], doctorExpenses: [], lockedPeriods: {}, bankRecons: [], accountingSettings: {},
  };
}

function xlsxBuffer(rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
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

// ═══════════════════════════════════════════════════════════════════════
// PART A — P6-017: anomaly engine consumes real Excel-imported amounts
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6B — Anomaly A: Excel-imported journal amounts reach the anomaly engine (P6-017)', () => {
  test('Anomaly A: an Excel-imported expense (700, a round number) shows its real amount in GET /api/anomalies, not 0', async () => {
    const importRes = await request(app)
      .post('/api/import/expenses')
      .set(auth())
      .attach('file', xlsxBuffer([{
        'التاريخ': '2041-01-06',
        'الوصف': 'Anomaly A imported expense',
        'المبلغ (د.ك)': 700, // >=500 and %100===0 -> must trigger the ROUND_NUMBER rule
        'رقم حساب المدين': '5100',
        'رقم حساب الدائن': '1100',
      }]), 'expenses.xlsx');
    expect(importRes.status).toBe(200);
    expect(importRes.body.created).toBe(1);

    let storedJe;
    await runAsTenant('default', async () => {
      storedJe = loadDB().journalEntries.find(j => j.source === 'import-expenses' && j.date === '2041-01-06');
    });
    expect(storedJe).toBeTruthy();
    const jeId = storedJe.id;
    expect(storedJe.totalDebit).toBeCloseTo(700, 3); // FIXED: write-time totals now set explicitly

    const anomRes = await request(app).get('/api/anomalies').set(auth());
    expect(anomRes.status).toBe(200);
    const entry = anomRes.body.anomalies.find(a => a.je.id === jeId);
    expect(entry).toBeTruthy();
    expect(entry.je.totalDebit).toBeCloseTo(700, 3); // FIXED: was 0/undefined before P0.6B
    expect(entry.flags.some(f => f.code === 'ROUND_NUMBER')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART B — P6-027: AP Aging correctness (rebuilt on db.accruedExpenses[])
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6B — AP Aging: rebuilt on the real, GL-integrated accruedExpenses[] subledger (P6-027)', () => {
  test('AP A: an unpaid accrued liability is aged with its full original amount', async () => {
    const res = await request(app).post('/api/accrued-expenses').set(auth()).send({
      description: 'AP A unpaid', amount: 1000, month: '2042-06', dueDate: '2042-06-15', vendor: 'AP-Vendor-A', accountCode: '5900',
    });
    expect(res.status).toBe(200);

    const aging = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2042-06-20' });
    expect(aging.status).toBe(200);
    const row = aging.body.rows.find(r => r.vendor === 'AP-Vendor-A');
    expect(row).toBeTruthy();
    expect(row.total).toBeCloseTo(1000, 3);
  });

  test('AP B: a partially-paid liability ages only the outstanding remainder, not the original amount', async () => {
    const create = await request(app).post('/api/accrued-expenses').set(auth()).send({
      description: 'AP B partial', amount: 800, month: '2042-06', dueDate: '2042-06-15', vendor: 'AP-Vendor-B', accountCode: '5900',
    });
    expect(create.status).toBe(200);
    const id = create.body.item.id;

    const pay = await request(app).post(`/api/accrued-expenses/${id}/pay`).set(auth()).send({
      amount: 300, payDate: '2042-06-18', payAccount: '1100',
    });
    expect(pay.status).toBe(200);

    const aging = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2042-06-20' });
    const row = aging.body.rows.find(r => r.vendor === 'AP-Vendor-B');
    expect(row).toBeTruthy();
    expect(row.total).toBeCloseTo(500, 3); // 800 - 300, FIXED: never the original 800
    expect(row.items[0].outstanding).toBeCloseTo(500, 3);
    expect(row.items[0].paid).toBeCloseTo(300, 3);
  });

  test('AP C: a fully-paid liability is excluded from aging entirely', async () => {
    const create = await request(app).post('/api/accrued-expenses').set(auth()).send({
      description: 'AP C fully paid', amount: 400, month: '2042-06', dueDate: '2042-06-15', vendor: 'AP-Vendor-C', accountCode: '5900',
    });
    expect(create.status).toBe(200);
    const id = create.body.item.id;

    const pay = await request(app).post(`/api/accrued-expenses/${id}/pay`).set(auth()).send({
      amount: 400, payDate: '2042-06-18', payAccount: '1100',
    });
    expect(pay.status).toBe(200);
    expect(pay.body).toBeTruthy();

    const aging = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2042-06-20' });
    const row = aging.body.rows.find(r => r.vendor === 'AP-Vendor-C');
    expect(row).toBeUndefined(); // FIXED: previously every vendor-tagged item aged forever regardless of payment
  });

  test('AP D: aging bucket boundaries (Current / 1-30 / 31-60 / 61-90 / 90+) are computed correctly', async () => {
    const items = [
      { desc: 'AP D current', due: '2042-06-15', amount: 100 }, // 15 days before asOf -> current
      { desc: 'AP D 31-60',   due: '2042-05-15', amount: 200 }, // 46 days -> days30
      { desc: 'AP D 61-90',   due: '2042-04-15', amount: 300 }, // 76 days -> days60
      { desc: 'AP D 90+',     due: '2042-01-15', amount: 400 }, // 166 days -> over90
    ];
    for (const it of items) {
      const res = await request(app).post('/api/accrued-expenses').set(auth()).send({
        description: it.desc, amount: it.amount, month: it.due.slice(0, 7), dueDate: it.due, vendor: 'AP-Vendor-D', accountCode: '5900',
      });
      expect(res.status).toBe(200);
    }

    const aging = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2042-06-30' });
    const row = aging.body.rows.find(r => r.vendor === 'AP-Vendor-D');
    expect(row).toBeTruthy();
    expect(row.buckets.current).toBeCloseTo(100, 3);
    expect(row.buckets.days30).toBeCloseTo(200, 3);
    expect(row.buckets.days60).toBeCloseTo(300, 3);
    expect(row.buckets.over90).toBeCloseTo(400, 3);
    expect(row.total).toBeCloseTo(1000, 3);
  });

  test('AP E: the AP Aging subledger total reconciles exactly to the GL 2900 balance for clean accruedExpenses[]-only data', async () => {
    const aging = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2042-06-30' });
    expect(aging.status).toBe(200);
    expect(aging.body.reconciliation.reconciled).toBe(true);
    expect(aging.body.reconciliation.difference).toBeCloseTo(0, 3);
    expect(aging.body.reconciliation.subledgerTotal).toBeCloseTo(aging.body.reconciliation.glTotal, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART C — P6-030: doctor commission liability accounting
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6B — Doctor Liability: earned commission produces a traceable, idempotent GL liability (P6-030)', () => {
  beforeAll(async () => {
    const res = await request(app).post('/api/doctors').set(auth()).send({
      doctors: [
        { name: 'Dr-Liab-A', target: 0, commission: 30, lab: 0, insurance: 0 },
        { name: 'Dr-Liab-E', target: 0, commission: 25, lab: 0, insurance: 0 },
      ],
    });
    expect(res.status).toBe(200);
  });

  test('Doctor Liability A: an earned commission recognizes Dr Commission Expense / Cr Doctor Commission Payable exactly once', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.paymentsData.push({ id: 'PAY-DLA-1', doctor: 'Dr-Liab-A', date: '2043-01-15', total: 10000 });
      saveDB(db);
    });

    const recalc = await request(app).post('/api/config/recalc-commissions').set(auth());
    expect(recalc.status).toBe(200);

    let commRecord, recogJe;
    await runAsTenant('default', async () => {
      const db = loadDB();
      commRecord = db.commissionHistory.find(c => c.doctor === 'Dr-Liab-A' && c.month === '2043-01');
      recogJe = db.journalEntries.find(j => j.type === 'commission-recognition' && j.sourceId === commRecord.id);
    });
    expect(commRecord.commission).toBeCloseTo(3000, 3); // 30% of 10,000
    expect(commRecord.recognizedAmount).toBeCloseTo(3000, 3);
    expect(commRecord.recognitionJeIds.length).toBe(1);
    expect(recogJe).toBeTruthy();
    const drTot = recogJe.lines.reduce((s,l)=>s+(l.debit||0),0);
    const crTot = recogJe.lines.reduce((s,l)=>s+(l.credit||0),0);
    expect(drTot).toBeCloseTo(3000, 3);
    expect(crTot).toBeCloseTo(3000, 3);
    expect(recogJe.lines.some(l => l.accountCode === '5100' && l.debit === 3000)).toBe(true);
    expect(recogJe.lines.some(l => l.accountCode === '2800' && l.credit === 3000)).toBe(true);
  });

  test('Doctor Liability B: recalculating the SAME doctor+period+revenue again cannot duplicate the liability journal', async () => {
    const recalc2 = await request(app).post('/api/config/recalc-commissions').set(auth());
    expect(recalc2.status).toBe(200); // unchanged revenue -> delta 0 -> idempotent no-op

    let commRecord;
    await runAsTenant('default', async () => {
      commRecord = loadDB().commissionHistory.find(c => c.doctor === 'Dr-Liab-A' && c.month === '2043-01');
    });
    expect(commRecord.recognitionJeIds.length).toBe(1); // FIXED: still exactly one, not two
    expect(commRecord.recognizedAmount).toBeCloseTo(3000, 3);
  });

  test('Doctor Liability C: payment settles the payable (Dr 2800/Cr Cash) without re-posting the expense', async () => {
    let journalCountBefore;
    await runAsTenant('default', async () => { journalCountBefore = loadDB().journalEntries.length; });

    const pay = await request(app).post('/api/commission/pay').set(auth()).send({
      doctor: 'Dr-Liab-A', month: '2043-01', payMethod: 'نقد', payDate: '2043-01-25',
    });
    expect(pay.status).toBe(200);

    let journalCountAfter, payJe, commRecord;
    await runAsTenant('default', async () => {
      const db = loadDB();
      journalCountAfter = db.journalEntries.length;
      commRecord = db.commissionHistory.find(c => c.doctor === 'Dr-Liab-A' && c.month === '2043-01');
      payJe = db.journalEntries.find(j => j.id === commRecord.paymentJeId);
    });
    expect(journalCountAfter).toBe(journalCountBefore + 1); // exactly one new JE (the payment) — no fresh recognition, no re-expense
    expect(commRecord.paid).toBe(true);
    expect(payJe).toBeTruthy();
    expect(payJe.lines.some(l => l.accountCode === '2800' && l.debit === 3000)).toBe(true); // settles the payable
    expect(payJe.lines.some(l => l.accountCode === '1100' && l.credit === 3000)).toBe(true); // cash out
    expect(payJe.lines.some(l => l.accountCode === '5100')).toBe(false); // FIXED: no second expense line at payment

    // Historical paid-commission protection (P0.6A) remains intact: a later
    // recalc with new revenue for the SAME already-paid month must not touch it.
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.paymentsData.push({ id: 'PAY-DLA-2', doctor: 'Dr-Liab-A', date: '2043-01-28', total: 5000 });
      saveDB(db);
    });
    const recalc3 = await request(app).post('/api/config/recalc-commissions').set(auth());
    expect(recalc3.status).toBe(200);
    expect(recalc3.body.skippedPaid).toBeGreaterThanOrEqual(1);
    let commAfter;
    await runAsTenant('default', async () => {
      commAfter = loadDB().commissionHistory.find(c => c.doctor === 'Dr-Liab-A' && c.month === '2043-01');
    });
    expect(commAfter.commission).toBeCloseTo(3000, 3); // unchanged
    expect(commAfter.recognizedAmount).toBeCloseTo(3000, 3); // unchanged
  });

  test('Doctor Liability D: the doctor-commission subledger reconciles exactly to the GL 2800 balance', async () => {
    const recon = await request(app).get('/api/doctors/commission-reconciliation').set(auth()).query({ asOf: '2043-02-01' });
    expect(recon.status).toBe(200);
    expect(recon.body.reconciled).toBe(true);
    expect(recon.body.difference).toBeCloseTo(0, 3);
    // Dr-Liab-A is now paid (excluded from outstanding); glTotal should also
    // reflect that (2800 nets to 0 for that doctor: 3000 credit - 3000 debit).
    expect(recon.body.subledgerTotal).toBeCloseTo(recon.body.glTotal, 3);
  });

  test('Doctor Liability E: recognition/payment are rejected once the affected period is locked', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.paymentsData.push({ id: 'PAY-DLE-1', doctor: 'Dr-Liab-E', date: '2043-03-10', total: 4000 });
      saveDB(db);
    });
    const recalc = await request(app).post('/api/config/recalc-commissions').set(auth());
    expect(recalc.status).toBe(200);
    let commRecord;
    await runAsTenant('default', async () => {
      commRecord = loadDB().commissionHistory.find(c => c.doctor === 'Dr-Liab-E' && c.month === '2043-03');
    });
    expect(commRecord.recognizedAmount).toBeCloseTo(1000, 3); // 25% of 4000, recognized while the period was still open

    const lockRes = await request(app).post('/api/period-lock').set(auth()).send({ period: '2043-03', locked: true });
    expect(lockRes.status).toBe(200);

    const pay = await request(app).post('/api/commission/pay').set(auth()).send({
      doctor: 'Dr-Liab-E', month: '2043-03', payMethod: 'نقد', payDate: '2043-03-20',
    });
    expect(pay.status).toBe(403); // FIXED: no financial write may post into a locked period
    expect(pay.body.code).toBe('PERIOD_LOCKED');

    let commAfter;
    await runAsTenant('default', async () => {
      commAfter = loadDB().commissionHistory.find(c => c.doctor === 'Dr-Liab-E' && c.month === '2043-03');
    });
    expect(commAfter.paid).toBe(false); // rejected atomically — nothing changed
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART D — P6-034: EOS canonical formula correctness
// ═══════════════════════════════════════════════════════════════════════
function yearsAgoISO(years, months = 0) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

describe('P0.6B — EOS: one canonical formula, >5-year overstatement corrected (P6-034)', () => {
  test('EOS A: the 15-day/30-day rate switches on the correct side of the 5-year boundary', async () => {
    const empBelow = await request(app).post('/api/employees').set(auth()).send({
      name: 'EOS-A-below', basicSalary: 900, hireDate: yearsAgoISO(4, 11), // 4y11m — must still use the 15-day rate
    });
    expect(empBelow.status).toBe(200);
    const empAt = await request(app).post('/api/employees').set(auth()).send({
      name: 'EOS-A-at', basicSalary: 900, hireDate: yearsAgoISO(5, 1), // just past 5y — must use the 30-day rate
    });
    expect(empAt.status).toBe(200);

    const run = await request(app).post('/api/payroll/eos-run').set(auth()).send({ month: '2044-01' });
    expect(run.status).toBe(200);
    const below = run.body.details.find(d => d.name === 'EOS-A-below');
    const at     = run.body.details.find(d => d.name === 'EOS-A-at');
    expect(below.monthly).toBeCloseTo(900 / 30 * 15 / 12, 3); // 15-day annual rate
    expect(at.monthly).toBeCloseTo(900 / 30 * 30 / 12, 3);    // 30-day annual rate — switched
  });

  test('EOS B: the >5-year accumulated formula matches the gap register\'s own proven worked example (basic 1,000, 8 years -> 5,500, never 8,000)', async () => {
    const emp = await request(app).post('/api/employees').set(auth()).send({
      name: 'EOS-B-eight-years', basicSalary: 1000, hireDate: yearsAgoISO(8),
    });
    expect(emp.status).toBe(200);

    const run = await request(app).post('/api/payroll/eos-run').set(auth()).send({ month: '2044-02' });
    expect(run.status).toBe(200);
    const rec = run.body.details.find(d => d.name === 'EOS-B-eight-years');
    expect(rec).toBeTruthy();
    // Independent verification using the server's OWN reported `years` —
    // note `years` in the response is itself rounded to 2dp for display
    // (calcEosForEmployee's own `parseFloat(years.toFixed(2))`), while
    // `accumulated` was computed server-side from the FULL-precision value,
    // so a few KD of rounding-propagation difference is expected here, not
    // a defect — bounded generously below.
    const expected = 1000 / 30 * 15 * Math.min(rec.years, 5) + (rec.years > 5 ? 1000 * (rec.years - 5) : 0);
    expect(Math.abs(rec.accumulated - expected)).toBeLessThan(5);
    // FIXED: 1000/30*15*5 + 1000*3 ≈ 5,500 — was 8,000 (1000/30*30*5+1000*3) before P0.6B.
    expect(rec.accumulated).toBeCloseTo(5500, -1); // within 50 KD of the proven worked example
    expect(Math.abs(rec.accumulated - 8000)).toBeGreaterThan(2000); // unambiguously NOT the old buggy value
  });

  test('EOS C: a partial-year (6-month) employee accrues a small positive monthly amount, no negative/undefined result', async () => {
    const emp = await request(app).post('/api/employees').set(auth()).send({
      name: 'EOS-C-partial', basicSalary: 600, hireDate: yearsAgoISO(0, 6),
    });
    expect(emp.status).toBe(200);

    const run = await request(app).post('/api/payroll/eos-run').set(auth()).send({ month: '2044-03' });
    expect(run.status).toBe(200);
    const rec = run.body.details.find(d => d.name === 'EOS-C-partial');
    expect(rec).toBeTruthy();
    expect(rec.monthly).toBeCloseTo(600 / 30 * 15 / 12, 3);
    expect(rec.monthly).toBeGreaterThan(0);
    expect(rec.accumulated).toBeGreaterThan(0);
    expect(rec.accumulated).toBeLessThan(600); // well under a full year's worth
  });

  test('EOS D: /api/close/run-all\'s EOS accrual step uses the exact same canonical calcEosForEmployee() output', async () => {
    const emp = await request(app).post('/api/employees').set(auth()).send({
      name: 'EOS-D-close', basicSalary: 1200, hireDate: yearsAgoISO(3),
    });
    expect(emp.status).toBe(200);

    const close = await request(app).post('/api/close/run-all').set(auth()).send({
      month: '2044-04', options: { depreciation: false, pifss: false, eos: true, closing: false, lock: false, confirmEmptyClose: true },
    });
    expect(close.status).toBe(200);

    // Independent verification: /api/close/run-all's EOS step sums
    // calcEosForEmployee(e).monthly across EVERY employee currently in
    // db.employees — including EOS-A/B/C's own fixtures from earlier tests
    // in this describe block, not just the one just created here. Recompute
    // that same sum independently from the real employee list, applying the
    // exact same formula calcEosForEmployee() uses (server.js) — rather
    // than assuming this test's employee is the only one present.
    const empsRes = await request(app).get('/api/employees').set(auth());
    expect(empsRes.status).toBe(200);
    let expectedTotal = empsRes.body.reduce((s, e) => {
      if (!e.hireDate) return s;
      const years = Math.max(0, (Date.now() - new Date(e.hireDate)) / (365.25 * 864e5));
      const basic = parseFloat(e.basicSalary) || 0;
      const annualDays = years <= 5 ? 15 : 30;
      return s + (basic / 30 * annualDays / 12);
    }, 0);
    expectedTotal = parseFloat(expectedTotal.toFixed(3));

    let eosJe;
    await runAsTenant('default', async () => {
      eosJe = loadDB().journalEntries.find(j => j.ref === 'EOS-2044-04');
    });
    expect(eosJe).toBeTruthy();
    expect(eosJe.totalDebit).toBeCloseTo(expectedTotal, 2);
  });

  test('EOS E: running month-close twice for the same period cannot duplicate the EOS accrual journal', async () => {
    let countBefore;
    await runAsTenant('default', async () => { countBefore = loadDB().journalEntries.filter(j => j.ref === 'EOS-2044-04').length; });
    expect(countBefore).toBe(1);

    const close2 = await request(app).post('/api/close/run-all').set(auth()).send({
      month: '2044-04', options: { depreciation: false, pifss: false, eos: true, closing: false, lock: false },
    });
    expect(close2.status).toBe(200);
    expect(close2.body.log.find(s => s.id === 'eos').status).toBe('skipped');

    let countAfter;
    await runAsTenant('default', async () => { countAfter = loadDB().journalEntries.filter(j => j.ref === 'EOS-2044-04').length; });
    expect(countAfter).toBe(1); // FIXED-behavior-confirmed: still exactly one, never duplicated
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART E — P6-044: one canonical period-close workflow
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6B — Close: both entry points share ONE canonical closing computation, no destructive overwrite (P6-044)', () => {
  test('Close A: /api/closing-entry and /api/close/run-all\'s closing step recognize the SAME ref and never double-post', async () => {
    await request(app).post('/api/journal').set(auth()).send({
      date: '2045-01-05', desc: 'Close A revenue',
      lines: [{ accountCode: '1100', debit: 900, credit: 0 }, { accountCode: '4100', debit: 0, credit: 900 }],
    }).expect(200);
    await request(app).post('/api/journal').set(auth()).send({
      date: '2045-01-10', desc: 'Close A expense',
      lines: [{ accountCode: '5100', debit: 300, credit: 0 }, { accountCode: '1100', debit: 0, credit: 300 }],
    }).expect(200);

    const legacy = await request(app).post('/api/closing-entry').set(auth()).send({ year: 2045, month: 1 });
    expect(legacy.status).toBe(200);
    expect(legacy.body.netResult).toBeCloseTo(600, 3);
    // FIXED: closes to 3300 now (the canonical account), never the old 3200.
    expect(legacy.body.entry.lines.some(l => l.accountCode === '3300')).toBe(true);
    expect(legacy.body.entry.lines.some(l => l.accountCode === '3200')).toBe(false);

    let closeCountAfterLegacy;
    await runAsTenant('default', async () => {
      closeCountAfterLegacy = loadDB().journalEntries.filter(j => j.ref === 'CLOSE-2045-01').length;
    });
    expect(closeCountAfterLegacy).toBe(1);

    // /api/close/run-all's own closing step recognizes the SAME ref the
    // legacy route just posted under — same canonical service, so it
    // reports "skipped", never a second competing closing entry.
    const runAll = await request(app).post('/api/close/run-all').set(auth()).send({
      month: '2045-01', options: { depreciation: false, pifss: false, eos: false, closing: true, lock: false },
    });
    expect(runAll.status).toBe(200);
    expect(runAll.body.log.find(s => s.id === 'closing').status).toBe('skipped');

    let closeCountFinal;
    await runAsTenant('default', async () => {
      closeCountFinal = loadDB().journalEntries.filter(j => j.ref === 'CLOSE-2045-01').length;
    });
    expect(closeCountFinal).toBe(1); // FIXED: never a second, competing closing entry
  });

  test('Close B: calling /api/closing-entry twice for the same period is rejected, not silently overwritten', async () => {
    const second = await request(app).post('/api/closing-entry').set(auth()).send({ year: 2045, month: 1 });
    expect(second.status).toBe(409); // FIXED: previously deleted the existing entry and tried to replace it, unguarded
    expect(second.body.code).toBe('ALREADY_CLOSED');

    let closeCount;
    await runAsTenant('default', async () => {
      closeCount = loadDB().journalEntries.filter(j => j.ref === 'CLOSE-2045-01').length;
    });
    expect(closeCount).toBe(1); // the original close survives untouched
  });

  test('Close C: the EOS step\'s own accrual (posted earlier in the SAME run) is correctly picked up by the closing step, with no cross-step corruption', async () => {
    const emp = await request(app).post('/api/employees').set(auth()).send({
      name: 'Close-C-employee', basicSalary: 900, hireDate: yearsAgoISO(2),
    });
    expect(emp.status).toBe(200);

    // The EOS step sums calcEosForEmployee(e).monthly across EVERY employee
    // currently in db.employees (by this point in the file: all of EOS
    // A-D's fixtures too, not just this one) — compute the true expected
    // total independently from the real employee list, exactly as EOS D does.
    const empsRes = await request(app).get('/api/employees').set(auth());
    expect(empsRes.status).toBe(200);
    let expectedMonthlyEos = empsRes.body.reduce((s, e) => {
      if (!e.hireDate) return s;
      const years = Math.max(0, (Date.now() - new Date(e.hireDate)) / (365.25 * 864e5));
      const basic = parseFloat(e.basicSalary) || 0;
      const annualDays = years <= 5 ? 15 : 30;
      return s + (basic / 30 * annualDays / 12);
    }, 0);
    expectedMonthlyEos = parseFloat(expectedMonthlyEos.toFixed(3)); // no revenue this month, so this is also the period's net loss

    // No revenue/expense journal seeded for 2045-02 — the ONLY P&L activity
    // this month is the EOS accrual the EOS step (STEP 3) posts earlier in
    // this exact same request, before the closing step (STEP 4) runs.
    const run = await request(app).post('/api/close/run-all').set(auth()).send({
      month: '2045-02', options: { depreciation: false, pifss: false, eos: true, closing: true, lock: false, confirmEmptyClose: true },
    });
    expect(run.status).toBe(200);
    expect(run.body.log.find(s => s.id === 'eos').status).toBe('done');
    // FIXED premise: the closing step correctly finds real P&L to close
    // (the EOS expense itself) — proving proper same-run sequencing, not a
    // "nothing to close" skip.
    expect(run.body.log.find(s => s.id === 'closing').status).toBe('done');

    let eosJe, closeJe;
    await runAsTenant('default', async () => {
      const db = loadDB();
      eosJe   = db.journalEntries.find(j => j.ref === 'EOS-2045-02');
      closeJe = db.journalEntries.find(j => j.ref === 'CLOSE-2045-02');
    });
    expect(eosJe).toBeTruthy();
    expect(eosJe.totalDebit).toBeCloseTo(expectedMonthlyEos, 3);
    const eosDr = eosJe.lines.reduce((s,l)=>s+(l.debit||0),0);
    const eosCr = eosJe.lines.reduce((s,l)=>s+(l.credit||0),0);
    expect(Math.abs(eosDr - eosCr)).toBeLessThan(0.005); // EOS step itself balanced, not a partial post

    expect(closeJe).toBeTruthy();
    // Net result = a loss (pure EOS expense, no revenue this month) -> 3300 debited.
    const line5140 = closeJe.lines.find(l => l.accountCode === '5140');
    const line3300 = closeJe.lines.find(l => l.accountCode === '3300');
    expect(line5140).toBeTruthy(); // closes out the EOS expense
    expect(line5140.credit).toBeCloseTo(expectedMonthlyEos, 2);
    expect(line3300).toBeTruthy(); // transfers the loss
    expect(line3300.debit).toBeCloseTo(expectedMonthlyEos, 2);
    const closeDr = closeJe.lines.reduce((s,l)=>s+(l.debit||0),0);
    const closeCr = closeJe.lines.reduce((s,l)=>s+(l.credit||0),0);
    expect(Math.abs(closeDr - closeCr)).toBeLessThan(0.005); // closing entry itself balanced — no corruption from the EOS step
  });

  test('Close D: the unified /api/close/run-all remains durable-before-ack after the closing-step refactor', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fs.removeSync(tmp);
      fs.writeFileSync(tmp, 'not-a-directory-anymore');
      try {
        const res = await request(app).post('/api/close/run-all').set(auth()).send({ month: '2045-03', options: { confirmEmptyClose: true } });
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
      } finally {
        fs.removeSync(tmp);
        fs.ensureDirSync(tmp);
      }
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART F/G — NEW-A (bank-recon checklist) / NEW-B (Telegram dead fields)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6B — Checklist A: month-close checklist reads the authoritative db.bankRecons (NEW-A / P6-069)', () => {
  test('Checklist A: a bank reconciliation seeded for the target period is counted; a different period is not', async () => {
    const save = await request(app).post('/api/bank-recon').set(auth()).send({
      account: '1110', period: '2046-05',
      bankStatementLines: [{ date: '2046-05-05', desc: 'Checklist A line', amount: 10 }],
      matchedLines: [], bankEndBalance: 10, notes: 'Checklist A',
    });
    expect(save.status).toBe(200);

    const checklistMay = await request(app).get('/api/month-close/2046-05').set(auth());
    expect(checklistMay.status).toBe(200);
    const bankStepMay = checklistMay.body.steps.find(s => s.id === 'bank_recon');
    expect(bankStepMay.auto).toBe(true); // FIXED: previously always false/0 regardless of real data
    expect(bankStepMay.count).toBe('1 تسوية');

    const checklistJune = await request(app).get('/api/month-close/2046-06').set(auth());
    const bankStepJune = checklistJune.body.steps.find(s => s.id === 'bank_recon');
    expect(bankStepJune.auto).toBe(false); // a different period must not count it
    expect(bankStepJune.count).toBe('0 تسوية');
  });
});

describe('P0.6B — Telegram: daily-summary anomaly count and recipient targeting use authoritative sources (NEW-B / P6-070)', () => {
  test('Telegram A: the scheduled daily-summary report includes a real, non-zero anomaly count', async () => {
    // Seed a real anomaly: a round-number (>=500, %100===0) journal entry.
    await request(app).post('/api/journal').set(auth()).send({
      date: '2046-07-10', desc: 'Telegram A anomaly seed',
      lines: [{ accountCode: '1100', debit: 800, credit: 0 }, { accountCode: '4100', debit: 0, credit: 800 }],
    }).expect(200);

    saveConfig({ ...loadConfig(), telegramChatIds: ['111111'] });

    const TelegramBotMock = require('node-telegram-bot-api');
    TelegramBotMock.mockClear();
    const start = await request(app).post('/api/telegram/start').set(auth()).send({ token: 'fake-telegram-a-token' });
    expect(start.status).toBe(200);
    const botInstance = TelegramBotMock.mock.results[TelegramBotMock.mock.results.length - 1].value;

    const send = await request(app).post('/api/reports/send-telegram').set(auth());
    expect(send.status).toBe(200);
    expect(send.body.sent).toBeGreaterThanOrEqual(1);

    const call = botInstance.sendMessage.mock.calls.find(c => c[0] === '111111');
    expect(call).toBeTruthy();
    // FIXED: previously always read the dead db.anomalies (always []), so
    // this line never appeared even with real, active anomalies.
    expect(call[1]).toMatch(/⚠️ شذوذات: [1-9]/);
  });

  test('Telegram B: proactive monitoring reports (monthly report) send to the canonical cfg.telegramChatIds recipients, never the dead db.telegramChatId', async () => {
    saveConfig({ ...loadConfig(), telegramChatIds: ['222222', '333333'] });
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.telegramChatId = 'DEAD-VALUE-SHOULD-NEVER-BE-USED';
      saveDB(db);
    });

    const TelegramBotMock = require('node-telegram-bot-api');
    TelegramBotMock.mockClear();
    const start = await request(app).post('/api/telegram/start').set(auth()).send({ token: 'fake-telegram-b-token' });
    expect(start.status).toBe(200);
    const botInstance = TelegramBotMock.mock.results[TelegramBotMock.mock.results.length - 1].value;

    const run = await request(app).post('/api/monitor/monthly-report').set(auth());
    expect(run.status).toBe(200);

    const calledIds = botInstance.sendMessage.mock.calls.map(c => c[0]);
    expect(calledIds).toContain('222222'); // FIXED: both configured recipients reached
    expect(calledIds).toContain('333333');
    expect(calledIds).not.toContain('DEAD-VALUE-SHOULD-NEVER-BE-USED');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART H — financial traceability
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6B — Traceability A: new doctor/EOS journals carry real source metadata', () => {
  test('Traceability A: a doctor-commission recognition journal and an EOS accrual journal are both source-traceable', async () => {
    let recogJe, eosJe;
    await runAsTenant('default', async () => {
      const db = loadDB();
      recogJe = db.journalEntries.find(j => j.type === 'commission-recognition');
      eosJe   = db.journalEntries.find(j => j.type === 'end_of_service' && j.ref === 'EOS-2044-04');
    });
    expect(recogJe).toBeTruthy();
    expect(recogJe.source).toBe('doctor-commission');
    expect(recogJe.sourceId).toBeTruthy();
    expect(recogJe.ref).toMatch(/^COMM-RECOG-/);
    expect(recogJe.desc).toContain('استحقاق عمولة');

    expect(eosJe).toBeTruthy();
    expect(eosJe.ref).toBe('EOS-2044-04');
    expect(eosJe.type).toBe('end_of_service');
    expect(eosJe.desc).toContain('2044-04');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART I / REGRESSION — P0.6A's independent TB/IS/BS/CF scenario
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6B — Regression A: the P0.6A independently-verified worked example remains correct', () => {
  test('Regression A: opening + revenue + expense + asset + depreciation reconciles across TB/IS/BS/CF exactly as in P0.6A', async () => {
    // P0.6A's own BS B established: this route's Balance Sheet is
    // intentionally ALL-TIME-cumulative, and this test file shares one
    // tenant across every describe block above — capture a BEFORE snapshot
    // and compare the DELTA (immune to whatever cumulative history already
    // exists), exactly like the corrected P0.6A BS B test.
    const before = await request(app).get('/api/financial-statements?period=month&year=2047&month=1').set(auth());
    const bsBefore = before.body.balanceSheet;

    await request(app).post('/api/opening-balance').set(auth()).send({
      date: '2047-01-01', balances: [{ code: '1100', debit: 2000, credit: 0 }, { code: '3100', debit: 0, credit: 2000 }],
    }).expect(200);
    await request(app).post('/api/journal').set(auth()).send({
      date: '2047-01-10', desc: 'Regression A revenue',
      lines: [{ accountCode: '1100', debit: 800, credit: 0 }, { accountCode: '4100', debit: 0, credit: 800 }],
    }).expect(200);
    await request(app).post('/api/journal').set(auth()).send({
      date: '2047-01-15', desc: 'Regression A expense',
      lines: [{ accountCode: '5100', debit: 300, credit: 0 }, { accountCode: '1100', debit: 0, credit: 300 }],
    }).expect(200);
    await request(app).post('/api/assets').set(auth()).send({
      name: 'Regression A asset', category: 'equipment', purchaseDate: '2047-01-01',
      cost: 1200, usefulLife: 1, salvageValue: 0, payMethod: 'cash', coaAccount: '1510',
    }).expect(200);
    const dep = await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2047-01' });
    expect(dep.status).toBe(200);
    expect(dep.body.totalDep).toBeCloseTo(100, 3);

    const tb = await request(app).get('/api/trial-balance?period=all').set(auth());
    // Isolated to this describe block's own year (2047) via distinct dates
    // above, but the shared tenant carries prior tests' history too — check
    // internal balance, not an absolute total (same discipline as P0.6A's
    // corrected BS B).
    expect(tb.body.isBalanced).toBe(true);

    const fsRes = await request(app).get('/api/financial-statements?period=month&year=2047&month=1').set(auth());
    expect(fsRes.status).toBe(200);
    const is = fsRes.body.incomeStatement, bs = fsRes.body.balanceSheet, cf = fsRes.body.cashFlow;
    expect(is.revenue.total).toBeCloseTo(800, 3);
    expect(is.operatingExpenses.total).toBeCloseTo(300, 3);
    expect(is.depreciation).toBeCloseTo(100, 3);
    expect(is.netProfit).toBeCloseTo(400, 3); // FIXED in P0.6A, still correct: depreciation deducted exactly once

    // Delta check (see comment above): this test's own postings move both
    // sides of the accounting equation by the identical amount (2,400 —
    // cash +1,300, fixed assets net +1,100 vs paid-in-capital +2,000 and
    // current-period net income +400), regardless of the shared ledger's
    // pre-existing cumulative state.
    const assetsDelta = bs.assets.total - bsBefore.assets.total;
    const liabEquityDelta = bs.totalLiabAndEquity - bsBefore.totalLiabAndEquity;
    expect(assetsDelta).toBeCloseTo(2400, 3);
    expect(liabEquityDelta).toBeCloseTo(2400, 3);
    expect(assetsDelta).toBeCloseTo(liabEquityDelta, 3); // still reconciles — P0.6A's own invariant holds

    expect(cf.operating + cf.investing + cf.financing).toBeCloseTo(cf.netChange, 3);
  });
});
