// P1 — Record Workspace & Master Data Management. Targeted regression for
// the new Journal list/detail, Patient detail/edit, Doctor list/detail/edit,
// and Fixed Asset detail APIs (NEW-R5-ADV-JOURNAL-NO-GET-01,
// NEW-R5-ADV-PATIENTS-NO-EDIT-01, NEW-R5-ADV-DOCTORS-NO-LIST-01,
// NEW-R5-ADV-ASSETS-NO-PERID-01). Does not touch canonical accounting logic,
// AP/AR calculations, or financial-statement logic — only adds read/safe-edit
// surfaces on top of it.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p1-record-workspace-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p1-record-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB, warmTenantCache } = require('../lib/database');
const { DEFAULT_COA } = require('../lib/defaults');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [
      { id: 'usr-admin', username: 'admin', email: 'admin@test.com', passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير', active: true, createdAt: new Date().toISOString(), lastLogin: null },
      { id: 'usr-noperm', username: 'noperm', email: 'noperm@test.com', passwordHash: hash('NoPermPass1!'), role: 'noperm', fullName: 'بلا صلاحيات', active: true, createdAt: new Date().toISOString(), lastLogin: null },
    ],
    roles: {
      admin:   { id: 'admin',   tabs: ['*'], actions: {} },
      noperm:  { id: 'noperm',  tabs: [],    actions: {} },
    },
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], fixedAssets: [], budget: {}, auditLog: [], accruedExpenses: [],
    journalMappings: [], doctorExpenses: [], doctorPayments: [], lockedPeriods: {}, vendorBills: [], accountingSettings: {},
    patients: [], patientReceivables: [],
  };
}

let adminToken, noPermToken, tenantBToken;

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
  const loginNoPerm = await request(app).post('/api/auth/login').send({ username: 'noperm', password: 'NoPermPass1!' });
  noPermToken = loginNoPerm.body.token;

  // A second tenant, for the three isolation tests below — same shape as
  // tests/tenant-isolation-http.test.js's established pattern.
  await runAsTenant('tenant-p1-b', async () => {
    await warmTenantCache('tenant-p1-b');
    const db = loadDB();
    db.users = [{ id: 'usr-tenantb', tenantId: 'tenant-p1-b', username: 'ownerb', email: 'ownerb@test.com', passwordHash: hash('OwnerB1234!'), role: 'admin', fullName: 'Owner B', active: true, createdAt: new Date().toISOString(), lastLogin: null }];
    db.roles = { admin: { id: 'admin', tabs: ['*'], actions: {} } };
    db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
    db.journalEntries = [{ id: 'JE-TENANTB-1', date: '2026-02-10', desc: 'TENANT_B_ONLY_JOURNAL', description: 'TENANT_B_ONLY_JOURNAL', ref: 'TENANTB-REF', lines: [{ accountCode: '1100', debit: 55, credit: 0 }, { accountCode: '4100', debit: 0, credit: 55 }] }];
    db.patients = [{ id: 'pat-tenantb-1', fileNumber: 'B-001', name: 'TENANT_B_ONLY_PATIENT', phone: '', active: true, createdAt: new Date().toISOString() }];
    db.doctors = [{ id: 'doc-tenantb-1', name: 'TENANT_B_ONLY_DOCTOR', target: 0, commission: 0, lab: 0, insurance: 0 }];
    saveDB(db);
  });
  const loginB = await request(app).post('/api/auth/login').send({ username: 'ownerb', password: 'OwnerB1234!', tenantId: 'tenant-p1-b' });
  tenantBToken = loginB.body.token;
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

// ═══════════════════════════════════════════════════════════════════════
// JOURNAL (7 tests)
// ═══════════════════════════════════════════════════════════════════════
describe('P1 — Journal list/detail (NEW-R5-ADV-JOURNAL-NO-GET-01)', () => {
  let je1, je2, je3;

  test('setup: post 3 real journal entries to search/list/paginate over', async () => {
    const r1 = await request(app).post('/api/journal').set(auth()).send({
      date: '2026-03-01', desc: 'P1 rent expense', lines: [{ accountCode: '5300', debit: 100, credit: 0 }, { accountCode: '1100', debit: 0, credit: 100 }],
    });
    expect(r1.status).toBe(200); je1 = r1.body.id;
    const r2 = await request(app).post('/api/journal').set(auth()).send({
      date: '2026-03-05', desc: 'P1 utilities payment', ref: 'UTIL-2026-03', lines: [{ accountCode: '5400', debit: 50, credit: 0 }, { accountCode: '1100', debit: 0, credit: 50 }],
    });
    expect(r2.status).toBe(200); je2 = r2.body.id;
    const r3 = await request(app).post('/api/journal').set(auth()).send({
      date: '2026-04-01', desc: 'P1 second month entry', lines: [{ accountCode: '5300', debit: 200, credit: 0 }, { accountCode: '1100', debit: 0, credit: 200 }],
    });
    expect(r3.status).toBe(200); je3 = r3.body.id;
  });

  test('1. list endpoint: GET /api/journal returns a real, paginated envelope with the posted entries', async () => {
    const res = await request(app).get('/api/journal').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.entries.some(e => e.id === je1)).toBe(true);
  });

  test('2. pagination/filtering: pageSize=1 returns exactly one entry per page, and date-range filtering excludes entries outside the range', async () => {
    const paged = await request(app).get('/api/journal').set(auth()).query({ pageSize: 1, page: 1 });
    expect(paged.status).toBe(200);
    expect(paged.body.entries.length).toBe(1);
    expect(paged.body.pageSize).toBe(1);

    const ranged = await request(app).get('/api/journal').set(auth()).query({ from: '2026-03-01', to: '2026-03-31' });
    expect(ranged.status).toBe(200);
    expect(ranged.body.entries.some(e => e.id === je1)).toBe(true);
    expect(ranged.body.entries.some(e => e.id === je2)).toBe(true);
    expect(ranged.body.entries.some(e => e.id === je3)).toBe(false); // April entry excluded from a March-only range
  });

  test('3. get by ID: GET /api/journal/:id returns the authoritative record with resolved account names on every line', async () => {
    const res = await request(app).get(`/api/journal/${je1}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.entry.id).toBe(je1);
    expect(res.body.entry.lines.length).toBe(2);
    expect(res.body.entry.lines.every(l => !!l.accountName)).toBe(true);
  });

  test('4. tenant isolation: Tenant B\'s own token can list/search journal entries and never sees Tenant A/default\'s entries', async () => {
    const res = await request(app).get('/api/journal').set(auth(tenantBToken));
    expect(res.status).toBe(200);
    expect(res.body.entries.some(e => e.id === 'JE-TENANTB-1')).toBe(true);
    expect(res.body.entries.some(e => e.id === je1 || e.id === je2 || e.id === je3)).toBe(false);
  });

  test('5. RBAC: a role with no journal permission is rejected (403), not silently given data', async () => {
    const res = await request(app).get('/api/journal').set(auth(noPermToken));
    expect(res.status).toBe(403);
  });

  test('6. search by reference/text: GET /api/journal?q= finds entries by description text and by ref, case-insensitively', async () => {
    const byDesc = await request(app).get('/api/journal').set(auth()).query({ q: 'utilities' });
    expect(byDesc.status).toBe(200);
    expect(byDesc.body.entries.some(e => e.id === je2)).toBe(true);
    expect(byDesc.body.entries.some(e => e.id === je1)).toBe(false);

    const byRef = await request(app).get('/api/journal').set(auth()).query({ q: 'UTIL-2026-03' });
    expect(byRef.status).toBe(200);
    expect(byRef.body.entries.some(e => e.id === je2)).toBe(true);
  });

  test('7. nonexistent ID: GET /api/journal/:id for a made-up id returns 404, not a crash or empty 200', async () => {
    const res = await request(app).get('/api/journal/JE-DOES-NOT-EXIST').set(auth());
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PATIENT (7 tests)
// ═══════════════════════════════════════════════════════════════════════
describe('P1 — Patient detail/edit (NEW-R5-ADV-PATIENTS-NO-EDIT-01)', () => {
  let patId;

  test('setup: create a patient and a real receivable against them', async () => {
    const p = await request(app).post('/api/patients').set(auth()).send({ name: 'مريض بار P1', fileNumber: 'P1-001', phone: '90000001' });
    expect(p.status).toBe(200);
    patId = p.body.patient.id;
    const rec = await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patId, reference: 'P1-INV-1', serviceDate: '2026-03-01', dueDate: '2026-04-01',
      description: 'خدمة P1', revenueAccountCode: '4100', receivableAccountCode: '1200', amount: 300,
    });
    expect(rec.status).toBe(200);
  });

  test('8. list: GET /api/patients returns the created patient', async () => {
    const res = await request(app).get('/api/patients').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.some(p => p.id === patId)).toBe(true);
  });

  test('9. get by ID: GET /api/patients/:id returns the raw master record', async () => {
    const res = await request(app).get(`/api/patients/${patId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.patient.id).toBe(patId);
    expect(res.body.patient.name).toBe('مريض بار P1');
  });

  test('10. edit safe field: PUT /api/patients/:id updates phone/fileNumber/name and persists', async () => {
    const res = await request(app).put(`/api/patients/${patId}`).set(auth()).send({ name: 'مريض بار P1 محدّث', phone: '90000002', fileNumber: 'P1-001-B' });
    expect(res.status).toBe(200);
    expect(res.body.patient.name).toBe('مريض بار P1 محدّث');
    const reread = await request(app).get(`/api/patients/${patId}`).set(auth());
    expect(reread.body.patient.phone).toBe('90000002');
    expect(reread.body.patient.fileNumber).toBe('P1-001-B');
  });

  test('11. financial history remains intact: the receivable and its statement are unaffected by the master-data edit above', async () => {
    const stmt = await request(app).get(`/api/patients/${patId}/statement`).set(auth());
    expect(stmt.status).toBe(200);
    expect(stmt.body.endingBalance).toBeCloseTo(300, 3);
    expect(stmt.body.rows.length).toBe(1);
    expect(stmt.body.rows[0].change).toBeCloseTo(300, 3);
  });

  test('12. unsafe identity change handled correctly: patientId is never editable via the body (it is the URL param), and a duplicate fileNumber is rejected, not silently allowed to collide', async () => {
    const other = await request(app).post('/api/patients').set(auth()).send({ name: 'مريض آخر P1', fileNumber: 'P1-002' });
    expect(other.status).toBe(200);

    // Attempting to smuggle a different id in the body changes nothing — the
    // URL param is authoritative, and patientReceivables still link by it.
    const tryChangeId = await request(app).put(`/api/patients/${patId}`).set(auth()).send({ id: 'pat-hijacked-id', name: 'مريض بار P1 محدّث' });
    expect(tryChangeId.status).toBe(200);
    expect(tryChangeId.body.patient.id).toBe(patId); // unchanged despite the smuggled body field
    const stmtStillWorks = await request(app).get(`/api/patients/${patId}/statement`).set(auth());
    expect(stmtStillWorks.body.endingBalance).toBeCloseTo(300, 3); // AR link survived

    const dupAttempt = await request(app).put(`/api/patients/${patId}`).set(auth()).send({ fileNumber: 'P1-002' });
    expect(dupAttempt.status).toBe(409);
    expect(dupAttempt.body.code).toBe('DUPLICATE_FILE_NUMBER');
  });

  test('13. tenant isolation: Tenant B cannot see, fetch, or edit the default tenant\'s patient', async () => {
    const list = await request(app).get('/api/patients').set(auth(tenantBToken));
    expect(list.status).toBe(200);
    expect(list.body.some(p => p.id === patId)).toBe(false);
    expect(list.body.some(p => p.id === 'pat-tenantb-1')).toBe(true);

    const getCross = await request(app).get(`/api/patients/${patId}`).set(auth(tenantBToken));
    expect(getCross.status).toBe(404); // tenant-scoped loadDB() never sees the other tenant's record at all

    const editCross = await request(app).put(`/api/patients/${patId}`).set(auth(tenantBToken)).send({ name: 'HACKED' });
    expect(editCross.status).toBe(404);
  });

  test('14. RBAC: a role with no "manual"/"financials" permission cannot read or edit patients', async () => {
    const getRes = await request(app).get(`/api/patients/${patId}`).set(auth(noPermToken));
    expect(getRes.status).toBe(403);
    const putRes = await request(app).put(`/api/patients/${patId}`).set(auth(noPermToken)).send({ name: 'X' });
    expect(putRes.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DOCTOR (6 tests)
// ═══════════════════════════════════════════════════════════════════════
describe('P1 — Doctor list/detail/edit (NEW-R5-ADV-DOCTORS-NO-LIST-01)', () => {
  let docId;

  test('setup: create two doctors via the full-array POST route', async () => {
    const res = await request(app).post('/api/doctors').set(auth()).send({
      doctors: [
        { name: 'DR.P1 ONE', target: 1000, commission: 40, lab: 10, insurance: 5 },
        { name: 'DR.P1 TWO', target: 2000, commission: 30, lab: 20, insurance: 10 },
      ],
    });
    expect(res.status).toBe(200);
    const list = await request(app).get('/api/doctors').set(auth());
    docId = list.body.find(d => d.name === 'DR.P1 ONE').id;
    expect(docId).toBeTruthy();
  });

  test('15. list: GET /api/doctors returns both doctors, each with a stable id', async () => {
    const res = await request(app).get('/api/doctors').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body.every(d => !!d.id)).toBe(true);
  });

  test('16. stable identity: re-saving the doctor roster (e.g. editing DR.P1 TWO) does not change DR.P1 ONE\'s id', async () => {
    const before = await request(app).get('/api/doctors').set(auth());
    const two = before.body.find(d => d.name === 'DR.P1 TWO');
    const resave = await request(app).post('/api/doctors').set(auth()).send({
      doctors: before.body.map(d => d.id === two.id ? { ...d, target: 2500 } : d),
    });
    expect(resave.status).toBe(200);
    const after = await request(app).get('/api/doctors').set(auth());
    expect(after.body.find(d => d.name === 'DR.P1 ONE').id).toBe(docId); // unchanged
    expect(after.body.find(d => d.name === 'DR.P1 TWO').target).toBe(2500);
  });

  test('17. detail: GET /api/doctors/:id returns master info + a real (initially empty) commission/activity summary', async () => {
    const res = await request(app).get(`/api/doctors/${docId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.doctor.id).toBe(docId);
    expect(res.body.doctor.name).toBe('DR.P1 ONE');
    expect(res.body.hasHistory).toBe(false);
    expect(res.body.commissionSummary.monthsRecorded).toBe(0);
  });

  test('18. edit safe field: PUT /api/doctors/:id updates commission/target and persists', async () => {
    const res = await request(app).put(`/api/doctors/${docId}`).set(auth()).send({ commission: 45, target: 1200 });
    expect(res.status).toBe(200);
    expect(res.body.doctor.commission).toBe(45);
    const reread = await request(app).get(`/api/doctors/${docId}`).set(auth());
    expect(reread.body.doctor.target).toBe(1200);
  });

  test('19. historical doctor-related records remain valid: after real financial history exists (doctor-expenses), the name becomes rename-locked but safe fields still edit normally, and the existing name-keyed expense record is untouched', async () => {
    const exp = await request(app).post('/api/doctor-expenses').set(auth()).send({ doctor: 'DR.P1 ONE', month: '2026-03', items: [{ name: 'مواد', amount: 15 }] });
    expect(exp.status).toBe(200);

    const detail = await request(app).get(`/api/doctors/${docId}`).set(auth());
    expect(detail.body.hasHistory).toBe(true);

    const renameAttempt = await request(app).put(`/api/doctors/${docId}`).set(auth()).send({ name: 'DR.P1 RENAMED' });
    expect(renameAttempt.status).toBe(409);
    expect(renameAttempt.body.code).toBe('DOCTOR_RENAME_LOCKED');

    const safeEdit = await request(app).put(`/api/doctors/${docId}`).set(auth()).send({ lab: 25 });
    expect(safeEdit.status).toBe(200);
    expect(safeEdit.body.doctor.name).toBe('DR.P1 ONE'); // untouched by the rejected rename attempt

    // The existing name-keyed expense record is still findable under the
    // original name — proving the rename-lock actually protected it.
    const expLookup = await request(app).get('/api/doctor-expenses/DR.P1 ONE/2026-03').set(auth());
    expect(expLookup.status).toBe(200);
    expect(expLookup.body.total).toBeCloseTo(15, 3);
  });

  test('20. tenant isolation: Tenant B sees only its own doctor, never the default tenant\'s doctors', async () => {
    const res = await request(app).get('/api/doctors').set(auth(tenantBToken));
    expect(res.status).toBe(200);
    expect(res.body.some(d => d.id === 'doc-tenantb-1')).toBe(true);
    expect(res.body.some(d => d.id === docId)).toBe(false);
  });

  // ── Adversarial-review fixes (P1 product review, identity persona) ──────
  test('AdvFix A (was P0): PUT /api/doctors/:id refuses to rename a doctor into a name already used by a different existing doctor', async () => {
    const collide = await request(app).put(`/api/doctors/${docId}`).set(auth()).send({ name: 'DR.P1 TWO' });
    expect(collide.status).toBe(409);
    expect(collide.body.code).toBe('DOCTOR_NAME_DUPLICATE');
    const reread = await request(app).get(`/api/doctors/${docId}`).set(auth());
    expect(reread.body.doctor.name).toBe('DR.P1 ONE'); // unchanged
  });

  test('AdvFix B (was P0): bulk POST /api/doctors refuses to create two rows sharing one name', async () => {
    const current = await request(app).get('/api/doctors').set(auth());
    const res = await request(app).post('/api/doctors').set(auth()).send({
      doctors: [...current.body, { name: 'DR.P1 DUPLICATE', target: 1, commission: 1, lab: 0, insurance: 0 }, { name: 'DR.P1 DUPLICATE', target: 2, commission: 2, lab: 0, insurance: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOCTOR_NAME_DUPLICATE');
  });

  test('AdvFix C (was P0): bulk POST /api/doctors refuses to silently drop a historied doctor by omitting their id with a new name (the rename-lock bypass)', async () => {
    await request(app).post('/api/doctor-expenses').set(auth()).send({ doctor: 'DR.P1 TWO', month: '2026-04', items: [{ name: 'x', amount: 5 }] });
    const historied = await request(app).get('/api/doctors').set(auth());
    const two = historied.body.find(d => d.name === 'DR.P1 TWO');
    expect(two).toBeTruthy();

    const bypass = await request(app).post('/api/doctors').set(auth()).send({
      doctors: historied.body.filter(d => d.id !== two.id).concat([{ name: 'DR.P1 TWO SNEAKY RENAME', target: 999, commission: 99, lab: 0, insurance: 0 }]),
    });
    expect(bypass.status).toBe(409);
    expect(bypass.body.code).toBe('DOCTOR_RENAME_LOCKED');

    // The roster must remain untouched by the rejected request.
    const stillThere = await request(app).get(`/api/doctors/${two.id}`).set(auth());
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.doctor.name).toBe('DR.P1 TWO');
  });

  test('AdvFix D (was P1): bulk POST /api/doctors refuses two new rows sharing one caller-chosen id', async () => {
    const current = await request(app).get('/api/doctors').set(auth());
    const res = await request(app).post('/api/doctors').set(auth()).send({
      doctors: [...current.body, { id: 'doc-collide-p1', name: 'DR.P1 COLLIDE A', target: 0, commission: 0, lab: 0, insurance: 0 }, { id: 'doc-collide-p1', name: 'DR.P1 COLLIDE B', target: 0, commission: 0, lab: 0, insurance: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOCTOR_ID_DUPLICATE');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// FIXED ASSET (5 tests)
// ═══════════════════════════════════════════════════════════════════════
describe('P1 — Fixed asset detail (NEW-R5-ADV-ASSETS-NO-PERID-01)', () => {
  let assetId, disposedAssetId;

  test('setup: create one asset that will stay active and one that will be disposed', async () => {
    const a1 = await request(app).post('/api/assets').set(auth()).send({
      name: 'P1 Asset Active', code: 'P1-FA-01', cost: 1000, usefulLife: 5, salvageValue: 0, coaAccount: '1510', accDepAccount: '1590', payMethod: 'cash', purchaseDate: '2026-01-01',
    });
    expect(a1.status).toBe(200);
    assetId = a1.body.asset.id;

    const a2 = await request(app).post('/api/assets').set(auth()).send({
      name: 'P1 Asset To Dispose', code: 'P1-FA-02', cost: 600, usefulLife: 3, salvageValue: 0, coaAccount: '1510', accDepAccount: '1590', payMethod: 'cash', purchaseDate: '2026-01-01',
    });
    expect(a2.status).toBe(200);
    disposedAssetId = a2.body.asset.id;

    const dep = await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2026-01' });
    expect(dep.status).toBe(200);

    const dispose = await request(app).post(`/api/assets/${disposedAssetId}/dispose`).set(auth()).send({ date: '2026-02-01', proceeds: 100 });
    expect(dispose.status).toBe(200);
  });

  test('21. get by ID: GET /api/assets/:id returns the authoritative record', async () => {
    const res = await request(app).get(`/api/assets/${assetId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.asset.id).toBe(assetId);
    expect(res.body.asset.name).toBe('P1 Asset Active');
  });

  test('22. calculated NBV consistent with canonical engine: the detail endpoint\'s nbv matches cost-accumulatedDep exactly, and matches GET /api/assets\' own list figures', async () => {
    const detail = await request(app).get(`/api/assets/${assetId}`).set(auth());
    const list = await request(app).get('/api/assets').set(auth());
    const fromList = list.body.find(a => a.id === assetId);
    const expectedNbv = parseFloat((fromList.cost - fromList.accumulatedDep).toFixed(3));
    expect(detail.body.nbv).toBeCloseTo(expectedNbv, 3);
    expect(fromList.accumulatedDep).toBeGreaterThan(0); // depreciation actually ran
  });

  test('23. disposed asset detail: shows disposal status/gain-loss and is flagged hasHistory', async () => {
    const res = await request(app).get(`/api/assets/${disposedAssetId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.asset.status).toBe('disposed');
    expect(res.body.asset.disposalProceeds).toBeCloseTo(100, 3);
    expect(res.body.hasHistory).toBe(true);
  });

  test('24. protected historical field cannot bypass guards: PUT /api/assets/:id still rejects a cost change on a historied asset via this same detail-adjacent path', async () => {
    const attempt = await request(app).put(`/api/assets/${assetId}`).set(auth()).send({ cost: 99999 });
    expect(attempt.status).toBe(409);
    expect(attempt.body.code).toBe('ASSET_HISTORY_LOCKED');
    const reread = await request(app).get(`/api/assets/${assetId}`).set(auth());
    expect(reread.body.asset.cost).toBe(1000); // unchanged
  });

  test('25. source/journal link: relatedJournals includes the purchase entry (sourceId match) and, for the disposed asset, the disposal entry too', async () => {
    const active = await request(app).get(`/api/assets/${assetId}`).set(auth());
    expect(active.body.relatedJournals.some(j => j.type === 'asset_purchase')).toBe(true);

    const disposed = await request(app).get(`/api/assets/${disposedAssetId}`).set(auth());
    expect(disposed.body.relatedJournals.some(j => j.type === 'asset_purchase')).toBe(true);
    expect(disposed.body.relatedJournals.some(j => j.type === 'asset_disposal')).toBe(true);
  });

  test('bonus — RBAC: a role with no assets permission cannot read asset detail (requireAdminAction is a hard admin-only gate)', async () => {
    const res = await request(app).get(`/api/assets/${assetId}`).set(auth(noPermToken));
    expect(res.status).toBe(403);
  });

  test('AdvFix (was P3): PUT /api/assets/:id refuses a duplicate code shared with a different existing asset', async () => {
    const res = await request(app).put(`/api/assets/${disposedAssetId}`).set(auth()).send({ code: 'P1-FA-01' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_CODE_DUPLICATE');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Adversarial-review fixes — patient-receivable source traceability + AR aging
// ═══════════════════════════════════════════════════════════════════════
describe('P1 — adversarial-review fixes: patient-receivable sourceId + AR-aging identity grouping', () => {
  test('AdvFix (was P1/P2): a new patient-receivable recognition journal entry now carries sourceId, so the source pill can deep-link to the exact patient', async () => {
    const p = await request(app).post('/api/patients').set(auth()).send({ name: 'مريض تتبّع المصدر', fileNumber: 'SRC-001' });
    const rec = await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: p.body.patient.id, serviceDate: '2026-05-01', dueDate: '2026-06-01',
      description: 'اختبار تتبّع المصدر', revenueAccountCode: '4100', receivableAccountCode: '1200', amount: 77,
    });
    expect(rec.status).toBe(200);
    const je = await request(app).get(`/api/journal/${rec.body.receivable.recognitionJournalId}`).set(auth());
    expect(je.status).toBe(200);
    expect(je.body.entry.sourceId).toBe(rec.body.receivable.id);
  });

  test('AdvFix (was P2): GET /api/patient-ar-aging groups by patientId, not a stale patientName snapshot, so a mid-life rename does not fragment one patient\'s balance', async () => {
    const p = await request(app).post('/api/patients').set(auth()).send({ name: 'اسم أصلي P1', fileNumber: 'RENAME-001' });
    const pid = p.body.patient.id;
    const rec1 = await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: pid, serviceDate: '2026-05-01', dueDate: '2026-06-01', description: 'قبل التعديل',
      revenueAccountCode: '4100', receivableAccountCode: '1200', amount: 40,
    });
    expect(rec1.status).toBe(200);

    const rename = await request(app).put(`/api/patients/${pid}`).set(auth()).send({ name: 'اسم معدَّل P1' });
    expect(rename.status).toBe(200);

    const rec2 = await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: pid, serviceDate: '2026-05-02', dueDate: '2026-06-02', description: 'بعد التعديل',
      revenueAccountCode: '4100', receivableAccountCode: '1200', amount: 60,
    });
    expect(rec2.status).toBe(200);

    const aging = await request(app).get('/api/patient-ar-aging').set(auth());
    expect(aging.status).toBe(200);
    const rowsForPatient = aging.body.rows.filter(r => r.patientId === pid);
    expect(rowsForPatient.length).toBe(1); // one row, not fragmented across old/new name
    expect(rowsForPatient[0].total).toBeCloseTo(100, 3); // 40 + 60, combined correctly
    expect(rowsForPatient[0].patient).toBe('اسم معدَّل P1'); // shows the current, live name
  });
});
