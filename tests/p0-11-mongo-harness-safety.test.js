// P0.11 Part C Step 9 — the isolated-Mongo test harness's own safety guard
// must itself be tested: it must REFUSE to treat a database name as
// droppable unless it unmistakably carries a test marker and does not look
// production-like. This file tests ONLY the harness module (tests/helpers/
// mongoTestHarness.js) — no real accounting logic, no server.js.

const { startIsolatedMongo, assertSafeTestDbName, randomTestDbName } = require('./helpers/mongoTestHarness');

describe('P0.11 — Mongo test-harness safety guard (Part C Step 9)', () => {
  test('Guard A: a name without the "_test_" marker is refused', () => {
    expect(() => assertSafeTestDbName('boubyan_accounting')).toThrow(/REFUSED/);
    expect(() => assertSafeTestDbName('boubyan_accounting_p011')).toThrow(/_test_/);
  });

  test('Guard B: a production-like name is refused even with a test marker present', () => {
    expect(() => assertSafeTestDbName('boubyan_production_test_abc')).toThrow(/REFUSED/);
    expect(() => assertSafeTestDbName('prod_test_x')).toThrow(/production-like/);
  });

  test('Guard C: an empty/undefined/non-string name is refused', () => {
    expect(() => assertSafeTestDbName('')).toThrow(/REFUSED/);
    expect(() => assertSafeTestDbName(undefined)).toThrow(/REFUSED/);
    expect(() => assertSafeTestDbName(null)).toThrow(/REFUSED/);
  });

  test('Guard D: a genuinely safe test name passes', () => {
    expect(assertSafeTestDbName('boubyan_accounting_p011_test_abc123')).toBe(true);
  });

  test('Guard E: randomTestDbName() always generates a name that itself passes the guard', () => {
    for (let i = 0; i < 5; i++) {
      const name = randomTestDbName('p011');
      expect(() => assertSafeTestDbName(name)).not.toThrow();
    }
  });

  // Real, end-to-end proof this is not mocked: actually spins up a real
  // disposable mongod (mongodb-memory-server), connects, writes, reads,
  // and stops it — the harness's stop() re-asserts the safety guard
  // immediately before its own destructive step (killing the disposable
  // mongod process via mongod.stop()). P0.11 (adversarial review finding,
  // mongo-parity persona): this comment previously said "dropDatabase()
  // call" — no such call exists anywhere in this codebase (grepped); the
  // actual guarded destructive action is the process-level stop() above.
  test('Real E2E: startIsolatedMongo() boots a genuine, isolated, disposable MongoDB and stop() tears it down safely', async () => {
    const instance = await startIsolatedMongo('safetytest');
    expect(instance.dbName).toMatch(/_test_/);
    expect(() => assertSafeTestDbName(instance.dbName)).not.toThrow();

    const mongoose = require('mongoose');
    await mongoose.connect(instance.uri);
    try {
      const Probe = mongoose.model('P011SafetyProbe', new mongoose.Schema({ x: Number }), 'p011_safety_probe');
      await Probe.create({ x: 42 });
      const count = await Probe.countDocuments();
      expect(count).toBe(1);
    } finally {
      await mongoose.disconnect();
    }
    await instance.stop();
  }, 60000);
});
