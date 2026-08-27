// R3 — Final Go-Live Blocker Closure.
//
// Isolated, real-app tests (DB_FILE_ONLY, os.tmpdir()) via supertest against
// the real exported Express app — no production data, no real network.
// Covers: P6-065 (insurance claim cancellation preserves journal history),
// P6-028 (cumulative Excel import never silently drops prior days from the
// auto-income journal), P6-036 (payroll accrual duplicate guard, independent
// of idempotency key), P6-023 (accrued-expense over-settlement guard).
// NEW-R1-SEC-01/SEC-02 are covered in tests/production-hardening.test.js
// (Secrets C-H, Telegram A-C).

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'r3-go-live-blockers-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');
const XLSX    = require('xlsx');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-r3-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [
      { id: 'usr-admin', username: 'admin', email: 'admin@test.com', passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير', active: true, createdAt: new Date().toISOString(), lastLogin: null },
      { id: 'usr-recep', username: 'receptionist1', email: 'r@test.com', passwordHash: hash('RecepPass1!'), role: 'receptionist', fullName: 'استقبال', active: true, createdAt: new Date().toISOString(), lastLogin: null },
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

let adminToken, recepToken;

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
  const login2 = await request(app).post('/api/auth/login').send({ username: 'receptionist1', password: 'RecepPass1!' });
  recepToken = login2.body.token;
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

// ═══════════════════════════════════════════════════════════════════════
// P6-065 — Insurance claim cancellation (no orphaned journal entries)
// ═══════════════════════════════════════════════════════════════════════
describe('R3 — P6-065: insurance claim deletion never orphans a journal entry', () => {
  async function createClaim(company, amount, claimDate) {
    const res = await request(app).post('/api/insurance-claims').set(auth()).send({ company, claimDate, amount });
    expect(res.status).toBe(200);
    return res.body.claim;
  }

  test('P6065 A: creating a claim posts a recognition JE and stores its id on the claim', async () => {
    const claim = await createClaim('Ins-A', 500, '2051-01-05');
    expect(claim.journalId).toBe('JE-' + claim.claimNo);
    let je; await runAsTenant('default', async () => { je = loadDB().journalEntries.find(j => j.id === claim.journalId); });
    expect(je).toBeTruthy();
    expect(je.lines.some(l => l.accountCode === '1130' && l.debit === 500)).toBe(true);
  });

  test('P6065 B: DELETE on an unpaid claim posts a reversal JE, preserves the original, sets status cancelled — never deletes the claim record', async () => {
    const claim = await createClaim('Ins-B', 300, '2051-01-06');
    const res = await request(app).delete(`/api/insurance-claims/${claim.id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.claim.status).toBe('cancelled');
    expect(res.body.reversalJournalIds.length).toBe(1);

    let db; await runAsTenant('default', async () => { db = loadDB(); });
    const stillThere = db.insuranceClaims.find(c => c.id === claim.id);
    expect(stillThere).toBeTruthy(); // never physically removed
    expect(stillThere.status).toBe('cancelled');
    const originalJe = db.journalEntries.find(j => j.id === claim.journalId);
    expect(originalJe).toBeTruthy(); // original recognition JE untouched
    const revJe = db.journalEntries.find(j => j.id === res.body.reversalJournalIds[0]);
    expect(revJe).toBeTruthy();
    expect(revJe.lines.find(l => l.accountCode === '1130').credit).toBe(300); // flipped from the original debit
    expect(revJe.lines.find(l => l.accountCode === '4150').debit).toBe(300);
  });

  test('P6065 C: cancelling an already-cancelled claim is rejected (repeated cancellation handled safely, no duplicate reversal)', async () => {
    const claim = await createClaim('Ins-C', 150, '2051-01-07');
    await request(app).delete(`/api/insurance-claims/${claim.id}`).set(auth()).expect(200);
    const second = await request(app).delete(`/api/insurance-claims/${claim.id}`).set(auth());
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_CANCELLED');
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    const revJes = db.journalEntries.filter(j => j.ref === 'REV-' + claim.journalId);
    expect(revJes.length).toBe(1); // exactly one reversal, not two
  });

  test('P6065 D: cancelling a RECEIVED claim reverses BOTH the recognition JE and the receipt JE', async () => {
    const claim = await createClaim('Ins-D', 400, '2051-01-08');
    const recv = await request(app).put(`/api/insurance-claims/${claim.id}`).set(auth()).send({ status: 'received', receivedDate: '2051-01-20', receivedAmount: 400 });
    expect(recv.status).toBe(200);
    expect(recv.body.claim.receiptJournalId).toBeTruthy();

    const del = await request(app).delete(`/api/insurance-claims/${claim.id}`).set(auth());
    expect(del.status).toBe(200);
    expect(del.body.reversalJournalIds.length).toBe(2);
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.journalEntries.find(j => j.id === claim.journalId)).toBeTruthy();
    expect(db.journalEntries.find(j => j.id === recv.body.claim.receiptJournalId)).toBeTruthy();
  });

  test('P6065 E: a claim dated into a locked period cannot be cancelled', async () => {
    const claim = await createClaim('Ins-E', 200, '2051-02-05');
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2051-02', locked: true }).expect(200);
    const res = await request(app).delete(`/api/insurance-claims/${claim.id}`).set(auth());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERIOD_LOCKED');
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.insuranceClaims.find(c => c.id === claim.id).status).not.toBe('cancelled');
  });

  test('P6065 F: a role without insurance:delete permission cannot cancel a claim', async () => {
    const claim = await createClaim('Ins-F', 100, '2051-01-09');
    const res = await request(app).delete(`/api/insurance-claims/${claim.id}`).set(auth(recepToken));
    expect(res.status).toBe(403);
  });

  // R3 adversarial review: the "dedicated" shortfall write-off account
  // ('5720') collided with DEFAULT_COA's pre-seeded "إقامات وتأشيرات"
  // (residency/visa fees, unrelated) — ensureAccount() silently reused it.
  test('P6065 G: an insurance shortfall write-off posts to the correct dedicated account (5930), not the colliding 5720', async () => {
    const claim = await createClaim('Ins-G', 1000, '2051-01-10');
    const recv = await request(app).put(`/api/insurance-claims/${claim.id}`).set(auth()).send({ status: 'received', receivedDate: '2051-01-25', receivedAmount: 700 });
    expect(recv.status).toBe(200);
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    const je = db.journalEntries.find(j => j.id === recv.body.claim.receiptJournalId);
    const shortfallLine = je.lines.find(l => l.debit === 300);
    expect(shortfallLine.accountCode).toBe('5930');
    const acc5720 = db.chartOfAccounts.find(a => a.code === '5720');
    expect(acc5720.name).toBe('إقامات وتأشيرات'); // untouched — proves no collision occurred
  });

  // R3 adversarial review: month-close's pending-insurance check used the
  // same wrong `c.date` field — always empty, so a real outstanding claim
  // never showed up and the checklist gave a false "لا معلقات" all-clear.
  test('P6065 H: month-close correctly flags a real pending claim for its period (was always a false all-clear)', async () => {
    await createClaim('Ins-H', 250, '2051-03-05');
    const res = await request(app).get('/api/month-close/2051-03').set(auth());
    expect(res.status).toBe(200);
    const item = res.body.steps.find(c => c.id === 'insurance');
    expect(item.auto).toBe(false);
    expect(item.count).not.toBe('لا معلقات');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// P6-028 — Cumulative Excel upload never silently drops days from the GL
// ═══════════════════════════════════════════════════════════════════════
describe('R3 — P6-028: cumulative daily-income Excel import never loses prior days from the auto-income journal', () => {
  function dailyIncomeBuffer(rows) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Date', 'Cash', 'K-Net', 'Visa', 'Master', 'Insurance', 'Cheque', 'Link', 'Total', 'Advance'],
      ...rows,
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  test('P6028 A: a partial upload (days 1-15) then a disjoint upload (days 16-20) of the SAME month — the auto-income JE reflects ALL days, not just the latest upload', async () => {
    const buf1 = dailyIncomeBuffer([['05/09/2051', 100, 0, 0, 0, 0, 0, 0, 100, 0]]);
    const r1 = await request(app).post('/api/upload').set(auth()).attach('file', buf1, 'DailyIncome-D1.xlsx');
    expect(r1.status).toBe(200);

    const buf2 = dailyIncomeBuffer([['16/09/2051', 50, 0, 0, 0, 0, 0, 0, 50, 0]]);
    const r2 = await request(app).post('/api/upload').set(auth()).attach('file', buf2, 'DailyIncome-D2.xlsx');
    expect(r2.status).toBe(200);

    let db; await runAsTenant('default', async () => { db = loadDB(); });
    const je = db.journalEntries.find(j => j.ref === 'INCOME-2051-09');
    expect(je).toBeTruthy();
    // Must reflect BOTH days (100 + 50 = 150), not just the second upload's 50.
    expect(je.totalDebit).toBeCloseTo(150, 3);
    const both = db.dailyData.filter(d => d.date === '2051-09-05' || d.date === '2051-09-16');
    expect(both.length).toBe(2); // both days survive in dailyData regardless
  });

  test('P6028 B: re-uploading the exact same file is idempotent — no duplicate journal entry, same total', async () => {
    let before; await runAsTenant('default', async () => { before = loadDB().journalEntries.filter(j => j.ref === 'INCOME-2051-09').length; });
    const buf = dailyIncomeBuffer([['05/09/2051', 100, 0, 0, 0, 0, 0, 0, 100, 0]]);
    await request(app).post('/api/upload').set(auth()).attach('file', buf, 'DailyIncome-D1-retry.xlsx').expect(200);
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    const jes = db.journalEntries.filter(j => j.ref === 'INCOME-2051-09');
    expect(jes.length).toBe(before); // still exactly one JE for this month, not two
    expect(jes[0].totalDebit).toBeCloseTo(150, 3); // unaffected by the retry
  });

  test('P6028 C: a new valid day inside an already-covered month is added without disturbing prior days', async () => {
    const buf = dailyIncomeBuffer([['10/09/2051', 25, 0, 0, 0, 0, 0, 0, 25, 0]]);
    await request(app).post('/api/upload').set(auth()).attach('file', buf, 'DailyIncome-D3.xlsx').expect(200);
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    const je = db.journalEntries.find(j => j.ref === 'INCOME-2051-09');
    expect(je.totalDebit).toBeCloseTo(175, 3); // 150 + 25, all three days included
  });

  test('P6028 D: the response exposes an explicit import summary (imported/updated counts), not just a generic success message', async () => {
    const buf = dailyIncomeBuffer([
      ['05/09/2051', 100, 0, 0, 0, 0, 0, 0, 100, 0], // already exists -> updated
      ['21/09/2051', 10, 0, 0, 0, 0, 0, 0, 10, 0],   // new -> imported
    ]);
    const res = await request(app).post('/api/upload').set(auth()).attach('file', buf, 'DailyIncome-D4.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.importSummary.imported).toBe(1);
    expect(res.body.importSummary.updated).toBe(1);
  });

  test('P6028 E: an Excel-native numeric serial date is parsed correctly, not silently dropped', async () => {
    const wb = XLSX.utils.book_new();
    // Excel serial 46000 corresponds to 2025-12-09 in the 1899-12-30 epoch.
    const ws = XLSX.utils.aoa_to_sheet([
      ['Date', 'Cash', 'K-Net', 'Visa', 'Master', 'Insurance', 'Cheque', 'Link', 'Total', 'Advance'],
      [46000, 40, 0, 0, 0, 0, 0, 0, 40, 0],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const res = await request(app).post('/api/upload').set(auth()).attach('file', buf, 'DailyIncome-Serial.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.records).toBe(1); // row survived parsing, not silently skipped
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.dailyData.some(d => d.date === '2025-12-09')).toBe(true);
  });

  // R3 adversarial review: two rows for the SAME date within one file both
  // took the "new" branch (existing Set was never updated inside the
  // loop), double-counting that date's revenue in the monthly journal.
  test('P6028 F: two rows for the SAME date within one file are merged, not double-counted', async () => {
    const buf = dailyIncomeBuffer([
      ['05/11/2051', 100, 0, 0, 0, 0, 0, 0, 100, 0],
      ['05/11/2051', 200, 0, 0, 0, 0, 0, 0, 200, 0],
    ]);
    const res = await request(app).post('/api/upload').set(auth()).attach('file', buf, 'DailyIncome-DupDate.xlsx');
    expect(res.status).toBe(200);
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    const rows = db.dailyData.filter(d => d.date === '2051-11-05');
    expect(rows.length).toBe(1); // not 2 — the second row updates, doesn't duplicate
    const je = db.journalEntries.find(j => j.ref === 'INCOME-2051-11');
    expect(je.totalDebit).toBeCloseTo(200, 3); // the later row's value, not 100+200
  });

  // R3 adversarial review: a negative channel value used to flow straight
  // through into the monthly aggregate — reject it outright instead.
  test('P6028 G: a row with a negative channel value is rejected (REJECTED_INVALID), not silently accepted', async () => {
    const buf = dailyIncomeBuffer([['05/12/2051', -150, 0, 0, 0, 0, 0, 0, -150, 0]]);
    const res = await request(app).post('/api/upload').set(auth()).attach('file', buf, 'DailyIncome-Negative.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.importSummary.rejectedInvalid).toBe(1);
    expect(res.body.importSummary.imported).toBe(0);
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.dailyData.some(d => d.date === '2051-12-05')).toBe(false);
  });

  // R3 adversarial review: a month whose net total is legitimately zero
  // (e.g. every day corrected to 0) used to have its prior JE silently
  // removed with the response reporting monthsAffected:[] — indistinguishable
  // from "this upload didn't touch that month at all."
  test('P6028 H: a corrective re-upload that zeroes out a month\'s only day removes the JE and the response says so explicitly', async () => {
    const buf1 = dailyIncomeBuffer([['05/10/2051', 80, 0, 0, 0, 0, 0, 0, 80, 0]]);
    await request(app).post('/api/upload').set(auth()).attach('file', buf1, 'DailyIncome-ZeroA.xlsx').expect(200);
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.journalEntries.some(j => j.ref === 'INCOME-2051-10')).toBe(true);

    const buf2 = dailyIncomeBuffer([['05/10/2051', 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
    const res = await request(app).post('/api/upload').set(auth()).attach('file', buf2, 'DailyIncome-ZeroB.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.importSummary.monthsRemoved).toContain('2051-10');
    await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.journalEntries.some(j => j.ref === 'INCOME-2051-10')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// P6-036 — Payroll accrual duplicate guard (domain-level, key-independent)
// ═══════════════════════════════════════════════════════════════════════
describe('R3 — P6-036: the same payroll period cannot be posted twice, regardless of idempotency key', () => {
  const entries = [{ name: 'Employee One', basicSalary: 500, allowances: 0, deductions: 0, recovery: 0 }];

  test('P6036 A: first accrual for a month succeeds', async () => {
    const res = await request(app).post('/api/payroll').set(auth()).send({ month: '2051-10', entries });
    expect(res.status).toBe(200);
    expect(res.body.record.accrualJeId).toBeTruthy();
  });

  test('P6036 B: a second POST for the SAME month with NO idempotency key is rejected (domain guard, not just key dedup)', async () => {
    const res = await request(app).post('/api/payroll').set(auth()).send({ month: '2051-10', entries });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_PAYROLL');
  });

  test('P6036 C: a second POST for the same month with a DIFFERENT idempotency key is still rejected', async () => {
    const res = await request(app).post('/api/payroll').set(auth()).set('Idempotency-Key', 'totally-different-key-999').send({ month: '2051-10', entries });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_PAYROLL');
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.journalEntries.filter(j => j.ref === 'PAY-ACC-2051-10').length).toBe(1); // still exactly one
    expect(db.payroll.filter(p => p.month === '2051-10').length).toBe(1);
  });

  test('P6036 D: a different month is unaffected and can be posted normally', async () => {
    const res = await request(app).post('/api/payroll').set(auth()).send({ month: '2051-11', entries });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// P6-023 — Accrued-expense over-settlement guard on PUT .../:id
// ═══════════════════════════════════════════════════════════════════════
describe('R3 — P6-023: an accrued expense already fully settled cannot be paid again / overpaid', () => {
  async function createAccrued(amount, month) {
    const res = await request(app).post('/api/accrued-expenses').set(auth()).send({ description: 'Accrued-R3', amount, month, accountCode: '5800' });
    expect(res.status).toBe(200);
    return res.body.item;
  }

  test('P6023 A: a partial payment via PUT succeeds and computes remaining correctly', async () => {
    const item = await createAccrued(100, '2051-09');
    const res = await request(app).put(`/api/accrued-expenses/${item.id}`).set(auth()).send({ status: 'paid', paidAmount: 40, paidDate: '2051-09-15' });
    expect(res.status).toBe(200);
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    const after = db.accruedExpenses.find(a => a.id === item.id);
    expect(after.paidAmount).toBeCloseTo(40, 3);
    expect(after.remaining).toBeCloseTo(60, 3);
    expect(after.status).toBe('partial');
  });

  test('P6023 B: a second PUT paying more than the remaining balance is rejected — no over-settlement journal posted', async () => {
    const item = await createAccrued(100, '2051-09');
    await request(app).put(`/api/accrued-expenses/${item.id}`).set(auth()).send({ status: 'paid', paidAmount: 100 }).expect(200);
    let jeCountBefore; await runAsTenant('default', async () => { jeCountBefore = loadDB().journalEntries.length; });

    const over = await request(app).put(`/api/accrued-expenses/${item.id}`).set(auth()).send({ status: 'paid', paidAmount: 500 });
    // item.status is already 'paid' after the first call, so the paid-branch
    // (status==='paid' && item.status!=='paid') does not even re-enter —
    // this itself proves a second "mark paid" call cannot silently re-post.
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.journalEntries.length).toBe(jeCountBefore); // no new JE from the second call
    expect(db.accruedExpenses.find(a => a.id === item.id).paidAmount).toBeCloseTo(100, 3); // unchanged
  });

  test('P6023 C: overpaying a PARTIALLY-paid item beyond its remaining balance is rejected with OVERPAYMENT', async () => {
    const item = await createAccrued(100, '2051-09');
    await request(app).put(`/api/accrued-expenses/${item.id}`).set(auth()).send({ paidAmount: 30, status: 'paid' }); // -> remaining 70, status 'partial' (not 'paid')
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.accruedExpenses.find(a => a.id === item.id).status).toBe('partial');

    const res = await request(app).put(`/api/accrued-expenses/${item.id}`).set(auth()).send({ status: 'paid', paidAmount: 999 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OVERPAYMENT');
    await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.accruedExpenses.find(a => a.id === item.id).paidAmount).toBeCloseTo(30, 3); // unchanged by the rejected attempt
  });

  test('P6023 D: a non-payment field update (notes) still passes through normally, unaffected by the overpayment guard', async () => {
    const item = await createAccrued(80, '2051-09');
    const res = await request(app).put(`/api/accrued-expenses/${item.id}`).set(auth()).send({ notes: 'تحديث ملاحظة فقط' });
    expect(res.status).toBe(200);
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.accruedExpenses.find(a => a.id === item.id).notes).toBe('تحديث ملاحظة فقط');
  });
});
