// P0.12 — Financial Idempotency & Retry-Safety Closure.
// Part E (Mongo-backend atomic claim mechanism) — the milestone's own
// explicit requirement: "Mongo backend needs a real uniqueness guarantee,
// not find-then-insert." Proven here against a REAL, isolated, disposable
// mongod (mongodb-memory-server — never a shared/remote/production
// instance; see tests/helpers/mongoTestHarness.js) by firing genuinely
// concurrent claim attempts and checking MongoDB's own E11000 duplicate-key
// rejection is what resolves the race, not a same-process in-memory check.
//
// Boilerplate mirrors tests/p0-11-backend-parity.test.js exactly (same
// initDB()/mongoTestHarness pattern this program has used throughout).

process.env.DB_FILE_ONLY = 'true'; // flipped to false only inside initDB() below, same pattern as P0.11
process.env.JWT_SECRET   = 'p0-12-idempotency-mongo-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p12-idem-mongo-boot-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, isFileFallbackMode, loadDB } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');
const { startIsolatedMongo } = require('./helpers/mongoTestHarness');
const {
  IdempotencyConflictError,
  computeFingerprint,
  claimIdempotencyKeyMongo,
  completeIdempotencyClaim,
  finalizeIdempotencyClaimMongo,
} = require('../lib/idempotency');

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

describe('P0.12 Part E — real isolated Mongo backend: atomic claim concurrency', () => {
  let mongoInstance;
  let adminToken;

  beforeAll(async () => {
    mongoInstance = await startIsolatedMongo('p012-idem-mongo');
    process.env.DB_FILE_ONLY = 'false';
    try {
      await initDB({
        mongoUri: mongoInstance.uri,
        dataFile: process.env.DATA_FILE,
        configFile: process.env.CONFIG_FILE,
        defaultConfig: {},
        buildInitialDB,
        migrateDB: () => false,
      });
    } finally {
      process.env.DB_FILE_ONLY = 'true';
    }
    expect(isFileFallbackMode()).toBe(false); // genuinely Mongo-backed, not a silent fallback

    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
    expect(login.status).toBe(200);
    adminToken = login.body.token;
  }, 120000);

  afterAll(async () => {
    try { await shutdownDB(); } catch {}
    if (mongoInstance) { try { await mongoInstance.stop(); } catch {} }
    try { fs.removeSync(tmp); } catch {}
  });

  test('Mongo Race A: N genuinely concurrent claim attempts for the IDENTICAL (tenant, scope, key, fingerprint) resolve to exactly ONE claimed:true — every other attempt is rejected as IDEMPOTENCY_IN_PROGRESS (the winner has not completed yet, so there is no COMPLETED result to replay — this exactly mirrors file-mode Claim B semantics)', async () => {
    const N = 12;
    const fp = computeFingerprint('journal:create', { amount: 999, desc: 'race-a' });
    const attempts = Array.from({ length: N }, () =>
      claimIdempotencyKeyMongo('default', 'journal:create', 'MONGO-RACE-A', fp)
    );
    const settled = await Promise.allSettled(attempts);

    const fulfilled = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
    const rejected  = settled.filter(s => s.status === 'rejected');

    expect(fulfilled.filter(r => r.claimed === true)).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);
    rejected.forEach(r => {
      expect(r.reason).toBeInstanceOf(IdempotencyConflictError);
      expect(r.reason.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    });
  }, 30000);

  test('Mongo Race B: N concurrent claim attempts for the SAME key but each with a DIFFERENT fingerprint — exactly ONE inserts, every other attempt is rejected as IDEMPOTENCY_KEY_REUSED (never silently treated as a replay of a different transaction)', async () => {
    const N = 8;
    const attempts = Array.from({ length: N }, (_, i) =>
      claimIdempotencyKeyMongo('default', 'journal:create', 'MONGO-RACE-B', computeFingerprint('journal:create', { amount: i, desc: 'race-b-' + i }))
    );
    const settled = await Promise.allSettled(attempts);

    const fulfilled = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
    const rejected  = settled.filter(s => s.status === 'rejected');

    expect(fulfilled.filter(r => r.claimed === true)).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);
    rejected.forEach(r => {
      expect(r.reason).toBeInstanceOf(IdempotencyConflictError);
      expect(r.reason.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  }, 30000);

  test('Mongo Persist A: completing a Mongo claim (in-memory + finalize) updates BOTH the dedicated IdempotencyRecord collection AND stays readable via the uniform db.idempotencyRecords[] read path after a reload', async () => {
    const fp = computeFingerprint('vendor-bill:create', { vendorId: 'V1', amount: 500 });
    const claim = await claimIdempotencyKeyMongo('default', 'vendor-bill:create', 'MONGO-PERSIST-A', fp);
    expect(claim.claimed).toBe(true);

    const db = loadDB();
    // P0.12 adversarial-review fix: completeIdempotencyClaim is now
    // in-memory only (step 3 of the write-order contract); the dedicated
    // Mongo write is finalizeIdempotencyClaimMongo, called only AFTER the
    // caller's own durable save — here simulated directly since this test
    // exercises the lib functions, not a full HTTP route.
    completeIdempotencyClaim(db, true, claim.record, { billId: 'BILL-1' }, 'BILL-1', 'JE-1');
    await finalizeIdempotencyClaimMongo(claim.record);

    // A fresh claim attempt (same key+fingerprint) after completion must see
    // COMPLETED and refuse to claim again — proves the Mongo-side update
    // (not just the in-memory db.idempotencyRecords array) actually landed.
    const replay = await claimIdempotencyKeyMongo('default', 'vendor-bill:create', 'MONGO-PERSIST-A', fp);
    expect(replay.claimed).toBe(false);
    expect(replay.record.status).toBe('COMPLETED');
    expect(replay.record.resultReference).toEqual({ billId: 'BILL-1' });
  });

  test('Mongo Persist B (adversarial-review fix, crash-safety proof): if finalizeIdempotencyClaimMongo is never reached (simulating a crash between the durable save and the finalize step), the dedicated collection still shows PROCESSING, never a false COMPLETED — so a later retry correctly re-attempts instead of replaying a phantom result', async () => {
    const fp = computeFingerprint('vendor-bill:create', { vendorId: 'V2', amount: 700 });
    const claim = await claimIdempotencyKeyMongo('default', 'vendor-bill:create', 'MONGO-PERSIST-B', fp);
    expect(claim.claimed).toBe(true);

    const db = loadDB();
    // Mark COMPLETED in-memory (step 3) — simulate the process crashing
    // BEFORE finalizeIdempotencyClaimMongo (step 5) ever runs. Before the
    // P0.12 adversarial-review fix, completeIdempotencyClaim() itself would
    // have already durably written COMPLETED to the dedicated collection at
    // this point — that write no longer happens here.
    completeIdempotencyClaim(db, true, claim.record, { billId: 'BILL-2' }, 'BILL-2', 'JE-2');

    // Query the dedicated collection directly — the actual source
    // claimIdempotencyKeyMongo reads from — it must still show PROCESSING,
    // proving no premature durable write occurred. (Going through
    // claimIdempotencyKeyMongo() itself here would throw IDEMPOTENCY_IN_
    // PROGRESS for a live, non-abandoned PROCESSING record — a DIFFERENT,
    // already-covered behavior; this test targets the durable-write timing
    // specifically, so it inspects the record directly.)
    const IdempotencyRecord = require('../models/IdempotencyRecord');
    const doc = await IdempotencyRecord.findOne({ tenantId: 'default', operationScope: 'vendor-bill:create', key: 'MONGO-PERSIST-B' }).lean();
    expect(doc.status).toBe('PROCESSING');
    expect(doc.resultReference).toBeNull();
  });

  test('Mongo E2E A: two genuinely concurrent HTTP retries of the SAME journal-create request (identical Idempotency-Key header) never produce two journal entries — at most one financial effect, end to end, over a real Mongo connection', async () => {
    const before = (loadDB().journalEntries || []).length;
    const idemKey = 'E2E-MONGO-JOURNAL-RACE-0001';
    const payload = {
      date: '2057-02-01', desc: 'P0.12 Mongo E2E race journal', lines: [
        { accountCode: '1100', debit: 444, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 444 },
      ],
    };

    const [r1, r2] = await Promise.all([
      request(app).post('/api/journal').set(auth(adminToken)).set('Idempotency-Key', idemKey).send(payload),
      request(app).post('/api/journal').set(auth(adminToken)).set('Idempotency-Key', idemKey).send(payload),
    ]);

    // Both requests must succeed at the HTTP layer in SOME acceptable shape:
    // 200 (either the real post or a clean idempotent replay) or 409
    // (IDEMPOTENCY_IN_PROGRESS, if the loser's claim attempt raced in before
    // the winner finished) — never a silent duplicate 200 with two distinct
    // journal ids.
    [r1, r2].forEach(r => expect([200, 409]).toContain(r.status));

    const after = (loadDB().journalEntries || []).filter(je => je.desc === payload.desc);
    expect(after).toHaveLength(1); // exactly one real financial effect, not zero, not two
    expect(after.length - 0).toBeLessThanOrEqual(1);
    expect((loadDB().journalEntries || []).length).toBe(before + 1);
  }, 30000);

  test('Mongo E2E B (adversarial-review fix, Concurrency persona finding — CONFIRMED): two genuinely concurrent vendor-bill payment requests with DIFFERENT Idempotency-Keys, each for the full outstanding amount, never both succeed — the overpayment guard holds under real Mongo-mode concurrency, not just sequentially', async () => {
    const vendorRes = await request(app).post('/api/vendors').set(auth(adminToken)).send({ name: 'P0.12 Mongo E2E B Vendor', type: 'supplier' });
    expect(vendorRes.status).toBe(200);
    const vendorId = vendorRes.body.vendor.id;

    const billRes = await request(app).post('/api/vendor-bills').set(auth(adminToken)).send({
      vendorId, billDate: '2057-03-01', description: 'P0.12 Mongo E2E B bill',
      allocations: [{ accountCode: '5200', amount: 100 }],
    });
    expect(billRes.status).toBe(200);
    const billId = billRes.body.bill.id;

    const payPayload = { amount: 100, payDate: '2057-03-02', payAccount: '1100' };
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth(adminToken)).set('Idempotency-Key', 'E2E-MONGO-BILLPAY-RACE-KEY-A').send(payPayload),
      request(app).post(`/api/vendor-bills/${billId}/pay`).set(auth(adminToken)).set('Idempotency-Key', 'E2E-MONGO-BILLPAY-RACE-KEY-B').send(payPayload),
    ]);

    // Before the fix: both could read outstandingAmount=100 before either
    // mutated (the Mongo claim await is a real yield point), both pass the
    // overpayment check, both post — 200 KWD paid against a 100 KWD bill.
    // After the fix (claim taken before the check): at most one succeeds;
    // the other must be rejected by the SAME pre-existing OVERPAYMENT
    // business-rule check, now correctly seeing the post-mutation balance.
    const succeeded = [r1, r2].filter(r => r.status === 200 && !r.body.idempotentReplay);
    const rejected  = [r1, r2].filter(r => r.status === 400 && r.body.code === 'OVERPAYMENT');
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const bill = (loadDB().vendorBills || []).find(b => b.id === billId);
    expect(bill.payments).toHaveLength(1);
    expect(bill.paidAmount).toBeCloseTo(100, 3);
    expect(bill.outstandingAmount).toBeCloseTo(0, 3);
  }, 30000);
});
