'use strict';
/**
 * P0.12 — canonical financial idempotency service.
 *
 * Closes P6-097: a client that retries a financial mutation after an
 * uncertain outcome (lost response, timeout, double-click, concurrent
 * duplicate submission) must never produce a second real accounting effect.
 *
 * CONTRACT (see docs/FINANCIAL_IDEMPOTENCY_ARCHITECTURE.md for the full
 * write-up):
 *   - Client sends an `Idempotency-Key` HTTP header (preferred) or a body
 *     field (`idempotencyKey`, or the pre-existing `clientRef` on routes
 *     that already used that name — kept for backward compatibility, not a
 *     second competing mechanism).
 *   - Uniqueness is scoped to (tenantId, operationScope, key) — the SAME
 *     key used for two different operation types, or by two different
 *     tenants, never collides.
 *   - Same key + same normalized financial intent (fingerprint) on retry →
 *     the ORIGINAL result is returned, zero new mutation.
 *   - Same key + a DIFFERENT fingerprint → 409 IDEMPOTENCY_KEY_REUSED, zero
 *     mutation (this is a client bug, not a retry — the key was reused for
 *     a genuinely different command).
 *   - No key supplied at all → the route behaves exactly as before this
 *     milestone (best-effort, no idempotency guarantee) — this is a
 *     deliberate, documented choice: forcing every existing API caller to
 *     start sending a key would be a breaking change outside this
 *     milestone's scope ("no new features", and every route's response
 *     shape/auth stays identical for a caller that doesn't opt in).
 *
 * CONCURRENCY:
 *   - File / default backend: claimIdempotencyKeySync() is fully synchronous
 *     (no `await` between checking for an existing key and inserting the
 *     PROCESSING record). Node.js is single-threaded — synchronous code
 *     runs to completion between await points, so two "concurrent" HTTP
 *     requests handled by the same process cannot interleave mid-check.
 *     This is the actual guarantee for this app's confirmed single-instance
 *     deployment model (see P0.5's multi-instance safety analysis).
 *   - Mongo backend: claimIdempotencyKeyMongo() additionally goes through a
 *     DEDICATED Mongoose model (models/IdempotencyRecord.js) with a real
 *     unique compound index on (tenantId, operationScope, key) — a genuine
 *     database-level uniqueness guarantee, not a "find then insert" race,
 *     and the only thing that also covers a cross-process race (e.g. an
 *     overlapping redeploy) that the in-memory check cannot see.
 *   - Both paths keep db.idempotencyRecords[] (an ENTITY_KEYS-tracked array,
 *     like every other persisted entity) as the single read source of
 *     truth, so callers never need to branch on backend to look up a prior
 *     result.
 *
 * CALLER CONTRACT — WRITE ORDER (P0.12 adversarial-review fix, critical):
 *   1. claimIdempotencyKey(...) — as early as possible in the route, and
 *      ALWAYS before reading any mutable balance/state field the route is
 *      about to validate (e.g. an outstanding-amount check). Reason: in
 *      Mongo mode, claimIdempotencyKeyMongo() performs a real network
 *      round-trip — a genuine event-loop yield that does NOT exist in file
 *      mode. If the claim is taken AFTER such a read, two concurrent
 *      requests carrying DIFFERENT keys (never deduplicated against each
 *      other by design) can both read the same stale balance before either
 *      mutates, and both pass a check that should have blocked the second
 *      one — a real regression this milestone's own adversarial review
 *      caught in four routes. Putting the claim first restores the
 *      pre-P0.12 guarantee: the entire read-validate-mutate span has no
 *      await before it completes, so it runs atomically per request again,
 *      regardless of which of two concurrent claims resolves first.
 *   2. Perform the mutation.
 *   3. completeIdempotencyClaim(db, isMongo, record, ...) — in-memory only,
 *      purely synchronous.
 *   4. await saveDB(db, {durable:true}) — the route's own existing call.
 *      On failure: await releaseIdempotencyClaim(db, isMongo, record) before
 *      returning the failure response — completeIdempotencyClaim already
 *      marked the in-memory record COMPLETED in step 3, and if the durable
 *      write never lands, that optimistic in-memory state must not survive
 *      to fool a same-process retry into replaying a mutation that was
 *      never actually saved.
 *   5. ONLY once step 4 has succeeded: if isMongo, await
 *      finalizeIdempotencyClaimMongo(record) — the dedicated collection's
 *      own durable write, deliberately last, so it can only ever mark a
 *      claim COMPLETED once the real financial mutation is confirmed
 *      durable first.
 */

const crypto = require('crypto');

const MIN_KEY_LEN = 8;
const MAX_KEY_LEN = 200;
const KEY_PATTERN = /^[A-Za-z0-9_\-:.]+$/;

// A PROCESSING record older than this is treated as abandoned (the process
// that claimed it almost certainly crashed or was killed before completing
// or failing the request) — a fresh attempt is allowed to reclaim the key
// rather than being blocked forever. This is deliberately generous (well
// beyond any real single request's duration) — see Part F Step 19: "do not
// permanently poison the key unnecessarily."
const PROCESSING_TIMEOUT_MS = 60000;

class IdempotencyConflictError extends Error {
  constructor(message, status, code, existing) {
    super(message);
    this.name = 'IdempotencyConflictError';
    this.status = status;
    this.code = code;
    this.existing = existing || null;
  }
}

/** Reads the key from the Idempotency-Key header, or falls back to a body
 * field — `idempotencyKey` (new canonical body field) or `clientRef`
 * (pre-existing field name already used by vendor-bill-payment / patient-
 * collection; treated as an equivalent alias, not a second mechanism). */
function extractIdempotencyKey(req) {
  const headerKey = req.headers && req.headers['idempotency-key'];
  const bodyKey = req.body && (req.body.idempotencyKey || req.body.clientRef);
  const raw = headerKey != null && String(headerKey).trim() !== '' ? headerKey : bodyKey;
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  return str || null;
}

function validateIdempotencyKey(key) {
  if (typeof key !== 'string' || !key) {
    return { ok: false, error: 'مفتاح التكرار (Idempotency-Key) مطلوب بصيغة نصية' };
  }
  if (key.length < MIN_KEY_LEN) {
    return { ok: false, error: `مفتاح التكرار قصير جدًا (الحد الأدنى ${MIN_KEY_LEN} حرفًا)` };
  }
  if (key.length > MAX_KEY_LEN) {
    return { ok: false, error: `مفتاح التكرار طويل جدًا (الحد الأقصى ${MAX_KEY_LEN} حرفًا)` };
  }
  if (!KEY_PATTERN.test(key)) {
    return { ok: false, error: 'مفتاح التكرار يحتوي أحرفًا غير مسموحة (المسموح: حروف/أرقام/- /_ /: /.)' };
  }
  return { ok: true };
}

/** Deterministic fingerprint of ONLY the financially meaningful, normalized
 * fields of a request — never raw transport metadata (headers, timestamps
 * the client can't control identically across a retry). Two genuinely
 * different transactions that happen to share every meaningful field are,
 * by definition, the same logical command as far as this service is
 * concerned — that's what operationScope + explicit business identity
 * (e.g. a real invoice/reference number) is for, not this fingerprint. */
function computeFingerprint(operationScope, normalizedPayload) {
  const json = JSON.stringify(normalizedPayload || {}, Object.keys(normalizedPayload || {}).sort());
  return crypto.createHash('sha256').update(String(operationScope) + '|' + json).digest('hex');
}

function _isAbandoned(record) {
  if (record.status !== 'PROCESSING') return false;
  const age = Date.now() - new Date(record.createdAt).getTime();
  return age > PROCESSING_TIMEOUT_MS;
}

function _newRecord(tenantId, operationScope, key, fingerprint) {
  return {
    id: 'IDEMP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    tenantId, operationScope, key, fingerprint,
    status: 'PROCESSING', resultReference: null, sourceId: null, journalId: null,
    createdAt: new Date().toISOString(), completedAt: null,
  };
}

function _checkExisting(existing, fingerprint) {
  if (existing.fingerprint !== fingerprint) {
    throw new IdempotencyConflictError(
      'نفس مفتاح التكرار (Idempotency-Key) استُخدم لعملية مالية مختلفة — لا يمكن إعادة استخدامه لعملية أخرى',
      409, 'IDEMPOTENCY_KEY_REUSED', existing
    );
  }
  if (existing.status === 'PROCESSING' && !_isAbandoned(existing)) {
    throw new IdempotencyConflictError(
      'نفس العملية قيد التنفيذ حاليًا — حاول مرة أخرى بعد قليل',
      409, 'IDEMPOTENCY_IN_PROGRESS', existing
    );
  }
}

/**
 * File/default-backend claim — synchronous by design (see file header).
 * Returns {claimed:true, record} on a fresh claim (caller must proceed to
 * perform the mutation and then call completeIdempotencyClaim), or
 * {claimed:false, record} when a COMPLETED prior result already exists
 * (caller should replay it, not re-execute). Throws IdempotencyConflictError
 * for a key reused with a different fingerprint, or a still-live PROCESSING
 * claim held by another in-flight request.
 */
function claimIdempotencyKeySync(db, tenantId, operationScope, key, fingerprint) {
  if (!db.idempotencyRecords) db.idempotencyRecords = [];
  const idx = db.idempotencyRecords.findIndex(r => r.tenantId === tenantId && r.operationScope === operationScope && r.key === key);
  if (idx >= 0) {
    const existing = db.idempotencyRecords[idx];
    _checkExisting(existing, fingerprint);
    if (existing.status === 'PROCESSING' && _isAbandoned(existing)) {
      // Reclaim: the prior attempt almost certainly crashed before ever
      // reaching a financial mutation (or this service's own completion
      // step). Overwrite in place with a fresh PROCESSING claim.
      const fresh = _newRecord(tenantId, operationScope, key, fingerprint);
      db.idempotencyRecords[idx] = fresh;
      return { claimed: true, record: fresh };
    }
    return { claimed: false, record: existing };
  }
  const record = _newRecord(tenantId, operationScope, key, fingerprint);
  db.idempotencyRecords.push(record);
  return { claimed: true, record };
}

function _recordFromMongoDoc(doc) {
  return {
    id: String(doc._id || doc.id || ''), tenantId: doc.tenantId, operationScope: doc.operationScope,
    key: doc.key, fingerprint: doc.fingerprint, status: doc.status,
    resultReference: doc.resultReference || null, sourceId: doc.sourceId || null, journalId: doc.journalId || null,
    createdAt: doc.createdAt, completedAt: doc.completedAt || null,
  };
}

/**
 * Mongo-backend claim — a real insert against the uniquely-indexed
 * IdempotencyRecord collection. A concurrent duplicate is rejected by
 * MongoDB itself (E11000), not discovered via a separate racy "find" —
 * see file header and models/IdempotencyRecord.js.
 */
async function claimIdempotencyKeyMongo(tenantId, operationScope, key, fingerprint, _retried) {
  const IdempotencyRecord = require('../models/IdempotencyRecord');
  try {
    const doc = await IdempotencyRecord.create({ tenantId, operationScope, key, fingerprint, status: 'PROCESSING' });
    return { claimed: true, record: _recordFromMongoDoc(doc) };
  } catch (e) {
    if (e && e.code === 11000) {
      const existingDoc = await IdempotencyRecord.findOne({ tenantId, operationScope, key }).lean();
      if (!existingDoc) {
        // P0.12 adversarial-review fix — the record that caused this E11000
        // was concurrently released (its owner's request failed cleanly
        // before ever mutating) in the narrow window between our create()
        // and this findOne(). The key is genuinely free again — retry the
        // claim once instead of surfacing a raw, unrelated duplicate-key
        // error for what is actually a legitimate fresh-claim case.
        if (_retried) throw e; // still pathological on a second attempt — surface it
        return claimIdempotencyKeyMongo(tenantId, operationScope, key, fingerprint, true);
      }
      const existing = _recordFromMongoDoc(existingDoc);
      _checkExisting(existing, fingerprint);
      if (existing.status === 'PROCESSING' && _isAbandoned(existing)) {
        const fresh = _newRecord(tenantId, operationScope, key, fingerprint);
        await IdempotencyRecord.updateOne(
          { tenantId, operationScope, key },
          { $set: { fingerprint, status: 'PROCESSING', resultReference: null, sourceId: null, journalId: null, createdAt: new Date(fresh.createdAt), completedAt: null } }
        );
        return { claimed: true, record: fresh };
      }
      return { claimed: false, record: existing };
    }
    throw e;
  }
}

/**
 * Dispatches to the correct backend claim implementation. `isMongo` should
 * be `!isFileFallbackMode()` — passed in explicitly (not re-derived here)
 * so callers control exactly which mode they're claiming under, matching
 * how every other P0.11 durable-save call site already reads that state.
 */
async function claimIdempotencyKey(db, isMongo, tenantId, operationScope, key, fingerprint) {
  if (isMongo) return claimIdempotencyKeyMongo(tenantId, operationScope, key, fingerprint);
  return claimIdempotencyKeySync(db, tenantId, operationScope, key, fingerprint);
}

// Plain data objects only (ISO date STRINGS, never Date instances, matching
// this codebase's own convention — see appendJournalEntry/appendAuditEvent
// call sites throughout server.js) — a JSON round-trip is a safe, adequate
// deep clone here. Not a general-purpose clone utility; deliberately narrow.
function _snapshot(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

/**
 * Marks a claimed record COMPLETED in memory (db.idempotencyRecords[], the
 * uniform read source for both backends) with a SNAPSHOT — not a live
 * reference — of the result, so a later, unrelated mutation of the actual
 * business object (e.g. reversing a payment) can never bleed into a replay
 * response for an earlier, already-completed request (P0.12 adversarial-
 * review fix — the prior version stored resultReference by reference).
 *
 * P0.12 adversarial-review fix (critical): this function is now PURELY
 * in-memory — it does NOT talk to Mongo. It MUST be called BEFORE the
 * route's own saveDB(db,{durable:true}) (as before), so this completion is
 * included in that SAME durable write (the batched file write, or the
 * batched Mongo EntityChunk flush for the 'idempotencyRecords' key) as the
 * financial mutation itself. The PREVIOUS version additionally performed an
 * immediate, independently-awaited write to the dedicated Mongo
 * IdempotencyRecord collection right here — BEFORE the caller's saveDB —
 * which meant a crash between this call and that saveDB call left the
 * dedicated collection durably COMPLETED with NO durable financial mutation
 * behind it: a retry would then return idempotentReplay:true referencing
 * data that was silently lost. That dedicated-collection write now lives in
 * finalizeIdempotencyClaimMongo() below, which callers MUST invoke ONLY
 * AFTER their own saveDB(db,{durable:true}) has already succeeded — see
 * docs/FINANCIAL_IDEMPOTENCY_ARCHITECTURE.md for the full write-order
 * contract every wired route follows.
 */
function completeIdempotencyClaim(db, isMongo, record, resultReference, sourceId, journalId) {
  record.status = 'COMPLETED';
  record.resultReference = _snapshot(resultReference);
  record.sourceId = sourceId || null;
  record.journalId = journalId || null;
  record.completedAt = new Date().toISOString();

  if (!db.idempotencyRecords) db.idempotencyRecords = [];
  const idx = db.idempotencyRecords.findIndex(r => r.tenantId === record.tenantId && r.operationScope === record.operationScope && r.key === record.key);
  if (idx >= 0) db.idempotencyRecords[idx] = record; else db.idempotencyRecords.push(record);
}

/**
 * The Mongo-only second half of completion — the dedicated IdempotencyRecord
 * collection's own durable write (see completeIdempotencyClaim()'s comment
 * for why this is split out). Callers must await this ONLY after their own
 * saveDB(db,{durable:true}) has already resolved successfully. A no-op for
 * file mode (nothing to call this for — file mode's completion is already
 * fully durable via the single saveDB(durable:true) call that persists
 * db.idempotencyRecords[] together with everything else).
 */
async function finalizeIdempotencyClaimMongo(record) {
  const IdempotencyRecord = require('../models/IdempotencyRecord');
  await IdempotencyRecord.updateOne(
    { tenantId: record.tenantId, operationScope: record.operationScope, key: record.key },
    { $set: { status: 'COMPLETED', resultReference: record.resultReference, sourceId: record.sourceId, journalId: record.journalId, completedAt: new Date(record.completedAt) } }
  );
}

/**
 * Releases a claim that must NOT block a future retry. Two cases:
 *   (a) the caller is certain no financial mutation was attempted (a
 *       failure caught strictly BEFORE any journal/subledger write, e.g.
 *       validation rejected the request), or
 *   (b) completeIdempotencyClaim() already ran (step 3 of the write-order
 *       contract above) but the subsequent saveDB(db,{durable:true}) then
 *       failed — the in-memory record now optimistically says COMPLETED
 *       with no durable write behind it, and MUST be released rather than
 *       left to fool a same-process retry into replaying a mutation that
 *       was never actually saved (P0.12 adversarial-review fix).
 * Removes the record entirely so the next attempt claims fresh.
 */
async function releaseIdempotencyClaim(db, isMongo, record) {
  if (db.idempotencyRecords) {
    db.idempotencyRecords = db.idempotencyRecords.filter(r => !(r.tenantId === record.tenantId && r.operationScope === record.operationScope && r.key === record.key));
  }
  if (isMongo) {
    const IdempotencyRecord = require('../models/IdempotencyRecord');
    try { await IdempotencyRecord.deleteOne({ tenantId: record.tenantId, operationScope: record.operationScope, key: record.key }); }
    catch (_) { /* best-effort — a leftover PROCESSING record just self-heals via PROCESSING_TIMEOUT_MS */ }
  }
}

module.exports = {
  IdempotencyConflictError,
  extractIdempotencyKey,
  validateIdempotencyKey,
  computeFingerprint,
  claimIdempotencyKeySync,
  claimIdempotencyKeyMongo,
  claimIdempotencyKey,
  completeIdempotencyClaim,
  finalizeIdempotencyClaimMongo,
  releaseIdempotencyClaim,
  PROCESSING_TIMEOUT_MS,
};
