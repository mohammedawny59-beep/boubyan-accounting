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

module.exports = { startIsolatedMongo, assertSafeTestDbName, randomTestDbName, TEST_DB_MARKER };
