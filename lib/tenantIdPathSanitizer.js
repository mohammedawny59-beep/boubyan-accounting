'use strict';
// Shared by scripts/tenant-backup.js and scripts/tenant-restore.js so the
// two tools can never silently diverge on this exact logic (owner-review
// LOW finding, final-PR-review lock remediation) — previously duplicated
// verbatim in both files.
//
// tenantId is operator-supplied CLI input, not network-reachable, but is
// interpolated into generated backup/checkpoint/staging/lock file paths —
// unlike lib/database.js's own _tenantFilePath()/_tenantConfigFilePath(),
// which sanitize for exactly this reason. Applied ONLY to the filesystem-
// path form — the real, unsanitized tenantId is still what every Mongo
// query/backup-content field/audit event uses.
//
// Collision-resistance (owner-review LOW finding, deterministic-lock
// redesign pass): a plain "replace every disallowed character with _" is
// lossy — 'clinic/A', 'clinic.A', and 'clinic A' would all collide on the
// identical 'clinic_A'. Two different tenants' checkpoint/staging/backup
// files could then be misread as belonging to each other. Fixed by
// appending a short content hash of the ORIGINAL id whenever sanitization
// actually changes anything — an already-safe id (the overwhelmingly
// common case; every real tenant id in this codebase's own tests and
// fixtures) is returned byte-identical, unchanged, so no existing
// checkpoint/staging/backup file naming is affected.
const crypto = require('crypto');

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeTenantIdForPath(tenantId) {
  const raw = String(tenantId);
  if (SAFE_ID_RE.test(raw)) return raw;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${safe}-${hash}`;
}

module.exports = { sanitizeTenantIdForPath };
