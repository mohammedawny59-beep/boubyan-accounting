// P4 — Phase B: Tenant Config Isolation (research.md Decision 2)
//
// loadConfig()/saveConfig() previously had ZERO tenant awareness — a single,
// global _configCache shared by every request regardless of tenant. This
// suite proves the new per-tenant branch (research.md Decision 2) genuinely
// isolates config across tenants, in both Mongo mode (real, isolated
// mongodb-memory-server — never a mock, since the bug class this exists to
// catch is about the real Mongo query/write, not a mocked model) and file
// mode, including a real cross-backend switch (case 10).

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p4-tenant-config-isolation-secret';
process.env.NODE_ENV     = 'test';

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p4-config-iso-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const {
  initDB, shutdownDB, isFileFallbackMode, loadDB, saveDB, loadConfig, saveConfig,
  runAsTenant, warmTenantConfigCache,
} = require('../lib/database');
const { startIsolatedMongo } = require('./helpers/mongoTestHarness');
const AppConfig = require('../models/AppConfig');

function buildInitialDB() {
  return {
    users: [], roles: { admin: { tabs: [], actions: {} } }, doctors: [], dailyData: [],
    paymentsData: [], commissionHistory: [], uploadedFiles: [], expenses: [], journalEntries: [],
    chartOfAccounts: [], vendors: [], invItems: [], invCategories: [], invMovements: [],
    recurringExpenses: [], companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [],
    insuranceClaims: [], payroll: [], employees: [], assets: [], budget: {}, auditLog: [],
    accruedExpenses: [], journalMappings: [], doctorExpenses: [],
  };
}

const DEFAULT_CFG = { smtpHost: '', smtpUser: '', smtpPass: '', clinicName: 'العيادة الافتراضية' };

describe('P4 Phase B — Mongo-mode config isolation (real Mongo)', () => {
  let mongoInstance;

  beforeAll(async () => {
    mongoInstance = await startIsolatedMongo('p4-config-iso');
    process.env.DB_FILE_ONLY = 'false';
    try {
      await initDB({
        mongoUri: mongoInstance.uri,
        dataFile: process.env.DATA_FILE,
        configFile: process.env.CONFIG_FILE,
        defaultConfig: DEFAULT_CFG,
        buildInitialDB,
        migrateDB: () => false,
      });
    } finally {
      process.env.DB_FILE_ONLY = 'true';
    }
    expect(isFileFallbackMode()).toBe(false);
  }, 120000);

  afterAll(async () => {
    try { await shutdownDB(); } catch {}
    if (mongoInstance) { try { await mongoInstance.stop(); } catch {} }
    try { fs.removeSync(tmp); } catch {}
  });

  test('(1) Tenant A saveConfig() is never visible to Tenant B loadConfig()', async () => {
    await runAsTenant('tenant-a', async () => {
      await warmTenantConfigCache('tenant-a');
      saveConfig({ ...loadConfig(), clinicName: 'عيادة أ السرية' });
    });
    await runAsTenant('tenant-b', async () => {
      await warmTenantConfigCache('tenant-b');
      expect(loadConfig().clinicName).not.toBe('عيادة أ السرية');
    });
  });

  test('(2) fee/card/KNET-shaped settings stay isolated', async () => {
    await runAsTenant('tenant-a', async () => {
      await warmTenantConfigCache('tenant-a');
      saveConfig({ ...loadConfig(), feeSettings: { cardFeePercent: 2.5, knetFeePercent: 1.0 } });
    });
    await runAsTenant('tenant-b', async () => {
      await warmTenantConfigCache('tenant-b');
      saveConfig({ ...loadConfig(), feeSettings: { cardFeePercent: 9.9, knetFeePercent: 8.8 } });
    });
    await runAsTenant('tenant-a', () => {
      expect(loadConfig().feeSettings).toEqual({ cardFeePercent: 2.5, knetFeePercent: 1.0 });
    });
    await runAsTenant('tenant-b', () => {
      expect(loadConfig().feeSettings).toEqual({ cardFeePercent: 9.9, knetFeePercent: 8.8 });
    });
  });

  test('(3) SMTP/branding settings stay isolated', async () => {
    await runAsTenant('tenant-a', async () => {
      await warmTenantConfigCache('tenant-a');
      saveConfig({ ...loadConfig(), smtpHost: 'smtp.a.example', smtpPass: 'secret-a' });
    });
    await runAsTenant('tenant-b', async () => {
      await warmTenantConfigCache('tenant-b');
      expect(loadConfig().smtpHost).not.toBe('smtp.a.example');
      expect(loadConfig().smtpPass).not.toBe('secret-a');
    });
  });

  test('(4) a legacy no-tenantId-field AppConfig document normalizes in place, never duplicates', async () => {
    // Raw-driver seed — no tenantId field at all (spec.md FR-027 — never
    // Model.create()). No default-tenant config doc exists yet at this point
    // in the suite (only tenant-a/tenant-b were touched by tests 1-3), so
    // this is the only `key:'config'` document any of default's own
    // _defaultTenantFilter-scoped queries could match.
    await AppConfig.collection.insertOne({ key: 'config', data: { clinicName: 'legacy-clinic' }, updatedAt: new Date() });
    const preCheck = await AppConfig.collection.findOne({ key: 'config' });
    expect('tenantId' in preCheck).toBe(false);

    // Exercises the same _defaultTenantFilter-scoped upsert fix (T016) via
    // flushToMongo()'s own default-tenant config branch — a genuine
    // default-tenant saveConfig() + durable flush.
    await runAsTenant('default', async () => {
      saveConfig({ clinicName: 'legacy-clinic-renamed' });
    });
    await new Promise(r => setTimeout(r, 600));

    // Scoped to default's own identity specifically — other tenants (tenant-a/
    // tenant-b from earlier tests) also legitimately have their own,
    // unrelated `key:'config'` documents in this same collection.
    const matches = await AppConfig.find({
      key: 'config',
      $or: [{ tenantId: 'default' }, { tenantId: { $exists: false } }, { tenantId: null }],
    }).lean();
    expect(matches).toHaveLength(1); // updated in place, never duplicated
    expect(matches[0].tenantId).toBe('default');
    expect(matches[0].data.clinicName).toBe('legacy-clinic-renamed');
  });

  test('(5) cold-miss fail-closed: loadConfig() for a never-warmed non-default tenant throws', () => {
    runAsTenant('tenant-never-warmed', () => {
      expect(() => loadConfig()).toThrow();
    });
  });

  test('(7) default-tenant AppConfig collision: a real non-default tenant AppConfig document never leaks into or is overwritten by default operations', async () => {
    await AppConfig.create({ tenantId: 'tenant-c', key: 'config', data: { clinicName: 'Tenant C real config' } });

    await runAsTenant('default', async () => {
      const db = loadDB();
      saveConfig({ clinicName: 'Default clinic config' });
    });
    await new Promise(r => setTimeout(r, 500));

    const cDoc = await AppConfig.findOne({ tenantId: 'tenant-c', key: 'config' }).lean();
    expect(cDoc.data.clinicName).toBe('Tenant C real config'); // untouched by default's own write

    const defaultDoc = await AppConfig.findOne({ tenantId: 'default', key: 'config' }).lean();
    expect(defaultDoc.data.clinicName).toBe('Default clinic config');
  });

  test('(8) config-only Mongo-mode flush: saveConfig() alone (no saveDB() in the same window) is actually written to AppConfig', async () => {
    await runAsTenant('tenant-flush-only', async () => {
      await warmTenantConfigCache('tenant-flush-only');
      saveConfig({ ...loadConfig(), clinicName: 'flush-only-tenant' });
    });
    // Wait past PERSIST_DEBOUNCE_MS for the scheduled flush to actually run.
    await new Promise(r => setTimeout(r, 600));

    const doc = await AppConfig.findOne({ tenantId: 'tenant-flush-only', key: 'config' }).lean();
    expect(doc).toBeTruthy();
    expect(doc.data.clinicName).toBe('flush-only-tenant');
  });
});

describe('P4 Phase B — file-mode config isolation (no Mongo connection attempted)', () => {
  const fileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p4-config-iso-file-'));

  beforeAll(async () => {
    process.env.DB_FILE_ONLY = 'true';
    process.env.DATA_FILE   = path.join(fileTmp, 'database.json');
    process.env.CONFIG_FILE = path.join(fileTmp, 'config.json');
    await initDB({
      mongoUri: 'mongodb://127.0.0.1:1/unused', // never reachable — proves zero Mongo connection is attempted
      dataFile: process.env.DATA_FILE,
      configFile: process.env.CONFIG_FILE,
      defaultConfig: DEFAULT_CFG,
      buildInitialDB,
      migrateDB: () => false,
    });
    expect(isFileFallbackMode()).toBe(true);
  }, 30000);

  afterAll(async () => {
    try { await shutdownDB(); } catch {}
    try { fs.removeSync(fileTmp); } catch {}
  });

  test('(6) file-fallback persistence: saveConfig() for a tenant survives a debounced flush + re-warm from a fresh cache, zero Mongo connection', async () => {
    await runAsTenant('tenant-file-1', async () => {
      await warmTenantConfigCache('tenant-file-1');
      saveConfig({ ...loadConfig(), clinicName: 'file-mode-tenant-1' });
    });
    await new Promise(r => setTimeout(r, 600)); // let the debounced file write actually happen

    const tenantsDir = path.join(fileTmp, 'tenants');
    const files = fs.existsSync(tenantsDir) ? fs.readdirSync(tenantsDir) : [];
    const cfgFile = files.find(f => f.includes('tenant-file-1') && f.endsWith('.config.json'));
    expect(cfgFile).toBeTruthy();
    const onDisk = fs.readJsonSync(path.join(tenantsDir, cfgFile));
    expect(onDisk.clinicName).toBe('file-mode-tenant-1');
  });

  test('(9) config-only file-mode shutdown flush: saveConfig() alone, then shutdownDB() before the debounce timer fires, writes the file before shutdown completes', async () => {
    await runAsTenant('tenant-file-shutdown', async () => {
      await warmTenantConfigCache('tenant-file-shutdown');
      saveConfig({ ...loadConfig(), clinicName: 'shutdown-flush-tenant' });
    });
    // Immediately shut down — deliberately BEFORE the PERSIST_DEBOUNCE_MS window elapses.
    await shutdownDB();

    const tenantsDir = path.join(fileTmp, 'tenants');
    const files = fs.readdirSync(tenantsDir);
    const cfgFile = files.find(f => f.includes('tenant-file-shutdown') && f.endsWith('.config.json'));
    expect(cfgFile).toBeTruthy();
    const onDisk = fs.readJsonSync(path.join(tenantsDir, cfgFile));
    expect(onDisk.clinicName).toBe('shutdown-flush-tenant');

    // Re-init for any subsequent test in this describe block.
    await initDB({
      mongoUri: 'mongodb://127.0.0.1:1/unused',
      dataFile: process.env.DATA_FILE,
      configFile: process.env.CONFIG_FILE,
      defaultConfig: DEFAULT_CFG,
      buildInitialDB,
      migrateDB: () => false,
    });
  }, 30000);
});

describe('P4 Phase B — (10) a pending config-file timer does not survive a backend switch', () => {
  const switchTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p4-config-iso-switch-'));
  let mongoInstance;

  afterAll(async () => {
    try { await shutdownDB(); } catch {}
    if (mongoInstance) { try { await mongoInstance.stop(); } catch {} }
    try { fs.removeSync(switchTmp); } catch {}
  });

  test('a scheduled-but-not-yet-fired file-mode config timer never fires against a freshly-switched backend', async () => {
    process.env.DB_FILE_ONLY = 'true';
    process.env.DATA_FILE   = path.join(switchTmp, 'database.json');
    process.env.CONFIG_FILE = path.join(switchTmp, 'config.json');
    await initDB({
      mongoUri: 'mongodb://127.0.0.1:1/unused',
      dataFile: process.env.DATA_FILE,
      configFile: process.env.CONFIG_FILE,
      defaultConfig: DEFAULT_CFG,
      buildInitialDB,
      migrateDB: () => false,
    });
    expect(isFileFallbackMode()).toBe(true);

    // Schedule a pending config-file write, but do NOT wait for it to fire —
    // the timer is still live when the backend switch below happens.
    await runAsTenant('tenant-switch', async () => {
      await warmTenantConfigCache('tenant-switch');
      saveConfig({ ...loadConfig(), clinicName: 'pre-switch-should-never-land' });
    });

    // Switch backends immediately (before PERSIST_DEBOUNCE_MS elapses) — a
    // fresh, empty, real Mongo instance this tenant has never touched.
    mongoInstance = await startIsolatedMongo('p4-config-iso-switch');
    process.env.DB_FILE_ONLY = 'false';
    try {
      await initDB({
        mongoUri: mongoInstance.uri,
        dataFile: process.env.DATA_FILE,
        configFile: process.env.CONFIG_FILE,
        defaultConfig: DEFAULT_CFG,
        buildInitialDB,
        migrateDB: () => false,
      });
    } finally {
      process.env.DB_FILE_ONLY = 'true';
    }
    expect(isFileFallbackMode()).toBe(false);

    // Wait past the original debounce window — if the stale timer had
    // survived, it would have fired by now and written the OLD file-mode
    // state (or thrown reaching into a now-cleared Map).
    await new Promise(r => setTimeout(r, 600));

    // The new backend's own cache for this tenant must NOT reflect the
    // stale pre-switch write — it was never warmed on the new backend at all.
    await runAsTenant('tenant-switch', () => {
      expect(() => loadConfig()).toThrow();
    });
  }, 60000);
});
