'use strict';
/**
 * P0.4 — Financial & security audit trail.
 *
 * Reuses the existing `db.auditLog` array (already part of ENTITY_KEYS /
 * emptyDBShape in lib/database.js, already written to in 5 places before
 * this milestone: password-reset x2, COA self-repair x3) as the single
 * append-only event log — no new persisted collection/entity was created.
 * This module only adds a structured event builder, a recursive sanitizer,
 * a before/after diff helper, and a bounded-size append function so every
 * caller produces a consistent, safe event shape instead of the ad-hoc
 * inline objects the 5 pre-existing call sites used.
 */

const MAX_AUDIT_LOG = 5000; // bounded, like the existing errorLog's 200-cap pattern (server.js logCrash)

// Recursively strip anything that must never be persisted in an audit event.
// P0.4A: broadened from just "password" to also catch smtpPass/pwd/pass-style
// integration-credential field names (e.g. lib/config's smtpPass) that don't
// contain the literal substring "password" but are exactly as sensitive.
const SENSITIVE_KEY_RE = /(password|passwordhash|pwd|pass$|^pass|token|secret|authorization|apikey|api_key|jwt|clientsecret|privatekey)/i;

function sanitizeForAudit(value, depth) {
  depth = depth || 0;
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map(v => sanitizeForAudit(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k)) { out[k] = '[REDACTED]'; continue; }
      out[k] = sanitizeForAudit(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && /^Bearer\s+/i.test(value)) return '[REDACTED]';
  return value;
}

/**
 * Structured diff between two plain objects — only the fields that actually
 * changed, never a full-object dump (Step 10).
 */
function diffFields(before, after) {
  const b = sanitizeForAudit(before || {});
  const a = sanitizeForAudit(after || {});
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const changedFields = [];
  const beforeOut = {}, afterOut = {};
  for (const k of keys) {
    const bv = b[k], av = a[k];
    const same = JSON.stringify(bv) === JSON.stringify(av);
    if (!same) {
      changedFields.push(k);
      if (bv !== undefined) beforeOut[k] = bv;
      if (av !== undefined) afterOut[k] = av;
    }
  }
  return { changedFields, before: beforeOut, after: afterOut };
}

let _seq = 0;
function nextId() {
  _seq = (_seq + 1) % 1e6;
  return `AUD-${Date.now()}-${_seq}`;
}

/**
 * Build a well-formed audit event. Every field the schema promises is
 * always present (null when not applicable) so consumers never have to
 * guess at shape.
 *
 * @param {object} opts
 * @param {object} opts.req        Express request (for actor/ip/userAgent/tenant) — optional
 * @param {string} opts.action     e.g. 'journal.create', 'user.role_changed'
 * @param {string} opts.resourceType e.g. 'journal', 'payroll', 'user'
 * @param {string} [opts.resourceId]
 * @param {'success'|'failure'} [opts.outcome]
 * @param {string} [opts.source]  route/function identifier, defaults to req.path
 * @param {object} [opts.before]
 * @param {object} [opts.after]
 * @param {object} [opts.metadata] small, bounded extra context
 */
function buildAuditEvent(opts) {
  const req = opts.req || {};
  const user = req.user || {};
  const diff = (opts.before !== undefined || opts.after !== undefined)
    ? diffFields(opts.before, opts.after)
    : { changedFields: [], before: undefined, after: undefined };

  return {
    id: nextId(),
    timestamp: new Date().toISOString(),
    tenantId: req.tenantId || user.tenantId || 'default',
    actorUserId: user.id || null,
    actorUsername: user.username || null,
    actorRole: user.role || null,
    action: opts.action,
    resourceType: opts.resourceType || null,
    resourceId: opts.resourceId != null ? String(opts.resourceId) : null,
    outcome: opts.outcome || 'success',
    source: opts.source || req.path || null,
    requestId: req.id || req.headers?.['x-request-id'] || null,
    ip: (req.ip || req.headers?.['x-forwarded-for'] || null),
    userAgent: req.headers?.['user-agent'] ? String(req.headers['user-agent']).slice(0, 200) : null,
    before: diff.before !== undefined ? sanitizeForAudit(diff.before) : undefined,
    after: diff.after !== undefined ? sanitizeForAudit(diff.after) : undefined,
    changedFields: diff.changedFields.length ? diff.changedFields : undefined,
    metadata: opts.metadata ? sanitizeForAudit(opts.metadata) : undefined,
  };
}

/**
 * Append-only write: unshift (newest-first, matching the existing errorLog
 * convention) + hard size cap. No update/delete path is exposed anywhere —
 * this is the ONLY function in the codebase that writes to db.auditLog.
 * Does not call saveDB() itself — callers append this to the SAME in-memory
 * db object as their business mutation so both commit in the same
 * saveDB() call (Step 14 — one logical save boundary; see server.js call
 * sites and the P0.4 report's "Audit Persistence Guarantees" section for
 * the documented limitation this implies).
 */
function appendAuditEvent(db, opts) {
  const event = buildAuditEvent(opts);
  db.auditLog = db.auditLog || [];
  db.auditLog.unshift(event);
  if (db.auditLog.length > MAX_AUDIT_LOG) db.auditLog.length = MAX_AUDIT_LOG;
  return event;
}

module.exports = { sanitizeForAudit, diffFields, buildAuditEvent, appendAuditEvent, MAX_AUDIT_LOG };
