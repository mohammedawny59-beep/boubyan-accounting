// P0.12 — Financial Idempotency & Retry-Safety Closure.
// Part G (audit + preserve pre-existing domain-specific idempotency
// guards), Part H (route-level wiring correctness), Part I/J (response
// semantics: replay, conflict, invalid-key, unprotected-when-no-key), Part L
// (file-backend half of file/Mongo parity — see p0-12-idempotency-mongo
// .test.js for the Mongo half).
//
// File-mode, real Express app via supertest — same boilerplate pattern as
// every other P0.x route-level test file in this program.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-12-idempotency-routes-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p12-idem-routes-'));
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

async function seedVendorDirect(id, name, accountId) {
  const db = loadDB();
  if (!db.vendors) db.vendors = [];
  db.vendors.push({ id, name, accountId, createdAt: new Date().toISOString() });
  await saveDB(db, { durable: true });
}

// buildAndPostPatientReceivable() (server.js) requires the patient to
// already exist in db.patients[] (looked up by patientId, 404 otherwise).
async function seedPatientDirect(id, name) {
  const db = loadDB();
  if (!db.patients) db.patients = [];
  db.patients.push({ id, name, createdAt: new Date().toISOString() });
  await saveDB(db, { durable: true });
}

function journalCount() { return (loadDB().journalEntries || []).length; }

// ═══════════════════════════════════════════════════════════════════════
// Part H/I — generic Idempotency-Key layer: end-to-end proofs across a
// diverse sample of the 22 newly-wired routes (simple create, sub-resource
// action layered on a pre-existing guard, and a PUT-update route).
// ═══════════════════════════════════════════════════════════════════════
describe('P0.12 Part H/I — generic Idempotency-Key: replay semantics end-to-end', () => {
  test('Idem A: POST /api/journal — a retried request with the SAME Idempotency-Key posts exactly ONE journal entry and returns idempotentReplay:true on the second call', async () => {
    const key = 'IDEM-A-JOURNAL-0001';
    const before = journalCount();
    const payload = { date: '2058-01-05', desc: 'Idem A journal', lines: [
      { accountCode: '1100', debit: 111, credit: 0 },
      { accountCode: '4100', debit: 0, credit: 111 },
    ]};
    const r1 = await request(app).post('/api/journal').set(auth()).set('Idempotency-Key', key).send(payload);
    expect(r1.status).toBe(200);
    expect(r1.body.idempotentReplay).toBeFalsy();

    const r2 = await request(app).post('/api/journal').set(auth()).set('Idempotency-Key', key).send(payload);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBe(true);

    expect(journalCount()).toBe(before + 1);
  });

  test('Idem B: POST /api/vendor-bills — a retried bill-creation request never creates a second bill or a second journal entry', async () => {
    await seedVendorDirect('VEN-IDEM-B', 'Idem B Vendor', '2100');
    const key = 'IDEM-B-VENDORBILL-0001';
    const beforeJe = journalCount();
    const payload = { vendorId: 'VEN-IDEM-B', billDate: '2058-01-06', description: 'Idem B bill', allocations: [{ accountCode: '5200', amount: 220 }] };

    const r1 = await request(app).post('/api/vendor-bills').set(auth()).set('Idempotency-Key', key).send(payload);
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/vendor-bills').set(auth()).set('Idempotency-Key', key).send(payload);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBe(true);
    expect(r2.body.bill.id).toBe(r1.body.bill.id);

    const bills = (loadDB().vendorBills || []).filter(b => b.description === 'Idem B bill');
    expect(bills).toHaveLength(1);
    expect(journalCount()).toBe(beforeJe + 1);
  });

  test('Idem C: POST /api/vendor-bills/:id/pay — layered on top of the pre-existing optional clientRef guard; a retried payment (using the generic header, no clientRef) posts exactly ONE payment', async () => {
    await seedVendorDirect('VEN-IDEM-C', 'Idem C Vendor', '2100');
    const bill = await request(app).post('/api/vendor-bills').set(auth()).send({ vendorId: 'VEN-IDEM-C', billDate: '2058-01-07', description: 'Idem C bill', allocations: [{ accountCode: '5200', amount: 500 }] });
    const billId = bill.body.bill.id;
    const key = 'IDEM-C-BILLPAY-0001';
    const payPayload = { amount: 200, payDate: '2058-01-08', payAccount: '1100' };

    const r1 = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).set('Idempotency-Key', key).send(payPayload);
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).set('Idempotency-Key', key).send(payPayload);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBe(true);

    const refreshedBill = (loadDB().vendorBills || []).find(b => b.id === billId);
    expect(refreshedBill.payments).toHaveLength(1);
    expect(refreshedBill.paidAmount).toBeCloseTo(200, 3);
  });

  test('Idem D: POST /api/patient-receivables/:id/writeoff — layered on a guard that only catches FULL write-offs; a retried PARTIAL write-off (which the old status check alone would miss) still posts exactly once', async () => {
    await seedPatientDirect('PAT-IDEM-D', 'Idem D Patient');
    const rec = await request(app).post('/api/patient-receivables').set(auth()).send({ patientId: 'PAT-IDEM-D', serviceDate: '2058-01-09', description: 'Idem D service', amount: 1000, revenueAccountCode: '4100', receivableAccountCode: '1200' });
    expect(rec.status).toBe(200);
    const recId = rec.body.receivable.id;
    const key = 'IDEM-D-WRITEOFF-0001';
    const woPayload = { amount: 300, date: '2058-01-10', reason: 'Idem D partial writeoff' }; // PARTIAL — status stays non-WRITTEN_OFF

    const r1 = await request(app).post(`/api/patient-receivables/${recId}/writeoff`).set(auth()).set('Idempotency-Key', key).send(woPayload);
    expect(r1.status).toBe(200);
    const refreshedAfterFirst = (loadDB().patientReceivables || []).find(r => r.id === recId);
    expect(refreshedAfterFirst.status).not.toBe('WRITTEN_OFF'); // confirms this really is a partial write-off, proving the old guard alone would not have caught a retry

    const r2 = await request(app).post(`/api/patient-receivables/${recId}/writeoff`).set(auth()).set('Idempotency-Key', key).send(woPayload);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBe(true);

    const refreshed = (loadDB().patientReceivables || []).find(r => r.id === recId);
    expect(refreshed.writtenOffAmount).toBeCloseTo(300, 3); // NOT 600 — the retry did not double-post
  });

  test('Idem E: POST /api/assets — a retried creation request never creates a second asset or a second purchase journal entry', async () => {
    const key = 'IDEM-E-ASSET-0001';
    const beforeJe = journalCount();
    const payload = { name: 'Idem E Asset', cost: 800, purchaseDate: '2058-01-11', payMethod: 'cash', usefulLife: 5 };

    const r1 = await request(app).post('/api/assets').set(auth()).set('Idempotency-Key', key).send(payload);
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/assets').set(auth()).set('Idempotency-Key', key).send(payload);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBe(true);

    const assets = (loadDB().fixedAssets || []).filter(a => a.name === 'Idem E Asset');
    expect(assets).toHaveLength(1);
    expect(journalCount()).toBe(beforeJe + 1);
  });

  test('Idem F: PUT /api/insurance-claims/:id — the exact clean P6-097 exemplar the milestone flagged: a retried "claim received" update never posts a second receipt journal entry', async () => {
    const claim = await request(app).post('/api/insurance-claims').set(auth()).send({ company: 'Idem F Insurer', claimDate: '2058-01-12', amount: 400 });
    expect(claim.status).toBe(200);
    const claimId = claim.body.claim.id;
    const key = 'IDEM-F-CLAIMUPDATE-0001';
    const beforeJe = journalCount();
    const updatePayload = { status: 'received', receivedDate: '2058-01-15', receivedAmount: 400, payAccount: '1100' };

    const r1 = await request(app).put(`/api/insurance-claims/${claimId}`).set(auth()).set('Idempotency-Key', key).send(updatePayload);
    expect(r1.status).toBe(200);
    const r2 = await request(app).put(`/api/insurance-claims/${claimId}`).set(auth()).set('Idempotency-Key', key).send(updatePayload);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBe(true);

    // At most ONE new journal entry from this update, regardless of the retry.
    expect(journalCount()).toBeLessThanOrEqual(beforeJe + 1);
  });

  test('Idem G: POST /api/closing-entry — a genuine retry (same month, same key) returns a clean 200 idempotentReplay instead of the pre-existing 409 ALREADY_CLOSED', async () => {
    await request(app).post('/api/journal').set(auth()).send({
      date: '2058-02-05', desc: 'Idem G revenue', lines: [
        { accountCode: '1100', debit: 700, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 700 },
      ],
    }).then(r => expect(r.status).toBe(200));

    const key = 'IDEM-G-CLOSE-0001';
    const r1 = await request(app).post('/api/closing-entry').set(auth()).set('Idempotency-Key', key).send({ year: 2058, month: 2 });
    expect(r1.status).toBe(200);
    expect(r1.body.idempotentReplay).toBeFalsy();

    const r2 = await request(app).post('/api/closing-entry').set(auth()).set('Idempotency-Key', key).send({ year: 2058, month: 2 });
    expect(r2.status).toBe(200); // NOT 409 — the whole point of layering the key on top
    expect(r2.body.idempotentReplay).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part I — response semantics for the error paths: invalid key format,
// fingerprint mismatch (client bug — key reused for a different command),
// and unprotected-when-no-key (deliberate backward-compatible opt-in).
// ═══════════════════════════════════════════════════════════════════════
describe('P0.12 Part I — response semantics: invalid key, conflict, opt-in', () => {
  test('Semantics A: a malformed Idempotency-Key header (too short) is rejected with 400 IDEMPOTENCY_KEY_INVALID and mutates nothing', async () => {
    const before = journalCount();
    const r = await request(app).post('/api/journal').set(auth()).set('Idempotency-Key', 'short').send({
      date: '2058-03-01', desc: 'Should not post', lines: [
        { accountCode: '1100', debit: 50, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 50 },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(journalCount()).toBe(before);
  });

  test('Semantics B: the SAME Idempotency-Key reused for a genuinely different request (different fingerprint) is rejected with 409 IDEMPOTENCY_KEY_REUSED — never silently treated as a replay', async () => {
    const key = 'SEMANTICS-B-REUSE-0001';
    const r1 = await request(app).post('/api/journal').set(auth()).set('Idempotency-Key', key).send({
      date: '2058-03-02', desc: 'Semantics B first', lines: [
        { accountCode: '1100', debit: 60, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 60 },
      ],
    });
    expect(r1.status).toBe(200);

    const r2 = await request(app).post('/api/journal').set(auth()).set('Idempotency-Key', key).send({
      date: '2058-03-03', desc: 'Semantics B SECOND — genuinely different', lines: [
        { accountCode: '1100', debit: 999, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 999 },
      ],
    });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const posted = (loadDB().journalEntries || []).find(j => j.desc === 'Semantics B SECOND — genuinely different');
    expect(posted).toBeUndefined(); // the second, different transaction never landed
  });

  test('Semantics C: no Idempotency-Key supplied at all — the route behaves exactly as before this milestone (unprotected, but unchanged); two identical calls create TWO journal entries', async () => {
    const before = journalCount();
    const payload = { date: '2058-03-04', desc: 'Semantics C unprotected', lines: [
      { accountCode: '1100', debit: 30, credit: 0 },
      { accountCode: '4100', debit: 0, credit: 30 },
    ]};
    const r1 = await request(app).post('/api/journal').set(auth()).send(payload);
    const r2 = await request(app).post('/api/journal').set(auth()).send(payload);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Deliberate, documented behavior: no key = no dedup guarantee (opt-in).
    expect(journalCount()).toBe(before + 2);
  });

  test('Semantics D: the pre-existing body.clientRef field name still works as an idempotency key (backward-compatible alias, not a second mechanism) for a route that has BOTH the old domain-specific clientRef check and the new generic layer', async () => {
    await seedVendorDirect('VEN-SEM-D', 'Semantics D Vendor', '2100');
    const bill = await request(app).post('/api/vendor-bills').set(auth()).send({ vendorId: 'VEN-SEM-D', billDate: '2058-03-05', description: 'Semantics D bill', allocations: [{ accountCode: '5200', amount: 150 }] });
    const billId = bill.body.bill.id;

    const r1 = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).send({ amount: 150, payDate: '2058-03-06', payAccount: '1100', clientRef: 'SEMANTICS-D-CLIENTREF-0001' });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).send({ amount: 150, payDate: '2058-03-06', payAccount: '1100', clientRef: 'SEMANTICS-D-CLIENTREF-0001' });
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBe(true);

    const refreshedBill = (loadDB().vendorBills || []).find(b => b.id === billId);
    expect(refreshedBill.payments).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part G — pre-existing domain-specific idempotency guards must survive
// this milestone UNCHANGED (not removed, not weakened) — regression proof,
// exercised WITHOUT any generic Idempotency-Key header, i.e. purely via the
// domain-specific mechanism this milestone promised not to touch.
// ═══════════════════════════════════════════════════════════════════════
describe('P0.12 Part G — pre-existing domain-specific guards are preserved', () => {
  test('Domain A: vendor-bill payment clientRef guard alone (no generic header) still prevents a duplicate payment', async () => {
    await seedVendorDirect('VEN-DOM-A', 'Domain A Vendor', '2100');
    const bill = await request(app).post('/api/vendor-bills').set(auth()).send({ vendorId: 'VEN-DOM-A', billDate: '2058-04-01', description: 'Domain A bill', allocations: [{ accountCode: '5200', amount: 300 }] });
    const billId = bill.body.bill.id;
    const payload = { amount: 300, payDate: '2058-04-02', payAccount: '1100', clientRef: 'DOMAIN-A-REF-0001' };

    const r1 = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).send(payload);
    const r2 = await request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth()).send(payload);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBe(true);

    const refreshedBill = (loadDB().vendorBills || []).find(b => b.id === billId);
    expect(refreshedBill.payments).toHaveLength(1);
  });

  test('Domain B: vendor-bill billNumber+vendorId duplicate-bill guard still rejects a second bill with the same number for the same vendor', async () => {
    await seedVendorDirect('VEN-DOM-B', 'Domain B Vendor', '2100');
    const payload = { vendorId: 'VEN-DOM-B', billNumber: 'DOMB-INV-001', billDate: '2058-04-03', description: 'Domain B bill', allocations: [{ accountCode: '5200', amount: 400 }] };
    const r1 = await request(app).post('/api/vendor-bills').set(auth()).send(payload);
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/vendor-bills').set(auth()).send(payload);
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('DUPLICATE_BILL');
  });

  test('Domain C: asset disposal status==="disposed" guard still rejects a second disposal of the same asset', async () => {
    const asset = await request(app).post('/api/assets').set(auth()).send({ name: 'Domain C Asset', cost: 500, purchaseDate: '2058-04-04', payMethod: 'cash', usefulLife: 5 });
    const assetId = asset.body.asset.id;
    const r1 = await request(app).post(`/api/assets/${assetId}/dispose`).set(auth()).send({ proceeds: 100, disposalDate: '2058-04-05' });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/api/assets/${assetId}/dispose`).set(auth()).send({ proceeds: 100, disposalDate: '2058-04-05' });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('ALREADY_DISPOSED');
  });

  test('Domain D: closing-entry CLOSE-<month> ref guard still rejects a second close of the same month when called WITHOUT any Idempotency-Key', async () => {
    await request(app).post('/api/journal').set(auth()).send({
      date: '2058-05-05', desc: 'Domain D revenue', lines: [
        { accountCode: '1100', debit: 900, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 900 },
      ],
    }).then(r => expect(r.status).toBe(200));

    const r1 = await request(app).post('/api/closing-entry').set(auth()).send({ year: 2058, month: 5 });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/closing-entry').set(auth()).send({ year: 2058, month: 5 });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('ALREADY_CLOSED');
  });

  test('Domain E: recurring/run per-item due-date guard (recurringIsDue) still prevents a double-post when run twice for the same month, WITHOUT any generic key (deliberately left unwrapped — see server.js comment)', async () => {
    const create = await request(app).post('/api/recurring').set(auth()).send({
      id: 'REC-DOMAIN-E', desc: 'Domain E recurring', cat: 'rent', amount: 120, payMethod: 'cash', frequency: 'monthly', day: 1, active: true,
    });
    expect(create.status).toBe(200);

    const beforeJe = journalCount();
    const r1 = await request(app).post('/api/recurring/run').set(auth()).send({});
    expect(r1.status).toBe(200);
    expect(r1.body.applied).toBeGreaterThanOrEqual(1);
    const afterFirstRun = journalCount();
    expect(afterFirstRun).toBeGreaterThan(beforeJe);

    // Same month, immediate second run — recurringIsDue() must skip it.
    const r2 = await request(app).post('/api/recurring/run').set(auth()).send({});
    expect(r2.status).toBe(200);
    expect(journalCount()).toBe(afterFirstRun); // no new posting from the second run
  });

  test('Domain F: patient-receivable collection clientRef guard alone (no generic header) still prevents a duplicate collection', async () => {
    await seedPatientDirect('PAT-DOM-F', 'Domain F Patient');
    const rec = await request(app).post('/api/patient-receivables').set(auth()).send({ patientId: 'PAT-DOM-F', serviceDate: '2058-04-06', description: 'Domain F service', amount: 500, revenueAccountCode: '4100', receivableAccountCode: '1200' });
    expect(rec.status).toBe(200);
    const recId = rec.body.receivable.id;
    const payload = { amount: 500, collectDate: '2058-04-07', collectAccount: '1100', clientRef: 'DOMAIN-F-REF-0001' };

    const r1 = await request(app).post(`/api/patient-receivables/${recId}/collect`).set(auth()).send(payload);
    const r2 = await request(app).post(`/api/patient-receivables/${recId}/collect`).set(auth()).send(payload);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBe(true);

    const refreshed = (loadDB().patientReceivables || []).find(r => r.id === recId);
    expect(refreshed.collections).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part J — security/tenant-scoping: a key is scoped to (tenant, operation,
// key), never global — confirmed at the unit level in
// p0-12-idempotency-core.test.js (Claim E/F); here confirmed that RBAC is
// evaluated independently of idempotency (a replay never bypasses auth).
// ═══════════════════════════════════════════════════════════════════════
describe('P0.12 Part J — idempotency never bypasses auth/RBAC', () => {
  test('Security A: an unauthenticated retried request with a valid Idempotency-Key still gets 401, never a replay', async () => {
    const key = 'SECURITY-A-NOAUTH-0001';
    const payload = { date: '2058-06-01', desc: 'Security A', lines: [
      { accountCode: '1100', debit: 10, credit: 0 },
      { accountCode: '4100', debit: 0, credit: 10 },
    ]};
    // First, a real authenticated post under this key.
    const r1 = await request(app).post('/api/journal').set(auth()).set('Idempotency-Key', key).send(payload);
    expect(r1.status).toBe(200);

    // Same key, but no Authorization header at all.
    const r2 = await request(app).post('/api/journal').set('Idempotency-Key', key).send(payload);
    expect(r2.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part M/N — failure injection: proves releaseIdempotencyClaim() actually
// runs end-to-end (not just at the unit level) when a mutation is rejected
// AFTER the claim but BEFORE any real posting, and that a genuinely
// abandoned PROCESSING record left behind by a crashed prior request
// self-heals for a real HTTP retry — not just for the lib-level unit test.
// ═══════════════════════════════════════════════════════════════════════
describe('P0.12 Part M/N — failure injection: release-on-failure and abandoned-claim self-heal, end to end', () => {
  test('Failure A: a claim followed by a REJECTED mutation (locked period) releases the key — an immediate retry with the SAME key against a valid period succeeds, not permanently blocked', async () => {
    const db = loadDB();
    db.lockedPeriods = db.lockedPeriods || {};
    db.lockedPeriods['2058-07'] = true;
    await saveDB(db, { durable: true });

    const key = 'FAILURE-A-RELEASE-0001';
    const beforeRejected = journalCount();
    const lockedPayload = { date: '2058-07-15', desc: 'Failure A (should be rejected)', lines: [
      { accountCode: '1100', debit: 25, credit: 0 },
      { accountCode: '4100', debit: 0, credit: 25 },
    ]};
    const r1 = await request(app).post('/api/journal').set(auth()).set('Idempotency-Key', key).send(lockedPayload);
    expect(r1.status).toBeGreaterThanOrEqual(400); // rejected — locked period
    expect(journalCount()).toBe(beforeRejected); // sanity: nothing posted under the rejected attempt

    // SAME key, but now pointed at a valid, unlocked date — if the claim
    // were NOT released, this would incorrectly get IDEMPOTENCY_KEY_REUSED
    // (different fingerprint, same key) or worse, silently replay nothing.
    const before = journalCount();
    const validPayload = { date: '2058-08-01', desc: 'Failure A retry (valid period)', lines: [
      { accountCode: '1100', debit: 25, credit: 0 },
      { accountCode: '4100', debit: 0, credit: 25 },
    ]};
    const r2 = await request(app).post('/api/journal').set(auth()).set('Idempotency-Key', key).send(validPayload);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBeFalsy(); // a genuine fresh post, not a replay
    expect(journalCount()).toBe(before + 1);
  });

  test('Failure B: a genuinely abandoned PROCESSING claim (simulated crash — record older than the self-heal timeout) does not permanently block a real HTTP retry of the same operation', async () => {
    const { PROCESSING_TIMEOUT_MS, computeFingerprint } = require('../lib/idempotency');
    const key = 'FAILURE-B-ABANDONED-0001';
    const payload = { date: '2058-09-01', desc: 'Failure B abandoned-claim retry', lines: [
      { accountCode: '1100', debit: 40, credit: 0 },
      { accountCode: '4100', debit: 0, credit: 40 },
    ]};
    const fingerprint = computeFingerprint('journal:create', { date: payload.date, desc: payload.desc, lines: payload.lines });

    // Simulate a process that crashed mid-request: a PROCESSING record
    // exists for this exact key+fingerprint, backdated past the self-heal
    // window, with no COMPLETED result — exactly what a real crash leaves.
    const db = loadDB();
    db.idempotencyRecords = db.idempotencyRecords || [];
    db.idempotencyRecords.push({
      id: 'IDEMP-SIMULATED-CRASH', tenantId: 'default', operationScope: 'journal:create',
      key, fingerprint, status: 'PROCESSING', resultReference: null, sourceId: null, journalId: null,
      createdAt: new Date(Date.now() - PROCESSING_TIMEOUT_MS - 10000).toISOString(), completedAt: null,
    });
    await saveDB(db, { durable: true });

    const before = journalCount();
    const r = await request(app).post('/api/journal').set(auth()).set('Idempotency-Key', key).send(payload);
    expect(r.status).toBe(200); // NOT 409 IDEMPOTENCY_IN_PROGRESS — the stale claim self-heals
    expect(r.body.idempotentReplay).toBeFalsy();
    expect(journalCount()).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part P (adversarial-review fix regression) — the Accounting persona's
// CONFIRMED P0 finding: expense:create's fingerprint referenced a field
// name (`paymentMethod`) that buildAndPostExpense() never actually reads,
// so it was always undefined and silently dropped, collapsing the
// fingerprint to just {amount,cat,date,desc,vendor} — two REAL, financially
// distinct expenses (same amount/date/desc/category, different payment
// method) reusing a key would collide, and the second one would be
// silently dropped while reporting idempotentReplay:true success.
// ═══════════════════════════════════════════════════════════════════════
describe('P0.12 adversarial-review fix — expense:create fingerprint now distinguishes payment method', () => {
  test('Fingerprint Fix A: the SAME key + SAME amount/date/desc/category but a DIFFERENT payMethodCode (cash vs bank) is now correctly detected as a genuinely different expense — 409 IDEMPOTENCY_KEY_REUSED (a client bug: reusing a key for different content), never a silent false replay that drops the second expense', async () => {
    const key = 'FINGERPRINT-FIX-A-PAYMETHOD-0001';
    const shared = { date: '2058-10-01', desc: 'Fingerprint Fix A shared desc', cat: 'مصاريف عامة', amount: 250 };

    const cashRes = await request(app).post('/api/expenses').set(auth()).set('Idempotency-Key', key).send({ ...shared, payMethodCode: '1100' });
    expect(cashRes.status).toBe(200);
    expect(cashRes.body.idempotentReplay).toBeFalsy();

    const bankRes = await request(app).post('/api/expenses').set(auth()).set('Idempotency-Key', key).send({ ...shared, payMethodCode: '1110' });
    // Before the fix: `paymentMethod` was never in the fingerprint, so this
    // request's fingerprint was IDENTICAL to the cash request's — the code
    // incorrectly took the COMPLETED-replay branch (200,
    // idempotentReplay:true) and the bank expense was NEVER posted: real
    // cash movement silently missing from the ledger while reporting
    // success. After the fix, payMethodCode is part of the fingerprint, so
    // this is correctly recognized as a genuinely different transaction
    // reusing the same key — the system's own established contract for
    // that case is 409 IDEMPOTENCY_KEY_REUSED (a client bug: use a NEW key
    // for a new logical operation), never a silent replay of stale data.
    expect(bankRes.status).toBe(409);
    expect(bankRes.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // The bank expense correctly did NOT post under the reused key — no
    // phantom/dropped data, no duplicate, just a clean rejection.
    const db = loadDB();
    const bankJe = (db.journalEntries || []).find(je =>
      je.lines && je.lines.some(l => (l.accountCode || l.account) === '1110') && je.desc === shared.desc);
    expect(bankJe).toBeUndefined();

    // The genuinely different bank expense DOES post successfully once the
    // client corrects its bug and uses a fresh key, as it always could.
    const bankRetryRes = await request(app).post('/api/expenses').set(auth()).set('Idempotency-Key', 'FINGERPRINT-FIX-A-PAYMETHOD-0001-BANK').send({ ...shared, payMethodCode: '1110' });
    expect(bankRetryRes.status).toBe(200);
    expect(bankRetryRes.body.idempotentReplay).toBeFalsy();
    expect(bankRetryRes.body.journalId).not.toBe(cashRes.body.journalId);
  });

  test('Fingerprint Fix B: the SAME key + genuinely identical payload (including payMethodCode) still replays cleanly — the fix did not break normal same-request retries', async () => {
    const key = 'FINGERPRINT-FIX-B-SAME-0001';
    const payload = { date: '2058-10-02', desc: 'Fingerprint Fix B', cat: 'مصاريف عامة', amount: 80, payMethodCode: '1100' };

    const r1 = await request(app).post('/api/expenses').set(auth()).set('Idempotency-Key', key).send(payload);
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/expenses').set(auth()).set('Idempotency-Key', key).send(payload);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotentReplay).toBe(true);
    expect(r2.body.journalId).toBe(r1.body.journalId);
  });
});
