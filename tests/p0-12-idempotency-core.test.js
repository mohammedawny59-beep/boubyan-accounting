// P0.12 — Financial Idempotency & Retry-Safety Closure.
// Part E (atomic claim mechanism, file/default backend) + Part F (claim
// lifecycle semantics) + Part B/D (key extraction, validation, fingerprint).
//
// Pure unit tests against lib/idempotency.js — no server, no DB backend,
// no network. `db` here is a bare plain object exactly like the one
// lib/database.js's loadDB() returns in file mode; claimIdempotencyKeySync/
// completeIdempotencyClaim/releaseIdempotencyClaim only ever touch
// db.idempotencyRecords, so a plain object is a faithful, fast substitute.

'use strict';

const {
  IdempotencyConflictError,
  extractIdempotencyKey,
  validateIdempotencyKey,
  computeFingerprint,
  claimIdempotencyKeySync,
  claimIdempotencyKey,
  completeIdempotencyClaim,
  releaseIdempotencyClaim,
  PROCESSING_TIMEOUT_MS,
} = require('../lib/idempotency');

function freshDb() {
  return { idempotencyRecords: [] };
}

describe('P0.12 — extractIdempotencyKey (Part B)', () => {
  test('Key A: reads the Idempotency-Key header when present', () => {
    const req = { headers: { 'idempotency-key': 'HDR-KEY-0001' }, body: {} };
    expect(extractIdempotencyKey(req)).toBe('HDR-KEY-0001');
  });

  test('Key B: falls back to body.idempotencyKey when no header is sent', () => {
    const req = { headers: {}, body: { idempotencyKey: 'BODY-KEY-0001' } };
    expect(extractIdempotencyKey(req)).toBe('BODY-KEY-0001');
  });

  test('Key C: falls back to the pre-existing body.clientRef field name (backward-compat alias)', () => {
    const req = { headers: {}, body: { clientRef: 'CLIENTREF-0001' } };
    expect(extractIdempotencyKey(req)).toBe('CLIENTREF-0001');
  });

  test('Key D: header takes precedence over both body fields when all three are sent', () => {
    const req = { headers: { 'idempotency-key': 'HDR-WINS' }, body: { idempotencyKey: 'BODY-LOSES', clientRef: 'CLIENTREF-LOSES' } };
    expect(extractIdempotencyKey(req)).toBe('HDR-WINS');
  });

  test('Key E: returns null when nothing is supplied (route runs unprotected, unchanged behavior)', () => {
    expect(extractIdempotencyKey({ headers: {}, body: {} })).toBeNull();
    expect(extractIdempotencyKey({ headers: {}, body: undefined })).toBeNull();
  });

  test('Key F: whitespace-only header is treated as absent, falls back to body', () => {
    const req = { headers: { 'idempotency-key': '   ' }, body: { clientRef: 'FALLBACK-OK' } };
    expect(extractIdempotencyKey(req)).toBe('FALLBACK-OK');
  });

  test('Key G: trims surrounding whitespace from the extracted key', () => {
    const req = { headers: { 'idempotency-key': '  TRIMMED-KEY  ' }, body: {} };
    expect(extractIdempotencyKey(req)).toBe('TRIMMED-KEY');
  });
});

describe('P0.12 — validateIdempotencyKey (Part B)', () => {
  test('Validate A: accepts a well-formed key', () => {
    expect(validateIdempotencyKey('order-2026-08-15-abc123').ok).toBe(true);
  });

  test('Validate B: rejects a key shorter than the minimum length', () => {
    const r = validateIdempotencyKey('short');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/قصير/);
  });

  test('Validate C: rejects a key longer than the maximum length', () => {
    const r = validateIdempotencyKey('x'.repeat(201));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/طويل/);
  });

  test('Validate D: rejects characters outside the allowed set (spaces, quotes, slashes)', () => {
    expect(validateIdempotencyKey('bad key with spaces').ok).toBe(false);
    expect(validateIdempotencyKey('bad/key/slash1234').ok).toBe(false);
    expect(validateIdempotencyKey('bad"key"quote1234').ok).toBe(false);
  });

  test('Validate E: accepts every character the pattern documents (letters, digits, - _ : .)', () => {
    expect(validateIdempotencyKey('AbC-123_xyz:foo.bar').ok).toBe(true);
  });

  test('Validate F: rejects non-string / empty input', () => {
    expect(validateIdempotencyKey('').ok).toBe(false);
    expect(validateIdempotencyKey(null).ok).toBe(false);
    expect(validateIdempotencyKey(undefined).ok).toBe(false);
    expect(validateIdempotencyKey(12345678).ok).toBe(false);
  });
});

describe('P0.12 — computeFingerprint (Part B)', () => {
  test('Fingerprint A: is deterministic for the same scope + payload', () => {
    const a = computeFingerprint('journal:create', { amount: 100, desc: 'x' });
    const b = computeFingerprint('journal:create', { amount: 100, desc: 'x' });
    expect(a).toBe(b);
  });

  test('Fingerprint B: is independent of key insertion order (sorted-JSON)', () => {
    const a = computeFingerprint('journal:create', { amount: 100, desc: 'x' });
    const b = computeFingerprint('journal:create', { desc: 'x', amount: 100 });
    expect(a).toBe(b);
  });

  test('Fingerprint C: differs when the operationScope differs, even with identical payload', () => {
    const a = computeFingerprint('journal:create', { amount: 100 });
    const b = computeFingerprint('vendor-bill:create', { amount: 100 });
    expect(a).not.toBe(b);
  });

  test('Fingerprint D: differs when any meaningful field differs', () => {
    const a = computeFingerprint('vendor-bill:pay', { id: 'B1', amount: 200 });
    const b = computeFingerprint('vendor-bill:pay', { id: 'B1', amount: 200.001 });
    expect(a).not.toBe(b);
  });

  test('Fingerprint E: is a 64-char lowercase hex sha256 digest', () => {
    const fp = computeFingerprint('x:y', { a: 1 });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('P0.12 — claimIdempotencyKeySync (Part E, file/default backend)', () => {
  test('Claim A: a fresh key is claimed and creates exactly one PROCESSING record', () => {
    const db = freshDb();
    const r = claimIdempotencyKeySync(db, 'default', 'journal:create', 'K1', 'FP1');
    expect(r.claimed).toBe(true);
    expect(r.record.status).toBe('PROCESSING');
    expect(db.idempotencyRecords).toHaveLength(1);
  });

  test('Claim B: a second claim attempt for the SAME still-PROCESSING key is rejected as IN_PROGRESS', () => {
    const db = freshDb();
    claimIdempotencyKeySync(db, 'default', 'journal:create', 'K2', 'FP2');
    expect(() => claimIdempotencyKeySync(db, 'default', 'journal:create', 'K2', 'FP2'))
      .toThrow(IdempotencyConflictError);
    try {
      claimIdempotencyKeySync(db, 'default', 'journal:create', 'K2', 'FP2');
    } catch (e) {
      expect(e.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(e.status).toBe(409);
    }
  });

  test('Claim C: after completion, a replay with the SAME fingerprint returns claimed:false with the completed record', async () => {
    const db = freshDb();
    const claim = claimIdempotencyKeySync(db, 'default', 'journal:create', 'K3', 'FP3');
    await completeIdempotencyClaim(db, false, claim.record, { journalId: 'JE-1' }, 'JE-1', 'JE-1');

    const replay = claimIdempotencyKeySync(db, 'default', 'journal:create', 'K3', 'FP3');
    expect(replay.claimed).toBe(false);
    expect(replay.record.status).toBe('COMPLETED');
    expect(replay.record.resultReference).toEqual({ journalId: 'JE-1' });
  });

  test('Claim D: the SAME key reused with a DIFFERENT fingerprint is rejected — IDEMPOTENCY_KEY_REUSED, not a replay', async () => {
    const db = freshDb();
    const claim = claimIdempotencyKeySync(db, 'default', 'journal:create', 'K4', 'FP4-original');
    await completeIdempotencyClaim(db, false, claim.record, { journalId: 'JE-2' }, 'JE-2', 'JE-2');

    expect(() => claimIdempotencyKeySync(db, 'default', 'journal:create', 'K4', 'FP4-DIFFERENT'))
      .toThrow(IdempotencyConflictError);
    try {
      claimIdempotencyKeySync(db, 'default', 'journal:create', 'K4', 'FP4-DIFFERENT');
    } catch (e) {
      expect(e.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(e.status).toBe(409);
    }
  });

  test('Claim E: the same key is independent across different operationScope values (no cross-scope collision)', () => {
    const db = freshDb();
    const a = claimIdempotencyKeySync(db, 'default', 'journal:create', 'SHARED-KEY', 'FP-A');
    const b = claimIdempotencyKeySync(db, 'default', 'vendor-bill:create', 'SHARED-KEY', 'FP-B');
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
    expect(db.idempotencyRecords).toHaveLength(2);
  });

  test('Claim F: the same key is independent across different tenants (no cross-tenant collision)', () => {
    const db = freshDb();
    const a = claimIdempotencyKeySync(db, 'tenant-a', 'journal:create', 'SHARED-KEY', 'FP-SAME');
    const b = claimIdempotencyKeySync(db, 'tenant-b', 'journal:create', 'SHARED-KEY', 'FP-SAME');
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
    expect(db.idempotencyRecords).toHaveLength(2);
  });

  test('Claim G: releaseIdempotencyClaim removes the record so a genuinely fresh retry can claim again', async () => {
    const db = freshDb();
    const claim = claimIdempotencyKeySync(db, 'default', 'journal:create', 'K5', 'FP5');
    await releaseIdempotencyClaim(db, false, claim.record);
    expect(db.idempotencyRecords).toHaveLength(0);

    const second = claimIdempotencyKeySync(db, 'default', 'journal:create', 'K5', 'FP5');
    expect(second.claimed).toBe(true);
  });

  test('Claim H: an abandoned PROCESSING claim (older than PROCESSING_TIMEOUT_MS) self-heals for a retry of the SAME logical operation (matching fingerprint) — reclaimed instead of blocked forever', () => {
    const db = freshDb();
    const claim = claimIdempotencyKeySync(db, 'default', 'journal:create', 'K6', 'FP6');
    // Simulate a crashed prior attempt: backdate createdAt past the timeout.
    claim.record.createdAt = new Date(Date.now() - PROCESSING_TIMEOUT_MS - 5000).toISOString();

    // A genuine retry of the SAME operation recomputes the SAME fingerprint
    // (identical request payload) — this is what self-healing exists for.
    const reclaim = claimIdempotencyKeySync(db, 'default', 'journal:create', 'K6', 'FP6');
    expect(reclaim.claimed).toBe(true);
    expect(reclaim.record.fingerprint).toBe('FP6');
    expect(db.idempotencyRecords).toHaveLength(1);
  });

  test('Claim H2: an abandoned PROCESSING claim does NOT let a DIFFERENT fingerprint hijack the key — still IDEMPOTENCY_KEY_REUSED, not silently reclaimed', () => {
    const db = freshDb();
    const claim = claimIdempotencyKeySync(db, 'default', 'journal:create', 'K6B', 'FP6B-original');
    claim.record.createdAt = new Date(Date.now() - PROCESSING_TIMEOUT_MS - 5000).toISOString();

    // Abandonment only means "the ORIGINAL operation's retry is no longer
    // blocked" — it must never mean "this key is now free for anything."
    // A different fingerprint reusing the same key is still a client bug.
    expect(() => claimIdempotencyKeySync(db, 'default', 'journal:create', 'K6B', 'FP6B-DIFFERENT-OPERATION'))
      .toThrow(IdempotencyConflictError);
    try {
      claimIdempotencyKeySync(db, 'default', 'journal:create', 'K6B', 'FP6B-DIFFERENT-OPERATION');
    } catch (e) {
      expect(e.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
  });

  test('Claim I: a NOT-yet-abandoned PROCESSING claim (well under the timeout) is still rejected as IN_PROGRESS', () => {
    const db = freshDb();
    const claim = claimIdempotencyKeySync(db, 'default', 'journal:create', 'K7', 'FP7');
    claim.record.createdAt = new Date(Date.now() - 1000).toISOString(); // 1s old, far under 60s
    expect(() => claimIdempotencyKeySync(db, 'default', 'journal:create', 'K7', 'FP7'))
      .toThrow(IdempotencyConflictError);
  });

  test('Claim J (TOCTOU-shape regression): claim-check and claim-insert happen inside ONE synchronous call — no awaited gap for a second logical caller to interleave through the same code path', () => {
    // This is a structural guarantee (see lib/idempotency.js header), proven
    // here by construction: claimIdempotencyKeySync's entire body — the
    // findIndex check AND the push/overwrite — contains zero `await`
    // keywords (it isn't even declared `async`). Two calls made back-to-back
    // by synchronous application code cannot interleave; JS has no way to
    // suspend and resume mid-function without an await point.
    expect(claimIdempotencyKeySync.constructor.name).not.toBe('AsyncFunction');
    // Behavioral corollary: 500 sequential claims for a NEW key each are all
    // independently claimed (no false rejections from the mechanism itself).
    const db = freshDb();
    for (let i = 0; i < 500; i++) {
      const r = claimIdempotencyKeySync(db, 'default', 'journal:create', 'BULK-' + i, 'FP-' + i);
      expect(r.claimed).toBe(true);
    }
    expect(db.idempotencyRecords).toHaveLength(500);
  });
});

describe('P0.12 — claimIdempotencyKey dispatcher (Part E)', () => {
  test('Dispatch A: isMongo=false routes to the synchronous file-mode implementation', async () => {
    const db = freshDb();
    const r = await claimIdempotencyKey(db, false, 'default', 'journal:create', 'DISPATCH-1', 'FPD1');
    expect(r.claimed).toBe(true);
    expect(db.idempotencyRecords).toHaveLength(1);
  });
});

describe('P0.12 — completeIdempotencyClaim / releaseIdempotencyClaim record shape (Part F)', () => {
  test('Complete A: stores resultReference, sourceId, journalId, and a completedAt timestamp', async () => {
    const db = freshDb();
    const claim = claimIdempotencyKeySync(db, 'default', 'vendor-bill:pay', 'K8', 'FP8');
    await completeIdempotencyClaim(db, false, claim.record, { bill: { id: 'B1' } }, 'B1', 'JE-BILLPAY-B1-1');

    const stored = db.idempotencyRecords.find(r => r.key === 'K8');
    expect(stored.status).toBe('COMPLETED');
    expect(stored.resultReference).toEqual({ bill: { id: 'B1' } });
    expect(stored.sourceId).toBe('B1');
    expect(stored.journalId).toBe('JE-BILLPAY-B1-1');
    expect(stored.completedAt).toEqual(expect.any(String));
  });

  test('Release A: a release before completion leaves NO trace — a fresh retry sees a brand-new record, not a stale PROCESSING one', async () => {
    const db = freshDb();
    const claim = claimIdempotencyKeySync(db, 'default', 'vendor-bill:pay', 'K9', 'FP9');
    await releaseIdempotencyClaim(db, false, claim.record);
    expect(db.idempotencyRecords.find(r => r.key === 'K9')).toBeUndefined();
  });
});
