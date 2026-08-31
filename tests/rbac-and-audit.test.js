// P0.4 — Server-Side RBAC & Financial Audit Trail, proven over the REAL
// Express app + REAL middleware stack (Supertest) — every check here is a
// real HTTP request through requireAuth → tenantMiddleware →
// requirePermission/requireAdminAction → the route handler, exactly the
// path a curl/Postman/DevTools request would take (frontend-only gating is
// never sufficient — see CLAUDE.md P0.4 Primary Objective A).
//
// Safety: DB_FILE_ONLY=true (no MongoDB ever touched), DATA_FILE/CONFIG_FILE
// point at a fresh os.tmpdir() directory removed in afterAll(). No production
// or real tenant data is read or written anywhere in this file.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-4-rbac-audit-test-secret';
process.env.NODE_ENV     = 'test';

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');
const jwt  = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-rbac-audit-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB, warmTenantCache } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');
const { sanitizeForAudit } = require('../lib/auditLog');

function hash(pw) { return bcrypt.hashSync(pw, 10); }
function baseCoa() { return DEFAULT_COA.map(a => ({ ...a })); }
const nowIso = () => new Date().toISOString();

function buildInitialDB() {
  return {
    users: [
      { id: 'usr-admin',   username: 'admin',       email: 'admin@test.com',   passwordHash: hash('AdminPass1!'),   role: 'admin',      fullName: 'مدير النظام',  active: true, createdAt: nowIso(), lastLogin: null },
      { id: 'usr-acct',    username: 'accountant1',  email: 'acct@test.com',    passwordHash: hash('AcctPass1!'),    role: 'accountant', fullName: 'محاسب',        active: true, createdAt: nowIso(), lastLogin: null },
      { id: 'usr-view',    username: 'viewer1',      email: 'view@test.com',    passwordHash: hash('ViewPass1!'),    role: 'viewer',      fullName: 'مشاهد',        active: true, createdAt: nowIso(), lastLogin: null },
      { id: 'usr-recep',   username: 'receptionist1',email: 'recep@test.com',   passwordHash: hash('RecepPass1!'),   role: 'receptionist', fullName: 'استقبال',      active: true, createdAt: nowIso(), lastLogin: null },
      { id: 'usr-demote',  username: 'demoteme',     email: 'demote@test.com',  passwordHash: hash('DemotePass1!'),  role: 'admin',       fullName: 'يُخفَّض لاحقاً', active: true, createdAt: nowIso(), lastLogin: null },
      { id: 'usr-disable', username: 'disableme',    email: 'disable@test.com', passwordHash: hash('DisablePass1!'), role: 'admin',       fullName: 'يُعطَّل لاحقاً', active: true, createdAt: nowIso(), lastLogin: null },
    ],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [],
    chartOfAccounts: baseCoa(),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: { name: 'شركة الاختبار' }, scheduleConfig: {},
    vouchers: [], cashReconciliation: [], insuranceClaims: [], payroll: [],
    employees: [], fixedAssets: [], assets: [], budget: {}, auditLog: [],
    accruedExpenses: [], journalMappings: [], doctorExpenses: [], lockedPeriods: {},
  };
}

async function seedTenant(tenantId, { users, vendors }) {
  await runAsTenant(tenantId, async () => {
    await warmTenantCache(tenantId);
    const db = loadDB();
    db.users = users;
    db.roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
    db.chartOfAccounts = baseCoa();
    db.vendors = vendors || [];
    db.journalEntries = [];
    db.auditLog = db.auditLog || [];
    saveDB(db);
  });
}

const OPEN_DATE = '2031-04-15';
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

  for (const [key, username, password] of [
    ['admin', 'admin', 'AdminPass1!'],
    ['accountant', 'accountant1', 'AcctPass1!'],
    ['viewer', 'viewer1', 'ViewPass1!'],
    ['receptionist', 'receptionist1', 'RecepPass1!'],
    ['demote', 'demoteme', 'DemotePass1!'],
    ['disable', 'disableme', 'DisablePass1!'],
  ]) {
    const res = await request(app).post('/api/auth/login').send({ username, password });
    if (res.status !== 200) throw new Error(`setup login failed for ${username}: ${JSON.stringify(res.body)}`);
    tokens[key] = res.body.token;
  }

  await seedTenant('tenant-a', {
    users: [{ id: 'usr-a-admin', tenantId: 'tenant-a', username: 'owner-a', email: 'a@t.com', passwordHash: hash('OwnerA123!'), role: 'admin', fullName: 'Owner A', active: true, createdAt: nowIso(), lastLogin: null }],
    vendors: [{ id: 'VND-A-1', name: 'TENANT_A_VENDOR', accountId: '2101' }],
  });
  await seedTenant('tenant-b', {
    users: [
      { id: 'usr-b-admin',  tenantId: 'tenant-b', username: 'owner-b',  email: 'b@t.com',  passwordHash: hash('OwnerB123!'),  role: 'admin',  fullName: 'Owner B',  active: true, createdAt: nowIso(), lastLogin: null },
      { id: 'usr-b-viewer', tenantId: 'tenant-b', username: 'viewer-b', email: 'bv@t.com', passwordHash: hash('ViewerB123!'), role: 'viewer', fullName: 'Viewer B', active: true, createdAt: nowIso(), lastLogin: null },
    ],
    vendors: [{ id: 'VND-B-1', name: 'TENANT_B_VENDOR', accountId: '2101' }],
  });
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

function auth(req, key = 'admin') { return req.set('Authorization', `Bearer ${tokens[key]}`); }
function forge(payload) { return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' }); }
async function defaultAuditLog() {
  let log; await runAsTenant('default', async () => { log = loadDB().auditLog || []; });
  return log;
}
async function tenantAuditLog(tenantId) {
  let log; await runAsTenant(tenantId, async () => { log = loadDB().auditLog || []; });
  return log;
}
async function setUserField(tenantId, userId, field, value) {
  await runAsTenant(tenantId, async () => {
    const db = loadDB();
    const u = db.users.find(x => x.id === userId);
    u[field] = value;
    saveDB(db);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// RBAC TESTS A–J
// ═══════════════════════════════════════════════════════════════════════
describe('P0.4 — RBAC Tests A–J (server-side, real HTTP requests)', () => {
  test('RBAC Test A: admin can perform an admin-only action (create a user)', async () => {
    const res = await auth(request(app).post('/api/users'), 'admin').send({
      username: 'rbactest-a', password: 'RbacTestA1!', email: 'rbactesta@test.com', fullName: 'RBAC A', role: 'viewer',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('RBAC Test B: accountant (in-scope permission) can create an expense', async () => {
    const res = await auth(request(app).post('/api/expenses'), 'accountant').send({
      date: OPEN_DATE, desc: 'Office supplies', amount: 12.5, cat: 'قرطاسية', accountCode: '5740', payMethodCode: '1100',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('RBAC Test C: accountant (out-of-scope permission) is denied deleting an expense', async () => {
    const create = await auth(request(app).post('/api/expenses'), 'admin').send({
      date: OPEN_DATE, desc: 'To be deleted', amount: 5, cat: 'أخرى', accountCode: '5900', payMethodCode: '1100',
    });
    expect(create.status).toBe(200);
    let expId; await runAsTenant('default', async () => { expId = loadDB().expenses.slice(-1)[0].id; });

    const res = await auth(request(app).delete(`/api/expenses/${expId}`), 'accountant');
    expect(res.status).toBe(403);
    expect(res.body.error).toBeTruthy();
  });

  test('RBAC Test D: non-admin is denied an admin-only resource (create a user)', async () => {
    const res = await auth(request(app).post('/api/users'), 'accountant').send({
      username: 'should-fail', password: 'ShouldFail1!', email: 'x@test.com', fullName: 'x', role: 'viewer',
    });
    expect(res.status).toBe(403);
  });

  test('RBAC Test E: non-admin is denied a resource with no tab model at all (fixed assets)', async () => {
    const res = await auth(request(app).post('/api/assets'), 'accountant').send({
      name: 'Test Asset', cost: 1000, category: 'furniture',
    });
    expect(res.status).toBe(403);
  });

  test('RBAC Test F: an unauthenticated request to a newly-gated route is rejected (401), not silently allowed', async () => {
    const res = await request(app).post('/api/expenses').send({ date: OPEN_DATE, desc: 'no token', amount: 1 });
    expect(res.status).toBe(401);
  });

  test('RBAC Test G: a demoted user\'s OLD admin JWT loses admin privilege on the very next request (stale-privilege refresh)', async () => {
    // demoteme logged in as admin in beforeAll (tokens.demote still claims role:"admin").
    await setUserField('default', 'usr-demote', 'role', 'viewer');
    const res = await auth(request(app).post('/api/users'), 'demote').send({
      username: 'post-demotion', password: 'PostDemo1!', email: 'y@test.com', fullName: 'y', role: 'viewer',
    });
    expect(res.status).toBe(403); // live role is now "viewer" — requireAdminAction rejects it
  });

  test('RBAC Test H: a disabled user\'s OLD valid JWT is rejected outright (401), not just downgraded', async () => {
    await setUserField('default', 'usr-disable', 'active', false);
    const res = await auth(request(app).get('/api/period-lock'), 'disable');
    expect(res.status).toBe(401);
  });

  test('RBAC Test I: cross-tenant — Tenant A admin cannot reach Tenant B\'s vendor by id (not found, not leaked)', async () => {
    const tokenA = (await request(app).post('/api/auth/login').send({ username: 'owner-a', password: 'OwnerA123!', tenantId: 'tenant-a' })).body.token;
    const res = await request(app).delete('/api/vendors/VND-B-1').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
    // Tenant B's vendor must still exist, completely untouched by Tenant A's request.
    let stillThere; await runAsTenant('tenant-b', async () => { stillThere = loadDB().vendors.find(v => v.id === 'VND-B-1'); });
    expect(stillThere).toBeTruthy();
  });

  test('RBAC Test J: cross-tenant — a forged JWT claiming an escalated role for a real low-privilege user is denied', async () => {
    // usr-b-viewer's TRUE stored role is "viewer" — forge a token claiming "admin" for that same id.
    const forged = forge({ id: 'usr-b-viewer', username: 'viewer-b', role: 'admin', fullName: 'Viewer B', tenantId: 'tenant-b' });
    const res = await request(app).post('/api/users').set('Authorization', `Bearer ${forged}`).send({
      username: 'escalated', password: 'Escalated1!', email: 'z@test.com', fullName: 'z', role: 'admin',
    });
    expect(res.status).toBe(403); // live-refresh overwrote the forged "admin" claim with the real "viewer" role
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AUDIT TESTS A–J
// ═══════════════════════════════════════════════════════════════════════
describe('P0.4 — Audit Tests A–J (financial & security audit trail)', () => {
  test('Audit Test A: a successful login appends a login.success event with the correct actor', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'accountant1', password: 'AcctPass1!' });
    expect(res.status).toBe(200);
    const log = await defaultAuditLog();
    expect(log[0].action).toBe('login.success');
    expect(log[0].actorUsername).toBe('accountant1');
    expect(log[0].outcome).toBe('success');
  });

  test('Audit Test B: a failed login appends a login.failure event with a diagnostic reason, without leaking it to the client', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'accountant1', password: 'WrongPassword1!' });
    expect(res.status).toBe(401);
    expect(res.body.error).not.toMatch(/password|reason|invalid_password/i);
    const log = await defaultAuditLog();
    expect(log[0].action).toBe('login.failure');
    expect(log[0].outcome).toBe('failure');
    expect(log[0].metadata.reason).toBe('invalid_password');
  });

  test('Audit Test C: creating a journal entry appends a journal.created event with the matching resourceId', async () => {
    const res = await auth(request(app).post('/api/journal'), 'admin').send({
      date: OPEN_DATE, desc: 'Audit Test C entry',
      lines: [{ accountCode: '1100', debit: 20, credit: 0 }, { accountCode: '4100', debit: 0, credit: 20 }],
    });
    expect(res.status).toBe(200);
    const log = await defaultAuditLog();
    expect(log[0].action).toBe('journal.created');
    expect(log[0].resourceId).toBe(res.body.id);
    global.__auditTestJeId = res.body.id;
  });

  test('Audit Test D: updating that journal entry appends journal.updated with a before/after diff limited to changed fields', async () => {
    const jeId = global.__auditTestJeId;
    const res = await auth(request(app).put(`/api/journal/${jeId}`), 'admin').send({ desc: 'Audit Test C entry — edited' });
    expect(res.status).toBe(200);
    const log = await defaultAuditLog();
    expect(log[0].action).toBe('journal.updated');
    expect(log[0].resourceId).toBe(jeId);
    expect(log[0].changedFields).toContain('desc');
    expect(log[0].before.desc).toBe('Audit Test C entry');
    expect(log[0].after.desc).toBe('Audit Test C entry — edited');
  });

  test('Audit Test E: deleting that journal entry appends journal.deleted with the pre-deletion data captured', async () => {
    const jeId = global.__auditTestJeId;
    const res = await auth(request(app).delete(`/api/journal/${jeId}`), 'admin');
    expect(res.status).toBe(200);
    const log = await defaultAuditLog();
    expect(log[0].action).toBe('journal.deleted');
    expect(log[0].resourceId).toBe(jeId);
    expect(log[0].before.desc).toBe('Audit Test C entry — edited');
    let stillExists; await runAsTenant('default', async () => { stillExists = loadDB().journalEntries.find(e => e.id === jeId); });
    expect(stillExists).toBeUndefined();
  });

  test('Audit Test F: a denied authorization attempt appends an authorization.denied event', async () => {
    const res = await auth(request(app).post('/api/assets'), 'accountant').send({ name: 'denied asset', cost: 1 });
    expect(res.status).toBe(403);
    const log = await defaultAuditLog();
    expect(log[0].action).toBe('authorization.denied');
    expect(log[0].outcome).toBe('failure');
    expect(log[0].actorUsername).toBe('accountant1');
  });

  test('Audit Test G: sensitive fields are never persisted in plaintext anywhere in the audit trail', async () => {
    // (1) unit-level: sanitizeForAudit redacts recursively, at any nesting depth.
    const cleaned = sanitizeForAudit({ password: 'secret123', nested: { token: 'abc', apiKey: 'xyz' }, ok: 'fine' });
    expect(cleaned.password).toBe('[REDACTED]');
    expect(cleaned.nested.token).toBe('[REDACTED]');
    expect(cleaned.nested.apiKey).toBe('[REDACTED]');
    expect(cleaned.ok).toBe('fine');

    // (2) integration-level: none of the real passwords used anywhere in this
    // test run ever leaked into the persisted audit trail (login events only
    // ever pass a username + failure reason into appendAuditEvent — never
    // the password itself).
    const log = await defaultAuditLog();
    const serialized = JSON.stringify(log);
    for (const pw of ['AdminPass1!', 'AcctPass1!', 'ViewPass1!', 'WrongPassword1!']) {
      expect(serialized).not.toContain(pw);
    }
  });

  test('Audit Test H: no route exists to modify or delete individual audit-log entries (append-only, immutable)', () => {
    const routes = app._router.stack
      .filter(l => l.route)
      .map(l => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
    const auditRoutes = routes.filter(r => typeof r.path === 'string' && r.path.startsWith('/api/audit-log'));
    expect(auditRoutes.length).toBeGreaterThan(0); // the read endpoint itself must exist
    for (const r of auditRoutes) {
      expect(r.methods).not.toContain('put');
      expect(r.methods).not.toContain('delete');
      expect(r.methods).not.toContain('patch');
      expect(r.methods).not.toContain('post');
    }
  });

  test('Audit Test I: the audit-log read endpoint is permission-protected and supports pagination', async () => {
    const denied = await auth(request(app).get('/api/audit-log'), 'accountant');
    expect(denied.status).toBe(403);

    const ok = await auth(request(app).get('/api/audit-log?limit=2&page=1'), 'admin');
    expect(ok.status).toBe(200);
    expect(ok.body.logs.length).toBeLessThanOrEqual(2);
    expect(ok.body.limit).toBe(2);
    expect(ok.body.page).toBe(1);
    expect(typeof ok.body.total).toBe('number');
    expect(typeof ok.body.pages).toBe('number');
  });

  test('Audit Test J: audit-log reads are tenant-scoped — Tenant A never sees Tenant B\'s (or default\'s) events', async () => {
    const tokenA = (await request(app).post('/api/auth/login').send({ username: 'owner-a', password: 'OwnerA123!', tenantId: 'tenant-a' })).body.token;
    // Generate at least one tenant-a event to read back.
    await request(app).post('/api/journal').set('Authorization', `Bearer ${tokenA}`).send({
      date: OPEN_DATE, desc: 'Tenant A only entry',
      lines: [{ accountCode: '1100', debit: 5, credit: 0 }, { accountCode: '4100', debit: 0, credit: 5 }],
    });
    const res = await request(app).get('/api/audit-log').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.logs.length).toBeGreaterThan(0);
    for (const entry of res.body.logs) expect(entry.tenantId).toBe('tenant-a');

    const tenantBLog = await tenantAuditLog('tenant-b');
    const defaultLog = await defaultAuditLog();
    const tenantAIds = new Set(res.body.logs.map(e => e.id));
    for (const entry of tenantBLog) expect(tenantAIds.has(entry.id)).toBe(false);
    for (const entry of defaultLog) expect(tenantAIds.has(entry.id)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Vendor / AP Workspace Upgrade — T033: RBAC is unchanged for every
// reused/modified endpoint this feature touches, including the new
// ?vendorId= aging filter (spec.md FR-022 — no new, narrower permission
// tier; no expanded visibility for any role beyond what it already had).
// ═══════════════════════════════════════════════════════════════════════
describe('Vendor Workspace — RBAC unchanged (T033)', () => {
  test('T033 A: a role without vendors:view (receptionist) is denied the vendor statement endpoint, exactly as before this feature', async () => {
    const res = await auth(request(app).get('/api/vendors/some-id/statement'), 'receptionist');
    expect(res.status).toBe(403);
  });

  test('T033 B: a role without vendors:view (receptionist) is denied the vendor-bills list endpoint this feature\'s workspace fetches from, exactly as before', async () => {
    const res = await auth(request(app).get('/api/vendor-bills'), 'receptionist');
    expect(res.status).toBe(403);
  });

  test('T033 C: a role without financials:view (receptionist) is denied the new ?vendorId= aging filter exactly as it was already denied the unfiltered endpoint — this feature introduces no new permission surface', async () => {
    const unfiltered = await auth(request(app).get('/api/ap-aging'), 'receptionist');
    expect(unfiltered.status).toBe(403);
    const filtered = await auth(request(app).get('/api/ap-aging').query({ vendorId: 'some-id' }), 'receptionist');
    expect(filtered.status).toBe(403);
  });

  test('T033 D: a role that already has vendors:view (accountant) is still allowed the vendor statement endpoint, for a real vendor, unaffected by this feature', async () => {
    const create = await auth(request(app).post('/api/vendors'), 'admin').send({ name: 'Vendor-RBAC-T033', phone: '000' });
    expect(create.status).toBe(200);
    const res = await auth(request(app).get(`/api/vendors/${create.body.vendor.id}/statement`), 'accountant');
    expect(res.status).toBe(200);
  });

  test('T033 E: a role that already has financials:view (viewer) is still allowed both the unfiltered and the new ?vendorId=-filtered aging endpoint, unaffected by this feature', async () => {
    const unfiltered = await auth(request(app).get('/api/ap-aging'), 'viewer');
    expect(unfiltered.status).toBe(200);
    const filtered = await auth(request(app).get('/api/ap-aging').query({ vendorId: 'ven-does-not-exist' }), 'viewer');
    expect(filtered.status).toBe(200);
  });
});
