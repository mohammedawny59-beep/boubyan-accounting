// P0.7 — Full Accounts Payable & Vendor Lifecycle.
//
// Isolated, real-app tests (DB_FILE_ONLY, os.tmpdir()) via supertest against
// the real exported Express app — no production data, no real network.
// Covers the new db.vendorBills[] subledger: recognition, multi-line
// allocation, duplicate prevention, partial/full payment, idempotency,
// credit/cancellation, payment reversal, vendor statement, AP aging
// expansion, GL reconciliation, RBAC, audit, tenant isolation, and
// regression of the P0.6A/P0.6B independently-verified scenarios.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-7-ap-lifecycle-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p07-'));
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
      { id: 'usr-recep', username: 'receptionist1', email: 'r@test.com', passwordHash: hash('RecepPass1!'), role: 'receptionist', fullName: 'استقبال', active: true, createdAt: new Date().toISOString(), lastLogin: null },
    ],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], fixedAssets: [], budget: {}, auditLog: [], accruedExpenses: [],
    journalMappings: [], doctorExpenses: [], lockedPeriods: {}, vendorBills: [], accountingSettings: {},
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

async function createVendor(name) {
  const res = await request(app).post('/api/vendors').set(auth()).send({ name, phone: '000' });
  expect(res.status).toBe(200);
  return res.body.vendor;
}

// ═══════════════════════════════════════════════════════════════════════
// PART B — Bill A-F
// ═══════════════════════════════════════════════════════════════════════
describe('P0.7 — Bill: supplier bill recognition (P6-024)', () => {
  test('Bill A: a posted supplier bill produces the correct Dr expense / Cr vendor-AP journal', async () => {
    const vendor = await createVendor('Vendor-Bill-A');
    const res = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-01-05', dueDate: '2048-02-04', billNumber: 'INV-001',
      description: 'Office expense', allocations: [{ accountCode: '5100', amount: 1000, desc: 'Office' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.bill.status).toBe('POSTED');
    expect(res.body.bill.grossAmount).toBeCloseTo(1000, 3);
    expect(res.body.bill.outstandingAmount).toBeCloseTo(1000, 3);

    let je;
    await runAsTenant('default', async () => { je = loadDB().journalEntries.find(j => j.id === res.body.bill.journalId); });
    expect(je).toBeTruthy();
    expect(je.lines.some(l => l.accountCode === '5100' && l.debit === 1000)).toBe(true);
    expect(je.lines.some(l => l.accountCode === vendor.accountId && l.credit === 1000)).toBe(true);
  });

  test('Bill B: a malformed allocation (zero/negative amount) is rejected before any mutation', async () => {
    const vendor = await createVendor('Vendor-Bill-B');
    const res = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-01-05', allocations: [{ accountCode: '5100', amount: -50 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ALLOCATION');
    let bills;
    await runAsTenant('default', async () => { bills = loadDB().vendorBills.filter(b => b.vendorId === vendor.id); });
    expect(bills.length).toBe(0);
  });

  test('Bill C: a bill for an unknown vendor is rejected', async () => {
    const res = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: 'VND-DOES-NOT-EXIST', billDate: '2048-01-05', allocations: [{ accountCode: '5100', amount: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_VENDOR');
  });

  test('Bill D: a duplicate vendor+billNumber is rejected, not silently merged', async () => {
    const vendor = await createVendor('Vendor-Bill-D');
    const first = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-01-05', billNumber: 'DUP-1', allocations: [{ accountCode: '5100', amount: 200 }],
    });
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-01-06', billNumber: 'DUP-1', allocations: [{ accountCode: '5100', amount: 300 }],
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('DUPLICATE_BILL');
    let bills;
    await runAsTenant('default', async () => { bills = loadDB().vendorBills.filter(b => b.vendorId === vendor.id); });
    expect(bills.length).toBe(1); // the duplicate attempt created nothing
  });

  test('Bill E: a bill dated into an already-locked period is rejected', async () => {
    const vendor = await createVendor('Vendor-Bill-E');
    const lockRes = await request(app).post('/api/period-lock').set(auth()).send({ period: '2048-03', locked: true });
    expect(lockRes.status).toBe(200);
    const res = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-03-10', allocations: [{ accountCode: '5100', amount: 100 }],
    });
    // Posting a bill creates a brand-new journal entry, so this goes through
    // validateJournalEntry's own Invariant B (the CREATE-path guard), which
    // — consistently with every other journal-creating route in this
    // codebase — rejects with 409/PERIOD_LOCKED. 403 is reserved for the
    // separate DELETE/UNDO guard (assertFinancialPeriodOpen), which does not
    // apply here since nothing pre-existing is being altered or removed.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('Bill F: a forced durable-persistence failure returns a real error, never a false success', async () => {
    const vendor = await createVendor('Vendor-Bill-F');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fs.removeSync(tmp);
      fs.writeFileSync(tmp, 'not-a-directory-anymore');
      try {
        const res = await request(app).post('/api/vendor-bills').set(auth()).send({
          vendorId: vendor.id, billDate: '2048-01-05', allocations: [{ accountCode: '5100', amount: 100 }],
        });
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
// PART C — Payment A-F
// ═══════════════════════════════════════════════════════════════════════
describe('P0.7 — Payment: settles the AP liability, never re-expenses', () => {
  let vendor, billId;

  beforeAll(async () => {
    vendor = await createVendor('Vendor-Payment');
    const res = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-04-01', allocations: [{ accountCode: '5100', amount: 1000 }],
    });
    billId = res.body.bill.id;
  });

  test('Payment A: a partial payment reduces outstanding correctly (1,000 -> 700)', async () => {
    const res = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).send({ amount: 300, payDate: '2048-04-05', payAccount: '1100' });
    expect(res.status).toBe(200);
    expect(res.body.bill.outstandingAmount).toBeCloseTo(700, 3);
    expect(res.body.bill.status).toBe('PARTIALLY_PAID');
    const je = (await runAsTenantJe(res.body.payment.jeId));
    expect(je.lines.some(l => l.accountCode === vendor.accountId && l.debit === 300)).toBe(true);
    expect(je.lines.some(l => l.accountCode === '1100' && l.credit === 300)).toBe(true);
    expect(je.lines.some(l => l.accountCode === '5100')).toBe(false); // never re-expensed
  });

  test('Payment B: the final payment closes the bill (outstanding 0, status PAID)', async () => {
    const res = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).send({ amount: 700, payDate: '2048-04-10', payAccount: '1100' });
    expect(res.status).toBe(200);
    expect(res.body.bill.outstandingAmount).toBeCloseTo(0, 3);
    expect(res.body.bill.status).toBe('PAID');
  });

  test('Payment C: overpayment (beyond outstanding) is rejected', async () => {
    const res = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).send({ amount: 50, payDate: '2048-04-11', payAccount: '1100' });
    expect(res.status).toBe(400);
    // Bill already PAID -> either ALREADY... but our route doesn't special-case fully-paid pre-check besides outstanding math;
    // outstanding is 0 so any positive amount exceeds it.
    expect(['OVERPAYMENT']).toContain(res.body.code);
  });

  test('Payment D: a retried payment request with the same clientRef is idempotent, not duplicated', async () => {
    const vendor2 = await createVendor('Vendor-Payment-D');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor2.id, billDate: '2048-04-01', allocations: [{ accountCode: '5100', amount: 500 }],
    });
    const bill2 = billRes.body.bill.id;
    const first = await request(app).post(`/api/vendor-bills/${bill2}/pay`).set(auth()).send({ amount: 200, payDate: '2048-04-05', payAccount: '1100', clientRef: 'RETRY-KEY-1' });
    expect(first.status).toBe(200);
    const retry = await request(app).post(`/api/vendor-bills/${bill2}/pay`).set(auth()).send({ amount: 200, payDate: '2048-04-05', payAccount: '1100', clientRef: 'RETRY-KEY-1' });
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(true);
    let billState;
    await runAsTenant('default', async () => { billState = loadDB().vendorBills.find(b => b.id === bill2); });
    expect(billState.paidAmount).toBeCloseTo(200, 3); // FIXED: not 400 — the retry had zero additional financial effect
    expect(billState.payments.length).toBe(1);
  });

  test('Payment E: a payment dated into a locked period is rejected', async () => {
    const vendor3 = await createVendor('Vendor-Payment-E');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor3.id, billDate: '2048-05-01', allocations: [{ accountCode: '5100', amount: 400 }],
    });
    const bill3 = billRes.body.bill.id;
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2048-06', locked: true }).expect(200);
    const res = await request(app).post(`/api/vendor-bills/${bill3}/pay`).set(auth()).send({ amount: 100, payDate: '2048-06-15', payAccount: '1100' });
    // A payment posts a brand-new journal entry too, so — same reasoning as
    // Bill E — this is the CREATE-path guard (409/PERIOD_LOCKED), not the
    // DELETE/UNDO guard (403).
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
    let billState;
    await runAsTenant('default', async () => { billState = loadDB().vendorBills.find(b => b.id === bill3); });
    expect(billState.paidAmount).toBe(0); // rejected atomically
  });

  test('Payment F: a forced durable-persistence failure during payment is atomic — no partial state', async () => {
    const vendor4 = await createVendor('Vendor-Payment-F');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor4.id, billDate: '2048-04-01', allocations: [{ accountCode: '5100', amount: 300 }],
    });
    const bill4 = billRes.body.bill.id;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fs.removeSync(tmp);
      fs.writeFileSync(tmp, 'not-a-directory-anymore');
      try {
        const res = await request(app).post(`/api/vendor-bills/${bill4}/pay`).set(auth()).send({ amount: 100, payDate: '2048-04-05', payAccount: '1100' });
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

async function runAsTenantJe(jeId) {
  let je;
  await runAsTenant('default', async () => { je = loadDB().journalEntries.find(j => j.id === jeId); });
  return je;
}

// ═══════════════════════════════════════════════════════════════════════
// PART D — Credit / Cancellation A-C
// ═══════════════════════════════════════════════════════════════════════
describe('P0.7 — Cancellation: unpaid bill cancellation uses a reversal journal, never deletion', () => {
  test('Cancellation A: cancelling an unpaid bill produces a reversal journal (Dr AP / Cr Expense)', async () => {
    const vendor = await createVendor('Vendor-Cancel-A');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-07-01', allocations: [{ accountCode: '5100', amount: 600 }],
    });
    const bill = billRes.body.bill;
    const res = await request(app).post(`/api/vendor-bills/${bill.id}/cancel`).set(auth()).send({ reason: 'Cancellation A test' });
    expect(res.status).toBe(200);
    expect(res.body.bill.status).toBe('CANCELLED');
    expect(res.body.bill.outstandingAmount).toBeCloseTo(0, 3);

    const revJe = await runAsTenantJe(res.body.reversalJournalId);
    expect(revJe).toBeTruthy();
    expect(revJe.lines.some(l => l.accountCode === vendor.accountId && l.debit === 600)).toBe(true);
    expect(revJe.lines.some(l => l.accountCode === '5100' && l.credit === 600)).toBe(true);
  });

  test('Cancellation B: the ORIGINAL recognition journal is preserved (not deleted/rewritten) after cancellation', async () => {
    const vendor = await createVendor('Vendor-Cancel-B');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-07-01', allocations: [{ accountCode: '5100', amount: 400 }],
    });
    const bill = billRes.body.bill;
    await request(app).post(`/api/vendor-bills/${bill.id}/cancel`).set(auth()).send({ reason: 'x' }).expect(200);

    const originalJe = await runAsTenantJe(bill.journalId);
    expect(originalJe).toBeTruthy(); // FIXED premise: still exists, untouched
    expect(originalJe.lines.some(l => l.accountCode === '5100' && l.debit === 400)).toBe(true);
    let billState;
    await runAsTenant('default', async () => { billState = loadDB().vendorBills.find(b => b.id === bill.id); });
    expect(billState.cancellation.jeId).not.toBe(bill.journalId); // reversal is a SEPARATE journal, linked
  });

  test('Cancellation C: cancelling with a reversal date inside a locked period is rejected', async () => {
    const vendor = await createVendor('Vendor-Cancel-C');
    // Bill itself is dated in an OPEN period (2048-09) — only the
    // cancellation's own reversal date (explicitly supplied below) falls
    // into the locked period, isolating exactly what this test targets.
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-09-15', allocations: [{ accountCode: '5100', amount: 250 }],
    });
    const bill = billRes.body.bill;
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2048-08', locked: true }).expect(200);

    const res = await request(app).post(`/api/vendor-bills/${bill.id}/cancel`).set(auth()).send({ reason: 'x', date: '2048-08-20' });
    // Cancellation posts a brand-new reversal journal entry (postVendorBillCredit
    // -> appendJournalEntry), so — same reasoning as Bill E/Payment E — this is
    // the CREATE-path guard (409/PERIOD_LOCKED), not the DELETE/UNDO guard (403).
    // The bill's own original recognition journal is never touched or deleted.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');

    let billState;
    await runAsTenant('default', async () => { billState = loadDB().vendorBills.find(b => b.id === bill.id); });
    expect(billState.status).toBe('POSTED'); // rejected atomically — still active, not cancelled
    expect(billState.outstandingAmount).toBeCloseTo(250, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART C (cont'd) — Payment Reversal A-B
// ═══════════════════════════════════════════════════════════════════════
describe('P0.7 — Payment Reversal: restores AP balance, preserves original payment history', () => {
  let vendor, bill, paymentId;

  beforeAll(async () => {
    vendor = await createVendor('Vendor-PayRev');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-09-01', allocations: [{ accountCode: '5100', amount: 900 }],
    });
    bill = billRes.body.bill;
    const payRes = await request(app).post(`/api/vendor-bills/${bill.id}/pay`).set(auth()).send({ amount: 400, payDate: '2048-09-05', payAccount: '1100' });
    paymentId = payRes.body.payment.id;
  });

  test('Payment Reversal A: reversing a payment restores the AP outstanding balance', async () => {
    const before = await request(app).get('/api/vendor-bills').set(auth()).query({ vendorId: vendor.id });
    expect(before.body[0].outstandingAmount).toBeCloseTo(500, 3); // 900 - 400

    const res = await request(app).post(`/api/vendor-bills/${bill.id}/payments/${paymentId}/reverse`).set(auth()).send({ reverseDate: '2048-09-10' });
    expect(res.status).toBe(200);
    expect(res.body.bill.outstandingAmount).toBeCloseTo(900, 3); // FIXED: restored to full 900
    expect(res.body.bill.status).toBe('POSTED');
  });

  test('Payment Reversal B: the ORIGINAL payment journal is preserved; only a new reversal journal is added', async () => {
    const originalPayJe = await runAsTenantJe('JE-BILLPAY-' + bill.id + '-1');
    expect(originalPayJe).toBeTruthy(); // still exists
    let billState;
    await runAsTenant('default', async () => { billState = loadDB().vendorBills.find(b => b.id === bill.id); });
    const payment = billState.payments.find(p => p.id === paymentId);
    expect(payment.reversed).toBe(true);
    expect(payment.jeId).toBe(originalPayJe.id); // link intact, not rewritten
    const reversalJe = await runAsTenantJe(payment.reversalJeId);
    expect(reversalJe).toBeTruthy();
    expect(reversalJe.lines.some(l => l.accountCode === '1100' && l.debit === 400)).toBe(true);
    expect(reversalJe.lines.some(l => l.accountCode === vendor.accountId && l.credit === 400)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART G/H — Statement A-B
// ═══════════════════════════════════════════════════════════════════════
describe('P0.7 — Vendor Statement: chronological running balance', () => {
  test('Statement A: running balance is correct across opening + bill + payment', async () => {
    const vendor = await createVendor('Vendor-Statement-A');
    await request(app).post('/api/vendors').set(auth()).send({ id: vendor.id, openingBalance: 200, openingDate: '2048-01-01' }).expect(200);
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-10-01', allocations: [{ accountCode: '5100', amount: 500 }],
    });
    const bill = billRes.body.bill;
    await request(app).post(`/api/vendor-bills/${bill.id}/pay`).set(auth()).send({ amount: 300, payDate: '2048-10-05', payAccount: '1100' }).expect(200);

    const stmt = await request(app).get(`/api/vendors/${vendor.id}/statement`).set(auth());
    expect(stmt.status).toBe(200);
    expect(stmt.body.rows.length).toBe(3); // opening, bill, payment
    expect(stmt.body.rows[0].type).toBe('opening');
    expect(stmt.body.rows[0].runningBalance).toBeCloseTo(200, 3);
    expect(stmt.body.rows[1].type).toBe('bill');
    expect(stmt.body.rows[1].runningBalance).toBeCloseTo(700, 3); // 200 + 500
    expect(stmt.body.rows[2].type).toBe('payment');
    expect(stmt.body.rows[2].runningBalance).toBeCloseTo(400, 3); // 700 - 300
  });

  test('Statement B: the statement ending balance equals the vendor\'s AP outstanding', async () => {
    const vendor = await createVendor('Vendor-Statement-B');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-10-01', allocations: [{ accountCode: '5100', amount: 800 }],
    });
    await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/pay`).set(auth()).send({ amount: 250, payDate: '2048-10-05', payAccount: '1100' }).expect(200);

    const stmt = await request(app).get(`/api/vendors/${vendor.id}/statement`).set(auth());
    let vendorRecord;
    await runAsTenant('default', async () => { vendorRecord = loadDB().vendors.find(v => v.id === vendor.id); });
    const billsOutstanding = (await runAsTenantBills(vendor.id)).reduce((s, b) => s + b.outstandingAmount, 0);
    const expectedOutstanding = (parseFloat(vendorRecord.openingBalance) || 0) + billsOutstanding;
    expect(stmt.body.endingBalance).toBeCloseTo(expectedOutstanding, 3);
    expect(stmt.body.endingBalance).toBeCloseTo(550, 3); // 800 - 250
  });
});

async function runAsTenantBills(vendorId) {
  let bills;
  await runAsTenant('default', async () => { bills = loadDB().vendorBills.filter(b => b.vendorId === vendorId); });
  return bills;
}

// ═══════════════════════════════════════════════════════════════════════
// PART F — Aging A-D
// ═══════════════════════════════════════════════════════════════════════
describe('P0.7 — AP Aging: expanded to cover the unified AP model', () => {
  test('Aging A: multiple bills for the same vendor land in the correct aging buckets', async () => {
    const vendor = await createVendor('Vendor-Aging-A');
    const items = [
      { due: '2049-01-15', amount: 100 }, // 15 days before asOf -> current
      { due: '2048-12-15', amount: 200 }, // 46 days -> days30
      { due: '2048-11-15', amount: 300 }, // 76 days -> days60
      { due: '2048-09-15', amount: 400 }, // 137 days -> over90 (avoids 2048-08, locked by an earlier Cancellation-C test in this shared-tenant file)
    ];
    for (const it of items) {
      const res = await request(app).post('/api/vendor-bills').set(auth()).send({
        vendorId: vendor.id, billDate: it.due, dueDate: it.due, allocations: [{ accountCode: '5100', amount: it.amount }],
      });
      expect(res.status).toBe(200);
    }
    const aging = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-01-30' });
    const row = aging.body.rows.find(r => r.vendor === 'Vendor-Aging-A');
    expect(row.buckets.current).toBeCloseTo(100, 3);
    expect(row.buckets.days30).toBeCloseTo(200, 3);
    expect(row.buckets.days60).toBeCloseTo(300, 3);
    expect(row.buckets.over90).toBeCloseTo(400, 3);
    expect(row.total).toBeCloseTo(1000, 3);
  });

  test('Aging B: a partially-paid bill ages only its outstanding remainder', async () => {
    const vendor = await createVendor('Vendor-Aging-B');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2049-01-01', dueDate: '2049-01-01', allocations: [{ accountCode: '5100', amount: 800 }],
    });
    await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/pay`).set(auth()).send({ amount: 300, payDate: '2049-01-05', payAccount: '1100' }).expect(200);

    const aging = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-01-10' });
    const row = aging.body.rows.find(r => r.vendor === 'Vendor-Aging-B');
    expect(row.total).toBeCloseTo(500, 3); // 800 - 300, never the original 800
  });

  test('Aging C: a fully-paid bill is excluded from aging entirely', async () => {
    const vendor = await createVendor('Vendor-Aging-C');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2049-01-01', allocations: [{ accountCode: '5100', amount: 350 }],
    });
    await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/pay`).set(auth()).send({ amount: 350, payDate: '2049-01-05', payAccount: '1100' }).expect(200);

    const aging = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-01-10' });
    const row = aging.body.rows.find(r => r.vendor === 'Vendor-Aging-C');
    expect(row).toBeUndefined();
  });

  test('Aging D: a vendor opening liability is included correctly, aged from its opening date', async () => {
    const vendor = await createVendor('Vendor-Aging-D');
    await request(app).post('/api/vendors').set(auth()).send({ id: vendor.id, openingBalance: 650, openingDate: '2048-10-01' }).expect(200);

    const aging = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-01-10' });
    const row = aging.body.rows.find(r => r.vendor === 'Vendor-Aging-D');
    expect(row).toBeTruthy();
    expect(row.total).toBeCloseTo(650, 3);
    expect(row.items[0].source).toBe('vendor-opening');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Reconciliation A-B
// ═══════════════════════════════════════════════════════════════════════
describe('P0.7 — AP Reconciliation: subledger vs GL, honest not forced', () => {
  test('Reconciliation A: the AP subledger total reconciles exactly to the GL for clean, vendorBills-only data', async () => {
    const vendor = await createVendor('Vendor-Recon-A');
    await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2049-02-01', allocations: [{ accountCode: '5100', amount: 777 }],
    }).expect(200);

    const aging = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-02-10' });
    // Isolated check: this vendor's own row total must match its own GL
    // account balance exactly (delta-safe even amid the shared tenant's
    // cumulative history from earlier describe blocks).
    const row = aging.body.rows.find(r => r.vendor === 'Vendor-Recon-A');
    expect(row.total).toBeCloseTo(777, 3);
    // Global reconciliation flag is also expected true here since every
    // vendor bill in this whole file posts exclusively through
    // buildAndPostVendorBill()/postVendorBillCredit() — no ad-hoc
    // payMethod:'accrued' expense exists anywhere in this test file.
    expect(aging.body.reconciliation.reconciled).toBe(true);
    expect(aging.body.reconciliation.difference).toBeCloseTo(0, 3);
  });

  test('Reconciliation B: a legacy payMethod:\'accrued\' expense causes an honestly-reported (not hidden) difference', async () => {
    const before = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-02-15' });
    const subledgerBefore = before.body.reconciliation.subledgerTotal;
    const glBefore = before.body.reconciliation.glTotal;

    await request(app).post('/api/expenses').set(auth()).send({
      date: '2049-02-12', desc: 'Reconciliation B legacy accrued expense', cat: 'مصاريف عامة', amount: 123, payMethod: 'accrued',
    }).expect(200);

    const after = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-02-15' });
    // GL grew by 123 (real 2900 credit), but the AP subledger did NOT
    // (this expense never went through accruedExpenses[] or vendorBills[]) —
    // the difference must widen by exactly 123, reported honestly, not plugged.
    expect(after.body.reconciliation.subledgerTotal).toBeCloseTo(subledgerBefore, 3);
    expect(after.body.reconciliation.glTotal).toBeCloseTo(glBefore + 123, 3);
    expect(after.body.reconciliation.reconciled).toBe(false);
    expect(after.body.reconciliation.note).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Vendor / AP Workspace Upgrade — GET /api/ap-aging?vendorId= filter
// (T002/T004/T005 — additive, backward-compatible; see
// specs/001-vendor-ap-workspace/contracts/vendor-ap-workspace-api.md)
// Positioned after Reconciliation A/B deliberately: this shared-tenant
// file's AP-aging endpoint counts every currently-outstanding vendor
// bill regardless of its billDate vs. the query's asOf (a pre-existing,
// out-of-scope characteristic of GET /api/ap-aging, unrelated to and
// unchanged by this filter), while GL balances ARE asOf-filtered via
// buildBalanceMap() — so a bill dated after an earlier test's own asOf
// would otherwise inflate that earlier test's subledgerTotal without a
// matching glTotal change and break its reconciled:true assertion.
// Running after Reconciliation A/B (whose own asOf values are 2049-02-10
// / 2049-02-15) with this block's bills dated in 2049-03 avoids that
// collision entirely, without touching Reconciliation A/B's own dates
// or this block's.
// ═══════════════════════════════════════════════════════════════════════
describe('Vendor Workspace — AP Aging vendorId filter', () => {
  test('Filter A: ?vendorId= returns a single row identical to the corresponding row in the unfiltered response', async () => {
    const vendor = await createVendor('Vendor-AgingFilter-A');
    await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2049-03-01', dueDate: '2049-03-01', allocations: [{ accountCode: '5100', amount: 444 }],
    }).expect(200);

    const unfiltered = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-03-10' });
    const expectedRow = unfiltered.body.rows.find(r => r.vendor === 'Vendor-AgingFilter-A');
    expect(expectedRow).toBeTruthy();

    const filtered = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-03-10', vendorId: vendor.id });
    expect(filtered.status).toBe(200);
    expect(filtered.body.rows.length).toBe(1);
    expect(filtered.body.rows[0]).toEqual(expectedRow);
  });

  test('Filter A (finding F6): a vendor with outstanding AP but zero overdue bills — current bucket equals the full outstanding total, overdue buckets zero', async () => {
    const vendor = await createVendor('Vendor-AgingFilter-F6');
    await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2049-03-05', dueDate: '2049-03-05', allocations: [{ accountCode: '5100', amount: 250 }],
    }).expect(200);

    const filtered = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-03-10', vendorId: vendor.id });
    const row = filtered.body.rows[0];
    expect(row.buckets.current).toBeCloseTo(250, 3);
    expect(row.buckets.days30).toBe(0);
    expect(row.buckets.days60).toBe(0);
    expect(row.buckets.over90).toBe(0);
  });

  test('Filter A (finding H3): grandTotal and reconciliation stay firm-wide under the vendorId filter, for the same asOf date', async () => {
    const vendor = await createVendor('Vendor-AgingFilter-H3');
    await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2049-03-06', dueDate: '2049-03-06', allocations: [{ accountCode: '5100', amount: 99 }],
    }).expect(200);

    const unfiltered = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-03-10' });
    const filtered = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-03-10', vendorId: vendor.id });

    expect(filtered.body.grandTotal).toBeCloseTo(unfiltered.body.grandTotal, 3);
    expect(filtered.body.reconciliation).toEqual(unfiltered.body.reconciliation);
  });

  test('Regression (T004): omitting vendorId still returns every vendor\'s row, unfiltered, with the same response shape as before', async () => {
    const vendorX = await createVendor('Vendor-AgingFilter-RegX');
    const vendorY = await createVendor('Vendor-AgingFilter-RegY');
    await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendorX.id, billDate: '2049-03-07', dueDate: '2049-03-07', allocations: [{ accountCode: '5100', amount: 60 }],
    }).expect(200);
    await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendorY.id, billDate: '2049-03-07', dueDate: '2049-03-07', allocations: [{ accountCode: '5100', amount: 70 }],
    }).expect(200);

    const unfiltered = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-03-10' });
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.rows.some(r => r.vendor === 'Vendor-AgingFilter-RegX')).toBe(true);
    expect(unfiltered.body.rows.some(r => r.vendor === 'Vendor-AgingFilter-RegY')).toBe(true);
    expect(Object.keys(unfiltered.body).sort()).toEqual(['asOf', 'grandTotal', 'reconciliation', 'rows'].sort());
  });

  test('Filter B (T005): an unknown vendorId returns a safe, empty, non-erroring result', async () => {
    const filtered = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-03-10', vendorId: 'ven-does-not-exist' });
    expect(filtered.status).toBe(200);
    expect(filtered.body.rows).toEqual([]);
  });

  test('Filter B (T005): a vendorId with no AP activity at all returns a safe, empty, non-erroring result', async () => {
    const vendor = await createVendor('Vendor-AgingFilter-NoActivity');
    const filtered = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-03-10', vendorId: vendor.id });
    expect(filtered.status).toBe(200);
    expect(filtered.body.rows).toEqual([]);
  });

  test('T025: vendor-level aging totals shown in the workspace equal that vendor\'s row in the firm-wide AP aging report', async () => {
    const vendor = await createVendor('Vendor-AgingFilter-T025');
    await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2049-03-08', dueDate: '2049-03-08', allocations: [{ accountCode: '5100', amount: 333 }],
    }).expect(200);

    const firmWide = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-03-10' });
    const firmWideRow = firmWide.body.rows.find(r => r.vendor === 'Vendor-AgingFilter-T025');
    const workspace = await request(app).get('/api/ap-aging').set(auth()).query({ asOf: '2049-03-10', vendorId: vendor.id });
    // T026's workspace aging section renders workspace.body.rows[0] as-is —
    // this must be byte-for-byte the same row the firm-wide report shows.
    expect(workspace.body.rows[0]).toEqual(firmWideRow);
    expect(workspace.body.rows[0].total).toBeCloseTo(333, 3);
    expect(workspace.body.rows[0].buckets).toEqual(firmWideRow.buckets);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RBAC A-B / Audit A-B / Tenant A
// ═══════════════════════════════════════════════════════════════════════
describe('P0.7 — RBAC, Audit, Tenant Isolation', () => {
  test('RBAC A: a role without vendors:add permission cannot create a supplier bill', async () => {
    const vendor = await createVendor('Vendor-RBAC-A');
    const res = await request(app).post('/api/vendor-bills').set(auth(recepToken)).send({
      vendorId: vendor.id, billDate: '2049-03-01', allocations: [{ accountCode: '5100', amount: 100 }],
    });
    expect(res.status).toBe(403);
  });

  test('RBAC B: a role without vendors:edit permission cannot pay a vendor bill', async () => {
    const vendor = await createVendor('Vendor-RBAC-B');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2049-03-01', allocations: [{ accountCode: '5100', amount: 100 }],
    });
    const res = await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/pay`).set(auth(recepToken)).send({ amount: 50, payAccount: '1100' });
    expect(res.status).toBe(403);
  });

  test('Audit A: posting a bill writes an audit event', async () => {
    const vendor = await createVendor('Vendor-Audit-A');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2049-03-01', allocations: [{ accountCode: '5100', amount: 321 }],
    });
    let auditEvent;
    await runAsTenant('default', async () => {
      auditEvent = loadDB().auditLog.find(e => e.action === 'vendor_bill.posted' && e.resourceId === billRes.body.bill.id);
    });
    expect(auditEvent).toBeTruthy();
    expect(auditEvent.after.amount).toBeCloseTo(321, 3);
  });

  test('Audit B: payment and payment-reversal both write audit events', async () => {
    const vendor = await createVendor('Vendor-Audit-B');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2049-03-01', allocations: [{ accountCode: '5100', amount: 200 }],
    });
    const payRes = await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/pay`).set(auth()).send({ amount: 200, payAccount: '1100' });
    await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/payments/${payRes.body.payment.id}/reverse`).set(auth()).send({}).expect(200);

    let payAudit, revAudit;
    await runAsTenant('default', async () => {
      const db = loadDB();
      payAudit = db.auditLog.find(e => e.action === 'vendor_bill.payment_posted' && e.resourceId === billRes.body.bill.id);
      revAudit = db.auditLog.find(e => e.action === 'vendor_bill.payment_reversed' && e.resourceId === billRes.body.bill.id);
    });
    expect(payAudit).toBeTruthy();
    expect(revAudit).toBeTruthy();
  });

  test('Tenant A: Tenant A\'s AP bills never leak into Tenant B\'s vendor-bills list', async () => {
    await runAsTenant('tenant-p07-b', async () => {
      await warmTenantCache('tenant-p07-b');
      const db = loadDB();
      db.users = [{ id: 'usr-tb', username: 'owner-tb', email: 'tb@test.com', passwordHash: hash('OwnerTB1!'), role: 'admin', fullName: 'Owner TB', active: true, createdAt: new Date().toISOString(), lastLogin: null }];
      db.roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
      db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
      db.vendors = []; db.vendorBills = []; db.journalEntries = []; db.lockedPeriods = {};
      saveDB(db);
    });
    const loginB = await request(app).post('/api/auth/login').send({ username: 'owner-tb', password: 'OwnerTB1!', tenantId: 'tenant-p07-b' });
    expect(loginB.status).toBe(200);
    const tokenB = loginB.body.token;

    const vendorDefault = await createVendor('Vendor-Tenant-A-Only');
    await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendorDefault.id, billDate: '2049-04-01', allocations: [{ accountCode: '5100', amount: 999 }],
    }).expect(200);

    const listB = await request(app).get('/api/vendor-bills').set(auth(tokenB));
    expect(listB.status).toBe(200);
    expect(listB.body.length).toBe(0); // FIXED-behavior-confirmed: tenant B sees none of tenant A's bills
    const vendorsB = await request(app).get('/api/vendors').set(auth(tokenB));
    expect(vendorsB.body.map(v => v.name)).not.toContain('Vendor-Tenant-A-Only');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Regression A-B
// ═══════════════════════════════════════════════════════════════════════
describe('P0.7 — Regression: P0.6A and P0.6B scenarios remain correct', () => {
  test('Regression A: the P0.6A independent TB/IS/BS/CF scenario remains correct', async () => {
    const before = await request(app).get('/api/financial-statements?period=month&year=2050&month=1').set(auth());
    const bsBefore = before.body.balanceSheet;

    await request(app).post('/api/opening-balance').set(auth()).send({
      date: '2050-01-01', balances: [{ code: '1100', debit: 2000, credit: 0 }, { code: '3100', debit: 0, credit: 2000 }],
    }).expect(200);
    await request(app).post('/api/journal').set(auth()).send({
      date: '2050-01-10', desc: 'Regression A revenue',
      lines: [{ accountCode: '1100', debit: 800, credit: 0 }, { accountCode: '4100', debit: 0, credit: 800 }],
    }).expect(200);
    await request(app).post('/api/journal').set(auth()).send({
      date: '2050-01-15', desc: 'Regression A expense',
      lines: [{ accountCode: '5100', debit: 300, credit: 0 }, { accountCode: '1100', debit: 0, credit: 300 }],
    }).expect(200);
    await request(app).post('/api/assets').set(auth()).send({
      name: 'Regression A asset', category: 'equipment', purchaseDate: '2050-01-01',
      cost: 1200, usefulLife: 1, salvageValue: 0, payMethod: 'cash', coaAccount: '1510',
    }).expect(200);
    const dep = await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2050-01' });
    expect(dep.body.totalDep).toBeCloseTo(100, 3);

    const tb = await request(app).get('/api/trial-balance?period=all').set(auth());
    expect(tb.body.isBalanced).toBe(true);

    const fsRes = await request(app).get('/api/financial-statements?period=month&year=2050&month=1').set(auth());
    const is = fsRes.body.incomeStatement, bs = fsRes.body.balanceSheet, cf = fsRes.body.cashFlow;
    expect(is.revenue.total).toBeCloseTo(800, 3);
    expect(is.operatingExpenses.total).toBeCloseTo(300, 3);
    expect(is.depreciation).toBeCloseTo(100, 3);
    expect(is.netProfit).toBeCloseTo(400, 3);
    const assetsDelta = bs.assets.total - bsBefore.assets.total;
    const liabEquityDelta = bs.totalLiabAndEquity - bsBefore.totalLiabAndEquity;
    expect(assetsDelta).toBeCloseTo(2400, 3);
    expect(assetsDelta).toBeCloseTo(liabEquityDelta, 3);
    expect(cf.operating + cf.investing + cf.financing).toBeCloseTo(cf.netChange, 3);
  });

  test('Regression B: P0.6B doctor commission / EOS / close / anomaly behavior remains correct', async () => {
    // Doctor commission liability (P6-030)
    await request(app).post('/api/doctors').set(auth()).send({
      doctors: [{ name: 'Dr-P07-Regression', target: 0, commission: 20, lab: 0, insurance: 0 }],
    }).expect(200);
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.paymentsData.push({ id: 'PAY-P07-REG', doctor: 'Dr-P07-Regression', date: '2050-02-15', total: 5000 });
      saveDB(db);
    });
    const recalc = await request(app).post('/api/config/recalc-commissions').set(auth());
    expect(recalc.status).toBe(200);
    let commRecord;
    await runAsTenant('default', async () => {
      commRecord = loadDB().commissionHistory.find(c => c.doctor === 'Dr-P07-Regression' && c.month === '2050-02');
    });
    expect(commRecord.commission).toBeCloseTo(1000, 3); // 20% of 5000
    expect(commRecord.recognizedAmount).toBeCloseTo(1000, 3);

    // EOS canonical formula (P6-034)
    const emp = await request(app).post('/api/employees').set(auth()).send({
      name: 'EMP-P07-Regression', basicSalary: 1000, hireDate: (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 8); return d.toISOString().slice(0, 10); })(),
    });
    expect(emp.status).toBe(200);
    const eosRun = await request(app).post('/api/payroll/eos-run').set(auth()).send({ month: '2050-02' });
    const rec = eosRun.body.details.find(d => d.name === 'EMP-P07-Regression');
    expect(rec.accumulated).toBeLessThan(6000); // FIXED (P6-034): nowhere near the old buggy ~8,000 for 8 years
    expect(rec.accumulated).toBeGreaterThan(5000);

    // Anomaly engine real-amount detection (P6-017)
    const XLSX = require('xlsx');
    const ws = XLSX.utils.json_to_sheet([{ 'التاريخ': '2050-02-20', 'الوصف': 'Regression B anomaly', 'المبلغ (د.ك)': 900, 'رقم حساب المدين': '5100', 'رقم حساب الدائن': '1100' }]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await request(app).post('/api/import/expenses').set(auth()).attach('file', buf, 'exp.xlsx').expect(200);
    const anomalies = await request(app).get('/api/anomalies').set(auth());
    let importedJe;
    await runAsTenant('default', async () => { importedJe = loadDB().journalEntries.find(j => j.source === 'import-expenses' && j.date === '2050-02-20'); });
    const anomEntry = anomalies.body.anomalies.find(a => a.je.id === importedJe.id);
    expect(anomEntry).toBeTruthy();
    expect(anomEntry.je.totalDebit).toBeCloseTo(900, 3); // FIXED: not 0

    // Unified close mechanism (P6-044)
    const closeRes = await request(app).post('/api/close/run-all').set(auth()).send({
      month: '2050-02', options: { depreciation: false, pifss: false, eos: false, closing: false, lock: false },
    });
    expect(closeRes.status).toBe(200);
  });
});

