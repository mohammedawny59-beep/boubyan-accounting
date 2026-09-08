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

/**
 * Full file-level validation: existence, non-zero size, JSON parses,
 * structural keys, and checksum (if a `<file>.sha256` sidecar exists).
 * Never throws — always returns a result object.
 */
function validateBackupFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, problems: [`file does not exist: ${filePath}`] };
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return { ok: false, problems: ['file is empty (0 bytes)'] };
  }

  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { return { ok: false, problems: [`cannot read file: ${e.message}`] }; }

  let backup;
  try { backup = JSON.parse(raw); }
  catch (e) { return { ok: false, problems: [`not valid JSON: ${e.message}`] }; }

  const structural = validateBackupObject(backup);
  const problems = [...structural.problems];

  let checksumOk = null;
  const sidecarPath = filePath + '.sha256';
  if (fs.existsSync(sidecarPath)) {
    try {
      const expected = fs.readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0];
      const actual = computeChecksum(raw);
      checksumOk = expected === actual;
      if (!checksumOk) problems.push(`checksum mismatch (sidecar says ${expected}, file hashes to ${actual})`);
    } catch (e) {
      checksumOk = false;
      problems.push(`could not read checksum sidecar: ${e.message}`);
    }
  }

  return {
    ok: structural.ok && checksumOk !== false,
    problems,
    checksumOk,
    tenantIds: extractTenantIds(backup),
    createdAt: backup?.createdAt,
    version: backup?.version,
    source: backup?.source,
    sizeBytes: stat.size,
  };
}

module.exports = {
  computeChecksum, validateBackupObject, validateBackupFile, extractTenantIds,
  canonicalJson, stripMongoMeta, computeCategoryDigest,
};
