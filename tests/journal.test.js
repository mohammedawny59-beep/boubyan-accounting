// Unit tests for period-lock logic (IFRS IAS 8 compliance)
// These test the pure business rule: edits to entries in locked periods must be rejected.

const LOCKED_PERIODS = { '2025-01': true, '2025-02': true };

function isPeriodLocked(date, lockedPeriods) {
  const period = (date || '').substring(0, 7);
  return !!(lockedPeriods || {})[period];
}

function canEditEntry(entry, newDate, lockedPeriods) {
  if (isPeriodLocked(entry.date, lockedPeriods)) {
    return { allowed: false, reason: `الفترة ${entry.date.substring(0, 7)} مقفلة` };
  }
  if (newDate && isPeriodLocked(newDate, lockedPeriods)) {
    return { allowed: false, reason: `الفترة ${newDate.substring(0, 7)} مقفلة (هدف)` };
  }
  return { allowed: true };
}

function canDeleteEntry(entry, lockedPeriods) {
  if (isPeriodLocked(entry.date, lockedPeriods)) {
    return { allowed: false, reason: `الفترة ${entry.date.substring(0, 7)} مقفلة` };
  }
  return { allowed: true };
}

describe('Period lock — edit protection (IAS 8)', () => {
  test('allows editing entry in open period', () => {
    const entry = { id: 'JE-2025-0001', date: '2025-03-01' };
    expect(canEditEntry(entry, null, LOCKED_PERIODS).allowed).toBe(true);
  });

  test('blocks editing entry in locked period', () => {
    const entry = { id: 'JE-2025-0001', date: '2025-01-15' };
    const result = canEditEntry(entry, null, LOCKED_PERIODS);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('2025-01');
  });

  test('blocks moving entry to locked period', () => {
    const entry = { id: 'JE-2025-0001', date: '2025-03-10' };
    const result = canEditEntry(entry, '2025-02-01', LOCKED_PERIODS);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('2025-02');
  });

  test('allows moving entry between two open periods', () => {
    const entry = { id: 'JE-2025-0001', date: '2025-03-10' };
    const result = canEditEntry(entry, '2025-04-01', LOCKED_PERIODS);
    expect(result.allowed).toBe(true);
  });
});

describe('Period lock — delete protection (IAS 8)', () => {
  test('allows deleting entry in open period', () => {
    const entry = { id: 'JE-2025-0002', date: '2025-06-01' };
    expect(canDeleteEntry(entry, LOCKED_PERIODS).allowed).toBe(true);
  });

  test('blocks deleting entry in locked period', () => {
    const entry = { id: 'JE-2025-0002', date: '2025-01-20' };
    const result = canDeleteEntry(entry, LOCKED_PERIODS);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('2025-01');
  });

  test('handles empty lockedPeriods gracefully', () => {
    const entry = { id: 'JE-2025-0002', date: '2025-01-20' };
    expect(canDeleteEntry(entry, {}).allowed).toBe(true);
    expect(canDeleteEntry(entry, null).allowed).toBe(true);
  });
});

describe('isPeriodLocked helper', () => {
  test('returns false for undefined date', () => {
    expect(isPeriodLocked(undefined, LOCKED_PERIODS)).toBe(false);
  });

  test('returns false for empty date string', () => {
    expect(isPeriodLocked('', LOCKED_PERIODS)).toBe(false);
  });

  test('returns true for exact locked month', () => {
    expect(isPeriodLocked('2025-02-28', LOCKED_PERIODS)).toBe(true);
  });
});
