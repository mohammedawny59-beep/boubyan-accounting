// Targeted regression coverage for the PR #10 final-gate finding
// (ACCRUED-DESCRIPTION-MISATTRIBUTION's neighboring, unrelated finding):
// server.js's startMonitorSchedule() had (a) no NODE_ENV guard, unlike its
// sibling startBackupSchedule(), and (b) handed a >32-bit-signed-int delay
// straight to setTimeout for the monthly report, which Node silently clamps
// to firing almost immediately instead of waiting for the real date — this
// crashed unrelated Jest suites (a leaked timer firing after their own DB
// teardown) and, independently, is a genuine production risk (an unintended
// early Telegram broadcast of real revenue/expense/payroll figures on
// almost any server restart date).
//
// This file verifies both fixes independently and deterministically:
// - the environment guard, by requiring the real server.js under
//   NODE_ENV=test (this whole suite's own default) and confirming the
//   scheduler never arms;
// - the timer-overflow-safety arithmetic, via the new, pure, side-effect-
//   free lib/scheduler.js, using dependency-injected schedule/clock
//   functions — no DB, no network, no child process, no real wall-clock
//   wait, and no Jest fake-timer/sinon interaction to reason about.

process.env.NODE_ENV = 'test';

describe('Scheduler timer safety (PR #10 CI-fix) — test-environment guard', () => {
  test('requiring server.js under NODE_ENV=test never arms the monitor schedule', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      jest.resetModules();
      require('../server');
      const armed = logSpy.mock.calls.some(args => String(args[0] || '').includes('Monitoring agent started'));
      expect(armed).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('lib/scheduler.js — pure timer-overflow-safety primitives', () => {
  const { MAX_TIMEOUT_MS, msUntilNext, scheduleAt } = require('../lib/scheduler');

  // A fixed reference point that reproduces the exact original root cause:
  // "now" is the 1st of a month, just past 9:01am, so the next monthly
  // target (the 1st of the *following* month at 9:00am) is ~31 days away —
  // comfortably past Node's ~24.855-day setTimeout limit.
  const NOW = new Date(2025, 0, 1, 9, 1, 0); // 2025-01-01 09:01:00 local

  test('msUntilNext reproduces the original overflow scenario: the next monthly target is genuinely beyond Node\'s 32-bit setTimeout limit', () => {
    const delay = msUntilNext(9, 0, 1, NOW);
    expect(delay).toBeGreaterThan(MAX_TIMEOUT_MS);
  });

  test('long-delay behavior: scheduleAt never hands a single hop larger than MAX_TIMEOUT_MS to the underlying timer, even when the real target is far beyond it — it must NOT fire on that first, bounded hop', () => {
    const startMs = NOW.getTime();
    const target = startMs + msUntilNext(9, 0, 1, NOW);
    expect(target - startMs).toBeGreaterThan(MAX_TIMEOUT_MS); // sanity — this IS the overflow scenario

    const scheduledDelays = [];
    // Captures what would be handed to the real timer, but deliberately
    // never invokes the callback — proving nothing fires on the first hop.
    const fakeSchedule = (fn, delay) => { scheduledDelays.push(delay); };

    scheduleAt(target, () => { throw new Error('must not fire on the first, bounded hop'); }, fakeSchedule, () => startMs);

    expect(scheduledDelays.length).toBe(1);
    expect(scheduledDelays[0]).toBeGreaterThan(0);
    expect(scheduledDelays[0]).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
  });

  test('normal due behavior: scheduleAt walks through bounded hops and fires onDue exactly once, only once the real target time has actually arrived — never early, never duplicated, never changing the intended target', () => {
    const startMs = NOW.getTime();
    const target = startMs + msUntilNext(9, 0, 1, NOW);
    let simulatedNow = startMs;
    let fireCount = 0;
    // Simulates real time genuinely advancing by exactly the requested hop
    // (mirroring what a real setTimeout does), without any real wall-clock
    // wait — this is what lets the test run instantly while still proving
    // the multi-hop walk-down actually reaches the real target.
    const fakeSchedule = (fn, delay) => { simulatedNow += delay; fn(); };

    scheduleAt(target, () => { fireCount++; }, fakeSchedule, () => simulatedNow);

    expect(fireCount).toBe(1); // fires exactly once — no duplicate report
    expect(simulatedNow).toBeGreaterThanOrEqual(target); // never fires before the real target
    expect(simulatedNow - target).toBeLessThan(1000); // fires at the intended moment, not early and not drifted
  });

  test('a due-immediately target (already in the past) fires onDue synchronously, with zero scheduling hops — the manual-trigger/already-due path is unaffected', () => {
    let fired = false;
    const scheduleSpy = jest.fn();
    scheduleAt(Date.now() - 1000, () => { fired = true; }, scheduleSpy, () => Date.now());
    expect(fired).toBe(true);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });
});
