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

module.exports = { computeChecksum, validateBackupObject, validateBackupFile, extractTenantIds };
