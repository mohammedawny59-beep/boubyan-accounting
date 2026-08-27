const fs = require('fs-extra');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { AsyncLocalStorage } = require('async_hooks');

const User = require('../models/User');
const EntityChunk = require('../models/EntityChunk');
const AppConfig = require('../models/AppConfig');
const LegacyKV = require('../models/LegacyKV');
const IdempotencyRecord = require('../models/IdempotencyRecord');

// ─── MULTI-TENANT CONTEXT (AsyncLocalStorage) ─────────────────────────────────
// Stores the current tenantId per async request chain.
// Routes don't need to change — loadDB()/saveDB() auto-scope to the active tenant.
const _tenantStorage = new AsyncLocalStorage();

// Per-tenant in-memory cache (tenantId → db)
const _tenantCaches  = new Map();
// Per-tenant dirty key sets
const _tenantDirty   = new Map();
// Per-tenant persist timers
const _tenantTimers  = new Map();

function _currentTenantId() {
  return _tenantStorage.getStore()?.tenantId || 'default';
}

/** Run a function in the context of a specific tenant */
function runAsTenant(tenantId, fn) {
  return _tenantStorage.run({ tenantId }, fn);
}

function _getTenantDirty(tid) {
  if (!_tenantDirty.has(tid)) _tenantDirty.set(tid, new Set());
  return _tenantDirty.get(tid);
}

async function _flushTenantToMongo(tenantId) {
  const db    = _tenantCaches.get(tenantId);
  const dirty = _getTenantDirty(tenantId);
  if (!db || dirty.size === 0) return;

  const keys = [...dirty];
  dirty.clear();

  const tasks = [];
  for (const key of keys) {
    if (key === 'users') {
      tasks.push(_persistUsersTenant(db.users || [], tenantId));
    } else if (ENTITY_KEYS.includes(key)) {
      tasks.push(_persistEntityKeyTenant(key, db[key], tenantId));
    }
  }
  if (tasks.length) await Promise.all(tasks);
}

function _scheduleTenantPersist(tenantId) {
  if (_tenantTimers.has(tenantId)) clearTimeout(_tenantTimers.get(tenantId));
  _tenantTimers.set(tenantId, setTimeout(async () => {
    _tenantTimers.delete(tenantId);
    await _flushTenantToMongo(tenantId).catch(e =>
      console.error(`❌ Tenant persist failed (${tenantId}):`, e.message)
    );
  }, PERSIST_DEBOUNCE_MS));
}

async function _persistEntityKeyTenant(key, data, tenantId) {
  await EntityChunk.updateOne(
    { tenantId, key },
    { $set: { tenantId, data, updatedAt: new Date() } },
    { upsert: true },
  );
}

async function _persistUsersTenant(users, tenantId) {
  const list = users || [];
  const ids  = list.map(u => u.id).filter(Boolean);
  if (ids.length) {
    await User.deleteMany({ tenantId, id: { $nin: ids } });
  } else {
    await User.deleteMany({ tenantId });
  }
  if (!list.length) return;
  const ops = list.map(u => ({
    updateOne: {
      filter: { tenantId, id: u.id },
      update: { $set: { tenantId, ...u } },
      upsert: true,
    },
  }));
  await User.bulkWrite(ops, { ordered: false });
}

async function _hydrateFromMongoTenant(tenantId) {
  const db = emptyDBShape();
  const users  = await User.find({ tenantId }).lean();
  db.users = users.map(({ _id, ...u }) => u);

  const chunks = await EntityChunk.find({ tenantId, key: { $in: ENTITY_KEYS } }).lean();
  for (const chunk of chunks) db[chunk.key] = chunk.data;
  return db;
}

async function _loadTenantDB(tenantId) {
  if (_tenantCaches.has(tenantId)) return _tenantCaches.get(tenantId);
  const db = await _hydrateFromMongoTenant(tenantId);
  _tenantCaches.set(tenantId, db);
  return db;
}

const ENTITY_KEYS = [
  'roles', 'doctors', 'dailyData', 'paymentsData', 'commissionHistory',
  'uploadedFiles', 'expenses', 'journalEntries', 'chartOfAccounts', 'vendors',
  'invItems', 'invCategories', 'invMovements', 'recurringExpenses',
  'companyInfo', 'scheduleConfig', 'vouchers', 'cashReconciliation',
  'insuranceClaims', 'payroll', 'employees',
  'assets', 'budget', 'auditLog', 'accruedExpenses', 'journalMappings',
  'doctorExpenses', 'passwordResets', 'errorLog',
  // P0.6A — Step 1 (P6-040): complete repository scan of every `db.<key>`
  // actually read/written by server.js turned up these — all genuinely
  // MUST PERSIST (accounting controls or real business records), previously
  // invisible to flushToMongo()/hydrateFromMongo() in real production
  // (Mongo) mode. `assets` is kept above rather than removed — see
  // normalizeCanonicalKeys() below; it is legacy/superseded by `fixedAssets`
  // but any real data already stored under it on a live Mongo instance must
  // keep persisting, never be silently dropped.
  'lockedPeriods',            // IAS 8 period-lock control (P6-040's core example)
  'fixedAssets',              // canonical fixed-asset register (P6-041)
  'bankCommittedLineKeys',    // bank-reconciliation duplicate-posting guard
  'bankMatchedLineIds',       // bank-reconciliation duplicate-posting guard
  'networkReceivableCleared', // bank-reconciliation running totals
  'patientAR',                // non-insurance patient receivables (real imported records)
  'doctorPayments',           // doctor-payment import history (real imported records)
  'accountingSettings',       // fiscal year / currency / rounding config
  'monthClose',                // month-end close checklist state
  'dismissedAnomalies',       // user-dismissed anomaly records
  'telegramToken',            // bot integration continuity (business-continuity, not accounting, but genuinely lost otherwise)
  'aiMemory',                  // AI-learned correction data
  'inventory',                 // legacy inventory-opening staging array (P6-042) — see normalizeCanonicalKeys()
  // P0.6A verification pass — Step 1/P6-040 follow-up: a full repository
  // db.<key> sweep (beyond the original 13) found ONE more genuinely-used,
  // reachable, audited financial-control key still missing: `bankRecons`
  // (POST /api/bank-recon, server.js:8208-8219 — real bank-reconciliation
  // match records: bankStatementLines/matchedLines/bankEndBalance/notes per
  // account+period, with its own appendAuditEvent call). Legacy relative to
  // the newer statement-import engine (bankCommittedLineKeys etc., already
  // registered above) but still reachable and RBAC-gated — real data, not
  // dead code. Previously invisible to flushToMongo() exactly like the
  // original P6-040 keys.
  'bankRecons',
  // P0.7 — the new Accounts Payable subledger (server.js POST
  // /api/vendor-bills et al.) — real, GL-integrated supplier bills/
  // payments/credits, each backed by a journal entry against the vendor's
  // own COA sub-account. Same P6-040-class discipline as every other key
  // above: registered from day one, never added after the fact.
  'vendorBills',
  // P0.8 — the new patient Accounts Receivable subledger. `patients` is the
  // minimal debtor master (server.js POST /api/patients); `patientReceivables`
  // is the GL-integrated receivable subledger (POST /api/patient-receivables
  // et al., Dr AR 1200 / Cr Revenue at recognition). Same P6-040-class
  // discipline: registered from day one, never added after the fact.
  'patients',
  'patientReceivables',
  // P0.12 — canonical financial idempotency store (closes P6-097). One
  // record per (tenantId, operationScope, key) claim; see
  // lib/idempotency.js for the full read/write contract. Registered from
  // day one in ENTITY_KEYS/emptyDBShape() like every other genuinely-
  // persisted entity in this file — an idempotency claim that silently
  // failed to survive a reload/backend-switch would defeat the entire
  // point of this milestone.
  'idempotencyRecords',
];

const PERSIST_DEBOUNCE_MS = 400;

let _dbCache = null;
let _configCache = null;
let _defaultConfig = null;
let _dirtyKeys = new Set();
let _configDirty = false;
let _persistTimer = null;
let _persistInFlight = null;

// File-fallback mode — used when MongoDB is unreachable
let _useFileFallback = false;
let _dataFile = null;
let _configFile = null;
let _fileFlushTimer = null;
let _filePersistFailures = 0;

// P0.5 — Step 2/3: fs.writeJsonSync() writes the destination file directly —
// a crash/power-loss mid-write (or disk-full partway through) can leave a
// truncated, unparseable database.json behind, corrupting the ONLY copy of
// the data in file-fallback mode. Write to a sibling temp file on the SAME
// directory (so the rename below is on the same filesystem/volume) and swap
// it into place with fs.renameSync — POSIX rename(2) and Windows same-volume
// MoveFileEx are both atomic: a reader/crash sees either the old file
// complete or the new file complete, never a half-written one.
function _atomicWriteJsonSync(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeJsonSync(tmp, data, { spaces: 2 });
  fs.renameSync(tmp, filePath);
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override || {})) {
    if (
      override[key] && typeof override[key] === 'object' && !Array.isArray(override[key]) &&
      base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

function emptyDBShape() {
  return {
    users: [],
    roles: {},
    doctors: [],
    dailyData: [],
    paymentsData: [],
    commissionHistory: [],
    uploadedFiles: [],
    expenses: [],
    journalEntries: [],
    chartOfAccounts: [],
    vendors: [],
    invItems: [],
    invCategories: [],
    invMovements: [],
    recurringExpenses: [],
    companyInfo: {},
    scheduleConfig: {},
    vouchers: [],
    cashReconciliation: [],
    insuranceClaims: [],
    payroll: [],
    employees: [],
    assets: [],
    budget: {},
    auditLog: [],
    accruedExpenses: [],
    journalMappings: [],
    doctorExpenses: [],
    // P0.6A — Step 1 (P6-040): see ENTITY_KEYS above for why each of these
    // is here.
    lockedPeriods: {},
    fixedAssets: [],
    bankCommittedLineKeys: [],
    bankMatchedLineIds: [],
    networkReceivableCleared: {},
    patientAR: [],
    doctorPayments: [],
    accountingSettings: {},
    monthClose: {},
    dismissedAnomalies: [],
    telegramToken: '',
    aiMemory: [],
    inventory: [],
    bankRecons: [],
    vendorBills: [],
    patients: [],
    patientReceivables: [],
    idempotencyRecords: [],
  };
}

// P0.6A — Step 2 (P6-041, P6-042): non-destructive forward normalization
// between a legacy key and the canonical key that superseded it. Legacy
// keys are NEVER deleted or overwritten here — only copied forward into the
// canonical key when the canonical one looks empty (fixedAssets) or when a
// legacy item genuinely isn't already represented canonically (inventory,
// matched by name). Idempotent — safe to call on every boot. Pure function,
// no I/O — exported so it can be unit-tested directly without going through
// a real or file-fallback initDB() cycle.
function normalizeCanonicalKeys(db) {
  if (!db) return db;

  // fixedAssets is canonical (server.js's asset routes read/write it
  // exclusively); `assets` was the originally-registered-but-dead
  // ENTITY_KEYS name. If a live Mongo instance has real historical data
  // sitting under the legacy `assets` key and the canonical one is empty,
  // surface it forward — `assets` itself is left untouched.
  if ((!Array.isArray(db.fixedAssets) || db.fixedAssets.length === 0) &&
      Array.isArray(db.assets) && db.assets.length > 0) {
    db.fixedAssets = db.assets.map(a => ({ ...a }));
  }
  if (!Array.isArray(db.fixedAssets)) db.fixedAssets = [];

  // invItems is canonical (every inventory CRUD/valuation route reads it);
  // `inventory` was written only by the opening-balance Excel import
  // (fixed going forward in server.js — see P6-042). Merge any legacy
  // items not already present (matched by name) forward, non-destructively.
  if (Array.isArray(db.inventory) && db.inventory.length > 0) {
    if (!Array.isArray(db.invItems)) db.invItems = [];
    const existingNames = new Set(db.invItems.map(i => i.name));
    for (const legacyItem of db.inventory) {
      if (existingNames.has(legacyItem.name)) continue;
      db.invItems.push({
        id: legacyItem.id, name: legacyItem.name, code: legacyItem.code || '',
        category: legacyItem.category || 'عام', unit: legacyItem.unit || 'قطعة',
        unitCost: legacyItem.unitCost ?? legacyItem.costPerUnit ?? 0,
        salePrice: legacyItem.salePrice || 0,
        quantity: legacyItem.quantity || 0,
        minQty: legacyItem.minQty ?? legacyItem.minQuantity ?? 0,
        description: legacyItem.notes || legacyItem.description || '',
        accountCode: legacyItem.accountCode, isOpening: legacyItem.isOpening,
        createdAt: legacyItem.createdAt || new Date().toISOString(),
      });
      existingNames.add(legacyItem.name);
    }
  }
  if (!Array.isArray(db.invItems)) db.invItems = [];

  return db;
}

// ─── FILE FALLBACK HELPERS ───────────────────────────────────────────────────

function scheduleFilePersist() {
  if (_fileFlushTimer) clearTimeout(_fileFlushTimer);
  _fileFlushTimer = setTimeout(() => {
    _fileFlushTimer = null;
    let ok = true;
    if (_dataFile && _dbCache) {
      try {
        fs.ensureDirSync(require('path').dirname(_dataFile));
        _atomicWriteJsonSync(_dataFile, _dbCache);
      } catch (e) {
        ok = false;
        console.error('❌ File persist failed:', e.message);
      }
    }
    if (_configFile && _configCache) {
      try {
        fs.ensureDirSync(require('path').dirname(_configFile));
        _atomicWriteJsonSync(_configFile, _configCache);
      } catch (e) {
        ok = false;
        console.error('❌ Config file persist failed:', e.message);
      }
    }
    // P0.5 — Step 2/3: previously a write failure (disk full, permission
    // error) was logged and then silently dropped forever — the in-memory
    // change existed but would never reach disk unless some LATER unrelated
    // save happened to retrigger scheduleFilePersist(). Now failures retry
    // with capped exponential backoff, mirroring the Mongo path's behavior.
    if (!ok) {
      _filePersistFailures++;
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(_filePersistFailures, 5)));
      console.error(`   ↳ سيُعاد المحاولة خلال ${delay / 1000}ث (محاولة ${_filePersistFailures})`);
      setTimeout(scheduleFilePersist, delay);
    } else {
      _filePersistFailures = 0;
    }
  }, PERSIST_DEBOUNCE_MS);
}

function loadFileDB(dataFile, buildInitialDB) {
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      const raw = fs.readJsonSync(dataFile);
      const base = emptyDBShape();
      return { ...base, ...raw };
    } catch (e) {
      console.warn('⚠️  Could not parse database.json:', e.message);
    }
  }
  return buildInitialDB();
}

function fileEnsureAdmin(db, defaultPassword) {
  const pw = defaultPassword || 'Admin@2026';
  if (!Array.isArray(db.users)) db.users = [];
  const hasAdmin = db.users.some(u => u.role === 'admin');
  if (!hasAdmin) {
    db.users.push({
      id: 'usr-1',
      username: 'admin',
      email: 'admin@boubyan.com',
      passwordHash: bcrypt.hashSync(pw, 10),
      role: 'admin',
      fullName: 'مدير النظام',
      active: true,
      createdAt: new Date().toISOString(),
      lastLogin: null,
    });
    console.log('👤 Admin user seeded (file mode)');
  }
}

// ─── MONGODB HELPERS ─────────────────────────────────────────────────────────

// 🔒 P0.1 — scoped to the DEFAULT tenant only. Legacy documents written before
// multi-tenancy existed have no tenantId field stored at all (schema `default`
// only applies on insert, not on query) — those still belong to the original
// clinic and must not be dropped. A real SaaS tenant's own documents
// (tenantId explicitly set to something else) must never be pulled in here.
const _defaultTenantFilter = {
  $or: [{ tenantId: 'default' }, { tenantId: { $exists: false } }, { tenantId: null }],
};

async function loadUsersArray() {
  const docs = await User.find(_defaultTenantFilter).lean();
  return docs.map(({ _id, ...u }) => u);
}

async function hydrateFromMongo() {
  const db = emptyDBShape();
  db.users = await loadUsersArray();

  const chunks = await EntityChunk.find({ ..._defaultTenantFilter, key: { $in: ENTITY_KEYS } }).lean();
  for (const chunk of chunks) {
    db[chunk.key] = chunk.data;
  }
  return db;
}

async function persistUsers(users) {
  const list = users || [];
  const ids = list.map(u => u.id).filter(Boolean);
  if (ids.length) {
    await User.deleteMany({ id: { $nin: ids } });
  } else {
    await User.deleteMany({});
  }

  if (!list.length) return;

  const ops = list.map(u => ({
    updateOne: {
      filter: { id: u.id },
      update: { $set: { ...u } },
      upsert: true,
    },
  }));
  await User.bulkWrite(ops, { ordered: false });
}

async function persistEntityKey(key, data) {
  await EntityChunk.updateOne(
    { key },
    { $set: { data, updatedAt: new Date() } },
    { upsert: true },
  );
}

async function persistAll(db) {
  await persistUsers(db.users || []);
  // P0.6A: fall back to emptyDBShape()'s own default value (not just an
  // array/object guess) — needed now that ENTITY_KEYS includes a string-
  // typed key (telegramToken); the old Array.isArray(...) ? [] : {} guess
  // would have defaulted a missing string key to {} instead of ''.
  const shape = emptyDBShape();
  await Promise.all(
    ENTITY_KEYS.map(key => persistEntityKey(key, db[key] ?? shape[key])),
  );
}

let _persistFailures = 0;

async function flushToMongo() {
  if (!_dbCache && !_configDirty) return;

  const keys = [..._dirtyKeys];
  _dirtyKeys.clear();
  const configDirty = _configDirty;
  _configDirty = false;

  const db = _dbCache;
  const tasks = [];

  if (db) {
    for (const key of keys) {
      if (key === 'users') {
        tasks.push(persistUsers(db.users || []));
      } else if (ENTITY_KEYS.includes(key)) {
        tasks.push(persistEntityKey(key, db[key]));
      }
    }
  }

  if (configDirty && _configCache) {
    tasks.push(
      AppConfig.updateOne(
        { key: 'config' },
        { $set: { data: _configCache, updatedAt: new Date() } },
        { upsert: true },
      ),
    );
  }

  if (!tasks.length) return;
  try {
    await Promise.all(tasks);
    _persistFailures = 0;
  } catch (e) {
    // ⚠️ لا يضيع أي تعديل أبداً: أعد المفاتيح لقائمة الحفظ وأعد المحاولة تلقائياً.
    // (الخلل القديم: كانت المفاتيح تُمسح قبل الحفظ، فإذا فشل Mongo ضاع التعديل
    //  بصمت وارتدّت البيانات القديمة عند أول إعادة تشغيل — "عدّلت ورجع القديم".)
    keys.forEach(k => _dirtyKeys.add(k));
    if (configDirty) _configDirty = true;
    _persistFailures++;
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(_persistFailures, 5)));
    console.error(`❌ Mongo persist failed (محاولة ${_persistFailures}) — سيعاد الحفظ خلال ${delay / 1000}ث:`, e.message);
    setTimeout(schedulePersist, delay);
    throw e;
  }
}

function schedulePersist() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    if (_persistInFlight) {
      schedulePersist();
      return;
    }
    _persistInFlight = flushToMongo()
      .catch(() => { /* logged + auto-retry scheduled inside flushToMongo */ })
      .finally(() => { _persistInFlight = null; });
  }, PERSIST_DEBOUNCE_MS);
}

async function migrateFromLegacyKV(dataFile) {
  const userCount = await User.countDocuments();
  const chunkCount = await EntityChunk.countDocuments();
  if (userCount > 0 || chunkCount > 0) return false;

  let legacy = null;
  const dbDoc = await LegacyKV.findOne({ key: 'db' }).lean();
  if (dbDoc?.data) legacy = dbDoc.data;
  else if (dataFile && fs.existsSync(dataFile)) {
    legacy = fs.readJsonSync(dataFile);
  }
  if (!legacy) return false;

  if (Array.isArray(legacy.users) && legacy.users.length) {
    await User.insertMany(legacy.users);
  }

  const chunkWrites = ENTITY_KEYS
    .filter(key => legacy[key] !== undefined)
    .map(key => ({
      updateOne: {
        filter: { key },
        update: { $set: { data: legacy[key], updatedAt: new Date() } },
        upsert: true,
      },
    }));

  if (chunkWrites.length) {
    await EntityChunk.bulkWrite(chunkWrites, { ordered: false });
  }

  console.log('📦 Migrated legacy KV blob → structured MongoDB collections');
  return true;
}

async function ensureAdminUser() {
  const username = (process.env.ADMIN_DEFAULT_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_DEFAULT_PASSWORD || 'Admin@2026';
  const email = (process.env.ADMIN_DEFAULT_EMAIL || 'admin@boubyan.com').trim();
  const fullName = process.env.ADMIN_DEFAULT_FULLNAME || 'مدير النظام';
  const reset = process.env.ADMIN_RESET_PASSWORD === 'true';

  // 🔒 P0.1 — scoped to the default tenant: must never read or (under
  // ADMIN_RESET_PASSWORD) overwrite another SaaS tenant's admin account just
  // because it also has role:'admin' or happens to share this username.
  let admin = await User.findOne({ ..._defaultTenantFilter, role: 'admin' });
  const byUsername = await User.findOne({ ..._defaultTenantFilter, username });

  if (!admin && !byUsername) {
    await User.create({
      tenantId: 'default',
      id: 'usr-1',
      username,
      email,
      passwordHash: bcrypt.hashSync(password, 10),
      role: 'admin',
      fullName,
      active: true,
      createdAt: new Date().toISOString(),
      lastLogin: null,
    });
    console.log(`👤 Admin user seeded (${username})`);
    return;
  }

  if (reset) {
    const target = byUsername || admin;
    if (target) {
      target.passwordHash = bcrypt.hashSync(password, 10);
      if (username) target.username = username;
      if (email) target.email = email;
      if (fullName) target.fullName = fullName;
      target.active = true;
      await target.save();
      console.log(`👤 Admin credentials reset from env (${target.username})`);
    }
  }
}

async function initConfig(configFile, defaultConfig) {
  _defaultConfig = defaultConfig;

  const cfgDoc = await AppConfig.findOne({ key: 'config' }).lean();
  if (cfgDoc?.data) {
    _configCache = cfgDoc.data;
    return;
  }

  const legacyCfg = await LegacyKV.findOne({ key: 'config' }).lean();
  if (legacyCfg?.data) {
    _configCache = legacyCfg.data;
    await AppConfig.updateOne(
      { key: 'config' },
      { $set: { data: _configCache, updatedAt: new Date() } },
      { upsert: true },
    );
    console.log('📦 Migrated legacy config into AppConfig collection');
    return;
  }

  if (configFile && fs.existsSync(configFile)) {
    try {
      _configCache = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      await AppConfig.updateOne(
        { key: 'config' },
        { $set: { data: _configCache, updatedAt: new Date() } },
        { upsert: true },
      );
      console.log('📦 Migrated legacy config.json into AppConfig collection');
      return;
    } catch (e) {
      console.warn('⚠️  Could not read config.json:', e.message);
    }
  }

  _configCache = { ...defaultConfig };
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

// مسار ملف بيانات المستأجر في وضع الملفات (data/tenants/<tid>.json)
function _tenantFilePath(tid) {
  if (!_dataFile) return null;
  const safe = String(tid).replace(/[^a-zA-Z0-9_-]/g, '_');
  return require('path').join(require('path').dirname(_dataFile), 'tenants', safe + '.json');
}

function loadDB() {
  const tid = _currentTenantId();

  if (tid !== 'default') {
    // Non-default tenant: serve from per-tenant cache
    if (_tenantCaches.has(tid)) return _tenantCaches.get(tid);
    // 🔒 عزل صارم (CLAUDE.md بند 2): مستأجر بلا كاش لا يستلم أبداً بيانات
    // العيادة الافتراضية — الخلل القديم كان يُرجع _dbCache نفسه فيرى المستأجر
    // قيود العيادة ويكتب فوقها. الآن: نحمّل ملفه (وضع الملفات) أو نعطيه
    // قاعدة فارغة معزولة تماماً.
    let db = null;
    const fp = _tenantFilePath(tid);
    if (_useFileFallback && fp && fs.existsSync(fp)) {
      try { db = fs.readJsonSync(fp); } catch { db = null; }
    }
    if (!db) {
      db = { ...emptyDBShape() };
      // Onboarding تلقائي: مستأجر جديد يبدأ بشجرة حسابات IFRS كاملة وأدوار جاهزة
      // بدل نظام فارغ (lib/defaults.js — لا تبعيات دائرية)
      try {
        const { DEFAULT_COA, DEFAULT_ROLES } = require('./defaults');
        db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
        db.roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
      } catch { /* defaults unavailable — keep empty shape */ }
    }
    _tenantCaches.set(tid, db);
    return db;
  }

  // Default tenant: use global cache (backward compat with all existing routes)
  if (!_dbCache) throw new Error('DB not initialized — initDB() must run before loadDB()');
  return _dbCache;
}

const _tenantFileTimers = new Map();
const _tenantFilePersistFailures = new Map();
function _scheduleTenantFilePersist(tid) {
  const fp = _tenantFilePath(tid);
  if (!fp) return;
  if (_tenantFileTimers.has(tid)) clearTimeout(_tenantFileTimers.get(tid));
  _tenantFileTimers.set(tid, setTimeout(() => {
    _tenantFileTimers.delete(tid);
    try {
      fs.ensureDirSync(require('path').dirname(fp));
      _atomicWriteJsonSync(fp, _tenantCaches.get(tid) || {});
      _tenantFilePersistFailures.delete(tid);
    } catch (e) {
      console.error('❌ Tenant file persist failed (' + tid + '):', e.message);
      const failures = (_tenantFilePersistFailures.get(tid) || 0) + 1;
      _tenantFilePersistFailures.set(tid, failures);
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(failures, 5)));
      console.error(`   ↳ سيُعاد المحاولة خلال ${delay / 1000}ث (مستأجر ${tid}, محاولة ${failures})`);
      setTimeout(() => _scheduleTenantFilePersist(tid), delay);
    }
  }, PERSIST_DEBOUNCE_MS));
}

/**
 * @param {object} db
 * @param {{durable?: boolean}} [opts]
 *
 * P0.5A — Objective B: `saveDB(db)` (no options — every one of the ~150
 * existing call sites) is UNCHANGED — synchronous-looking, fire-and-forget,
 * updates the in-tenant-process cache immediately and schedules the actual
 * Mongo/file write on the existing PERSIST_DEBOUNCE_MS timer. Returns
 * `undefined`, exactly as before.
 *
 * `saveDB(db, {durable: true})` is new: same immediate cache update, but
 * instead of scheduling a debounced write, it cancels any pending timer for
 * the CURRENT tenant and performs the flush to Mongo/file NOW, returning a
 * Promise that resolves only once that tenant's state has actually reached
 * durable storage (or rejects if the write failed). See server.js's
 * critical financial routes (journal/payroll/vouchers/etc.) for callers —
 * they now `await saveDB(db, {durable:true})` and turn a rejection into a
 * 500 instead of a false "success:true".
 */
function saveDB(db, opts) {
  const durable = !!(opts && opts.durable);
  const tid = _currentTenantId();

  if (tid !== 'default') {
    // Non-default tenant: write to per-tenant cache + persist
    _tenantCaches.set(tid, db);
    if (_useFileFallback) {
      if (durable) {
        if (_tenantFileTimers.has(tid)) { clearTimeout(_tenantFileTimers.get(tid)); _tenantFileTimers.delete(tid); }
        const fp = _tenantFilePath(tid);
        if (!fp) return Promise.resolve();
        return (async () => {
          fs.ensureDirSync(require('path').dirname(fp));
          _atomicWriteJsonSync(fp, db);
        })();
      }
      _scheduleTenantFilePersist(tid); // كان يُهمل الحفظ في وضع الملفات — الآن يُحفظ لملف المستأجر
      return;
    }
    Object.keys(db).forEach(k => _getTenantDirty(tid).add(k));
    if (durable) {
      if (_tenantTimers.has(tid)) { clearTimeout(_tenantTimers.get(tid)); _tenantTimers.delete(tid); }
      return _flushTenantToMongo(tid);
    }
    _scheduleTenantPersist(tid);
    return;
  }

  // Default tenant
  _dbCache = db;
  if (_useFileFallback) {
    if (durable) {
      if (_fileFlushTimer) { clearTimeout(_fileFlushTimer); _fileFlushTimer = null; }
      return (async () => {
        fs.ensureDirSync(require('path').dirname(_dataFile));
        _atomicWriteJsonSync(_dataFile, db);
        if (_configFile && _configCache) {
          fs.ensureDirSync(require('path').dirname(_configFile));
          _atomicWriteJsonSync(_configFile, _configCache);
        }
      })();
    }
    scheduleFilePersist();
    return;
  }
  Object.keys(db).forEach(k => _dirtyKeys.add(k));
  if (durable) {
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    return (async () => {
      if (_persistInFlight) await _persistInFlight.catch(() => {}); // let any in-progress flush settle first
      await flushToMongo();
    })();
  }
  schedulePersist();
}

/**
 * Warm up a non-default tenant's cache for use in request handlers.
 * Call this in the tenant middleware before the request hits any route.
 */
async function warmTenantCache(tenantId) {
  if (tenantId === 'default' || _useFileFallback) return;
  if (!_tenantCaches.has(tenantId)) {
    await _loadTenantDB(tenantId);
  }
}

function loadConfig() {
  if (!_defaultConfig) return _configCache || {};
  if (!_configCache) return { ..._defaultConfig };
  return deepMerge(_defaultConfig, _configCache);
}

function saveConfig(cfg) {
  _configCache = cfg;
  if (_useFileFallback) {
    scheduleFilePersist();
  } else {
    _configDirty = true;
    schedulePersist();
  }
}

// P0.5 — Step 4/5: graceful shutdown must flush EVERY tenant's pending
// writes, not just the default tenant's. Before this fix, shutdownDB()
// never looked at _tenantCaches/_tenantDirty/_tenantTimers at all — a
// debounced write queued for a non-default (SaaS) tenant right before
// SIGTERM was silently dropped even though the default tenant's own pending
// write was flushed correctly.
async function _flushAllTenantsOnShutdown() {
  // Cancel pending debounce timers — flushed synchronously below instead,
  // so shutdown isn't held hostage by the PERSIST_DEBOUNCE_MS window.
  for (const timer of _tenantFileTimers.values()) clearTimeout(timer);
  _tenantFileTimers.clear();
  for (const timer of _tenantTimers.values()) clearTimeout(timer);
  _tenantTimers.clear();

  if (_useFileFallback) {
    for (const tid of _tenantCaches.keys()) {
      const fp = _tenantFilePath(tid);
      if (!fp) continue;
      try {
        fs.ensureDirSync(require('path').dirname(fp));
        _atomicWriteJsonSync(fp, _tenantCaches.get(tid) || {});
      } catch (e) {
        console.error(`❌ Tenant shutdown flush failed (${tid}):`, e.message);
      }
    }
    return;
  }

  // Mongo mode: flush every tenant with any cached state, not just ones
  // still listed in _tenantDirty — being conservative here costs a few
  // redundant upserts at worst, never a lost write.
  const tenantIds = new Set([..._tenantDirty.keys(), ..._tenantCaches.keys()]);
  await Promise.all([...tenantIds].map(tid =>
    _flushTenantToMongo(tid).catch(e =>
      console.error(`❌ Tenant Mongo shutdown flush failed (${tid}):`, e.message))
  ));
}

// P0.5 — Step 4: bounded timeout so a hung Mongo write can never make
// shutdown hang forever. Production hosts send SIGKILL after their own grace
// period regardless, but the process should try to exit cleanly first.
const SHUTDOWN_TIMEOUT_MS = 8000;

async function shutdownDB() {
  const work = (async () => {
    await _flushAllTenantsOnShutdown();

    if (_useFileFallback) {
      if (_fileFlushTimer) {
        clearTimeout(_fileFlushTimer);
        _fileFlushTimer = null;
      }
      // Write the default tenant's current state directly rather than
      // scheduling + hoping the debounce fires within an arbitrary wait —
      // deterministic and immediate.
      if (_dataFile && _dbCache) {
        try {
          fs.ensureDirSync(require('path').dirname(_dataFile));
          _atomicWriteJsonSync(_dataFile, _dbCache);
        } catch (e) { console.error('❌ Shutdown file persist failed:', e.message); }
      }
      if (_configFile && _configCache) {
        try {
          fs.ensureDirSync(require('path').dirname(_configFile));
          _atomicWriteJsonSync(_configFile, _configCache);
        } catch (e) { console.error('❌ Shutdown config persist failed:', e.message); }
      }
      return;
    }
    if (_persistTimer) {
      clearTimeout(_persistTimer);
      _persistTimer = null;
    }
    if (_persistInFlight) await _persistInFlight;
    await flushToMongo();
    await mongoose.connection.close();
  })();

  // Bounded wait — but always clear the guard timer once `work` settles, on
  // either path. An uncleared timer here would keep the event loop (and
  // every Jest worker process running this in a test) alive for the full
  // SHUTDOWN_TIMEOUT_MS after every single shutdownDB() call, real bug
  // caught by this milestone's own test run before it ever reached production.
  let guardTimer;
  const guard = new Promise(resolve => {
    guardTimer = setTimeout(() => {
      console.error(`⚠️  Shutdown flush exceeded ${SHUTDOWN_TIMEOUT_MS}ms — proceeding with exit anyway`);
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
  });
  try {
    await Promise.race([work, guard]);
  } finally {
    clearTimeout(guardTimer);
  }
}

async function initDB({ mongoUri, dataFile, configFile, defaultConfig, buildInitialDB, migrateDB }) {
  _dataFile = dataFile;
  _configFile = configFile;
  _defaultConfig = defaultConfig;

  // P0.11 (Part D — file/Mongo parity harness): reset on every call, not just
  // once at module load. Previously this flag was ONLY ever set to `true`
  // (in the file-fallback catch branch below) and never reset back to
  // `false` on a later successful Mongo connection — a single process that
  // called initDB() more than once (a real Mongo backend attempted after an
  // earlier DB_FILE_ONLY/fallback run) would keep loadDB()/saveDB() routing
  // through the file-mode branch while believing it was Mongo-connected,
  // silently persisting to the wrong backend. Production calls initDB() once
  // per process so this never surfaced there, but it's exactly the failure
  // mode a same-process file→Mongo backend switch (this milestone's own
  // cross-backend parity test) would hit.
  _useFileFallback = false;

  // P0.11 (adversarial review finding, mongo-parity persona): the fix above
  // only resets the DEFAULT tenant's state (_useFileFallback, and _dbCache
  // is unconditionally reassigned further down either branch). It never
  // touched non-default-tenant module state — loadDB()'s non-default-tenant
  // branch checks ONLY `_tenantCaches.has(tid)` before ever consulting the
  // current backend mode, so a tenant's cache warmed under a PRIOR initDB()
  // call (a different backend) would keep being served — and PERSISTED TO —
  // through the new backend indefinitely. Independently reproduced: a
  // tenant's file-mode data survived a same-process switch to a freshly
  // provisioned, empty, real Mongo instance that tenant had never touched.
  // Pending timers are cleared explicitly before their Maps are cleared —
  // each timer closure captures the OLD backend's state and must not fire
  // against it after a switch.
  for (const t of _tenantTimers.values()) clearTimeout(t);
  for (const t of _tenantFileTimers.values()) clearTimeout(t);
  _tenantCaches.clear();
  _tenantDirty.clear();
  _tenantTimers.clear();
  _tenantFileTimers.clear();
  _tenantFilePersistFailures.clear();

  // ── Try MongoDB ──────────────────────────────────────────────────────────
  try {
    // Sandbox / test instances force local-file storage (no production DB touch)
    if (process.env.DB_FILE_ONLY === 'true') throw new Error('DB_FILE_ONLY — using isolated file storage');
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 10,
    });
    console.log('🍃 MongoDB connected');

    // P0.12 (critical fix, found by Mongo Race A/B/E2E A in
    // tests/p0-12-idempotency-mongo.test.js): Model.create() does NOT wait
    // for a schema's indexes to finish building — mongoose builds them in
    // the BACKGROUND after the model is first used, unless explicitly
    // awaited. Without this, IdempotencyRecord's unique compound index
    // (tenantId, operationScope, key) — the whole reason a dedicated Mongo
    // collection exists instead of the generic EntityChunk array model —
    // was not guaranteed to exist yet for any request served shortly after
    // a connect/restart, so MongoDB never rejected concurrent duplicate
    // inserts with E11000: every "claim" silently succeeded, exactly
    // reproducing the P6-097 duplicate-posting bug this milestone exists to
    // close. `Model.init()` resolves only once the collection exists AND
    // every index has finished building, so this MUST complete before
    // initDB() itself resolves (i.e. before the server can serve a single
    // request), not merely be started.
    await IdempotencyRecord.init();

    mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected'));
    mongoose.connection.on('reconnected', () => console.log('🍃 MongoDB reconnected'));

    const migrated = await migrateFromLegacyKV(dataFile);
    const hasData = (await User.countDocuments()) > 0 || (await EntityChunk.countDocuments()) > 0;

    if (!migrated && !hasData) {
      _dbCache = buildInitialDB();
      await persistAll(_dbCache);
      console.log('🆕 Created fresh structured database');
    } else {
      _dbCache = await hydrateFromMongo();
    }

    await ensureAdminUser();
    _dbCache.users = await loadUsersArray();

    normalizeCanonicalKeys(_dbCache);

    if (typeof migrateDB === 'function') {
      const changed = migrateDB(_dbCache);
      if (changed) saveDB(_dbCache);
    }

    if (!_dbCache.roles || !Object.keys(_dbCache.roles).length) {
      const initial = buildInitialDB();
      _dbCache.roles = initial.roles;
      saveDB(_dbCache);
    }

    await initConfig(configFile, defaultConfig);

    if (_persistTimer) {
      clearTimeout(_persistTimer);
      _persistTimer = null;
    }
    await flushToMongo();

  } catch (err) {
    // P0.5 — Step 19: production must fail closed. Before this check, ANY
    // Mongo connection failure in production (wrong MONGO_URI, network blip,
    // rotated credentials, Atlas outage) silently dropped into local-file
    // mode — indistinguishable from a deliberate DB_FILE_ONLY=true choice.
    // On an ephemeral host (serverless — see vercel.json — or a container
    // without an attached persistent volume — see scripts/backup.js's own
    // comment that Render wipes local disk on restart) that file is not
    // durable: the app would keep accepting financial postings, return 200,
    // and lose all of it on the next restart/redeploy, with no operator
    // ever told persistence silently changed mode. Only an EXPLICIT
    // DB_FILE_ONLY=true bypasses this — "fail closed unless explicitly
    // configured", not fail closed unconditionally (tests/dev keep working).
    const explicitFileMode = process.env.DB_FILE_ONLY === 'true';
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && !explicitFileMode) {
      console.error(`🚨 FATAL: MongoDB required in production but unavailable: ${err.message}`);
      console.error('🚨 Refusing to silently fall back to local file storage in production.');
      console.error('🚨 Set DB_FILE_ONLY=true explicitly if file-mode is really intended, or fix MONGO_URI.');
      throw err;
    }

    // ── File fallback (dev/test, or explicit opt-in) ───────────────────────
    console.warn(`⚠️  MongoDB unavailable (${err.message})`);
    console.warn('📂 Falling back to local file storage (data/database.json)');
    _useFileFallback = true;

    _dbCache = loadFileDB(dataFile, buildInitialDB);

    fileEnsureAdmin(_dbCache, process.env.ADMIN_DEFAULT_PASSWORD);

    normalizeCanonicalKeys(_dbCache);

    if (typeof migrateDB === 'function') {
      const changed = migrateDB(_dbCache);
      if (changed) saveDB(_dbCache);
    }

    if (!_dbCache.roles || !Object.keys(_dbCache.roles).length) {
      const initial = buildInitialDB();
      _dbCache.roles = initial.roles;
    }

    // Load config from file
    if (configFile && fs.existsSync(configFile)) {
      try { _configCache = fs.readJsonSync(configFile); }
      catch (e) { _configCache = { ...defaultConfig }; }
    } else {
      _configCache = { ...defaultConfig };
    }

    // Persist initial state to file
    scheduleFilePersist();
  }
}

// P0.5 — Step 21: lets /api/health/ready report which persistence mode is
// actually active (operational visibility only — not a secret, not DB
// content) without reaching into this module's private state directly.
function isFileFallbackMode() {
  return _useFileFallback;
}

module.exports = {
  initDB,
  loadDB,
  saveDB,
  loadConfig,
  saveConfig,
  shutdownDB,
  warmTenantCache,
  runAsTenant,
  ENTITY_KEYS,
  isFileFallbackMode,
  // P0.5 — exposed ONLY for tests/production-hardening.test.js (Persistence
  // B: a failed write must never leave a corrupt destination file). Not
  // used by any route — internal to this module otherwise.
  _atomicWriteJsonSync,
  // P0.6A — exported for direct unit-testing (Step 2) and reused by initDB()
  // itself; also exposes emptyDBShape() so tests can assert the full default
  // shape includes every ENTITY_KEYS field with the right type.
  normalizeCanonicalKeys,
  emptyDBShape,
};
