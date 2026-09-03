'use strict';
// Pure, side-effect-free scheduling primitives used by server.js's
// recursive-setTimeout monitor schedulers (daily inventory check / monthly
// report). Extracted so the timer-overflow-safety property is directly,
// deterministically testable without booting the full app, touching a real
// database, or waiting on real wall-clock time — the same "extract the pure
// logic into a small, Node-requirable module" pattern already established
// by public/js/vendorWorkspaceLogic.js for the vendor/AP workspace feature.
//
// Root cause this exists to fix: server.js used to hand msUntilNext()'s raw
// delay straight to setTimeout. Node's setTimeout silently CLAMPS any delay
// above its internal 32-bit signed-int limit (2,147,483,647ms ≈ 24.855 days)
// to fire almost immediately instead of throwing or warning usefully — the
// monthly-report delay (up to ~31 days) crosses that limit on most days of
// the month, so a real production process could broadcast the monthly
// Telegram report the instant it started, and in Jest a leaked instance of
// the timer could fire mid-suite and crash unrelated tests.

// Node's own safe setTimeout maximum.
const MAX_TIMEOUT_MS = 2147483647;

// ms until the next occurrence of {hour}:{minute}, optionally pinned to a
// specific day-of-month (e.g. hour=9, minute=0, dayOfMonth=1 => next 1st of
// the month at 9:00am, local time — matches this schedule's existing,
// unchanged semantics). `now` is injectable for deterministic testing.
function msUntilNext(hour, minute, dayOfMonth, now) {
  now = now || new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (dayOfMonth) {
    next.setDate(dayOfMonth);
    if (next <= now) { next.setMonth(next.getMonth() + 1); next.setDate(dayOfMonth); }
  } else {
    if (next <= now) next.setDate(next.getDate() + 1);
  }
  return next - now;
}

// Arranges for `onDue` to run once `targetTime` (an absolute epoch-ms
// timestamp) has genuinely arrived, by walking down through <=MAX_TIMEOUT_MS
// hops rather than handing a single, possibly-overflowing delay straight to
// the underlying timer. Never fires early (each hop re-derives the real
// remaining delay against the same fixed targetTime) and fires exactly once
// per call (the caller decides whether/when to schedule the next cycle,
// typically by calling scheduleAt again from inside onDue). `schedule`/`now`
// default to the real setTimeout/Date.now but are injectable so this can be
// driven synchronously and instantly in tests, with no real wall-clock wait.
function scheduleAt(targetTime, onDue, schedule, now) {
  schedule = schedule || setTimeout;
  now = now || Date.now;
  const remaining = targetTime - now();
  if (remaining <= 0) { onDue(); return; }
  schedule(() => scheduleAt(targetTime, onDue, schedule, now), Math.min(remaining, MAX_TIMEOUT_MS));
}

module.exports = { MAX_TIMEOUT_MS, msUntilNext, scheduleAt };
