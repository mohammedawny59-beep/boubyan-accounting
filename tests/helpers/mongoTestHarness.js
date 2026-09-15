// P0.11 — isolated, disposable MongoDB test harness.
//
// Uses mongodb-memory-server: spawns a REAL mongod binary (downloaded once,
// cached locally) bound to a random localhost port with its own fresh,
// throwaway data directory. This is NOT a connection to any shared/remote
// Mongo instance — there is no production URI, no production credential,
// and no way for this harness to reach a real database even by mistake,
// because each instance IS its own brand-new, empty, disposable server
// process. The explicit test-marker naming/assertion below is still
// enforced as defense-in-depth (required by the P0.11 milestone spec, Part
// C Step 9) even though the isolation is already structural.
'use strict';

const TEST_DB_MARKER = /_test_/;
// Deliberately NOT \b-bounded: \b does not fire at underscore boundaries
// (underscore is a \w character), so "boubyan_production_test_x" would
// slip past a word-boundary-anchored pattern entirely. A plain substring
// match catches "production"/"prod" wherever it appears in the name.
const PROD_LIKE = /prod(uction)?/i;

function randomTestDbName(label) {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const safeLabel = String(label || 'p011').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return `boubyan_accounting_${safeLabel}_test_${rand}`;
}

// Required safety gate (P0.11 Part C Step 9): refuse to treat ANY database
// name as safe-to-drop unless it unmistakably carries the test marker and
// does not look production-like. Called before every destructive action in
// this harness, not just once at creation time.
function assertSafeTestDbName(dbName) {
  if (typeof dbName !== 'string' || dbName.length === 0) {
    throw new Error('REFUSED: no database name provided — cannot verify test-safety.');
  }
  if (PROD_LIKE.test(dbName)) {
    throw new Error(`REFUSED: database name "${dbName}" looks production-like — refusing regardless of test marker.`);
  }
  if (!TEST_DB_MARKER.test(dbName)) {
    throw new Error(`REFUSED: database name "${dbName}" does not contain the required "_test_" marker — refusing to treat as a safe, droppable test database.`);
  }
  return true;
}

/**
 * Starts a fresh, isolated, disposable MongoDB instance for a single test
 * file. Returns { uri, dbName, mongod, stop() }.
 */
async function startIsolatedMongo(label) {
  // Lazy require — keeps this dependency out of any code path that isn't
  // actually running a Mongo-backed test.
  const { MongoMemoryServer } = require('mongodb-memory-server');

  const dbName = randomTestDbName(label);
  assertSafeTestDbName(dbName);

  const mongod = await MongoMemoryServer.create({ instance: { dbName } });
  const uri = `${mongod.getUri()}${dbName}`;

  return {
    uri,
    dbName,
    mongod,
    async stop() {
      // Re-assert immediately before the destructive step, not just at
      // creation — this is the actual guard the milestone's own safety
      // test (Part C Step 9 / Test #22 below) exercises.
      assertSafeTestDbName(dbName);
      try {
        await mongod.stop();
      } catch (_) { /* already stopped / never started — safe to ignore */ }
    },
  };
}

// CI reliability pass: a spawned child process (tenant-backup.js /
// tenant-restore.js under test) connecting to this file's own
// mongodb-memory-server instance can occasionally exceed even a generous
// connection timeout under REAL CI host contention — dozens of test files
// each running their own mongod, all competing for a resource-constrained
// runner's limited CPU. Diagnosed directly from an actual CI failure:
// "Server selection timed out after 20000 ms", a clean, narrowly-matched
// infrastructure signature — never a stand-in for a genuine application
// error, which would fail with a DIFFERENT message and must still fail
// the test immediately, on the first attempt, with no retry.
const TRANSIENT_MONGO_ERROR_RE = /Server selection timed out|MongooseServerSelectionError|ECONNREFUSED|connection \d+ to .* timed out/i;

function isTransientMongoConnectionError(result) {
  if (!result || result.status === 0) return false;
  if (TRANSIENT_MONGO_ERROR_RE.test(result.stderr || '')) return true;
  // A null status means the child was terminated by execSync's own
  // `timeout` option (the only thing that ever signals these specific
  // children) — but that does NOT mean it was killed before doing
  // anything. tenant-restore.js's mongoose.connect() is awaited near the
  // very top of run(), true, but plenty of its OWN real work follows
  // still inside the same 40s budget: Step 0's lock acquisition, Step
  // 3's staging write, Step 5's actual category apply. A timeout landing
  // after Step 0 kills a child that ALREADY holds a Mongo lock — the
  // script registers no SIGTERM handler, so its own `finally` (lock
  // release) never runs, orphaning the lock. Retrying then spawns a
  // FRESH attempt that hits Step 0's own correct, by-design,
  // no-staleness-bypass rejection instead of re-running the scenario the
  // test actually means to exercise: a DIFFERENT code path, silently
  // substituted for the intended one. Both the orphaned-lock rejection
  // and a genuine application failure exit with a real, definite,
  // non-null status, so a bare `status !== 0` assertion can't tell them
  // apart — but anything checking a specific single-attempt side effect
  // (a staging file, checkpoint stage/categoriesApplied, an audit event,
  // an expected 0-on-success) can silently break. Confirmed from two
  // independent CI failures on the SAME run, both shaped exactly like
  // this: "Step 6: staging-file cleanup" (file never written — attempt 1
  // never reached Step 3) and "Step 4: checkpoint lifecycle: a corrupted
  // checkpoint..." (expected 0, got 1 — attempt 2 rejected at Step 0).
  // A null status is therefore NOT retried — only a clean, fully-printed
  // transient-connect error (the regex match above) is, since that
  // message can only be produced by mongoose.connect() itself, strictly
  // before Step 0 ever runs, before anything exists to orphan.
  return false;
}

// CI watchdog-calibration diagnostic: classifies a spawned child's
// {status, stderr, signal, killed} result (the spawn helper must capture
// signal/killed from execSync's own thrown error — see runRestoreOnce)
// into exactly one of the three distinct failure shapes these children
// can produce, so a flaky assertion's failure output can state WHICH one
// actually happened instead of leaving it to be inferred from timing.
// 'watchdog_timeout' checks killed/signal FIRST (the direct, unambiguous
// signal from Node that execSync's own `timeout` fired) and falls back to
// a null status only for callers that haven't been updated to capture
// signal/killed yet — a null status has no other possible cause for these
// specific spawned children (see isTransientMongoConnectionError above).
function classifyChildResult(result) {
  if (!result) return 'no_result';
  if (result.status === 0) return 'success';
  if (result.killed === true || result.signal) return 'watchdog_timeout';
  if (TRANSIENT_MONGO_ERROR_RE.test(result.stderr || '')) return 'mongo_connection_error';
  if (result.status === null) return 'watchdog_timeout';
  return 'application_exit';
}

// Synchronous real-time delay between retries, matching this test suite's
// own established busy-wait precedent (tests/tenant-backup.test.js and
// tests/tenant-restore.test.js's own waitPastSecondBoundary()) — kept
// synchronous deliberately so callers of a plain execSync-based spawn
// helper need no async/await conversion at any call site.
function sleepSyncMs(ms) {
  const now = Date.now();
  while (Date.now() - now < ms) { /* busy-wait */ }
}

// Wraps a synchronous spawn function (must return {status, stdout, stderr})
// and retries it, WITH NO CALL-SITE CHANGES REQUIRED, only when the failure
// exactly matches the diagnosed transient-infrastructure signature above.
// Any other failure (a real assertion-worthy bug) returns immediately on
// the first attempt, unmasked.
// attempts defaults to 2 (not 3): each attempt is bounded by the caller's
// own execSync `timeout` (40s in tests/tenant-backup.test.js;
// tests/tenant-restore.test.js's own RESTORE_CHILD_TIMEOUT_MS is
// CI-calibrated, 40s locally / 90s on CI), so worst case is already
// ~80-180s for a single call — keeping the default at 2 attempts (not 3)
// keeps a single call's absolute worst case bounded to a known,
// reasonable figure rather than compounding further. This retry path
// only fires on a clean, fully-printed transient-connect error now (see
// isTransientMongoConnectionError's own comment), so this worst case is
// itself a rare, already-bounded edge, not the common case.
function withRetryOnTransientMongoError(spawnFn, attempts = 2, delayMs = 1000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = spawnFn();
    if (!isTransientMongoConnectionError(last)) return last;
    if (i < attempts - 1) sleepSyncMs(delayMs);
  }
  return last;
}

module.exports = {
  startIsolatedMongo, assertSafeTestDbName, randomTestDbName, TEST_DB_MARKER,
  isTransientMongoConnectionError, withRetryOnTransientMongoError, classifyChildResult,
};
