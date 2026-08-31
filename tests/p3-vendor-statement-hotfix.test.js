// P3-HOTFIX — Vendor Statement Legacy Journal Compatibility.
//
// Reproduces the exact production regression found for account 2112
// (opening balance + 5 manual journal-voucher credits + 3 VND-PAY expense-
// type debits, all posted directly against the vendor's payable account,
// none through db.vendorBills[]) and proves GET /api/vendors/:id/statement
// now surfaces that activity as distinct 'legacy-journal' rows, without
// duplicating anything already represented via vendorBills, and reconciles
// to the same canonical GL balance /api/trial-balance uses.
//
// Isolated, real-app tests (DB_FILE_ONLY, os.tmpdir()) via supertest — same
// harness as tests/p0-7-ap-lifecycle.test.js. No production data anywhere.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p3-vendor-statement-hotfix-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p3-vstmt-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB } = require('../lib/database');
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

async function createVendor(name, accountId) {
  const res = await request(app).post('/api/vendors').set(auth()).send({ name, phone: '000' });
  expect(res.status).toBe(200);
  return res.body.vendor;
}

// Directly injects raw legacy-shaped journal entries (bypassing POST
// /api/journal) — replicates exactly how the production entries were
// found: no vendorBills record, posted straight against the account.
async function injectRawJournalEntries(entries) {
  await runAsTenant('default', async () => {
    const db = loadDB();
    db.journalEntries = db.journalEntries || [];
    db.journalEntries.push(...entries);
    await saveDB(db, { durable: true });
  });
}

async function getStatement(vendorId) {
  const r = await request(app).get(`/api/vendors/${vendorId}/statement`).set(auth());
  expect(r.status).toBe(200);
  return r.body;
}

// ═══════════════════════════════════════════════════════════════════════
// Vendor / AP Workspace Upgrade — T006: the workspace summary's
// reconciliation status (FR-003) and the full statement's own
// reconciliation summary (FR-011) are guaranteed to always agree because
// they are ONE shared calculation (clarification Q1, research.md
// Decision 1) — proven here at the data level: two independent GET
// requests to the same endpoint return byte-for-byte identical
// reconciliation objects, which is exactly what makes it safe for the
// frontend's workspace summary card (T010) and full-statement badge to
// both read from the same `.reconciliation` field of the same response
// without ever risking disagreement.
// ═══════════════════════════════════════════════════════════════════════
describe('Vendor Workspace — summary and full-statement reconciliation share one calculation (T006)', () => {
  test('T006 A: repeated reads of the statement endpoint return an identical reconciliation object, reconciled case', async () => {
    const vendor = await createVendor('Vendor-T006-Reconciled');
    await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendor.id, billDate: '2048-09-01', allocations: [{ accountCode: '5100', amount: 640 }],
    }).expect(200);

    const read1 = await getStatement(vendor.id);
    const read2 = await getStatement(vendor.id);
    // Byte-for-byte identical — this IS the guarantee FR-003/FR-011 require:
    // the workspace summary card and the full statement's own reconciliation
    // summary read this exact same field, so they can never disagree.
    expect(read2.reconciliation).toEqual(read1.reconciliation);
    expect(read1.reconciliation.reconciled).toBe(true);
  });

  test('T006 B: repeated reads also agree when NOT reconciled — the disagreement itself is reported identically both times, never smoothed over on a later read', async () => {
    const vendor = await createVendor('Vendor-T006-Mismatch');
    await injectRawJournalEntries([
      { id: 'T006-MISMATCH-JE', date: '2048-09-02', ref: 'T006-STALE', desc: 'Orphaned vendor-opening-tagged entry', type: 'manual', source: 'vendor-opening', totalDebit: 88, totalCredit: 88, lines: [{ accountCode: '5210', accountId: '5210', debit: 88, credit: 0 }, { accountCode: vendor.accountId, accountId: vendor.accountId, debit: 0, credit: 88 }] },
    ]);
    const read1 = await getStatement(vendor.id);
    const read2 = await getStatement(vendor.id);
    expect(read1.reconciliation.reconciled).toBe(false);
    expect(read2.reconciliation).toEqual(read1.reconciliation);
  });
});

describe('P3-HOTFIX Case A — legacy-only vendor (opening + manual credits + VND-PAY debits)', () => {
  test('all historical rows are visible and ending balance equals GL, with zero data mutation', async () => {
    const vendor = await createVendor('Legacy Lab A');
    await request(app).post('/api/vendors').set(auth()).send({ id: vendor.id, openingBalance: 4907.5, openingDate: '2048-01-01' }).expect(200);

    const jeCountBefore = (await runAsTenant('default', async () => loadDB().journalEntries.length));

    await injectRawJournalEntries([
      { id: 'LEG-JE-1', date: '2048-01-31', ref: 'JV-2048-0001', desc: 'صيانة مختبر', type: 'manual', source: 'manual', totalDebit: 300, totalCredit: 300, lines: [{ accountCode: '5210', accountId: '5210', debit: 300, credit: 0 }, { accountCode: vendor.accountId, accountId: vendor.accountId, debit: 0, credit: 300 }] },
      { id: 'LEG-JE-2', date: '2048-02-28', ref: 'JV-2048-0002', desc: 'مواد إضافية', type: 'manual', source: 'manual', totalDebit: 29, totalCredit: 29, lines: [{ accountCode: '5210', accountId: '5210', debit: 29, credit: 0 }, { accountCode: vendor.accountId, accountId: vendor.accountId, debit: 0, credit: 29 }] },
      { id: 'LEG-JE-3', date: '2048-03-15', ref: 'VND-PAY', desc: 'سداد نقدي', type: 'expense', source: 'expenses', totalDebit: 200, totalCredit: 200, lines: [{ accountCode: vendor.accountId, accountId: vendor.accountId, debit: 200, credit: 0 }, { accountCode: '1100', accountId: '1100', debit: 0, credit: 200 }] },
    ]);

    const stmt = await getStatement(vendor.id);
    // opening + 2 manual credits + 1 VND-PAY debit = 4 rows, none dropped.
    expect(stmt.rows.length).toBe(4);
    expect(stmt.rows.filter(r => r.type === 'legacy-journal').length).toBe(3);
    const expectedBalance = 4907.5 + 300 + 29 - 200; // 5036.5
    expect(stmt.endingBalance).toBeCloseTo(expectedBalance, 3);
    expect(stmt.reconciliation.glBalance).toBeCloseTo(expectedBalance, 3);
    expect(stmt.reconciliation.statementBalance).toBeCloseTo(expectedBalance, 3);
    expect(stmt.reconciliation.reconciled).toBe(true);

    // No data mutation: journal entry count only grew by exactly the 3 we injected ourselves — GET never wrote anything.
    const jeCountAfter = (await runAsTenant('default', async () => loadDB().journalEntries.length));
    expect(jeCountAfter).toBe(jeCountBefore + 3);
  });
});

describe('P3-HOTFIX Case B — modern vendorBills vendor: unchanged, no phantom legacy rows', () => {
  test('bill/payment journals are not duplicated as legacy-journal rows', async () => {
    const vendor = await createVendor('Modern Vendor B');
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({ vendorId: vendor.id, billDate: '2048-10-01', allocations: [{ accountCode: '5100', amount: 500 }] });
    await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/pay`).set(auth()).send({ amount: 300, payDate: '2048-10-05', payAccount: '1100' }).expect(200);

    const stmt = await getStatement(vendor.id);
    expect(stmt.rows.length).toBe(2); // bill + payment, no opening
    expect(stmt.rows.every(r => r.type !== 'legacy-journal')).toBe(true);
    expect(stmt.reconciliation.reconciled).toBe(true);
  });
});

describe('P3-HOTFIX Case C — mixed history: legacy direct journals + later vendorBills', () => {
  test('both appear, no duplicates, correct chronological running balance, reconciles to GL', async () => {
    const vendor = await createVendor('Mixed Vendor C');
    await request(app).post('/api/vendors').set(auth()).send({ id: vendor.id, openingBalance: 1000, openingDate: '2048-01-01' }).expect(200);

    await injectRawJournalEntries([
      { id: 'LEG-JE-C1', date: '2048-02-01', ref: 'JV-C1', desc: 'شراء قديم', type: 'manual', source: 'manual', totalDebit: 150, totalCredit: 150, lines: [{ accountCode: '5210', debit: 150, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 150 }] },
    ]);

    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({ vendorId: vendor.id, billDate: '2048-06-01', allocations: [{ accountCode: '5100', amount: 400 }] });
    await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/pay`).set(auth()).send({ amount: 100, payDate: '2048-06-10', payAccount: '1100' }).expect(200);

    const stmt = await getStatement(vendor.id);
    // opening + 1 legacy + 1 bill + 1 payment = 4, chronologically ordered.
    expect(stmt.rows.length).toBe(4);
    expect(stmt.rows.map(r => r.type)).toEqual(['opening', 'legacy-journal', 'bill', 'payment']);
    const expectedBalance = 1000 + 150 + 400 - 100; // 1450
    expect(stmt.endingBalance).toBeCloseTo(expectedBalance, 3);
    expect(stmt.reconciliation.glBalance).toBeCloseTo(expectedBalance, 3);
    expect(stmt.reconciliation.reconciled).toBe(true);
    // running balance is monotonically consistent with direction at each step
    expect(stmt.rows[0].runningBalance).toBeCloseTo(1000, 3);
    expect(stmt.rows[1].runningBalance).toBeCloseTo(1150, 3);
    expect(stmt.rows[2].runningBalance).toBeCloseTo(1550, 3);
    expect(stmt.rows[3].runningBalance).toBeCloseTo(1450, 3);
  });
});

describe('P3-HOTFIX Case D — opening balance appears exactly once', () => {
  test('no duplicate opening row even with other legacy activity present', async () => {
    const vendor = await createVendor('Opening-Once Vendor D');
    await request(app).post('/api/vendors').set(auth()).send({ id: vendor.id, openingBalance: 500, openingDate: '2048-01-01' }).expect(200);
    await injectRawJournalEntries([
      { id: 'LEG-JE-D1', date: '2048-02-01', ref: 'JV-D1', desc: 'نشاط تاريخي', type: 'manual', source: 'manual', totalDebit: 50, totalCredit: 50, lines: [{ accountCode: '5210', debit: 50, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 50 }] },
    ]);
    const stmt = await getStatement(vendor.id);
    expect(stmt.rows.filter(r => r.type === 'opening').length).toBe(1);
  });
});

describe('P3-HOTFIX — exact reproduction of the two real production vendors found affected', () => {
  test('account 2112 pattern (opening 4907.5 + 5 manual credits + 3 VND-PAY debits) reconciles to exactly 5,152.500', async () => {
    const vendor = await createVendor('مختبر معاويه');
    await request(app).post('/api/vendors').set(auth()).send({ id: vendor.id, openingBalance: 4907.5, openingDate: '2026-01-01' }).expect(200);
    await injectRawJournalEntries([
      { id: 'X1', date: '2026-01-31', ref: 'JV-2026-0007', desc: 'x', type: 'manual', source: 'manual', totalDebit: 300, totalCredit: 300, lines: [{ accountCode: '5210', debit: 300, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 300 }] },
      { id: 'X2', date: '2026-02-28', ref: 'JV-2026-0008', desc: 'x', type: 'manual', source: 'manual', totalDebit: 29, totalCredit: 29, lines: [{ accountCode: '5210', debit: 29, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 29 }] },
      { id: 'X3', date: '2026-03-15', ref: 'VND-PAY', desc: 'x', type: 'expense', source: 'expenses', totalDebit: 200, totalCredit: 200, lines: [{ accountCode: vendor.accountId, debit: 200, credit: 0 }, { accountCode: '1100', debit: 0, credit: 200 }] },
      { id: 'X4', date: '2026-03-31', ref: 'JV-2026-0009', desc: 'x', type: 'manual', source: 'manual', totalDebit: 75, totalCredit: 75, lines: [{ accountCode: '5210', debit: 75, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 75 }] },
      { id: 'X5', date: '2026-03-31', ref: 'VND-PAY', desc: 'x', type: 'expense', source: 'expenses', totalDebit: 150, totalCredit: 150, lines: [{ accountCode: vendor.accountId, debit: 150, credit: 0 }, { accountCode: '1100', debit: 0, credit: 150 }] },
      { id: 'X6', date: '2026-04-30', ref: 'JV-2026-0010', desc: 'x', type: 'manual', source: 'manual', totalDebit: 90, totalCredit: 90, lines: [{ accountCode: '5210', debit: 90, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 90 }] },
      { id: 'X7', date: '2026-05-31', ref: 'JV-2026-0011', desc: 'x', type: 'manual', source: 'manual', totalDebit: 131, totalCredit: 131, lines: [{ accountCode: '5210', debit: 131, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 131 }] },
      { id: 'X8', date: '2026-05-31', ref: 'VND-PAY', desc: 'x', type: 'expense', source: 'expenses', totalDebit: 30, totalCredit: 30, lines: [{ accountCode: vendor.accountId, debit: 30, credit: 0 }, { accountCode: '1100', debit: 0, credit: 30 }] },
    ]);
    const stmt = await getStatement(vendor.id);
    // 1 opening + 5 manual credits + 3 VND-PAY debits = 9 rows — matches the
    // real production account's exact movement count found in the backup.
    expect(stmt.rows.length).toBe(9);
    expect(stmt.endingBalance).toBe(5152.5);
    expect(stmt.reconciliation.glBalance).toBe(5152.5);
    expect(stmt.reconciliation.statementBalance).toBe(5152.5);
    expect(stmt.reconciliation.difference).toBe(0);
    expect(stmt.reconciliation.reconciled).toBe(true);
  });

  test('account 2102 pattern (no opening + 5 manual credits of 30 + 1 expense debit of 90) reconciles to exactly 60.000', async () => {
    const vendor = await createVendor('شركة رائد للتجارة');
    await injectRawJournalEntries([
      { id: 'Y1', date: '2026-01-01', ref: 'JV-2026-0001', desc: 'x', type: 'manual', source: 'manual', totalDebit: 30, totalCredit: 30, lines: [{ accountCode: '5210', debit: 30, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 30 }] },
      { id: 'Y2', date: '2026-01-31', ref: 'EXP-AUTO', desc: 'x', type: 'expense', source: 'expenses', totalDebit: 90, totalCredit: 90, lines: [{ accountCode: vendor.accountId, debit: 90, credit: 0 }, { accountCode: '1100', debit: 0, credit: 90 }] },
      { id: 'Y3', date: '2026-02-01', ref: 'JV-2026-0002', desc: 'x', type: 'manual', source: 'manual', totalDebit: 30, totalCredit: 30, lines: [{ accountCode: '5210', debit: 30, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 30 }] },
      { id: 'Y4', date: '2026-03-01', ref: 'JV-2026-0003', desc: 'x', type: 'manual', source: 'manual', totalDebit: 30, totalCredit: 30, lines: [{ accountCode: '5210', debit: 30, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 30 }] },
      { id: 'Y5', date: '2026-04-01', ref: 'JV-2026-0004', desc: 'x', type: 'manual', source: 'manual', totalDebit: 30, totalCredit: 30, lines: [{ accountCode: '5210', debit: 30, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 30 }] },
      { id: 'Y6', date: '2026-05-01', ref: 'JV-2026-0005', desc: 'x', type: 'manual', source: 'manual', totalDebit: 30, totalCredit: 30, lines: [{ accountCode: '5210', debit: 30, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 30 }] },
    ]);
    const stmt = await getStatement(vendor.id);
    expect(stmt.rows.length).toBe(6);
    expect(stmt.endingBalance).toBe(60);
    expect(stmt.reconciliation.glBalance).toBe(60);
    expect(stmt.reconciliation.reconciled).toBe(true);
  });
});

describe('P3-HOTFIX Case E — legacy account field variants (accountCode / accountId / account)', () => {
  test('a line using ONLY accountId, and a line using ONLY the bare "account" field, are both detected', async () => {
    const vendor = await createVendor('Field-Variant Vendor E');
    await injectRawJournalEntries([
      // accountCode present, matches vendor's accountId value
      { id: 'LEG-JE-E1', date: '2048-01-10', ref: 'JV-E1', desc: 'عبر accountCode', type: 'manual', source: 'manual', totalDebit: 10, totalCredit: 10, lines: [{ accountCode: '5210', debit: 10, credit: 0 }, { accountCode: vendor.accountId, debit: 0, credit: 10 }] },
      // ONLY accountId set (no accountCode) — the older field-naming variant
      { id: 'LEG-JE-E2', date: '2048-01-20', ref: 'JV-E2', desc: 'عبر accountId فقط', type: 'manual', source: 'manual', totalDebit: 20, totalCredit: 20, lines: [{ accountCode: '5210', debit: 20, credit: 0 }, { accountId: vendor.accountId, debit: 0, credit: 20 }] },
      // ONLY bare "account" set — the depreciation-route-style legacy field
      { id: 'LEG-JE-E3', date: '2048-01-25', ref: 'JV-E3', desc: 'عبر account فقط', type: 'manual', source: 'manual', totalDebit: 30, totalCredit: 30, lines: [{ accountCode: '5210', debit: 30, credit: 0 }, { account: vendor.accountId, debit: 0, credit: 30 }] },
    ]);
    const stmt = await getStatement(vendor.id);
    expect(stmt.rows.length).toBe(3);
    expect(stmt.rows.map(r => r.reference).sort()).toEqual(['JV-E1', 'JV-E2', 'JV-E3']);
    expect(stmt.endingBalance).toBeCloseTo(60, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Vendor / AP Workspace Upgrade — T032: the reconciliation-mismatch
// warning (shared by the workspace summary card, T010, and the full
// statement's own reconciliation summary, FR-011 — Decision 1's single
// shared source) renders from a genuinely honest difference against a
// deliberate fixture, and confirms zero data mutation from merely
// viewing it (spec.md FR-020: no auto-correction, ever).
// ═══════════════════════════════════════════════════════════════════════
describe('P3-HOTFIX — reconciliation mismatch warning (T032)', () => {
  test('a deliberate GL/statement difference is reported honestly, identically on repeated views, with zero data mutation', async () => {
    const vendor = await createVendor('Legacy Lab Mismatch');
    const jeCountBefore = (await runAsTenant('default', async () => loadDB().journalEntries.length));

    // A journal entry tagged source:'vendor-opening' — the statement
    // endpoint's own exclusion logic (server.js:6488) drops ANY such entry
    // from the legacy-journal rows unconditionally (it assumes the real
    // opening-balance row, generated separately from vendor.openingBalance,
    // already represents it) — but buildBalanceMap() (server.js:6517, no
    // date filtering for this endpoint) still nets its debit/credit into
    // the vendor's real GL balance regardless of source. This vendor's own
    // openingBalance is left at its default 0, so no real opening row is
    // generated to coincidentally absorb it. The result is a deliberate,
    // reproducible GL-vs-statement divergence — not a contrived assertion,
    // but the same class of gap Reconciliation B (tests/p0-7-ap-lifecycle)
    // already proves exists for a different source tag (payMethod:'accrued').
    await injectRawJournalEntries([
      { id: 'MISMATCH-JE-1', date: '2048-06-01', ref: 'STALE-REF', desc: 'Orphaned vendor-opening-tagged entry', type: 'manual', source: 'vendor-opening', totalDebit: 175, totalCredit: 175, lines: [{ accountCode: '5210', accountId: '5210', debit: 175, credit: 0 }, { accountCode: vendor.accountId, accountId: vendor.accountId, debit: 0, credit: 175 }] },
    ]);

    const stmt1 = await getStatement(vendor.id);
    // The tagged entry never appears as a statement row (excluded by its
    // own source:'vendor-opening' tag, and this vendor has no real opening
    // balance to generate one in its place) ...
    expect(stmt1.rows.length).toBe(0);
    expect(stmt1.endingBalance).toBeCloseTo(0, 3);
    // ... yet it moved the real GL balance, so the single shared
    // reconciliation check (FR-003/FR-011) must report a real, honest
    // difference — never silently plugged or auto-corrected (FR-020).
    expect(stmt1.reconciliation.reconciled).toBe(false);
    expect(stmt1.reconciliation.glBalance).toBeCloseTo(175, 3);
    expect(stmt1.reconciliation.statementBalance).toBeCloseTo(0, 3);
    expect(stmt1.reconciliation.difference).toBeCloseTo(-175, 3);

    // Merely viewing (GET) the statement a second time must not mutate
    // anything: identical reconciliation, identical journal entry count —
    // no auto-correcting journal entry was created by viewing the warning.
    const stmt2 = await getStatement(vendor.id);
    expect(stmt2.reconciliation).toEqual(stmt1.reconciliation);
    expect(stmt2.rows.length).toBe(0);
    const jeCountAfter = (await runAsTenant('default', async () => loadDB().journalEntries.length));
    expect(jeCountAfter).toBe(jeCountBefore + 1);
  });
});
