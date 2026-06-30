const fs = require('fs-extra');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const User = require('../models/User');
const EntityChunk = require('../models/EntityChunk');
const AppConfig = require('../models/AppConfig');
const LegacyKV = require('../models/LegacyKV');

const ENTITY_KEYS = [
  'roles', 'doctors', 'dailyData', 'paymentsData', 'commissionHistory',
  'uploadedFiles', 'expenses', 'journalEntries', 'chartOfAccounts', 'vendors',
  'invItems', 'invCategories', 'invMovements', 'recurringExpenses',
  'companyInfo', 'scheduleConfig', 'vouchers', 'cashReconciliation',
  'insuranceClaims', 'payroll', 'employees',
  'assets', 'budget', 'auditLog', 'accruedExpenses', 'journalMappings',
  'doctorExpenses',
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
  };
}

// ─── FILE FALLBACK HELPERS ───────────────────────────────────────────────────

function scheduleFilePersist() {
  if (_fileFlushTimer) clearTimeout(_fileFlushTimer);
  _fileFlushTimer = setTimeout(() => {
    _fileFlushTimer = null;
    if (_dataFile && _dbCache) {
      try {
        fs.ensureDirSync(require('path').dirname(_dataFile));
        fs.writeJsonSync(_dataFile, _dbCache, { spaces: 2 });
      } catch (e) {
        console.error('❌ File persist failed:', e.message);
      }
    }
    if (_configFile && _configCache) {
      try {
        fs.ensureDirSync(require('path').dirname(_configFile));
        fs.writeJsonSync(_configFile, _configCache, { spaces: 2 });
      } catch (e) {
        console.error('❌ Config file persist failed:', e.message);
      }
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

async function loadUsersArray() {
  const docs = await User.find().lean();
  return docs.map(({ _id, ...u }) => u);
}

async function hydrateFromMongo() {
  const db = emptyDBShape();
  db.users = await loadUsersArray();

  const chunks = await EntityChunk.find({ key: { $in: ENTITY_KEYS } }).lean();
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
  await Promise.all(
    ENTITY_KEYS.map(key => persistEntityKey(key, db[key] ?? (Array.isArray(emptyDBShape()[key]) ? [] : {}))),
  );
}

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
  await Promise.all(tasks);
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
      .catch(e => console.error('❌ Mongo persist failed:', e.message))
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

  let admin = await User.findOne({ role: 'admin' });
  const byUsername = await User.findOne({ username });

  if (!admin && !byUsername) {
    await User.create({
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

function loadDB() {
  if (!_dbCache) throw new Error('DB not initialized — initDB() must run before loadDB()');
  return _dbCache;
}

function saveDB(db) {
  _dbCache = db;
  if (_useFileFallback) {
    scheduleFilePersist();
  } else {
    Object.keys(db).forEach(k => _dirtyKeys.add(k));
    schedulePersist();
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

async function shutdownDB() {
  if (_useFileFallback) {
    if (_fileFlushTimer) {
      clearTimeout(_fileFlushTimer);
      _fileFlushTimer = null;
    }
    scheduleFilePersist();
    await new Promise(r => setTimeout(r, 600));
    return;
  }
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  if (_persistInFlight) await _persistInFlight;
  await flushToMongo();
  await mongoose.connection.close();
}

async function initDB({ mongoUri, dataFile, configFile, defaultConfig, buildInitialDB, migrateDB }) {
  _dataFile = dataFile;
  _configFile = configFile;
  _defaultConfig = defaultConfig;

  // ── Try MongoDB ──────────────────────────────────────────────────────────
  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 10,
    });
    console.log('🍃 MongoDB connected');

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
    // ── File fallback ──────────────────────────────────────────────────────
    console.warn(`⚠️  MongoDB unavailable (${err.message})`);
    console.warn('📂 Falling back to local file storage (data/database.json)');
    _useFileFallback = true;

    _dbCache = loadFileDB(dataFile, buildInitialDB);

    fileEnsureAdmin(_dbCache, process.env.ADMIN_DEFAULT_PASSWORD);

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

module.exports = {
  initDB,
  loadDB,
  saveDB,
  loadConfig,
  saveConfig,
  shutdownDB,
  ENTITY_KEYS,
};
