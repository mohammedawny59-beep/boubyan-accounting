'use strict';
/**
 * P0.5 — Step 9/10: shared, pure backup-file validation logic.
 *
 * Used by BOTH scripts/verify-backup.js (operator-facing check) and
 * scripts/restore.js (refuse-before-writing gate) so the two can never
 * silently drift apart — one gate, two callers. Every function here only
 * READS from the filesystem; nothing in this module ever writes, deletes,
 * or connects to a database. That keeps it safe to unit-test directly
 * (tests/production-hardening.test.js — Backup B/C, Restore B) without any
 * real backup file, Mongo connection, or production data involved.
 */
const fs = require('fs');
const crypto = require('crypto');

function computeChecksum(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// P4 — Phase D (research.md Decision 6/9, data-model.md "New logical file
// format 1"): deterministic canonicalization so two logically-identical
// record sets always hash the same, regardless of key-insertion order or
// array element order. Recursively sorts object keys at every depth; for an
// array whose elements are all plain objects sharing a stable identity
// field (`id` for user-shaped records, `key` for entity-chunk/config-shaped
// records), sorts the array by that field FIRST, before the recursive
// key-sorting pass reaches its elements — an array with no uniform `id`/
// `key` field is left in its original order (nothing in this feature's own
// digest use ever needs to canonicalize such an array).
function _stableArraySort(arr) {
  if (!arr.every(el => el && typeof el === 'object' && !Array.isArray(el))) return arr;
  let field = null;
  if (arr.every(el => el.id !== undefined)) field = 'id';
  else if (arr.every(el => el.key !== undefined)) field = 'key';
  if (!field) return arr;
  return [...arr].sort((a, b) => {
    const av = String(a[field]), bv = String(b[field]);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return _stableArraySort(value).map(canonicalJson);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalJson(value[k]);
    return out;
  }
  return value;
}

// P4 — Phase D: strips Mongoose's own `_id`/`__v` before every digest
// computation — mandatory even though the STORED backup collections keep
// `_id` on Mongo-sourced records (matching scripts/backup.js's existing,
// unmodified precedent). Without stripping first, a Mongo-sourced backup's
// own digest (hashed over `_id`-bearing records) could never match
// restore's own recompute (hashed over `_id`-stripped staged/re-queried
// records) — every real restore would fail its own integrity check.
function stripMongoMeta(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const { _id, __v, ...rest } = record;
  return rest;
}

// The single, only function used to compute a `categoryDigests.<cat>` value
// anywhere in this codebase — at backup-write time, restore-staging's
// recompute, and restore-apply's live re-check alike — so all three stay
// consistent by construction.
function computeCategoryDigest(records) {
  const stripped = (records || []).map(stripMongoMeta);
  return computeChecksum(JSON.stringify(canonicalJson(stripped)));
}

/** Structural validation of an already-parsed backup object. */
function validateBackupObject(backup) {
  const problems = [];
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    return { ok: false, problems: ['backup content is not a JSON object'] };
  }
  // P4 — Phase E (research.md Decision 7, "Whole-Instance Separation"):
  // additive, deliberate guard — a tenant-scoped file must never be fed to
  // the whole-instance scripts/restore.js. An absent scope (every existing
  // whole-instance backup, past and future) is completely unaffected.
  if (backup.scope === 'tenant') {
    return { ok: false, problems: ['this is a tenant-scoped backup file — use scripts/tenant-restore.js'] };
  }
  if (!backup.createdAt) problems.push('missing createdAt');
  if (!backup.version) problems.push('missing version');
  if (!backup.source) problems.push('missing source');
  if (backup.source && !['mongodb', 'file'].includes(backup.source)) {
    problems.push(`unknown source "${backup.source}" (expected "mongodb" or "file")`);
  }
  if (backup.source === 'mongodb') {
    if (!backup.collections || typeof backup.collections !== 'object') {
      problems.push('mongodb backup is missing "collections"');
    } else {
      for (const key of ['users', 'entityChunks', 'appConfigs', 'tenants', 'subscriptions']) {
        if (!(key in backup.collections)) problems.push(`missing collections.${key}`);
      }
    }
  } else if (backup.source === 'file') {
    if (!backup.database) problems.push('file backup is missing "database"');
  }
  return { ok: problems.length === 0, problems };
}

// P4 — Phase E (research.md Decision 7/8, tenant-restore-contract.md Step 1,
// sub-steps 2-7): structural validation of an already-parsed TENANT-scoped
// backup object. Additive — validateBackupObject() above is completely
// unaffected by this function's existence. Never touches the filesystem;
// the fingerprint-vs-checkpoint check (Step 1.8) needs the checkpoint file
// and lives in scripts/tenant-restore.js itself, not here.
function validateTenantBackupObject(backup, targetTenantId) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    return { ok: false, problems: ['backup content is not a JSON object'] };
  }
  const problems = [];

  if (backup.scope !== 'tenant') {
    problems.push('not a tenant-scoped backup (backup.scope must be "tenant")');
  }
  if (backup.schemaVersion !== 1) {
    problems.push(`unsupported schemaVersion "${backup.schemaVersion}" (expected 1)`);
  }
  if (typeof backup.tenantId !== 'string' || !backup.tenantId) {
    problems.push('missing or ambiguous tenantId');
  } else if (targetTenantId != null && backup.tenantId !== targetTenantId) {
    problems.push(`tenant mismatch: backup covers "${backup.tenantId}", restore target is "${targetTenantId}"`);
  }

  const collections = backup.collections;
  if (!collections || typeof collections !== 'object' || Array.isArray(collections)) {
    problems.push('missing collections');
  } else {
    for (const key of ['users', 'entityChunks', 'appConfigs']) {
      if (!Array.isArray(collections[key])) problems.push(`missing or non-array collections.${key}`);
    }
    // research.md Decision 10 — a leftover shape from an incompatible producer.
    if ('tenants' in collections) problems.push('collections.tenants present — not a valid tenant-scoped shape (research.md Decision 10)');
    if ('subscriptions' in collections) problems.push('collections.subscriptions present — not a valid tenant-scoped shape (research.md Decision 10)');
    // research.md Decision 8 — defense in depth, independent of whether the
    // backup tool itself behaved correctly (a hand-edited/future-version file).
    if ('idempotencyRecords' in collections) problems.push('collections.idempotencyRecords present — not a valid tenant-scoped shape');
    if (Array.isArray(collections.entityChunks)) {
      for (const reserved of ['idempotencyRecords', '__restoreLock__', 'auditLog']) {
        if (collections.entityChunks.some(c => c && c.key === reserved)) {
          problems.push(`collections.entityChunks contains a reserved/excluded key "${reserved}"`);
        }
      }
    }

    // Record-count / digest integrity (research.md Decision 6, third pass) —
    // a backup file hand-edited after being written is caught here.
    for (const cat of ['users', 'entityChunks', 'appConfigs']) {
      const arr = collections[cat];
      if (!Array.isArray(arr)) continue; // already flagged above
      const expectedCount = backup.recordCounts?.[cat];
      if (expectedCount !== arr.length) {
        problems.push(`recordCounts.${cat} (${expectedCount}) does not match collections.${cat}.length (${arr.length})`);
      }
      const expectedDigest = backup.categoryDigests?.[cat];
      const actualDigest = computeCategoryDigest(arr);
      if (expectedDigest !== actualDigest) {
        problems.push(`categoryDigests.${cat} does not match a freshly-computed digest of collections.${cat}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Best-effort extraction of every tenantId referenced in the backup — for
 * the "tenant identity is present" verification requirement and for the
 * operator to see at a glance which tenants a given backup covers. */
function extractTenantIds(backup) {
  const ids = new Set();
  if (backup?.source === 'mongodb' && backup.collections) {
    for (const coll of Object.values(backup.collections)) {
      if (Array.isArray(coll)) for (const doc of coll) if (doc?.tenantId) ids.add(doc.tenantId);
    }
  } else if (backup?.source === 'file' && backup.database?.users) {
    for (const u of backup.database.users) if (u?.tenantId) ids.add(u.tenantId);
    if (!ids.size) ids.add('default'); // single-clinic file-mode has no tenantId field at all
  }
  return [...ids].sort();
}

// Shared file mechanics: existence, non-zero size, JSON parses, and checksum
// (if a `<file>.sha256` sidecar exists) — the part validateBackupFile() and
// validateTenantBackupFile() both need identically, regardless of which
// object-level validator (whole-instance vs. tenant-scoped) runs next.
// Never throws. `checksum` is always the file's own actual sha256 (even
// with no sidecar present) so a caller doing a fingerprint comparison (Step
// 1.8) never has to hash the file a second time.
function _readAndVerifyChecksum(filePath) {
  if (!fs.existsSync(filePath)) {
    return { fatal: true, problems: [`file does not exist: ${filePath}`] };
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return { fatal: true, problems: ['file is empty (0 bytes)'] };
  }

  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { return { fatal: true, problems: [`cannot read file: ${e.message}`] }; }

  let backup;
  try { backup = JSON.parse(raw); }
  catch (e) { return { fatal: true, problems: [`not valid JSON: ${e.message}`] }; }

  const problems = [];
  const checksum = computeChecksum(raw);
  let checksumOk = null;
  const sidecarPath = filePath + '.sha256';
  if (fs.existsSync(sidecarPath)) {
    try {
      const expected = fs.readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0];
      checksumOk = expected === checksum;
      if (!checksumOk) problems.push(`checksum mismatch (sidecar says ${expected}, file hashes to ${checksum})`);
    } catch (e) {
      checksumOk = false;
      problems.push(`could not read checksum sidecar: ${e.message}`);
    }
  }

  return { fatal: false, problems, checksumOk, checksum, backup, sizeBytes: stat.size };
}

/**
 * Full file-level validation: existence, non-zero size, JSON parses,
 * structural keys, and checksum (if a `<file>.sha256` sidecar exists).
 * Never throws — always returns a result object.
 */
function validateBackupFile(filePath) {
  const r = _readAndVerifyChecksum(filePath);
  if (r.fatal) return { ok: false, problems: r.problems };

  const structural = validateBackupObject(r.backup);
  const problems = [...structural.problems, ...r.problems];
  return {
    ok: structural.ok && r.checksumOk !== false,
    problems,
    checksumOk: r.checksumOk,
    tenantIds: extractTenantIds(r.backup),
    createdAt: r.backup?.createdAt,
    version: r.backup?.version,
    source: r.backup?.source,
    sizeBytes: r.sizeBytes,
  };
}

// P4 — Phase E: file-level validation for a TENANT-scoped backup file
// (tenant-restore-contract.md Step 1.1-1.7) — same shared file mechanics as
// validateBackupFile() above, but structural checks go through
// validateTenantBackupObject() instead. Returns the parsed `backup` object
// and its own `checksum` too, since scripts/tenant-restore.js's Step 1.8
// fingerprint check needs both and must not re-read/re-hash the file.
function validateTenantBackupFile(filePath, targetTenantId) {
  const r = _readAndVerifyChecksum(filePath);
  if (r.fatal) return { ok: false, problems: r.problems };

  const structural = validateTenantBackupObject(r.backup, targetTenantId);
  const problems = [...structural.problems, ...r.problems];
  return {
    ok: structural.ok && r.checksumOk !== false,
    problems,
    checksumOk: r.checksumOk,
    checksum: r.checksum,
    backup: r.backup,
    tenantId: r.backup?.tenantId,
    createdAt: r.backup?.createdAt,
    schemaVersion: r.backup?.schemaVersion,
    source: r.backup?.source,
    sizeBytes: r.sizeBytes,
  };
}

module.exports = {
  computeChecksum, validateBackupObject, validateBackupFile, extractTenantIds,
  canonicalJson, stripMongoMeta, computeCategoryDigest,
  validateTenantBackupObject, validateTenantBackupFile,
};
