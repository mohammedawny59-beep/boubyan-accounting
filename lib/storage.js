'use strict';
/**
 * P0.5A — Objective A: minimal storage abstraction.
 *
 * Forensic finding (see P0.5A report §3): every current upload flow in this
 * codebase (Excel imports, OCR invoice images, Telegram document/photo
 * downloads) is TRANSIENT — read once, parsed into normal DB records, then
 * discarded. `db.uploadedFiles` is a metadata-only import log (name/type/
 * record count) — it has never stored a file path or served file content
 * back. There is currently NO "permanent business document" feature.
 *
 * This module exists anyway, narrowly, because:
 *   1. Step 4's tenant-safe key generation directly fixes a real path-
 *      traversal bug (server.js's Telegram document handler built a disk
 *      path from the attacker-influenced Telegram filename).
 *   2. Step 2/3 ask for the abstraction + fail-closed config validation to
 *      exist BEFORE any future "store this invoice permanently" feature is
 *      built, so that feature never has to couple directly to `uploads/`.
 *
 * It is deliberately NOT wired into the 5 already-safe Excel-import routes
 * (they delete their temp file immediately after parsing, before any
 * business logic that could throw — already correct) — rewiring working
 * code with no bug is exactly the "broad infrastructure rewrite" this
 * milestone was told not to become.
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

// ─── Tenant-safe key generation (Step 4) ───────────────────────────────────

// Only a fixed allow-list of extensions is ever honored — anything else
// (including no extension, or an extension containing path separators) is
// replaced with `.bin`. The ORIGINAL filename is never used to build a path;
// callers that want to preserve it must store it separately as metadata.
const SAFE_EXT_RE = /^\.(xlsx|xls|csv|pdf|jpg|jpeg|png|webp|txt)$/i;

function _safeExtOf(originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  return SAFE_EXT_RE.test(ext) ? ext : '.bin';
}

/**
 * Build a server-controlled, tenant-scoped storage key. NEVER derives any
 * path SEGMENT from user input — tenantId and category are validated
 * against a strict charset, the filename only contributes its (allow-
 * listed) extension, and the unique component is a server-generated UUID.
 * This makes path traversal (`../`, absolute paths, embedded separators)
 * structurally impossible rather than something to remember to sanitize at
 * every call site.
 *
 * @param {string} tenantId
 * @param {string} category   e.g. 'invoices', 'imports', 'ocr-temp'
 * @param {string} [originalName] only its extension is used, if allow-listed
 * @returns {string} e.g. "tenants/default/invoices/6c1b...-...-....pdf"
 */
function buildTenantKey(tenantId, category, originalName) {
  const safeTenant = String(tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  const safeCategory = String(category || 'misc').replace(/[^a-zA-Z0-9_-]/g, '_') || 'misc';
  const ext = _safeExtOf(originalName);
  const unique = crypto.randomUUID();
  return `tenants/${safeTenant}/${safeCategory}/${unique}${ext}`;
}

// ─── Config validation (Step 3 — fail closed) ──────────────────────────────

/**
 * Pure validation — never touches the filesystem/network, never throws.
 * Mirrors lib/secretValidation.js's shape/pattern so the two are reviewed
 * together easily.
 * @param {object} env  process.env (or an isolated fake for tests)
 */
function validateStorageConfig(env) {
  const problems = [];
  const mode = (env.UPLOAD_STORAGE || 'local').toLowerCase();

  if (!['local', 's3'].includes(mode)) {
    problems.push({ level: 'fatal', code: 'UPLOAD_STORAGE_UNKNOWN_MODE', message: `UPLOAD_STORAGE="${mode}" is not "local" or "s3"` });
    return { ok: false, mode, problems };
  }

  if (mode === 's3') {
    const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
    for (const key of required) {
      if (!env[key]) problems.push({ level: 'fatal', code: `${key}_MISSING`, message: `UPLOAD_STORAGE=s3 requires ${key}, which is not set` });
    }
  }

  // Production must not silently default to "local" just because s3 wasn't
  // configured — that's exactly the silent-fallback pattern P0.5 closed for
  // Mongo. "local" is only safe when CHOSEN explicitly.
  if (env.NODE_ENV === 'production' && !env.UPLOAD_STORAGE) {
    problems.push({ level: 'warn', code: 'UPLOAD_STORAGE_UNSET_IN_PRODUCTION', message: 'UPLOAD_STORAGE is not set — defaulting to "local", which is only durable with an explicitly attached persistent disk' });
  }

  const fatal = problems.some(p => p.level === 'fatal');
  return { ok: !fatal, mode, problems };
}

// ─── Local adapter ──────────────────────────────────────────────────────────

function _localRoot(rootDir) {
  return rootDir || path.join(__dirname, '..', 'uploads', 'store');
}

function _resolveLocalPath(rootDir, key) {
  const root = path.resolve(_localRoot(rootDir));
  // Belt-and-suspenders: even though buildTenantKey() never produces a
  // traversal-capable key, any caller passing a raw key straight through
  // (e.g. one read back from an old DB record) is still checked here —
  // resolve() collapses "..", then confirm the result is still under root.
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`storage key escapes root: ${key}`);
  }
  return resolved;
}

function createLocalAdapter(rootDir) {
  return {
    mode: 'local',
    async save(key, buffer) {
      const p = _resolveLocalPath(rootDir, key);
      await fs.ensureDir(path.dirname(p));
      await fs.writeFile(p, buffer);
      return { key };
    },
    async read(key) {
      return fs.readFile(_resolveLocalPath(rootDir, key));
    },
    async delete(key) {
      await fs.remove(_resolveLocalPath(rootDir, key));
    },
    async exists(key) {
      return fs.pathExists(_resolveLocalPath(rootDir, key));
    },
  };
}

// ─── S3-compatible adapter (SigV4 over Node's built-in https — no new
// dependency) ────────────────────────────────────────────────────────────
// NEVER exercised against a real endpoint in this repository (no live S3
// credentials exist here, and this milestone forbids invoking real external
// services). Signature computation has a determinism/structural regression
// test (tests/production-hardening-p05a.test.js "Storage" section,
// `_sigV4` test) — it is NOT verified against AWS's official published
// SigV4 test-suite vectors, since this environment has no network access to
// fetch or independently confirm those values, and hand-typing a remembered
// "golden" signature would risk baking in a wrong value that always passes
// for the wrong reason. Operators MUST smoke-test against their real
// S3-compatible endpoint before relying on this in production — see
// docs/UPLOAD_STORAGE_MIGRATION.md.

function _sigV4(opts) {
  const { method, host, path: reqPath, region, service, accessKeyId, secretAccessKey, payloadHash, extraHeaders = {} } = opts;
  const now = opts.now || new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extraHeaders };
  const signedHeaderNames = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames.map(h => `${h}:${headers[Object.keys(headers).find(k => k.toLowerCase() === h)]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [method, reqPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { amzDate, authorization, signedHeaders };
}

function createS3Adapter(cfg) {
  const https = require('https');
  const http = require('http');
  const { URL } = require('url');

  function request(method, key, body) {
    return new Promise((resolve, reject) => {
      const endpoint = new URL(cfg.endpoint);
      const reqPath = `/${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
      const payload = body || Buffer.alloc(0);
      const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
      const { amzDate, authorization } = _sigV4({
        method, host: endpoint.host, path: reqPath,
        region: cfg.region || 'us-east-1', service: 's3',
        accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
        payloadHash,
      });
      const client = endpoint.protocol === 'http:' ? http : https;
      const req = client.request({
        hostname: endpoint.hostname, port: endpoint.port || undefined, path: reqPath, method,
        headers: {
          Host: endpoint.host,
          'X-Amz-Date': amzDate,
          'X-Amz-Content-Sha256': payloadHash,
          Authorization: authorization,
          'Content-Length': payload.length,
        },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, body: responseBody });
          else if (res.statusCode === 404) resolve({ statusCode: 404, body: responseBody });
          else reject(new Error(`S3 ${method} ${key} failed: HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      if (payload.length) req.write(payload);
      req.end();
    });
  }

  return {
    mode: 's3',
    async save(key, buffer) {
      await request('PUT', key, buffer);
      return { key };
    },
    async read(key) {
      const res = await request('GET', key);
      if (res.statusCode === 404) throw new Error(`storage key not found: ${key}`);
      return res.body;
    },
    async delete(key) {
      await request('DELETE', key);
    },
    async exists(key) {
      const res = await request('HEAD', key).catch(e => (e.message.includes('404') ? { statusCode: 404 } : Promise.reject(e)));
      return res.statusCode !== 404;
    },
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

function getStorage(env = process.env) {
  const { ok, mode, problems } = validateStorageConfig(env);
  if (!ok) {
    const msg = problems.filter(p => p.level === 'fatal').map(p => p.message).join('; ');
    throw new Error(`Storage configuration invalid: ${msg}`);
  }
  if (mode === 's3') {
    return createS3Adapter({
      endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
  }
  return createLocalAdapter(env.UPLOAD_LOCAL_ROOT);
}

module.exports = {
  buildTenantKey,
  validateStorageConfig,
  createLocalAdapter,
  createS3Adapter,
  getStorage,
  _sigV4, // exported for SigV4 test-vector verification only
};
