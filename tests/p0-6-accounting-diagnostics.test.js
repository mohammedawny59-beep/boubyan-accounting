// P0.6 — Full Accounting Functional, Workflow & Data Integrity Audit.
//
// These are DIAGNOSTIC tests written to PROVE specific findings documented in
// docs/ACCOUNTING_GAP_REGISTER.md — they are not implementation tests for new
// features. Every test runs against isolated temp storage (DB_FILE_ONLY=true,
// os.tmpdir()) through the REAL server.js app via supertest — no production
// data is ever read or written, no real network/AI call is made.
//
// Several of these tests intentionally assert the CURRENT, BUGGY behavior
// (clearly marked "DIAGNOSTIC OF A KNOWN DEFECT" in each test's comment) so
// that a future milestone that fixes the underlying gap-register item will
// see this test FAIL and know to update it — instead of the regression
// silently losing coverage.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-6-accounting-diagnostics-secret';
process.env.NODE_ENV     = 'test';

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

// P0.6A — Step 18/23 (Telegram A): the real node-telegram-bot-api client
// makes live network calls (long-polling) the instant it's constructed with
// a truthy `polling` option — exactly what POST /api/telegram/start does.
// Mocked here (hoisted by Jest above the requires below) so Telegram A can
// exercise the REAL bot.on('message', ...) handler registered by
// server.js's setupBot() with zero network activity, per the milestone's
// explicit "Mock Telegram network" instruction.
jest.mock('node-telegram-bot-api', () => jest.fn().mockImplementation(() => ({
  on: jest.fn(),
  onText: jest.fn(),
  sendMessage: jest.fn().mockResolvedValue({}),
  getFileLink: jest.fn(),
  stopPolling: jest.fn().mockResolvedValue({}),
})));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p06-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB, ENTITY_KEYS, normalizeCanonicalKeys } = require('../lib/database');
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
    journalMappings: [], doctorExpenses: [], lockedPeriods: {},
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
// DIAGNOSTIC A / TB A / TB B — P6-001: Trial Balance no longer doubles
// opening balances (fixed in P0.6A)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6 Diagnostic A / TB A+B — Trial Balance opening-balance double-count fixed (P6-001, fixed in P0.6A)', () => {
  // P0.6A — Step 6 (P6-001) test-expectation update:
  //   OLD ASSERTION: `expect(row1100.totalDebit).toBeCloseTo(1000, 3)` and
  //     a February (unrelated-period) row showing a fabricated 500 balance.
  //   WHY WRONG: those numbers faithfully encoded a real bug — server.js's
  //     GET /api/trial-balance summed the real opening journal entry via
  //     `filteredEntries` AND separately re-added `acc.openingDebit` /
  //     `openingCredit` on top of the same amount.
  //   NEW ACCOUNTING ASSERTION: that redundant re-add block was removed —
  //     the journal entry is the only source now, so the ending balance
  //     must equal the true posted amount (100/500 — not doubled), and a
  //     period that doesn't include the opening entry's own date must show
  //     nothing for it at all (matching how every other account's activity
  //     already behaves in a period-scoped view).
  test('TB A: an opening DEBIT balance (debit-normal account, 1100) is not doubled', async () => {
    const res = await request(app).post('/api/opening-balance').set(auth()).send({
      date: '2031-01-01',
      balances: [
        { code: '1100', debit: 100, credit: 0 },
        { code: '3100', debit: 0, credit: 100 },
      ],
    });
    expect(res.status).toBe(200);

    const tb = await request(app).get('/api/trial-balance?period=all').set(auth());
    expect(tb.status).toBe(200);
    const row1100 = tb.body.rows.find(r => r.code === '1100');
    expect(row1100.totalDebit).toBeCloseTo(100, 3); // FIXED: was 200 (doubled) before P0.6A
    expect(row1100.netDebit).toBeCloseTo(100, 3);
    expect(tb.body.isBalanced).toBe(true);
  });

  test('TB B: an opening CREDIT balance (credit-normal account, 3100) is not doubled', async () => {
    // Same request as TB A also posted a 100 credit to 3100 (equity) — a
    // credit-normal account — so this reuses that same opening entry to
    // prove the fix holds for the credit side too, not just debit.
    const tb = await request(app).get('/api/trial-balance?period=all').set(auth());
    const row3100 = tb.body.rows.find(r => r.code === '3100');
    expect(row3100.totalCredit).toBeCloseTo(100, 3); // FIXED: was 200 (doubled) before P0.6A
    expect(row3100.netCredit).toBeCloseTo(100, 3);
  });

  test('an unrelated period (no real activity) no longer shows a fabricated opening balance', async () => {
    // The opening balance above was dated 2031-01-01. February 2031 has
    // zero real transactions — a correct period-scoped Trial Balance must
    // show nothing for either account that month (matching how every other
    // account's regular activity is already excluded outside its period).
    const tb = await request(app).get('/api/trial-balance?period=month&year=2031&month=2').set(auth());
    expect(tb.status).toBe(200);
    expect(tb.body.rows.find(r => r.code === '1100')).toBeUndefined(); // FIXED: used to fabricate a 500 balance
    expect(tb.body.rows.find(r => r.code === '3100')).toBeUndefined();
  });

  // P0.6A verification pass — TB C: found via an independently-hand-computed
  // worked numerical example (opening 2000, revenue 800, expense 300, asset
  // 1200/1yr/0-salvage -> monthly depreciation 100). GET /api/trial-balance
  // has its OWN separate debit/credit aggregation loop (does not call the
  // shared buildBalanceMap() helper) that only read `line.accountCode ||
  // line.accountId` — POST /api/assets/depreciate (server.js:8130-8131)
  // builds its lines with the key `account`, so every standalone-
  // depreciation entry's two lines were silently invisible to the Trial
  // Balance (grandDebit/grandCredit still matched each other — both were
  // short by the same missing 100 — so `isBalanced:true` never caught it).
  test('TB C: a standalone depreciation entry (POST /api/assets/depreciate) is not silently dropped from the Trial Balance', async () => {
    const assetRes = await request(app).post('/api/assets').set(auth()).send({
      name: 'TB C asset', category: 'equipment', purchaseDate: '2035-08-01',
      cost: 1200, usefulLife: 1, salvageValue: 0, payMethod: 'cash', coaAccount: '1510',
    });
    expect(assetRes.status).toBe(200);
    const depRes = await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2035-08' });
    expect(depRes.status).toBe(200);
    expect(depRes.body.totalDep).toBeCloseTo(100, 3);

    const tb = await request(app).get('/api/trial-balance?period=month&year=2035&month=8').set(auth());
    expect(tb.status).toBe(200);
    const dep5800 = tb.body.rows.find(r => r.code === '5800');
    const accum1590 = tb.body.rows.find(r => r.code === '1590');
    expect(dep5800).toBeTruthy();   // FIXED: previously absent from `rows` entirely
    expect(accum1590).toBeTruthy(); // FIXED: previously absent from `rows` entirely
    expect(dep5800.netDebit).toBeCloseTo(100, 3);
    expect(accum1590.netCredit).toBeCloseTo(100, 3);
    expect(tb.body.isBalanced).toBe(true);

    // Test-isolation cleanup: POST /api/assets/depreciate re-processes EVERY
    // active asset each time it's called (correct real-world behavior for a
    // recurring monthly depreciation run) — this test's own asset must not
    // stay active in the shared tenant, or a LATER test's own depreciate
    // call (e.g. IS A) would silently re-depreciate it too and inflate that
    // test's totalDep. Deactivate only after this test's own assertions.
    //
    // P0.10 adversarial-review fix update: PUT {status:'inactive'} used to
    // be accepted here, but `status` is now a system-managed field (PUT
    // rejects any attempt to set it directly with 409
    // ASSET_FIELD_SYSTEM_MANAGED — a real P0 finding: the old unrestricted
    // PUT let a caller silently achieve the same effect as a real disposal,
    // with no reversing journal and no way to genuinely dispose the asset
    // afterward). This test's cleanup goal is unchanged — just no longer
    // reachable through the public API on purpose — so it now sets the
    // field directly on the shared test DB instead of going through PUT.
    await runAsTenant('default', async () => {
      const db = loadDB();
      const asset = db.fixedAssets.find(a => a.id === assetRes.body.asset.id);
      asset.status = 'inactive';
      saveDB(db);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DIAGNOSTIC B / IS A — P6-051: /api/financial-statements deducts
// depreciation exactly once (fixed in P0.6A)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6 Diagnostic B / IS A — live financial-statements screen deducts depreciation once (P6-051, fixed in P0.6A)', () => {
  // P0.6A — Step 11 (P6-051) test-expectation update:
  //   OLD ASSERTION: `netProfit` equaled `correctlyComputedNetProfit - 100`
  //     (i.e. depreciation subtracted a second time on top of totalOpEx).
  //   WHY WRONG: `coaTypeSum('expense')` already includes account 5800
  //     (depreciation) inside totalOpEx; subtracting the separate
  //     `depreciation` figure again in `ebit = ebitda - depreciation` was a
  //     genuine double count, understating net profit by exactly the
  //     depreciation amount every period depreciation was posted.
  //   NEW ACCOUNTING ASSERTION: totalOpEx now EXCLUDES depreciation (shown
  //     as its own separate line), so it is deducted exactly once. Using
  //     the exact numbers from the milestone's own spec: Revenue=1,000,
  //     operating expenses excluding depreciation=300, depreciation=100 →
  //     profit must be 600, never 500.
  test('IS A: depreciation is deducted exactly once — Revenue 1,000, OpEx-excl-depreciation 300, Depreciation 100 → profit 600', async () => {
    // Asset: cost 1200, useful life 1 year, no salvage → monthly depreciation
    // = (1200-0)/1/12 = 100.000 KWD exactly.
    const assetRes = await request(app).post('/api/assets').set(auth()).send({
      name: 'Diagnostic-B asset', category: 'equipment', purchaseDate: '2031-04-01',
      cost: 1200, usefulLife: 1, salvageValue: 0, payMethod: 'cash',
    });
    expect(assetRes.status).toBe(200);

    const depRes = await request(app).post('/api/assets/depreciate').set(auth()).send({ period: '2031-04' });
    expect(depRes.status).toBe(200);
    expect(depRes.body.totalDep).toBeCloseTo(100, 3);

    // A known, independent expense (300, excluding depreciation) and a
    // known revenue journal entry (1,000) in the same month, so the report
    // has unambiguous, hand-computable totals matching the milestone spec.
    const expRes = await request(app).post('/api/expenses').set(auth()).send({
      date: '2031-04-10', desc: 'Diagnostic-B expense', cat: 'مصاريف عامة', amount: 300, payMethod: 'cash',
    });
    expect(expRes.status).toBe(200);

    const revRes = await request(app).post('/api/journal').set(auth()).send({
      date: '2031-04-15', desc: 'Diagnostic-B revenue',
      lines: [{ accountCode: '1100', debit: 1000, credit: 0 }, { accountCode: '4100', debit: 0, credit: 1000 }],
    });
    expect(revRes.status).toBe(200);

    const fsRes = await request(app).get('/api/financial-statements?period=month&year=2031&month=4').set(auth());
    expect(fsRes.status).toBe(200);
    const is = fsRes.body.incomeStatement;

    expect(is.depreciation).toBeCloseTo(100, 3);
    // FIXED: operatingExpenses.total now excludes depreciation (300, not 400).
    expect(is.operatingExpenses.total).toBeCloseTo(300, 3);
    // FIXED: profit = 1000 - 300 - 100 = 600 (deducted exactly once), never 500.
    expect(is.netProfit).toBeCloseTo(600, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DIAGNOSTIC C / Lock A — P6-012: cascading delete bypasses period lock
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6 Diagnostic C / Lock A — DELETE /api/expenses/:id rejects deletion of a journal entry in an already-locked period (P6-012, fixed in P0.6A)', () => {
  // P0.6A — Step 4 (P6-012) test-expectation update:
  //   OLD ASSERTION: `expect(cascadeDelete.status).toBe(200)` and
  //     `expect(jeExistsAfterCascade).toBe(false)` — the cascaded journal
  //     deletion succeeded and silently removed a locked-period entry.
  //   WHY WRONG: those assertions faithfully encoded a real control gap
  //     (server.js's DELETE /api/expenses/:id never checked lockedPeriods
  //     before removing its linked journal entry) — not correct behavior.
  //   NEW ACCOUNTING ASSERTION: the route now calls the shared
  //     assertFinancialPeriodOpen() guard (lib/journalGuard.js) before
  //     mutating anything, so the cascade delete must now be REJECTED
  //     (403) and the locked-period journal entry must still exist
  //     afterward, exactly like the direct journal-delete route.
  test('the cascaded journal-entry deletion is now rejected, matching the direct-delete route', async () => {
    const createRes = await request(app).post('/api/expenses').set(auth()).send({
      date: '2031-05-05', desc: 'Diagnostic-C expense', cat: 'مصاريف عامة', amount: 20, payMethod: 'cash',
    });
    expect(createRes.status).toBe(200);
    const journalId = createRes.body.journalId;

    let expenseId, jeExistsBeforeLock;
    await runAsTenant('default', async () => {
      const db = loadDB();
      expenseId = db.expenses.find(e => e.journalId === journalId).id;
      jeExistsBeforeLock = db.journalEntries.some(j => j.id === journalId);
    });
    expect(jeExistsBeforeLock).toBe(true);

    const lockRes = await request(app).post('/api/period-lock').set(auth()).send({ period: '2031-05', locked: true });
    expect(lockRes.status).toBe(200);

    // Direct journal deletion is correctly blocked by the lock (this is the
    // control that always worked — proves the lock mechanism itself is sound).
    const directDeleteAttempt = await request(app).delete(`/api/journal/${journalId}`).set(auth());
    expect(directDeleteAttempt.status).toBe(403);

    // Deleting the SAME journal entry indirectly, via the expense that owns
    // it, must now be rejected too — server.js's DELETE /api/expenses/:id
    // calls assertFinancialPeriodOpen() before mutating anything.
    const cascadeDelete = await request(app).delete(`/api/expenses/${expenseId}`).set(auth());
    expect(cascadeDelete.status).toBe(403);
    expect(cascadeDelete.body.code).toBe('PERIOD_LOCKED');

    let jeExistsAfterCascade, expenseStillExists;
    await runAsTenant('default', async () => {
      const db = loadDB();
      jeExistsAfterCascade = db.journalEntries.some(j => j.id === journalId);
      expenseStillExists = db.expenses.some(e => e.id === expenseId);
    });
    expect(jeExistsAfterCascade).toBe(true);   // locked-period journal entry survives
    expect(expenseStillExists).toBe(true);     // rejected atomically — the expense record wasn't removed either
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DIAGNOSTIC D / AI A — P6-058: AI agent add_expense now creates a real
// journal entry (fixed in P0.6A)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6 Diagnostic D / AI A — AI agent add_expense creates a journal entry (P6-058, fixed in P0.6A)', () => {
  // P0.6A — Step 16 (P6-058) test-expectation update:
  //   OLD ASSERTION: `expect(journalCountAfter).toBe(journalCountBefore)`
  //     — the expense record was created but NO journal entry ever was.
  //   WHY WRONG: that assertion faithfully encoded a real double-entry
  //     violation (server.js's executePlan() pushed straight to
  //     db.expenses with no appendJournalEntry call at all) — not correct
  //     accounting behavior.
  //   NEW ACCOUNTING ASSERTION: add_expense now calls the same
  //     buildAndPostExpense() service POST /api/expenses uses, so exactly
  //     one new, balanced journal entry must exist afterward, linked to
  //     the created expense via journalId.
  test('AI A: AI agent add_expense creates a balanced journal entry linked to the expense', async () => {
    let journalCountBefore;
    await runAsTenant('default', async () => { journalCountBefore = (loadDB().journalEntries || []).length; });

    const res = await request(app).post('/api/ai/agent/execute').set(auth()).send({
      command: 'diagnostic test — add an expense via the AI agent path',
      plan: { actions: [{ type: 'add_expense', data: { description: 'Diagnostic-D AI expense', amount: 77, category: 'مصاريف عامة', vendor: '' } }] },
    });
    expect(res.status).toBe(200);

    let journalCountAfter, expense, linkedJE;
    await runAsTenant('default', async () => {
      const db = loadDB();
      journalCountAfter = (db.journalEntries || []).length;
      expense = (db.expenses || []).find(e => e.amount === 77);
      linkedJE = expense && (db.journalEntries || []).find(j => j.id === expense.journalId);
    });

    expect(expense).toBeTruthy(); // the expense record was created...
    expect(journalCountAfter).toBe(journalCountBefore + 1); // FIXED: exactly one new journal entry was created for it
    expect(linkedJE).toBeTruthy(); // ...and it's linked via journalId
    const totD = linkedJE.lines.reduce((s,l)=>s+(l.debit||0),0);
    const totC = linkedJE.lines.reduce((s,l)=>s+(l.credit||0),0);
    expect(Math.abs(totD - totC)).toBeLessThan(0.005); // balanced, exactly like a UI-created expense
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DIAGNOSTIC E — P6-040: ENTITY_KEYS persistence allowlist is incomplete
// ═══════════════════════════════════════════════════════════════════════
describe('P0.6 Diagnostic E — critical db.* fields are registered in lib/database.js ENTITY_KEYS (P6-040)', () => {
  // P0.6A — Step 1 (P6-040) test-expectation update:
  //   OLD ASSERTION: `expect(stillMissing).toEqual(criticalMissingKeys)` —
  //     every one of these keys was absent from ENTITY_KEYS.
  //   WHY WRONG: that assertion was faithfully encoding a real production
  //     bug (these keys silently never reached MongoDB, see P6-040), not
  //     correct behavior — it was written deliberately as a "diagnostic of
  //     a known defect" with an explicit note to flip it once fixed.
  //   NEW ACCOUNTING ASSERTION: ENTITY_KEYS now includes all of them (see
  //     lib/database.js) — every key must survive a real MongoDB-mode
  //     restart going forward, so `stillMissing` must be empty.
  test('all production-critical keys now survive a MongoDB-mode restart', () => {
    // These fields are all genuinely read/written by server.js (see
    // ACCOUNTING_GAP_REGISTER.md P6-040/041/042 for exact line-number
    // evidence).
    const criticalKeys = [
      'lockedPeriods',            // IAS 8 period-lock control
      'fixedAssets',              // entire fixed-asset register
      'bankCommittedLineKeys',    // bank-reconciliation duplicate-posting guard
      'bankMatchedLineIds',
      'networkReceivableCleared',
      'patientAR',                // non-insurance patient receivables
      'doctorPayments',           // doctor-payment import history
      'accountingSettings',       // fiscal year / currency / rounding config
      'inventory',                // legacy inventory-opening staging array (P6-042) — kept persisted for backward compat, see normalizeCanonicalKeys()
      'bankRecons',               // legacy manual bank-reconciliation match records (POST /api/bank-recon) — found in the P0.6A verification-pass full repo sweep, not the original 13
    ];
    const stillMissing = criticalKeys.filter(k => !ENTITY_KEYS.includes(k));
    expect(stillMissing).toEqual([]);
  });

  // P0.6A verification pass — Persistence C: a comprehensive repo-wide
  // db.<key> sweep (beyond the original 13 keys) found `bankRecons` (real,
  // reachable, audited bank-reconciliation match records — POST
  // /api/bank-recon) missing from ENTITY_KEYS too. Unlike the "name is in
  // the allowlist" check above, this proves the actual HTTP round-trip: a
  // real record survives being written and re-read through the real route.
  test('Persistence C: a bank-reconciliation match record written via POST /api/bank-recon round-trips through GET /api/bank-recon', async () => {
    const saveRes = await request(app).post('/api/bank-recon').set(auth()).send({
      account: '1110', period: '2034-09',
      bankStatementLines: [{ date: '2034-09-05', desc: 'Persistence C line', amount: 42 }],
      matchedLines: ['JE-PC-1'],
      bankEndBalance: 42, notes: 'Persistence C test record',
    });
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.success).toBe(true);

    const readRes = await request(app).get('/api/bank-recon').set(auth()).query({ account: '1110', period: '2034-09' });
    expect(readRes.status).toBe(200);
    expect(readRes.body.bankEndBalance).toBeCloseTo(42, 3);
    expect(readRes.body.notes).toBe('Persistence C test record');
    expect(readRes.body.matchedLines).toEqual(['JE-PC-1']);

    let stored;
    await runAsTenant('default', async () => {
      stored = (loadDB().bankRecons || []).find(r => r.account === '1110' && r.period === '2034-09');
    });
    expect(stored).toBeTruthy(); // FIXED: this record now also survives inside ENTITY_KEYS, not just the in-process cache
  });
});

// ═══════════════════════════════════════════════════════════════════════
// P0.6A — Step 23/24: remaining named shared tests not already covered
// above (TB A/B, IS A, Lock A/Diagnostic C, AI A/Diagnostic D already exist
// above under their P0.6 diagnostic names). Isolated test data, fresh
// years/months per describe block to avoid cross-test interference within
// this shared-tenant file.
// ═══════════════════════════════════════════════════════════════════════

describe('P0.6A — OB A: opening balance cannot post to a revenue/expense (P&L) account (P6-002)', () => {
  test('OB A: an opening-balance request targeting a revenue account is rejected before any mutation', async () => {
    const res = await request(app).post('/api/opening-balance').set(auth()).send({
      date: '2034-01-01',
      balances: [{ code: '4100', debit: 0, credit: 200 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OPENING_BALANCE_PNL_ACCOUNT');
  });
});

describe('P0.6A — OB B: opening balance is atomic — a rejected request leaves chartOfAccounts/journalEntries unchanged (P6-010)', () => {
  test('OB B: an opening-balance request referencing an unknown account is rejected and commits nothing', async () => {
    let before1100, beforeJeCount;
    await runAsTenant('default', async () => {
      const db = loadDB();
      before1100 = { ...db.chartOfAccounts.find(a => a.code === '1100') };
      beforeJeCount = db.journalEntries.length;
    });

    const res = await request(app).post('/api/opening-balance').set(auth()).send({
      date: '2034-01-05',
      balances: [
        { code: '1100', debit: 999, credit: 0 },
        { code: 'NOPE-9999', debit: 0, credit: 999 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_ACCOUNT');

    let after1100, afterJeCount;
    await runAsTenant('default', async () => {
      const db = loadDB();
      after1100 = { ...db.chartOfAccounts.find(a => a.code === '1100') };
      afterJeCount = db.journalEntries.length;
    });
    // FIXED: the route now validates the candidate journal entry BEFORE
    // zeroing/reapplying openingDebit/openingCredit or replacing the prior
    // opening JE — a rejected posting must leave both completely untouched.
    expect(after1100.openingDebit).toBe(before1100.openingDebit);
    expect(after1100.openingCredit).toBe(before1100.openingCredit);
    expect(afterJeCount).toBe(beforeJeCount);
  });
});

describe('P0.6A — Journal A: PUT /api/journal/:id recomputes totals server-side from the new lines (P6-011)', () => {
  test('Journal A: editing a journal entry\'s lines never trusts stale totalDebit/totalCredit — both are recomputed from the NEW lines', async () => {
    const createRes = await request(app).post('/api/journal').set(auth()).send({
      date: '2034-02-10', desc: 'Journal A original',
      lines: [{ accountCode: '1100', debit: 100, credit: 0 }, { accountCode: '4100', debit: 0, credit: 100 }],
    });
    expect(createRes.status).toBe(200);
    const id = createRes.body.id;

    const editRes = await request(app).put(`/api/journal/${id}`).set(auth()).send({
      lines: [{ accountCode: '1100', debit: 150, credit: 0 }, { accountCode: '4100', debit: 0, credit: 150 }],
    });
    expect(editRes.status).toBe(200);

    let stored;
    await runAsTenant('default', async () => { stored = loadDB().journalEntries.find(e => e.id === id); });
    expect(stored.totalDebit).toBeCloseTo(150, 3);  // FIXED: was still 100 (stale) before P0.6A
    expect(stored.totalCredit).toBeCloseTo(150, 3);
  });
});

describe('P0.6A — Lock B: POST /api/bank/reconcile-undo-all rejects the WHOLE undo if any affected period is locked, all-or-nothing (P6-013)', () => {
  test('Lock B: one BRECON entry in a locked period blocks removal of ALL BRECON entries, including ones in still-open periods', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.journalEntries.push(
        { id: 'JE-BRC-LOCK', date: '2034-03-10', desc: 'Lock B locked-period recon', ref: 'BRECON', reference: 'BRECON', type: 'bank-settlement', totalDebit: 10, totalCredit: 10, lines: [{ accountCode: '1110', debit: 10, credit: 0 }, { accountCode: '4100', debit: 0, credit: 10 }] },
        { id: 'JE-BRC-OPEN', date: '2034-04-10', desc: 'Lock B open-period recon',   ref: 'BRECON', reference: 'BRECON', type: 'bank-settlement', totalDebit: 5,  totalCredit: 5,  lines: [{ accountCode: '1110', debit: 5,  credit: 0 }, { accountCode: '4100', debit: 0, credit: 5  }] },
      );
      saveDB(db);
    });

    const lockRes = await request(app).post('/api/period-lock').set(auth()).send({ period: '2034-03', locked: true });
    expect(lockRes.status).toBe(200);

    const undoRes = await request(app).post('/api/bank/reconcile-undo-all').set(auth());
    expect(undoRes.status).toBe(403); // FIXED: previously had no lock check at all
    expect(undoRes.body.code).toBe('PERIOD_LOCKED');

    let stillHasLocked, stillHasOpen;
    await runAsTenant('default', async () => {
      const db = loadDB();
      stillHasLocked = db.journalEntries.some(j => j.id === 'JE-BRC-LOCK');
      stillHasOpen   = db.journalEntries.some(j => j.id === 'JE-BRC-OPEN');
    });
    expect(stillHasLocked).toBe(true); // whole undo rejected...
    expect(stillHasOpen).toBe(true);   // ...so the open-period entry survives too — no partial undo
  });
});

describe('P0.6A — Persistence A/B: normalizeCanonicalKeys() preserves canonical state across a restart (Step 2)', () => {
  test('Persistence A: legacy db.assets is forward-copied into canonical db.fixedAssets, non-destructively and idempotently', () => {
    const db = { assets: [{ id: 'AST-1', name: 'Restart Asset', cost: 500 }], fixedAssets: [] };
    normalizeCanonicalKeys(db);
    expect(db.fixedAssets.length).toBe(1);
    expect(db.fixedAssets[0].name).toBe('Restart Asset');
    expect(db.assets.length).toBe(1); // legacy key left untouched, not deleted

    normalizeCanonicalKeys(db); // idempotent — a second "restart" must not duplicate
    expect(db.fixedAssets.length).toBe(1);
  });

  test('Persistence B: legacy db.inventory items are forward-merged into canonical db.invItems with field renaming, non-destructively and idempotently', () => {
    const db = {
      inventory: [{ id: 'INV-1', name: 'Restart Item', costPerUnit: 12, minQuantity: 3, quantity: 10 }],
      invItems: [],
    };
    normalizeCanonicalKeys(db);
    expect(db.invItems.length).toBe(1);
    expect(db.invItems[0].name).toBe('Restart Item');
    expect(db.invItems[0].unitCost).toBe(12); // costPerUnit -> unitCost
    expect(db.invItems[0].minQty).toBe(3);    // minQuantity -> minQty
    expect(db.inventory.length).toBe(1);      // legacy key left untouched

    normalizeCanonicalKeys(db); // idempotent — a second "restart" must not duplicate the already-merged item
    expect(db.invItems.length).toBe(1);
  });
});

describe('P0.6A — IS B: /api/financial-statements excludes closing-transfer entries from operational P&L (P6-043)', () => {
  test('IS B: an open month, a just-closed month, and a multi-month range containing the closed month all show real revenue/expense — never zeroed by the closing transfer', async () => {
    await request(app).post('/api/journal').set(auth()).send({
      date: '2033-05-05', desc: 'IS B revenue',
      lines: [{ accountCode: '1100', debit: 700, credit: 0 }, { accountCode: '4100', debit: 0, credit: 700 }],
    }).expect(200);
    await request(app).post('/api/journal').set(auth()).send({
      date: '2033-05-12', desc: 'IS B expense',
      lines: [{ accountCode: '5100', debit: 250, credit: 0 }, { accountCode: '1100', debit: 0, credit: 250 }],
    }).expect(200);

    const beforeClose = await request(app).get('/api/financial-statements?period=month&year=2033&month=5').set(auth());
    expect(beforeClose.status).toBe(200);
    expect(beforeClose.body.incomeStatement.revenue.total).toBeCloseTo(700, 3);
    expect(beforeClose.body.incomeStatement.operatingExpenses.total).toBeCloseTo(250, 3);
    expect(beforeClose.body.incomeStatement.netProfit).toBeCloseTo(450, 3);

    const closeRes = await request(app).post('/api/close/run-all').set(auth()).send({
      month: '2033-05', options: { depreciation: false, pifss: false, eos: false, closing: true, lock: false },
    });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.log.find(s => s.id === 'closing').status).toBe('done');

    const afterClose = await request(app).get('/api/financial-statements?period=month&year=2033&month=5').set(auth());
    // FIXED: the closing transfer entry (dated within the same month) used
    // to net revenue/expense to zero for any query including it.
    expect(afterClose.body.incomeStatement.revenue.total).toBeCloseTo(700, 3);
    expect(afterClose.body.incomeStatement.operatingExpenses.total).toBeCloseTo(250, 3);
    expect(afterClose.body.incomeStatement.netProfit).toBeCloseTo(450, 3);

    const yearRange = await request(app).get('/api/financial-statements?period=year&year=2033').set(auth());
    expect(yearRange.status).toBe(200);
    expect(yearRange.body.incomeStatement.revenue.total).toBeCloseTo(700, 3);
    expect(yearRange.body.incomeStatement.netProfit).toBeCloseTo(450, 3);
  });
});

describe('P0.6A — BS A: /api/financial-statements Balance Sheet only reflects transactions up to the requested as-of date (P6-052)', () => {
  test('BS A: a transaction dated AFTER the requested period must not appear in that period\'s Balance Sheet, but does appear once its own period is requested', async () => {
    const mayBefore = await request(app).get('/api/financial-statements?period=month&year=2032&month=5').set(auth());
    expect(mayBefore.status).toBe(200);
    const cashBeforeMay = mayBefore.body.balanceSheet.assets.current.cash;

    await request(app).post('/api/journal').set(auth()).send({
      date: '2032-06-15', desc: 'BS A future-dated transaction',
      lines: [{ accountCode: '1100', debit: 500, credit: 0 }, { accountCode: '4100', debit: 0, credit: 500 }],
    }).expect(200);

    const mayAfter = await request(app).get('/api/financial-statements?period=month&year=2032&month=5').set(auth());
    // FIXED: previously summed EVERY journal entry ever posted regardless of date.
    expect(mayAfter.body.balanceSheet.assets.current.cash).toBeCloseTo(cashBeforeMay, 3);

    const juneRes = await request(app).get('/api/financial-statements?period=month&year=2032&month=6').set(auth());
    expect(juneRes.body.balanceSheet.assets.current.cash).toBeCloseTo(cashBeforeMay + 500, 3);
  });
});

describe('P0.6A — BS B: /api/financial-statements Balance Sheet detail sections reconcile to their own stated totals (P6-053)', () => {
  // NOTE on test design (recorded per this milestone's "explain why the
  // previous expectation was accounting-wise incorrect" rule): the first
  // version of this test asserted `bs.assets.total === bs.totalLiabAndEquity`
  // (the fundamental accounting equation) using ABSOLUTE values. That failed
  // — not because P6-053 regressed, but because the assertion itself was
  // wrong for this shared-tenant test file: /api/financial-statements'
  // Balance Sheet is intentionally ALL-TIME-cumulative (buildBalanceMap(db,
  // null, asOfDate) — no lower date bound, per P6-052's own point-in-time
  // fix), so by the time this test runs it also reflects every other
  // describe block's postings in this file, including IS B's month-close
  // closing entry, which credits account 3300 — an equity account this
  // route's totalEquity calculation never reads (it only reads 3100/3200
  // explicitly). That gap is real but pre-existing and out of P0.6A's 20
  // targeted findings (not P6-052/053/054 — those are about date filtering,
  // a response's detail reconciling to ITS OWN stated total, and cash-flow
  // reconciliation, not a global cross-account-type equity sweep), so it is
  // flagged for a future milestone rather than fixed here (see final report).
  // The CORRECT, isolation-proof way to verify "the balance sheet honestly
  // reflects double-entry postings" in a shared/cumulative ledger is a DELTA
  // check: post a self-balanced pair of entries and confirm both sides of
  // the accounting equation move by the identical amount — true regardless
  // of whatever pre-existing history/imbalance the shared ledger carries.
  test('BS B: current-assets detail sums to its total, total assets sums to its own breakdown, and a self-balanced posting moves both sides of the accounting equation by the same amount', async () => {
    const before = await request(app).get('/api/financial-statements?period=month&year=2035&month=3').set(auth());
    expect(before.status).toBe(200);
    const bsBefore = before.body.balanceSheet;

    await request(app).post('/api/journal').set(auth()).send({
      date: '2035-03-05', desc: 'BS B revenue',
      lines: [{ accountCode: '1100', debit: 800, credit: 0 }, { accountCode: '4100', debit: 0, credit: 800 }],
    }).expect(200);
    await request(app).post('/api/journal').set(auth()).send({
      date: '2035-03-10', desc: 'BS B expense',
      lines: [{ accountCode: '5100', debit: 200, credit: 0 }, { accountCode: '1100', debit: 0, credit: 200 }],
    }).expect(200);

    const res = await request(app).get('/api/financial-statements?period=month&year=2035&month=3').set(auth());
    expect(res.status).toBe(200);
    const bs = res.body.balanceSheet;

    const currentSum = bs.assets.current.cash + bs.assets.current.bank + bs.assets.current.insuranceReceivable
      + bs.assets.current.patientReceivable + bs.assets.current.otherReceivable + bs.assets.current.inventory;
    expect(currentSum).toBeCloseTo(bs.assets.current.total, 3);

    const assetsSum = bs.assets.current.total + bs.assets.fixed.net + bs.assets.otherNonCurrent;
    expect(assetsSum).toBeCloseTo(bs.assets.total, 3); // FIXED: totalAssets is now DERIVED from this exact breakdown

    expect(bs.totalLiabAndEquity).toBeCloseTo(bs.liabilities.total + bs.equity.total, 3);

    // Net effect of the two postings above: cash +600 (800 in, 200 out);
    // period net income +600 (800 revenue - 200 expense), no liability
    // account touched — so assets and totalLiabAndEquity must move by the
    // SAME amount, regardless of whatever absolute value either side
    // already carried from other tests in this shared ledger.
    const assetsDelta = bs.assets.total - bsBefore.assets.total;
    const liabEquityDelta = bs.totalLiabAndEquity - bsBefore.totalLiabAndEquity;
    expect(assetsDelta).toBeCloseTo(600, 3);
    expect(liabEquityDelta).toBeCloseTo(600, 3);
    expect(assetsDelta).toBeCloseTo(liabEquityDelta, 3);
  });
});

describe('P0.6A — CF A: /api/financial-statements Cash Flow reconciles to the actual ledger movement in cash accounts (P6-054)', () => {
  test('CF A: the indirect-method net change in cash matches the real debit/credit movement independently reconstructed from the ledger', async () => {
    await request(app).post('/api/journal').set(auth()).send({
      date: '2036-04-05', desc: 'CF A cash revenue',
      lines: [{ accountCode: '1100', debit: 500, credit: 0 }, { accountCode: '4100', debit: 0, credit: 500 }],
    }).expect(200);
    await request(app).post('/api/journal').set(auth()).send({
      date: '2036-04-10', desc: 'CF A revenue on patient account (non-cash)',
      lines: [{ accountCode: '1200', debit: 300, credit: 0 }, { accountCode: '4100', debit: 0, credit: 300 }],
    }).expect(200); // FIXED: 1200 used to be omitted from the working-capital adjustment (P6-054)
    await request(app).post('/api/journal').set(auth()).send({
      date: '2036-04-15', desc: 'CF A cash expense',
      lines: [{ accountCode: '5100', debit: 150, credit: 0 }, { accountCode: '1100', debit: 0, credit: 150 }],
    }).expect(200);

    let actualCashMovement;
    await runAsTenant('default', async () => {
      const db = loadDB();
      let dr = 0, cr = 0;
      db.journalEntries.filter(je => (je.date || '').startsWith('2036-04')).forEach(je => {
        (je.lines || []).forEach(l => {
          const code = String(l.accountCode || l.account || '');
          if (code === '1100' || code === '1110') { dr += parseFloat(l.debit) || 0; cr += parseFloat(l.credit) || 0; }
        });
      });
      actualCashMovement = parseFloat((dr - cr).toFixed(3));
    });

    const res = await request(app).get('/api/financial-statements?period=month&year=2036&month=4').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.cashFlow.netChange).toBeCloseTo(actualCashMovement, 3);
  });
});

describe('P0.6A — AI B: AI agent add_daily follows the same accounting workflow as manual daily-income creation (P6-059)', () => {
  test('AI B: add_daily creates a balanced revenue journal entry via the same buildAndPostManualIncome() service the manual-entry route uses', async () => {
    let journalCountBefore;
    await runAsTenant('default', async () => { journalCountBefore = (loadDB().journalEntries || []).length; });

    const res = await request(app).post('/api/ai/agent/execute').set(auth()).send({
      command: 'AI B — add a daily income entry via the AI agent path',
      plan: { actions: [{ type: 'add_daily', data: { date: '2034-08-01', cash: 60, knet: 40 } }] },
    });
    expect(res.status).toBe(200);

    let journalCountAfter, dailyEntry, linkedJE;
    await runAsTenant('default', async () => {
      const db = loadDB();
      journalCountAfter = (db.journalEntries || []).length;
      dailyEntry = (db.dailyData || []).find(d => d.date === '2034-08-01' && d.total === 100);
      linkedJE = (db.journalEntries || []).find(j => j.ref === 'MAN' && j.date === '2034-08-01');
    });

    expect(dailyEntry).toBeTruthy(); // the daily-income record was created...
    expect(journalCountAfter).toBe(journalCountBefore + 1); // FIXED: exactly one new journal entry, was previously zero
    expect(linkedJE).toBeTruthy();
    const totD = linkedJE.lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totC = linkedJE.lines.reduce((s, l) => s + (l.credit || 0), 0);
    expect(Math.abs(totD - totC)).toBeLessThan(0.005); // balanced, exactly like a manually-entered daily income
  });
});

describe('P0.6A — Telegram A: Telegram /expense uses the exact same accounting posting path as UI/API expense creation (P6-060)', () => {
  test('Telegram A: a Telegram-originated expense produces a balanced journal entry with the same accounting shape as an API-originated expense for equivalent inputs', async () => {
    const TelegramBotMock = require('node-telegram-bot-api');
    TelegramBotMock.mockClear();

    const startRes = await request(app).post('/api/telegram/start').set(auth()).send({ token: 'fake-test-token-telegram-a' });
    expect(startRes.status).toBe(200);

    const botInstance = TelegramBotMock.mock.results[TelegramBotMock.mock.results.length - 1].value;
    const messageHandler = botInstance.on.mock.calls.find(c => c[0] === 'message')[1];
    expect(messageHandler).toBeInstanceOf(Function);

    const chatId = 999777111;
    // First message from a brand-new chat only auto-registers it (the
    // bootstrap window) — it does not process a command yet, matching real
    // production behavior exactly (see server.js setupBot()).
    await messageHandler({ chat: { id: chatId }, text: '/start' });
    // Second message is now from an authorized chat and reaches the real
    // /expense command handling — the exact code path this test targets.
    await messageHandler({ chat: { id: chatId }, text: '/expense 88 Telegram-A-test' });

    let telegramExpense, telegramJE;
    await runAsTenant('default', async () => {
      const db = loadDB();
      telegramExpense = (db.expenses || []).find(e => e.amount === 88 && e.desc === 'Telegram-A-test');
      telegramJE = telegramExpense && (db.journalEntries || []).find(j => j.id === telegramExpense.journalId);
    });
    expect(telegramExpense).toBeTruthy(); // FIXED: previously db.expenses.push() with NO journal entry at all
    expect(telegramJE).toBeTruthy();
    const tTotD = telegramJE.lines.reduce((s, l) => s + (l.debit || 0), 0);
    const tTotC = telegramJE.lines.reduce((s, l) => s + (l.credit || 0), 0);
    expect(Math.abs(tTotD - tTotC)).toBeLessThan(0.005);

    // Same accounting inputs via the normal UI/API path — must produce the
    // SAME accounting shape (same accounts touched, same line count),
    // proving both entry points now share one accounting consequence.
    const apiRes = await request(app).post('/api/expenses').set(auth()).send({
      date: new Date().toISOString().split('T')[0], desc: 'API-equivalent-test', cat: 'أخرى', amount: 88, payMethod: 'cash',
    });
    expect(apiRes.status).toBe(200);
    let apiJE;
    await runAsTenant('default', async () => {
      apiJE = (loadDB().journalEntries || []).find(j => j.id === apiRes.body.journalId);
    });
    expect(apiJE.lines.length).toBe(telegramJE.lines.length);
    const telegramAccts = telegramJE.lines.map(l => l.accountCode).sort().join(',');
    const apiAccts      = apiJE.lines.map(l => l.accountCode).sort().join(',');
    expect(telegramAccts).toBe(apiAccts);
  });
});

describe('P0.6A — Vendor A: vendor-generated account codes never collide, and account 2200 is never overwritten (P6-003)', () => {
  test('Vendor A: 15 sequentially-created vendors all receive unique account codes', async () => {
    const codes = [];
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post('/api/vendors').set(auth()).send({ name: `Vendor-A-${i}`, phone: '000' });
      expect(res.status).toBe(200);
      codes.push(res.body.vendor.accountId);
    }
    expect(new Set(codes).size).toBe(15); // no duplicates — FIXED: the old maxCode+1 scan collided once 2100's direct slots were exhausted
    expect(codes.includes('2200')).toBe(false);

    let acc2200, vendorAccounts;
    await runAsTenant('default', async () => {
      const db = loadDB();
      acc2200 = db.chartOfAccounts.find(a => a.code === '2200');
      vendorAccounts = db.chartOfAccounts.filter(a => codes.includes(a.code));
    });
    expect(acc2200.name).toBe('الرواتب المستحقة الدفع'); // untouched — still the real payroll-payable account
    expect(vendorAccounts.length).toBe(15); // every generated code resolved to its own distinct COA entry
  });
});

describe('P0.6A — Doctor A/B/C: commission recalculation safety and performance-report correctness (P6-031/032/033)', () => {
  beforeAll(async () => {
    const res = await request(app).post('/api/doctors').set(auth()).send({
      doctors: [
        { name: 'Dr-Paid-A',   target: 0, commission: 10, lab: 0, insurance: 0 },
        { name: 'Dr-Unpaid-B', target: 0, commission: 20, lab: 0, insurance: 0 },
      ],
    });
    expect(res.status).toBe(200);
  });

  test('Doctor A: a commission record already marked paid is never overwritten by a later recalculation, even if new revenue data arrives for that month', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.paymentsData.push({ id: 'PAY-DRA-1', doctor: 'Dr-Paid-A', date: '2034-06-15', total: 1000 });
      saveDB(db);
    });

    const firstRecalc = await request(app).post('/api/config/recalc-commissions').set(auth());
    expect(firstRecalc.status).toBe(200);

    let commRecord;
    await runAsTenant('default', async () => {
      const db = loadDB();
      commRecord = db.commissionHistory.find(c => c.doctor === 'Dr-Paid-A' && c.month === '2034-06');
      expect(commRecord.commission).toBeCloseTo(100, 3); // 10% of 1000
      commRecord.paid = true; // simulate the commission actually having been paid out
      saveDB(db);
    });

    // New revenue arrives for the SAME already-paid month.
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.paymentsData.push({ id: 'PAY-DRA-2', doctor: 'Dr-Paid-A', date: '2034-06-20', total: 500 });
      saveDB(db);
    });

    const secondRecalc = await request(app).post('/api/config/recalc-commissions').set(auth());
    expect(secondRecalc.status).toBe(200);
    expect(secondRecalc.body.skippedPaid).toBeGreaterThanOrEqual(1); // FIXED: previously no such guard existed

    let commAfter;
    await runAsTenant('default', async () => {
      commAfter = loadDB().commissionHistory.find(c => c.doctor === 'Dr-Paid-A' && c.month === '2034-06');
    });
    expect(commAfter.commission).toBeCloseTo(100, 3); // unchanged — the paid record was never touched
    expect(commAfter.revenue).toBeCloseTo(1000, 3);   // unchanged — new 500 revenue was NOT folded in
  });

  test('Doctor B: an unpaid commission recalculates using the real revenue source (paymentsData), never a zero/empty source', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.paymentsData.push({ id: 'PAY-DRB-1', doctor: 'Dr-Unpaid-B', date: '2034-07-10', total: 800 });
      saveDB(db);
    });

    const res = await request(app).post('/api/config/recalc-commissions').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.created + res.body.updated).toBeGreaterThanOrEqual(1);

    let commRecord;
    await runAsTenant('default', async () => {
      commRecord = loadDB().commissionHistory.find(c => c.doctor === 'Dr-Unpaid-B' && c.month === '2034-07');
    });
    expect(commRecord).toBeTruthy();
    // FIXED (P6-032): the paymentsData accumulation line (`groups[k].revenue += p.total`)
    // was missing, so revenue/commission were always silently zero before P0.6A.
    expect(commRecord.revenue).toBeCloseTo(800, 3);
    expect(commRecord.commission).toBeCloseTo(160, 3); // 20% of 800
  });

  test('Doctor C: the doctor performance report returns real, non-zero revenue/session figures for seeded data', async () => {
    const res = await request(app).get('/api/reports/doctor-performance?from=2034-07-01&to=2034-07-31').set(auth());
    expect(res.status).toBe(200);
    const drB = res.body.doctors.find(d => d.name === 'Dr-Unpaid-B');
    expect(drB).toBeTruthy();
    // FIXED (P6-033): the report used to read db.dailyData (which never
    // carries a `.doctor` field) instead of db.paymentsData, so every
    // doctor's revenue/sessions were systematically zero.
    expect(drB.revenue).toBeCloseTo(800, 3);
    expect(drB.sessions).toBeGreaterThanOrEqual(1);
    expect(drB.avgPerSession).toBeGreaterThan(0);
  });
});

describe('P0.6A — Close A: month-close success is acknowledged only after durable persistence actually completes (P6-066)', () => {
  test('Close A: a forced durable-persistence failure on /api/close/run-all returns a real error, never a false success', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Same technique tests/production-hardening-p05a.test.js's Durability B
      // uses: replace the destination directory with a plain FILE so the
      // durable write's fs.ensureDirSync() throws before anything is written.
      fs.removeSync(tmp);
      fs.writeFileSync(tmp, 'not-a-directory-anymore');
      try {
        const res = await request(app).post('/api/close/run-all').set(auth()).send({ month: '2037-01', options: { confirmEmptyClose: true } });
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
      } finally {
        fs.removeSync(tmp);
        fs.ensureDirSync(tmp);
      }
    } finally {
      errSpy.mockRestore();
    }
  });
});
