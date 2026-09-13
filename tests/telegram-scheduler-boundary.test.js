// P4 — Phase C: Telegram/Monitor Default-Tenant-Only Boundary (T018)
// research.md Decision 3, contracts/telegram-scheduler-boundary-contract.md
//
// server.js's Telegram bot (`bot`/`global._tgBot`) and its scheduled
// inventory/monthly-report jobs are a SINGLE process-global singleton —
// there is no per-tenant bot instance. Until full multi-tenant Telegram
// support ships, every route that reads or reconfigures that singleton must
// reject any non-default tenant BEFORE touching it, so a SaaS tenant can
// neither hijack default's own bot/token nor learn about its integration
// status. This proves, over the real Express app + real middleware stack
// (Supertest, like tests/tenant-isolation-http.test.js), for each of the 5
// guarded routes: (a) default-tenant behavior is completely unchanged from
// before this guard existed, (b) a non-default tenant gets 403 + a stable
// machine-readable code, and (c) no side effect (bot construction, message
// send, token persistence, status disclosure) happens before the rejection.
//
// node-telegram-bot-api is mocked exactly like tests/r4-telegram-
// accounting.test.js — the real library opens a genuine polling connection
// to Telegram's servers, which must never happen in a test run.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p4-telegram-scheduler-boundary-secret';
process.env.NODE_ENV     = 'test';

jest.mock('node-telegram-bot-api', () => {
  return jest.fn().mockImplementation(function () {
    this._handlers = {};
    this.on = jest.fn((event, cb) => { this._handlers[event] = cb; });
    this.sendMessage = jest.fn().mockResolvedValue({});
    this.stopPolling = jest.fn().mockResolvedValue({});
    this.getFileLink = jest.fn();
  });
});

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const request = require('supertest');
const TelegramBot = require('node-telegram-bot-api');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p4-tg-boundary-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const {
  initDB, shutdownDB, runAsTenant, loadDB, saveDB, warmTenantCache,
  loadConfig, saveConfig,
} = require('../lib/database');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [{
      id: 'usr-default-admin', username: 'default-admin', email: 'default@clinic.com',
      passwordHash: hash('DefaultPass1!'), role: 'admin', fullName: 'مدير العيادة',
      active: true, createdAt: new Date().toISOString(), lastLogin: null,
    }],
    roles: { admin: { id: 'admin', tabs: ['*'], actions: {} } },
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: [], vendors: [],
    invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: { name: 'عيادة بوبيان' }, scheduleConfig: {},
    vouchers: [], cashReconciliation: [], insuranceClaims: [], payroll: [], employees: [],
    assets: [], budget: {}, auditLog: [], accruedExpenses: [], journalMappings: [],
    doctorExpenses: [],
  };
}

async function seedTenantUser(tenantId, username, password) {
  await runAsTenant(tenantId, async () => {
    await warmTenantCache(tenantId);
    const db = loadDB();
    db.users = [{
      id: `usr-${tenantId}`, tenantId, username, email: `${username}@example.com`,
      passwordHash: hash(password), role: 'admin', fullName: username,
      active: true, createdAt: new Date().toISOString(), lastLogin: null,
    }];
    saveDB(db);
  });
}

beforeAll(async () => {
  await initDB({
    mongoUri: 'mongodb://127.0.0.1:1/unused',
    dataFile: process.env.DATA_FILE,
    configFile: process.env.CONFIG_FILE,
    defaultConfig: {},
    buildInitialDB,
    migrateDB: () => false,
  });
  await seedTenantUser('tenant-x', 'owner-x', 'PassX1234!');
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

async function login(username, password, tenantId) {
  const body = { username, password };
  if (tenantId) body.tenantId = tenantId;
  return request(app).post('/api/auth/login').send(body);
}

describe('P4 Phase C — Telegram/Monitor default-tenant-only boundary (T018)', () => {
  let tokenDefault, tokenX;

  beforeAll(async () => {
    tokenDefault = (await login('default-admin', 'DefaultPass1!')).body.token;
    tokenX = (await login('owner-x', 'PassX1234!', 'tenant-x')).body.token;
    expect(tokenDefault).toBeTruthy();
    expect(tokenX).toBeTruthy();

    // Give default a real chatId so the routes below exercise their genuine
    // pre-P4 success path (not just a "no chat configured" no-op) — the
    // strongest possible proof that default-tenant behavior is unchanged.
    await runAsTenant('default', async () => {
      const cfg = loadConfig();
      cfg.telegramChatIds = ['999'];
      saveConfig(cfg);
    });
  });

  // ── Route 1: POST /api/telegram/start ─────────────────────────────────
  describe('POST /api/telegram/start', () => {
    test('default tenant: unchanged behavior — bot starts successfully', async () => {
      const res = await request(app)
        .post('/api/telegram/start')
        .set('Authorization', `Bearer ${tokenDefault}`)
        .send({ token: '111:FAKE-BOUNDARY-TEST' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(TelegramBot).toHaveBeenCalledTimes(1);
      expect(global._tgBot).toBeTruthy();
    });

    test('non-default tenant: 403 + TELEGRAM_DEFAULT_TENANT_ONLY, bot left untouched', async () => {
      const callsBefore = TelegramBot.mock.calls.length;
      const botBefore = global._tgBot;

      const res = await request(app)
        .post('/api/telegram/start')
        .set('Authorization', `Bearer ${tokenX}`)
        .send({ token: '222:SHOULD-NOT-START' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TELEGRAM_DEFAULT_TENANT_ONLY');
      expect(TelegramBot.mock.calls.length).toBe(callsBefore); // no new bot constructed
      expect(global._tgBot).toBe(botBefore); // same instance, untouched
    });

    test('no side effect before rejection: default clinic\'s stored token is unaffected by the rejected attempt', async () => {
      let tokenBefore;
      await runAsTenant('default', async () => { tokenBefore = loadDB().telegramToken; });

      const res = await request(app)
        .post('/api/telegram/start')
        .set('Authorization', `Bearer ${tokenX}`)
        .send({ token: '333:ANOTHER-ATTEMPT' });
      expect(res.status).toBe(403);

      let tokenAfter;
      await runAsTenant('default', async () => { tokenAfter = loadDB().telegramToken; });
      expect(tokenAfter).toBe(tokenBefore);
    });
  });

  // ── Route 2: POST /api/monitor/inventory ──────────────────────────────
  describe('POST /api/monitor/inventory', () => {
    test('default tenant: unchanged behavior — triggers the real inventory check', async () => {
      const res = await request(app)
        .post('/api/monitor/inventory')
        .set('Authorization', `Bearer ${tokenDefault}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('non-default tenant: 403 + TELEGRAM_DEFAULT_TENANT_ONLY', async () => {
      const res = await request(app)
        .post('/api/monitor/inventory')
        .set('Authorization', `Bearer ${tokenX}`)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TELEGRAM_DEFAULT_TENANT_ONLY');
    });

    test('no side effect before rejection: bot.sendMessage is never invoked for the rejected request', async () => {
      const mockBot = global._tgBot;
      const before = mockBot.sendMessage.mock.calls.length;

      const res = await request(app)
        .post('/api/monitor/inventory')
        .set('Authorization', `Bearer ${tokenX}`)
        .send({});
      expect(res.status).toBe(403);
      expect(mockBot.sendMessage.mock.calls.length).toBe(before);
    });
  });

  // ── Route 3: POST /api/monitor/monthly-report ─────────────────────────
  describe('POST /api/monitor/monthly-report', () => {
    test('default tenant: unchanged behavior — sends the real monthly report', async () => {
      const res = await request(app)
        .post('/api/monitor/monthly-report')
        .set('Authorization', `Bearer ${tokenDefault}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('non-default tenant: 403 + TELEGRAM_DEFAULT_TENANT_ONLY', async () => {
      const res = await request(app)
        .post('/api/monitor/monthly-report')
        .set('Authorization', `Bearer ${tokenX}`)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TELEGRAM_DEFAULT_TENANT_ONLY');
    });

    test('no side effect before rejection: bot.sendMessage is never invoked for the rejected request', async () => {
      const mockBot = global._tgBot;
      const before = mockBot.sendMessage.mock.calls.length;

      const res = await request(app)
        .post('/api/monitor/monthly-report')
        .set('Authorization', `Bearer ${tokenX}`)
        .send({});
      expect(res.status).toBe(403);
      expect(mockBot.sendMessage.mock.calls.length).toBe(before);
    });
  });

  // ── Route 4: GET /api/monitor/status ───────────────────────────────────
  describe('GET /api/monitor/status', () => {
    test('default tenant: unchanged behavior — discloses real bot/inventory status', async () => {
      const res = await request(app)
        .get('/api/monitor/status')
        .set('Authorization', `Bearer ${tokenDefault}`);
      expect(res.status).toBe(200);
      expect(res.body.botActive).toBe(true);
      expect(typeof res.body.chatIdSet).toBe('boolean');
    });

    test('non-default tenant: 403 + TELEGRAM_DEFAULT_TENANT_ONLY', async () => {
      const res = await request(app)
        .get('/api/monitor/status')
        .set('Authorization', `Bearer ${tokenX}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TELEGRAM_DEFAULT_TENANT_ONLY');
    });

    test('no disclosure before rejection: rejected response body carries no status fields', async () => {
      const res = await request(app)
        .get('/api/monitor/status')
        .set('Authorization', `Bearer ${tokenX}`);
      expect(res.status).toBe(403);
      expect(res.body.botActive).toBeUndefined();
      expect(res.body.chatIdSet).toBeUndefined();
      expect(res.body.dbBackend).toBeUndefined();
      expect(res.body.backup).toBeUndefined();
    });
  });

  // ── Route 5: POST /api/reports/send-telegram ───────────────────────────
  describe('POST /api/reports/send-telegram', () => {
    test('default tenant: unchanged behavior — sends the real daily report', async () => {
      const res = await request(app)
        .post('/api/reports/send-telegram')
        .set('Authorization', `Bearer ${tokenDefault}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.sent).toBeGreaterThanOrEqual(1);
    });

    test('non-default tenant: 403 + TELEGRAM_DEFAULT_TENANT_ONLY', async () => {
      const res = await request(app)
        .post('/api/reports/send-telegram')
        .set('Authorization', `Bearer ${tokenX}`)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TELEGRAM_DEFAULT_TENANT_ONLY');
    });

    test('no side effect before rejection: bot.sendMessage is never invoked for the rejected request', async () => {
      const mockBot = global._tgBot;
      const before = mockBot.sendMessage.mock.calls.length;

      const res = await request(app)
        .post('/api/reports/send-telegram')
        .set('Authorization', `Bearer ${tokenX}`)
        .send({});
      expect(res.status).toBe(403);
      expect(mockBot.sendMessage.mock.calls.length).toBe(before);
    });
  });
});
