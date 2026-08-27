// R5A — Final Acceptance Gate: targeted regression tests closing test-
// coverage gaps found by the R5A independent re-verification workflow.
//
// R5A re-checked all 14 R5/R5-adversarial-review fixes from fresh eyes and
// confirmed every one is present, correct, and free of any contradictory
// code path — but found that 7 of the 14 had ZERO automated regression
// coverage at all, and 2 more (the close-guard's actual blocking path, the
// journal-tolerance boundary case) were only ever exercised indirectly.
// This is not new discovery — every behavior asserted below was already
// independently verified correct via code review and/or live curl during
// R5 itself; these tests just lock that verified behavior in so a future,
// unrelated change can't silently regress any of it without CI catching it.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'r5a-acceptance-regression-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-r5a-'));
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

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

// ═══════════════════════════════════════════════════════════════════════
// Gap 1 — journal balance tolerance boundary (NEW-R5-ADV-JOURNAL-TOLERANCE-01)
// Existing tests/journal-integrity.test.js Test B only proves a GROSS (5
// KWD) imbalance is rejected. It never exercised the actual bug: an entry
// off by 0.001-0.005 KWD, which the OLD tolerance silently accepted.
// ═══════════════════════════════════════════════════════════════════════
describe('R5A Gap 1 — journal balance tolerance boundary (NEW-R5-ADV-JOURNAL-TOLERANCE-01)', () => {
  test('a 0.003 KWD imbalance (inside the old 0.005 tolerance, outside the new 0.001) is rejected', async () => {
    const res = await request(app).post('/api/journal').set(auth()).send({
      date: '2090-01-05', desc: 'R5A boundary test',
      lines: [{ accountCode: '1100', debit: 10.003, credit: 0 }, { accountCode: '5900', debit: 0, credit: 10.000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNBALANCED');
  });

  test('a genuinely balanced entry still posts normally (no false-positive rejection)', async () => {
    const res = await request(app).post('/api/journal').set(auth()).send({
      date: '2090-01-06', desc: 'R5A boundary control',
      lines: [{ accountCode: '1100', debit: 10, credit: 0 }, { accountCode: '5900', debit: 0, credit: 10 }],
    });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Gap 2 — empty-period close guard's own blocking path (NEW-R5-ADV-CLOSE-GUARD-01)
// All existing usages of this guard pass confirmEmptyClose:true to BYPASS
// it for an unrelated purpose. None proves the guard actually blocks on
// its own when that flag is absent.
// ═══════════════════════════════════════════════════════════════════════
describe('R5A Gap 2 — empty-period close guard blocks by default (NEW-R5-ADV-CLOSE-GUARD-01)', () => {
  test('closing a genuinely virgin period WITHOUT confirmEmptyClose is rejected, with zero mutation', async () => {
    const res = await request(app).post('/api/close/run-all').set(auth()).send({ month: '2091-03' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMPTY_PERIOD_CLOSE_BLOCKED');

    let db;
    await runAsTenant('default', async () => { db = loadDB(); });
    expect((db.journalEntries || []).some(j => (j.date || '').startsWith('2091-03'))).toBe(false);
    expect((db.lockedPeriods || {})['2091-03']).toBeFalsy();
  });

  test('the same virgin period WITH confirmEmptyClose:true is allowed through', async () => {
    const res = await request(app).post('/api/close/run-all').set(auth()).send({
      month: '2091-03', options: { depreciation: false, pifss: false, eos: false, closing: false, lock: false, confirmEmptyClose: true },
    });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Gap 3 — GET /api/ar-aging (NEW-R5-ADV-AR-AGING-RECON-01)
// Zero prior automated coverage of this endpoint existed at all.
// ═══════════════════════════════════════════════════════════════════════
describe('R5A Gap 3 — GET /api/ar-aging excludes cancelled claims and self-reconciles (NEW-R5-ADV-AR-AGING-RECON-01)', () => {
  test('a cancelled claim is excluded from the aging total, and the endpoint self-reconciles against GL 1130', async () => {
    const pending = await request(app).post('/api/insurance-claims').set(auth()).send({
      company: 'R5A Insurance Co', claimDate: '2092-01-05', amount: 500,
    });
    expect(pending.status).toBe(200);

    const toCancel = await request(app).post('/api/insurance-claims').set(auth()).send({
      company: 'R5A Insurance Co', claimDate: '2092-01-06', amount: 300,
    });
    expect(toCancel.status).toBe(200);
    const cancelRes = await request(app).delete(`/api/insurance-claims/${toCancel.body.claim.id}`).set(auth());
    expect(cancelRes.status).toBe(200);

    const aging = await request(app).get('/api/ar-aging').set(auth());
    expect(aging.status).toBe(200);
    expect(aging.body.grandTotal).toBeCloseTo(500, 2); // the cancelled 300 must NOT appear
    expect(aging.body.reconciliation).toBeTruthy();
    expect(aging.body.reconciliation.reconciled).toBe(true);
    expect(aging.body.reconciliation.difference).toBeLessThan(0.005);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Gap 4 — empty-body create rejection (NEW-R5-ADV-EMPTY-CREATE-01)
// Zero prior automated coverage existed for any of the three routes.
// ═══════════════════════════════════════════════════════════════════════
describe('R5A Gap 4 — empty-body create is rejected, partial update is not (NEW-R5-ADV-EMPTY-CREATE-01)', () => {
  test('POST /api/vendors {} is rejected', async () => {
    const res = await request(app).post('/api/vendors').set(auth()).send({});
    expect(res.status).toBe(400);
  });

  test('POST /api/employees {} is rejected', async () => {
    const res = await request(app).post('/api/employees').set(auth()).send({});
    expect(res.status).toBe(400);
  });

  test('POST /api/inv/items {} is rejected', async () => {
    const res = await request(app).post('/api/inv/items').set(auth()).send({});
    expect(res.status).toBe(400);
  });

  test('a partial update of an EXISTING employee (no name field re-sent) is still allowed', async () => {
    const create = await request(app).post('/api/employees').set(auth()).send({ name: 'R5A Emp', basicSalary: 300 });
    expect(create.status).toBe(200);
    const list = await request(app).get('/api/employees').set(auth());
    const emp = list.body.find(e => e.name === 'R5A Emp');
    expect(emp).toBeTruthy();

    const update = await request(app).post('/api/employees').set(auth()).send({ id: emp.id, basicSalary: 350 });
    expect(update.status).toBe(200);
    const listAfter = await request(app).get('/api/employees').set(auth());
    const empAfter = listAfter.body.find(e => e.id === emp.id);
    expect(empAfter.basicSalary).toBe(350);
    expect(empAfter.name).toBe('R5A Emp'); // untouched, not wiped by the update
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Gap 5 — negative-cash warning (NEW-R5-ADV-NEGATIVE-CASH-WARNING-01)
// Zero prior automated coverage of the `warning` field existed, and no
// existing test set up a scenario where the paid account actually goes
// negative.
// ═══════════════════════════════════════════════════════════════════════
describe('R5A Gap 5 — vendor-bill cash payment surfaces a non-blocking negative-balance warning (NEW-R5-ADV-NEGATIVE-CASH-WARNING-01)', () => {
  test('paying a bill from account 1100 with no prior cash deposit succeeds AND carries a warning', async () => {
    const vendor = await request(app).post('/api/vendors').set(auth()).send({ name: 'R5A Vendor', phone: '000' });
    expect(vendor.status).toBe(200);
    const bill = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.body.vendor.id, billDate: '2093-01-05', billNumber: 'R5A-INV-001',
      description: 'R5A negative-cash test', allocations: [{ accountCode: '5100', amount: 100, desc: 'expense' }],
    });
    expect(bill.status).toBe(200);

    // Fresh DB, account 1100 opens at 0 — any cash payment drives it negative immediately.
    const pay = await request(app).post(`/api/vendor-bills/${bill.body.bill.id}/pay`).set(auth()).send({
      amount: 100, payDate: '2093-01-06', payAccount: '1100',
    });
    expect(pay.status).toBe(200); // non-blocking: the payment itself must still succeed
    expect(pay.body.success).toBe(true);
    expect(pay.body.warning).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Gap 6 — forgot-password enumeration (NEW-R5-ADV-FORGOT-PW-ENUM-01)
// Zero prior automated coverage existed anywhere in the repo.
// ═══════════════════════════════════════════════════════════════════════
describe('R5A Gap 6 — POST /api/auth/forgot gives identical responses for real vs fake emails (NEW-R5-ADV-FORGOT-PW-ENUM-01)', () => {
  test('a real registered email and a nonexistent email get byte-identical generic responses (SMTP unconfigured)', async () => {
    const real = await request(app).post('/api/auth/forgot').send({ email: 'admin@test.com' });
    const fake = await request(app).post('/api/auth/forgot').send({ email: 'definitely-nobody@nowhere.test' });
    expect(real.status).toBe(fake.status);
    expect(real.body).toEqual(fake.body);
    expect(real.body.success).toBe(true); // generic "if registered you'll get an email" shape, not a distinguishable error
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Gap 7 — audit-log resourceId filter (NEW-R5-ADV-AUDIT-RESOURCEID-01)
// Existing rbac-and-audit.test.js checks resourceId on raw stored records,
// never via the actual HTTP query-param filter this fix wired up.
// ═══════════════════════════════════════════════════════════════════════
describe('R5A Gap 7 — GET /api/audit-log?resourceId= actually filters (NEW-R5-ADV-AUDIT-RESOURCEID-01)', () => {
  test('filtering by one employee\'s resourceId excludes another employee\'s audit events', async () => {
    const empA = await request(app).post('/api/employees').set(auth()).send({ name: 'R5A Audit Emp A', basicSalary: 200 });
    expect(empA.status).toBe(200);
    const empB = await request(app).post('/api/employees').set(auth()).send({ name: 'R5A Audit Emp B', basicSalary: 200 });
    expect(empB.status).toBe(200);
    const list = await request(app).get('/api/employees').set(auth());
    const idA = list.body.find(e => e.name === 'R5A Audit Emp A').id;
    const idB = list.body.find(e => e.name === 'R5A Audit Emp B').id;

    const filtered = await request(app).get('/api/audit-log').set(auth()).query({ resourceType: 'employee', resourceId: idA });
    expect(filtered.status).toBe(200);
    expect(filtered.body.logs.length).toBeGreaterThan(0);
    expect(filtered.body.logs.every(l => l.resourceId === idA)).toBe(true);
    expect(filtered.body.logs.some(l => l.resourceId === idB)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Gap 8 — P&L date-range validation (NEW-R5-ADV-PNL-DATERANGE-01)
// Zero prior automated coverage of the new validation branches existed.
// ═══════════════════════════════════════════════════════════════════════
describe('R5A Gap 8 — GET /api/reports/pnl rejects reversed/garbage date ranges (NEW-R5-ADV-PNL-DATERANGE-01)', () => {
  test('a reversed range (from > to) is rejected with 400', async () => {
    const res = await request(app).get('/api/reports/pnl').set(auth()).query({ from: '2090-03-31', to: '2090-01-01' });
    expect(res.status).toBe(400);
  });

  test('a non-date garbage string is rejected with 400', async () => {
    const res = await request(app).get('/api/reports/pnl').set(auth()).query({ from: 'notadate', to: 'alsobad' });
    expect(res.status).toBe(400);
  });

  test('a valid ordered range still works (no false-positive rejection)', async () => {
    const res = await request(app).get('/api/reports/pnl').set(auth()).query({ from: '2090-01-01', to: '2090-01-31' });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Gap 9 — malformed JSON returns 400, not 500 (NEW-R5-ADV-MALFORMED-JSON-01)
// Zero prior automated coverage existed (the similarly-named test in
// production-hardening.test.js exercises scripts/restore.js's local
// JSON.parse, an unrelated code path).
// ═══════════════════════════════════════════════════════════════════════
describe('R5A Gap 9 — malformed JSON in a request body returns 400 (NEW-R5-ADV-MALFORMED-JSON-01)', () => {
  test('a broken JSON body returns 400 with the expected Arabic message, not a generic 500', async () => {
    const res = await request(app)
      .post('/api/vendors')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{malformed');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('صيغة JSON غير صالحة في جسم الطلب');
  });
});
