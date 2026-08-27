// P0.9 — Chart of Accounts Integrity, Account Classification & Period-Lock
// Control Closure.
//
// Isolated, real-app tests (DB_FILE_ONLY, os.tmpdir()) via supertest against
// the real exported Express app — no production data, no real network.
// Covers: account type immutability once historical entries exist, COA
// parent/child hierarchy integrity (orphan/cycle/incompatible-type
// rejection), delete safety (journal history, subledger references, system-
// protected accounts, children), active/inactive posting policy, the
// P6-072 account-code fix (1120->1130, 5700->5720/4200->4150), remaining
// period-lock coverage, vendor orphan protection, configured-account
// validation, RBAC, audit, persistence, tenant isolation, and regression of
// P0.6A/P0.6B/P0.7/P0.8.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-9-coa-integrity-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p09-'));
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
      { id: 'usr-acct',  username: 'accountant1', email: 'a@test.com', passwordHash: hash('AcctPass1!'), role: 'accountant', fullName: 'محاسب', active: true, createdAt: new Date().toISOString(), lastLogin: null },
    ],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], fixedAssets: [], budget: {}, auditLog: [], accruedExpenses: [],
    journalMappings: [], doctorExpenses: [], lockedPeriods: {}, vendorBills: [], accountingSettings: {},
    patientAR: [], patients: [], patientReceivables: [],
  };
}

let adminToken, recepToken, acctToken;

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
  const login3 = await request(app).post('/api/auth/login').send({ username: 'accountant1', password: 'AcctPass1!' });
  acctToken = login3.body.token;
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

async function createAccount(overrides) {
  const res = await request(app).post('/api/coa/account').set(auth()).send({
    code: overrides.code, name: overrides.name || ('Acc-' + overrides.code),
    type: overrides.type || 'expense', parent: overrides.parent, isGroup: !!overrides.isGroup,
  });
  return res;
}

async function postJournal(date, lines, desc) {
  return request(app).post('/api/journal').set(auth()).send({ date, desc: desc || 'test entry', lines });
}

async function runAsTenantCoa() {
  let coa;
  await runAsTenant('default', async () => { coa = loadDB().chartOfAccounts; });
  return coa;
}

// ═══════════════════════════════════════════════════════════════════════
// Type Integrity A-D
// ═══════════════════════════════════════════════════════════════════════
describe('P0.9 — Account Type Integrity (P6-004)', () => {
  test('Type A: an unused account\'s type can be changed freely', async () => {
    await createAccount({ code: '5901', name: 'Unused-TypeA', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    const res = await request(app).put('/api/coa/account/5901').set(auth()).send({ type: 'asset' });
    expect(res.status).toBe(200);
    expect(res.body.account.type).toBe('asset');
  });

  test('Type B: an account with journal history cannot have its type changed', async () => {
    await createAccount({ code: '5902', name: 'Historical-TypeB', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await postJournal('2051-01-05', [{ accountCode: '5902', debit: 100, credit: 0 }, { accountCode: '1100', debit: 0, credit: 100 }]).then(r => expect(r.status).toBe(200));
    const res = await request(app).put('/api/coa/account/5902').set(auth()).send({ type: 'asset' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACCOUNT_TYPE_LOCKED');
    const coa = await runAsTenantCoa();
    expect(coa.find(a => a.code === '5902').type).toBe('expense'); // unchanged
  });

  test('Type C: renaming a historical account (not changing type) is still allowed', async () => {
    await createAccount({ code: '5903', name: 'Historical-TypeC-Old', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await postJournal('2051-01-05', [{ accountCode: '5903', debit: 50, credit: 0 }, { accountCode: '1100', debit: 0, credit: 50 }]).then(r => expect(r.status).toBe(200));
    const res = await request(app).put('/api/coa/account/5903').set(auth()).send({ name: 'Historical-TypeC-New' });
    expect(res.status).toBe(200);
    expect(res.body.account.name).toBe('Historical-TypeC-New');
  });

  test('Type D: reassigning an account to a parent of an incompatible type is rejected', async () => {
    await createAccount({ code: '5904', name: 'IncompatParent-TypeD', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    const res = await request(app).put('/api/coa/account/5904').set(auth()).send({ parent: '2000' }); // liability group
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INCOMPATIBLE_PARENT_TYPE');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Hierarchy A-E
// ═══════════════════════════════════════════════════════════════════════
describe('P0.9 — COA Hierarchy Integrity (P6-006/P6-007)', () => {
  test('Hierarchy A: an account cannot be made its own parent', async () => {
    await createAccount({ code: '5910', name: 'SelfParent-A', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    const res = await request(app).put('/api/coa/account/5910').set(auth()).send({ parent: '5910' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CIRCULAR_PARENT');
  });

  test('Hierarchy B: a two-node parent cycle is rejected', async () => {
    await createAccount({ code: '5911', name: 'Cycle-B1', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await createAccount({ code: '5912', name: 'Cycle-B2', type: 'expense', parent: '5911' }).then(r => expect(r.status).toBe(200));
    const res = await request(app).put('/api/coa/account/5911').set(auth()).send({ parent: '5912' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CIRCULAR_PARENT');
  });

  test('Hierarchy C: a deeper (3-node) parent cycle is rejected', async () => {
    await createAccount({ code: '5913', name: 'Cycle-C1', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await createAccount({ code: '5914', name: 'Cycle-C2', type: 'expense', parent: '5913' }).then(r => expect(r.status).toBe(200));
    await createAccount({ code: '5915', name: 'Cycle-C3', type: 'expense', parent: '5914' }).then(r => expect(r.status).toBe(200));
    const res = await request(app).put('/api/coa/account/5913').set(auth()).send({ parent: '5915' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CIRCULAR_PARENT');
  });

  test('Hierarchy D: creating an account under a parent of an incompatible type is rejected', async () => {
    const res = await createAccount({ code: '4910', name: 'BadParent-D', type: 'revenue', parent: '5000' }); // expense group
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INCOMPATIBLE_PARENT_TYPE');
  });

  test('Hierarchy E: creating an account under a valid, type-matching parent is accepted', async () => {
    const res = await createAccount({ code: '5920', name: 'ValidChild-E', type: 'expense', parent: '5000' });
    expect(res.status).toBe(200);
    expect(res.body.account.parent).toBe('5000');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Delete Safety A-F
// ═══════════════════════════════════════════════════════════════════════
describe('P0.9 — COA Delete Safety', () => {
  test('Delete A: an account with journal history cannot be deleted', async () => {
    // R3: was '5930' — now the real, SYSTEM_PROTECTED insurance doubtful-
    // debt account (P6072 C fix below), so deletion would hit
    // SYSTEM_ACCOUNT_PROTECTED before this test's own HAS_ENTRIES guard
    // ever got exercised. Moved to '6900' (a range DEFAULT_COA never uses)
    // to keep testing an ordinary, non-system account's history guard.
    await createAccount({ code: '6900', name: 'HasEntries-A', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await postJournal('2051-02-01', [{ accountCode: '6900', debit: 10, credit: 0 }, { accountCode: '1100', debit: 0, credit: 10 }]).then(r => expect(r.status).toBe(200));
    const res = await request(app).delete('/api/coa/account/6900').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_ENTRIES');
  });

  test('Delete B: an account referenced by a vendor (AP) cannot be deleted', async () => {
    const vRes = await request(app).post('/api/vendors').set(auth()).send({ name: 'Vendor-Delete-B' });
    expect(vRes.status).toBe(200);
    const res = await request(app).delete(`/api/coa/account/${vRes.body.vendor.accountId}`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_SUBLEDGER_REFERENCE');
  });

  test('Delete C: an account referenced by a patient receivable (AR) cannot be deleted', async () => {
    await createAccount({ code: '4920', name: 'PatientRevenue-C', type: 'revenue', parent: '4000' }).then(r => expect(r.status).toBe(200));
    const pRes = await request(app).post('/api/patients').set(auth()).send({ name: 'Patient-Delete-C' });
    await request(app).post('/api/patient-receivables').set(auth()).send({ patientId: pRes.body.patient.id, serviceDate: '2051-02-01', amount: 50, revenueAccountCode: '4920' }).then(r => expect(r.status).toBe(200));
    const res = await request(app).delete('/api/coa/account/4920').set(auth());
    expect(res.status).toBe(409);
    // Recognizing a patient receivable always posts a real journal entry
    // too, so accountHasEntries() (checked first) already rejects this —
    // HAS_SUBLEDGER_REFERENCE is reached only when a subledger reference
    // exists with genuinely zero journal lines of its own (covered by
    // "Delete B", a vendor with no bills yet). Both are real, independent
    // protections; this scenario legitimately trips the first one.
    expect(res.body.code).toBe('HAS_ENTRIES');
  });

  test('Delete D: a parent account with children cannot be deleted', async () => {
    await createAccount({ code: '5940', name: 'Parent-D', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await createAccount({ code: '5941', name: 'Child-D', type: 'expense', parent: '5940' }).then(r => expect(r.status).toBe(200));
    const res = await request(app).delete('/api/coa/account/5940').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_CHILDREN');
  });

  test('Delete E: a system-controlled account cannot be deleted even if unused', async () => {
    const res = await request(app).delete('/api/coa/account/1200').set(auth()); // patient AR control account
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYSTEM_ACCOUNT_PROTECTED');
  });

  test('Delete F: a genuinely unused custom account can be deleted', async () => {
    await createAccount({ code: '5950', name: 'TrulyUnused-F', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    const res = await request(app).delete('/api/coa/account/5950').set(auth());
    expect(res.status).toBe(200);
    const coa = await runAsTenantCoa();
    expect(coa.find(a => a.code === '5950')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Active State A-C
// ═══════════════════════════════════════════════════════════════════════
describe('P0.9 — Account Deactivation & Posting Policy', () => {
  test('Active A: a historical account can be safely deactivated', async () => {
    await createAccount({ code: '5960', name: 'ToDeactivate-A', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await postJournal('2051-02-05', [{ accountCode: '5960', debit: 20, credit: 0 }, { accountCode: '1100', debit: 0, credit: 20 }]).then(r => expect(r.status).toBe(200));
    const res = await request(app).put('/api/coa/account/5960').set(auth()).send({ status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body.account.status).toBe('inactive');
  });

  test('Active B: posting a NEW journal entry to an inactive account is rejected', async () => {
    const res = await postJournal('2051-02-06', [{ accountCode: '5960', debit: 5, credit: 0 }, { accountCode: '1100', debit: 0, credit: 5 }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INACTIVE_ACCOUNT_POSTING');
  });

  test('Active C: the trial balance still includes the inactive account\'s historical entry', async () => {
    const tb = await request(app).get('/api/trial-balance').set(auth());
    expect(tb.status).toBe(200);
    const row = tb.body.rows.find(r => r.code === '5960');
    // Trial balance must still reflect the 20 posted while the account was active — not silently dropped
    // just because the account is now inactive (reports never filter by status).
    expect(row).toBeTruthy();
    expect(row.totalDebit).toBeCloseTo(20, 3);
    expect(tb.body.isBalanced).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// P6-072 A-E
// ═══════════════════════════════════════════════════════════════════════
describe('P0.9 — P6-072: insurance/bad-debt account-code fix', () => {
  test('P6072 A: creating an insurance claim posts the receivable to 1130, not 1120', async () => {
    const res = await request(app).post('/api/insurance-claims').set(auth()).send({ company: 'GIG', claimDate: '2051-03-01', amount: 300 });
    expect(res.status).toBe(200);
    let je;
    await runAsTenant('default', async () => { je = loadDB().journalEntries.find(j => j.ref === res.body.claim.claimNo); });
    expect(je.lines.some(l => l.accountCode === '1130')).toBe(true);
    expect(je.lines.some(l => l.accountCode === '1120')).toBe(false);
  });

  test('P6072 B: an immediate KNET manual-entry payment remains correctly on 1110 — unaffected by the insurance fix', async () => {
    const res = await request(app).post('/api/manual-entry').set(auth()).send({ date: '2051-03-02', knet: 200 });
    expect(res.status).toBe(200);
    let je;
    await runAsTenant('default', async () => { je = loadDB().journalEntries.find(j => j.id === 'JE-MAN-' + new Date('2051-03-02').getTime()) || loadDB().journalEntries.find(j => j.ref === 'MAN' && j.date === '2051-03-02'); });
    expect(je.lines.some(l => l.accountCode === '1110')).toBe(true);
    expect(je.lines.some(l => l.accountCode === '1120')).toBe(false);
  });

  // R3 (adversarial review): '5720' was ITSELF a collision — DEFAULT_COA
  // already defines 5720 = "إقامات وتأشيرات" (an unrelated, actively
  // category-mapped staff expense account) — ensureAccount() silently
  // reused it instead of creating a dedicated doubtful-debt account. Same
  // bug class as the 5710->5920 fix this test already covers below (P6072
  // D). Moved to a genuinely free code, 5930.
  test('P6072 C: insurance claim shortfall write-off posts to the dedicated 5930, not 5700 or the colliding 5720', async () => {
    const claimRes = await request(app).post('/api/insurance-claims').set(auth()).send({ company: 'GIG-Shortfall', claimDate: '2051-03-03', amount: 500 });
    const res = await request(app).put(`/api/insurance-claims/${claimRes.body.claim.id}`).set(auth()).send({ status: 'received', receivedAmount: 400, receivedDate: '2051-03-10' });
    expect(res.status).toBe(200);
    let je;
    await runAsTenant('default', async () => { je = loadDB().journalEntries.find(j => j.id.startsWith('JE-CLM-RCV-')); });
    expect(je.lines.some(l => l.accountCode === '5930')).toBe(true);
    expect(je.lines.some(l => l.accountCode === '5700')).toBe(false);
    expect(je.lines.some(l => l.accountCode === '5720')).toBe(false);
  });

  test('P6072 D: patient bad-debt write-off (P0.8, account 5920) remains distinct and unaffected', async () => {
    // R2 fix: account moved 5710 -> 5920 (5710 collides with DEFAULT_COA's
    // pre-seeded "هاتف وإنترنت" — discovered via live UI testing in R2).
    const pRes = await request(app).post('/api/patients').set(auth()).send({ name: 'Patient-P6072-D' });
    const rRes = await request(app).post('/api/patient-receivables').set(auth()).send({ patientId: pRes.body.patient.id, serviceDate: '2051-03-04', amount: 150 });
    const woRes = await request(app).post(`/api/patient-receivables/${rRes.body.receivable.id}/writeoff`).set(auth()).send({});
    expect(woRes.status).toBe(200);
    let je;
    await runAsTenant('default', async () => { je = loadDB().journalEntries.find(j => j.id === woRes.body.journalId); });
    expect(je.lines.some(l => l.accountCode === '5920')).toBe(true);
    expect(je.lines.some(l => l.accountCode === '5710')).toBe(false); // no longer collides with the pre-seeded phone/internet account
    expect(je.lines.some(l => l.accountCode === '5720')).toBe(false); // patient bad debt and insurance doubtful debt stay separate
  });

  test('P6072 E: insurance claim revenue posts to 4150, not 4200', async () => {
    const res = await request(app).post('/api/insurance-claims').set(auth()).send({ company: 'GIG-Rev', claimDate: '2051-03-05', amount: 250 });
    let je;
    await runAsTenant('default', async () => { je = loadDB().journalEntries.find(j => j.ref === res.body.claim.claimNo); });
    expect(je.lines.some(l => l.accountCode === '4150')).toBe(true);
    expect(je.lines.some(l => l.accountCode === '4200')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Period Lock A-C
// ═══════════════════════════════════════════════════════════════════════
describe('P0.9 — Remaining Period-Lock Coverage', () => {
  test('PeriodLock A: creating an insurance claim (new journal) in a locked period is rejected', async () => {
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2051-04', locked: true }).expect(200);
    const res = await request(app).post('/api/insurance-claims').set(auth()).send({ company: 'Locked-Co', claimDate: '2051-04-10', amount: 100 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('PeriodLock B: marking an insurance claim received (new journal) in a locked period is rejected', async () => {
    const claimRes = await request(app).post('/api/insurance-claims').set(auth()).send({ company: 'Locked-Co-2', claimDate: '2051-05-01', amount: 100 });
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2051-05', locked: true }).expect(200);
    const res = await request(app).put(`/api/insurance-claims/${claimRes.body.claim.id}`).set(auth()).send({ status: 'received', receivedAmount: 100, receivedDate: '2051-05-15' });
    // creating this claim ITSELF should have been rejected by the guard above too, since claimDate is inside 2051-05
    expect(res.status).toBe(409);
  });

  test('PeriodLock C: the same lifecycle in an OPEN period still works end-to-end (safe path unaffected)', async () => {
    const claimRes = await request(app).post('/api/insurance-claims').set(auth()).send({ company: 'Open-Co', claimDate: '2051-06-01', amount: 100 });
    expect(claimRes.status).toBe(200);
    const res = await request(app).put(`/api/insurance-claims/${claimRes.body.claim.id}`).set(auth()).send({ status: 'received', receivedAmount: 100, receivedDate: '2051-06-10' });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Vendor Orphan Protection A-B (Part G — newly discovered while enumerating)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.9 — Vendor Deletion Orphan Protection', () => {
  test('Orphan A: a vendor with a posted bill cannot be deleted', async () => {
    const vRes = await request(app).post('/api/vendors').set(auth()).send({ name: 'Vendor-Orphan-A' });
    await request(app).post('/api/vendor-bills').set(auth()).send({ vendorId: vRes.body.vendor.id, billDate: '2051-06-01', allocations: [{ accountCode: '5200', amount: 50 }] }).then(r => expect(r.status).toBe(200));
    const res = await request(app).delete(`/api/vendors/${vRes.body.vendor.id}`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VENDOR_HAS_BILLS');
  });

  test('Orphan B: a vendor with a posted opening balance cannot be deleted', async () => {
    const vRes = await request(app).post('/api/vendors').set(auth()).send({ name: 'Vendor-Orphan-B', openingBalance: 200, openingDate: '2051-06-01' });
    expect(vRes.status).toBe(200);
    const res = await request(app).delete(`/api/vendors/${vRes.body.vendor.id}`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VENDOR_HAS_OPENING_BALANCE');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Configuration Account Validation A-C
// ═══════════════════════════════════════════════════════════════════════
describe('P0.9 — Configured Account Validation', () => {
  test('Config A: patient-opening import rejects a missing configured receivable account', async () => {
    await runAsTenant('default', async () => { const db = loadDB(); db.accountingSettings = db.accountingSettings || {}; db.accountingSettings.accReceivable = '9999-GONE'; saveDB(db); });
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([{ 'اسم المريض': 'ConfigA-Patient', 'المبلغ المستحق (د.ك)': 100, 'التاريخ الافتتاحي': '2051-07-01' }]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const res = await request(app).post('/api/import/patient-opening').set(auth()).attach('file', buf, 'opening.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIGURED_ACCOUNT_MISSING');
    await runAsTenant('default', async () => { const db = loadDB(); delete db.accountingSettings.accReceivable; saveDB(db); });
  });

  test('Config B: patient-opening import rejects a wrong-type configured receivable account', async () => {
    await runAsTenant('default', async () => { const db = loadDB(); db.accountingSettings = db.accountingSettings || {}; db.accountingSettings.accReceivable = '5000'; saveDB(db); }); // expense group, wrong type
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([{ 'اسم المريض': 'ConfigB-Patient', 'المبلغ المستحق (د.ك)': 100, 'التاريخ الافتتاحي': '2051-07-02' }]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const res = await request(app).post('/api/import/patient-opening').set(auth()).attach('file', buf, 'opening2.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIGURED_ACCOUNT_WRONG_TYPE');
    await runAsTenant('default', async () => { const db = loadDB(); delete db.accountingSettings.accReceivable; saveDB(db); });
  });

  test('Config C: a valid configured receivable account is accepted', async () => {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([{ 'اسم المريض': 'ConfigC-Patient', 'المبلغ المستحق (د.ك)': 75, 'التاريخ الافتتاحي': '2051-07-03' }]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const res = await request(app).post('/api/import/patient-opening').set(auth()).attach('file', buf, 'opening3.xlsx');
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RBAC A-C / Audit A-C / Persistence A / Tenant A
// ═══════════════════════════════════════════════════════════════════════
describe('P0.9 — RBAC, Audit, Persistence, Tenant Isolation', () => {
  test('RBAC A: a role without coa:add permission cannot create an account', async () => {
    const res = await createAccount({ code: '5970', name: 'RBAC-A', type: 'expense', parent: '5000' });
    // reuse createAccount but with receptionist token by calling raw request
    const res2 = await request(app).post('/api/coa/account').set(auth(recepToken)).send({ code: '5971', name: 'RBAC-A2', type: 'expense', parent: '5000' });
    expect(res2.status).toBe(403);
  });

  test('RBAC B: a role without coa:edit permission cannot edit an account', async () => {
    const res = await request(app).put('/api/coa/account/5001').set(auth(recepToken)).send({ name: 'x' });
    expect(res.status).toBe(403);
  });

  test('RBAC C: a role without coa:delete permission cannot delete an account (accountant has add/edit but not delete)', async () => {
    await createAccount({ code: '5980', name: 'RBAC-C', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    const res = await request(app).delete('/api/coa/account/5980').set(auth(acctToken));
    expect(res.status).toBe(403);
  });

  test('Audit A: a valid account edit is audited', async () => {
    await createAccount({ code: '5990', name: 'Audit-A-Old', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await request(app).put('/api/coa/account/5990').set(auth()).send({ name: 'Audit-A-New' }).then(r => expect(r.status).toBe(200));
    let audit;
    await runAsTenant('default', async () => { audit = loadDB().auditLog.find(a => a.action === 'coa.account_updated' && a.resourceId === '5990'); });
    expect(audit).toBeTruthy();
  });

  test('Audit B: deactivation is audited', async () => {
    await createAccount({ code: '5991', name: 'Audit-B', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await request(app).put('/api/coa/account/5991').set(auth()).send({ status: 'inactive' }).then(r => expect(r.status).toBe(200));
    let audit;
    await runAsTenant('default', async () => { audit = loadDB().auditLog.find(a => a.action === 'coa.account_updated' && a.resourceId === '5991'); });
    expect(audit).toBeTruthy();
  });

  test('Audit C: a valid unused-account deletion is audited', async () => {
    await createAccount({ code: '5992', name: 'Audit-C', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await request(app).delete('/api/coa/account/5992').set(auth()).then(r => expect(r.status).toBe(200));
    let audit;
    await runAsTenant('default', async () => { audit = loadDB().auditLog.find(a => a.action === 'coa.account_deleted' && a.resourceId === '5992'); });
    expect(audit).toBeTruthy();
  });

  test('Persistence A: an allowed COA change survives shutdownDB/initDB reload', async () => {
    await createAccount({ code: '5993', name: 'Persist-Before', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));
    await shutdownDB();
    await initDB({
      mongoUri: 'mongodb://127.0.0.1:1/unused', dataFile: process.env.DATA_FILE, configFile: process.env.CONFIG_FILE,
      defaultConfig: {}, buildInitialDB, migrateDB: () => false,
    });
    let acc;
    await runAsTenant('default', async () => { acc = loadDB().chartOfAccounts.find(a => a.code === '5993'); });
    expect(acc).toBeTruthy();
    expect(acc.name).toBe('Persist-Before');
  });

  test('Tenant A: Tenant A COA mutation cannot affect Tenant B', async () => {
    await runAsTenant('tenant-b-p09', async () => {
      await warmTenantCache('tenant-b-p09');
      const db = loadDB();
      db.users = [{ id: 'usr-tb9', username: 'tenantb9', email: 'tb9@test.com', passwordHash: hash('TenantB1!'), role: 'admin', fullName: 'Tenant B Admin', active: true, createdAt: new Date().toISOString(), lastLogin: null }];
      db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
      saveDB(db);
    });
    const loginB = await request(app).post('/api/auth/login').send({ username: 'tenantb9', password: 'TenantB1!', tenantId: 'tenant-b-p09' });
    const tokenB = loginB.body.token;

    await createAccount({ code: '5994', name: 'TenantA-Only', type: 'expense', parent: '5000' }).then(r => expect(r.status).toBe(200));

    const coaB = await request(app).get('/api/coa').set(auth(tokenB));
    expect(coaB.status).toBe(200);
    expect(coaB.body.find(a => a.code === '5994')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Regression A-D
// ═══════════════════════════════════════════════════════════════════════
describe('P0.9 — Regression: P0.7/P0.8/P0.6B/P0.6A scenarios remain correct', () => {
  test('Regression A: the P0.7 AP vendor-bill lifecycle remains green', async () => {
    const vendorRes = await request(app).post('/api/vendors').set(auth()).send({ name: 'Vendor-P09-Regression' });
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({ vendorId: vendorRes.body.vendor.id, billDate: '2051-08-01', allocations: [{ accountCode: '5200', amount: 400 }] });
    expect(billRes.status).toBe(200);
    const payRes = await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/pay`).set(auth()).send({ amount: 400, payAccount: '1100' });
    expect(payRes.status).toBe(200);
    expect(payRes.body.bill.status).toBe('PAID');
  });

  test('Regression B: the P0.8 Patient AR lifecycle remains green', async () => {
    const pRes = await request(app).post('/api/patients').set(auth()).send({ name: 'Patient-P09-Regression' });
    const rRes = await request(app).post('/api/patient-receivables').set(auth()).send({ patientId: pRes.body.patient.id, serviceDate: '2051-08-01', amount: 300 });
    expect(rRes.status).toBe(200);
    const collRes = await request(app).post(`/api/patient-receivables/${rRes.body.receivable.id}/collect`).set(auth()).send({ amount: 300, collectAccount: '1100' });
    expect(collRes.status).toBe(200);
    expect(collRes.body.receivable.status).toBe('COLLECTED');
  });

  test('Regression C: P0.6B doctor commission reconciliation endpoint remains functional', async () => {
    const docRes = await request(app).post('/api/doctors').set(auth()).send({ doctors: [{ name: 'Dr-P09-Regression', target: 0, commission: 30, lab: 0, insurance: 0 }] });
    expect(docRes.status).toBe(200);
    const recon = await request(app).get('/api/doctors/commission-reconciliation').set(auth());
    expect(recon.status).toBe(200);
  });

  test('Regression D: P0.6A Trial Balance remains internally balanced after this whole file\'s activity', async () => {
    const tb = await request(app).get('/api/trial-balance').set(auth());
    expect(tb.status).toBe(200);
    expect(tb.body.isBalanced).toBe(true);
  });
});
