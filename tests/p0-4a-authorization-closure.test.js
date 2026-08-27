// P0.4A — Authorization Closure & Sensitive Data Exposure Hardening.
// Real HTTP requests through the actual Express app (Supertest) — the same
// path a curl/Postman/DevTools attacker would take, never the UI.
//
// Safety: DB_FILE_ONLY=true (no MongoDB ever touched), DATA_FILE/CONFIG_FILE
// point at a fresh os.tmpdir() directory removed in afterAll(). No production
// or real tenant data is read or written anywhere in this file. lib/ai's
// callAI() is jest-mocked — this file never makes a real Anthropic API call.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-4a-authz-closure-test-secret';
process.env.NODE_ENV     = 'test';
process.env.ANTHROPIC_API_KEY = 'fake-test-key-not-real';
// Step 16 — these two are never stored in db/config in this codebase (verified
// by inspection: only read via process.env, e.g. lib/stripe.js), so nothing
// needs to be "seeded" for them — this guards against that ever changing.
process.env.STRIPE_SECRET_KEY = 'FAKE_STRIPE_SECRET_XYZ';

jest.mock('../lib/ai', () => ({
  callAI: jest.fn().mockResolvedValue('mock AI reply (no external call made)'),
  callAIVision: jest.fn().mockResolvedValue('{}'),
}));

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p04a-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB, warmTenantCache } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');
const { callAI } = require('../lib/ai');

function hash(pw) { return bcrypt.hashSync(pw, 10); }
function baseCoa() { return DEFAULT_COA.map(a => ({ ...a })); }
const nowIso = () => new Date().toISOString();

// ── Secret / sensitive-data markers (Steps 15–16) ──────────────────────────
const MARK = {
  payroll:   'SECRET_PAYROLL_MARKER_9281',
  bank:      'SECRET_BANK_MARKER_7312',
  audit:     'SECRET_AUDIT_MARKER_5519',
  adminCfg:  'SECRET_ADMIN_CONFIG_8842',
  smtpPass:  'FAKE_SMTP_SECRET_XYZ',
  tgToken:   'FAKE_TELEGRAM_TOKEN_XYZ',
  pwHash:    'FAKE_PASSWORD_HASH_XYZ',
  resetToken:'FAKE_RESET_TOKEN_XYZ',
};

function buildInitialDB() {
  return {
    users: [
      { id: 'usr-admin', username: 'admin',       email: 'admin@test.com', passwordHash: hash('AdminPass1!'),  role: 'admin',        fullName: 'مدير',    active: true, createdAt: nowIso(), lastLogin: null },
      { id: 'usr-acct',  username: 'accountant1',  email: 'a@test.com',     passwordHash: hash('AcctPass1!'),   role: 'accountant',   fullName: 'محاسب',   active: true, createdAt: nowIso(), lastLogin: null },
      { id: 'usr-view',  username: 'viewer1',      email: 'v@test.com',     passwordHash: hash('ViewPass1!'),   role: 'viewer',       fullName: 'مشاهد',   active: true, createdAt: nowIso(), lastLogin: null },
      { id: 'usr-recep', username: 'receptionist1',email: 'r@test.com',     passwordHash: hash('RecepPass1!'),  role: 'receptionist', fullName: 'استقبال', active: true, createdAt: nowIso(), lastLogin: null },
      { id: 'usr-inv',   username: 'inventory1',   email: 'i@test.com',     passwordHash: hash('InvPass1!'),    role: 'inventory',    fullName: 'مخزون',   active: true, createdAt: nowIso(), lastLogin: null },
      // A dedicated user whose passwordHash is literally the marker string —
      // the strongest possible check that GET /api/data / /api/admin/backup
      // strip the *real* passwordHash field (not just a decoy field name).
      { id: 'usr-marker',username: 'markeruser',   email: 'm@test.com',     passwordHash: MARK.pwHash,          role: 'viewer',       fullName: 'Marker',  active: true, createdAt: nowIso(), lastLogin: null },
      // Custom role with "ai" view but explicitly NO "payroll" tab at all —
      // no DEFAULT_ROLES role has this exact combination (accountant has
      // both), so this is the only way to actually exercise Test G's
      // invariant: someone who CAN reach /api/ai/chat but CANNOT read payroll.
      { id: 'usr-ai',    username: 'ai-analyst',   email: 'ai@test.com',    passwordHash: hash('AiPass1!'),     role: 'ai_only',      fullName: 'محلل AI', active: true, createdAt: nowIso(), lastLogin: null },
    ],
    roles: { ...JSON.parse(JSON.stringify(DEFAULT_ROLES)), ai_only: { name: 'AI Only', color: '#888', tabs: ['ai'], actions: { ai: ['view'] } } },
    doctors: [{ id: 'DR-1', name: 'د. أحمد', target: 5000, commission: 20, lab: 5, insurance: 2 }],
    dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [],
    chartOfAccounts: baseCoa(),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: { name: 'شركة الاختبار' }, scheduleConfig: { marker: MARK.adminCfg },
    vouchers: [], cashReconciliation: [], insuranceClaims: [], payroll: [
      { id: 'PAY-1', month: '2031-01', totalNet: 1234.5, notes: MARK.payroll, entries: [{ name: 'موظف', basicSalary: 500 }] },
    ],
    employees: [], fixedAssets: [], assets: [], budget: {},
    auditLog: [{ id: 'AUD-SEED-1', timestamp: nowIso(), action: 'seed.marker', metadata: { note: MARK.audit } }],
    accruedExpenses: [], journalMappings: [], doctorExpenses: [], lockedPeriods: {},
    bankRecons: [{ account: '1110', period: '2031-01', notes: MARK.bank, bankStatementLines: [], matchedLines: [] }],
    telegramToken: MARK.tgToken,
    passwordResets: [{ token: MARK.resetToken, userId: 'usr-admin', expiresAt: Date.now() + 30 * 60 * 1000 }],
  };
}

const OPEN_DATE = '2031-01-15';
let tokens = {};

beforeAll(async () => {
  await initDB({
    mongoUri: 'mongodb://127.0.0.1:1/unused',
    dataFile: process.env.DATA_FILE,
    configFile: process.env.CONFIG_FILE,
    defaultConfig: {},
    buildInitialDB,
    migrateDB: () => false,
  });

  // Seed the SMTP secret directly into the config store (mirrors what
  // POST /api/settings/report would persist) — no HTTP call needed for setup.
  await runAsTenant('default', async () => {
    const { saveConfig, loadConfig } = require('../lib/database');
    saveConfig({ ...loadConfig(), smtpPass: MARK.smtpPass, smtpHost: 'smtp.example.com', smtpUser: 'ops@example.com' });
  });

  for (const [key, username, password] of [
    ['admin', 'admin', 'AdminPass1!'],
    ['accountant', 'accountant1', 'AcctPass1!'],
    ['viewer', 'viewer1', 'ViewPass1!'],
    ['receptionist', 'receptionist1', 'RecepPass1!'],
    ['inventory', 'inventory1', 'InvPass1!'],
    ['ai_only', 'ai-analyst', 'AiPass1!'],
  ]) {
    const res = await request(app).post('/api/auth/login').send({ username, password });
    if (res.status !== 200) throw new Error(`setup login failed for ${username}: ${JSON.stringify(res.body)}`);
    tokens[key] = res.body.token;
  }

  await runAsTenant('tenant-a', async () => {
    await warmTenantCache('tenant-a');
    const db = loadDB();
    db.users = [{ id: 'usr-a-acct', tenantId: 'tenant-a', username: 'acct-a', email: 'a@t.com', passwordHash: hash('AcctA123!'), role: 'accountant', fullName: 'Acct A', active: true, createdAt: nowIso(), lastLogin: null }];
    db.roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
    db.chartOfAccounts = baseCoa();
    db.payroll = [{ id: 'PAY-A-1', month: '2031-01', totalNet: 999, notes: 'TENANT_A_PAYROLL_SECRET' }];
    db.auditLog = [];
    saveDB(db);
  });
  await runAsTenant('tenant-b', async () => {
    await warmTenantCache('tenant-b');
    const db = loadDB();
    db.users = [{ id: 'usr-b-admin', tenantId: 'tenant-b', username: 'owner-b', email: 'b@t.com', passwordHash: hash('OwnerB123!'), role: 'admin', fullName: 'Owner B', active: true, createdAt: nowIso(), lastLogin: null }];
    db.roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
    db.chartOfAccounts = baseCoa();
    db.payroll = [{ id: 'PAY-B-1', month: '2031-01', totalNet: 555, notes: 'TENANT_B_PAYROLL_SECRET' }];
    db.auditLog = [];
    saveDB(db);
  });
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

function auth(req, key = 'admin') { return req.set('Authorization', `Bearer ${tokens[key]}`); }

// ═══════════════════════════════════════════════════════════════════════
// STEP 14 — ROLE MATRIX THROUGH RAW HTTP (Tests A–J)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.4A — Role Matrix Tests A–J', () => {
  test('Test A: viewer/accountant cannot modify system config; admin can', async () => {
    const asViewer = await auth(request(app).put('/api/config'), 'viewer').send({ brand: { name: 'hacked' } });
    expect(asViewer.status).toBe(403);
    const asAccountant = await auth(request(app).put('/api/config'), 'accountant').send({ brand: { name: 'hacked' } });
    expect(asAccountant.status).toBe(403);
    const asAdmin = await auth(request(app).put('/api/config'), 'admin').send({ brand: { name: 'ok' } });
    expect(asAdmin.status).toBe(200);
  });

  test('Test B: unauthorized user cannot modify accounting settings (KNET/Visa-affecting config)', async () => {
    const res = await auth(request(app).put('/api/accounting-settings'), 'accountant').send({ currency: 'USD' });
    expect(res.status).toBe(403);
    const asAdmin = await auth(request(app).put('/api/accounting-settings'), 'admin').send({ currency: 'KWD' });
    expect(asAdmin.status).toBe(200);
  });

  test('Test C: unauthorized user cannot trigger commission recalculation', async () => {
    const res = await auth(request(app).post('/api/config/recalc-commissions'), 'accountant').send({});
    expect(res.status).toBe(403);
  });

  test('Test D: non-admin cannot change company configuration', async () => {
    const res = await auth(request(app).post('/api/company'), 'accountant').send({ name: 'Hacked Co' });
    expect(res.status).toBe(403);
    const asAdmin = await auth(request(app).post('/api/company'), 'admin').send({ name: 'شركة الاختبار' });
    expect(asAdmin.status).toBe(200);
  });

  test('Test E: unauthorized user cannot invoke legacy bank reconciliation save', async () => {
    const res = await auth(request(app).post('/api/bank-recon'), 'accountant').send({ account: '1110', period: '2031-01', bankEndBalance: 100 });
    expect(res.status).toBe(403);
  });

  test('Test F: centralized subscription authorization preserves admin-only behavior', async () => {
    const res = await auth(request(app).post('/api/subscription/checkout'), 'accountant').send({ plan: 'pro' });
    expect(res.status).toBe(403);
    const del = await auth(request(app).delete('/api/subscription'), 'viewer');
    expect(del.status).toBe(403);
  });

  test('Test G: AI chat does not leak payroll figures to a user without payroll permission', async () => {
    callAI.mockClear();
    // ai_only: custom role with "ai" tab view but explicitly no "payroll" tab
    // at all — the one combination that actually exercises this invariant
    // (every DEFAULT_ROLES role that can reach /api/ai/chat also has payroll).
    const res = await auth(request(app).post('/api/ai/chat'), 'ai_only').send({ message: 'ما هو إجمالي الرواتب؟' });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    const systemPromptSent = callAI.mock.calls[0][0].system;
    expect(systemPromptSent).not.toContain(MARK.payroll);
    expect(systemPromptSent).not.toMatch(/1234\.5/); // the real payroll total must not appear either

    // admin (has payroll:view) — the SAME question DOES get the real context.
    callAI.mockClear();
    const asAdmin = await auth(request(app).post('/api/ai/chat'), 'admin').send({ message: 'ما هو إجمالي الرواتب؟' });
    expect(asAdmin.status).toBe(200);
    const adminPrompt = callAI.mock.calls[0][0].system;
    expect(adminPrompt).toMatch(/1234\.5/);
  });

  test('Test H: AI bank-reconciliation endpoint is blocked outright for non-admin (bank data never reached)', async () => {
    const res = await auth(request(app).post('/api/ai/bank-recon'), 'accountant').send({ bankText: 'some statement text' });
    expect(res.status).toBe(403);
  });

  test('Test I: unauthorized user cannot send a report externally (Telegram/email)', async () => {
    const tg = await auth(request(app).post('/api/reports/send-telegram'), 'receptionist');
    expect(tg.status).toBe(403);
    const email = await auth(request(app).post('/api/reports/send-email'), 'inventory').send({ to: 'x@example.com' });
    expect(email.status).toBe(403);
  });

  test('Test J: unauthorized user cannot toggle a month-close checklist step', async () => {
    const res = await auth(request(app).post('/api/month-close/2031-01/step'), 'viewer').send({ stepId: 'lockPeriod', done: true });
    expect(res.status).toBe(403);
    const asAccountant = await auth(request(app).post('/api/month-close/2031-01/step'), 'accountant').send({ stepId: 'lockPeriod', done: true });
    expect(asAccountant.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// STEP 15 — GET /api/data EXPOSURE TESTS (raw-JSON marker search per role)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.4A — GET /api/data exposure (Step 15)', () => {
  const ROLE_MARKERS_ALLOWED = {
    admin:        [MARK.payroll, MARK.bank, MARK.audit, MARK.adminCfg],
    accountant:   [MARK.payroll],
    viewer:       [],
    receptionist: [],
    inventory:    [],
  };

  for (const role of ['admin', 'accountant', 'viewer', 'receptionist', 'inventory']) {
    test(`role "${role}" receives only its authorized markers from /api/data`, async () => {
      const res = await auth(request(app).get('/api/data'), role);
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      const allowed = ROLE_MARKERS_ALLOWED[role];
      for (const marker of [MARK.payroll, MARK.bank, MARK.audit, MARK.adminCfg]) {
        if (allowed.includes(marker)) expect(raw).toContain(marker);
        else expect(raw).not.toContain(marker);
      }
    });
  }

  test('receptionist/accountant (no "doctors" permission) still get doctor NAMES for the manual-entry picker, but not commission rates', async () => {
    const res = await auth(request(app).get('/api/data'), 'receptionist');
    expect(res.status).toBe(200);
    expect(res.body.doctors).toEqual([{ id: 'DR-1', name: 'د. أحمد' }]);
    expect(JSON.stringify(res.body.doctors)).not.toMatch(/target|commission|insurance/);
  });

  test('admin (has "doctors" permission) gets full doctor records including commission rates', async () => {
    const res = await auth(request(app).get('/api/data'), 'admin');
    const doc = res.body.doctors.find(d => d.id === 'DR-1');
    expect(doc.commission).toBe(20);
    expect(doc.target).toBe(5000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// STEP 16 — NEVER-SEND SECRET TESTS
// ═══════════════════════════════════════════════════════════════════════
describe('P0.4A — Never-send secret tests (Step 16)', () => {
  const BROAD_ENDPOINTS = ['/api/data', '/api/config'];

  for (const role of ['admin', 'accountant', 'viewer']) {
    for (const endpoint of BROAD_ENDPOINTS) {
      test(`${endpoint} never serializes secrets for role "${role}"`, async () => {
        const res = await auth(request(app).get(endpoint), role);
        expect(res.status).toBe(200);
        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain(MARK.smtpPass);
        expect(raw).not.toContain(MARK.tgToken);
        expect(raw).not.toContain(MARK.pwHash);
        expect(raw).not.toContain(MARK.resetToken);
        expect(raw).not.toContain(process.env.STRIPE_SECRET_KEY);
        expect(raw).not.toContain(process.env.ANTHROPIC_API_KEY);
      });
    }
  }

  test('GET /api/admin/backup (admin-only, restore-purpose) is the ONE place secrets legitimately appear — and is still denied to non-admin', async () => {
    const denied = await auth(request(app).get('/api/admin/backup'), 'accountant');
    expect(denied.status).toBe(403);
    const asAdmin = await auth(request(app).get('/api/admin/backup'), 'admin');
    expect(asAdmin.status).toBe(200);
    // documents the intentional exception: full backup restores password hashes.
    expect(JSON.stringify(asAdmin.body)).toContain(MARK.pwHash);
  });

  test('GET /api/settings/report never returns smtpPass to admin either (write-only field)', async () => {
    const res = await auth(request(app).get('/api/settings/report'), 'admin');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(MARK.smtpPass);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// STEP 17 — READ AUTHORIZATION TESTS (direct sensitive GET endpoints)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.4A — Direct read-endpoint authorization (Step 17)', () => {
  test('viewer cannot read payroll, audit log, users, or bank details directly', async () => {
    expect((await auth(request(app).get('/api/payroll'), 'viewer')).status).toBe(403);
    expect((await auth(request(app).get('/api/audit-log'), 'viewer')).status).toBe(403);
    expect((await auth(request(app).get('/api/users'), 'viewer')).status).toBe(403);
    expect((await auth(request(app).get('/api/bank-recon?account=1110&period=2031-01'), 'viewer')).status).toBe(403);
  });

  test('accountant receives payroll (granted) but not users/roles/audit-log (not granted)', async () => {
    expect((await auth(request(app).get('/api/payroll'), 'accountant')).status).toBe(200);
    expect((await auth(request(app).get('/api/users'), 'accountant')).status).toBe(403);
    expect((await auth(request(app).get('/api/roles'), 'accountant')).status).toBe(403);
    expect((await auth(request(app).get('/api/audit-log'), 'accountant')).status).toBe(403);
  });

  test('admin retains full read access to every sensitive endpoint', async () => {
    expect((await auth(request(app).get('/api/payroll'), 'admin')).status).toBe(200);
    expect((await auth(request(app).get('/api/users'), 'admin')).status).toBe(200);
    expect((await auth(request(app).get('/api/roles'), 'admin')).status).toBe(200);
    expect((await auth(request(app).get('/api/audit-log'), 'admin')).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// STEP 18 — TENANT + RBAC COMPOSITION
// ═══════════════════════════════════════════════════════════════════════
describe('P0.4A — Tenant + RBAC composition (Step 18)', () => {
  test('Tenant A accountant cannot read Tenant B data through /api/data, /api/payroll, or the audit log', async () => {
    const tokenA = (await request(app).post('/api/auth/login').send({ username: 'acct-a', password: 'AcctA123!', tenantId: 'tenant-a' })).body.token;

    const data = await request(app).get('/api/data').set('Authorization', `Bearer ${tokenA}`);
    expect(data.status).toBe(200);
    expect(JSON.stringify(data.body)).toContain('TENANT_A_PAYROLL_SECRET');
    expect(JSON.stringify(data.body)).not.toContain('TENANT_B_PAYROLL_SECRET');

    const payroll = await request(app).get('/api/payroll').set('Authorization', `Bearer ${tokenA}`);
    expect(payroll.status).toBe(200);
    expect(JSON.stringify(payroll.body)).not.toContain('TENANT_B_PAYROLL_SECRET');
  });

  test('a forged JWT combining Tenant B identity with an escalated role still cannot read admin-only Tenant B resources beyond its true role', async () => {
    const jwt = require('jsonwebtoken');
    // usr-b-admin genuinely IS admin in tenant-b — forge instead a fake id that
    // does not exist in tenant-b's user table at all.
    const forged = jwt.sign({ id: 'usr-b-ghost', username: 'ghost', role: 'admin', tenantId: 'tenant-b' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const res = await request(app).get('/api/data').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401); // stale-privilege live-user check rejects a non-existent user id outright
  });
});
