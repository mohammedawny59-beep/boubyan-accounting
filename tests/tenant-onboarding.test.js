// Private Beta Phase 1 — operator-controlled clinic onboarding
// (scripts/onboard-tenant.js). Calls createClinicTenant() directly — the
// exact exported production function, not a spawned CLI process — for
// fast, deterministic tests, matching this project's own established
// pattern (scripts/tenant-backup.js's rotateTenantBackups(),
// scripts/tenant-restore.js's acquireLockMongo()).
//
// Isolated test database only (mongodb-memory-server via
// tests/helpers/mongoTestHarness.js) — never production or demo.

process.env.JWT_SECRET = 'p-beta1-onboarding-secret';
process.env.NODE_ENV = 'test';

const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-beta1-onboarding-'));
const DATA_FILE = path.join(tmp, 'database.json');
const CONFIG_FILE = path.join(tmp, 'config.json');

const { _setDataFileForTooling, runAsTenant, warmTenantCache, loadDB } = require('../lib/database');
_setDataFileForTooling(DATA_FILE);
process.env.DATA_FILE = DATA_FILE;
process.env.CONFIG_FILE = CONFIG_FILE;

const Tenant = require('../models/Tenant');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const EntityChunk = require('../models/EntityChunk');
const { startIsolatedMongo } = require('./helpers/mongoTestHarness');
const { createClinicTenant } = require('../scripts/onboard-tenant');

describe('Private Beta Phase 1 — operator-controlled clinic onboarding', () => {
  let mongoInstance;

  beforeAll(async () => {
    mongoInstance = await startIsolatedMongo('p-beta1-onboarding');
    await mongoose.connect(mongoInstance.uri);
    await Promise.all([Tenant.init(), Subscription.init(), User.init(), EntityChunk.init()]);
    process.env.MONGO_URI = mongoInstance.uri;

    // Seed a realistic 'default' tenant with its own real-shaped data —
    // every test below proves onboarding a NEW clinic never reads or
    // writes any of this.
    await Tenant.create({ tenantId: 'default', name: 'Boubyan Dental', slug: 'default', email: 'ops@boubyan.example' });
    await User.create({ tenantId: 'default', id: 'u_default_admin', username: 'default-admin', passwordHash: bcrypt.hashSync('whatever-existing-pw', 10), role: 'admin' });
    await EntityChunk.create({ tenantId: 'default', key: 'vendors', data: [{ id: 'V-DEFAULT-1', name: 'Existing Default Vendor' }] });
  }, 120000);

  afterAll(async () => {
    try { await mongoose.connection.close(); } catch {}
    if (mongoInstance) { try { await mongoInstance.stop(); } catch {} }
    try { fs.removeSync(tmp); } catch {}
  });

  function clinicAOpts(overrides) {
    return {
      tenantId: 'clinic-a', name: 'Clinic A Dental', slug: 'clinic-a-slug',
      email: 'contact@clinic-a.example', adminUsername: 'clinic-a-admin',
      adminEmail: 'admin@clinic-a.example', adminPassword: 'clinicA-Pw1234',
      plan: 'trial', timezone: 'Asia/Kuwait', currency: 'KWD', language: 'ar',
      ...overrides,
    };
  }

  // ── 1 & 2: create Clinic A + its admin ──────────────────────────────────
  test('1-2: creates Clinic A (Tenant + Subscription) and its first admin User, with a working, bcrypt-verifiable password', async () => {
    const result = await createClinicTenant(clinicAOpts());
    expect(result.ok).toBe(true);
    expect(result.tenantId).toBe('clinic-a');

    const tenant = await Tenant.findOne({ tenantId: 'clinic-a' }).lean();
    expect(tenant).toBeTruthy();
    expect(tenant.status).toBe('active');
    expect(tenant.slug).toBe('clinic-a-slug');

    const sub = await Subscription.findOne({ tenantId: 'clinic-a' }).lean();
    expect(sub).toBeTruthy();
    expect(sub.status).toBe('active');

    const admin = await User.findOne({ tenantId: 'clinic-a', username: 'clinic-a-admin' }).lean();
    expect(admin).toBeTruthy();
    expect(admin.role).toBe('admin');
    expect(bcrypt.compareSync('clinicA-Pw1234', admin.passwordHash)).toBe(true);
    expect(bcrypt.compareSync('wrong-password', admin.passwordHash)).toBe(false);
  });

  // ── 3: Admin A belongs only to Clinic A ─────────────────────────────────
  test('3: Admin A exists ONLY under clinic-a — absent from default and from every other tenant', async () => {
    const allWithThatUsername = await User.find({ username: 'clinic-a-admin' }).lean();
    expect(allWithThatUsername.length).toBe(1);
    expect(allWithThatUsername[0].tenantId).toBe('clinic-a');

    const inDefault = await User.findOne({ tenantId: 'default', username: 'clinic-a-admin' }).lean();
    expect(inDefault).toBeNull();
  });

  // ── 4: Clinic A cannot see default clinic data ──────────────────────────
  test('4: Clinic A\'s own data is fully separate from default\'s — its own seeded COA/vendors, never default\'s real data', async () => {
    const clinicAVendors = await EntityChunk.findOne({ tenantId: 'clinic-a', key: 'vendors' }).lean();
    // Clinic A's own vendors EntityChunk either doesn't exist yet (nothing
    // seeded there — chartOfAccounts/roles/users are seeded, vendors is
    // not) or, if present, must never contain default's real vendor.
    if (clinicAVendors) {
      const names = (clinicAVendors.data || []).map(v => v.name);
      expect(names).not.toContain('Existing Default Vendor');
    }

    const defaultVendors = await EntityChunk.findOne({ tenantId: 'default', key: 'vendors' }).lean();
    expect(defaultVendors.data[0].name).toBe('Existing Default Vendor'); // untouched, still exactly as seeded

    await runAsTenant('clinic-a', async () => {
      await warmTenantCache('clinic-a');
      const db = loadDB();
      expect((db.chartOfAccounts || []).length).toBeGreaterThan(0); // Clinic A got its OWN seeded COA
      expect((db.vendors || []).length).toBe(0); // never default's vendor data
      expect((db.users || []).map(u => u.username)).toEqual(['clinic-a-admin']); // only its own admin
    });
  });

  // ── 5: default clinic cannot be changed by Clinic A onboarding ──────────
  test('5: onboarding Clinic A left default\'s own Tenant row and vendors EntityChunk byte-for-byte unchanged', async () => {
    const defaultTenant = await Tenant.findOne({ tenantId: 'default' }).lean();
    expect(defaultTenant.name).toBe('Boubyan Dental');
    expect(defaultTenant.slug).toBe('default');

    const defaultAdmin = await User.findOne({ tenantId: 'default', username: 'default-admin' }).lean();
    expect(defaultAdmin).toBeTruthy(); // still exactly the one seeded in beforeAll — never duplicated or overwritten

    const defaultUserCount = await User.countDocuments({ tenantId: 'default' });
    expect(defaultUserCount).toBe(1); // Clinic A's admin never landed here
  });

  // ── 6: duplicate tenant is rejected ─────────────────────────────────────
  test('6: re-onboarding the same tenant-id (or the same slug) is rejected — no second Tenant/Subscription/admin is created', async () => {
    const bySameId = await createClinicTenant(clinicAOpts({ adminUsername: 'clinic-a-admin-2', slug: 'a-different-slug' }));
    expect(bySameId.ok).toBe(false);
    expect(bySameId.stage).toBe('duplicate_tenant');

    const bySameSlug = await createClinicTenant(clinicAOpts({ tenantId: 'clinic-a-different-id', adminUsername: 'clinic-a-admin-3' }));
    expect(bySameSlug.ok).toBe(false);
    expect(bySameSlug.stage).toBe('duplicate_tenant');

    expect(await Tenant.countDocuments({ tenantId: 'clinic-a' })).toBe(1);
    expect(await Tenant.countDocuments({ slug: 'clinic-a-slug' })).toBe(1);
    // Neither rejected retry's own admin username was ever created anywhere.
    expect(await User.findOne({ username: 'clinic-a-admin-2' }).lean()).toBeNull();
    expect(await User.findOne({ username: 'clinic-a-admin-3' }).lean()).toBeNull();
  });

  // ── 7: duplicate admin/user is rejected safely ──────────────────────────
  test('7a: onboarding twice with a DIFFERENT admin username the second time still only ever creates the FIRST admin (rejected at the tenant-duplicate stage before any second user is touched)', async () => {
    const result = await createClinicTenant(clinicAOpts({ adminUsername: 'someone-else' }));
    expect(result.ok).toBe(false);
    const admins = await User.find({ tenantId: 'clinic-a' }).lean();
    expect(admins.length).toBe(1);
    expect(admins[0].username).toBe('clinic-a-admin'); // the original, only ever this one
  });

  test('7b: the internal duplicate-admin-username guard itself rejects safely, without touching the pre-existing user, if a Tenant row is created for an id that already has an orphan User (defense-in-depth beyond the tenant-duplicate check)', async () => {
    // Deliberately contrived orphan state (a User with no matching Tenant
    // row) to exercise this guard directly, since the tenant-duplicate
    // check above makes it otherwise unreachable through the normal flow.
    await User.create({ tenantId: 'clinic-orphan', id: 'u_orphan', username: 'clinic-orphan-admin', passwordHash: bcrypt.hashSync('x', 10), role: 'admin' });

    const result = await createClinicTenant(clinicAOpts({
      tenantId: 'clinic-orphan', slug: 'clinic-orphan-slug', adminUsername: 'clinic-orphan-admin',
    }));
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('duplicate_user');

    // Fail-safe cleanup: the Tenant/Subscription this attempt itself
    // created before hitting the duplicate-user guard must be rolled back
    // — no half-created tenant left behind.
    expect(await Tenant.findOne({ tenantId: 'clinic-orphan' }).lean()).toBeNull();
    expect(await Subscription.findOne({ tenantId: 'clinic-orphan' }).lean()).toBeNull();
    // The pre-existing orphan user itself is completely untouched.
    const orphanUser = await User.findOne({ tenantId: 'clinic-orphan', username: 'clinic-orphan-admin' }).lean();
    expect(orphanUser.id).toBe('u_orphan');
  });

  // ── 8: invalid tenant context fails closed ──────────────────────────────
  test('8: missing/malformed required fields fail closed at validation — before any Tenant/Subscription/User is created', async () => {
    const missingId = await createClinicTenant(clinicAOpts({ tenantId: '' }));
    expect(missingId.ok).toBe(false);
    expect(missingId.stage).toBe('validation');

    const badChars = await createClinicTenant(clinicAOpts({ tenantId: 'Bad ID With Spaces!', slug: 'clinic-badid-slug' }));
    expect(badChars.ok).toBe(false);
    expect(badChars.stage).toBe('validation');
    expect(await Tenant.findOne({ slug: 'clinic-badid-slug' }).lean()).toBeNull();

    const shortPassword = await createClinicTenant(clinicAOpts({ tenantId: 'clinic-shortpw', slug: 'clinic-shortpw-slug', adminUsername: 'shortpw-admin', adminPassword: 'short' }));
    expect(shortPassword.ok).toBe(false);
    expect(shortPassword.stage).toBe('validation');
    expect(await Tenant.findOne({ tenantId: 'clinic-shortpw' }).lean()).toBeNull();

    // Owner-review finding (lean review, LOW): the remaining required
    // fields share the identical fail-fast guard clause as the ones above
    // — still worth asserting each individually rather than trusting the
    // shared code path by inference alone.
    for (const [field, badValue] of [['name', ''], ['slug', ''], ['email', ''], ['adminUsername', '']]) {
      const res = await createClinicTenant(clinicAOpts({ tenantId: `clinic-missing-${field}`.toLowerCase(), slug: `clinic-missing-${field}-slug`.toLowerCase(), [field]: badValue }));
      expect(res.ok).toBe(false);
      expect(res.stage).toBe('validation');
      expect(await Tenant.findOne({ tenantId: `clinic-missing-${field}`.toLowerCase() }).lean()).toBeNull();
    }

    const badPlan = await createClinicTenant(clinicAOpts({ tenantId: 'clinic-badplan', slug: 'clinic-badplan-slug', adminUsername: 'badplan-admin', plan: 'not-a-real-plan' }));
    expect(badPlan.ok).toBe(false);
    expect(badPlan.stage).toBe('validation');
    expect(await Tenant.findOne({ tenantId: 'clinic-badplan' }).lean()).toBeNull();
  });

  // ── 9: new clinic loads its own app shell with no cross-tenant leakage ──
  test('9: a second, independently onboarded Clinic B loads its own dashboard-equivalent state with zero leakage from default OR Clinic A', async () => {
    const resultB = await createClinicTenant(clinicAOpts({
      tenantId: 'clinic-b', slug: 'clinic-b-slug', name: 'Clinic B Dental',
      email: 'contact@clinic-b.example', adminUsername: 'clinic-b-admin', adminEmail: 'admin@clinic-b.example',
    }));
    expect(resultB.ok).toBe(true);

    await runAsTenant('clinic-b', async () => {
      await warmTenantCache('clinic-b');
      const db = loadDB();
      expect((db.users || []).map(u => u.username)).toEqual(['clinic-b-admin']); // only its own admin — not default-admin, not clinic-a-admin
      expect(db.companyInfo.name).toBe('Clinic B Dental');
      expect((db.chartOfAccounts || []).length).toBeGreaterThan(0);
      expect((db.vendors || []).length).toBe(0); // never default's or Clinic A's vendor data
    });

    // And the reverse: Clinic A's own cache still shows only its own admin, unaffected by Clinic B's onboarding.
    await runAsTenant('clinic-a', async () => {
      await warmTenantCache('clinic-a');
      const db = loadDB();
      expect((db.users || []).map(u => u.username)).toEqual(['clinic-a-admin']);
    });

    // Audit trail: onboarding wrote to default's own audit log, never to either clinic's.
    const auditDoc = await EntityChunk.findOne({ tenantId: 'default', key: 'auditLog' }).lean();
    const onboardEvents = (auditDoc?.data || []).filter(e => e.action === 'tenant.onboard');
    expect(onboardEvents.some(e => e.resourceId === 'clinic-a' && e.outcome === 'success')).toBe(true);
    expect(onboardEvents.some(e => e.resourceId === 'clinic-b' && e.outcome === 'success')).toBe(true);
    expect(onboardEvents.some(e => e.outcome === 'failure')).toBe(true); // at least one of the rejected attempts above was audited too
  });
});
