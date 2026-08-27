// P0.11 — Financial Statement Truthfulness Closure (Objective C).
//
// Isolated, real-app tests (DB_FILE_ONLY, os.tmpdir()) via supertest against
// the real exported Express app. Covers: the newly-fixed totalEquity/3300
// omission (the core P0.11 finding — Assets != Liabilities+Equity for any
// month/year report requested after a period close), the new Cash Flow
// GL-reconciliation self-check, the Patient AR un-clamping, the new fixed-
// asset register-vs-GL cross-check on the Balance Sheet, cash-vs-non-cash
// Cash Flow correctness, pre/post-close reporting, and tenant isolation.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-11-financial-statements-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p11-fs-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB, warmTenantCache } = require('../lib/database');
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
    patientAR: [], patients: [], patientReceivables: [],
    bankRecons: [], bankCommittedLineKeys: [], bankMatchedLineIds: [], networkReceivableCleared: { knet: 0, card: 0 },
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

const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

async function postJournal(date, lines, desc) {
  return request(app).post('/api/journal').set(auth()).send({ date, desc: desc || 'test entry', lines });
}

async function getStatements(query) {
  return request(app).get('/api/financial-statements').set(auth()).query(query);
}

async function closeMonth(year, month) {
  return request(app).post('/api/closing-entry').set(auth()).send({ year, month });
}

// ═══════════════════════════════════════════════════════════════════════
// Balance Sheet Equity — the core P0.11 finding (totalEquity omitted 3300)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.11 — Balance Sheet Equity: account 3300 (period-close transfer)', () => {
  test('Equity A: BEFORE any close, a month with revenue/expense reports a balanced sheet with the raw profit in equity', async () => {
    await postJournal('2053-01-05', [{ accountCode: '1100', debit: 4000, credit: 0 }, { accountCode: '4100', debit: 0, credit: 4000 }], 'Jan revenue').then(r => expect(r.status).toBe(200));
    await postJournal('2053-01-10', [{ accountCode: '5100', debit: 1000, credit: 0 }, { accountCode: '1100', debit: 0, credit: 1000 }], 'Jan expense').then(r => expect(r.status).toBe(200));

    const res = await getStatements({ period: 'month', year: 2053, month: 1 });
    expect(res.status).toBe(200);
    expect(res.body.incomeStatement.netProfit).toBeCloseTo(3000, 2);
    expect(res.body.balanceSheet.equity.currentPeriodNetIncome).toBeCloseTo(3000, 2);
    expect(res.body.balanceSheet.balanced).toBe(true);
    expect(res.body.balanceSheet.differenceKD).toBeLessThan(0.005);
  });

  test('Equity B: closing January posts the transfer to 3300', async () => {
    const res = await closeMonth(2053, 1);
    expect(res.status).toBe(200);
    let je;
    await runAsTenant('default', async () => { je = loadDB().journalEntries.find(j => j.ref === 'CLOSE-2053-01'); });
    expect(je).toBeTruthy();
    expect(je.lines.some(l => l.accountCode === '3300' && l.credit === 3000)).toBe(true);
  });

  test('Equity C (THE CORE FIX): a LATER month (February, no activity) after January\'s close still reports a balanced sheet — January\'s transferred profit is now visible in equity', async () => {
    const res = await getStatements({ period: 'month', year: 2053, month: 2 });
    expect(res.status).toBe(200);
    // Before the P0.11 fix this was 0 (3300 never read) and balanced was false.
    expect(res.body.balanceSheet.equity.total).toBeCloseTo(3000, 2);
    expect(res.body.balanceSheet.assets.total).toBeCloseTo(3000, 2); // cash unchanged since January
    expect(res.body.balanceSheet.balanced).toBe(true);
    expect(res.body.balanceSheet.differenceKD).toBeLessThan(0.005);
  });

  test('Equity D (no double-count): requesting January itself AFTER it was closed still reports the SAME 3000 equity, not 6000', async () => {
    const res = await getStatements({ period: 'month', year: 2053, month: 1 });
    expect(res.status).toBe(200);
    expect(res.body.balanceSheet.equity.total).toBeCloseTo(3000, 2);
    expect(res.body.balanceSheet.balanced).toBe(true);
  });

  test('Equity F: period:"all" does not double-count via priorClosedRetained (P&L side alone already spans full history)', async () => {
    // Note: this route's own pre-existing (unmodified by this fix) design
    // treats "all" asymmetrically — the P&L half is genuinely unbounded,
    // but the Balance Sheet half's asOfDate for "all" is "today" (real
    // wall-clock date), not "the last transaction ever recorded". Since
    // this test suite intentionally uses far-future dates (matching this
    // whole session's convention of never colliding with real "today"),
    // asserting balanced:true for "all" here would depend on that
    // unrelated, pre-existing behavior rather than on this fix. What THIS
    // fix specifically guarantees for "all" — priorClosedRetained is
    // forced to 0, never double-adding on top of currentPeriodNI's own
    // full-history figure — is what's actually asserted below.
    const res = await getStatements({ period: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.incomeStatement.netProfit).toBeCloseTo(3000, 2);
    expect(res.body.balanceSheet.equity.currentPeriodNetIncome).toBeCloseTo(3000, 2);
    // Equity total must equal currentPeriodNI alone (0 + 0 + 0 + 3000), not
    // 6000 — which is what a naive "always add 3300" fix would have produced.
    expect(res.body.balanceSheet.equity.total).toBeCloseTo(3000, 2);
  });

  test('Equity G (adversarial review finding): a manual journal entry cannot post directly to account 3300 outside the canonical closing path', async () => {
    const res = await postJournal('2053-03-05', [
      { accountCode: '3300', debit: 500, credit: 0 },
      { accountCode: '1100', debit: 0, credit: 500 },
    ], 'attempted manual 3300 posting');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SYSTEM_ACCOUNT_POSTING');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// R5A — GET /api/reports/balance-sheet direct coverage
// (NEW-R5-ADV-BALANCE-SHEET-EQUITY-01)
// ═══════════════════════════════════════════════════════════════════════
// The Equity A-G tests above only ever exercise the balanceSheet sub-object
// nested inside GET /api/financial-statements. R5's adversarial review
// found the SEPARATE, real production endpoint GET /api/reports/
// balance-sheet had the identical omitted-open-period-net-income defect
// (fixed independently, server.js ~14206-14222, via an openPeriodNetIncome
// term) — but had zero direct test coverage of its own `balanced` flag.
// Mirrors the same before/after-close/no-double-count pattern against the
// actual endpoint, using a distinct year (2054) to avoid any fixture
// collision with the tests above.
describe('R5A — GET /api/reports/balance-sheet: openPeriodNetIncome (NEW-R5-ADV-BALANCE-SHEET-EQUITY-01)', () => {
  test('BS Equity A: BEFORE any close, a month with open revenue/expense reports balanced:true with the raw profit folded into equity', async () => {
    await postJournal('2054-01-05', [{ accountCode: '1100', debit: 5000, credit: 0 }, { accountCode: '4100', debit: 0, credit: 5000 }], 'BS-direct Jan revenue').then(r => expect(r.status).toBe(200));
    await postJournal('2054-01-10', [{ accountCode: '5100', debit: 2000, credit: 0 }, { accountCode: '1100', debit: 0, credit: 2000 }], 'BS-direct Jan expense').then(r => expect(r.status).toBe(200));

    const res = await request(app).get('/api/reports/balance-sheet').set(auth()).query({ date: '2054-01-20' });
    expect(res.status).toBe(200);
    expect(res.body.openPeriodNetIncome).toBeCloseTo(3000, 2);
    expect(res.body.balanced).toBe(true);
  });

  test('BS Equity B: closing January posts the transfer to 3300', async () => {
    const res = await closeMonth(2054, 1);
    expect(res.status).toBe(200);
  });

  test('BS Equity C (THE CORE FIX): a LATER month (February, no activity) after January\'s close still reports balanced:true', async () => {
    const res = await request(app).get('/api/reports/balance-sheet').set(auth()).query({ date: '2054-02-15' });
    expect(res.status).toBe(200);
    expect(res.body.openPeriodNetIncome).toBeCloseTo(0, 2); // February itself has no open 4xxx/5xxx activity
    // 6000, not 3000: account 3300 is CUMULATIVE across this whole shared-fixture
    // test file — the earlier "Equity B" test (2053-01 close) already credited
    // 3300 for 3000 before this describe block even runs; this describe block's
    // own 2054-01 close (BS Equity B above) adds a second 3000 on top. What THIS
    // fix actually guarantees (and what matters here) is that February's own
    // openPeriodNetIncome is genuinely 0 — not that equity is a fixed number.
    expect(res.body.totalEquity).toBeCloseTo(6000, 2);
    expect(res.body.balanced).toBe(true);
  });

  test('BS Equity D (no double-count): requesting January itself AFTER it was closed still reports balanced:true, not inflated by re-adding January\'s own already-closed profit a second time', async () => {
    const res = await request(app).get('/api/reports/balance-sheet').set(auth()).query({ date: '2054-01-31' });
    expect(res.status).toBe(200);
    expect(res.body.openPeriodNetIncome).toBeCloseTo(0, 2); // already closed -> nets to ~zero via buildBalanceMap
    // Same cumulative 6000 as BS Equity C (see comment there) — the point of
    // THIS assertion is that it is NOT 9000 (6000 + January's 3000 double-counted
    // via openPeriodNetIncome on top of its own already-posted 3300 transfer).
    expect(res.body.totalEquity).toBeCloseTo(6000, 2);
    expect(res.body.balanced).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cash Flow — cash vs non-cash + GL reconciliation
// ═══════════════════════════════════════════════════════════════════════
describe('P0.11 — Cash Flow: cash-vs-non-cash correctness + GL reconciliation self-check', () => {
  test('CF A: a cash patient collection is included in operating cash flow', async () => {
    const pRes = await request(app).post('/api/patients').set(auth()).send({ name: 'CF-Patient-A' });
    const rRes = await request(app).post('/api/patient-receivables').set(auth()).send({ patientId: pRes.body.patient.id, serviceDate: '2053-03-05', amount: 500 });
    await request(app).post(`/api/patient-receivables/${rRes.body.receivable.id}/collect`).set(auth()).send({ amount: 500, collectAccount: '1100' }).then(r => expect(r.status).toBe(200));

    const res = await getStatements({ period: 'month', year: 2053, month: 3 });
    expect(res.status).toBe(200);
    // Recognition (credit) has zero cash effect; the collection itself is the cash event.
    expect(res.body.cashFlow.reconciled).toBe(true);
  });

  test('CF B: a credit-financed asset purchase is EXCLUDED from investing cash flow', async () => {
    await request(app).post('/api/assets').set(auth()).send({ name: 'CF-Asset-Credit', cost: 1200, purchaseDate: '2053-03-10', payMethod: 'credit', usefulLife: 5 }).then(r => expect(r.status).toBe(200));
    const res = await getStatements({ period: 'month', year: 2053, month: 3 });
    // investing should NOT include the 1200 credit-financed purchase
    expect(res.body.cashFlow.investing).toBeCloseTo(0, 2);
  });

  test('CF C: a CASH asset purchase IS included in investing cash flow', async () => {
    await request(app).post('/api/assets').set(auth()).send({ name: 'CF-Asset-Cash', cost: 300, purchaseDate: '2053-03-12', payMethod: 'cash', usefulLife: 5 }).then(r => expect(r.status).toBe(200));
    const res = await getStatements({ period: 'month', year: 2053, month: 3 });
    expect(res.body.cashFlow.investing).toBeCloseTo(-300, 2);
  });

  test('CF D: depreciation is excluded from operating cash flow (added back, not left as a cash expense)', async () => {
    await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2053-03' }).then(r => expect(r.status).toBe(200));
    const res = await getStatements({ period: 'month', year: 2053, month: 3 });
    expect(res.status).toBe(200);
    expect(res.body.incomeStatement.depreciation).toBeGreaterThan(0);
    // The GL-reconciliation self-check is the real proof depreciation was
    // correctly treated as non-cash: if it had been left as a cash outflow,
    // operating cash flow would be understated and reconciled would be false.
    expect(res.body.cashFlow.reconciled).toBe(true);
  });

  test('CF E: an UNPAID vendor bill is excluded from operating cash flow until actually paid', async () => {
    const vRes = await request(app).post('/api/vendors').set(auth()).send({ name: 'CF-Vendor-E' });
    await request(app).post('/api/vendor-bills').set(auth()).send({ vendorId: vRes.body.vendor.id, billDate: '2053-03-15', allocations: [{ accountCode: '5200', amount: 400 }] }).then(r => expect(r.status).toBe(200));
    const res = await getStatements({ period: 'month', year: 2053, month: 3 });
    expect(res.status).toBe(200);
    // Reconciled must still hold — the unpaid bill increases a liability
    // (working-capital source of cash in the indirect method) with zero
    // actual cash movement; both sides of the identity move together.
    expect(res.body.cashFlow.reconciled).toBe(true);
  });

  test('CF F: actually PAYING that vendor bill moves real cash and the statement still reconciles', async () => {
    let bill;
    await runAsTenant('default', async () => { bill = loadDB().vendorBills.find(b => b.grossAmount === 400); });
    await request(app).post(`/api/vendor-bills/${bill.id}/pay`).set(auth()).send({ amount: 400, payAccount: '1100' }).then(r => expect(r.status).toBe(200));
    const res = await getStatements({ period: 'month', year: 2053, month: 3 });
    expect(res.status).toBe(200);
    expect(res.body.cashFlow.reconciled).toBe(true);
  });

  test('CF G: opening cash + net movement = closing cash, tied to the real GL 1100/1110 balance', async () => {
    const res = await getStatements({ period: 'month', year: 2053, month: 3 });
    expect(res.status).toBe(200);
    const { openingCash, netChange, closingCash, impliedClosingCash } = res.body.cashFlow;
    expect(parseFloat((openingCash + netChange).toFixed(3))).toBeCloseTo(impliedClosingCash, 2);
    expect(Math.abs(impliedClosingCash - closingCash)).toBeLessThan(0.005);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fixed Asset GL Reconciliation surfaced on the Balance Sheet
// ═══════════════════════════════════════════════════════════════════════
describe('P0.11 — Balance Sheet fixed-asset register-vs-GL cross-check', () => {
  test('AssetRecon A: a normally-created asset reconciles (register cost/accumDep match GL 1510/1590)', async () => {
    await request(app).post('/api/assets').set(auth()).send({ name: 'BS-Asset-Recon', cost: 600, purchaseDate: '2053-04-01', payMethod: 'cash', usefulLife: 5 }).then(r => expect(r.status).toBe(200));
    const res = await getStatements({ period: 'month', year: 2053, month: 4 });
    expect(res.status).toBe(200);
    expect(res.body.balanceSheet.assets.fixed.glReconciliation.reconciled).toBe(true);
    expect(res.body.balanceSheet.assets.fixed.glReconciliation.registerCost).toBeCloseTo(res.body.balanceSheet.assets.fixed.glReconciliation.glCost, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Trial Balance + Income Statement regression (still correct)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.11 — Trial Balance and Income Statement remain correct (regression)', () => {
  test('TB A: trial balance stays balanced after all this file\'s activity', async () => {
    const tb = await request(app).get('/api/trial-balance').set(auth());
    expect(tb.status).toBe(200);
    expect(tb.body.isBalanced).toBe(true);
  });

  test('IS A: income statement excludes closing-transfer entries from a multi-month range', async () => {
    const res = await getStatements({ period: 'year', year: 2053 });
    expect(res.status).toBe(200);
    // Year-to-date net profit must reflect real operating activity across
    // Jan-Apr, not be zeroed out by January's own closing entry.
    expect(res.body.incomeStatement.netProfit).not.toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Date/period boundary correctness (P0.11 Part L). Uses 2057 — unused by
// any other date in this file or any sibling P0.11 test file.
// ═══════════════════════════════════════════════════════════════════════
describe('P0.11 — date/period boundary correctness', () => {
  test('Boundary A: a JE dated the FIRST day of the month is included in that month\'s Income Statement', async () => {
    await postJournal('2057-02-01', [{ accountCode: '1100', debit: 400, credit: 0 }, { accountCode: '4100', debit: 0, credit: 400 }], 'Boundary A first-day').then(r => expect(r.status).toBe(200));
    const res = await getStatements({ period: 'month', year: 2057, month: 2 });
    expect(res.body.incomeStatement.revenue.total).toBeCloseTo(400, 3);
  });

  test('Boundary B: a JE dated the LAST real day of a 28-day February (2057 is not a leap year) is included in February, not spilled into March', async () => {
    await postJournal('2057-02-28', [{ accountCode: '1100', debit: 150, credit: 0 }, { accountCode: '4100', debit: 0, credit: 150 }], 'Boundary B last-day-feb').then(r => expect(r.status).toBe(200));
    const feb = await getStatements({ period: 'month', year: 2057, month: 2 });
    const mar = await getStatements({ period: 'month', year: 2057, month: 3 });
    expect(feb.body.incomeStatement.revenue.total).toBeCloseTo(550, 3); // 400 (A) + 150 (B)
    expect(mar.body.incomeStatement.revenue.total).toBe(0);
  });

  test('Boundary C: a JE dated the 1st of the FOLLOWING month is excluded from February\'s Income Statement AND from February\'s point-in-time Balance Sheet cash — and correctly included in March for both', async () => {
    const febBefore = await getStatements({ period: 'month', year: 2057, month: 2 });
    const febRevenueBefore = febBefore.body.incomeStatement.revenue.total;
    const febCashBefore = febBefore.body.balanceSheet.assets.current.cash;

    await postJournal('2057-03-01', [{ accountCode: '1100', debit: 275, credit: 0 }, { accountCode: '4100', debit: 0, credit: 275 }], 'Boundary C next-month-first-day').then(r => expect(r.status).toBe(200));

    const febAfter = await getStatements({ period: 'month', year: 2057, month: 2 });
    const mar = await getStatements({ period: 'month', year: 2057, month: 3 });

    // February must be COMPLETELY unaffected — both its own-period P&L
    // (pnlFromDate/pnlToDate bounded) and its point-in-time Balance Sheet
    // (all-time-up-to-asOfDate, where asOfDate must correctly resolve to
    // Feb 28, not spill into March) exclude the March 1 entry.
    expect(febAfter.body.incomeStatement.revenue.total).toBe(febRevenueBefore);
    expect(febAfter.body.balanceSheet.assets.current.cash).toBeCloseTo(febCashBefore, 3);
    // March correctly sees it on both statements.
    expect(mar.body.incomeStatement.revenue.total).toBeCloseTo(275, 3);
    expect(mar.body.balanceSheet.assets.current.cash).toBeCloseTo(febCashBefore + 275, 3);
  });

  test('Boundary D: year-boundary — a JE dated December 31 counts in that year; a JE dated January 1 of the next year does not', async () => {
    await postJournal('2057-12-31', [{ accountCode: '1100', debit: 600, credit: 0 }, { accountCode: '4100', debit: 0, credit: 600 }], 'Boundary D year-end').then(r => expect(r.status).toBe(200));
    const y2057 = await getStatements({ period: 'year', year: 2057 });
    const y2057RevenueBefore = y2057.body.incomeStatement.revenue.total;
    expect(y2057RevenueBefore).toBeGreaterThanOrEqual(600);

    await postJournal('2058-01-01', [{ accountCode: '1100', debit: 900, credit: 0 }, { accountCode: '4100', debit: 0, credit: 900 }], 'Boundary D new-year').then(r => expect(r.status).toBe(200));

    const y2057After = await getStatements({ period: 'year', year: 2057 });
    const y2058 = await getStatements({ period: 'year', year: 2058 });
    expect(y2057After.body.incomeStatement.revenue.total).toBe(y2057RevenueBefore); // unaffected by the 2058 JE
    expect(y2058.body.incomeStatement.revenue.total).toBeCloseTo(900, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tenant Isolation for financial statements
// ═══════════════════════════════════════════════════════════════════════
describe('P0.11 — Financial statements are tenant-isolated', () => {
  test('Tenant A: Tenant A\'s revenue/equity never appears in Tenant B\'s statements', async () => {
    await runAsTenant('tenant-b-p11', async () => {
      await warmTenantCache('tenant-b-p11');
      const db = loadDB();
      db.users = [{ id: 'usr-tb11', username: 'tenantb11', email: 'tb11@test.com', passwordHash: hash('TenantB1!'), role: 'admin', fullName: 'Tenant B Admin', active: true, createdAt: new Date().toISOString(), lastLogin: null }];
      db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
      saveDB(db);
    });
    const loginB = await request(app).post('/api/auth/login').send({ username: 'tenantb11', password: 'TenantB1!', tenantId: 'tenant-b-p11' });
    const tokenB = loginB.body.token;

    const resB = await request(app).get('/api/financial-statements').set(auth(tokenB)).query({ period: 'all' });
    expect(resB.status).toBe(200);
    expect(resB.body.incomeStatement.revenue.total).toBe(0);
    expect(resB.body.balanceSheet.equity.total).toBe(0);
  });
});
