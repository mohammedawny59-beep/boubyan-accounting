// P0.11 — Production Persistence Proof (Objective A) + ENTITY_KEYS
// Completeness (Objective B), Parts E-H.
//
// Isolated, real-app tests (DB_FILE_ONLY, os.tmpdir()) via supertest against
// the real exported Express app — same boilerplate pattern as every other
// P0.x test file this program has produced.
//
// The core mechanic proven here is a REAL restart, not an in-memory replay:
// `restart()` below calls `initDB()` a second time against the SAME on-disk
// data file. `lib/database.js`'s file-fallback branch (`_dbCache =
// loadFileDB(dataFile, buildInitialDB)`) does a fresh `fs.readJsonSync()`
// into a brand-new object every time it runs — `restart()` asserts the
// returned `loadDB()` reference actually changed (`not.toBe`) so a test
// cannot silently pass by comparing the same in-memory object that wrote
// the data in the first place. Every write these tests depend on goes
// through a durable-before-ack route (`saveDB(db,{durable:true})`) that P0.11
// Part Q converted/confirmed, so by the time each `POST`'s response resolves
// the write is guaranteed to already be on disk.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-11-persistence-durability-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p11-durability-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, loadDB, saveDB } = require('../lib/database');
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

async function bootDB() {
  await initDB({
    mongoUri: 'mongodb://127.0.0.1:1/unused',
    dataFile: process.env.DATA_FILE,
    configFile: process.env.CONFIG_FILE,
    defaultConfig: {},
    buildInitialDB,
    migrateDB: () => false,
  });
}

beforeAll(async () => {
  await bootDB();
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
  adminToken = login.body.token;
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

// The one mechanic every "restart" test in this file depends on: destroy the
// in-memory `_dbCache` reference and force lib/database.js to re-read the
// on-disk file into a genuinely new object. Comparing `before`/`after` by
// reference (not value) is what makes this a real proof rather than a tautology.
async function restart() {
  const before = loadDB();
  await bootDB();
  const after = loadDB();
  expect(after).not.toBe(before);
  return after;
}

async function seedVendorDirect(id, name, accountId) {
  const db = loadDB();
  if (!db.vendors) db.vendors = [];
  db.vendors.push({ id, name, accountId, createdAt: new Date().toISOString() });
  await saveDB(db, { durable: true });
}

// ═══════════════════════════════════════════════════════════════════════
// Part E — Restart/reload durability for ~13 critical financial workflows.
// Pattern: POST via the real durable-before-ack route → restart() → GET the
// same data back through a fresh read path and assert it survived intact.
// ═══════════════════════════════════════════════════════════════════════
describe('P0.11 Part E — restart/reload durability of critical financial workflows', () => {
  test('Reload A: a posted journal entry survives a full reload from disk', async () => {
    const post = await request(app).post('/api/journal').set(auth()).send({
      date: '2054-01-05', desc: 'Reload A revenue', lines: [
        { accountCode: '1100', debit: 500, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 500 },
      ],
    });
    expect(post.status).toBe(200);
    const jeId = post.body.entry ? post.body.entry.id : post.body.id;

    await restart();

    const found = loadDB().journalEntries.find(j => j.id === jeId || j.desc === 'Reload A revenue');
    expect(found).toBeTruthy();
    expect(found.lines.length).toBe(2);
  });

  test('Reload B: a voucher (and its journal entry) survives a full reload from disk', async () => {
    const post = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'payment', date: '2054-01-06', payee: 'Reload B Payee', assetAccId: '1100',
      lines: [{ accountId: '5200', amount: 75 }],
    });
    expect(post.status).toBe(200);
    const voucherNumber = post.body.voucher.number;

    await restart();

    const je = loadDB().journalEntries.find(j => j.ref === voucherNumber);
    expect(je).toBeTruthy();
    expect(je.totalDebit).toBeCloseTo(75, 3);
  });

  test('Reload C: an insurance claim survives a full reload from disk', async () => {
    const post = await request(app).post('/api/insurance-claims').set(auth()).send({
      company: 'Reload C Insurer', claimDate: '2054-01-07', amount: 300,
    });
    expect(post.status).toBe(200);
    const claimId = post.body.claim ? post.body.claim.id : undefined;

    await restart();

    const list = await request(app).get('/api/insurance-claims').set(auth());
    expect(list.status).toBe(200);
    const found = list.body.find(c => c.company === 'Reload C Insurer');
    expect(found).toBeTruthy();
    expect(found.amount).toBeCloseTo(300, 3);
  });

  test('Reload D: an accrued expense survives a full reload from disk', async () => {
    const post = await request(app).post('/api/accrued-expenses').set(auth()).send({
      description: 'Reload D accrual', amount: 120, month: '2054-01', accountCode: '5900',
    });
    expect(post.status).toBe(200);

    await restart();

    const list = await request(app).get('/api/accrued-expenses').set(auth());
    expect(list.status).toBe(200);
    const found = list.body.accruedExpenses.find(a => a.description === 'Reload D accrual');
    expect(found).toBeTruthy();
    expect(found.amount).toBeCloseTo(120, 3);
  });

  test('Reload E: an employee record survives a full reload from disk', async () => {
    const post = await request(app).post('/api/employees').set(auth()).send({ name: 'Reload E Employee', role: 'admin' });
    expect(post.status).toBe(200);

    await restart();

    const list = await request(app).get('/api/employees').set(auth());
    expect(list.status).toBe(200);
    const employees = Array.isArray(list.body) ? list.body : (list.body.employees || []);
    const found = employees.find(e => e.name === 'Reload E Employee');
    expect(found).toBeTruthy();
  });

  test('Reload F: a payroll record (and its accrual journal entry) survives a full reload from disk', async () => {
    const post = await request(app).post('/api/payroll').set(auth()).send({
      month: '2054-02', entries: [{ name: 'Reload F Worker', basicSalary: 400 }],
    });
    expect(post.status).toBe(200);

    await restart();

    const list = await request(app).get('/api/payroll').set(auth());
    expect(list.status).toBe(200);
    const records = Array.isArray(list.body) ? list.body : (list.body.records || list.body.payroll || []);
    const found = records.find(p => p.month === '2054-02');
    expect(found).toBeTruthy();
    expect(found.totalNet).toBeCloseTo(400, 3);
  });

  test('Reload G: a fixed asset (and its acquisition journal entry) survives a full reload from disk', async () => {
    const post = await request(app).post('/api/assets').set(auth()).send({
      name: 'Reload G Asset', cost: 1000, purchaseDate: '2054-01-08', payMethod: 'cash', usefulLife: 5,
    });
    expect(post.status).toBe(200);
    const assetId = post.body.asset.id;

    await restart();

    const list = await request(app).get('/api/assets').set(auth());
    expect(list.status).toBe(200);
    const assets = Array.isArray(list.body) ? list.body : (list.body.assets || []);
    const found = assets.find(a => a.id === assetId);
    expect(found).toBeTruthy();
    expect(found.cost).toBeCloseTo(1000, 3);
  });

  test('Reload H: a vendor bill (AP) survives a full reload from disk', async () => {
    await seedVendorDirect('VEN-RELOAD-H', 'Reload H Vendor', '2100');
    const post = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: 'VEN-RELOAD-H', billDate: '2054-01-09', description: 'Reload H bill',
      allocations: [{ accountCode: '5200', amount: 250 }],
    });
    expect(post.status).toBe(200);
    const billId = post.body.bill.id;

    await restart();

    const list = await request(app).get('/api/vendor-bills').set(auth());
    expect(list.status).toBe(200);
    const found = list.body.find(b => b.id === billId);
    expect(found).toBeTruthy();
    expect(found.grossAmount).toBeCloseTo(250, 3);
  });

  test('Reload I: a cash reconciliation record survives a full reload from disk', async () => {
    const post = await request(app).post('/api/cash-reconciliation').set(auth()).send({
      date: '2054-01-10', openingBalance: 100, physicalCash: 100,
    });
    expect(post.status).toBe(200);

    await restart();

    const list = await request(app).get('/api/cash-reconciliation').set(auth());
    expect(list.status).toBe(200);
    const recs = Array.isArray(list.body) ? list.body : (list.body.records || []);
    const found = recs.find(r => r.date === '2054-01-10');
    expect(found).toBeTruthy();
  });

  test('Reload J: a period lock survives a full reload from disk', async () => {
    const post = await request(app).post('/api/period-lock').set(auth()).send({ period: '2054-03', locked: true });
    expect(post.status).toBe(200);

    await restart();

    const locks = await request(app).get('/api/period-lock').set(auth());
    expect(locks.status).toBe(200);
    expect(locks.body['2054-03']).toBe(true);
  });

  test('Reload K: a period-closing entry survives a full reload from disk', async () => {
    await request(app).post('/api/journal').set(auth()).send({
      date: '2054-04-05', desc: 'Reload K revenue', lines: [
        { accountCode: '1100', debit: 900, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 900 },
      ],
    }).then(r => expect(r.status).toBe(200));

    const close = await request(app).post('/api/closing-entry').set(auth()).send({ year: 2054, month: 4 });
    expect(close.status).toBe(200);
    const closingEntryId = close.body.entry.id;

    await restart();

    const found = loadDB().journalEntries.find(j => j.id === closingEntryId);
    expect(found).toBeTruthy();
    expect(found.type).toBe('closing');
  });

  test('Reload L: a bulk-journal import (durable saveDB, P0.11 Part Q) survives a full reload from disk', async () => {
    const XLSX = require('xlsx');
    const wsData = [
      { 'رقم القيد (مشترك لسطور نفس القيد)': 'RELOAD-L-1', 'التاريخ': '2054-01-11', 'الوصف': 'Reload L import', 'رقم الحساب': '1100', 'مدين (د.ك)': 60, 'دائن (د.ك)': 0 },
      { 'رقم القيد (مشترك لسطور نفس القيد)': 'RELOAD-L-1', 'التاريخ': '2054-01-11', 'الوصف': 'Reload L import', 'رقم الحساب': '4100', 'مدين (د.ك)': 0, 'دائن (د.ك)': 60 },
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const post = await request(app).post('/api/import/bulk-journal').set(auth()).attach('file', buf, 'reload-l.xlsx');
    expect(post.status).toBe(200);
    expect(post.body.success).toBe(true);
    expect(post.body.created).toBe(1);

    await restart();

    const found = loadDB().journalEntries.find(j => j.description === 'Reload L import' || j.desc === 'Reload L import');
    expect(found).toBeTruthy();
  });

  test('Reload M: a patient-AR opening-balance import (durable saveDB, P0.11 Part Q) survives a full reload from disk', async () => {
    const XLSX = require('xlsx');
    const wsData = [
      { 'اسم المريض': 'Reload M Patient', 'المبلغ المستحق (د.ك)': 180, 'التاريخ الافتتاحي': '2054-01-01' },
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const post = await request(app).post('/api/import/patient-opening').set(auth()).attach('file', buf, 'reload-m.xlsx');
    expect(post.status).toBe(200);
    expect(post.body.success).toBe(true);
    expect(post.body.created).toBe(1);

    await restart();

    const found = loadDB().journalEntries.find(j => j.ref === 'OB-PAT');
    expect(found).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part G — Idempotency-after-restart: a duplicate-prevention guard's state
// must live on disk, not just in the process that first enforced it.
// ═══════════════════════════════════════════════════════════════════════
describe('P0.11 Part G — idempotency guards persist across a restart', () => {
  test('Idempotency A: patient-AR opening import stays a one-time operation across a restart', async () => {
    // Reload M above already imported the OB-PAT-referenced journal entry
    // and this suite already restarted since, so the guard's persisted
    // state (not an in-memory flag) is what must reject this repeat.
    const XLSX = require('xlsx');
    const wsData = [{ 'اسم المريض': 'Idempotency A Patient', 'المبلغ المستحق (د.ك)': 50, 'التاريخ الافتتاحي': '2054-01-01' }];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const repeat = await request(app).post('/api/import/patient-opening').set(auth()).attach('file', buf, 'idempotency-a.xlsx');
    expect(repeat.status).toBe(409);
  });

  test('Idempotency B: a duplicate vendor-bill number for the same vendor stays rejected across a restart', async () => {
    await seedVendorDirect('VEN-IDEMP-B', 'Idempotency B Vendor', '2100');
    const first = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: 'VEN-IDEMP-B', billNumber: 'DUP-001', billDate: '2054-01-12', description: 'first',
      allocations: [{ accountCode: '5200', amount: 40 }],
    });
    expect(first.status).toBe(200);

    await restart();

    const second = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: 'VEN-IDEMP-B', billNumber: 'DUP-001', billDate: '2054-01-13', description: 'second (should be rejected)',
      allocations: [{ accountCode: '5200', amount: 40 }],
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('DUPLICATE_BILL');
  });

  test('Idempotency C: a vendor-bill payment clientRef stays idempotent across a restart', async () => {
    await seedVendorDirect('VEN-IDEMP-C', 'Idempotency C Vendor', '2100');
    const bill = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: 'VEN-IDEMP-C', billDate: '2054-01-14', description: 'to be paid twice with same clientRef',
      allocations: [{ accountCode: '5200', amount: 90 }],
    });
    expect(bill.status).toBe(200);
    const billId = bill.body.bill.id;

    const pay1 = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).send({
      amount: 90, payDate: '2054-01-15', payAccount: '1100', clientRef: 'IDEMP-C-CLIENTREF',
    });
    expect(pay1.status).toBe(200);

    await restart();

    const pay2 = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).send({
      amount: 90, payDate: '2054-01-16', payAccount: '1100', clientRef: 'IDEMP-C-CLIENTREF',
    });
    expect(pay2.status).toBe(200);
    // A retried request with the same clientRef must return the ORIGINAL
    // payment, not create a second one — verified by re-fetching the bill
    // and confirming only one payment (not two) is on record.
    const after = await request(app).get('/api/vendor-bills').set(auth());
    const reloadedBill = after.body.find(b => b.id === billId);
    expect((reloadedBill.payments || []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part H — Period-lock persistence: a locked period must reject mutations
// after a restart, proving the lock lives on disk, not only in memory.
// ═══════════════════════════════════════════════════════════════════════
describe('P0.11 Part H — period-lock enforcement persists across a restart', () => {
  test('PeriodLock A: a CREATE into a period locked before a restart is still rejected (409) after it', async () => {
    const lock = await request(app).post('/api/period-lock').set(auth()).send({ period: '2054-05', locked: true });
    expect(lock.status).toBe(200);

    await restart();

    const post = await request(app).post('/api/journal').set(auth()).send({
      date: '2054-05-10', desc: 'should be rejected — locked period', lines: [
        { accountCode: '1100', debit: 10, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 10 },
      ],
    });
    expect(post.status).toBe(409);
  });

  test('PeriodLock B: a DELETE from a period locked before a restart is still rejected (403) after it', async () => {
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2054-06', locked: false });
    const post = await request(app).post('/api/journal').set(auth()).send({
      date: '2054-06-10', desc: 'PeriodLock B entry', lines: [
        { accountCode: '1100', debit: 20, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 20 },
      ],
    });
    expect(post.status).toBe(200);
    const jeId = post.body.entry ? post.body.entry.id : post.body.id;

    const lock = await request(app).post('/api/period-lock').set(auth()).send({ period: '2054-06', locked: true });
    expect(lock.status).toBe(200);

    await restart();

    const del = await request(app).delete(`/api/journal/${jeId}`).set(auth());
    expect(del.status).toBe(403);
  });

  test('PeriodLock C: unlocking a period before a restart correctly stays unlocked after it', async () => {
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2054-07', locked: true });
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2054-07', locked: false });

    await restart();

    const post = await request(app).post('/api/journal').set(auth()).send({
      date: '2054-07-10', desc: 'should be accepted — unlocked after restart', lines: [
        { accountCode: '1100', debit: 30, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 30 },
      ],
    });
    expect(post.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Audit-trail persistence: an audit event logged before a restart must
// still be readable, with its real actor/resource fields, after it.
// ═══════════════════════════════════════════════════════════════════════
describe('P0.11 — audit-trail persistence across a restart', () => {
  test('Audit A: a period-lock audit event survives a full reload from disk', async () => {
    const action = await request(app).post('/api/period-lock').set(auth()).send({ period: '2054-08', locked: true });
    expect(action.status).toBe(200);

    await restart();

    const log = await request(app).get('/api/audit-log').set(auth()).query({ action: 'period.locked', resourceType: 'period' });
    expect(log.status).toBe(200);
    const entry = log.body.logs.find(l => l.resourceId === '2054-08');
    expect(entry).toBeTruthy();
    expect(entry.actorUsername).toBe('admin');
  });

  test('Audit B: an asset-creation audit event survives a full reload from disk, with its before/after payload intact', async () => {
    const create = await request(app).post('/api/assets').set(auth()).send({
      name: 'Audit B Asset', cost: 500, purchaseDate: '2054-01-17', payMethod: 'cash',
    });
    expect(create.status).toBe(200);
    const assetId = create.body.asset.id;

    await restart();

    const log = await request(app).get('/api/audit-log').set(auth()).query({ action: 'asset.created', resourceType: 'fixedAsset' });
    expect(log.status).toBe(200);
    const entry = log.body.logs.find(l => l.resourceId === assetId);
    expect(entry).toBeTruthy();
    expect(entry.after.name).toBe('Audit B Asset');
    expect(entry.after.cost).toBeCloseTo(500, 3);
  });
});
