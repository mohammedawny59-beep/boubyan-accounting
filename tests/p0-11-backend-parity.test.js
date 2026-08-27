// P0.11 — Cross-Backend Parity (Objective D) + Part D/O.
//
// Proves the FILE backend and a REAL, isolated, disposable MongoDB backend
// (via tests/helpers/mongoTestHarness.js — mongodb-memory-server, never a
// shared/remote/production instance) produce IDENTICAL financially-material
// results for an identical sequence of operations.
//
// Kept in its own file (not merged into p0-11-persistence-durability.test.js)
// because it needs a real mongod boot (slower, its own timeout budget) and
// because lib/database.js's persistence mode is a MODULE-LEVEL singleton —
// switching backends mid-file only works safely with a single, deliberate,
// sequential handoff, done once here rather than interleaved with the
// faster file-only reload suite.
//
// Mechanic: run the exact same scenario (journal entries + a period close)
// against a fresh FILE-backend instance, capture a snapshot; then fully
// re-init lib/database.js against a fresh, isolated, disposable Mongo
// instance and run the IDENTICAL scenario; capture a second snapshot. The
// snapshot is restricted to financially-material AGGREGATES (Trial Balance
// sums, Income Statement net profit, Balance Sheet totals, Cash Flow
// reconciliation) rather than raw records — raw journalEntries/ids embed
// Date.now()-based ids and createdAt timestamps that will legitimately
// differ between the two phases even when the accounting result is
// identical, so comparing them directly would produce false failures.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-11-backend-parity-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p11-parity-boot-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, isFileFallbackMode, runAsTenant, loadDB, saveDB } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');
const { startIsolatedMongo } = require('./helpers/mongoTestHarness');

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

const auth = t => ({ Authorization: `Bearer ${t}` });

// Same scenario replayed against both backends — deterministic amounts, a
// year (2056) not used by any other P0.11 test file, no reliance on "today".
async function runScenario(token) {
  await request(app).post('/api/journal').set(auth(token)).send({
    date: '2056-01-05', desc: 'Parity revenue', lines: [
      { accountCode: '1100', debit: 5000, credit: 0 },
      { accountCode: '4100', debit: 0, credit: 5000 },
    ],
  }).then(r => { if (r.status !== 200) throw new Error('seed revenue JE failed: ' + JSON.stringify(r.body)); });

  await request(app).post('/api/journal').set(auth(token)).send({
    date: '2056-01-10', desc: 'Parity expense', lines: [
      { accountCode: '5100', debit: 1800, credit: 0 },
      { accountCode: '1100', debit: 0, credit: 1800 },
    ],
  }).then(r => { if (r.status !== 200) throw new Error('seed expense JE failed: ' + JSON.stringify(r.body)); });

  await request(app).post('/api/vouchers').set(auth(token)).send({
    type: 'payment', date: '2056-01-12', payee: 'Parity Payee', assetAccId: '1100',
    lines: [{ accountId: '5200', amount: 300 }],
  }).then(r => { if (r.status !== 200) throw new Error('seed voucher failed: ' + JSON.stringify(r.body)); });

  const close = await request(app).post('/api/closing-entry').set(auth(token)).send({ year: 2056, month: 1 });
  if (close.status !== 200) throw new Error('closing entry failed: ' + JSON.stringify(close.body));

  const stmt = await request(app).get('/api/financial-statements').set(auth(token)).query({ period: 'month', year: 2056, month: 1 });
  if (stmt.status !== 200) throw new Error('financial-statements fetch failed: ' + JSON.stringify(stmt.body));
  return extractComparableSnapshot(stmt.body);
}

// Restricted to financially-material aggregates — see file header for why
// raw records (ids/timestamps) are deliberately excluded.
function extractComparableSnapshot(body) {
  const { incomeStatement: is, balanceSheet: bs, cashFlow: cf } = body;
  return {
    incomeStatement: {
      revenueTotal: is.revenue.total,
      operatingExpensesTotal: is.operatingExpenses.total,
      netProfit: is.netProfit,
    },
    balanceSheet: {
      totalAssets: bs.assets.total,
      totalLiabilities: bs.liabilities.total,
      totalEquity: bs.equity.total,
      totalLiabAndEquity: bs.totalLiabAndEquity,
      balanced: bs.balanced,
      differenceKD: bs.differenceKD,
    },
    cashFlow: {
      operating: cf.operating,
      investing: cf.investing,
      financing: cf.financing,
      netChange: cf.netChange,
      reconciled: cf.reconciled,
    },
  };
}

describe('P0.11 Part D/O — file vs. real isolated Mongo backend parity', () => {
  let mongoInstance;

  afterAll(async () => {
    try { await shutdownDB(); } catch {}
    if (mongoInstance) { try { await mongoInstance.stop(); } catch {} }
    try { fs.removeSync(tmp); } catch {}
  });

  test('Parity A: an identical financial scenario produces identical Trial-Balance-derived Income Statement / Balance Sheet / Cash Flow aggregates on the file backend and on a real isolated Mongo backend', async () => {
    // ── Phase 1: fresh FILE backend ──────────────────────────────────────
    await initDB({
      mongoUri: 'mongodb://127.0.0.1:1/unused',
      dataFile: process.env.DATA_FILE,
      configFile: process.env.CONFIG_FILE,
      defaultConfig: {},
      buildInitialDB,
      migrateDB: () => false,
    });
    expect(isFileFallbackMode()).toBe(true);

    const fileLogin = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
    expect(fileLogin.status).toBe(200);
    const fileSnapshot = await runScenario(fileLogin.body.token);

    // ── Phase 2: fresh, REAL, isolated, disposable Mongo backend ─────────
    // mongodb-memory-server spawns a genuine mongod bound to a random
    // localhost port with its own throwaway data directory — this is never
    // a shared/remote/production instance (see mongoTestHarness.js header).
    mongoInstance = await startIsolatedMongo('p011-parity');
    const mongoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p11-parity-mongo-'));
    process.env.DB_FILE_ONLY = 'false';
    try {
      await initDB({
        mongoUri: mongoInstance.uri,
        dataFile: path.join(mongoTmp, 'database.json'),
        configFile: path.join(mongoTmp, 'config.json'),
        defaultConfig: {},
        buildInitialDB,
        migrateDB: () => false,
      });
    } finally {
      // Restore immediately regardless of outcome — nothing else in this
      // process should ever silently run against a live Mongo attempt.
      process.env.DB_FILE_ONLY = 'true';
    }
    // Proves this is genuinely Mongo-backed, not a silent fallback (P0.11
    // also fixed a real bug here: initDB() previously never reset
    // isFileFallbackMode() back to false on a later successful Mongo
    // connect — see lib/database.js's initDB() comment).
    expect(isFileFallbackMode()).toBe(false);

    const mongoLogin = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
    expect(mongoLogin.status).toBe(200);
    const mongoSnapshot = await runScenario(mongoLogin.body.token);
    fs.removeSync(mongoTmp);

    expect(mongoSnapshot).toEqual(fileSnapshot);
    // A parity check that both sides trivially satisfy (e.g. both broken the
    // same way) would be worthless — anchor to the known-correct numbers so
    // a shared regression can't hide behind "at least they match."
    expect(fileSnapshot.incomeStatement.netProfit).toBeCloseTo(5000 - 1800 - 300, 3);
    expect(fileSnapshot.balanceSheet.balanced).toBe(true);
    expect(fileSnapshot.cashFlow.reconciled).toBe(true);
  }, 120000);

  // P0.11 (adversarial review finding, mongo-parity persona): Parity A above
  // never exercises a non-default tenant, so it could not have caught the
  // real bug this test targets directly — a tenant's cache warmed under one
  // backend silently surviving (and being served/persisted through) a later
  // same-process switch to a completely different, fresh backend, because
  // loadDB()'s non-default-tenant branch only ever checked
  // `_tenantCaches.has(tid)`, never the current backend mode. Fixed in
  // lib/database.js's initDB() by clearing _tenantCaches/_tenantDirty/
  // _tenantTimers (and their file-mode equivalents) on every call, not just
  // resetting the default tenant's own state.
  test('Parity B: a tenant\'s cache does NOT survive a same-process switch to a fresh backend (regression for the initDB() tenant-cache reset fix)', async () => {
    const TENANT = 'acme-p011-parity-b';

    // Parity A (above) leaves the process connected to ITS isolated Mongo
    // instance at the end of its own test body (only torn down in
    // afterAll) — mongoose's default connection is a singleton, and calling
    // mongoose.connect() again while one is still open fails, which would
    // silently push this test's own initDB() calls into file-fallback mode
    // and defeat the whole point of the test. Closing it first, exactly as
    // production's own graceful-shutdown path would, avoids that.
    await shutdownDB();

    // Phase 1: fresh FILE backend — warm the tenant's cache with a real entry.
    const fileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p11-parityb-file-'));
    await initDB({
      mongoUri: 'mongodb://127.0.0.1:1/unused',
      dataFile: path.join(fileTmp, 'database.json'),
      configFile: path.join(fileTmp, 'config.json'),
      defaultConfig: {},
      buildInitialDB,
      migrateDB: () => false,
    });
    expect(isFileFallbackMode()).toBe(true);

    await runAsTenant(TENANT, async () => {
      const db = loadDB();
      db.journalEntries = db.journalEntries || [];
      db.journalEntries.push({ id: 'JE-PARITY-B-STALE', date: '2056-01-01', desc: 'stale file-mode entry', lines: [] });
      await saveDB(db, { durable: true });
    });

    // Phase 2: switch, same process, to a FRESH, real, isolated Mongo
    // backend this tenant has never touched.
    const parityBMongo = await startIsolatedMongo('p011-parity-b');
    const mongoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p11-parityb-mongo-'));
    process.env.DB_FILE_ONLY = 'false';
    try {
      await initDB({
        mongoUri: parityBMongo.uri,
        dataFile: path.join(mongoTmp, 'database.json'),
        configFile: path.join(mongoTmp, 'config.json'),
        defaultConfig: {},
        buildInitialDB,
        migrateDB: () => false,
      });
    } finally {
      process.env.DB_FILE_ONLY = 'true';
    }
    expect(isFileFallbackMode()).toBe(false);

    // The tenant's cache must be genuinely fresh — the stale file-mode
    // journal entry must NOT be visible after the switch.
    await runAsTenant(TENANT, async () => {
      const db = loadDB();
      const stale = (db.journalEntries || []).find(j => j.id === 'JE-PARITY-B-STALE');
      expect(stale).toBeUndefined();
    });

    await parityBMongo.stop();
    fs.removeSync(fileTmp);
    fs.removeSync(mongoTmp);
  }, 120000);
});
