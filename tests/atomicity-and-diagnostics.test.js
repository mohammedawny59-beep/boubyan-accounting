// P0.3 — Transaction Atomicity & Historical Ledger Reconciliation Audit.
// Real Express app + Supertest throughout; no re-implemented route logic.
//
// Safety: DB_FILE_ONLY=true (MongoDB never touched), fresh os.tmpdir() per
// run, removed in afterAll(). No production/real tenant data anywhere here.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-3-atomicity-test-secret';
process.env.NODE_ENV     = 'test';

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-atomicity-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB, warmTenantCache } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [{
      id: 'usr-admin', username: 'admin', email: 'admin@clinic.com',
      passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير',
      active: true, createdAt: new Date().toISOString(), lastLogin: null,
    }],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [],
    chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: { name: 'عيادة الاختبار' }, scheduleConfig: {},
    vouchers: [], cashReconciliation: [], insuranceClaims: [], payroll: [],
    employees: [], fixedAssets: [], assets: [], budget: {}, auditLog: [],
    accruedExpenses: [], journalMappings: [], doctorExpenses: [], lockedPeriods: {},
  };
}

let token;
const OPEN_DATE  = '2032-05-15';
const OPEN_MONTH = '2032-05';
const LOCK_MONTH = '2032-02';
const LOCK_DATE  = '2032-02-10';

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
  token = login.body.token;
  await request(app).post('/api/period-lock').set('Authorization', `Bearer ${token}`).send({ period: LOCK_MONTH, locked: true });
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

function auth(req) { return req.set('Authorization', `Bearer ${token}`); }
async function journalCount() {
  let n; await runAsTenant('default', async () => { n = (loadDB().journalEntries || []).length; }); return n;
}

describe('P0.3 — Atomicity Test A: insurance claim', () => {
  test('a rejected "received" posting leaves the claim and the journal completely unchanged', async () => {
    const create = await auth(request(app).post('/api/insurance-claims')).send({
      company: 'Test Co', claimDate: OPEN_DATE, amount: 100,
    });
    expect(create.status).toBe(200);
    const claimId = create.body.claim.id;
    const before = await journalCount();

    const fail = await auth(request(app).put(`/api/insurance-claims/${claimId}`)).send({
      status: 'received', receivedDate: LOCK_DATE, receivedAmount: 100,
    });
    expect(fail.status).toBe(409);

    await runAsTenant('default', async () => {
      const db = loadDB();
      const claim = db.insuranceClaims.find(c => c.id === claimId);
      expect(claim.status).toBe('pending');       // unchanged
      expect(claim.receivedAmount).toBeUndefined(); // never set
      expect((db.journalEntries || []).length).toBe(before);
    });
  });
});

describe('P0.3 — Atomicity Test B: payroll status/payment', () => {
  test('a rejected payment posting leaves payroll status and journal unchanged', async () => {
    const create = await auth(request(app).post('/api/payroll')).send({
      month: OPEN_MONTH,
      entries: [{ name: 'Emp B', role: 'admin', basicSalary: 200, allowances: 0, deductions: 0 }],
    });
    expect(create.status).toBe(200);
    const payId = create.body.record.id;
    const before = await journalCount();

    const fail = await auth(request(app).put(`/api/payroll/${payId}/status`)).send({
      status: 'paid', paidDate: LOCK_DATE,
    });
    expect(fail.status).toBe(409);

    await runAsTenant('default', async () => {
      const db = loadDB();
      const rec = db.payroll.find(p => p.id === payId);
      expect(rec.status).toBe('pending');           // unchanged
      expect(rec.paymentJeId).toBeUndefined();       // never set
      expect((db.journalEntries || []).length).toBe(before);
    });
  });

  test('a rejected payroll EDIT (PUT /api/payroll/:id) leaves the original accrual journal entry intact', async () => {
    // R3 — P6-036 made payroll month uniqueness a real, enforced domain
    // guard: OPEN_MONTH was already claimed by the previous test in this
    // same describe block — a distinct, otherwise-unused month is needed
    // here since this test creates its OWN independent payroll record.
    const create = await auth(request(app).post('/api/payroll')).send({
      month: '2032-08',
      entries: [{ name: 'Emp B2', role: 'admin', basicSalary: 150, allowances: 0, deductions: 0 }],
    });
    const payId = create.body.record.id;
    const originalAccrualId = create.body.record.accrualJeId;

    const fail = await auth(request(app).put(`/api/payroll/${payId}`)).send({
      month: LOCK_MONTH, // forces the rebuilt accrual entry into a locked period
      entries: [{ name: 'Emp B2', role: 'admin', basicSalary: 999, allowances: 0, deductions: 0 }],
    });
    expect(fail.status).toBe(409);

    await runAsTenant('default', async () => {
      const db = loadDB();
      const rec = db.payroll.find(p => p.id === payId);
      expect(rec.month).toBe('2032-08'); // still the original month, not overwritten
      expect((db.journalEntries || []).some(j => j.id === originalAccrualId)).toBe(true); // old JE still present
    });
  });
});

describe('P0.3 — Atomicity Test C: asset creation', () => {
  test('a rejected asset-purchase posting means the asset itself was never retained', async () => {
    const before = await journalCount();
    let assetsBefore;
    await runAsTenant('default', async () => { assetsBefore = (loadDB().fixedAssets || []).length; });

    const fail = await auth(request(app).post('/api/assets')).send({
      name: 'Rejected Asset', cost: 500, purchaseDate: LOCK_DATE, payMethod: 'cash',
    });
    expect(fail.status).toBe(409);

    await runAsTenant('default', async () => {
      const db = loadDB();
      expect((db.fixedAssets || []).length).toBe(assetsBefore); // asset NOT retained
      expect((db.fixedAssets || []).some(a => a.name === 'Rejected Asset')).toBe(false);
      expect((db.journalEntries || []).length).toBe(before);
    });
  });
});

describe('P0.3 — Atomicity Test D: inventory', () => {
  test('a rejected inventory posting leaves stock quantity and movement history unchanged', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.invItems = db.invItems || [];
      db.invItems.push({ id: 'ITEM-D', name: 'Test Item D', qty: 10, cost: 1 });
      saveDB(db);
    });
    const before = await journalCount();
    let movementsBefore;
    await runAsTenant('default', async () => { movementsBefore = (loadDB().invMovements || []).length; });

    const fail = await auth(request(app).post('/api/inv/operation')).send({
      type: 'purchase', date: LOCK_DATE, payAccount: '1100',
      lines: [{ itemId: 'ITEM-D', qty: 5, cost: 2 }],
    });
    expect(fail.status).toBe(409);

    await runAsTenant('default', async () => {
      const db = loadDB();
      const item = db.invItems.find(i => i.id === 'ITEM-D');
      expect(item.qty).toBe(10); // unchanged — the +5 purchase never applied
      expect((db.invMovements || []).length).toBe(movementsBefore); // no orphan movement record
      expect((db.journalEntries || []).length).toBe(before);
    });
  });
});

describe('P0.3 — Atomicity Test E: accrued expense payment', () => {
  test('a rejected installment payment leaves paid/remaining state and journal unchanged', async () => {
    const create = await auth(request(app).post('/api/accrued-expenses')).send({
      description: 'Test Accrual E', amount: 100, month: OPEN_MONTH, accountCode: '5900',
    });
    expect(create.status).toBe(200);
    const itemId = create.body.item.id;
    const before = await journalCount();

    const fail = await auth(request(app).post(`/api/accrued-expenses/${itemId}/pay`)).send({
      amount: 40, payDate: LOCK_DATE, payAccount: '1100',
    });
    expect(fail.status).toBe(409);

    await runAsTenant('default', async () => {
      const db = loadDB();
      const item = db.accruedExpenses.find(a => a.id === itemId);
      expect(item.paidAmount).toBe(0);           // unchanged
      expect(item.status).toBe('pending');        // unchanged
      expect((item.payments || []).length).toBe(0); // no installment recorded
      expect((db.journalEntries || []).length).toBe(before);
    });
  });
});

describe('P0.3 — Additional confirmed risks beyond the P0.2-reported list', () => {
  test('vendor opening-balance: a rejected posting leaves vendor.openingBalance at its previous value', async () => {
    const createVendor = await auth(request(app).post('/api/vendors')).send({ name: 'Test Vendor F' });
    const vendorId = createVendor.body.vendor.id;

    // First, a SUCCESSFUL opening balance in the open period.
    const ok = await auth(request(app).post('/api/vendors')).send({ id: vendorId, name: 'Test Vendor F', openingBalance: 50, openingDate: OPEN_DATE });
    expect(ok.status).toBe(200);

    // Now attempt to change it via a locked-period date — must be rejected AND leave the balance at 50.
    await runAsTenant('default', async () => {
      const db = loadDB();
      const v = db.vendors.find(x => x.id === vendorId);
      expect(v.openingBalance).toBe(50);
    });
    // setVendorOpening fails closed silently (used for self-heal too) rather than throwing through
    // POST /api/vendors — confirm via direct unit-style call through the same route with a locked date.
    const before = await journalCount();
    const attempt = await auth(request(app).post('/api/vendors')).send({ id: vendorId, name: 'Test Vendor F', openingBalance: 999, openingDate: LOCK_DATE });
    expect(attempt.status).toBe(200); // the vendors route itself still succeeds (name/profile update)
    await runAsTenant('default', async () => {
      const db = loadDB();
      const v = db.vendors.find(x => x.id === vendorId);
      expect(v.openingBalance).toBe(50); // rejected posting — balance NOT overwritten to 999
      expect((db.journalEntries || []).length).toBe(before); // no new/broken journal entry
    });
  });

  test('voucher edit: a rejected re-post leaves the ORIGINAL journal entry intact (not deleted)', async () => {
    const create = await auth(request(app).post('/api/vouchers')).send({
      type: 'receipt', date: OPEN_DATE, assetAccId: '1100',
      lines: [{ accountId: '4100', amount: 25 }],
    });
    expect(create.status).toBe(200);
    const voucherId = create.body.voucher.id;
    const originalJeId = 'JE-' + create.body.voucher.number;

    const fail = await auth(request(app).put(`/api/vouchers/${voucherId}`)).send({
      date: LOCK_DATE, lines: [{ accountId: '4100', amount: 30 }],
    });
    expect(fail.status).toBe(409);

    await runAsTenant('default', async () => {
      const db = loadDB();
      expect((db.journalEntries || []).some(j => j.id === originalJeId)).toBe(true); // still there
      const v = db.vouchers.find(x => x.id === voucherId);
      expect(v.amount).toBe(25); // voucher itself unchanged
    });
  });

  test('depreciation: a rejected posting leaves accumulatedDep unchanged on every asset', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.fixedAssets = db.fixedAssets || [];
      db.fixedAssets.push({ id: 'AST-DEP', name: 'Depreciable', cost: 1200, salvageValue: 0, usefulLife: 5, accumulatedDep: 0, status: 'active', depExpAccount: '5800', accDepAccount: '1590' });
      saveDB(db);
    });
    const fail = await auth(request(app).post('/api/assets/depreciate')).send({ period: LOCK_MONTH });
    expect(fail.status).toBe(409);
    await runAsTenant('default', async () => {
      const db = loadDB();
      const asset = db.fixedAssets.find(a => a.id === 'AST-DEP');
      expect(asset.accumulatedDep).toBe(0); // unchanged
    });
  });
});

describe('P0.3 — Historical ledger diagnostic (read-only)', () => {
  beforeAll(async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.journalEntries = db.journalEntries || [];
      // A valid, fully-resolved entry.
      db.journalEntries.push({
        id: 'JE-DIAG-VALID', date: '2032-06-10', desc: 'valid entry', type: 'expense',
        lines: [{ accountCode: '1100', debit: 10, credit: 0 }, { accountCode: '4100', debit: 0, credit: 10 }],
      });
      // Synthetic historical entries seeded directly (bypassing the P0.2
      // guard on purpose) referencing the three specifically-required
      // phantom codes, to prove the scanner detects them. This is
      // synthetic/test fixture data only — no production data was scanned.
      db.journalEntries.push({
        id: 'JE-DIAG-1160', date: '2032-06-11', desc: 'legacy inventory purchase', ref: 'MOV-OLD-1', source: 'inventory', type: 'inventory',
        lines: [{ accountCode: '1160', debit: 20, credit: 0 }, { accountCode: '2100', debit: 0, credit: 20 }],
      });
      db.journalEntries.push({
        id: 'JE-DIAG-5250', date: '2032-06-12', desc: 'legacy PIFSS', ref: 'PIFSS-OLD', source: 'close-run-all', type: 'pifss',
        lines: [{ accountCode: '5250', debit: 15, credit: 0 }, { accountCode: '2200', debit: 0, credit: 15 }],
      });
      db.journalEntries.push({
        id: 'JE-DIAG-5260', date: '2032-06-13', desc: 'legacy EOS', ref: 'EOS-OLD', source: 'payroll-eos-run', type: 'end_of_service',
        lines: [{ accountCode: '5260', debit: 30, credit: 0 }, { accountCode: '2300', debit: 0, credit: 30 }],
      });
      // A second 1160 line in a different month, to prove per-code aggregation across periods.
      db.journalEntries.push({
        id: 'JE-DIAG-1160-B', date: '2032-07-01', desc: 'legacy inventory purchase 2', ref: 'MOV-OLD-2', source: 'inventory', type: 'inventory',
        lines: [{ accountCode: '1160', debit: 5, credit: 0 }, { accountCode: '2100', debit: 0, credit: 5 }],
      });
      saveDB(db);
    });
  });

  test('detects all three required phantom codes with correct debit/credit totals and date ranges', async () => {
    const res = await auth(request(app).get('/api/reports/ledger-diagnostic?from=2032-06-01&to=2032-07-31'));
    expect(res.status).toBe(200);
    expect(res.body.hasUnresolvedAccounts).toBe(true);

    const byCode = Object.fromEntries(res.body.unresolvedCodes.map(u => [u.code, u]));
    expect(byCode['1160'].affectedEntries).toBe(2);
    expect(byCode['1160'].debitTotal).toBe(25); // 20 + 5
    expect(byCode['1160'].earliestDate).toBe('2032-06-11');
    expect(byCode['1160'].latestDate).toBe('2032-07-01');

    expect(byCode['5250'].affectedEntries).toBe(1);
    expect(byCode['5250'].debitTotal).toBe(15);

    expect(byCode['5260'].affectedEntries).toBe(1);
    expect(byCode['5260'].debitTotal).toBe(30);

    // Resolved codes (1100, 4100, 2100, 2200, 2300) must never appear as unresolved.
    expect(byCode['1100']).toBeUndefined();
    expect(byCode['2200']).toBeUndefined();
  });

  test('period filtering excludes entries outside the requested range', async () => {
    const res = await auth(request(app).get('/api/reports/ledger-diagnostic?from=2032-07-01&to=2032-07-31'));
    const byCode = Object.fromEntries(res.body.unresolvedCodes.map(u => [u.code, u]));
    expect(byCode['1160'].affectedEntries).toBe(1); // only the July one
    expect(byCode['5250']).toBeUndefined();          // June-only code excluded
  });

  test('the diagnostic never mutates the database', async () => {
    let before, after;
    await runAsTenant('default', async () => { before = JSON.stringify(loadDB().journalEntries); });
    await auth(request(app).get('/api/reports/ledger-diagnostic'));
    await runAsTenant('default', async () => { after = JSON.stringify(loadDB().journalEntries); });
    expect(after).toBe(before);
  });

  test('P&L and Balance Sheet expose hasUnresolvedAccounts when unresolved lines fall in range', async () => {
    const pnl = await auth(request(app).get('/api/reports/pnl?from=2032-06-01&to=2032-07-31'));
    expect(pnl.body.hasUnresolvedAccounts).toBe(true);
    expect(pnl.body.unresolvedCodes.map(u => u.code)).toEqual(expect.arrayContaining(['5250', '5260']));

    const bs = await auth(request(app).get('/api/reports/balance-sheet?date=2032-07-31'));
    expect(bs.body.hasUnresolvedAccounts).toBe(true);
  });

  test('a report with no unresolved accounts in range shows hasUnresolvedAccounts:false', async () => {
    const pnl = await auth(request(app).get('/api/reports/pnl?from=2032-05-01&to=2032-05-31')); // OPEN_MONTH only, no diag fixtures there
    expect(pnl.body.hasUnresolvedAccounts).toBe(false);
    expect(pnl.body.unresolvedCount).toBe(0);
  });

  test('tenant isolation: Tenant A\'s unresolved historical entries are invisible to Tenant B\'s diagnostic', async () => {
    await runAsTenant('tenant-diag-a', async () => {
      await warmTenantCache('tenant-diag-a');
      const db = loadDB();
      db.users = [{ id: 'u-diag-a', tenantId: 'tenant-diag-a', username: 'diag-a', passwordHash: hash('DiagA!123'), role: 'admin', active: true }];
      db.chartOfAccounts = [{ code: '1100', name: 'Cash', type: 'asset' }, { code: '4100', name: 'Rev', type: 'revenue' }];
      db.journalEntries = [{
        id: 'JE-TENANT-A-PHANTOM', date: '2032-06-15', desc: 'tenant A phantom',
        lines: [{ accountCode: '1160', debit: 999, credit: 0 }, { accountCode: '4100', debit: 0, credit: 999 }],
      }];
      saveDB(db);
    });
    await runAsTenant('tenant-diag-b', async () => {
      await warmTenantCache('tenant-diag-b');
      const db = loadDB();
      db.users = [{ id: 'u-diag-b', tenantId: 'tenant-diag-b', username: 'diag-b', passwordHash: hash('DiagB!123'), role: 'admin', active: true }];
      db.chartOfAccounts = [{ code: '1100', name: 'Cash', type: 'asset' }, { code: '4100', name: 'Rev', type: 'revenue' }];
      db.journalEntries = [{
        id: 'JE-TENANT-B-CLEAN', date: '2032-06-15', desc: 'tenant B clean entry',
        lines: [{ accountCode: '1100', debit: 5, credit: 0 }, { accountCode: '4100', debit: 0, credit: 5 }],
      }];
      saveDB(db);
    });

    const loginB = await request(app).post('/api/auth/login').send({ username: 'diag-b', password: 'DiagB!123', tenantId: 'tenant-diag-b' });
    const diagB = await request(app).get('/api/reports/ledger-diagnostic').set('Authorization', `Bearer ${loginB.body.token}`);
    expect(diagB.body.hasUnresolvedAccounts).toBe(false);
    expect(diagB.body.unresolvedCodes.find(u => u.code === '1160')).toBeUndefined();

    const loginA = await request(app).post('/api/auth/login').send({ username: 'diag-a', password: 'DiagA!123', tenantId: 'tenant-diag-a' });
    const diagA = await request(app).get('/api/reports/ledger-diagnostic').set('Authorization', `Bearer ${loginA.body.token}`);
    expect(diagA.body.hasUnresolvedAccounts).toBe(true);
    expect(diagA.body.unresolvedCodes.find(u => u.code === '1160').debitTotal).toBe(999);
  });
});
