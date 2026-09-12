#!/usr/bin/env node
'use strict';
/**
 * نسخ احتياطي لبيانات مستأجر واحد فقط — Tenant-Scoped Backup
 *
 * يصدّر فقط users + entityChunks (المستثنيات: idempotencyRecords, auditLog,
 * __restoreLock__) + appConfigs لمستأجر واحد محدّد إلى
 * backups/tenant-<tenantId>-<stamp>.json (+ .sha256). لا يمسّ Tenant/
 * Subscription إطلاقاً (خارج النطاق — specs/002.../research.md Decision 10).
 *
 * لا يُعدّل scripts/backup.js أو npm run backup بأي شكل — أداة مستقلة تماماً.
 *
 * التشغيل:  node scripts/tenant-backup.js --tenant=<المعرّف>
 * الاستعادة: node scripts/tenant-restore.js backups/tenant-<...>.json --tenant=<المعرّف>
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { computeChecksum, computeCategoryDigest } = require('../lib/backupValidation');
const { appendAuditEvent } = require('../lib/auditLog');
const {
  TENANT_BACKUP_ENTITY_KEYS, _tenantFilePath, _tenantConfigFilePath,
  _setDataFileForTooling, _atomicWriteJsonSync,
} = require('../lib/database');
const User = require('../models/User');
const EntityChunk = require('../models/EntityChunk');
const AppConfig = require('../models/AppConfig');
const Tenant = require('../models/Tenant');

const ROOT        = path.join(__dirname, '..');
const BACKUP_DIR  = process.env.BACKUP_DIR || path.join(ROOT, 'backups');
const TENANT_BACKUP_KEEP = Number(process.env.TENANT_BACKUP_KEEP || 30);
const MONGO_URI   = process.env.MONGO_URI;
const DATA_FILE   = process.env.DATA_FILE   || path.join(ROOT, 'data', 'database.json');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(ROOT, 'data', 'config.json');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Owner-review finding (final PR review, LOW): --tenant= is operator-
// supplied CLI input, not network-reachable, but was interpolated
// unsanitized into the generated backup filename — unlike
// lib/database.js's own _tenantFilePath(), which already sanitizes for
// exactly this reason. A value containing path separators could otherwise
// write outside BACKUP_DIR. Applied ONLY to the filesystem-path form of
// the tenantId — the real, unsanitized tenantId is still what every Mongo
// query/backup-content field/audit event uses.
function sanitizeTenantIdForPath(tenantId) {
  return String(tenantId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Mirrors lib/database.js:427-429's own _defaultTenantFilter exactly — not
// exported by that module (only _tenantFilePath/_tenantConfigFilePath are,
// per tasks.md T027), reproduced here verbatim rather than widening that
// module's export surface for one literal object every consumer, including
// this codebase's own tests, already reproduces the same way.
const _defaultTenantFilter = {
  $or: [{ tenantId: 'default' }, { tenantId: { $exists: false } }, { tenantId: null }],
};

class BackupFailure extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}

function parseArgs(argv) {
  let tenantId = null;
  for (const arg of argv) {
    const m = /^--tenant=(.*)$/.exec(arg);
    if (m) tenantId = m[1];
  }
  return { tenantId: tenantId && tenantId.trim() ? tenantId.trim() : null };
}

function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

// T031 — default-tenant duplicate-identity pre-flight (research.md Decision
// 16): a detection gate, never a repair. Only meaningful in Mongo mode —
// file mode's single-blob-per-tenant storage cannot physically hold two
// separate documents for the same identity the way Mongo can.
async function findDefaultDuplicates() {
  const problems = [];

  const users = await User.find(_defaultTenantFilter).lean();
  const usersById = new Map();
  for (const u of users) {
    if (!usersById.has(u.id)) usersById.set(u.id, []);
    usersById.get(u.id).push(u);
  }
  for (const [id, docs] of usersById) {
    if (docs.length > 1) problems.push({ category: 'users', identity: id, ids: docs.map(d => String(d._id)) });
  }

  for (const [category, Model] of [['entityChunks', EntityChunk], ['appConfigs', AppConfig]]) {
    const docs = await Model.find(_defaultTenantFilter).lean();
    const byKey = new Map();
    for (const d of docs) {
      if (!byKey.has(d.key)) byKey.set(d.key, []);
      byKey.get(d.key).push(d);
    }
    for (const [key, ds] of byKey) {
      if (ds.length > 1) problems.push({ category, identity: key, ids: ds.map(d => String(d._id)) });
    }
  }
  return problems;
}

// T031a — non-default tenant existence/active-status pre-check (research.md
// Decision 21), Mongo mode only — reuses lib/tenantMiddleware.js:72-73's
// existing pattern verbatim.
async function isNonDefaultTenantActive(tenantId) {
  const tenant = await Tenant.findOne({ tenantId }).lean();
  return !!tenant && tenant.status === 'active';
}

// T032 — Mongo-mode collection queries, TENANT_BACKUP_ENTITY_KEYS only.
async function queryMongo(tenantId) {
  const filter = tenantId === 'default' ? _defaultTenantFilter : { tenantId };
  const users = await User.find(filter).lean();
  const entityChunks = await EntityChunk.find({ ...filter, key: { $in: TENANT_BACKUP_ENTITY_KEYS } }).lean();
  const appConfigs = await AppConfig.find({ ...filter, key: 'config' }).lean();
  return { users, entityChunks, appConfigs };
}

// T033 — file-mode transform into the same unified shape Mongo mode
// produces (research.md Decision 9). A non-default tenant that has never
// persisted anything gets an empty blob (Decision 21's file-mode carve-out
// — a missing file is never treated as "tenant does not exist").
function queryFile(tenantId, backupCreatedAt) {
  let blob, cfgBlob;
  if (tenantId === 'default') {
    blob = readJsonSafe(DATA_FILE) || {};
    cfgBlob = readJsonSafe(CONFIG_FILE);
  } else {
    blob = readJsonSafe(_tenantFilePath(tenantId)) || {};
    cfgBlob = readJsonSafe(_tenantConfigFilePath(tenantId));
  }

  const users = blob.users || [];
  const appConfigs = cfgBlob != null
    ? [{ tenantId, key: 'config', data: cfgBlob, updatedAt: backupCreatedAt }]
    : [];
  // !=null (loose) deliberately catches both undefined and an explicit null
  // — matching Mongoose's own required:true rejection of both (Decision 9,
  // third-pass tightening). passwordResets/errorLog are real ENTITY_KEYS
  // members genuinely absent from a tenant that never triggered either.
  const entityChunks = TENANT_BACKUP_ENTITY_KEYS
    .filter(key => blob[key] != null)
    .map(key => ({ tenantId, key, data: blob[key], updatedAt: backupCreatedAt }));

  return { users, entityChunks, appConfigs };
}

// T034a — audit trail (research.md Decision 23). Always written to
// default's own auditLog, via a synthetic req:{tenantId} so the event's own
// tenantId field reflects the real target, never a hand-rolled event object.
async function recordAuditEvent(tenantId, isMongoMode, outcome, metadata) {
  const opts = {
    req: { tenantId },
    action: 'tenant.backup',
    resourceType: 'tenant',
    resourceId: tenantId,
    outcome,
    metadata,
  };
  if (isMongoMode) {
    const doc = await EntityChunk.findOne({ tenantId: 'default', key: 'auditLog' }).lean();
    const container = { auditLog: doc?.data || [] };
    appendAuditEvent(container, opts);
    await EntityChunk.findOneAndUpdate(
      { tenantId: 'default', key: 'auditLog' },
      { $set: { tenantId: 'default', data: container.auditLog, updatedAt: new Date() } },
      { upsert: true },
    );
  } else {
    const db = readJsonSafe(DATA_FILE) || {};
    db.auditLog = db.auditLog || [];
    appendAuditEvent(db, opts);
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    _atomicWriteJsonSync(DATA_FILE, db);
  }
}

// T035a — per-tenant retention (research.md Decision 24, tenth-pass
// correction): exact-equality match on the fixed-width-stamp-stripped
// tenantId, never startsWith() — see the decision for the acme/acme-corp
// hyphen-collision defect this closes.
function rotateTenantBackups(tenantId) {
  const STAMP_AND_SEP_LEN = 20; // 19-char "YYYY-MM-DDTHH-mm-ss" stamp + 1 separating hyphen
  try {
    const candidates = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('tenant-') && f.endsWith('.json'));
    const matching = [];
    for (const f of candidates) {
      const withoutWrapper = f.slice('tenant-'.length, f.length - '.json'.length);
      if (withoutWrapper.length <= STAMP_AND_SEP_LEN) continue;
      const extractedTenantId = withoutWrapper.slice(0, withoutWrapper.length - STAMP_AND_SEP_LEN);
      if (extractedTenantId === sanitizeTenantIdForPath(tenantId)) matching.push(f);
    }
    matching.sort();
    const excess = matching.slice(0, Math.max(0, matching.length - TENANT_BACKUP_KEEP));
    for (const old of excess) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
      try { fs.unlinkSync(path.join(BACKUP_DIR, old + '.sha256')); } catch {}
    }
    if (excess.length) {
      console.log(`🧹 حُذفت ${excess.length} نسخة احتياطية قديمة للمستأجر "${tenantId}" (نحتفظ بآخر ${TENANT_BACKUP_KEEP})`);
    }
  } catch (e) {
    console.warn(`⚠️ فشل تدوير النسخ الاحتياطية القديمة: ${e.message}`);
  }
}

async function run() {
  const { tenantId } = parseArgs(process.argv.slice(2));
  if (!tenantId) {
    console.error('❌ يجب تحديد المستأجر صراحة: --tenant=<المعرّف> — لم يُكتب أي ملف.');
    process.exitCode = 1;
    return;
  }

  console.log(`🗄️  بدء النسخ الاحتياطي للمستأجر "${tenantId}"...`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  _setDataFileForTooling(DATA_FILE);

  const isMongoMode = !!MONGO_URI;
  const createdAt = new Date().toISOString();

  if (isMongoMode) await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  try {
    let collections, source;

    if (isMongoMode) {
      source = 'mongodb';
      if (tenantId === 'default') {
        const dupes = await findDefaultDuplicates();
        if (dupes.length) {
          for (const d of dupes) {
            console.error(`❌ هوية مكرّرة (${d.category}): "${d.identity}" — مستندات: ${d.ids.join(', ')}`);
          }
          await recordAuditEvent(tenantId, isMongoMode, 'failure', { reason: 'default_duplicate_identity', duplicates: dupes });
          console.error('❌ توجد هويات مكرّرة للعيادة الافتراضية — رُفض النسخ الاحتياطي، لم يُكتب أي ملف.');
          throw new BackupFailure('default duplicate identity', 'default_duplicate_identity');
        }
      } else {
        const active = await isNonDefaultTenantActive(tenantId);
        if (!active) {
          await recordAuditEvent(tenantId, isMongoMode, 'failure', { reason: 'tenant_not_found_or_inactive' });
          console.error(`❌ المستأجر "${tenantId}" غير موجود أو غير نشط — رُفض النسخ الاحتياطي، لم يُكتب أي ملف.`);
          throw new BackupFailure('tenant not found or inactive', 'tenant_not_found_or_inactive');
        }
      }
      collections = await queryMongo(tenantId);
    } else {
      source = 'file';
      collections = queryFile(tenantId, createdAt);
    }

    const recordCounts = {
      users: collections.users.length,
      entityChunks: collections.entityChunks.length,
      appConfigs: collections.appConfigs.length,
    };
    const categoryDigests = {
      users: computeCategoryDigest(collections.users),
      entityChunks: computeCategoryDigest(collections.entityChunks),
      appConfigs: computeCategoryDigest(collections.appConfigs),
    };

    const backup = {
      scope: 'tenant', schemaVersion: 1, tenantId, createdAt, source,
      recordCounts, categoryDigests, collections,
    };
    const json = JSON.stringify(backup, null, 2);
    const file = path.join(BACKUP_DIR, `tenant-${sanitizeTenantIdForPath(tenantId)}-${stamp()}.json`);
    fs.writeFileSync(file, json, 'utf8');
    const checksum = computeChecksum(json);
    fs.writeFileSync(file + '.sha256', `${checksum}  ${path.basename(file)}\n`, 'utf8');

    await recordAuditEvent(tenantId, isMongoMode, 'success', { backupFingerprint: checksum, createdAt, recordCounts, categoryDigests });

    rotateTenantBackups(tenantId);

    const sizeMB = (fs.statSync(file).size / 1048576).toFixed(2);
    console.log(`✅ تم — ${path.basename(file)} (${sizeMB} MB)`);
    console.log(`   ↳ المستأجر: ${tenantId}`);
    console.log(`   ↳ المصدر: ${source === 'mongodb' ? 'MongoDB' : 'ملفات محلية'}`);
    console.log(`   ↳ السجلات: users=${recordCounts.users}, entityChunks=${recordCounts.entityChunks}, appConfigs=${recordCounts.appConfigs}`);
    console.log(`   ↳ sha256:  ${checksum}`);
  } catch (e) {
    if (!(e instanceof BackupFailure)) {
      console.error('❌ فشل النسخ الاحتياطي:', e.message);
    }
    process.exitCode = 1;
  } finally {
    if (isMongoMode) { try { await mongoose.connection.close(); } catch {} }
  }
}

if (require.main === module) {
  run();
}

module.exports = { run, parseArgs, rotateTenantBackups };
