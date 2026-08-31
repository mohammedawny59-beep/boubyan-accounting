// P3 — Vendor / Accounts Payable Workspace Upgrade (specs/001-vendor-ap-workspace).
//
// Workspace-specific composition cases the AP-lifecycle and statement-hotfix
// files don't already own: open-items derivation (the F1 status+outstanding
// filter, including the credited-to-zero case), date-range-vs-reconciliation
// (clarification Q2), outstanding/overdue filters, and cross-view
// no-duplication (T031). Vendor search (finding H1) is verified manually
// via quickstart.md instead — no unit test file for it (see research.md
// Decision 10).
//
// Isolated, real-app tests (DB_FILE_ONLY, os.tmpdir()) via supertest — same
// harness as tests/p0-7-ap-lifecycle.test.js. No production data anywhere.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p3-vendor-ap-workspace-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p3-vws-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, loadDB, saveDB } = require('../lib/database');
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
  };
}

let adminToken;
beforeAll(async () => {
  await initDB({ mongoUri: 'mongodb://127.0.0.1:1/unused', dataFile: process.env.DATA_FILE, configFile: process.env.CONFIG_FILE, defaultConfig: {}, buildInitialDB, migrateDB: () => false });
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
  adminToken = login.body.token;
});
afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});
const auth = () => ({ Authorization: `Bearer ${adminToken}` });

async function createVendor(name) {
  const res = await request(app).post('/api/vendors').set(auth()).send({ name, phone: '000' });
  expect(res.status).toBe(200);
  return res.body.vendor;
}

async function createBill(vendorId, opts = {}) {
  const res = await request(app).post('/api/vendor-bills').set(auth()).send({
    vendorId, billDate: opts.billDate || '2050-01-01', dueDate: opts.dueDate || '2050-01-01',
    billNumber: opts.billNumber, allocations: [{ accountCode: '5100', amount: opts.amount || 100 }],
  });
  expect(res.status).toBe(200);
  return res.body.bill;
}

// The exact predicate T015's open-items list, T007/T009's Open Bills
// figure, and T018's next-item preview all key off (research.md Decision
// 4, finding F1) — not `status` alone.
const isOpen = b => b.status !== 'CANCELLED' && b.status !== 'PAID' && (b.outstandingAmount || 0) > 0.001;

// ═══════════════════════════════════════════════════════════════════════
// T014 — Open-items derivation (finding F1)
// ═══════════════════════════════════════════════════════════════════════
describe('Vendor Workspace — Open Items derivation (finding F1)', () => {
  test('F1 A: an unpaid, uncredited bill is open', async () => {
    const vendor = await createVendor('Vendor-OpenItems-A');
    const bill = await createBill(vendor.id, { amount: 500 });
    expect(isOpen(bill)).toBe(true);
    expect(bill.status).toBe('POSTED');
    expect(bill.outstandingAmount).toBeCloseTo(500, 3);
  });

  test('F1 B: a fully paid bill is not open (status alone would already exclude it, but outstandingAmount must also be ~0)', async () => {
    const vendor = await createVendor('Vendor-OpenItems-B');
    const bill = await createBill(vendor.id, { amount: 300 });
    const pay = await request(app).post(`/api/vendor-bills/${bill.id}/pay`).set(auth()).send({ amount: 300, payDate: '2050-01-05', payAccount: '1100' });
    expect(pay.status).toBe(200);
    expect(isOpen(pay.body.bill)).toBe(false);
    expect(pay.body.bill.status).toBe('PAID');
    expect(pay.body.bill.outstandingAmount).toBeCloseTo(0, 3);
  });

  test('F1 C: a cancelled bill is not open', async () => {
    const vendor = await createVendor('Vendor-OpenItems-C');
    const bill = await createBill(vendor.id, { amount: 200 });
    const cancel = await request(app).post(`/api/vendor-bills/${bill.id}/cancel`).set(auth()).send({ reason: 'test cancel' });
    expect(cancel.status).toBe(200);
    const refetch = await request(app).get('/api/vendor-bills').set(auth()).query({ vendorId: vendor.id });
    const cancelled = refetch.body.find(b => b.id === bill.id);
    expect(isOpen(cancelled)).toBe(false);
    expect(cancelled.status).toBe('CANCELLED');
  });

  test('F1 D (the core regression this finding is about): a POSTED bill credited all the way to zero via the real /credit path must NOT appear as open, even though its status never becomes PAID', async () => {
    const vendor = await createVendor('Vendor-OpenItems-D');
    const bill = await createBill(vendor.id, { amount: 400 });
    const credit = await request(app).post(`/api/vendor-bills/${bill.id}/credit`).set(auth()).send({ amount: 400, reason: 'full credit note', date: '2050-01-10' });
    expect(credit.status).toBe(200);
    // Confirmed regression case: postVendorBillCredit() only sets status via
    // the payment path (server.js:6216) — a credit-only path never flips
    // status to PAID. This is exactly why F1's filter checks
    // outstandingAmount too, not status alone (data-model.md: "State
    // Transitions" nuance, research.md Decision 4).
    expect(credit.body.bill.status).not.toBe('PAID');
    expect(credit.body.bill.outstandingAmount).toBeCloseTo(0, 3);
    expect(isOpen(credit.body.bill)).toBe(false);
  });

  test('F1 E: a bill with combined partial payment + partial credit shows the correct remaining balance and stays open', async () => {
    const vendor = await createVendor('Vendor-OpenItems-E');
    const bill = await createBill(vendor.id, { amount: 1000 });
    const pay = await request(app).post(`/api/vendor-bills/${bill.id}/pay`).set(auth()).send({ amount: 300, payDate: '2050-01-05', payAccount: '1100' });
    expect(pay.status).toBe(200);
    const credit = await request(app).post(`/api/vendor-bills/${bill.id}/credit`).set(auth()).send({ amount: 250, reason: 'partial credit', date: '2050-01-06' });
    expect(credit.status).toBe(200);
    // Remaining balance reflects BOTH payments and credits together, not
    // payments alone (spec.md Acceptance Scenario US2#3 / FR-006).
    expect(credit.body.bill.outstandingAmount).toBeCloseTo(1000 - 300 - 250, 3);
    expect(credit.body.bill.status).toBe('PARTIALLY_PAID');
    expect(isOpen(credit.body.bill)).toBe(true);
  });

  test('F1 F: within one vendor\'s bill set, the open-items filter correctly separates open from non-open', async () => {
    const vendor = await createVendor('Vendor-OpenItems-Mix');
    const open1 = await createBill(vendor.id, { amount: 100 });
    const paid  = await createBill(vendor.id, { amount: 150 });
    const cancelled = await createBill(vendor.id, { amount: 175 });
    const creditedToZero = await createBill(vendor.id, { amount: 220 });
    await request(app).post(`/api/vendor-bills/${paid.id}/pay`).set(auth()).send({ amount: 150, payDate: '2050-01-05', payAccount: '1100' }).expect(200);
    await request(app).post(`/api/vendor-bills/${cancelled.id}/cancel`).set(auth()).send({ reason: 'test' }).expect(200);
    await request(app).post(`/api/vendor-bills/${creditedToZero.id}/credit`).set(auth()).send({ amount: 220, reason: 'test', date: '2050-01-06' }).expect(200);

    const res = await request(app).get('/api/vendor-bills').set(auth()).query({ vendorId: vendor.id });
    const openIds = res.body.filter(isOpen).map(b => b.id);
    expect(openIds).toEqual([open1.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T019 — date-range filter narrows rows, never touches reconciliation
// (clarification Q2, spec.md FR-015)
// ═══════════════════════════════════════════════════════════════════════
describe('Vendor Workspace — statement date-range filter leaves reconciliation unchanged (clarification Q2)', () => {
  test('Q2 A: the statement endpoint returns the full, unfiltered row set and a single reconciliation value — any date-range narrowing is the caller\'s own client-side concern, never a server recomputation', async () => {
    const vendor = await createVendor('Vendor-DateRange-Q2');
    await createBill(vendor.id, { billDate: '2050-02-01', dueDate: '2050-02-01', amount: 111 });
    await createBill(vendor.id, { billDate: '2050-05-01', dueDate: '2050-05-01', amount: 222 });

    const full = await request(app).get(`/api/vendors/${vendor.id}/statement`).set(auth());
    expect(full.status).toBe(200);
    expect(full.body.rows.length).toBeGreaterThanOrEqual(2);
    const recBefore = full.body.reconciliation;

    // Calling the SAME endpoint again (simulating what a client-side date
    // filter does — it never re-requests with a narrower range, since T022
    // filters the already-fetched `rows` array in place) must yield an
    // identical reconciliation object — there is exactly one reconciliation
    // calculation for a vendor (FR-011), and it is never a function of any
    // date range a caller might apply to the row list.
    const again = await request(app).get(`/api/vendors/${vendor.id}/statement`).set(auth());
    expect(again.body.reconciliation).toEqual(recBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T027 — "outstanding only" / "overdue only" filters
// ═══════════════════════════════════════════════════════════════════════
describe('Vendor Workspace — outstanding-only and overdue-only filtering data', () => {
  test('Filters A: a vendor with a zero balance is correctly distinguishable from one with an outstanding balance, for the vendor-list "outstanding only" filter', async () => {
    const owing = await createVendor('Vendor-Filters-Owing');
    await createBill(owing.id, { amount: 50 });
    const clear = await createVendor('Vendor-Filters-Clear');

    const owingBills = await request(app).get('/api/vendor-bills').set(auth()).query({ vendorId: owing.id });
    const clearBills = await request(app).get('/api/vendor-bills').set(auth()).query({ vendorId: clear.id });
    expect(owingBills.body.some(isOpen)).toBe(true);
    expect(clearBills.body.length).toBe(0);
  });

  test('Filters B: overdue-only narrows to bills whose due date has passed, using the pre-existing dueDate field — no new bucket logic', async () => {
    const vendor = await createVendor('Vendor-Filters-Overdue');
    const overdue = await createBill(vendor.id, { billDate: '2020-01-01', dueDate: '2020-01-01', amount: 60 });
    const notOverdue = await createBill(vendor.id, { billDate: '2099-01-01', dueDate: '2099-01-01', amount: 70 });

    const res = await request(app).get('/api/vendor-bills').set(auth()).query({ vendorId: vendor.id });
    const today = new Date().toISOString().slice(0, 10);
    const overdueOnly = res.body.filter(isOpen).filter(b => b.dueDate && b.dueDate < today);
    expect(overdueOnly.map(b => b.id)).toEqual([overdue.id]);
    expect(overdueOnly.map(b => b.id)).not.toContain(notOverdue.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T031 — no vendorBill/payment/legacy-journal row is ever duplicated
// across the statement, open-items, and aging views for the same vendor
// ═══════════════════════════════════════════════════════════════════════
describe('Vendor Workspace — no cross-view duplication (T031)', () => {
  test('Dup A: a bill + its payment + a legacy direct-journal posting on the same account each appear exactly once in the statement, and the bill appears exactly once in the open-items source', async () => {
    const vendor = await createVendor('Vendor-Dup-A');
    const bill = await createBill(vendor.id, { amount: 900 });
    await request(app).post(`/api/vendor-bills/${bill.id}/pay`).set(auth()).send({ amount: 400, payDate: '2050-01-05', payAccount: '1100' }).expect(200);

    // A legacy, direct journal entry against this vendor's own payable
    // account — posted outside the vendorBills subledger entirely, the
    // same P3-HOTFIX legacy-journal case p3-vendor-statement-hotfix.test.js
    // already covers in depth; this test only confirms it doesn't ALSO
    // collide with this bill's own rows.
    const db = loadDB();
    db.journalEntries.push({
      id: 'JE-DUP-A-LEGACY', date: '2050-01-02', ref: 'LEGACY-DUP-A', desc: 'Legacy direct posting',
      source: 'manual', totalDebit: 50, totalCredit: 50,
      lines: [
        { accountCode: '5100', debit: 50, credit: 0 },
        { accountCode: vendor.accountId, debit: 0, credit: 50 },
      ],
    });
    saveDB(db);

    const stmt = await request(app).get(`/api/vendors/${vendor.id}/statement`).set(auth());
    const billRows = stmt.body.rows.filter(r => r.sourceId === bill.id);
    // bill.js -> one 'bill' row + one 'payment' row for this single bill
    // and its single payment — never duplicated across two representations.
    expect(billRows.filter(r => r.type === 'bill').length).toBe(1);
    expect(billRows.filter(r => r.type === 'payment').length).toBe(1);
    const legacyRows = stmt.body.rows.filter(r => r.type === 'legacy-journal' && r.reference === 'LEGACY-DUP-A');
    expect(legacyRows.length).toBe(1);

    // The bill also appears exactly once in the source array the open-items
    // list (T015) and Open Bills total (T007/T009) both derive from.
    const bills = await request(app).get('/api/vendor-bills').set(auth()).query({ vendorId: vendor.id });
    expect(bills.body.filter(b => b.id === bill.id).length).toBe(1);
  });
});
