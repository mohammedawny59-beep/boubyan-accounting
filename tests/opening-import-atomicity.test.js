// P0.3A — Close the final known accounting atomicity gaps:
// /api/import/inventory-opening and /api/import/patient-opening.
// Real Express app + Supertest, real multer file upload (in-memory XLSX
// buffers built with the same `xlsx` package the routes themselves use).
//
// Safety: DB_FILE_ONLY=true (MongoDB never touched), fresh os.tmpdir() per
// run, removed in afterAll(). No production/real tenant data anywhere here.
//
// P0.6A — Step 2 (P6-042) test-expectation update:
//   OLD ASSERTION: every check here read `db.inventory` for the imported
//     items.
//   WHY WRONG: `db.inventory` was a separate array from `db.invItems` — the
//     one every other inventory route (POST /api/inv/items,
//     /api/inv/operation) and the financial-statements inventory valuation
//     actually read. The old assertions were faithfully testing a real bug
//     (imported items permanently invisible to the rest of the inventory
//     module) rather than correct behavior.
//   NEW ACCOUNTING ASSERTION: the route now commits into the canonical
//     `db.invItems` array (see server.js's inventory-opening-import route),
//     so every assertion below now reads `db.invItems` instead.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-3a-opening-import-test-secret';
process.env.NODE_ENV     = 'test';

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-opening-import-'));
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
    vendors: [], invItems: [], invCategories: [], invMovements: [], inventory: [],
    recurringExpenses: [], companyInfo: { name: 'عيادة الاختبار' }, scheduleConfig: {},
    vouchers: [], cashReconciliation: [], insuranceClaims: [], payroll: [],
    employees: [], fixedAssets: [], assets: [], budget: {}, auditLog: [],
    accruedExpenses: [], journalMappings: [], doctorExpenses: [], patientAR: [],
    accountingSettings: {}, lockedPeriods: {},
  };
}

let token;

function xlsxBuffer(rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function inventoryRow(name, qty, cost, extra) {
  return Object.assign({
    'اسم المادة': name,
    'الكمية الافتتاحية': qty,
    'تكلفة الوحدة (د.ك)': cost,
  }, extra || {});
}
function patientRow(name, amount, extra) {
  return Object.assign({
    'اسم المريض': name,
    'المبلغ المستحق (د.ك)': amount,
    'التاريخ الافتتاحي': '2033-04-10',
  }, extra || {});
}

function postInventoryFile(rows) {
  return request(app).post('/api/import/inventory-opening')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', xlsxBuffer(rows), 'inventory.xlsx');
}
function postPatientFile(rows) {
  return request(app).post('/api/import/patient-opening')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', xlsxBuffer(rows), 'patient.xlsx');
}

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
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

async function snapshot() {
  let s;
  await runAsTenant('default', async () => {
    const db = loadDB();
    s = {
      inventory: (db.invItems || []).length,
      patientAR: (db.patientAR || []).length,
      journal: (db.journalEntries || []).length,
    };
  });
  return s;
}

describe('P0.3A — Test 1: inventory opening rejected in a locked period leaves everything unchanged', () => {
  const thisMonth = new Date().toISOString().slice(0, 7);
  beforeAll(async () => { await request(app).post('/api/period-lock').set('Authorization', `Bearer ${token}`).send({ period: thisMonth, locked: true }); });
  afterAll(async () => { await request(app).post('/api/period-lock').set('Authorization', `Bearer ${token}`).send({ period: thisMonth, locked: false }); });

  test('rejects with zero new inventory records and zero journal change', async () => {
    const before = await snapshot();
    const res = await postInventoryFile([inventoryRow('Locked Period Item', 5, 2)]);
    expect(res.status).toBe(409);
    const after = await snapshot();
    expect(after.inventory).toBe(before.inventory);
    expect(after.journal).toBe(before.journal);
  });
});

describe('P0.3A — Test 2: inventory opening with an unresolvable account code', () => {
  test('journal validation failure means complete rollback / no commit', async () => {
    const before = await snapshot();
    const res = await postInventoryFile([inventoryRow('Phantom Account Item', 3, 10, { 'رقم الحساب': '9999' })]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_ACCOUNT');
    const after = await snapshot();
    expect(after.inventory).toBe(before.inventory); // no partial item added
    expect(after.journal).toBe(before.journal);
  });
});

describe('P0.3A — Test 3: patient opening rejected in a locked period leaves everything unchanged', () => {
  const thisMonth = new Date().toISOString().slice(0, 7);
  beforeAll(async () => { await request(app).post('/api/period-lock').set('Authorization', `Bearer ${token}`).send({ period: thisMonth, locked: true }); });
  afterAll(async () => { await request(app).post('/api/period-lock').set('Authorization', `Bearer ${token}`).send({ period: thisMonth, locked: false }); });

  test('rejects with zero patient AR mutation and zero journal mutation', async () => {
    const before = await snapshot();
    const res = await postPatientFile([patientRow('Locked Period Patient', 40)]);
    expect(res.status).toBe(409);
    const after = await snapshot();
    expect(after.patientAR).toBe(before.patientAR);
    expect(after.journal).toBe(before.journal);
  });
});

describe('P0.3A — Test 4: patient opening journal failure is all-or-nothing', () => {
  test('an unresolvable receivable account rejects the whole batch, nothing committed', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.accountingSettings = { ...(db.accountingSettings || {}), accReceivable: '9999' };
      saveDB(db);
    });
    // restore sane settings for later tests — wrapped in try/finally so a
    // failed assertion below can never leave a broken accReceivable setting
    // for every subsequent test in this file (P0.9 hardening: this is
    // exactly the cascading-failure shape a bare post-assertion cleanup
    // creates).
    try {
      const before = await snapshot();
      const res = await postPatientFile([patientRow('Bad Account Patient', 60)]);
      expect(res.status).toBe(400);
      // P0.9 — P6-072-adjacent hardening: a MISSING configured receivable
      // account is now caught by a dedicated, earlier, more specific check
      // (Part F/Step 19) before the journal is even attempted — not the
      // generic validateJournalEntry UNKNOWN_ACCOUNT this used to surface.
      // The safety property this test exists to prove (reject + nothing
      // committed) is unchanged and re-verified by the assertions below.
      expect(res.body.code).toBe('CONFIGURED_ACCOUNT_MISSING');
      const after = await snapshot();
      expect(after.patientAR).toBe(before.patientAR);
      expect(after.journal).toBe(before.journal);
    } finally {
      await runAsTenant('default', async () => {
        const db = loadDB();
        db.accountingSettings = { ...(db.accountingSettings || {}), accReceivable: '1200' };
        saveDB(db);
      });
    }
  });
});

describe('P0.3A — Test 5: multi-row inventory batch, one invalid row → zero committed', () => {
  test('10 rows, 1 invalid (missing quantity) → whole batch rejected', async () => {
    const before = await snapshot();
    const rows = [];
    for (let i = 0; i < 9; i++) rows.push(inventoryRow(`Batch Item ${i}`, 1, 1));
    rows.push(inventoryRow('Bad Row', 0, 1)); // qty=0 → treated as missing → row-level error
    const res = await postInventoryFile(rows);
    expect(res.status).toBe(400);
    expect(res.body.created).toBe(0);
    expect(res.body.errors.length).toBe(1);
    const after = await snapshot();
    expect(after.inventory).toBe(before.inventory); // none of the 9 valid rows committed either
    expect(after.journal).toBe(before.journal);
  });
});

describe('P0.3A — Test 6: multi-row patient batch, one invalid row → zero committed', () => {
  test('10 rows, 1 invalid (missing amount) → whole batch rejected', async () => {
    const before = await snapshot();
    const rows = [];
    for (let i = 0; i < 9; i++) rows.push(patientRow(`Batch Patient ${i}`, 10));
    rows.push(patientRow('Bad Patient Row', 0)); // amount=0 → row-level error
    const res = await postPatientFile(rows);
    expect(res.status).toBe(400);
    expect(res.body.created).toBe(0);
    expect(res.body.errors.length).toBe(1);
    const after = await snapshot();
    expect(after.patientAR).toBe(before.patientAR);
    expect(after.journal).toBe(before.journal);
  });
});

describe('P0.3A — Test 7: a fully valid inventory-opening import commits everything together', () => {
  test('all rows and one balanced journal entry commit successfully', async () => {
    const before = await snapshot();
    const res = await postInventoryFile([
      inventoryRow('Valid Item A', 10, 2),
      inventoryRow('Valid Item B', 5, 4),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.created).toBe(2);
    expect(res.body.errors).toEqual([]);

    await runAsTenant('default', async () => {
      const db = loadDB();
      expect(db.invItems.some(i => i.name === 'Valid Item A' && i.quantity === 10)).toBe(true);
      expect(db.invItems.some(i => i.name === 'Valid Item B' && i.quantity === 5)).toBe(true);
      const je = db.journalEntries.find(j => j.ref === 'OB-INV');
      expect(je).toBeDefined();
      const totD = je.lines.reduce((s, l) => s + (l.debit || 0), 0);
      const totC = je.lines.reduce((s, l) => s + (l.credit || 0), 0);
      expect(Math.abs(totD - totC)).toBeLessThan(0.005); // balanced
    });
    const after = await snapshot();
    expect(after.inventory).toBe(before.inventory + 2);
    expect(after.journal).toBe(before.journal + 1);
  });

  test('duplicate-import guard: re-submitting a second inventory-opening file is rejected (409), not silently doubled', async () => {
    const before = await snapshot();
    const res = await postInventoryFile([inventoryRow('Should Not Import', 1, 1)]);
    expect(res.status).toBe(409);
    const after = await snapshot();
    expect(after.inventory).toBe(before.inventory);
    expect(after.journal).toBe(before.journal);
  });
});

describe('P0.3A — Test 8: a fully valid patient-opening import commits everything together', () => {
  test('all rows and one balanced journal entry commit successfully', async () => {
    const before = await snapshot();
    const res = await postPatientFile([
      patientRow('Valid Patient A', 30),
      patientRow('Valid Patient B', 20),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.errors).toEqual([]);

    await runAsTenant('default', async () => {
      const db = loadDB();
      expect(db.patientAR.some(p => p.name === 'Valid Patient A' && p.amount === 30)).toBe(true);
      const je = db.journalEntries.find(j => j.ref === 'OB-PAT');
      expect(je).toBeDefined();
      const totD = je.lines.reduce((s, l) => s + (l.debit || 0), 0);
      const totC = je.lines.reduce((s, l) => s + (l.credit || 0), 0);
      expect(Math.abs(totD - totC)).toBeLessThan(0.005);
    });
    const after = await snapshot();
    expect(after.patientAR).toBe(before.patientAR + 2);
    expect(after.journal).toBe(before.journal + 1);
  });

  test('duplicate-import guard: re-submitting a second patient-opening file is rejected (409)', async () => {
    const before = await snapshot();
    const res = await postPatientFile([patientRow('Should Not Import', 5)]);
    expect(res.status).toBe(409);
    const after = await snapshot();
    expect(after.patientAR).toBe(before.patientAR);
    expect(after.journal).toBe(before.journal);
  });
});

describe('P0.3A — Test 9: tenant isolation regression', () => {
  test('Tenant A\'s opening import changes only Tenant A — Tenant B stays empty', async () => {
    await runAsTenant('tenant-open-a', async () => {
      await warmTenantCache('tenant-open-a');
      const db = loadDB();
      db.users = [{ id: 'u-open-a', tenantId: 'tenant-open-a', username: 'open-a', passwordHash: hash('OpenA!123'), role: 'admin', active: true }];
      db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
      db.invItems = []; db.journalEntries = [];
      saveDB(db);
    });
    await runAsTenant('tenant-open-b', async () => {
      await warmTenantCache('tenant-open-b');
      const db = loadDB();
      db.users = [{ id: 'u-open-b', tenantId: 'tenant-open-b', username: 'open-b', passwordHash: hash('OpenB!123'), role: 'admin', active: true }];
      db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
      db.invItems = []; db.journalEntries = [];
      saveDB(db);
    });

    const loginA = await request(app).post('/api/auth/login').send({ username: 'open-a', password: 'OpenA!123', tenantId: 'tenant-open-a' });
    const res = await request(app).post('/api/import/inventory-opening')
      .set('Authorization', `Bearer ${loginA.body.token}`)
      .attach('file', xlsxBuffer([inventoryRow('Tenant A Only Item', 7, 3)]), 'inv.xlsx');
    expect(res.status).toBe(200);

    await runAsTenant('tenant-open-a', async () => {
      const db = loadDB();
      expect(db.invItems.some(i => i.name === 'Tenant A Only Item')).toBe(true);
    });
    await runAsTenant('tenant-open-b', async () => {
      const db = loadDB();
      expect((db.invItems || []).length).toBe(0);
      expect((db.journalEntries || []).length).toBe(0);
    });
  });
});
