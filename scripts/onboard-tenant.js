#!/usr/bin/env node
'use strict';
/**
 * إنشاء مستأجر (عيادة) جديد + أول مستخدم admin له — Operator-Controlled Clinic Onboarding
 *
 * Private Beta Phase 1 — the smallest safe path to onboard clinic #2 (and #3)
 * without touching the existing 'default' tenant or exposing a public
 * self-signup surface. This is deliberately NOT a new HTTP endpoint: it is
 * an operator-run CLI tool, matching this codebase's own established
 * pattern for privileged, low-frequency, human-operated actions
 * (scripts/tenant-backup.js, scripts/tenant-restore.js).
 *
 * This does NOT replace or modify the existing public
 * POST /api/tenants/register route (server.js) — that route is out of
 * scope for this change and is left completely untouched. This script
 * reuses the SAME underlying production primitives that route already
 * uses (the Tenant/Subscription Mongoose models, runAsTenant/loadDB/
 * saveDB from lib/database.js, and lib/defaults.js's DEFAULT_COA/
 * DEFAULT_ROLES) so both paths share the exact same data shape and
 * schema-enforced safety guarantees — this script does not reimplement
 * or duplicate that logic, it composes the same building blocks.
 *
 * التشغيل:
 *   TENANT_ADMIN_PASSWORD=<كلمة مرور 8 أحرف فأكثر> node scripts/onboard-tenant.js \
 *     --tenant-id=<معرّف فريد> --name=<اسم العيادة> --slug=<معرّف نصي فريد> \
 *     --email=<بريد التواصل> --admin-username=<اسم مستخدم الأدمن> \
 *     [--admin-email=<بريد الأدمن>] [--plan=trial|starter|pro|enterprise] \
 *     [--timezone=Asia/Kuwait] [--currency=KWD] [--language=ar] [--yes]
 *
 * القفل الأمني: كلمة مرور الأدمن تُمرَّر عبر متغيّر بيئة (TENANT_ADMIN_PASSWORD)
 * وليس كوسيط سطر أوامر — لتفادي بقائها في history/process-list. لا خيار آخر.
 *
 * ⚠️ لا يمسّ المستأجر 'default' أو أي مستأجر آخر موجود إطلاقاً — كل ما يفعله
 *    هذا الأمر محصور بالمستأجر الجديد المحدد صراحةً عبر --tenant-id=.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const readline = require('readline');
const Tenant = require('../models/Tenant');
const Subscription = require('../models/Subscription');
const { runAsTenant, warmTenantCache, loadDB, saveDB } = require('../lib/database');
const { appendAuditEvent } = require('../lib/auditLog');
const EntityChunk = require('../models/EntityChunk');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

const MONGO_URI = process.env.MONGO_URI;

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}

function parseArgs(argv) {
  const get = (name) => {
    const arg = argv.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3).trim() || null : null;
  };
  return {
    tenantId: get('tenant-id'),
    name: get('name'),
    slug: get('slug'),
    email: get('email'),
    adminUsername: get('admin-username'),
    adminEmail: get('admin-email'),
    plan: get('plan') || 'trial',
    timezone: get('timezone') || 'Asia/Kuwait',
    currency: get('currency') || 'KWD',
    language: get('language') || 'ar',
    yes: argv.includes('--yes') || process.env.ONBOARD_YES === '1',
  };
}

const USAGE = 'الاستخدام: TENANT_ADMIN_PASSWORD=<كلمة مرور> node scripts/onboard-tenant.js --tenant-id=<معرّف> --name=<اسم العيادة> --slug=<معرّف نصي> --email=<بريد التواصل> --admin-username=<اسم المستخدم> [--admin-email=] [--plan=trial|starter|pro|enterprise] [--timezone=] [--currency=] [--language=] [--yes]';

const VALID_PLANS = ['trial', 'starter', 'pro', 'enterprise'];
// A conservative allowlist, not the full Mongo-safe-string set this project
// uses elsewhere (sanitizeTenantIdForPath) — tenantId/slug here become
// literal path segments AND literal EntityChunk/User/Tenant field values;
// keeping them to this narrow, human-readable set avoids ever needing that
// broader sanitization question at all for a value an operator, not an
// end user, types once per clinic.
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/**
 * Core onboarding logic — exported separately from run() so tests can call
 * it directly (deterministic, no CLI-argument-parsing/child-process spawn
 * needed), exactly like scripts/tenant-backup.js's rotateTenantBackups()
 * and scripts/tenant-restore.js's acquireLockMongo() are exported for the
 * same reason.
 *
 * Fail-safe, not a real Mongo transaction (this repo's own established
 * constraint — plan.md: "No Mongo multi-document transactions" — a
 * standalone/non-replica-set MongoDB, which mongodb-memory-server defaults
 * to, does not support them): if any step after Tenant/Subscription
 * creation fails, the Tenant and Subscription documents just created ARE
 * explicitly deleted before returning, so a failed onboarding attempt
 * never leaves a half-created tenant with no admin able to log into it.
 */
async function createClinicTenant(opts) {
  const {
    tenantId, name, slug, email, adminUsername, adminEmail, adminPassword,
    plan, timezone, currency, language,
  } = opts;

  const problems = [];
  if (!tenantId || !SAFE_ID_RE.test(tenantId)) problems.push('tenant-id مطلوب: أحرف/أرقام إنجليزية صغيرة وشرطات فقط، 3-32 حرفاً');
  if (!name) problems.push('name (اسم العيادة) مطلوب');
  if (!slug || !SAFE_ID_RE.test(slug)) problems.push('slug مطلوب: أحرف/أرقام إنجليزية صغيرة وشرطات فقط، 3-32 حرفاً');
  if (!email) problems.push('email (بريد التواصل) مطلوب');
  if (!adminUsername) problems.push('adminUsername مطلوب');
  if (!adminPassword || adminPassword.length < 8) problems.push('كلمة مرور الأدمن يجب أن تكون 8 أحرف على الأقل');
  if (plan && !VALID_PLANS.includes(plan)) problems.push(`plan غير معروف: ${plan}`);
  if (problems.length) return { ok: false, stage: 'validation', problems };

  // Duplicate checks BEFORE any write — fail closed, touch nothing.
  const [existingById, existingBySlug] = await Promise.all([
    Tenant.findOne({ tenantId }).lean(),
    Tenant.findOne({ slug }).lean(),
  ]);
  if (existingById) return { ok: false, stage: 'duplicate_tenant', problems: [`tenant-id "${tenantId}" مستخدم مسبقاً`] };
  if (existingBySlug) return { ok: false, stage: 'duplicate_tenant', problems: [`slug "${slug}" مستخدم مسبقاً (المستأجر: ${existingBySlug.tenantId})`] };

  let tenant = null;
  let subscription = null;
  try {
    tenant = await Tenant.create({
      tenantId, name, slug, email, plan, status: 'active',
      timezone, currency, language,
    });
    subscription = await Subscription.create({
      tenantId, plan, status: 'active', seats: Subscription.LIMITS[plan].seats,
    });

    await runAsTenant(tenantId, async () => {
      await warmTenantCache(tenantId);
      const db = loadDB();
      const adminId = `u_${Date.now().toString(36)}`;
      if ((db.users || []).some(u => u.username === adminUsername)) {
        // Structurally unreachable for a brand-new tenant (nothing could
        // have created a user for it yet) — defensive only, matching this
        // codebase's own "duplicate admin/user is rejected safely" bar
        // rather than relying solely on the unique-index throw below.
        throw Object.assign(new Error(`admin-username "${adminUsername}" مستخدم مسبقاً في هذا المستأجر`), { stage: 'duplicate_user' });
      }
      (db.users = db.users || []).push({
        id: adminId,
        tenantId,
        username: adminUsername,
        email: adminEmail || '',
        fullName: name,
        role: 'admin',
        passwordHash: bcrypt.hashSync(adminPassword, 10),
        active: true,
        createdAt: new Date().toISOString(),
      });
      // نفس منطق /api/tenants/register تماماً (server.js) — شجرة حسابات
      // IFRS كاملة وأدوار جاهزة لكل مستأجر جديد، لا نظام فارغ.
      if (!(db.chartOfAccounts || []).length) db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
      if (!db.roles || !Object.keys(db.roles).length) db.roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
      db.companyInfo = { ...(db.companyInfo || {}), name, currency };
      // {durable:true}: this is a short-lived CLI process, not the
      // long-running server — the plain saveDB(db) every route uses relies
      // on a DEBOUNCED flush firing later in the SAME still-running
      // process. This process is about to exit; durable:true flushes to
      // Mongo/file NOW and awaits it, so the admin user this operator is
      // about to hand a password to is provably persisted, never lost to
      // an early process exit.
      await saveDB(db, { durable: true });
    });

    const audit = await recordOnboardingAudit(tenantId, 'success', { name, slug, plan, adminUsername });
    return { ok: true, tenantId, slug, adminUsername, auditRecorded: audit.ok };
  } catch (e) {
    // Fail-safe cleanup: never leave a half-created tenant (a Tenant/
    // Subscription row with no working admin able to log into it) lying
    // around silently after a failed attempt. Owner-review finding (lean
    // review, LOW): a rollback delete that itself throws must be reported
    // loudly, not swallowed — a stray half-created tenant would otherwise
    // be self-revealing only on a later retry (as a duplicate_tenant
    // rejection), not immediately at the time it actually happened.
    try {
      if (tenant) await Tenant.deleteOne({ tenantId });
    } catch (cleanupErr) {
      console.error(`❌ فشل إلزامي: تعذّر التراجع عن سجل Tenant الجزئي لـ "${tenantId}" بعد فشل الإنشاء — ${cleanupErr.message}. تحقق يدوياً.`);
    }
    try {
      if (subscription) await Subscription.deleteOne({ tenantId });
    } catch (cleanupErr) {
      console.error(`❌ فشل إلزامي: تعذّر التراجع عن سجل Subscription الجزئي لـ "${tenantId}" بعد فشل الإنشاء — ${cleanupErr.message}. تحقق يدوياً.`);
    }
    await recordOnboardingAudit(tenantId, 'failure', { name, slug, plan, adminUsername, reason: e.message });
    return { ok: false, stage: e.stage || 'unexpected', problems: [e.message] };
  }
}

// Mirrors scripts/tenant-restore.js's own recordAuditEvent() exactly
// (bounded, explicit — never silently swallowed) — deliberately simpler
// here (no transient-Mongo retry): this is a rare, human-run, one-shot
// tool, not a path this project has ever observed CI-contention failures
// on, so adding that complexity here would be unjustified.
async function recordOnboardingAudit(tenantId, outcome, metadata) {
  try {
    const doc = await EntityChunk.findOne({ tenantId: 'default', key: 'auditLog' }).lean();
    const container = { auditLog: doc?.data || [] };
    appendAuditEvent(container, {
      req: { tenantId: 'default' }, action: 'tenant.onboard', resourceType: 'tenant',
      resourceId: tenantId, outcome, metadata,
    });
    await EntityChunk.findOneAndUpdate(
      { tenantId: 'default', key: 'auditLog' },
      { $set: { tenantId: 'default', data: container.auditLog, updatedAt: new Date() } },
      { upsert: true },
    );
    return { ok: true };
  } catch (e) {
    console.error(`❌ فشل إلزامي: تعذّر تسجيل حدث تدقيق الإنشاء (tenant="${tenantId}", outcome="${outcome}") — ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenantId || !args.name || !args.slug || !args.email || !args.adminUsername) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!MONGO_URI) {
    console.error('❌ يتطلب اتصال MongoDB حقيقي (MONGO_URI) — إنشاء مستأجر جديد غير مدعوم في وضع الملفات.');
    process.exitCode = 1;
    return;
  }
  const adminPassword = process.env.TENANT_ADMIN_PASSWORD;
  if (!adminPassword) {
    console.error('❌ يتطلب متغيّر البيئة TENANT_ADMIN_PASSWORD (كلمة مرور الأدمن) — لن يُقبل كوسيط سطر أوامر.');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS) || 20000 });
  try {
    // Owner-review finding (lean review, LOW): an operator with the wrong
    // MONGO_URI set (e.g. a different environment than intended) would
    // otherwise create a real, if fully isolated, stray tenant with no
    // in-script confirmation of which database it actually landed in.
    // Echoes host+database name ONLY — mongoose.connection.host/.name
    // never include the credentials embedded in the connection string.
    console.log(`🏥 إنشاء عيادة جديدة: "${args.name}" (tenant-id="${args.tenantId}", slug="${args.slug}")`);
    console.log(`   ↳ قاعدة البيانات المستهدفة: ${mongoose.connection.host}/${mongoose.connection.name}`);
    console.log(`   ↳ هذا لا يمسّ المستأجر "default" أو أي مستأجر آخر إطلاقاً.`);
    if (!args.yes) {
      const answer = await ask('اكتب "نعم" لتأكيد إنشاء هذا المستأجر: ');
      if (answer !== 'نعم') {
        console.log('أُلغي الإنشاء — لم يُكتب أي شيء.');
        return;
      }
    }

    const result = await createClinicTenant({
      tenantId: args.tenantId, name: args.name, slug: args.slug, email: args.email,
      adminUsername: args.adminUsername, adminEmail: args.adminEmail, adminPassword,
      plan: args.plan, timezone: args.timezone, currency: args.currency, language: args.language,
    });
    if (!result.ok) {
      console.error(`❌ فشل إنشاء المستأجر (${result.stage}):`);
      for (const p of result.problems) console.error(`   - ${p}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✅ تم — المستأجر "${result.tenantId}" جاهز، بشجرة حسابات وأدوار كاملة.`);
    console.log(`   ↳ اسم المستخدم للدخول: ${result.adminUsername} (استخدم tenantId="${result.tenantId}" عند تسجيل الدخول)`);
  } finally {
    try { await mongoose.connection.close(); } catch {}
  }
}

if (require.main === module) {
  run();
}

module.exports = { run, parseArgs, createClinicTenant };
