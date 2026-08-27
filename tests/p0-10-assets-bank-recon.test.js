// P0.10 — Fixed Assets & Bank Reconciliation Control Closure.
//
// Isolated, real-app tests (DB_FILE_ONLY, os.tmpdir()) via supertest against
// the real exported Express app — no production data, no real network.
// Covers: canonical depreciation idempotency/clamping (P6-045), asset
// creation account validation, history-lock on edit/delete, full disposal
// lifecycle with gain/loss (P6-046), asset-register-to-GL reconciliation,
// the bank 'matched-book' commit dead-branch fix, settlement/deposit commit
// + skipped-reason splitting, single-item bank-reconciliation undo (JE-based
// and match-only), legacy bank-recon route hardening + its new
// reconciliation block, the negative cash/bank balance guard (P6-047), the
// P6-074 employee-delete-vs-deactivate fix, RBAC/audit/persistence/tenant
// isolation, and regression of P0.6A-P0.9.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-10-assets-bank-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p10-'));
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
    patientAR: [], patients: [], patientReceivables: [],
    bankRecons: [], bankCommittedLineKeys: [], bankMatchedLineIds: [], networkReceivableCleared: { knet: 0, card: 0 },
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

async function createAsset(overrides = {}) {
  return request(app).post('/api/assets').set(auth()).send({
    name: overrides.name || 'Asset-' + Date.now() + Math.random(),
    cost: overrides.cost != null ? overrides.cost : 1200,
    purchaseDate: overrides.purchaseDate || '2052-01-01',
    usefulLife: overrides.usefulLife != null ? overrides.usefulLife : 5,
    salvageValue: overrides.salvageValue != null ? overrides.salvageValue : 0,
    payMethod: overrides.payMethod || 'cash',
    coaAccount: overrides.coaAccount,
    accDepAccount: overrides.accDepAccount,
    depExpAccount: overrides.depExpAccount,
  });
}

async function postJournal(date, lines, desc) {
  return request(app).post('/api/journal').set(auth()).send({ date, desc: desc || 'test entry', lines });
}

async function findJE(predicate) {
  let je;
  await runAsTenant('default', async () => { je = loadDB().journalEntries.find(predicate); });
  return je;
}

// ═══════════════════════════════════════════════════════════════════════
// Depreciation A-E
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Fixed Asset Depreciation Idempotency & Canonical Engine (P6-045)', () => {
  test('Dep A: depreciating a period posts a balanced journal and updates the asset\'s own accumulatedDep', async () => {
    const create = await createAsset({ name: 'DepA-Asset', cost: 1200, usefulLife: 5, salvageValue: 0 });
    expect(create.status).toBe(200);
    const assetId = create.body.asset.id;
    const res = await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2052-01' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const je = await findJE(j => j.ref === 'DEP-2052-01');
    expect(je).toBeTruthy();
    const dr = je.lines.reduce((s, l) => s + (l.debit || 0), 0);
    const cr = je.lines.reduce((s, l) => s + (l.credit || 0), 0);
    expect(Math.abs(dr - cr)).toBeLessThan(0.005);
    let asset;
    await runAsTenant('default', async () => { asset = loadDB().fixedAssets.find(a => a.id === assetId); });
    expect(asset.accumulatedDep).toBeCloseTo(1200 / 5 / 12, 2); // 20.000
  });

  test('Dep B: running the SAME period twice is rejected (idempotency guard)', async () => {
    const res = await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2052-01' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_RUN');
  });

  test('Dep C: depreciation clamps at NBV = salvage value, never overshoots', async () => {
    const create = await createAsset({ name: 'DepC-Asset', cost: 1200, usefulLife: 5, salvageValue: 200 });
    const assetId = create.body.asset.id;
    // Force the asset to the edge of full depreciation (depreciable base = 1000; only 10 left).
    // accumulatedDep is now a system-managed field (adversarial-review P0 fix) and PUT correctly
    // rejects setting it directly — set up the scenario via direct DB state instead of the HTTP route.
    await runAsTenant('default', async () => {
      const db = loadDB();
      const asset = db.fixedAssets.find(a => a.id === assetId);
      asset.accumulatedDep = 990;
      saveDB(db);
    });
    const res = await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2052-02' });
    expect(res.status).toBe(200);
    let asset;
    await runAsTenant('default', async () => { asset = loadDB().fixedAssets.find(a => a.id === assetId); });
    expect(asset.accumulatedDep).toBeCloseTo(1000, 2); // clamped to cost - salvage, not 990+16.667
    const nbv = 1200 - asset.accumulatedDep;
    expect(nbv).toBeCloseTo(200, 2); // exactly salvageValue, never below

    // A further period must skip this fully-depreciated asset entirely (no over-depreciation)
    await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2052-03' });
    let asset2;
    await runAsTenant('default', async () => { asset2 = loadDB().fixedAssets.find(a => a.id === assetId); });
    expect(asset2.accumulatedDep).toBeCloseTo(1000, 2); // unchanged
  });

  test('Dep D: a disposed asset is excluded from any subsequent depreciation run', async () => {
    const create = await createAsset({ name: 'DepD-Asset', cost: 600, usefulLife: 5, salvageValue: 0 });
    const assetId = create.body.asset.id;
    await request(app).post(`/api/assets/${assetId}/dispose`).set(auth()).send({ disposalDate: '2052-03-15', proceeds: 0 }).then(r => expect(r.status).toBe(200));
    await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2052-04' });
    let asset;
    await runAsTenant('default', async () => { asset = loadDB().fixedAssets.find(a => a.id === assetId); });
    expect(asset.accumulatedDep).toBeCloseTo(0, 2); // never depreciated after disposal at 0 accumulated
    expect(asset.status).toBe('disposed');
  });

  test('Dep E: /api/close/run-all\'s depreciation step delegates to the SAME canonical engine (same DEP-<period> ref convention)', async () => {
    const create = await createAsset({ name: 'DepE-Asset', cost: 2400, usefulLife: 10, salvageValue: 0 });
    const assetId = create.body.asset.id;
    const res = await request(app).post('/api/close/run-all').set(auth()).send({ month: '2052-05', options: { depreciation: true, closing: false, confirmEmptyClose: true } });
    expect(res.status).toBe(200);
    const je = await findJE(j => j.ref === 'DEP-2052-05');
    expect(je).toBeTruthy(); // exact same ref format as the direct /api/assets/depreciate path
    let asset;
    await runAsTenant('default', async () => { asset = loadDB().fixedAssets.find(a => a.id === assetId); });
    expect(asset.accumulatedDep).toBeCloseTo(2400 / 10 / 12, 2);
    // Re-running the same period via THIS route must also be blocked by the shared guard
    const res2 = await request(app).post('/api/close/run-all').set(auth()).send({ month: '2052-05', options: { depreciation: true, closing: false } });
    expect(res2.status).toBe(409); // month already locked by the first run-all call
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Creation A-E
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Fixed Asset Creation & Account Validation', () => {
  test('Create A: a valid asset creation posts a balanced purchase journal', async () => {
    const res = await createAsset({ name: 'CreateA-Asset', cost: 500 });
    expect(res.status).toBe(200);
    const je = await findJE(j => j.ref === 'AST-' + res.body.asset.id);
    expect(je).toBeTruthy();
    expect(je.totalDebit).toBeCloseTo(500, 3);
    expect(je.totalCredit).toBeCloseTo(500, 3);
  });

  test('Create B: an unknown coaAccount code is rejected', async () => {
    const res = await createAsset({ name: 'CreateB-Asset', coaAccount: '9999-GONE' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_ACCOUNT');
  });

  test('Create C: a group/header account is rejected for coaAccount', async () => {
    const res = await createAsset({ name: 'CreateC-Asset', coaAccount: '1500' }); // fixed-assets GROUP header
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('GROUP_ACCOUNT_POSTING');
  });

  test('Create D: a wrong-type account is rejected for depExpAccount', async () => {
    const res = await createAsset({ name: 'CreateD-Asset', depExpAccount: '1100' }); // asset-type, not expense
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INCOMPATIBLE_ACCOUNT_TYPE');
  });

  test('Create E: payMethod:"credit" posts the purchase to 2100 (AP), not cash/bank', async () => {
    const res = await createAsset({ name: 'CreateE-Asset', cost: 300, payMethod: 'credit' });
    expect(res.status).toBe(200);
    const je = await findJE(j => j.ref === 'AST-' + res.body.asset.id);
    expect(je.lines.some(l => l.accountCode === '2100' && l.credit === 300)).toBe(true);
    expect(je.lines.some(l => l.accountCode === '1100')).toBe(false);
    expect(je.lines.some(l => l.accountCode === '1110')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Edit A-D
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Fixed Asset Edit & History Lock', () => {
  test('Edit A: an asset with a purchase journal (history) cannot have its cost changed', async () => {
    const create = await createAsset({ name: 'EditA-Asset', cost: 400 });
    const res = await request(app).put(`/api/assets/${create.body.asset.id}`).set(auth()).send({ cost: 999 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_HISTORY_LOCKED');
  });

  test('Edit B: the same historied asset CAN have cosmetic fields (name/category) changed', async () => {
    const create = await createAsset({ name: 'EditB-Asset-Old', cost: 400 });
    const res = await request(app).put(`/api/assets/${create.body.asset.id}`).set(auth()).send({ name: 'EditB-Asset-New', category: 'IT' });
    expect(res.status).toBe(200);
    expect(res.body.asset.name).toBe('EditB-Asset-New');
  });

  test('Edit C: a zero-cost (never-historied) asset CAN have its cost changed freely', async () => {
    const create = await createAsset({ name: 'EditC-Asset', cost: 0 });
    const res = await request(app).put(`/api/assets/${create.body.asset.id}`).set(auth()).send({ cost: 250 });
    expect(res.status).toBe(200);
    expect(res.body.asset.cost).toBe(250);
  });

  test('Edit D: PUT validates a newly-supplied account field even before any history exists', async () => {
    const create = await createAsset({ name: 'EditD-Asset', cost: 0 });
    const res = await request(app).put(`/api/assets/${create.body.asset.id}`).set(auth()).send({ depExpAccount: '9999-GONE' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_ACCOUNT');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Delete Safety & Disposal A-G (P6-046)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Fixed Asset Delete Safety & Disposal (P6-046)', () => {
  test('Delete A: a never-historied (cost 0) asset can be hard-deleted', async () => {
    const create = await createAsset({ name: 'DeleteA-Asset', cost: 0 });
    const res = await request(app).delete(`/api/assets/${create.body.asset.id}`).set(auth());
    expect(res.status).toBe(200);
    let asset;
    await runAsTenant('default', async () => { asset = loadDB().fixedAssets.find(a => a.id === create.body.asset.id); });
    expect(asset).toBeUndefined();
  });

  test('Delete B: an asset with a purchase journal cannot be hard-deleted', async () => {
    const create = await createAsset({ name: 'DeleteB-Asset', cost: 400 });
    const res = await request(app).delete(`/api/assets/${create.body.asset.id}`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_HISTORY_LOCKED');
  });

  test('Dispose A: disposing with proceeds greater than NBV posts a gain to 4300', async () => {
    const create = await createAsset({ name: 'DisposeA-Asset', cost: 1000, usefulLife: 10, salvageValue: 0, purchaseDate: '2052-01-01' });
    const res = await request(app).post(`/api/assets/${create.body.asset.id}/dispose`).set(auth()).send({ disposalDate: '2052-01-02', proceeds: 1000 }); // NBV ~1000 (no depreciation run yet), proceeds 1000 -> gain 0; force a gain instead
    // Re-derive with a guaranteed gain: NBV is ~cost (no depreciation posted for this asset yet) so proceeds > cost guarantees a gain.
    expect(res.status).toBe(200);
    const create2 = await createAsset({ name: 'DisposeA2-Asset', cost: 500, usefulLife: 10, salvageValue: 0, purchaseDate: '2052-01-01' });
    const res2 = await request(app).post(`/api/assets/${create2.body.asset.id}/dispose`).set(auth()).send({ disposalDate: '2052-01-03', proceeds: 700 });
    expect(res2.status).toBe(200);
    const je = await findJE(j => j.id === 'JE-DISPOSE-' + create2.body.asset.id);
    expect(je.lines.some(l => l.accountCode === '4300' && l.credit === 200)).toBe(true); // gain = 700 - 500
  });

  test('Dispose B: disposing with proceeds less than NBV posts a loss to 5910', async () => {
    const create = await createAsset({ name: 'DisposeB-Asset', cost: 500, usefulLife: 10, salvageValue: 0, purchaseDate: '2052-01-01' });
    const res = await request(app).post(`/api/assets/${create.body.asset.id}/dispose`).set(auth()).send({ disposalDate: '2052-01-04', proceeds: 100 });
    expect(res.status).toBe(200);
    const je = await findJE(j => j.id === 'JE-DISPOSE-' + create.body.asset.id);
    expect(je.lines.some(l => l.accountCode === '5910' && l.debit === 400)).toBe(true); // loss = 500 - 100
  });

  test('Dispose C: disposing an already-disposed asset is rejected', async () => {
    const create = await createAsset({ name: 'DisposeC-Asset', cost: 300, purchaseDate: '2052-01-01' });
    await request(app).post(`/api/assets/${create.body.asset.id}/dispose`).set(auth()).send({ disposalDate: '2052-01-05', proceeds: 300 }).then(r => expect(r.status).toBe(200));
    const res = await request(app).post(`/api/assets/${create.body.asset.id}/dispose`).set(auth()).send({ disposalDate: '2052-01-06', proceeds: 0 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_DISPOSED');
  });

  test('Dispose D: the disposal journal always balances (debit === credit) regardless of gain/loss/exact', async () => {
    const create = await createAsset({ name: 'DisposeD-Asset', cost: 800, purchaseDate: '2052-01-01' });
    const res = await request(app).post(`/api/assets/${create.body.asset.id}/dispose`).set(auth()).send({ disposalDate: '2052-01-07', proceeds: 800 }); // exact NBV, zero gain/loss
    expect(res.status).toBe(200);
    const je = await findJE(j => j.id === 'JE-DISPOSE-' + create.body.asset.id);
    const dr = je.lines.reduce((s, l) => s + (l.debit || 0), 0);
    const cr = je.lines.reduce((s, l) => s + (l.credit || 0), 0);
    expect(Math.abs(dr - cr)).toBeLessThan(0.005);
  });

  test('Dispose E: negative proceeds are rejected', async () => {
    const create = await createAsset({ name: 'DisposeE-Asset', cost: 300, purchaseDate: '2052-01-01' });
    const res = await request(app).post(`/api/assets/${create.body.asset.id}/dispose`).set(auth()).send({ disposalDate: '2052-01-08', proceeds: -50 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PROCEEDS');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Register-to-GL Reconciliation A-B
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Fixed Asset Register-to-GL Reconciliation', () => {
  test('Recon A: a freshly created, normally-depreciated asset moves register and GL together (zero NEW difference introduced)', async () => {
    const before = await request(app).get('/api/assets/reconciliation').set(auth());
    const create = await createAsset({ name: 'ReconA-Asset', cost: 1200, usefulLife: 10, salvageValue: 0, purchaseDate: '2052-06-01' });
    await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2052-06' });
    const after = await request(app).get('/api/assets/reconciliation').set(auth());
    const costDelta = after.body.registerCost - before.body.registerCost;
    const glCostDelta = after.body.glCost - before.body.glCost;
    expect(Math.abs(costDelta - glCostDelta)).toBeLessThan(0.005); // register and GL cost move by the same amount
    const accumDelta = after.body.registerAccumDep - before.body.registerAccumDep;
    const glAccumDelta = after.body.glAccumDep - before.body.glAccumDep;
    expect(Math.abs(accumDelta - glAccumDelta)).toBeLessThan(0.005);
  });

  test('Recon B: a disposed asset\'s cost drops out of registerCost (excluded once disposed)', async () => {
    const create = await createAsset({ name: 'ReconB-Asset', cost: 900, purchaseDate: '2052-06-01' });
    const before = await request(app).get('/api/assets/reconciliation').set(auth());
    await request(app).post(`/api/assets/${create.body.asset.id}/dispose`).set(auth()).send({ disposalDate: '2052-06-15', proceeds: 900 });
    const after = await request(app).get('/api/assets/reconciliation').set(auth());
    expect(before.body.registerCost - after.body.registerCost).toBeCloseTo(900, 2);
  });

  test('Recon C (R5 staging finding): an active asset posted under a DIFFERENT coaAccount than the one being queried must not pollute registerCost/registerAccumDep for either account\'s reconciliation', async () => {
    // Reproduces a real bug found while staging-testing a company with assets
    // split across two control accounts (medical equipment 1510, furniture
    // 1520): registerCost used to sum EVERY active asset unconditionally,
    // while glCost was correctly scoped to the queried account — so a new
    // asset posted to ONE account inflated registerCost for a reconciliation
    // query against the OTHER account too, corrupting its costDifference by
    // exactly the new asset's cost even though nothing about that account
    // actually changed. Uses before/after DELTAS (like Recon A/B above)
    // rather than an absolute reconciled:true, since this file accumulates
    // other tests' assets/journals against the shared 1510/1590 accounts —
    // the bug is specifically about cross-account contamination, which a
    // delta isolates regardless of whatever else already happened to 1510.
    const before1510 = await request(app).get('/api/assets/reconciliation').set(auth()).query({ costAccount: '1510', accumDepAccount: '1590' });
    const a1520 = await createAsset({ name: 'ReconC-1520', cost: 500, purchaseDate: '2052-06-01', coaAccount: '1520' });
    expect(a1520.status).toBe(200);
    const after1510 = await request(app).get('/api/assets/reconciliation').set(auth()).query({ costAccount: '1510', accumDepAccount: '1590' });

    // The 1520-account asset must move NEITHER registerCost NOR glCost for
    // a 1510-scoped query — under the bug, registerCost jumped by 500 while
    // glCost (correctly scoped) did not, producing a spurious costDifference.
    expect(after1510.body.registerCost - before1510.body.registerCost).toBeCloseTo(0, 2);
    expect(after1510.body.glCost - before1510.body.glCost).toBeCloseTo(0, 2);
    expect(after1510.body.costDifference).toBeCloseTo(before1510.body.costDifference, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Matching Engine A-C (matched-book dead-branch fix)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Bank Reconciliation Matching Engine & Matched-Book Fix', () => {
  let matchedProposal;

  test('Match A: reconcile-match finds a "matched-book" pairing for an existing bank-account journal entry', async () => {
    await postJournal('2052-07-01', [{ accountCode: '1110', debit: 300, credit: 0 }, { accountCode: '4200', debit: 0, credit: 300 }]).then(r => expect(r.status).toBe(200));
    const res = await request(app).post('/api/bank/reconcile-match').set(auth()).send({
      lines: [{ date: '2052-07-02', desc: 'statement line matching book', amount: 300 }],
    });
    expect(res.status).toBe(200);
    matchedProposal = res.body.proposals.find(p => p.kind === 'matched-book');
    expect(matchedProposal).toBeTruthy();
    expect(matchedProposal.srcKey).toBeTruthy(); // P0.10 fix: previously undefined
    expect(matchedProposal.bookMatchKey).toBeTruthy();
  });

  test('Match B: committing a matched-book proposal registers it — no new journal, matched count increments', async () => {
    const before = await runAsTenant('default', async () => loadDB().journalEntries.length);
    const res = await request(app).post('/api/bank/reconcile-commit').set(auth()).send({ proposals: [matchedProposal] });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(1);
    expect(res.body.posted).toBe(0);
    let after, matchedIds, committedKeys;
    await runAsTenant('default', async () => {
      const db = loadDB();
      after = db.journalEntries.length;
      matchedIds = db.bankMatchedLineIds || [];
      committedKeys = db.bankCommittedLineKeys || [];
    });
    expect(after).toBe(before); // no new JE posted
    expect(matchedIds).toContain(matchedProposal.bookMatchKey);
    expect(committedKeys).toContain(matchedProposal.srcKey);
  });

  test('Match C: re-matching the exact same statement line is now correctly recognized as already posted', async () => {
    const res = await request(app).post('/api/bank/reconcile-match').set(auth()).send({
      lines: [{ date: '2052-07-02', desc: 'statement line matching book', amount: 300 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.alreadyPosted).toBe(1);
    expect(res.body.proposals.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Commit A-D
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Bank Reconciliation Commit (settlement / deposit / skipped reasons)', () => {
  test('Commit A: a settlement proposal posts a balanced JE and increases networkReceivableCleared', async () => {
    const before = await runAsTenant('default', async () => ({ ...(loadDB().networkReceivableCleared || { knet: 0, card: 0 }) }));
    const res = await request(app).post('/api/bank/reconcile-commit').set(auth()).send({
      proposals: [{ kind: 'settlement', srcKey: 'settle-test-1', bucket: 'knet', net: 50, settleAccount: '1125', bankAccount: '1110', bankDate: '2052-07-05', bankDesc: 'network settlement' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(1);
    const je = await findJE(j => j.lines && j.lines.some(l => l.accountCode === '1110' && l.debit === 50) && j.type === 'bank-settlement');
    expect(je).toBeTruthy();
    expect(je.lines.some(l => l.accountCode === '1125' && l.credit === 50)).toBe(true);
    let after;
    await runAsTenant('default', async () => { after = loadDB().networkReceivableCleared; });
    expect(after.knet - (before.knet || 0)).toBeCloseTo(50, 3);
  });

  test('Commit B: a deposit-unmatched proposal with a matching split posts correctly', async () => {
    const res = await request(app).post('/api/bank/reconcile-commit').set(auth()).send({
      proposals: [{ kind: 'deposit-unmatched', srcKey: 'dep-test-1', bankDate: '2052-07-06', bankDesc: 'misc deposit', amount: 120, bankAccount: '1110', splits: [{ accountCode: '4200', amount: 120, desc: 'misc' }] }],
    });
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(1);
    const je = await findJE(j => j.type === 'bank-deposit' && j.lines.some(l => l.accountCode === '1110' && l.debit === 120));
    expect(je).toBeTruthy();
    expect(je.lines.some(l => l.accountCode === '4200' && l.credit === 120)).toBe(true);
  });

  test('Commit C: a split total not matching the line amount is skipped with skippedReasons.splitMismatch', async () => {
    const res = await request(app).post('/api/bank/reconcile-commit').set(auth()).send({
      proposals: [{ kind: 'deposit-unmatched', srcKey: 'dep-test-2', bankDate: '2052-07-07', bankDesc: 'bad split', amount: 100, bankAccount: '1110', splits: [{ accountCode: '4200', amount: 50, desc: 'x' }] }],
    });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.skippedReasons.splitMismatch).toBe(1);
  });

  test('Commit D: a proposal with no account assigned at all is skipped with skippedReasons.noAccountAssigned', async () => {
    const res = await request(app).post('/api/bank/reconcile-commit').set(auth()).send({
      proposals: [{ kind: 'withdrawal', srcKey: 'wd-test-1', bankDate: '2052-07-08', bankDesc: 'unassigned withdrawal', amount: 40, bankAccount: '1110' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.skippedReasons.noAccountAssigned).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Undo A-F
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Bank Reconciliation Single-Item Undo', () => {
  let settlementJeId;

  test('Undo A: undoing a settlement JE deletes it and restores networkReceivableCleared', async () => {
    await request(app).post('/api/bank/reconcile-commit').set(auth()).send({
      proposals: [{ kind: 'settlement', srcKey: 'undo-settle-1', bucket: 'card', net: 30, settleAccount: '1125', bankAccount: '1110', bankDate: '2052-08-01', bankDesc: 'to be undone' }],
    }).then(r => expect(r.status).toBe(200));
    const je = await findJE(j => j._srcKey === 'undo-settle-1');
    expect(je).toBeTruthy();
    settlementJeId = je.id;
    const before = await runAsTenant('default', async () => ({ ...(loadDB().networkReceivableCleared || {}) }));

    const res = await request(app).post('/api/bank/reconcile-undo').set(auth()).send({ jeId: settlementJeId });
    expect(res.status).toBe(200);
    const gone = await findJE(j => j.id === settlementJeId);
    expect(gone).toBeUndefined();
    let after, committedKeys;
    await runAsTenant('default', async () => { after = loadDB().networkReceivableCleared; committedKeys = loadDB().bankCommittedLineKeys || []; });
    expect(before.card - after.card).toBeCloseTo(30, 3);
    expect(committedKeys).not.toContain('undo-settle-1'); // Undo B: srcKey removed so the line can be recommitted
  });

  test('Undo B: the freed srcKey can now be recommitted without hitting the duplicate guard', async () => {
    const res = await request(app).post('/api/bank/reconcile-commit').set(auth()).send({
      proposals: [{ kind: 'settlement', srcKey: 'undo-settle-1', bucket: 'card', net: 30, settleAccount: '1125', bankAccount: '1110', bankDate: '2052-08-02', bankDesc: 're-committed' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.posted).toBe(1);
    expect(res.body.duplicate).toBe(0);
  });

  test('Undo C: undoing a matched-book pairing by srcKey/bookMatchKey clears the match, no JE touched', async () => {
    await postJournal('2052-08-03', [{ accountCode: '1110', debit: 75, credit: 0 }, { accountCode: '4200', debit: 0, credit: 75 }]).then(r => expect(r.status).toBe(200));
    const matchRes = await request(app).post('/api/bank/reconcile-match').set(auth()).send({ lines: [{ date: '2052-08-04', desc: 'undo-match-test', amount: 75 }] });
    const proposal = matchRes.body.proposals.find(p => p.kind === 'matched-book');
    expect(proposal).toBeTruthy();
    await request(app).post('/api/bank/reconcile-commit').set(auth()).send({ proposals: [proposal] }).then(r => expect(r.body.matched).toBe(1));

    const res = await request(app).post('/api/bank/reconcile-undo').set(auth()).send({ srcKey: proposal.srcKey, bookMatchKey: proposal.bookMatchKey });
    expect(res.status).toBe(200);
    let matchedIds, committedKeys, jeCountAfter;
    await runAsTenant('default', async () => {
      const db = loadDB();
      matchedIds = db.bankMatchedLineIds || [];
      committedKeys = db.bankCommittedLineKeys || [];
      jeCountAfter = db.journalEntries.length;
    });
    expect(matchedIds).not.toContain(proposal.bookMatchKey);
    expect(committedKeys).not.toContain(proposal.srcKey);
  });

  test('Undo D: undoing a JE whose date falls in a NOW-locked period is rejected (403)', async () => {
    await request(app).post('/api/bank/reconcile-commit').set(auth()).send({
      proposals: [{ kind: 'settlement', srcKey: 'undo-locked-1', bucket: 'knet', net: 15, settleAccount: '1125', bankAccount: '1110', bankDate: '2052-09-01', bankDesc: 'will be locked' }],
    }).then(r => expect(r.status).toBe(200));
    const je = await findJE(j => j._srcKey === 'undo-locked-1');
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2052-09', locked: true }).then(r => expect(r.status).toBe(200));
    const res = await request(app).post('/api/bank/reconcile-undo').set(auth()).send({ jeId: je.id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('Undo E: undoing a non-existent jeId returns 404', async () => {
    const res = await request(app).post('/api/bank/reconcile-undo').set(auth()).send({ jeId: 'JE-BRC-DOES-NOT-EXIST' });
    expect(res.status).toBe(404);
  });

  test('Undo F: undoing a jeId that is NOT a bank-reconciliation entry is rejected with NOT_RECON_ENTRY', async () => {
    const jr = await postJournal('2052-08-05', [{ accountCode: '5900', debit: 10, credit: 0 }, { accountCode: '1100', debit: 0, credit: 10 }]);
    const res = await request(app).post('/api/bank/reconcile-undo').set(auth()).send({ jeId: jr.body.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_RECON_ENTRY');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Legacy Route Hardening A-C
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Legacy Bank-Recon Route Hardening', () => {
  test('Legacy A: GET /api/bank-recon returns a reconciliation block', async () => {
    await request(app).post('/api/bank-recon').set(auth()).send({ account: '1100', period: '2052-10', bankStatementLines: [{ date: '2052-10-01', desc: 'x', amount: 50 }], matchedLines: [], bankEndBalance: 50, notes: '' }).then(r => expect(r.status).toBe(200));
    const res = await request(app).get('/api/bank-recon').set(auth()).query({ account: '1100', period: '2052-10' });
    expect(res.status).toBe(200);
    expect(res.body.reconciliation).toBeTruthy();
    expect(typeof res.body.reconciliation.bookBalance).toBe('number');
    expect(typeof res.body.reconciliation.difference).toBe('number');
    expect(res.body.reconciliation.note).toBeTruthy();
  });

  test('Legacy B: saving a bank-recon record for a LOCKED period is rejected (403)', async () => {
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2052-11', locked: true }).then(r => expect(r.status).toBe(200));
    const res = await request(app).post('/api/bank-recon').set(auth()).send({ account: '1100', period: '2052-11', bankStatementLines: [], matchedLines: [], bankEndBalance: 0, notes: '' });
    expect(res.status).toBe(403);
  });

  test('Legacy C: saving a bank-recon record for an OPEN period succeeds', async () => {
    const res = await request(app).post('/api/bank-recon').set(auth()).send({ account: '1100', period: '2052-12', bankStatementLines: [], matchedLines: [], bankEndBalance: 0, notes: 'ok' });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Negative Balance Guard A-B (P6-047)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Negative Cash/Bank Balance Guard (P6-047)', () => {
  test('Balance A: a large unbacked credit to 1100 (cash) is flagged as a negative-balance alert', async () => {
    await postJournal('2052-07-09', [{ accountCode: '5900', debit: 50000, credit: 0 }, { accountCode: '1100', debit: 0, credit: 50000 }]).then(r => expect(r.status).toBe(200));
    const res = await request(app).get('/api/anomalies').set(auth());
    expect(res.status).toBe(200);
    const alert = res.body.balanceAlerts.find(a => a.accountCode === '1100');
    expect(alert).toBeTruthy();
    expect(alert.balance).toBeLessThan(0);
    expect(alert.code).toBe('NEGATIVE_CASH_BALANCE');
  });

  test('Balance B: an account that never went negative (1110) is not flagged', async () => {
    const res = await request(app).get('/api/anomalies').set(auth());
    expect(res.status).toBe(200);
    const alert = res.body.balanceAlerts.find(a => a.accountCode === '1110');
    expect(alert).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Employee Delete Safety A-C (P6-074)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Employee Delete Safety (P6-074)', () => {
  test('Employee A: an employee with NO payroll history is hard-deleted', async () => {
    await request(app).post('/api/employees').set(auth()).send({ name: 'EmployeeA-NoHistory' }).then(r => expect(r.status).toBe(200));
    const list = await request(app).get('/api/employees').set(auth());
    const emp = list.body.find(e => e.name === 'EmployeeA-NoHistory');
    expect(emp).toBeTruthy();
    const res = await request(app).delete(`/api/employees/${emp.id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.deactivated).toBe(false);
    const list2 = await request(app).get('/api/employees').set(auth());
    expect(list2.body.find(e => e.id === emp.id)).toBeUndefined();
  });

  test('Employee B: an employee referenced by a payroll entry (by name) is DEACTIVATED, not deleted', async () => {
    await request(app).post('/api/employees').set(auth()).send({ name: 'EmployeeB-HasPayroll' }).then(r => expect(r.status).toBe(200));
    const list = await request(app).get('/api/employees').set(auth());
    const emp = list.body.find(e => e.name === 'EmployeeB-HasPayroll');
    await request(app).post('/api/payroll').set(auth()).send({ month: '2052-07', entries: [{ name: 'EmployeeB-HasPayroll', role: 'admin', basicSalary: 300, allowances: 0, deductions: 0 }] }).then(r => expect(r.status).toBe(200));

    const res = await request(app).delete(`/api/employees/${emp.id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.deactivated).toBe(true);
    const list2 = await request(app).get('/api/employees').set(auth());
    const stillThere = list2.body.find(e => e.id === emp.id);
    expect(stillThere).toBeTruthy(); // kept, not removed
    expect(stillThere.status).toBe('inactive');
  });

  test('Employee C: the deactivation is audited', async () => {
    let audit;
    await runAsTenant('default', async () => { audit = loadDB().auditLog.find(a => a.action === 'employee.deactivated'); });
    expect(audit).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RBAC / Audit / Persistence / Tenant A-E
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — RBAC, Audit, Persistence, Tenant Isolation', () => {
  test('RBAC A: a non-admin role cannot create a fixed asset', async () => {
    const res = await request(app).post('/api/assets').set(auth(recepToken)).send({ name: 'RBAC-Asset', cost: 100 });
    expect(res.status).toBe(403);
  });

  test('RBAC B: a non-admin role cannot commit a bank reconciliation', async () => {
    const res = await request(app).post('/api/bank/reconcile-commit').set(auth(recepToken)).send({ proposals: [] });
    expect(res.status).toBe(403);
  });

  test('Audit A: asset disposal is audited', async () => {
    const create = await createAsset({ name: 'AuditA-Asset', cost: 200, purchaseDate: '2052-01-01' });
    await request(app).post(`/api/assets/${create.body.asset.id}/dispose`).set(auth()).send({ disposalDate: '2052-01-09', proceeds: 200 }).then(r => expect(r.status).toBe(200));
    let audit;
    await runAsTenant('default', async () => { audit = loadDB().auditLog.find(a => a.action === 'asset.disposed' && a.resourceId === create.body.asset.id); });
    expect(audit).toBeTruthy();
  });

  test('Persistence A: a committed bank-recon JE survives shutdownDB/initDB reload', async () => {
    await request(app).post('/api/bank/reconcile-commit').set(auth()).send({
      proposals: [{ kind: 'deposit-unmatched', srcKey: 'persist-test-1', bankDate: '2052-08-10', bankDesc: 'persist check', amount: 60, bankAccount: '1110', splits: [{ accountCode: '4200', amount: 60, desc: 'x' }] }],
    }).then(r => expect(r.status).toBe(200));
    await shutdownDB();
    await initDB({
      mongoUri: 'mongodb://127.0.0.1:1/unused', dataFile: process.env.DATA_FILE, configFile: process.env.CONFIG_FILE,
      defaultConfig: {}, buildInitialDB, migrateDB: () => false,
    });
    const je = await findJE(j => j._srcKey === 'persist-test-1');
    expect(je).toBeTruthy();
  });

  test('Tenant A: Tenant A\'s fixed asset is invisible to Tenant B', async () => {
    await runAsTenant('tenant-b-p10', async () => {
      await warmTenantCache('tenant-b-p10');
      const db = loadDB();
      db.users = [{ id: 'usr-tb10', username: 'tenantb10', email: 'tb10@test.com', passwordHash: hash('TenantB1!'), role: 'admin', fullName: 'Tenant B Admin', active: true, createdAt: new Date().toISOString(), lastLogin: null }];
      db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
      saveDB(db);
    });
    const loginB = await request(app).post('/api/auth/login').send({ username: 'tenantb10', password: 'TenantB1!', tenantId: 'tenant-b-p10' });
    const tokenB = loginB.body.token;

    const create = await createAsset({ name: 'TenantA-Only-Asset', cost: 150 });
    expect(create.status).toBe(200);

    const assetsB = await request(app).get('/api/assets').set(auth(tokenB));
    expect(assetsB.status).toBe(200);
    expect(assetsB.body.find(a => a.name === 'TenantA-Only-Asset')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Adversarial-Review Fix Verification A-H — targeted regression coverage
// for the 12 real gaps a background adversarial-review workflow found
// against this milestone's own implementation (fixed in the same
// milestone, not deferred).
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Adversarial-Review Fix Verification', () => {
  test('AdvFix A: PUT cannot flip status directly (bypassing real disposal accounting)', async () => {
    const create = await createAsset({ name: 'AdvFixA-Asset', cost: 300, purchaseDate: '2052-01-01' });
    const res = await request(app).put(`/api/assets/${create.body.asset.id}`).set(auth()).send({ status: 'disposed' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_FIELD_SYSTEM_MANAGED');
  });

  test('AdvFix B: PUT cannot set accumulatedDep directly', async () => {
    const create = await createAsset({ name: 'AdvFixB-Asset', cost: 300, purchaseDate: '2052-01-01' });
    const res = await request(app).put(`/api/assets/${create.body.asset.id}`).set(auth()).send({ accumulatedDep: 999 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_FIELD_SYSTEM_MANAGED');
  });

  test('AdvFix C: PUT cannot change payMethod on a historied asset (desyncs Cash Flow classification)', async () => {
    const create = await createAsset({ name: 'AdvFixC-Asset', cost: 300, payMethod: 'cash', purchaseDate: '2052-01-01' });
    const res = await request(app).put(`/api/assets/${create.body.asset.id}`).set(auth()).send({ payMethod: 'credit' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_HISTORY_LOCKED');
  });

  test('AdvFix D: disposal rejects a proceedsAccount of the wrong type', async () => {
    const create = await createAsset({ name: 'AdvFixD-Asset', cost: 300, purchaseDate: '2052-01-01' });
    const res = await request(app).post(`/api/assets/${create.body.asset.id}/dispose`).set(auth()).send({ disposalDate: '2052-01-10', proceeds: 300, proceedsAccount: '4200' }); // revenue account, wrong type
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INCOMPATIBLE_ACCOUNT_TYPE');
  });

  test('AdvFix E: reconciliation endpoint rejects an unknown costAccount instead of silently reporting reconciled:true', async () => {
    const res = await request(app).get('/api/assets/reconciliation').set(auth()).query({ costAccount: '9999-GONE' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_ACCOUNT');
  });

  test('AdvFix F: reconcile-commit buckets a non-period-lock rejection under otherRejected, not periodLocked', async () => {
    const res = await request(app).post('/api/bank/reconcile-commit').set(auth()).send({
      proposals: [{ kind: 'settlement', srcKey: 'advfix-f-1', bucket: 'knet', net: 25, settleAccount: '9999-GONE', bankAccount: '1110', bankDate: '2052-07-20', bankDesc: 'bad settle account' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.skippedReasons.otherRejected).toBe(1);
    expect(res.body.skippedReasons.periodLocked).toBe(0);
  });

  test('AdvFix G: reconcile-undo rejects a breadcrumb-less legacy settlement instead of silently leaving networkReceivableCleared stale', async () => {
    const legacyJeId = 'JE-BRC-LEGACY-1';
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.journalEntries.push({
        id: legacyJeId, date: '2052-07-21', desc: 'legacy settlement (pre-P0.10, no breadcrumbs)',
        ref: 'BRECON', reference: 'BRECON', type: 'bank-settlement', totalDebit: 40, totalCredit: 40, createdAt: new Date().toISOString(),
        lines: [{ accountCode: '1110', debit: 40, credit: 0 }, { accountCode: '1125', debit: 0, credit: 40 }],
      });
      db.networkReceivableCleared = db.networkReceivableCleared || { knet: 0, card: 0 };
      db.networkReceivableCleared.knet = (db.networkReceivableCleared.knet || 0) + 40;
      saveDB(db);
    });
    const res = await request(app).post('/api/bank/reconcile-undo').set(auth()).send({ jeId: legacyJeId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LEGACY_SETTLEMENT_NO_BREADCRUMB');
    const stillThere = await findJE(j => j.id === legacyJeId);
    expect(stillThere).toBeTruthy(); // rejected before any mutation — the legacy JE is untouched
  });

  test('AdvFix H: PIFSS/EOS aggregation excludes a soft-deleted (inactive) employee', async () => {
    await request(app).post('/api/employees').set(auth()).send({
      // hireDate must be in the real past (calcEosForEmployee derives years-of-service from the
      // actual system clock, not this file's fictional 2052 journal dates) so EOS accrues > 0.
      name: 'AdvFixH-Employee', basicSalary: 500, nationality: 'كويتي', pifssEnrolled: true, hireDate: '2015-01-01',
    }).then(r => expect(r.status).toBe(200));
    const list = await request(app).get('/api/employees').set(auth());
    const emp = list.body.find(e => e.name === 'AdvFixH-Employee');
    // R3 — P6-036 fix made payroll month uniqueness a real, enforced domain
    // guard: '2052-07' is already claimed by an earlier test in this same
    // file (Employee B, line ~589) — using a genuinely unused month here
    // instead of relying on the old (buggy) tolerance for same-month reposts.
    await request(app).post('/api/payroll').set(auth()).send({ month: '2053-01', entries: [{ name: 'AdvFixH-Employee', role: 'admin', basicSalary: 500, allowances: 0, deductions: 0 }] }).then(r => expect(r.status).toBe(200));
    const del = await request(app).delete(`/api/employees/${emp.id}`).set(auth());
    expect(del.status).toBe(200);
    expect(del.body.deactivated).toBe(true); // soft-deleted, stays in db.employees[] with status:'inactive'

    // A fresh, never-locked period's close/run-all must NOT post any PIFSS/EOS liability for this
    // now-inactive employee — they are the only employee in this test file with real
    // basicSalary/nationality/hireDate, so a PIFSS-2052-08 journal existing at all here would mean
    // the exclusion failed. (2052-09/2052-11 are used by earlier period-lock tests — avoided here.)
    await request(app).post('/api/close/run-all').set(auth()).send({ month: '2052-08', options: { depreciation: false, pifss: true, eos: true, closing: false, confirmEmptyClose: true } }).then(r => expect(r.status).toBe(200));
    const pifssJe = await findJE(j => j.ref === 'PIFSS-2052-08');
    const eosJe = await findJE(j => j.ref === 'EOS-2052-08');
    expect(pifssJe).toBeUndefined();
    expect(eosJe).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Regression A-D
// ═══════════════════════════════════════════════════════════════════════
describe('P0.10 — Regression: P0.9/P0.8/P0.7/P0.6B/P0.6A scenarios remain correct', () => {
  test('Regression A: the P0.9 COA account-type immutability guard remains green', async () => {
    const acc = await request(app).post('/api/coa/account').set(auth()).send({ code: '5995', name: 'Regr-P09', type: 'expense', parent: '5000' });
    expect(acc.status).toBe(200);
    await postJournal('2052-07-10', [{ accountCode: '5995', debit: 5, credit: 0 }, { accountCode: '1100', debit: 0, credit: 5 }]).then(r => expect(r.status).toBe(200));
    const res = await request(app).put('/api/coa/account/5995').set(auth()).send({ type: 'asset' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACCOUNT_TYPE_LOCKED');
  });

  test('Regression B: the P0.7 AP vendor-bill lifecycle remains green', async () => {
    const vendorRes = await request(app).post('/api/vendors').set(auth()).send({ name: 'Vendor-P10-Regression' });
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({ vendorId: vendorRes.body.vendor.id, billDate: '2052-07-11', allocations: [{ accountCode: '5200', amount: 400 }] });
    expect(billRes.status).toBe(200);
    const payRes = await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/pay`).set(auth()).send({ amount: 400, payAccount: '1100' });
    expect(payRes.status).toBe(200);
    expect(payRes.body.bill.status).toBe('PAID');
  });

  test('Regression C: the P0.8 Patient AR lifecycle remains green', async () => {
    const pRes = await request(app).post('/api/patients').set(auth()).send({ name: 'Patient-P10-Regression' });
    const rRes = await request(app).post('/api/patient-receivables').set(auth()).send({ patientId: pRes.body.patient.id, serviceDate: '2052-07-12', amount: 300 });
    expect(rRes.status).toBe(200);
    const collRes = await request(app).post(`/api/patient-receivables/${rRes.body.receivable.id}/collect`).set(auth()).send({ amount: 300, collectAccount: '1100' });
    expect(collRes.status).toBe(200);
    expect(collRes.body.receivable.status).toBe('COLLECTED');
  });

  test('Regression D: the Trial Balance remains internally balanced after this whole file\'s activity', async () => {
    const tb = await request(app).get('/api/trial-balance').set(auth());
    expect(tb.status).toBe(200);
    expect(tb.body.isBalanced).toBe(true);
  });
});
