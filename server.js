require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initDB, loadDB, saveDB, loadConfig, saveConfig, shutdownDB, runAsTenant, warmTenantCache,
  isFileFallbackMode,
} = require('./lib/database');
const { callAI, callAIVision } = require('./lib/ai');
const { calcCommission: _calcCommission } = require('./lib/calcCommission');
const { tenantMiddleware, getTenantInfo } = require('./lib/tenantMiddleware');
const { appendJournalEntry, validateJournalEntry, validateJournalBatch, scanUnresolvedAccounts, assertFinancialPeriodOpen, jeAmounts, JournalValidationError } = require('./lib/journalGuard');
// P0.12 — canonical financial idempotency service (closes P6-097). See
// lib/idempotency.js for the full contract.
const {
  IdempotencyConflictError, extractIdempotencyKey, validateIdempotencyKey, computeFingerprint,
  claimIdempotencyKey, completeIdempotencyClaim, finalizeIdempotencyClaimMongo, releaseIdempotencyClaim,
} = require('./lib/idempotency');

// P0.12 adversarial-review fix: by the time every call site below invokes
// this, the route's own saveDB(db,{durable:true}) has ALREADY succeeded —
// the real financial mutation is safely durable. finalizeIdempotencyClaimMongo
// is only the dedicated Mongo collection's own follow-up write; if IT fails
// (a second, independent Mongo round-trip), that must never turn into a
// failure response for a mutation that genuinely already succeeded, and
// must never propagate to a route's outer catch (some of which
// unconditionally call releaseIdempotencyClaim on any error — releasing
// here, after a real success, would wrongly let a future retry duplicate
// it). Worst case on failure: the dedicated collection keeps showing
// PROCESSING and self-heals via PROCESSING_TIMEOUT_MS like any other
// abandoned claim — logged, not thrown.
async function safeFinalizeIdempotencyClaimMongo(record) {
  try {
    await finalizeIdempotencyClaimMongo(record);
  } catch (e) {
    console.error('⚠️ finalizeIdempotencyClaimMongo failed (mutation already durably saved — dedicated record self-heals via PROCESSING_TIMEOUT_MS):', e.message);
  }
}
const { hasPermission } = require('./lib/authz');
const { appendAuditEvent } = require('./lib/auditLog');
const { projectDataForUser } = require('./lib/dataProjection');
const { buildTenantKey } = require('./lib/storage');
const stripe = require('./lib/stripe');
const Tenant = require('./models/Tenant');
const Subscription = require('./models/Subscription');

const app = express();
const PORT = process.env.PORT || 3000;

// P0.5 — Step 21: liveness/readiness, registered before any other
// middleware so they stay reachable even if something else misbehaves.
// Liveness proves only that the process is up and answering HTTP — no
// dependency checks — for an orchestrator's "should I kill+restart this
// process" decision. Readiness probes loadDB() directly rather than a
// manually-tracked flag: loadDB() throws "DB not initialized" until
// initDB() has completed, so this can never drift out of sync with the
// real underlying condition, and it reports the persistence mode actually
// in effect — for a "don't route traffic here yet" gate during
// startup/rolling deploys. Neither ever returns secrets, DB contents, or
// stack traces.
app.get('/api/health/live', (req, res) => {
  res.json({ status: 'ok' });
});
app.get('/api/health/ready', (req, res) => {
  try {
    loadDB();
  } catch {
    return res.status(503).json({ status: 'starting' });
  }
  let persistence = 'unknown';
  try { persistence = isFileFallbackMode() ? 'file' : 'mongo'; } catch { /* not yet known */ }
  res.json({ status: 'ready', persistence });
});

// ===== PATHS =====
// DATA_FILE/CONFIG_FILE are env-overridable so the system-tester can boot an
// isolated sandbox instance against a throwaway database (real data untouched).
const DATA_FILE   = process.env.DATA_FILE   || path.join(__dirname, 'data', 'database.json');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'data', 'config.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.ensureDirSync(path.join(__dirname, 'data'));
fs.ensureDirSync(UPLOADS_DIR);

// ===== MONGODB =====
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/boubyan_accounting';
// P0.11 (Part P — no credential exposure): a MONGO_URI following the
// standard mongodb://user:pass@host/db or mongodb+srv://user:pass@host/db
// form embeds real credentials in the connection string itself. Startup
// logging must never print those — this masks the userinfo segment while
// keeping the host/db visible (useful for confirming which cluster/db a
// deploy actually connected to).
//
// P0.11 (adversarial review finding, tenant-security persona): the original
// version used a single, non-greedy `[^@/]+@` regex — masking only up to
// the FIRST literal '@'. A password containing an unescaped '@' (a real,
// unremarkable password shape) left the password's remainder AND the real
// hostname in plaintext while the string still started with '***:***@',
// looking fully redacted at a glance. Fixed with a two-layer approach:
// prefer the WHATWG URL parser (correctly resolves username/password at the
// LAST '@', per spec — verified independently), falling back to a GREEDY
// regex (matches up to the last '@', not the first) only for connection-
// string shapes the URL parser rejects outright, such as a comma-separated
// multi-host replica-set authority (mongodb://user:pass@h1,h2,h3/db) — a
// real, common production shape neither the old regex nor a bare `new URL()`
// call handles correctly.
function redactMongoUri(uri) {
  const s = String(uri || '');
  try {
    const u = new URL(s);
    if (u.username || u.password) { u.username = '***'; u.password = '***'; }
    return u.toString();
  } catch (e) {
    return s.replace(/\/\/.*@/, '//***:***@');
  }
}

// ===== CONFIG HELPERS =====
const DEFAULT_CONFIG = {
  brand: { name: 'بوبيان لطب الأسنان', tagline: 'نظام المحاسبة والمالية' },
  modules: { dashboard:true, upload:true, import:true, manual:true, vouchers:true, cashrecon:true,
    insurance:true, payroll:true, doctors:true, expenses:true, vendors:true, journal:true,
    coa:true, financials:true, trialbalance:true, opening:true, bankrecon:true, assets:true,
    reports:true, ledger:true, inventory:true, ai:true, users:true, telegram:true, settings:true },
  labels: { agents:'الدكاترة', agent:'دكتور', agentsTab:'عمولات الدكاترة',
    agentsSubtitle:'محسوبة تلقائياً — تراكمية', commission:'العمولة', target:'الهدف الشهري',
    lab:'خصم المختبر', insurance:'التأمين', revenue:'الإيراد', agentIdField:'اسم الدكتور' },
  nav: { 'cat.main':'الرئيسية','cat.finance':'العمليات المالية','cat.accounting':'المحاسبة',
    'cat.reports':'التقارير','cat.inventory':'المخزون','cat.ai':'الذكاء الاصطناعي','cat.admin':'النظام',
    dashboard:'لوحة التحكم', upload:'رفع البيانات', import:'استيراد Excel', manual:'إدخال يدوي',
    vouchers:'السندات', cashrecon:'تسوية الصندوق', insurance:'مطالبات التأمين', payroll:'الرواتب',
    doctors:'الدكاترة', expenses:'المصاريف', vendors:'الموردون', journal:'القيود اليومية',
    coa:'دليل الحسابات', financials:'القوائم المالية', trialbalance:'ميزان المراجعة',
    opening:'الأرصدة الافتتاحية', bankrecon:'التسوية البنكية', assets:'الأصول الثابتة',
    reports:'التقارير', ledger:'دفتر الأستاذ', inventory:'المخزون', ai:'الذكاء الاصطناعي',
    users:'المستخدمون', telegram:'تيليجرام', settings:'الإعدادات' },
  commissionFormula: { base:'above_target', deductions:['lab'], method:'percentage',
    tiers:[{from:0,to:3000,rate:15},{from:3000,to:6000,rate:20},{from:6000,to:null,rate:25}] },
  insDeductionRate: 0.45,
  dashboard: { kpi: {
    kTotal:'إجمالي الإيرادات', kNet:'صافي (بدون تأمين)', kIns:'حصة التأمين',
    kComm:'إجمالي العمولات', kPend:'عمولات معلّقة'
  }},
  importTemplates: {
    expenses:'المصاريف', inventory:'الأرصدة الافتتاحية للمخزون',
    doctors:'مدفوعات الدكاترة', journal:'قيود يومية جماعية', patients:'أرصدة المرضى الافتتاحية'
  },
  automation: {
    dailySummary:      { enabled: true,  hour: 20 },
    inventoryAlert:    { enabled: true },
    targetAlert:       { enabled: true },
    pendingReminder:   { enabled: true,  dayOfWeek: 4 },
    insuranceAlert:    { enabled: true,  daysThreshold: 30 },
    closingReminder:   { enabled: true,  daysBeforeEnd: 3 },
    anomalyDetection:  { enabled: true,  multiplier: 2.0 },
    revenueVariance:   { enabled: true,  threshold: 30 },
    doctorRanking:     { enabled: true },
    goalProgress:      { enabled: true }
  }
};

// Safe unique ID — cryptographically random suffix
const crypto = require('crypto');
function genId(prefix = '') {
  return `${prefix}${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

// أوجِد حساباً أو أنشئه في شجرة الحسابات (يمنع القيود على حسابات غير موجودة
// التي تُخلّ بميزان المراجعة)
function ensureAccount(db, code, name, type, parent) {
  const coa = db.chartOfAccounts || (db.chartOfAccounts = []);
  let acc = coa.find(a => String(a.code) === String(code));
  if (!acc) {
    acc = { id: String(code), code: String(code), name, type,
      parent: parent || null, parentId: parent || null,
      normalBalance: ['asset', 'expense'].includes(type) ? 'debit' : 'credit',
      isGroup: false, status: 'active', balance: 0, createdAt: new Date().toISOString() };
    coa.push(acc);
  }
  return acc;
}

// آخر يوم صحيح في الشهر (يمنع تواريخ خاطئة مثل 2026-02-30)
function monthEndDate(month) {
  const m = /^\d{4}-\d{2}$/.test(String(month)) ? String(month) : new Date().toISOString().slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(y, mo, 0).getDate(); // اليوم 0 من الشهر التالي = آخر يوم في هذا الشهر
  return `${m}-${String(last).padStart(2, '0')}`;
}

// Sequential journal entry ID: JE-YYYY-NNNN
function nextJeId(db) {
  const year = new Date().getFullYear();
  const prefix = `JE-${year}-`;
  const entries = db.journalEntries || [];
  let max = 0;
  entries.forEach(e => {
    if (e.id && e.id.startsWith(prefix)) {
      const n = parseInt(e.id.slice(prefix.length)) || 0;
      if (n > max) max = n;
    }
  });
  return prefix + String(max + 1).padStart(4, '0');
}

// ===== SECURITY MIDDLEWARE =====

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data:; " +
    "connect-src 'self';"
  );
  next();
});

// CORS — نفس الموقع مسموح دائماً (المتصفح يرسل Origin مع كل POST/PUT/DELETE حتى
// لنفس الموقع — القائمة القديمة كانت ترفضها فتتعطل كل أزرار الحفظ/التعديل/الحذف
// بخطأ 500 بينما قراءة الصفحات تعمل). القائمة البيضاء تبقى للأصول الخارجية فقط.
const allowedOrigins = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://127.0.0.1:3000']).map(s => s.trim().replace(/\/+$/, ''));

app.use((req, res, next) => cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const o = String(origin).replace(/\/+$/, '');
    if (allowedOrigins.includes(o)) return cb(null, true);
    try { if (new URL(o).host === req.headers.host) return cb(null, true); } catch {}       // same-origin
    try { if (process.env.RENDER_EXTERNAL_URL && new URL(o).host === new URL(process.env.RENDER_EXTERNAL_URL).host) return cb(null, true); } catch {}
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
})(req, res, next));

// ── Stripe: Webhook (raw body required) ──────────────────────
// P0.5 — Step 11/12: MUST be registered before app.use(express.json(...))
// below and before the optional API_SECRET gate. Express runs app.use()
// middleware in registration order for every matching request — the old
// registration (near the bottom of this file, far after express.json())
// meant the global JSON parser had already read and consumed the request
// stream before this route's own express.raw() ever ran, leaving it either
// an already-parsed object or a drained/empty stream. Either way Stripe
// signature verification (which needs the exact original raw bytes) could
// never succeed — every real Stripe webhook call was silently broken.
// Stripe also cannot send our custom x-api-secret header, so this must also
// sit before that gate; it authenticates itself via Stripe's own signature.
const ProcessedWebhookEvent = require('./models/ProcessedWebhookEvent');
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'Missing stripe-signature' });

    let event;
    try {
      event = await stripe.handleWebhook(req.body, sig);
    } catch (e) {
      console.error('❌ Stripe webhook error:', e.message);
      return res.status(400).json({ error: e.message });
    }

    // P0.5 — Step 13: durable idempotency. Stripe retries delivery on
    // anything but a 2xx response, and can deliver the same event more than
    // once under normal operation — a Mongo unique-index insert is the
    // dedup boundary (atomic, durable across restarts, safe under multiple
    // instances), not an in-memory Set that forgets everything on restart.
    try {
      await ProcessedWebhookEvent.create({ provider: 'stripe', eventId: event.id, type: event.type });
    } catch (e) {
      if (e.code === 11000) return res.json({ received: true, duplicate: true });
      console.error('❌ Stripe webhook dedup-store error:', e.message);
      // Dedup store itself failed (e.g. Mongo hiccup) — proceed rather than
      // silently drop a legitimate event; worst case is a rare double-apply
      // of an idempotent Subscription upsert, not a lost one.
    }

    const obj = event.data.object;
    const tenantId = obj.metadata?.tenantId;
    if (!tenantId) return res.json({ received: true }); // not our event

    try {
      let auditAction = null, auditAfter = null;

      if (event.type === 'checkout.session.completed') {
        const sub = obj.subscription;
        const plan = obj.metadata?.plan || 'starter';
        await Subscription.findOneAndUpdate(
          { tenantId },
          { plan, status: 'active', stripeSubscriptionId: sub,
            currentPeriodStart: new Date(), cancelAtPeriodEnd: false },
          { upsert: true, new: true },
        );
        await Tenant.findOneAndUpdate({ tenantId }, { plan });
        console.log(`✅ Stripe: checkout.session.completed → tenant=${tenantId} plan=${plan}`);
        auditAction = 'subscription.activated_via_webhook';
        auditAfter = { plan, status: 'active' };
      }

      if (event.type === 'customer.subscription.updated') {
        const plan = obj.metadata?.plan || obj.items?.data[0]?.price?.nickname || 'starter';
        await Subscription.findOneAndUpdate(
          { tenantId },
          {
            plan,
            status: obj.status,
            currentPeriodStart: new Date(obj.current_period_start * 1000),
            currentPeriodEnd:   new Date(obj.current_period_end   * 1000),
            cancelAtPeriodEnd:  obj.cancel_at_period_end,
          },
        );
        await Tenant.findOneAndUpdate({ tenantId }, { plan });
        auditAction = 'subscription.updated_via_webhook';
        auditAfter = { plan, status: obj.status, cancelAtPeriodEnd: obj.cancel_at_period_end };
      }

      if (event.type === 'customer.subscription.deleted') {
        await Subscription.findOneAndUpdate(
          { tenantId },
          { status: 'cancelled', plan: 'trial' },
        );
        await Tenant.findOneAndUpdate({ tenantId }, { plan: 'trial', status: 'active' });
        console.log(`⚠️  Stripe: subscription deleted → tenant=${tenantId}`);
        auditAction = 'subscription.cancelled_via_webhook';
        auditAfter = { plan: 'trial', status: 'cancelled' };
      }

      // P0.5 — Step 12: audit subscription state changes triggered by Stripe
      // itself, not just ones triggered through our own authenticated routes.
      if (auditAction) {
        try {
          await runAsTenant(tenantId, async () => {
            await warmTenantCache(tenantId);
            const db = loadDB();
            appendAuditEvent(db, {
              req: { ip: req.ip, headers: req.headers, path: req.path, tenantId },
              action: auditAction, resourceType: 'subscription', resourceId: tenantId,
              outcome: 'success', after: auditAfter,
              metadata: { stripeEventId: event.id, stripeEventType: event.type },
            });
            saveDB(db);
          });
        } catch (e) { console.error('❌ Stripe webhook audit-log error:', e.message); }
      }
    } catch (e) {
      console.error('❌ Stripe webhook handler error:', e.message);
    }

    res.json({ received: true });
  }
);

// Optional machine-to-machine API key — browser SPA uses JWT instead.
const API_SECRET = process.env.API_SECRET;
app.use('/api', (req, res, next) => {
  if (!API_SECRET) return next();
  // Public login/branding + JWT-authenticated SPA requests must not require x-api-secret.
  if (req.path.startsWith('/auth/') || req.path.startsWith('/public/')) return next();
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) return next();
  // Also allow direct-download links that carry a valid JWT via _token query param
  if (req.query._token) {
    try { jwt.verify(req.query._token, JWT_SECRET); return next(); } catch {}
  }
  const secret = req.headers['x-api-secret'] || req.query._secret;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Rate limiting — max 200 req/min per IP for API, 10/min for AI endpoints
const rateCounts = new Map();
// Cleanup old entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateCounts.entries()) {
    if (now - entry.start > 120000) rateCounts.delete(key);
  }
}, 5 * 60 * 1000);

function rateLimit(max, windowMs = 60000) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const entry = rateCounts.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
    entry.count++;
    rateCounts.set(key, entry);
    if (entry.count > max) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}
app.use('/api/ai', rateLimit(10));  // 10 AI calls/min
app.use('/api', rateLimit(200));    // 200 API calls/min
app.use(require('compression')());  // HTTP Gzip compression — IAS 8 audit: performance

// Body size limit + depth limit (prevent deeply nested JSON DoS)
app.use(express.json({ limit: '5mb', strict: true }));
// لا تُخزِّن صفحات HTML في المتصفح — حتى يصل أي تحديث للمستخدم فوراً بعد النشر
// (بدون هذا، المتصفح يبقى يعرض نسخة index.html القديمة رغم نشر الإصلاحات).
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// File upload — restrict to Excel only, max 10MB
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('Only Excel files allowed'));
    cb(null, true);
  }
});

// Sanitize string helper — encode HTML entities to prevent XSS
function sanitize(val, maxLen = 500) {
  if (typeof val !== 'string') return val;
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .substring(0, maxLen);
}
// Reverse for display (when data is already sanitized and we need the original)
function desanitize(val) {
  if (typeof val !== 'string') return val;
  return val
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
}

// ===== JWT =====
// P0.5 — Step 17/18: production startup validation, extended beyond the
// original "is JWT_SECRET merely set" check to also reject known-dangerous
// values (empty/"secret"/"changeme"/the dev default itself/too short) and
// warn on a handful of other risky-default env combinations. See
// lib/secretValidation.js for the full rule set and rationale — kept in its
// own pure module so it's unit-testable without booting a real server.
const { validateProductionSecrets } = require('./lib/secretValidation');
{
  const { ok, problems } = validateProductionSecrets(process.env);
  for (const p of problems) {
    const prefix = p.level === 'fatal' ? '🚨 FATAL' : '⚠️  WARNING';
    console[p.level === 'fatal' ? 'error' : 'warn'](`${prefix} [${p.code}]: ${p.message}`);
  }
  if (!ok) {
    console.error('🚨 Refusing to start with a dangerous production configuration.');
    process.exit(1);
  }
}

// P0.5A — Step 15: this app is SINGLE-INSTANCE ONLY (in-process cache, no
// cross-instance cache sync — see docs/PRODUCTION_RUNBOOK.md §4). There is
// no reliable, universal way to detect "another instance of me is running
// elsewhere" from inside one process, so this is a best-effort, non-fatal
// heads-up for the handful of common platform env vars that indicate a
// multi-worker/cluster launch was configured — it does NOT solve
// multi-instance safety, it only surfaces the misconfiguration earlier than
// "data mysteriously reverts" would.
{
  const concurrencySignals = [
    process.env.WEB_CONCURRENCY && Number(process.env.WEB_CONCURRENCY) > 1 ? `WEB_CONCURRENCY=${process.env.WEB_CONCURRENCY}` : null,
    process.env.NODE_APP_INSTANCE ? `NODE_APP_INSTANCE=${process.env.NODE_APP_INSTANCE}` : null,
    process.env.INSTANCE_ID ? `INSTANCE_ID=${process.env.INSTANCE_ID}` : null,
  ].filter(Boolean);
  if (concurrencySignals.length) {
    console.warn(`⚠️  WARNING [MULTI_INSTANCE_SIGNAL_DETECTED]: ${concurrencySignals.join(', ')} — this app is SINGLE-INSTANCE ONLY. Running more than one process against the same database WILL cause lost writes. See docs/PRODUCTION_RUNBOOK.md §4.`);
  }
}

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    // Unreachable in practice — validateProductionSecrets() above already
    // exits on a missing JWT_SECRET in production — kept as defense in depth.
    console.error('🚨 FATAL: JWT_SECRET not set in production!');
    process.exit(1);
  }
  console.warn('⚠️  JWT_SECRET not set — using insecure default (dev only)');
  return 'boubyan-dental-dev-only-NOT-for-production';
})();
const JWT_EXPIRES = '12h';

// All tabs/actions + default COA + roles — moved to lib/defaults.js (تفكيك تدريجي، CLAUDE.md بند 6)
const { ALL_TABS, ALL_ACTIONS, DEFAULT_COA, DEFAULT_ROLES } = require('./lib/defaults');


// Auth middleware — verifies JWT on all /api routes except /api/auth/*
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  // Also accept token as query param (for direct-download links like Excel/PPTX)
  const token = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query._token || null;
  if (!token) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'انتهت جلسة العمل — يرجى تسجيل الدخول مجدداً' });
  }
}

// Permission check helper — P0.4: now a thin wrapper over lib/authz.js's
// hasPermission() so there is exactly one implementation of the tab/action
// policy (previously duplicated here); kept for backward compatibility with
// the one pre-existing call site (GET /api/users) and any future inline use.
function can(user, tab, action = 'view') {
  return hasPermission(user, tab, action, loadDB());
}

// ─── P0.4: Server-side authorization middleware ────────────────────────────
// Centralizes what used to be ~15 repeated `if (req.user.role !== 'admin')`
// blocks plus zero enforcement on ~175 other mutating routes. Both factories
// run AFTER requireAuth + tenantMiddleware, so req.user.role here is always
// the LIVE role (tenantMiddleware._refreshLiveUser refreshed it this
// request — P0.4 Step 4), never a stale/forged value from the JWT or from
// req.body/query — nothing here ever reads permission data from the request
// itself. Fails closed: any error/missing user -> 403, never silently allow.

// requirePermission(tab, action) — reuses the EXACT existing tab/action
// policy (lib/defaults.js DEFAULT_ROLES / db.roles), matching the same
// model the frontend already uses to decide what to show. No new permission
// vocabulary was invented (P0.4 Step 2).
function requirePermission(tab, action) {
  return (req, res, next) => {
    // req.user.role is already the LIVE role — tenantMiddleware refreshes it
    // from the current user record on every request (P0.4 Step 4).
    if (!req.user) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
    if (!hasPermission(req.user, tab, action, loadDB())) {
      auditDenied(req, `${tab}.${action}`, tab);
      return res.status(403).json({ error: 'غير مصرح — صلاحياتك لا تشمل هذا الإجراء' });
    }
    next();
  };
}

// requireAdminAction — for the handful of resources the existing UI never
// modeled as a tab at all (user/role management, period lock/close, fixed
// assets, bank reconciliation — see lib/authz.js's header comment for why).
// Every one of these was already either explicitly admin-gated or reachable
// by no non-admin role's `tabs` list in DEFAULT_ROLES, so this preserves
// exactly who could already use these screens while finally enforcing it
// server-side.
function requireAdminAction(actionLabel) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
      auditDenied(req, actionLabel, 'admin');
      return res.status(403).json({ error: 'غير مصرح — المدير فقط' });
    }
    next();
  };
}

// Bounded security audit event for a 403 — never logs the request body
// (attacker-controlled, unbounded) to avoid turning this into a DoS/log-
// injection vector (P0.4 Step 12).
function auditDenied(req, action, resourceType) {
  try {
    const db = loadDB();
    appendAuditEvent(db, {
      req, action: 'authorization.denied', resourceType, outcome: 'failure',
      metadata: { attemptedAction: String(action).slice(0, 80), method: req.method, path: String(req.path || '').slice(0, 200) },
    });
    saveDB(db);
  } catch { /* never let audit logging break the actual denial response */ }
}

// ===== DATABASE (MongoDB-backed, in-memory cache for sync access) =====
function buildInitialDB() {
  return {
    users: [],
    roles: {
      admin:       { ...DEFAULT_ROLES.admin,       id: 'admin' },
      accountant:  { ...DEFAULT_ROLES.accountant,  id: 'accountant' },
      receptionist:{ ...DEFAULT_ROLES.receptionist,id: 'receptionist' },
      inventory:   { ...DEFAULT_ROLES.inventory,   id: 'inventory' },
      viewer:      { ...DEFAULT_ROLES.viewer,       id: 'viewer' },
    },
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
    scheduleConfig: { weeklyReport: true, weeklyDay: 0, monthlyReport: true },
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
    // P0.6A — Step 1 (P6-040): kept in lockstep with lib/database.js's
    // emptyDBShape() — see ENTITY_KEYS there for why each of these persists.
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
    // P0.6A verification pass had added `bankRecons` to lib/database.js's
    // emptyDBShape() but missed this real-boot-path twin — added now
    // alongside P0.7's `vendorBills` for consistency (both must exist so a
    // truly fresh MongoDB-mode boot starts with the correct empty shape).
    bankRecons: [],
    vendorBills: [],
    // P0.8 — the new patient Accounts Receivable subledger (see
    // lib/database.js's ENTITY_KEYS for the matching registration).
    patients: [],
    patientReceivables: [],
  };
}

// Apply idempotent migrations/seeds to a db object. Returns true if mutated.
function migrateDB(db) {
  let changed = false;
  if (!db.chartOfAccounts || db.chartOfAccounts.length === 0) {
    db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
    changed = true;
  } else {
    // Fix misnamed accounts and add missing ones
    const coaFixes = {
      '4100': 'إيرادات نقدية — كاش',
      '4110': 'إيرادات K-Net',
      '4120': 'إيرادات Visa',
      '4130': 'إيرادات Master',
      '4140': 'إيرادات Link',
      '1110': 'البنك — الحساب الجاري',
      '1120': 'K-Net / Visa / Master — مستحقات',
      '1125': 'مستحقات الشبكة — Visa/Master/KNET/Link',
      '1130': 'ذمم مدينة — شركات التأمين',
    };
    for (const [code, correctName] of Object.entries(coaFixes)) {
      const acc = db.chartOfAccounts.find(a => a.code === code);
      if (acc && acc.name !== correctName) { acc.name = correctName; changed = true; }
    }
    // Add missing accounts
    const newAccounts = [
      { id:'4150', code:'4150', name:'إيرادات تأمين — إجمالي',             type:'revenue', parent:'4000', balance:0 },
      { id:'4160', code:'4160', name:'إيرادات شيكات',                       type:'revenue', parent:'4000', balance:0 },
      { id:'1125', code:'1125', name:'مستحقات الشبكة — Visa/Master/KNET/Link', type:'asset', parent:'1000', balance:0 },
      { id:'5760', code:'5760', name:'خصم التأمين — حسم شركات التأمين',     type:'expense', parent:'5700', balance:0 },
    ];
    for (const acc of newAccounts) {
      if (!db.chartOfAccounts.find(a => a.code === acc.code)) {
        db.chartOfAccounts.push({ ...acc });
        changed = true;
      }
    }
  }
  // R2 — additive role-grant backfill (verified defect, live-reproduced by
  // adversarial review): db.roles is only ever seeded wholesale when
  // entirely missing (see the block below and buildInitialDB()), so a
  // tenant whose db.roles.* was already persisted before a DEFAULT_ROLES
  // change (new tab, new action) silently never receives it — e.g. the
  // R2 nav tabs (vendorbills/patients/patientreceivables) and the P0.8
  // accountant.manual edit/delete grant. Union in only entries DEFAULT_ROLES
  // already specifies for that exact role; never remove or downgrade
  // anything a tenant may have customized (same additive spirit as the
  // COA-fix block above).
  if (db.roles) {
    for (const [roleId, def] of Object.entries(DEFAULT_ROLES)) {
      const role = db.roles[roleId];
      if (!role) continue;
      if (Array.isArray(role.tabs) && Array.isArray(def.tabs)) {
        for (const tab of def.tabs) {
          if (!role.tabs.includes(tab)) { role.tabs.push(tab); changed = true; }
        }
      }
      if (role.actions && def.actions) {
        for (const [tab, acts] of Object.entries(def.actions)) {
          if (!Array.isArray(role.actions[tab])) { role.actions[tab] = [...acts]; changed = true; continue; }
          for (const act of acts) {
            if (!role.actions[tab].includes(act)) { role.actions[tab].push(act); changed = true; }
          }
        }
      }
    }
  }
  if (!db.users || db.users.length === 0) {
    const adminHash = bcrypt.hashSync(process.env.ADMIN_DEFAULT_PASSWORD || 'Admin@2026', 10);
    db.users = [{
      id: 'usr-1',
      username: (process.env.ADMIN_DEFAULT_USERNAME || 'admin').trim(),
      email: (process.env.ADMIN_DEFAULT_EMAIL || 'admin@boubyan.com').trim(),
      passwordHash: adminHash, role: 'admin',
      fullName: process.env.ADMIN_DEFAULT_FULLNAME || 'مدير النظام', active: true,
      createdAt: new Date().toISOString(), lastLogin: null
    }];
    db.roles = {
      admin:       { ...DEFAULT_ROLES.admin,        id: 'admin' },
      accountant:  { ...DEFAULT_ROLES.accountant,   id: 'accountant' },
      receptionist:{ ...DEFAULT_ROLES.receptionist, id: 'receptionist' },
      inventory:   { ...DEFAULT_ROLES.inventory,    id: 'inventory' },
      viewer:      { ...DEFAULT_ROLES.viewer,        id: 'viewer' },
    };
    changed = true;
  }
  return changed;
}

['SIGINT', 'SIGTERM'].forEach(sig =>
  process.once(sig, () => { shutdownDB().finally(() => process.exit(0)); }));

// P0.5 — Step 22: Node's own default behavior on an uncaught synchronous
// exception is already to print it and exit — the correct instinct for
// "unknown corrupted state" (do not blindly keep serving requests past an
// exception nothing anticipated). This handler makes that explicit instead
// of relying on the implicit default, and adds one improvement: a bounded,
// best-effort attempt to flush pending database writes before exiting, so
// an in-flight debounced save isn't ALSO lost on top of whatever crashed.
// Never logs more than err.message — no stack trace, no request body, no
// secrets — logCrash() already applies the same bounded/sanitized shape
// used for every other crash record.
process.once('uncaughtException', (err) => {
  console.error('🚨 FATAL — uncaughtException:', err && err.message);
  try { if (typeof logCrash === 'function') logCrash('uncaughtException', err && err.message, {}); } catch {}
  const hardExit = setTimeout(() => process.exit(1), 10000);
  hardExit.unref();
  shutdownDB().catch(() => {}).finally(() => process.exit(1));
});

// ===== EXCEL PARSER =====
function parseDailyIncome(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  
  const records = [];
  
  // Find header row and map column positions
  let colMap = null;
  let headerRowIdx = -1;
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowStr = row.map(c => String(c)).join('|').toLowerCase();
    if (rowStr.includes('date') && rowStr.includes('cash') && rowStr.includes('k-net')) {
      headerRowIdx = i;
      // Map columns by name
      colMap = {};
      for (let j = 0; j < row.length; j++) {
        const h = String(row[j]).trim().toLowerCase();
        if (h === 'date') colMap.date = j;
        else if (h === 'cash') colMap.cash = j;
        else if (h === 'k-net') colMap.knet = j;
        else if (h === 'visa') colMap.visa = j;
        else if (h === 'master') colMap.master = j;
        else if (h === 'insurance') colMap.insurance = j;
        else if (h === 'cheque') colMap.cheque = j;
        else if (h === 'link') colMap.link = j;
        else if (h === 'total') colMap.total = j;
        else if (h === 'advance') colMap.advance = j;
      }
      break;
    }
  }
  
  if (!colMap) return records;
  
  // Parse data rows
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const firstCell = String(row[colMap.date] || '').trim();
    
    if (!firstCell || firstCell === '0') continue;

    // R3 — P6-028 (Excel serial dates): a genuine Excel date-typed cell
    // comes through `sheet_to_json(ws,{header:1})` as a raw numeric serial
    // (e.g. 45852), not the 'DD/MM/YYYY' text string this parser expects —
    // it used to fail the regex below and be silently dropped. Excel's
    // epoch is 1899-12-30 (accounting for the historical 1900 leap-year
    // bug), so a serial number converts via +N days from that date.
    let isoDate = null;
    const rawDateCell = row[colMap.date];
    if (typeof rawDateCell === 'number' && rawDateCell > 0) {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(epoch.getTime() + rawDateCell * 86400000);
      isoDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    } else if (/^\d{2}\/\d{2}\/\d{4}/.test(firstCell)) {
      const parts = firstCell.split('/');
      isoDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
    } else if (/^\d{4}-\d{2}-\d{2}/.test(firstCell)) {
      isoDate = firstCell.slice(0, 10);
    }
    if (!isoDate) continue;

    const getVal = (col) => col !== undefined ? (parseFloat(row[col]) || 0) : 0;

    const record = {
      date:      isoDate,
      cash:      getVal(colMap.cash),
      knet:      getVal(colMap.knet),
      visa:      getVal(colMap.visa),
      master:    getVal(colMap.master),
      insurance: getVal(colMap.insurance),
      cheque:    getVal(colMap.cheque),
      link:      getVal(colMap.link),
      total:     getVal(colMap.total),
      advance:   getVal(colMap.advance),
    };
    
    records.push(record);
  }
  return records;
}

function parsePaymentsDetails(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  
  const records = [];
  let colMap = null;
  let headerRowIdx = -1;
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowStr = row.map(c => String(c)).join('|').toLowerCase();
    if (rowStr.includes('doctor') && (rowStr.includes('inv id') || rowStr.includes('inv. total'))) {
      headerRowIdx = i;
      colMap = {};
      for (let j = 0; j < row.length; j++) {
        const h = String(row[j]).trim().toLowerCase();
        if (h === 'inv id') colMap.invId = j;
        else if (h === 'patient name') colMap.patient = j;
        else if (h === 'file no') colMap.fileNo = j;
        else if (h === 'date') colMap.date = j;
        else if (h === 'doctor') colMap.doctor = j;
        else if (h === 'k-net') colMap.knet = j;
        else if (h === 'visa') colMap.visa = j;
        else if (h === 'master') colMap.master = j;
        else if (h === 'link') colMap.link = j;
        else if (h === 'gig-globmed') colMap.gig = j;
        else if (h === 'inv. total') colMap.total = j;
      }
      break;
    }
  }
  
  if (!colMap) return records;
  
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const invId = parseInt(row[colMap.invId]);
    if (!invId || isNaN(invId)) continue;
    
    const dateStr = String(row[colMap.date] || '').trim();
    if (!/\d{2}\/\d{2}\/\d{4}/.test(dateStr)) continue;
    const parts = dateStr.split('/');
    const isoDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
    
    const getVal = (col) => col !== undefined ? (parseFloat(row[col]) || 0) : 0;
    
    records.push({
      invId,
      patient: String(row[colMap.patient] || '').trim(),
      fileNo:  String(row[colMap.fileNo] || '').trim(),
      date:    isoDate,
      doctor:  String(row[colMap.doctor] || '').trim(),
      knet:    getVal(colMap.knet),
      visa:    getVal(colMap.visa),
      master:  getVal(colMap.master),
      link:    getVal(colMap.link),
      gig:     getVal(colMap.gig),
      total:   getVal(colMap.total),
    });
  }
  return records;
}

function calcCommission(dr, revenue) {
  const cfg = loadConfig();
  return _calcCommission(dr, revenue, cfg.commissionFormula || {});
}

function getMonth(dateStr) {
  return dateStr.substring(0, 7); // yyyy-mm
}

// ===== AUTH ROUTES (public — no token needed) =====

// ── حماية من التخمين (brute-force): قفل تصاعدي لكل (مستخدم + IP) ──
// 5 محاولات فاشلة → قفل 5 دقائق، يتضاعف مع كل قفل لاحق حتى 60 دقيقة.
const _loginFails = new Map(); // key → { count, lockedUntil, locks }
setInterval(() => { const now = Date.now();
  for (const [k, v] of _loginFails) if (now - (v.last || 0) > 3600000) _loginFails.delete(k);
}, 10 * 60 * 1000);

// P0.1 — tenant-aware login: the tenant identity MUST be resolved before the
// user lookup happens (CLAUDE.md multi-tenancy / forensic-audit finding #2).
// An optional `tenantId` in the request body lets a SaaS login screen target
// a specific company workspace. Omitting it (or sending 'default') preserves
// the original single-clinic install's exact prior behavior byte-for-byte.
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });

    const requestedTenantId = (req.body.tenantId && String(req.body.tenantId).trim()) || 'default';

    const fkey = String(username).toLowerCase() + '|' + req.ip + '|' + requestedTenantId;
    const rec = _loginFails.get(fkey) || { count: 0, locks: 0, lockedUntil: 0, last: 0 };
    if (rec.lockedUntil > Date.now()) {
      const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `تم قفل تسجيل الدخول مؤقتاً بعد محاولات فاشلة متكررة — حاول بعد ${mins} دقيقة` });
    }

    const registerFail = () => {
      rec.count++; rec.last = Date.now();
      if (rec.count >= 5) {
        rec.locks++; rec.count = 0;
        rec.lockedUntil = Date.now() + Math.min(60, 5 * Math.pow(2, rec.locks - 1)) * 60000;
      }
      _loginFails.set(fkey, rec);
    };
    // P0.4 — Step 12: audit every failed login when a tenant-scoped db is
    // available (i.e. inside runAsTenant below, where reason is meaningful —
    // "wrong password" vs "no such user" vs "tenant mismatch" — without ever
    // exposing that distinction to the CLIENT, which always gets the same
    // generic 401 message either way, so this never becomes a username-
    // enumeration oracle).
    const genericFail = (db, reason) => {
      registerFail();
      if (db) {
        try {
          appendAuditEvent(db, {
            req: { ip: req.ip, headers: req.headers, path: req.path, tenantId },
            action: 'login.failure', resourceType: 'session', outcome: 'failure',
            metadata: { username: String(username).slice(0, 100), reason, tenantId },
          });
          saveDB(db);
        } catch { /* never let audit logging block the 401 response */ }
      }
      res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    };

    // Fail closed (Step 6): a non-default tenant identity must be a real,
    // ACTIVE tenant whenever we have a registry to check against (MongoDB
    // mode). We never fall through to search the default tenant's users on
    // an invalid tenantId — same generic message either way (no enumeration).
    const tenantId = requestedTenantId;
    if (tenantId !== 'default' && require('mongoose').connection.readyState === 1) {
      const tenant = await Tenant.findOne({ tenantId }).lean();
      if (!tenant || tenant.status !== 'active') return genericFail(null, 'tenant_inactive_or_unknown');
    }

    await runAsTenant(tenantId, async () => {
      if (tenantId !== 'default') await warmTenantCache(tenantId);

      const db = loadDB();
      const user = (db.users || []).find(u => u.username === username || u.email === username);
      if (!user || !user.active) return genericFail(db, 'user_not_found_or_inactive');
      // Defense-in-depth (Step 6 — "tenant identity inconsistent with the
      // user"): a user record pulled from tenant X's own isolated cache must
      // actually belong to tenant X.
      if (tenantId !== 'default' && user.tenantId && user.tenantId !== tenantId) return genericFail(db, 'tenant_mismatch');

      const valid = bcrypt.compareSync(password, user.passwordHash);
      if (!valid) return genericFail(db, 'invalid_password');

      _loginFails.delete(fkey); // نجاح → صفّر العداد

      // Update lastLogin
      user.lastLogin = new Date().toISOString();
      appendAuditEvent(db, {
        req: { user: { id: user.id, username: user.username, role: user.role }, ip: req.ip, headers: req.headers, path: req.path, tenantId },
        action: 'login.success', resourceType: 'session', resourceId: user.id, outcome: 'success',
        metadata: { tenantId },
      });
      saveDB(db);

      // Build permissions from role
      const roleObj = (db.roles || {})[user.role] || DEFAULT_ROLES[user.role] || DEFAULT_ROLES.viewer;
      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, fullName: user.fullName, tenantId },
        JWT_SECRET, { expiresIn: JWT_EXPIRES }
      );

      res.json({
        success: true,
        token,
        user: { id: user.id, username: user.username, email: user.email, fullName: user.fullName, role: user.role },
        permissions: { tabs: roleObj.tabs || [], actions: roleObj.actions || {} }
      });
    });
  } catch (e) {
    console.error('❌ login error:', e.message);
    res.status(500).json({ error: 'تعذر تسجيل الدخول — حاول لاحقاً' });
  }
});

// هوية الشركة لشاشة الدخول (عام — لا يكشف أي بيانات حساسة، فقط الاسم والشعار)
app.get('/api/public/branding', (req, res) => {
  try {
    const db = loadDB();
    const c = db.companyInfo || {};
    res.json({ name: c.name || 'نظام المحاسبة الذكي', logo: c.logo || '' });
  } catch { res.json({ name: 'نظام المحاسبة الذكي', logo: '' }); }
});

app.get('/api/auth/me', requireAuth, tenantMiddleware, (req, res) => {
  const db = loadDB();
  const user = (db.users || []).find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const roleObj = (db.roles || {})[user.role] || DEFAULT_ROLES[user.role] || DEFAULT_ROLES.viewer;
  res.json({
    user: { id: user.id, username: user.username, email: user.email, fullName: user.fullName, role: user.role, lastLogin: user.lastLogin },
    permissions: { tabs: roleObj.tabs || [], actions: roleObj.actions || {} }
  });
});

// ── User Management (admin only) ──────────────────
app.get('/api/users', requireAuth, tenantMiddleware, requireAdminAction('users.view'), (req, res) => {
  if (!can(req.user, 'settings', 'view')) return res.status(403).json({ error: 'غير مصرح' });
  const db = loadDB();
  const users = (db.users || []).map(u => ({ id: u.id, username: u.username, email: u.email, fullName: u.fullName, role: u.role, active: u.active, createdAt: u.createdAt, lastLogin: u.lastLogin }));
  res.json(users);
});

app.post('/api/users', requireAuth, tenantMiddleware, requireAdminAction('users.create'), async (req, res) => {
  const { username, password, email, fullName, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
  if (password.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  const db = loadDB();
  if ((db.users || []).find(u => u.username === username)) return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });
  const newUser = {
    id: genId('usr-'),
    username: sanitize(username, 50),
    email: sanitize(email || '', 100),
    fullName: sanitize(fullName || username, 100),
    passwordHash: bcrypt.hashSync(password, 10),
    role: role || 'viewer',
    active: true,
    createdAt: new Date().toISOString(),
    lastLogin: null
  };
  db.users.push(newUser);
  appendAuditEvent(db, { req, action: 'user.created', resourceType: 'user', resourceId: newUser.id,
    after: { username: newUser.username, email: newUser.email, role: newUser.role, active: newUser.active } });
  saveDB(db);
  res.json({ success: true, id: newUser.id });
});

app.put('/api/users/:id', requireAuth, tenantMiddleware, requireAdminAction('users.update'), async (req, res) => {
  const db = loadDB();
  const idx = db.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const before = { email: db.users[idx].email, fullName: db.users[idx].fullName, role: db.users[idx].role, active: db.users[idx].active };
  const { email, fullName, role, active, password } = req.body;
  if (email)    db.users[idx].email    = sanitize(email, 100);
  if (fullName) db.users[idx].fullName = sanitize(fullName, 100);
  if (role)     db.users[idx].role     = role;
  if (active !== undefined) db.users[idx].active = !!active;
  if (password) db.users[idx].passwordHash = bcrypt.hashSync(password, 10);
  const after = { email: db.users[idx].email, fullName: db.users[idx].fullName, role: db.users[idx].role, active: db.users[idx].active };
  appendAuditEvent(db, { req, action: role ? 'user.role_changed' : 'user.updated', resourceType: 'user', resourceId: req.params.id, before, after });
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/users/:id', requireAuth, tenantMiddleware, requireAdminAction('users.delete'), (req, res) => {
  const db = loadDB();
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'لا يمكن حذف حسابك الخاص' });
  const target = db.users.find(u => u.id === req.params.id);
  db.users = db.users.filter(u => u.id !== req.params.id);
  appendAuditEvent(db, { req, action: 'user.deleted', resourceType: 'user', resourceId: req.params.id,
    before: target ? { username: target.username, role: target.role, active: target.active } : undefined });
  saveDB(db);
  res.json({ success: true });
});

// ── Role/Permission Management (admin only) ────────
app.get('/api/roles', requireAuth, tenantMiddleware, requireAdminAction('roles.view'), (req, res) => {
  const db = loadDB();
  res.json(db.roles || DEFAULT_ROLES);
});

app.put('/api/roles/:id', requireAuth, tenantMiddleware, requireAdminAction('roles.manage'), (req, res) => {
  const db = loadDB();
  if (!db.roles) db.roles = { ...DEFAULT_ROLES };
  const before = db.roles[req.params.id] ? { ...db.roles[req.params.id] } : undefined;
  const { name, color, tabs, actions } = req.body;
  db.roles[req.params.id] = { id: req.params.id, name, color, tabs: tabs || [], actions: actions || {} };
  appendAuditEvent(db, { req, action: 'role.permissions_changed', resourceType: 'role', resourceId: req.params.id,
    before, after: db.roles[req.params.id] });
  saveDB(db);
  res.json({ success: true });
});

// ── Change own password ───────────────────────────
app.post('/api/auth/change-password', requireAuth, tenantMiddleware, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'كلمتا المرور مطلوبتان' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!bcrypt.compareSync(oldPassword, user.passwordHash)) return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveDB(db);
  res.json({ success: true });
});

// ── نسيت كلمة المرور: تدفق استرجاع حقيقي بالبريد (CLAUDE.md مرحلة 4) ──
// 1) POST /api/auth/forgot {email} → رمز صالح 30 دقيقة يُرسل بالبريد (SMTP من الإعدادات أو env)
// 2) POST /api/auth/reset {token, password} → تعيين كلمة مرور جديدة
app.post('/api/auth/forgot', rateLimit(5), async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'البريد الإلكتروني مطلوب' });
  const db = loadDB();
  const user = (db.users || []).find(u => (u.email === email || u.username === email) && u.active);
  // رد موحّد دائماً — لا نكشف وجود البريد من عدمه (أمان)
  const generic = { success: true, message: 'إن كان البريد مسجلاً لدينا فستصلك رسالة استرجاع خلال دقائق' };

  const cfg = loadConfig();
  const smtpHost = cfg.smtpHost || process.env.SMTP_HOST;
  const smtpUser = cfg.smtpUser || process.env.SMTP_USER;
  const smtpPass = cfg.smtpPass || process.env.SMTP_PASS;
  const smtpPort = cfg.smtpPort || process.env.SMTP_PORT || 587;
  // R5 (staging validation, adversarial review — P2/security, live-
  // reproduced): the "SMTP not configured" 503 used to fire ONLY after a
  // real user was found — a registered email got 503 + a distinct body,
  // an unregistered one got the generic 200 — trivially distinguishable,
  // letting an unauthenticated caller enumerate valid accounts (confirmed
  // live: admin@boubyan.com and two other real seeded accounts all
  // returned 503, a fabricated address returned 200). Both branches below
  // now short-circuit to the IDENTICAL generic response regardless of
  // whether `user` was found — SMTP misconfiguration becomes an operator-
  // visible condition (server logs it below either way) rather than a
  // client-visible one that doubles as an account-existence oracle.
  if (!smtpHost || !smtpUser) {
    console.warn('⚠️  /api/auth/forgot: SMTP not configured — password-reset email cannot be sent (admin should reset via the Users screen or configure SMTP in Settings)');
    return res.json(generic);
  }
  if (!user) return res.json(generic);

  const token = require('crypto').randomBytes(32).toString('hex');
  db.passwordResets = (db.passwordResets || []).filter(r => r.expiresAt > Date.now()); // نظّف المنتهي
  db.passwordResets.push({ token, userId: user.id, expiresAt: Date.now() + 30 * 60 * 1000 });
  saveDB(db);

  const base = process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${base}/index.html?reset=${token}`;
  const comp = (db.companyInfo && db.companyInfo.name) || cfg.companyName || 'نظام المحاسبة الذكي';
  // R3 — HTML-injection fix (found alongside the login-page stored-XSS by
  // adversarial review): `comp` is admin-controlled (POST /api/company) and
  // was interpolated raw into the reset-email HTML body — escape for the
  // HTML context specifically (subject/from stay as plain text, a different
  // concern nodemailer's own address/header encoding already handles).
  const compHtml = String(comp).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: smtpHost, port: parseInt(smtpPort), secure: String(smtpPort) === '465', auth: { user: smtpUser, pass: smtpPass } });
    await t.sendMail({
      from: `"${comp}" <${smtpUser}>`, to: user.email || email,
      subject: `استرجاع كلمة المرور — ${comp}`,
      html: `<div dir="rtl" style="font-family:Arial;max-width:480px;margin:0 auto;background:#f8fafc;border-radius:12px;padding:26px;border:1px solid #e2e8f0">
        <h2 style="color:#1e293b;margin:0 0 6px">${compHtml}</h2>
        <p style="color:#475569;font-size:14px;line-height:1.8">وصلنا طلب لإعادة تعيين كلمة مرورك. اضغط الزر خلال <b>30 دقيقة</b>:</p>
        <p style="text-align:center;margin:22px 0"><a href="${link}" style="background:#3b82f6;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700">إعادة تعيين كلمة المرور</a></p>
        <p style="color:#94a3b8;font-size:12px">إن لم تطلب ذلك فتجاهل هذه الرسالة — كلمة مرورك لن تتغير.</p></div>`,
    });
    (db.auditLog = db.auditLog || []).unshift({ id: 'AUD-' + Date.now(), at: new Date().toISOString(), user: user.username, action: 'password-reset-requested' });
    saveDB(db);
    res.json(generic);
  } catch (e) {
    console.error('❌ reset mail failed:', e.message);
    res.status(500).json({ error: 'تعذّر إرسال البريد — تحقق من إعدادات SMTP' });
  }
});

app.post('/api/auth/reset', rateLimit(10), (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'الرمز وكلمة المرور مطلوبان' });
  if (password.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  const db = loadDB();
  const rec = (db.passwordResets || []).find(r => r.token === token);
  if (!rec || rec.expiresAt < Date.now()) return res.status(400).json({ error: 'رابط الاسترجاع غير صالح أو منتهي — اطلب رابطاً جديداً' });
  const user = (db.users || []).find(u => u.id === rec.userId);
  if (!user) return res.status(400).json({ error: 'المستخدم غير موجود' });
  user.passwordHash = bcrypt.hashSync(password, 10);
  db.passwordResets = db.passwordResets.filter(r => r.token !== token);
  (db.auditLog = db.auditLog || []).unshift({ id: 'AUD-' + Date.now(), at: new Date().toISOString(), user: user.username, action: 'password-reset-completed' });
  saveDB(db);
  res.json({ success: true, message: 'تم تغيير كلمة المرور — سجّل دخولك الآن' });
});

// ── Register new tenant (public — no auth required) ──────────
// R3 — P6-037 fix: relocated here (was originally registered ~13.5k lines
// later, under "MULTI-TENANCY & SUBSCRIPTION ROUTES") so it registers
// BEFORE the global auth gate immediately below, exactly like
// /api/auth/login above — Express matches routes in registration order,
// so a route defined after `app.use('/api', requireAuth, ...)` always
// inherits that gate regardless of what its own handler/comment says.
// Handler logic is UNCHANGED from its original — reproduced verbatim, just
// relocated. public/landing.html's #registerOverlay/submitRegister() form
// already calls this exact endpoint, confirming self-service registration
// is a genuinely shipped, expected product flow, not dead code to delete.
// R3 (adversarial review): this newly-public route had no route-specific
// rate limit — only the blanket `rateLimit(200)/min` global default (server
// .js ~line 407) applied — an unauthenticated, uncapped tenant-creation
// endpoint (each call activates immediately, no email verification) is an
// abuse vector (spam trials/resource exhaustion). Matches the same
// rateLimit(...) pattern already used on the other public auth routes
// (/api/auth/forgot -> 5/min, /api/auth/reset -> 10/min) above.
app.post('/api/tenants/register', rateLimit(10), async (req, res) => {
  const { name, email, password, slug, timezone, currency, language } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password مطلوبة' });
  if (password.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });

  try {
    // Generate unique tenantId from slug or email
    const base = (slug || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
    const tenantId = `${base}-${Date.now().toString(36)}`;

    // Check slug uniqueness
    const exists = await Tenant.findOne({ slug: base });
    if (exists) return res.status(409).json({ error: 'هذا الاسم مستخدم مسبقاً — اختر اسماً آخر' });

    // Create Tenant
    const tenant = await Tenant.create({
      tenantId,
      name,
      slug: base,
      email,
      plan:   'trial',
      status: 'active',
      timezone:  timezone  || 'Asia/Kuwait',
      currency:  currency  || 'KWD',
      language:  language  || 'ar',
    });

    // Create trial Subscription
    await Subscription.create({
      tenantId,
      plan:   'trial',
      status: 'active',
      seats:  Subscription.LIMITS.trial.seats,
    });

    // Create admin user for this tenant inside DB
    const { runAsTenant, warmTenantCache } = require('./lib/database');
    await runAsTenant(tenantId, async () => {
      await warmTenantCache(tenantId);
      const db = loadDB();
      const adminId = `u_${Date.now()}`;
      (db.users = db.users || []).push({
        id: adminId,
        tenantId,
        username: email,
        email,
        fullName: name,
        role: 'admin',
        passwordHash: bcrypt.hashSync(password, 10),
        active: true,
        createdAt: new Date().toISOString(),
      });
      // Onboarding تلقائي: الزبون الجديد يبدأ بشجرة حسابات IFRS كاملة وأدوار
      // واسم شركته جاهزين — لا نظام فارغ ولا تدخل يدوي (CLAUDE.md مرحلة 5)
      if (!(db.chartOfAccounts || []).length) db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
      if (!db.roles || !Object.keys(db.roles).length) db.roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
      db.companyInfo = { ...(db.companyInfo || {}), name, currency: currency || 'KWD' };
      saveDB(db);
    });

    res.status(201).json({
      success: true,
      tenantId,
      message: 'تم إنشاء الحساب — تجربة مجانية 14 يوم',
      trialEndsAt: tenant.trialEndsAt,
    });
  } catch (e) {
    console.error('❌ Tenant register error:', e.message);
    // R4 (Part P): this catch wraps direct Mongoose calls (Tenant.create/
    // Subscription.create/Tenant.findOne) — a validation or duplicate-key
    // error's e.message can include collection/index names or other Mongo
    // internals. Logged above for operators; the client gets a safe generic
    // message only.
    res.status(500).json({ error: 'تعذّر إنشاء الحساب — يرجى المحاولة لاحقاً' });
  }
});

// ── Apply auth + tenant context to all remaining API routes (P0.1) ─────────
// Centralized: every route registered after this line automatically gets a
// verified JWT (req.user) AND the correct tenant's AsyncLocalStorage context
// (req.tenantId, loadDB()/saveDB() auto-scoped) — see lib/tenantMiddleware.js.
app.use('/api', requireAuth, tenantMiddleware);

// ===== API ROUTES =====

// Get all data — strip sensitive fields before returning
// P0.4A — Primary Objective B: was a flat { ...db } (minus passwordHash) sent
// to ANY authenticated user regardless of role. Now server-side projected
// per the requesting user's own permissions — see lib/dataProjection.js for
// the full field-level classification and the account-takeover risk this
// closes (db.passwordResets was previously exposed here to every role).
app.get('/api/data', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(projectDataForUser(db, req.user));
});

// ── نسخة احتياطية كاملة للتحميل (المدير فقط) ────────────────────────────────
// يرجّع كل البيانات كملف JSON قابل للتنزيل — نسخة خارج الخادم يحتفظ بها المالك.
app.get('/api/admin/backup', requireAuth, requireAdminAction('data.backup_download'), (req, res) => {
  const db = loadDB();
  const config = (typeof loadConfig === 'function') ? loadConfig() : {};
  const payload = {
    createdAt: new Date().toISOString(),
    version:   1,
    source:    'app-download',
    createdBy: req.user.username,
    database:  db,      // يشمل كل شيء (مع hashes كلمات السر — لازمة للاستعادة)
    config,
  };
  appendAuditEvent(db, { req, action: 'data.backup_downloaded', resourceType: 'database', outcome: 'success' });
  saveDB(db);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="boubyan-backup-${stamp}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// Upload Excel
// P0.4A: this route only ever parses "dailyIncome"/"payments" revenue files
// (see fileName.includes() branches below) — the same category of data
// /api/manual-entry posts one record at a time. It is gated to the "manual"
// tab (not "upload", which no non-admin DEFAULT_ROLES role has) so the
// receptionist/accountant roles that legitimately use this bulk-upload
// workflow today keep working, while viewer/inventory are denied.
// R4 — NEW-R3-TELEGRAM-UPLOAD-01 fix: extracted verbatim from the
// POST /api/upload dailyincome branch (mutates db.dailyData/db.journalEntries
// in place, never calls saveDB/appendAuditEvent itself — caller's
// responsibility, exactly the same contract as the pre-existing
// buildAndPostExpense(db, data), which is already shared identically
// between POST /api/expenses and the Telegram /expense command). This is
// the ONE canonical accounting implementation for a daily-income import —
// both the HTTP upload route and the Telegram bot's document handler now
// call this instead of the Telegram path maintaining its own incomplete
// copy that merged db.dailyData but never posted a journal entry at all.
function processDailyIncomeUpload(db, parsedRows, batchId) {
  let importAdded = 0, importUpdated = 0, importRejected = 0;
  const uploadMonths = [];
  const removedMonths = [];

  // A negative channel value (bad data entry — this format has no
  // legitimate refund/credit-row concept elsewhere in the codebase) used to
  // flow straight through into the monthly aggregate, which could net a
  // whole month to zero/negative and silently delete its journal entry
  // below with no trace. Reject such rows outright.
  const CHANNELS = ['cash','knet','visa','master','insurance','cheque','link'];
  const parsed = [];
  for (const rec of parsedRows) {
    if (CHANNELS.some(k => (rec[k] || 0) < 0)) { importRejected++; continue; }
    parsed.push(rec);
  }

  // === AUTO JOURNAL ENTRIES FOR DAILY INCOME (monthly grouping) ===
  if (!db.journalEntries) db.journalEntries = [];
  const coa = db.chartOfAccounts || [];
  const findAcc = (code) => {
    const a = coa.find(a => a.code === code || a.id === code);
    return a || { id: code, code, name: code };
  };

  // Revenue credit accounts
  const rev4100 = findAcc('4100'); // Cash
  const rev4110 = findAcc('4110'); // K-Net
  const rev4120 = findAcc('4120'); // Visa
  const rev4130 = findAcc('4130'); // Master
  const rev4140 = findAcc('4140'); // Link
  const rev4150 = findAcc('4150'); // Insurance
  const rev4160 = findAcc('4160'); // Cheque
  // Asset debit accounts
  const cash1100  = findAcc('1100'); // Sundry cash
  const bank1110  = findAcc('1110'); // Bank (Cheque)
  const hisabi1125= findAcc('1125'); // حسابي — K-Net / Visa / Master / Link
  const ins1130   = findAcc('1130'); // Insurance receivable (net)
  const exp5760   = findAcc('5760'); // خصم التأمين
  const bankFee5750 = findAcc('5750') || { id:'5750', code:'5750', name:'مصاريف بنكية وعمولات' }; // عمولة الشبكة

  // R4 adversarial-review fix (Accountant persona, CRITICAL — two-part):
  // this function used to (1) merge parsedRows into db.dailyData, then (2)
  // delete each affected month's OLD journal entry unconditionally, THEN
  // (3) build/validate the replacement. A rejection at step 3 (most
  // realistically PERIOD_LOCKED — a correction upload touching an
  // already-closed month) threw with steps 1-2 already committed to the
  // live in-memory db object — loadDB() returns that same object on every
  // call in this process, not a fresh copy, so the caller's "rejected"
  // response was a lie: db.dailyData already had the new day merged in
  // with no matching journal entry, and the OLD entry for that month was
  // already gone. The very next unrelated saveDB() call anywhere in the
  // app would persist that corruption permanently.
  //
  // Fixed with a genuine prepare-then-commit ordering across the WHOLE
  // function, not just the per-month journal step: every affected month's
  // replacement candidate is built and validated first, against a
  // SIMULATED view of what db.dailyData would contain after the merge —
  // without actually mutating db.dailyData or db.journalEntries yet.
  // validateJournalEntry() only reads db (lockedPeriods/chartOfAccounts),
  // never dailyData, so simulating the merge for validation purposes is
  // exact, not approximate. Only once every affected month has either
  // validated successfully or been confirmed as an intentional net-zero
  // removal does the function commit: the real dailyData merge, then each
  // month's journal change. A rejection now leaves db completely
  // untouched — dailyData included.
  const affectedMonths = new Set(parsed.map(rec => rec.date.substring(0, 7)));
  const simByDate = new Map();
  for (const rec of db.dailyData) {
    if (affectedMonths.has(rec.date.substring(0, 7))) simByDate.set(rec.date, rec);
  }
  for (const rec of parsed) simByDate.set(rec.date, rec); // overlay — same "new row wins" semantics as the real merge below

  const monthGroups = {};
  for (const rec of simByDate.values()) {
    const month = rec.date.substring(0, 7);
    if (!monthGroups[month]) monthGroups[month] = { cash:0, knet:0, visa:0, master:0, link:0, cheque:0, insurance:0 };
    const g = monthGroups[month];
    g.cash      += rec.cash      || 0;
    g.knet      += rec.knet      || 0;
    g.visa      += rec.visa      || 0;
    g.master    += rec.master    || 0;
    g.link      += rec.link      || 0;
    g.cheque    += rec.cheque    || 0;
    g.insurance += rec.insurance || 0;
  }

  // PLAN pass — pure: builds each affected month's decision (remove-only,
  // or a validated candidate to post) with zero mutation of db.
  const plan = []; // { month, hadOldJe, remove: bool, candidate?: object }
  for (const [month, g] of Object.entries(monthGroups)) {
    const hadOldJe = db.journalEntries.some(e => e.type === 'auto-income' && e.ref === `INCOME-${month}`);

    const r = (v) => parseFloat(v.toFixed(3));
    const cfg = loadConfig();
    const insRate = typeof cfg.insDeductionRate === 'number' ? cfg.insDeductionRate : 0.13;
    // عمولة الشبكة + وسيط «حسابي»: قبل شهر البدء تذهب البطاقات للبنك مباشرة ناقصاً العمولة،
    // ومن شهر البدء فصاعداً تذهب لحساب «حسابي» (1125) وتُسوّى لاحقاً عبر كشف البنك.
    const feeKnet     = typeof cfg.feeKnet === 'number' ? cfg.feeKnet : 0.0065; // كي-نت 0.65%
    const feeCard     = typeof cfg.feeCard === 'number' ? cfg.feeCard : 0.0265; // فيزا/ماستر 2.65%
    const hesabiStart = cfg.hesabiStartMonth || '2026-06';
    const useHesabi   = month >= hesabiStart;
    const lines = [];
    let totalDebitRev = 0;
    // ترحيل قناة بطاقة: إمّا لحسابي (إجمالي) أو للبنك مباشرة (صافي + عمولة)
    // نموذج المستحقات: إيرادات البطاقات تُسجَّل مديناً على «مستحقات الشبكة» (1125) بالصافي
    // بعد العمولة، والعمولة مصروفاً فوراً. يُصفّى المستحق لاحقاً عبر كشف البنك (مدين بنك/دائن مستحق).
    const postCard = (gross, rate, remarks) => {
      if (gross <= 0) return;
      const fee = r(gross * rate), net = r(gross - fee);
      lines.push({ accountId:hisabi1125.id, accountCode:'1125', accountName:hisabi1125.name, debit:net, credit:0, remarks:`${remarks} (صافي بعد عمولة ${(rate*100).toFixed(2)}% — يُصفّى عبر البنك)` });
      if (fee > 0) lines.push({ accountId:bankFee5750.id, accountCode:'5750', accountName:bankFee5750.name, debit:fee, credit:0, remarks:`عمولة الشبكة ${(rate*100).toFixed(2)}% — ${remarks}` });
      totalDebitRev += gross;
    };

    // Debit lines
    if (g.cash > 0) {
      const v = r(g.cash);
      lines.push({ accountId:cash1100.id, accountCode:'1100', accountName:cash1100.name, debit:v, credit:0 });
      totalDebitRev += v;
    }
    // K-Net → حسابي أو البنك مباشرة (عمولة 0.65%)
    postCard(r(g.knet), feeKnet, `كي-نت: ${r(g.knet)} د.ك`);
    // Visa + Master → حسابي أو البنك مباشرة (عمولة 2.65%)
    if ((g.visa + g.master) > 0) {
      const parts = [];
      if (g.visa   > 0) parts.push(`فيزا: ${r(g.visa)} د.ك`);
      if (g.master > 0) parts.push(`ماستر: ${r(g.master)} د.ك`);
      postCard(r(g.visa + g.master), feeCard, parts.join(' | '));
    }
    // Link → حسابي أو البنك مباشرة (عمولة 2.65%)
    postCard(r(g.link), feeCard, `لينك: ${r(g.link)} د.ك`);
    // Cheque → Bank
    if (g.cheque > 0) {
      const v = r(g.cheque);
      lines.push({ accountId:bank1110.id, accountCode:'1110', accountName:bank1110.name, debit:v, credit:0, remarks:`شيك: ${v} د.ك` });
      totalDebitRev += v;
    }
    // Insurance: file value = NET (after deduction); back-calculate gross
    let insGross = 0;
    if (g.insurance > 0) {
      const net       = r(g.insurance);
      insGross        = r(net / (1 - insRate));
      const deduction = r(insGross - net);
      lines.push({ accountId:ins1130.id, accountCode:'1130', accountName:ins1130.name, debit:net,       credit:0, remarks:`صافي التأمين — ${((1-insRate)*100).toFixed(0)}% من الإجمالي` });
      lines.push({ accountId:exp5760.id, accountCode:'5760', accountName:exp5760.name, debit:deduction, credit:0, remarks:`خصم شركات التأمين — ${(insRate*100).toFixed(0)}%` });
      totalDebitRev += insGross;
    }

    // Credit lines
    if (g.cash      > 0) { const v=r(g.cash);    lines.push({ accountId:rev4100.id, accountCode:'4100', accountName:rev4100.name, debit:0, credit:v }); }
    if (g.knet      > 0) { const v=r(g.knet);    lines.push({ accountId:rev4110.id, accountCode:'4110', accountName:rev4110.name, debit:0, credit:v }); }
    if (g.visa      > 0) { const v=r(g.visa);    lines.push({ accountId:rev4120.id, accountCode:'4120', accountName:rev4120.name, debit:0, credit:v }); }
    if (g.master    > 0) { const v=r(g.master);  lines.push({ accountId:rev4130.id, accountCode:'4130', accountName:rev4130.name, debit:0, credit:v }); }
    if (g.link      > 0) { const v=r(g.link);    lines.push({ accountId:rev4140.id, accountCode:'4140', accountName:rev4140.name, debit:0, credit:v }); }
    if (g.cheque    > 0) { const v=r(g.cheque);  lines.push({ accountId:rev4160.id, accountCode:'4160', accountName:rev4160.name, debit:0, credit:v }); }
    if (insGross    > 0) {                        lines.push({ accountId:rev4150.id, accountCode:'4150', accountName:rev4150.name, debit:0, credit:insGross, remarks:'إيرادات التأمين — إجمالي' }); }

    const totalRev = totalDebitRev;

    if (lines.length < 2 || totalRev === 0) {
      // Intentional net-zero/negative removal — recorded in the plan, not
      // applied yet; committed below only once every month has planned
      // successfully.
      if (hadOldJe) plan.push({ month, hadOldJe, remove: true });
      continue;
    }

    const candidate = {
      id:          `JE-INC-${month}`,
      date:        monthEndDate(month),
      desc:        `إيرادات شهر ${month}`,
      ref:         `INCOME-${month}`,
      type:        'auto-income',
      // R4 — Part C traceability fix: auto-income JEs never carried
      // source/sourceModule (unlike vendor-bill/patient-receivable/
      // insurance-claim/fixed-asset JEs) — now tagged so the journal UI can
      // show "this came from a daily-income import" and, for Telegram-
      // sourced imports specifically, which channel created it.
      source:      batchId.startsWith('BATCH-TG-') ? 'telegram-daily-income' : 'daily-income-upload',
      sourceModule:'revenue',
      _batchId:    batchId,
      totalDebit:  r(totalRev),
      totalCredit: r(totalRev),
      createdAt:   new Date().toISOString(),
      lines,
      autoGenerated: true,
    };
    // Validate against the REAL db (lockedPeriods/chartOfAccounts — never
    // dailyData) before anything is committed. A rejection here (most
    // realistically PERIOD_LOCKED) propagates immediately, before the plan
    // below is ever applied — db is untouched, dailyData included.
    const check = validateJournalEntry(db, candidate);
    if (!check.ok) throw new JournalValidationError(check.error, check.status, check.code);

    plan.push({ month, hadOldJe, remove: false, candidate });
  }

  // COMMIT — every month in `plan` already validated successfully; only now
  // do we mutate db, starting with the real dailyData merge (identical
  // logic to the simulation above, so the counts/final state match exactly
  // what was just validated).
  const existing = new Set(db.dailyData.map(d => d.date));
  for (const rec of parsed) {
    rec._batchId = batchId;
    if (!existing.has(rec.date)) {
      db.dailyData.push(rec);
      existing.add(rec.date);
      importAdded++;
    } else {
      const idx = db.dailyData.findIndex(d => d.date === rec.date);
      db.dailyData[idx] = rec;
      importUpdated++;
    }
  }
  db.dailyData.sort((a, b) => b.date.localeCompare(a.date));

  for (const step of plan) {
    if (step.hadOldJe) db.journalEntries = db.journalEntries.filter(e => !(e.type === 'auto-income' && e.ref === `INCOME-${step.month}`));
    if (step.remove) {
      removedMonths.push(step.month);
      continue;
    }
    uploadMonths.push(step.month);
    // rebuilt successfully — not a net removal, don't report it as one.
    { const ri = removedMonths.indexOf(step.month); if (ri !== -1) removedMonths.splice(ri, 1); }
    appendJournalEntry(db, step.candidate);
  }
  db.journalEntries.sort((a, b) => b.date.localeCompare(a.date));
  // === END AUTO JOURNAL ===

  return { importAdded, importUpdated, importRejected, uploadMonths, removedMonths, validRows: parsed };
}

app.post('/api/upload', requireAuth, requirePermission('manual', 'add'), upload.single('file'), (req, res) => {
  try {
    const db = loadDB();
    const filePath = req.file.path;
    const fileName = req.file.originalname.toLowerCase();
    const batchId  = 'BATCH-' + Date.now();   // create once, used for ALL tagging below

    let parsed = [];
    let type = '';
    let uploadMonths = [];   // months covered (for daily files)
    // R3 — P6-028: explicit import counts, surfaced in the response instead
    // of a silent generic success message.
    let importAdded = 0, importUpdated = 0, importSkippedDuplicate = 0, importRejected = 0;
    let removedMonths = []; // months whose prior auto-income JE was removed with nothing to replace it (net-zero/negative)

    if (fileName.includes('dailyincome')) {
      parsed = parseDailyIncome(filePath);
      type = 'daily';

      // R4 — NEW-R3-TELEGRAM-UPLOAD-01: this whole block used to be inline
      // here; now shared with the Telegram bot's document handler via
      // processDailyIncomeUpload() (defined just above this route) so
      // there is exactly ONE canonical accounting implementation.
      const result = processDailyIncomeUpload(db, parsed, batchId);
      importAdded = result.importAdded;
      importUpdated = result.importUpdated;
      importRejected = result.importRejected;
      uploadMonths = result.uploadMonths;
      removedMonths = result.removedMonths;
      parsed = result.validRows; // downstream `parsed.length` must reflect post-rejection count

    } else if (fileName.includes('payments')) {
      parsed = parsePaymentsDetails(filePath);
      type = 'payments';
      
      // Merge by invId
      const existingIds = new Set(db.paymentsData.map(d => d.invId));
      for (const rec of parsed) {
        rec._batchId = batchId;   // tag every payment record
        if (!existingIds.has(rec.invId)) {
          db.paymentsData.push(rec);
          importAdded++;
        } else {
          importSkippedDuplicate++;
        }
      }
      db.paymentsData.sort((a, b) => b.date.localeCompare(a.date));
      
      // Auto-calculate commissions per doctor per month
      updateCommissions(db);
    }
    
    // Log upload record (batchId already created above and applied to all records)
    db.uploadedFiles.push({
      id:      batchId,
      batchId,
      name:    req.file.originalname,
      type,
      records: parsed.length,
      months:  uploadMonths,
      date:    new Date().toISOString(),
    });
    
    saveDB(db);

    // real-time target achievement check after upload
    if (type === 'payments') {
      const currentMonth = new Date().toISOString().substring(0,7);
      const groups = {};
      for (const p of db.paymentsData) {
        if ((p.date||'').startsWith(currentMonth) && p.doctor && p.doctor !== 'Advance') {
          groups[p.doctor] = (groups[p.doctor]||0) + (p.total||0);
        }
      }
      Object.entries(groups).forEach(([doctor, rev]) => checkTargetAchievement(doctor, rev));
    }

    appendAuditEvent(db, { req, action: 'upload.file_imported', resourceType: 'upload', resourceId: batchId, after: { type, records: parsed.length, added: importAdded, updated: importUpdated, skippedDuplicate: importSkippedDuplicate, rejectedInvalid: importRejected, removedMonths, fileName: req.file.originalname } });
    saveDB(db);
    res.json({
      success: true, type, records: parsed.length,
      // R3 — P6-028: explicit per-row classification instead of an opaque
      // "N records" message — a partial/cumulative import's actual effect
      // (new days, days corrected, duplicates skipped, invalid rows
      // rejected, months whose entry was net-removed) is now visible to the
      // caller instead of being indistinguishable from a full success.
      importSummary: { imported: importAdded, updated: importUpdated, skippedDuplicate: importSkippedDuplicate, rejectedInvalid: importRejected, monthsAffected: uploadMonths, monthsRemoved: removedMonths },
      message: `تم رفع ${parsed.length} سجل بنجاح (جديد: ${importAdded}، محدَّث: ${importUpdated}${importSkippedDuplicate?`، مكرَّر متجاهَل: ${importSkippedDuplicate}`:''}${importRejected?`، مرفوض (قيمة سالبة): ${importRejected}`:''}${removedMonths.length?`، أشهر أُزيل قيدها بلا بديل: ${removedMonths.join(', ')}`:''})`,
    });
  } catch (err) {
    if (err instanceof JournalValidationError) return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    console.error('Upload error:', err.message);
    res.status(500).json({ success: false, message: 'خطأ في قراءة الملف — تأكد من صحة الصيغة' });
  } finally {
    // P0.5A — Step 7: this used to sit mid-try, right after the successful
    // parse+save path — any later throw (e.g. a locked-period journal
    // rejection reached deep inside the parse/merge logic above) skipped it
    // entirely and leaked the temp Excel file in UPLOADS_DIR forever.
    if (req.file?.path) { try { fs.removeSync(req.file.path); } catch { /* never let cleanup failure mask the real error */ } }
  }
});

// P0.6B — Step 10/11/12 (P6-030): earned doctor commission must produce a
// real GL liability (Dr Commission Expense / Cr Doctor Commission Payable,
// account 2800 — a dedicated code, never sharing 2900's general accrued-
// expenses subledger, so it doesn't repeat the P6-027 GL-conflation
// problem). `db.commissionHistory[]` is a continuously-recalculated
// ESTIMATE (updateCommissions() runs on every new payments import, every
// doctor-formula save, every doctor-expenses save — never a single discrete
// "close the month" action), so recognition must be IDEMPOTENT and
// DELTA-BASED: post only the difference between what was already
// recognized (`entry.recognizedAmount`) and the newly computed commission —
// never a duplicate full-amount journal. A legitimate amount change before
// settlement becomes a small adjustment entry, not a rewrite of the
// original (Step 12). Never called for an already-`paid` record — callers
// keep the pre-existing P0.6A guard for that.
//
// Mirrors the try/catch/console.warn-and-skip pattern updateCommissions()
// already uses for its insurance-deduction journal just below: a locked
// period for ONE doctor/month must not abort saving the rest of a batch
// (doctor list, doctor-expenses, Excel import) — it is safely retried the
// next time this function runs, since the delta is still outstanding.
function recognizeCommissionLiability(db, entry, newNetCommission) {
  const target  = parseFloat((parseFloat(newNetCommission) || 0).toFixed(3));
  const already = parseFloat((parseFloat(entry.recognizedAmount) || 0).toFixed(3));
  const delta   = parseFloat((target - already).toFixed(3));
  if (Math.abs(delta) < 0.001) { entry.recognizedAmount = target; return; } // idempotent no-op

  const period = String(entry.month || '').slice(0, 7);
  const date   = monthEndDate(period);
  assertFinancialPeriodOpen(db, [date]); // Step 33 — never bypass the period lock

  const coa        = db.chartOfAccounts || [];
  const commExp     = coa.find(a => a.code === '5100') || ensureAccount(db, '5100', 'عمولات الأطباء', 'expense', '5000');
  const commPayable = ensureAccount(db, '2800', 'عمولات أطباء مستحقة الدفع', 'liability', '2000');

  const seq  = (entry.recognitionJeIds || []).length + 1;
  const jeId = 'JE-COMM-RECOG-' + entry.id + '-' + seq;
  const abs  = Math.abs(delta);
  // delta > 0: commission increased -> recognize more (Dr Expense / Cr Payable).
  // delta < 0: commission was revised DOWN before payment -> reverse the excess.
  const lines = delta > 0
    ? [ { accountId: commExp.id,     accountCode: '5100', accountName: commExp.name,     debit: abs, credit: 0 },
        { accountId: commPayable.id, accountCode: '2800', accountName: commPayable.name, debit: 0,   credit: abs } ]
    : [ { accountId: commPayable.id, accountCode: '2800', accountName: commPayable.name, debit: abs, credit: 0 },
        { accountId: commExp.id,     accountCode: '5100', accountName: commExp.name,     debit: 0,   credit: abs } ];

  appendJournalEntry(db, {
    id: jeId, date,
    desc: `${seq > 1 ? 'تسوية ' : ''}استحقاق عمولة د. ${entry.doctor} — ${period}`,
    ref: `COMM-RECOG-${entry.doctor}-${period}`, reference: `COMM-RECOG-${entry.doctor}-${period}`,
    type: seq > 1 ? 'commission-recognition-adjustment' : 'commission-recognition',
    source: 'doctor-commission', sourceId: entry.id, sourceModule: 'commission',
    totalDebit: abs, totalCredit: abs,
    createdAt: new Date().toISOString(), autoGenerated: true,
    lines,
  });

  entry.recognizedAmount   = target;
  entry.recognitionJeIds   = [...(entry.recognitionJeIds || []), jeId];
}

function updateCommissions(db) {
  // Group payments by doctor+month
  const groups = {};
  for (const p of db.paymentsData) {
    const month = getMonth(p.date);
    const doctor = p.doctor;
    if (doctor === 'Advance' || !doctor) continue;
    const key = `${doctor}|${month}`;
    if (!groups[key]) groups[key] = { doctor, month, revenue: 0 };
    groups[key].revenue += p.total;
  }
  
  // Update commission history + create insurance expense journal entries
  const coa = db.chartOfAccounts || [];
  const findAcc = (code) => coa.find(a => a.code === code) || { id: code, code, name: code };
  const insExpAcc  = findAcc('5730'); // تأمين طبي وعمالي
  const insLiabAcc = findAcc('2200'); // رواتب / التزامات مستحقة

  for (const key of Object.keys(groups)) {
    const g = groups[key];
    const dr = db.doctors.find(d =>
      d.name === g.doctor ||
      d.name.toLowerCase().replace(/\s+/g,'') === g.doctor.toLowerCase().replace(/\s+/g,'')
    );
    if (!dr) continue;
    const commission = calcCommission(dr, g.revenue);

    // Calculate insurance deduction amount
    const cfg = loadConfig();
    const formula = cfg.commissionFormula || {};
    const base = formula.base || 'above_target';
    const baseAmt = base === 'above_target' ? Math.max(0, g.revenue - (dr.target || 0)) : g.revenue;
    const insRate = (formula.deductions || ['lab']).includes('insurance') ? (dr.insurance || 0) : 0;
    const insDeduction = parseFloat((baseAmt * insRate / 100).toFixed(3));

    // Deduct per-doctor monthly variable expenses
    const drExpRecord = (db.doctorExpenses || []).find(r => r.doctor === g.doctor && r.month === g.month);
    const drExpTotal = drExpRecord ? (drExpRecord.total || 0) : 0;
    const netCommission = parseFloat(Math.max(0, commission - drExpTotal).toFixed(3));

    const existing = db.commissionHistory.find(c => c.doctor === g.doctor && c.month === g.month);
    // P0.6A — Step 20 (P6-031): a commission record already marked paid
    // represents a period whose actual paid amount is already frozen into
    // a posted journal entry (see POST /api/commission/pay) — recalculating
    // over it here would silently make the displayed commission history
    // diverge from what was actually paid, with no audit trail explaining
    // why. Skip the whole doctor/month (including the insurance-deduction
    // JE recalculation below) once paid; treat it as closed.
    if (existing && existing.paid) continue;
    let commRecord;
    if (existing) {
      existing.revenue = g.revenue;
      existing.commission = netCommission;
      existing.grossCommission = commission;
      existing.drExpenses = drExpTotal;
      commRecord = existing;
    } else {
      commRecord = {
        id: genId('comm-'),
        doctor: g.doctor,
        month: g.month,
        revenue: g.revenue,
        commission: netCommission,
        grossCommission: commission,
        drExpenses: drExpTotal,
        paid: false,
        payMethod: '',
        payDate: '',
        recognizedAmount: 0,
        recognitionJeIds: [],
      };
      db.commissionHistory.push(commRecord);
    }

    // P0.6B — Step 10/11/12 (P6-030): recognize the earned liability
    // (Dr Commission Expense / Cr Doctor Commission Payable) — idempotent,
    // delta-based, so re-running this function for the same doctor+month
    // (its normal behavior — see the 4 call sites) never duplicates the
    // journal. A locked period for this ONE doctor/month must not abort the
    // rest of this batch (mirrors the insurance-deduction try/catch below).
    try {
      recognizeCommissionLiability(db, commRecord, netCommission);
    } catch (e) {
      if (!(e instanceof JournalValidationError)) throw e;
      console.warn(`⚠️ تخطي استحقاق عمولة ${g.doctor}/${g.month}: ${e.message}`);
    }

    // Insurance journal: debit expense, credit insurance receivable (reduces 1130 to net)
    if (insDeduction > 0) {
      const jeRef = `INS-EXP-${g.doctor}-${g.month}`.replace(/\s/g,'-');
      db.journalEntries = db.journalEntries || [];
      db.journalEntries = db.journalEntries.filter(e => e.ref !== jeRef);
      const insRecAcc2 = findAcc('1130'); // ذمم مدينة — شركات التأمين
      // خصم التأمين قيد جانبي تلقائي يُعاد حسابه عند كل تحديث لبيانات الأطباء/مصاريفهم —
      // لا يجوز أن يُسقط حفظ الأطباء بالكامل لمجرد أن شهراً قديماً أصبح مقفلاً (P0.2).
      try {
        appendJournalEntry(db, {
          id: genId('JE-INS-'),
          date: monthEndDate(g.month),
          desc: `خصم تأمين طبيب — ${g.doctor} — ${g.month}`,
          ref: jeRef,
          type: 'insurance-expense',
          totalDebit: insDeduction,
          totalCredit: insDeduction,
          createdAt: new Date().toISOString(),
          autoGenerated: true,
          lines: [
            { accountId: insExpAcc.id,   accountCode: '5730', accountName: insExpAcc.name,   debit: insDeduction, credit: 0 },
            { accountId: insRecAcc2.id,  accountCode: '1130', accountName: insRecAcc2.name,  debit: 0, credit: insDeduction },
          ],
        });
      } catch (e) {
        if (!(e instanceof JournalValidationError)) throw e;
        console.warn(`⚠️ تخطي قيد خصم تأمين ${g.doctor}/${g.month}: ${e.message}`);
      }
    }
  }
}

// Save doctors — validate structure before writing
// P1 (Record Workspace, NEW-R5-ADV-DOCTORS-NO-LIST-01): db.doctors historically
// carried no `id` field at all — every financial reference (commissionHistory,
// doctorExpenses, doctorPayments, dailyData) links a doctor by exact `name`
// string, never by id. That name-based linkage is UNCHANGED here and remains
// authoritative — `id` below is purely additive (stable-across-saves, used
// only by the new list/detail/edit UI for addressability), never consumed by
// any existing commission/expense/import calculation. Ids are assigned once
// and preserved by matching the incoming row to an existing row by id (if the
// caller echoes one back) or by name, so a doctor's URL/bookmark stays valid
// across ordinary roster edits.
function ensureDoctorIds(db) {
  db.doctors = db.doctors || [];
  let changed = false;
  db.doctors = db.doctors.map(d => {
    if (d.id) return d;
    changed = true;
    return { ...d, id: genId('doc-') };
  });
  return changed;
}

// A doctor's `name` is the ONLY key every historical financial record links
// through (see comment above) — renaming it would silently orphan those
// lookups. Mirrors the exact same history-lock pattern already used for
// fixed assets (assetHasHistory/ASSET_HISTORY_LOCKED_FIELDS).
function doctorHasHistory(db, name) {
  if (!name) return false;
  return (db.commissionHistory || []).some(c => c.doctor === name)
    || (db.doctorExpenses || []).some(e => e.doctor === name)
    || (db.doctorPayments || []).some(p => p.doctor === name)
    || (db.dailyData || []).some(d => d.doctor === name || (Array.isArray(d.doctors) && d.doctors.some(x => x.name === name)));
}

app.post('/api/doctors', requirePermission('doctors', 'add'), (req, res) => {
  const db = loadDB();
  const before = db.doctors || [];
  const incoming = req.body.doctors;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'doctors must be array' });

  // P1 adversarial-review fix (P1 finding): a caller-chosen id repeated
  // across two rows in the SAME payload would make GET/PUT /api/doctors/:id
  // permanently resolve to only the first match — the second row persists
  // as an unreachable ghost, silently un-editable/un-viewable forever.
  const seenIncomingIds = new Set();
  for (const d of incoming) {
    if (!d.id) continue;
    if (seenIncomingIds.has(d.id)) {
      return res.status(409).json({ success: false, error: `المعرّف "${d.id}" مكرر أكثر من مرة في نفس الطلب`, code: 'DOCTOR_ID_DUPLICATE' });
    }
    seenIncomingIds.add(d.id);
  }

  // P1 — validate-before-commit: this legacy full-array-replace endpoint is
  // still what the Settings roster editor uses (saveDoctor()) — without this
  // check it could bypass PUT /api/doctors/:id's identical rename-safety
  // guard entirely. Detectable when the caller round-trips a doctor's stable
  // id (the updated frontend now does).
  for (const d of incoming) {
    if (!d.id) continue;
    const existing = before.find(b => b.id === d.id);
    if (!existing) continue;
    const nextName = sanitize(String(d.name || ''), 100);
    if (nextName && nextName !== existing.name && doctorHasHistory(db, existing.name)) {
      return res.status(409).json({
        success: false,
        error: `لا يمكن تغيير اسم الطبيب "${existing.name}" — له سجل مالي فعلي (عمولات/مصاريف/مدفوعات) مرتبط بالاسم الحالي. أنشئ طبيباً جديداً بدلاً من ذلك إن لزم.`,
        code: 'DOCTOR_RENAME_LOCKED',
      });
    }
  }

  // P1 adversarial-review fix (P0 finding): the check above only fires when
  // the caller round-trips the id. A row with NO id and a genuinely
  // different name is indistinguishable from "this doctor, renamed" from
  // the server's side — and since this endpoint replaces the WHOLE array,
  // simply omitting a historied doctor's id (with a different name, or by
  // dropping their row entirely) silently orphans their commission/expense/
  // payment history under a name no longer in db.doctors, with the old id
  // now 404ing. If a historied doctor's name doesn't survive ANYWHERE in
  // the incoming payload (by id or by their unchanged name), reject —
  // exactly as unsafe as the explicit-id rename case above.
  for (const b of before) {
    if (!doctorHasHistory(db, b.name)) continue;
    const stillPresent = incoming.some(d => d.id === b.id || sanitize(String(d.name || ''), 100) === b.name);
    if (!stillPresent) {
      return res.status(409).json({
        success: false,
        error: `الطبيب "${b.name}" له سجل مالي فعلي ولا يمكن حذفه أو إعادة تسميته ضمنيًا عبر استبدال القائمة بالكامل. أعد إرسال القائمة مع الإبقاء عليه (بنفس id أو بنفس الاسم)، أو استخدم PUT /api/doctors/${b.id} لتعديل حقوله الآمنة فقط.`,
        code: 'DOCTOR_RENAME_LOCKED',
      });
    }
  }

  const resolved = incoming.map(d => {
    const name = sanitize(String(d.name || ''), 100);
    const existing = (d.id && before.find(b => b.id === d.id)) || before.find(b => b.name === name);
    return {
      id:         d.id || (existing && existing.id) || genId('doc-'),
      name,
      target:     Math.max(0, parseFloat(d.target) || 0),
      commission: Math.min(100, Math.max(0, parseFloat(d.commission) || 0)),
      lab:        Math.min(100, Math.max(0, parseFloat(d.lab) || 0)),
      insurance:  Math.min(100, Math.max(0, parseFloat(d.insurance) || 0)),
    };
  });

  // P1 adversarial-review fix (P0 finding): every commission/expense/payment
  // calculation joins purely by doctor NAME (no id anywhere in that data) —
  // two doctor ids sharing one name doesn't just risk ambiguity, it actively
  // fabricates duplicated financial history (both ids report the SAME real
  // records as their own), and the shared name becomes permanently
  // rename-locked for both the moment either accrues history — an
  // unrecoverable stuck state. Names must stay unique across the roster.
  const nameCounts = {};
  resolved.forEach(d => { if (d.name) nameCounts[d.name] = (nameCounts[d.name] || 0) + 1; });
  const dupName = Object.keys(nameCounts).find(n => nameCounts[n] > 1);
  if (dupName) {
    return res.status(409).json({
      success: false,
      error: `الاسم "${dupName}" مستخدَم لأكثر من طبيب في نفس القائمة — أسماء الأطباء يجب أن تكون فريدة لأن كل الحسابات المالية (عمولات/مصاريف/مدفوعات) تُربَط بالاسم مباشرة.`,
      code: 'DOCTOR_NAME_DUPLICATE',
    });
  }

  db.doctors = resolved;
  updateCommissions(db);
  appendAuditEvent(db, { req, action: 'doctors.updated', resourceType: 'doctors', before: { count: (before||[]).length }, after: { count: db.doctors.length } });
  saveDB(db);
  res.json({ success: true });
});

// P1 — GET /api/doctors: was previously entirely missing (NEW-R5-ADV-DOCTORS-NO-LIST-01)
// — the bundled UI's own roster editor had to download the whole /api/data
// blob just to list doctors. Lazily backfills stable ids (see ensureDoctorIds)
// so records seeded before this milestone (no `id` field yet) become
// addressable too, without touching any name-keyed financial record.
app.get('/api/doctors', requirePermission('doctors', 'view'), (req, res) => {
  const db = loadDB();
  if (ensureDoctorIds(db)) saveDB(db);
  res.json(db.doctors || []);
});

// GET doctor monthly expenses
app.get('/api/doctor-expenses/:doctor/:month', requirePermission('doctors', 'view'), (req, res) => {
  const db = loadDB();
  const doctor = decodeURIComponent(req.params.doctor);
  const month  = req.params.month;
  const record = (db.doctorExpenses || []).find(r => r.doctor === doctor && r.month === month);
  res.json(record || { doctor, month, items: [] });
});

// SAVE doctor monthly expenses
app.post('/api/doctor-expenses', requirePermission('doctors', 'add'), (req, res) => {
  const { doctor, month, items } = req.body;
  if (!doctor || !month) return res.status(400).json({ error: 'doctor and month required' });
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be array' });
  const db = loadDB();
  if (!db.doctorExpenses) db.doctorExpenses = [];
  const cleaned = items
    .map(it => ({ name: sanitize(String(it.name || ''), 200), amount: Math.max(0, parseFloat(it.amount) || 0) }))
    .filter(it => it.name && it.amount > 0);
  const total = cleaned.reduce((s, i) => s + i.amount, 0);
  const idx = db.doctorExpenses.findIndex(r => r.doctor === doctor && r.month === month);
  const record = { doctor, month, items: cleaned, total, updatedAt: new Date().toISOString() };
  if (idx >= 0) db.doctorExpenses[idx] = record;
  else db.doctorExpenses.push(record);
  // Re-calculate commissions so monthly expenses are reflected
  updateCommissions(db);
  appendAuditEvent(db, { req, action: 'doctor_expenses.updated', resourceType: 'doctorExpenses', resourceId: `${doctor}/${month}`, after: { total } });
  saveDB(db);
  res.json({ success: true, total });
});

// Mark commission paid
// P0.6B — Step 13 (P6-030): settles the recognized liability — Dr Doctor
// Commission Payable (2800) / Cr Cash or Bank — never re-expenses (the
// expense side was already recognized when the commission was earned, via
// recognizeCommissionLiability()/updateCommissions()). Durable-before-ack
// (Step 34): this is a one-shot, non-retriable cash disbursement — unlike
// recognition (idempotent/self-healing on the next recalculation), a lost
// payment record after a real cash outflow cannot be safely regenerated.
app.post('/api/commission/pay', requirePermission('doctors', 'edit'), async (req, res, next) => {
  try {
  const { doctor, month, payMethod, payDate, checkNo } = req.body;
  const db = loadDB();
  const entry = (db.commissionHistory||[]).find(c => c.doctor === doctor && c.month === month);
  if (!entry) return res.status(404).json({ success: false, message: 'لم يتم إيجاد العمولة' });
  // Step 13: no duplicate payment, no paying an unrecognized/zero commission.
  if (entry.paid) return res.status(409).json({ success: false, message: 'هذه العمولة مدفوعة بالفعل', code: 'ALREADY_PAID' });
  const amt = parseFloat(entry.commission) || parseFloat(entry.amount) || 0;
  if (!(amt > 0)) return res.status(400).json({ success: false, message: 'لا يوجد مبلغ عمولة مستحق للدفع' });

  const payDateResolved = payDate || new Date().toISOString().slice(0,10);

  // Step 33: settlement date must respect the same period lock as recognition.
  try {
    assertFinancialPeriodOpen(db, [payDateResolved]);
    // Step 13: ensure the liability is FULLY recognized before it is ever
    // settled — guarantees this payment never debits 2800 by more than was
    // actually credited to it, even if an earlier recalculation missed it
    // (e.g. a period-lock skip logged by updateCommissions() above).
    recognizeCommissionLiability(db, entry, amt);
  } catch (e) {
    if (!(e instanceof JournalValidationError)) throw e;
    return res.status(e.status).json({ success: false, message: e.message, code: e.code });
  }

  const accs = db.chartOfAccounts || [];
  const commPayable = ensureAccount(db, '2800', 'عمولات أطباء مستحقة الدفع', 'liability', '2000');
  const m = (payMethod||'').toLowerCase();
  let payAcc;
  if(m.includes('بنك')||m.includes('bank')||m.includes('تحويل')){
    payAcc = accs.find(a=>a.code==='1110')||{id:'1110',code:'1110',name:'البنك'};
  } else {
    payAcc = accs.find(a=>a.code==='1100')||{id:'1100',code:'1100',name:'الصندوق'};
  }

  const jeId = 'JE-COM-PAY-'+Date.now();
  try {
    appendJournalEntry(db, {
      id: jeId, date: payDateResolved,
      desc:`سداد عمولة د. ${doctor} — شهر ${month}`+(checkNo?` — شيك #${checkNo}`:''),
      ref:`COM-${month}-${doctor}`, type:'commission-payment',
      source: 'doctor-commission', sourceId: entry.id, sourceModule: 'commission',
      totalDebit:amt, totalCredit:amt,
      createdAt:new Date().toISOString(),
      lines:[
        {accountId:commPayable.id, accountCode:'2800', accountName: commPayable.name, debit:amt, credit:0},
        {accountId:payAcc.id, accountCode:payAcc.code, accountName:payAcc.name, debit:0,  credit:amt}
      ]
    });
  } catch (e) {
    if (!(e instanceof JournalValidationError)) throw e;
    return res.status(e.status).json({ success: false, message: e.message, code: e.code });
  }

  entry.paid        = true;
  entry.payMethod   = payMethod;
  entry.payDate     = payDateResolved;
  entry.checkNo     = checkNo || '';
  entry.paymentJeId = jeId;

  appendAuditEvent(db, { req, action: 'commission.paid', resourceType: 'commission', resourceId: `${doctor}/${month}`, after: { payMethod: entry.payMethod, payDate: entry.payDate, amount: amt } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for commission.paid:', e.message);
    return res.status(500).json({ success: false, message: 'تعذّر حفظ سداد العمولة بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// P0.6B — Step 14 (P6-030): read-only reconciliation between the doctor-
// commission subledger (sum of every UNPAID record's recognizedAmount —
// the operational "what do we still owe doctors" view) and the GL's own
// account 2800 balance (the ledger's own answer to the same question).
// Expected `difference: 0` for clean data where every recognition/payment
// went through recognizeCommissionLiability()/POST /api/commission/pay —
// never plugged; a real gap is reported honestly (e.g. historical records
// from before this liability model existed — see P0_6B_HISTORICAL_REMEDIATION.md).
app.get('/api/doctors/commission-reconciliation', requireAuth, requirePermission('doctors', 'view'), (req, res) => {
  const db = loadDB();
  const asOfStr = req.query.asOf && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf) ? req.query.asOf : new Date().toISOString().slice(0,10);
  const outstanding = (db.commissionHistory || []).filter(c => !c.paid);
  const subledgerTotal = parseFloat(outstanding.reduce((s, c) => s + (parseFloat(c.recognizedAmount) || 0), 0).toFixed(3));

  const bm = buildBalanceMap(db, null, asOfStr);
  const b2800 = bm['2800'] || { debit: 0, credit: 0 };
  const glTotal = parseFloat((b2800.credit - b2800.debit).toFixed(3));
  const difference = parseFloat((glTotal - subledgerTotal).toFixed(3));

  res.json({
    asOf: asOfStr, subledgerTotal, glTotal, difference, reconciled: Math.abs(difference) < 0.005,
    outstandingCount: outstanding.length,
    unrecognizedCount: outstanding.filter(c => Math.abs((parseFloat(c.commission)||0) - (parseFloat(c.recognizedAmount)||0)) > 0.005).length,
  });
});

// P1 — GET /api/doctors/:id: master record + a real activity summary, joined
// the only way the data model actually supports — by `name` (see
// doctorHasHistory comment). Never invents a per-doctor subledger; only
// aggregates existing commissionHistory/doctorExpenses/doctorPayments rows.
// NOTE ON ROUTE ORDER: registered AFTER every literal-path /api/doctors/*
// route above (commission-reconciliation) — a `:id` param would otherwise
// match "commission-reconciliation" as a literal id and shadow that route
// entirely (caught by the existing Doctor Liability D / Regression B/C tests).
app.get('/api/doctors/:id', requirePermission('doctors', 'view'), (req, res) => {
  const db = loadDB();
  if (ensureDoctorIds(db)) saveDB(db);
  const doctor = (db.doctors || []).find(d => d.id === req.params.id);
  if (!doctor) return res.status(404).json({ success: false, error: 'الطبيب غير موجود' });

  const commissions = (db.commissionHistory || []).filter(c => c.doctor === doctor.name)
    .sort((a, b) => String(b.month).localeCompare(String(a.month)));
  const totalCommissionPaid = commissions.reduce((s, c) => s + (parseFloat(c.commission) || 0), 0);
  const expenses = (db.doctorExpenses || []).filter(e => e.doctor === doctor.name)
    .sort((a, b) => String(b.month).localeCompare(String(a.month)));
  const payments = (db.doctorPayments || []).filter(p => p.doctor === doctor.name)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  res.json({
    doctor,
    hasHistory: doctorHasHistory(db, doctor.name),
    commissionSummary: {
      monthsRecorded: commissions.length,
      totalCommissionPaid: parseFloat(totalCommissionPaid.toFixed(3)),
      recent: commissions.slice(0, 12),
    },
    expenses: expenses.slice(0, 12),
    payments: payments.slice(0, 12),
  });
});

// P1 — PUT /api/doctors/:id: single-record edit (the existing POST /api/doctors
// full-array-replace stays for the bulk/legacy flow, this adds the missing
// one-record primitive R5's adversarial review flagged). Renaming a doctor
// who already has ANY historical financial activity is blocked — see
// doctorHasHistory — because every existing lookup joins by exact name
// string and this route deliberately does NOT cascade-rename those records
// (that would be an auto-migration of production history, out of scope).
app.put('/api/doctors/:id', requirePermission('doctors', 'edit'), (req, res) => {
  const db = loadDB();
  if (ensureDoctorIds(db)) saveDB(db);
  const idx = (db.doctors || []).findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'الطبيب غير موجود' });
  const before = { ...db.doctors[idx] };

  const body = req.body || {};
  const nextName = body.name !== undefined ? sanitize(String(body.name || ''), 100) : before.name;
  if (!nextName) return res.status(400).json({ success: false, error: 'اسم الطبيب مطلوب' });
  // P1 adversarial-review fix (P0 finding): renaming into a name ALREADY
  // used by a different existing doctor was previously unchecked — this
  // would make two ids share one financial identity (every commission/
  // expense/payment lookup joins by name), fabricating duplicated history
  // for both. Checked before the rename-lock below so the more specific,
  // more dangerous collision case gets its own clear error.
  if (nextName !== before.name) {
    const collision = (db.doctors || []).find(d => d.id !== before.id && d.name === nextName);
    if (collision) {
      return res.status(409).json({
        success: false,
        error: `الاسم "${nextName}" مستخدَم بالفعل لطبيب آخر — أسماء الأطباء يجب أن تكون فريدة لأن كل الحسابات المالية تُربَط بالاسم مباشرة.`,
        code: 'DOCTOR_NAME_DUPLICATE',
      });
    }
  }
  if (nextName !== before.name && doctorHasHistory(db, before.name)) {
    return res.status(409).json({
      success: false,
      error: `لا يمكن تغيير اسم الطبيب "${before.name}" — له سجل مالي فعلي (عمولات/مصاريف/مدفوعات) مرتبط بالاسم الحالي. أنشئ طبيباً جديداً بدلاً من ذلك إن لزم.`,
      code: 'DOCTOR_RENAME_LOCKED',
    });
  }

  db.doctors[idx] = {
    ...before,
    name: nextName,
    target:     body.target     !== undefined ? Math.max(0, parseFloat(body.target) || 0)                     : before.target,
    commission: body.commission !== undefined ? Math.min(100, Math.max(0, parseFloat(body.commission) || 0))  : before.commission,
    lab:        body.lab        !== undefined ? Math.min(100, Math.max(0, parseFloat(body.lab) || 0))         : before.lab,
    insurance:  body.insurance  !== undefined ? Math.min(100, Math.max(0, parseFloat(body.insurance) || 0))   : before.insurance,
  };
  updateCommissions(db);
  appendAuditEvent(db, { req, action: 'doctor.updated', resourceType: 'doctor', resourceId: req.params.id, before, after: db.doctors[idx] });
  saveDB(db);
  res.json({ success: true, doctor: db.doctors[idx] });
});

// Add expense — whitelist only known fields
// دوال تحويل الفئة/طريقة الدفع لحسابات — انتقلت إلى lib/accounting.js (تفكيك تدريجي)
const { expCatToAccount, payMethodToAccount } = require('./lib/accounting');


// P0.6A — Steps 16/18 (P6-058, P6-060): the ONE shared expense-creation
// service every entry point (HTTP API, AI agent, Telegram bot) must call —
// builds and validates the debit/credit journal entry using the exact same
// account-resolution rules the HTTP route always used, and posts it via
// appendJournalEntry (full balance/account-existence/period-lock
// validation — no parallel, weaker accounting path). Throws (a plain Error
// for the simple date/amount checks, JournalValidationError for anything
// appendJournalEntry rejects) and mutates NOTHING if it throws — callers
// decide how to translate that into their own response/reply format, and
// are responsible for saveDB()/audit/anomaly-check side effects.
function buildAndPostExpense(db, data) {
  const { date, desc, cat, amount, vendor, payMethod, notes,
          accountCode, accountId, accountName,
          payMethodCode, vendorId, vendorAccountId } = data;
  const amt = parseFloat(amount);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date)))
    throw new Error('التاريخ مطلوب بصيغة صحيحة (YYYY-MM-DD)');
  if (isNaN(amt) || amt <= 0)
    throw new Error('المبلغ مطلوب ويجب أن يكون رقماً موجباً');
  if (!db.journalEntries) db.journalEntries = [];
  const jeId = nextJeId(db);
  const newExpense = {
    id: genId('exp-'),
    date:      sanitize(date, 10),
    desc:      sanitize(desc, 300),
    cat:       sanitize(cat || accountName, 100),
    amount:    amt,
    vendor:    sanitize(vendor, 200),
    payMethod: sanitize(payMethod || payMethodCode, 50),
    notes:     sanitize(notes, 500),
    vendorId:  sanitize(vendorId, 50),
    journalId: jeId
  };

  // Resolve debit account: prefer explicit accountCode/accountId from new modal
  let debitAcc;
  if (accountCode) {
    const coaAcc = (db.chartOfAccounts||[]).find(a => a.code === accountCode);
    debitAcc = coaAcc
      ? { id: coaAcc.id, code: coaAcc.code, name: coaAcc.name }
      : { id: accountId || accountCode, code: accountCode, name: accountName || accountCode };
  } else {
    const fallback = expCatToAccount(cat, db.chartOfAccounts);
    debitAcc = { code: fallback.code, name: fallback.name };
  }

  // Resolve credit account
  let creditAcc;
  const pm = payMethodCode || payMethod || '';
  if (pm === 'accrued') {
    // P0.7 — Step 22 (explicit decision, not silent ambiguity): kept
    // exactly as-is for backward compatibility (existing records/forms
    // using payMethod:'accrued' keep working, no auto-migration) — but
    // DELIBERATELY option (C): still excluded from GET /api/ap-aging's
    // subledger population, because this path has no settlement-tracking
    // field of its own (no paidAmount/remaining/status — P0.6B's original
    // finding). New callers who need a trackable, payable-lifecycle accrual
    // should use POST /api/accrued-expenses (a real vendor liability) or
    // POST /api/vendor-bills (a real, identified-vendor supplier bill) —
    // both fully participate in AP aging/reconciliation/vendor statements.
    creditAcc = ensureAccount(db, '2900', 'مصاريف مستحقة', 'liability', '2000');
  } else if (pm && pm.match(/^\d{4}$/)) {
    const coaCredit = (db.chartOfAccounts||[]).find(a => a.code === pm);
    creditAcc = coaCredit
      ? { id: coaCredit.id, code: coaCredit.code, name: coaCredit.name }
      : { id: pm, code: pm, name: pm };
  } else {
    const fallback = payMethodToAccount(pm);
    creditAcc = { code: fallback.code, name: fallback.name };
  }

  // Resolve vendor account for journal line (if vendor linked)
  const vendorAcc = vendorAccountId
    ? (() => {
        const va = (db.chartOfAccounts||[]).find(a => a.id === vendorAccountId || a.code === vendorAccountId);
        return va ? { id: va.id, code: va.code, name: va.name } : { id: vendorAccountId, code: vendorAccountId, name: vendor || vendorAccountId };
      })()
    : null;

  const jeDesc = (desc || cat || 'مصروف') + (vendor ? ' — ' + vendor : '');
  const je = {
    id: jeId,
    date: sanitize(date, 10),
    description: jeDesc,
    desc: jeDesc,
    ref: 'EXP-AUTO',
    reference: 'EXP-AUTO',
    type: 'expense',
    source: 'expenses',
    expenseId: newExpense.id,
    totalDebit: amt, totalCredit: amt,
    lines: vendorAcc
      ? [
          { accountId: debitAcc.id, accountCode: debitAcc.code, accountName: debitAcc.name, debit: amt, credit: 0 },
          { accountId: vendorAcc.id, accountCode: vendorAcc.code, accountName: vendorAcc.name, debit: 0, credit: amt }
        ]
      : [
          { accountId: debitAcc.id, accountCode: debitAcc.code, accountName: debitAcc.name, debit: amt, credit: 0 },
          { accountId: creditAcc.id, accountCode: creditAcc.code, accountName: creditAcc.name, debit: 0, credit: amt }
        ],
    createdAt: new Date().toISOString()
  };
  // P0.3 — Pattern A: validate/append the journal BEFORE the expense record
  // is stored, so a rejected posting never leaves an orphaned expense
  // pointing at a journal entry that was never created.
  appendJournalEntry(db, je);
  db.expenses = db.expenses || [];
  db.expenses.push(newExpense);
  return { expense: newExpense, journalId: jeId, debitAccount: debitAcc, creditAccount: creditAcc };
}

// P0.11 (saveDB call-site audit — adversarial review finding, persistence
// persona): this is the highest-frequency expense-entry route in the app and
// was missed by the original Part Q pass despite posting a real journal
// entry. Converted to durable-before-ack; the pre-existing `throw e` for
// JournalValidationError (relying on Express's synchronous-throw forwarding)
// no longer applies now that the handler is async, so it's now caught
// explicitly and forwarded via next(err) — the global error middleware
// already formats it identically either way.
app.post('/api/expenses', requirePermission('expenses', 'add'), async (req, res, next) => {
  try {
    const db = loadDB();

    // P0.12 (closes P6-097 — highest-volume expense-entry route in the app,
    // per its own P0.11 comment; had zero idempotency protection).
    const isMongo = !isFileFallbackMode();
    const idemKey = extractIdempotencyKey(req);
    let idemRecord = null;
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const b = req.body || {};
      // P0.12 adversarial-review fix (P0, confirmed real): the field named
      // `paymentMethod` here never matched anything buildAndPostExpense()
      // actually reads (payMethod/payMethodCode select the CREDIT account;
      // accountCode/accountId/accountName select the DEBIT account) — it
      // was always undefined and silently dropped by JSON.stringify, so
      // two real, different expenses (e.g. identical date/amount/desc but
      // cash vs bank) collided on the same fingerprint: the second, real
      // expense was silently never posted, replayed as a false "success".
      const fingerprint = computeFingerprint('expense:create', {
        date: b.date, amount: b.amount, cat: b.cat, vendor: b.vendor, desc: b.desc, notes: b.notes,
        payMethod: b.payMethod, payMethodCode: b.payMethodCode,
        accountCode: b.accountCode, accountId: b.accountId, accountName: b.accountName,
        vendorId: b.vendorId, vendorAccountId: b.vendorAccountId,
      });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'expense:create', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, ...claim.record.resultReference });
      }
      idemRecord = claim.record;
    }

    let result;
    try {
      result = buildAndPostExpense(db, req.body);
    } catch (e) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      if (e instanceof JournalValidationError) throw e;
      return res.status(400).json({ error: e.message });
    }
    appendAuditEvent(db, { req, action: 'expense.created', resourceType: 'expense', resourceId: result.expense.id, after: { date: result.expense.date, amount: result.expense.amount, cat: result.expense.cat, vendor: result.expense.vendor } });
    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { journalId: result.journalId, debitAccount: result.debitAccount, creditAccount: result.creditAccount }, result.expense.id, result.journalId);
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      // P0.12 adversarial-review fix: completeIdempotencyClaim already
      // marked idemRecord COMPLETED in memory above — if the durable write
      // itself fails, that optimistic state must not survive to fool a
      // same-process retry into replaying a mutation that was never saved.
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      throw e;
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    checkExpenseAnomaly(result.expense).catch(()=>{});
    res.json({ success: true, journalId: result.journalId, debitAccount: result.debitAccount, creditAccount: result.creditAccount });
  } catch (err) {
    next(err);
  }
});

// Delete expense + its auto-generated journal entry
// P0.11 (saveDB call-site audit — adversarial review finding): converted to
// durable-before-ack.
app.delete('/api/expenses/:id', requirePermission('expenses', 'delete'), async (req, res, next) => {
  try {
    const db = loadDB();
    const exp = (db.expenses||[]).find(e => String(e.id) === String(req.params.id));
    // P0.6A — Step 4 (P6-012): check the lock BEFORE mutating anything — this
    // route previously deleted the linked journal entry with no lock check at
    // all, letting a closed period's ledger change via the expense record
    // instead of the (correctly-protected) journal-delete route.
    if (exp) assertFinancialPeriodOpen(db, [exp.date]);
    db.expenses = (db.expenses||[]).filter(e => String(e.id) !== String(req.params.id));
    // Remove linked JE if it was auto-created by expenses route
    if (exp && exp.journalId) {
      const je = (db.journalEntries||[]).find(j => j.id === exp.journalId && j.source === 'expenses');
      if (je) db.journalEntries = db.journalEntries.filter(j => j.id !== exp.journalId);
    }
    if (exp) appendAuditEvent(db, { req, action: 'expense.deleted', resourceType: 'expense', resourceId: exp.id, before: { date: exp.date, amount: exp.amount, cat: exp.cat } });
    await saveDB(db, { durable: true });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ===== RESET DATA (admin only) =====
app.post('/api/reset-data', requireAuth, requireAdminAction('data.reset'), (req, res) => {
  const { scope } = req.body; // 'all' | 'transactions'
  const db = loadDB();

  // Always wipe transaction data
  db.dailyData        = [];
  db.paymentsData     = [];
  db.commissionHistory = [];
  db.journalEntries   = [];
  db.expenses         = [];
  db.uploadedFiles    = [];
  db.vouchers         = [];
  db.cashReconciliation = [];
  db.insuranceClaims  = [];
  db.payroll          = [];
  db.invMovements     = [];

  if (scope === 'all') {
    // Also reset doctors, vendors, inventory, assets, COA (re-seed defaults)
    db.doctors      = [];
    db.vendors      = [];
    db.invItems     = [];
    db.invCategories = [];
    db.employees    = [];
    db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
  }

  appendAuditEvent(db, { req, action: 'data.reset', resourceType: 'database', outcome: 'success', after: { scope } });
  saveDB(db);
  res.json({ success: true, scope });
});

// Stats endpoint — reads from journal entries (source of truth)
app.get('/api/stats', requirePermission('financials', 'view'), (req, res) => {
  const { from, to } = req.query;
  const db = loadDB();
  const r3 = v => parseFloat(v.toFixed(3));

  // Filter journal entries by date range
  // R5 (staging validation, reproduced live): a period-end close posts a
  // type:'closing' transfer entry that CREDITS every 5xxx expense account
  // to zero it into 3300 — the revenue sum below only counts CREDIT lines
  // on 4xxx accounts, so a closing entry's DEBIT-side reversal of revenue
  // was already (accidentally) excluded; but the expense sum further down
  // computes a signed net (debit-credit) with no type filter at all, so a
  // closing entry's large CREDIT to 5xxx accounts became a large NEGATIVE
  // "expense" that silently cancelled out the real expense postings for the
  // exact same accounts — after even one month-end close, totalExpenses (and
  // therefore netIncome, and the dashboard's headline KPI cards) could read
  // ~0 regardless of real activity, while totalRevenue stayed correct by
  // coincidence. GET /api/reports/pnl already excludes type:'closing' for
  // this exact reason (see its own comment) — mirrored here.
  let entries = (db.journalEntries || []).filter(e => e.type !== 'closing');
  if (from) entries = entries.filter(e => e.date >= from);
  if (to)   entries = entries.filter(e => e.date <= to);

  // Revenue accounts: any account whose code starts with '4'
  const coa = db.chartOfAccounts || [];
  const isRevAccount = (accountId) => {
    const acc = coa.find(a => a.id === accountId || a.code === accountId);
    return acc ? acc.code.startsWith('4') : false;
  };

  // Sum credit amounts per revenue account from journal lines
  const revByCode = {};
  for (const entry of entries) {
    for (const line of entry.lines || []) {
      if ((line.credit || 0) > 0 && isRevAccount(line.accountId)) {
        const acc = coa.find(a => a.id === line.accountId);
        const code = acc?.code || line.accountCode || line.accountId;
        revByCode[code] = (revByCode[code] || 0) + (line.credit || 0);
      }
    }
  }

  const totalRevenue = Object.values(revByCode).reduce((s, v) => s + v, 0);
  const insRevenue   = revByCode['4150'] || 0; // إيرادات تأمين
  const cashRevenue  = revByCode['4100'] || 0;
  const knetRevenue  = revByCode['4110'] || 0;
  const visaRevenue  = revByCode['4120'] || 0;
  const masterRevenue= revByCode['4130'] || 0;
  const linkRevenue  = revByCode['4140'] || 0;
  const chequeRevenue= revByCode['4160'] || 0;

  // Insurance: 4150 now holds gross amount; compute share using config rate
  const cfg2         = loadConfig();
  const insRate2     = typeof cfg2.insDeductionRate === 'number' ? cfg2.insDeductionRate : 0.13;
  const insOriginal  = insRevenue; // gross (credited to 4150 directly)
  const insShare     = r3(insRevenue * insRate2);

  // Work days = unique dates with revenue > 0 from daily data (unchanged)
  let daily = db.dailyData || [];
  if (from) daily = daily.filter(d => d.date >= from);
  if (to)   daily = daily.filter(d => d.date <= to);
  const workDays = daily.filter(d => d.total > 0).length;

  const totalComm  = (db.commissionHistory || []).reduce((s, c) => s + (c.commission || 0), 0);
  const pendingComm= (db.commissionHistory || []).filter(c => !c.paid).reduce((s, c) => s + (c.commission || 0), 0);

  // المصاريف والرواتب — مربوطة مباشرة بالقيود الفعلية (5xxx) لنفس الفترة المختارة،
  // مع تفصيل يومي (إيراد/مصروف/رواتب/صافي) لكل تاريخ ظهرت فيه حركة.
  const byDate = {};
  let totalExpenses = 0, totalPayroll = 0;
  for (const entry of entries) {
    const d = entry.date;
    if (!byDate[d]) byDate[d] = { revenue: 0, expenses: 0, payroll: 0 };
    for (const line of entry.lines || []) {
      const acc  = coa.find(a => a.id === line.accountId || a.code === line.accountId);
      const code = acc?.code || line.accountCode || '';
      if (!code) continue;
      if (code.startsWith('4') && (line.credit || 0) > 0) byDate[d].revenue += line.credit || 0;
      if (code.startsWith('5')) {
        const net = (line.debit || 0) - (line.credit || 0);
        byDate[d].expenses += net;
        totalExpenses += net;
        if (code === '5110' || code === '5120') { byDate[d].payroll += net; totalPayroll += net; }
      }
    }
  }
  const dailyBreakdown = Object.keys(byDate).sort().map(d => ({
    date: d,
    revenue:  r3(byDate[d].revenue),
    expenses: r3(byDate[d].expenses),
    payroll:  r3(byDate[d].payroll),
    net:      r3(byDate[d].revenue - byDate[d].expenses),
  }));

  res.json({
    totalRevenue:  r3(totalRevenue),
    insRecorded:   r3(insRevenue - insShare),
    insOriginal:   r3(insRevenue),
    insShare,
    insNet:        r3(insRevenue - insShare),
    insRate:       insRate2,
    netCash:       r3(totalRevenue - insRevenue),
    workDays,
    totalComm:     r3(totalComm),
    pendingComm:   r3(pendingComm),
    totalExpenses: r3(totalExpenses),
    totalPayroll:  r3(totalPayroll),
    netIncome:     r3(totalRevenue - totalExpenses),
    dailyBreakdown,
    // breakdown by payment method
    byMethod: {
      cash:   r3(cashRevenue),
      knet:   r3(knetRevenue),
      visa:   r3(visaRevenue),
      master: r3(masterRevenue),
      link:   r3(linkRevenue),
      cheque: r3(chequeRevenue),
      insurance: r3(insRevenue),
    }
  });
});

// ===== TELEGRAM BOT =====
let bot = null;

// Allowed chat IDs — set TG_ALLOWED_CHATS=123456,789012 in .env, or auto-register first user
const _tgAllowedChats = new Set(
  (process.env.TG_ALLOWED_CHATS || '').split(',').filter(Boolean).map(Number)
);
function _isTgAllowed(chatId) {
  if (_tgAllowedChats.has(chatId)) return true;
  const db = loadDB();
  const saved = db.scheduleConfig?.chatId;
  if (saved && Number(saved) === Number(chatId)) return true;
  return false;
}

// P0.5 — Step 14/15: "first message wins" auto-registration is a real
// takeover window — the bot's username is discoverable on Telegram, and
// whoever messages it FIRST (not necessarily the operator who just
// configured the token) becomes the permanently-trusted chat with access to
// financial actions (file upload → dailyData/paymentsData ingestion, below).
// Removing auto-registration entirely would break the only bootstrap path
// (there is no other way to learn the operator's chat id), so instead the
// window is bounded: auto-registration is only honored for
// TG_REGISTRATION_WINDOW_MS after /api/telegram/start is called — an
// attacker who is not watching at that exact moment (and does not already
// know the token was just (re)configured) cannot win the race later, even
// years later after a restart. Exported for tests — never calls Telegram.
const TG_REGISTRATION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
let _tgBotStartedAt = 0;

function _tgRegistrationWindowOpen() {
  return _tgBotStartedAt > 0 && (Date.now() - _tgBotStartedAt) <= TG_REGISTRATION_WINDOW_MS;
}

// R3 — NEW-R1-SEC-02 reverified: this route was already covered by the
// global `app.use('/api', requireAuth, tenantMiddleware)` mount (server.js,
// registered before this route) — an anonymous request already gets 401
// (proven by the existing test 'Telegram A' in production-hardening.test.js
// and empirically via curl). The ORIGINAL finding (unauthenticated hijack)
// is stale. The real residual gap: this route had no requirePermission, so
// ANY authenticated user of ANY role in a tenant could reconfigure that
// tenant's bot token — least-privilege gap, not the reported vulnerability.
// Fixed to match every other tenant-configuration route's convention.
app.post('/api/telegram/start', requireAuth, requirePermission('telegram', 'edit'), async (req, res) => {
  const { token } = req.body;

  // Stop old bot completely before starting new one
  if (bot) {
    try { await bot.stopPolling({ cancel: true }); } catch(e) {}
    bot = null;
    global._tgBot = null;
    await new Promise(r => setTimeout(r, 1500));
  }

  try {
    const cleanToken = String(token || '').trim().replace(/[\s\n\r]/g, '');
    bot = new TelegramBot(cleanToken, { polling: { interval: 1000, params: { timeout: 10 } } });
    _tgBotStartedAt = Date.now();
    setupBot(bot);

    // Save token encrypted (base64 obfuscation — not true encryption, but keeps it out of plaintext)
    const db = loadDB();
    db.telegramToken = Buffer.from(cleanToken).toString('base64');
    appendAuditEvent(db, { req, action: 'telegram.bot_started', resourceType: 'telegram', outcome: 'success' });
    saveDB(db);

    res.json({ success: true, message: 'البوت شغال ✅' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'فشل تشغيل البوت: ' + err.message });
  }
});

function setupBot(bot) {
  global._tgBot = bot;
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // ── Auto-register first user (only within the bootstrap window), then enforce whitelist ──
    if (!_isTgAllowed(chatId)) {
      const db = loadDB();
      if (!db.scheduleConfig?.chatId && _tgRegistrationWindowOpen()) {
        // First user to message becomes the admin
        if (!db.scheduleConfig) db.scheduleConfig = {};
        db.scheduleConfig.chatId = chatId;
        _tgAllowedChats.add(chatId);
        appendAuditEvent(db, { req: { path: 'telegram:auto-register', tenantId: 'default' }, action: 'telegram.chat_auto_registered', resourceType: 'telegram', resourceId: String(chatId), outcome: 'success' });
        saveDB(db);
        bot.sendMessage(chatId, '✅ تم تسجيلك كمستخدم رئيسي للبوت.\n\nاكتب /start لقائمة الأوامر.');
      } else {
        appendAuditEvent(db, { req: { path: 'telegram:message', tenantId: 'default' }, action: 'telegram.unauthorized_chat_blocked', resourceType: 'telegram', resourceId: String(chatId), outcome: 'failure' });
        saveDB(db);
        bot.sendMessage(chatId, '⛔ غير مصرح.');
      }
      return;
    }

    // File received
    if (msg.document) {
      const fileName = msg.document.file_name || '';
      bot.sendMessage(chatId, `📂 استلمت الملف: ${fileName}\nجاري المعالجة...`);
      
      // P0.5A — Step 4/7: tempPath used to be built from the Telegram-
      // supplied fileName directly (`tg_${Date.now()}_${fileName}`) — a
      // real path-traversal risk (CWE-22), since that filename is chosen by
      // whoever sends the document, not by us. buildTenantKey() generates a
      // server-controlled name instead (only the — allow-listed — extension
      // is taken from the original name); the original name is kept
      // separately as metadata (`db.uploadedFiles[].name`) exactly as
      // before, never as part of a filesystem path. Cleanup now runs in
      // `finally` so a processing error can no longer leak the temp file.
      const tempPath = path.join(UPLOADS_DIR, buildTenantKey('default', 'telegram-temp', fileName));
      try {
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const https = require('https');
        const http = require('http');
        const client = fileLink.startsWith('https') ? https : http;

        await fs.ensureDir(path.dirname(tempPath));
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tempPath);
          client.get(fileLink, res => { res.pipe(file); file.on('finish', resolve); }).on('error', reject);
        });

        const db = loadDB();
        const lowerName = fileName.toLowerCase();
        let parsed = [];
        let type = '';
        const batchId = 'BATCH-TG-' + Date.now();
        let importSummary = null;

        if (lowerName.includes('dailyincome')) {
          parsed = parseDailyIncome(tempPath);
          type = 'daily';
          // R4 — NEW-R3-TELEGRAM-UPLOAD-01 fix: this used to merge into
          // db.dailyData and STOP — no journal entry was ever posted, so
          // Telegram-imported revenue showed on dailyData-driven dashboards
          // but never reached the GL/financial statements. Now calls the
          // SAME canonical accounting function POST /api/upload uses (no
          // second implementation to drift out of sync).
          const result = processDailyIncomeUpload(db, parsed, batchId);
          parsed = result.validRows;
          importSummary = result;
        } else if (lowerName.includes('payments')) {
          parsed = parsePaymentsDetails(tempPath);
          type = 'payments';
          const existingIds = new Set(db.paymentsData.map(d => d.invId));
          for (const rec of parsed) { rec._batchId = batchId; if (!existingIds.has(rec.invId)) db.paymentsData.push(rec); }
          db.paymentsData.sort((a, b) => b.date.localeCompare(a.date));
          updateCommissions(db);
        }

        db.uploadedFiles.push({ id: batchId, batchId, name: fileName, type, records: parsed.length, months: importSummary?.uploadMonths || [], date: new Date().toISOString() });
        // R4 adversarial-review fix (Accountant persona): removedMonths
        // (a month whose net total ended up zero/negative and had its old
        // journal entry removed with nothing rebuilt) was reported in both
        // the audit event and the user-facing message for the browser
        // upload path (POST /api/upload) but silently dropped from both
        // here — a Telegram upload that net-zeroed a previously-posted
        // month gave no indication anything but "success" happened.
        appendAuditEvent(db, { req: { headers: {}, path: '/telegram/upload', tenantId: 'default' }, action: 'upload.file_imported', resourceType: 'upload', resourceId: batchId, after: { type, records: parsed.length, source: 'telegram', ...(importSummary ? { added: importSummary.importAdded, updated: importSummary.importUpdated, rejectedInvalid: importSummary.importRejected, monthsAffected: importSummary.uploadMonths, monthsRemoved: importSummary.removedMonths } : {}), fileName } });
        saveDB(db);

        const removedNote = importSummary?.removedMonths?.length ? `\n⚠️ أشهر أُزيل قيدها بلا بديل: ${importSummary.removedMonths.join(', ')}` : '';
        const summaryTxt = importSummary
          ? `✅ تم حفظ ${parsed.length} سجل وترحيل قيد الإيراد (${importSummary.uploadMonths.join(', ') || 'لا شهر جديد'})${removedNote}\nاكتب /stats لرؤية الإحصائيات`
          : `✅ تم حفظ ${parsed.length} سجل بنجاح!\nاكتب /stats لرؤية الإحصائيات`;
        bot.sendMessage(chatId, summaryTxt);
      } catch (err) {
        bot.sendMessage(chatId, `❌ خطأ: ${err.message}`);
      } finally {
        try { fs.removeSync(tempPath); } catch { /* never let cleanup failure mask the real error */ }
      }
      return;
    }
    
    // Photo received — invoice AI reader
    if (msg.photo) {
      bot.sendMessage(chatId, '🔍 جاري قراءة الفاتورة...');
      try {
        const largestPhoto = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(largestPhoto.file_id);
        const https = require('https');
        const http  = require('http');
        const client = fileLink.startsWith('https') ? https : http;
        const tempPath = path.join(UPLOADS_DIR, `invoice_${Date.now()}.jpg`);
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tempPath);
          client.get(fileLink, r => { r.pipe(file); file.on('finish', resolve); }).on('error', reject);
        });
        const base64Image = fs.readFileSync(tempPath).toString('base64');
        fs.removeSync(tempPath);

        const rawText = await callAIVision({
          model: 'claude-sonnet-4-6',
          base64Image,
          prompt: `استخرج بيانات هذه الفاتورة وأجب بـ JSON فقط:\n{"vendor":"اسم المورد","amount":رقم,"date":"YYYY-MM-DD","category":"مواد مختبر/رواتب/إيجار/كهرباء/صيانة/أخرى","description":"وصف قصير"}\nإذا ما قدرت تقرأ قيمة حط null. اليوم: ${new Date().toISOString().split('T')[0]}`,
          max_tokens: 500,
        }) || '{}';
        let invoice;
        try { invoice = JSON.parse(rawText.replace(/```json|```/g, '').trim()); } catch(e) { invoice = {}; }

        const db = loadDB();
        if (!db.pendingInvoices) db.pendingInvoices = {};
        db.pendingInvoices[chatId] = { step: 'confirm_data', invoice };
        saveDB(db);

        const esc = s => String(s||'').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        bot.sendMessage(chatId,
          '📄 *قرأت الفاتورة:*\n\n' +
          '🏢 المورد: ' + esc(invoice.vendor || 'غير واضح') + '\n' +
          '💰 المبلغ: ' + esc(invoice.amount ? invoice.amount + ' د.ك' : 'غير واضح') + '\n' +
          '📅 التاريخ: ' + esc(invoice.date || 'غير واضح') + '\n' +
          '📂 التصنيف: ' + esc(invoice.category || 'غير واضح') + '\n' +
          '📝 الوصف: ' + esc(invoice.description || '—') + '\n\n' +
          'هل البيانات صحيحة؟',
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
            { text: '✅ نعم، صحيحة', callback_data: 'inv_confirm_data' },
            { text: '❌ إلغاء', callback_data: 'inv_cancel' }
          ]]}}
        );
      } catch(err) {
        bot.sendMessage(chatId, '❌ خطأ في قراءة الفاتورة: ' + err.message);
      }
      return;
    }

    // ── Voice-to-Journal ────────────────────────────────────────────────────
    if (msg.voice || msg.audio) {
      bot.sendMessage(chatId, '🎤 جاري تحليل الرسالة الصوتية...');
      try {
        const fileId   = (msg.voice || msg.audio).file_id;
        const fileLink = await bot.getFileLink(fileId);
        const https    = require('https');
        const http     = require('http');
        const proto    = fileLink.startsWith('https') ? https : http;
        const tmpPath  = path.join(UPLOADS_DIR, `voice_${Date.now()}.ogg`);

        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tmpPath);
          proto.get(fileLink, r => { r.pipe(file); file.on('finish', resolve); }).on('error', reject);
        });

        // Claude doesn't transcribe audio directly — send as base64 + ask to interpret
        // as text describing a financial transaction (user must send voice in Arabic)
        const audioB64 = fs.readFileSync(tmpPath).toString('base64');
        fs.removeSync(tmpPath);

        const db    = loadDB();
        const coa   = (db.chartOfAccounts || [])
          .filter(a => !a.isGroup && a.status !== 'inactive')
          .map(a => `${a.code}|${a.name}|${a.type}`).join('\n');
        const today = new Date().toISOString().slice(0, 10);

        // Use Claude to decode the voice as financial intent
        const rawText = await callAI({
          model: 'claude-sonnet-4-6', max_tokens: 800,
          messages: [{ role: 'user', content: [
            { type: 'document', source: { type: 'base64', media_type: 'audio/ogg', data: audioB64 } },
            { type: 'text', text: `استمع لهذه الرسالة الصوتية وحولها لقيد محاسبي.
اليوم: ${today}. دليل الحسابات:\n${coa}
أعد JSON فقط:
{"transcription":"النص المسموع","date":"YYYY-MM-DD","description":"وصف القيد","lines":[{"accountCode":"","accountName":"","debit":0,"credit":0}],"confidence":0.0}` },
          ]}],
        }) || '{}';
        const jMatch  = rawText.match(/\{[\s\S]*\}/);
        if (!jMatch) throw new Error('فشل تحليل الصوت');

        const result = JSON.parse(jMatch[0]);
        const lines  = (result.lines || []);
        const dr     = lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0);
        const cr     = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
        const bal    = Math.abs(dr - cr) < 0.005;

        // Store pending voice JE for confirmation
        if (!db.pendingVoiceJE) db.pendingVoiceJE = {};
        db.pendingVoiceJE[chatId] = { result, dr, cr };
        saveDB(db);

        const esc = s => String(s||'').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        const linesText = lines.map(l => `  ${esc(l.accountCode)} ${esc(l.accountName)}: مدين ${l.debit||0} / دائن ${l.credit||0}`).join('\n');

        bot.sendMessage(chatId,
          `🎤 *ما سمعته:* ${esc(result.transcription || '...')}\n\n` +
          `📅 التاريخ: ${esc(result.date || today)}\n` +
          `📝 الوصف: ${esc(result.description || '...')}\n\n` +
          `📋 *القيد المقترح:*\n${linesText}\n\n` +
          `${bal ? '✅ القيد متوازن' : '⚠️ القيد غير متوازن!'}\n` +
          `هل تريد حفظ هذا القيد؟`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
            { text: '✅ حفظ القيد', callback_data: 'voice_je_confirm' },
            { text: '❌ إلغاء',     callback_data: 'voice_je_cancel' }
          ]]}}
        );
      } catch(err) {
        bot.sendMessage(chatId, '❌ خطأ في تحليل الصوت: ' + err.message);
      }
      return;
    }

    // Cancel invoice (text fallback)
    if (text === '/cancel_invoice') {
      const db = loadDB();
      if (db.pendingInvoices) delete db.pendingInvoices[chatId];
      saveDB(db);
      bot.sendMessage(chatId, '❌ تم إلغاء الفاتورة.');
      return;
    }

    // Manual expense entry: /expense 50 مواد مختبر
    if (text.startsWith('/expense ')) {
      const parts = text.replace('/expense ', '').split(' ');
      const amount = parseFloat(parts[0]);
      const desc = sanitize(parts.slice(1).join(' '), 300);
      if (!amount || !desc) {
        bot.sendMessage(chatId, '❌ الصيغة: /expense [المبلغ] [الوصف]\nمثال: /expense 50 مواد مختبر');
        return;
      }
      // P0.6A — Step 18 (P6-060): route through the exact same
      // buildAndPostExpense() service POST /api/expenses and the AI agent's
      // add_expense action both use — this used to push straight into
      // db.expenses with NO journal entry at all, invisible to every
      // financial statement. Now gets a real, validated, balanced journal
      // entry, exactly like an expense entered through the UI.
      const db = loadDB();
      let result;
      try {
        result = buildAndPostExpense(db, {
          date: new Date().toISOString().split('T')[0],
          desc, cat: 'أخرى', amount: Math.max(0, amount), payMethod: 'cash',
        });
      } catch (e) {
        bot.sendMessage(chatId, '❌ تعذّر تسجيل المصروف: ' + e.message);
        return;
      }
      appendAuditEvent(db, { action: 'expense.created', resourceType: 'expense', resourceId: result.expense.id, source: 'telegram', metadata: { chatId }, after: { date: result.expense.date, amount: result.expense.amount, cat: result.expense.cat, source: 'telegram_manual' } });
      saveDB(db);
      bot.sendMessage(chatId, '✅ تم تسجيل المصروف: ' + desc + ' — ' + amount + ' د.ك');
      return;
    }

    // Show expenses — grouped by category
    if (text === '/expenses') {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0, 7);
      const expenses = (db.expenses || []).filter(e => e.date && e.date.startsWith(thisMonth));
      if (!expenses.length) { bot.sendMessage(chatId, '💸 لا توجد مصاريف هذا الشهر.\nأضف مصروف: /expense [مبلغ] [وصف]'); return; }
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      const total = expenses.reduce((s,e) => s + (e.amount||0), 0);
      // Group by category
      const catTotals = {};
      expenses.forEach(e => { catTotals[e.cat||'أخرى'] = (catTotals[e.cat||'أخرى']||0) + (e.amount||0); });
      const sorted = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
      let msg = `💸 *مصاريف ${thisMonth}*\n\n`;
      sorted.forEach(([cat, amt]) => {
        const pct = Math.round(amt/total*100);
        const bar = '█'.repeat(Math.min(8,Math.floor(pct/13))) + '░'.repeat(Math.max(0,8-Math.min(8,Math.floor(pct/13))));
        msg += `📂 *${cat}*: ${fmt(amt)} د.ك (${pct}%)\n${bar}\n`;
      });
      msg += `\n💰 *الإجمالي: ${fmt(total)} د.ك*`;
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      return;
    }

    // ---- Inventory Telegram Commands ----
    if (text === '/stock' || text === '/مخزون') {
      const db = loadDB();
      const items = db.invItems || [];
      if (!items.length) { bot.sendMessage(chatId, '📦 لا توجد أصناف مسجّلة في المخزون.'); return; }
      // Support both field naming conventions (qty/quantity, minQty/minQuantity, nameAr/name)
      const qty  = i => parseFloat(i.qty ?? i.quantity ?? 0);
      const minQ = i => parseFloat(i.minQty ?? i.minQuantity ?? 0);
      const nm   = i => i.nameAr || i.name || i.nameEn || '—';
      const totalVal = items.reduce((s,i) => s + qty(i) * (parseFloat(i.cost)||0), 0);
      const low  = items.filter(i => qty(i) > 0 && qty(i) <= minQ(i));
      const out  = items.filter(i => qty(i) <= 0);
      let msg = `📦 *ملخص المخزون*\n\n`;
      msg += `🔢 إجمالي الأصناف: *${items.length}*\n`;
      msg += `💰 القيمة الكلية: *${totalVal.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك*\n`;
      if (out.length)  msg += `\n🔴 *نفد (${out.length}):*\n` + out.map(i=>`  • ${nm(i)}`).join('\n');
      if (low.length)  msg += `\n🟡 *منخفض (${low.length}):*\n` + low.map(i=>`  • ${nm(i)}: ${qty(i)} ${i.unit||''} (حد: ${minQ(i)})`).join('\n');
      if (!out.length && !low.length) msg += `\n✅ جميع الأصناف بمستويات كافية.`;
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/lowstock') {
      const db = loadDB();
      const items = db.invItems || [];
      const qty  = i => parseFloat(i.qty ?? i.quantity ?? 0);
      const minQ = i => parseFloat(i.minQty ?? i.minQuantity ?? 0);
      const nm   = i => i.nameAr || i.name || i.nameEn || '—';
      const low = items.filter(i => qty(i) <= minQ(i));
      if (!low.length) { bot.sendMessage(chatId, '✅ لا توجد أصناف منخفضة أو نافدة.'); return; }
      let msg = `⚠️ *أصناف تحتاج إعادة طلب*\n\n`;
      low.forEach(i => {
        const icon = qty(i) <= 0 ? '🔴' : '🟡';
        msg += `${icon} *${nm(i)}*\n   الكمية: ${qty(i)} ${i.unit||''} | الحد: ${minQ(i)}\n\n`;
      });
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/item ')) {
      const db = loadDB();
      const query = text.replace('/item ', '').trim().toLowerCase();
      const qty  = i => parseFloat(i.qty ?? i.quantity ?? 0);
      const minQ = i => parseFloat(i.minQty ?? i.minQuantity ?? 0);
      const nm   = i => i.nameAr || i.name || i.nameEn || '—';
      const item = (db.invItems || []).find(i =>
        nm(i).toLowerCase().includes(query) ||
        (i.code && i.code.toLowerCase() === query) ||
        (i.nameEn && i.nameEn.toLowerCase().includes(query))
      );
      if (!item) { bot.sendMessage(chatId, `❌ لم أجد صنفاً باسم "${query}"`); return; }
      const val = qty(item) * (parseFloat(item.cost)||0);
      bot.sendMessage(chatId,
        `📦 *${nm(item)}*\n` +
        (item.code ? `كود: \`${item.code}\`\n` : '') +
        `الكمية: *${qty(item)} ${item.unit||''}*\n` +
        `سعر الوحدة: *${(parseFloat(item.cost)||0).toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك*\n` +
        `القيمة الكلية: *${val.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك*\n` +
        `الحد الأدنى: ${minQ(item)} ${item.unit||''}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // /goals — تقدم أهداف الدكاترة
    if (text === '/goals' || text === '/أهداف') {
      const db = loadDB();
      const doctors = db.doctors || [];
      const thisMonth = new Date().toISOString().substring(0,7);
      const mEntries = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(thisMonth));
      const drRevMap = {};
      mEntries.forEach(day => {
        // Support both formats: day.doctor (string) and day.doctors[] (array)
        if (day.doctor) {
          drRevMap[day.doctor] = (drRevMap[day.doctor]||0) + (parseFloat(day.total)||0);
        }
        (day.doctors||[]).forEach(dr => { drRevMap[dr.name] = (drRevMap[dr.name]||0) + (dr.revenue||0); });
      });
      const withTarget = doctors.filter(d=>d.target>0);
      if (!withTarget.length) { bot.sendMessage(chatId, '🎯 لم يُحدَّد هدف لأي دكتور بعد.\nحدّد الأهداف من لوحة التحكم.'); return; }
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      let msg = `🎯 *تقدم الأهداف — ${thisMonth}*\n\n`;
      withTarget.forEach(dr => {
        const rev = drRevMap[dr.name] || 0;
        const pct = Math.round((rev / dr.target) * 100);
        const filled = Math.min(10, Math.floor(pct/10));
        const bar = '█'.repeat(filled) + '░'.repeat(10-filled);
        const icon = pct >= 80 ? '✅' : pct >= 50 ? '⚠️' : '🔴';
        msg += `${icon} *${dr.name}*\n  ${bar} ${pct}%\n  ${fmt(rev)} / ${fmt(dr.target)} د.ك\n\n`;
      });
      const totalRev = withTarget.reduce((s,d)=>(s + (drRevMap[d.name]||0)), 0);
      const totalTarget = withTarget.reduce((s,d)=>s+d.target, 0);
      const overallPct = totalTarget > 0 ? Math.round(totalRev/totalTarget*100) : 0;
      msg += `📊 *الإجمالي: ${overallPct}% من الهدف*`;
      bot.sendMessage(chatId, msg, { parse_mode:'Markdown' });
      return;
    }

    // /doctors — تصنيف الدكاترة هذا الشهر
    if (text === '/doctors' || text === '/دكاترة') {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0,7);
      const mEntries = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(thisMonth));
      const drMap = {};
      mEntries.forEach(day => {
        if (day.doctor) {
          drMap[day.doctor] = (drMap[day.doctor]||0) + (parseFloat(day.total)||0);
        }
        (day.doctors||[]).forEach(dr => { drMap[dr.name] = (drMap[dr.name]||0) + (dr.revenue||0); });
      });
      const ranked = Object.entries(drMap).sort((a,b)=>b[1]-a[1]);
      if (!ranked.length) { bot.sendMessage(chatId, '📭 لا توجد بيانات دكاترة لهذا الشهر.'); return; }
      const medals = ['🥇','🥈','🥉'];
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      let msg = `🏆 *تصنيف الدكاترة — ${thisMonth}*\n\n`;
      const total = ranked.reduce((s,[,r])=>s+r,0);
      ranked.forEach(([name, rev], i) => {
        const medal = medals[i] || `${i+1}.`;
        const share = total > 0 ? Math.round(rev/total*100) : 0;
        msg += `${medal} *${name}*: ${fmt(rev)} د.ك (${share}%)\n`;
      });
      msg += `\n💰 *الإجمالي: ${fmt(total)} د.ك*`;
      bot.sendMessage(chatId, msg, { parse_mode:'Markdown' });
      return;
    }

    // /summary — ملخص سريع متكامل
    if (text === '/summary' || text === '/ملخص') {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0,7);
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      const daily = (db.dailyData||[]).filter(d=>d.date?.startsWith(thisMonth));
      const totalRev = daily.reduce((s,d)=>s+(d.total||0),0);
      const totalIns = daily.reduce((s,d)=>s+(d.insurance||0),0);
      const totalExp = (db.expenses||[]).filter(e=>e.date?.startsWith(thisMonth)).reduce((s,e)=>s+(e.amount||0),0);
      const pendingComm = (db.commissionHistory||[]).filter(c=>!c.paid).reduce((s,c)=>s+(c.commission||0),0);
      const lowStock = (db.invItems||[]).filter(i=>(parseFloat(i.qty??i.quantity??0))<=(parseFloat(i.minQty??i.minQuantity??0))).length;
      const pendingIns = (db.insuranceClaims||[]).filter(c=>c.status!=='received').reduce((s,c)=>s+(c.amount||0),0);
      const net = totalRev - totalExp;
      bot.sendMessage(chatId,
        `📋 *الملخص السريع — ${thisMonth}*\n\n` +
        `💰 الإيرادات: *${fmt(totalRev)} د.ك*\n` +
        `💸 المصاريف: ${fmt(totalExp)} د.ك\n` +
        `✅ الصافي: *${fmt(net)} د.ك*\n` +
        `🏥 التأمين: ${fmt(totalIns)} د.ك\n\n` +
        `⏳ عمولات معلقة: ${fmt(pendingComm)} د.ك\n` +
        `📋 مطالبات تأمين معلقة: ${fmt(pendingIns)} د.ك\n` +
        `📦 أصناف منخفضة: ${lowStock} صنف`,
        { parse_mode:'Markdown' }
      );
      return;
    }

    // Text commands
    if (text === '/start') {
      bot.sendMessage(chatId,
        '👋 *مرحباً بك في نظام بوبيان المحاسبي*\n\n' +
        '📊 *الإيرادات:*\n/income — إيرادات اليوم\n/stats — إحصائيات الشهر\n/summary — ملخص سريع\n\n' +
        '👨‍⚕️ *الدكاترة:*\n/comm — عمولات الدكاترة\n/pending — غير المدفوعة\n/doctors — تصنيف الدكاترة\n/goals — تقدم الأهداف\n\n' +
        '💸 *المصاريف:*\n📸 صوّر فاتورة — AI يقرأها تلقائياً\n/expense 50 مواد مختبر — إدخال يدوي\n/expenses — مصاريف الشهر\n\n' +
        '📦 *المخزون:*\n/stock — ملخص المخزون\n/lowstock — المنخفض فقط\n\n' +
        '🏥 *التأمين والموردون:*\n/insurance — حالة المطالبات\n/vendors — أرصدة الموردين\n\n' +
        '🤖 *الذكاء الاصطناعي:*\n/analyze — تحليل مالي ذكي\n/forecast — توقعات الشهر القادم\n\n' +
        '📂 ابعث Excel — يُحفَظ تلقائياً',
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text:'📊 إيرادات اليوم', callback_data:'quick_income' }, { text:'📋 ملخص الشهر', callback_data:'quick_summary' }],
            [{ text:'🏆 تصنيف الدكاترة', callback_data:'quick_doctors' }, { text:'🎯 الأهداف', callback_data:'quick_goals' }],
            [{ text:'📦 المخزون', callback_data:'quick_stock' }, { text:'⏳ عمولات معلقة', callback_data:'quick_pending' }],
            [{ text:'🤖 تحليل ذكي', callback_data:'quick_analyze' }]
          ]}
        }
      );
      return;
    }
    
    if (text === '/help') {
      bot.sendMessage(chatId,
        '📖 *قائمة الأوامر المتاحة*\n\n' +
        '/start — القائمة الرئيسية\n' +
        '/today — إيرادات اليوم\n' +
        '/income — تفصيل إيرادات اليوم\n' +
        '/stats — إحصائيات الشهر\n' +
        '/summary — ملخص سريع\n' +
        '/doctors — تصنيف الدكاترة\n' +
        '/goals — تقدم الأهداف\n' +
        '/stock — ملخص المخزون\n' +
        '/lowstock — المخزون المنخفض\n' +
        '/insurance — حالة التأمين\n' +
        '/vendors — أرصدة الموردين\n' +
        '/analyze — تحليل مالي بالذكاء الاصطناعي\n' +
        '/forecast — توقعات الشهر القادم\n' +
        '/report — تقرير شهري مختصر\n' +
        '/comm — عمولات الدكاترة\n' +
        '/pending — العمولات المعلقة\n' +
        '/expenses — مصاريف الشهر\n' +
        '/expense <مبلغ> <وصف> — إضافة مصروف',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/today') {
      const db = loadDB();
      const today = new Date().toISOString().split('T')[0];
      const dayData = (db.dailyData||[]).find(d => d.date === today);
      if (!dayData || !dayData.total) {
        bot.sendMessage(chatId, '📅 لا توجد إيرادات مسجلة لليوم ' + today);
        return;
      }
      const fmt = n => (parseFloat(n)||0).toFixed(3) + ' د.ك';
      bot.sendMessage(chatId,
        '📅 *إيرادات اليوم — ' + today + '*\n\n' +
        '💰 الإجمالي: ' + fmt(dayData.total) + '\n' +
        '🏥 التأمين: ' + fmt(dayData.insurance) + '\n' +
        (dayData.doctor ? '👨‍⚕️ الدكتور: ' + dayData.doctor + '\n' : '') +
        (dayData.notes ? '📝 ملاحظات: ' + dayData.notes : ''),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/report' || text.startsWith('/report ')) {
      const db = loadDB();
      const now = new Date();
      const targetMonth = text.split(' ')[1] || now.toISOString().substring(0,7);
      const daily = (db.dailyData||[]).filter(d => d.date.startsWith(targetMonth));
      if (!daily.length) { bot.sendMessage(chatId, '❌ لا توجد بيانات للفترة ' + targetMonth); return; }
      const totalRev = daily.reduce((s,d) => s+(parseFloat(d.total)||0), 0);
      const totalIns = daily.reduce((s,d) => s+(parseFloat(d.insurance)||0), 0);
      const expenses = (db.expenses||[]).filter(e => e.date && e.date.startsWith(targetMonth));
      const totalExp = expenses.reduce((s,e) => s+(parseFloat(e.amount)||0), 0);
      const net = totalRev - totalExp;
      const fmt = n => n.toFixed(3) + ' د.ك';
      const daysWorked = daily.filter(d=>d.total>0).length;
      bot.sendMessage(chatId,
        '📊 *التقرير الشهري — ' + targetMonth + '*\n\n' +
        '💰 إجمالي الإيرادات: ' + fmt(totalRev) + '\n' +
        '🏥 حصة التأمين: ' + fmt(totalIns) + '\n' +
        '💸 إجمالي المصاريف: ' + fmt(totalExp) + '\n' +
        '📈 صافي الربح: ' + fmt(net) + '\n' +
        '📅 أيام العمل: ' + daysWorked + '\n' +
        '📊 متوسط اليوم: ' + fmt(daysWorked > 0 ? totalRev/daysWorked : 0),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/stats' || text.startsWith('/stats ')) {
      const db = loadDB();
      const monthNames = {'01':'يناير','02':'فبراير','03':'مارس','04':'أبريل','05':'مايو','06':'يونيو','07':'يوليو','08':'أغسطس','09':'سبتمبر','10':'أكتوبر','11':'نوفمبر','12':'ديسمبر'};
      const allMonths = [...new Set(db.dailyData.map(d => d.date.substring(0,7)))].sort().reverse();
      if (!allMonths.length) { bot.sendMessage(chatId, '❌ لا توجد بيانات. ارفع ملف Excel أولاً.'); return; }
      const requestedMonth = text.split(' ')[1];
      const targetMonth = requestedMonth || allMonths[0];
      const daily = db.dailyData.filter(d => d.date.startsWith(targetMonth));
      const total = daily.reduce((s, d) => s + d.total, 0);
      const ins = daily.reduce((s, d) => s + d.insurance, 0);
      const insOrig = ins > 0 ? ins / 0.75 : 0;
      const insShare = insOrig * 0.25;
      const days = daily.filter(d => d.total > 0).length;
      const [y, m] = targetMonth.split('-');
      const monthLabel = (monthNames[m] || m) + ' ' + y;
      const otherMonths = allMonths.filter(mo => mo !== targetMonth).slice(0, 5);
      const otherStr = otherMonths.length ? '\n\n📅 *أشهر أخرى:*\n' + otherMonths.map(mo => {
        const [y2,m2] = mo.split('-'); return '• /stats ' + mo + ' — ' + (monthNames[m2]||m2) + ' ' + y2;
      }).join('\n') : '';
      bot.sendMessage(chatId,
        '📊 *إحصائيات ' + monthLabel + '*\n\n' +
        '💰 إجمالي الإيرادات: *' + total.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3}) + '* د.ك\n' +
        '🏥 حصة التأمين: ' + insShare.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3}) + ' د.ك\n' +
        '✅ صافي العيادة: *' + (total - insShare).toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3}) + '* د.ك\n' +
        '📅 أيام العمل: ' + days + ' يوم' + otherStr,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    if (text === '/comm') {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0, 7);
      const comms = db.commissionHistory.filter(c => c.month === thisMonth);
      
      if (!comms.length) { bot.sendMessage(chatId, 'لا توجد عمولات للشهر الحالي'); return; }
      
      let msg2 = `👨‍⚕️ *عمولات ${thisMonth}*\n\n`;
      for (const c of comms) {
        msg2 += `${c.doctor}\n`;
        msg2 += `  إيراد: ${c.revenue.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} | عمولة: ${c.commission.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك\n`;
        msg2 += `  ${c.paid ? '✅ مدفوع' : '⏳ غير مدفوع'}\n\n`;
      }
      bot.sendMessage(chatId, msg2, { parse_mode: 'Markdown' });
      return;
    }
    
    if (text === '/pending') {
      const db = loadDB();
      const pending = db.commissionHistory.filter(c => !c.paid);
      if (!pending.length) { bot.sendMessage(chatId, '✅ كل العمولات مدفوعة!'); return; }
      
      let msg3 = `⏳ *العمولات غير المدفوعة*\n\n`;
      const total = pending.reduce((s, c) => s + c.commission, 0);
      for (const c of pending) {
        msg3 += `• ${c.doctor} — ${c.month}: ${c.commission.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك\n`;
      }
      msg3 += `\n*الإجمالي: ${total.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك*`;
      bot.sendMessage(chatId, msg3, { parse_mode: 'Markdown' });
      return;
    }
    
    // /income — إيرادات اليوم
    if (text === '/income' || text === '/اليوم') {
      const db = loadDB();
      const today = new Date().toISOString().split('T')[0];
      const rec = (db.dailyData || []).find(d => d.date === today);
      if (!rec || !rec.total) {
        bot.sendMessage(chatId, `📅 *${today}*\n\nلم تُرفع بيانات اليوم بعد.\nأرسل ملف Excel أو استخدم /stats للأشهر السابقة.`, { parse_mode:'Markdown' });
        return;
      }
      const net = (rec.cash||0)+(rec.knet||0)+(rec.visa||0)+(rec.master||0)+(rec.link||0);
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      bot.sendMessage(chatId,
        `📅 *إيرادات ${today}*\n\n` +
        `💰 الإجمالي: *${fmt(rec.total)} د.ك*\n` +
        `  💵 كاش: ${fmt(rec.cash||0)} د.ك\n` +
        `  💳 K-Net: ${fmt(rec.knet||0)} د.ك\n` +
        `  💳 Visa: ${fmt(rec.visa||0)} د.ك\n` +
        `  🔗 Link: ${fmt(rec.link||0)} د.ك\n` +
        `  🏥 تأمين: ${fmt(rec.insurance||0)} د.ك\n` +
        `  ✅ صافي نقدي+شبكة: *${fmt(net)} د.ك*`,
        { parse_mode:'Markdown' }
      );
      return;
    }

    // /vendors — أرصدة الموردين
    if (text === '/vendors' || text === '/موردون') {
      const db = loadDB();
      const vendors = db.vendors || [];
      if (!vendors.length) { bot.sendMessage(chatId, '📭 لا يوجد موردون مسجّلون.'); return; }
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      const entries = db.journalEntries || [];
      let msg = `🏭 *أرصدة الموردين*\n\n`;
      let totalOwing = 0;
      vendors.forEach(v => {
        const vEntries = entries.filter(e => e.lines && e.lines.some(l => l.accountId === v.accountId));
        let balance = 0;
        vEntries.forEach(e => e.lines.forEach(l => { if(l.accountId===v.accountId){ balance += (l.credit||0)-(l.debit||0); }}));
        if (balance > 0) {
          msg += `• *${v.name}*: ${fmt(balance)} د.ك مستحق\n`;
          totalOwing += balance;
        }
      });
      if (totalOwing === 0) msg += '✅ لا توجد مستحقات للموردين حالياً.\n';
      else msg += `\n*الإجمالي المستحق: ${fmt(totalOwing)} د.ك*`;
      bot.sendMessage(chatId, msg, { parse_mode:'Markdown' });
      return;
    }

    // /insurance — حالة مطالبات التأمين
    if (text === '/insurance' || text === '/تأمين') {
      const db = loadDB();
      const claims = db.insuranceClaims || [];
      if (!claims.length) { bot.sendMessage(chatId, '🏥 لا توجد مطالبات تأمين مسجّلة.'); return; }
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      const pending   = claims.filter(c => c.status === 'pending');
      const submitted = claims.filter(c => c.status === 'submitted');
      const received  = claims.filter(c => c.status === 'received');
      const totalPending = pending.concat(submitted).reduce((s,c) => s+(c.amount||0), 0);
      const totalReceived = received.reduce((s,c) => s+(c.receivedAmount||c.amount||0), 0);
      bot.sendMessage(chatId,
        `🏥 *مطالبات التأمين*\n\n` +
        `⏳ معلقة: *${pending.length}* مطالبة — ${fmt(pending.reduce((s,c)=>s+(c.amount||0),0))} د.ك\n` +
        `📤 مقدّمة: *${submitted.length}* مطالبة — ${fmt(submitted.reduce((s,c)=>s+(c.amount||0),0))} د.ك\n` +
        `✅ مستلمة: *${received.length}* مطالبة — ${fmt(totalReceived)} د.ك\n\n` +
        `💰 إجمالي المعلق: *${fmt(totalPending)} د.ك*`,
        { parse_mode:'Markdown' }
      );
      return;
    }

    // /analyze — AI تحليل شامل
    if (text === '/analyze' || text === '/تحليل') {
      if (!process.env.ANTHROPIC_API_KEY) { bot.sendMessage(chatId, '❌ ANTHROPIC_API_KEY غير مضبوط.'); return; }
      bot.sendMessage(chatId, '🤖 جاري التحليل الذكي...');
      try {
        const db = loadDB();
        const now = new Date();
        const thisMonth = now.toISOString().substring(0,7);
        const lastMonth = new Date(now.getFullYear(), now.getMonth()-1).toISOString().substring(0,7);
        const daily = db.dailyData || [];
        const expenses = db.expenses || [];
        const tmRev = daily.filter(d=>d.date.startsWith(thisMonth)).reduce((s,d)=>s+(d.total||0),0);
        const lmRev = daily.filter(d=>d.date.startsWith(lastMonth)).reduce((s,d)=>s+(d.total||0),0);
        const tmExp = expenses.filter(e=>e.date?.startsWith(thisMonth)).reduce((s,e)=>s+(e.amount||0),0);
        const lmExp = expenses.filter(e=>e.date?.startsWith(lastMonth)).reduce((s,e)=>s+(e.amount||0),0);
        const pendingComm = (db.commissionHistory||[]).filter(c=>!c.paid).reduce((s,c)=>s+(c.commission||0),0);
        const lowStock = (db.invItems||[]).filter(i=>(parseFloat(i.qty??i.quantity??0))<=(parseFloat(i.minQty??i.minQuantity??0))).length;
        const pendingClaims = (db.insuranceClaims||[]).filter(c=>c.status!=='received').reduce((s,c)=>s+(c.amount||0),0);
        const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
        const context = `بيانات عيادة بوبيان:\n- إيرادات ${thisMonth}: ${fmt(tmRev)} د.ك\n- إيرادات ${lastMonth}: ${fmt(lmRev)} د.ك\n- نمو الإيرادات: ${lmRev?((tmRev-lmRev)/lmRev*100).toFixed(1)+'%':'لا يوجد'}\n- مصاريف ${thisMonth}: ${fmt(tmExp)} د.ك\n- مصاريف ${lastMonth}: ${fmt(lmExp)} د.ك\n- صافي الشهر الحالي: ${fmt(tmRev-tmExp)} د.ك\n- عمولات معلقة: ${fmt(pendingComm)} د.ك\n- مطالبات تأمين معلقة: ${fmt(pendingClaims)} د.ك\n- أصناف مخزون منخفضة: ${lowStock}`;
        const analysis = await callAI({
          model: 'claude-haiku-4-5-20251001', max_tokens: 600,
          system: 'أنت محلل مالي خبير لعيادة أسنان. قدّم تحليلاً موجزاً وذكياً باللغة العربية في 5-7 نقاط. استخدم إيموجي. ركّز على النقاط المهمة والتوصيات.',
          messages: [{ role: 'user', content: `حلّل هذه البيانات وأعطني أهم الملاحظات والتوصيات:\n${context}` }],
        }) || 'لم أستطع التحليل';
        bot.sendMessage(chatId, `🤖 *التحليل الذكي — ${thisMonth}*\n\n${analysis}`, { parse_mode:'Markdown' });
      } catch(e) {
        bot.sendMessage(chatId, '❌ خطأ في التحليل: ' + e.message);
      }
      return;
    }

    // /forecast — AI توقع الشهر القادم
    if (text === '/forecast' || text === '/توقع') {
      if (!process.env.ANTHROPIC_API_KEY) { bot.sendMessage(chatId, '❌ ANTHROPIC_API_KEY غير مضبوط.'); return; }
      bot.sendMessage(chatId, '📈 جاري حساب التوقعات...');
      try {
        const db = loadDB();
        const daily = db.dailyData || [];
        const revByMonth = {};
        daily.forEach(d => {
          const m = d.date?.substring(0,7);
          if (m) revByMonth[m] = (revByMonth[m]||0) + (d.total||0);
        });
        const months = Object.entries(revByMonth).sort((a,b)=>a[0].localeCompare(b[0])).slice(-6);
        if (months.length < 2) { bot.sendMessage(chatId, '⚠️ البيانات غير كافية للتوقع. تحتاج على الأقل شهرين.'); return; }
        const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
        const history = months.map(([m,v])=>`${m}: ${fmt(v)} د.ك`).join('\n');
        const forecast = await callAI({
          model: 'claude-haiku-4-5-20251001', max_tokens: 400,
          system: 'أنت محلل مالي. بناء على بيانات الإيرادات الشهرية، توقّع الشهر القادم. أجب باختصار بالعربية مع الرقم المتوقع والأسباب.',
          messages: [{ role: 'user', content: `إيرادات الأشهر الماضية:\n${history}\n\nتوقّع الشهر القادم مع تبرير.` }],
        }) || 'لم أستطع التوقع';
        bot.sendMessage(chatId, `📈 *توقعات الشهر القادم*\n\n${forecast}`, { parse_mode:'Markdown' });
      } catch(e) {
        bot.sendMessage(chatId, '❌ خطأ: ' + e.message);
      }
      return;
    }

    // AI answer using Anthropic
    try {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0, 7);
      const daily = db.dailyData.filter(d => d.date.startsWith(thisMonth));
      const total = daily.reduce((s, d) => s + d.total, 0);
      const ins = daily.reduce((s, d) => s + d.insurance, 0);
      const comms = db.commissionHistory.filter(c => c.month === thisMonth);
      
      const context = `بيانات عيادة بوبيان لطب الأسنان - ${thisMonth}:
إجمالي الإيرادات: ${total.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك
التأمين المسجّل: ${ins.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك
أيام العمل: ${daily.filter(d=>d.total>0).length}
العمولات: ${comms.map(c=>`${c.doctor}: ${c.commission.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك (${c.paid?'مدفوع':'غير مدفوع'})`).join(', ')}`;

      const answer = await callAI({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: `أنت مساعد محاسبي لعيادة بوبيان. ${context}. أجب باختصار بالعربي.`,
        messages: [{ role: 'user', content: text }],
      }) || 'ما قدرت أجاوب';
      bot.sendMessage(chatId, answer);
    } catch(e) {
      bot.sendMessage(chatId, 'اكتب /stats أو /comm أو /pending للحصول على المعلومات');
    }
  });

  // ===== CALLBACK QUERIES (inline keyboard buttons) =====
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;
    const esc    = s => String(s||'').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

    const catMap = {'مواد مختبر':'5210','رواتب':'5100','إيجار':'5510','كهرباء':'5520','كهرباء/ماء':'5520','صيانة':'5540','تسويق':'5610','إقامة':'5720','تأشيرات':'5170','تأمين':'5740','هاتف':'5530','أخرى':'5670'};
    const payMethods = {
      pay_cash:   { code:'1100', name:'الصندوق — نقدي',              label:'💵 كاش' },
      pay_knet:   { code:'1120', name:'K-Net / Visa / Master',       label:'📳 K-Net' },
      pay_link:   { code:'1120', name:'K-Net / Visa / Master',       label:'🔗 Link' },
      pay_cheque: { code:'1110', name:'البنك — الحساب الجاري',       label:'🧾 شيك' },
    };

    // Quick-menu shortcuts from /start inline keyboard
    const quickHandlers = {
      quick_income:  '/income',
      quick_summary: '/summary',
      quick_doctors: '/doctors',
      quick_goals:   '/goals',
      quick_stock:   '/stock',
      quick_pending: '/pending',
      quick_analyze: '/analyze',
    };
    if (quickHandlers[data]) {
      bot.answerCallbackQuery(query.id);
      // Re-emit as if the user typed the command
      bot.emit('message', { ...query.message, text: quickHandlers[data], chat: query.message.chat, from: query.from });
      return;
    }

    // Step 1: user confirmed invoice data → ask payment method
    if (data === 'inv_confirm_data') {
      const db = loadDB();
      const pending = db.pendingInvoices?.[chatId];
      if (!pending) { bot.answerCallbackQuery(query.id, { text: 'انتهت الجلسة، أعد إرسال الفاتورة' }); return; }
      pending.step = 'choose_payment';
      saveDB(db);
      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId, '💳 كيف تم الدفع؟', { reply_markup: { inline_keyboard: [
        [{ text:'💵 كاش', callback_data:'pay_cash' }, { text:'📳 K-Net', callback_data:'pay_knet' }],
        [{ text:'🔗 Link', callback_data:'pay_link' }, { text:'🧾 شيك', callback_data:'pay_cheque' }],
        [{ text:'🤝 على الآجل (ذمم دائنة)', callback_data:'pay_credit' }],
        [{ text:'❌ إلغاء', callback_data:'inv_cancel' }]
      ]}});
      return;
    }

    // Step 2: payment method chosen → build journal entry → ask confirmation
    if (['pay_cash','pay_knet','pay_link','pay_cheque','pay_credit'].includes(data)) {
      const db = loadDB();
      const pending = db.pendingInvoices?.[chatId];
      if (!pending?.invoice) { bot.answerCallbackQuery(query.id, { text: 'انتهت الجلسة' }); return; }

      const invoice  = pending.invoice;
      const amount   = parseFloat(invoice.amount) || 0;
      const date     = invoice.date || new Date().toISOString().split('T')[0];
      const desc     = invoice.description || invoice.vendor || 'فاتورة';
      const accounts = db.chartOfAccounts || [];

      // Expense account
      const expCode = catMap[invoice.category || 'أخرى'] || '5670';
      const expAcc  = accounts.find(a => a.code === expCode) || { id: expCode, code: expCode, name: invoice.category || 'مصاريف متنوعة' };

      // Credit account
      let creditAcc, payLabel, vendorWarning = '';
      if (data === 'pay_credit') {
        const vendorName = (invoice.vendor || '').toLowerCase();
        const vendorAcc  = vendorName ? accounts.find(a => a.type === 'liability' && a.name.toLowerCase().includes(vendorName)) : null;
        if (vendorAcc) {
          creditAcc = vendorAcc;
          payLabel  = '🤝 على الآجل — ' + vendorAcc.name;
        } else {
          creditAcc    = accounts.find(a => a.code === '2100') || { id:'2100', code:'2100', name:'ذمم دائنة — موردون' };
          payLabel     = '🤝 على الآجل';
          vendorWarning = invoice.vendor
            ? `\n⚠️ المورد "${invoice.vendor}" غير موجود في شجرة الحسابات — تم استخدام "ذمم دائنة — موردون (2100)". أضفه من الموقع إن أردت.`
            : '';
        }
      } else {
        const pm  = payMethods[data];
        creditAcc = accounts.find(a => a.code === pm.code) || { id: pm.code, code: pm.code, name: pm.name };
        payLabel  = pm.label;
      }

      const jeId = 'JE-TG-' + Date.now();
      const je   = {
        id: jeId, date, desc, ref: 'TG-INV', type: 'ai',
        totalDebit: amount, totalCredit: amount, createdAt: new Date().toISOString(),
        lines: [
          { accountId: expAcc.id,    accountCode: expAcc.code,    accountName: expAcc.name,    debit: amount, credit: 0 },
          { accountId: creditAcc.id, accountCode: creditAcc.code, accountName: creditAcc.name, debit: 0,      credit: amount }
        ]
      };

      pending.step = 'confirm_journal';
      pending.payLabel = payLabel;
      pending.journalEntry = je;
      saveDB(db);

      bot.answerCallbackQuery(query.id);
      if (vendorWarning) bot.sendMessage(chatId, vendorWarning);
      bot.sendMessage(chatId,
        '📝 *القيد المحاسبي المقترح:*\n\n' +
        '📅 ' + esc(date) + ' — ' + esc(desc) + '\n' +
        '💳 ' + esc(payLabel) + '\n\n' +
        '  مدين:  ' + esc(expAcc.code) + ' — ' + esc(expAcc.name) + '\n' +
        '         ' + esc(amount.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})) + ' د.ك\n\n' +
        '  دائن:  ' + esc(creditAcc.code) + ' — ' + esc(creditAcc.name) + '\n' +
        '         ' + esc(amount.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})) + ' د.ك\n\n' +
        'راجع القيد — إذا مزبوط اضغط ترحيل:',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '✅ ترحيل وحفظ', callback_data: 'inv_save' },
          { text: '❌ إلغاء', callback_data: 'inv_cancel' }
        ]]}}
      );
      return;
    }

    // Step 3: save everything
    if (data === 'inv_save') {
      const db = loadDB();
      const pending = db.pendingInvoices?.[chatId];
      if (!pending?.journalEntry) { bot.answerCallbackQuery(query.id, { text: 'انتهت الجلسة' }); return; }

      const je      = pending.journalEntry;
      const invoice = pending.invoice;
      const amount  = parseFloat(invoice.amount) || 0;
      const date    = invoice.date || new Date().toISOString().split('T')[0];
      const desc    = invoice.description || invoice.vendor || 'فاتورة';

      if (!db.expenses)      db.expenses      = [];

      // P0.2 — AI/OCR-suggested entries get the exact same accounting
      // validation as a manually-typed one before they're ever persisted.
      try {
        appendJournalEntry(db, je);
      } catch (e) {
        if (!(e instanceof JournalValidationError)) throw e;
        bot.answerCallbackQuery(query.id, { text: 'تعذّر الترحيل' });
        bot.sendMessage(chatId, `❌ تعذّر ترحيل القيد: ${e.message}\nراجع الفاتورة يدوياً من الموقع.`);
        return;
      }
      db.expenses.push({ id: genId('exp-'), desc, cat: invoice.category || 'أخرى', amount, date, vendor: invoice.vendor || '', source: 'telegram_photo', journalId: je.id });
      db.journalEntries.sort((a,b) => b.date.localeCompare(a.date));
      delete db.pendingInvoices[chatId];
      saveDB(db);

      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId,
        '✅ *تم الترحيل والحفظ!*\n\n' +
        '💸 ' + desc + ' — ' + amount.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3}) + ' د.ك\n' +
        '💳 ' + (pending.payLabel || '') + '\n\n' +
        'القيد موجود في القيود اليومية على الموقع 🌐',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Cancel
    if (data === 'inv_cancel') {
      const db = loadDB();
      if (db.pendingInvoices) delete db.pendingInvoices[chatId];
      saveDB(db);
      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId, '❌ تم إلغاء الفاتورة.');
      return;
    }

    // Voice-to-Journal: save confirmed JE
    if (data === 'voice_je_confirm') {
      const db      = loadDB();
      const pending = db.pendingVoiceJE?.[chatId];
      if (!pending) { bot.answerCallbackQuery(query.id, { text: 'انتهت الجلسة' }); return; }
      const result  = pending.result;
      const lines   = (result.lines || []).map(l => ({
        accountId:   l.accountCode,
        accountCode: l.accountCode,
        accountName: l.accountName,
        debit:  parseFloat(l.debit)  || 0,
        credit: parseFloat(l.credit) || 0,
      }));
      const totalDebit  = parseFloat(lines.reduce((s, l) => s + l.debit,  0).toFixed(3));
      const totalCredit = parseFloat(lines.reduce((s, l) => s + l.credit, 0).toFixed(3));
      const je = {
        id: 'JE-VOICE-' + Date.now(),
        date: result.date || new Date().toISOString().slice(0, 10),
        desc: result.description || 'قيد صوتي',
        ref: 'VOICE-TG',
        type: 'voice_entry',
        source: 'telegram_voice',
        transcription: result.transcription || '',
        confidence: result.confidence || 0,
        totalDebit, totalCredit,
        lines,
        createdAt: new Date().toISOString(),
      };
      // P0.2 — the transcribed/AI-suggested entry still has to pass the same
      // balance/account-existence/period-lock rules as a manual entry.
      try {
        appendJournalEntry(db, je);
      } catch (e) {
        if (!(e instanceof JournalValidationError)) throw e;
        bot.answerCallbackQuery(query.id, { text: 'تعذّر الترحيل' });
        bot.sendMessage(chatId, `❌ تعذّر ترحيل القيد الصوتي: ${e.message}`);
        return;
      }
      delete db.pendingVoiceJE[chatId];
      saveDB(db);
      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId, `✅ تم حفظ القيد الصوتي!\n📋 ${je.desc}\n💰 ${totalDebit.toFixed(3)} د.ك\n🆔 ${je.id}`);
      return;
    }

    if (data === 'voice_je_cancel') {
      const db = loadDB();
      if (db.pendingVoiceJE) delete db.pendingVoiceJE[chatId];
      saveDB(db);
      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId, '❌ تم إلغاء القيد الصوتي.');
      return;
    }

    bot.answerCallbackQuery(query.id);
  });

  // Voice / audio → AI inventory query
  bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '🎙️ جاري معالجة رسالتك الصوتية...');
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const fileLink  = await bot.getFileLink(msg.voice.file_id);
      const https     = require('https');
      const http      = require('http');
      const client2   = fileLink.startsWith('https') ? https : http;
      const chunks    = [];
      await new Promise((resolve, reject) => {
        client2.get(fileLink, res => {
          res.on('data', d => chunks.push(d));
          res.on('end', resolve);
        }).on('error', reject);
      });
      const audioBase64 = Buffer.concat(chunks).toString('base64');

      const db    = loadDB();
      const items = db.invItems || [];
      const stockSummary = items.map(i => `${i.nameAr} [${i.code}]: ${i.qty} ${i.unit} @ ${i.cost.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} KD`).join('\n');

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `أنت مساعد مخزون لعيادة أسنان. بيانات المخزون الحالية:\n${stockSummary || 'لا توجد أصناف'}\n\nأجب على سؤال المستخدم الصوتي بشكل موجز باللغة العربية.` },
            { type: 'document', source: { type: 'base64', media_type: 'audio/ogg', data: audioBase64 } }
          ]
        }]
      });
      bot.sendMessage(chatId, response.content[0].text, { parse_mode: 'Markdown' });
    } catch(e) {
      // Fallback: treat as text query if audio not supported
      bot.sendMessage(chatId, '❌ لم أتمكن من معالجة الصوت. استخدم /stock أو /item [اسم الصنف]');
    }
  });
}

// Auto-start bot if token saved (token stored as base64) — called after initDB()
function autoStartBot() {
  const db = loadDB();
  if (!db.telegramToken) return;
  try {
    const decoded = Buffer.from(db.telegramToken, 'base64').toString('utf8').trim().replace(/[\s\n\r]/g, '');
    if (decoded && /^\d+:[A-Za-z0-9_-]+$/.test(decoded)) {
      bot = new TelegramBot(decoded, { polling: { params: { timeout: 10 } } });
      // P0.5: also (re)opens the bounded auto-registration window on every
      // restart — if the operator saved a token but a restart happened
      // before anyone ever messaged the bot, first-time setup must still be
      // completable, not permanently locked out.
      _tgBotStartedAt = Date.now();
      setupBot(bot);
      console.log('✅ Telegram bot started automatically');
    } else {
      console.log('⚠️  Telegram token format invalid, skipping bot start');
    }
  } catch(e) {
    console.log('⚠️  Telegram token invalid, skipping bot start');
  }
}

// ===== EXPORT: EXCEL =====
app.get('/api/export/excel', requireAuth, requirePermission('reports', 'export'), (req, res) => {
  const db = loadDB();
  const { type = 'income', from, to } = req.query;
  const wb = XLSX.utils.book_new();

  const filterDate = arr => arr.filter(r => {
    const d = r.date || '';
    return (!from || d >= from) && (!to || d <= to);
  });

  const headerStyle = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0a1628' } }, alignment: { horizontal: 'center' } };

  if (type === 'income') {
    const data = filterDate(db.dailyData || []);
    const rows = [
      ['التاريخ', 'كاش', 'K-Net', 'Visa', 'Mastercard', 'تأمين', 'Link', 'الإجمالي'],
      ...data.map(d => [d.date, d.cash||0, d.knet||0, d.visa||0, d.master||0, d.insurance||0, d.link||0, d.total||0]),
      ['الإجمالي',
        data.reduce((s,d)=>s+(d.cash||0),0),
        data.reduce((s,d)=>s+(d.knet||0),0),
        data.reduce((s,d)=>s+(d.visa||0),0),
        data.reduce((s,d)=>s+(d.master||0),0),
        data.reduce((s,d)=>s+(d.insurance||0),0),
        data.reduce((s,d)=>s+(d.link||0),0),
        data.reduce((s,d)=>s+(d.total||0),0),
      ]
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [14,12,12,12,12,12,12,14].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'الإيرادات اليومية');

  } else if (type === 'expenses') {
    const data = filterDate(db.expenses || []);
    const rows = [
      ['التاريخ', 'البيان', 'الفئة', 'المبلغ (د.ك)'],
      ...data.map(e => [e.date, e.desc, e.cat, e.amount||0]),
      ['الإجمالي', '', '', data.reduce((s,e)=>s+(e.amount||0),0)]
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [14,30,16,14].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'المصاريف');

  } else if (type === 'financials') {
    const journals = filterDate(db.journalEntries || []);
    const coa = db.chartOfAccounts || [];
    const acName = {};
    coa.forEach(a => { acName[a.code] = a.name; });

    const bal = {};
    journals.forEach(je => {
      (je.lines||[]).forEach(l => {
        const key = l.accountCode || l.accountId || l.account || 'unknown';
        if (!bal[key]) bal[key] = { name: acName[key]||l.accountName||key, dr:0, cr:0 };
        bal[key].dr += parseFloat(l.debit)||0;
        bal[key].cr += parseFloat(l.credit)||0;
      });
    });

    // Income Statement sheet
    const incRows = [['الحساب', 'الكود', 'الإيرادات (د.ك)', 'المصاريف (د.ك)', 'الرصيد (د.ك)']];
    let totRev = 0, totExp = 0;
    Object.entries(bal).forEach(([code, b]) => {
      const n = parseInt(code);
      if (n >= 4000 && n < 5000) { const net = b.cr-b.dr; totRev+=net; incRows.push([b.name, code, net, '', net]); }
      if (n >= 5000 && n < 6000) { const net = b.dr-b.cr; totExp+=net; incRows.push([b.name, code, '', net, -net]); }
    });
    incRows.push(['', '', '', '', '']);
    incRows.push(['إجمالي الإيرادات', '', totRev, '', '']);
    incRows.push(['إجمالي المصاريف', '', '', totExp, '']);
    incRows.push([totRev-totExp >= 0 ? 'صافي الربح' : 'صافي الخسارة', '', '', '', totRev-totExp]);
    const wsInc = XLSX.utils.aoa_to_sheet(incRows);
    wsInc['!cols'] = [28,10,16,16,16].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsInc, 'قائمة الدخل');

    // Balance Sheet sheet
    const bsRows = [['البند', 'الكود', 'المبلغ (د.ك)']];
    bsRows.push(['═══ الأصول ═══', '', '']);
    let totAss = 0;
    Object.entries(bal).forEach(([code, b]) => {
      if (parseInt(code)>=1000 && parseInt(code)<2000) { const net=b.dr-b.cr; totAss+=net; bsRows.push([b.name, code, net]); }
    });
    bsRows.push(['إجمالي الأصول', '', totAss]);
    bsRows.push(['', '', '']);
    bsRows.push(['═══ الخصوم ═══', '', '']);
    let totLiab = 0;
    Object.entries(bal).forEach(([code, b]) => {
      if (parseInt(code)>=2000 && parseInt(code)<3000) { const net=b.cr-b.dr; totLiab+=net; bsRows.push([b.name, code, net]); }
    });
    bsRows.push(['إجمالي الخصوم', '', totLiab]);
    bsRows.push(['صافي الدخل (مرحّل)', '', totRev-totExp]);
    bsRows.push(['إجمالي الخصوم + حقوق الملكية', '', totLiab+(totRev-totExp)]);
    const wsBs = XLSX.utils.aoa_to_sheet(bsRows);
    wsBs['!cols'] = [30,10,16].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsBs, 'الميزانية العمومية');

  } else if (type === 'journal') {
    const data = filterDate(db.journalEntries || []);
    const rows = [['التاريخ', 'رقم القيد', 'البيان', 'الحساب', 'مدين (د.ك)', 'دائن (د.ك)', 'النوع']];
    data.forEach(je => {
      (je.lines||[]).forEach((l,i) => {
        rows.push([i===0?je.date:'', i===0?je.id:'', i===0?je.desc:'', l.accountName||l.account, l.debit||0, l.credit||0, i===0?je.type:'']);
      });
      rows.push(['','','','','','','']);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [12,18,24,20,14,14,12].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'القيود اليومية');

  } else if (type === 'trial-balance') {
    // ميزان المراجعة — من القيود مباشرة (CLAUDE.md مرحلة 5: تصدير لكل تقرير)
    const journals = filterDate(db.journalEntries || []);
    const coa = db.chartOfAccounts || [];
    const acName = {}; coa.forEach(a => { acName[String(a.code)] = a.name; });
    const bal = {};
    journals.forEach(je => (je.lines||[]).forEach(l => {
      const key = String(l.accountCode || l.accountId || l.account || '');
      if (!key) return;
      if (!bal[key]) bal[key] = { dr:0, cr:0 };
      bal[key].dr += parseFloat(l.debit)||0; bal[key].cr += parseFloat(l.credit)||0;
    }));
    const rows = [['الكود','الحساب','مدين (د.ك)','دائن (د.ك)','الرصيد']];
    let tDr=0, tCr=0;
    Object.keys(bal).sort().forEach(code => {
      const b=bal[code]; tDr+=b.dr; tCr+=b.cr;
      rows.push([code, acName[code]||code, +b.dr.toFixed(3), +b.cr.toFixed(3), +(b.dr-b.cr).toFixed(3)]);
    });
    rows.push(['','الإجمالي', +tDr.toFixed(3), +tCr.toFixed(3), +(tDr-tCr).toFixed(3)]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [10,30,16,16,16].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'ميزان المراجعة');

  } else if (type === 'coa') {
    const coa = db.chartOfAccounts || [];
    const tl = {asset:'أصول',liability:'التزامات',equity:'حقوق ملكية',revenue:'إيرادات',expense:'مصاريف'};
    const rows = [['الكود','اسم الحساب','النوع','الحساب الأب','مجمّع','الحالة'],
      ...[...coa].sort((a,b)=>String(a.code).localeCompare(String(b.code)))
        .map(a=>[a.code, a.name, tl[a.type]||a.type, a.parent||'—', a.isGroup?'نعم':'لا', a.status==='inactive'?'موقوف':'فعّال'])];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [10,32,14,12,8,10].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'شجرة الحسابات');

  } else if (type === 'vendors') {
    const vendors = db.vendors || [];
    const balOf = (aid) => (db.journalEntries||[]).reduce((s,e)=>s+(e.lines||[]).reduce((x,l)=>
      (String(l.accountId)===String(aid)||String(l.accountCode)===String(aid))?x+(parseFloat(l.credit)||0)-(parseFloat(l.debit)||0):x,0),0);
    const rows = [['المورد','النوع','الهاتف','شروط الدفع','الرصيد المستحق (د.ك)'],
      ...vendors.map(v=>[v.name, v.type||'—', v.phone||'—', v.terms||'—', +balOf(v.accountId).toFixed(3)])];
    rows.push(['الإجمالي','','','', +vendors.reduce((s,v)=>s+balOf(v.accountId),0).toFixed(3)]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [26,14,14,12,18].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'الموردون');

  } else if (type === 'payroll') {
    const recs = db.payroll || [];
    const rows = [['الشهر','الموظف','الدور','أساسي','بدلات','خصومات','الصافي','الحالة']];
    recs.forEach(r => (r.entries||[]).forEach((e,i)=>rows.push([
      i===0?r.month:'', e.name, e.role||'—', e.basicSalary||0, e.allowances||0, e.deductions||0, e.netSalary||0, i===0?(r.status==='paid'?'مدفوع':'معلق'):''])));
    rows.push(['الإجمالي','','', '', '', '', +recs.reduce((s,r)=>s+(r.totalNet||0),0).toFixed(3), '']);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [10,22,12,10,10,10,12,10].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'الرواتب');
  }

  const fileName = `boubyan-${type}-${new Date().toISOString().substring(0,10)}.xlsx`;
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ===== EXPORT: PPTX =====
app.get('/api/export/pptx', requireAuth, requirePermission('reports', 'export'), (req, res) => {
  const db = loadDB();
  const { from, to } = req.query;

  // Try to use pptxgenjs if installed, else return JSON for client-side generation
  let PptxGenJS;
  try { PptxGenJS = require('pptxgenjs'); } catch(e) { PptxGenJS = null; }

  const filterDate = arr => arr.filter(r => {
    const d = r.date || '';
    return (!from || d >= from) && (!to || d <= to);
  });

  const daily = filterDate(db.dailyData || []);
  const expenses = filterDate(db.expenses || []);
  const journals = filterDate(db.journalEntries || []);

  const totRev   = daily.reduce((s,d)=>s+(d.total||0),0);
  const totExp   = expenses.reduce((s,e)=>s+(e.amount||0),0);
  const netInc   = totRev - totExp;
  const totCash  = daily.reduce((s,d)=>s+(d.cash||0),0);
  const totKnet  = daily.reduce((s,d)=>s+(d.knet||0),0);
  const totVisa  = daily.reduce((s,d)=>s+(d.visa||0),0);
  const totIns   = daily.reduce((s,d)=>s+(d.insurance||0),0);

  // By month
  const byMonth = {};
  daily.forEach(d => {
    const m = (d.date||'').substring(0,7);
    if (!byMonth[m]) byMonth[m] = 0;
    byMonth[m] += d.total||0;
  });

  if (!PptxGenJS) {
    // Return data for client-side use
    return res.json({ totRev, totExp, netInc, totCash, totKnet, totVisa, totIns, byMonth,
      workDays: daily.filter(d=>d.total>0).length, period: from ? `${from} → ${to||'الآن'}` : 'كل الفترات' });
  }

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = 'بوبيان للمحاسبة — تقرير دوري';

  const NAVY='0a1628', CYAN='00d4ff', GREEN='00ff9d', ORANGE='ff6b35', WHITE='FFFFFF', GRAY='94a3b8';
  const fmt = n => (+n).toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});

  // Slide 1: Title
  const s1 = pptx.addSlide();
  s1.background = { color: NAVY };
  s1.addShape(pptx.ShapeType.rect, { x:0, y:2.5, w:10, h:0.05, fill:{color:CYAN} });
  s1.addText('بوبيان لطب الأسنان', { x:0.5, y:0.8, w:9, h:1, fontSize:40, bold:true, color:WHITE, align:'center', fontFace:'Arial' });
  s1.addText('التقرير المالي الدوري', { x:0.5, y:1.8, w:9, h:0.6, fontSize:22, color:CYAN, align:'center', fontFace:'Arial' });
  s1.addText(from ? `الفترة: ${from} → ${to||'الآن'}` : 'كل الفترات', { x:0.5, y:2.8, w:9, h:0.5, fontSize:14, color:GRAY, align:'center', fontFace:'Arial' });

  // Slide 2: KPIs
  const s2 = pptx.addSlide();
  s2.background = { color: NAVY };
  s2.addText('المؤشرات الرئيسية', { x:0.3, y:0.2, w:9.4, h:0.6, fontSize:24, bold:true, color:WHITE, fontFace:'Arial' });
  const kpis = [
    { label:'إجمالي الإيرادات', val:fmt(totRev)+' د.ك', color:CYAN,  x:0.3 },
    { label:'إجمالي المصاريف',  val:fmt(totExp)+' د.ك', color:ORANGE, x:2.65 },
    { label:'صافي الربح',       val:fmt(netInc)+' د.ك', color:GREEN,  x:5.0 },
    { label:'أيام العمل',       val:String(daily.filter(d=>d.total>0).length)+' يوم', color:'fbbf24', x:7.35 },
  ];
  kpis.forEach(k => {
    s2.addShape(pptx.ShapeType.roundRect, { x:k.x, y:0.9, w:2.25, h:1.6, fill:{color:'111827'}, line:{color:k.color,pt:1}, rectRadius:0.1 });
    s2.addText(k.val,   { x:k.x, y:1.1, w:2.25, h:0.7, fontSize:16, bold:true, color:k.color, align:'center', fontFace:'IBM Plex Mono' });
    s2.addText(k.label, { x:k.x, y:1.9, w:2.25, h:0.4, fontSize:10, color:GRAY, align:'center', fontFace:'Arial' });
  });

  // Slide 3: Payment breakdown
  const s3 = pptx.addSlide();
  s3.background = { color: NAVY };
  s3.addText('توزيع طرق الدفع', { x:0.3, y:0.2, w:9.4, h:0.6, fontSize:24, bold:true, color:WHITE, fontFace:'Arial' });
  const pays = [ ['كاش',totCash,CYAN], ['K-Net',totKnet,GREEN], ['Visa',totVisa,ORANGE], ['تأمين',totIns,'f87171'] ];
  pays.forEach(([label,val,color],i) => {
    const pct = totRev > 0 ? (val/totRev*100).toFixed(1)+'%' : '0%';
    s3.addShape(pptx.ShapeType.roundRect, { x:0.3+i*2.4, y:0.9, w:2.2, h:2.0, fill:{color:'111827'}, line:{color,pt:1}, rectRadius:0.1 });
    s3.addText(pct,        { x:0.3+i*2.4, y:1.0, w:2.2, h:0.7, fontSize:28, bold:true, color, align:'center', fontFace:'IBM Plex Mono' });
    s3.addText(fmt(val)+' د.ك', { x:0.3+i*2.4, y:1.8, w:2.2, h:0.35, fontSize:11, color:WHITE, align:'center', fontFace:'Arial' });
    s3.addText(label,      { x:0.3+i*2.4, y:2.2, w:2.2, h:0.4, fontSize:12, color:GRAY, align:'center', fontFace:'Arial' });
  });

  // Slide 4: Monthly trend table
  const months = Object.keys(byMonth).sort();
  if (months.length > 0) {
    const s4 = pptx.addSlide();
    s4.background = { color: NAVY };
    s4.addText('الإيرادات الشهرية', { x:0.3, y:0.2, w:9.4, h:0.6, fontSize:24, bold:true, color:WHITE, fontFace:'Arial' });
    const tableRows = [
      [{ text:'الشهر',fontSize:11,bold:true,color:WHITE,fill:{color:'111827'} }, { text:'الإيراد (د.ك)',fontSize:11,bold:true,color:WHITE,fill:{color:'111827'} }],
      ...months.map(m => [{ text:m,fontSize:10,color:GRAY }, { text:fmt(byMonth[m]),fontSize:10,color:CYAN }])
    ];
    s4.addTable(tableRows, { x:1.5, y:0.9, w:7, colW:[4,3], border:{color:'1e2d45',pt:0.5} });
  }

  // Slide 5: Closing
  const s5 = pptx.addSlide();
  s5.background = { color: NAVY };
  s5.addShape(pptx.ShapeType.rect, { x:0, y:2.5, w:10, h:0.05, fill:{color:CYAN} });
  s5.addText('شكراً', { x:0.5, y:1.2, w:9, h:1, fontSize:48, bold:true, color:WHITE, align:'center', fontFace:'Arial' });
  s5.addText('بوبيان لطب الأسنان — نظام المحاسبة الذكي', { x:0.5, y:2.8, w:9, h:0.5, fontSize:13, color:GRAY, align:'center', fontFace:'Arial' });

  const fileName = `boubyan-report-${new Date().toISOString().substring(0,10)}.pptx`;
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  pptx.write('nodebuffer').then(buf => res.send(buf)).catch(e => res.status(500).json({ error: e.message }));
});

// ===== SCHEDULED REPORTS =====
// API to get/set schedule config
app.get('/api/schedule', requirePermission('settings', 'view'), (req, res) => {
  const db = loadDB();
  res.json(db.scheduleConfig || { weeklyReport: true, weeklyDay: 0, monthlyReport: true });
});

app.post('/api/schedule', requirePermission('settings', 'edit'), (req, res) => {
  const db = loadDB();
  db.scheduleConfig = { ...db.scheduleConfig, ...req.body };
  saveDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
// AUTOMATION ENGINE — runs every hour
// ═══════════════════════════════════════════════════
function getAutoCfg() {
  const cfg = loadConfig();
  return cfg.automation || {};
}

function tgSend(msg, opts) {
  const db = loadDB();
  const chatId = (db.scheduleConfig||{}).chatId || process.env.TG_CHAT_ID;
  if (!global._tgBot || !chatId) return;
  global._tgBot.sendMessage(chatId, msg, opts||{}).catch(()=>{});
}

const fmt3 = n => Number(n||0).toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});

function runScheduledTasks() {
  if (!global._tgBot) return;
  const db  = loadDB();
  const aut = getAutoCfg();
  const cfg = db.scheduleConfig || {};
  const now = new Date();
  const hour    = now.getHours();
  const day     = now.getDay();
  const date    = now.getDate();
  const todayStr = now.toISOString().substring(0,10);
  const thisMonth = todayStr.substring(0,7);

  // ── 1. ملخص يومي (كل مساء — الساعة القابلة للتخصيص)
  const dailyHour = Number(aut.dailySummary?.hour ?? 20);
  // Opt-in: user explicitly disabled clinic accounting reports (2026-07-03)
  if (aut.dailySummary?.enabled === true && hour === dailyHour) {
    const lastKey = 'lastDailySummary';
    if (cfg[lastKey] !== todayStr) {
      const dayRec = (db.dailyData||[]).find(d => d.date === todayStr);
      const yestStr = new Date(now-864e5).toISOString().substring(0,10);
      const yestRec = (db.dailyData||[]).find(d => d.date === yestStr);
      const todayRev = dayRec?.total || 0;
      const yestRev  = yestRec?.total || 0;
      const todayExp = (db.expenses||[]).filter(e=>e.date===todayStr).reduce((s,e)=>s+(e.amount||0),0);
      const diff = todayRev - yestRev;
      const arrow = diff > 0 ? '📈' : diff < 0 ? '📉' : '➡️';
      tgSend(
        `🌙 *ملخص ${todayStr}*\n\n` +
        `💰 الإيرادات: *${fmt3(todayRev)} د.ك* ${arrow}\n` +
        `💸 المصاريف: ${fmt3(todayExp)} د.ك\n` +
        `📊 الصافي: *${fmt3(todayRev-todayExp)} د.ك*\n` +
        (yestRev ? `\nمقارنة بالأمس: ${diff>=0?'+':''}${fmt3(diff)} د.ك` : '') +
        `\n\n_تقرير يومي تلقائي_`,
        { parse_mode:'Markdown' }
      );
      db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
      saveDB(db);
    }
  }

  // ── 2. تقرير أسبوعي (الأحد أو اليوم المحدد الساعة 9)
  if (cfg.weeklyReport === true && day === (cfg.weeklyDay ?? 0) && hour === 9) {
    const lastKey = 'lastWeeklyReport';
    if (cfg[lastKey] !== todayStr) {
      const d7 = new Date(now); d7.setDate(d7.getDate()-7);
      const from7 = d7.toISOString().substring(0,10);
      const week  = (db.dailyData||[]).filter(d=>d.date>=from7);
      const totRev = week.reduce((s,d)=>s+(d.total||0),0);
      const totExp = (db.expenses||[]).filter(e=>e.date>=from7).reduce((s,e)=>s+(e.amount||0),0);
      tgSend(
        `📅 *التقرير الأسبوعي — ${from7} إلى ${todayStr}*\n\n` +
        `💰 الإيرادات: *${fmt3(totRev)} د.ك*\n` +
        `💸 المصاريف: *${fmt3(totExp)} د.ك*\n` +
        `📊 صافي الربح: *${fmt3(totRev-totExp)} د.ك*\n` +
        `🗓 أيام العمل: ${week.filter(d=>d.total>0).length} يوم\n\n_تقرير أسبوعي_`,
        { parse_mode:'Markdown' }
      );
      db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
      saveDB(db);
    }
  }

  // ── 3. تقرير شهري (أول الشهر الساعة 9)
  if (cfg.monthlyReport === true && date === 1 && hour === 9) {
    const lastKey = 'lastMonthlyReport';
    if (cfg[lastKey] !== todayStr) {
      const prevMonth = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().substring(0,7);
      const mDays = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(prevMonth));
      const totRev = mDays.reduce((s,d)=>s+(d.total||0),0);
      const totExp = (db.expenses||[]).filter(e=>(e.date||'').startsWith(prevMonth)).reduce((s,e)=>s+(e.amount||0),0);
      tgSend(
        `📊 *التقرير الشهري — ${prevMonth}*\n\n` +
        `💰 الإيرادات: *${fmt3(totRev)} د.ك*\n` +
        `  ├ كاش: ${fmt3(mDays.reduce((s,d)=>s+(d.cash||0),0))} د.ك\n` +
        `  ├ K-Net: ${fmt3(mDays.reduce((s,d)=>s+(d.knet||0),0))} د.ك\n` +
        `  └ تأمين: ${fmt3(mDays.reduce((s,d)=>s+(d.insurance||0),0))} د.ك\n` +
        `💸 المصاريف: *${fmt3(totExp)} د.ك*\n` +
        `📈 صافي الربح: *${fmt3(totRev-totExp)} د.ك*\n` +
        `🗓 أيام العمل: ${mDays.filter(d=>d.total>0).length} يوم\n\n_تقرير شهري تلقائي_`,
        { parse_mode:'Markdown' }
      );
      db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
      saveDB(db);
    }
  }

  // ── 4. تذكير عمولات معلقة (الخميس الساعة 10)
  const pendDay = Number(aut.pendingReminder?.dayOfWeek ?? 4);
  if (aut.pendingReminder?.enabled === true && day === pendDay && hour === 10) {
    const lastKey = 'lastPendingReminder';
    if (cfg[lastKey] !== todayStr) {
      const pending = (db.commissionHistory||[]).filter(c=>!c.paid);
      if (pending.length > 0) {
        const total = pending.reduce((s,c)=>s+(c.commission||0),0);
        let msg = `⏰ *تذكير — عمولات غير مدفوعة*\n\n`;
        pending.forEach(c => { msg += `• ${c.doctor} (${c.month}): ${fmt3(c.commission)} د.ك\n`; });
        msg += `\n*الإجمالي: ${fmt3(total)} د.ك*\n_يرجى الصرف قريباً_`;
        tgSend(msg, { parse_mode:'Markdown' });
        db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
        saveDB(db);
      }
    }
  }

  // ── 5. تنبيه مطالبات التأمين المتأخرة (يومياً الساعة 11)
  const insDays = Number(aut.insuranceAlert?.daysThreshold ?? 30);
  if (aut.insuranceAlert?.enabled !== false && hour === 11) {
    const lastKey = 'lastInsuranceAlert';
    if (cfg[lastKey] !== todayStr) {
      const cutoff = new Date(now - insDays*864e5).toISOString().substring(0,10);
      // R3 (adversarial review): was `c.date` — that field never existed on
      // an insurance claim (the real field is `claimDate`), so this
      // condition was always `undefined < cutoff` -> false — this alert
      // could never fire, for any claim, ever. Also excludes 'cancelled'
      // now that P6-065 introduced that status (a cancelled claim is not
      // "overdue," its liability was reversed).
      const old = (db.insuranceClaims||[]).filter(c => c.status !== 'received' && c.status !== 'cancelled' && c.claimDate < cutoff);
      if (old.length > 0) {
        const total = old.reduce((s,c)=>s+(c.amount||0),0);
        tgSend(
          `🏥 *تنبيه — مطالبات تأمين متأخرة (+${insDays} يوم)*\n\n` +
          old.slice(0,5).map(c=>`• ${c.patientName||c.description||'مطالبة'} (${c.date}): ${fmt3(c.amount)} د.ك`).join('\n') +
          (old.length>5 ? `\n... و${old.length-5} مطالبات أخرى` : '') +
          `\n\n*الإجمالي المعلق: ${fmt3(total)} د.ك*`,
          { parse_mode:'Markdown' }
        );
        db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
        saveDB(db);
      }
    }
  }

  // ── 6. تذكير إغلاق الشهر (آخر N أيام الساعة 9)
  const closingDays = Number(aut.closingReminder?.daysBeforeEnd ?? 3);
  if (aut.closingReminder?.enabled !== false && hour === 9) {
    const lastDay = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    if (date >= lastDay - closingDays + 1) {
      const lastKey = 'lastClosingReminder';
      if (cfg[lastKey] !== todayStr) {
        const daysLeft = lastDay - date;
        tgSend(
          `📋 *تذكير — إغلاق الشهر*\n\n` +
          `⏰ تبقّى *${daysLeft} ${daysLeft===1?'يوم':'أيام'}* على نهاية ${thisMonth}\n\n` +
          `✅ تأكد من:\n• رفع جميع بيانات الإيرادات\n• تسوية الصندوق\n• مراجعة مطالبات التأمين\n• تسوية البنك\n• قيود الاستهلاك`,
          { parse_mode:'Markdown' }
        );
        db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
        saveDB(db);
      }
    }
  }

  // ── 7. فحص المخزون المنخفض (يومياً الساعة 8)
  if (aut.inventoryAlert?.enabled !== false && hour === 8) {
    const lastKey = 'lastInventoryCheck';
    if (cfg[lastKey] !== todayStr) {
      const _iqty = i => parseFloat(i.qty??i.quantity??0);
      const _iminq = i => parseFloat(i.minQty??i.minQuantity??0);
      const _inm = i => i.nameAr||i.name||i.nameEn||'—';
      const low = (db.invItems||[]).filter(i => _iqty(i) <= _iminq(i));
      if (low.length > 0) {
        const out = low.filter(i=>_iqty(i)<=0);
        const min = low.filter(i=>_iqty(i)>0);
        let msg = `📦 *تنبيه المخزون — ${todayStr}*\n\n`;
        if (out.length) msg += `🔴 *نفد (${out.length}):*\n`+out.map(i=>`  • ${_inm(i)}`).join('\n')+'\n\n';
        if (min.length) msg += `🟡 *منخفض (${min.length}):*\n`+min.map(i=>`  • ${_inm(i)}: ${_iqty(i)} ${i.unit||''} (حد: ${_iminq(i)})`).join('\n');
        tgSend(msg, { parse_mode:'Markdown' });
        db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
        saveDB(db);
      }
    }
  }

  // ── 8. تحليل انحراف الإيراد اليومي (يومياً الساعة 21)
  // يقارن إيراد اليوم بمتوسط آخر 30 يوم — ينبّه إذا كان الانحراف > 30%
  if (aut.revenueVariance?.enabled !== false && hour === 21) {
    const lastKey = 'lastRevenueVariance';
    if (cfg[lastKey] !== todayStr) {
      const dayRec = (db.dailyData||[]).find(d => d.date === todayStr);
      const todayRev = dayRec?.total || 0;
      const past30 = (db.dailyData||[])
        .filter(d => d.date < todayStr && d.total > 0)
        .slice(-30);
      if (past30.length >= 5 && todayRev > 0) {
        const avg30 = past30.reduce((s,d)=>s+(d.total||0),0) / past30.length;
        const threshold = Number(aut.revenueVariance?.threshold ?? 30) / 100;
        const variance = (todayRev - avg30) / avg30;
        if (Math.abs(variance) > threshold) {
          const icon = variance > 0 ? '📈' : '📉';
          const dir  = variance > 0 ? 'أعلى' : 'أدنى';
          tgSend(
            `${icon} *تحليل الإيراد — ${todayStr}*\n\n` +
            `💰 إيراد اليوم: *${fmt3(todayRev)} د.ك*\n` +
            `📊 المتوسط (30 يوم): ${fmt3(avg30)} د.ك\n` +
            `⚡ الانحراف: *${dir} بنسبة ${(Math.abs(variance)*100).toFixed(1)}%*\n\n` +
            (variance < 0
              ? `_الإيراد أقل من المعتاد — يُنصح بمراجعة السجلات_`
              : `_يوم ممتاز! الإيراد فوق المتوسط_`),
            { parse_mode:'Markdown' }
          );
          db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
          saveDB(db);
        }
      }
    }
  }

  // ── 9. تصنيف الدكاترة شهرياً (يوم 5 من كل شهر الساعة 9)
  if (aut.doctorRanking?.enabled !== false && date === 5 && hour === 9) {
    const lastKey = 'lastDoctorRanking';
    const rankMonth = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().substring(0,7);
    if (cfg[lastKey] !== rankMonth) {
      const mEntries = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(rankMonth));
      const drMap = {};
      mEntries.forEach(day => {
        (day.doctors||[]).forEach(dr => {
          drMap[dr.name] = (drMap[dr.name]||0) + (dr.revenue||0);
        });
      });
      const ranked = Object.entries(drMap).sort((a,b)=>b[1]-a[1]);
      if (ranked.length > 0) {
        const medals = ['🥇','🥈','🥉'];
        let msg = `🏆 *تصنيف الدكاترة — ${rankMonth}*\n\n`;
        ranked.forEach(([name, rev], i) => {
          const medal = medals[i] || `${i+1}.`;
          msg += `${medal} ${name}: *${fmt3(rev)} د.ك*\n`;
        });
        const total = ranked.reduce((s,[,r])=>s+r,0);
        msg += `\n📊 إجمالي الشهر: *${fmt3(total)} د.ك*`;
        tgSend(msg, { parse_mode:'Markdown' });
        db.scheduleConfig = { ...cfg, [lastKey]: rankMonth };
        saveDB(db);
      }
    }
  }

  // ── 10. تذكير تقدم الأهداف منتصف الشهر (يوم 15 الساعة 10)
  if (aut.goalProgress?.enabled !== false && date === 15 && hour === 10) {
    const lastKey = 'lastGoalProgress';
    if (cfg[lastKey] !== thisMonth) {
      const doctors = db.doctors || [];
      const mEntries = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(thisMonth));
      const drRevMap = {};
      mEntries.forEach(day => {
        (day.doctors||[]).forEach(dr => {
          drRevMap[dr.name] = (drRevMap[dr.name]||0) + (dr.revenue||0);
        });
      });
      const withTarget = doctors.filter(d=>d.target>0);
      if (withTarget.length > 0) {
        let msg = `🎯 *تقدم الأهداف — منتصف ${thisMonth}*\n\n`;
        withTarget.forEach(dr => {
          const rev = drRevMap[dr.name] || 0;
          const pct = Math.round((rev / dr.target) * 100);
          const bar = '█'.repeat(Math.min(10,Math.floor(pct/10))) + '░'.repeat(Math.max(0,10-Math.floor(pct/10)));
          const icon = pct >= 50 ? '✅' : pct >= 30 ? '⚠️' : '🔴';
          msg += `${icon} ${dr.name}\n  ${bar} ${pct}%\n  ${fmt3(rev)} / ${fmt3(dr.target)} د.ك\n\n`;
        });
        tgSend(msg, { parse_mode:'Markdown' });
        db.scheduleConfig = { ...cfg, [lastKey]: thisMonth };
        saveDB(db);
      }
    }
  }
}

// تنبيه فوري عند نفاد مخزون صنف
function checkInventoryAlert(item) {
  const aut = getAutoCfg();
  const _qty = parseFloat(item.qty??item.quantity??0);
  const _minq = parseFloat(item.minQty??item.minQuantity??0);
  const _nm = item.nameAr||item.name||item.nameEn||'—';
  if (!aut.inventoryAlert?.enabled || _qty > _minq) return;
  const icon = _qty <= 0 ? '🔴 *نفد*' : '🟡 *منخفض*';
  tgSend(`📦 ${icon}: *${_nm}*\nالكمية: ${_qty} ${item.unit||''} | الحد الأدنى: ${_minq}`, { parse_mode:'Markdown' });
}

// تنبيه فوري عند شذوذ مصروف
async function checkExpenseAnomaly(expense) {
  const aut = getAutoCfg();
  if (!aut.anomalyDetection?.enabled) return;
  const multiplier = Number(aut.anomalyDetection?.multiplier ?? 2);
  const db = loadDB();
  const now = new Date().toISOString().substring(0,7);
  const sameCategory = (db.expenses||[]).filter(e => e.cat === expense.cat && e.date?.substring(0,7) !== now);
  if (sameCategory.length < 3) return;
  const avg = sameCategory.reduce((s,e)=>s+(e.amount||0),0) / sameCategory.length;
  if (expense.amount > avg * multiplier) {
    tgSend(
      `⚠️ *مصروف غير عادي — تنبيه ذكي*\n\n` +
      `📂 الفئة: ${expense.cat}\n` +
      `💰 المبلغ: *${fmt3(expense.amount)} د.ك*\n` +
      `📊 المعدل الطبيعي: ${fmt3(avg)} د.ك\n` +
      `📈 الفرق: *${((expense.amount/avg-1)*100).toFixed(0)}% أعلى من المعتاد*\n` +
      `📝 الوصف: ${expense.desc||'—'}`,
      { parse_mode:'Markdown' }
    );
  }
}

// تنبيه فوري عند تجاوز هدف الدكتور
function checkTargetAchievement(doctor, newRevenue) {
  const aut = getAutoCfg();
  if (!aut.targetAlert?.enabled) return;
  const db = loadDB();
  const dr = (db.doctors||[]).find(d => d.name === doctor);
  if (!dr || !dr.target) return;
  if (newRevenue >= dr.target) {
    tgSend(
      `🎯 *تجاوز الهدف!*\n\n` +
      `👨‍⚕️ الدكتور: *${doctor}*\n` +
      `💰 الإيراد الحالي: *${fmt3(newRevenue)} د.ك*\n` +
      `🎯 الهدف الشهري: ${fmt3(dr.target)} د.ك\n` +
      `📈 التجاوز: *${fmt3(newRevenue-dr.target)} د.ك (${((newRevenue/dr.target-1)*100).toFixed(0)}%)*`,
      { parse_mode:'Markdown' }
    );
  }
}

// Check every hour
setInterval(runScheduledTasks, 60 * 60 * 1000);
// Also check on startup after 5 seconds
setTimeout(runScheduledTasks, 5000);

// ═══════════════════════════════════════════════════
// MONTHLY REPORT SLIDE — HTML Presentation
// ═══════════════════════════════════════════════════
app.get('/api/monthly-report-slide', requireAuth, requirePermission('reports', 'export'), async (req, res) => {
  try {
  const db = loadDB();
  const now = new Date();
  const targetMonth = req.query.month || now.toISOString().substring(0, 7);
  const [yr, mo] = targetMonth.split('-').map(Number);
  const monthNames = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const monthLabel = `${monthNames[mo-1]} ${yr}`;

  const daily    = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(targetMonth));
  const expenses = (db.expenses||[]).filter(e=>(e.date||'').startsWith(targetMonth));
  const claims   = (db.insuranceClaims||[]);

  const totalRev = daily.reduce((s,d)=>s+(d.total||0),0);
  const cashRev  = daily.reduce((s,d)=>s+(d.cash||0),0);
  const knetRev  = daily.reduce((s,d)=>s+(d.knet||0)+(d.visa||0)+(d.master||0),0);
  const insRev   = daily.reduce((s,d)=>s+(d.insurance||0),0);
  const linkRev  = daily.reduce((s,d)=>s+(d.link||0),0);
  const totalExp = expenses.reduce((s,e)=>s+(e.amount||0),0);
  const netProfit = totalRev - totalExp;
  const margin   = totalRev ? (netProfit/totalRev*100).toFixed(1) : 0;
  const workDays = daily.filter(d=>d.total>0).length;
  const avgPerDay = workDays ? (totalRev/workDays).toFixed(3) : 0;

  // Previous month for comparison
  const prevMonth = new Date(yr, mo-2).toISOString().substring(0,7);
  const prevRev = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(prevMonth)).reduce((s,d)=>s+(d.total||0),0);
  const revGrowth = prevRev ? ((totalRev-prevRev)/prevRev*100).toFixed(1) : null;

  // Top doctor
  const drRev = {};
  (db.paymentsData||[]).filter(p=>(p.date||'').startsWith(targetMonth)).forEach(p=>{
    if(p.doctor && p.doctor!=='Advance') drRev[p.doctor]=(drRev[p.doctor]||0)+(p.total||0);
  });
  const topDr = Object.entries(drRev).sort((a,b)=>b[1]-a[1])[0];

  // Expense categories
  const expCat = {};
  expenses.forEach(e=>{ expCat[e.cat||'أخرى']=(expCat[e.cat||'أخرى']||0)+(e.amount||0); });
  const topExpCats = Object.entries(expCat).sort((a,b)=>b[1]-a[1]).slice(0,5);

  // Pending insurance
  const pendingIns = claims.filter(c=>c.status!=='received').reduce((s,c)=>s+(c.amount||0),0);

  const f = v => (+v).toLocaleString('ar-KW',{minimumFractionDigits:3,maximumFractionDigits:3});

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>التقرير المالي الشهري — ${monthLabel}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
:root{
  --bg:#040915;--surface:#080d1e;--surface2:#0d1530;
  --accent:#4f8ef7;--accent2:#2dd4bf;--gold:#fbbf24;
  --danger:#f87171;--text:#e4ecff;--text2:#94a3b8;--border:#1a2d57;
}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',Tahoma,Arial,sans-serif;min-height:100vh;overflow-x:hidden;}
body::before{content:'';position:fixed;inset:0;background-image:radial-gradient(circle,rgba(79,142,247,.05) 1px,transparent 1px);background-size:24px 24px;pointer-events:none;}

.slides-wrap{width:100%;max-width:1100px;margin:0 auto;padding:24px;}

/* ── Slide Card ── */
.slide{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:36px;margin-bottom:24px;position:relative;overflow:hidden;}
.slide::before{content:'';position:absolute;top:0;right:0;width:4px;height:100%;background:linear-gradient(180deg,var(--accent),var(--accent2));}

/* ── Cover Slide ── */
.slide-cover{background:linear-gradient(135deg,#060d2a 0%,#0e1c3a 50%,#040915 100%);text-align:center;padding:64px 48px;}
.slide-cover .logo-circle{width:80px;height:80px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:24px;display:flex;align-items:center;justify-content:center;font-size:36px;margin:0 auto 24px;}
.slide-cover h1{font-size:32px;font-weight:800;letter-spacing:-.02em;margin-bottom:8px;}
.slide-cover .subtitle{font-size:16px;color:var(--text2);margin-bottom:32px;}
.slide-cover .period-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(79,142,247,.12);border:1px solid rgba(79,142,247,.3);border-radius:99px;padding:8px 20px;font-size:14px;color:var(--accent);}

/* ── KPI Grid ── */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:0;}
.kpi{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:20px 16px;text-align:center;position:relative;overflow:hidden;}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--kpi-color,var(--accent));}
.kpi .kpi-label{font-size:11px;color:var(--text2);margin-bottom:8px;letter-spacing:.02em;}
.kpi .kpi-value{font-size:22px;font-weight:800;font-family:monospace;letter-spacing:-.01em;}
.kpi .kpi-sub{font-size:10px;color:var(--text2);margin-top:4px;}
.kpi.good{--kpi-color:var(--accent2);}
.kpi.warn{--kpi-color:var(--gold);}
.kpi.bad{--kpi-color:var(--danger);}

/* ── Section title ── */
.slide-title{font-size:20px;font-weight:700;margin-bottom:24px;display:flex;align-items:center;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--border);}
.slide-num{font-size:10px;color:var(--text2);position:absolute;top:20px;left:36px;font-family:monospace;}

/* ── Chart containers ── */
.chart-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.chart-box{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:16px;}
.chart-box h3{font-size:12px;color:var(--text2);margin-bottom:12px;}

/* ── Table ── */
.rtable{width:100%;border-collapse:collapse;font-size:12px;}
.rtable th{background:var(--surface2);padding:10px 14px;text-align:right;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border);}
.rtable td{padding:8px 14px;border-bottom:1px solid rgba(26,45,87,.5);color:var(--text);}
.rtable tr:last-child td{border-bottom:none;font-weight:700;}
.rtable .num{text-align:left;font-family:monospace;}
.rtable .good{color:var(--accent2);}
.rtable .bad{color:var(--danger);}

/* ── Insight Cards ── */
.insights{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}
.insight{background:var(--surface2);border-radius:10px;padding:16px;border-right:3px solid var(--insight-color,var(--accent));}
.insight.good{--insight-color:var(--accent2);}
.insight.warn{--insight-color:var(--gold);}
.insight.bad{--insight-color:var(--danger);}
.insight .ins-label{font-size:10px;color:var(--text2);margin-bottom:6px;}
.insight .ins-val{font-size:14px;font-weight:700;}

/* ── Print / Nav ── */
.print-btn{position:fixed;bottom:24px;left:24px;background:var(--accent);color:#fff;border:none;border-radius:10px;padding:12px 20px;font-size:13px;cursor:pointer;font-family:inherit;box-shadow:0 4px 20px rgba(79,142,247,.4);z-index:999;}
@media print{.print-btn,.slide-num{display:none;}.slide{page-break-after:always;border:none;}}
</style>
</head>
<body>
<div class="slides-wrap">

<!-- SLIDE 1: COVER -->
<div class="slide slide-cover">
  <div class="logo-circle">🦷</div>
  <h1>التقرير المالي الشهري</h1>
  <div class="subtitle">بوبيان لطب الأسنان — نظام المحاسبة الذكي</div>
  <div class="period-badge">📅 ${monthLabel}</div>
  ${revGrowth !== null ? `<div style="margin-top:16px;font-size:13px;color:${+revGrowth>=0?'#2dd4bf':'#f87171'}">${+revGrowth>=0?'📈 نمو':'📉 تراجع'} ${Math.abs(+revGrowth)}% مقارنة بالشهر السابق</div>` : ''}
</div>

<!-- SLIDE 2: KPIs -->
<div class="slide">
  <span class="slide-num">01</span>
  <div class="slide-title">📊 مؤشرات الأداء الرئيسية — ${monthLabel}</div>
  <div class="kpi-grid">
    <div class="kpi ${totalRev > (prevRev||0) ? 'good':'warn'}">
      <div class="kpi-label">إجمالي الإيرادات</div>
      <div class="kpi-value" style="color:var(--accent2);font-size:18px">${f(totalRev)}</div>
      <div class="kpi-sub">دينار كويتي</div>
    </div>
    <div class="kpi ${netProfit>=0?'good':'bad'}">
      <div class="kpi-label">صافي الربح</div>
      <div class="kpi-value" style="color:${netProfit>=0?'var(--accent2)':'var(--danger)'};font-size:18px">${f(Math.abs(netProfit))}</div>
      <div class="kpi-sub">هامش ${margin}%</div>
    </div>
    <div class="kpi warn">
      <div class="kpi-label">إجمالي المصاريف</div>
      <div class="kpi-value" style="color:var(--gold);font-size:18px">${f(totalExp)}</div>
      <div class="kpi-sub">${Object.keys(expCat).length} تصنيف</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">أيام العمل الفعلية</div>
      <div class="kpi-value" style="color:var(--accent)">${workDays}</div>
      <div class="kpi-sub">معدل ${f(avgPerDay)} د.ك/يوم</div>
    </div>
  </div>
</div>

<!-- SLIDE 3: REVENUE BREAKDOWN -->
<div class="slide">
  <span class="slide-num">02</span>
  <div class="slide-title">💰 تحليل الإيرادات — توزيع طرق الدفع</div>
  <div class="chart-row">
    <div class="chart-box">
      <h3>توزيع طرق الدفع</h3>
      <div id="payChart" style="height:220px;"></div>
    </div>
    <div>
      <table class="rtable">
        <thead><tr><th>طريقة الدفع</th><th class="num">المبلغ (د.ك)</th><th class="num">النسبة</th></tr></thead>
        <tbody>
          ${totalRev > 0 ? [
            ['💵 نقد', cashRev],
            ['💳 K-Net / شبكة', knetRev],
            ['🏥 تأمين', insRev],
            ['🔗 Link', linkRev],
          ].filter(([,v])=>v>0).map(([name,val])=>`
            <tr><td>${name}</td><td class="num good">${f(val)}</td><td class="num">${totalRev?(val/totalRev*100).toFixed(1):0}%</td></tr>
          `).join('') : '<tr><td colspan="3" style="text-align:center;color:var(--text2)">لا يوجد بيانات</td></tr>'}
          <tr style="border-top:2px solid var(--border)"><td style="font-weight:800">الإجمالي</td><td class="num good" style="font-size:14px">${f(totalRev)}</td><td class="num">100%</td></tr>
        </tbody>
      </table>
      ${pendingIns > 0 ? `<div style="margin-top:12px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--gold)">⚠️ مطالبات تأمين معلقة: ${f(pendingIns)} د.ك</div>` : ''}
    </div>
  </div>
</div>

<!-- SLIDE 4: EXPENSES -->
<div class="slide">
  <span class="slide-num">03</span>
  <div class="slide-title">📉 تحليل المصاريف — ${monthLabel}</div>
  <div class="chart-row">
    <div class="chart-box">
      <h3>المصاريف حسب التصنيف</h3>
      <div id="expChart" style="height:220px;"></div>
    </div>
    <div>
      <table class="rtable">
        <thead><tr><th>التصنيف</th><th class="num">المبلغ (د.ك)</th><th class="num">%</th></tr></thead>
        <tbody>
          ${topExpCats.length ? topExpCats.map(([cat,amt])=>`
            <tr><td>${cat}</td><td class="num bad">${f(amt)}</td><td class="num">${totalExp?(amt/totalExp*100).toFixed(1):0}%</td></tr>
          `).join('') : '<tr><td colspan="3" style="text-align:center;color:var(--text2)">لا يوجد مصاريف</td></tr>'}
          <tr style="border-top:2px solid var(--border)"><td>الإجمالي</td><td class="num bad" style="font-size:14px">${f(totalExp)}</td><td class="num">100%</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- SLIDE 5: INSIGHTS & RECOMMENDATIONS -->
<div class="slide">
  <span class="slide-num">04</span>
  <div class="slide-title">💡 التحليل والتوصيات</div>
  <div class="insights">
    <div class="insight ${netProfit>=0?'good':'bad'}">
      <div class="ins-label">الربحية</div>
      <div class="ins-val">${netProfit>=0?'✅ ربح':'❌ خسارة'} — هامش ${margin}%</div>
    </div>
    <div class="insight ${+revGrowth>=0?'good':'bad'}">
      <div class="ins-label">نمو الإيرادات</div>
      <div class="ins-val">${revGrowth!==null?(+revGrowth>=0?'📈 نمو +':'📉 تراجع ')+Math.abs(+revGrowth)+'%':'📊 أول شهر'}</div>
    </div>
    <div class="insight ${pendingIns>0?'warn':'good'}">
      <div class="ins-label">مطالبات التأمين</div>
      <div class="ins-val">${pendingIns>0?`⚠️ معلق ${f(pendingIns)} د.ك`:'✅ لا مطالبات معلقة'}</div>
    </div>
    ${topDr ? `<div class="insight good"><div class="ins-label">أفضل دكتور</div><div class="ins-val">⭐ ${topDr[0]}: ${f(topDr[1])} د.ك</div></div>` : ''}
    <div class="insight ${totalRev>0&&cashRev/totalRev>0.5?'good':'warn'}">
      <div class="ins-label">نسبة النقد</div>
      <div class="ins-val">${totalRev?(cashRev/totalRev*100).toFixed(0):0}% من الإيرادات نقداً</div>
    </div>
    <div class="insight ${workDays>=20?'good':workDays>=15?'warn':'bad'}">
      <div class="ins-label">كثافة العمل</div>
      <div class="ins-val">${workDays} يوم عمل — معدل ${f(avgPerDay)} د.ك</div>
    </div>
  </div>
  <div style="margin-top:20px;padding:16px;background:rgba(79,142,247,.06);border:1px solid rgba(79,142,247,.2);border-radius:10px;font-size:12px;line-height:1.8;color:var(--text2)">
    <strong style="color:var(--text)">📋 ملخص تنفيذي:</strong><br>
    ${totalRev > 0 ? `حققت العيادة إيرادات ${f(totalRev)} د.ك خلال ${monthLabel} بمعدل ${f(avgPerDay)} د.ك يومياً على مدى ${workDays} يوم عمل.` : 'لا توجد بيانات إيرادات لهذا الشهر.'}
    ${netProfit >= 0 ? ` حقق صافي ربح ${f(netProfit)} د.ك بهامش ${margin}%.` : ` سجلت خسارة صافية ${f(Math.abs(netProfit))} د.ك — يُنصح بمراجعة هيكل المصاريف.`}
    ${pendingIns > 0 ? ` تنبيه: ${f(pendingIns)} د.ك مطالبات تأمين معلقة تحتاج متابعة.` : ''}
  </div>
</div>

</div><!-- /slides-wrap -->

<button class="print-btn" onclick="window.print()">🖨️ طباعة / PDF</button>

<script>
// Payment methods pie chart
const payData = [
  {value:${cashRev.toFixed(3)},name:'نقد'},
  {value:${knetRev.toFixed(3)},name:'K-Net'},
  {value:${insRev.toFixed(3)},name:'تأمين'},
  {value:${linkRev.toFixed(3)},name:'Link'},
].filter(d=>d.value>0);

if(payData.length && document.getElementById('payChart')){
  echarts.init(document.getElementById('payChart'),null,{renderer:'canvas'}).setOption({
    backgroundColor:'transparent',
    tooltip:{trigger:'item',formatter:'{b}: {c} KWD ({d}%)'},
    legend:{bottom:0,textStyle:{color:'#94a3b8',fontSize:9}},
    series:[{type:'pie',radius:['40%','68%'],center:['50%','45%'],
      data:payData,
      label:{formatter:'{d}%',fontSize:10,color:'#e4ecff'},
      itemStyle:{borderColor:'#040915',borderWidth:2},
    }],
    color:['#4f8ef7','#2dd4bf','#fbbf24','#a78bfa'],
  });
}

// Expenses bar chart
const expData = ${JSON.stringify(topExpCats)};
if(expData.length && document.getElementById('expChart')){
  echarts.init(document.getElementById('expChart'),null,{renderer:'canvas'}).setOption({
    backgroundColor:'transparent',
    tooltip:{trigger:'axis'},
    grid:{left:10,right:10,top:10,bottom:50,containLabel:true},
    xAxis:{type:'category',data:expData.map(d=>d[0]),axisLabel:{color:'#94a3b8',fontSize:9,rotate:15}},
    yAxis:{type:'value',axisLabel:{color:'#94a3b8',fontSize:9},splitLine:{lineStyle:{color:'#1a2d57'}}},
    series:[{type:'bar',data:expData.map(d=>d[1].toFixed(3)),
      itemStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'#f87171'},{offset:1,color:'#dc2626'}])},
      label:{show:true,position:'top',fontSize:9,color:'#f87171',formatter:v=>v.value>0?v.value:''},
    }]
  });
}
<\/script>
</body></html>`;

  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(html);
  } catch (e) {
    console.error('❌ monthly-report-slide error:', e.message);
    res.status(500).send('<h3 style="font-family:sans-serif;direction:rtl">تعذر توليد التقرير الشهري — ' + e.message + '</h3>');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AI AGENT CONTROL PANEL — لوحة التحكم الذكية
// ═══════════════════════════════════════════════════════════════════════════════
{
  const { spawn } = require('child_process');

  const AGENTS = {
    // ── Core internal departments ──────────────────────────────────────────────
    'audit-quality':    { script: 'scripts/departments/audit-quality.js',    nameAr: 'التدقيق والجودة',    icon: '🔍', color: '#f97316', category: 'internal' },
    'security-scan':    { script: 'scripts/departments/security-scan.js',    nameAr: 'الأمن السيبراني',   icon: '🔒', color: '#ef4444', category: 'internal' },
    'operations':       { script: 'scripts/departments/operations.js',       nameAr: 'العمليات',           icon: '⚙️', color: '#6366f1', category: 'internal' },
    'it-health':        { script: 'scripts/departments/it-health.js',        nameAr: 'صحة النظام',         icon: '💻', color: '#22d3ee', category: 'internal' },
    'hr-reminders':     { script: 'scripts/departments/hr-reminders.js',     nameAr: 'الموارد البشرية',   icon: '👥', color: '#22c55e', category: 'internal' },
    'design-audit':     { script: 'scripts/departments/design-audit.js',     nameAr: 'التصميم وUX',        icon: '🎨', color: '#ec4899', category: 'internal' },
    'news-reader':      { script: 'scripts/departments/news-reader.js',      nameAr: 'متابعة الأخبار',    icon: '📰', color: '#eab308', category: 'internal' },
    'ai-optimizer':     { script: 'scripts/departments/ai-optimizer.js',     nameAr: 'تحسين الذكاء',      icon: '🤖', color: '#a855f7', category: 'internal' },
    'rd-suggestions':   { script: 'scripts/departments/rd-suggestions.js',   nameAr: 'البحث والتطوير',    icon: '🔬', color: '#14b8a6', category: 'internal' },
    'compliance':       { script: 'scripts/compliance-check.js',             nameAr: 'الامتثال القانوني', icon: '✅', color: '#84cc16', category: 'internal' },
    'system-tester':    { script: 'scripts/departments/system-tester.js',    nameAr: 'المُجرِّب',          icon: '🧪', color: '#06b6d4', category: 'internal' },
    // ── SaaS departments (CLAUDE.md §2-3) ─────────────────────────────────────
    'market-intel':     { script: 'scripts/departments/market-intel.js',     nameAr: 'أبحاث المنافسين',   icon: '🕵️', color: '#0ea5e9', category: 'saas' },
    'design-studio':    { script: 'scripts/departments/design-studio.js',    nameAr: 'التصميم الإنتاجي',  icon: '🪄', color: '#d946ef', category: 'saas' },
    'global-compliance':{ script: 'scripts/departments/global-compliance.js',nameAr: 'الامتثال العالمي',  icon: '⚖️', color: '#10b981', category: 'saas' },
    'meta-eval':        { script: 'scripts/departments/meta-eval.js',        nameAr: 'التحقق الذاتي',     icon: '🔎', color: '#8b5cf6', category: 'saas' },
    'marketing-growth': { script: 'scripts/departments/marketing-growth.js', nameAr: 'التسويق والنمو',    icon: '📣', color: '#f43f5e', category: 'saas' },
    'deploy-website':   { script: 'scripts/departments/deploy-website.js',   nameAr: 'النشر والموقع',     icon: '🚀', color: '#f59e0b', category: 'saas' },
  };

  // Serve control panel page
  app.get('/agents', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'agents.html'));
  });

  // List all agents + memory status
  app.get('/api/agents/status', requireAuth, (req, res) => {
    const memDir = path.join(__dirname, '.agent-memory');
    let companyState = {};
    const stateFile = path.join(memDir, 'company-state.json');
    if (fs.existsSync(stateFile)) {
      try { companyState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    }

    const result = {};
    for (const [id, agent] of Object.entries(AGENTS)) {
      const histFile = path.join(memDir, `${id}-history.json`);
      let history = [];
      if (fs.existsSync(histFile)) {
        try { history = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch {}
      }
      const latest = history[0] || null;
      const cs = companyState[id] || null;
      result[id] = {
        ...agent,
        id,
        score:    latest?.score    ?? cs?.score    ?? null,
        critical: latest?.critical ?? cs?.critical ?? 0,
        high:     latest?.high     ?? 0,
        medium:   latest?.medium   ?? 0,
        date:     latest?.date     ?? cs?.date     ?? null,
        trend:    history.length >= 2
                    ? (history[0].score > history[1].score ? 'up' : history[0].score < history[1].score ? 'down' : 'stable')
                    : 'new',
        sparkline: history.slice(0, 6).reverse().map(h => h.score),
      };
    }
    res.json(result);
  });

  // SSE: stream a single agent run
  app.get('/api/agents/run/:id', requireAuth, (req, res) => {
    const agent = AGENTS[req.params.id];
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (type, data) => {
      try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {}
    };

    send('start', { id: req.params.id, name: agent.nameAr });

    const proc = spawn('node', [agent.script], {
      cwd: __dirname,
      env: { ...process.env },
    });

    let reportBuf = '';
    proc.stdout.on('data', c => { reportBuf += c.toString(); });
    proc.stderr.on('data', c => {
      c.toString().split('\n').filter(l => l.trim()).forEach(line => send('log', line));
    });
    proc.on('close', code => {
      send('report', reportBuf);
      send('done', { id: req.params.id, code, time: new Date().toISOString() });
      res.end();
    });
    req.on('close', () => { try { proc.kill(); } catch {} });
  });

  // ── SSE: المدير الذكي — يشغّل الوكلاء ويجمع نتائجهم في تقرير واحد ──────────────
  app.get('/api/agents/orchestrate', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {} };

    // اختيار الوكلاء: افتراضياً كل الوكلاء الداخليين (تجنّب أبحاث الويب المكلفة)
    const { orchestrate } = require('./scripts/departments/_orchestrator');
    const { AGENTS: REG } = require('./scripts/departments/_registry');
    let ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) ids = Object.keys(REG).filter(id => REG[id].category === 'internal');

    send('start', { count: ids.length });
    let aborted = false;
    req.on('close', () => { aborted = true; });

    orchestrate(
      ids,
      (agentId, line) => { if (!aborted) send('log', { agentId, line }); },
      (agentId, kpi) => { if (!aborted) send('agent-done', { agentId, ...kpi }); },
    ).then(({ report, health, merged }) => {
      if (aborted) return;
      send('report', report);
      send('done', { health, issues: merged.length, time: new Date().toISOString() });
      res.end();
    }).catch(e => {
      if (aborted) return;
      // R4 (Part P): orchestrate() spawns agent scripts via child_process —
      // a spawn/script failure's e.message can include a raw filesystem
      // path. Logged in full server-side; the SSE stream gets a safe
      // generic notice only.
      console.error('❌ Agent orchestration error:', e.message);
      send('log', { agentId: 'chief', line: '❌ حدث خطأ أثناء تشغيل الوكلاء — راجع سجلات الخادم' });
      send('done', { error: 'تعذّر إكمال التشغيل' });
      res.end();
    });
  });

  // ── Telegram Webhook — /approve & /reject commands ──────────────────────────
  // CLAUDE.md §4: BLOCKING findings wait here for user approval
  {
    const { processCommand, getPendingApprovals } = require('./lib/telegram');
    const { getCacheStats } = require('./lib/ai');

    // Telegram bot webhook — set via: https://api.telegram.org/bot<TOKEN>/setWebhook?url=<YOUR_URL>/api/telegram/webhook
    app.post('/api/telegram/webhook', (req, res) => {
      res.json({ ok: true }); // respond fast to Telegram
      const msg = req.body?.message;
      if (!msg?.text) return;

      const result = processCommand(msg.text);
      if (!result) return;

      const { sendNotification } = require('./lib/telegram');
      if (!result.found) {
        sendNotification({ deptNameAr: 'نظام الموافقة', title: 'ID غير موجود', detail: `لم أجد طلب موافقة برقم: ${result.id}` });
        return;
      }

      const emoji  = result.action === 'approve' ? '✅' : '❌';
      const label  = result.action === 'approve' ? 'مقبول' : 'مرفوض';
      sendNotification({
        deptNameAr: result.item.deptAr,
        title:      `${emoji} ${label} — ${result.item.finding.title}`,
        detail:     `تم تسجيل قرارك. الحالة: ${result.item.status}`,
      });
    });

    // Get pending approvals list
    app.get('/api/agents/approvals', requireAuth, (req, res) => {
      res.json(getPendingApprovals());
    });

    // Approve a pending item
    app.post('/api/agents/approvals/:id/approve', requireAuth, (req, res) => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'المدير فقط يمكنه الموافقة' });
      const result = processCommand(`/approve ${req.params.id}`);
      if (!result) return res.status(404).json({ error: 'الطلب غير موجود' });
      if (!result.found) return res.status(404).json({ error: 'معرّف غير صالح' });
      try { sendNotification({ deptNameAr: result.item.deptAr || result.item.dept, title: '✅ تمت الموافقة', detail: result.item.finding.title }); } catch {}
      res.json({ success: true, id: req.params.id, status: 'approved' });
    });

    // Reject a pending item
    app.post('/api/agents/approvals/:id/reject', requireAuth, (req, res) => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'المدير فقط يمكنه الرفض' });
      const result = processCommand(`/reject ${req.params.id}`);
      if (!result) return res.status(404).json({ error: 'الطلب غير موجود' });
      if (!result.found) return res.status(404).json({ error: 'معرّف غير صالح' });
      res.json({ success: true, id: req.params.id, status: 'rejected' });
    });

    // Apply a fix suggestion automatically (AUTO level — CLAUDE.md §4)
    // Only for bug fixes, not new features
    app.post('/api/agents/apply-fix', requireAuth, async (req, res) => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'المدير فقط' });

      const { suggestion, context, targetFile } = req.body;
      if (!suggestion) return res.status(400).json({ error: 'suggestion مطلوب' });

      // Only allow editing files inside public/ or specific safe paths
      const SAFE_PATHS = ['public/index.html', 'public/agents.html', 'public/landing.html'];
      const target = targetFile || 'public/index.html';
      if (!SAFE_PATHS.includes(target)) {
        return res.status(403).json({ error: 'لا يمكن تعديل هذا الملف تلقائياً — يحتاج موافقة يدوية' });
      }

      try {
        const fs   = require('fs-extra');
        const path = require('path');
        const filePath = path.join(__dirname, target);

        if (!await fs.pathExists(filePath)) {
          return res.status(404).json({ error: 'الملف غير موجود: ' + target });
        }

        const fileContent = await fs.readFile(filePath, 'utf8');

        // Extract relevant portion around the suggestion keywords to keep context focused
        const MAX_EXCERPT = 60000;
        let fileExcerpt = fileContent;
        if (fileContent.length > MAX_EXCERPT) {
          // Try to find a relevant region based on keywords in the suggestion
          const keywords = suggestion.match(/[؀-ۿ\w]{4,}/g) || [];
          let bestIdx = -1;
          for (const kw of keywords) {
            const idx = fileContent.indexOf(kw);
            if (idx > 0) { bestIdx = idx; break; }
          }
          if (bestIdx > 5000) {
            const start = Math.max(0, bestIdx - 5000);
            fileExcerpt = '…[مقتطع ذو صلة]\n' + fileContent.slice(start, start + MAX_EXCERPT);
          } else {
            fileExcerpt = fileContent.slice(0, MAX_EXCERPT);
          }
        }

        // Use Claude to generate the specific fix
        const prompt = `أنت مطوّر ويب خبير. لديك ملف HTML يحتاج إصلاح.

المشكلة المُكتشَفة:
${suggestion}

${context ? `سياق إضافي:\n${context}\n` : ''}

محتوى الملف (${fileExcerpt.length} حرف من أصل ${fileContent.length}):
\`\`\`html
${fileExcerpt}
\`\`\`

مهمتك:
1. اشرح بجملة واحدة ماذا ستصلح
2. قدّم أصغر تغيير ممكن (لا تعيد كتابة الملف كله)
3. SEARCH يجب أن يكون نصاً موجوداً بالضبط في الملف أعلاه (انسخه حرفياً)
4. إذا التغيير كبير جداً أو غير آمن أو لم تجد الكود، أجب بسطر واحد فقط: SKIP: السبب

⚠️ التزم حرفياً بهذا الشكل — الكود داخل أسوار \`\`\` إجبارياً، ولا تكتب أي كلام بعد سور الإغلاق الأخير:
EXPLANATION: [شرح بسيط بالعربي في سطر واحد]
SEARCH:
\`\`\`
[النص القديم منقول حرفياً من الملف]
\`\`\`
REPLACE:
\`\`\`
[النص الجديد]
\`\`\``;

        const aiResponse = await callAI({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        });

        // Parse AI response — SKIP may appear after EXPLANATION, not only at the start
        const skipMatch = aiResponse.match(/^SKIP:\s*([\s\S]+)/m);
        if (skipMatch && !/^SEARCH:/m.test(aiResponse)) {
          return res.json({
            success: false,
            skipped: true,
            reason: skipMatch[1].trim(),
            message: 'الإصلاح يحتاج مراجعة يدوية',
          });
        }

        // Strict fenced-block parsing — prose can never leak into the file.
        // (The old regex captured everything after REPLACE: to end of response,
        //  which wrote AI commentary into the live page.)
        const expMatch     = aiResponse.match(/EXPLANATION:\s*(.+)/);
        const searchFence  = aiResponse.match(/SEARCH:\s*```[\w]*\n([\s\S]*?)\n?```/);
        const replaceFence = aiResponse.match(/REPLACE:\s*```[\w]*\n([\s\S]*?)\n?```/);

        if (!searchFence || !replaceFence) {
          return res.json({ success: false, skipped: true, reason: 'الذكاء الاصطناعي لم يلتزم بصيغة الإصلاح الآمنة — يحتاج مراجعة يدوية' });
        }

        const searchText  = searchFence[1];
        const replaceText = replaceFence[1];
        const explanation = expMatch ? expMatch[1].trim() : suggestion;

        // Safety net: reject any patch that still carries response markers or fences
        const LEAK = /(EXPLANATION:|SEARCH:|REPLACE:|SKIP:|```)/;
        if (!searchText.trim() || LEAK.test(replaceText) || LEAK.test(searchText)) {
          return res.json({ success: false, skipped: true, reason: 'الإصلاح المُولَّد يحتوي نصاً غير آمن — رُفض تلقائياً لحماية الصفحة' });
        }

        // Guard against "file completion": the AI sees only an excerpt, so it must
        // never balloon a targeted edit into appending large blocks of markup.
        if (replaceText.length > searchText.length + 1500) {
          return res.json({ success: false, skipped: true, reason: 'الإصلاح يضيف كوداً كبيراً جداً (قد يكون محاولة إكمال ملف) — رُفض لحماية الصفحة' });
        }

        // Must appear exactly once — replacing an ambiguous match could corrupt elsewhere
        const occurrences = fileContent.split(searchText).length - 1;
        if (occurrences === 0) {
          return res.json({
            success: false,
            reason: 'النص المُراد تعديله غير موجود بالضبط في الملف — يحتاج مراجعة يدوية',
            searchAttempted: searchText.slice(0, 200),
          });
        }
        if (occurrences > 1) {
          return res.json({ success: false, skipped: true, reason: `النص المُراد تعديله موجود ${occurrences} مرات — غامض، يحتاج مراجعة يدوية` });
        }

        // ── Second-AI safety review — a different model double-checks the patch
        // before it touches the live page (blocks bad "fixes" like removing dir=rtl).
        try {
          const reviewPrompt = `أنت مراجع كود صارم. اقترح أحدهم هذا التغيير على ملف واجهة عربية (RTL) لنظام محاسبي حي.

قديم:
${searchText}

جديد:
${replaceText}

هل التغيير آمن وصحيح ولا يكسر التخطيط أو اللغة العربية (مثلاً حذف dir="rtl" أو تغيير جذري أو كود ضار)؟
أجب بكلمة واحدة في أول سطر: APPROVE أو REJECT، ثم سبب مختصر.`;
          const review = await callAI({
            model: 'claude-sonnet-4-6',
            max_tokens: 200,
            messages: [{ role: 'user', content: reviewPrompt }],
          });
          if (/^\s*REJECT/i.test(review)) {
            const why = review.replace(/^\s*REJECT:?\s*/i, '').trim().slice(0, 200);
            return res.json({ success: false, skipped: true, reason: 'رفضه المراجع الثاني (فحص أمان): ' + (why || 'قد يكسر الصفحة') });
          }
        } catch (e) {
          console.error('⚠️ second-AI review failed (allowing):', e.message);
        }

        // Apply the fix locally
        const newContent = fileContent.replace(searchText, replaceText);
        await fs.writeFile(filePath, newContent, 'utf8');

        // Make it PERMANENT: commit to GitHub if configured (Render disk is ephemeral)
        const github = require('./lib/github');
        let persistence = { permanent: false, url: null };
        if (github.isConfigured()) {
          try {
            const r = await github.commitFile(target, newContent, `fix(agent): ${explanation}\n\nطُبِّق تلقائياً بواسطة ${req.user.username} عبر لوحة الوكلاء`);
            persistence = { permanent: true, url: r.url };
          } catch (ghErr) {
            console.error('⚠️ GitHub commit failed:', ghErr.message);
            persistence = { permanent: false, url: null, error: ghErr.message };
          }
        }

        // Log to agent memory — full diff stored so the fix can be undone
        const logPath = path.join(__dirname, '.agent-memory', 'auto-fixes.json');
        await fs.ensureDir(path.dirname(logPath));
        let fixes = [];
        try { fixes = JSON.parse(await fs.readFile(logPath, 'utf8')); } catch {}
        const fixId = `fix_${Date.now()}`;
        fixes.push({
          id:          fixId,
          appliedAt:   new Date().toISOString(),
          appliedBy:   req.user.username,
          targetFile:  target,
          suggestion,
          explanation,
          diff:        { search: searchText, replace: replaceText },
          permanent:   persistence.permanent,
          commitUrl:   persistence.url,
          undone:      false,
        });
        const tmpLog = logPath + '.tmp';
        await fs.writeFile(tmpLog, JSON.stringify(fixes, null, 2), 'utf8');
        await fs.rename(tmpLog, logPath);

        // Clear message about whether the change is permanent
        let msg;
        if (persistence.permanent) {
          msg = `✅ تم التطبيق وحُفظ في الكود نهائياً: ${explanation}`;
        } else if (persistence.error) {
          msg = `⚠️ طُبِّق مؤقتاً فقط — تعذّر الحفظ في GitHub: ${persistence.error}`;
        } else {
          msg = `⚠️ طُبِّق مؤقتاً — لجعله دائماً أضف GITHUB_TOKEN في الإعدادات. (${explanation})`;
        }

        res.json({
          success: true,
          message: msg,
          file: target,
          fixId,
          explanation,
          permanent: persistence.permanent,
          commitUrl: persistence.url,
        });

      } catch (e) {
        console.error('❌ apply-fix error:', e.message);
        // R4 (Part P): this catch wraps fs.readFile/fs.writeFile/fs.rename on
        // a server filesystem path — e.message can include that raw path.
        res.status(500).json({ error: 'تعذّر تطبيق الإصلاح — راجع سجلات الخادم' });
      }
    });

    // Undo an applied fix (reverse the search/replace)
    app.post('/api/agents/fixes/:id/undo', requireAuth, async (req, res) => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'المدير فقط' });
      try {
        const fs   = require('fs-extra');
        const path = require('path');
        const logPath = path.join(__dirname, '.agent-memory', 'auto-fixes.json');
        let fixes = [];
        try { fixes = JSON.parse(await fs.readFile(logPath, 'utf8')); } catch {}
        const fix = fixes.find(f => f.id === req.params.id);
        if (!fix) return res.status(404).json({ error: 'الإصلاح غير موجود في السجل' });
        if (fix.undone) return res.json({ success: false, reason: 'تم التراجع عن هذا الإصلاح مسبقاً' });
        if (!fix.diff || !fix.diff.search || !fix.diff.replace) {
          return res.json({ success: false, reason: 'هذا الإصلاح قديم ولا يحمل تفاصيل كافية للتراجع' });
        }

        const filePath = path.join(__dirname, fix.targetFile);
        const content  = await fs.readFile(filePath, 'utf8');
        if (!content.includes(fix.diff.replace)) {
          return res.json({ success: false, reason: 'الكود تغيّر منذ التطبيق — لا يمكن التراجع تلقائياً' });
        }
        const reverted = content.replace(fix.diff.replace, fix.diff.search);
        await fs.writeFile(filePath, reverted, 'utf8');

        // Also revert on GitHub so the undo is permanent too
        const github = require('./lib/github');
        let undoPermanent = false;
        if (github.isConfigured()) {
          try {
            await github.commitFile(fix.targetFile, reverted, `revert(agent): تراجع عن "${fix.explanation}"\n\nبواسطة ${req.user.username}`);
            undoPermanent = true;
          } catch (ghErr) { console.error('⚠️ GitHub undo commit failed:', ghErr.message); }
        }

        fix.undone   = true;
        fix.undoneAt = new Date().toISOString();
        const tmpLog = logPath + '.tmp';
        await fs.writeFile(tmpLog, JSON.stringify(fixes, null, 2), 'utf8');
        await fs.rename(tmpLog, logPath);

        res.json({ success: true, message: undoPermanent ? '↩️ تم التراجع وحُفظ في الكود' : '↩️ تم التراجع (مؤقتاً)' });
      } catch (e) {
        // R4 (Part P): same fs.readFile/writeFile-on-a-server-path risk as
        // apply-fix above.
        console.error('❌ fix undo error:', e.message);
        res.status(500).json({ error: 'تعذّر التراجع عن الإصلاح — راجع سجلات الخادم' });
      }
    });

    // Get auto-fix history
    app.get('/api/agents/fixes', requireAuth, async (req, res) => {
      try {
        const fs   = require('fs-extra');
        const path = require('path');
        const logPath = path.join(__dirname, '.agent-memory', 'auto-fixes.json');
        const fixes = await fs.pathExists(logPath) ? JSON.parse(await fs.readFile(logPath, 'utf8')) : [];
        res.json(fixes.slice(-20).reverse());
      } catch { res.json([]); }
    });

    // Get AI cache stats (CLAUDE.md §6)
    app.get('/api/agents/cache-stats', requireAuth, (req, res) => {
      res.json(getCacheStats());
    });

    // Introspect registered GET routes — lets the system-tester auto-discover
    // every feature endpoint (so new features are covered without manual work).
    app.get('/api/agents/routes', requireAuth, (req, res) => {
      const routes = [];
      const stack = (app._router && app._router.stack) || [];
      for (const layer of stack) {
        if (layer.route && layer.route.methods && layer.route.methods.get) {
          const p = layer.route.path;
          if (typeof p === 'string' && p.startsWith('/api/') && !p.includes(':') && !p.includes('*')) {
            routes.push(p);
          }
        }
      }
      res.json({ routes: [...new Set(routes)] });
    });
  }
}

// ── Catch unhandled promise rejections ───────────────
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Promise Rejection:', reason);
});

// P0.1 — only auto-boot (connect DB, start bot, run startup auto-repair,
// bind a real port) when this file is executed directly (`node server.js`,
// exactly how `npm start` / the production process runs it). When a test
// suite does `require('./server')` to get an app for Supertest, none of this
// runs automatically — the test calls lib/database.js's initDB() itself
// against an isolated file/temp DB, exactly like tests/tenant-isolation.test.js
// already does. Zero behavior change for the real deployed process.
if (require.main === module) {
  initDB({
    mongoUri: MONGO_URI,
    dataFile: DATA_FILE,
    configFile: CONFIG_FILE,
    defaultConfig: DEFAULT_CONFIG,
    buildInitialDB,
    migrateDB,
  })
    .then(() => {
      autoStartBot();
      // إصلاح ذاتي شامل عند الإقلاع: شجرة الحسابات + قيود الرواتب الخاطئة + أرصدة
      // الموردين الممسوحة + إجماليات القيود — حتمي وآمن ومسجَّل في سجل التدقيق.
      try {
        const db = loadDB();
        const changes = runAutoRepairSuite(db);
        if (changes.length) {
          (db.auditLog = db.auditLog || []).unshift({
            id: 'AUD-' + Date.now(), at: new Date().toISOString(), user: 'system',
            action: 'auto-repair-startup', details: changes
          });
          saveDB(db);
          console.log(`🔧 Auto-repair (startup): ${changes.length} إصلاح —`, changes.map(c => `${c.action}:${c.from || ''}→${c.to || ''}`).join(', '));
        }
      } catch (e) { console.warn('⚠️ Auto-repair skipped:', e.message); }
      app.listen(PORT, () => {
        console.log(`\n✅ بوبيان للمحاسبة - يعمل على http://localhost:${PORT}`);
        console.log(`📂 البيانات محفوظة في: MongoDB (${redactMongoUri(MONGO_URI)})`);
      });
    })
    .catch(err => {
      console.error('❌ فشل الاتصال بقاعدة البيانات MongoDB:', err.message);
      process.exit(1);
    });
}

// P0.1 — export the configured Express app so tests can drive it with
// Supertest against the REAL route/middleware stack (module.exports = app is
// harmless for the direct-execution path above; Node just ignores it there).
module.exports = app;

// ═══════════════════════════════════════════════════
// AI ACCOUNTING MASTER — المحاسب الذكي المتقدم
// ═══════════════════════════════════════════════════

// ── 1. Period Lock — قفل/فتح الفترة المحاسبية ──────
app.post('/api/period-lock', requireAuth, requireAdminAction('period.lock'), async (req, res, next) => {
  try {
    const { period, locked } = req.body; // period = 'YYYY-MM'
    if (!period) return res.status(400).json({ error: 'period مطلوب' });
    const db = loadDB();
    if (!db.lockedPeriods) db.lockedPeriods = {};
    const wasLocked = !!db.lockedPeriods[period];
    db.lockedPeriods[period] = !!locked;
    appendAuditEvent(db, {
      req, action: locked ? 'period.locked' : 'period.unlocked', resourceType: 'period', resourceId: period,
      before: { locked: wasLocked }, after: { locked: !!locked },
    });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for period.locked/unlocked:', e.message);
      return res.status(500).json({ error: 'تعذّر حفظ حالة قفل الفترة بشكل دائم — حاول مرة أخرى' });
    }
    res.json({ success: true, period, locked: !!locked });
  } catch (err) {
    next(err);
  }
});

app.get('/api/period-lock', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.lockedPeriods || {});
});

// Helper: check if a date is in a locked period
function isPeriodLocked(date) {
  const db = loadDB();
  if (!db.lockedPeriods) return false;
  const period = (date || '').substring(0, 7);
  return !!db.lockedPeriods[period];
}

// ── 2. Month-End Close Checklist ──────────────────
app.get('/api/month-close/:period', requireAuth, requirePermission('journal', 'view'), (req, res) => {
  const { period } = req.params; // YYYY-MM
  const db = loadDB();
  const saved = (db.monthClose || {})[period] || {};

  // Build checklist status
  const monthDays = (db.dailyData || []).filter(d => (d.date || '').startsWith(period));
  const monthExp  = (db.expenses || []).filter(e => (e.date || '').startsWith(period));
  const monthJE   = (db.journalEntries || []).filter(j => (j.date || '').startsWith(period));
  // R3 (adversarial review): was `c.date` — never existed on a claim (real
  // field is `claimDate`), so this always filtered to an empty array,
  // showing a false "لا معلقات" all-clear at month-close regardless of real
  // outstanding claims. Also excludes 'cancelled' (P6-065).
  const pendIns   = (db.insuranceClaims || []).filter(c => (c.claimDate || '').startsWith(period) && c.status !== 'received' && c.status !== 'cancelled');
  const cashRecon = (db.cashReconciliation || []).filter(c => (c.period || '').startsWith(period));
  // P0.6B — Step 26 (NEW-A / P6-069): this checklist step read
  // `db.bankReconciliation`, a key NEVER written anywhere in the codebase
  // (confirmed by a full-repository search) — always empty, so the
  // "bank_recon" step showed 0 reconciliations regardless of how many real
  // ones existed. The actual persisted bank-reconciliation records live in
  // `db.bankRecons` (POST /api/bank-recon, keyed by account+period — see
  // that route for the real schema). Fixed to read the authoritative key;
  // no new alias introduced (there was never a legitimate reason for the
  // old name — it was simply wrong).
  const bankRecon = (db.bankRecons || []).filter(b => (b.period || '').startsWith(period));
  const payroll   = (db.payroll || []).filter(p => (p.period || '').startsWith(period));

  const steps = [
    { id: 'transactions',   label: 'رفع جميع الإيرادات والمدفوعات',         auto: monthDays.length > 0,  count: `${monthDays.length} يوم مرفوع`, manual: saved.transactions },
    { id: 'cash_recon',     label: 'تسوية الصندوق النقدي',                  auto: cashRecon.length > 0,  count: `${cashRecon.length} تسوية`, manual: saved.cash_recon },
    { id: 'bank_recon',     label: 'التسوية البنكية',                        auto: bankRecon.length > 0,  count: `${bankRecon.length} تسوية`, manual: saved.bank_recon },
    { id: 'expenses',       label: 'تسجيل جميع المصاريف',                   auto: monthExp.length > 0,   count: `${monthExp.length} مصروف`, manual: saved.expenses },
    { id: 'insurance',      label: 'مراجعة مطالبات التأمين',                auto: pendIns.length === 0,  count: pendIns.length > 0 ? `${pendIns.length} معلقة` : 'لا معلقات', manual: saved.insurance },
    { id: 'payroll',        label: 'صرف الرواتب وتسجيل قيودها',             auto: payroll.length > 0,    count: `${payroll.length} كشف`, manual: saved.payroll },
    { id: 'journal',        label: 'مراجعة القيود اليومية',                  auto: monthJE.length > 0,    count: `${monthJE.length} قيد`, manual: saved.journal },
    { id: 'accruals',       label: 'قيود الاستحقاق (مصاريف لم تُسدَّد)',    auto: false,                 count: '', manual: saved.accruals },
    { id: 'depreciation',   label: 'قيد الاستهلاك الشهري',                  auto: false,                 count: '', manual: saved.depreciation },
    { id: 'financials',     label: 'مراجعة القوائم المالية والتوقيع عليها',  auto: false,                 count: '', manual: saved.financials },
  ];

  const completed = steps.filter(s => s.auto || s.manual).length;
  const locked = (db.lockedPeriods || {})[period] || false;

  res.json({ period, steps, completed, total: steps.length, locked });
});

app.post('/api/month-close/:period/step', requireAuth, requirePermission('journal', 'edit'), (req, res) => {
  const { period } = req.params;
  const { stepId, done } = req.body;
  const db = loadDB();
  if (!db.monthClose) db.monthClose = {};
  if (!db.monthClose[period]) db.monthClose[period] = {};
  const before = db.monthClose[period][stepId];
  db.monthClose[period][stepId] = !!done;
  appendAuditEvent(db, { req, action: 'month_close.step_toggled', resourceType: 'monthClose', resourceId: `${period}/${stepId}`, before: { done: !!before }, after: { done: !!done } });
  saveDB(db);
  res.json({ success: true });
});

// ── 3. Audit Prep Agent — فحص القيود المشبوهة ────
app.post('/api/ai/audit-prep', requireAuth, requirePermission('financials', 'view'), rateLimit(5), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  const { period } = req.body;
  const db = loadDB();

  const entries = (db.journalEntries || []).filter(j =>
    !period || (j.date || '').startsWith(period)
  ).slice(0, 200);

  const expenses = (db.expenses || []).filter(e =>
    !period || (e.date || '').startsWith(period)
  ).slice(0, 200);

  const prompt = `أنت محاسب قانوني متخصص في كشف الأخطاء والتلاعب. راجع البيانات التالية وأعطني قائمة بالمخاطر باللغة العربية.

أنماط الخطر:
- مبالغ مستديرة تماماً (1000, 5000, 10000)
- مدخلات في عطل نهاية الأسبوع (جمعة/سبت)
- وصف مبهم (متنوع، تعديل، مصروف عام)
- مبالغ كبيرة غير عادية مقارنة بالمعتاد
- مصاريف بدون فئة محددة
- تكرار نفس المبلغ لنفس المورد

القيود اليومية:
${JSON.stringify(entries.slice(0,50), null, 1)}

المصاريف:
${JSON.stringify(expenses.slice(0,50), null, 1)}

أعد JSON فقط بهذا الشكل:
{"findings": [{"id": "...", "risk": "HIGH|MEDIUM|LOW", "type": "...", "description": "...", "action": "..."}], "summary": "...", "score": 0-100}`;

  try {
    const text = await callAI({
      model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }) || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    res.json(jsonMatch ? JSON.parse(jsonMatch[0]) : { findings: [], summary: 'لا توجد مخاطر', score: 100 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 4. Financial Narrative — تقرير CFO ───────────
app.post('/api/ai/financial-narrative', requireAuth, requirePermission('financials', 'view'), rateLimit(5), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  const { period } = req.body;
  const db = loadDB();

  const monthDays = (db.dailyData || []).filter(d => (d.date || '').startsWith(period));
  const prevPeriod = new Date(period + '-01');
  prevPeriod.setMonth(prevPeriod.getMonth() - 1);
  const prevStr = prevPeriod.toISOString().substring(0, 7);
  const prevDays = (db.dailyData || []).filter(d => (d.date || '').startsWith(prevStr));

  const totRev  = monthDays.reduce((s, d) => s + (d.total || 0), 0);
  const prevRev = prevDays.reduce((s, d) => s + (d.total || 0), 0);
  const totExp  = (db.expenses || []).filter(e => (e.date || '').startsWith(period)).reduce((s, e) => s + (e.amount || 0), 0);
  const prevExp = (db.expenses || []).filter(e => (e.date || '').startsWith(prevStr)).reduce((s, e) => s + (e.amount || 0), 0);
  const totIns  = monthDays.reduce((s, d) => s + (d.insurance || 0), 0);
  const totCash = monthDays.reduce((s, d) => s + (d.cash || 0), 0);
  const totKnet = monthDays.reduce((s, d) => s + (d.knet || 0), 0);

  // Expenses by category
  const expByCat = {};
  (db.expenses || []).filter(e => (e.date || '').startsWith(period)).forEach(e => {
    expByCat[e.cat || 'أخرى'] = (expByCat[e.cat || 'أخرى'] || 0) + (e.amount || 0);
  });
  const topExp = Object.entries(expByCat).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const data = {
    period, currency: 'د.ك',
    revenue: { current: totRev, previous: prevRev, change_pct: prevRev ? ((totRev - prevRev) / prevRev * 100).toFixed(1) : 0 },
    expenses: { current: totExp, previous: prevExp, change_pct: prevExp ? ((totExp - prevExp) / prevExp * 100).toFixed(1) : 0 },
    net_profit: totRev - totExp,
    revenue_mix: { cash: totCash, knet: totKnet, insurance: totIns },
    top_expense_categories: topExp,
    work_days: monthDays.filter(d => d.total > 0).length
  };

  const prompt = `أنت مدير مالي CFO خبير. اكتب تقريراً تنفيذياً باللغة العربية للفترة ${period} بناءً على البيانات التالية.

البيانات:
${JSON.stringify(data, null, 2)}

اكتب التقرير بهذا التنسيق:
1. **ملخص الأداء** (فقرة واحدة - 3 جمل، أرقام محددة)
2. **تحليل الإيرادات** (فقرة واحدة - قارن بالشهر السابق)
3. **تحليل المصاريف** (فقرة واحدة - أكبر 3 بنود)
4. **المخاطر والفرص** (3 نقاط)

استخدم الأرقام بالدينار الكويتي. كن محدداً ومهنياً. لا تزيد عن 350 كلمة.`;

  try {
    const narrative = await callAI({
      model: 'claude-sonnet-4-6', max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }) || '';
    res.json({ narrative, data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 5. OCR فواتير — استخراج بيانات الفاتورة ──────
const uploadImg = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('صور فقط (JPG, PNG, PDF, WebP)'));
    cb(null, true);
  }
});

app.post('/api/ai/ocr-invoice', requireAuth, requirePermission('expenses', 'add'), uploadImg.single('file'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  if (!req.file) return res.status(400).json({ error: 'الملف مطلوب' });

  try {
    const imageData = fs.readFileSync(req.file.path);
    const base64 = imageData.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const db = loadDB();
    const coa = (db.chartOfAccounts || []).filter(a => !a.isGroup).map(a => `${a.code}: ${a.name}`).join('\n');
    const vendors = (db.vendors || []).map(v => v.name).join(', ');

    const text = await callAIVision({
      model: 'claude-sonnet-4-6',
      base64Image: base64,
      mediaType: mimeType,
      max_tokens: 1000,
      prompt: `استخرج بيانات هذه الفاتورة وأعد JSON فقط:

دليل الحسابات المتاحة:
${coa}

الموردون المسجلون: ${vendors}

أعد:
{
  "vendor": "اسم المورد",
  "vendor_match": "اسم المورد المطابق من القائمة أو null",
  "date": "YYYY-MM-DD",
  "invoice_number": "رقم الفاتورة",
  "amount": 0.000,
  "tax": 0.000,
  "total": 0.000,
  "description": "وصف المشتريات",
  "suggested_account": "كود الحساب المقترح",
  "suggested_account_name": "اسم الحساب",
  "confidence": 0.0,
  "items": [{"description": "", "qty": 0, "unit_price": 0, "total": 0}]
}`,
    }) || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    fs.removeSync(req.file.path);
    res.json(jsonMatch ? JSON.parse(jsonMatch[0]) : { error: 'لم يتمكن AI من قراءة الفاتورة' });
  } catch(e) {
    try { fs.removeSync(req.file.path); } catch(_) {}
    // R4 (Part P) — the confirmed filesystem-path-leaking OCR route: this
    // catch wraps fs.readFileSync(req.file.path); a missing/corrupt multer
    // temp file throws Node's raw "ENOENT ... open 'uploads/...'" text,
    // exposing the server's upload directory layout to any authenticated
    // user with expense-add permission.
    console.error('❌ OCR invoice error:', e.message);
    res.status(500).json({ error: 'تعذّر قراءة الفاتورة — تأكد من الملف وحاول مرة أخرى' });
  }
});

// ═══════════════════════════════════════════════════
// CONFIG ENGINE — إعدادات التخصيص
// ═══════════════════════════════════════════════════
// P0.4A — Step 9: loadConfig() returns the SAME underlying store that
// POST /api/settings/report writes smtpPass into (they share one config.json/
// AppConfig document) — this route was serializing that secret to every
// authenticated user. GET /api/settings/report already excluded it
// correctly; this route didn't. Stripped here rather than gating the whole
// route to admin, since brand/nav/commissionFormula genuinely are needed by
// every role's UI.
app.get('/api/config', requireAuth, (req, res) => {
  const { smtpPass, ...safeConfig } = loadConfig();
  res.json(safeConfig);
});

app.put('/api/config', requireAuth, requirePermission('settings', 'edit'), (req, res) => {
  try {
    const current = loadConfig();
    const db = loadDB();
    // Deep merge
    const updated = {
      brand:             { ...current.brand,             ...(req.body.brand             || {}) },
      modules:           { ...current.modules,           ...(req.body.modules           || {}) },
      labels:            { ...current.labels,            ...(req.body.labels            || {}) },
      nav:               { ...current.nav,               ...(req.body.nav               || {}) },
      commissionFormula: { ...current.commissionFormula, ...(req.body.commissionFormula || {}) },
      dashboard:         { kpi: { ...(current.dashboard?.kpi||{}), ...(req.body.dashboard?.kpi||{}) } },
      importTemplates:   { ...(current.importTemplates||{}), ...(req.body.importTemplates||{}) },
      automation:        Object.fromEntries(
        Object.entries({ ...(current.automation||{}), ...(req.body.automation||{}) })
          .map(([k,v]) => [k, typeof v === 'object' ? { ...((current.automation||{})[k]||{}), ...v } : v])
      ),
    };
    if (req.body.commissionFormula?.tiers) updated.commissionFormula.tiers = req.body.commissionFormula.tiers;
    // R4 (Part N): these four scalars are READ by the daily-income posting
    // math (processDailyIncomeUpload, server.js ~line 1452-1458 — insurance
    // deduction rate, K-Net/card network fees, the "حسابي" clearing-account
    // cutover month) but until now had NO write path at all — not this
    // route, not /api/settings/report. They were pure hardcoded defaults
    // dressed up as "configurable" (R1/R3 flagged "no UI"; the deeper truth
    // found while writing Part N's settings→posting test is there was no
    // backend route either). Plumbed here as plain scalar overrides — same
    // pattern as the existing brand/modules fields above — with no change
    // to the calculation logic itself or its defaults when unset.
    //
    // R4 adversarial-review fix (Frontend-Security persona, HIGH): the
    // `typeof === 'number'` checks alone accepted ANY finite value with no
    // range check — reachable by any role granted only ('settings','edit'),
    // not just a full admin (requirePermission, not requireAdminAction).
    // A rate like feeCard:0.9 posts a fully balanced journal entry that
    // silently misroutes ~90% of every card transaction into the bank-fee
    // expense account instead of the real clearing account — no validator
    // in the app catches it, since validateJournalEntry has no business-
    // range invariant and the entry balances perfectly. A rate >1 makes the
    // computed net negative, which validateJournalEntry DOES reject
    // (UNBALANCED or NEGATIVE_AMOUNT) but with a confusing error on the
    // NEXT unrelated upload, giving no indication a bad settings value is
    // the actual cause. A fee/deduction rate must be a fraction in [0,1).
    const RATE_FIELDS = ['insDeductionRate', 'feeKnet', 'feeCard'];
    for (const f of RATE_FIELDS) {
      const v = req.body[f];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 1)) {
        return res.status(400).json({ error: `${f} يجب أن تكون نسبة عشرية بين 0 و1 (مثال: 0.0265 لعمولة 2.65%)` });
      }
    }
    if (req.body.hesabiStartMonth !== undefined && !/^\d{4}-\d{2}$/.test(String(req.body.hesabiStartMonth))) {
      return res.status(400).json({ error: 'hesabiStartMonth يجب أن تكون بصيغة YYYY-MM' });
    }
    if (typeof req.body.insDeductionRate === 'number')  updated.insDeductionRate  = req.body.insDeductionRate;
    else if (current.insDeductionRate !== undefined)     updated.insDeductionRate  = current.insDeductionRate;
    if (typeof req.body.feeKnet === 'number')            updated.feeKnet           = req.body.feeKnet;
    else if (current.feeKnet !== undefined)              updated.feeKnet           = current.feeKnet;
    if (typeof req.body.feeCard === 'number')            updated.feeCard           = req.body.feeCard;
    else if (current.feeCard !== undefined)              updated.feeCard           = current.feeCard;
    if (typeof req.body.hesabiStartMonth === 'string')   updated.hesabiStartMonth  = req.body.hesabiStartMonth;
    else if (current.hesabiStartMonth !== undefined)     updated.hesabiStartMonth  = current.hesabiStartMonth;
    saveConfig(updated);
    appendAuditEvent(db, { req, action: 'config.updated', resourceType: 'config', before: { brand: current.brand, commissionFormula: current.commissionFormula }, after: { brand: updated.brand, commissionFormula: updated.commissionFormula } });
    saveDB(db);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Recalculate all commissions with new formula (called after formula change)
app.post('/api/config/recalc-commissions', requireAuth, requireAdminAction('commissions.recalculate'), (req, res) => {
  try {
    const db = loadDB();
    db.commissionHistory = db.commissionHistory || [];
    const groups = {};
    // P0.6A — Step 20 (P6-032): the previous "aggregate from dailyData"
    // branch was dead code — parseDailyIncome() never produces a `.doctor`
    // field on any row, so `if (!r.doctor) return;` short-circuited every
    // single row unconditionally. Removed. paymentsData IS the real,
    // granular per-doctor revenue source (it carries `.doctor`/`.total`) —
    // it was already being grouped here but the actual `+= p.total`
    // accumulation line was missing, so every doctor's recalculated revenue
    // (and therefore commission) was silently zero.
    (db.paymentsData || []).forEach(p => {
      if (!p.doctor || p.doctor === 'Advance') return;
      const k = `${p.doctor}|${getMonth(p.date)}`;
      if (!groups[k]) groups[k] = { doctor: p.doctor, month: getMonth(p.date), revenue: 0 };
      groups[k].revenue += (parseFloat(p.total) || 0);
    });
    let created = 0, updated = 0, skippedPaid = 0;
    for (const key of Object.keys(groups)) {
      const g  = groups[key];
      if (!g.doctor || !g.month) continue;
      const dr = (db.doctors || []).find(d => d.name === g.doctor);
      if (!dr) continue;
      const commission = calcCommission(dr, g.revenue);
      const existing   = db.commissionHistory.find(c => c.doctor === g.doctor && c.month === g.month);
      // P0.6A — Step 20 (P6-031): never overwrite an already-paid period —
      // see the identical guard/rationale in updateCommissions() above.
      if (existing && existing.paid) { skippedPaid++; continue; }
      const netCommission = parseFloat(commission.toFixed(3));
      let commRecord;
      if (existing) {
        existing.revenue = g.revenue;
        existing.commission = netCommission;
        commRecord = existing;
        updated++;
      } else {
        commRecord = {
          id: genId('comm-'),
          doctor: g.doctor,
          month: g.month,
          revenue: parseFloat(g.revenue.toFixed(3)),
          commission: netCommission,
          paid: false,
          payMethod: '',
          payDate: '',
          recognizedAmount: 0,
          recognitionJeIds: [],
        };
        db.commissionHistory.push(commRecord);
        created++;
      }
      // P0.6B — Step 10 (P6-030): the SAME shared recognition helper
      // updateCommissions() uses — one source of truth for the liability
      // journal, not a second divergent posting path for the admin-
      // triggered recalculation.
      try {
        recognizeCommissionLiability(db, commRecord, netCommission);
      } catch (e) {
        if (!(e instanceof JournalValidationError)) throw e;
        console.warn(`⚠️ تخطي استحقاق عمولة ${g.doctor}/${g.month}: ${e.message}`);
      }
    }
    appendAuditEvent(db, { req, action: 'commissions.recalculated', resourceType: 'commissionHistory', after: { groupsProcessed: Object.keys(groups).length, created, updated, skippedPaid } });
    saveDB(db);
    res.json({ success: true, recalculated: Object.keys(groups).length, created, updated, skippedPaid });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Company info endpoints
app.get('/api/company', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.companyInfo || {});
});

app.post('/api/company', requireAuth, requireAdminAction('company.update'), (req, res) => {
  const db = loadDB();
  const before = { ...(db.companyInfo || {}) };
  // Allowlist fields — prevent mass assignment
  const { name, nameEn, logo, currency, phone, email, address, taxNo, crNo, fiscalYearStart } = req.body;
  db.companyInfo = { ...db.companyInfo, name, nameEn, logo, currency, phone, email, address, taxNo, crNo, fiscalYearStart };
  appendAuditEvent(db, { req, action: 'company.updated', resourceType: 'companyInfo', before, after: db.companyInfo });
  saveDB(db);
  res.json({ success: true });
});

// ===== VENDORS API =====
app.get('/api/vendors', requirePermission('vendors', 'view'), (req, res) => {
  const db = loadDB();
  // شفاء تلقائي: أعِد إنشاء القيد الافتتاحي لأي مورد رصيده الافتتاحي مخزّن لكن قيده
  // مفقود (حُذف سابقاً بخطأ شاشة الأرصدة الافتتاحية). idempotent — يعمل مرة واحدة.
  let healed = 0;
  (db.vendors || []).forEach(v => {
    const amt = parseFloat(v.openingBalance) || 0;
    if (amt <= 0) return;
    const jeId = 'JE-VND-OPEN-' + v.id;
    const je = (db.journalEntries || []).find(e => e.id === jeId);
    if (!je) {
      setVendorOpening(db, v, amt, v.openingDate);
      healed++;
    } else {
      // نظّف المرجع القديم الطويل (OPEN-VND-<timestamp>) إلى مرجع قصير مقروء
      const cleanRef = 'OB-' + (v.accountId || v.id);
      if (je.ref !== cleanRef || je.reference !== cleanRef) {
        je.ref = cleanRef; je.reference = cleanRef;
        healed++;
      }
    }
  });
  if (healed) saveDB(db);
  res.json(db.vendors || []);
});

// إنشاء/تحديث القيد الافتتاحي للمورد: مدين «أرصدة افتتاحية» / دائن حساب المورد
// (المورد التزام — الرصيد الافتتاحي يعني أننا مدينون له)
function setVendorOpening(db, vendor, amount, date) {
  db.journalEntries = db.journalEntries || [];
  const jeId = 'JE-VND-OPEN-' + vendor.id;
  // P0.3: removing the previous opening-balance JE must NOT happen until we
  // know the replacement (or the "clear to zero" outcome) is actually going
  // to commit — doing it unconditionally up front meant a REJECTED re-post
  // (locked period) deleted the old, still-valid opening entry and left the
  // vendor with none at all.
  const removeOldJe = () => {
    db.journalEntries = db.journalEntries.filter(e =>
      e.id !== jeId && e.ref !== 'OPEN-' + vendor.id && e.reference !== 'OPEN-' + vendor.id);
  };
  const amt = parseFloat(amount) || 0;
  if (amt <= 0) { removeOldJe(); vendor.openingBalance = amt; return; }

  // حساب أرصدة افتتاحية (حقوق ملكية) — أنشئه إن لم يوجد
  const coa = db.chartOfAccounts || [];
  let openAcc = coa.find(a => a.code === '3900');
  if (!openAcc) {
    openAcc = { id: '3900', code: '3900', name: 'أرصدة افتتاحية', type: 'equity', parent: '3000', parentId: '3000', normalBalance: 'credit', status: 'active', balance: 0, createdAt: new Date().toISOString() };
    coa.push(openAcc);
    db.chartOfAccounts = coa;
  }
  const vAcc = coa.find(a => a.id === vendor.accountId || a.code === vendor.accountId) || { id: vendor.accountId, code: vendor.accountId, name: vendor.name };
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? date : new Date().toISOString().slice(0, 10);
  const openRef = 'OB-' + (vendor.accountId || vendor.id);
  const je = {
    id: jeId, date: d,
    desc: `رصيد افتتاحي — ${vendor.name}`, description: `رصيد افتتاحي — ${vendor.name}`,
    ref: openRef, reference: openRef, type: 'vendor-opening', source: 'vendor-opening',
    autoGenerated: true, totalDebit: amt, totalCredit: amt, createdAt: new Date().toISOString(),
    lines: [
      { accountId: openAcc.id, accountCode: '3900', accountName: openAcc.name, debit: amt, credit: 0 },
      { accountId: vAcc.id, accountCode: vAcc.code, accountName: vAcc.name, debit: 0, credit: amt },
    ],
  };
  // P0.3 — Pattern A: validate BEFORE mutating vendor.openingBalance. This
  // function also runs as silent self-healing from GET /api/vendors — a
  // locked-period/invalid-account rejection must neither break a plain read
  // nor leave the vendor's openingBalance field diverged from its journal.
  const result = validateJournalEntry(db, je);
  if (!result.ok) {
    console.warn(`⚠️ تخطي قيد رصيد افتتاحي للمورد ${vendor.name}: ${result.error}`);
    return; // old JE (if any) is left completely intact
  }
  removeOldJe();
  vendor.openingBalance = amt;
  db.journalEntries.push(je);
}

// P0.12 (closes P6-097 for vendor CREATION — no dedup of any kind existed;
// also fixes a P0.11-class durability gap on the same route: this handler
// was still non-async fire-and-forget saveDB(db), which idempotency
// completion tracking depends on being durable — see lib/idempotency.js).
app.post('/api/vendors', requirePermission('vendors', 'add'), async (req, res, next) => {
 try {
  const db = loadDB();
  if (!db.vendors) db.vendors = [];
  const body = req.body;
  const isEdit = body.id && db.vendors.some(v => v.id === body.id);
  const isMongo = !isFileFallbackMode();

  if (isEdit) {
    const idx = db.vendors.findIndex(v => v.id === body.id);
    const beforeVendor = { ...db.vendors[idx] };
    // P0.3: openingBalance/openingDate must NOT be merged directly from the
    // request — setVendorOpening() below is the sole writer of that field,
    // and only commits it once the resulting journal entry actually
    // validates (period not locked, etc). Spreading it here unconditionally
    // meant a REJECTED posting still left the vendor's openingBalance
    // overwritten with the rejected value.
    const { openingBalance, openingDate, ...rest } = body;
    db.vendors[idx] = { ...db.vendors[idx], ...rest };
    const coa = db.chartOfAccounts || [];
    const caIdx = coa.findIndex(a => a.id === db.vendors[idx].accountId);
    if (caIdx !== -1) coa[caIdx].name = body.name;
    db.chartOfAccounts = coa;
    // حدّث الرصيد الافتتاحي إن أُرسل — setVendorOpening() itself is already
    // upsert-safe (always removes any prior opening JE for this vendor
    // before posting the replacement), so the edit path needs no additional
    // idempotency key handling — see the P0.12 forensic inventory.
    if (openingBalance !== undefined) setVendorOpening(db, db.vendors[idx], openingBalance, openingDate);
    appendAuditEvent(db, { req, action: 'vendor.updated', resourceType: 'vendor', resourceId: body.id, before: beforeVendor, after: db.vendors[idx] });
    await saveDB(db, { durable: true });
    return res.json({ success: true, vendor: db.vendors[idx] });
  }

  // R5 (staging validation, adversarial review — P1, live-reproduced): an
  // empty {} body silently created a permanent, nameless vendor AND a
  // permanent, nameless liability account under the AP tree (neither
  // `name: body.name` in the vendor object below nor in the pushed COA
  // entry was ever null-checked). Sibling create routes already reject this
  // correctly (POST /api/patients {} -> "اسم المريض مطلوب", POST
  // /api/doctors {} -> "doctors must be array", POST /api/insurance-claims
  // {} -> "missing fields") — vendors had no equivalent guard at all.
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ success: false, error: 'اسم المورد مطلوب' });
  }

  // P0.12 — CREATE path only (the edit path above is naturally idempotent).
  const idemKey = extractIdempotencyKey(req);
  let idemRecord = null;
  if (idemKey) {
    const v = validateIdempotencyKey(idemKey);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
    const fingerprint = computeFingerprint('vendor:create', { name: body.name, type: body.type, phone: body.phone, email: body.email, openingBalance: body.openingBalance });
    const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'vendor:create', idemKey, fingerprint);
    if (!claim.claimed && claim.record.status === 'COMPLETED') {
      return res.json({ success: true, idempotentReplay: true, vendor: claim.record.resultReference });
    }
    idemRecord = claim.record;
  }

  // P0.6A — Step 19 (P6-003): the old ad-hoc `maxCode+1` scan only checked
  // siblings already parented under 2100 — it never checked the FULL chart
  // of accounts, so the 100th vendor collided with the hard-coded 2200
  // "الرواتب المستحقة الدفع" account (validateJournalEntry resolves a
  // duplicate code to whichever account is first in the array, silently
  // commingling vendor AP postings with payroll-payable postings). Now
  // routed through the same collision-safe, hierarchy-aware generator
  // POST /api/coa/account itself uses — it checks the ENTIRE chart, and
  // cascades into a sub-group instead of colliding once 2100's direct
  // slots (2110-2190) are full.
  const coa = db.chartOfAccounts || [];
  const { suggestChildCode } = require('./lib/coaCodes');
  const codeSuggestion = suggestChildCode('2100', coa);
  if (!codeSuggestion) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    return res.status(409).json({ success: false, error: 'تعذّر توليد كود حساب جديد للمورد — شجرة الحسابات ممتلئة تحت 2100 (الذمم الدائنة). راجع شجرة الحسابات يدوياً.' });
  }
  const accountCode = codeSuggestion.code;

  const newVendor = {
    id:          'VND-' + Date.now(),
    accountId:   accountCode,
    name:        body.name,
    type:        body.type        || 'أخرى',
    phone:       body.phone       || '',
    email:       body.email       || '',
    address:     body.address     || '',
    terms:       body.terms       || 'نقد',
    creditLimit: body.creditLimit || 0,
    notes:       body.notes       || '',
    createdAt:   new Date().toISOString(),
  };

  db.vendors.push(newVendor);
  // Parent to whatever suggestChildCode() actually resolved — normally
  // '2100' directly, but it may be a cascaded sub-group (e.g. '2110') once
  // 2100's own direct slots are full; hardcoding '2100' here regardless of
  // where the code was actually generated would break the parent/child
  // tree the generator just built.
  db.chartOfAccounts = [...coa, { id: accountCode, code: accountCode, name: body.name, type: 'liability', parent: codeSuggestion.parentCode, parentId: codeSuggestion.parentCode, balance: 0 }];
  try {
    // الرصيد الافتتاحي للمورد (إن وُجد) → قيد افتتاحي
    if (body.openingBalance) setVendorOpening(db, newVendor, body.openingBalance, body.openingDate);
  } catch (mutErr) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    throw mutErr;
  }
  appendAuditEvent(db, { req, action: 'vendor.created', resourceType: 'vendor', resourceId: newVendor.id, after: { name: newVendor.name, type: newVendor.type } });
  if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, newVendor, newVendor.id, null);
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    throw e;
  }
  if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
  res.json({ success: true, vendor: newVendor });
 } catch (err) {
  next(err);
 }
});

app.delete('/api/vendors/:id', requirePermission('vendors', 'delete'), (req, res) => {
  const db = loadDB();
  const vendor = (db.vendors || []).find(v => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ success: false, message: 'مورد غير موجود' });
  // P0.9 — Part G (newly discovered while enumerating financial delete
  // routes): this route previously deleted the vendor record unconditionally
  // — a real orphaning risk once vendorBills[] exists (P0.7): a bill's
  // vendorId would point at nothing, breaking vendorApOutstanding()/AP
  // aging/the vendor statement for that bill. A vendor with a posted
  // opening-balance journal is likewise never truly "unused" even with zero
  // vendorBills.
  const hasBills = (db.vendorBills || []).some(b => b.vendorId === vendor.id);
  if (hasBills)
    return res.status(409).json({ success: false, message: 'لا يمكن حذف المورد — له فواتير في دفتر الذمم الدائنة', code: 'VENDOR_HAS_BILLS' });
  if ((parseFloat(vendor.openingBalance) || 0) > 0.001)
    return res.status(409).json({ success: false, message: 'لا يمكن حذف المورد — له رصيد افتتاحي مُرحَّل', code: 'VENDOR_HAS_OPENING_BALANCE' });
  db.vendors = db.vendors.filter(v => v.id !== req.params.id);
  const hasEntries = (db.journalEntries || []).some(e => e.lines.some(l => l.accountId === vendor.accountId));
  if (!hasEntries) db.chartOfAccounts = (db.chartOfAccounts || []).filter(a => a.id !== vendor.accountId);
  appendAuditEvent(db, { req, action: 'vendor.deleted', resourceType: 'vendor', resourceId: vendor.id, before: { name: vendor.name } });
  saveDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// ACCOUNTS PAYABLE — دفتر تبعية الذمم الدائنة (P0.7)
// ═══════════════════════════════════════════════════════════════════════
// P0.7 — Part A (Step 1): forensic map of every pre-existing "money owed to
// a supplier" mechanism in this codebase, and why none of them alone is a
// coherent AP subledger:
//   • db.vendors[].openingBalance — a real liability (setVendorOpening()
//     posts Dr 3900/Cr vendor's own COA sub-account) but it is a SNAPSHOT,
//     not a transaction stream: no bill, no due date, no partial-payment
//     tracking of its own.
//   • db.accruedExpenses[] — a genuine payable lifecycle (amount/paidAmount/
//     remaining/payments[]/status, real journals) but modeled as a generic
//     accrual (`vendor` is free text, not linked to db.vendors), and
//     account-agnostic (credits 2900, shared with non-vendor accruals).
//   • db.expenses[] with payMethod:'accrued' — credits 2900 too, but with
//     NO settlement-tracking field at all (P6-027's original finding).
//   • db.vouchers[] — a general-purpose cash-movement instrument (any
//     `lines[]` can touch any account, including a vendor's own account)
//     with no concept of "bill," "outstanding," or vendor statement.
// AUTHORITATIVE going forward for a real supplier bill: vendor.accountId
// itself — every vendor already has ONE dedicated COA sub-account under
// 2100 (server.js POST /api/vendors, P0.6A's P6-003 fix), and
// setVendorOpening() already posts real liability journals against it. The
// new `db.vendorBills[]` below reuses this EXACT existing account per
// vendor as its liability/"AP control" account — NOT a new invented shared
// code — so posting a bill, paying it, and the vendor's pre-existing
// opening balance all land on the SAME real GL account per vendor, and the
// aggregate "AP control total" for reconciliation is simply the sum of
// every vendor's own account balance (the natural group-total of the 2100
// parent, exactly how a real subsidiary ledger control account works).
// LEGACY / UNCHANGED (Step 21-23, no auto-migration, no deletion):
// accruedExpenses[], payMethod:'accrued' expenses, and vouchers all keep
// their exact current behavior — see the dedicated comments at each and
// docs/AP_HISTORICAL_MIGRATION_PLAN.md for how they relate to vendorBills.

// Status model (Step 3): POSTED -> PARTIALLY_PAID -> PAID, or -> CANCELLED.
// No DRAFT state: every other creation route in this codebase (expenses,
// accruedExpenses, vouchers) posts to the GL immediately on creation, with
// no existing staged draft-then-post workflow anywhere to extend — adding
// one here alone would be an unjustified, disconnected new concept. A bill
// is therefore always POSTED (has a real GL journal) the instant it exists.

function nextBillNo(db) {
  const all = db.vendorBills || [];
  const nums = all.map(b => parseInt((b.number || '0').replace(/\D/g, '')) || 0);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `BILL-${String(next).padStart(4, '0')}`;
}

// P0.7 — Steps 4-7: builds + validates + posts a supplier bill. Pure
// prepare-then-commit (P0.3 pattern): validates the FULL candidate journal
// before touching db.vendorBills — a rejected posting (locked period,
// unbalanced allocation, unknown account) mutates nothing.
function buildAndPostVendorBill(db, data, actorReq) {
  const { vendorId, billNumber, billDate, dueDate, description, allocations } = data;
  const vendor = (db.vendors || []).find(v => v.id === vendorId);
  if (!vendor) { const e = new Error('المورد غير موجود'); e.status = 400; e.code = 'UNKNOWN_VENDOR'; throw e; }
  if (!billDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(billDate))) {
    const e = new Error('تاريخ الفاتورة مطلوب بصيغة صحيحة (YYYY-MM-DD)'); e.status = 400; e.code = 'INVALID_DATE'; throw e;
  }
  if (!Array.isArray(allocations) || !allocations.length) {
    const e = new Error('يجب تحديد بند تخصيص واحد على الأقل'); e.status = 400; e.code = 'NO_ALLOCATIONS'; throw e;
  }
  // Step 7: duplicate-bill heuristic — same vendor + same non-empty bill
  // number is almost certainly a re-entry, not two genuinely different
  // bills. Never required globally (some real supplier documents have no
  // number), only checked when a number IS supplied.
  const billNo = billNumber ? String(billNumber).trim() : '';
  if (billNo) {
    const dupe = (db.vendorBills || []).find(b => b.vendorId === vendorId && String(b.billNumber || '').trim() === billNo && b.status !== 'CANCELLED');
    if (dupe) {
      const e = new Error(`فاتورة بنفس الرقم (${billNo}) موجودة بالفعل لهذا المورد — راجع الفاتورة #${dupe.id} قبل الإضافة`);
      e.status = 409; e.code = 'DUPLICATE_BILL'; throw e;
    }
  }

  const coa = db.chartOfAccounts || [];
  const cleanAllocs = allocations.map(a => {
    const amt = parseFloat(a.amount);
    if (!(amt > 0)) { const e = new Error('كل بند تخصيص يجب أن يحمل مبلغًا موجبًا'); e.status = 400; e.code = 'INVALID_ALLOCATION'; throw e; }
    const acc = coa.find(x => String(x.code) === String(a.accountCode) || String(x.id) === String(a.accountCode));
    if (!acc) { const e = new Error(`حساب التخصيص ${a.accountCode} غير موجود في شجرة الحسابات`); e.status = 400; e.code = 'UNKNOWN_ACCOUNT'; throw e; }
    return { accountCode: acc.code, accountId: acc.id, accountName: acc.name, amount: parseFloat(amt.toFixed(3)), desc: a.desc || '' };
  });
  const grossAmount = parseFloat(cleanAllocs.reduce((s, a) => s + a.amount, 0).toFixed(3));

  const vendorAcc = coa.find(a => a.id === vendor.accountId || a.code === vendor.accountId);
  if (!vendorAcc) { const e = new Error('حساب المورد المحاسبي غير موجود — راجع بيانات المورد'); e.status = 400; e.code = 'UNKNOWN_VENDOR_ACCOUNT'; throw e; }

  const id = 'BILL-' + Date.now();
  const jeId = 'JE-BILL-' + id;
  const lines = [
    ...cleanAllocs.map(a => ({ accountId: a.accountId, accountCode: a.accountCode, accountName: a.accountName, debit: a.amount, credit: 0 })),
    { accountId: vendorAcc.id, accountCode: vendorAcc.code, accountName: vendorAcc.name, debit: 0, credit: grossAmount },
  ];
  const candidateJe = {
    id: jeId, date: billDate,
    desc: `فاتورة مورد — ${vendor.name}${billNo ? ' — #' + billNo : ''}`,
    ref: 'BILL-' + id, reference: 'BILL-' + id, type: 'vendor-bill',
    source: 'vendor-bill', sourceId: id, sourceModule: 'accounts-payable',
    totalDebit: grossAmount, totalCredit: grossAmount,
    createdAt: new Date().toISOString(), lines,
  };
  // Validate the full candidate journal (balance/accounts/period-lock)
  // BEFORE committing anything (P0.3 pattern) — appendJournalEntry() itself
  // both validates and pushes atomically, throwing without mutating on failure.
  appendJournalEntry(db, candidateJe);

  const bill = {
    id, number: nextBillNo(db),
    vendorId, vendorName: vendor.name,
    billNumber: billNo, billDate, dueDate: dueDate || '',
    description: description || '',
    grossAmount, paidAmount: 0, creditedAmount: 0, outstandingAmount: grossAmount,
    status: 'POSTED',
    allocations: cleanAllocs,
    liabilityAccountCode: vendorAcc.code,
    journalId: jeId,
    payments: [], credits: [], cancellation: null,
    source: 'vendor-bill', sourceId: id,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    createdBy: actorReq?.user?.username || 'system',
  };
  if (!db.vendorBills) db.vendorBills = [];
  db.vendorBills.push(bill);
  return bill;
}

// P0.12 (closes P6-097 — the pre-existing billNumber+vendorId duplicate
// guard inside buildAndPostVendorBill() is entirely opt-in: a bill with no
// billNumber at all, a real and explicitly-supported case per that
// function's own comment, gets zero protection. Layered here, not replacing
// the existing guard, per Part G's "don't remove a real domain invariant").
app.post('/api/vendor-bills', requireAuth, requirePermission('vendors', 'add'), async (req, res, next) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const db = loadDB();

    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const b = req.body || {};
      const fingerprint = computeFingerprint('vendor-bill:create', { vendorId: b.vendorId, billNumber: b.billNumber, billDate: b.billDate, description: b.description, allocations: b.allocations });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'vendor-bill:create', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, bill: claim.record.resultReference });
      }
      idemRecord = claim.record;
    }

    let bill;
    try {
      bill = buildAndPostVendorBill(db, req.body, req);
    } catch (e) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      if (e.status) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }
    appendAuditEvent(db, { req, action: 'vendor_bill.posted', resourceType: 'vendorBill', resourceId: bill.id, after: { vendor: bill.vendorName, amount: bill.grossAmount, billNumber: bill.billNumber } });
    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, bill, bill.id, bill.journalId);
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for vendor_bill.posted:', e.message);
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ الفاتورة بشكل دائم — حاول مرة أخرى' });
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, bill });
  } catch (err) {
    next(err);
  }
});

app.get('/api/vendor-bills', requireAuth, requirePermission('vendors', 'view'), (req, res) => {
  const db = loadDB();
  let bills = db.vendorBills || [];
  if (req.query.vendorId) bills = bills.filter(b => b.vendorId === req.query.vendorId);
  if (req.query.status)   bills = bills.filter(b => b.status === req.query.status);
  res.json(bills.slice().sort((a, b) => (b.billDate || '').localeCompare(a.billDate || '')));
});

// P0.7 — Steps 8-11: pay a supplier bill. Settles the LIABILITY
// (Dr vendor account / Cr Bank-Cash) — never re-recognizes the expense.
// Idempotent via an optional client-supplied `clientRef`: a retried HTTP
// request with the same clientRef returns the ORIGINAL payment result
// rather than creating a second financial effect.
app.post('/api/vendor-bills/:id/pay', requireAuth, requirePermission('vendors', 'edit'), async (req, res, next) => {
  try {
    const db = loadDB();
    const bill = (db.vendorBills || []).find(b => b.id === req.params.id);
    if (!bill) return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
    if (bill.status === 'CANCELLED') return res.status(409).json({ success: false, error: 'لا يمكن الدفع لفاتورة مُلغاة', code: 'BILL_CANCELLED' });

    const { amount, payDate, payAccount, checkNo, clientRef } = req.body;
    const amt = parseFloat(amount);

    // P0.12 adversarial-review fix (P0, confirmed): the idempotency claim
    // MUST be taken before ANY read of bill.outstandingAmount used for
    // validation below — in Mongo mode the claim performs a real await (a
    // genuine event-loop yield that did not exist before P0.12 introduced
    // it), so two concurrent requests carrying DIFFERENT keys (never
    // deduplicated against each other) could otherwise both read the same
    // stale outstandingAmount before either mutates, both pass the
    // overpayment check, and both post a real duplicate payment. Claiming
    // first restores the pre-P0.12 guarantee: once this await resolves,
    // the clientRef/overpayment checks and the mutation below run with no
    // further await between them, atomically per request again.
    const isMongo = !isFileFallbackMode();
    const idemKey = extractIdempotencyKey(req);
    let idemRecord = null;
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      // P0.12 adversarial-review fix: date is deliberately excluded from this
      // fingerprint. This route has a pre-existing clientRef-only equality
      // domain guard (below) that never treated date as part of the
      // operation's identity; including it here would make the generic
      // fingerprint layer reject same-clientRef retries with a different
      // date before that domain guard ever runs, silently narrowing its
      // established contract. See tests/p0-11-persistence-durability.test.js
      // "Idempotency C".
      const fingerprint = computeFingerprint('vendor-bill:pay', { id: bill.id, amount: parseFloat((amt || 0).toFixed(3)), payAccount: String(payAccount || ''), checkNo: checkNo || '' });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'vendor-bill:pay', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, bill: claim.record.resultReference && claim.record.resultReference.bill, payment: claim.record.resultReference && claim.record.resultReference.payment });
      }
      idemRecord = claim.record;
    }

    // Idempotency: an identical retried request (same clientRef) returns the
    // already-committed payment instead of creating a duplicate financial effect.
    if (clientRef) {
      const already = (bill.payments || []).find(p => p.clientRef === clientRef);
      if (already) {
        if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
        return res.json({ success: true, bill, payment: already, idempotentReplay: true });
      }
    }

    if (!(amt > 0)) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(400).json({ success: false, error: 'مبلغ الدفعة مطلوب ويجب أن يكون رقمًا موجبًا' });
    }
    if (amt > bill.outstandingAmount + 0.001) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(400).json({ success: false, error: `المبلغ (${amt.toFixed(3)}) أكبر من المتبقي (${bill.outstandingAmount.toFixed(3)} د.ك)`, code: 'OVERPAYMENT' });
    }

    const payDateResolved = payDate || new Date().toISOString().slice(0, 10);
    const coa = db.chartOfAccounts || [];
    const vendorAcc = coa.find(a => a.code === bill.liabilityAccountCode) || { id: bill.liabilityAccountCode, code: bill.liabilityAccountCode, name: bill.vendorName };
    const payAcc = coa.find(a => String(a.id) === String(payAccount) || String(a.code) === String(payAccount)) || coa.find(a => a.code === '1100') || { id: '1100', code: '1100', name: 'الصندوق' };

    const seq = (bill.payments || []).length + 1;
    const jeId = 'JE-BILLPAY-' + bill.id + '-' + seq;
    const roundedAmt = parseFloat(amt.toFixed(3));
    const je = {
      id: jeId, date: payDateResolved,
      desc: `سداد فاتورة مورد — ${bill.vendorName} (قسط ${seq})${checkNo ? ' — شيك #' + checkNo : ''}`,
      ref: 'BILLPAY-' + bill.id + '-' + seq, reference: 'BILLPAY-' + bill.id + '-' + seq, type: 'vendor-bill-payment',
      source: 'vendor-bill', sourceId: bill.id, sourceModule: 'accounts-payable',
      totalDebit: roundedAmt, totalCredit: roundedAmt,
      createdAt: new Date().toISOString(),
      lines: [
        { accountId: vendorAcc.id, accountCode: vendorAcc.code, accountName: vendorAcc.name, debit: roundedAmt, credit: 0 },
        { accountId: payAcc.id, accountCode: payAcc.code, accountName: payAcc.name, debit: 0, credit: roundedAmt },
      ],
    };
    let payment;
    try {
      appendJournalEntry(db, je);
      payment = { id: 'PMT-' + jeId, amount: roundedAmt, date: payDateResolved, account: payAcc.code, accountName: payAcc.name, checkNo: checkNo || '', clientRef: clientRef || null, jeId, reversed: false };
      bill.payments = bill.payments || [];
      bill.payments.push(payment);
      bill.paidAmount = parseFloat((bill.paidAmount + roundedAmt).toFixed(3));
      bill.outstandingAmount = parseFloat((bill.grossAmount - bill.creditedAmount - bill.paidAmount).toFixed(3));
      bill.status = bill.outstandingAmount <= 0.001 ? 'PAID' : 'PARTIALLY_PAID';
      bill.updatedAt = new Date().toISOString();
      if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { bill, payment }, bill.id, jeId);
    } catch (e) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }

    appendAuditEvent(db, { req, action: 'vendor_bill.payment_posted', resourceType: 'vendorBill', resourceId: bill.id, after: { amount: roundedAmt, status: bill.status, outstanding: bill.outstandingAmount } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for vendor_bill.payment_posted:', e.message);
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ الدفعة بشكل دائم — حاول مرة أخرى' });
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    // R5 (staging validation, adversarial review — P1, live-reproduced): a
    // routine cash payment could silently drive the till (1100) or bank
    // (1110) negative — an accounting impossibility — with zero signal in
    // the response. detectNegativeBalanceAccounts() already exists and is
    // correctly tagged "accounting-impossible... requires immediate review"
    // (P0.10/P6-047) but was only ever surfaced reactively via a separate
    // GET /api/anomalies call, never at the point of the action that caused
    // it. Deliberately NON-BLOCKING — this does not change accounting
    // behavior or reject the payment (that would be a new business-policy
    // decision, e.g. whether the app should ever support cash overdraft,
    // which needs the product owner's own call, not a silent server
    // default) — it only adds visibility exactly where the existing
    // detector's own comment says the condition demands it.
    const negAlert = (payAcc.code === '1100' || payAcc.code === '1110')
      ? detectNegativeBalanceAccounts(db).find(a => a.accountCode === payAcc.code)
      : null;
    res.json({ success: true, bill, payment, warning: negAlert ? negAlert.msg : undefined });
  } catch (err) {
    next(err);
  }
});

// P0.7 — Step 26: reverses a single previously-posted payment (mistaken
// entry) — never deletes the original payment journal. Dr Bank-Cash /
// Cr vendor account, restoring the outstanding balance. Both the original
// payment JE and the reversal JE remain in the ledger, explicitly linked.
app.post('/api/vendor-bills/:id/payments/:paymentId/reverse', requireAuth, requirePermission('vendors', 'delete'), async (req, res, next) => {
  try {
    const db = loadDB();
    const bill = (db.vendorBills || []).find(b => b.id === req.params.id);
    if (!bill) return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
    const payment = (bill.payments || []).find(p => p.id === req.params.paymentId);
    if (!payment) return res.status(404).json({ success: false, error: 'الدفعة غير موجودة' });
    if (payment.reversed) return res.status(409).json({ success: false, error: 'هذه الدفعة مُلغاة بالفعل', code: 'ALREADY_REVERSED' });

    const reverseDate = req.body.reverseDate || new Date().toISOString().slice(0, 10);
    const coa = db.chartOfAccounts || [];
    const vendorAcc = coa.find(a => a.code === bill.liabilityAccountCode) || { id: bill.liabilityAccountCode, code: bill.liabilityAccountCode, name: bill.vendorName };
    const payAcc = coa.find(a => a.code === payment.account) || { id: payment.account, code: payment.account, name: payment.accountName };

    const revJeId = 'JE-BILLPAYREV-' + payment.id;
    const je = {
      id: revJeId, date: reverseDate,
      desc: `عكس دفعة فاتورة مورد — ${bill.vendorName} — ${payment.id}`,
      ref: 'BILLPAYREV-' + payment.id, reference: 'BILLPAYREV-' + payment.id, type: 'vendor-bill-payment-reversal',
      source: 'vendor-bill', sourceId: bill.id, sourceModule: 'accounts-payable',
      totalDebit: payment.amount, totalCredit: payment.amount,
      createdAt: new Date().toISOString(),
      lines: [
        { accountId: payAcc.id, accountCode: payAcc.code, accountName: payAcc.name, debit: payment.amount, credit: 0 },
        { accountId: vendorAcc.id, accountCode: vendorAcc.code, accountName: vendorAcc.name, debit: 0, credit: payment.amount },
      ],
    };
    try {
      appendJournalEntry(db, je);
    } catch (e) {
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }

    payment.reversed = true;
    payment.reversalJeId = revJeId;
    bill.paidAmount = parseFloat((bill.paidAmount - payment.amount).toFixed(3));
    bill.outstandingAmount = parseFloat((bill.grossAmount - bill.creditedAmount - bill.paidAmount).toFixed(3));
    bill.status = bill.outstandingAmount <= 0.001 ? 'PAID' : (bill.paidAmount > 0.001 ? 'PARTIALLY_PAID' : 'POSTED');
    bill.updatedAt = new Date().toISOString();

    appendAuditEvent(db, { req, action: 'vendor_bill.payment_reversed', resourceType: 'vendorBill', resourceId: bill.id, before: { paidAmount: parseFloat((bill.paidAmount + payment.amount).toFixed(3)) }, after: { paidAmount: bill.paidAmount, outstanding: bill.outstandingAmount } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for vendor_bill.payment_reversed:', e.message);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ عكس الدفعة بشكل دائم — حاول مرة أخرى' });
    }
    res.json({ success: true, bill, reversal: { jeId: revJeId } });
  } catch (err) {
    next(err);
  }
});

// P0.7 — Step 12: narrow credit/adjustment — reduces an unsettled bill
// (e.g. supplier goodwill credit, pricing correction) BEFORE full payment.
// Dr vendor account / Cr the original expense/asset allocation account(s)
// pro-rata. Never reduces below the already-paid amount.
function postVendorBillCredit(db, bill, amount, reason, req, creditDate) {
  const amt = parseFloat(amount);
  if (!(amt > 0)) { const e = new Error('مبلغ الإشعار الدائن مطلوب ويجب أن يكون رقمًا موجبًا'); e.status = 400; e.code = 'INVALID_CREDIT'; throw e; }
  const maxCreditable = parseFloat((bill.grossAmount - bill.paidAmount - bill.creditedAmount).toFixed(3));
  if (amt > maxCreditable + 0.001) {
    const e = new Error(`لا يمكن أن يتجاوز الإشعار الدائن (${amt.toFixed(3)}) المتبقي غير المدفوع (${maxCreditable.toFixed(3)} د.ك)`);
    e.status = 400; e.code = 'CREDIT_EXCEEDS_OUTSTANDING'; throw e;
  }
  // Step 29: the credit/cancellation date is caller-controllable (defaults
  // to today) — a real accountant backdates a credit note to match the
  // supplier's own document date, and this is also what makes the date
  // subject to the SAME period-lock guard as every other financial write
  // (via appendJournalEntry's own Invariant B below).
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(creditDate)) ? creditDate : new Date().toISOString().slice(0, 10);
  const coa = db.chartOfAccounts || [];
  const vendorAcc = coa.find(a => a.code === bill.liabilityAccountCode) || { id: bill.liabilityAccountCode, code: bill.liabilityAccountCode, name: bill.vendorName };
  // Reverse pro-rata across the original allocation accounts (largest first)
  // so a credit against a multi-line bill still balances against real accounts.
  let remaining = parseFloat(amt.toFixed(3));
  const total = bill.allocations.reduce((s, a) => s + a.amount, 0);
  const creditLines = [];
  bill.allocations.forEach((a, i) => {
    const isLast = i === bill.allocations.length - 1;
    const share = isLast ? remaining : parseFloat((amt * (a.amount / total)).toFixed(3));
    if (share <= 0) return;
    creditLines.push({ accountId: a.accountId, accountCode: a.accountCode, accountName: a.accountName, debit: 0, credit: share });
    remaining = parseFloat((remaining - share).toFixed(3));
  });
  const seq = (bill.credits || []).length + 1;
  const jeId = 'JE-BILLCREDIT-' + bill.id + '-' + seq;
  const je = {
    id: jeId, date,
    desc: `إشعار دائن — فاتورة مورد ${bill.vendorName}${reason ? ' — ' + reason : ''}`,
    ref: 'BILLCREDIT-' + bill.id + '-' + seq, reference: 'BILLCREDIT-' + bill.id + '-' + seq, type: 'vendor-bill-credit',
    source: 'vendor-bill', sourceId: bill.id, sourceModule: 'accounts-payable',
    totalDebit: amt, totalCredit: amt, createdAt: new Date().toISOString(),
    lines: [{ accountId: vendorAcc.id, accountCode: vendorAcc.code, accountName: vendorAcc.name, debit: amt, credit: 0 }, ...creditLines],
  };
  appendJournalEntry(db, je); // throws on locked period / imbalance — nothing mutated yet

  bill.credits = bill.credits || [];
  bill.credits.push({ id: 'CR-' + jeId, amount: amt, date, reason: reason || '', jeId });
  bill.creditedAmount = parseFloat((bill.creditedAmount + amt).toFixed(3));
  bill.outstandingAmount = parseFloat((bill.grossAmount - bill.creditedAmount - bill.paidAmount).toFixed(3));
  bill.updatedAt = new Date().toISOString();
  return je;
}

// P0.12 (closes P6-097 — this route has no pre-existing duplicate guard at
// all: nothing stops a retried credit-note request from posting twice).
app.post('/api/vendor-bills/:id/credit', requireAuth, requirePermission('vendors', 'edit'), async (req, res, next) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const db = loadDB();
    const bill = (db.vendorBills || []).find(b => b.id === req.params.id);
    if (!bill) return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
    if (bill.status === 'CANCELLED') return res.status(409).json({ success: false, error: 'الفاتورة مُلغاة بالفعل', code: 'BILL_CANCELLED' });

    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const fingerprint = computeFingerprint('vendor-bill:credit', { id: bill.id, amount: req.body.amount, reason: req.body.reason || '', date: req.body.date || null });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'vendor-bill:credit', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, bill: claim.record.resultReference && claim.record.resultReference.bill, journalId: claim.record.journalId });
      }
      idemRecord = claim.record;
    }

    let je;
    try {
      je = postVendorBillCredit(db, bill, req.body.amount, req.body.reason, req, req.body.date);
      if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { bill }, bill.id, je.id);
    } catch (e) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      if (e.status) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }
    appendAuditEvent(db, { req, action: 'vendor_bill.credited', resourceType: 'vendorBill', resourceId: bill.id, after: { amount: req.body.amount, outstanding: bill.outstandingAmount } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for vendor_bill.credited:', e.message);
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ الإشعار الدائن بشكل دائم — حاول مرة أخرى' });
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, bill, journalId: je.id });
  } catch (err) {
    next(err);
  }
});

// P0.7 — Steps 24-25: cancel an UNPAID bill via a full reversal journal —
// never deletes the original recognition journal. A partially/fully paid
// bill must be settled via credit/payment-reversal first (Step 25: "do not
// allow naive cancellation... require settlement/credit logic").
app.post('/api/vendor-bills/:id/cancel', requireAuth, requirePermission('vendors', 'delete'), async (req, res, next) => {
  try {
    const db = loadDB();
    const bill = (db.vendorBills || []).find(b => b.id === req.params.id);
    if (!bill) return res.status(404).json({ success: false, error: 'الفاتورة غير موجودة' });
    if (bill.status === 'CANCELLED') return res.status(409).json({ success: false, error: 'الفاتورة مُلغاة بالفعل', code: 'ALREADY_CANCELLED' });
    if (bill.paidAmount > 0.001) {
      return res.status(409).json({ success: false, error: 'لا يمكن إلغاء فاتورة عليها دفعات — استخدم عكس الدفعة أولًا ثم الإلغاء، أو إشعارًا دائنًا جزئيًا', code: 'BILL_HAS_PAYMENTS' });
    }
    let je;
    try {
      je = postVendorBillCredit(db, bill, bill.outstandingAmount, req.body.reason || 'إلغاء الفاتورة', req, req.body.date);
    } catch (e) {
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      if (e.status) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }
    bill.status = 'CANCELLED';
    bill.cancellation = { jeId: je.id, date: je.date, reason: req.body.reason || '' };
    bill.updatedAt = new Date().toISOString();

    appendAuditEvent(db, { req, action: 'vendor_bill.cancelled', resourceType: 'vendorBill', resourceId: bill.id, after: { reason: req.body.reason || '' } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for vendor_bill.cancelled:', e.message);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ الإلغاء بشكل دائم — حاول مرة أخرى' });
    }
    res.json({ success: true, bill, reversalJournalId: je.id, originalJournalId: bill.journalId });
  } catch (err) {
    next(err);
  }
});

// P0.7 — Step 18: read-only chronological vendor statement. Every row
// carries source metadata (Step 19) so the running balance is fully
// traceable back to its originating document.
app.get('/api/vendors/:id/statement', requireAuth, requirePermission('vendors', 'view'), (req, res) => {
  const db = loadDB();
  const vendor = (db.vendors || []).find(v => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ error: 'المورد غير موجود' });

  const rows = [];
  if ((parseFloat(vendor.openingBalance) || 0) > 0) {
    rows.push({ date: vendor.openingDate || '', type: 'opening', reference: 'OB-' + vendor.accountId, description: 'رصيد افتتاحي', amount: parseFloat(vendor.openingBalance), direction: 'credit', sourceId: vendor.id });
  }
  const vendorBillIds = new Set();
  (db.vendorBills || []).filter(b => b.vendorId === vendor.id).forEach(b => {
    vendorBillIds.add(b.id);
    rows.push({ date: b.billDate, type: 'bill', reference: b.billNumber || b.number, description: b.description || `فاتورة مورد ${b.number}`, amount: b.grossAmount, direction: 'credit', sourceId: b.id });
    (b.credits || []).forEach(c => rows.push({ date: c.date, type: 'credit', reference: c.id, description: `إشعار دائن — ${c.reason || b.number}`, amount: c.amount, direction: 'debit', sourceId: b.id }));
    (b.payments || []).filter(p => !p.reversed).forEach(p => rows.push({ date: p.date, type: 'payment', reference: p.id, description: `دفعة — ${b.number}`, amount: p.amount, direction: 'debit', sourceId: b.id }));
  });

  // P3-HOTFIX — legacy direct-journal activity: any journalEntries[] line
  // posted directly against this vendor's payable account, bypassing the
  // vendorBills subledger entirely (raw manual/expense-type entries from
  // before vendorBills existed — see docs/P3 vendor-statement investigation).
  // Matched on accountCode/accountId/account (string-normalized — legacy
  // lines aren't guaranteed to use one field consistently), then EXCLUDED
  // whenever the owning entry is already represented as the opening-balance
  // row (source==='vendor-opening', or the fixed 'JE-VND-OPEN-'+vendor.id
  // id as a fallback for any pre-P0.3 opening JE missing that field) or as
  // a vendorBills row (source==='vendor-bill' && sourceId is one of THIS
  // vendor's own bill ids — the same source/sourceId every bill/payment/
  // credit JE already carries, from buildAndPostVendorBill and the
  // pay/credit routes). Never matched on description text.
  const vendorAccountKey = String(vendor.accountId);
  const legacyOpeningJeId = 'JE-VND-OPEN-' + vendor.id;
  (db.journalEntries || []).forEach(je => {
    if (je.id === legacyOpeningJeId || je.source === 'vendor-opening') return;
    if (je.source === 'vendor-bill' && vendorBillIds.has(je.sourceId)) return;
    (je.lines || []).forEach(l => {
      const matches = String(l.accountCode ?? '') === vendorAccountKey ||
                       String(l.accountId ?? '')   === vendorAccountKey ||
                       String(l.account ?? '')     === vendorAccountKey;
      if (!matches) return;
      const debit = parseFloat(l.debit) || 0, credit = parseFloat(l.credit) || 0;
      if (debit <= 0.0005 && credit <= 0.0005) return;
      rows.push({
        date: je.date, type: 'legacy-journal', reference: je.ref || je.reference || je.id,
        description: je.desc || je.description || 'قيد تاريخي',
        amount: credit > 0 ? credit : debit, direction: credit > 0 ? 'credit' : 'debit',
        sourceId: je.id, source: je.source || je.type || null, journalEntryId: je.id,
      });
    });
  });

  // Deterministic chronological sort — date, then a stable id tie-break
  // (never insertion order, so a reset/reload always produces the same
  // running balance sequence for same-day entries).
  rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.sourceId || '').localeCompare(String(b.sourceId || '')));

  let running = 0;
  rows.forEach(r => { running = parseFloat((running + (r.direction === 'credit' ? r.amount : -r.amount)).toFixed(3)); r.runningBalance = running; });

  // Reconciliation — reuses buildBalanceMap(), the SAME canonical per-
  // account balance helper already used by /api/trial-balance and
  // /api/reports/balance-sheet, rather than a second independent sum.
  const balMap = buildBalanceMap(db, null, null);
  const glRow = balMap[vendorAccountKey] || { debit: 0, credit: 0 };
  const glBalance = parseFloat((glRow.credit - glRow.debit).toFixed(3));
  const statementBalance = running;
  const difference = parseFloat((statementBalance - glBalance).toFixed(3));

  res.json({
    vendor: { id: vendor.id, name: vendor.name }, rows, endingBalance: running,
    reconciliation: { statementBalance, glBalance, difference, reconciled: Math.abs(difference) < 0.005 },
  });
});

// P0.7 — Step 20: the vendor's outstanding AP balance is ALWAYS derived
// (opening + posted bills − credits − payments) — never a second, competing
// stored total that could drift from the journal facts.
function vendorApOutstanding(db, vendorId) {
  const vendor = (db.vendors || []).find(v => v.id === vendorId);
  const opening = vendor ? (parseFloat(vendor.openingBalance) || 0) : 0;
  const billsTotal = (db.vendorBills || []).filter(b => b.vendorId === vendorId)
    .reduce((s, b) => s + (b.grossAmount - b.creditedAmount - b.paidAmount), 0);
  return parseFloat((opening + billsTotal).toFixed(3));
}

// ═══════════════════════════════════════════════════════════════════════
// PATIENT ACCOUNTS RECEIVABLE — دفتر تبعية الذمم المدينة (P0.8)
// ═══════════════════════════════════════════════════════════════════════
// P0.8 — Part A: forensic map of every existing revenue/receivable source,
// checked directly against current code before writing anything here:
//   • dailyData[] (POST /api/upload "dailyincome" files, parseDailyIncome())
//     — channel totals only (cash/knet/visa/master/link/cheque/insurance),
//     posts a monthly "auto-income" journal immediately (see the
//     "AUTO JOURNAL ENTRIES FOR DAILY INCOME" block above). 100% cash-basis
//     — the file format has no "unpaid" column at all. Its insurance
//     component debits 1130 (a real receivable) but that already reconciles
//     via db.insuranceClaims[]/GET /api/ar-aging — a separate, working AR
//     system this milestone must not touch or redesign.
//   • paymentsData[] (POST /api/upload "payments" files, parsePaymentsDetails())
//     — real per-invoice patient+doctor identity (invId/fileNo/patient/
//     doctor) but creates NO journal entry at all; it feeds ONLY
//     updateCommissions(). Every column (knet/visa/master/link/gig)
//     represents an amount ALREADY collected via that channel — no "amount
//     owed" field exists in this format either.
//   • POST /api/manual-entry / AI add_daily (buildAndPostManualIncome) —
//     same cash-basis shape/limitation as dailyData: no patient link, no
//     unpaid concept.
//   • db.patientAR[] (POST /api/import/patient-opening — the ONLY writer,
//     confirmed by a full-repository search) — THIS is P6-029's exact
//     target: a one-time opening-balance import (Dr 1200 / Cr 3100 equity,
//     NOT revenue), write-only — zero read routes, zero GET /api/ar-aging
//     inclusion (that endpoint is 100% insurance-claims-only, see its own
//     code above), zero collection route.
// CONCLUSION: no import pipeline in this system carries an "unpaid patient
// revenue" signal — genuine credit-basis patient revenue has never been an
// operational data flow here, only a one-time legacy balance import. Part
// K below (import integration) is therefore a documented non-integration,
// not an oversight — inventing a payment-state signal the source data does
// not contain would violate the explicit "do not infer payment state from
// ambiguous data" instruction.
//
// PATIENT IDENTITY (Part B): no patients[] master existed before this
// milestone. The only stronger-than-name identifiers already present
// anywhere are patientAR[]'s `fileNo` and paymentsData[]'s `fileNo`/`invId`
// — both free text, never cross-referenced. The minimal master below
// dedupes by `fileNumber` when supplied; a new patient is always created
// when no fileNumber is given (name alone is never treated as authoritative
// identity, per explicit instruction).
//
// CONTROL ACCOUNT (Part J/Step 24 — "ONE clear patient AR control account",
// singular, unlike P0.7's per-vendor sub-accounts which were justified
// there by an existing ~100-vendor COA convention): every
// patientReceivables[] record shares ONE control account, 1200
// ("الذمم المدينة — مرضى") — already present in DEFAULT_COA and already the
// exact account patient-opening imports use (settings.accReceivable ||
// '1200', see POST /api/import/patient-opening above) — reusing existing
// architecture, not inventing a new code. Patient volume (unlike ~100
// vendors) makes a dedicated sub-account per patient impractical.
//
// DOCTOR REVENUE (Part D/Step 9): commission is computed exclusively from
// paymentsData[] via updateCommissions() (P0.6B-hardened, untouched here).
// patientReceivables[] recognition accepts an OPTIONAL doctorId purely as
// informational/reporting metadata — never read by updateCommissions() or
// any commission path — so one economic event still creates revenue/
// commission exactly once, through exactly one pipeline.
//
// BAD-DEBT ACCOUNT (Part F/Step 17) — a forensic side-finding while mapping
// this area: the EXISTING insurance-claim write-off (PUT
// /api/insurance-claims/:id, ~8453) posts its shortfall to account '5700'
// assuming it means "ديون مشكوك في تحصيلها" (doubtful debts), but
// DEFAULT_COA's real 5700 is "مصاريف إدارية عمومية" (general admin
// expenses) — a pre-existing account-code/name mismatch (validateJournalEntry's
// Invariant E only checks code existence, not name, so it silently
// validates against the wrong semantic account). Also, the same route's
// insurance-receivable line (~8442) references account '1120' assuming it
// means "ذمم التأمين", but DEFAULT_COA's real 1120 is "K-Net / Visa /
// Master — مستحقات" (card settlement, unrelated) — the real insurance
// receivable is 1130. Both are pre-existing, out of P0.8's scope to fix
// (touching insurance-claims code is explicitly out of scope for this
// milestone) — logged as gap-register finding P6-072 instead. To avoid
// compounding either mismatch, patient AR write-off below uses a genuinely
// new, correctly-named, lazily-created account (ensureAccount('5920',
// 'ديون معدومة', ...)) rather than reusing the mis-named 5700.
//
// R2 fix (verified defect, discovered via live UI testing of the write-off
// workflow): this originally used code '5710', reasoning it was unused —
// but lib/defaults.js DEFAULT_COA already seeds '5710' as "هاتف وإنترنت"
// (Phone & Internet). Since ensureAccount() only creates an account if the
// code doesn't already exist, every write-off was silently posting bad-debt
// expense into the phone/internet expense account instead of a dedicated
// bad-debt account. '5920' is confirmed free in DEFAULT_COA (5900 is
// "مصاريف أخرى متنوعة", 5910 is used by asset-disposal losses).

function nextReceivableNo(db) {
  const list = db.patientReceivables || [];
  let max = 0;
  list.forEach(r => {
    const m = /^AR-(\d+)$/.exec(r.number || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'AR-' + String(max + 1).padStart(4, '0');
}

// Step 20/Invariant-11-style: derived, never a stored/independently-managed
// balance — mirrors vendorApOutstanding() exactly.
function patientArOutstanding(db, patientId) {
  const total = (db.patientReceivables || []).filter(r => r.patientId === patientId)
    .reduce((s, r) => s + (r.grossAmount - r.creditedAmount - r.writtenOffAmount - r.collectedAmount), 0);
  return parseFloat(total.toFixed(3));
}

// Steps 7-9: recognize a genuine credit (unpaid) patient service — Dr AR /
// Cr Revenue. Prepare-then-commit (P0.3 Pattern A): the journal is
// validated/appended BEFORE the patientReceivables[] record is pushed, so a
// rejected posting (locked period, unbalanced, bad account) leaves nothing
// behind.
function buildAndPostPatientReceivable(db, data, actorReq) {
  const { patientId, reference, serviceDate, dueDate, doctorId, description,
          revenueAccountCode, receivableAccountCode, amount } = data;

  const patient = (db.patients || []).find(p => p.id === patientId);
  if (!patient) { const e = new Error('المريض غير موجود'); e.status = 404; e.code = 'PATIENT_NOT_FOUND'; throw e; }

  if (!serviceDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(serviceDate))) {
    const e = new Error('تاريخ الخدمة مطلوب بصيغة صحيحة (YYYY-MM-DD)'); e.status = 400; e.code = 'INVALID_DATE'; throw e;
  }
  const amt = parseFloat(amount);
  if (!(amt > 0)) { const e = new Error('المبلغ مطلوب ويجب أن يكون رقمًا موجبًا'); e.status = 400; e.code = 'INVALID_AMOUNT'; throw e; }

  const coa = db.chartOfAccounts || [];
  const arCode  = receivableAccountCode || '1200';
  const revCode = revenueAccountCode || '4200';
  const arAcc  = coa.find(a => a.code === arCode);
  if (!arAcc) { const e = new Error(`حساب الذمم المدينة ${arCode} غير موجود في شجرة الحسابات`); e.status = 400; e.code = 'UNKNOWN_ACCOUNT'; throw e; }
  const revAcc = coa.find(a => a.code === revCode);
  if (!revAcc) { const e = new Error(`حساب الإيراد ${revCode} غير موجود في شجرة الحسابات`); e.status = 400; e.code = 'UNKNOWN_ACCOUNT'; throw e; }

  // Step 5/duplicate prevention: same patient + same reference (invoice/doc
  // number), excluding a cancelled record, is rejected rather than silently
  // creating a second receivable for the same underlying document.
  if (reference) {
    const dup = (db.patientReceivables || []).find(r => r.patientId === patientId && r.reference === reference && r.status !== 'CANCELLED');
    if (dup) { const e = new Error(`مرجع/فاتورة مكرر لنفس المريض: ${reference}`); e.status = 409; e.code = 'DUPLICATE_REFERENCE'; throw e; }
  }

  const seq = (db.patientReceivables || []).length + 1;
  const jeId = 'JE-PATREC-' + Date.now() + '-' + seq;
  // P1 adversarial-review fix (P1/P2 findings, navigation persona): the
  // receivable's own id used to be generated AFTER this journal entry was
  // already built/posted, so this recognition entry — the FIRST and most
  // commonly clicked journal entry in the whole patient-receivable lifecycle
  // — never carried a sourceId at all, unlike every sibling builder
  // (collection/reversal/credit/write-off, all below) which correctly set
  // sourceId: rec.id. That silently broke the new "go to source" deep-link
  // for exactly this entry type. Generated early here so it can be included.
  const recId = genId('patrec-');
  const je = {
    id: jeId, date: serviceDate,
    desc: `إيراد آجل — ${patient.name}${description ? ' — ' + description : ''}`,
    ref: 'PATREC-' + jeId, reference: 'PATREC-' + jeId, type: 'patient-receivable',
    source: 'patient-receivable', sourceId: recId, sourceModule: 'accounts-receivable',
    totalDebit: amt, totalCredit: amt, createdAt: new Date().toISOString(),
    lines: [
      { accountId: arAcc.id, accountCode: arAcc.code, accountName: arAcc.name, debit: amt, credit: 0 },
      { accountId: revAcc.id, accountCode: revAcc.code, accountName: revAcc.name, debit: 0, credit: amt },
    ],
  };
  appendJournalEntry(db, je); // throws on locked period / imbalance / unknown account — nothing mutated yet

  const rec = {
    id: recId, number: nextReceivableNo(db),
    patientId, patientName: patient.name, reference: reference || '',
    serviceDate, dueDate: dueDate || null, doctorId: doctorId || null, description: description || '',
    revenueAccountCode: revAcc.code, receivableAccountCode: arAcc.code,
    grossAmount: amt, collectedAmount: 0, creditedAmount: 0, writtenOffAmount: 0, outstandingAmount: amt,
    status: 'POSTED', recognitionJournalId: jeId,
    collections: [], credits: [], writeOff: null, cancellation: null,
    source: 'patient-receivable', sourceId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    createdBy: actorReq && actorReq.user ? actorReq.user.username : 'system',
  };
  db.patientReceivables = db.patientReceivables || [];
  db.patientReceivables.push(rec);
  return rec;
}

// Step 4 — minimal debtor master. `fileNumber` (when supplied) is the only
// deduplication key — an existing ACTIVE patient with the same normalized
// fileNumber is returned instead of creating a duplicate; name alone is
// never used to dedupe (explicit instruction).
// R2 — additive fix (verified defect, live-reproduced by adversarial
// review): this route had no idempotency-key wiring at all and its only
// dedup guard keyed on an OPTIONAL fileNumber, so two concurrent creates
// with the same name/blank fileNumber both silently succeeded, fragmenting
// that patient's AR history across two records. Now uses the exact same
// idempotency-store pattern as its sibling POST /api/patient-receivables
// immediately below.
app.post('/api/patients', requireAuth, requirePermission('manual', 'add'), async (req, res, next) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const db = loadDB();
    db.patients = db.patients || [];
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'اسم المريض مطلوب' });
    const fileNumber = (req.body.fileNumber || '').trim();

    if (fileNumber) {
      const existing = db.patients.find(p => p.fileNumber && p.fileNumber === fileNumber && p.active !== false);
      if (existing) return res.json({ success: true, patient: existing, idempotentReplay: true });
    }

    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const fingerprint = computeFingerprint('patient:create', { name, fileNumber, phone: (req.body.phone || '').trim() });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'patient:create', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, patient: claim.record.resultReference });
      }
      idemRecord = claim.record;
    }

    const patient = {
      id: genId('pat-'), fileNumber: fileNumber || '', name,
      phone: (req.body.phone || '').trim(), active: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    db.patients.push(patient);
    appendAuditEvent(db, { req, action: 'patient.created', resourceType: 'patient', resourceId: patient.id, after: { name: patient.name, fileNumber: patient.fileNumber } });
    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, patient, patient.id, patient.id);
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for patient.created:', e.message);
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ المريض بشكل دائم — حاول مرة أخرى' });
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, patient });
  } catch (err) {
    next(err);
  }
});

app.get('/api/patients', requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  res.json((db.patients || []).slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
});

// P1 (Record Workspace, NEW-R5-ADV-PATIENTS-NO-EDIT-01): a plain single-record
// GET for the edit-form/detail-workspace use case — distinct from the
// existing GET /api/patients/:id/statement, which returns AR history, not
// the raw master record.
app.get('/api/patients/:id', requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const patient = (db.patients || []).find(p => p.id === req.params.id);
  if (!patient) return res.status(404).json({ success: false, error: 'المريض غير موجود' });
  res.json({ success: true, patient });
});

// P1 — PUT /api/patients/:id: safe NON-financial master-data edit only
// (name/phone/fileNumber). The patient's true financial identity is the
// server-generated `id` (patientReceivables link by `patientId`, confirmed —
// see buildAndPostPatientReceivable above), which is the URL param here and
// never editable via the body, so this can never orphan AR history.
// `fileNumber` is likewise never used as a financial lookup key anywhere
// (only an optional create-time dedup convenience) — safe to edit — but the
// same dedup check applied at create time is re-applied here for data
// hygiene, scoped to exclude the patient's own record.
app.put('/api/patients/:id', requirePermission('manual', 'edit'), (req, res) => {
  const db = loadDB();
  const idx = (db.patients || []).findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'المريض غير موجود' });
  const before = { ...db.patients[idx] };

  const body = req.body || {};
  const nextName = body.name !== undefined ? String(body.name || '').trim() : before.name;
  if (!nextName) return res.status(400).json({ success: false, error: 'اسم المريض مطلوب' });

  const nextFileNumber = body.fileNumber !== undefined ? String(body.fileNumber || '').trim() : before.fileNumber;
  if (nextFileNumber) {
    const dup = db.patients.find(p => p.id !== before.id && p.fileNumber === nextFileNumber && p.active !== false);
    if (dup) return res.status(409).json({ success: false, error: `رقم الملف "${nextFileNumber}" مستخدَم بالفعل لمريض آخر`, code: 'DUPLICATE_FILE_NUMBER' });
  }

  db.patients[idx] = {
    ...before,
    name: nextName,
    fileNumber: nextFileNumber,
    phone: body.phone !== undefined ? String(body.phone || '').trim() : before.phone,
    updatedAt: new Date().toISOString(),
  };
  appendAuditEvent(db, { req, action: 'patient.updated', resourceType: 'patient', resourceId: before.id, before, after: db.patients[idx] });
  saveDB(db);
  res.json({ success: true, patient: db.patients[idx] });
});

// Steps 5-9: post a patient receivable (credit revenue recognition).
// P0.12 (closes P6-097 — original recognition has no duplicate guard at
// all; unlike vendor bills there isn't even an opt-in billNumber check).
app.post('/api/patient-receivables', requireAuth, requirePermission('manual', 'add'), async (req, res, next) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const db = loadDB();

    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const b = req.body || {};
      const fingerprint = computeFingerprint('patient-receivable:create', { patientId: b.patientId, serviceDate: b.serviceDate, description: b.description, grossAmount: b.grossAmount, allocations: b.allocations });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'patient-receivable:create', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, receivable: claim.record.resultReference });
      }
      idemRecord = claim.record;
    }

    let rec;
    try {
      rec = buildAndPostPatientReceivable(db, req.body, req);
    } catch (e) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      if (e.status) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }
    appendAuditEvent(db, { req, action: 'patient_receivable.posted', resourceType: 'patientReceivable', resourceId: rec.id, after: { patient: rec.patientName, amount: rec.grossAmount, reference: rec.reference } });
    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, rec, rec.id, rec.journalId);
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for patient_receivable.posted:', e.message);
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ الذمة بشكل دائم — حاول مرة أخرى' });
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, receivable: rec });
  } catch (err) {
    next(err);
  }
});

app.get('/api/patient-receivables', requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  let recs = db.patientReceivables || [];
  if (req.query.patientId) recs = recs.filter(r => r.patientId === req.query.patientId);
  if (req.query.status)    recs = recs.filter(r => r.status === req.query.status);
  res.json(recs.slice().sort((a, b) => (b.serviceDate || '').localeCompare(a.serviceDate || '')));
});

// Steps 10-14: collect against an outstanding receivable — Dr Cash/Bank /
// Cr AR. Never re-recognizes revenue. Idempotent via an optional
// client-supplied `clientRef` (same pattern as P0.7's vendor-bill payments).
app.post('/api/patient-receivables/:id/collect', requireAuth, requirePermission('manual', 'edit'), async (req, res, next) => {
  try {
    const db = loadDB();
    const rec = (db.patientReceivables || []).find(r => r.id === req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'الذمة غير موجودة' });
    if (rec.status === 'CANCELLED')   return res.status(409).json({ success: false, error: 'لا يمكن التحصيل من ذمة مُلغاة', code: 'RECEIVABLE_CANCELLED' });
    if (rec.status === 'WRITTEN_OFF') return res.status(409).json({ success: false, error: 'لا يمكن التحصيل من ذمة مشطوبة كدين معدوم', code: 'RECEIVABLE_WRITTEN_OFF' });

    const { amount, collectDate, collectAccount, checkNo, clientRef } = req.body;
    const amt = parseFloat(amount);

    // P0.12 adversarial-review fix (P0, confirmed): claim BEFORE any read
    // of rec.outstandingAmount used for validation — see the identical
    // fix/rationale at vendor-bills/:id/pay above (Mongo claim awaits are a
    // real event-loop yield that did not exist pre-P0.12; claiming first
    // restores atomicity for the read-validate-mutate span below).
    const isMongo = !isFileFallbackMode();
    const idemKey = extractIdempotencyKey(req);
    let idemRecord = null;
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      // P0.12 adversarial-review fix: date is deliberately excluded from this
      // fingerprint — same rationale as vendor-bill:pay above (a pre-existing
      // clientRef-only equality domain guard never treated date as part of
      // this operation's identity).
      const fingerprint = computeFingerprint('patient-receivable:collect', { id: rec.id, amount: parseFloat((amt || 0).toFixed(3)), collectAccount: String(collectAccount || ''), checkNo: checkNo || '' });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'patient-receivable:collect', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, receivable: claim.record.resultReference && claim.record.resultReference.receivable, collection: claim.record.resultReference && claim.record.resultReference.collection });
      }
      idemRecord = claim.record;
    }

    if (clientRef) {
      const already = (rec.collections || []).find(c => c.clientRef === clientRef);
      if (already) {
        if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
        return res.json({ success: true, receivable: rec, collection: already, idempotentReplay: true });
      }
    }

    if (!(amt > 0)) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(400).json({ success: false, error: 'مبلغ التحصيل مطلوب ويجب أن يكون رقمًا موجبًا' });
    }
    if (amt > rec.outstandingAmount + 0.001) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(400).json({ success: false, error: `المبلغ (${amt.toFixed(3)}) أكبر من المتبقي (${rec.outstandingAmount.toFixed(3)} د.ك)`, code: 'OVERCOLLECTION' });
    }

    const dateResolved = collectDate || new Date().toISOString().slice(0, 10);
    const coa = db.chartOfAccounts || [];
    const arAcc  = coa.find(a => a.code === rec.receivableAccountCode) || { id: rec.receivableAccountCode, code: rec.receivableAccountCode, name: 'الذمم المدينة — مرضى' };
    const collAcc = coa.find(a => String(a.id) === String(collectAccount) || String(a.code) === String(collectAccount)) || coa.find(a => a.code === '1100') || { id: '1100', code: '1100', name: 'الصندوق' };

    const seq = (rec.collections || []).length + 1;
    const jeId = 'JE-PATCOLL-' + rec.id + '-' + seq;
    const roundedAmt = parseFloat(amt.toFixed(3));
    const je = {
      id: jeId, date: dateResolved,
      desc: `تحصيل من مريض — ${rec.patientName} (قسط ${seq})${checkNo ? ' — شيك #' + checkNo : ''}`,
      ref: 'PATCOLL-' + rec.id + '-' + seq, reference: 'PATCOLL-' + rec.id + '-' + seq, type: 'patient-receivable-collection',
      source: 'patient-receivable', sourceId: rec.id, sourceModule: 'accounts-receivable',
      totalDebit: roundedAmt, totalCredit: roundedAmt, createdAt: new Date().toISOString(),
      lines: [
        { accountId: collAcc.id, accountCode: collAcc.code, accountName: collAcc.name, debit: roundedAmt, credit: 0 },
        { accountId: arAcc.id,   accountCode: arAcc.code,   accountName: arAcc.name,   debit: 0, credit: roundedAmt },
      ],
    };
    let collection;
    try {
      appendJournalEntry(db, je);
      collection = { id: 'COLL-' + jeId, amount: roundedAmt, date: dateResolved, account: collAcc.code, accountName: collAcc.name, checkNo: checkNo || '', clientRef: clientRef || null, jeId, reversed: false };
      rec.collections = rec.collections || [];
      rec.collections.push(collection);
      rec.collectedAmount = parseFloat((rec.collectedAmount + roundedAmt).toFixed(3));
      rec.outstandingAmount = parseFloat((rec.grossAmount - rec.creditedAmount - rec.writtenOffAmount - rec.collectedAmount).toFixed(3));
      rec.status = rec.outstandingAmount <= 0.001 ? 'COLLECTED' : 'PARTIALLY_COLLECTED';
      rec.updatedAt = new Date().toISOString();
      if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { receivable: rec, collection }, rec.id, jeId);
    } catch (e) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }

    appendAuditEvent(db, { req, action: 'patient_receivable.collection_posted', resourceType: 'patientReceivable', resourceId: rec.id, after: { amount: roundedAmt, status: rec.status, outstanding: rec.outstandingAmount } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for patient_receivable.collection_posted:', e.message);
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ التحصيل بشكل دائم — حاول مرة أخرى' });
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, receivable: rec, collection });
  } catch (err) {
    next(err);
  }
});

// Reverses a single previously-posted collection (mistaken entry) — never
// deletes the original. Dr AR / Cr Cash-Bank, restoring the outstanding
// balance. Both the original collection JE and the reversal JE remain.
app.post('/api/patient-receivables/:id/collections/:collectionId/reverse', requireAuth, requirePermission('manual', 'delete'), async (req, res, next) => {
  try {
    const db = loadDB();
    const rec = (db.patientReceivables || []).find(r => r.id === req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'الذمة غير موجودة' });
    const collection = (rec.collections || []).find(c => c.id === req.params.collectionId);
    if (!collection) return res.status(404).json({ success: false, error: 'التحصيل غير موجود' });
    if (collection.reversed) return res.status(409).json({ success: false, error: 'هذا التحصيل مُلغى بالفعل', code: 'ALREADY_REVERSED' });

    const reverseDate = req.body.reverseDate || new Date().toISOString().slice(0, 10);
    const coa = db.chartOfAccounts || [];
    const arAcc   = coa.find(a => a.code === rec.receivableAccountCode) || { id: rec.receivableAccountCode, code: rec.receivableAccountCode, name: 'الذمم المدينة — مرضى' };
    const collAcc = coa.find(a => a.code === collection.account) || { id: collection.account, code: collection.account, name: collection.accountName };

    const revJeId = 'JE-PATCOLLREV-' + collection.id;
    const je = {
      id: revJeId, date: reverseDate,
      desc: `عكس تحصيل من مريض — ${rec.patientName} — ${collection.id}`,
      ref: 'PATCOLLREV-' + collection.id, reference: 'PATCOLLREV-' + collection.id, type: 'patient-receivable-collection-reversal',
      source: 'patient-receivable', sourceId: rec.id, sourceModule: 'accounts-receivable',
      totalDebit: collection.amount, totalCredit: collection.amount, createdAt: new Date().toISOString(),
      lines: [
        { accountId: arAcc.id,   accountCode: arAcc.code,   accountName: arAcc.name,   debit: collection.amount, credit: 0 },
        { accountId: collAcc.id, accountCode: collAcc.code, accountName: collAcc.name, debit: 0, credit: collection.amount },
      ],
    };
    try {
      appendJournalEntry(db, je);
    } catch (e) {
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }

    collection.reversed = true;
    collection.reversalJeId = revJeId;
    rec.collectedAmount = parseFloat((rec.collectedAmount - collection.amount).toFixed(3));
    rec.outstandingAmount = parseFloat((rec.grossAmount - rec.creditedAmount - rec.writtenOffAmount - rec.collectedAmount).toFixed(3));
    rec.status = rec.outstandingAmount <= 0.001 ? 'COLLECTED' : (rec.collectedAmount > 0.001 ? 'PARTIALLY_COLLECTED' : 'POSTED');
    rec.updatedAt = new Date().toISOString();

    appendAuditEvent(db, { req, action: 'patient_receivable.collection_reversed', resourceType: 'patientReceivable', resourceId: rec.id, before: { collectedAmount: parseFloat((rec.collectedAmount + collection.amount).toFixed(3)) }, after: { collectedAmount: rec.collectedAmount, outstanding: rec.outstandingAmount } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for patient_receivable.collection_reversed:', e.message);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ عكس التحصيل بشكل دائم — حاول مرة أخرى' });
    }
    res.json({ success: true, receivable: rec, reversal: { jeId: revJeId } });
  } catch (err) {
    next(err);
  }
});

// Step 15: narrow credit/revenue-reduction — Dr Revenue / Cr AR. Never
// reduces below the already-collected amount. Never deletes the original
// recognition journal.
function postPatientReceivableCredit(db, rec, amount, reason, req, creditDate) {
  const amt = parseFloat(amount);
  if (!(amt > 0)) { const e = new Error('مبلغ الإشعار الدائن مطلوب ويجب أن يكون رقمًا موجبًا'); e.status = 400; e.code = 'INVALID_CREDIT'; throw e; }
  const maxCreditable = parseFloat((rec.grossAmount - rec.collectedAmount - rec.creditedAmount - rec.writtenOffAmount).toFixed(3));
  if (amt > maxCreditable + 0.001) {
    const e = new Error(`لا يمكن أن يتجاوز الإشعار الدائن (${amt.toFixed(3)}) المتبقي غير المحصَّل (${maxCreditable.toFixed(3)} د.ك)`);
    e.status = 400; e.code = 'CREDIT_EXCEEDS_OUTSTANDING'; throw e;
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(creditDate)) ? creditDate : new Date().toISOString().slice(0, 10);
  const coa = db.chartOfAccounts || [];
  const arAcc  = coa.find(a => a.code === rec.receivableAccountCode) || { id: rec.receivableAccountCode, code: rec.receivableAccountCode, name: 'الذمم المدينة — مرضى' };
  const revAcc = coa.find(a => a.code === rec.revenueAccountCode)    || { id: rec.revenueAccountCode,    code: rec.revenueAccountCode,    name: 'إيرادات' };

  const seq = (rec.credits || []).length + 1;
  const jeId = 'JE-PATCREDIT-' + rec.id + '-' + seq;
  const je = {
    id: jeId, date,
    desc: `إشعار دائن — مريض ${rec.patientName}${reason ? ' — ' + reason : ''}`,
    ref: 'PATCREDIT-' + rec.id + '-' + seq, reference: 'PATCREDIT-' + rec.id + '-' + seq, type: 'patient-receivable-credit',
    source: 'patient-receivable', sourceId: rec.id, sourceModule: 'accounts-receivable',
    totalDebit: amt, totalCredit: amt, createdAt: new Date().toISOString(),
    lines: [
      { accountId: revAcc.id, accountCode: revAcc.code, accountName: revAcc.name, debit: amt, credit: 0 },
      { accountId: arAcc.id,  accountCode: arAcc.code,  accountName: arAcc.name,  debit: 0, credit: amt },
    ],
  };
  appendJournalEntry(db, je); // throws on locked period / imbalance — nothing mutated yet

  rec.credits = rec.credits || [];
  rec.credits.push({ id: 'CR-' + jeId, amount: amt, date, reason: reason || '', jeId });
  rec.creditedAmount = parseFloat((rec.creditedAmount + amt).toFixed(3));
  rec.outstandingAmount = parseFloat((rec.grossAmount - rec.creditedAmount - rec.writtenOffAmount - rec.collectedAmount).toFixed(3));
  rec.updatedAt = new Date().toISOString();
  return je;
}

// P0.12 (closes P6-097 — no pre-existing duplicate guard on this route).
app.post('/api/patient-receivables/:id/credit', requireAuth, requirePermission('manual', 'edit'), async (req, res, next) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const db = loadDB();
    const rec = (db.patientReceivables || []).find(r => r.id === req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'الذمة غير موجودة' });
    if (rec.status === 'CANCELLED') return res.status(409).json({ success: false, error: 'الذمة مُلغاة بالفعل', code: 'RECEIVABLE_CANCELLED' });

    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const fingerprint = computeFingerprint('patient-receivable:credit', { id: rec.id, amount: req.body.amount, reason: req.body.reason || '', date: req.body.date || null });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'patient-receivable:credit', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, receivable: claim.record.resultReference && claim.record.resultReference.receivable, journalId: claim.record.journalId });
      }
      idemRecord = claim.record;
    }

    let je;
    try {
      je = postPatientReceivableCredit(db, rec, req.body.amount, req.body.reason, req, req.body.date);
      if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { receivable: rec }, rec.id, je.id);
    } catch (e) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      if (e.status) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }
    appendAuditEvent(db, { req, action: 'patient_receivable.credited', resourceType: 'patientReceivable', resourceId: rec.id, after: { amount: req.body.amount, outstanding: rec.outstandingAmount } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for patient_receivable.credited:', e.message);
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ الإشعار الدائن بشكل دائم — حاول مرة أخرى' });
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, receivable: rec, journalId: je.id });
  } catch (err) {
    next(err);
  }
});

// Step 16: cancel an UNCOLLECTED receivable via a full reversal (credit)
// journal — never deletes the original recognition journal. A partially/
// fully collected receivable must be settled via collection-reversal or a
// partial credit first (mirrors P0.7's vendor-bill cancellation policy).
app.post('/api/patient-receivables/:id/cancel', requireAuth, requirePermission('manual', 'delete'), async (req, res, next) => {
  try {
    const db = loadDB();
    const rec = (db.patientReceivables || []).find(r => r.id === req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'الذمة غير موجودة' });
    if (rec.status === 'CANCELLED') return res.status(409).json({ success: false, error: 'الذمة مُلغاة بالفعل', code: 'ALREADY_CANCELLED' });
    if (rec.collectedAmount > 0.001) {
      return res.status(409).json({ success: false, error: 'لا يمكن إلغاء ذمة عليها تحصيل — استخدم عكس التحصيل أولًا ثم الإلغاء، أو إشعارًا دائنًا جزئيًا', code: 'RECEIVABLE_HAS_COLLECTIONS' });
    }
    let je;
    try {
      je = postPatientReceivableCredit(db, rec, rec.outstandingAmount, req.body.reason || 'إلغاء الذمة', req, req.body.date);
    } catch (e) {
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      if (e.status) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }
    rec.status = 'CANCELLED';
    rec.cancellation = { jeId: je.id, date: je.date, reason: req.body.reason || '' };
    rec.updatedAt = new Date().toISOString();

    appendAuditEvent(db, { req, action: 'patient_receivable.cancelled', resourceType: 'patientReceivable', resourceId: rec.id, after: { reason: req.body.reason || '' } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for patient_receivable.cancelled:', e.message);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ الإلغاء بشكل دائم — حاول مرة أخرى' });
    }
    res.json({ success: true, receivable: rec, reversalJournalId: je.id, originalJournalId: rec.recognitionJournalId });
  } catch (err) {
    next(err);
  }
});

// Step 17: bad-debt write-off — Dr Bad Debt Expense / Cr AR. Distinct from
// a credit note (which reverses revenue as if the price/service itself was
// reduced): a write-off acknowledges the debt is uncollectible WITHOUT
// reversing the original revenue recognition. No cash movement. Cannot
// exceed the current outstanding amount.
// P0.12 (closes P6-097 — the status===WRITTEN_OFF guard only catches a
// FULL write-off; a partial write-off leaves outstandingAmount > 0 and
// status unchanged, so a retried partial write-off is not caught by it).
app.post('/api/patient-receivables/:id/writeoff', requireAuth, requirePermission('manual', 'delete'), async (req, res, next) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const db = loadDB();
    const rec = (db.patientReceivables || []).find(r => r.id === req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: 'الذمة غير موجودة' });
    if (rec.status === 'CANCELLED')   return res.status(409).json({ success: false, error: 'لا يمكن شطب ذمة مُلغاة', code: 'RECEIVABLE_CANCELLED' });
    if (rec.status === 'WRITTEN_OFF') return res.status(409).json({ success: false, error: 'الذمة مشطوبة بالفعل', code: 'ALREADY_WRITTEN_OFF' });

    const amt = parseFloat(req.body.amount != null ? req.body.amount : rec.outstandingAmount);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date)) ? req.body.date : new Date().toISOString().slice(0, 10);

    // P0.12 adversarial-review fix (P0, confirmed): claim BEFORE any read
    // of rec.outstandingAmount used for validation — same rationale as
    // vendor-bills/:id/pay and patient-receivables/:id/collect above.
    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const fingerprint = computeFingerprint('patient-receivable:writeoff', { id: rec.id, amount: parseFloat((amt || 0).toFixed(3)), date, reason: req.body.reason || '' });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'patient-receivable:writeoff', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, receivable: claim.record.resultReference && claim.record.resultReference.receivable, journalId: claim.record.journalId });
      }
      idemRecord = claim.record;
    }

    if (!(amt > 0)) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(400).json({ success: false, error: 'مبلغ الشطب مطلوب ويجب أن يكون رقمًا موجبًا' });
    }
    if (amt > rec.outstandingAmount + 0.001) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(400).json({ success: false, error: `مبلغ الشطب (${amt.toFixed(3)}) أكبر من المتبقي (${rec.outstandingAmount.toFixed(3)} د.ك)`, code: 'WRITEOFF_EXCEEDS_OUTSTANDING' });
    }

    const coa = db.chartOfAccounts || [];
    const arAcc = coa.find(a => a.code === rec.receivableAccountCode) || { id: rec.receivableAccountCode, code: rec.receivableAccountCode, name: 'الذمم المدينة — مرضى' };
    // Deliberately NOT account 5700 (see forensic note above — it is
    // mis-named "مصاريف إدارية عمومية" in DEFAULT_COA, not bad debts) and
    // NOT 5710 (also pre-seeded, as "هاتف وإنترنت" — see R2 fix note above).
    const bdAcc = ensureAccount(db, '5920', 'ديون معدومة', 'expense', '5000');

    const roundedAmt = parseFloat(amt.toFixed(3));
    const jeId = 'JE-PATWO-' + rec.id + '-' + Date.now();
    const je = {
      id: jeId, date,
      desc: `شطب دين معدوم — ${rec.patientName}${req.body.reason ? ' — ' + req.body.reason : ''}`,
      ref: 'PATWO-' + rec.id, reference: 'PATWO-' + rec.id, type: 'patient-receivable-writeoff',
      source: 'patient-receivable', sourceId: rec.id, sourceModule: 'accounts-receivable',
      totalDebit: roundedAmt, totalCredit: roundedAmt, createdAt: new Date().toISOString(),
      lines: [
        { accountId: bdAcc.id, accountCode: bdAcc.code, accountName: bdAcc.name, debit: roundedAmt, credit: 0 },
        { accountId: arAcc.id, accountCode: arAcc.code,  accountName: arAcc.name, debit: 0, credit: roundedAmt },
      ],
    };
    try {
      appendJournalEntry(db, je);
      rec.writeOff = { jeId, amount: roundedAmt, date, reason: req.body.reason || '' };
      rec.writtenOffAmount = parseFloat((rec.writtenOffAmount + roundedAmt).toFixed(3));
      rec.outstandingAmount = parseFloat((rec.grossAmount - rec.creditedAmount - rec.writtenOffAmount - rec.collectedAmount).toFixed(3));
      rec.status = rec.outstandingAmount <= 0.001 ? 'WRITTEN_OFF' : rec.status;
      rec.updatedAt = new Date().toISOString();
      if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { receivable: rec }, rec.id, jeId);
    } catch (e) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
      throw e;
    }

    appendAuditEvent(db, { req, action: 'patient_receivable.written_off', resourceType: 'patientReceivable', resourceId: rec.id, after: { amount: roundedAmt, outstanding: rec.outstandingAmount } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for patient_receivable.written_off:', e.message);
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ الشطب بشكل دائم — حاول مرة أخرى' });
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, receivable: rec, journalId: jeId });
  } catch (err) {
    next(err);
  }
});

// Step 19-20: chronological patient statement with a running balance.
app.get('/api/patients/:id/statement', requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const patient = (db.patients || []).find(p => p.id === req.params.id);
  if (!patient) return res.status(404).json({ success: false, error: 'المريض غير موجود' });

  const recs = (db.patientReceivables || []).filter(r => r.patientId === patient.id);
  const rows = [];
  recs.forEach(r => {
    rows.push({ date: r.serviceDate, type: 'receivable', reference: r.reference || r.number, description: r.description, change: r.grossAmount, sourceId: r.id });
    (r.collections || []).filter(c => !c.reversed).forEach(c => rows.push({ date: c.date, type: 'collection', reference: c.id, description: 'تحصيل', change: -c.amount, sourceId: r.id }));
    (r.credits || []).forEach(c => rows.push({ date: c.date, type: 'credit', reference: c.id, description: c.reason || 'إشعار دائن', change: -c.amount, sourceId: r.id }));
    if (r.writeOff) rows.push({ date: r.writeOff.date, type: 'writeoff', reference: r.writeOff.jeId, description: 'شطب دين معدوم', change: -r.writeOff.amount, sourceId: r.id });
  });
  rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  let running = 0;
  rows.forEach(row => { running = parseFloat((running + row.change).toFixed(3)); row.runningBalance = running; });

  res.json({ success: true, patient, rows, endingBalance: parseFloat(running.toFixed(3)) });
});

// Step 21-25: AR aging for non-insurance patient receivables — a SEPARATE
// endpoint from GET /api/ar-aging (which is 100% insurance-claims-only, see
// its code above) so the two debtor types are never combined, per explicit
// instruction. Buckets match the AP-aging convention for consistency:
// current(<=30) / days30(<=60) / days60(<=90) / over90(>90).
app.get('/api/patient-ar-aging', requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const today   = new Date();
  const asOfStr = req.query.asOf && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf) ? req.query.asOf : today.toISOString().slice(0, 10);
  const asOf    = new Date(asOfStr);

  const items = [];
  // Source 1: patientReceivables[] — ages the OUTSTANDING amount only.
  (db.patientReceivables || []).filter(r => r.status !== 'CANCELLED' && r.status !== 'COLLECTED' && r.status !== 'WRITTEN_OFF' && r.outstandingAmount > 0.001).forEach(r => {
    const ageFrom = r.dueDate || r.serviceDate;
    const days = Math.floor((asOf - new Date(ageFrom)) / 86400000);
    items.push({ source: 'patient-receivable', id: r.id, number: r.number, patient: r.patientName, patientId: r.patientId, description: r.description || r.reference,
      original: r.grossAmount, collected: r.collectedAmount, outstanding: r.outstandingAmount,
      documentDate: r.serviceDate, dueDate: r.dueDate || null, ageFrom, days });
  });
  // Source 2 (Step 25 — legacy, honestly surfaced): db.patientAR[] opening
  // import — no collection-tracking field of its own (P6-029's original
  // finding), so its full face amount is the best-available outstanding
  // figure; any real-world collection recorded outside this new subledger
  // will show up as a GL reconciliation difference below, not be hidden.
  (db.patientAR || []).forEach(p => {
    const amt = parseFloat(p.amount) || 0;
    if (amt <= 0.001) return;
    const ageFrom = p.date || null;
    const days = ageFrom ? Math.floor((asOf - new Date(ageFrom)) / 86400000) : 0;
    items.push({ source: 'patient-opening', id: 'OB-' + p.id, number: 'OB-' + p.id, patient: p.name, patientId: null, description: 'رصيد افتتاحي' + (p.fileNo ? ' — ملف ' + p.fileNo : ''),
      original: amt, collected: 0, outstanding: amt, documentDate: ageFrom, dueDate: null, ageFrom, days });
  });

  // P1 adversarial-review fix (P2 finding, identity persona): was grouped by
  // `it.patient` (== the receivable's own patientName, a NAME SNAPSHOT taken
  // at creation time — buildAndPostPatientReceivable copies patient.name
  // onto the record once, it is never a live reference). The new, sanctioned
  // PUT /api/patients/:id name-edit silently fragmented one real patient's
  // total exposure across multiple named rows in this exact aging report the
  // moment any of their receivables predated the rename. Grouped by the real
  // `patientId` instead wherever one exists (only the legacy patient-opening
  // source genuinely has no patientId, so it still falls back to name there
  // — nothing else does). Purely a display/grouping fix — the underlying
  // outstanding amounts, bucket math, and GL total below are unchanged.
  const byPatient = {};
  items.forEach(it => {
    const key = it.patientId || ('name:' + (it.patient || 'غير محدد'));
    if (!byPatient[key]) byPatient[key] = { patient: it.patient, patientId: it.patientId, total: 0, buckets: { current: 0, days30: 0, days60: 0, over90: 0 }, count: 0, items: [] };
    const row = byPatient[key];
    row.total = parseFloat((row.total + it.outstanding).toFixed(3));
    row.count++;
    row.items.push(it);
    if      (it.days <= 30) row.buckets.current += it.outstanding;
    else if (it.days <= 60) row.buckets.days30  += it.outstanding;
    else if (it.days <= 90) row.buckets.days60  += it.outstanding;
    else                     row.buckets.over90  += it.outstanding;
  });
  const rows = Object.values(byPatient).map(r => {
    Object.keys(r.buckets).forEach(k => r.buckets[k] = parseFloat(r.buckets[k].toFixed(3)));
    if (r.patientId) {
      const livePatient = (db.patients || []).find(p => p.id === r.patientId);
      if (livePatient) r.patient = livePatient.name; // always the current name, never a stale snapshot
    }
    return r;
  });

  const subledgerTotal = parseFloat(items.reduce((s, it) => s + it.outstanding, 0).toFixed(3));
  const bm = buildBalanceMap(db, null, asOfStr);
  const b1200 = bm['1200'] || { debit: 0, credit: 0 };
  const glTotal = parseFloat((b1200.debit - b1200.credit).toFixed(3));
  const difference = parseFloat((subledgerTotal - glTotal).toFixed(3));
  const reconciled = Math.abs(difference) <= 0.005;

  res.json({
    asOf: asOfStr, rows, subledgerTotal, count: items.length,
    reconciliation: {
      subledgerTotal, glTotal, difference, reconciled,
      note: reconciled
        ? 'يطابق تمامًا — كل نشاط حساب 1200 مصدره patientReceivables[]/الأرصدة الافتتاحية في هذه البيانات.'
        : 'فرق حقيقي — على الأرجح تحصيل تاريخي مسجَّل خارج هذا الدفتر الفرعي لرصيد افتتاحي مستورد (لا تتبع تحصيل خاص به)، أو نشاط آخر على حساب 1200. مُعروض بصدق، لا مُجبَر على الصفر.',
    },
  });
});

// ===== INVENTORY API =====
const DEFAULT_INV_CATS = [
  { id:'CAT-1', name:'مواد التقويم', subs:['براكيت','أسلاك','مواد طبع'] },
  { id:'CAT-2', name:'مواد الزراعة', subs:['غرسات','أطواق','أغطية'] },
  { id:'CAT-3', name:'مواد الحشو', subs:['كمبوزيت','أملغم','مواد تجويف'] },
  { id:'CAT-4', name:'مواد التبييض', subs:['جل تبييض','صواني'] },
  { id:'CAT-5', name:'أدوية ومخدرات', subs:['مخدر موضعي','مضادات حيوية','مسكنات'] },
  { id:'CAT-6', name:'مستلزمات عامة', subs:['قفازات','كمامات','إبر','مناديل'] },
];

// Items CRUD
app.get('/api/inv/items', requirePermission('inventory', 'view'), (req, res) => {
  const db = loadDB();
  res.json(db.invItems || []);
});

app.post('/api/inv/items', requireAuth, requirePermission('inventory', 'add'), (req, res) => {
  const db = loadDB();
  if (!db.invItems) db.invItems = [];
  // Allowlist fields — prevent mass assignment
  const { id, name, code, category, unit, costPrice, salePrice, quantity, minQty, description } = req.body;
  const safeBody = { id, name, code, category, unit, costPrice, salePrice, quantity, minQty, description };
  const idx = db.invItems.findIndex(i => i.id === id);
  // R5 (staging validation, adversarial review — P1, live-reproduced): an
  // empty {} body silently created a permanent, nameless inventory item.
  // Only enforced on genuine CREATE (no existing record matched by id) — a
  // partial update of other fields on an existing item must not require
  // re-sending name every time.
  if (idx === -1 && (!name || !String(name).trim())) {
    return res.status(400).json({ success: false, error: 'اسم الصنف مطلوب' });
  }
  const before = idx !== -1 ? { ...db.invItems[idx] } : undefined;
  let item;
  if (idx !== -1) {
    db.invItems[idx] = { ...db.invItems[idx], ...safeBody };
    item = db.invItems[idx];
  } else {
    item = { ...safeBody, id: id || genId('inv-'), createdAt: new Date().toISOString() };
    db.invItems.push(item);
  }
  appendAuditEvent(db, { req, action: before ? 'inventory_item.updated' : 'inventory_item.created', resourceType: 'invItem', resourceId: item.id, before, after: item });
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/inv/items/:id', requirePermission('inventory', 'delete'), (req, res) => {
  const db = loadDB();
  const item = (db.invItems || []).find(i => i.id === req.params.id);
  db.invItems = (db.invItems || []).filter(i => i.id !== req.params.id);
  if (item) appendAuditEvent(db, { req, action: 'inventory_item.deleted', resourceType: 'invItem', resourceId: item.id, before: { name: item.name } });
  saveDB(db);
  res.json({ success: true });
});

// Categories
app.post('/api/inv/categories', requireAuth, requirePermission('inventory', 'add'), (req, res) => {
  const db = loadDB();
  const cats = req.body.categories;
  if (!Array.isArray(cats)) return res.status(400).json({ error: 'categories must be an array' });
  db.invCategories = cats.map(c => ({ id: c.id, name: String(c.name || '').slice(0, 100) }));
  appendAuditEvent(db, { req, action: 'inventory_categories.updated', resourceType: 'invCategories', after: { count: db.invCategories.length } });
  saveDB(db);
  res.json({ success: true });
});

// Inventory Operations (purchase / consume / adjust)
app.post('/api/inv/operation', requirePermission('inventory', 'add'), (req, res) => {
  const db = loadDB();
  if (!db.invItems)     db.invItems = [];
  if (!db.invMovements) db.invMovements = [];
  if (!db.journalEntries) db.journalEntries = [];

  const { type, date, lines, notes, vendorId, invoice, payAccount, extra } = req.body;
  const movId = 'MOV-' + Date.now();
  const jeId  = 'JE-INV-' + Date.now();
  const total = lines.reduce((s, l) => s + l.qty * l.cost, 0);

  // --- build journal entry ---
  const accounts = db.chartOfAccounts || [];
  const findAcc  = (code) => accounts.find(a => a.code === code || a.id === code) || { id: code, code, name: code };
  // P0.2: كان يرحّل على 1160 (غير موجود بالشجرة) فيختفي القيد من القوائم المالية
  // ويرفضه المدقّق المركزي الآن — الحساب الصحيح هو 1300 (المخزون — مستلزمات طبية).
  const inv1160  = ensureAccount(db, '1300', 'المخزون — مستلزمات طبية', 'asset', '1000');

  let jeLines = [];
  let desc = '';

  if (type === 'purchase') {
    const payAcc = findAcc(payAccount || '2100');
    const vendor = (db.vendors || []).find(v => v.id === vendorId);
    desc = `شراء مواد مخزون${vendor ? ' من ' + vendor.name : ''}${invoice ? ' — فاتورة ' + invoice : ''}`;
    jeLines = [
      { accountId: inv1160.id, accountCode: inv1160.code, accountName: inv1160.name, debit: total, credit: 0 },
      { accountId: payAcc.id,  accountCode: payAcc.code  || payAccount, accountName: payAcc.name || payAccount, debit: 0, credit: total },
    ];
    // if credit/AP, also link to vendor account
    if (payAccount === '2100' && vendor) {
      const vendorAcc = findAcc(vendor.accountId);
      jeLines[1] = { accountId: vendorAcc.id, accountCode: vendorAcc.code || vendor.accountId, accountName: vendor.name, debit: 0, credit: total };
    }
  } else if (type === 'consume') {
    const exp5210 = findAcc('5210');
    desc = `استهلاك مواد مخزون${extra ? ' — ' + extra : ''}`;
    jeLines = [
      { accountId: exp5210.id, accountCode: exp5210.code || '5210', accountName: exp5210.name || 'مصروف مواد', debit: total, credit: 0 },
      { accountId: inv1160.id, accountCode: inv1160.code, accountName: inv1160.name, debit: 0, credit: total },
    ];
  } else if (type === 'adjust') {
    const netQtyChange = lines.reduce((s,l) => s + l.qty, 0);
    if (netQtyChange < 0) {
      // decrease: debit inventory-shortage expense, credit inventory
      // P0.2: كان يرحّل على 5215/5670 (غير موجودين) — الآن 5230 المخصّص فعلياً.
      const exp5215 = ensureAccount(db, '5230', 'مصروف نقص/تسوية مخزون', 'expense', '5200');
      desc = `تسوية مخزون (نقص)${extra ? ' — ' + extra : ''}`;
      jeLines = [
        { accountId: exp5215.id, accountCode: exp5215.code, accountName: exp5215.name, debit: Math.abs(total), credit: 0 },
        { accountId: inv1160.id, accountCode: inv1160.code, accountName: inv1160.name, debit: 0, credit: Math.abs(total) },
      ];
    } else {
      // increase: debit inventory, credit equity adjustment 3200
      const eq3200 = findAcc('3200');
      desc = `تسوية مخزون (زيادة)${extra ? ' — ' + extra : ''}`;
      jeLines = [
        { accountId: inv1160.id, accountCode: inv1160.code, accountName: inv1160.name, debit: total, credit: 0 },
        { accountId: eq3200.id,  accountCode: eq3200.code || '3200', accountName: eq3200.name || 'حقوق الملكية', debit: 0, credit: total },
      ];
    }
  }

  const journalEntry = {
    id: jeId, date, desc, ref: movId, type: 'inventory',
    totalDebit: total, totalCredit: total,
    createdAt: new Date().toISOString(),
    lines: jeLines,
  };

  // P0.3 — Pattern A (validate before mutation): the journal is validated
  // FIRST, before touching item quantities/cost. A rejected posting (e.g.
  // locked period) must never leave stock levels changed with no matching
  // journal entry.
  const guardResult = validateJournalEntry(db, journalEntry);
  if (!guardResult.ok) throw new JournalValidationError(guardResult.error, guardResult.status, guardResult.code);

  // --- update item quantities (FIFO tracked via cost) — only now, after the
  // journal is confirmed postable ---
  lines.forEach(l => {
    const item = db.invItems.find(i => i.id === l.itemId);
    if (!item) return;
    if (type === 'purchase')      item.qty += l.qty;
    else if (type === 'consume')  item.qty = Math.max(0, item.qty - l.qty);
    else if (type === 'adjust') {
      item.qty = Math.max(0, item.qty + l.qty); // qty can be negative for decrease
    }
    item.cost = l.cost; // update unit cost on purchase (FIFO last-in simplification)
  });

  db.journalEntries.push(journalEntry);

  // save movement record
  db.invMovements.push({
    id: movId, type, date, notes: notes || '',
    journalId: jeId,
    vendorId, invoice, payAccount, extra,
    items: lines,
    total,
  });

  appendAuditEvent(db, { req, action: `inventory_operation.${type}`, resourceType: 'invMovement', resourceId: movId, after: { type, total, itemCount: lines.length } });
  saveDB(db);

  // real-time low-stock alert via automation engine
  lines.forEach(l => {
    const item = db.invItems.find(i => i.id === l.itemId);
    if (item) checkInventoryAlert(item);
  });

  res.json({ success: true, journalId: jeId, movId });
});

// COA endpoint
// ═══ COA — دليل الحسابات ════════════════════════════════

// Helper: compute balances for all accounts from journal entries
function computeCoaBalances(accounts, entries) {
  const bal = {};
  (entries || []).forEach(je => {
    (je.lines || []).forEach(l => {
      const key = l.accountId || l.accountCode || l.account;
      if (!key) return;
      if (!bal[key]) bal[key] = { debit: 0, credit: 0 };
      bal[key].debit  += parseFloat(l.debit)  || 0;
      bal[key].credit += parseFloat(l.credit) || 0;
    });
  });
  const DEBIT_NATURE  = ['asset','expense'];
  const CREDIT_NATURE = ['liability','equity','revenue'];
  return accounts.map(a => {
    const b = bal[a.id] || bal[a.code] || { debit:0, credit:0 };
    const net = DEBIT_NATURE.includes(a.type)
      ? b.debit - b.credit
      : b.credit - b.debit;
    return { ...a, debit: b.debit, credit: b.credit, balance: net };
  });
}

// Helper: check if account has journal entries
function accountHasEntries(db, id) {
  return (db.journalEntries || []).some(je =>
    (je.lines || []).some(l => l.accountId === id || l.accountCode === id || l.account === id)
  );
}

// ═══════════════════════════════════════════════════════════════════════
// P0.9 — COA integrity guards (Parts C/D/E/F)
// ═══════════════════════════════════════════════════════════════════════
// Deliberately centralized here — not because every account-code literal in
// this file is being routed through a new abstraction (that would be the
// "giant refactor" this milestone explicitly warns against), but because
// these FEW specific safety checks (type-lock, cycle prevention, delete
// protection) must be enforced consistently at the three COA mutation
// routes, and scattering copies of the same logic across them would be the
// real risk.

// System-controlled account codes: every code this codebase relies on
// PROGRAMMATICALLY (referenced via a hardcoded fallback object or
// ensureAccount() lazy-creation, or the default account for a core
// mechanism) — verified by direct repository search, not guessed. Deleting
// any of these would either silently start posting to a phantom
// in-memory-only account (Invariant E then rejects with UNKNOWN_ACCOUNT) or
// break a report that assumes it exists. This does NOT include ordinary
// user expense-category accounts, which remain freely deletable when unused.
const SYSTEM_PROTECTED_ACCOUNT_CODES = new Set([
  '1100','1110','1120','1125','1130','1200','1300','1900', // cash/bank/K-Net-Visa-Master/حسابي/insurance AR/patient AR/inventory/suspense
  '2100','2200','2210','2600','2700','2800','2900',        // vendor AP group/payroll payable/payroll deductions/PIFSS payable/EOS liability/doctor commission payable/accrued expenses
  '3100','3300',                                            // opening-balance equity/closing transfer
  '4100','4110','4120','4130','4140','4150','4160','4200', // revenue channels incl. insurance
  '5100','5110','5120','5130','5140','5230',                // payroll expense group + leaves (PIFSS/EOS expense sides), inventory adjustment
  // R3: 5710/5720 comment corrected — they are "هاتف وإنترنت"/"إقامات
  // وتأشيرات" (ordinary, actively category-mapped expense accounts, see
  // server.js:3113), not the bad-debt accounts a stale comment here used to
  // claim. 5920 (patient bad-debt write-off, P0.8/R2) and 5930 (insurance
  // doubtful-debt write-off, P0.9/R3) are the REAL accounts those reports
  // depend on and were missing from this protected set entirely.
  '5700','5710','5720','5750','5920','5930',                 // general admin (parent)/phone-internet/residency-visas/bank fees/patient bad debt/insurance doubtful debt
]);

// P6-007: walks the ancestor chain starting at `startRef` (an id or code),
// bounded to 50 hops — returns true if `targetId`/`targetCode` appears
// anywhere in that chain (including immediately, covering the self-parent
// case), meaning assigning `startRef` as the account's new parent would
// create a cycle. A broken/orphan ancestor mid-chain just stops the walk
// (that is P6-006's concern, not a cycle).
function coaParentCycleExists(coa, targetId, targetCode, startRef) {
  let cur = startRef;
  let hops = 0;
  while (cur != null && hops < 50) {
    if (String(cur) === String(targetId) || String(cur) === String(targetCode)) return true;
    const acc = coa.find(a => String(a.id) === String(cur) || String(a.code) === String(cur));
    if (!acc) return false;
    cur = acc.parent;
    hops++;
  }
  return hops >= 50; // an unexpectedly-long chain is treated as suspicious/cyclic too
}

// Every account/subledger/config reference to `acc` besides raw journal
// lines (already covered by accountHasEntries) — Part E, Step 14. Returns a
// human-readable reason string, or null if genuinely unreferenced.
function coaAccountReferenceReason(db, acc) {
  const code = String(acc.code), id = String(acc.id);
  const match = v => v != null && (String(v) === code || String(v) === id);
  if ((db.vendors || []).some(v => match(v.accountId)))
    return 'مرتبط بحساب مورد (vendors[].accountId)';
  if ((db.vendorBills || []).some(b => match(b.liabilityAccountCode)))
    return 'مرتبط بفاتورة مورد (vendorBills[].liabilityAccountCode)';
  if ((db.patientReceivables || []).some(r => match(r.receivableAccountCode) || match(r.revenueAccountCode)))
    return 'مرتبط بذمة مريض (patientReceivables[])';
  const settings = db.accountingSettings || {};
  if (match(settings.accReceivable) || match(settings.accRetained))
    return 'حساب مُعرَّف في إعدادات النظام (accountingSettings)';
  return null;
}

// Bulk save (legacy - keep for backward compat)
app.post('/api/coa', requirePermission('coa', 'edit'), (req, res) => {
  const db = loadDB();
  const before = (db.chartOfAccounts || []).length;
  db.chartOfAccounts = req.body.chartOfAccounts;
  appendAuditEvent(db, { req, action: 'coa.bulk_replaced', resourceType: 'chartOfAccounts', before: { count: before }, after: { count: (db.chartOfAccounts || []).length } });
  saveDB(db);
  res.json({ success: true });
});

// GET all accounts (with optional balances)
app.get('/api/coa', requirePermission('coa', 'view'), (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  if (req.query.withBalances === '1') {
    res.json(computeCoaBalances(coa, db.journalEntries));
  } else {
    res.json(coa);
  }
});

// GET with balances
app.get('/api/coa/balances', requirePermission('coa', 'view'), (req, res) => {
  const db = loadDB();
  res.json(computeCoaBalances(db.chartOfAccounts || [], db.journalEntries));
});

// GET duplicates
app.get('/api/coa/duplicates', requirePermission('coa', 'view'), (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  const codeSeen = {}, nameSeen = {}, dups = [];
  coa.forEach(a => {
    if (codeSeen[a.code]) dups.push({ type:'code', value:a.code, ids:[codeSeen[a.code], a.id] });
    else codeSeen[a.code] = a.id;
    const nameKey = a.name?.trim().toLowerCase();
    if (nameKey && nameSeen[nameKey]) dups.push({ type:'name', value:a.name, ids:[nameSeen[nameKey], a.id] });
    else if (nameKey) nameSeen[nameKey] = a.id;
  });
  res.json(dups);
});

// POST — add single account
app.post('/api/coa/account', requirePermission('coa', 'add'), async (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  const { code, name, type, parent, description, isGroup, normalBalance } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'رقم الحساب والاسم مطلوبان' });

  // ── تطبيع/تصحيح كود الحساب — يمنع الأكواد الخاطئة (مثل 50 أو 59010) ──
  const { suggestChildCode } = require('./lib/coaCodes');
  let finalCode = String(code).trim();
  let finalParent = parent || null;
  let corrected = false;
  if (!/^\d+$/.test(finalCode))
    return res.status(400).json({ error: 'رقم الحساب يجب أن يكون أرقاماً فقط' });
  // العرض القياسي لأكواد الحسابات (الأكثر شيوعاً) — عادة 4 خانات
  const leafCodes = coa.filter(a => !a.isGroup && /^\d+$/.test(String(a.code))).map(a => String(a.code).length);
  const freq = {}; leafCodes.forEach(w => freq[w] = (freq[w] || 0) + 1);
  const stdWidth = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
  const p = finalParent ? coa.find(a => a.id === finalParent || a.code === finalParent) : null;
  const wrongWidth = stdWidth && finalCode.length !== Number(stdWidth);
  const taken = coa.some(a => String(a.code) === finalCode);
  if ((p || wrongWidth) && (wrongWidth || taken)) {
    // اقترح رقماً صحيحاً — حتى لو كانت المجموعة ممتلئة (ينزل لمجموعة فرعية مثل 5910)
    const base = p ? String(p.code) : (coa.find(a => !a.parent && /^\d+$/.test(String(a.code)) && String(a.code)[0] === finalCode[0])?.code);
    const s = base ? suggestChildCode(String(base), coa) : null;
    if (s) {
      finalCode = s.code;
      const realParent = coa.find(a => String(a.code) === s.parentCode || String(a.id) === s.parentCode);
      if (realParent) finalParent = String(realParent.id || realParent.code);
      corrected = true;
    } else if (wrongWidth) {
      return res.status(400).json({ error: `رقم الحساب "${finalCode}" غير صحيح (المعيار ${stdWidth} خانات) ولا يوجد رقم بديل متاح — اختر مجموعة فرعية أخرى` });
    }
  }
  if (coa.some(a => String(a.code) === finalCode))
    return res.status(400).json({ error: 'رقم الحساب موجود مسبقاً' });

  // P0.9 — P6-006: the correction block above only resolves `finalParent`
  // when a code-width mismatch or code collision triggered it — a directly-
  // supplied `parent` referencing a NON-existent account otherwise sailed
  // through untouched, creating an orphan invisible in any tree view.
  let finalParentAcc = null;
  if (finalParent) {
    finalParentAcc = coa.find(a => String(a.id) === String(finalParent) || String(a.code) === String(finalParent));
    if (!finalParentAcc) {
      return res.status(400).json({ error: `الحساب الأب "${finalParent}" غير موجود في شجرة الحسابات`, code: 'PARENT_NOT_FOUND' });
    }
    // Part D/Step 10: a leaf account's fundamental type must match its
    // parent's — DEFAULT_COA's own group accounts already satisfy this
    // (1000=asset parents 1500=asset, 2000=liability, etc.), so this only
    // ever rejects a genuinely new inconsistency, never existing data.
    const childType = type || 'expense';
    if (finalParentAcc.type && finalParentAcc.type !== childType) {
      return res.status(400).json({ error: `نوع الحساب (${childType}) لا يتوافق مع نوع الحساب الأب "${finalParentAcc.name}" (${finalParentAcc.type})`, code: 'INCOMPATIBLE_PARENT_TYPE' });
    }
  }

  const acc = {
    id: finalCode, code: finalCode, name, type: type||'expense',
    parent: finalParent, description: description||'', isGroup: !!isGroup,
    normalBalance: normalBalance || (['asset','expense'].includes(type) ? 'debit' : 'credit'),
    status: 'active', balance: 0, createdAt: new Date().toISOString()
  };
  coa.push(acc);
  coa.sort((a,b) => String(a.code||"").localeCompare(String(b.code||"")));
  db.chartOfAccounts = coa;
  appendAuditEvent(db, { req, action: 'coa.account_created', resourceType: 'chartOfAccounts', resourceId: acc.code, after: { code: acc.code, name: acc.name, type: acc.type } });
  // P0.9 — Part M/Step 35: COA is a control structure every other financial
  // route depends on — a "success" response must not outrun durable
  // persistence, same convention as the P0.7/P0.8 subledger routes.
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for coa.account_created:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ الحساب بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true, account: acc, corrected, requestedCode: corrected ? String(code).trim() : undefined });
});

// إصلاح شامل لشجرة الحسابات: أكواد خاطئة (50/59010) + معرّفات ناقصة + آباء مفقودين + تحديث القيود
app.post('/api/coa/fix-codes', requireAuth, requirePermission('coa', 'edit'), (req, res) => {
  const db  = loadDB();
  const { repairChart } = require('./lib/coaCodes');
  const changes = repairChart(db.chartOfAccounts || [], db.journalEntries || []);
  if (changes.length) {
    (db.auditLog = db.auditLog || []).unshift({
      id: 'AUD-' + Date.now(), at: new Date().toISOString(), user: req.user?.username || 'system',
      action: 'coa-repair', details: changes
    });
    appendAuditEvent(db, { req, action: 'coa.fix_codes', resourceType: 'chartOfAccounts', after: { changesCount: changes.length } });
    saveDB(db);
  }
  res.json({ success: true, fixed: changes.length, changes });
});

// ── الإصلاح الذاتي الشامل — يستخدمه "المُجرِّب" وعند إقلاع الخادم ──
// إصلاحات حتمية فقط (لا ذكاء اصطناعي): شجرة الحسابات، حسابات القيود المفقودة،
// إجماليات القيود، القيود الفارغة، قيود رواتب على حسابات خاطئة، أرصدة موردين
// ممسوحة. كل إصلاح يُسجَّل في سجل التدقيق مع نسخة احتياطية.
function runAutoRepairSuite(db) {
  const applied = [];
  const r3 = n => Math.round((Number(n) || 0) * 1000) / 1000;

  // 1. شجرة الحسابات: أكواد خاطئة (50/59010) + معرّفات ناقصة + آباء مفقودين
  const { repairChart } = require('./lib/coaCodes');
  repairChart(db.chartOfAccounts || [], db.journalEntries || [])
    .forEach(c => applied.push({ area: 'شجرة الحسابات', ...c }));

  // 2. حسابات مستخدمة في القيود لكنها غير موجودة بالشجرة → إعادة إنشائها
  const coa = db.chartOfAccounts = db.chartOfAccounts || [];
  const codes = new Set(coa.map(a => String(a.code)));
  const typeByPrefix = { '1':'asset','2':'liability','3':'equity','4':'revenue','5':'expense' };
  const missing = new Map();
  for (const e of db.journalEntries || []) for (const l of e.lines || []) {
    const c = String(l.accountCode || l.accountId || '');
    if (c && /^\d{3,6}$/.test(c) && !codes.has(c) && !missing.has(c))
      missing.set(c, l.accountName || l.account || '');
  }
  for (const [code, nm] of missing) {
    const root = coa.find(a => !a.parent && /^\d+$/.test(String(a.code)) && String(a.code)[0] === code[0]);
    coa.push({ id: code, code, name: nm && !/^\d+$/.test(String(nm)) ? nm : ('حساب مستعاد ' + code),
      type: typeByPrefix[code[0]] || 'expense',
      parent: root ? String(root.id || root.code) : null, isGroup: false, status: 'active', balance: 0,
      description: 'أُنشئ تلقائياً — كان مستخدماً في القيود وغير موجود بالشجرة',
      createdAt: new Date().toISOString() });
    codes.add(code);
    applied.push({ area: 'شجرة الحسابات', action: 'account-restored', name: nm || code, to: code });
  }

  // 2ب. ضمان وجود حساب معلّق (Suspense) — مكان مؤقّت لأي مبلغ بنكي غير محدّد حتى تصنيفه
  if (!codes.has('1900')) {
    ensureAccount(db, '1900', 'حساب معلّق — تسوية مؤقتة (Suspense)', 'asset', '1000');
    codes.add('1900');
    applied.push({ area: 'شجرة الحسابات', action: 'account-added', name: 'حساب معلّق — تسوية مؤقتة', to: '1900' });
  }

  // 2ج. توحيد قيود إيرادات البطاقات القديمة (auto-income) على نموذج «مستحقات الشبكة» الموحّد.
  //    قبل هذا التوحيد كانت الفترة قبل «حسابي» تُرحَّل صافياً للبنك مباشرة (1110+5750)،
  //    وفترة «حسابي» تُرحَّل بالإجمالي على 1125 بدون فصل عمولة. كلاهما يُعاد بناؤه هنا:
  //    مدين 1125 (صافي بعد العمولة الحالية بالإعدادات) + مدين 5750 (العمولة) — بنفس إجمالي
  //    الإيراد الدائن (4110/4120/4130/4140) الذي يبقى كما هو (المصدر الموثوق). idempotent.
  {
    const cfgFee = loadConfig();
    const feeKnetR  = typeof cfgFee.feeKnet === 'number' ? cfgFee.feeKnet : 0.0065;
    const feeCardR  = typeof cfgFee.feeCard === 'number' ? cfgFee.feeCard : 0.0265;
    const acc1125 = coa.find(a => a.code === '1125') || ensureAccount(db, '1125', 'مستحقات الشبكة — Visa/Master/KNET/Link', 'asset', '1000');
    const acc5750 = coa.find(a => a.code === '5750') || ensureAccount(db, '5750', 'مصاريف بنكية وعمولات', 'expense', '5700');
    const cardKeywordRe = /كي-نت|كي نت|فيزا|ماستر|لينك|knet|visa|master|link/i;
    const postCard2 = (out, gross, rate, remarks) => {
      if (gross <= 0) return;
      const fee = r3(gross * rate), net = r3(gross - fee);
      out.push({ accountId: acc1125.id, accountCode: '1125', accountName: acc1125.name, debit: net, credit: 0, remarks: `${remarks} (صافي بعد عمولة ${(rate*100).toFixed(2)}% — يُصفّى عبر البنك)` });
      if (fee > 0) out.push({ accountId: acc5750.id, accountCode: '5750', accountName: acc5750.name, debit: fee, credit: 0, remarks: `عمولة الشبكة ${(rate*100).toFixed(2)}% — ${remarks}` });
    };
    let unifiedCount = 0;
    for (const je of db.journalEntries || []) {
      if (je.type !== 'auto-income' || je._receivableModelFixed) continue;
      const lines = je.lines || [];
      const grossOf = code => r3(lines.filter(l => l.accountCode === code).reduce((s, l) => s + (parseFloat(l.credit) || 0), 0));
      const gKnet = grossOf('4110'), gVisa = grossOf('4120'), gMaster = grossOf('4130'), gLink = grossOf('4140');
      if (!gKnet && !gVisa && !gMaster && !gLink) { je._receivableModelFixed = true; continue; } // لا إيراد بطاقات بهذا القيد
      const keep = lines.filter(l => {
        const isCardDebit = (parseFloat(l.debit) || 0) > 0 && (
          l.accountCode === '1125' ||
          ((l.accountCode === '1110' || l.accountCode === '5750') && cardKeywordRe.test(l.remarks || ''))
        );
        return !isCardDebit;
      });
      const fresh = [];
      postCard2(fresh, gKnet, feeKnetR, `كي-نت: ${gKnet} د.ك`);
      if (gVisa + gMaster > 0) {
        const parts = []; if (gVisa > 0) parts.push(`فيزا: ${gVisa} د.ك`); if (gMaster > 0) parts.push(`ماستر: ${gMaster} د.ك`);
        postCard2(fresh, r3(gVisa + gMaster), feeCardR, parts.join(' | '));
      }
      postCard2(fresh, gLink, feeCardR, `لينك: ${gLink} د.ك`);
      je.lines = [...keep, ...fresh];
      je.totalDebit  = r3(je.lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0));
      je.totalCredit = r3(je.lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0));
      je._receivableModelFixed = true;
      unifiedCount++;
    }
    if (unifiedCount) applied.push({ area: 'الإيرادات', action: 'card-revenue-unified-to-receivable', name: unifiedCount + ' قيد إيراد', to: 'مُوحَّد على مستحقات الشبكة 1125 بالصافي + عمولة 5750' });
  }

  // 3. قيود إجماليّها المخزّن لا يطابق بنودها → إعادة احتساب (تظهر بصفر في الشاشة)
  let recomputed = 0;
  for (const e of db.journalEntries || []) {
    const lines = e.lines || [];
    if (!lines.length) continue;
    const d = r3(lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0));
    const c = r3(lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0));
    const badD = e.totalDebit  != null && Math.abs((parseFloat(e.totalDebit)  || 0) - d) > 0.005;
    const badC = e.totalCredit != null && Math.abs((parseFloat(e.totalCredit) || 0) - c) > 0.005;
    if (badD || badC) { e.totalDebit = d; e.totalCredit = c; recomputed++; }
  }
  if (recomputed) applied.push({ area: 'القيود', action: 'totals-recomputed', name: recomputed + ' قيد', to: 'أُعيد احتساب إجمالياته من بنوده' });

  // 4. قيود فارغة تماماً (بدون أي بنود) → تُحذف مع حفظ نسخة كاملة في سجل التدقيق
  const emptyOnes = (db.journalEntries || []).filter(e => !(e.lines || []).length);
  if (emptyOnes.length) {
    db.journalEntries = (db.journalEntries || []).filter(e => (e.lines || []).length);
    applied.push({ area: 'القيود', action: 'empty-entries-removed', name: emptyOnes.length + ' قيد فارغ', backup: emptyOnes });
  }

  // 5. قيود الرواتب القديمة على حسابات خاطئة (2100 ذمم الموردين / 5200 تكلفة المواد)
  //    → تُنقل للحسابات الصحيحة (2200 رواتب مستحقة / 5120 راتب إداري) — IAS 19.
  //    هذا يصحّح الميزانية (الرصيد السالب في الرواتب المستحقة) وقائمة الدخل معاً.
  {
    const { payrollAccounts } = require('./lib/coaCodes');
    const pa = payrollAccounts(coa);
    let remapped = 0;
    for (const e of db.journalEntries || []) {
      if (!['payroll', 'payroll_payment'].includes(e.type)) continue;
      for (const l of e.lines || []) {
        if (String(l.accountCode) === '2100') {
          l.accountCode = pa.payable.code; l.accountId = pa.payable.id; l.accountName = pa.payable.name; remapped++;
        } else if (String(l.accountCode) === '5200' && e.type === 'payroll') {
          l.accountCode = pa.expAdmin.code; l.accountId = pa.expAdmin.id; l.accountName = pa.expAdmin.name; remapped++;
        }
      }
    }
    if (remapped) applied.push({ area: 'الرواتب', action: 'payroll-accounts-remapped', name: remapped + ' بند', to: 'نُقلت قيود الرواتب من حسابات الموردين/المواد إلى 2200/5120' });
  }

  // 6. موردون رصيدهم الافتتاحي مخزّن لكن قيده مفقود (مُسح سابقاً بخطأ قديم) → إعادة إنشائه
  {
    let restored = 0;
    (db.vendors || []).forEach(v => {
      const amt = parseFloat(v.openingBalance) || 0;
      if (amt <= 0) return;
      const jeId = 'JE-VND-OPEN-' + v.id;
      const exists = (db.journalEntries || []).some(e => e.id === jeId || e.ref === 'OPEN-' + v.id || e.reference === 'OPEN-' + v.id);
      if (!exists) { setVendorOpening(db, v, amt, v.openingDate); restored++; applied.push({ area: 'الموردون', action: 'vendor-opening-restored', name: v.name, to: amt + ' د.ك' }); }
    });
  }

  // 7. توحيد مراجع قيود الأرصدة الافتتاحية القديمة (كانت أرقاماً طويلة مبهمة مثل OPEN-VND-1783...)
  //    → مراجع قصيرة مقروءة: مورد OB-<كود الحساب> / مخزون OB-INV / مرضى OB-PAT / عام OPENING
  {
    let normalized = 0;
    for (const e of db.journalEntries || []) {
      const id = String(e.id || '');
      let ref = null;
      if (id.startsWith('JE-VND-OPEN-') || e.type === 'vendor-opening' || e.source === 'vendor-opening') {
        const vLine = (e.lines || []).find(l => String(l.accountCode) !== '3900');
        const code = vLine ? (vLine.accountCode || vLine.accountId) : '';
        ref = code ? 'OB-' + code : 'OB';
      } else if (id.startsWith('JE-INV-OPEN-') || e.source === 'import-inventory-opening') {
        ref = 'OB-INV';
      } else if (id.startsWith('JE-PAT-OPEN-') || e.source === 'import-patient-opening') {
        ref = 'OB-PAT';
      } else if (id.startsWith('JE-OPEN-') || e.type === 'opening') {
        ref = 'OPENING';
      }
      if (ref && (e.ref !== ref || e.reference !== ref)) {
        e.ref = ref; e.reference = ref; normalized++;
      }
    }
    if (normalized) applied.push({ area: 'القيود', action: 'opening-refs-normalized', name: normalized + ' قيد افتتاحي', to: 'مراجع قصيرة مقروءة (OB-...)' });
  }

  // 8. مزامنة أسماء الحسابات في بنود القيود مع الأسماء الحالية في الشجرة
  //    (يصلح الحسابات التي غُيّر اسمها سابقاً ولم ينعكس على القيود القديمة)
  {
    const byId   = new Map(coa.map(a => [String(a.id), a]));
    const byCode = new Map(coa.map(a => [String(a.code), a]));
    let synced = 0;
    for (const e of db.journalEntries || []) for (const l of e.lines || []) {
      const acc = byId.get(String(l.accountId)) || byCode.get(String(l.accountCode)) || byCode.get(String(l.accountId));
      if (acc && acc.name && l.accountName !== acc.name) { l.accountName = acc.name; synced++; }
    }
    if (synced) applied.push({ area: 'القيود', action: 'account-names-synced', name: synced + ' بند', to: 'حُدّثت أسماء الحسابات لتطابق الشجرة' });
  }

  // 9. توحيد مراجع المصاريف المستحقة القديمة (كانت ACR-<timestamp> طويلاً) → ACR-0001 مقروء
  {
    let fixedAccrued = 0;
    (db.accruedExpenses || []).slice().sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||''))).forEach(item => {
      if (item.number) return;
      const number = nextAccruedNo(db);
      item.number = number;
      const je = (db.journalEntries || []).find(e => e.id === item.jeId || e.ref === item.id);
      if (je) { je.ref = number; je.reference = number; }
      fixedAccrued++;
    });
    if (fixedAccrued) applied.push({ area: 'المصاريف المستحقة', action: 'accrued-refs-normalized', name: fixedAccrued + ' سجل', to: 'مراجع قصيرة مقروءة (ACR-...)' });
  }

  return applied;
}

app.post('/api/repair/auto', requireAuth, requireAdminAction('repair.auto'), (req, res) => {
  const db = loadDB();
  const applied = runAutoRepairSuite(db);
  if (applied.length) {
    (db.auditLog = db.auditLog || []).unshift({
      id: 'AUD-' + Date.now(), at: new Date().toISOString(), user: req.user?.username || 'system-tester',
      action: 'auto-repair', details: applied
    });
    appendAuditEvent(db, { req, action: 'repair.auto_run', resourceType: 'database', after: { fixedCount: applied.length } });
    saveDB(db);
  }
  res.json({ success: true, fixed: applied.length, applied });
});

// PUT — edit single account
app.put('/api/coa/account/:id', requirePermission('coa', 'edit'), async (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  // Match by id OR code as STRINGS — resilient to numeric codes/ids from old/AI data
  const pid = String(req.params.id);
  const idx = coa.findIndex(a => String(a.id) === pid || String(a.code) === pid);
  if (idx === -1) return res.status(404).json({ error: 'الحساب غير موجود' });
  const { name, type, parent, description, isGroup, normalBalance, status } = req.body;
  const code = req.body.code != null ? String(req.body.code) : null;
  // If code changed and new code already exists → reject
  if (code && code !== String(coa[idx].code) && coa.find(a => String(a.code) === code))
    return res.status(400).json({ error: 'رقم الحساب موجود مسبقاً' });
  const prev = coa[idx];
  const oldCode = String(prev.code);
  const accId   = prev.id;

  // P0.9 — Part M/Step 34: validate BEFORE any mutation — a rejected edit
  // must leave `prev` completely untouched, never a partial modify-then-fail.

  // P6-004: an account's fundamental TYPE cannot change once it has real
  // journal history — computeCoaBalances()/every report derive the display
  // sign from `type` read live, so a retroactive change silently flips the
  // sign of every historical entry without touching a single journal line.
  // Unused accounts keep full flexibility (Step 9 — do not over-restrict
  // harmless configuration).
  if (type !== undefined && type !== prev.type) {
    if (accountHasEntries(db, accId) || accountHasEntries(db, oldCode)) {
      return res.status(409).json({ error: `لا يمكن تغيير نوع الحساب "${prev.name}" — له قيود محاسبية فعلية؛ تغيير النوع بأثر رجعي يقلب إشارة كل تاريخه`, code: 'ACCOUNT_TYPE_LOCKED' });
    }
  }

  // P6-007 + Part D: parent reassignment — cycle, existence, and type-class checks.
  if (parent !== undefined && String(parent) !== String(prev.parent)) {
    if (parent) {
      if (String(parent) === String(accId) || String(parent) === oldCode) {
        return res.status(400).json({ error: 'لا يمكن أن يكون الحساب أباً لنفسه', code: 'CIRCULAR_PARENT' });
      }
      if (coaParentCycleExists(coa, accId, oldCode, parent)) {
        return res.status(400).json({ error: 'تعيين هذا الأب يُنشئ تسلسلاً دائرياً (Circular Parent)', code: 'CIRCULAR_PARENT' });
      }
      const newParentAcc = coa.find(a => String(a.id) === String(parent) || String(a.code) === String(parent));
      if (!newParentAcc) {
        return res.status(400).json({ error: `الحساب الأب "${parent}" غير موجود في شجرة الحسابات`, code: 'PARENT_NOT_FOUND' });
      }
      const prospectiveType = type !== undefined ? type : prev.type;
      if (newParentAcc.type && newParentAcc.type !== prospectiveType) {
        return res.status(400).json({ error: `نوع الحساب (${prospectiveType}) لا يتوافق مع نوع الحساب الأب الجديد "${newParentAcc.name}" (${newParentAcc.type})`, code: 'INCOMPATIBLE_PARENT_TYPE' });
      }
    }
  }

  coa[idx] = { ...prev, ...{ code: code||prev.code, name: name||prev.name, type: type||prev.type,
    parent: parent !== undefined ? parent : prev.parent,
    description: description !== undefined ? description : prev.description,
    isGroup: isGroup !== undefined ? !!isGroup : prev.isGroup,
    normalBalance: normalBalance||prev.normalBalance, status: status||prev.status,
    updatedAt: new Date().toISOString() }};
  const newCode = String(coa[idx].code);
  const newName = coa[idx].name;
  // انشر تغيير الاسم/الرقم على كل بنود القيود المرتبطة بهذا الحساب (مصدر واحد للحقيقة)
  if (newName !== prev.name || newCode !== oldCode) {
    (db.journalEntries || []).forEach(e => (e.lines || []).forEach(l => {
      const match = (l.accountId != null && String(l.accountId) === String(accId)) ||
                    (l.accountCode != null && String(l.accountCode) === oldCode) ||
                    (l.accountId != null && String(l.accountId) === oldCode);
      if (match) {
        l.accountName = newName;
        if (l.accountCode != null && String(l.accountCode) === oldCode) l.accountCode = newCode;
        if (l.accountId   != null && String(l.accountId)   === oldCode) l.accountId   = newCode;
      }
    }));
  }
  coa.sort((a,b) => String(a.code||"").localeCompare(String(b.code||"")));
  db.chartOfAccounts = coa;
  appendAuditEvent(db, { req, action: 'coa.account_updated', resourceType: 'chartOfAccounts', resourceId: newCode, before: { code: oldCode, name: prev.name }, after: { code: newCode, name: newName } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for coa.account_updated:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التعديل بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true, account: coa[idx] });
});

// DELETE — single account with journal-entry protection
app.delete('/api/coa/account/:id', requirePermission('coa', 'delete'), async (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  const pid = String(req.params.id);
  const acc = coa.find(a => String(a.id) === pid || String(a.code) === pid);
  if (!acc) return res.status(404).json({ error: 'الحساب غير موجود' });
  // P0.9 — Part F/Step 17: system-controlled accounts are protected
  // outright, regardless of current usage — code elsewhere assumes these
  // specific accounts exist (see SYSTEM_PROTECTED_ACCOUNT_CODES's own
  // comment for the full, repository-verified list).
  if (SYSTEM_PROTECTED_ACCOUNT_CODES.has(String(acc.code)))
    return res.status(409).json({ error: `لا يمكن حذف الحساب "${acc.name}" (${acc.code}) — حساب نظامي يعتمد عليه الكود برمجياً`, code: 'SYSTEM_ACCOUNT_PROTECTED' });
  // Block: has children (match parent against both the account's id and its code, as strings)
  if (coa.some(a => a.parent != null && (String(a.parent) === String(acc.id) || String(a.parent) === String(acc.code))))
    return res.status(409).json({ error: 'لا يمكن حذف الحساب — يحتوي على حسابات فرعية', code:'HAS_CHILDREN' });
  // Block: has journal entries (check both id and code)
  if (accountHasEntries(db, acc.id) || accountHasEntries(db, acc.code))
    return res.status(409).json({ error: 'لا يمكن حذف الحساب — مرتبط بقيود محاسبية', code:'HAS_ENTRIES' });
  // P0.9 — Part E/Step 14: referenced by a subledger/config even with zero
  // journal lines of its own yet (e.g. a vendor created but never billed).
  const refReason = coaAccountReferenceReason(db, acc);
  if (refReason)
    return res.status(409).json({ error: `لا يمكن حذف الحساب — ${refReason}`, code: 'HAS_SUBLEDGER_REFERENCE' });
  db.chartOfAccounts = coa.filter(a => a !== acc);
  appendAuditEvent(db, { req, action: 'coa.account_deleted', resourceType: 'chartOfAccounts', resourceId: String(acc.code), before: { code: acc.code, name: acc.name } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for coa.account_deleted:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ الحذف بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true });
});

// POST — AI analyze COA for IFRS compliance
app.post('/api/coa/ai-analyze', requireAuth, requirePermission('coa', 'view'), rateLimit(5), async (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  const je  = db.journalEntries  || [];

  // Client-side rules (fast, no AI needed for basic checks)
  const issues = [];
  const REQUIRED_ROOTS = [
    { code:'1', name:'الأصول', type:'asset' },
    { code:'2', name:'الالتزامات', type:'liability' },
    { code:'3', name:'حقوق الملكية', type:'equity' },
    { code:'4', name:'الإيرادات', type:'revenue' },
    { code:'5', name:'المصاريف', type:'expense' },
  ];

  // Check root categories exist
  REQUIRED_ROOTS.forEach(r => {
    if (!coa.some(a => a.code.startsWith(r.code) && !a.parent)) {
      issues.push({ severity:'error', msg:`مجموعة "${r.name}" (${r.code}xxx) غير موجودة كحساب رئيسي`, fix:`أضف حساب رئيسي من نوع ${r.name}` });
    }
  });

  // Check placement: code prefix vs type
  const typeMap = { '1':'asset','2':'liability','3':'equity','4':'revenue','5':'expense' };
  coa.forEach(a => {
    const expected = typeMap[a.code[0]];
    if (expected && a.type !== expected) {
      issues.push({ severity:'warning', id:a.id, code:a.code, msg:`حساب "${a.name}" (${a.code}) من نوع "${a.type}" لكن رقمه يشير إلى "${expected}"`, fix:`غيّر نوع الحساب إلى "${expected}" أو غيّر رقمه` });
    }
  });

  // Check duplicates
  const codeSeen = {};
  coa.forEach(a => {
    if (codeSeen[a.code]) issues.push({ severity:'error', code:a.code, msg:`رقم الحساب "${a.code}" مكرر`, fix:`احذف أو أعد ترقيم أحد الحسابين` });
    else codeSeen[a.code] = true;
  });

  // Check orphan accounts (parent referenced but not exists)
  const idSet = new Set(coa.map(a => a.id));
  coa.forEach(a => {
    if (a.parent && !idSet.has(a.parent)) {
      issues.push({ severity:'error', id:a.id, code:a.code, msg:`حساب "${a.name}" (${a.code}) يشير إلى حساب أب غير موجود`, fix:`حدّث الحساب الأب أو اجعله حساباً رئيسياً` });
    }
  });

  // Missing recommended accounts for dental clinic (IFRS)
  const RECOMMENDED = [
    { check: coa => !coa.some(a=>a.type==='asset' && a.code.startsWith('1') && (a.name.includes('نقد')||a.name.includes('صندوق')||a.name.includes('بنك'))), msg:'لا يوجد حساب للنقد أو البنك (IFRS IAS 7 — بيان التدفقات النقدية)', severity:'warning' },
    { check: coa => !coa.some(a=>a.type==='asset' && (a.name.includes('ذمم')||a.name.includes('مدين'))), msg:'لا يوجد حساب ذمم مدينة (IFRS IFRS 9 — الأدوات المالية)', severity:'warning' },
    { check: coa => !coa.some(a=>a.type==='expense' && a.code.startsWith('5') && a.name.includes('إهلاك')), msg:'لا يوجد حساب إهلاك (IFRS IAS 16 — الأصول الثابتة)', severity:'info' },
    { check: coa => !coa.some(a=>a.type==='equity'), msg:'لا يوجد حسابات حقوق الملكية — مطلوبة وفق IFRS', severity:'error' },
  ];
  RECOMMENDED.forEach(r => { if (r.check(coa)) issues.push({ severity:r.severity, msg:r.msg }); });

  const errors   = issues.filter(i=>i.severity==='error').length;
  const warnings = issues.filter(i=>i.severity==='warning').length;
  const score    = Math.max(0, 100 - errors*15 - warnings*5);

  // If ANTHROPIC_API_KEY set, enrich with AI narrative
  let aiNarrative = null;
  if (process.env.ANTHROPIC_API_KEY && coa.length > 0) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic();
      const coaSummary = coa.map(a=>`${a.code}: ${a.name} [${a.type}]${a.parent?` → ${a.parent}`:''}`).join('\n');
      const msg = await client.messages.create({
        model:'claude-haiku-4-5-20251001', max_tokens:600,
        messages:[{ role:'user', content:
          `أنت مدقق حسابات محترف متخصص في معايير IFRS. قيّم شجرة الحسابات التالية لعيادة أسنان:\n\n${coaSummary}\n\nالمشاكل المكتشفة تلقائياً: ${JSON.stringify(issues.map(i=>i.msg))}\n\nأعطني تقييماً موجزاً في 3-4 نقاط باللغة العربية، مع أبرز التوصيات لتحسين الشجرة وفق IFRS.` }]
      });
      aiNarrative = msg.content[0].text;
    } catch(e) { aiNarrative = null; }
  }

  res.json({ score, issues, errors, warnings, totalAccounts: coa.length, aiNarrative });
});

// POST — AI chat builder for COA
app.post('/api/coa/ai-chat', requireAuth, requirePermission('coa', 'add'), rateLimit(10), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ reply:'❌ ANTHROPIC_API_KEY غير مضبوط. أضفه في ملف .env لتفعيل مساعد الذكاء الاصطناعي.' });
  const { messages } = req.body;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    // Always load fresh from DB — don't trust currentCoa from client
    const db = loadDB();
    const coa = db.chartOfAccounts || [];
    const usedCodes = new Set(coa.map(a => a.code));
    const nxt = (from, to) => { for (let i=from;i<=to;i++){const c=String(i);if(!usedCodes.has(c))return c;} return String(to); };
    const nextCodes = {
      asset:nxt(1100,1999), liability:nxt(2100,2999), equity:nxt(3100,3999), revenue:nxt(4100,4999),
      salaries:nxt(5010,5099), materials:nxt(5110,5199), supplies:nxt(5210,5299),
      rent:nxt(5310,5399), utilities:nxt(5410,5499), maintenance:nxt(5510,5599),
      marketing:nxt(5610,5699), admin:nxt(5710,5799), depreciation:nxt(5810,5899), misc:nxt(5910,5999),
    };

    const systemPrompt = `أنت مساعد لبناء شجرة الحسابات لعيادة "بوبيان" للأسنان.

الحسابات الموجودة (كود: اسم):
${coa.map(a=>`${a.code}:${a.name}`).join(' | ')}

الكود التالي المتاح لكل نطاق:
أصول=${nextCodes.asset} | خصوم=${nextCodes.liability} | إيرادات=${nextCodes.revenue}
مصاريف متنوعة=${nextCodes.misc} | إداري=${nextCodes.admin} | صيانة=${nextCodes.maintenance}
مواد=${nextCodes.materials} | مستلزمات=${nextCodes.supplies} | رواتب=${nextCodes.salaries}

قواعد:
1. لا تستخدم أكواداً من قائمة الحسابات الموجودة أعلاه
2. استخدم الكود التالي المتاح بالضبط من الجدول أعلاه
3. أضف حساباً واحداً فقط ما لم يطلب المستخدم صراحةً أكثر
4. عند إضافة حساب أعطِ JSON: {"action":"addAccounts","accounts":[{"code":"XXXX","name":"...","type":"expense","parent":null,"isGroup":false}]}
5. تحدث بالعربي فقط`;

    const resp = await client.messages.create({
      model:'claude-haiku-4-5-20251001', max_tokens:600,
      system: systemPrompt,
      messages: (messages||[]).map(m => ({ role:m.role, content:m.content }))
    });
    let reply = resp.content[0].text;

    // Server-side: correct any codes the AI picked that are already taken
    try {
      const jsonMatch = reply.match(/\{[^{}]*"action"\s*:\s*"addAccounts"[\s\S]*?\}/);
      if (jsonMatch) {
        const act = JSON.parse(jsonMatch[0]);
        if (Array.isArray(act.accounts)) {
          act.accounts = act.accounts.map(acc => {
            if (!acc.code || usedCodes.has(acc.code)) {
              const t = acc.type || 'expense';
              const p = parseInt(acc.parent) || 0;
              let fixed;
              if (t !== 'expense') fixed = nextCodes[t] || nextCodes.misc;
              else if (!p || p >= 5900) fixed = nextCodes.misc;
              else if (p >= 5800) fixed = nextCodes.depreciation;
              else if (p >= 5700) fixed = nextCodes.admin;
              else if (p >= 5600) fixed = nextCodes.marketing;
              else if (p >= 5500) fixed = nextCodes.maintenance;
              else if (p >= 5400) fixed = nextCodes.utilities;
              else if (p >= 5300) fixed = nextCodes.rent;
              else if (p >= 5200) fixed = nextCodes.supplies;
              else if (p >= 5100) fixed = nextCodes.materials;
              else fixed = nextCodes.misc;
              acc.code = fixed;
            }
            return acc;
          });
          reply = reply.replace(jsonMatch[0], JSON.stringify(act));
        }
      }
    } catch {}

    res.json({ reply });
  } catch(e) {
    res.status(500).json({ reply: 'حدث خطأ: ' + e.message });
  }
});

// Reset COA to defaults
app.post('/api/coa/reset-defaults', requireAuth, requireAdminAction('coa.reset_defaults'), (req, res) => {
  const db = loadDB();
  const before = (db.chartOfAccounts || []).length;
  db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
  appendAuditEvent(db, { req, action: 'coa.reset_to_defaults', resourceType: 'chartOfAccounts', before: { count: before }, after: { count: db.chartOfAccounts.length } });
  saveDB(db);
  res.json({ success: true, count: db.chartOfAccounts.length });
});

// ═══════════════════════════════════════════════════
// TRIAL BALANCE — ميزان المراجعة
// ═══════════════════════════════════════════════════
app.get('/api/trial-balance', requirePermission('ledger', 'view'), (req, res) => {
  const db = loadDB();
  const { period, year, month } = req.query;
  const accounts = db.chartOfAccounts || [];
  const entries  = db.journalEntries  || [];

  const now = new Date();
  const targetYear  = parseInt(year)  || now.getFullYear();
  const targetMonth = parseInt(month) || now.getMonth() + 1;
  const monthStr    = `${targetYear}-${String(targetMonth).padStart(2,'0')}`;

  // Filter entries by period
  const filteredEntries = entries.filter(e => {
    if (!period || period === 'all') return true;
    if (period === 'year')  return (e.date||'').startsWith(String(targetYear));
    if (period === 'month') return (e.date||'').startsWith(monthStr);
    return true;
  });

  // Aggregate debits/credits per account code
  // P0.6A verification pass — Trial Balance follow-up: POST
  // /api/assets/depreciate (server.js:8130-8131) builds its lines with the
  // key `account`, not `accountCode` — the same mismatch already fixed in
  // buildBalanceMap() earlier in P0.6A (used by the P&L/Balance Sheet/live
  // financial-statements screen). This route has its own separate
  // aggregation loop (does not call buildBalanceMap()), so it still silently
  // dropped every standalone-depreciation entry from the Trial Balance,
  // discovered via the independent worked-numerical-example verification
  // (Trial Balance grandDebit/grandCredit came out balanced but 100 KD short
  // on both sides — the depreciation entry's two lines were both invisible).
  const totals = {};
  filteredEntries.forEach(entry => {
    (entry.lines || []).forEach(line => {
      const code = line.accountCode || line.accountId || line.account;
      if (!code) return;
      if (!totals[code]) totals[code] = { debit: 0, credit: 0 };
      totals[code].debit  += line.debit  || 0;
      totals[code].credit += line.credit || 0;
    });
  });

  // P0.6A — Step 6 (P6-001): opening balances are ALREADY represented by a
  // real `type:'opening'` journal entry (see POST /api/opening-balance),
  // whose lines are summed into `totals` above via `filteredEntries` —
  // exactly like any other journal entry, and correctly included/excluded
  // by the period filter the same way every other account's activity is.
  // This block used to ALSO add `acc.openingDebit`/`openingCredit` on top
  // of that, unconditionally, double-counting every opening balance in
  // every "all"/"year" view and even fabricating a balance in period views
  // that don't otherwise include the opening entry's own date. Removed —
  // the journal entry is the single source of truth (see
  // docs/ACCOUNTING_INVARIANTS.md #7); `openingDebit`/`openingCredit`
  // remain on the account purely as display/reference metadata for the
  // opening-balance screen itself, never summed into a report again.

  // Build rows (leaf accounts only, exclude groups)
  const rows = accounts
    .filter(a => !a.isGroup)
    .map(acc => {
      const t = totals[acc.code] || { debit: 0, credit: 0 };
      const netDebit  = Math.max(0, t.debit - t.credit);
      const netCredit = Math.max(0, t.credit - t.debit);
      return { code: acc.code, name: acc.name, type: acc.type, totalDebit: t.debit, totalCredit: t.credit, netDebit, netCredit };
    });

  // أضف أي كود ظهر في القيود لكنه غير موجود في شجرة الحسابات (كي لا يُسقَط طرف
  // ويختلّ الميزان — مثل 2900 مصاريف مستحقة سابقاً)
  const coaCodes = new Set(accounts.map(a => String(a.code)));
  for (const [code, t] of Object.entries(totals)) {
    if (coaCodes.has(String(code))) continue;
    const line = filteredEntries.flatMap(e => e.lines || []).find(l => String(l.accountCode || l.accountId || l.account) === String(code));
    rows.push({ code, name: (line && line.accountName) || ('حساب ' + code) + ' (غير مُعرّف)', type: 'unknown',
      totalDebit: t.debit, totalCredit: t.credit,
      netDebit: Math.max(0, t.debit - t.credit), netCredit: Math.max(0, t.credit - t.debit) });
  }

  const finalRows = rows
    .filter(r => r.totalDebit !== 0 || r.totalCredit !== 0)
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));

  const grandDebit  = finalRows.reduce((s, r) => s + r.netDebit,  0);
  const grandCredit = finalRows.reduce((s, r) => s + r.netCredit, 0);
  const isBalanced  = Math.abs(grandDebit - grandCredit) < 0.001;

  // P0.3 — this report already surfaces unresolved codes as "unknown" rows;
  // add the same explicit flag the P&L/Balance Sheet now expose so a caller
  // doesn't have to scan `rows` for `type==='unknown'` itself.
  const unknownRows = finalRows.filter(r => r.type === 'unknown');
  res.json({
    rows: finalRows, grandDebit, grandCredit, isBalanced, period: period || 'all', monthStr,
    hasUnresolvedAccounts: unknownRows.length > 0,
    unresolvedCount: unknownRows.length,
  });
});

// ═══════════════════════════════════════════════════
// OPENING BALANCES — الأرصدة الافتتاحية
// ═══════════════════════════════════════════════════
app.post('/api/opening-balance', requirePermission('coa', 'edit'), async (req, res, next) => {
  // P0.6A — Step 22: opening balances are a P0-level, whole-chart-affecting
  // mutation explicitly named as needing durable acknowledgement — durable
  // save + outer try/catch(next) for the same Express-4-async-handler
  // safety reason as P0.5A's other 8 durable routes.
  try {
  const db = loadDB();
  const { balances, date } = req.body; // balances: [{code, debit, credit}]
  if (!Array.isArray(balances)) return res.status(400).json({ error: 'balances array required' });

  const accounts = db.chartOfAccounts || [];
  const nonZero = balances.filter(b => (parseFloat(b.debit)||0) > 0 || (parseFloat(b.credit)||0) > 0);

  // P0.6A — Step 7 (P6-002): opening balances may only post to
  // balance-sheet accounts (asset/liability/equity) — never revenue/expense,
  // which would silently contaminate whatever period's P&L happens to
  // include this entry's date (P&L reports have no concept of "opening"
  // entries to exclude). Reject the WHOLE request, before any mutation, if
  // any targeted account resolves to a P&L type.
  const pnlViolations = nonZero
    .map(b => accounts.find(a => a.code === b.code))
    .filter(acc => acc && (acc.type === 'revenue' || acc.type === 'expense'));
  if (pnlViolations.length) {
    return res.status(400).json({
      error: `لا يمكن ترحيل رصيد افتتاحي لحساب إيراد/مصروف (${pnlViolations.map(a => a.code).join('، ')}) — الأرصدة الافتتاحية تُرحَّل فقط لحسابات الميزانية العمومية (أصول/خصوم/حقوق ملكية)`,
      code: 'OPENING_BALANCE_PNL_ACCOUNT',
    });
  }

  // P0.6A — Step 8 (P6-010): build + validate the REPLACEMENT journal entry
  // BEFORE touching chartOfAccounts or deleting the prior opening entry —
  // the same "prepare then commit" pattern already used correctly elsewhere
  // in this codebase (setVendorOpening, inventory/patient-opening imports).
  // Previously this route zeroed+reapplied every account's opening fields
  // and deleted the prior opening JE FIRST, and only validated the new JE
  // last — a rejected posting (locked period, phantom account) left
  // chartOfAccounts already mutated and the prior opening JE already gone,
  // with nothing valid to replace it.
  const lines = nonZero.map(b => {
    const acc = accounts.find(a => a.code === b.code);
    return { accountId: b.code, accountCode: b.code, accountName: acc?.name || b.code, debit: parseFloat(b.debit)||0, credit: parseFloat(b.credit)||0 };
  });

  let candidateJe = null;
  let need3900 = false;
  if (lines.length > 0) {
    // وازِن القيد تلقائياً: الفرق يذهب لحساب «أرصدة افتتاحية» (3900)
    const totDr = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totCr = lines.reduce((s, l) => s + (l.credit || 0), 0);
    const diff = parseFloat((totDr - totCr).toFixed(3));
    const existing3900 = accounts.find(a => a.code === '3900');
    if (Math.abs(diff) > 0.001) {
      need3900 = !existing3900;
      lines.push({ accountId: '3900', accountCode: '3900', accountName: existing3900 ? existing3900.name : 'أرصدة افتتاحية',
        debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0 });
    }
    const totalDebit  = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
    candidateJe = {
      id: 'JE-OPEN-' + Date.now(),
      date: date || new Date().toISOString().substring(0, 10),
      desc: 'قيد الأرصدة الافتتاحية', description: 'قيد الأرصدة الافتتاحية',
      ref: 'OPENING', reference: 'OPENING', type: 'opening',
      totalDebit, totalCredit, autoGenerated: true, lines,
      createdAt: new Date().toISOString(),
    };
    // Validate against a view where the prior opening entry is already
    // excluded (matching what will actually be committed) and a
    // hypothetical 3900 exists if the balancing line needs it — WITHOUT
    // mutating the real `db`/`accounts` yet.
    const validationAccounts = need3900
      ? [...accounts, { id: '3900', code: '3900', name: 'أرصدة افتتاحية', type: 'equity', parent: '3000', parentId: '3000', normalBalance: 'credit', status: 'active', balance: 0, createdAt: new Date().toISOString() }]
      : accounts;
    const dbForValidation = { ...db, chartOfAccounts: validationAccounts, journalEntries: (db.journalEntries || []).filter(e => e.type !== 'opening') };
    const result = validateJournalEntry(dbForValidation, candidateJe);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }
  }

  // Validated (or nothing to post) — safe to commit everything together now.
  accounts.forEach(a => { a.openingDebit = 0; a.openingCredit = 0; });
  balances.forEach(b => {
    const acc = accounts.find(a => a.code === b.code);
    if (acc) {
      acc.openingDebit  = parseFloat(b.debit)  || 0;
      acc.openingCredit = parseFloat(b.credit) || 0;
    }
  });
  if (need3900) {
    accounts.push({ id: '3900', code: '3900', name: 'أرصدة افتتاحية', type: 'equity', parent: '3000', parentId: '3000', normalBalance: 'credit', status: 'active', balance: 0, createdAt: new Date().toISOString() });
  }
  db.chartOfAccounts = accounts;
  db.journalEntries = (db.journalEntries || []).filter(e => e.type !== 'opening'); // استبدل السابق
  if (candidateJe) db.journalEntries.unshift(candidateJe);

  appendAuditEvent(db, { req, action: 'opening_balance.set', resourceType: 'chartOfAccounts', after: { accountCount: balances.length } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for opening_balance.set:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ الأرصدة الافتتاحية بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════
// PERIOD CLOSING ENTRY — قيد الإقفال
// ═══════════════════════════════════════════════════
// P0.6B — Step 20/21 (P6-044): the ONE canonical period-close computation.
// Previously TWO independent implementations existed with the SAME journal
// `ref` convention (`CLOSE-<month>`) but different target accounts (this
// route closed to 3200 "الأرباح المحتجزة"; /api/close/run-all's own STEP 4
// closed to 3300 "أرباح/خسائر الفترة الحالية") and different safety
// behavior: this route unconditionally executed
// `db.journalEntries = entries.filter(e => e.ref !== CLOSE-<month>)` —
// DELETING any existing closing entry (including one /api/close/run-all had
// already posted and locked the period for) BEFORE attempting to post a
// replacement, with NO period-lock check of its own. If the replacement
// then failed validation (predictably: its own date falls inside the
// period that was — by definition, if a closing entry already existed —
// almost certainly already locked), the delete had already mutated the
// live in-memory db with nothing to reverse it: a period left showing
// `lockedPeriods[month]=true` with ZERO closing journal behind it,
// discoverable only by manually diffing the ledger. Standardized on 3300
// (the account P6-043's live financial-statements fix and this
// milestone's own AP/doctor-liability work already treat as the canonical
// current-period-result transfer account) — /api/close/run-all's version,
// being idempotent (checks for an existing ref before doing ANY work) and
// exception-safe, is the canonical implementation; /api/closing-entry
// becomes a thin, backward-compatible wrapper around it (Step 21: "legacy
// routes may become compatibility wrappers... no duplicated close
// calculations").
function computeAndPostClosingEntry(db, month) {
  const closeRef = `CLOSE-${month}`;
  if ((db.journalEntries || []).some(j => j.ref === closeRef)) {
    return { status: 'skipped', detail: 'تم مسبقاً', netResult: 0, linesCount: 0 };
  }
  const monthJE = (db.journalEntries || []).filter(j => (j.date || '').startsWith(month));
  const coaAccs = db.chartOfAccounts || [];
  const balMap  = {};
  monthJE.forEach(je => (je.lines || []).forEach(l => {
    const c = String(l.accountCode || l.account || ''); if (!c) return;
    if (!balMap[c]) balMap[c] = { debit: 0, credit: 0 };
    balMap[c].debit  += parseFloat(l.debit)  || 0;
    balMap[c].credit += parseFloat(l.credit) || 0;
  }));
  const cLines = []; let net = 0;
  coaAccs.filter(a => a.type === 'revenue').forEach(a => {
    const b = balMap[a.code]; if (!b) return;
    const bal = parseFloat((b.credit - b.debit).toFixed(3));
    if (Math.abs(bal) < 0.001) return;
    cLines.push({ accountCode: a.code, accountName: a.name, debit: Math.max(0, bal), credit: 0 }); net += bal;
  });
  coaAccs.filter(a => a.type === 'expense').forEach(a => {
    const b = balMap[a.code]; if (!b) return;
    const bal = parseFloat((b.debit - b.credit).toFixed(3));
    if (Math.abs(bal) < 0.001) return;
    cLines.push({ accountCode: a.code, accountName: a.name, debit: 0, credit: Math.max(0, bal) }); net -= bal;
  });
  if (!cLines.length) return { status: 'skipped', detail: 'لا إيرادات/مصاريف', netResult: 0, linesCount: 0 };

  const net3300 = parseFloat(net.toFixed(3));
  const p3300   = coaAccs.find(a => a.code === '3300') || { code: '3300', name: 'أرباح/خسائر الفترة' };
  cLines.push(net3300 >= 0
    ? { accountCode: '3300', accountName: p3300.name, debit: 0, credit: Math.abs(net3300) }
    : { accountCode: '3300', accountName: p3300.name, debit: Math.abs(net3300), credit: 0 });
  const tDr = parseFloat(cLines.reduce((s, l) => s + (l.debit || 0), 0).toFixed(3));
  const tCr = parseFloat(cLines.reduce((s, l) => s + (l.credit || 0), 0).toFixed(3));
  const je = {
    id: 'JE-CLOSE-' + Date.now(), date: month + '-28', desc: `إقفال شهر ${month}`,
    ref: closeRef, reference: closeRef, type: 'closing', totalDebit: tDr, totalCredit: tCr,
    createdAt: new Date().toISOString(), lines: cLines,
  };
  appendJournalEntry(db, je); // throws JournalValidationError if the period is locked/unbalanced — never bypassed
  return { status: 'done', detail: `صافي ${net3300 >= 0 ? 'ربح' : 'خسارة'} ${Math.abs(net3300).toFixed(3)} د.ك`, netResult: net3300, linesCount: cLines.length, entry: je };
}

// Backward-compatible wrapper — same canonical computation as
// /api/close/run-all's own closing step, above. No longer deletes any
// existing entry; if one already exists for the period, reports it as
// already-closed instead of silently overwriting it.
// P0.12 — Part G note: the pre-existing CLOSE-<month> ref guard inside
// computeAndPostClosingEntry() already fully closes P6-097 for this route
// (a synchronous, file-mode-atomic check-then-post — same structural
// argument as every other route in this milestone). The generic
// Idempotency-Key layer is added ADDITIVELY on top purely for a nicer
// caller experience: a genuine retry now gets a clean 200 replay instead of
// a 409 ALREADY_CLOSED, which a naive "retry until 200" client would
// otherwise treat as a failure. Deliberately does NOT touch whether closing
// locks the period — P6-098 stays OPEN, exactly as instructed.
app.post('/api/closing-entry', requireAdminAction('period.closing_entry'), async (req, res, next) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
  const { year, month: monthNum } = req.body;
  const now = new Date();
  const targetYear  = parseInt(year)     || now.getFullYear();
  const targetMonth = parseInt(monthNum) || now.getMonth() + 1;
  const month = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;

  const db = loadDB();

  const idemKey = extractIdempotencyKey(req);
  if (idemKey) {
    const v = validateIdempotencyKey(idemKey);
    if (!v.ok) return res.status(400).json({ error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
    const fingerprint = computeFingerprint('period:close', { month });
    const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'period:close', idemKey, fingerprint);
    if (!claim.claimed && claim.record.status === 'COMPLETED') {
      return res.json({ success: true, idempotentReplay: true, ...claim.record.resultReference });
    }
    idemRecord = claim.record;
  }

  let result;
  try {
    result = computeAndPostClosingEntry(db, month);
  } catch (e) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    if (!(e instanceof JournalValidationError)) throw e;
    return res.status(e.status).json({ error: e.message, code: e.code });
  }
  if (result.status === 'skipped') {
    // Nothing was posted under THIS claim (the period was already closed by
    // some earlier, unrelated operation) — release so this key stays usable.
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    return res.status(409).json({ error: `الفترة ${month} مُقفَلة محاسبيًا بالفعل — لا يوجد إيراد/مصروف جديد ليُقفَل، أو قيد الإقفال موجود مسبقًا`, code: 'ALREADY_CLOSED' });
  }

  appendAuditEvent(db, { req, action: 'period.closing_entry_posted', resourceType: 'journal', resourceId: result.entry.id, after: { month, netResult: result.netResult, linesCount: result.linesCount } });
  if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { netResult: result.netResult, linesCount: result.linesCount, entry: result.entry }, result.entry.id, result.entry.id);
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for period.closing_entry_posted:', e.message);
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ قيد الإقفال بشكل دائم — حاول مرة أخرى' });
  }
  if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
  res.json({ success: true, netResult: result.netResult, linesCount: result.linesCount, entry: result.entry });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════
// AP / AR AGING — تقادم الذمم
// ═══════════════════════════════════════════════════
app.get('/api/ar-aging', requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const claims = db.insuranceClaims || [];
  const today  = new Date();

  // R5 (staging validation, adversarial review — P1, live-reproduced):
  // two real bugs in the same filter/date logic.
  // (1) `status !== 'received'` let CANCELLED claims through at their full
  // original amount — a cancelled claim's recognition entry is fully
  // reversed (DELETE /api/insurance-claims/:id posts an explicit reversal
  // JE, its true GL impact is 0), so including it here overstated aging by
  // the sum of every cancelled claim's face value (confirmed live: 4
  // cancelled claims totaling 2503.649 KWD counted here in full while the
  // GL's real account-1130 balance excluded them entirely). A 'received'
  // claim correctly stays excluded even when partially settled — a short
  // insurance settlement is intentionally cleared in full against 1130 with
  // the shortfall booked to a dedicated doubtful-debt expense (5930), not
  // left as a receivable — so `status==='received'` is NOT itself a bug.
  // (2) `c.date` is read for aging, but the insurance-claim object has no
  // `date` field at all (only `claimDate`, set at creation) — so `days` was
  // always ~0 (falls back to `today`) regardless of true age, silently
  // collapsing every claim into the "current" bucket.
  const buckets = { current: [], days30: [], days60: [], days90: [], over90: [] };
  claims.filter(c => c.status !== 'received' && c.status !== 'cancelled').forEach(c => {
    const days = Math.floor((today - new Date(c.claimDate || today)) / 86400000);
    const item = { id: c.id, company: c.company || 'غير محدد', amount: c.amount || 0, date: c.claimDate, days };
    if      (days <= 30)  buckets.current.push(item);
    else if (days <= 60)  buckets.days30.push(item);
    else if (days <= 90)  buckets.days60.push(item);
    else if (days <= 120) buckets.days90.push(item);
    else                  buckets.over90.push(item);
  });

  const sum = arr => arr.reduce((s, i) => s + i.amount, 0);
  const grandTotal = claims.filter(c => c.status !== 'received' && c.status !== 'cancelled').reduce((s,c)=>s+(c.amount||0),0);
  // Reconciliation, matching the sibling AP/Patient-AR aging endpoints'
  // self-verification pattern — an insurance receivable subledger that
  // silently drifts from the GL is exactly the class of bug this closes.
  const glTotal = parseFloat(((buildBalanceMap(db, null, null)['1130'] || { debit: 0, credit: 0 }).debit -
    (buildBalanceMap(db, null, null)['1130'] || { debit: 0, credit: 0 }).credit).toFixed(3));
  const subledgerTotal = parseFloat(grandTotal.toFixed(3));
  res.json({
    buckets,
    totals: { current: sum(buckets.current), days30: sum(buckets.days30), days60: sum(buckets.days60), days90: sum(buckets.days90), over90: sum(buckets.over90) },
    grandTotal: subledgerTotal,
    reconciliation: {
      subledgerTotal, glTotal, difference: parseFloat((subledgerTotal - glTotal).toFixed(3)),
      reconciled: Math.abs(subledgerTotal - glTotal) < 0.005,
      note: 'ذمم التأمين (1130) — مطالبات معلَّقة فقط، تستبعد الملغاة والمستلَمة (المستلَمة تُقفَل بالكامل عند التسوية القصيرة، انظر حساب 5930).',
    },
  });
});

// P0.6B — Step 4-7 (P6-027): the previous implementation filtered
// `e.paymentStatus !== 'paid'` — a field NEVER written anywhere in the
// codebase (confirmed by a full-repository search), so the condition was
// always true and every vendor-tagged expense — even one paid in cash the
// same second it was recorded — aged forever. Also structurally
// disconnected from journalEntries entirely (a real 2900 GL balance of
// 30.000 KD produced a 0 aging total in the P0.6 audit's own live test).
//
// `db.accruedExpenses[]` (POST/PUT/:id/pay routes above `db.doctorExpenses`)
// is the ONE structure in this system with a genuine, GL-integrated
// paid-tracking lifecycle: `amount` (original), `paidAmount`, `remaining`,
// `payments[]`, `status` ('pending'/'partial'/'paid'), each backed by real
// journal entries (creation credits 2900, each payment debits 2900). AP
// Aging is rebuilt on this — the only source that can honestly answer
// "how much do we still owe, per vendor, aged by how long" without
// inventing data. `db.expenses` records posted with `payMethod:'accrued'`
// (buildAndPostExpense, server.js ~1618) ALSO credit account 2900 but have
// NO paid/remaining tracking field of their own (`paymentStatus` is dead) —
// deliberately excluded from the aging population rather than faking a
// paid state for them; see `reconciliation.note` below when this causes a
// real, honestly-reported gap against the GL balance.
// P0.7 — Step 15-17: expanded to cover the unified AP model (vendorBills +
// vendor opening liabilities) ALONGSIDE the P0.6B accruedExpenses[] source
// — never double-counted (they are structurally disjoint arrays; a bill is
// never auto-converted from an accrual, see Step 21/docs comment on
// buildAndPostVendorBill). Grouped by vendor NAME so a vendor with both an
// accruedExpense and a real vendorBill shows as ONE consolidated row.
app.get('/api/ap-aging', requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const accrued = db.accruedExpenses || [];
  const today   = new Date();
  const asOfStr = req.query.asOf && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf) ? req.query.asOf : today.toISOString().slice(0, 10);
  const asOf    = new Date(asOfStr);

  // Source 1 (P0.6B): accruedExpenses[] — outstanding = remaining balance
  // only (age the OUTSTANDING amount, never the original).
  const outstanding = accrued
    .filter(a => a.status !== 'paid' && r3(a.remaining != null ? a.remaining : a.amount) > 0.001)
    .map(a => {
      const original = r3(a.amount);
      const paid     = r3(a.paidAmount || 0);
      const remain   = a.remaining != null ? r3(a.remaining) : r3(original - paid);
      const ageFrom  = a.dueDate || monthEndDate(a.month);
      const days     = Math.floor((asOf - new Date(ageFrom)) / 86400000);
      return {
        source: 'accrued-expense', id: a.id, number: a.number, vendor: a.vendor || a.description, description: a.description,
        original, paid, outstanding: remain,
        documentDate: monthEndDate(a.month), dueDate: a.dueDate || null, ageFrom, days,
      };
    });

  // Source 2 (P0.7): vendorBills[] — outstanding already maintained
  // (grossAmount - creditedAmount - paidAmount) by the bill routes themselves.
  (db.vendorBills || []).filter(b => b.status !== 'CANCELLED' && b.status !== 'PAID' && b.outstandingAmount > 0.001).forEach(b => {
    const ageFrom = b.dueDate || b.billDate;
    const days = Math.floor((asOf - new Date(ageFrom)) / 86400000);
    outstanding.push({
      source: 'vendor-bill', id: b.id, number: b.number, vendor: b.vendorName, description: b.description || b.billNumber,
      original: b.grossAmount, paid: b.paidAmount, outstanding: b.outstandingAmount,
      documentDate: b.billDate, dueDate: b.dueDate || null, ageFrom, days,
    });
  });

  // Source 3 (P0.7 — Step 13/14): vendor opening liabilities. Aged from the
  // opening date itself (no due date exists for an opening balance —
  // documented, not fabricated) — labeled distinctly so a reader can see
  // exactly why it appears. Represents the SAME single GL effect
  // setVendorOpening() already posts — not a second recognition of it.
  (db.vendors || []).filter(v => (parseFloat(v.openingBalance) || 0) > 0.001).forEach(v => {
    const amt = parseFloat(v.openingBalance);
    const ageFrom = v.openingDate || null;
    const days = ageFrom ? Math.floor((asOf - new Date(ageFrom)) / 86400000) : null;
    outstanding.push({
      source: 'vendor-opening', id: 'OB-' + v.id, number: 'OB-' + v.accountId, vendor: v.name, description: 'رصيد افتتاحي',
      original: amt, paid: 0, outstanding: amt,
      documentDate: ageFrom, dueDate: null, ageFrom, days: days == null ? 0 : days,
    });
  });

  const byVendor = {};
  outstanding.forEach(i => { (byVendor[i.vendor] = byVendor[i.vendor] || []).push(i); });

  // Step 16 buckets: Current(<=30) / 1-30 handled as "current" per this
  // system's existing 30/60/90 convention (kept for continuity with the
  // dashboard's prior bucket labels) — extended with an explicit 90+ bucket
  // per the milestone's recommended Current/1-30/31-60/61-90/90+ scheme.
  const rows = Object.entries(byVendor).map(([vendor, items]) => {
    const buckets = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };
    items.forEach(i => {
      if      (i.days <= 30) buckets.current += i.outstanding;
      else if (i.days <= 60) buckets.days30  += i.outstanding;
      else if (i.days <= 90) buckets.days60  += i.outstanding;
      else                    buckets.over90  += i.outstanding;
    });
    Object.keys(buckets).forEach(k => buckets[k] = r3(buckets[k]));
    const total = r3(items.reduce((s, i) => s + i.outstanding, 0));
    return { vendor, total, buckets, count: items.length, items };
  }).sort((a, b) => b.total - a.total);

  const subledgerTotal = r3(rows.reduce((s, r) => s + r.total, 0));

  // Step 17: reconcile against the FULL AP universe of GL accounts — 2900
  // (accruedExpenses[]'s shared control account, per P0.6B) PLUS every
  // vendor's own dedicated sub-account (vendorBills[] + opening balances
  // both post there). Reported honestly, never plugged — a nonzero
  // difference is EXPECTED whenever a `payMethod:'accrued'` expense exists
  // outside accruedExpenses[]'s lifecycle (P0.6B's own documented gap).
  const bm = buildBalanceMap(db, null, asOfStr);
  const b2900 = bm['2900'] || { debit: 0, credit: 0 };
  const vendorAccountsTotal = (db.vendors || []).reduce((s, v) => {
    const b = bm[v.accountId]; if (!b) return s;
    return s + (b.credit - b.debit);
  }, 0);
  const glTotal = r3((b2900.credit - b2900.debit) + vendorAccountsTotal);
  const difference = r3(glTotal - subledgerTotal);
  const reconciliation = {
    subledgerTotal, glTotal, difference, reconciled: Math.abs(difference) < 0.005,
    note: Math.abs(difference) < 0.005
      ? 'يطابق تمامًا — كل نشاط حسابي 2900 وحسابات الموردين المخصَّصة مصدره accruedExpenses[]/vendorBills[]/الأرصدة الافتتاحية في هذه البيانات.'
      : 'فرق حقيقي غير مُرقَّع: على الأرجح مصروف واحد أو أكثر بطريقة دفع "آجل" (payMethod: accrued) رُحِّل عبر POST /api/expenses مباشرة (خارج دورة حياة accruedExpenses[])، أو ترحيل يدوي مباشر لحساب مورد لم يمرّ عبر /api/vendor-bills — راجع GET /api/reports/ledger-diagnostic لتحديد المصدر.',
  };

  // Vendor / AP Workspace Upgrade — optional ?vendorId= filter (additive,
  // opt-in; omitting it reproduces the response above byte-for-byte).
  // rows/subledgerTotal/reconciliation above are already fully computed
  // from the unfiltered set; only this response-only variable is scoped.
  const matchedVendor = req.query.vendorId ? db.vendors.find(v => v.id === req.query.vendorId) : null;
  const vendorName = matchedVendor ? matchedVendor.name : null;
  const responseRows = req.query.vendorId ? rows.filter(r => r.vendor === vendorName) : rows;

  res.json({ asOf: asOfStr, rows: responseRows, grandTotal: subledgerTotal, reconciliation });
});

// ═══════════════════════════════════════════════════
// ACCOUNTING SETTINGS — إعدادات السنة المالية
// ═══════════════════════════════════════════════════
app.get('/api/accounting-settings', (req, res) => {
  const db = loadDB();
  res.json(db.accountingSettings || { fiscalYearStart: '01', fiscalYearEnd: '12', currency: 'KWD', currencySymbol: 'د.ك', decimalPlaces: 3, bookStartDate: '' });
});

app.put('/api/accounting-settings', requireAuth, requireAdminAction('accounting_settings.update'), (req, res) => {
  const db = loadDB();
  const before = { ...(db.accountingSettings || {}) };
  db.accountingSettings = { ...(db.accountingSettings || {}), ...req.body };
  appendAuditEvent(db, { req, action: 'accounting_settings.updated', resourceType: 'accountingSettings', before, after: db.accountingSettings });
  saveDB(db);
  res.json({ success: true });
});

// Journal endpoints
// P0.5A — Objective B: journal posting is the single most central CRITICAL
// FINANCIAL mutation in the whole application — converted to await durable
// persistence (see lib/database.js saveDB(db,{durable:true})) rather than
// the normal fire-and-forget debounced save. If durable persistence fails,
// the request returns 500, never "success:true" for a journal entry that
// only exists in RAM.
// P1 (Record Workspace, NEW-R5-ADV-JOURNAL-NO-GET-01): journal entries had NO
// list/detail GET route at all — any lookup (including the bundled UI's own
// edit-prefill flow) had to download the entire unpaginated GET /api/data
// blob and search it client-side. Read-only, no mutation, no invented
// filters beyond what the data model actually supports.
app.get('/api/journal', requirePermission('journal', 'view'), (req, res) => {
  const db = loadDB();
  let entries = db.journalEntries || [];

  const { from, to, account, reference, source, q, type, amount } = req.query;
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) entries = entries.filter(j => (j.date || '') >= from);
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) entries = entries.filter(j => (j.date || '') <= to);
  if (account) entries = entries.filter(j => (j.lines || []).some(l => l.accountCode === account));
  if (reference) {
    const needle = String(reference).toLowerCase();
    entries = entries.filter(j => String(j.ref || '').toLowerCase().includes(needle) || String(j.reference || '').toLowerCase().includes(needle));
  }
  if (source) entries = entries.filter(j => j.source === source);
  if (type) entries = entries.filter(j => j.type === type);
  if (q) {
    const needle = String(q).toLowerCase();
    entries = entries.filter(j =>
      String(j.desc || j.description || '').toLowerCase().includes(needle) ||
      String(j.ref || '').toLowerCase().includes(needle) ||
      String(j.reference || '').toLowerCase().includes(needle));
  }
  if (amount !== undefined && amount !== '' && !isNaN(parseFloat(amount))) {
    const amt = parseFloat(amount);
    entries = entries.filter(j =>
      Math.abs((parseFloat(j.totalDebit) || 0) - amt) < 0.005 ||
      Math.abs((parseFloat(j.totalCredit) || 0) - amt) < 0.005 ||
      (j.lines || []).some(l => Math.abs((parseFloat(l.debit) || 0) - amt) < 0.005 || Math.abs((parseFloat(l.credit) || 0) - amt) < 0.005));
  }

  entries = entries.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id || '').localeCompare(a.id || ''));

  const total = entries.length;
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const start = (page - 1) * pageSize;
  const pageEntries = entries.slice(start, start + pageSize);

  res.json({ entries: pageEntries, total, page, pageSize });
});

// P1 — GET /api/journal/:id: the authoritative single-entry record, same
// shape appendJournalEntry() ever stores — no derived/invented fields beyond
// a resolved account name per line for display convenience where missing.
app.get('/api/journal/:id', requirePermission('journal', 'view'), (req, res) => {
  const db = loadDB();
  const entry = (db.journalEntries || []).find(j => j.id === req.params.id);
  if (!entry) return res.status(404).json({ success: false, error: 'القيد غير موجود' });
  const coa = db.chartOfAccounts || [];
  const lines = (entry.lines || []).map(l => ({
    ...l,
    accountName: l.accountName || (coa.find(a => a.code === l.accountCode) || {}).name || l.accountCode,
  }));
  res.json({ success: true, entry: { ...entry, lines } });
});

app.post('/api/journal', requireAuth, tenantMiddleware, requirePermission('journal', 'add'), async (req, res, next) => {
  // P0.5A hang fix: Express 4 does NOT catch rejected promises thrown from
  // async handlers (unlike Express 5) — a bare `throw` below (e.g. from
  // validateJournalEntry/appendJournalEntry) would otherwise become an
  // unhandled rejection and the request would hang forever with no
  // response. Wrapping the pre-existing synchronous logic in this outer
  // try/catch restores the original behavior (forward to the global error
  // middleware via next(err)) while the inner try/catch below stays
  // specific to the new durable-save failure path.
  try {
    const db = loadDB();
    if (!db.journalEntries) db.journalEntries = [];
    const entry = req.body;
    const isEdit = db.journalEntries.some(e => entry && e.id === entry.id);
    // ── P0.2: بنية/توازن/تاريخ/قفل فترة/وجود حساب — كلها عبر المدقّق المركزي الآن ──
    const existingIdx = db.journalEntries.findIndex(e => entry && e.id === entry.id);

    // P0.12 (closes P6-097 for the CREATE path only — an edit via POST is
    // already naturally idempotent by URL/id, see the inventory). Claimed
    // BEFORE nextJeId() so a retry never even mints a second sequential id.
    const isMongo = !isFileFallbackMode();
    let idemRecord = null;
    if (existingIdx < 0) {
      const idemKey = extractIdempotencyKey(req);
      if (idemKey) {
        const v = validateIdempotencyKey(idemKey);
        if (!v.ok) return res.status(400).json({ error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
        const fingerprint = computeFingerprint('journal:create', { date: entry && entry.date, desc: entry && (entry.desc || entry.description), lines: entry && entry.lines });
        const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'journal:create', idemKey, fingerprint);
        if (!claim.claimed && claim.record.status === 'COMPLETED') {
          return res.json({ success: true, idempotentReplay: true, id: claim.record.sourceId });
        }
        idemRecord = claim.record;
      }
    }

    if (existingIdx < 0 && entry && typeof entry === 'object') {
      // Always assign a clean sequential ID for new entries (before validation
      // so the id is present on the entry the validator/append receives).
      entry.id = nextJeId(db);
    }
    try {
      if (existingIdx >= 0) {
        // Editing an existing entry via POST — validate the replacement BEFORE
        // mutating the array (this path had no balance/account/date checks at
        // all before P0.2, unlike PUT /api/journal/:id).
        const result = validateJournalEntry(db, entry);
        if (!result.ok) throw new JournalValidationError(result.error, result.status, result.code);
        db.journalEntries[existingIdx] = entry;
      } else {
        appendJournalEntry(db, entry);
        if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { id: entry.id }, entry.id, entry.id);
      }
    } catch (mutErr) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      throw mutErr;
    }
    db.journalEntries.sort((a,b) => b.date.localeCompare(a.date));
    appendAuditEvent(db, {
      req, action: isEdit ? 'journal.updated' : 'journal.created', resourceType: 'journal', resourceId: entry.id,
      after: { date: entry.date, desc: entry.desc || entry.description, totalDebit: entry.totalDebit, totalCredit: entry.totalCredit },
    });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for journal.created/updated:', e.message);
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(500).json({ success: false, message: 'تعذّر حفظ القيد بشكل دائم — حاول مرة أخرى' });
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, id: entry.id });
  } catch (err) {
    next(err);
  }
});

app.put('/api/journal/:id', requireAuth, tenantMiddleware, requirePermission('journal', 'edit'), async (req, res, next) => {
  try {
    const db = loadDB();
    const idx = (db.journalEntries || []).findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'القيد غير موجود' });
    const existing = db.journalEntries[idx];

    // IFRS compliance: reject edits to entries in locked periods (IAS 8)
    const entryPeriod = (existing.date || '').substring(0, 7);
    if ((db.lockedPeriods || {})[entryPeriod]) {
      return res.status(403).json({ success: false, message: `الفترة ${entryPeriod} مقفلة — لا يمكن تعديل القيد` });
    }

    const { date, desc, ref, lines } = req.body;

    // Also block moving an entry into a locked period
    const newDate = date ? sanitize(date, 10) : existing.date;
    const newPeriod = (newDate || '').substring(0, 7);
    if (newPeriod !== entryPeriod && (db.lockedPeriods || {})[newPeriod]) {
      return res.status(403).json({ success: false, message: `الفترة ${newPeriod} مقفلة — لا يمكن نقل القيد إليها` });
    }

    const newDesc = desc ? sanitize(desc, 500) : (existing.desc || existing.description || '');
    const updated = {
      ...existing,
      id: req.params.id,
      date: newDate,
      desc: newDesc,
      description: newDesc,
      ref:  ref  ? sanitize(ref, 100)  : existing.ref,
      lines: Array.isArray(lines) ? lines : existing.lines,
      updatedAt: new Date().toISOString()
    };
    // P0.2: هذا المسار كان يتحقق من قفل الفترة فقط — الآن يتحقق أيضاً من التوازن
    // ووجود الحسابات وصحة المبالغ، تماماً كأي قيد جديد (الفحص أعلاه لرسائل أدق).
    const guardResult = validateJournalEntry(db, updated);
    if (!guardResult.ok && guardResult.code !== 'PERIOD_LOCKED') {
      return res.status(guardResult.status).json({ success: false, message: guardResult.error, code: guardResult.code });
    }
    // P0.6A — Step 9 (P6-011): recompute totalDebit/totalCredit from the
    // NEW lines server-side — never trust the spread-forward stale values
    // from `existing` (the `...existing` above carries them over
    // unchanged even when `lines` itself was replaced). Computed directly
    // from `updated.lines` rather than trusting guardResult's returned
    // totals, since guardResult.ok can be false yet still fall through to
    // here for the PERIOD_LOCKED special-case above.
    const computedDebit  = (updated.lines || []).reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0);
    const computedCredit = (updated.lines || []).reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
    updated.totalDebit  = parseFloat(computedDebit.toFixed(3));
    updated.totalCredit = parseFloat(computedCredit.toFixed(3));
    db.journalEntries[idx] = updated;
    // مزامنة السند المرتبط: إن كان هذا قيدَ سند (JE-<number>) فحدِّث السند نفسه
    syncVoucherFromJE(db, updated);
    db.journalEntries.sort((a, b) => b.date.localeCompare(a.date));
    appendAuditEvent(db, {
      req, action: 'journal.updated', resourceType: 'journal', resourceId: req.params.id,
      before: { date: existing.date, desc: existing.desc || existing.description, ref: existing.ref },
      after:  { date: updated.date,  desc: updated.desc,                          ref: updated.ref },
    });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for journal.updated:', e.message);
      return res.status(500).json({ success: false, message: 'تعذّر حفظ التعديل بشكل دائم — حاول مرة أخرى' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// يبقي السند متطابقاً مع قيده عند تعديل القيد مباشرة من شاشة القيود
function syncVoucherFromJE(db, je) {
  const v = (db.vouchers || []).find(x => je.ref === x.number || je.id === 'JE-' + x.number);
  if (!v) return;
  const isR = v.type === 'receipt';
  const dist = (je.lines || []).filter(l =>
    String(l.accountId) !== String(v.assetAccId) && String(l.accountCode) !== String(v.assetAccId));
  const lines = (dist.length ? dist : je.lines || []).map(l => ({
    accountId: l.accountId, accountCode: l.accountCode, accountName: l.accountName,
    amount: (isR ? (l.credit || l.debit) : (l.debit || l.credit)) || 0, desc: l.desc || ''
  }));
  v.date   = je.date || v.date;
  v.lines  = lines;
  v.amount = parseFloat((je.lines || []).reduce((s, l) => s + (l.debit || 0), 0).toFixed(3));
  // الطرف النقدي قد يتغيّر أيضاً
  const assetLine = (je.lines || []).find(l => isR ? (l.debit > 0) : (l.credit > 0));
  if (assetLine) { v.assetAccId = assetLine.accountId; v.assetAccName = assetLine.accountName; }
  v.updatedAt = new Date().toISOString();
}

app.delete('/api/journal/:id', requireAuth, tenantMiddleware, requirePermission('journal', 'delete'), async (req, res, next) => {
  try {
    const db = loadDB();
    const entry = (db.journalEntries || []).find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ success: false, message: 'القيد غير موجود' });

    // IFRS compliance: block deletion of entries in locked periods
    const period = (entry.date || '').substring(0, 7);
    if ((db.lockedPeriods || {})[period]) {
      return res.status(403).json({ success: false, message: `الفترة ${period} مقفلة — لا يمكن حذف القيد` });
    }

    // P0.6A — Step 4 (P6-012): the check above only covers the PRIMARY
    // entry's own date. If this entry is an accrued-expense's original
    // accrual JE, deleting it cascades into deleting every payment JE
    // linked to that accrual too (below), and a payment can genuinely sit
    // in a LATER month than the accrual — possibly one that's locked even
    // though the accrual's own month isn't. Determine the full cascade set
    // and check every one of their real dates BEFORE any mutation starts,
    // so the whole delete is all-or-nothing.
    const linkedAccrualPre = (db.accruedExpenses || []).find(a => a.jeId === entry.id);
    if (linkedAccrualPre) {
      const prePayJeIds = new Set((linkedAccrualPre.payments || []).map(p => p.jeId).filter(Boolean));
      const cascadedJEs = db.journalEntries.filter(e => prePayJeIds.has(e.id));
      assertFinancialPeriodOpen(db, cascadedJEs.map(e => e.date));
    }

    // P0.4 — Step 17 Audit Test C: audited BEFORE the record disappears, while
    // `entry` still holds the original data (captured above, pre-filter).
    appendAuditEvent(db, {
      req, action: 'journal.deleted', resourceType: 'journal', resourceId: req.params.id,
      before: { date: entry.date, desc: entry.desc || entry.description, ref: entry.ref, totalDebit: entry.totalDebit, totalCredit: entry.totalCredit },
    });

    db.journalEntries = db.journalEntries.filter(e => e.id !== req.params.id);

    // إن كان قيد سند: احذف السند المرتبط أيضاً حتى لا يبقى معلّقاً
    const v = (db.vouchers || []).find(x => entry.ref === x.number || entry.id === 'JE-' + x.number);
    if (v) db.vouchers = db.vouchers.filter(x => x.id !== v.id);

    // إن كان قيد مصروف (عادي أو متكرر): احذف سجل المصروف المرتبط أيضاً — وُجدا معاً ويُحذفان معاً
    const linkedExpense = (db.expenses || []).find(x => x.journalId === entry.id);
    if (linkedExpense) db.expenses = (db.expenses || []).filter(x => x.id !== linkedExpense.id);

    // إن كان قيد أصل الاستحقاق لمصروف مستحق: احذف كامل سجل المصروف المستحق مع كل قيود دفعاته
    const linkedAccrual = linkedAccrualPre;
    if (linkedAccrual) {
      const payJeIds = new Set((linkedAccrual.payments || []).map(p => p.jeId).filter(Boolean));
      db.journalEntries = db.journalEntries.filter(e => !payJeIds.has(e.id));
      db.accruedExpenses = db.accruedExpenses.filter(a => a.id !== linkedAccrual.id);
    } else {
      // إن كان قيد دفعة (قسط) على مصروف مستحق: احذف تلك الدفعة فقط وأعد احتساب المتبقي
      const owner = (db.accruedExpenses || []).find(a => (a.payments || []).some(p => p.jeId === entry.id));
      if (owner) {
        const removedPay = owner.payments.find(p => p.jeId === entry.id);
        owner.payments = owner.payments.filter(p => p.jeId !== entry.id);
        owner.paidAmount = r3((owner.paidAmount || 0) - (removedPay?.amount || 0));
        owner.remaining  = r3((parseFloat(owner.amount) || 0) - owner.paidAmount);
        owner.status = owner.remaining <= 0.001 ? 'paid' : (owner.paidAmount > 0 ? 'partial' : 'pending');
        if (owner.status !== 'paid') delete owner.paidDate;
      }
    }

    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for journal.deleted:', e.message);
      return res.status(500).json({ success: false, message: 'تعذّر حفظ الحذف بشكل دائم — حاول مرة أخرى' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// AI Journal Entry from invoice image
app.post('/api/ai/journal', requireAuth, requirePermission('ai', 'view'), async (req, res) => {
  try {
    const { image, accounts } = req.body;
    const accountList = accounts.map(a => `${a.code}: ${a.name} (${a.type})`).join('\n');
    
    const raw = await callAIVision({
      model: 'claude-sonnet-4-6',
      base64Image: image,
      max_tokens: 1000,
      prompt: `أنت محاسب خبير. اقرأ هذه الفاتورة وولّد قيد محاسبي.

شجرة الحسابات المتاحة:
${accountList}

أجب بـ JSON فقط بدون أي نص إضافي:
{
  "description": "بيان القيد",
  "ref": "رقم الفاتورة إن وجد",
  "lines": [
    {"accountId": "رقم الحساب من الشجرة", "debit": 0, "credit": 0},
    {"accountId": "رقم الحساب من الشجرة", "debit": 0, "credit": 0}
  ]
}

القواعد: مجموع المدين = مجموع الدائن. للمصروف: مدين حساب المصروف، دائن الصندوق أو البنك. للإيراد: مدين الصندوق أو البنك، دائن حساب الإيراد.`,
    }) || '{}';
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ success: true, ...result });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════
// AI ACCOUNTING ASSISTANT
// ═══════════════════════════════════════════════════
app.post('/api/ai/chat', requireAuth, requirePermission('ai', 'view'), async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const db = loadDB();
    // P0.4A — Step 3: AI must never become an RBAC bypass. A user who cannot
    // read /api/payroll (etc.) directly must not be able to obtain the same
    // figures by asking the chat assistant — so each sensitive section below
    // is only baked into the system prompt if the CURRENT user's own
    // permissions grant read access to that domain.
    const canPayroll   = hasPermission(req.user, 'payroll',   'view', db);
    const canInsurance = hasPermission(req.user, 'insurance', 'view', db);
    const canVouchers  = hasPermission(req.user, 'vouchers',  'view', db);
    const canInventory = hasPermission(req.user, 'inventory', 'view', db);
    const canJournal   = hasPermission(req.user, 'journal',   'view', db);

    // Build financial snapshot for AI context
    const now = new Date();
    const thisMonth = now.toISOString().substring(0, 7);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1).toISOString().substring(0, 7);

    const daily = db.dailyData || [];
    const expenses = db.expenses || [];
    const vouchers = db.vouchers || [];
    const claims = db.insuranceClaims || [];
    const payroll = db.payroll || [];
    const entries = db.journalEntries || [];
    const inventory = db.invItems || [];

    // Monthly revenue
    const revByMonth = {};
    daily.forEach(d => {
      const m = (d.date || '').substring(0, 7);
      if (!revByMonth[m]) revByMonth[m] = 0;
      revByMonth[m] += d.total || 0;
    });

    // Monthly expenses
    const expByMonth = {};
    expenses.forEach(e => {
      const m = (e.date || '').substring(0, 7);
      if (!expByMonth[m]) expByMonth[m] = 0;
      expByMonth[m] += e.amount || 0;
    });

    const totalRevenue = daily.reduce((s, d) => s + (d.total || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const thisMonthRev = revByMonth[thisMonth] || 0;
    const lastMonthRev = revByMonth[lastMonth] || 0;
    const thisMonthExp = expByMonth[thisMonth] || 0;
    const revenueGrowth = lastMonthRev ? ((thisMonthRev - lastMonthRev) / lastMonthRev * 100).toFixed(1) : null;

    // Doctor performance
    const drRev = {};
    daily.forEach(d => {
      if (d.doctor) {
        drRev[d.doctor] = (drRev[d.doctor] || 0) + (d.total || 0);
      }
    });

    // Expense categories
    const expByCat = {};
    expenses.forEach(e => {
      expByCat[e.cat || 'أخرى'] = (expByCat[e.cat || 'أخرى'] || 0) + (e.amount || 0);
    });

    // Payment methods breakdown
    const payMix = { cash: 0, knet: 0, visa: 0, master: 0, insurance: 0, link: 0 };
    daily.forEach(d => {
      payMix.cash += d.cash || 0;
      payMix.knet += d.knet || 0;
      payMix.visa += d.visa || 0;
      payMix.master += d.master || 0;
      payMix.insurance += d.insurance || 0;
      payMix.link += d.link || 0;
    });

    // Insurance claims summary
    const claimPending = claims.filter(c => c.status !== 'received').reduce((s, c) => s + (c.amount || 0), 0);
    const claimReceived = claims.filter(c => c.status === 'received').reduce((s, c) => s + (c.receivedAmount || c.amount || 0), 0);

    // Payroll total
    const payrollTotal = payroll.reduce((s, p) => s + (p.totalNet || 0), 0);
    const payrollPending = payroll.filter(p => p.status !== 'paid').reduce((s, p) => s + (p.totalNet || 0), 0);

    // Top expense categories
    const topExpenses = Object.entries(expByCat)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, amt]) => `${cat}: ${amt.toFixed(3)} د.ك`)
      .join(' | ');

    // Recent vouchers
    const recentVouchers = vouchers.slice(-5).map(v =>
      `${v.number} (${v.type === 'receipt' ? 'قبض' : 'صرف'}) ${(v.amount || 0).toFixed(3)} د.ك — ${v.payee || '—'}`
    ).join('\n');

    const systemPrompt = `أنت مساعد محاسبي ذكي متخصص في عيادة الأسنان "بوبيان". لديك وصول كامل لبيانات العيادة الحقيقية.

═══════════════════════════════════════
📊 الملف المالي الكامل للعيادة (${now.toLocaleDateString('ar-KW')})
═══════════════════════════════════════

💰 الإيرادات:
• إجمالي الإيرادات (كل الفترات): ${totalRevenue.toFixed(3)} د.ك
• إيرادات ${thisMonth}: ${thisMonthRev.toFixed(3)} د.ك
• إيرادات ${lastMonth}: ${lastMonthRev.toFixed(3)} د.ك
• النمو الشهري: ${revenueGrowth !== null ? revenueGrowth + '%' : 'لا يوجد بيانات كافية'}

💸 المصاريف:
• إجمالي المصاريف: ${totalExpenses.toFixed(3)} د.ك
• مصاريف ${thisMonth}: ${thisMonthExp.toFixed(3)} د.ك
• أعلى التصنيفات: ${topExpenses || 'لا يوجد'}

📈 صافي الربح (تقريبي): ${(totalRevenue - totalExpenses).toFixed(3)} د.ك
• هامش الربح: ${totalRevenue ? ((totalRevenue - totalExpenses) / totalRevenue * 100).toFixed(1) + '%' : '—'}

💳 توزيع طرق الدفع (إجمالي):
• كاش: ${payMix.cash.toFixed(3)} د.ك (${totalRevenue ? (payMix.cash / totalRevenue * 100).toFixed(1) : 0}%)
• K-Net: ${payMix.knet.toFixed(3)} د.ك (${totalRevenue ? (payMix.knet / totalRevenue * 100).toFixed(1) : 0}%)
• Visa/Master: ${(payMix.visa + payMix.master).toFixed(3)} د.ك
• تأمين: ${payMix.insurance.toFixed(3)} د.ك (${totalRevenue ? (payMix.insurance / totalRevenue * 100).toFixed(1) : 0}%)
• Link: ${payMix.link.toFixed(3)} د.ك

👨‍⚕️ أداء الدكاترة:
${Object.entries(drRev).map(([dr, rev]) => `• ${dr}: ${rev.toFixed(3)} د.ك`).join('\n') || '• لا يوجد بيانات حسب الدكتور'}

🏥 مطالبات التأمين:
${canInsurance ? `• معلقة/مقدّمة: ${claimPending.toFixed(3)} د.ك (${claims.filter(c => c.status !== 'received').length} مطالبة)
• مستلمة: ${claimReceived.toFixed(3)} د.ك
• شركات التأمين: ${[...new Set(claims.map(c => c.company))].join(', ') || 'لا يوجد'}` : '• 🔒 غير متاح لصلاحياتك'}

👥 الرواتب:
${canPayroll ? `• إجمالي الرواتب المسجّلة: ${payrollTotal.toFixed(3)} د.ك
• رواتب معلقة (غير مدفوعة): ${payrollPending.toFixed(3)} د.ك
• عدد الموظفين: ${(db.employees || []).length}` : '• 🔒 غير متاح لصلاحياتك'}

🧾 السندات:
${canVouchers ? `• إجمالي سندات القبض: ${vouchers.filter(v => v.type === 'receipt').reduce((s, v) => s + v.amount, 0).toFixed(3)} د.ك
• إجمالي سندات الصرف: ${vouchers.filter(v => v.type === 'payment').reduce((s, v) => s + v.amount, 0).toFixed(3)} د.ك` : '• 🔒 غير متاح لصلاحياتك'}

📦 المخزون:
${canInventory ? `• عدد الأصناف: ${inventory.length}
• أصناف تحت الحد الأدنى: ${inventory.filter(i => (i.quantity || 0) <= (i.minQty || 0)).length}` : '• 🔒 غير متاح لصلاحياتك'}

📝 القيود المحاسبية:
${canJournal ? `• إجمالي القيود: ${entries.length}
• آخر قيد: ${entries.length ? entries[entries.length - 1]?.date : 'لا يوجد'}` : '• 🔒 غير متاح لصلاحياتك'}

📅 الشهور المتاحة: ${Object.keys(revByMonth).sort().join(', ') || 'لا يوجد'}

═══════════════════════════════════════

قواعد الإجابة:
1. أجب دائماً بالعربي بأسلوب مهني وواضح
2. استخدم الأرقام الحقيقية من البيانات أعلاه
3. عند تحليل المخاطر كن صريحاً ومحدداً
4. قدم توصيات قابلة للتطبيق
5. استخدم الـ emojis لتنظيم الإجابة
6. عند توليد قيد محاسبي أجب بـ JSON في كتلة \`\`\`json
7. لا تخترع أرقاماً غير موجودة في البيانات`;

    // Build conversation history
    const messages = [];
    if (history && Array.isArray(history)) {
      history.slice(-10).forEach(h => {
        messages.push({ role: h.role, content: h.content });
      });
    }
    messages.push({ role: 'user', content: message });

    const reply = await callAI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: systemPrompt,
      messages,
    }) || 'لم أتمكن من الإجابة';
    res.json({ success: true, reply });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════
// AI CHAT — STREAMING (SSE)
// ═══════════════════════════════════════════════════
app.post('/api/ai/chat/stream', requireAuth, requirePermission('ai', 'view'), async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const db = loadDB();
    // P0.4A — Step 3: same RBAC-bypass guard as /api/ai/chat above — payroll/
    // insurance figures are only computed into the prompt if the user's own
    // permissions grant read access to that domain.
    const canPayroll   = hasPermission(req.user, 'payroll',   'view', db);
    const canInsurance = hasPermission(req.user, 'insurance', 'view', db);
    const now = new Date();
    const thisMonth = now.toISOString().substring(0, 7);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1).toISOString().substring(0, 7);

    const daily = db.dailyData || [];
    const expenses = db.expenses || [];
    const inventory = db.invItems || [];
    const claims = db.insuranceClaims || [];
    const payroll = canPayroll ? (db.payroll || []) : [];
    const vouchers = db.vouchers || [];

    const revByMonth = {};
    daily.forEach(d => { const m = (d.date||'').substring(0,7); revByMonth[m] = (revByMonth[m]||0) + (d.total||0); });
    const expByMonth = {};
    expenses.forEach(e => { const m = (e.date||'').substring(0,7); expByMonth[m] = (expByMonth[m]||0) + (e.amount||0); });
    const drRev = {};
    daily.forEach(d => { if (d.doctor) drRev[d.doctor] = (drRev[d.doctor]||0) + (d.total||0); });
    const expByCat = {};
    expenses.forEach(e => { expByCat[e.cat||'أخرى'] = (expByCat[e.cat||'أخرى']||0) + (e.amount||0); });
    const payMix = { cash:0, knet:0, visa:0, master:0, insurance:0, link:0 };
    daily.forEach(d => { payMix.cash+=d.cash||0; payMix.knet+=d.knet||0; payMix.visa+=d.visa||0; payMix.master+=d.master||0; payMix.insurance+=d.insurance||0; payMix.link+=d.link||0; });

    const totalRevenue = daily.reduce((s,d) => s+(d.total||0), 0);
    const totalExpenses = expenses.reduce((s,e) => s+(e.amount||0), 0);
    const thisMonthRev = revByMonth[thisMonth]||0;
    const lastMonthRev = revByMonth[lastMonth]||0;
    const thisMonthExp = expByMonth[thisMonth]||0;
    const revenueGrowth = lastMonthRev ? ((thisMonthRev-lastMonthRev)/lastMonthRev*100).toFixed(1) : null;
    const claimPending = canInsurance ? claims.filter(c=>c.status!=='received').reduce((s,c)=>s+c.amount,0) : 0;
    const lowStock = inventory.filter(i=>(i.qty||0)<=(i.minQty||0));
    const topExpenses = Object.entries(expByCat).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([c,a])=>`${c}: ${a.toFixed(3)} د.ك`).join(' | ');

    // Compute next available code per range — injected into prompt so AI never picks an existing code
    const usedCodes = new Set((db.chartOfAccounts||[]).map(a => a.code));
    const nextCode = (from, to) => { for (let i = from; i <= to; i++) { const c = String(i); if (!usedCodes.has(c)) return c; } return String(to); };
    const nextCodes = {
      asset: nextCode(1100,1999), liability: nextCode(2100,2999),
      equity: nextCode(3100,3999), revenue: nextCode(4100,4999),
      salaries: nextCode(5010,5099), materials: nextCode(5110,5199),
      supplies: nextCode(5210,5299), rent: nextCode(5310,5399),
      utilities: nextCode(5410,5499), maintenance: nextCode(5510,5599),
      marketing: nextCode(5610,5699), admin: nextCode(5710,5799),
      depreciation: nextCode(5810,5899), misc: nextCode(5910,5999),
    };

    const systemPrompt = `أنت مساعد محاسبي لعيادة "بوبيان" للأسنان. أجب بالعربي فقط.

تعليمات مهمة:
- لا تكتب JSON أبداً
- لا تقل "تم الإضافة" أو "تم التسجيل" — أنت لا تضيف الحسابات مباشرة، المستخدم هو من يؤكد الإضافة
- عند طلب إضافة حساب: استخدم الأداة add_account مباشرةً باستخدام الكود المتاح من جدول الأكواد أدناه

شجرة الحسابات الموجودة (كود — اسم):
${(db.chartOfAccounts||[]).map(a=>`${a.code}:${a.name}`).join(' | ')}

الكود التالي المتاح لكل نوع — استخدم هذا الكود بالضبط ولا تختر غيره:
• مصاريف متنوعة: ${nextCodes.misc}
• مواد: ${nextCodes.materials} | مستلزمات: ${nextCodes.supplies}
• رواتب: ${nextCodes.salaries} | إيجار: ${nextCodes.rent} | مرافق: ${nextCodes.utilities}
• صيانة: ${nextCodes.maintenance} | تسويق: ${nextCodes.marketing} | إداري: ${nextCodes.admin}
• أصول: ${nextCodes.asset} | خصوم: ${nextCodes.liability} | إيرادات: ${nextCodes.revenue}

═══ بيانات العيادة (${now.toLocaleDateString('ar-KW')}) ═══
إيرادات إجمالية: ${totalRevenue.toFixed(3)} | هذا الشهر: ${thisMonthRev.toFixed(3)} | الشهر الماضي: ${lastMonthRev.toFixed(3)} د.ك
نقد: ${payMix.cash.toFixed(3)} | K-Net: ${payMix.knet.toFixed(3)} | تأمين: ${payMix.insurance.toFixed(3)} | Link: ${payMix.link.toFixed(3)} د.ك
مصاريف: ${totalExpenses.toFixed(3)} | رواتب: ${payroll.reduce((s,p)=>s+(p.totalNet||0),0).toFixed(3)} | صافي ربح: ${(totalRevenue-totalExpenses-payroll.reduce((s,p)=>s+(p.totalNet||0),0)).toFixed(3)} د.ك
دكاترة: ${Object.entries(drRev).map(([d,r])=>`${d}: ${r.toFixed(3)}`).join(' | ')||'لا يوجد'}
تأمين معلق: ${claimPending.toFixed(3)} | مخزون: ${inventory.length} صنف`;

    const messages = [];
    if (history && Array.isArray(history)) history.slice(-10).forEach(h => messages.push({ role: h.role, content: h.content }));
    messages.push({ role: 'user', content: message });

    send('tool', { name: 'قراءة البيانات المالية', status: 'done', summary: `${daily.length} سجل، ${expenses.length} مصروف، ${inventory.length} صنف مخزون` });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 1200, system: systemPrompt, messages, stream: true,
        tools: [{
          name: 'add_account',
          description: 'اقترح إضافة حساب تفصيلي واحد فقط (ليس مجموعة) في شجرة الحسابات. السيرفر هو من يحدد الكود الصحيح.',
          input_schema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'اسم الحساب بالعربي' },
              type: { type: 'string', enum: ['asset','liability','equity','revenue','expense'], description: 'نوع الحساب' },
              parent: { type: 'string', description: 'كود الحساب الأب إذا كان موجوداً في الشجرة' }
            },
            required: ['name','type']
          }
        }]
      })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let toolInput = '';
    let inTool = false;
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
            inTool = true; toolInput = '';
          } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
            toolInput += evt.delta.partial_json || '';
          } else if (evt.type === 'content_block_stop' && inTool) {
            inTool = false;
            try {
              const params = JSON.parse(toolInput);
              const accType = params.type || 'expense';
              const parentCode = parseInt(params.parent) || 0;
              // Server overrides AI code with guaranteed-available code from correct range
              const codeMap = {
                asset: nextCodes.asset, liability: nextCodes.liability, equity: nextCodes.equity,
                revenue: nextCodes.revenue,
              };
              let serverCode;
              if (accType !== 'expense') {
                serverCode = codeMap[accType] || nextCodes.misc;
              } else if (parentCode >= 5900 || !parentCode) {
                serverCode = nextCodes.misc;
              } else if (parentCode >= 5800) serverCode = nextCodes.depreciation;
              else if (parentCode >= 5700) serverCode = nextCodes.admin;
              else if (parentCode >= 5600) serverCode = nextCodes.marketing;
              else if (parentCode >= 5500) serverCode = nextCodes.maintenance;
              else if (parentCode >= 5400) serverCode = nextCodes.utilities;
              else if (parentCode >= 5300) serverCode = nextCodes.rent;
              else if (parentCode >= 5200) serverCode = nextCodes.supplies;
              else if (parentCode >= 5100) serverCode = nextCodes.materials;
              else serverCode = nextCodes.misc;
              send('action', { type: 'addAccount', code: serverCode, name: params.name, accountType: accType, parent: params.parent||null });
            } catch {}
          } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            fullText += evt.delta.text;
            send('delta', { text: evt.delta.text });
          }
        } catch {}
      }
    }

    // Fallback: if model output JSON or ADDACCOUNT text instead of using the tool, extract and emit action
    const usedCoa = new Set((db.chartOfAccounts||[]).map(a => a.code));

    // Auto-correct a code if already used — pick next available in same range
    const autoCorrectCode = (code, accType) => {
      if (!usedCoa.has(code)) return code;
      const n = parseInt(code) || 0;
      if (n >= 5900) return nextCodes.misc;
      if (n >= 5800) return nextCodes.depreciation;
      if (n >= 5700) return nextCodes.admin;
      if (n >= 5600) return nextCodes.marketing;
      if (n >= 5500) return nextCodes.maintenance;
      if (n >= 5400) return nextCodes.utilities;
      if (n >= 5300) return nextCodes.rent;
      if (n >= 5200) return nextCodes.supplies;
      if (n >= 5100) return nextCodes.materials;
      if (n >= 5000) return nextCodes.salaries;
      if (n >= 4000) return nextCodes.revenue;
      if (n >= 3000) return nextCodes.equity;
      if (n >= 2000) return nextCodes.liability;
      return nextCodes.asset;
    };

    const emittedCodes = new Set();
    const emitAction = (code, name, accountType, parent) => {
      const finalCode = autoCorrectCode(code, accountType);
      if (!finalCode || emittedCodes.has(finalCode)) return;
      emittedCodes.add(finalCode);
      send('action', { type: 'addAccount', code: finalCode, name, accountType: accountType||'expense', parent: parent||null });
    };

    // Try ADDACCOUNT text format
    const addRe = /ADDACCOUNT:([^:\n]+):([^:\n]+):([^:\n]+):([^\n]*)/g;
    let m;
    while ((m = addRe.exec(fullText)) !== null) {
      const [, code, name, type, parent] = m.map(s => (s||'').trim());
      if (code && name) emitAction(code, name, type, parent);
    }
    // Try JSON blocks — catches cases where model writes JSON despite instructions
    const jsonBlockRe = /```(?:json)?\s*([\s\S]*?)```/g;
    while ((m = jsonBlockRe.exec(fullText)) !== null) {
      try {
        const parsed = JSON.parse(m[1]);
        const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : (parsed.code ? [parsed] : []);
        for (const acc of accounts) {
          if (acc.code && acc.name) emitAction(acc.code, acc.name, acc.type, acc.parent);
        }
      } catch {}
    }

    send('done', { success: true });
    res.end();

  } catch (err) {
    send('error', { message: err.message });
    res.end();
  }
});

// ═══════════════════════════════════════════════════
// MONITORING AGENT — مراقب تلقائي للعيادة
// ═══════════════════════════════════════════════════
function buildFinancialSummary(db) {
  const now = new Date();
  const thisMonth = now.toISOString().substring(0, 7);
  const daily = db.dailyData || [];
  const expenses = db.expenses || [];
  const payroll = db.payroll || [];
  const inventory = db.invItems || [];
  const claims = db.insuranceClaims || [];

  const monthlyRev = daily.filter(d=>(d.date||'').startsWith(thisMonth)).reduce((s,d)=>s+(d.total||0),0);
  const monthlyExp = expenses.filter(e=>(e.date||'').startsWith(thisMonth)).reduce((s,e)=>s+(e.amount||0),0);
  const monthlyPayroll = payroll.filter(p=>(p.period||'').startsWith(thisMonth)).reduce((s,p)=>s+(p.totalNet||0),0);
  const totalRev = daily.reduce((s,d)=>s+(d.total||0),0);
  const pendingClaims = claims.filter(c=>c.status!=='received').reduce((s,c)=>s+c.amount,0);
  const lowItems = inventory.filter(i=>(i.qty||0)<=(i.minQty||0));

  return { now, thisMonth, monthlyRev, monthlyExp, monthlyPayroll, totalRev, pendingClaims, lowItems, inventory };
}

// P0.6B — Step 29 (NEW-B / P6-070): `db.telegramChatId` (singular) is never
// written anywhere in this codebase — both functions below always no-op.
// The canonical, actually-configured recipient list is `cfg.telegramChatIds`
// (array, in config.json — the exact same source POST /api/reports/send-
// telegram already uses to broadcast buildDailySummaryText() to every
// registered chat). Sends to every configured recipient, not just one.
async function runInventoryCheck() {
  const db = loadDB();
  const bot = global._tgBot;
  const ids = ((loadConfig().telegramChatIds) || []).filter(Boolean);
  if (!bot || !ids.length) return;

  const { lowItems } = buildFinancialSummary(db);
  if (!lowItems.length) return;

  const lines = lowItems.map(i => `• ${i.name||i.id}: ${i.qty||0} ${i.unit||''} (الحد الأدنى: ${i.minQty||0})`).join('\n');
  const msg = `⚠️ *تنبيه المخزون — بوبيان للأسنان*\n\nالأصناف التالية وصلت للحد الأدنى:\n${lines}\n\n📅 ${new Date().toLocaleDateString('ar-KW')}`;
  for (const id of ids) { try { await bot.sendMessage(id, msg, { parse_mode: 'Markdown' }); } catch {} }
}

async function runMonthlyReport() {
  const db = loadDB();
  const bot = global._tgBot;
  const ids = ((loadConfig().telegramChatIds) || []).filter(Boolean);
  if (!bot || !ids.length) return;

  const { thisMonth, monthlyRev, monthlyExp, monthlyPayroll, pendingClaims, lowItems, inventory } = buildFinancialSummary(db);
  const net = monthlyRev - monthlyExp - monthlyPayroll;

  const msg = `📊 *التقرير الشهري — ${thisMonth}*\n*عيادة بوبيان للأسنان*\n\n` +
    `💰 *الإيرادات:* ${monthlyRev.toFixed(3)} د.ك\n` +
    `💸 *المصاريف:* ${monthlyExp.toFixed(3)} د.ك\n` +
    `👥 *الرواتب:* ${monthlyPayroll.toFixed(3)} د.ك\n` +
    `📈 *صافي الربح:* ${net.toFixed(3)} د.ك\n` +
    `🏥 *مطالبات معلقة:* ${pendingClaims.toFixed(3)} د.ك\n` +
    `📦 *المخزون:* ${inventory.length} صنف، ${lowItems.length} منخفض\n\n` +
    `_تم الإرسال تلقائياً من نظام المحاسبة_`;

  for (const id of ids) { try { await bot.sendMessage(id, msg, { parse_mode: 'Markdown' }); } catch {} }
}

// Endpoint لتشغيل الفحص يدوياً
// P0.4A — Step 4: these manually trigger the SAME scheduled Telegram sends
// as the automation engine (runInventoryCheck/runMonthlyReport) — the
// monthly one broadcasts payroll/insurance figures externally, so it's
// gated like any other privileged external-side-effect action rather than
// left open to every authenticated role.
app.post('/api/monitor/inventory', requireAuth, requireAdminAction('monitor.trigger_inventory'), async (req, res) => {
  await runInventoryCheck();
  res.json({ success: true, message: 'تم فحص المخزون وإرسال التنبيهات' });
});
app.post('/api/monitor/monthly-report', requireAuth, requireAdminAction('monitor.trigger_monthly_report'), async (req, res) => {
  await runMonthlyReport();
  res.json({ success: true, message: 'تم إرسال التقرير الشهري' });
});
app.get('/api/monitor/status', requireAuth, requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const { lowItems, inventory, monthlyRev, monthlyExp, thisMonth } = buildFinancialSummary(db);
  res.json({
    botActive: !!global._tgBot,
    chatIdSet: !!db.telegramChatId,
    inventoryItems: inventory.length,
    lowStockItems: lowItems.length,
    thisMonth, monthlyRev, monthlyExp,
    // R4 (Part Q/R): minimal operational status — DB backend mode and
    // scheduled-backup visibility, no new monitoring vendor, no
    // browser-based restore. _backupStatus is only ever populated when the
    // scheduler is actually active (production only, see startBackupSchedule
    // above) so this honestly reports "not active" elsewhere rather than
    // fabricating a schedule that isn't really running.
    dbBackend: isFileFallbackMode() ? 'file' : 'mongo',
    backup: _backupStatus,
  });
});

// جدولة تلقائية بدون مكتبة خارجية
(function startMonitorSchedule() {
  function msUntilNext(hour, minute, dayOfMonth) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (dayOfMonth) {
      next.setDate(dayOfMonth);
      if (next <= now) { next.setMonth(next.getMonth() + 1); next.setDate(dayOfMonth); }
    } else {
      if (next <= now) next.setDate(next.getDate() + 1);
    }
    return next - now;
  }

  // فحص المخزون يومياً الساعة 8 صباحاً
  function scheduleInventoryCheck() {
    const delay = msUntilNext(8, 0);
    setTimeout(() => { runInventoryCheck(); scheduleInventoryCheck(); }, delay);
  }

  // تقرير شهري كل أول الشهر الساعة 9 صباحاً
  function scheduleMonthlyReport() {
    const delay = msUntilNext(9, 0, 1);
    setTimeout(() => { runMonthlyReport(); scheduleMonthlyReport(); }, delay);
  }

  scheduleInventoryCheck();
  scheduleMonthlyReport();
  console.log('🤖 Monitoring agent started — daily inventory check @ 8:00am, monthly report @ 1st of month 9:00am');
})();

// R3 — NEW-R1-BACKUP: automatic scheduled backup. `scripts/backup.js`
// already has checksum/rotation/restore-safety (P0.5) — this only adds
// scheduling on top, reusing the exact recursive-setTimeout pattern proven
// safe above (no external cron dependency). Runs `backup.js` as a CHILD
// PROCESS (matching scripts/backup-scheduled-example.sh's own invocation)
// rather than in-process, so it never opens a second `mongoose.connect()`
// inside the live server — backup.js owns its own connect/close.
//
// R3 (adversarial review): the original guard excluded NODE_ENV==='test'/
// JEST_WORKER_ID — bulletproof against Jest itself, but `scripts/departments
// /_sandbox.js` spawns a real `node server.js` child (its own isolated DB)
// WITHOUT ever setting NODE_ENV, so that exclusion never applied there —
// the scheduler could activate inside a department-agent sandbox run, using
// the real repo's backups/ directory (BACKUP_DIR unset in that spawn),
// mixing throwaway sandbox-run backups in among real operator backups.
// Flipped to explicit OPT-IN (production only) instead of opt-out
// (everything-except-test) — a daily filesystem-writing scheduler has no
// business running in local dev or any sandbox/test context either, so
// this is the more conservative default even beyond closing the slip-
// through.
// R4 (Part Q/R) — operational status visibility. The scheduler below only
// ever logged to console; there was zero admin-visible signal for whether
// the last automatic backup succeeded, when the next one is due, or even
// whether the scheduler is running at all (only active in production —
// see the guard just below, so a non-production deployment should
// honestly report "scheduler not active" rather than silently show stale
// or fabricated values). Read by GET /api/monitor/status.
let _backupStatus = {
  schedulerActive: false,
  lastRunAt: null, lastResult: null /* 'success'|'failure'|null */, lastFile: null, lastError: null,
  nextScheduledAt: null,
};

(function startBackupSchedule() {
  if (process.env.NODE_ENV !== 'production') return;
  _backupStatus.schedulerActive = true;

  const { execFile } = require('child_process');
  const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
  let backupRunning = false;

  function msUntilNext(hour, minute) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }

  function newestBackupFile() {
    try {
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-') && f.endsWith('.json')).sort();
      return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
    } catch { return null; }
  }

  function runScheduledBackup() {
    if (backupRunning) {
      console.warn('⚠️  Scheduled backup skipped — a previous run is still in progress (no overlapping runs).');
      return;
    }
    backupRunning = true;
    console.log('🗄️  Scheduled backup starting...');
    execFile(process.execPath, [path.join(__dirname, 'scripts', 'backup.js')], { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        // The previous backup file is never touched by a failed run —
        // backup.js only rotates old files AFTER a successful write.
        console.error('❌ FATAL: scheduled backup failed —', err.message);
        if (stderr) console.error(stderr.trim());
        backupRunning = false;
        _backupStatus.lastRunAt = new Date().toISOString();
        _backupStatus.lastResult = 'failure';
        _backupStatus.lastError = err.message;
        return;
      }
      const latest = newestBackupFile();
      if (!latest) {
        console.error('❌ FATAL: scheduled backup process exited 0 but no backup file was found — treating as a failure.');
        backupRunning = false;
        _backupStatus.lastRunAt = new Date().toISOString();
        _backupStatus.lastResult = 'failure';
        _backupStatus.lastError = 'exited 0 but no backup file was produced';
        return;
      }
      execFile(process.execPath, [path.join(__dirname, 'scripts', 'verify-backup.js'), latest], (verifyErr, vOut) => {
        _backupStatus.lastRunAt = new Date().toISOString();
        _backupStatus.lastFile = path.basename(latest);
        if (verifyErr) {
          console.error(`❌ FATAL: scheduled backup ${path.basename(latest)} FAILED integrity verification —`, verifyErr.message);
          _backupStatus.lastResult = 'failure';
          _backupStatus.lastError = 'فشل التحقق من سلامة النسخة: ' + verifyErr.message;
        } else {
          console.log(`✅ Scheduled backup verified: ${path.basename(latest)}`);
          _backupStatus.lastResult = 'success';
          _backupStatus.lastError = null;
        }
        backupRunning = false;
      });
    });
  }

  function scheduleBackup() {
    const delay = msUntilNext(3, 0); // 3:00am — off-peak, distinct from the 8am/9am monitor jobs above
    _backupStatus.nextScheduledAt = new Date(Date.now() + delay).toISOString();
    setTimeout(() => { runScheduledBackup(); scheduleBackup(); }, delay).unref();
  }

  scheduleBackup();
  console.log('🗄️  Backup scheduler started — daily automatic backup @ 3:00am');
})();

// ═══════════════════════════════════════════════════
// FINANCIAL STATEMENTS — 3-Statement Model
// P&L + Balance Sheet + Cash Flow (linked)
// ═══════════════════════════════════════════════════
app.get('/api/financial-statements', requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const { period = 'month', year, month } = req.query;

  const daily   = db.dailyData        || [];
  const expenses = db.expenses        || [];
  const payroll  = db.payroll         || [];
  const claims   = db.insuranceClaims || [];
  const vouchers = db.vouchers        || [];

  // ── Filter by period ──────────────────────────────
  const now = new Date();
  const targetYear  = parseInt(year)  || now.getFullYear();
  const targetMonth = parseInt(month) || now.getMonth() + 1;
  const monthStr = `${targetYear}-${String(targetMonth).padStart(2,'0')}`;

  const filterByPeriod = (items, dateField = 'date') => {
    if (period === 'month')  return items.filter(i => (i[dateField]||'').startsWith(monthStr));
    if (period === 'year')   return items.filter(i => (i[dateField]||'').startsWith(String(targetYear)));
    return items; // all-time
  };

  const pDaily    = filterByPeriod(daily);
  const pExpenses = filterByPeriod(expenses);
  const pPayroll  = filterByPeriod(payroll, 'period');
  const pVouchers = filterByPeriod(vouchers);

  // P0.6A — Step 10/12 (P6-052): a single "as of" snapshot date for the
  // Balance Sheet section below — previously the Balance Sheet ignored the
  // requested period entirely (always summed EVERY journal entry ever
  // posted, including ones dated after the requested period). Point-in-time
  // by construction now: last day of the requested month/year, or today for
  // an unscoped ("all") request — matching how /api/reports/balance-sheet's
  // own `date` parameter already works.
  const asOfDate = (() => {
    // P0.11 (Part L — date/period boundary correctness): was
    // `new Date(targetYear, targetMonth, 0).toISOString().slice(0, 10)` —
    // constructs a LOCAL-time Date then converts to UTC before slicing.
    // In any server timezone with a positive UTC offset (e.g. Asia/Riyadh,
    // UTC+3 — this environment), local midnight of the month's last day
    // converts to the PREVIOUS UTC day, silently excluding that day's real
    // transactions from both this Balance Sheet snapshot and (via
    // pnlToDate below) that month's Income Statement. monthEndDate() reads
    // the local calendar day number directly (`.getDate()`, never
    // `.toISOString()`) and is timezone-safe — reused here instead of a
    // second, subtly different implementation of the same "last day of
    // month" calculation.
    if (period === 'month') return monthEndDate(monthStr);
    if (period === 'year')  return `${targetYear}-12-31`;
    return new Date().toISOString().slice(0, 10);
  })();
  // P&L date range — null bounds = unbounded, matching the pre-existing
  // "all" behavior exactly.
  const pnlFromDate = period === 'month' ? `${monthStr}-01` : (period === 'year' ? `${targetYear}-01-01` : null);
  const pnlToDate   = period === 'month' ? asOfDate          : (period === 'year' ? `${targetYear}-12-31` : null);

  // ══════════════════════════════════════════════════
  // INCOME STATEMENT (P&L)
  // ══════════════════════════════════════════════════

  // P0.6A — Step 10 (canonical reporting architecture): both balance maps
  // now go through the SAME shared buildBalanceMap() helper /api/reports/*
  // already uses, instead of two separate hand-rolled loops — one shared
  // source of truth for "sum journal lines per account over a date range."
  // ── ALL-TIME-UP-TO-asOfDate COA balance map (Balance Sheet) ──
  const allCoaBalMap = buildBalanceMap(db, null, asOfDate);
  // ── PERIOD COA balance map (Income Statement) — closing-transfer entries
  // excluded (P6-043): a month/year-end closing entry nets that period's
  // own revenue/expense accounts to zero by design; including it here would
  // silently cancel real operating activity for any range that spans a
  // closed period.
  const coaBalMap = buildBalanceMap(db, pnlFromDate, pnlToDate, { excludeClosing: true });
  const periodJE = (db.journalEntries || []).filter(je => {
    if (pnlFromDate && je.date < pnlFromDate) return false;
    if (pnlToDate   && je.date > pnlToDate)   return false;
    if (je.type === 'closing') return false;
    return true;
  });

  // Sum by COA type from period journal entries
  const coaAccounts = db.chartOfAccounts || [];
  const coaTypeSum = (type) => {
    return coaAccounts.filter(a=>a.type===type).reduce((s,a) => {
      const b = coaBalMap[a.code];
      if (!b) return s;
      // expense/asset: balance = debit - credit; revenue/liability/equity: credit - debit
      const bal = (type==='expense'||type==='asset') ? b.debit - b.credit : b.credit - b.debit;
      return s + Math.max(0, bal);
    }, 0);
  };

  // Revenue — primary source: COA 4xxx accounts in period JEs (same source as expenses)
  // Fallback to dailyData aggregates for legacy data that predates JE auto-creation
  const cashRev = pDaily.reduce((s,d) => s + (d.cash||0), 0);
  const knetRev = pDaily.reduce((s,d) => s + (d.knet||0) + (d.visa||0) + (d.master||0), 0);
  const linkRev = pDaily.reduce((s,d) => s + (d.link||0), 0);
  const insRev  = pDaily.reduce((s,d) => s + (d.insurance||0), 0);
  const dailyRevTotal = cashRev + knetRev + linkRev + insRev;

  const jeRevTotal   = coaTypeSum('revenue');
  const totalRevenue = jeRevTotal > 0 ? jeRevTotal : dailyRevTotal;

  // Expense breakdown by category (for display)
  const expByCat = {};
  pExpenses.forEach(e => {
    const cat = e.cat || 'مصاريف عامة';
    expByCat[cat] = (expByCat[cat] || 0) + (e.amount || 0);
  });

  // Fallback figures from raw tables (used only if no JEs)
  const salaryExpense = pPayroll.reduce((s,p) => s + (p.totalGross||p.totalNet||0), 0);
  const totalExpenses = pExpenses.reduce((s,e) => s + (e.amount||0), 0);

  // Real depreciation from JE type=depreciation in period
  const depreciation = periodJE
    .filter(je => je.type==='depreciation')
    .reduce((s,je) => s + (je.lines||[]).filter(l=>l.debit>0).reduce((ss,l)=>ss+(parseFloat(l.debit)||0),0), 0);

  // Expenses — from COA 5xxx accounts in period JEs (primary), fallback to raw tables
  // P0.6A — Step 11 (P6-051): `coaTypeSum('expense')` sums EVERY expense-
  // type account, which already includes account 5800 (depreciation) —
  // `depreciation` above is that same amount, computed separately so it can
  // be shown as its own line. Subtracting it here means it is counted
  // exactly once (as its own explicit line via `ebit = ebitda - depreciation`
  // below), not twice. Before this fix, a period with depreciation
  // understated net profit by exactly the depreciation amount.
  const jeExpenseTotalRaw = coaTypeSum('expense');
  const jeExpenseTotal = jeExpenseTotalRaw > 0 ? Math.max(0, jeExpenseTotalRaw - depreciation) : 0;
  const totalOpEx  = jeExpenseTotalRaw > 0 ? jeExpenseTotal : (totalExpenses + salaryExpense);
  const totalCOGS  = 0; // dental clinic: direct costs already in operating expenses

  const grossProfit = totalRevenue - totalCOGS;
  const grossMargin = totalRevenue ? (grossProfit / totalRevenue * 100) : 0;
  const ebitda      = grossProfit - totalOpEx;
  const ebit        = ebitda - depreciation;
  const netProfit   = ebit;
  const netMargin   = totalRevenue ? (netProfit / totalRevenue * 100) : 0;

  // ══════════════════════════════════════════════════
  // BALANCE SHEET  (all figures from double-entry JE)
  // ══════════════════════════════════════════════════
  // allCoaBalMap is already built above (all-time JE balance map)

  // Helper: all-time balance for a single account code
  const accBal = (code) => {
    const b = allCoaBalMap[String(code)];
    if (!b) return 0;
    return b.debit - b.credit; // positive = debit-normal (assets/expenses)
  };
  const accBalCr = (code) => {
    const b = allCoaBalMap[String(code)];
    if (!b) return 0;
    return b.credit - b.debit; // positive = credit-normal (liabilities/equity/revenue)
  };

  // ── Current Assets (display breakdown) ──────────
  const cashBalance     = accBal('1100');  // may be negative if overdraft
  const bankBalance     = accBal('1110');
  // P0.9 — P6-072: was accBal('1120') (card settlement, unrelated) — see
  // the insurance-claims routes' fix comment for full cross-codebase
  // evidence. 1130 is the correct, already-elsewhere-used insurance
  // receivable account; totalAssets itself was never wrong (both codes fed
  // the same currentAssets sum either way), only the display LABEL/bucket
  // was — this is a pure re-labeling fix, zero change to any total.
  const insRecFromJE    = Math.max(0, accBal('1130'));
  const insRecFromClaims= (db.insuranceClaims||[]).filter(c=>c.status!=='received').reduce((s,c)=>s+(c.amount||0),0);
  const insReceivable   = insRecFromJE > 0 ? insRecFromJE : insRecFromClaims;
  // P0.6A — Step 13 (P6-053): account 1200 (patient AR) was entirely
  // missing from this breakdown despite being a real, populated asset
  // account — silently excluded from the current-assets total shown here.
  // P0.11 — no longer clamped to 0: GET /api/patient-ar-aging's own
  // glTotal for the same account (server.js, patient-ar-aging route) is
  // unclamped, and a genuinely negative 1200 balance (net credit/
  // overpayment) must be shown honestly here too, matching the same
  // never-plug precedent already applied to netFixedAssets below.
  const patientReceivable = accBal('1200');
  const otherReceivable = Math.max(0, accBal('1140')); // 1130 now correctly counted under insReceivable above, not here
  const inventory       = (db.invItems||[]).reduce((s,i)=>s+((i.quantity||0)*(i.unitCost||0)),0);
  const currentAssets   = cashBalance + bankBalance + insReceivable + patientReceivable + otherReceivable + inventory;

  // ── Fixed Assets (display breakdown) ────────────
  const fixedAssetsGross = (db.fixedAssets||[]).filter(a=>a.status==='active').reduce((s,a)=>s+(parseFloat(a.cost)||0),0);
  const accumDeprJE      = Math.max(0, accBalCr('1590'));
  const accumDeprReg     = (db.fixedAssets||[]).reduce((s,a)=>s+(parseFloat(a.accumulatedDep)||0),0);
  const accumDepr        = accumDeprJE > 0 ? accumDeprJE : accumDeprReg;
  // P0.6A — Step 13 (P6-053): no longer clamped to 0 — a genuinely negative
  // net book value (over-depreciated/orphaned register data) must be shown
  // honestly, not silently hidden as zero (see docs/ACCOUNTING_INVARIANTS.md
  // — never plug/hide a real discrepancy).
  const netFixedAssets   = fixedAssetsGross - accumDepr;
  // P0.11 (DoD: "Assets reconcile through GL to BS"): fixedAssetsGross/
  // accumDepr above are a DISPLAY figure that mixes register-cost with a
  // GL-preferring accumDepr fallback — this doesn't itself change (avoiding
  // an unjustified display-behavior change), but a real register/GL 1510
  // /1590 mismatch was previously only discoverable by separately querying
  // GET /api/assets/reconciliation. Mirrors that endpoint's own math
  // exactly (same field names), scoped to this report's own asOfDate, so
  // the same honest cross-check is visible on the flagship screen itself.
  const fixedAssetReconciliation = (() => {
    // P0.11 (adversarial review finding, financial-statements persona): two
    // real bugs in the original version of this self-check, both fixed here
    // without touching the pre-existing accumDepr DISPLAY fallback above
    // (accumDeprReg) — that's older P0.6A-era logic, out of this fix's scope.
    //
    // Bug 1: registerAccumDep reused accumDeprReg, which sums EVERY asset's
    // accumulatedDep with no status filter — while registerCost (via
    // fixedAssetsGross) is already active-only. Disposal never clears
    // accumulatedDep (that field is system-managed and PUT explicitly
    // refuses to touch it — see ASSET_SYSTEM_MANAGED_FIELDS), so a disposed
    // asset's stale depreciation permanently polluted this sum against a
    // cost total that had already dropped that same asset — reconciled
    // would go permanently false after any disposal even though the GL and
    // the disposal accounting are both correct. Fixed by summing
    // accumulatedDep over the SAME active-only asset set as registerCost.
    //
    // Bug 2: glCost/glAccumDep were hardcoded to 1510/1590, but each asset
    // supports a caller-chosen coaAccount/accDepAccount (POST /api/assets).
    // A tenant using a non-default control account got a register total
    // that included those assets while the GL comparison silently excluded
    // them — a permanent, configuration-driven false mismatch. Fixed by
    // summing GL balances over the actual set of accounts the active
    // register assets use, not a fixed pair.
    const activeAssets = (db.fixedAssets||[]).filter(a=>a.status==='active');
    const registerCost = fixedAssetsGross;
    const registerAccumDep = activeAssets.reduce((s,a)=>s+(parseFloat(a.accumulatedDep)||0),0);
    const costAccountCodes = [...new Set(activeAssets.map(a=>a.coaAccount||'1510'))];
    const depAccountCodes  = [...new Set(activeAssets.map(a=>a.accDepAccount||'1590'))];
    const glCost = costAccountCodes.reduce((s,code)=>s+accBal(code), 0);
    const glAccumDep = depAccountCodes.reduce((s,code)=>s+accBalCr(code), 0);
    return {
      registerCost: parseFloat(registerCost.toFixed(3)), glCost: parseFloat(glCost.toFixed(3)),
      registerAccumDep: parseFloat(registerAccumDep.toFixed(3)), glAccumDep: parseFloat(glAccumDep.toFixed(3)),
      reconciled: Math.abs(registerCost - glCost) <= 0.005 && Math.abs(registerAccumDep - glAccumDep) <= 0.005,
    };
  })();

  // Additional non-current assets from COA (intangibles 1600+, investments 1700+)
  const otherNonCurrent = coaAccounts.filter(a=>a.type==='asset' && a.code>='1600').reduce((s,a)=>{
    const b = allCoaBalMap[a.code]; if (!b) return s;
    return s + (b.debit - b.credit);
  }, 0);

  // P0.6A — Step 13 (P6-053): totalAssets is now DERIVED from the exact
  // same current/fixed/otherNonCurrent breakdown returned to the caller
  // below, instead of a separate parallel ledger sweep (`coaAssetTotalJE`)
  // that could — and did — disagree with the displayed detail (missing
  // 1200; the old sweep also double-counted inventory whenever account 1300
  // itself carried a real JE balance alongside the separate physical
  // `db.invItems` valuation). Guarantees the response's own sub-totals
  // always reconcile to its own grand total by construction.
  const totalAssets = currentAssets + netFixedAssets + otherNonCurrent;

  // ── Liabilities ──────────────────────────────────
  // All liabilities come from COA 2xxx accounts in JE ledger (no raw-array fallbacks)
  const coaLiabTotal = coaAccounts.filter(a=>a.type==='liability').reduce((s,a) => {
    const b = allCoaBalMap[a.code]; if (!b) return s;
    return s + Math.max(0, b.credit - b.debit);
  }, 0);
  const totalLiab = coaLiabTotal;

  // ── Equity ───────────────────────────────────────
  // Paid-in capital and prior retained earnings from COA 3xxx JE ledger
  const paidInCapital = Math.max(0, accBalCr('3100'));
  const priorRetained = accBalCr('3200'); // may be negative (accumulated losses)
  // Current-period net income from P&L (not yet closed to 3200)
  const currentPeriodNI = netProfit;
  // P0.11 (financial-statement forensic finding): this previously never
  // read account 3300 — P0.6B's canonical period-close transfer target
  // (computeAndPostClosingEntry posts Dr revenue/Cr expense/Cr-or-Dr 3300
  // for each closed month; 3200 above is legacy/unused since that
  // unification). For any month/year-scoped report requested AFTER a
  // prior period had been closed, that prior period's transferred profit
  // was invisible — not in priorRetained (3200, dead) and not in
  // currentPeriodNI (scoped to the REQUESTED period only) — so
  // Assets != Liabilities+Equity by exactly the missing amount. Reproducible:
  // close month 1, then request month 2's statement -> balanced:false.
  //
  // Fix: sum 3300 activity dated STRICTLY BEFORE the requested period's own
  // start (pnlFromDate). This captures every PRIOR period's transferred
  // profit while deliberately excluding anything dated INSIDE the
  // currently-requested period — that period's own gross P&L is already
  // fully counted via currentPeriodNI (built from this SAME period's raw
  // revenue/expense JEs), so including this same period's own closing
  // entry here too would double-count it. For period:'all' (pnlFromDate is
  // null), currentPeriodNI already spans the entire history end-to-end on
  // its own, so priorClosedRetained is correctly 0 — adding anything would
  // double-count the whole thing.
  //
  // Known narrow limitation (pre-existing, not introduced by this fix): a
  // manual journal entry posted directly to 3300 and dated INSIDE the
  // requested period (outside the designed close workflow — no exposed
  // route does this) would not appear in either term. No worse than the
  // previous behavior, which ignored 3300 unconditionally.
  const priorClosedRetained = pnlFromDate
    ? (db.journalEntries || [])
        .filter(je => je.date < pnlFromDate)
        .reduce((s, je) => s + (je.lines || []).reduce((ss, l) => {
          const code = String(l.accountCode || l.account || '');
          return code === '3300' ? ss + ((parseFloat(l.credit) || 0) - (parseFloat(l.debit) || 0)) : ss;
        }, 0), 0)
    : 0;
  // Total equity = paid-in capital + prior retained (legacy 3200) + prior
  // closed-period transfers (3300) + current period net income
  const totalEquity = paidInCapital + priorRetained + priorClosedRetained + currentPeriodNI;

  // Balance check — tolerance 0.005 KD (half a fils); any larger gap is a real error
  const bsDiff      = Math.abs(totalAssets - (totalLiab + totalEquity));
  const balanceCheck = bsDiff < 0.005;

  // ══════════════════════════════════════════════════
  // CASH FLOW STATEMENT — Indirect Method
  // ══════════════════════════════════════════════════

  // P0.11 — journal-entry types that represent a one-time opening/investing
  // posting rather than a period's real operating working-capital movement.
  // Declared once here (BEFORE periodInsRecChange, which is the first of the
  // two working-capital scans below to run) and reused by periodLiabChange
  // further down — both scans need the identical exclusion set, and a
  // `const` referenced before its own declaration line throws (temporal
  // dead zone), so this must sit above both IIFEs, not between them.
  const NON_OPERATING_JE_TYPES = new Set(['asset_purchase', 'asset_disposal', 'opening', 'vendor-opening']);

  // Operating: start with net income, add back non-cash items, adjust working capital
  // Working capital changes derived from period JE movements in current asset/liability accounts
  const periodInsRecChange = (() => {
    const periodBal = {};
    periodJE.forEach(je => {
      // P0.11 (adversarial review finding, financial-statements persona):
      // this scan previously had NO type exclusion at all — an 'opening' or
      // 'vendor-opening' entry touching 1120/1130/1200 would inflate
      // operating cash flow exactly like the periodLiabChange bug below.
      if (NON_OPERATING_JE_TYPES.has(je.type)) return;
      (je.lines||[]).forEach(l => {
        const code = String(l.accountCode || l.account || '');
        if (!code) return;
        if (!periodBal[code]) periodBal[code] = { debit:0, credit:0 };
        periodBal[code].debit  += parseFloat(l.debit)  || 0;
        periodBal[code].credit += parseFloat(l.credit) || 0;
      });
    });
    // Increase in receivables = use of cash (negative); decrease = source of cash (positive)
    const chg1120 = (periodBal['1120']?.debit||0) - (periodBal['1120']?.credit||0);
    const chg1130 = (periodBal['1130']?.debit||0) - (periodBal['1130']?.credit||0);
    // P0.6A — Step 15 (P6-054): account 1200 (patient AR) was omitted from
    // this working-capital adjustment despite being a real, populated
    // receivable account feeding into P&L revenue — any clinic actually
    // using patient AR got an overstated operating cash flow.
    const chg1200 = (periodBal['1200']?.debit||0) - (periodBal['1200']?.credit||0);
    return chg1120 + chg1130 + chg1200;
  })();

  // Increase in payables = source of cash; decrease = use of cash.
  // P0.11 (Cash Flow forensic finding, exposed by the new GL-reconciliation
  // self-check below): a credit-financed asset purchase (payMethod:'credit',
  // Dr 1510 / Cr 2100) was previously counted here too, since 2100 is a
  // general liability-type account used for BOTH ordinary operating payables
  // (unpaid expense/inventory bills) AND capital-asset purchases. Treating
  // that credit as an "operating" working-capital source of cash created a
  // phantom cash inflow equal to the asset's full cost, even though
  // `periodCapEx`/`cfInvesting` already (correctly) excludes the same
  // purchase entirely — inflating netCashFlow by exactly that amount with
  // no real cash ever moving. NON_OPERATING_JE_TYPES (declared above,
  // shared with periodInsRecChange) is the fix: opening/investing postings
  // never belong to operating working capital.
  const periodLiabChange = (() => {
    const periodBal = {};
    periodJE.forEach(je => {
      if (NON_OPERATING_JE_TYPES.has(je.type)) return;
      (je.lines||[]).forEach(l => {
        const code = String(l.accountCode || l.account || '');
        if (!coaAccounts.find(a=>a.code===code && a.type==='liability')) return;
        if (!periodBal[code]) periodBal[code] = { debit:0, credit:0 };
        periodBal[code].debit  += parseFloat(l.debit)  || 0;
        periodBal[code].credit += parseFloat(l.credit) || 0;
      });
    });
    return Object.values(periodBal).reduce((s,b)=>s+(b.credit-b.debit),0);
  })();

  const cfOperating = netProfit
    + depreciation            // add back non-cash depreciation
    - periodInsRecChange      // decrease/(increase) in receivables
    + periodLiabChange;       // increase/(decrease) in payables

  // Investing: actual capital expenditures in the period (new assets purchased)
  // P0.10 — Part C/Step 8: only cash/bank-paid assets represent an actual
  // cash outflow — an asset bought on credit (Dr 1510 / Cr 2100, payMethod
  // 'credit') moves zero cash at acquisition. Previously every asset's full
  // cost was summed regardless of payMethod, overstating this line for any
  // credit-financed purchase. `payMethod` is now stored on the asset record
  // (see POST /api/assets) — assets created before this milestone have no
  // stored payMethod and are treated as cash (their prior, only-available
  // behavior), so this is purely additive precision, not a behavior
  // regression for existing data.
  const isCashPaid = a => (a.payMethod || 'cash') !== 'credit';
  const periodCapEx = (() => {
    if (period === 'month') {
      return (db.fixedAssets||[]).filter(a=>isCashPaid(a) && (a.purchaseDate||'').startsWith(monthStr)).reduce((s,a)=>s+(parseFloat(a.cost)||0),0);
    }
    if (period === 'year') {
      return (db.fixedAssets||[]).filter(a=>isCashPaid(a) && (a.purchaseDate||'').startsWith(String(targetYear))).reduce((s,a)=>s+(parseFloat(a.cost)||0),0);
    }
    return (db.fixedAssets||[]).filter(isCashPaid).reduce((s,a)=>s+(parseFloat(a.cost)||0),0);
  })();
  const cfInvesting = -periodCapEx; // cash paid for assets = outflow

  // Financing: owner contributions (3100 credits) minus drawings (3100 debits) in period
  const cfFinancing = (() => {
    const periodBal = {};
    periodJE.forEach(je => {
      (je.lines||[]).forEach(l => {
        const code = String(l.accountCode || l.account || '');
        if (!periodBal[code]) periodBal[code] = { debit:0, credit:0 };
        periodBal[code].debit  += parseFloat(l.debit)  || 0;
        periodBal[code].credit += parseFloat(l.credit) || 0;
      });
    });
    const b3100 = periodBal['3100'];
    const b3400 = periodBal['3400']; // drawings account
    const contributions = b3100 ? b3100.credit - b3100.debit : 0;
    const drawings      = b3400 ? b3400.debit  - b3400.credit : 0;
    return contributions - drawings;
  })();

  const netCashFlow = cfOperating + cfInvesting + cfFinancing;

  // P0.11 (Objective C / Part K Step 29): the indirect-method cash flow
  // above had no internal check against the ACTUAL GL cash/bank movement —
  // every other subledger-facing endpoint in this system (AP aging, patient
  // AR aging, asset reconciliation) self-reports an honest `reconciled`
  // boolean; this route did not. Opening cash = GL 1100+1110 balance as of
  // the day before the requested period starts; closing cash = the SAME
  // balance as of asOfDate (already computed via allCoaBalMap/accBal above,
  // for period:'all' there is no meaningful prior boundary so opening is 0
  // by definition, matching how currentPeriodNI already treats 'all'). No
  // plug: if the indirect-method reconstruction and the real GL movement
  // disagree, `reconciled:false` surfaces that honestly instead of hiding it.
  const cashFlowGLCheck = (() => {
    const closingCashGL = parseFloat((accBal('1100') + accBal('1110')).toFixed(3));
    let openingCashGL = 0;
    if (pnlFromDate) {
      const openingAsOf = (() => { const d = new Date(pnlFromDate); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
      const openingMap = buildBalanceMap(db, null, openingAsOf);
      const b1100 = openingMap['1100'] || { debit: 0, credit: 0 };
      const b1110 = openingMap['1110'] || { debit: 0, credit: 0 };
      openingCashGL = parseFloat(((b1100.debit - b1100.credit) + (b1110.debit - b1110.credit)).toFixed(3));
    }
    const impliedClosingCash = parseFloat((openingCashGL + netCashFlow).toFixed(3));
    return {
      openingCashGL, closingCashGL, impliedClosingCash,
      reconciled: Math.abs(impliedClosingCash - closingCashGL) <= 0.005,
    };
  })();

  // ══════════════════════════════════════════════════
  // KEY RATIOS
  // ══════════════════════════════════════════════════
  const currentRatio    = totalLiab ? (currentAssets / totalLiab) : null;
  const debtToEquity    = totalEquity ? (totalLiab / totalEquity) : 0;
  const returnOnEquity  = totalEquity ? (netProfit / totalEquity * 100) : 0;
  const returnOnAssets  = totalAssets ? (netProfit / totalAssets * 100) : 0;

  // Revenue breakdown by doctor
  const drRevenue = {};
  (db.paymentsData||[]).forEach(p => {
    if (!p.doctor || p.doctor === 'Advance') return;
    drRevenue[p.doctor] = (drRevenue[p.doctor]||0) + (p.total||0);
  });

  res.json({
    period: { type: period, year: targetYear, month: targetMonth, label: period === 'month' ? monthStr : String(targetYear) },
    incomeStatement: {
      revenue: {
        cash: cashRev, knet: knetRev, link: linkRev, insurance: insRev, total: totalRevenue
      },
      cogs: totalCOGS,
      grossProfit, grossMarginPct: grossMargin,
      operatingExpenses: {
        byCategory: expByCat,
        salaries: salaryExpense,
        total: totalOpEx
      },
      ebitda,
      depreciation,
      ebit,
      netProfit, netMarginPct: netMargin,
    },
    balanceSheet: {
      assets: {
        current: {
          cash: cashBalance,
          bank: bankBalance,
          insuranceReceivable: insReceivable,
          patientReceivable,
          otherReceivable,
          inventory,
          total: currentAssets,
        },
        fixed: { gross: fixedAssetsGross, accumulatedDepreciation: accumDepr, net: netFixedAssets, glReconciliation: fixedAssetReconciliation },
        otherNonCurrent,
        total: totalAssets,
      },
      liabilities: {
        fromJE: coaLiabTotal,
        total: totalLiab,
      },
      equity: {
        paidInCapital,
        priorRetainedEarnings: priorRetained,
        currentPeriodNetIncome: currentPeriodNI,
        total: totalEquity,
      },
      totalLiabAndEquity: parseFloat((totalLiab + totalEquity).toFixed(3)),
      balanced: balanceCheck,
      differenceKD: parseFloat(bsDiff.toFixed(3)),
    },
    cashFlow: {
      operating: cfOperating,
      investing: cfInvesting,
      financing: cfFinancing,
      netChange: netCashFlow,
      openingCash: cashFlowGLCheck.openingCashGL,
      closingCash: cashFlowGLCheck.closingCashGL,
      impliedClosingCash: cashFlowGLCheck.impliedClosingCash,
      reconciled: cashFlowGLCheck.reconciled,
      note: cashFlowGLCheck.reconciled ? 'يطابق حركة النقدية الفعلية في دفتر الأستاذ.' : 'فرق حقيقي بين إعادة بناء التدفق النقدي غير المباشر وحركة حسابي 1100/1110 الفعلية — راجع بنود رأس المال العامل غير المُغطاة (كالمخزون أو حسابات ذمم أخرى).',
    },
    ratios: {
      currentRatio, debtToEquity,
      returnOnEquity, returnOnAssets,
      grossMargin, netMargin,
    },
    doctorRevenue: drRevenue,
  });
});

// Recurring expenses endpoints
// P0.12 (closes P6-097 — a retried template-creation request duplicated
// the template, which then posts a real journal entry every period it
// runs; also P0.11-class fix — was fire-and-forget saveDB(db), no
// durable:true and no await, so an ack could precede an actual write).
app.post('/api/recurring', requirePermission('recurring', 'add'), async (req, res, next) => {
 try {
  const db = loadDB();
  if (!db.recurringExpenses) db.recurringExpenses = [];

  const isMongo = !isFileFallbackMode();
  const idemKey = extractIdempotencyKey(req);
  let idemRecord = null;
  if (idemKey) {
    const v = validateIdempotencyKey(idemKey);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
    const b = req.body || {};
    const fingerprint = computeFingerprint('recurring:create', { desc: b.desc, amount: b.amount, cat: b.cat, payMethod: b.payMethod, frequency: b.frequency, day: b.day, accountId: b.accountId });
    const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'recurring:create', idemKey, fingerprint);
    if (!claim.claimed && claim.record.status === 'COMPLETED') {
      return res.json({ success: true, idempotentReplay: true });
    }
    idemRecord = claim.record;
  }

  try {
    db.recurringExpenses.push(req.body);
    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { id: req.body.id }, req.body.id, null);
  } catch (e) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    throw e;
  }
  appendAuditEvent(db, { req, action: 'recurring.template_created', resourceType: 'recurringExpenses', resourceId: req.body.id, after: { desc: req.body.desc, amount: req.body.amount } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for recurring.template_created:', e.message);
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ المصروف المتكرر بشكل دائم — حاول مرة أخرى' });
  }
  if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
  res.json({ success: true });
 } catch (err) {
  next(err);
 }
});

app.delete('/api/recurring/:id', requirePermission('recurring', 'delete'), (req, res) => {
  const db = loadDB();
  const item = (db.recurringExpenses||[]).find(r => r.id === req.params.id);
  db.recurringExpenses = (db.recurringExpenses||[]).filter(r => r.id !== req.params.id);
  if (item) appendAuditEvent(db, { req, action: 'recurring.template_deleted', resourceType: 'recurringExpenses', resourceId: item.id, before: { desc: item.desc, amount: item.amount } });
  saveDB(db);
  res.json({ success: true });
});

// هل حان موعد تنفيذ المصروف المتكرر؟ (يحترم التكرار: يومي/أسبوعي/شهري/ربعي/سنوي)
function recurringIsDue(r, today) {
  if (!r.active) return false;
  const freq = r.frequency || 'monthly';
  if (!r.lastApplied) return true; // لم يُطبّق من قبل → مستحق الآن
  const last = new Date(r.lastApplied + (r.lastApplied.length <= 10 ? 'T00:00:00' : ''));
  if (isNaN(last)) return true;
  const days = Math.floor((today - last) / 86400000);
  switch (freq) {
    case 'daily':     return days >= 1;
    case 'weekly':    return days >= 7;
    case 'quarterly': return days >= 90;
    case 'yearly':    return days >= 365;
    case 'monthly':
    default:          return today.toISOString().slice(0, 7) !== r.lastApplied.slice(0, 7);
  }
}

function recurringNextRun(r, fromDate) {
  const base = r.lastApplied ? new Date(r.lastApplied) : fromDate;
  const d = new Date(base);
  switch (r.frequency || 'monthly') {
    case 'daily':     d.setDate(d.getDate() + 1); break;
    case 'weekly':    d.setDate(d.getDate() + 7); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'yearly':    d.setFullYear(d.getFullYear() + 1); break;
    default:          d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().slice(0, 10);
}

// P0.12 — Part G note: NOT wrapped with the generic Idempotency-Key layer.
// recurringIsDue() is itself a real, existing per-item idempotency guard —
// keyed by (item, period) via r.lastApplied — that already makes a retried
// or duplicate "run" call a no-op for anything already applied this period,
// for every frequency (daily/weekly/monthly/quarterly/yearly). Adding a
// second, request-level key here would be redundant, not protective.
// P0.11-class fix: was a fire-and-forget saveDB(db) with no durable:true
// and no await — an ack could precede the actual write for real postings.
app.post('/api/recurring/run', requirePermission('recurring', 'add'), async (req, res, next) => {
 try {
  const db = loadDB();
  const items = db.recurringExpenses || [];
  const today = new Date();
  const thisMonth = today.toISOString().substring(0, 7);
  let applied = 0;

  items.forEach(r => {
    if (!recurringIsDue(r, today)) return; // يحترم التكرار — يمنع التكرار المزدوج

    if (!db.expenses) db.expenses = [];
    if (!db.journalEntries) db.journalEntries = [];
    const day = Math.min(28, Math.max(1, parseInt(r.day) || 1));
    const date = `${thisMonth}-${String(day).padStart(2, '0')}`;
    const jeId = 'JE-REC-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const expId = genId('exp-');

    // ربط المصروف بقيده حتى يُحذفا معاً
    db.expenses.push({
      id: expId, desc: r.desc + ' (متكرر)', cat: r.cat, amount: r.amount,
      date, payMethod: r.payMethod || 'cash', source: 'recurring', journalId: jeId,
    });

    const accounts = db.chartOfAccounts || [];
    // حساب المصروف: المحدد يدوياً → وإلا حسب الفئة → دائماً حساب موجود فعلاً بالشجرة
    // (القديم كان يخترع 5699 غير الموجود فيختفي المصروف من قائمة الدخل ويختل الميزان)
    const found   = accounts.find(a => a.id === r.accountId || a.code === r.accountId);
    const resolved = found ? { code: String(found.code), name: found.name } : expCatToAccount(r.cat, accounts);
    const expAcc  = { id: resolved.code, code: resolved.code, name: resolved.name };
    const credit  = payMethodToAccount(r.payMethod || 'cash');
    const cashAcc = accounts.find(a => a.code === credit.code) || { id: credit.code, code: credit.code, name: credit.name };
    // P0.2: بنود التكرار مستقلة عن بعضها — فشل بند واحد (مثلاً فترة مقفلة) لا
    // يجوز أن يوقف تطبيق بقية المصاريف المتكررة المستحقة في نفس التشغيلة.
    try {
      appendJournalEntry(db, {
        id: jeId, date, desc: r.desc + ' (متكرر)', description: r.desc + ' (متكرر)',
        ref: 'REC', reference: 'REC', type: 'expense', source: 'recurring', expenseId: expId,
        totalDebit: r.amount, totalCredit: r.amount, createdAt: new Date().toISOString(),
        lines: [
          { accountId: expAcc.id, accountCode: expAcc.code, accountName: expAcc.name, debit: r.amount, credit: 0 },
          { accountId: cashAcc.id, accountCode: cashAcc.code, accountName: cashAcc.name, debit: 0, credit: r.amount },
        ],
      });
    } catch (e) {
      if (!(e instanceof JournalValidationError)) throw e;
      db.expenses = db.expenses.filter(x => x.id !== expId); // تراجع عن سجل المصروف اليتيم
      console.warn(`⚠️ تخطي مصروف متكرر "${r.desc}": ${e.message}`);
      return;
    }

    r.lastApplied = date;
    r.nextRun = recurringNextRun(r, today);
    applied++;
  });

  appendAuditEvent(db, { req, action: 'recurring.run', resourceType: 'recurringExpenses', after: { applied } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for recurring.run:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ نتيجة التشغيل بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true, applied });
 } catch (err) {
  next(err);
 }
});

// ═══════════════════════════════════════════════════
// MANUAL INCOME ENTRY
// ═══════════════════════════════════════════════════
// P0.6A — Steps 16/17 (P6-059): the ONE shared manual daily-income service
// every entry point (HTTP API, AI agent) must call — same channel→account
// mapping and appendJournalEntry() validation as the HTTP route always
// used. Throws (plain Error or JournalValidationError) and mutates NOTHING
// on failure. If the caller only has a single lump-sum figure (e.g. an
// AI-proposed `total`/`amount` with no cash/knet/visa/... breakdown), it is
// treated as a cash-only day — the same aggregate outcome a human would get
// manually entering that day as all-cash via this same route.
function buildAndPostManualIncome(db, data) {
  const { date, doctor, cash, knet, visa, master, insurance, link, notes } = data;
  if (!date) throw new Error('date required');

  let cash_=parseFloat(cash)||0, knet_=parseFloat(knet)||0,
      visa_=parseFloat(visa)||0, master_=parseFloat(master)||0,
      ins_=parseFloat(insurance)||0, link_=parseFloat(link)||0;
  if (cash_===0 && knet_===0 && visa_===0 && master_===0 && ins_===0 && link_===0) {
    const lump = parseFloat(data.total ?? data.amount) || 0;
    if (lump > 0) cash_ = lump;
  }
  const total = cash_+knet_+visa_+master_+ins_+link_;

  const entry = {
    id: 'MAN-'+Date.now(), source:'manual',
    date, doctor: doctor||'',
    cash:cash_, knet:knet_, visa:visa_, master:master_,
    insurance:ins_, link:link_, total, notes:notes||''
  };

  // Auto journal entry
  const accounts = db.chartOfAccounts||[];
  const cashAcc = accounts.find(a=>a.code==='1100')||{id:'1100',code:'1100',name:'الصندوق'};
  const knetAcc = accounts.find(a=>a.code==='1110')||{id:'1110',code:'1110',name:'K-Net'};
  const revAcc  = accounts.find(a=>a.code==='4100')||{id:'4100',code:'4100',name:'إيرادات العيادة'};

  const lines=[];
  if(cash_>0) lines.push({accountId:cashAcc.id,accountCode:'1100',accountName:'الصندوق',debit:cash_,credit:0});
  if(knet_>0||visa_>0||master_>0||link_>0){
    const netCard=knet_+visa_+master_+link_;
    lines.push({accountId:knetAcc.id,accountCode:'1110',accountName:'مدفوعات شبكة',debit:netCard,credit:0});
  }
  if(ins_>0){
    // P0.9 — P6-072: was '1120' (card settlement, unrelated) — see the
    // insurance-claims routes' fix comment for full cross-codebase evidence.
    const insAcc=accounts.find(a=>a.code==='1130')||{id:'1130',code:'1130',name:'ذمم مدينة — شركات التأمين'};
    lines.push({accountId:insAcc.id,accountCode:insAcc.code,accountName:insAcc.name,debit:ins_,credit:0});
  }
  lines.push({accountId:revAcc.id,accountCode:'4100',accountName:'إيرادات العيادة',debit:0,credit:total});

  // P0.3 — Pattern A: validate/append the journal BEFORE dailyData is stored,
  // so a rejected posting (e.g. locked period) never leaves a phantom daily
  // income record with no matching journal entry.
  appendJournalEntry(db, {
    id:'JE-MAN-'+Date.now(), date,
    desc:`إيراد يدوي ${date}${doctor?' — '+doctor:''}`,
    ref:'MAN', type:'revenue',
    totalDebit:total, totalCredit:total,
    createdAt:new Date().toISOString(), lines
  });

  if (!db.dailyData) db.dailyData = [];
  db.dailyData.push(entry);
  return { entry };
}

app.post('/api/manual-entry', requirePermission('manual', 'add'), (req, res) => {
  const db = loadDB();
  let result;
  try {
    result = buildAndPostManualIncome(db, req.body);
  } catch (e) {
    if (e instanceof JournalValidationError) throw e;
    return res.status(400).json({ error: e.message });
  }
  appendAuditEvent(db, { req, action: 'manual_entry.created', resourceType: 'dailyData', resourceId: result.entry.id, after: { date: result.entry.date, total: result.entry.total, doctor: result.entry.doctor } });
  saveDB(db);
  res.json({ success:true, entry: result.entry });
});

// ═══════════════════════════════════════════════════
// VOUCHERS — سندات القبض والصرف
// ═══════════════════════════════════════════════════
function nextVoucherNo(db, type) {
  const prefix = type==='receipt'?'RV':'PV';
  const all = (db.vouchers||[]).filter(v=>v.type===type);
  const nums = all.map(v=>parseInt((v.number||'0').replace(/\D/g,''))||0);
  const next = nums.length ? Math.max(...nums)+1 : 1;
  return `${prefix}-${String(next).padStart(4,'0')}`;
}

// رقم مرجع قصير مقروء للمصاريف المستحقة (بدل ACR-<timestamp> الطويل)
function nextAccruedNo(db) {
  const all = db.accruedExpenses || [];
  const nums = all.map(a=>parseInt((a.number||'0').replace(/\D/g,''))||0);
  const next = nums.length ? Math.max(...nums)+1 : 1;
  return `ACR-${String(next).padStart(4,'0')}`;
}

app.get('/api/vouchers', requirePermission('vouchers', 'view'), (req,res)=>{
  const db=loadDB();
  let v=db.vouchers||[];
  if(req.query.type) v=v.filter(x=>x.type===req.query.type);
  if(req.query.from) v=v.filter(x=>x.date>=req.query.from);
  if(req.query.to)   v=v.filter(x=>x.date<=req.query.to);
  res.json(v.sort((a,b)=>b.date.localeCompare(a.date)));
});

// يبني السند + قيده المتوازن من الطلب (مشترك بين الإضافة والتعديل)
function buildVoucherAndJE(db, body, existing) {
  const {type,date,payee,notes,checkNo,assetAccId,lines} = body;
  const accounts=db.chartOfAccounts||[];
  const assetAcc=accounts.find(a=>String(a.id)===String(assetAccId)||String(a.code)===String(assetAccId))||{id:assetAccId||'',code:assetAccId||'',name:'حساب نقدي'};
  const resolvedLines=(lines||[]).filter(l=>(parseFloat(l.amount)||0)>0).map(l=>{
    const acc=accounts.find(a=>String(a.id)===String(l.accountId)||String(a.code)===String(l.accountId))||{id:l.accountId,code:l.accountId,name:l.accountId};
    return {accountId:acc.id,accountCode:acc.code,accountName:acc.name,amount:parseFloat(l.amount)||0,desc:l.desc||''};
  });
  const total=r3(resolvedLines.reduce((s,l)=>s+l.amount,0));
  const number = existing?.number || nextVoucherNo(db,type);
  const voucher={
    id: existing?.id || 'VCH-'+Date.now(), number, type, date, amount:total,
    payee:payee||'', notes:notes||'', checkNo:checkNo||'',
    assetAccId:assetAcc.id, assetAccName:assetAcc.name,
    lines:resolvedLines,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: existing ? new Date().toISOString() : undefined
  };
  const jeLines=[];
  if(type==='receipt'){
    jeLines.push({accountId:assetAcc.id,accountCode:assetAcc.code,accountName:assetAcc.name,debit:total,credit:0});
    resolvedLines.forEach(l=>jeLines.push({accountId:l.accountId,accountCode:l.accountCode,accountName:l.accountName,debit:0,credit:l.amount}));
  } else {
    resolvedLines.forEach(l=>jeLines.push({accountId:l.accountId,accountCode:l.accountCode,accountName:l.accountName,debit:l.amount,credit:0}));
    jeLines.push({accountId:assetAcc.id,accountCode:assetAcc.code,accountName:assetAcc.name,debit:0,credit:total});
  }
  const lineNote = resolvedLines.map(l=>l.desc).filter(Boolean).join('، ');
  const jeDesc=(type==='receipt'?`سند قبض ${number}`:`سند صرف ${number}`)+(payee?` — ${payee}`:'')+(lineNote?` — ${lineNote}`:'')+(checkNo?` — شيك #${checkNo}`:'');
  const je={ id:'JE-'+number, date, desc:jeDesc, description:jeDesc,
    ref:number, reference:number, type, totalDebit:total, totalCredit:total,
    createdAt:new Date().toISOString(), lines:jeLines };
  return { voucher, je };
}

app.post('/api/vouchers', requirePermission('vouchers', 'add'), async (req,res,next)=>{
  try {
    const db=loadDB();
    const {type,date,lines} = req.body;
    if(!type||!date) return res.status(400).json({error:'missing fields'});
    if(!lines||!lines.length) return res.status(400).json({error:'no lines provided'});
    const { voucher, je } = buildVoucherAndJE(db, req.body);
    if(!db.vouchers) db.vouchers=[];
    appendJournalEntry(db, je);
    db.vouchers.push(voucher);
    appendAuditEvent(db, { req, action: 'voucher.created', resourceType: 'voucher', resourceId: voucher.id, after: { number: voucher.number, type: voucher.type, amount: voucher.amount } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for voucher.created:', e.message);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ السند بشكل دائم — حاول مرة أخرى' });
    }
    res.json({success:true,voucher});
  } catch (err) {
    next(err);
  }
});

// تعديل سند — يحذف قيده القديم ويعيد إنشاءه (مربوط بالقيود)
// P0.11 (saveDB call-site audit): converted to durable-before-ack, matching
// the ~37 already-hardened financial-critical routes — this posts/replaces
// a real journal entry and previously relied solely on the 400ms debounce.
app.put('/api/vouchers/:id', requirePermission('vouchers', 'edit'), async (req,res,next)=>{
 try {
  const db=loadDB();
  const idx=(db.vouchers||[]).findIndex(v=>String(v.id)===String(req.params.id));
  if(idx<0) return res.status(404).json({error:'not found'});
  const old=db.vouchers[idx];
  if(!req.body.lines||!req.body.lines.length) return res.status(400).json({error:'no lines provided'});
  // P0.3 — Pattern C: build + validate the REPLACEMENT journal entry BEFORE
  // deleting the old one. Deleting first (as before) meant a rejected
  // re-post (locked period, phantom account) left the voucher's journal
  // entry gone with nothing to replace it.
  const { voucher, je } = buildVoucherAndJE(db, { ...req.body, type: req.body.type||old.type }, old);
  const result = validateJournalEntry(db, je);
  if (!result.ok) throw new JournalValidationError(result.error, result.status, result.code);
  // P0.6A — Step 4 (P6-012): the OLD voucher JE is about to be removed —
  // check its own period isn't locked before doing so (a locked-period
  // voucher edit rejecting the NEW entry via validateJournalEntry above
  // was already safe; this guards the destructive removal of the old one).
  assertFinancialPeriodOpen(db, [old.date]);
  // احذف قيد السند القديم (بالمعرّف أو بالمرجع) والتزم بالجديد معاً
  db.journalEntries=(db.journalEntries||[]).filter(j=>j.id!=='JE-'+old.number && j.ref!==old.number);
  db.journalEntries.push(je);
  db.vouchers[idx]=voucher;
  appendAuditEvent(db, { req, action: 'voucher.updated', resourceType: 'voucher', resourceId: voucher.id, before: { amount: old.amount, payee: old.payee }, after: { amount: voucher.amount, payee: voucher.payee } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for voucher.updated:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التعديل بشكل دائم — حاول مرة أخرى' });
  }
  res.json({success:true,voucher});
 } catch (err) {
  if (err instanceof JournalValidationError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  next(err);
 }
});

app.delete('/api/vouchers/:id', requirePermission('vouchers', 'delete'), async (req,res,next)=>{
 try {
  const db=loadDB();
  const v=(db.vouchers||[]).find(x=>String(x.id)===String(req.params.id));
  // P0.6A — Step 4 (P6-012): check before mutating anything.
  if (v) assertFinancialPeriodOpen(db, [v.date]);
  db.vouchers=(db.vouchers||[]).filter(x=>String(x.id)!==String(req.params.id));
  // احذف قيد السند المرتبط أيضاً (كان يبقى معلّقاً في القيود)
  if(v) db.journalEntries=(db.journalEntries||[]).filter(j=>j.id!=='JE-'+v.number && j.ref!==v.number);
  if(v) appendAuditEvent(db, { req, action: 'voucher.deleted', resourceType: 'voucher', resourceId: v.id, before: { number: v.number, amount: v.amount } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for voucher.deleted:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ الحذف بشكل دائم — حاول مرة أخرى' });
  }
  res.json({success:true});
 } catch (err) {
  next(err);
 }
});

// ═══════════════════════════════════════════════════
// CASH RECONCILIATION — تسوية الصندوق
// ═══════════════════════════════════════════════════
app.get('/api/cash-reconciliation', requirePermission('cashrecon', 'view'), (req,res)=>{
  const db=loadDB();
  let r=db.cashReconciliation||[];
  if(req.query.from) r=r.filter(x=>x.date>=req.query.from);
  if(req.query.to)   r=r.filter(x=>x.date<=req.query.to);
  res.json(r.sort((a,b)=>b.date.localeCompare(a.date)));
});

// P0.11 (saveDB call-site audit): converted to durable-before-ack.
app.post('/api/cash-reconciliation', requirePermission('cashrecon', 'add'), async (req,res,next)=>{
 try {
  const db=loadDB();
  const {date,openingBalance,physicalCash,notes} = req.body;
  if(!date) return res.status(400).json({error:'date required'});

  // Calculate expected from dailyData that day
  const daily=db.dailyData||[];
  const dayData=daily.filter(d=>d.date===date);
  const expectedCash=dayData.reduce((s,d)=>s+(d.cash||0),0);
  const expectedKnet=dayData.reduce((s,d)=>s+(d.knet||0)+(d.visa||0)+(d.master||0)+(d.link||0),0);
  const totalRevenue=dayData.reduce((s,d)=>s+(d.total||0),0);
  const dayExpenses=(db.expenses||[]).filter(e=>e.date===date).reduce((s,e)=>s+(e.amount||0),0);

  const open=parseFloat(openingBalance)||0;
  const physical=parseFloat(physicalCash)||0;
  const expectedClosing=open+expectedCash-dayExpenses;
  const diff=physical-expectedClosing;

  const rec={
    id:'REC-'+Date.now(), date,
    openingBalance:open, physicalCash:physical,
    expectedCash, expectedKnet, totalRevenue,
    dayExpenses, expectedClosing,
    difference:diff, status:Math.abs(diff)<0.001?'balanced':diff>0?'surplus':'shortage',
    notes:notes||'', createdAt:new Date().toISOString()
  };

  if(!db.cashReconciliation) db.cashReconciliation=[];
  // Remove existing for same date
  db.cashReconciliation=db.cashReconciliation.filter(r=>r.date!==date);
  db.cashReconciliation.push(rec);
  appendAuditEvent(db, { req, action: 'cash_reconciliation.created', resourceType: 'cashReconciliation', resourceId: rec.id, after: { date: rec.date, difference: rec.difference, status: rec.status } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for cash_reconciliation.created:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التسوية بشكل دائم — حاول مرة أخرى' });
  }
  res.json({success:true, rec});
 } catch (err) {
  next(err);
 }
});

// ═══════════════════════════════════════════════════
// INSURANCE CLAIMS — مطالبات التأمين
// ═══════════════════════════════════════════════════
app.get('/api/insurance-claims', requirePermission('insurance', 'view'), (req,res)=>{
  const db=loadDB();
  let c=db.insuranceClaims||[];
  if(req.query.status) c=c.filter(x=>x.status===req.query.status);
  if(req.query.company) c=c.filter(x=>x.company===req.query.company);
  res.json(c.sort((a,b)=>b.claimDate.localeCompare(a.claimDate)));
});

// P0.11 (saveDB call-site audit): converted to durable-before-ack.
app.post('/api/insurance-claims', requirePermission('insurance', 'add'), async (req,res,next)=>{
 try {
  const db=loadDB();
  const {company,claimDate,amount,period,notes} = req.body;
  if(!company||!claimDate||!amount) return res.status(400).json({error:'missing fields'});

  // P0.12 (closes P6-097). Claimed BEFORE claimNo is derived so a retry
  // never even consumes a second sequential claim number.
  const isMongo = !isFileFallbackMode();
  const idemKey = extractIdempotencyKey(req);
  let idemRecord = null;
  if (idemKey) {
    const v = validateIdempotencyKey(idemKey);
    if (!v.ok) return res.status(400).json({ error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
    const fingerprint = computeFingerprint('insurance-claim:create', { company, claimDate, amount: parseFloat(amount)||0, period, notes });
    const claimResult = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'insurance-claim:create', idemKey, fingerprint);
    if (!claimResult.claimed && claimResult.record.status === 'COMPLETED') {
      return res.json({ success: true, idempotentReplay: true, claim: claimResult.record.resultReference });
    }
    idemRecord = claimResult.record;
  }

  const all=db.insuranceClaims||[];
  const nums=all.map(c=>parseInt((c.claimNo||'0').replace(/\D/g,''))||0);
  const claimNo='IC-'+String(nums.length?Math.max(...nums)+1:1).padStart(4,'0');

  const claim={
    id:'CLM-'+Date.now(), claimNo,
    company, claimDate, amount:parseFloat(amount)||0,
    period:period||'', status:'pending',
    notes:notes||'', createdAt:new Date().toISOString(),
    journalId:'JE-'+claimNo, receiptJournalId:null, cancellation:null,
  };

  // Journal: debit insurance receivable, credit insurance revenue.
  // P0.2: validated (and, on failure, thrown) BEFORE the claim record is
  // pushed — an invalid/locked-period entry must leave db untouched.
  // P0.9 — P6-072: was '1120' ("K-Net / Visa / Master — مستحقات" in
  // DEFAULT_COA — card settlement, unrelated) and '4200' ("إيرادات أخرى" —
  // generic other revenue, unrelated). The correct accounts already exist
  // and are already used correctly elsewhere in this same codebase
  // (updateCommissions()'s insurance-deduction entry uses 1130; the daily-
  // income auto-journal uses 1130/4150 for the exact same insurance
  // concept) — this route was the odd one out, not a case of no correct
  // account existing yet.
  const accounts=db.chartOfAccounts||[];
  const insRecAcc=accounts.find(a=>a.code==='1130')||{id:'1130',code:'1130',name:'ذمم مدينة — شركات التأمين'};
  const insRevAcc=accounts.find(a=>a.code==='4150')||{id:'4150',code:'4150',name:'إيرادات تأمين — إجمالي'};
  try {
    appendJournalEntry(db, {
      id:'JE-'+claimNo, date:claimDate,
      desc:`مطالبة تأمين ${claimNo} — ${company}`,
      ref:claimNo, type:'insurance',
      totalDebit:claim.amount, totalCredit:claim.amount,
      createdAt:new Date().toISOString(),
      lines:[
        {accountId:insRecAcc.id,accountCode:insRecAcc.code,accountName:insRecAcc.name,debit:claim.amount,credit:0},
        {accountId:insRevAcc.id,accountCode:insRevAcc.code,accountName:insRevAcc.name,debit:0,credit:claim.amount}
      ]
    });
  } catch (mutErr) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    throw mutErr;
  }

  if(!db.insuranceClaims) db.insuranceClaims=[];
  db.insuranceClaims.push(claim);
  appendAuditEvent(db, { req, action: 'insurance_claim.created', resourceType: 'insuranceClaim', resourceId: claim.id, after: { claimNo: claim.claimNo, company: claim.company, amount: claim.amount } });
  if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, claim, claim.id, 'JE-'+claimNo);
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for insurance_claim.created:', e.message);
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ المطالبة بشكل دائم — حاول مرة أخرى' });
  }
  if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
  res.json({success:true,claim});
 } catch (err) {
  if (err instanceof JournalValidationError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  next(err);
 }
});

// P0.11 (saveDB call-site audit): converted to durable-before-ack.
app.put('/api/insurance-claims/:id', requirePermission('insurance', 'edit'), async (req,res,next)=>{
  // P0.12 — declared OUTSIDE the try block so the outer catch below (which
  // must release an in-flight claim on ANY failure, including a rejected
  // journal validation) can actually see them.
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
 try {
  const db=loadDB();
  const claim=(db.insuranceClaims||[]).find(c=>String(c.id)===String(req.params.id));
  if(!claim) return res.status(404).json({error:'not found'});

  const {status,receivedDate,receivedAmount} = req.body;
  const beforeClaim = { status: claim.status, receivedDate: claim.receivedDate, receivedAmount: claim.receivedAmount };

  // P0.12 (closes P6-097 — no guard here prevented a retry from posting a
  // SECOND 'استلام تأمين' JE for the same claim; this is the exact scenario
  // the adversarial review flagged as a clean P6-097 exemplar).
  const idemKey = extractIdempotencyKey(req);
  if (idemKey) {
    const v = validateIdempotencyKey(idemKey);
    if (!v.ok) return res.status(400).json({ error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
    const fingerprint = computeFingerprint('insurance-claim:update', { id: req.params.id, status, receivedDate, receivedAmount, payAccount: req.body.payAccount });
    const claimResult = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'insurance-claim:update', idemKey, fingerprint);
    if (!claimResult.claimed && claimResult.record.status === 'COMPLETED') {
      return res.json({ success: true, idempotentReplay: true, claim: claimResult.record.resultReference });
    }
    idemRecord = claimResult.record;
  }

  // P0.3 — Pattern A: build + validate the "received" journal entry BEFORE
  // any field on `claim` is mutated (Atomicity Test A). The claim's own
  // fields (status/receivedDate/receivedAmount) must stay exactly as they
  // were if the posting is rejected (e.g. a locked period).
  let je = null;
  if(status==='received' && receivedAmount){
    const accounts=db.chartOfAccounts||[];
    // payAccount: 'bank' (default for insurance — usually wire transfer) or 'cash'
    const useBank = (req.body.payAccount||'bank') !== 'cash';
    const recvAcc = useBank
      ? (accounts.find(a=>a.code==='1110')||{id:'1110',code:'1110',name:'البنك'})
      : (accounts.find(a=>a.code==='1100')||{id:'1100',code:'1100',name:'الصندوق'});
    // P0.9 — P6-072: was '1120' (card settlement, unrelated) — see the
    // creation route's comment above for the full cross-codebase evidence.
    const insRecAcc=accounts.find(a=>a.code==='1130')||{id:'1130',code:'1130',name:'ذمم مدينة — شركات التأمين'};
    const amt        = parseFloat(receivedAmount)||0;
    const claimedAmt = parseFloat(claim.amount)||0;

    const jeLines=[
      {accountId:recvAcc.id,  accountCode:recvAcc.code, accountName:recvAcc.name,  debit:amt,        credit:0},
      {accountId:insRecAcc.id,accountCode:insRecAcc.code, accountName:insRecAcc.name, debit:0,          credit:claimedAmt}
    ];
    // If received less than claimed — write off the shortfall to a doubtful-
    // debt expense. P0.9 — P6-072: was '5700', which DEFAULT_COA actually
    // names "مصاريف إدارية عمومية" (general admin expense), not doubtful
    // debts — validateJournalEntry's Invariant E only checks the code
    // exists, not its name, so this silently posted to the wrong account.
    // R3 (adversarial review, found alongside P6-065): the "dedicated"
    // replacement account '5720' was ITSELF a collision — DEFAULT_COA
    // (lib/defaults.js) already defines 5720 = "إقامات وتأشيرات" (staff
    // residency/visa fees, actively used via catMap at server.js:3113) —
    // ensureAccount() only creates an account if the code doesn't already
    // exist, so every insurance shortfall silently posted to that unrelated
    // category instead. Same bug class as the 5710→5920 fix in R2. Moved to
    // a genuinely free code, '5930', distinct from both 5720 (residency
    // fees) and 5920 (patient bad-debt write-off, P0.8/R2) — insurance
    // claim shortfall, patient bad debt, and residency fees are three
    // different economic events and must stay separately traceable.
    const shortfall = parseFloat((claimedAmt - amt).toFixed(3));
    if(shortfall > 0.001){
      const bdAcc = ensureAccount(db, '5930', 'ديون مشكوك في تحصيلها — تأمين', 'expense', '5900');
      jeLines.push({accountId:bdAcc.id,accountCode:bdAcc.code,accountName:bdAcc.name,debit:shortfall,credit:0});
    }
    const totalDr = jeLines.reduce((s,l)=>s+(l.debit||0),0);
    const totalCr = jeLines.reduce((s,l)=>s+(l.credit||0),0);

    je = {
      id:'JE-CLM-RCV-'+Date.now(), date:receivedDate||new Date().toISOString().slice(0,10),
      desc:`استلام تأمين ${claim.claimNo} — ${claim.company}${shortfall>0.001?' (فرق مشطوب: '+shortfall.toFixed(3)+')':''}`,
      ref:claim.claimNo+'-RCV', type:'insurance_received',
      totalDebit:parseFloat(totalDr.toFixed(3)), totalCredit:parseFloat(totalCr.toFixed(3)),
      createdAt:new Date().toISOString(),
      lines:jeLines
    };
    const result = validateJournalEntry(db, je);
    if (!result.ok) throw new JournalValidationError(result.error, result.status, result.code);
  }

  claim.status=status||claim.status;
  if(receivedDate) claim.receivedDate=receivedDate;
  if(receivedAmount!=null) claim.receivedAmount=parseFloat(receivedAmount)||0;
  if (je) { db.journalEntries.push(je); claim.receiptJournalId = je.id; }

  appendAuditEvent(db, { req, action: 'insurance_claim.updated', resourceType: 'insuranceClaim', resourceId: claim.id, before: beforeClaim, after: { status: claim.status, receivedDate: claim.receivedDate, receivedAmount: claim.receivedAmount } });
  if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, claim, claim.id, je ? je.id : null);
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for insurance_claim.updated:', e.message);
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التعديل بشكل دائم — حاول مرة أخرى' });
  }
  if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
  res.json({success:true,claim});
 } catch (err) {
  if (idemRecord) { try { await releaseIdempotencyClaim(loadDB(), isMongo, idemRecord); } catch (_) {} }
  if (err instanceof JournalValidationError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  next(err);
 }
});

// R3 — P6-065 fix: this route used to physically splice the claim out of
// db.insuranceClaims[] while never touching db.journalEntries[], orphaning
// its recognition JE (and receipt JE, if received) forever. The recognition
// JE is posted unconditionally at claim creation (see POST above), so every
// claim that exists has already-posted financial history — there is no
// "unposted claim" state in this domain. The route now performs the same
// safe, non-destructive cancellation used for vendor-bills/patient-
// receivables (server.js:5789, 6398): post an explicit reversal journal for
// every JE the claim ever posted, never delete a journal entry, never
// remove the claim record itself. The endpoint URL/method/response shape is
// UNCHANGED so the existing frontend button (public/index.html:10913-10915,
// deleteClaim()) works without any UI change.
app.delete('/api/insurance-claims/:id', requirePermission('insurance', 'delete'), async (req,res,next)=>{
 try {
  const db=loadDB();
  const claim=(db.insuranceClaims||[]).find(c=>String(c.id)===String(req.params.id));
  if (!claim) return res.status(404).json({ success:false, error:'المطالبة غير موجودة' });
  if (claim.status === 'cancelled') return res.status(409).json({ success:false, error:'المطالبة مُلغاة بالفعل', code:'ALREADY_CANCELLED' });

  // P0.6A's guard referenced the nonexistent field `claim.date` (the real
  // field is `claimDate`) so it was always a silent no-op — fixed here.
  const reverseDate = new Date().toISOString().slice(0,10);
  assertFinancialPeriodOpen(db, [claim.claimDate, claim.receivedDate, reverseDate]);

  const coa = db.chartOfAccounts || [];
  const reversalJournalIds = [];

  const recognitionJe = (db.journalEntries||[]).find(j => j.id === (claim.journalId || ('JE-'+claim.claimNo)));
  if (recognitionJe && !(db.journalEntries||[]).some(j => j.ref === 'REV-'+recognitionJe.id)) {
    const revJe = {
      id: 'JE-REV-'+recognitionJe.id, date: reverseDate,
      desc: `عكس مطالبة تأمين ${claim.claimNo} — ${claim.company}`,
      ref: 'REV-'+recognitionJe.id, reference: 'REV-'+recognitionJe.id, type: 'insurance-claim-reversal',
      source: 'insurance-claim', sourceId: claim.id, sourceModule: 'insurance',
      totalDebit: recognitionJe.totalDebit, totalCredit: recognitionJe.totalCredit,
      createdAt: new Date().toISOString(),
      lines: (recognitionJe.lines||[]).map(l => ({ accountId:l.accountId, accountCode:l.accountCode, accountName:l.accountName, debit:l.credit||0, credit:l.debit||0 })),
    };
    appendJournalEntry(db, revJe);
    reversalJournalIds.push(revJe.id);
  }

  if (claim.receiptJournalId) {
    const receiptJe = (db.journalEntries||[]).find(j => j.id === claim.receiptJournalId);
    if (receiptJe && !(db.journalEntries||[]).some(j => j.ref === 'REV-'+receiptJe.id)) {
      const revJe2 = {
        id: 'JE-REV-'+receiptJe.id, date: reverseDate,
        desc: `عكس استلام مطالبة تأمين ${claim.claimNo} — ${claim.company}`,
        ref: 'REV-'+receiptJe.id, reference: 'REV-'+receiptJe.id, type: 'insurance-claim-receipt-reversal',
        source: 'insurance-claim', sourceId: claim.id, sourceModule: 'insurance',
        totalDebit: receiptJe.totalDebit, totalCredit: receiptJe.totalCredit,
        createdAt: new Date().toISOString(),
        lines: (receiptJe.lines||[]).map(l => ({ accountId:l.accountId, accountCode:l.accountCode, accountName:l.accountName, debit:l.credit||0, credit:l.debit||0 })),
      };
      appendJournalEntry(db, revJe2);
      reversalJournalIds.push(revJe2.id);
    }
  }

  const before = { status: claim.status, journalId: claim.journalId, receiptJournalId: claim.receiptJournalId };
  claim.status = 'cancelled';
  claim.cancellation = { reversalJournalIds, date: reverseDate, reason: (req.body && req.body.reason) || '' };
  claim.updatedAt = new Date().toISOString();

  appendAuditEvent(db, { req, action: 'insurance_claim.cancelled', resourceType: 'insuranceClaim', resourceId: claim.id, before, after: { status: claim.status, reversalJournalIds } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for insurance_claim.cancelled:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ الإلغاء بشكل دائم — حاول مرة أخرى' });
  }
  res.json({success:true, claim, reversalJournalIds});
 } catch (err) {
  if (err instanceof JournalValidationError) return res.status(err.status).json({ success:false, error: err.message, code: err.code });
  next(err);
 }
});

// ═══════════════════════════════════════════════════
// PAYROLL — كشف الرواتب
// ═══════════════════════════════════════════════════
app.get('/api/payroll', requirePermission('payroll', 'view'), (req,res)=>{
  const db=loadDB();
  let p=db.payroll||[];
  if(req.query.month) p=p.filter(x=>x.month===req.query.month);
  res.json(p.sort((a,b)=>b.month.localeCompare(a.month)));
});

// ── Payroll helpers — كل شيء مربوط بالقيود (استحقاق + دفع + استرداد إذن عمل) ──
const r3 = n => parseFloat((Number(n)||0).toFixed(3));

function buildPayrollRecord(body, existing) {
  const entries = (body.entries||[]).map(e => ({
    name: e.name||'', role: e.role||'', accountCode: e.accountCode || '',
    basicSalary: parseFloat(e.basicSalary)||0,
    allowances:  parseFloat(e.allowances)||0,
    deductions:  parseFloat(e.deductions)||0,
    recovery:    parseFloat(e.recovery)||0, // استرداد الموظف (راتب إذن العمل)
    netSalary:   (parseFloat(e.basicSalary)||0)+(parseFloat(e.allowances)||0)-(parseFloat(e.deductions)||0)
  }));
  const totalGross      = r3(entries.reduce((s,e)=>s+e.basicSalary+e.allowances,0));
  const totalDeductions = r3(entries.reduce((s,e)=>s+e.deductions,0));
  const totalRecovery   = r3(entries.reduce((s,e)=>s+e.recovery,0));
  return { ...(existing||{}), month: body.month, entries,
    totalGross, totalDeductions, totalRecovery, totalNet: r3(totalGross-totalDeductions) };
}

// مصروف كل موظف على حسابه المختار (أو طبي/إداري حسب الدور إن لم يُختر)
function payrollExpenseAccFor(accounts, pa, e, findAcc) {
  let acc = e.accountCode ? findAcc(e.accountCode) : null;
  if (!acc) acc = /طبيب|دكتور|طبي/.test(String(e.role||'')) ? pa.expMedical : pa.expAdmin;
  return acc;
}

function buildPayrollAccrual(db, rec) {
  const accounts = db.chartOfAccounts||[];
  const { payrollAccounts } = require('./lib/coaCodes');
  const pa = payrollAccounts(accounts);
  db.chartOfAccounts = accounts;
  const findAcc = c => accounts.find(a => String(a.code)===String(c) || String(a.id)===String(c));
  const byAcc = {};
  (rec.entries||[]).forEach(e => {
    const gross = (e.basicSalary||0)+(e.allowances||0);
    if (gross<=0) return;
    const acc = payrollExpenseAccFor(accounts, pa, e, findAcc);
    byAcc[acc.code] = byAcc[acc.code] || { acc, amount:0 };
    byAcc[acc.code].amount += gross;
  });
  const lines = Object.values(byAcc).map(x => ({accountId:x.acc.id,accountCode:x.acc.code,accountName:x.acc.name,debit:r3(x.amount),credit:0}));
  lines.push({accountId:pa.payable.id,accountCode:pa.payable.code,accountName:pa.payable.name,debit:0,credit:rec.totalNet});
  if(rec.totalDeductions>0) lines.push({accountId:pa.deductions.id,accountCode:pa.deductions.code,accountName:pa.deductions.name,debit:0,credit:rec.totalDeductions});
  return { id:rec.accrualJeId, date:`${rec.month}-01`,
    desc:`استحقاق رواتب شهر ${rec.month}`, description:`استحقاق رواتب شهر ${rec.month}`,
    ref:'PAY-ACC-'+rec.month, reference:'PAY-ACC-'+rec.month, type:'payroll',
    // R4 (Part C): payroll JEs had no source tag at all — the frontend's
    // new journal-traceability display (public/index.html) needs it to
    // offer a "go to source" link back to the payroll tab.
    source:'payroll', sourceId:rec.id, sourceModule:'payroll',
    totalDebit:rec.totalGross, totalCredit:rec.totalGross, createdAt:new Date().toISOString(), lines };
}

function buildPayrollPayment(db, rec) {
  const accs = db.chartOfAccounts||[];
  const { payrollAccounts } = require('./lib/coaCodes');
  const pa = payrollAccounts(accs);
  db.chartOfAccounts = accs;
  const findAcc = c => accs.find(a => String(a.id)===String(c)||String(a.code)===String(c));
  let payAcc = rec.payAccount ? findAcc(rec.payAccount) : null;
  if(!payAcc){ const credit = payMethodToAccount(rec.payMethod||'cash'); payAcc = accs.find(a=>a.code===credit.code)||{id:credit.code,code:credit.code,name:credit.name}; }
  const net = rec.totalNet || rec.totalGross || 0;
  const checkTag = rec.checkNo ? ` — شيك #${rec.checkNo}` : '';
  const jes = [{ id:rec.paymentJeId, date:rec.paidDate,
    desc:`دفع رواتب شهر ${rec.month}${checkTag}`, description:`دفع رواتب شهر ${rec.month}${checkTag}`,
    ref:'PAY-PMT-'+rec.month, reference:'PAY-PMT-'+rec.month, type:'payroll_payment',
    source:'payroll', sourceId:rec.id, sourceModule:'payroll',
    totalDebit:net, totalCredit:net, createdAt:new Date().toISOString(),
    lines:[ {accountId:pa.payable.id,accountCode:pa.payable.code,accountName:pa.payable.name,debit:net,credit:0},
            {accountId:payAcc.id,accountCode:payAcc.code,accountName:payAcc.name,debit:0,credit:net} ] }];
  // استرداد الموظفين (راتب إذن العمل): نقد وارد يخفّض مصروف الرواتب → صافي التكلفة الحقيقية
  const recovByAcc = {};
  (rec.entries||[]).forEach(e => {
    const rv = e.recovery||0; if(rv<=0) return;
    const acc = payrollExpenseAccFor(accs, pa, e, findAcc);
    recovByAcc[acc.code] = recovByAcc[acc.code] || { acc, amount:0 };
    recovByAcc[acc.code].amount += rv;
  });
  const totalRecovery = r3(Object.values(recovByAcc).reduce((s,x)=>s+x.amount,0));
  if(totalRecovery>0){
    const rlines=[{accountId:payAcc.id,accountCode:payAcc.code,accountName:payAcc.name,debit:totalRecovery,credit:0}];
    Object.values(recovByAcc).forEach(x=>rlines.push({accountId:x.acc.id,accountCode:x.acc.code,accountName:x.acc.name,debit:0,credit:r3(x.amount)}));
    jes.push({ id:rec.recoveryJeId, date:rec.paidDate,
      desc:`استرداد رواتب (إذن عمل) شهر ${rec.month}`, description:`استرداد رواتب شهر ${rec.month}`,
      ref:'PAY-REC-'+rec.month, reference:'PAY-REC-'+rec.month, type:'payroll_recovery',
      source:'payroll', sourceId:rec.id, sourceModule:'payroll',
      totalDebit:totalRecovery, totalCredit:totalRecovery, createdAt:new Date().toISOString(), lines:rlines });
  }
  return jes;
}

function removePayrollJEs(db, rec) {
  // P0.6A — Step 4 (P6-012): shared by both the PUT (edit, rebuild) and
  // DELETE payroll routes — reject before removing anything if the
  // record's own period is locked, instead of silently altering a closed
  // period's payroll liability/expense postings.
  assertFinancialPeriodOpen(db, [rec.month ? rec.month + '-01' : null]);
  const ids = [rec.accrualJeId, rec.paymentJeId, rec.recoveryJeId].filter(Boolean);
  const refs = ['PAY-ACC-'+rec.month,'PAY-PMT-'+rec.month,'PAY-REC-'+rec.month];
  db.journalEntries = (db.journalEntries||[]).filter(j =>
    !ids.includes(j.id) && !(['payroll','payroll_payment','payroll_recovery'].includes(j.type) && refs.includes(j.ref)));
}

app.post('/api/payroll', requirePermission('payroll', 'add'), async (req,res,next)=>{
  try {
    const db=loadDB();
    const {month, entries} = req.body;
    if(!month||!entries||!entries.length) return res.status(400).json({error:'missing fields'});

    // R3 — P6-036 fix: idempotency-key protection (below) is opt-in and
    // per-request — a retry with no key, or with a DIFFERENT key, was never
    // blocked, so the same payroll period could be posted twice, doubling
    // the payroll liability. Domain-level uniqueness, independent of any
    // key, mirroring depreciateActiveAssets()'s `DEP-<period>` ref guard.
    const payrollRef = 'PAY-ACC-' + month;
    if ((db.journalEntries||[]).some(j => j.ref === payrollRef)) {
      return res.status(409).json({ success:false, error: `تم استحقاق رواتب شهر ${month} بالفعل`, code: 'DUPLICATE_PAYROLL' });
    }

    // P0.12 (closes P6-097 — no check for an existing payroll record for the
    // same month before creating a new one).
    const isMongo = !isFileFallbackMode();
    const idemKey = extractIdempotencyKey(req);
    let idemRecord = null;
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const fingerprint = computeFingerprint('payroll:create', { month, entries });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'payroll:create', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, record: claim.record.resultReference });
      }
      idemRecord = claim.record;
    }

    const rec = buildPayrollRecord(req.body);
    rec.id='PAY-'+Date.now(); rec.status='pending'; rec.createdAt=new Date().toISOString();
    rec.accrualJeId='JE-PAY-'+Date.now();
    if(!db.payroll) db.payroll=[];
    try {
      appendJournalEntry(db, buildPayrollAccrual(db, rec));
    } catch (mutErr) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      throw mutErr;
    }
    db.payroll.push(rec);
    appendAuditEvent(db, { req, action: 'payroll.created', resourceType: 'payroll', resourceId: rec.id, after: { month: rec.month, totalNet: rec.totalNet } });
    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, rec, rec.id, rec.accrualJeId);
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for payroll.created:', e.message);
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ كشف الرواتب بشكل دائم — حاول مرة أخرى' });
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({success:true,record:rec});
  } catch (err) {
    next(err);
  }
});

// تعديل كشف رواتب — يحذف قيوده القديمة ويعيد إنشاءها (استحقاق + دفع إن كان مدفوعاً)
// P0.11 (saveDB call-site audit): converted to durable-before-ack.
app.put('/api/payroll/:id', requirePermission('payroll', 'edit'), async (req,res,next)=>{
 try {
  const db=loadDB();
  const idx=(db.payroll||[]).findIndex(p=>String(p.id)===String(req.params.id));
  if(idx<0) return res.status(404).json({error:'not found'});
  const old=db.payroll[idx];
  if(!req.body.month||!req.body.entries||!req.body.entries.length) return res.status(400).json({error:'missing fields'});

  // P0.3 — Pattern C (prepare then commit): build and validate every
  // candidate journal entry BEFORE removing the old ones or replacing the
  // payroll record. Previously removePayrollJEs() ran first, so a rejected
  // re-post (locked period, phantom account) left the payroll record
  // pointing at accrual/payment journal ids that no longer existed
  // (Atomicity Test B).
  const rec=buildPayrollRecord(req.body,{ id:old.id, createdAt:old.createdAt, status:old.status, payAccount:old.payAccount, paidDate:old.paidDate, payMethod:old.payMethod });
  rec.accrualJeId='JE-PAY-'+Date.now();
  const accrualJe = buildPayrollAccrual(db, rec);
  let result = validateJournalEntry(db, accrualJe);
  if (!result.ok) throw new JournalValidationError(result.error, result.status, result.code);

  let paymentJes = [];
  if(rec.status==='paid'){
    rec.paymentJeId='JE-PAY-PMT-'+Date.now();
    rec.recoveryJeId='JE-PAY-REC-'+Date.now();
    paymentJes = buildPayrollPayment(db, rec);
    for (const je of paymentJes) {
      result = validateJournalEntry(db, je);
      if (!result.ok) throw new JournalValidationError(result.error, result.status, result.code);
    }
  }

  // All candidates validated — commit everything together.
  removePayrollJEs(db, old);
  db.journalEntries.push(accrualJe);
  paymentJes.forEach(je => db.journalEntries.push(je));
  db.payroll[idx]=rec;
  appendAuditEvent(db, { req, action: 'payroll.updated', resourceType: 'payroll', resourceId: rec.id, before: { totalNet: old.totalNet }, after: { totalNet: rec.totalNet } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for payroll.updated:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التعديل بشكل دائم — حاول مرة أخرى' });
  }
  res.json({success:true,record:rec});
 } catch (err) {
  if (err instanceof JournalValidationError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  next(err);
 }
});

// P0.5A: this is the actual "payroll payment" mutation — status→'paid'
// posts the real cash-movement journal entry. Converted to durable save.
app.put('/api/payroll/:id/status', requirePermission('payroll', 'edit'), async (req,res,next)=>{
  try {
  const db=loadDB();
  const rec=(db.payroll||[]).find(p=>String(p.id)===String(req.params.id));
  if(!rec) return res.status(404).json({error:'not found'});
  const prevStatus = rec.status;

  // P0.3 — Pattern B (snapshot + rollback): buildPayrollPayment() genuinely
  // needs the updated payAccount/payMethod/paidDate on `rec` to compute the
  // payment entry, so a brief in-place mutation is unavoidable here. Snapshot
  // exactly the fields this route can touch and restore them if the payment
  // journal is rejected (Atomicity Test B) — the record must come back out
  // status/flags-unchanged, not "paid" with no journal to back it up.
  const snapshot = {
    status: rec.status, paidDate: rec.paidDate, payAccount: rec.payAccount,
    payMethod: rec.payMethod, checkNo: rec.checkNo,
    paymentJeId: rec.paymentJeId, recoveryJeId: rec.recoveryJeId,
  };

  rec.status   = req.body.status   || 'paid';
  rec.paidDate = req.body.paidDate || new Date().toISOString().slice(0,10);
  if(req.body.payAccount) rec.payAccount = String(req.body.payAccount);
  if(req.body.payMethod)  rec.payMethod  = req.body.payMethod;
  rec.checkNo = req.body.checkNo || '';

  // عند وضع «مدفوع»: قيد الدفع (رواتب مستحقة → نقد) + قيد استرداد إذن العمل إن وُجد
  if(rec.status==='paid' && prevStatus!=='paid'){
    rec.paymentJeId='JE-PAY-PMT-'+Date.now();
    rec.recoveryJeId='JE-PAY-REC-'+Date.now();
    const jes = buildPayrollPayment(db, rec);
    for (const je of jes) {
      const result = validateJournalEntry(db, je);
      if (!result.ok) {
        Object.assign(rec, snapshot); // rollback — leave rec exactly as it was
        throw new JournalValidationError(result.error, result.status, result.code);
      }
    }
    jes.forEach(je => db.journalEntries.push(je));
  }
  appendAuditEvent(db, { req, action: 'payroll.status_changed', resourceType: 'payroll', resourceId: rec.id, before: { status: prevStatus }, after: { status: rec.status } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for payroll.status_changed:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ حالة الدفع بشكل دائم — حاول مرة أخرى' });
  }
  res.json({success:true,rec});
  } catch (err) {
    next(err);
  }
});

// P0.11 (saveDB call-site audit): converted to durable-before-ack.
app.delete('/api/payroll/:id', requirePermission('payroll', 'delete'), async (req,res,next)=>{
 try {
  const db=loadDB();
  const rec=(db.payroll||[]).find(p=>String(p.id)===String(req.params.id));
  if(rec) removePayrollJEs(db, rec); // احذف قيوده (استحقاق + دفع + استرداد)
  db.payroll=(db.payroll||[]).filter(p=>String(p.id)!==String(req.params.id));
  if(rec) appendAuditEvent(db, { req, action: 'payroll.deleted', resourceType: 'payroll', resourceId: rec.id, before: { month: rec.month, totalNet: rec.totalNet } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for payroll.deleted:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ الحذف بشكل دائم — حاول مرة أخرى' });
  }
  res.json({success:true});
 } catch (err) {
  next(err);
 }
});

// Employees CRUD
app.get('/api/employees', requirePermission('payroll', 'view'), (req,res)=>{
  const db=loadDB();
  res.json(db.employees||[]);
});

// P0.11 (saveDB call-site audit): converted to durable-before-ack.
app.post('/api/employees', requirePermission('payroll', 'add'), async (req,res,next)=>{
 try {
  const db=loadDB();
  if(!db.employees) db.employees=[];
  const { id, ...rest } = req.body;
  let emp, isNew = true;
  const idx = id ? db.employees.findIndex(e => e.id === id) : -1;
  // R5 (staging validation, adversarial review — P1, live-reproduced): an
  // empty {} body silently created a permanent employee record with no
  // fields at all (`{id:'EMP-...', createdAt:...}`, no name), unlike sibling
  // create routes (patients/doctors/insurance-claims) which all correctly
  // reject a nameless record. Only enforced on genuine CREATE (no existing
  // record matched) — an update of an existing employee's other fields
  // (e.g. basicSalary only) must not be forced to re-send name every time.
  if (idx < 0 && (!rest.name || !String(rest.name).trim())) {
    return res.status(400).json({ success: false, error: 'اسم الموظف مطلوب' });
  }
  if (id) {
    if (idx >= 0) { isNew = false; db.employees[idx] = { ...db.employees[idx], ...rest, id, updatedAt: new Date().toISOString() }; emp = db.employees[idx]; }
    else { emp = { id, ...rest, createdAt: new Date().toISOString() }; db.employees.push(emp); }
  } else {
    emp = { id: 'EMP-' + Date.now(), ...rest, createdAt: new Date().toISOString() };
    db.employees.push(emp);
  }
  appendAuditEvent(db, { req, action: isNew ? 'employee.created' : 'employee.updated', resourceType: 'employee', resourceId: emp.id, after: { name: emp.name } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for employee.created/updated:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ الموظف بشكل دائم — حاول مرة أخرى' });
  }
  res.json({success:true});
 } catch (err) {
  next(err);
 }
});

// P0.10 (P6-074): previously deleted the employee record unconditionally —
// no check at all against db.payroll[], producing orphaned payroll records.
// Forensic finding while implementing this: db.payroll[].entries[] links to
// an employee by free-text `name` ONLY (buildPayrollRecord, server.js —
// `entries: (body.entries||[]).map(e => ({ name: e.name||'', ... }))`) —
// there is NO employeeId/empId field anywhere in the payroll domain to key
// off, unlike vendorBills.vendorId (P6-073's fix). A name match is
// inherently unreliable both ways (renamed employee → false negative;
// two employees sharing a name → false positive), so a hard 409 block on it
// would be a control that LOOKS precise but isn't — worse than no block.
// Per this milestone's explicit guidance ("prefer deactivate over delete"
// when a hard block isn't safe/reliable): a name match found → soft-delete
// (status:'inactive', kept in db.employees[] so payroll history still
// resolves a name to a real record) instead of physical removal; no match
// found → unchanged pre-existing hard-delete behavior (no risk identified).
app.delete('/api/employees/:id', requirePermission('payroll', 'delete'), async (req, res, next) => {
  try {
  const db=loadDB();
  const emp=(db.employees||[]).find(e=>String(e.id)===String(req.params.id));
  if (!emp) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
  const empName = String(emp.name || '').trim();
  const hasPayrollHistory = empName && (db.payroll || []).some(rec =>
    (rec.entries || []).some(e => String(e.name || '').trim() === empName));

  if (hasPayrollHistory) {
    emp.status = 'inactive';
    emp.deactivatedAt = new Date().toISOString();
    appendAuditEvent(db, { req, action: 'employee.deactivated', resourceType: 'employee', resourceId: emp.id, before: { status: 'active' }, after: { status: 'inactive', reason: 'PAYROLL_HISTORY_NAME_MATCH' } });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for employee.deactivated:', e.message);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ التعطيل بشكل دائم — حاول مرة أخرى' });
    }
    return res.json({ success: true, deactivated: true, message: 'للموظف سجلات رواتب سابقة — تم تعطيله بدلاً من حذفه للحفاظ على سلامة سجل الرواتب التاريخي' });
  }

  db.employees=(db.employees||[]).filter(e=>String(e.id)!==String(req.params.id));
  appendAuditEvent(db, { req, action: 'employee.deleted', resourceType: 'employee', resourceId: emp.id, before: { name: emp.name } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for employee.deleted:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ الحذف بشكل دائم — حاول مرة أخرى' });
  }
  res.json({success:true, deactivated:false});
  } catch (err) {
    next(err);
  }
});

// ─── FIXED ASSETS ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// P0.10 — Fixed Assets control closure (Parts A-E)
// ═══════════════════════════════════════════════════════════════════════
// Part A forensic finding: a real financial event links to a specific
// asset in exactly two ways — its own purchase journal (ref === 'AST-'+id)
// and its own accumulatedDep tally (a combined depreciation JE's lines
// carry no clean per-asset key of their own, only a display name). Using
// accumulatedDep>0 as the depreciation-history signal avoids fragile
// string-matching into a shared multi-asset journal entry.
function assetHasHistory(db, asset) {
  const hasPurchaseJE = (db.journalEntries || []).some(j => j.ref === 'AST-' + asset.id);
  const hasDepreciation = (parseFloat(asset.accumulatedDep) || 0) > 0.001;
  return hasPurchaseJE || hasDepreciation;
}

// Part C/Step 9: validates a proposed asset account code (coaAccount /
// accDepAccount / depExpAccount) exists, is not a group/header account, and
// matches the expected fundamental type — same P0.9 COA-compliance
// discipline applied to every other configurable system account.
function validateAssetAccountField(db, code, expectedType, label) {
  if (!code) return null;
  const acc = (db.chartOfAccounts || []).find(a => String(a.code) === String(code));
  if (!acc) { const e = new Error(`حساب ${label} (${code}) غير موجود في شجرة الحسابات`); e.status = 400; e.code = 'UNKNOWN_ACCOUNT'; throw e; }
  if (acc.isGroup) { const e = new Error(`حساب ${label} (${code} — ${acc.name}) حساب تجميعي — لا يصلح للترحيل المباشر`); e.status = 400; e.code = 'GROUP_ACCOUNT_POSTING'; throw e; }
  if (acc.type !== expectedType) { const e = new Error(`حساب ${label} (${code} — ${acc.name}) نوعه ${acc.type}، والمتوقع ${expectedType}`); e.status = 400; e.code = 'INCOMPATIBLE_ACCOUNT_TYPE'; throw e; }
  return acc;
}

// Part B/Steps 3-4 (P6-045): the ONE canonical depreciation calculation +
// posting function. Previously duplicated between this route and
// /api/close/run-all's own inline STEP 1 loop, with three real
// divergences now eliminated at the source: (a) per-asset rounding — the
// old manual route only rounded the aggregate JE total, letting
// unrounded floating-point drift accumulate into asset.accumulatedDep on
// repeated runs; (b) journal-line key — the old manual route built lines
// with `account:` instead of the standard `accountCode:` (a P6-001-class
// bug, silently reliant on other readers' three-way fallback rather than
// being correct at the source); (c) idempotency — only the close/run-all
// copy checked a deterministic ref before posting. Both callers now share
// this one implementation, so both get all three fixes identically.
function depreciateActiveAssets(db, period) {
  const depRef = 'DEP-' + period;
  const alreadyDep = (db.journalEntries || []).some(j => j.ref === depRef);
  if (alreadyDep) return { status: 'skipped', reason: 'ALREADY_RUN', totalDep: 0, assetsCount: 0 };

  // Auto-fill missing fields on old/malformed asset records (preserved
  // from the original manual route — harmless, purely additive defaults).
  (db.fixedAssets || []).forEach(a => {
    if (!a.depExpAccount) a.depExpAccount = '5800';
    if (!a.accDepAccount) a.accDepAccount = '1590';
    if (!a.usefulLife)    a.usefulLife    = 5;
    if (a.salvageValue == null) a.salvageValue = 0;
    if (!a.status)        a.status        = 'active';
    if (a.accumulatedDep === undefined) a.accumulatedDep = 0;
  });

  // Step 16: disposed assets are already excluded — status!=='active'.
  const active = (db.fixedAssets || []).filter(a => a.status === 'active');
  if (!active.length) return { status: 'skipped', reason: 'NO_ACTIVE_ASSETS', totalDep: 0, assetsCount: 0 };

  const lines = [];
  let totalDep = 0;
  // P0.3 — Pattern C: compute pending accumulatedDep updates without
  // applying them yet; only commit after the journal entry validates.
  const pendingDep = [];
  active.forEach(asset => {
    const ann = ((parseFloat(asset.cost) || 0) - (parseFloat(asset.salvageValue) || 0)) / (parseInt(asset.usefulLife) || 5);
    const mon = ann / 12;
    const nbv = (parseFloat(asset.cost) || 0) - (parseFloat(asset.accumulatedDep) || 0);
    const sal = parseFloat(asset.salvageValue) || 0;
    if (nbv <= sal || mon <= 0) return;
    const dep = parseFloat(Math.min(mon, nbv - sal).toFixed(3));
    if (dep <= 0) return;
    pendingDep.push({ asset, newAccumulatedDep: parseFloat(((parseFloat(asset.accumulatedDep) || 0) + dep).toFixed(3)) });
    totalDep += dep;
    lines.push({ accountCode: asset.depExpAccount || '5800', accountName: 'مصروف اهتلاك — ' + asset.name, debit: dep, credit: 0 });
    lines.push({ accountCode: asset.accDepAccount || '1590', accountName: 'مجمع اهتلاك — ' + asset.name, debit: 0, credit: dep });
  });
  totalDep = parseFloat(totalDep.toFixed(3));
  if (!lines.length || totalDep <= 0) return { status: 'skipped', reason: 'NOTHING_TO_DEPRECIATE', totalDep: 0, assetsCount: 0 };

  const je = {
    id: 'JE-DEP-' + Date.now(), date: period + '-01', desc: 'قيد اهتلاك شهر ' + period,
    ref: depRef, type: 'depreciation', source: 'fixed-assets', sourceModule: 'fixed-assets',
    totalDebit: totalDep, totalCredit: totalDep, lines, createdAt: new Date().toISOString(),
  };
  appendJournalEntry(db, je); // throws JournalValidationError on locked period/imbalance/unknown account — nothing committed yet
  pendingDep.forEach(u => { u.asset.accumulatedDep = u.newAccumulatedDep; });
  return { status: 'done', journalEntry: je, totalDep, assetsCount: pendingDep.length };
}

// Part D (P6-046): the first disposal/retirement flow for this subledger —
// removes cost + accumulated depreciation, records proceeds if any,
// recognizes gain/loss. Never touches the original acquisition/
// depreciation journals — a brand-new reversal-shaped entry, same
// never-rewrite-history discipline as every other subledger in this app.
function buildAndPostAssetDisposal(db, asset, data, actorReq) {
  if (asset.status === 'disposed') { const e = new Error('الأصل مُتخلَّص منه بالفعل'); e.status = 409; e.code = 'ALREADY_DISPOSED'; throw e; }
  const proceeds = parseFloat(data.proceeds) || 0;
  if (proceeds < 0) { const e = new Error('عائد التخلص لا يمكن أن يكون سالباً'); e.status = 400; e.code = 'INVALID_PROCEEDS'; throw e; }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(data.disposalDate)) ? data.disposalDate : new Date().toISOString().slice(0, 10);

  const cost = parseFloat(asset.cost) || 0;
  const accumDep = parseFloat(asset.accumulatedDep) || 0;
  const nbv = parseFloat((cost - accumDep).toFixed(3));
  const gainLoss = parseFloat((proceeds - nbv).toFixed(3)); // positive = gain, negative = loss

  const coa = db.chartOfAccounts || [];
  const costAcc   = coa.find(a => a.code === asset.coaAccount)   || { id: asset.coaAccount,   code: asset.coaAccount,   name: 'أصول ثابتة' };
  const accDepAcc = coa.find(a => a.code === asset.accDepAccount) || { id: asset.accDepAccount, code: asset.accDepAccount, name: 'مجمع الإهلاك' };

  // P0.10 adversarial-review fix (P2 finding): KWD's smallest unit IS
  // 0.001 (1 fils) — every amount here is already rounded to 3dp, so
  // "exactly 0.001" is a real, legitimate nonzero amount, not floating-
  // point noise. The original strict `> 0.001` (and `< -0.001`) excluded
  // it, either permanently orphaning a 1-fils credit balance on 1590 (once
  // status flips to 'disposed', ALREADY_DISPOSED blocks ever clearing it
  // again) or posting a real, silently-tolerated 1-fils debit/credit
  // imbalance. Now `>= 0.001` / `<= -0.001`, matching
  // depreciateActiveAssets' own `dep <= 0` convention (which already
  // includes 0.001).
  const lines = [];
  if (accumDep >= 0.001) lines.push({ accountId: accDepAcc.id, accountCode: accDepAcc.code, accountName: accDepAcc.name, debit: accumDep, credit: 0 });
  if (proceeds >= 0.001) {
    // P0.10 adversarial-review fix (P1 finding): proceedsAccount previously
    // took a raw id/code lookup with no type check — every other asset-
    // domain account field (coaAccount/accDepAccount/depExpAccount) is
    // validated via validateAssetAccountField; proceeds is cash/bank/
    // receivable actually received, so it must resolve to a real,
    // non-group, asset-type account too.
    const payAccount = data.proceedsAccount || '1100';
    const proceedsAcc = validateAssetAccountField(db, payAccount, 'asset', 'حساب استلام العائد (proceedsAccount)');
    lines.push({ accountId: proceedsAcc.id, accountCode: proceedsAcc.code, accountName: proceedsAcc.name, debit: proceeds, credit: 0 });
  }
  if (gainLoss <= -0.001) {
    // Step 12 (zero-proceeds write-off) is just the special case proceeds=0
    // — the same loss line, sized to the full NBV.
    const lossAcc = ensureAccount(db, '5910', 'خسائر التخلص من الأصول الثابتة', 'expense', '5000');
    lines.push({ accountId: lossAcc.id, accountCode: lossAcc.code, accountName: lossAcc.name, debit: parseFloat((-gainLoss).toFixed(3)), credit: 0 });
  }
  lines.push({ accountId: costAcc.id, accountCode: costAcc.code, accountName: costAcc.name, debit: 0, credit: cost });
  if (gainLoss >= 0.001) {
    const gainAcc = ensureAccount(db, '4300', 'أرباح التخلص من الأصول الثابتة', 'revenue', '4000');
    lines.push({ accountId: gainAcc.id, accountCode: gainAcc.code, accountName: gainAcc.name, debit: 0, credit: parseFloat(gainLoss.toFixed(3)) });
  }

  const totalDr = parseFloat(lines.reduce((s, l) => s + (l.debit || 0), 0).toFixed(3));
  const totalCr = parseFloat(lines.reduce((s, l) => s + (l.credit || 0), 0).toFixed(3));
  const jeId = 'JE-DISPOSE-' + asset.id;
  const je = {
    id: jeId, date,
    desc: `التخلص من أصل — ${asset.name}${data.reason ? ' — ' + data.reason : ''}`,
    ref: 'DISPOSE-' + asset.id, reference: 'DISPOSE-' + asset.id, type: 'asset_disposal',
    source: 'fixed-assets', sourceId: asset.id, sourceModule: 'fixed-assets',
    totalDebit: totalDr, totalCredit: totalCr, createdAt: new Date().toISOString(), lines,
  };
  appendJournalEntry(db, je); // throws on locked period / imbalance / unknown account — nothing mutated yet

  asset.status = 'disposed';
  asset.disposalDate = date;
  asset.disposalReason = data.reason || '';
  asset.disposalProceeds = proceeds;
  asset.disposalGainLoss = gainLoss;
  asset.disposalJournalId = jeId;
  asset.updatedAt = new Date().toISOString();
  return je;
}

app.get('/api/assets', requireAuth, requireAdminAction('assets.view'), (req, res) => {
  const db = loadDB();
  res.json(db.fixedAssets || []);
});

app.post('/api/assets', requireAuth, requireAdminAction('assets.create'), async (req, res, next) => {
 try {
  const db = loadDB();
  if (!db.fixedAssets) db.fixedAssets = [];
  const coaAcc   = sanitize(req.body.coaAccount    || '1510', 10);
  const accDep   = sanitize(req.body.accDepAccount || '1590', 10);
  const depExp   = sanitize(req.body.depExpAccount || '5800', 10);
  const cost     = parseFloat(req.body.cost) || 0;
  const pDate    = sanitize(req.body.purchaseDate || '', 10);
  const payMeth  = sanitize(req.body.payMethod || 'cash', 20); // 'cash' | 'bank' | 'credit'

  // P0.9-style config validation: whatever accounts this asset will use
  // must exist, not be group/header accounts, and match the expected
  // fundamental type — before the asset (or its purchase journal) is built.
  validateAssetAccountField(db, coaAcc, 'asset',   'التكلفة (coaAccount)');
  validateAssetAccountField(db, accDep, 'asset',   'مجمع الإهلاك (accDepAccount)');
  validateAssetAccountField(db, depExp, 'expense', 'مصروف الإهلاك (depExpAccount)');

  // P0.12 (closes P6-097 — asset creation had no duplicate guard at all;
  // a retried request created a second asset AND a second purchase JE).
  const isMongo = !isFileFallbackMode();
  const idemKey = extractIdempotencyKey(req);
  let idemRecord = null;
  if (idemKey) {
    const v = validateIdempotencyKey(idemKey);
    if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
    const fingerprint = computeFingerprint('asset:create', { code: req.body.code || '', name: req.body.name || '', cost, purchaseDate: pDate, coaAcc, accDep, depExp, payMeth, usefulLife: req.body.usefulLife, salvageValue: req.body.salvageValue });
    const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'asset:create', idemKey, fingerprint);
    if (!claim.claimed && claim.record.status === 'COMPLETED') {
      return res.json({ success: true, idempotentReplay: true, asset: claim.record.resultReference });
    }
    idemRecord = claim.record;
  }

  const asset = {
    id: 'AST-' + Date.now(),
    code: sanitize(req.body.code || '', 20),
    name: sanitize(req.body.name || '', 200),
    category: sanitize(req.body.category || '', 100),
    purchaseDate: pDate,
    cost,
    usefulLife: parseInt(req.body.usefulLife) || 5,
    method: req.body.method || 'straight-line',
    salvageValue: parseFloat(req.body.salvageValue) || 0,
    coaAccount: coaAcc,
    accDepAccount: accDep,
    depExpAccount: depExp,
    // P0.10 — Part C/Step 8 (Cash-Flow accuracy): payMethod was previously
    // read only to pick the acquisition JE's credit account, then
    // discarded — periodCapEx (Cash Flow "Investing") summed EVERY asset's
    // cost regardless of how it was paid, overstating cash outflow for any
    // asset bought on credit (Dr 1510 / Cr 2100, no cash movement at all).
    // Stored now so that calculation can filter correctly.
    payMethod: payMeth,
    accumulatedDep: 0,
    status: 'active',
    createdAt: new Date().toISOString()
  };

  // P0.3 — Pattern A: build + validate the purchase journal entry BEFORE the
  // asset is added to the register. A rejected posting (locked period,
  // phantom account) must not leave an asset registered with no matching
  // journal entry (Atomicity Test C).
  let je = null;
  if (cost > 0) {
    const accs = db.chartOfAccounts || [];
    const assetAcc  = accs.find(a=>a.code===coaAcc) || {id:coaAcc,code:coaAcc,name:'أصول ثابتة'};
    let creditAcc;
    if(payMeth==='bank'){
      creditAcc = accs.find(a=>a.code==='1110')||{id:'1110',code:'1110',name:'البنك'};
    } else if(payMeth==='credit'){
      // P0.2: كان يستخدم 2200 (الرواتب المستحقة الدفع — حساب مختلف تماماً) خطأً
      // للشراء الآجل من المورد؛ الحساب الصحيح هو 2100 (الذمم الدائنة — موردون).
      creditAcc = accs.find(a=>a.code==='2100')||{id:'2100',code:'2100',name:'الذمم الدائنة — موردون'};
    } else {
      creditAcc = accs.find(a=>a.code==='1100')||{id:'1100',code:'1100',name:'الصندوق'};
    }
    je = {
      id:'JE-AST-'+Date.now(), date:pDate||new Date().toISOString().slice(0,10),
      desc:`شراء أصل: ${asset.name}`,
      ref:'AST-'+asset.id, type:'asset_purchase', source: 'fixed-assets', sourceId: asset.id, sourceModule: 'fixed-assets',
      totalDebit:cost, totalCredit:cost,
      createdAt:new Date().toISOString(),
      lines:[
        {accountId:assetAcc.id, accountCode:coaAcc,          accountName:assetAcc.name,  debit:cost, credit:0},
        {accountId:creditAcc.id,accountCode:creditAcc.code,   accountName:creditAcc.name, debit:0,    credit:cost}
      ]
    };
  }

  try {
    if (je) appendJournalEntry(db, je); // throws JournalValidationError — nothing committed yet
    db.fixedAssets.push(asset);
    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, asset, asset.id, je && je.id);
  } catch (e) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    throw e;
  }

  appendAuditEvent(db, { req, action: 'asset.created', resourceType: 'fixedAsset', resourceId: asset.id, after: { name: asset.name, cost: asset.cost } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for asset.created:', e.message);
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ الأصل بشكل دائم — حاول مرة أخرى' });
  }
  if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
  res.json({ success: true, asset });
 } catch (err) {
  if (err instanceof JournalValidationError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  if (err.status) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  next(err);
 }
});

// Part C/Step 9: fields that would silently invalidate historical
// depreciation math if changed after the asset has real financial history
// (a purchase journal or any accumulated depreciation). Safe fields
// (name/code/category/method) remain freely editable always.
// P0.10 adversarial-review fix — payMethod added: it was previously
// unlocked despite periodCapEx (server.js ~8696) reading it live to decide
// Cash-Flow "Investing" classification. The purchase JE's credit account
// (1100/1110/2100) is permanently fixed at creation time based on
// payMethod — editing payMethod afterward desynchronizes the Cash Flow
// Statement from the actual posted journal with no detection mechanism.
const ASSET_HISTORY_LOCKED_FIELDS = ['cost', 'purchaseDate', 'usefulLife', 'salvageValue', 'coaAccount', 'accDepAccount', 'depExpAccount', 'payMethod'];

// P0.10 adversarial-review fix (P0 finding): these fields are exclusively
// system-managed — status/disposal* only by buildAndPostAssetDisposal,
// accumulatedDep only by depreciateActiveAssets — and must NEVER be
// settable via a raw PUT, regardless of history. Before this fix,
// PUT {status:'disposed'} silently achieved the same register/report
// effect as a real disposal (excluded from depreciation, excluded from the
// Balance Sheet's fixedAssetsGross, excluded from the reconciliation
// endpoint) WITHOUT posting any reversing/gain-loss journal — and then
// permanently blocked the real dispose route (which 409s ALREADY_DISPOSED
// purely off asset.status). PUT {accumulatedDep:<anything>} similarly let
// accumulatedDep exceed cost (negative NBV), corrupting a later real
// dispose's gain/loss computation into a fabricated number that still
// passes journalGuard's balance check (the algebra is self-consistent
// regardless of how corrupted the input is).
const ASSET_SYSTEM_MANAGED_FIELDS = ['status', 'accumulatedDep', 'disposalDate', 'disposalReason', 'disposalProceeds', 'disposalGainLoss', 'disposalJournalId'];

app.put('/api/assets/:id', requireAuth, requireAdminAction('assets.update'), async (req, res, next) => {
 try {
  const db = loadDB();
  const idx = (db.fixedAssets || []).findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'الأصل غير موجود' });
  const before = { ...db.fixedAssets[idx] };

  const attemptedSystemChange = ASSET_SYSTEM_MANAGED_FIELDS.some(f => req.body[f] !== undefined && String(req.body[f]) !== String(before[f]));
  if (attemptedSystemChange) {
    return res.status(409).json({ success: false, error: `هذا الحقل تديره المنظومة تلقائياً (الإهلاك/التخلص) ولا يُعدَّل يدوياً — استخدم /dispose للتخلص من الأصل`, code: 'ASSET_FIELD_SYSTEM_MANAGED' });
  }

  // P0.10 — Part C/Step 9 (P6-046-adjacent): the forensic map for this
  // milestone found that a raw, unvalidated PUT could silently corrupt
  // depExpAccount/accDepAccount to a nonexistent or incompatible COA code
  // — and because both depreciation routes post ONE combined multi-line
  // journal for every active asset together, a single corrupted asset
  // fails validateJournalEntry's Invariant E and rejects the ENTIRE
  // month's depreciation run for every other asset too. Historical fields
  // are now locked once real financial history exists (P0.9's account-
  // type-immutability pattern, applied here), and any account-code field
  // supplied is validated (exists / not group / correct type) even for an
  // asset with no history yet.
  if (assetHasHistory(db, before)) {
    const attemptedChange = ASSET_HISTORY_LOCKED_FIELDS.some(f => req.body[f] !== undefined && String(req.body[f]) !== String(before[f]));
    if (attemptedChange) {
      return res.status(409).json({ success: false, error: `لا يمكن تعديل بيانات الشراء/الإهلاك الأساسية للأصل "${before.name}" — له تاريخ مالي فعلي (قيد شراء و/أو إهلاك متراكم)`, code: 'ASSET_HISTORY_LOCKED' });
    }
  }
  if (req.body.coaAccount !== undefined)   validateAssetAccountField(db, req.body.coaAccount,   'asset',   'التكلفة (coaAccount)');
  if (req.body.accDepAccount !== undefined) validateAssetAccountField(db, req.body.accDepAccount, 'asset',   'مجمع الإهلاك (accDepAccount)');
  if (req.body.depExpAccount !== undefined) validateAssetAccountField(db, req.body.depExpAccount, 'expense', 'مصروف الإهلاك (depExpAccount)');

  // P1 adversarial-review fix (P3 finding, identity persona): `code` is the
  // physical asset tag staff use to locate/label equipment — never a
  // financial join key (grepped: no lookup anywhere uses fixedAsset.code),
  // so a duplicate can't orphan history, but it was the one identifying
  // field on this route with zero uniqueness check, unlike the sibling
  // PUT /api/patients/:id's fileNumber check added in this same milestone.
  if (req.body.code !== undefined && req.body.code) {
    const dupCode = (db.fixedAssets || []).find(a => a.id !== before.id && a.code === req.body.code);
    if (dupCode) {
      return res.status(409).json({ success: false, error: `الكود "${req.body.code}" مستخدَم بالفعل لأصل آخر ("${dupCode.name}")`, code: 'ASSET_CODE_DUPLICATE' });
    }
  }

  db.fixedAssets[idx] = { ...db.fixedAssets[idx], ...req.body, id: req.params.id };
  appendAuditEvent(db, { req, action: 'asset.updated', resourceType: 'fixedAsset', resourceId: req.params.id, before, after: db.fixedAssets[idx] });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for asset.updated:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التعديل بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true, asset: db.fixedAssets[idx] });
 } catch (err) {
  if (err.status) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  next(err);
 }
});

app.delete('/api/assets/:id', requireAuth, requireAdminAction('assets.delete'), async (req, res, next) => {
 try {
  const db = loadDB();
  const asset = (db.fixedAssets || []).find(a => a.id === req.params.id);
  if (!asset) return res.status(404).json({ success: false, error: 'الأصل غير موجود' });
  // P0.10 — Part C/Step 10 (P6-046): an asset with real financial history
  // (purchase journal and/or accumulated depreciation) can no longer be
  // physically deleted at all — DELETE previously removed the register row
  // while leaving the purchase/depreciation journals in place with nothing
  // left to explain them (P6-046's exact original complaint). Disposal
  // (POST /api/assets/:id/dispose) is now the only correct path for such
  // an asset; physical delete remains available ONLY for a genuinely
  // unused/mistake asset (e.g. cost 0, never depreciated).
  if (assetHasHistory(db, asset)) {
    return res.status(409).json({ success: false, error: `لا يمكن حذف الأصل "${asset.name}" — له تاريخ مالي فعلي؛ استخدم التخلص من الأصل (dispose) بدلاً من ذلك`, code: 'ASSET_HISTORY_LOCKED' });
  }
  // P0.6A — Step 4: defensive guard, kept — still relevant for the narrow
  // remaining case (no journal/no accumulated dep, but a purchaseDate
  // inside a period that has since been locked for other reasons).
  assertFinancialPeriodOpen(db, [asset.purchaseDate]);
  db.fixedAssets = (db.fixedAssets || []).filter(a => a.id !== req.params.id);
  appendAuditEvent(db, { req, action: 'asset.deleted', resourceType: 'fixedAsset', resourceId: asset.id, before: { name: asset.name, cost: asset.cost } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for asset.deleted:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ الحذف بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true });
 } catch (err) {
  if (err instanceof JournalValidationError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  next(err);
 }
});

app.post('/api/assets/depreciate', requireAuth, requireAdminAction('assets.depreciate'), async (req, res, next) => {
 try {
  const db = loadDB();
  const { period } = req.body; // e.g. "2026-06"
  if (!period) return res.status(400).json({ error: 'يجب تحديد الفترة' });
  if (!db.fixedAssets || db.fixedAssets.length === 0)
    return res.status(400).json({ error: 'لا توجد أصول ثابتة' });

  let result;
  try {
    result = depreciateActiveAssets(db, period);
  } catch (e) {
    if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
    throw e;
  }
  if (result.status === 'skipped') {
    const messages = { ALREADY_RUN: 'تم تشغيل إهلاك هذه الفترة مسبقاً — لا يمكن تكراره', NO_ACTIVE_ASSETS: 'لا توجد أصول ثابتة نشطة', NOTHING_TO_DEPRECIATE: 'لا توجد أصول تستحق اهتلاكاً' };
    const statusCode = result.reason === 'ALREADY_RUN' ? 409 : 200;
    return res.status(statusCode).json({ success: statusCode === 200, message: messages[result.reason], code: result.reason, totalDep: 0 });
  }

  appendAuditEvent(db, { req, action: 'asset.depreciation_run', resourceType: 'journal', resourceId: result.journalEntry.id, after: { period, totalDep: result.totalDep, assetsCount: result.assetsCount } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for asset.depreciation_run:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ قيد الإهلاك بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true, journalEntry: result.journalEntry, totalDep: result.totalDep, assetsCount: result.assetsCount });
 } catch (err) {
  next(err);
 }
});

// Part D (P6-046): dispose/retire an asset — full or zero-proceeds
// write-off, with gain/loss recognition. Never touches the original
// acquisition/depreciation journals.
app.post('/api/assets/:id/dispose', requireAuth, requireAdminAction('assets.dispose'), async (req, res, next) => {
 try {
  const db = loadDB();
  const asset = (db.fixedAssets || []).find(a => a.id === req.params.id);
  if (!asset) return res.status(404).json({ success: false, error: 'الأصل غير موجود' });
  let je;
  try {
    je = buildAndPostAssetDisposal(db, asset, req.body, req);
  } catch (e) {
    if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
    if (e.status) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
    throw e;
  }
  appendAuditEvent(db, { req, action: 'asset.disposed', resourceType: 'fixedAsset', resourceId: asset.id, after: { proceeds: asset.disposalProceeds, gainLoss: asset.disposalGainLoss } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for asset.disposed:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التخلص بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true, asset, journalId: je.id });
 } catch (err) {
  next(err);
 }
});

// Part E/Step 15: honest asset-register-vs-GL reconciliation — never plugs
// a difference, same pattern as AP/AR/COA reconciliation elsewhere.
app.get('/api/assets/reconciliation', requireAuth, requireAdminAction('assets.view'), (req, res) => {
  const db = loadDB();
  const assets = db.fixedAssets || [];
  const active = assets.filter(a => a.status !== 'disposed');

  const costCode = req.query.costAccount || '1510';
  const accumCode = req.query.accumDepAccount || '1590';
  // P0.10 adversarial-review fix (P2 finding): these were previously
  // unvalidated — a nonexistent account code silently fell back to
  // {debit:0,credit:0} instead of erroring, indistinguishable from "this
  // account genuinely has zero activity." A caller supplying a wrong/typo'd
  // code could get reconciled:true while the REAL 1510/1590 control
  // accounts (the whole reason this endpoint exists) were never inspected.
  let costAcc, accumAcc;
  try {
    costAcc = validateAssetAccountField(db, costCode, 'asset', 'حساب التكلفة (costAccount)');
    accumAcc = validateAssetAccountField(db, accumCode, 'asset', 'حساب مجمع الإهلاك (accumDepAccount)');
  } catch (e) {
    return res.status(e.status || 400).json({ success: false, error: e.message, code: e.code });
  }

  // R5 (staging validation, reproduced live): registerCost/registerAccumDep
  // used to sum EVERY active asset regardless of which coaAccount/
  // accDepAccount it actually posts to — only the GL side (bCost/bAccum
  // below) was scoped to the requested costCode/accumCode. Any company with
  // more than one fixed-asset control account (e.g. medical equipment under
  // 1510 vs computers under 1530 — exactly the setup this endpoint exists to
  // reconcile) got a permanent false "غير مطابق" for BOTH accounts, since
  // the unfiltered register total could never equal either account's real
  // GL balance alone. The sibling self-check inside the financial-statements
  // route already scopes correctly (see the costAccountCodes/depAccountCodes
  // pattern a few thousand lines up) — mirrored here, scoped to the single
  // requested account instead of the full set in use.
  const registerAssets = active.filter(a => (a.coaAccount || '1510') === costCode);
  const registerCost = parseFloat(registerAssets.reduce((s, a) => s + (parseFloat(a.cost) || 0), 0).toFixed(3));
  const depRegisterAssets = active.filter(a => (a.accDepAccount || '1590') === accumCode);
  const registerAccumDep = parseFloat(depRegisterAssets.reduce((s, a) => s + (parseFloat(a.accumulatedDep) || 0), 0).toFixed(3));
  const registerNBV = parseFloat((registerCost - registerAccumDep).toFixed(3));

  const bm = buildBalanceMap(db, null, req.query.asOf || null);
  const bCost  = bm[costAcc.code]  || { debit: 0, credit: 0 };
  const bAccum = bm[accumAcc.code] || { debit: 0, credit: 0 };
  const glCost = parseFloat((bCost.debit - bCost.credit).toFixed(3));
  const glAccumDep = parseFloat((bAccum.credit - bAccum.debit).toFixed(3));
  const glNBV = parseFloat((glCost - glAccumDep).toFixed(3));

  const costDifference = parseFloat((registerCost - glCost).toFixed(3));
  const accumDepDifference = parseFloat((registerAccumDep - glAccumDep).toFixed(3));
  const nbvDifference = parseFloat((registerNBV - glNBV).toFixed(3));
  const reconciled = Math.abs(costDifference) <= 0.005 && Math.abs(accumDepDifference) <= 0.005 && Math.abs(nbvDifference) <= 0.005;

  res.json({
    registerCost, registerAccumDep, registerNBV,
    glCost, glAccumDep, glNBV,
    costDifference, accumDepDifference, nbvDifference, reconciled,
    note: reconciled ? 'يطابق تمامًا.' : 'فرق حقيقي — راجع الأصول ذات حسابات غير قياسية (coaAccount/accDepAccount مختلفة عن 1510/1590) أو ترحيلات يدوية خارج هذا الدفتر.',
  });
});

// P1 (Record Workspace, NEW-R5-ADV-ASSETS-NO-PERID-01): individual asset
// detail, reusing the exact NBV formula used everywhere else in this file
// (cost - accumulatedDep, 3-decimal round — see buildAndPostAssetDisposal
// above). Related-journal linkage is honest about what the data model
// actually supports: the purchase and disposal entries DO carry a per-entry
// `sourceId===asset.id` (confirmed), so those are matched exactly; the
// monthly depreciation entries do NOT carry any per-line/per-entry asset
// identifier (they merge every active asset's depreciation into one entry —
// a separate, already-documented, deliberately-deferred gap) so this route
// does not fabricate a per-asset depreciation journal history — it exposes
// the asset's own already-computed cumulative `accumulatedDep` instead,
// which is the only depreciation figure this data model can honestly attest
// to at the per-asset level.
// NOTE ON ROUTE ORDER: this MUST be registered after every literal-path
// /api/assets/* route above (reconciliation, depreciate, :id/dispose) —
// Express matches routes in registration order, and a `:id` param matches
// any single path segment, including literal segment names like
// "reconciliation"; registering this first previously shadowed and broke
// GET /api/assets/reconciliation entirely (caught by the existing Recon A/B/C
// regression tests).
app.get('/api/assets/:id', requireAuth, requireAdminAction('assets.view'), (req, res) => {
  const db = loadDB();
  const asset = (db.fixedAssets || []).find(a => a.id === req.params.id);
  if (!asset) return res.status(404).json({ success: false, error: 'الأصل غير موجود' });

  const cost = parseFloat(asset.cost) || 0;
  const accumulatedDep = parseFloat(asset.accumulatedDep) || 0;
  const nbv = parseFloat((cost - accumulatedDep).toFixed(3));

  const relatedJournals = (db.journalEntries || [])
    .filter(j => j.sourceId === asset.id || j.ref === ('AST-' + asset.id))
    .map(j => ({ id: j.id, date: j.date, ref: j.ref, desc: j.desc || j.description, type: j.type, totalDebit: j.totalDebit, totalCredit: j.totalCredit }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  res.json({
    asset, nbv,
    hasHistory: assetHasHistory(db, asset),
    relatedJournals,
    depreciationNote: 'قيود الإهلاك الشهري تُدمَج لكل الأصول النشطة في قيد واحد بلا معرّف سطري لكل أصل — القيمة الدفترية أعلاه محسوبة من مجمع الإهلاك المُسجَّل على الأصل نفسه، وهو الرقم الوحيد الموثوق على مستوى الأصل الفردي حاليًا.',
  });
});

// ─── BANK RECONCILIATION ─────────────────────────────────────────────────────
app.get('/api/bank-recon', requireAuth, requireAdminAction('bank.view'), (req, res) => {
  const db = loadDB();
  const { account, period } = req.query;
  if (!account || !period) return res.status(400).json({ error: 'account و period مطلوبان' });

  const recons = db.bankRecons || [];
  const existing = recons.find(r => r.account === account && r.period === period);

  // Get journal lines for this account in this period
  const [year, month] = period.split('-');
  const journalLines = [];
  (db.journalEntries || []).forEach(je => {
    if (!je.date.startsWith(period)) return;
    (je.lines || []).forEach(line => {
      const lineAcc = line.accountCode != null ? line.accountCode : line.account;
      if (String(lineAcc) === String(account)) {
        journalLines.push({
          id: je.id + '-' + lineAcc,
          date: je.date,
          desc: je.desc,
          ref: je.ref,
          debit: line.debit || 0,
          credit: line.credit || 0,
          matched: existing?.matchedLines?.includes(je.id + '-' + lineAcc) || false
        });
      }
    });
  });

  // Opening balance from opening entries
  const openingBalance = (db.chartOfAccounts || []).find(a => String(a.code) === String(account))?.openingDebit || 0;

  // P0.10 — GL-vs-bank-statement reconciliation exposure (forensic gap:
  // this legacy route returned raw lines but never the comparison itself,
  // leaving the frontend to compute a partial version client-side with no
  // API-level source of truth). Mirrors the frontend's own definitions
  // (public/index.html updateReconSummary: period-net GL movement, no
  // openingBalance) so this doesn't silently disagree with what's on screen.
  const matchedLinesArr = existing?.matchedLines || [];
  const bookBalance = parseFloat(journalLines.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0).toFixed(3));
  const unmatchedBookAmount = parseFloat(journalLines.filter(l => !matchedLinesArr.includes(l.id)).reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0).toFixed(3));
  const bankStatementTotal = parseFloat((existing?.bankStatementLines || []).reduce((s, l) => s + (parseFloat(l.amount) || 0), 0).toFixed(3));
  const bankEndBalance = existing?.bankEndBalance || 0;
  const difference = parseFloat((bankEndBalance - bookBalance).toFixed(3));

  res.json({
    account,
    period,
    bankStatementLines: existing?.bankStatementLines || [],
    matchedLines: existing?.matchedLines || [],
    bankEndBalance: existing?.bankEndBalance || 0,
    notes: existing?.notes || '',
    journalLines,
    openingBalance,
    reconciliation: {
      bookBalance, unmatchedBookAmount,
      matchedBookAmount: parseFloat((bookBalance - unmatchedBookAmount).toFixed(3)),
      bankStatementTotal, bankEndBalance, difference,
      reconciled: Math.abs(difference) <= 0.005,
      note: 'هذا النموذج القديم (bankRecons) يتتبع حالة المطابقة على أسطر القيود فقط (matchedLines) — أسطر كشف البنك (bankStatementLines) لا تحمل علم مطابقة مستقلاً في هذا النموذج، فلا يمكن اشتقاق "بنود معلّقة من كشف البنك" بدقة منه. للمطابقة الآلية الكاملة بين الطرفين استخدم /api/bank/reconcile-match.',
    },
  });
});

// P0.4A — Step 2 legacy route review: this is an OLDER manual-matching bank
// reconciliation model (db.bankRecons, keyed by account+period) predating the
// newer statement-import engine at /api/bank/reconcile-*. It is still reachable
// and its GET counterpart above is already admin-gated (bank.view) — gated here
// with the same effective permission for consistency rather than silently
// removed, since removal without confirming zero callers risks breaking an
// in-progress reconciliation workflow.
app.post('/api/bank-recon', requireAuth, requireAdminAction('bank.reconcile_legacy_save'), async (req, res, next) => {
  try {
  const db = loadDB();
  if (!db.bankRecons) db.bankRecons = [];
  const { account, period, bankStatementLines, matchedLines, bankEndBalance, notes } = req.body;
  if (!account || !period) return res.status(400).json({ success: false, error: 'account و period مطلوبان' });
  // P0.10 — defense-in-depth: a locked period's reconciliation record is
  // part of that period's closed audit trail (IAS 8) and shouldn't be
  // silently rewritten after close, even though this route posts no
  // journal entry itself. Same DELETE/UNDO-path convention (403) used
  // everywhere else in the app for a locked-period rejection.
  assertFinancialPeriodOpen(db, [period + '-01']);
  const idx = db.bankRecons.findIndex(r => r.account === account && r.period === period);
  const before = idx >= 0 ? { ...db.bankRecons[idx] } : undefined;
  const rec = { account, period, bankStatementLines: bankStatementLines || [], matchedLines: matchedLines || [], bankEndBalance: parseFloat(bankEndBalance) || 0, notes: notes || '', updatedAt: new Date().toISOString() };
  if (idx >= 0) db.bankRecons[idx] = rec;
  else db.bankRecons.push(rec);
  appendAuditEvent(db, { req, action: 'bank.reconcile_legacy_saved', resourceType: 'bankRecons', resourceId: `${account}/${period}`, before, after: { bankEndBalance: rec.bankEndBalance, matchedCount: rec.matchedLines.length } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for bank.reconcile_legacy_saved:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التسوية بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EXCEL TEMPLATES — تحميل قوالب الاستيراد
// ═══════════════════════════════════════════════════════════════════════════

function styleHeader(ws, headers, rowNum) {
  headers.forEach((h, i) => {
    const cellRef = XLSX.utils.encode_cell({ r: rowNum - 1, c: i });
    if (!ws[cellRef]) ws[cellRef] = {};
    ws[cellRef].s = {
      font: { bold: true, color: { rgb: 'FFFFFF' }, name: 'Arial', sz: 11 },
      fill: { fgColor: { rgb: '1E3A5F' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: {
        top: { style: 'thin', color: { rgb: 'AAAAAA' } },
        bottom: { style: 'thin', color: { rgb: 'AAAAAA' } },
        left: { style: 'thin', color: { rgb: 'AAAAAA' } },
        right: { style: 'thin', color: { rgb: 'AAAAAA' } }
      }
    };
  });
}

// Helper: build and send an xlsx workbook
function sendWorkbook(res, wb, filename) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', bookSST: false });
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

// ── 1. قالب المصاريف ──────────────────────────────────────────────────────
app.get('/api/templates/expenses', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Data entry
  const headers = ['التاريخ','الوصف','المبلغ (د.ك)','الفئة','طريقة الدفع','المورد','رقم الفاتورة','رقم حساب المدين','رقم حساب الدائن','ملاحظات'];
  const sample = [
    ['2026-06-13','مستلزمات طبية',150.500,'مستلزمات طبية','نقداً','شركة الخليج الطبية','INV-001','5100','1010',''],
    ['2026-06-13','إيجار العيادة',800.000,'إيجار','تحويل بنكي','المالك','','5200','2100','إيجار يونيو 2026'],
    ['2026-06-13','كهرباء وماء',95.750,'مرافق','بطاقة','','','5300','1010',''],
  ];
  const wsData = [headers, ...sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [12,28,14,18,14,22,14,18,18,22].map(w => ({ wch: w }));
  ws['!rows'] = [{ hpt: 36 }];
  styleHeader(ws, headers, 1);
  XLSX.utils.book_append_sheet(wb, ws, 'المصاريف');

  // Sheet 2: Instructions
  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['📋 تعليمات قالب المصاريف'],
    [''],
    ['الحقل', 'وصف', 'مثال', 'إلزامي؟'],
    ['التاريخ', 'تاريخ المصروف بصيغة YYYY-MM-DD', '2026-06-13', 'نعم'],
    ['الوصف', 'وصف مختصر للمصروف', 'مستلزمات طبية', 'نعم'],
    ['المبلغ', 'المبلغ بالدينار الكويتي - ثلاث خانات عشرية', '150.500', 'نعم'],
    ['الفئة', 'فئة المصروف', 'مستلزمات طبية / إيجار / رواتب ...', 'لا'],
    ['طريقة الدفع', 'كيف تم الدفع', 'نقداً / بطاقة / تحويل بنكي', 'لا'],
    ['المورد', 'اسم الجهة الموردة أو المستفيدة', 'شركة الخليج الطبية', 'لا'],
    ['رقم الفاتورة', 'رقم الفاتورة إن وجد', 'INV-001', 'لا'],
    ['رقم حساب المدين', 'رقم الحساب من دليل الحسابات (يُترك فارغاً للنظام)', '5100', 'لا'],
    ['رقم حساب الدائن', 'رقم الحساب الدائن (يُترك فارغاً للنظام)', '1010', 'لا'],
    ['ملاحظات', 'أي ملاحظات إضافية', '', 'لا'],
    [''],
    ['⚠️ ملاحظات مهمة:'],
    ['- لا تعدّل رؤوس الأعمدة في الصف الأول'],
    ['- إذا تركت حسابات المدين/الدائن فارغة، سيختار النظام الحسابات الافتراضية'],
    ['- يمكن إدخال أكثر من 500 سطر في ورقة واحدة'],
  ]);
  wsInfo['!cols'] = [20, 38, 28, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsInfo, 'تعليمات');

  sendWorkbook(res, wb, 'قالب_المصاريف.xlsx');
});

// ── 2. قالب الأرصدة الافتتاحية للمخزون ──────────────────────────────────
app.get('/api/templates/inventory-opening', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();

  const headers = ['اسم المادة','الوحدة','الكمية الافتتاحية','تكلفة الوحدة (د.ك)','إجمالي التكلفة (د.ك)','الكمية الدنيا (تنبيه)','الفئة','الموقع / المستودع','رقم الحساب','ملاحظات'];
  const sample = [
    ['مخدر موضعي','علبة',20,2.500,'=C2*D2',5,'مواد طبية','مستودع رئيسي','1310',''],
    ['إبر الحقن','صندوق',15,3.750,'=C3*D3',3,'مواد طبية','مستودع رئيسي','1310',''],
    ['قفازات لاتكس','صندوق',30,1.800,'=C4*D4',10,'مستلزمات','مستودع رئيسي','1310',''],
    ['مواد حشو','عبوة',8,12.000,'=C5*D5',2,'مواد علاجية','مستودع طب الأسنان','1310',''],
  ];
  const wsData = [headers, ...sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [22,10,16,18,18,16,14,18,14,22].map(w => ({ wch: w }));
  ws['!rows'] = [{ hpt: 36 }];
  styleHeader(ws, headers, 1);
  XLSX.utils.book_append_sheet(wb, ws, 'أرصدة_المخزون');

  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['📋 تعليمات قالب الأرصدة الافتتاحية للمخزون'],
    [''],
    ['الحقل', 'وصف', 'مثال', 'إلزامي؟'],
    ['اسم المادة', 'اسم المادة أو المستلزم', 'مخدر موضعي', 'نعم'],
    ['الوحدة', 'وحدة القياس', 'علبة / صندوق / قطعة / مل', 'نعم'],
    ['الكمية الافتتاحية', 'الكمية الموجودة حالياً', '20', 'نعم'],
    ['تكلفة الوحدة', 'تكلفة الشراء لكل وحدة بالدينار', '2.500', 'نعم'],
    ['إجمالي التكلفة', 'يحتسب تلقائياً = الكمية × التكلفة', 'معادلة تلقائية', 'لا'],
    ['الكمية الدنيا', 'حد إعادة الطلب — يظهر تنبيه عنده', '5', 'لا'],
    ['الفئة', 'تصنيف المادة', 'مواد طبية / مستلزمات / أدوات', 'لا'],
    ['الموقع', 'مكان التخزين', 'مستودع رئيسي', 'لا'],
    ['رقم الحساب', 'حساب المخزون من دليل الحسابات (اتركه فارغاً للافتراضي)', '1310', 'لا'],
    [''],
    ['⚠️ ملاحظات:'],
    ['- سيُنشئ النظام قيداً يومياً يُدين حساب المخزون ويُدائن رأس المال'],
    ['- تأكد من صحة الكميات — هذه أرصدة البداية ولا يمكن تعديلها لاحقاً بسهولة'],
    ['- العمود E (إجمالي التكلفة) يحتسب تلقائياً في Excel ولكن النظام يحسبه مجدداً'],
  ]);
  wsInfo['!cols'] = [20, 38, 28, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsInfo, 'تعليمات');

  sendWorkbook(res, wb, 'قالب_أرصدة_المخزون.xlsx');
});

// ── 3. قالب مدفوعات الدكاترة ─────────────────────────────────────────────
app.get('/api/templates/doctor-payments', requireAuth, (req, res) => {
  const db = loadDB();
  const wb = XLSX.utils.book_new();

  const headers = ['اسم الدكتور','الشهر (YYYY-MM)','إجمالي الإيرادات (د.ك)','خصومات المختبر (د.ك)','خصومات التأمين (د.ك)','صافي الوعاء','نسبة العمولة %','العمولة المستحقة (د.ك)','السُّلف المصروفة (د.ك)','صافي المستحق (د.ك)','تاريخ الدفع','طريقة الدفع','ملاحظات'];
  const doctors = (db.doctors || []).map((d, i) => [
    d.name, '2026-06', 0, 0, 0, `=C${i+2}-D${i+2}-E${i+2}`, d.commission, `=F${i+2}*G${i+2}/100`, 0, `=H${i+2}-I${i+2}`, '', 'تحويل بنكي', ''
  ]);
  const sample = doctors.length ? doctors : [
    ['DR.NASSER','2026-06',5000,200,300,'=C2-D2-E2',20,'=F2*G2/100',0,'=H2-I2','2026-06-30','تحويل بنكي',''],
  ];
  const wsData = [headers, ...sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [18,14,18,16,16,14,14,18,16,16,14,14,18].map(w => ({ wch: w }));
  ws['!rows'] = [{ hpt: 36 }];
  styleHeader(ws, headers, 1);
  XLSX.utils.book_append_sheet(wb, ws, 'مدفوعات_الدكاترة');

  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['📋 تعليمات قالب مدفوعات الدكاترة'],
    [''],
    ['الحقل', 'وصف', 'ملاحظة'],
    ['اسم الدكتور', 'اسم الدكتور كما هو في النظام', 'يجب أن يتطابق تماماً'],
    ['الشهر', 'الشهر المحاسبي بصيغة YYYY-MM', '2026-06'],
    ['إجمالي الإيرادات', 'إجمالي ما حققه الدكتور قبل الخصومات', 'د.ك'],
    ['خصومات المختبر', 'تكاليف المختبر الخارجي', 'د.ك'],
    ['خصومات التأمين', 'خصومات شركات التأمين', 'د.ك'],
    ['صافي الوعاء', 'يحتسب تلقائياً = الإيرادات - خصومات', 'معادلة'],
    ['نسبة العمولة %', 'النسبة المتفق عليها مع الدكتور', '%'],
    ['العمولة المستحقة', 'يحتسب تلقائياً = الوعاء × النسبة', 'معادلة'],
    ['السُّلف', 'أي سُلف صُرفت للدكتور مسبقاً', 'د.ك'],
    ['صافي المستحق', 'العمولة - السُّلف', 'معادلة'],
    ['تاريخ الدفع', 'تاريخ صرف المبلغ', 'YYYY-MM-DD'],
    ['طريقة الدفع', 'نقداً / بطاقة / تحويل بنكي / شيك', ''],
    [''],
    ['⚠️ سيُنشئ النظام قيداً يومياً: مدين حساب عمولات الدكاترة — دائن الخزينة/البنك'],
  ]);
  wsInfo['!cols'] = [20, 38, 22].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsInfo, 'تعليمات');

  sendWorkbook(res, wb, 'قالب_مدفوعات_الدكاترة.xlsx');
});

// ── 4. قالب قيود يومية جماعية ────────────────────────────────────────────
app.get('/api/templates/bulk-journal', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();

  const headers = ['رقم القيد (مشترك لسطور نفس القيد)','التاريخ','الوصف','رقم الحساب','اسم الحساب','مدين (د.ك)','دائن (د.ك)','مرجع','ملاحظات'];
  const sample = [
    ['JE-001','2026-06-13','شراء مستلزمات طبية','5100','مصاريف مستلزمات طبية',150.500,0,'INV-001',''],
    ['JE-001','2026-06-13','شراء مستلزمات طبية','1010','الصندوق',0,150.500,'INV-001','الطرف المقابل'],
    ['','','','','','','','',''],
    ['JE-002','2026-06-13','إيجار يونيو 2026','5200','مصروف الإيجار',800.000,0,'',''],
    ['JE-002','2026-06-13','إيجار يونيو 2026','2100','دائنون متنوعون',0,800.000,'',''],
  ];
  const wsData = [headers, ...sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [28,13,28,14,24,14,14,14,20].map(w => ({ wch: w }));
  ws['!rows'] = [{ hpt: 36 }];
  styleHeader(ws, headers, 1);
  XLSX.utils.book_append_sheet(wb, ws, 'قيود_جماعية');

  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['📋 تعليمات قالب القيود اليومية الجماعية'],
    [''],
    ['⚙️ كيفية الاستخدام:'],
    ['1. كل قيد يتكون من سطرين أو أكثر يشتركون في نفس رقم القيد'],
    ['2. مجموع المدين = مجموع الدائن لكل قيد (شرط التوازن)'],
    ['3. رقم الحساب يجب أن يتطابق مع دليل الحسابات في النظام'],
    ['4. اترك صف فارغاً بين القيود المختلفة (اختياري للوضوح)'],
    [''],
    ['الحقل', 'وصف', 'إلزامي؟'],
    ['رقم القيد', 'معرّف القيد — نفس الرقم لسطور القيد الواحد', 'نعم'],
    ['التاريخ', 'تاريخ القيد YYYY-MM-DD', 'نعم'],
    ['الوصف', 'وصف القيد (نفسه لكل سطور القيد)', 'نعم'],
    ['رقم الحساب', 'الكود من دليل الحسابات', 'نعم'],
    ['اسم الحساب', 'للمرجعية فقط — النظام يستخدم رقم الحساب', 'لا'],
    ['مدين', 'المبلغ المدين (0 للسطور الدائنة)', 'نعم'],
    ['دائن', 'المبلغ الدائن (0 للسطور المدينة)', 'نعم'],
    ['مرجع', 'رقم الفاتورة أو المستند المرجعي', 'لا'],
    [''],
    ['❌ أخطاء شائعة:'],
    ['- عدم توازن القيد (مدين ≠ دائن) → سيرفض النظام القيد'],
    ['- رقم حساب غير موجود في دليل الحسابات → خطأ في الاستيراد'],
    ['- تكرار رقم قيد مع تواريخ مختلفة → يجب أن يكون لكل قيد تاريخ واحد'],
  ]);
  wsInfo['!cols'] = [20, 42, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsInfo, 'تعليمات');

  sendWorkbook(res, wb, 'قالب_قيود_جماعية.xlsx');
});

// ── 5. قالب أرصدة المرضى الافتتاحية ─────────────────────────────────────
app.get('/api/templates/patient-opening', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();

  const headers = ['اسم المريض','رقم الملف','التاريخ الافتتاحي','المبلغ المستحق (د.ك)','نوع التأمين','شركة التأمين','ملاحظات'];
  const sample = [
    ['أحمد محمد الشمري','P-001','2026-01-01',250.000,'تأمين اختياري','شركة الخليج للتأمين','رصيد منقول من النظام القديم'],
    ['سارة علي العتيبي','P-002','2026-01-01',180.500,'نقدي','',''],
    ['خالد يوسف البدر','P-003','2026-01-01',95.750,'تأمين إلزامي','AXA التأمين',''],
  ];
  const wsData = [headers, ...sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [24,12,16,18,14,24,28].map(w => ({ wch: w }));
  ws['!rows'] = [{ hpt: 36 }];
  styleHeader(ws, headers, 1);
  XLSX.utils.book_append_sheet(wb, ws, 'أرصدة_المرضى');

  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['📋 تعليمات قالب الأرصدة الافتتاحية للمرضى'],
    [''],
    ['⚙️ الغرض:'],
    ['يُستخدم هذا القالب عند الترحيل من نظام محاسبي آخر لنقل الذمم المدينة للمرضى'],
    [''],
    ['الحقل', 'وصف', 'إلزامي؟'],
    ['اسم المريض', 'الاسم الكامل للمريض', 'نعم'],
    ['رقم الملف', 'رقم ملف المريض في النظام', 'لا'],
    ['التاريخ الافتتاحي', 'تاريخ بداية الرصيد YYYY-MM-DD', 'نعم'],
    ['المبلغ المستحق', 'المبلغ المستحق على المريض بالدينار', 'نعم'],
    ['نوع التأمين', 'نقدي / تأمين إلزامي / تأمين اختياري', 'لا'],
    ['شركة التأمين', 'اسم شركة التأمين إن وجدت', 'لا'],
    [''],
    ['⚠️ سيُنشئ النظام: قيد مدين ذمم مرضى — دائن رأس المال (ترحيل)'],
  ]);
  wsInfo['!cols'] = [20, 42, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsInfo, 'تعليمات');

  sendWorkbook(res, wb, 'قالب_أرصدة_المرضى.xlsx');
});

// ═══════════════════════════════════════════════════════════════════════════
// EXCEL IMPORT — استيراد البيانات من Excel
// ═══════════════════════════════════════════════════════════════════════════

// ── IMPORT: المصاريف ──────────────────────────────────────────────────────
// P0.11 (saveDB call-site audit — adversarial review finding): converted to
// durable-before-ack, matching its sibling import routes.
// P0.12 (closes P6-097 — bulk file-upload import routes are especially
// prone to client-side retry-on-timeout behavior). The idempotency key
// protects the WHOLE FILE as one logical import; the fingerprint is derived
// from the parsed rows themselves (not the raw file bytes), so two
// byte-different-but-semantically-identical re-exports of the same data
// still correctly collide.
app.post('/api/import/expenses', requireAuth, requirePermission('expenses', 'add'), upload.single('file'), async (req, res) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.removeSync(req.file.path);

    const db = loadDB();
    if (!db.expenses) db.expenses = [];
    if (!db.journalEntries) db.journalEntries = [];
    const settings = db.accountingSettings || {};
    // P0.2: الاحتياط الافتراضي كان 1010 (غير موجود) — الآن 1100 (الصندوق — نقدي).
    const cashAcc = settings.accCash || '1100';
    const errors = [];
    const created = [];

    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const fingerprint = computeFingerprint('import:expenses', { rows });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'import:expenses', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, ...claim.record.resultReference });
      }
      idemRecord = claim.record;
    }

    rows.forEach((row, i) => {
      const date   = String(row['التاريخ'] || '').trim();
      const desc   = String(row['الوصف'] || '').trim();
      const amount = parseFloat(row['المبلغ (د.ك)'] || row['المبلغ'] || 0);
      if (!date || !desc || !amount) { errors.push(`سطر ${i+2}: بيانات ناقصة`); return; }

      const id = `EXP-${Date.now()}-${i}`;
      const expense = {
        id, date, description: desc, amount,
        category:    String(row['الفئة'] || 'متنوعة'),
        paymentMethod: String(row['طريقة الدفع'] || 'نقداً'),
        vendor:      String(row['المورد'] || ''),
        invoiceNo:   String(row['رقم الفاتورة'] || ''),
        notes:       String(row['ملاحظات'] || ''),
        createdAt:   new Date().toISOString()
      };

      const debitAcc  = String(row['رقم حساب المدين'] || '5100').trim() || '5100';
      const creditAcc = String(row['رقم حساب الدائن'] || cashAcc).trim() || cashAcc;
      const je = {
        id: `JE-IMP-EXP-${Date.now()}-${i}`,
        date, description: desc,
        // P0.6B (P6-017): totalDebit/totalCredit set explicitly at write
        // time, matching every other journal-creating route's convention —
        // detectAnomalies()/GET /api/anomalies now also recompute from
        // `lines` via jeAmounts() as a second line of defense, but this
        // entry should carry correct totals of its own regardless.
        totalDebit: amount, totalCredit: amount,
        lines: [
          { accountCode: debitAcc,  debit: amount,  credit: 0 },
          { accountCode: creditAcc, debit: 0, credit: amount }
        ],
        reference: expense.invoiceNo || id,
        source: 'import-expenses',
        createdAt: new Date().toISOString()
      };
      try {
        appendJournalEntry(db, je);
      } catch (e) {
        if (!(e instanceof JournalValidationError)) throw e;
        errors.push(`سطر ${i+2}: ${e.message}`);
        return;
      }
      db.expenses.push(expense);
      created.push({ id, jeId: je.id });
    });

    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { created: created.length, errors }, null, null);
    await saveDB(db, { durable: true });
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, created: created.length, errors });
  } catch(e) {
    if (idemRecord) { try { await releaseIdempotencyClaim(loadDB(), isMongo, idemRecord); } catch (_) {} }
    // R4 (Part P): XLSX.readFile(req.file.path) wraps fs.readFileSync — a
    // missing/corrupt upload throws Node's raw upload-path error text.
    console.error('❌ Expense import error:', e.message);
    res.status(500).json({ success: false, error: 'تعذّر استيراد ملف المصاريف — تأكد من الملف وحاول مرة أخرى' });
  }
});

// ── IMPORT: المخزون الافتتاحي ────────────────────────────────────────────
// P0.3A — prepare/validate/commit, all-or-nothing (Steps 2/4). Opening-
// balance imports are a single accounting batch: either every row's
// inventory record AND the one combined journal entry commit together, or
// NOTHING is written — no partial rows, no dangling journal reference.
// P0.11 (saveDB call-site audit): converted to durable-before-ack — the
// existing outer try/catch already returns 500 with e.message on any
// thrown error, which now correctly also covers a failed durable save.
app.post('/api/import/inventory-opening', requireAuth, requirePermission('inventory', 'add'), upload.single('file'), async (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.removeSync(req.file.path);

    const db = loadDB();
    const settings = db.accountingSettings || {};
    const errors = [];
    const created = [];
    let totalValue = 0;
    const jeLines = [];

    // Stage every intended mutation WITHOUT touching db.invItems yet.
    // `pendingNew` mirrors the original "merge same-name rows within this
    // batch" behavior (previously implicit because the array was mutated
    // immediately, making later rows in the same loop see earlier ones);
    // `pendingDeltas` stages cumulative +qty/+cost for names that already
    // exist in the tenant's persisted inventory.
    //
    // P0.6A — Step 2 (P6-042): this used to stage against/commit into
    // db.inventory, a SEPARATE array from db.invItems — the one every other
    // inventory route (POST /api/inv/items, POST /api/inv/operation) and
    // the /api/financial-statements inventory valuation actually read. That
    // meant an opening-balance import posted a real, valid journal entry
    // but the imported items were permanently invisible to the rest of the
    // inventory module. Now staged/committed directly against the
    // canonical db.invItems array instead (field names — unitCost/minQty —
    // matched to what that array's other writers/readers already use).
    const existingByName = new Map((db.invItems || []).map(it => [it.name, it]));
    const pendingNew = new Map();     // name -> staged new item
    const pendingDeltas = new Map();  // existing item ref -> {quantity, totalCost}

    rows.forEach((row, i) => {
      const name = String(row['اسم المادة'] || '').trim();
      const qty  = parseFloat(row['الكمية الافتتاحية'] || row['الكمية'] || 0);
      const cost = parseFloat(row['تكلفة الوحدة (د.ك)'] || row['تكلفة الوحدة'] || 0);
      if (!name || !qty) { errors.push(`سطر ${i+2}: اسم أو كمية ناقصة`); return; }

      const id = `INV-${Date.now()}-${i}`;
      const total = parseFloat((qty * cost).toFixed(3));
      // P0.2: الاحتياط الافتراضي كان 1310 (غير موجود) — الآن 1300 (المخزون).
      const invAcct = String(row['رقم الحساب'] || settings.accInventory || '1300').trim();

      const existingItem = existingByName.get(name);
      if (existingItem) {
        const d = pendingDeltas.get(existingItem) || { quantity: 0, totalCost: 0 };
        d.quantity += qty;
        d.totalCost = parseFloat((d.totalCost + total).toFixed(3));
        pendingDeltas.set(existingItem, d);
      } else if (pendingNew.has(name)) {
        const staged = pendingNew.get(name);
        staged.quantity += qty;
        staged.totalCost = parseFloat((staged.totalCost + total).toFixed(3));
      } else {
        pendingNew.set(name, {
          id, name,
          unit:         String(row['الوحدة'] || 'قطعة'),
          quantity:     qty,
          unitCost:     cost,
          totalCost:    total,
          minQty:       parseFloat(row['الكمية الدنيا (تنبيه)'] || 0),
          category:     String(row['الفئة'] || 'عام'),
          location:     String(row['الموقع / المستودع'] || ''),
          accountCode:  invAcct,
          notes:        String(row['ملاحظات'] || ''),
          isOpening:    true,
          createdAt:    new Date().toISOString(),
        });
      }

      totalValue += total;
      jeLines.push({ accountCode: invAcct, debit: total, credit: 0 });
      created.push(name);
    });

    // Step 4 — whole-batch: ANY invalid source row rejects the entire batch.
    if (errors.length) {
      return res.status(400).json({ success: false, created: 0, totalValue: 0, errors,
        error: `تعذّر استيراد الملف — ${errors.length} سطر غير صالح. لم يُستورد أي سطر (الدفعة كاملة أو لا شيء).` });
    }

    if (jeLines.length > 0) {
      // Step 5 — duplicate-import guard: this route always posts to the
      // same deterministic ref ('OB-INV'); re-submitting the same/another
      // opening-inventory file would otherwise silently double the journal
      // AND double every merged item's quantity. Reject instead of guessing
      // how to reconcile a second import.
      if ((db.journalEntries || []).some(j => j.ref === 'OB-INV' || j.reference === 'OB-INV')) {
        return res.status(409).json({ success: false, created: 0, totalValue: 0, errors: [],
          error: 'تم استيراد أرصدة افتتاحية للمخزون مسبقاً (OB-INV) — استخدم شاشة عمليات المخزون للتعديلات اللاحقة بدل إعادة الاستيراد.' });
      }
      const equityAcc = settings.accRetained || '3100';
      jeLines.push({ accountCode: equityAcc, debit: 0, credit: parseFloat(totalValue.toFixed(3)) });
      const je = {
        id: `JE-INV-OPEN-${Date.now()}`,
        date: new Date().toISOString().split('T')[0],
        description: `أرصدة افتتاحية للمخزون — استيراد Excel (${created.length} مادة)`,
        desc: `أرصدة افتتاحية للمخزون — استيراد Excel (${created.length} مادة)`,
        ref: 'OB-INV', reference: 'OB-INV',
        lines: jeLines,
        source: 'import-inventory-opening',
        createdAt: new Date().toISOString()
      };
      const result = validateJournalEntry(db, je);
      if (!result.ok) {
        return res.status(result.status).json({ success: false, created: 0, totalValue: 0, errors: [], error: result.error, code: result.code });
      }

      // Everything validated — commit inventory mutations + journal together.
      if (!db.invItems) db.invItems = [];
      pendingDeltas.forEach((delta, item) => {
        item.quantity += delta.quantity;
        item.totalCost = parseFloat(((item.totalCost || 0) + delta.totalCost).toFixed(3));
      });
      pendingNew.forEach(item => db.invItems.push(item));
      if (!db.journalEntries) db.journalEntries = [];
      db.journalEntries.push(je);
    }

    await saveDB(db, { durable: true });
    res.json({ success: true, created: created.length, totalValue: parseFloat(totalValue.toFixed(3)), errors: [] });
  } catch(e) {
    if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
    // R4 (Part P): XLSX.readFile(req.file.path) wraps fs.readFileSync — a
    // missing/corrupt upload throws Node's raw upload-path error text.
    console.error('❌ Inventory-opening import error:', e.message);
    res.status(500).json({ success: false, error: 'تعذّر استيراد ملف الأرصدة الافتتاحية — تأكد من الملف وحاول مرة أخرى' });
  }
});

// ── IMPORT: مدفوعات الدكاترة ─────────────────────────────────────────────
// P0.11 (saveDB call-site audit): converted to durable-before-ack.
// P0.12 (closes P6-097 — adversarial review's highest-severity finding in
// this cluster: this route had NO duplicate-import guard at all, unlike its
// near-identical sibling /api/import/inventory-opening). Same
// whole-file-as-one-logical-import pattern as /api/import/expenses above.
app.post('/api/import/doctor-payments', requireAuth, requirePermission('doctors', 'add'), upload.single('file'), async (req, res) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.removeSync(req.file.path);

    const db = loadDB();
    if (!db.doctorPayments) db.doctorPayments = [];
    if (!db.journalEntries) db.journalEntries = [];
    const settings = db.accountingSettings || {};
    // P0.2: الاحتياط الافتراضي كان 1010 (غير موجود) — الآن 1100 (الصندوق — نقدي).
    const cashAcc = settings.accCash || '1100';
    const errors = [];
    const created = [];

    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const fingerprint = computeFingerprint('import:doctor-payments', { rows });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'import:doctor-payments', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, ...claim.record.resultReference });
      }
      idemRecord = claim.record;
    }

    rows.forEach((row, i) => {
      const doctor = String(row['اسم الدكتور'] || '').trim();
      const month  = String(row['الشهر (YYYY-MM)'] || row['الشهر'] || '').trim();
      const net    = parseFloat(row['صافي المستحق (د.ك)'] || row['صافي المستحق'] || 0);
      if (!doctor || !month) { errors.push(`سطر ${i+2}: دكتور أو شهر ناقص`); return; }

      const id = `DPAY-${Date.now()}-${i}`;
      const commission = parseFloat(row['العمولة المستحقة (د.ك)'] || row['العمولة المستحقة'] || 0);
      const advances   = parseFloat(row['السُّلف المصروفة (د.ك)'] || row['السلف'] || 0);
      const payDate    = String(row['تاريخ الدفع'] || monthEndDate(month)).trim();
      const payMethod  = String(row['طريقة الدفع'] || 'تحويل بنكي').trim();

      const payment = {
        id, doctor, month, commission, advances, net,
        payDate, payMethod,
        revenue:   parseFloat(row['إجمالي الإيرادات (د.ك)'] || 0),
        labDeduct: parseFloat(row['خصومات المختبر (د.ك)'] || 0),
        insDeduct: parseFloat(row['خصومات التأمين (د.ك)'] || 0),
        notes:     String(row['ملاحظات'] || ''),
        createdAt: new Date().toISOString()
      };
      if (net > 0) {
        // P0.2: كان يرحّل عمولة الطبيب على 5400 (مرافق — كهرباء وماء، حساب
        // غير ذي صلة) — الحساب الصحيح هو 5100 (المستخدم فعلاً لعمولات
        // الأطباء في مسار الدفع الآخر /api/commission/pay).
        const je = {
          id: `JE-DPAY-${Date.now()}-${i}`,
          date: payDate,
          description: `عمولة ${doctor} — ${month}`,
          // P0.6B (P6-017): explicit totals at write time (see the matching
          // fix in /api/import/expenses above for the full rationale).
          totalDebit: commission, totalCredit: commission,
          lines: [
            { accountCode: '5100', debit: commission, credit: 0 },
            { accountCode: cashAcc, debit: 0, credit: net },
            ...(advances > 0 ? [{ accountCode: '1200', debit: 0, credit: advances }] : [])
          ],
          source: 'import-doctor-payments',
          createdAt: new Date().toISOString()
        };
        try {
          appendJournalEntry(db, je);
        } catch (e) {
          if (!(e instanceof JournalValidationError)) throw e;
          errors.push(`سطر ${i+2}: ${e.message}`);
          return;
        }
      }
      db.doctorPayments.push(payment);
      created.push(doctor);
    });

    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, { created: created.length, errors }, null, null);
    await saveDB(db, { durable: true });
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, created: created.length, errors });
  } catch(e) {
    if (idemRecord) { try { await releaseIdempotencyClaim(loadDB(), isMongo, idemRecord); } catch (_) {} }
    // R4 (Part P): XLSX.readFile(req.file.path) wraps fs.readFileSync — a
    // missing/corrupt upload throws Node's raw upload-path error text.
    console.error('❌ Doctor-payments import error:', e.message);
    res.status(500).json({ success: false, error: 'تعذّر استيراد ملف مدفوعات الدكاترة — تأكد من الملف وحاول مرة أخرى' });
  }
});

// ── IMPORT: قيود جماعية ───────────────────────────────────────────────────
// P0.11 (saveDB call-site audit): converted to durable-before-ack.
// P0.12 (closes P6-097 — the pre-existing 'reference' dedup check below was
// found by the forensic inventory to be field-mismatched and functionally
// ineffective against a genuine re-upload; layered here without removing
// it, per Part G's "don't remove a weaker-but-real domain guard" rule).
app.post('/api/import/bulk-journal', requireAuth, tenantMiddleware, requirePermission('journal', 'add'), upload.single('file'), async (req, res) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.removeSync(req.file.path);

    const db = loadDB();
    if (!db.journalEntries) db.journalEntries = [];

    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const fingerprint = computeFingerprint('import:bulk-journal', { rows });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'import:bulk-journal', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, ...claim.record.resultReference });
      }
      idemRecord = claim.record;
    }

    // Group rows by journal entry ID
    const groups = {};
    rows.forEach((row, i) => {
      const jeId   = String(row['رقم القيد (مشترك لسطور نفس القيد)'] || row['رقم القيد'] || '').trim();
      const date   = String(row['التاريخ'] || '').trim();
      const desc   = String(row['الوصف'] || '').trim();
      const acct   = String(row['رقم الحساب'] || '').trim();
      const debit  = parseFloat(row['مدين (د.ك)'] || row['مدين'] || 0);
      const credit = parseFloat(row['دائن (د.ك)'] || row['دائن'] || 0);
      if (!jeId || !date || !acct) return;
      if (!groups[jeId]) groups[jeId] = { id: jeId, date, description: desc, lines: [], reference: String(row['مرجع'] || ''), notes: String(row['ملاحظات'] || '') };
      groups[jeId].lines.push({ accountCode: acct, debit, credit });
    });

    // P0.2 — Step 13: validate every group in the uploaded file BEFORE
    // committing any of them. A single bad journal id in the spreadsheet
    // used to still import all the other, valid ones — now it's all-or-none.
    const candidates = Object.values(groups)
      .filter(je => db.journalEntries.findIndex(e => e.reference === je.id) < 0)
      .map(je => ({ ...je, id: `JE-IMP-${je.id}-${Date.now()}`, source: 'import-bulk-journal', createdAt: new Date().toISOString() }));

    const { valid, invalid } = validateJournalBatch(db, candidates);
    if (invalid.length) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(400).json({
        success: false,
        created: 0,
        total: Object.keys(groups).length,
        errors: invalid.map(x => `قيد ${x.entry.reference}: ${x.error}`),
        error: `تعذّر استيراد الملف — ${invalid.length} من ${candidates.length} قيداً غير صالح. لم يُستورد أي قيد.`,
      });
    }

    valid.forEach(entry => db.journalEntries.push(entry));
    const resultRef = { created: valid.length, total: Object.keys(groups).length, errors: [] };
    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, resultRef, null, null);
    await saveDB(db, { durable: true });
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, ...resultRef });
  } catch(e) {
    if (idemRecord) { try { await releaseIdempotencyClaim(loadDB(), isMongo, idemRecord); } catch (_) {} }
    // R4 (Part P): XLSX.readFile(req.file.path) wraps fs.readFileSync — a
    // missing/corrupt upload throws Node's raw upload-path error text.
    console.error('❌ Bulk-journal import error:', e.message);
    res.status(500).json({ success: false, error: 'تعذّر استيراد ملف القيود — تأكد من الملف وحاول مرة أخرى' });
  }
});

// ── IMPORT: أرصدة المرضى الافتتاحية ─────────────────────────────────────
// P0.3A — same prepare/validate/commit, all-or-nothing pattern as the
// inventory-opening import above (Steps 3/4).
// P0.11 (saveDB call-site audit): converted to durable-before-ack.
app.post('/api/import/patient-opening', requireAuth, requireAdminAction('import.patient_opening'), upload.single('file'), async (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.removeSync(req.file.path);

    const db = loadDB();
    const settings = db.accountingSettings || {};
    const errors = [];
    const created = [];
    let total = 0;
    const jeLines = [];
    const pendingRecords = []; // staged patientAR records — not pushed to db yet

    rows.forEach((row, i) => {
      const name   = String(row['اسم المريض'] || '').trim();
      const amount = parseFloat(row['المبلغ المستحق (د.ك)'] || row['المبلغ'] || 0);
      const date   = String(row['التاريخ الافتتاحي'] || new Date().toISOString().split('T')[0]).trim();
      if (!name || !amount) { errors.push(`سطر ${i+2}: اسم أو مبلغ ناقص`); return; }

      const id = `PAT-AR-${Date.now()}-${i}`;
      pendingRecords.push({
        id, name,
        fileNo:     String(row['رقم الملف'] || ''),
        date, amount,
        insurance:  String(row['نوع التأمين'] || 'نقدي'),
        insCompany: String(row['شركة التأمين'] || ''),
        notes:      String(row['ملاحظات'] || ''),
        isOpening:  true,
        createdAt:  new Date().toISOString()
      });

      const arAcc = settings.accReceivable || '1200';
      jeLines.push({ accountCode: arAcc, debit: amount, credit: 0 });
      total += amount;
      created.push(name);
    });

    // Step 4 — whole-batch: ANY invalid source row rejects the entire batch.
    if (errors.length) {
      return res.status(400).json({ success: false, created: 0, totalAmount: 0, errors,
        error: `تعذّر استيراد الملف — ${errors.length} سطر غير صالح. لم يُستورد أي سطر (الدفعة كاملة أو لا شيء).` });
    }

    // P0.9 — Part F/Step 19: `accountingSettings.accReceivable` is a
    // user-configurable account code — validateJournalEntry's Invariant E
    // will catch a MISSING account, but a configured code that resolves to
    // the WRONG account type (e.g. an expense account mistakenly set as the
    // patient-AR account) would still validate successfully and silently
    // misclassify every opening balance. Checked once here, before any
    // per-row line was even built into a real journal attempt.
    if (jeLines.length > 0) {
      const arAccResolved = (db.chartOfAccounts || []).find(a => String(a.code) === String(settings.accReceivable || '1200'));
      if (!arAccResolved) {
        return res.status(400).json({ success: false, created: 0, totalAmount: 0, errors: [],
          error: `حساب الذمم المدينة المُعرَّف (${settings.accReceivable || '1200'}) غير موجود في شجرة الحسابات`, code: 'CONFIGURED_ACCOUNT_MISSING' });
      }
      if (arAccResolved.type !== 'asset') {
        return res.status(400).json({ success: false, created: 0, totalAmount: 0, errors: [],
          error: `حساب الذمم المدينة المُعرَّف (${arAccResolved.code} — ${arAccResolved.name}) ليس حساب أصول (${arAccResolved.type}) — لا يصلح كحساب ذمم مدينة`, code: 'CONFIGURED_ACCOUNT_WRONG_TYPE' });
      }
    }

    if (jeLines.length > 0) {
      // Step 5 — duplicate-import guard: same deterministic ref every time.
      if ((db.journalEntries || []).some(j => j.ref === 'OB-PAT' || j.reference === 'OB-PAT')) {
        return res.status(409).json({ success: false, created: 0, totalAmount: 0, errors: [],
          error: 'تم استيراد أرصدة افتتاحية لذمم المرضى مسبقاً (OB-PAT) — لا يمكن إعادة الاستيراد لتفادي ازدواج الأرصدة.' });
      }
      const equityAcc = settings.accRetained || '3100';
      jeLines.push({ accountCode: equityAcc, debit: 0, credit: parseFloat(total.toFixed(3)) });
      const je = {
        id: `JE-PAT-OPEN-${Date.now()}`,
        date: new Date().toISOString().split('T')[0],
        description: `أرصدة افتتاحية — ذمم مرضى (${created.length} مريض)`,
        desc: `أرصدة افتتاحية — ذمم مرضى (${created.length} مريض)`,
        ref: 'OB-PAT', reference: 'OB-PAT',
        lines: jeLines,
        source: 'import-patient-opening',
        createdAt: new Date().toISOString()
      };
      const result = validateJournalEntry(db, je);
      if (!result.ok) {
        return res.status(result.status).json({ success: false, created: 0, totalAmount: 0, errors: [], error: result.error, code: result.code });
      }

      // Everything validated — commit patientAR records + journal together.
      if (!db.patientAR) db.patientAR = [];
      pendingRecords.forEach(r => db.patientAR.push(r));
      if (!db.journalEntries) db.journalEntries = [];
      db.journalEntries.push(je);
    }

    await saveDB(db, { durable: true });
    res.json({ success: true, created: created.length, totalAmount: parseFloat(total.toFixed(3)), errors: [] });
  } catch(e) {
    if (e instanceof JournalValidationError) return res.status(e.status).json({ success: false, error: e.message, code: e.code });
    // R4 (Part P): XLSX.readFile(req.file.path) wraps fs.readFileSync — a
    // missing/corrupt upload throws Node's raw upload-path error text.
    console.error('❌ Patient-opening import error:', e.message);
    res.status(500).json({ success: false, error: 'تعذّر استيراد ملف أرصدة المرضى — تأكد من الملف وحاول مرة أخرى' });
  }
});


// ═══════════════════════════════════════════════════════════════
//  AI AGENT  |  AI CFO  |  AI BANK RECONCILIATION
// ═══════════════════════════════════════════════════════════════
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse  = require('pdf-parse');
const multerPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });
// كشف البنك: يقبل CSV و Excel (التحقق من الامتداد داخل المعالج ليعطي رسالة واضحة بدل خطأ 500)
const uploadBank = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });

function buildFinancialSnapshot(db) {
  const now       = new Date();
  const thisMonth = now.toISOString().substring(0,7);
  const lastMonth = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().substring(0,7);
  const expenses  = db.expenses   || [];
  const coa       = db.chartOfAccounts || [];
  const entries   = db.journalEntries || [];

  // Revenue from journal entries (credit side of accounts starting with '4')
  const isRevAcc = (accountId) => {
    const acc = coa.find(a => a.id === accountId || a.code === accountId);
    return acc ? acc.code.startsWith('4') : (String(accountId).startsWith('4'));
  };
  const isExpAcc = (accountId) => {
    const acc = coa.find(a => a.id === accountId || a.code === accountId);
    return acc ? acc.code.startsWith('5') : (String(accountId).startsWith('5'));
  };

  const rev = m => entries
    .filter(e => e.date && e.date.startsWith(m))
    .reduce((s, e) => s + (e.lines||[]).filter(l => isRevAcc(l.accountId) && (l.credit||0) > 0)
      .reduce((ss, l) => ss + (l.credit||0), 0), 0);

  const expFromJournals = m => entries
    .filter(e => e.date && e.date.startsWith(m))
    .reduce((s, e) => s + (e.lines||[]).filter(l => isExpAcc(l.accountId) && (l.debit||0) > 0)
      .reduce((ss, l) => ss + (l.debit||0), 0), 0);

  const exp = m => {
    const fromExpenses = expenses.filter(e=>e.date&&e.date.startsWith(m)).reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
    const fromJournals = expFromJournals(m);
    // Use whichever source has data; prefer journals if both exist to avoid double-count
    return fromJournals > 0 ? fromJournals : fromExpenses;
  };

  const tmRev = rev(thisMonth), lmRev = rev(lastMonth);
  const tmExp = exp(thisMonth), lmExp = exp(lastMonth);
  const tmNet = tmRev - tmExp, lmNet = lmRev - lmExp;

  const dayOfMonth  = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const projRev     = dayOfMonth > 0 ? (tmRev / dayOfMonth) * daysInMonth : 0;
  const projProfit  = projRev - tmExp;

  const expByCategory = {};
  // Build expense-by-category from journal entries (debit side of expense accounts)
  entries.filter(e=>e.date&&e.date.startsWith(thisMonth)).forEach(entry => {
    (entry.lines||[]).filter(l => isExpAcc(l.accountId) && (l.debit||0) > 0).forEach(l => {
      const acc = coa.find(a => a.id === l.accountId);
      const cat = acc?.name || l.accountName || 'أخرى';
      expByCategory[cat] = (expByCategory[cat]||0) + (l.debit||0);
    });
  });
  // Fallback to raw expenses if no journal entries for this month
  if (!Object.keys(expByCategory).length) {
    expenses.filter(e=>e.date&&e.date.startsWith(thisMonth)).forEach(e => {
      const cat = e.category || 'أخرى';
      expByCategory[cat] = (expByCategory[cat]||0) + (parseFloat(e.amount)||0);
    });
  }

  const drRevMap = {};
  const daily = db.dailyData || [];
  daily.forEach(d => { if(d.doctor){ drRevMap[d.doctor]=(drRevMap[d.doctor]||0)+(parseFloat(d.total)||0); } });

  const avgDailyExp = dayOfMonth > 0 ? tmExp / dayOfMonth : 0;

  return {
    thisMonth, lastMonth,
    revenue:  { thisMonth: tmRev, lastMonth: lmRev, change: lmRev>0?((tmRev-lmRev)/lmRev*100):0, projected: projRev },
    expenses: { thisMonth: tmExp, lastMonth: lmExp, change: lmExp>0?((tmExp-lmExp)/lmExp*100):0, byCategory: expByCategory },
    profit:   { thisMonth: tmNet, lastMonth: lmNet, projected: projProfit },
    doctors:  drRevMap,
    avgDailyExpense:    avgDailyExp,
    pendingInsurance:   (db.insuranceClaims||[]).filter(c=>c.status==='pending').reduce((s,c)=>s+(parseFloat(c.amount)||0),0),
    lowStock:           (db.invItems||[]).filter(i=>(parseFloat(i.quantity||i.qty)||0) <= (parseFloat(i.minQuantity||i.minQty)||0)).length,
    totalJournalEntries:(db.journalEntries||[]).length,
    daysInMonth, dayOfMonth
  };
}

// ─── 1. AI ACCOUNTANT AGENT ────────────────────────────────────
// ─── AI MEMORY helpers ─────────────────────────────────────────
function getRelevantMemories(db, command) {
  const mems = db.aiMemory || [];
  if (!mems.length) return [];
  const words = command.toLowerCase().split(/\s+/);
  return mems
    .filter(m => {
      const triggers = (m.trigger||'').toLowerCase().split(',').map(t=>t.trim());
      return triggers.some(t => t && words.some(w => w.includes(t) || t.includes(w)));
    })
    .sort((a,b) => (b.count||0)-(a.count||0))
    .slice(0, 8);
}

function buildMemoryBlock(memories) {
  if (!memories.length) return '';
  return '\n\nذاكرة التعلم (قرارات المحاسب السابقة — اتبعها دائماً):\n' +
    memories.map(m => `• "${m.trigger}" → ${m.field==='category'?'فئة: '+m.to : m.field+': '+m.to} (استُخدم ${m.count} مرة)`).join('\n');
}

// ─── AI AGENT core (shared between preview & execute) ──────────
async function callAgentAI(command, db) {
  const snap = buildFinancialSnapshot(db);
  const coa  = (db.chartOfAccounts||[]).filter(a=>a.status!=='inactive')
                 .map(a=>`${a.code} — ${a.name} (${a.type})`).join('\n');
  const today = new Date().toISOString().split('T')[0];
  const memories = getRelevantMemories(db, command);
  const memBlock = buildMemoryBlock(memories);

  const systemPrompt = `أنت وكيل محاسبي ذكي لعيادة أسنان بوبيان الكويت. العملة: KWD (د.ك).
حلل أمر المستخدم وخطط لتنفيذه.

شجرة الحسابات المتاحة:
${coa.substring(0,2000)}

البيانات الحالية (${snap.thisMonth}):
- الإيرادات: ${snap.revenue.thisMonth.toFixed(3)} د.ك
- المصاريف: ${snap.expenses.thisMonth.toFixed(3)} د.ك
- صافي الربح: ${snap.profit.thisMonth.toFixed(3)} د.ك${memBlock}

أعد فقط JSON (لا نص خارجه):
{
  "understanding": "فهمت الأمر: ...",
  "actions": [
    {
      "type": "add_expense",
      "data": { "id": "exp-AGT-TS", "date": "${today}", "amount": 0, "category": "...", "description": "...", "vendor": "...", "paymentMethod": "نقد" }
    },
    {
      "type": "add_journal",
      "data": {
        "id": "JE-AGT-TS", "date": "${today}", "description": "...", "reference": "AGT-TS",
        "lines": [ { "accountCode": "...", "accountName": "...", "debit": 0, "credit": 0 } ]
      }
    }
  ],
  "summary": "سأقوم بـ: ...",
  "details": ["تفصيل 1", "تفصيل 2"]
}
استبدل TS برقم timestamp. القيود يجب أن تكون متوازنة (debit = credit).`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 2048,
    system: systemPrompt, messages: [{ role:'user', content: command }]
  });
  const raw = msg.content[0].text.trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('لم يتمكن الوكيل من فهم الأمر');
  return JSON.parse(m[0]);
}

// P0.4A — Step 3: the AI agent can propose actions across several domains
// (expenses/journal/manual/vendors) but the route above is only gated on the
// single "ai" tab. Without this map, a custom role granted ai:add but NOT
// e.g. journal:add could use the agent to post journal entries it could
// never post directly — an RBAC bypass. Every action type here is checked
// against the SAME per-domain permission its equivalent direct route
// requires, using the one hasPermission() engine — not a second model.
const AGENT_ACTION_PERMISSION = {
  add_expense:   ['expenses', 'add'],
  add_journal:   ['journal',  'add'],
  add_daily:     ['manual',   'add'],
  update_vendor: ['vendors',  'edit'],
};

function executePlan(plan, db, user) {
  const ts = Date.now();
  const results = [];
  for (const action of (plan.actions||[])) {
    const d = action.data || {};
    const fixId = id => (id||'').toString().replace('TS', ts);
    const perm = AGENT_ACTION_PERMISSION[action.type];
    if (perm && user && !hasPermission(user, perm[0], perm[1], db)) {
      results.push({ action: action.type, label: 'مرفوض', denied: true, reason: 'صلاحياتك لا تشمل هذا الإجراء' });
      continue;
    }
    if (action.type === 'add_expense') {
      // P0.6A — Step 16 (P6-058): route through the exact same
      // buildAndPostExpense() service POST /api/expenses uses — full
      // balance/account-existence/period-lock validation via
      // appendJournalEntry(), never a bare db.expenses.push(). Throws (and
      // aborts the whole plan, same as add_journal below) on any rejection
      // — no orphan expense record can be created here anymore.
      // Field-name bridge: the AI plan schema historically produced
      // `description`/`category` (this action's own pre-existing result
      // fields prove it: `description:d.description, category:d.category`
      // below), while the HTTP API/buildAndPostExpense use `desc`/`cat` —
      // accept either. `date` defaults to today if the AI didn't supply
      // one (matching a human quickly logging "today's" expense via chat).
      const result = buildAndPostExpense(db, {
        date: d.date || new Date().toISOString().slice(0, 10),
        desc: d.desc || d.description,
        cat: d.cat || d.category,
        amount: d.amount, vendor: d.vendor,
        payMethod: d.payMethod || d.payMethodCode || 'cash', notes: d.notes,
        accountCode: d.accountCode, accountId: d.accountId, accountName: d.accountName,
        payMethodCode: d.payMethodCode, vendorId: d.vendorId, vendorAccountId: d.vendorAccountId,
      });
      results.push({ action:'add_expense', label:'مصروف', description:result.expense.desc, amount:result.expense.amount, category:result.expense.cat, vendor:result.expense.vendor, journalId: result.journalId });
    }
    if (action.type === 'add_journal') {
      // P0.2 — Step 12: an AI-proposed journal entry gets exactly the same
      // accounting validation as a manually-typed one before it's persisted.
      // The AI can suggest; appendJournalEntry decides whether it's valid.
      const je = Object.assign({}, d, { id: fixId(d.id)||('JE-AGT-'+ts), source:'AI-Agent', createdAt: new Date().toISOString() });
      if (je.lines) je.lines = je.lines.map(l=>Object.assign({},l,{debit:parseFloat(l.debit)||0,credit:parseFloat(l.credit)||0}));
      appendJournalEntry(db, je);
      results.push({ action:'add_journal', label:'قيد محاسبي', description:d.description, lines:d.lines });
    }
    if (action.type === 'add_daily') {
      // P0.6A — Step 17 (P6-059): route through the exact same
      // buildAndPostManualIncome() service POST /api/manual-entry uses —
      // an AI-created daily-income record now gets a real revenue journal
      // entry, exactly like the manual/UI equivalent, instead of a bare
      // db.dailyData.push() with no ledger impact at all.
      const result = buildAndPostManualIncome(db, d);
      results.push({ action:'add_daily', label:'إيراد يومي', amount:result.entry.total });
    }
    if (action.type === 'update_vendor') {
      const v = (db.vendors||[]).find(x=>x.name===d.name||x.id===d.id);
      if (v) { Object.assign(v,d); results.push({ action:'update_vendor', label:'مورد', name:d.name }); }
    }
  }
  return results;
}

// ─── 1a. AGENT PREVIEW (no DB write) ──────────────────────────
app.post('/api/ai/agent/preview', requireAuth, requirePermission('ai', 'view'), rateLimit(20), async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  try {
    const db   = loadDB();
    const plan = await callAgentAI(command, db);
    res.json({ success: true, plan, command });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── 1b. AGENT EXECUTE (approved plan) ────────────────────────
app.post('/api/ai/agent/execute', requireAuth, requirePermission('ai', 'add'), rateLimit(20), async (req, res) => {
  const { plan, command, corrections } = req.body;
  if (!plan || !plan.actions) return res.status(400).json({ error: 'plan required' });
  try {
    const db = loadDB();
    // Apply any user corrections to the plan before executing
    if (corrections && corrections.length) {
      corrections.forEach(c => {
        plan.actions.forEach(a => {
          if (a.data && c.field in a.data) a.data[c.field] = c.newValue;
        });
      });
    }
    const results = executePlan(plan, db, req.user);
    appendAuditEvent(db, { req, action: 'ai_agent.executed', resourceType: 'aiAgent', after: { command, actionsCount: results.length } });
    saveDB(db);
    // Auto-learn: if corrections were made, store them as memories
    if (corrections && corrections.length && command) {
      db.aiMemory = db.aiMemory || [];
      corrections.forEach(c => {
        const existing = db.aiMemory.find(m => m.trigger===c.trigger && m.field===c.field);
        if (existing) { existing.to=c.newValue; existing.count=(existing.count||0)+1; existing.lastUsed=new Date().toISOString().split('T')[0]; }
        else db.aiMemory.push({ id:'mem-'+Date.now()+'-'+Math.random().toString(36).substring(2,6), trigger:c.trigger, field:c.field, from:c.oldValue, to:c.newValue, count:1, learnedFrom:command, lastUsed:new Date().toISOString().split('T')[0], createdAt:new Date().toISOString().split('T')[0] });
      });
      saveDB(db);
    }
    res.json({ success:true, summary:plan.summary, details:plan.details||[], results, actionsCount:results.length });
  } catch(e) {
    if (e instanceof JournalValidationError) return res.status(e.status).json({ success:false, error:e.message, code:e.code });
    res.status(500).json({ success:false, error:e.message });
  }
});

// ─── 1c. AGENT (legacy — direct execute, no approval) ─────────
app.post('/api/ai/agent', requireAuth, requirePermission('ai', 'add'), rateLimit(20), async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  try {
    const db      = loadDB();
    const plan    = await callAgentAI(command, db);
    const results = executePlan(plan, db, req.user);
    appendAuditEvent(db, { req, action: 'ai_agent.executed', resourceType: 'aiAgent', after: { command, actionsCount: results.length } });
    saveDB(db);
    res.json({ success:true, understanding:plan.understanding, summary:plan.summary, details:plan.details||[], results, actionsCount:results.length });
  } catch(e) {
    if (e instanceof JournalValidationError) return res.status(e.status).json({ success:false, error:e.message, code:e.code });
    res.status(500).json({ success:false, error:e.message });
  }
});

// ─── AI MEMORY CRUD ────────────────────────────────────────────
app.get('/api/ai/memory', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.aiMemory || []);
});

app.post('/api/ai/memory', requireAuth, (req, res) => {
  const { trigger, field, from, to } = req.body;
  if (!trigger || !field || !to) return res.status(400).json({ error: 'trigger, field, to required' });
  const db = loadDB();
  db.aiMemory = db.aiMemory || [];
  const existing = db.aiMemory.find(m => m.trigger===trigger && m.field===field);
  if (existing) {
    existing.to = to; existing.count = (existing.count||0)+1;
    existing.lastUsed = new Date().toISOString().split('T')[0];
    saveDB(db); return res.json({ success:true, updated:true, memory:existing });
  }
  const mem = { id:'mem-'+Date.now(), trigger, field, from:from||'', to, count:1, createdAt:new Date().toISOString().split('T')[0], lastUsed:new Date().toISOString().split('T')[0] };
  db.aiMemory.push(mem);
  saveDB(db);
  res.json({ success:true, updated:false, memory:mem });
});

app.delete('/api/ai/memory/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const before = (db.aiMemory||[]).length;
  db.aiMemory = (db.aiMemory||[]).filter(m => m.id !== req.params.id);
  if (db.aiMemory.length === before) return res.status(404).json({ error: 'not found' });
  saveDB(db);
  res.json({ success:true });
});

// Record a manual correction (called when user edits AI output)
app.post('/api/ai/memory/correct', requireAuth, (req, res) => {
  const { trigger, field, oldValue, newValue, command } = req.body;
  if (!trigger || !field || !newValue) return res.status(400).json({ error: 'trigger, field, newValue required' });
  const db = loadDB();
  db.aiMemory = db.aiMemory || [];
  const existing = db.aiMemory.find(m => m.trigger===trigger && m.field===field);
  if (existing) {
    existing.to = newValue; existing.from = oldValue||existing.from;
    existing.count = (existing.count||0)+1;
    existing.lastUsed = new Date().toISOString().split('T')[0];
  } else {
    db.aiMemory.push({ id:'mem-'+Date.now(), trigger, field, from:oldValue||'', to:newValue, count:1, learnedFrom:command||'', createdAt:new Date().toISOString().split('T')[0], lastUsed:new Date().toISOString().split('T')[0] });
  }
  saveDB(db);
  res.json({ success:true, memoriesCount:(db.aiMemory||[]).length });
});

// ─── 2. AI CFO ─────────────────────────────────────────────────
app.post('/api/ai/cfo', requireAuth, requirePermission('financials', 'view'), rateLimit(10), async (req, res) => {
  const db   = loadDB();
  const snap = buildFinancialSnapshot(db);
  const daily    = db.dailyData || [];
  const expenses = db.expenses  || [];
  const now      = new Date();

  // Last 6 months trend
  const months = [];
  for (let i=5; i>=0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const m = d.toISOString().substring(0,7);
    const r = daily.filter(x=>x.date&&x.date.startsWith(m)).reduce((s,x)=>s+(parseFloat(x.total)||0),0);
    const e = expenses.filter(x=>x.date&&x.date.startsWith(m)).reduce((s,x)=>s+(parseFloat(x.amount)||0),0);
    months.push({ month: m, revenue: r, expenses: e, profit: r-e });
  }

  const avgDailyRev  = snap.dayOfMonth>0 ? snap.revenue.thisMonth / snap.dayOfMonth : 0;
  const dailyNet     = avgDailyRev - snap.avgDailyExpense;
  const liquidityDays = dailyNet < 0 ? Math.round(snap.revenue.thisMonth / Math.abs(dailyNet)) : 999;

  const salaryExp = expenses.filter(e=>e.date&&e.date.startsWith(snap.thisMonth)&&(e.category||'').includes('راتب'))
    .reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  const salaryPct = snap.revenue.thisMonth > 0 ? (salaryExp/snap.revenue.thisMonth*100) : 0;

  const topExp = Object.entries(snap.expenses.byCategory).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const alerts = [];
  if (snap.revenue.change < -10) alerts.push({ level:'danger', msg: 'الإيرادات انخفضت '+Math.abs(snap.revenue.change).toFixed(1)+'% عن الشهر الماضي' });
  if (salaryPct > 35) alerts.push({ level:'warning', msg: 'الرواتب '+salaryPct.toFixed(1)+'% من الإيرادات — أعلى من المعدل الصحي (35%)' });
  if (liquidityDays < 45 && liquidityDays < 999) alerts.push({ level:'danger', msg: 'مشكلة سيولة محتملة خلال '+liquidityDays+' يوم' });
  if (snap.pendingInsurance > 1000) alerts.push({ level:'warning', msg: snap.pendingInsurance.toFixed(3)+' د.ك تأمين معلق يحتاج متابعة' });
  if (snap.lowStock > 0) alerts.push({ level:'info', msg: snap.lowStock+' صنف وصل للحد الأدنى في المخزون' });
  if (snap.profit.projected > snap.profit.lastMonth) alerts.push({ level:'success', msg: 'توقع: ربح الشهر الحالي سيتجاوز الشهر الماضي بـ '+(snap.profit.projected - snap.profit.lastMonth).toFixed(3)+' د.ك' });

  const metrics = { months, snap, liquidityDays, salaryPct, salaryExp, topExp, alerts,
    projectedRevenue: snap.revenue.projected, projectedProfit: snap.profit.projected };

  if (!process.env.ANTHROPIC_API_KEY) return res.json({ success: true, metrics, narrative: null });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: 'أنت CFO ذكي لعيادة أسنان. اكتب تحليلاً مالياً مختصراً ودقيقاً باللغة العربية (5-7 جمل). ركز على: أبرز رقم، أكبر خطر، أهم توصية. لا تعيد الأرقام فقط — حللها.',
      messages: [{ role:'user', content: JSON.stringify(metrics) }]
    });
    res.json({ success: true, metrics, narrative: msg.content[0].text });
  } catch(e) {
    res.json({ success: true, metrics, narrative: null, aiError: e.message });
  }
});

// ─── 3. AI BANK RECONCILIATION ─────────────────────────────────
app.post('/api/ai/bank-recon', requireAuth, requireAdminAction('bank.ai_reconcile'), multerPdf.single('pdf'), rateLimit(5), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });

  let bankText = req.body.bankText || '';

  if (req.file) {
    try {
      const parsed = await pdfParse(req.file.buffer);
      bankText = parsed.text;
    } catch(e) {
      return res.status(400).json({ error: 'فشل قراءة PDF: ' + e.message });
    }
  }

  if (!bankText.trim()) return res.status(400).json({ error: 'لم يتم إرسال بيانات البنك' });

  const db = loadDB();
  const coa = (db.chartOfAccounts||[]).map(a=>a.code+'|'+a.name+'|'+a.type).join('\n');
  const recentJE = (db.journalEntries||[]).slice(-50).map(je =>
    je.date+'|'+je.description+'|'+((je.lines||[]).reduce((s,l)=>s+(l.debit||0),0)).toFixed(3)
  ).join('\n');

  const systemPrompt = `أنت محاسب متخصص في مطابقة البنك. العملة: KWD.

شجرة الحسابات:
${coa.substring(0,1500)}

القيود المحاسبية الأخيرة:
${recentJE.substring(0,1000)}

مهمتك:
1. استخرج كل عملية من كشف البنك (تاريخ، وصف، مبلغ، نوع: دائن/مدين)
2. طابق كل عملية مع القيود الموجودة إن أمكن
3. للعمليات غير المطابقة أنشئ قيوداً مقترحة

أعد JSON فقط:
{
  "bankTransactions": [
    { "date":"YYYY-MM-DD", "description":"...", "amount":0, "type":"debit|credit", "matched":true, "matchedJE":"id أو null" }
  ],
  "unmatched": [
    { "date":"YYYY-MM-DD", "description":"...", "amount":0, "type":"debit|credit" }
  ],
  "suggestedJournalEntries": [
    { "date":"YYYY-MM-DD", "description":"...", "lines":[{"accountCode":"...","accountName":"...","debit":0,"credit":0}] }
  ],
  "summary": {
    "totalTransactions":0, "matched":0, "unmatched":0,
    "totalDebits":0, "totalCredits":0, "reconStatus":"متوافق|فروقات موجودة"
  }
}`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role:'user', content: 'كشف الحساب البنكي:\n\n'+bankText.substring(0,6000) }]
    });

    const raw = msg.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ success: false, error: 'فشل تحليل كشف البنك', raw: raw.substring(0,200) });

    const result = JSON.parse(jsonMatch[0]);
    res.json(Object.assign({ success: true }, result));
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ① AI SMART ENTRY — نص عربي حر → قيد محاسبي مقترح
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/ai/suggest-entry', requireAuth, requirePermission('journal', 'add'), rateLimit(20), async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text مطلوب' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });

  const db  = loadDB();
  const coa = (db.chartOfAccounts || [])
    .filter(a => !a.isGroup && a.status !== 'inactive')
    .map(a => `${a.code}|${a.name}|${a.type}`)
    .join('\n');
  const today = new Date().toISOString().slice(0, 10);

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: `أنت محاسب قانوني للكويت متخصص في القيد المزدوج. العملة: KWD. اليوم: ${today}.
دليل الحسابات:\n${coa}\nقواعد: القيد يجب أن يتوازن. أعد JSON فقط لا شرح.`,
      messages: [{ role: 'user', content: `حوّل هذا النص لقيد محاسبي: "${text}"
أعد JSON:
{"date":"YYYY-MM-DD","description":"...","type":"...","confidence":0.0,"lines":[{"accountCode":"","accountName":"","debit":0,"credit":0}],"notes":"","ambiguous":false}` }]
    });

    const raw   = msg.content[0]?.text || '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'لم يتمكن الذكاء الاصطناعي من فهم النص' });

    const suggestion = JSON.parse(match[0]);
    const coaMap = {};
    (db.chartOfAccounts || []).forEach(a => { coaMap[a.code] = a; });
    const validated = (suggestion.lines || []).map(l => ({
      ...l,
      accountName: coaMap[l.accountCode]?.name || l.accountName,
      valid:  !!coaMap[l.accountCode],
      debit:  parseFloat(l.debit)  || 0,
      credit: parseFloat(l.credit) || 0,
    }));
    const totalDr = validated.reduce((s, l) => s + l.debit,  0);
    const totalCr = validated.reduce((s, l) => s + l.credit, 0);

    res.json({
      success: true,
      suggestion: { ...suggestion, lines: validated },
      balanced:    Math.abs(totalDr - totalCr) < 0.005,
      totalDebit:  parseFloat(totalDr.toFixed(3)),
      totalCredit: parseFloat(totalCr.toFixed(3)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ai/confirm-entry', requireAuth, requirePermission('ai', 'add'), (req, res) => {
  const { suggestion, originalText } = req.body;
  if (!suggestion?.lines) return res.status(400).json({ error: 'suggestion مطلوب' });

  const db    = loadDB();
  const lines = (suggestion.lines || []).map(l => ({
    accountId:   l.accountCode,
    accountCode: l.accountCode,
    accountName: l.accountName,
    debit:  parseFloat(l.debit)  || 0,
    credit: parseFloat(l.credit) || 0,
  }));
  const totalDebit  = parseFloat(lines.reduce((s, l) => s + l.debit,  0).toFixed(3));
  const totalCredit = parseFloat(lines.reduce((s, l) => s + l.credit, 0).toFixed(3));

  const je = {
    id: 'JE-AI-' + Date.now(),
    date: suggestion.date || new Date().toISOString().slice(0, 10),
    desc: suggestion.description,
    ref: 'AI-SMART',
    type: suggestion.type || 'ai_entry',
    source: 'ai_smart_entry',
    originalText: originalText || '',
    confidence: suggestion.confidence || 0,
    totalDebit, totalCredit,
    lines,
    createdAt: new Date().toISOString(),
  };

  // P0.2 — Step 12: full accounting validation (balance/account-existence/
  // period-lock), not just the balance check this route used to do alone.
  appendJournalEntry(db, je);
  appendAuditEvent(db, { req, action: 'ai_entry.confirmed', resourceType: 'journal', resourceId: je.id, after: { totalDebit, totalCredit, desc: je.desc } });
  saveDB(db);
  res.json({ success: true, journalEntry: je });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② ANOMALY ENGINE — كشف الشذوذ على كل قيد محاسبي
// ═══════════════════════════════════════════════════════════════════════════
function detectAnomalies(je, db) {
  const flags = [];
  const allJE = db.journalEntries || [];
  // P0.6B — Step 1/2 (P6-017): compute from `lines` via the shared
  // jeAmounts() helper rather than trusting je.totalDebit directly — Excel
  // import routes (POST /api/import/expenses, /api/import/doctor-payments)
  // build valid, balanced `lines` but historically never set totalDebit on
  // the entry itself, so every rule below that keys off `amt` (duplicate,
  // round-number, outlier) was silently neutered (amt always 0) for those
  // entries, not merely mis-displayed.
  const amt   = jeAmounts(je).debit;
  const date  = je.date || '';

  // Duplicate: same amount + same date
  const dupes = allJE.filter(x =>
    x.id !== je.id &&
    Math.abs(jeAmounts(x).debit - amt) < 0.001 &&
    x.date === date
  );
  if (dupes.length)
    flags.push({ code: 'DUPLICATE', severity: 'high', msg: `مبلغ مكرر (${amt} د.ك) في نفس التاريخ — قيد #${dupes[0].id}` });

  // Round number
  if (amt >= 500 && amt % 100 === 0)
    flags.push({ code: 'ROUND_NUMBER', severity: 'medium', msg: `مبلغ مستدير كبير (${amt} د.ك) — يستحق المراجعة` });

  // Statistical outlier (>mean+3σ over last 90 days)
  const recent = allJE
    .filter(x => x.date >= new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10))
    .map(x => jeAmounts(x).debit).filter(v => v > 0);
  if (recent.length >= 10) {
    const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
    const std  = Math.sqrt(recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length);
    if (amt > mean + 3 * std)
      flags.push({ code: 'OUTLIER', severity: 'high', msg: `مبلغ خارج النطاق — يتجاوز المتوسط بـ ${((amt - mean) / std).toFixed(1)}σ` });
  }

  // Backdated into locked period
  const period = date.slice(0, 7);
  if ((db.lockedPeriods || {})[period])
    flags.push({ code: 'LOCKED_PERIOD', severity: 'high', msg: `تاريخ في فترة مقفلة (${period})` });

  // Weekend entry
  const day = new Date(date).getDay();
  if (day === 5 || day === 6)
    flags.push({ code: 'WEEKEND', severity: 'low', msg: `قيد بتاريخ ${day === 5 ? 'جمعة' : 'سبت'}` });

  // Unbalanced
  const { debit: dr, credit: cr } = jeAmounts(je);
  if (Math.abs(dr - cr) > 0.005)
    flags.push({ code: 'UNBALANCED', severity: 'critical', msg: `قيد غير متوازن! مدين ${dr.toFixed(3)} ≠ دائن ${cr.toFixed(3)}` });

  return flags;
}

// P0.6B — Step 28 (NEW-B / P6-070): the ONE shared anomaly-computation
// function — GET /api/anomalies AND the Telegram daily-summary report
// (buildDailySummaryText(), below) both call this instead of either
// duplicating the scan or (as the Telegram path previously did) reading
// the dead `db.anomalies` field that nothing in this codebase ever writes.
function computeAnomalies(db) {
  const result = [];
  const sev = { critical: 4, high: 3, medium: 2, low: 1 };
  (db.journalEntries || []).forEach(je => {
    const flags = detectAnomalies(je, db);
    // P0.6B (P6-017): expose the same lines-derived amount detectAnomalies()
    // itself just used, not the possibly-missing raw je.totalDebit field —
    // this is what the dashboard displayed as "0.000" for Excel-imported
    // entries.
    if (flags.length) result.push({ je: { id: je.id, date: je.date, desc: je.desc, totalDebit: jeAmounts(je).debit }, flags });
  });
  result.sort((a, b) => Math.max(...b.flags.map(f => sev[f.severity] || 0)) - Math.max(...a.flags.map(f => sev[f.severity] || 0)));
  return result;
}

// P0.10 (P6-047): no control anywhere previously flagged a cash/bank account
// going negative — accounting-impossible for a physical cash drawer or an
// unarranged current account, and a strong signal of a missing receipt, a
// double-counted withdrawal, or a data-entry error. This is a single
// whole-ledger balance check (not per-entry — computeAnomalies() above
// already scans every journal entry once; adding a second O(n) balance
// walk per entry there would be O(n²) for no benefit), so it lives as its
// own function and is exposed as an additive field on GET /api/anomalies
// rather than folded into the per-entry anomaly list, since a
// negative-balance alert is a ledger-wide fact, not something caused by (or
// traceable to) any single journal entry.
const CASH_BANK_BALANCE_ACCOUNTS = [
  { code: '1100', label: 'الصندوق (نقدي)' },
  { code: '1110', label: 'البنك — الحساب الجاري' },
];
function detectNegativeBalanceAccounts(db) {
  const coa = db.chartOfAccounts || [];
  const balances = {};
  CASH_BANK_BALANCE_ACCOUNTS.forEach(({ code }) => {
    const acc = coa.find(a => String(a.code) === code);
    balances[code] = (parseFloat(acc?.openingDebit) || 0) - (parseFloat(acc?.openingCredit) || 0);
  });
  (db.journalEntries || []).forEach(je => {
    (je.lines || []).forEach(l => {
      const lineAcc = String(l.accountCode != null ? l.accountCode : l.account);
      if (Object.prototype.hasOwnProperty.call(balances, lineAcc)) {
        balances[lineAcc] += (parseFloat(l.debit) || 0) - (parseFloat(l.credit) || 0);
      }
    });
  });
  const alerts = [];
  CASH_BANK_BALANCE_ACCOUNTS.forEach(({ code, label }) => {
    const balance = parseFloat((balances[code] || 0).toFixed(3));
    if (balance < -0.005) {
      alerts.push({ code: 'NEGATIVE_CASH_BALANCE', severity: 'critical', accountCode: code, accountLabel: label, balance, msg: `رصيد ${label} (${code}) سالب: ${balance.toFixed(3)} د.ك — غير ممكن محاسبياً، يستدعي مراجعة فورية` });
    }
  });
  return alerts;
}

app.get('/api/anomalies', requireAuth, requirePermission('journal', 'view'), (req, res) => {
  const db     = loadDB();
  const result = computeAnomalies(db);
  const balanceAlerts = detectNegativeBalanceAccounts(db);
  res.json({ total: result.length, anomalies: result.slice(0, 100), balanceAlerts });
});

app.post('/api/anomalies/dismiss', requireAuth, requirePermission('journal', 'edit'), (req, res) => {
  const { jeId, code } = req.body;
  const db = loadDB();
  if (!db.dismissedAnomalies) db.dismissedAnomalies = [];
  db.dismissedAnomalies.push({ jeId, code, dismissedAt: new Date().toISOString() });
  appendAuditEvent(db, { req, action: 'anomaly.dismissed', resourceType: 'journal', resourceId: jeId, after: { code } });
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/journal/check-anomaly', requireAuth, requirePermission('journal', 'add'), (req, res) => {
  const { je } = req.body;
  if (!je) return res.status(400).json({ error: 'je مطلوب' });
  const db    = loadDB();
  const flags = detectAnomalies(je, db);
  res.json({ flags, count: flags.length, safe: !flags.some(f => f.severity !== 'low') });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ PIFSS + END-OF-SERVICE — وفق قانون العمل الكويتي
// ═══════════════════════════════════════════════════════════════════════════
// P0.10 adversarial-review fix (P1 regression finding): P6-074's employee-
// delete fix introduced a persistent status:'inactive' state for employees
// with payroll history (soft-delete instead of physical removal, so
// db.payroll[]'s free-text name references keep resolving to a real
// record). Before that fix, "deleted" always meant physically removed —
// every consumer of db.employees[] automatically excluded terminated
// staff. The four PIFSS/EOS aggregation sites below (eos-run, hr-summary,
// close/run-all's PIFSS step, close/run-all's EOS step) never filtered on
// status and are untouched by this milestone's scope otherwise — but they
// would now keep summing a terminated employee's PIFSS employer share and
// EOS monthly accrual into every future period's real posted journal
// entry, forever. One shared filter closes the gap without touching the
// PIFSS/EOS formulas themselves (explicitly out of scope for this
// milestone).
function activeEmployeesOnly(employees) {
  return (employees || []).filter(e => (e.status || 'active') !== 'inactive');
}

function calcPifssForEmployee(emp) {
  const basic     = parseFloat(emp.basicSalary) || 0;
  const isKuwaiti = !!(emp.pifssEnrolled || (emp.nationality || '').includes('كويتي'));
  const rates     = isKuwaiti ? { employee: 0.11, employer: 0.115 } : { employee: 0, employer: 0 };
  return {
    basic, isKuwaiti,
    employeeShare: parseFloat((basic * rates.employee).toFixed(3)),
    employerShare: parseFloat((basic * rates.employer).toFixed(3)),
    total: parseFloat((basic * (rates.employee + rates.employer)).toFixed(3)),
  };
}

// P0.6B — Step 16/17 (P6-034): the ONE canonical EOS calculation — both
// POST /api/payroll/eos-run and /api/close/run-all's EOS step call this
// same function (via `.monthly`), so there was never a second divergent
// engine to unify; the single defect was isolated to `accumulated` below.
//
// This system's own already-implemented policy (confirmed from THIS
// function's own pre-existing `annualDays` selection, not invented): the
// first 5 years of service accrue at a 15-days-of-basic-salary-per-year
// rate; every year beyond 5 accrues at 30-days-per-year (a full month's
// salary per year) — the standard Kuwaiti Labour Law Art. 51 structure this
// codebase was already built against (see the pre-existing `annualDays`
// branch and P0.2's PIFSS/EOS account-mapping comments elsewhere in this
// file). `monthly` (the figure actually posted in every real monthly
// accrual journal, via /api/close/run-all and /api/payroll/eos-run) always
// applied the CORRECT marginal rate for the month it ran in — proven
// unaffected. `accumulated` (an informational lifetime-entitlement
// snapshot, not itself posted to any journal) was the one defect: it
// reused `annualDays` — already switched to 30 for any employee past the
// 5-year mark — for the FIRST-5-YEARS term too, instead of the fixed 15.
// Concrete proof from the gap register's own worked example, reproduced
// here: basic=1,000, years=8 -> OLD accumulated = 1000/30*30*5 + 1000*3 =
// 8,000 (wrong, treats all 8 years at the 30-day rate) vs the CORRECT
// 1000/30*15*5 + 1000*3 = 5,500 (first 5 years at 15-day rate, remaining 3
// at 30-day rate) — a ~45% overstatement for any employee past 5 years.
function calcEosForEmployee(emp) {
  if (!emp.hireDate) return { monthly: 0, accumulated: 0, years: 0 };
  const years       = Math.max(0, (Date.now() - new Date(emp.hireDate)) / (365.25 * 864e5));
  const basic       = parseFloat(emp.basicSalary) || 0;
  const annualDays  = years <= 5 ? 15 : 30;
  const monthly     = parseFloat((basic / 30 * annualDays / 12).toFixed(3));
  // FIXED: the first-5-years term now always uses the fixed 15-day rate,
  // never the (possibly-already-30) `annualDays` variable above.
  const accumulated = parseFloat((basic / 30 * 15 * Math.min(years, 5) + (years > 5 ? basic * (years - 5) : 0)).toFixed(3));
  return { monthly, accumulated, years: parseFloat(years.toFixed(2)) };
}

app.post('/api/payroll/eos-run', requireAuth, requirePermission('payroll', 'add'), (req, res) => {
  const { month } = req.body;
  if (!month) return res.status(400).json({ error: 'month مطلوب' });
  const db  = loadDB();
  const ref = `EOS-${month}`;
  if ((db.journalEntries || []).some(j => j.ref === ref))
    return res.status(409).json({ error: `تم احتساب EOS لشهر ${month} مسبقاً` });

  const details = [];
  let total = 0;
  activeEmployeesOnly(db.employees).forEach(emp => {
    const e = calcEosForEmployee(emp);
    if (e.monthly <= 0) return;
    details.push({ name: emp.name || emp.id, basicSalary: emp.basicSalary, years: e.years, monthly: e.monthly, accumulated: e.accumulated });
    total += e.monthly;
  });
  if (!details.length) return res.json({ success: true, message: 'لا توجد مستحقات — تأكد من تسجيل تاريخ التعيين', details: [] });

  total = parseFloat(total.toFixed(3));
  // P0.2: كان يرحّل على 5260 (غير موجود) و2300 (إيجار مستحق — تصادم دلالي) —
  // الآن حسابا EOS المخصّصان (lib/coaCodes.js eosAccounts، بذاتية الشفاء).
  const { eosAccounts } = require('./lib/coaCodes');
  const accs = db.chartOfAccounts || [];
  const ea   = eosAccounts(accs);
  db.chartOfAccounts = accs;
  const je = {
    id: 'JE-EOS-' + Date.now(), date: month + '-01', desc: `مخصص نهاية الخدمة ${month}`,
    ref, type: 'end_of_service', totalDebit: total, totalCredit: total,
    createdAt: new Date().toISOString(),
    lines: [
      { accountId: ea.expense.id,   accountCode: ea.expense.code,   accountName: ea.expense.name,   debit: total, credit: 0 },
      { accountId: ea.liability.id, accountCode: ea.liability.code, accountName: ea.liability.name, debit: 0, credit: total },
    ],
  };
  appendJournalEntry(db, je);
  appendAuditEvent(db, { req, action: 'payroll.eos_run', resourceType: 'journal', resourceId: je.id, after: { month, totalMonthly: total, employeeCount: details.length } });
  saveDB(db);
  res.json({ success: true, month, details, totalMonthly: total, journalEntry: je });
});

app.put('/api/employees/:id/hr', requireAuth, requirePermission('payroll', 'edit'), (req, res) => {
  const db  = loadDB();
  const emp = (db.employees || []).find(e => String(e.id) === String(req.params.id));
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });
  const { hireDate, nationality, basicSalary, pifssEnrolled, position } = req.body;
  if (hireDate !== undefined)       emp.hireDate       = hireDate;
  if (nationality !== undefined)    emp.nationality    = nationality;
  if (basicSalary !== undefined)    emp.basicSalary    = parseFloat(basicSalary) || emp.basicSalary;
  if (pifssEnrolled !== undefined)  emp.pifssEnrolled  = pifssEnrolled;
  if (position !== undefined)       emp.position       = position;
  saveDB(db);
  res.json({ success: true, employee: emp, pifss: calcPifssForEmployee(emp), eos: calcEosForEmployee(emp) });
});

app.get('/api/payroll/hr-summary', requireAuth, requirePermission('payroll', 'view'), (req, res) => {
  const db   = loadDB();
  const emps = activeEmployeesOnly(db.employees).map(emp => ({ ...emp, pifss: calcPifssForEmployee(emp), eos: calcEosForEmployee(emp) }));
  res.json({
    employees: emps,
    totals: {
      pifssEmployer:   parseFloat(emps.reduce((s, e) => s + e.pifss.employerShare, 0).toFixed(3)),
      pifssEmployee:   parseFloat(emps.reduce((s, e) => s + e.pifss.employeeShare, 0).toFixed(3)),
      eosMonthly:      parseFloat(emps.reduce((s, e) => s + e.eos.monthly,         0).toFixed(3)),
      eosAccumulated:  parseFloat(emps.reduce((s, e) => s + e.eos.accumulated,     0).toFixed(3)),
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ MONTH-END CLOSE — إقفال شهري كامل بزر واحد
// ═══════════════════════════════════════════════════════════════════════════
// P0.12 — Part G note: deliberately NOT wrapped with the generic
// Idempotency-Key layer. This route is 5 independently-guarded
// sub-operations (depreciation's own ALREADY_RUN check, PIFSS-<month> ref,
// EOS-<month> ref, the shared CLOSE-<month> ref via
// computeAndPostClosingEntry(), and the top-level `lockedPeriods[month]`
// check that short-circuits the ENTIRE route once locked) bundled behind
// one convenience button, not one atomic logical command — a single
// request/response fingerprint doesn't model "3 of 5 steps already landed,
// retry should complete the other 2" as well as the current design already
// does: every step self-heals independently on retry via its own ref
// check, which is exactly the P6-097-safe behavior this milestone requires.
// /api/closing-entry (the actual closing-entry operation, shared by this
// route's own STEP 4) IS wrapped — see its own P0.12 comment above.
app.post('/api/close/run-all', requireAuth, requireAdminAction('period.close'), async (req, res, next) => {
  // P0.6A — Step 3 (P6-066): this is the highest-value single batch
  // financial mutation in the app (up to 4 journal entries + the period
  // lock, in one call) — it previously used the plain debounced saveDB(db)
  // (crash window between the 200 response and the actual write) AND, as
  // an async handler with no outer try/catch, a bare `throw` from any of
  // its internal steps (the same Express-4-does-not-auto-catch-async-
  // rejections issue P0.5A fixed for 8 other routes) would have hung the
  // request forever instead of reaching the global error middleware.
  try {
  const { month, options = {} } = req.body;
  if (!month) return res.status(400).json({ error: 'month مطلوب (YYYY-MM)' });

  const db  = loadDB();
  const log = [];
  const step = (id, label, status, detail = '') =>
    log.push({ id, label, status, detail, ts: new Date().toISOString() });

  if ((db.lockedPeriods || {})[month])
    return res.status(409).json({ error: `الفترة ${month} مقفلة بالفعل`, log });

  // R5 (staging validation, adversarial review — P0, live-reproduced twice
  // independently on fresh virgin periods): this route never checked its
  // own readiness checklist (GET /api/month-close/:period) before posting
  // depreciation/PIFSS/EOS/closing entries and permanently locking the
  // period — a period with ZERO real transactions, ZERO cash/bank
  // reconciliations, ZERO expenses, and ZERO payroll could still be closed
  // and locked, producing a closing entry fabricated ENTIRELY from the
  // auto-generated adjustments themselves (confirmed live: "صافي خسارة
  // 902.833 د.ك" exactly equal to 60+494.5+348.333, i.e. no real revenue or
  // expense ever existed for that month) — the single highest-stakes
  // accounting action in the app, with no guard at all.
  //
  // Deliberately NOT "require the full 10-item checklist" — 3 of its 10
  // steps (accruals/depreciation/financials) are manual-only by design
  // (auto:false, GET /api/month-close/:period) and can never be satisfied
  // by this one-button automated route on their own; requiring full
  // completion would make /api/close/run-all permanently unusable, which is
  // a much larger, unrequested redesign, not a bug fix. Instead: block only
  // the exact demonstrated case — a period with NONE of the 6 automatically-
  // verifiable activity signals present at all — and require an explicit,
  // named acknowledgement to proceed anyway (a real edge case, e.g. closing
  // a genuinely inactive shell period for administrative continuity, stays
  // possible, but can no longer happen silently/accidentally).
  if (!options.confirmEmptyClose) {
    const hasActivity =
      (db.dailyData || []).some(d => (d.date || '').startsWith(month)) ||
      (db.cashReconciliation || []).some(c => (c.period || '').startsWith(month)) ||
      (db.bankRecons || []).some(b => (b.period || '').startsWith(month)) ||
      (db.expenses || []).some(e => (e.date || '').startsWith(month)) ||
      (db.payroll || []).some(p => (p.period || '').startsWith(month)) ||
      (db.journalEntries || []).some(j => (j.date || '').startsWith(month));
    if (!hasActivity) {
      return res.status(409).json({
        success: false,
        error: `لا توجد أي حركة فعلية مسجَّلة لشهر ${month} (لا مبيعات، لا مصاريف، لا رواتب، لا تسويات، لا قيود) — إقفاله سينشئ قيد إقفال وهمي من التسويات التلقائية فقط دون أي نشاط حقيقي وراءه. إن كنت متأكداً أن هذا مقصود، أعد الإرسال مع options.confirmEmptyClose:true.`,
        code: 'EMPTY_PERIOD_CLOSE_BLOCKED',
        log: [],
      });
    }
  }

  if (!db.journalEntries) db.journalEntries = [];

  // STEP 1: Depreciation
  // P0.10 — Part B (P6-045): delegates to the ONE canonical
  // depreciateActiveAssets() (defined near /api/assets/depreciate above) —
  // no second, divergent depreciation calculation maintained here anymore
  // (previously had different rounding, the wrong journal-line key, and no
  // idempotency guard of its own — this route's guard is now shared, not
  // duplicated).
  if (options.depreciation !== false) {
    try {
      const result = depreciateActiveAssets(db, month);
      if (result.status === 'skipped') {
        const detail = { ALREADY_RUN: 'تم مسبقاً', NO_ACTIVE_ASSETS: 'لا أصول ثابتة', NOTHING_TO_DEPRECIATE: 'لا أصول تستحق اهتلاكاً' }[result.reason] || result.reason;
        step('depreciation','قيد الإهلاك','skipped',detail);
      } else {
        // P0.10 — Part M/Step 38: the forensic map found zero appendAuditEvent
        // calls anywhere in this route, including for depreciation — added
        // here specifically (in scope for this milestone's fixed-asset
        // domain), not as a full audit overhaul of PIFSS/EOS/closing too.
        appendAuditEvent(db, { req, action: 'asset.depreciation_run', resourceType: 'journal', resourceId: result.journalEntry.id, after: { period: month, totalDep: result.totalDep, assetsCount: result.assetsCount } });
        step('depreciation','قيد الإهلاك','done',`${result.totalDep.toFixed(3)} د.ك`);
      }
    } catch (e) {
      if (!(e instanceof JournalValidationError)) throw e;
      step('depreciation','قيد الإهلاك','error', e.message);
    }
  }

  // STEP 2: PIFSS
  if (options.pifss !== false) {
    const pifssRef = `PIFSS-${month}`;
    if (db.journalEntries.some(j => j.ref === pifssRef)) { step('pifss','PIFSS','skipped','تم مسبقاً'); }
    else {
      let tot = 0;
      activeEmployeesOnly(db.employees).forEach(e => { tot += calcPifssForEmployee(e).employerShare; });
      tot = parseFloat(tot.toFixed(3));
      if (tot > 0) {
        // P0.2: كان يرحّل على 5250 (غير موجود) و2200 (رواتب مستحقة — حساب مختلف
        // الغرض) — الآن حسابا PIFSS المخصّصان (lib/coaCodes.js pifssAccounts).
        const { pifssAccounts } = require('./lib/coaCodes');
        const accs = db.chartOfAccounts||[];
        const pa = pifssAccounts(accs);
        db.chartOfAccounts = accs;
        try {
          appendJournalEntry(db, { id:'JE-PIFSS-'+Date.now(), date:month+'-01', desc:`PIFSS ${month}`, ref:pifssRef, type:'pifss', totalDebit:tot, totalCredit:tot, createdAt:new Date().toISOString(), lines:[{accountId:pa.expense.id,accountCode:pa.expense.code,accountName:pa.expense.name,debit:tot,credit:0},{accountId:pa.payable.id,accountCode:pa.payable.code,accountName:pa.payable.name,debit:0,credit:tot}] });
          step('pifss','PIFSS التأمينات','done',`${tot.toFixed(3)} د.ك`);
        } catch (e) {
          if (!(e instanceof JournalValidationError)) throw e;
          step('pifss','PIFSS التأمينات','error', e.message);
        }
      } else { step('pifss','PIFSS','skipped','لا موظفون كويتيون'); }
    }
  }

  // STEP 3: EOS
  if (options.eos !== false) {
    const eosRef = `EOS-${month}`;
    if (db.journalEntries.some(j => j.ref === eosRef)) { step('eos','نهاية الخدمة','skipped','تم مسبقاً'); }
    else {
      let tot = 0;
      activeEmployeesOnly(db.employees).forEach(e => { tot += calcEosForEmployee(e).monthly; });
      tot = parseFloat(tot.toFixed(3));
      if (tot > 0) {
        // P0.2: كان يرحّل على 5260 (غير موجود) و2300 (إيجار مستحق — تصادم
        // دلالي) — الآن حسابا EOS المخصّصان (lib/coaCodes.js eosAccounts).
        const { eosAccounts } = require('./lib/coaCodes');
        const accs  = db.chartOfAccounts||[];
        const ea = eosAccounts(accs);
        db.chartOfAccounts = accs;
        try {
          appendJournalEntry(db, { id:'JE-EOS-'+Date.now(), date:month+'-01', desc:`نهاية الخدمة ${month}`, ref:eosRef, type:'end_of_service', totalDebit:tot, totalCredit:tot, createdAt:new Date().toISOString(), lines:[{accountId:ea.expense.id,accountCode:ea.expense.code,accountName:ea.expense.name,debit:tot,credit:0},{accountId:ea.liability.id,accountCode:ea.liability.code,accountName:ea.liability.name,debit:0,credit:tot}] });
          step('eos','مخصص نهاية الخدمة','done',`${tot.toFixed(3)} د.ك`);
        } catch (e) {
          if (!(e instanceof JournalValidationError)) throw e;
          step('eos','مخصص نهاية الخدمة','error', e.message);
        }
      } else { step('eos','نهاية الخدمة','skipped','لا تواريخ تعيين'); }
    }
  }

  // STEP 4: Closing Entry
  // P0.6B — Step 21 (P6-044): delegates to the ONE canonical
  // computeAndPostClosingEntry() (defined above, near /api/closing-entry)
  // — no second, divergent close calculation maintained here anymore.
  if (options.closing !== false) {
    try {
      const result = computeAndPostClosingEntry(db, month);
      step('closing', 'قيد الإقفال', result.status, result.detail);
    } catch (e) {
      if (!(e instanceof JournalValidationError)) throw e;
      step('closing', 'قيد الإقفال', 'error', e.message);
    }
  }

  // STEP 5: Lock period
  if (options.lock !== false) {
    if (!db.lockedPeriods) db.lockedPeriods = {};
    const wasLocked = !!db.lockedPeriods[month];
    db.lockedPeriods[month] = true;
    step('lock','قفل الفترة','done',`${month} مقفلة الآن`);
    // R5 (staging validation, reproduced live): this was the ONLY path that
    // ever sets lockedPeriods[month]=true without an audit-trail entry — the
    // standalone POST /api/period-lock route (server.js, ~line 5023) logs
    // 'period.locked' via appendAuditEvent, but locking a period through
    // month-end close (the path a real accountant actually uses, per this
    // route's own "إقفال شهري كامل بزر واحد" framing) left zero audit trace
    // of one of the most consequential financial-control actions in the
    // system (IAS 8 period immutability) — confirmed via GET /api/audit-log
    // ?action=period.locked returning total:0 despite 3 real closes in this
    // staging run. Mirrors the standalone route's own event shape.
    appendAuditEvent(db, {
      req, action: 'period.locked', resourceType: 'period', resourceId: month,
      before: { locked: wasLocked }, after: { locked: true }, metadata: { source: 'close.run_all' },
    });
  }

  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for close.run_all:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ إغلاق الشهر بشكل دائم — قد يكون بعض الخطوات لم يُحفَظ، حاول مرة أخرى', log });
  }
  const done    = log.filter(s => s.status === 'done').length;
  const skipped = log.filter(s => s.status === 'skipped').length;
  res.json({ success: true, month, log, summary: `${done} خطوة منجزة، ${skipped} متخطاة`, locked: options.lock !== false });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SECTION: FIX LAYER — Remarks, AI-Learn, COA-Next-Code, File-Delete,
//          Accrued-Expenses, Advanced Reports
// ══════════════════════════════════════════════════════════════════════════

// ── COA: suggest next available account code under a prefix/parent ─────────
app.get('/api/coa/next-code', requireAuth, requirePermission('coa', 'view'), (req, res) => {
  const db  = loadDB();
  const coa = db.chartOfAccounts || [];
  const { prefix, parent } = req.query;
  const { suggestChildCode } = require('./lib/coaCodes');

  // Resolve the base code we're generating a child under
  let baseCode = null;
  if (parent) {
    const p = coa.find(a => a.id === parent || a.code === parent);
    if (!p) return res.json({ nextCode: '' });
    baseCode = String(p.code);
  } else if (prefix) {
    baseCode = String(prefix);
  } else {
    return res.json({ nextCode: '' });
  }

  // حتى لو كانت المجموعة ممتلئة — ينزل تلقائياً لمجموعة فرعية (مثل 5910 تحت 5900)
  const s = suggestChildCode(baseCode, coa);
  if (!s) return res.json({ nextCode: '' });
  const under = coa.find(a => String(a.code) === s.parentCode);
  res.json({ nextCode: s.code, cascaded: s.cascaded, under: s.parentCode, underId: under ? String(under.id || under.code) : s.parentCode, underName: under ? under.name : '' });
});

// ── JOURNAL: AI-Learn from correction ──────────────────────────────────────
app.post('/api/journal/learn', requireAuth, requirePermission('journal', 'add'), (req, res) => {
  const db = loadDB();
  const { originalEntry, correctedEntry, reason } = req.body;
  if (!originalEntry || !correctedEntry) return res.status(400).json({ error: 'originalEntry و correctedEntry مطلوبان' });

  if (!db.journalMappings) db.journalMappings = [];

  // Detect what changed
  const changes = [];
  const origLines = originalEntry.lines || [];
  const corrLines = correctedEntry.lines || [];

  // Compare line-by-line
  corrLines.forEach((cl, i) => {
    const ol = origLines[i];
    if (!ol) {
      changes.push({ type: 'line_added', lineIdx: i, accountCode: cl.accountCode, accountName: cl.accountName });
      return;
    }
    if (ol.accountCode !== cl.accountCode)
      changes.push({ type: 'account_changed', lineIdx: i, from: ol.accountCode, to: cl.accountCode, fromName: ol.accountName, toName: cl.accountName });
    if (Math.abs((ol.debit||0)-(cl.debit||0)) > 0.001 || Math.abs((ol.credit||0)-(cl.credit||0)) > 0.001)
      changes.push({ type: 'amount_changed', lineIdx: i, accountCode: cl.accountCode });
  });
  if (origLines.length > corrLines.length)
    changes.push({ type: 'lines_removed', fromCount: origLines.length, toCount: corrLines.length });

  const mapping = {
    id: 'JM-' + Date.now(),
    sourceType: originalEntry.type || 'unknown',
    sourceRef: originalEntry.ref || '',
    desc: originalEntry.desc || '',
    changes,
    reason: reason || '',
    correctedLines: corrLines.map(l => ({ accountCode: l.accountCode, accountName: l.accountName, side: l.debit > 0 ? 'debit' : 'credit' })),
    learnedAt: new Date().toISOString(),
    learnedBy: req.user?.username || 'user',
    useCount: 0,
  };

  // Update existing mapping for same type+desc or add new
  const existing = db.journalMappings.find(m => m.sourceType === mapping.sourceType && m.desc === mapping.desc);
  if (existing) {
    Object.assign(existing, mapping, { id: existing.id, useCount: (existing.useCount||0) + 1 });
  } else {
    db.journalMappings.push(mapping);
  }
  if (db.journalMappings.length > 500) db.journalMappings = db.journalMappings.slice(-500);

  // Also log to aiMemory if it exists (existing learning system)
  if (!db.aiMemory) db.aiMemory = [];
  changes.filter(c => c.type === 'account_changed').forEach(c => {
    const mem = db.aiMemory.find(m => m.trigger === mapping.desc && m.field === `line_${c.lineIdx}_account`);
    if (mem) { mem.to = c.to; mem.count = (mem.count||0)+1; }
    else db.aiMemory.push({ id:'mem-jl-'+Date.now()+'-'+c.lineIdx, trigger: mapping.desc, field: `line_${c.lineIdx}_account`, from: c.from, to: c.to, count:1, learnedFrom: 'journal_correction', createdAt: new Date().toISOString().slice(0,10), lastUsed: new Date().toISOString().slice(0,10) });
  });

  saveDB(db);
  res.json({ success: true, mappingId: mapping.id, changes });
});

// ── DELETE uploaded file record + its data ─────────────────────────────────
app.delete('/api/uploaded-files/:id', requireAuth, requirePermission('upload', 'delete'), (req, res) => {
  const db    = loadDB();
  const files = db.uploadedFiles || [];
  // Match by id or batchId; fall back to numeric index for legacy files uploaded before batchId system
  let idx = files.findIndex(f => f.id === req.params.id || f.batchId === req.params.id);
  if (idx === -1 && /^\d+$/.test(req.params.id)) {
    const i = parseInt(req.params.id, 10);
    if (i >= 0 && i < files.length) idx = i;
  }
  if (idx === -1) return res.status(404).json({ error: 'الملف غير موجود' });

  const file     = files[idx];
  const batchId  = file.batchId;
  let removed    = 0;

  // Always remove journal entries tagged with this batchId (covers JE-INC-* for daily, any future types)
  const jeBefore = (db.journalEntries||[]).length;
  if (batchId) {
    db.journalEntries = (db.journalEntries||[]).filter(e => e._batchId !== batchId);
  }
  // Also remove by month ref for daily files (covers legacy entries without _batchId)
  if (file.type === 'daily' && Array.isArray(file.months) && file.months.length) {
    const monthSet = new Set(file.months);
    db.journalEntries = (db.journalEntries||[]).filter(
      e => !(e.type === 'auto-income' && monthSet.has((e.ref||'').replace('INCOME-', '')))
    );
  }
  const jeRemoved = jeBefore - (db.journalEntries||[]).length;

  if (batchId) {
    if (file.type === 'daily') {
      const before = (db.dailyData||[]).length;
      db.dailyData = (db.dailyData||[]).filter(r => r._batchId !== batchId);
      removed = before - db.dailyData.length;
    } else if (file.type === 'payments') {
      const before = (db.paymentsData||[]).length;
      db.paymentsData = (db.paymentsData||[]).filter(r => r._batchId !== batchId);
      removed = before - db.paymentsData.length;
    } else if (file.type === 'expenses') {
      const before = (db.expenses||[]).length;
      db.expenses = (db.expenses||[]).filter(r => r._batchId !== batchId);
      removed = before - db.expenses.length;
    }
  }

  db.uploadedFiles.splice(idx, 1);
  saveDB(db);
  res.json({ success: true, removed, journalEntries: jeRemoved, file });
});

// ── ACCRUED EXPENSES (مصاريف مستحقة) ───────────────────────────────────────
app.get('/api/accrued-expenses', requireAuth, requirePermission('expenses', 'view'), (req, res) => {
  const db = loadDB();
  let list = db.accruedExpenses || [];
  if (req.query.status) list = list.filter(a => a.status === req.query.status);
  if (req.query.month)  list = list.filter(a => a.month === req.query.month);
  res.json({ accruedExpenses: list });
});

// P0.11 (saveDB call-site audit): converted to durable-before-ack.
app.post('/api/accrued-expenses', requireAuth, requirePermission('expenses', 'add'), async (req, res, next) => {
 try {
  const db = loadDB();
  if (!db.accruedExpenses) db.accruedExpenses = [];
  const { description, amount, month, accountCode, accountName, dueDate, vendor, notes } = req.body;
  if (!description || !amount || !month) return res.status(400).json({ error: 'الوصف والمبلغ والشهر مطلوبة' });
  // R5 (staging validation, adversarial review — P1, live-reproduced): this
  // route used to accept ANY/no accountCode and silently fall back (a few
  // lines down, via ensureAccount(db, accountCode||'5800', ...)) to account
  // 5800 — "إهلاك الأصول الثابتة" (Depreciation of Fixed Assets), a real,
  // sensitive, already-in-use expense line — for a caller who omitted the
  // field OR simply typed the wrong field name (e.g. `expenseAccountCode`
  // instead of `accountCode`; both produce the identical `undefined` the
  // server sees, so no server-side distinction between "intentionally
  // generic" and "typo" is possible). Confirmed live: this misfiled a real
  // accrual into the depreciation expense total with zero error, and the
  // assets-reconciliation report never catches it (it only checks 1510/1590,
  // never 5800). POST /api/vendor-bills already requires and validates every
  // allocation's accountCode with a clear 400 — mirrored here: accountCode
  // is now REQUIRED and must resolve to a real, expense-type COA account.
  if (!accountCode) {
    return res.status(400).json({ error: 'حساب المصروف (accountCode) مطلوب', code: 'MISSING_ACCOUNT' });
  }
  const accrExpAcc = (db.chartOfAccounts || []).find(a => a.code === accountCode || a.id === accountCode);
  if (!accrExpAcc) {
    return res.status(400).json({ error: `الحساب ${accountCode} غير موجود في شجرة الحسابات`, code: 'UNKNOWN_ACCOUNT' });
  }
  if (accrExpAcc.type !== 'expense') {
    return res.status(400).json({ error: `الحساب ${accountCode} (${accrExpAcc.name}) ليس حساب مصروف`, code: 'INCOMPATIBLE_ACCOUNT_TYPE' });
  }

  // P0.12 (closes P6-097)
  const isMongo = !isFileFallbackMode();
  const idemKey = extractIdempotencyKey(req);
  let idemRecord = null;
  if (idemKey) {
    const v = validateIdempotencyKey(idemKey);
    if (!v.ok) return res.status(400).json({ error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
    const fingerprint = computeFingerprint('accrued-expense:create', { description, amount: parseFloat(amount), month, accountCode, vendor });
    const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'accrued-expense:create', idemKey, fingerprint);
    if (!claim.claimed && claim.record.status === 'COMPLETED') {
      return res.json({ success: true, idempotentReplay: true, item: claim.record.resultReference });
    }
    idemRecord = claim.record;
  }

  const number = nextAccruedNo(db);
  const item = {
    id: 'ACR-' + Date.now(), number,
    description, month,
    amount: parseFloat(amount),
    paidAmount: 0,
    remaining: parseFloat(amount),
    payments: [],
    accountCode: accountCode || '2900',
    accountName: accountName || 'مصاريف مستحقة',
    dueDate: dueDate || '',
    vendor: vendor || '',
    notes: notes || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    createdBy: req.user?.username || 'user',
  };

  // Create journal entry: Dr Expense / Cr Accrued Liability
  const db2  = db;
  const coa  = db2.chartOfAccounts || [];
  const expAcc  = coa.find(a=>a.code===accountCode) || ensureAccount(db, accountCode||'5800', accountName||'مصاريف متنوعة', 'expense', '5000');
  // «مصاريف مستحقة» (2900) — أنشئه إن لم يوجد حتى يظهر في ميزان المراجعة ويتوازن
  const acrAcc  = ensureAccount(db, '2900', 'مصاريف مستحقة', 'liability', '2000');
  const amt     = parseFloat(amount);
  const jeId = 'JE-ACR-' + item.id;
  try {
    appendJournalEntry(db, {
      id: jeId, date: monthEndDate(month),
      desc: `مصروف مستحق — ${description} — ${month}`,
      ref: number, reference: number, type: 'accrued-expense',
      // R4 (Part C): accrued-expense JEs had no source tag at all.
      source: 'accrued-expense', sourceId: item.id, sourceModule: 'expenses',
      totalDebit: amt, totalCredit: amt,
      createdAt: new Date().toISOString(),
      autoGenerated: true,
      lines: [
        { accountId: expAcc.id, accountCode: expAcc.code, accountName: expAcc.name, debit: amt, credit: 0 },
        { accountId: acrAcc.id, accountCode: '2900',      accountName: acrAcc.name, debit: 0,  credit: amt },
      ],
    });
  } catch (mutErr) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    throw mutErr;
  }
  item.jeId = jeId;

  db.accruedExpenses.push(item);
  appendAuditEvent(db, { req, action: 'accrued_expense.created', resourceType: 'accruedExpense', resourceId: item.id, after: { description: item.description, amount: item.amount, month: item.month } });
  if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, item, item.id, jeId);
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for accrued_expense.created:', e.message);
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ المصروف المستحق بشكل دائم — حاول مرة أخرى' });
  }
  if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
  res.json({ success: true, item });
 } catch (err) {
  if (err instanceof JournalValidationError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  next(err);
 }
});

// P0.11 (saveDB call-site audit): converted to durable-before-ack.
app.put('/api/accrued-expenses/:id', requireAuth, requirePermission('expenses', 'edit'), async (req, res, next) => {
 try {
  const db  = loadDB();
  const idx = (db.accruedExpenses||[]).findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'السجل غير موجود' });
  const item = db.accruedExpenses[idx];
  const beforeItem = { status: item.status, paidAmount: item.paidAmount };
  const { status, paidDate, paidAmount, notes } = req.body;

  if (status === 'paid' && item.status !== 'paid') {
    // R3 — P6-023 fix: this branch used to post `parseFloat(paidAmount ||
    // item.amount)` with NO bound check at all — an over-settlement (e.g.
    // paidAmount:999999 on a 100-liability item) posted unguarded, and the
    // trailing `{ ...item, ...req.body }` mass-spread let the caller also
    // set `remaining`/`paidAmount` directly, bypassing even this branch.
    // Same total/remaining/payments[] bookkeeping as the sibling `/pay`
    // route (server.js:13254-13297) so the JE-delete-cascade reversal path
    // (which matches on `item.payments[].jeId`) can find this payment too.
    const total       = parseFloat(item.amount) || 0;
    const alreadyPaid = item.paidAmount != null ? (parseFloat(item.paidAmount) || 0) : 0;
    const remaining   = r3(total - alreadyPaid);
    const amt         = parseFloat(paidAmount != null ? paidAmount : remaining);
    if (!(amt > 0)) return res.status(400).json({ success:false, error: 'المبلغ مطلوب ويجب أن يكون رقماً موجباً' });
    if (amt > remaining + 0.001) {
      return res.status(400).json({ success:false, error: `المبلغ (${amt.toFixed(3)}) أكبر من المتبقي (${remaining.toFixed(3)} د.ك)`, code: 'OVERPAYMENT' });
    }

    const coa = db.chartOfAccounts || [];
    const acrAcc = ensureAccount(db, '2900', 'مصاريف مستحقة', 'liability', '2000');
    const cashAcc = coa.find(a=>a.code==='1100') || { id:'1100', code:'1100', name:'الصندوق' };
    const payRef = (item.number || item.id) + '-PAY';
    const jeId = 'JE-ACR-PAY-' + Date.now();
    appendJournalEntry(db, {
      id: jeId, date: paidDate || new Date().toISOString().slice(0,10),
      desc: `سداد مصروف مستحق — ${item.description}`,
      ref: payRef, reference: payRef, type: 'accrued-expense-payment',
      source: 'accrued-expense', sourceId: item.id, sourceModule: 'expenses',
      totalDebit: amt, totalCredit: amt,
      createdAt: new Date().toISOString(),
      lines: [
        { accountId: acrAcc.id, accountCode: '2900', accountName: acrAcc.name, debit: amt, credit: 0 },
        { accountId: cashAcc.id, accountCode: '1100', accountName: cashAcc.name, debit: 0, credit: amt },
      ],
    });
    item.payments = item.payments || [];
    item.payments.push({ amount: r3(amt), date: paidDate || new Date().toISOString().slice(0,10), account: '1100', accountName: cashAcc.name, checkNo: '', jeId });
    item.paidAmount = r3(alreadyPaid + amt);
    item.remaining  = r3(total - item.paidAmount);
    item.status     = item.remaining <= 0.001 ? 'paid' : 'partial';
  }

  // paidAmount/remaining are always server-computed, never client-supplied
  // (that mass-assignment was the actual P6-023 overpayment vector). status
  // is excluded too only when the paid-branch above just computed it —
  // otherwise a legitimate non-payment status change (e.g. reopening/
  // cancelling) must still pass through untouched, exactly as before.
  const enteredPaidBranch = status === 'paid' && beforeItem.status !== 'paid';
  const safeBody = { ...req.body };
  delete safeBody.paidAmount; delete safeBody.remaining;
  if (enteredPaidBranch) delete safeBody.status;
  // R4 adversarial-review fix (Accountant persona, CRITICAL): amount/month/
  // accountCode/accountName were NOT excluded here — only the frontend's
  // editAccrued() disabled those fields (public/index.html), a UI-only
  // restriction with no server-side enforcement. A direct PUT request
  // (bypassing the UI) could change the subledger amount/period/account
  // while the already-posted journal entry (created once, at accrual time,
  // never rebuilt by this route) kept its original values — silently
  // desyncing the subledger from the GL, exactly the failure mode this
  // route's own accompanying frontend comment claims is impossible.
  // Enforced server-side now, matching the one real caller's actual
  // contract: only description/dueDate/vendor/notes are safe to change
  // after the accrual JE has been posted.
  delete safeBody.amount; delete safeBody.month; delete safeBody.accountCode; delete safeBody.accountName;
  db.accruedExpenses[idx] = { ...item, ...safeBody, updatedAt: new Date().toISOString() };
  appendAuditEvent(db, { req, action: 'accrued_expense.updated', resourceType: 'accruedExpense', resourceId: item.id, before: beforeItem, after: { status: db.accruedExpenses[idx].status, paidAmount: db.accruedExpenses[idx].paidAmount } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for accrued_expense.updated:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التعديل بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true });
 } catch (err) {
  if (err instanceof JournalValidationError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  next(err);
 }
});

// دفعة جزئية على مصروف مستحق — تُسجّل قسطاً، تُنشئ قيده، وتحدّث المتبقي والحالة
// P0.11 (saveDB call-site audit — adversarial review finding): converted to
// durable-before-ack, matching the sibling POST/PUT routes on this resource.
app.post('/api/accrued-expenses/:id/pay', requireAuth, requirePermission('expenses', 'edit'), async (req, res, next) => {
 try {
  const db   = loadDB();
  const item = (db.accruedExpenses||[]).find(a => a.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'السجل غير موجود' });

  const amount     = parseFloat(req.body.amount);
  const payDate    = req.body.payDate || new Date().toISOString().slice(0,10);
  const payAccount = req.body.payAccount || '1100';
  const checkNo    = (req.body.checkNo || '').toString().trim();

  // P0.12 adversarial-review fix (P1, confirmed): claim BEFORE reading
  // item.paidAmount for the remaining-balance check below — in Mongo mode
  // the claim performs a real await (a genuine event-loop yield that did
  // not exist pre-P0.12), so two concurrent requests with DIFFERENT keys
  // could otherwise both read the same stale item.paidAmount, both pass the
  // remaining-balance check, and — since the mutation below writes
  // item.paidAmount from a LOCAL `alreadyPaid` snapshot rather than
  // re-reading item.paidAmount at write time — the second to run would
  // silently overwrite the first's already-applied payment (a genuine lost
  // update, not just a duplicated check). Claiming first restores full
  // synchronous atomicity for the read-check-mutate span below, exactly as
  // done for vendor-bills/:id/pay and patient-receivables/:id/collect.
  const isMongo = !isFileFallbackMode();
  const idemKey = extractIdempotencyKey(req);
  let idemRecord = null;
  if (idemKey) {
    const v = validateIdempotencyKey(idemKey);
    if (!v.ok) return res.status(400).json({ error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
    // P0.12 adversarial-review fix: date is deliberately excluded from this
    // fingerprint — same rationale as vendor-bill:pay above (a pre-existing
    // clientRef-only equality domain guard never treated date as part of
    // this operation's identity).
    const fingerprint = computeFingerprint('accrued-expense:pay', { id: req.params.id, amount: r3(amount || 0), payAccount: String(payAccount), checkNo });
    const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'accrued-expense:pay', idemKey, fingerprint);
    if (!claim.claimed && claim.record.status === 'COMPLETED') {
      return res.json({ success: true, idempotentReplay: true, item: claim.record.resultReference });
    }
    idemRecord = claim.record;
  }

  const total       = parseFloat(item.amount) || 0;
  // احسب المدفوع من السجل (مع دعم البيانات القديمة: مدفوع كامل إن كانت الحالة paid)
  const alreadyPaid = item.paidAmount != null
    ? (parseFloat(item.paidAmount) || 0)
    : (item.status === 'paid' ? total : 0);
  const remaining   = r3(total - alreadyPaid);

  if (!(amount > 0)) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    return res.status(400).json({ error: 'المبلغ مطلوب ويجب أن يكون رقماً موجباً' });
  }
  if (amount > remaining + 0.001) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    return res.status(400).json({ error: `المبلغ (${amount.toFixed(3)}) أكبر من المتبقي (${remaining.toFixed(3)} د.ك)` });
  }

  const coa    = db.chartOfAccounts || [];
  const acrAcc = ensureAccount(db, '2900', 'مصاريف مستحقة', 'liability', '2000');
  const payAcc = coa.find(a => String(a.id)===String(payAccount) || String(a.code)===String(payAccount))
                 || { id: payAccount, code: payAccount, name: payAccount };

  const seq     = (item.payments?.length || 0) + 1;
  const jeId    = 'JE-ACR-PAY-' + Date.now();
  const payRef  = (item.number || item.id) + '-PAY' + seq;
  const checkTag= checkNo ? ` — شيك #${checkNo}` : '';
  try {
    appendJournalEntry(db, {
      id: jeId, date: payDate,
      desc: `سداد مصروف مستحق — ${item.description} (قسط ${seq})${checkTag}`,
      ref: payRef, reference: payRef, type: 'accrued-expense-payment',
      totalDebit: r3(amount), totalCredit: r3(amount),
      createdAt: new Date().toISOString(),
      lines: [
        { accountId: acrAcc.id, accountCode: '2900',      accountName: acrAcc.name, debit: r3(amount), credit: 0 },
        { accountId: payAcc.id, accountCode: payAcc.code, accountName: payAcc.name, debit: 0, credit: r3(amount) },
      ],
    });

    item.payments   = item.payments || [];
    item.payments.push({ amount: r3(amount), date: payDate, account: payAcc.code, accountName: payAcc.name, checkNo, jeId });
    item.paidAmount = r3(alreadyPaid + amount);
    item.remaining  = r3(total - item.paidAmount);
    item.status     = item.remaining <= 0.001 ? 'paid' : 'partial';
    if (item.status === 'paid') item.paidDate = payDate;

    appendAuditEvent(db, { req, action: 'accrued_expense.paid', resourceType: 'accruedExpense', resourceId: item.id, after: { amount: r3(amount), status: item.status, remaining: item.remaining } });
    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, item, item.id, jeId);
  } catch (mutErr) {
    // P0.12 Part F Step 19 — a failure here means no financial mutation
    // actually landed; release the claim so it doesn't permanently block a
    // legitimate retry with the same key.
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    throw mutErr;
  }
  try {
    await saveDB(db, { durable: true });
  } catch (saveErr) {
    if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
    throw saveErr;
  }
  if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
  // R5 (staging validation, adversarial review — P1, same class as the
  // vendor-bill-payment fix above): non-blocking visibility only, no change
  // to accounting behavior — see that fix's comment for full rationale.
  const negAlert = (payAcc.code === '1100' || payAcc.code === '1110')
    ? detectNegativeBalanceAccounts(db).find(a => a.accountCode === payAcc.code)
    : null;
  res.json({ success: true, item, warning: negAlert ? negAlert.msg : undefined });
 } catch (err) {
  next(err);
 }
});

// P0.11 (saveDB call-site audit — adversarial review finding): converted to
// durable-before-ack.
app.delete('/api/accrued-expenses/:id', requireAuth, requirePermission('expenses', 'delete'), async (req, res, next) => {
 try {
  const db  = loadDB();
  const idx = (db.accruedExpenses||[]).findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'السجل غير موجود' });
  const item = db.accruedExpenses[idx];
  // احذف قيد الاستحقاق + كل قيود الدفعات المرتبطة (بالمعرّف أو بمرجع السداد)
  const payJeIds = new Set([item.jeId, ...((item.payments||[]).map(p => p.jeId))].filter(Boolean));
  const payRefPrefix = (item.number || item.id) + '-PAY';
  const linkedJEs = (db.journalEntries||[]).filter(e =>
    payJeIds.has(e.id) || (e.type === 'accrued-expense-payment' && String(e.ref||'').startsWith(payRefPrefix)));
  // P0.6A — Step 4 (P6-012): the accrual entry and every payment entry can
  // legitimately sit in different months — check the REAL date of every
  // journal entry this delete would remove (not just the accrued-expense
  // record's own metadata date) before removing any of them.
  assertFinancialPeriodOpen(db, linkedJEs.map(e => e.date));
  db.journalEntries = (db.journalEntries||[]).filter(e => !linkedJEs.includes(e));
  db.accruedExpenses.splice(idx, 1);
  appendAuditEvent(db, { req, action: 'accrued_expense.deleted', resourceType: 'accruedExpense', resourceId: item.id, before: { description: item.description, amount: item.amount } });
  await saveDB(db, { durable: true });
  res.json({ success: true });
 } catch (err) {
  next(err);
 }
});

// ── FINANCIAL REPORTS (P&L, Balance Sheet, Cash Flow, Budget) ──────────────
// P0.6A — Step 10/14 (P6-043): `excludeClosing` is the ONE shared switch
// every P&L-purpose caller (the operational income statement, in either
// implementation) must pass — a month/year-end closing transfer (type
// 'closing') nets that period's revenue/expense accounts to zero by
// design, so including it in an OPERATIONAL P&L for a range spanning that
// period silently cancels real activity. Trial Balance/General Ledger
// callers must NOT pass this — closing entries are real, permanent ledger
// postings and belong in those views (they are never deleted from the
// ledger — only excluded from this one specific report purpose).
function buildBalanceMap(db, fromDate, toDate, opts) {
  const excludeClosing = !!(opts && opts.excludeClosing);
  const balMap = {};
  for (const je of (db.journalEntries || [])) {
    if (fromDate && je.date < fromDate) continue;
    if (toDate   && je.date > toDate)   continue;
    if (excludeClosing && je.type === 'closing') continue;
    for (const ln of (je.lines || [])) {
      // P0.6A — Step 10: fall back to `ln.account` — most journal-line
      // builders in this codebase use `accountCode`, but a few (e.g. the
      // depreciation-posting route, POST /api/assets/depreciate) use the
      // older `account` key instead. validateJournalEntry() and every other
      // line-reader in this file already tolerate both; this shared helper
      // must too, or switching a caller over to it silently drops those
      // lines from every total (discovered via IS A while wiring
      // /api/financial-statements through this function for P6-043/051).
      const code = ln.accountCode || ln.account;
      if (!code) continue;
      if (!balMap[code]) balMap[code] = { debit: 0, credit: 0 };
      balMap[code].debit  += parseFloat(ln.debit  || 0);
      balMap[code].credit += parseFloat(ln.credit || 0);
    }
  }
  return balMap;
}

app.get('/api/reports/pnl', requireAuth, requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const { from, to } = req.query;
  // R5 (staging validation, adversarial review — P2, live-reproduced): a
  // reversed range (from > to) or non-date garbage in either param used to
  // silently return HTTP 200 with an all-zero P&L (`buildBalanceMap`'s date
  // filter never matches anything for a bogus/reversed bound), identical in
  // shape to "genuinely zero activity this period" — a mis-ordered date
  // picker or client bug could read as "we had zero income," a real
  // financial-statement misstatement risk, not just a cosmetic gap.
  const isValidDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
  if (from !== undefined && !isValidDate(from)) {
    return res.status(400).json({ error: `from غير صالح — يجب أن يكون بصيغة YYYY-MM-DD (القيمة المُرسَلة: ${from})` });
  }
  if (to !== undefined && !isValidDate(to)) {
    return res.status(400).json({ error: `to غير صالح — يجب أن يكون بصيغة YYYY-MM-DD (القيمة المُرسَلة: ${to})` });
  }
  if (from !== undefined && to !== undefined && from > to) {
    return res.status(400).json({ error: `النطاق الزمني معكوس — from (${from}) بعد to (${to})` });
  }
  // P0.6A — Step 14 (P6-043): exclude closing-transfer entries — see
  // buildBalanceMap()'s own comment for why an operational P&L must.
  const balMap  = buildBalanceMap(db, from, to, { excludeClosing: true });
  const coa     = db.chartOfAccounts || [];
  const revenue = [], expenses = [];
  for (const acc of coa) {
    const b = balMap[acc.code]; if (!b) continue;
    if (acc.code.startsWith('4')) {
      const amt = parseFloat((b.credit - b.debit).toFixed(3));
      if (Math.abs(amt) > 0.001) revenue.push({ code: acc.code, name: acc.name, amount: amt });
    } else if (acc.code.startsWith('5')) {
      const amt = parseFloat((b.debit - b.credit).toFixed(3));
      if (Math.abs(amt) > 0.001) expenses.push({ code: acc.code, name: acc.name, amount: amt });
    }
  }
  const totalRevenue  = parseFloat(revenue.reduce((s,r)=>s+r.amount,0).toFixed(3));
  const totalExpenses = parseFloat(expenses.reduce((s,e)=>s+e.amount,0).toFixed(3));
  const netIncome     = parseFloat((totalRevenue - totalExpenses).toFixed(3));
  const margin        = totalRevenue > 0 ? parseFloat((netIncome/totalRevenue*100).toFixed(1)) : 0;
  // P0.3 — Step 9/10: a P&L must not silently present itself as complete
  // when journal lines in this same period reference an account code that
  // no longer (or never did) resolve in the COA — those lines are excluded
  // from `revenue`/`expenses` above with no other signal. Expose that here.
  const diag = scanUnresolvedAccounts(db, from, to);
  res.json({
    from, to, revenue, expenses, totalRevenue, totalExpenses, netIncome, margin,
    hasUnresolvedAccounts: diag.hasUnresolvedAccounts,
    unresolvedCount: diag.unresolvedCount,
    unresolvedCodes: diag.unresolvedCodes.map(u => ({ code: u.code, affectedEntries: u.affectedEntries, debitTotal: u.debitTotal, creditTotal: u.creditTotal })),
  });
});

app.get('/api/reports/balance-sheet', requireAuth, requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const toDate = req.query.date || new Date().toISOString().slice(0,10);
  const balMap = buildBalanceMap(db, null, toDate);
  const coa    = db.chartOfAccounts || [];
  const assets = [], liabilities = [], equity = [];
  // R5 (staging validation, adversarial review — P0, live-reproduced): this
  // loop only ever branched on codes starting with '1'/'2'/'3' — revenue
  // ('4xxx') and expense ('5xxx') accounts for the CURRENT, not-yet-closed
  // period were invisible to equity entirely, so `balanced` was false on
  // every ordinary day that wasn't exactly a month-end (confirmed live:
  // GET with no params, i.e. "today", reported balanced:false while
  // GET /api/trial-balance for the same instant showed a genuinely balanced
  // ledger). The sibling GET /api/financial-statements already solves this
  // correctly (see its own detailed P0.11 comment a few thousand lines up)
  // — mirrored here, but simpler: `balMap` above is already built WITHOUT
  // excludeClosing, so a CLOSED period's 4xxx/5xxx activity nets to exactly
  // zero on its own (original postings + that period's closing reversal
  // cancel out) — only the current OPEN period's real, un-reversed
  // revenue/expense activity survives in the cumulative balance, which is
  // exactly the "not yet swept into equity" residual this needs. Same
  // credit-minus-debit sign convention already used for liability/equity
  // above works unmodified for both 4xxx (revenue, credit-normal) and 5xxx
  // (expense, debit-normal — a debit balance there is a NEGATIVE credit-debit
  // value, correctly reducing equity).
  let openPeriodNetIncome = 0;
  for (const acc of coa) {
    const b = balMap[acc.code]; if (!b) continue;
    if (acc.code.startsWith('1')) { const amt=parseFloat((b.debit-b.credit).toFixed(3)); if(Math.abs(amt)>0.001) assets.push({code:acc.code,name:acc.name,amount:amt}); }
    else if (acc.code.startsWith('2')) { const amt=parseFloat((b.credit-b.debit).toFixed(3)); if(Math.abs(amt)>0.001) liabilities.push({code:acc.code,name:acc.name,amount:amt}); }
    else if (acc.code.startsWith('3')) { const amt=parseFloat((b.credit-b.debit).toFixed(3)); if(Math.abs(amt)>0.001) equity.push({code:acc.code,name:acc.name,amount:amt}); }
    else if (acc.code.startsWith('4') || acc.code.startsWith('5')) { openPeriodNetIncome += (b.credit - b.debit); }
  }
  openPeriodNetIncome = parseFloat(openPeriodNetIncome.toFixed(3));
  const totalAssets=parseFloat(assets.reduce((s,a)=>s+a.amount,0).toFixed(3));
  const totalLiabilities=parseFloat(liabilities.reduce((s,l)=>s+l.amount,0).toFixed(3));
  const totalEquity=parseFloat((equity.reduce((s,e)=>s+e.amount,0) + openPeriodNetIncome).toFixed(3));
  // P0.3 — same unresolved-account exposure as the P&L (see there for why).
  const diag = scanUnresolvedAccounts(db, null, toDate);
  res.json({
    date:toDate, assets, liabilities, equity, openPeriodNetIncome, totalAssets, totalLiabilities, totalEquity,
    balanced:Math.abs(totalAssets-totalLiabilities-totalEquity)<0.5,
    hasUnresolvedAccounts: diag.hasUnresolvedAccounts,
    unresolvedCount: diag.unresolvedCount,
    unresolvedCodes: diag.unresolvedCodes.map(u => ({ code: u.code, affectedEntries: u.affectedEntries, debitTotal: u.debitTotal, creditTotal: u.creditTotal })),
  });
});

// P0.3 — Step 6: reusable READ-ONLY historical-ledger diagnostic. Scans this
// tenant's own journalEntries/chartOfAccounts (loadDB() is already scoped to
// the caller's tenant via P0.1's tenantMiddleware — no cross-tenant reach is
// possible here) and reports every accountCode that doesn't resolve, with
// per-code entry/line counts, debit/credit totals, date range, and sample
// refs/sources/descriptions to help a human classify likely historical
// cause. Never modifies the database.
app.get('/api/reports/ledger-diagnostic', requireAuth, requirePermission('ledger', 'view'), (req, res) => {
  const db = loadDB();
  const { from, to } = req.query;
  const diag = scanUnresolvedAccounts(db, from, to);
  res.json(diag);
});

app.get('/api/reports/cashflow', requireAuth, requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const { from, to } = req.query;
  const coa = db.chartOfAccounts || [];
  const cashCodes = new Set(coa.filter(a=>a.code.startsWith('11')).map(a=>a.code));
  if (!cashCodes.size) { cashCodes.add('1100'); cashCodes.add('1110'); }
  let opIn=0,opOut=0,invIn=0,invOut=0,finIn=0,finOut=0;
  for (const je of (db.journalEntries||[])) {
    if (from && je.date<from) continue;
    if (to && je.date>to) continue;
    for (const ln of (je.lines||[])) {
      if (!cashCodes.has(ln.accountCode)) continue;
      const dr=parseFloat(ln.debit||0), cr=parseFloat(ln.credit||0);
      const counterCodes=(je.lines||[]).filter(l=>l.accountCode!==ln.accountCode).map(l=>l.accountCode||'');
      const isAsset=counterCodes.some(c=>c.startsWith('15')||c.startsWith('16'));
      const isEquityOrLiab=counterCodes.some(c=>c.startsWith('3')||c.startsWith('23')||c.startsWith('24'));
      if (isAsset) { invIn+=dr; invOut+=cr; }
      else if (isEquityOrLiab) { finIn+=dr; finOut+=cr; }
      else { opIn+=dr; opOut+=cr; }
    }
  }
  const operating=parseFloat((opIn-opOut).toFixed(3));
  const investing=parseFloat((invIn-invOut).toFixed(3));
  const financing=parseFloat((finIn-finOut).toFixed(3));
  res.json({ from, to, operating:{inflows:parseFloat(opIn.toFixed(3)),outflows:parseFloat(opOut.toFixed(3)),net:operating}, investing:{inflows:parseFloat(invIn.toFixed(3)),outflows:parseFloat(invOut.toFixed(3)),net:investing}, financing:{inflows:parseFloat(finIn.toFixed(3)),outflows:parseFloat(finOut.toFixed(3)),net:financing}, netChange:parseFloat((operating+investing+financing).toFixed(3)) });
});

app.get('/api/budget', requireAuth, requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB(); res.json({ budget: db.budget || {} });
});

app.post('/api/budget/set', requireAuth, requirePermission('financials', 'edit'), (req, res) => {
  const db = loadDB();
  const { key, targets } = req.body;
  if (!key||!targets) return res.status(400).json({ error:'key & targets required' });
  if (!db.budget) db.budget = {};
  db.budget[key] = { ...(db.budget[key]||{}), ...targets, updatedAt:new Date().toISOString() };
  saveDB(db);
  res.json({ success:true, key, budget:db.budget[key] });
});

app.get('/api/reports/budget-variance', requireAuth, requirePermission('financials', 'view'), (req, res) => {
  const db = loadDB();
  const { year, month } = req.query;
  if (!year) return res.status(400).json({ error:'year required' });
  const key  = month ? `${year}-${String(month).padStart(2,'0')}` : year;
  const from = month ? `${year}-${String(month).padStart(2,'0')}-01` : `${year}-01-01`;
  const to   = month ? `${year}-${String(month).padStart(2,'0')}-31` : `${year}-12-31`;
  const target = db.budget?.[key] || {};
  const bm   = buildBalanceMap(db, from, to);
  const coa  = db.chartOfAccounts || [];
  const aRev = parseFloat(coa.filter(a=>a.code.startsWith('4')).reduce((s,a)=>{const b=bm[a.code];return s+(b?(b.credit-b.debit):0);},0).toFixed(3));
  const aExp = parseFloat(coa.filter(a=>a.code.startsWith('5')).reduce((s,a)=>{const b=bm[a.code];return s+(b?(b.debit-b.credit):0);},0).toFixed(3));
  const tRev=parseFloat(target.revenue||0), tExp=parseFloat(target.expenses||0), tNet=parseFloat(target.netIncome||(tRev-tExp));
  res.json({ key, target, actual:{revenue:aRev,expenses:aExp,netIncome:parseFloat((aRev-aExp).toFixed(3))}, variance:{revenue:parseFloat((aRev-tRev).toFixed(3)),expenses:parseFloat((aExp-tExp).toFixed(3)),netIncome:parseFloat((aRev-aExp-tNet).toFixed(3)),revenuePct:tRev>0?parseFloat(((aRev-tRev)/tRev*100).toFixed(1)):0,expensesPct:tExp>0?parseFloat(((aExp-tExp)/tExp*100).toFixed(1)):0} });
});

// ── AUDIT LOG ──────────────────────────────────────────────────────────────
// P0.4 — Step 15: permission-protected, paginated, filterable audit read.
// db.auditLog is already newest-first (appendAuditEvent unshifts), and
// loadDB() is already tenant-scoped, so no extra sort/tenant-filter needed
// here — just query-param filtering + pagination on top of that array.
app.get('/api/audit-log', requireAuth, requireAdminAction('audit.read'), (req, res) => {
  const db = loadDB();
  let logs = db.auditLog || [];
  const { action, resourceType, resourceId, actorUserId, actorUsername, outcome, from, to } = req.query;
  if (action)         logs = logs.filter(l => l.action === action);
  if (resourceType)   logs = logs.filter(l => l.resourceType === resourceType);
  // R5 (staging validation, adversarial review — P2, live-reproduced twice,
  // independently, by two different reviewers): every stored audit event
  // carries a resourceId (buildAuditEvent, lib/auditLog.js), and this route
  // already documents/accepts a resourceId query param in practice — but it
  // was never destructured or filtered on, so it was silently ignored,
  // always returning the full unfiltered log with no error — exactly the
  // "reconstruct one record's full lifecycle" use case an audit trail
  // exists for, and the one this milestone's own audit-trail verification
  // depends on.
  if (resourceId)      logs = logs.filter(l => l.resourceId === resourceId);
  if (actorUserId)    logs = logs.filter(l => l.actorUserId === actorUserId);
  if (actorUsername)  logs = logs.filter(l => l.actorUsername === actorUsername);
  if (outcome)         logs = logs.filter(l => l.outcome === outcome);
  if (from)            logs = logs.filter(l => l.timestamp >= from);
  if (to)              logs = logs.filter(l => l.timestamp <= to);

  const total  = logs.length;
  const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200));
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const offset = (page - 1) * limit;

  res.json({ logs: logs.slice(offset, offset + limit), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
});

console.log('✅ Fix Layer: COA-next-code, Journal-learn, File-delete, Accrued-Expenses, P&L, BS, CF, Budget, Audit-Log loaded');

// ══════════════════════════════════════════════════════════════════════
// DATA ENTRY LAYER v1 — 13 أداة لتسريع وتحسين إدخال البيانات
// ══════════════════════════════════════════════════════════════════════

// ── 1. JOURNAL TEMPLATES — قوالب القيود ─────────────────────────────
app.get('/api/journal-templates', requireAuth, requirePermission('journal', 'view'), (req, res) => {
  const db = loadDB();
  res.json({ templates: db.journalMappings || [] });
});

app.post('/api/journal-templates', requireAuth, requirePermission('journal', 'add'), (req, res) => {
  const db = loadDB();
  const { name, description, lines } = req.body;
  if (!name || !Array.isArray(lines) || !lines.length)
    return res.status(400).json({ error: 'name و lines مطلوبة' });
  const template = {
    id: genId('TPL-'), name, description: description || '', lines,
    createdAt: new Date().toISOString(), createdBy: req.user?.username
  };
  if (!db.journalMappings) db.journalMappings = [];
  db.journalMappings.unshift(template);
  if (db.journalMappings.length > 100) db.journalMappings = db.journalMappings.slice(0, 100);
  saveDB(db);
  res.json({ success: true, template });
});

app.delete('/api/journal-templates/:id', requireAuth, requirePermission('journal', 'delete'), (req, res) => {
  const db = loadDB();
  if (!db.journalMappings) return res.json({ success: true });
  db.journalMappings = db.journalMappings.filter(t => t.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// ── 2. SMART SUGGEST — إكمال تلقائي ذكي ──────────────────────────
app.get('/api/smart-suggest', requireAuth, requirePermission('journal', 'view'), (req, res) => {
  const db = loadDB();
  const q = (req.query.q || '').toLowerCase().trim();
  const limit = Math.min(parseInt(req.query.limit || 10), 20);

  // Build frequency + keyword→account map from last 500 entries
  const accFreq = {}, descMap = {};
  for (const je of (db.journalEntries || []).slice(-500)) {
    const desc = (je.description || je.desc || '').toLowerCase();
    for (const ln of (je.lines || [])) {
      const code = ln.accountCode;
      if (!code) continue;
      accFreq[code] = (accFreq[code] || 0) + 1;
      const words = desc.split(/\s+/).filter(w => w.length > 2);
      for (const w of words) {
        if (!descMap[w]) descMap[w] = {};
        descMap[w][code] = (descMap[w][code] || 0) + 1;
      }
    }
  }

  const coa = db.chartOfAccounts || [];
  const accounts = coa.map(acc => {
    let score = 0;
    if (!q) { score = accFreq[acc.code] || 0; }
    else {
      if (acc.code.startsWith(q)) score += 25;
      if (acc.code.includes(q)) score += 15;
      if (acc.name.includes(q)) score += 20;
      const qWords = q.split(/\s+/).filter(w => w.length > 2);
      for (const w of qWords) score += (descMap[w]?.[acc.code] || 0) * 3;
      score += (accFreq[acc.code] || 0) * 0.5;
    }
    return { code: acc.code, name: acc.name, type: acc.type, score };
  }).filter(a => !q || a.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);

  const vendors = (db.vendors || []).filter(v => {
    if (!q) return true;
    return (v.name||'').toLowerCase().includes(q) || (v.code||'').toLowerCase().includes(q);
  }).slice(0, 5).map(v => ({ id: v.id, name: v.name }));

  res.json({ accounts, vendors });
});

// ── 3. BANK CSV/EXCEL IMPORT ─────────────────────────────────────
app.post('/api/bank/import-csv', requireAuth, requireAdminAction('bank.import'), uploadBank.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'الملف مطلوب' });
    const fname = (req.file.originalname || '').toLowerCase();
    const ext   = fname.slice(fname.lastIndexOf('.'));
    if (!['.csv', '.xlsx', '.xls', '.txt'].includes(ext))
      return res.status(400).json({ error: 'صيغة غير مدعومة — ارفع ملف CSV أو Excel' });
    const buf = req.file.buffer || require('fs').readFileSync(req.file.path);
    // CSV/TXT: اقرأه كنص (مع دعم UTF-8 BOM والعربية)؛ Excel: كـ buffer
    let wb;
    if (ext === '.csv' || ext === '.txt') {
      let text = buf.toString('utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // إزالة BOM
      wb = XLSX.read(text, { type: 'string', cellDates: true, raw: false });
    } else {
      wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    }
    if (!wb.SheetNames.length) return res.status(400).json({ error: 'الملف فارغ أو تالف' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (rows.length < 2) return res.status(400).json({ error: 'الملف لا يحتوي بيانات (يجب أن يحتوي صف عناوين وصف بيانات على الأقل)' });

    const hdr = rows[0].map(h => String(h || '').trim().toLowerCase());
    const idx = key => hdr.findIndex(h => h.includes(key));
    const dateI  = [idx('date'), idx('تاريخ'), 0].find(i => i >= 0);
    const descI  = [idx('desc'), idx('narr'), idx('detail'), idx('بيان'), idx('وصف'), 1].find(i => i >= 0);
    const amtI   = [idx('amount'), idx('مبلغ'), idx('value')].find(i => i >= 0);
    const drI    = [idx('debit'), idx('مدين'), idx('out'), idx('withdraw')].find(i => i >= 0);
    const crI    = [idx('credit'), idx('دائن'), idx('in'), idx('deposit')].find(i => i >= 0);

    const lines = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row.some(c => c !== '')) continue;
      const raw = row[dateI];
      let date = '';
      if (raw instanceof Date) date = raw.toISOString().slice(0, 10);
      else if (typeof raw === 'number') {
        const d = XLSX.SSF.parse_date_code(raw);
        if (d) date = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
      } else {
        const m = String(raw).match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
        if (m) {
          const yr = m[3].length === 2 ? '20'+m[3] : m[3];
          date = `${yr}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
        } else date = String(raw).slice(0, 10);
      }
      const desc = String(row[descI] || '').trim();
      let amount = 0;
      if (drI >= 0 && crI >= 0) {
        const dr = parseFloat(String(row[drI]).replace(/,/g,'')) || 0;
        const cr = parseFloat(String(row[crI]).replace(/,/g,'')) || 0;
        amount = parseFloat((cr - dr).toFixed(3));
      } else if (amtI >= 0) {
        amount = parseFloat(String(row[amtI]).replace(/,/g,'')) || 0;
      }
      if (!date) continue;
      lines.push({ date, desc, amount });
    }
    if (req.file.path) require('fs').unlink(req.file.path, () => {});
    if (!lines.length) {
      return res.status(400).json({ error: `لم يتم التعرّف على أي معاملة. تأكد أن الملف يحتوي أعمدة: التاريخ، البيان، والمبلغ (أو مدين/دائن). العناوين المقروءة: ${hdr.filter(Boolean).join(' | ') || '—'}` });
    }
    res.json({ success: true, lines, count: lines.length });
  } catch(e) {
    console.error('bank import-csv error:', e);
    res.status(400).json({ error: 'تعذّرت قراءة الملف: ' + e.message });
  }
});

// ── 4. BANK AUTO-CATEGORIZE — تصنيف ذكي ─────────────────────────
app.post('/api/bank/categorize', requireAuth, requireAdminAction('bank.categorize'), async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions) || !transactions.length)
    return res.status(400).json({ error: 'transactions[] مطلوبة' });

  const db = loadDB();
  const rules = [
    // إيداعات الشبكة (كي-نت/فيزا/ماستر/لينك/POS Settlement) = تصفية مستحقات الشبكة، لا إيراد جديد
    { re: /pos|settlement|تسوية|k-?net|كي-?نت|knet|visa|فيزا|master|ماستر|mastercard|link|لينك|\bmid\b/i, debitAcc:'1125', creditAcc:'1125', label:'تصفية مستحقات الشبكة' },
    { re: /راتب|salary|payroll|رواتب/i,              debitAcc:'5100', creditAcc:'2100', label:'رواتب' },
    { re: /إيجار|rent|اجار/i,                         debitAcc:'5200', creditAcc:'1100', label:'إيجار' },
    { re: /كهرباء|electric|mew|moo/i,                 debitAcc:'5300', creditAcc:'1100', label:'كهرباء' },
    { re: /هاتف|تلفون|telephone|mobile|zain|viva|ooredoo/i, debitAcc:'5350', creditAcc:'1100', label:'اتصالات' },
    { re: /تأمين|insurance/i,                         debitAcc:'5400', creditAcc:'2100', label:'تأمين' },
    { re: /مختبر|lab|laboratory/i,                    debitAcc:'5500', creditAcc:'2100', label:'مختبر' },
    { re: /pifss|تأمينات|تامينات/i,                   debitAcc:'5150', creditAcc:'2200', label:'PIFSS' },
    // P0.10 — was debitAcc:'5600' ("تسويق وإعلان" — Marketing, unrelated)
    // and creditAcc:'1500' (the Fixed-Assets GROUP header — isGroup:true,
    // would be rejected outright by journalGuard's GROUP_ACCOUNT_POSTING).
    // Corrected to the accounts actually used everywhere else in the
    // fixed-asset domain (POST /api/assets/depreciate, /api/close/run-all).
    { re: /اهتلاك|depreciation/i,                     debitAcc:'5800', creditAcc:'1590', label:'اهتلاك' },
    { re: /صيانة|maintenance|repair/i,                debitAcc:'5700', creditAcc:'1100', label:'صيانة' },
    { re: /تسوية|transfer|تحويل/i,                    debitAcc:'1110', creditAcc:'1120', label:'تحويل بنكي' },
  ];

  const categorized = transactions.map(tx => {
    const desc = tx.desc || '';
    for (const r of rules) {
      if (r.re.test(desc)) {
        const acct = tx.amount >= 0 ? r.creditAcc : r.debitAcc;
        return { ...tx, suggestedAccount: acct, category: r.label, confidence: 0.85, method: 'rule' };
      }
    }
    const defaultAcc = tx.amount >= 0 ? '4900' : '5900';
    return { ...tx, suggestedAccount: defaultAcc, category: tx.amount >= 0 ? 'إيراد أخرى' : 'مصروف أخرى', confidence: 0.3, method: 'default' };
  });

  // Upgrade low-confidence via AI (batch, haiku for speed)
  const lowConf = categorized.filter(t => t.confidence < 0.6).slice(0, 15);
  if (lowConf.length && process.env.ANTHROPIC_API_KEY) {
    try {
      const coa = (db.chartOfAccounts||[]).slice(0,50).map(a=>`${a.code} ${a.name}`).join('\n');
      const aiText = await callAI({
        model: 'claude-haiku-4-5-20251001', max_tokens: 512,
        messages: [{ role: 'user', content: `صنّف المعاملات على حسابات من دليل الحسابات. أجب JSON فقط.
معاملات:
${lowConf.map((t,i)=>`${i+1}. "${t.desc}" ${t.amount} KD`).join('\n')}
حسابات متاحة:
${coa}
تنسيق الإجابة: [{"i":1,"code":"XXXX","name":"اسم","conf":0.9},...]` }],
      }).catch(() => '');
      if (aiText) {
        const m = aiText.match(/\[[\s\S]*?\]/);
        if (m) JSON.parse(m[0]).forEach(s => {
          const t = categorized.find(c => c === lowConf[s.i-1]);
          if (t) { t.suggestedAccount = s.code; t.category = s.name; t.confidence = s.conf; t.method = 'ai'; }
        });
      }
    } catch(_) {}
  }
  res.json({ success: true, transactions: categorized });
});

// ══════════════════════════════════════════════════════════════════════════
// BANK SETTLEMENT RECONCILIATION — مطابقة كشف البنك (مستحقات الشبكة + التوقيت + وسيط حسابي)
//   الفكرة: مبيعات الشبكة (كي-نت / فيزا-ماستر-لينك) تُرحَّل مديناً بالصافي (بعد العمولة) على
//   حساب مستحقات (1125) وقت الاعتراف بالإيراد، والعمولة تُصرَف فوراً. لاحقاً تصل دفعات البنك
//   — غالباً عدّة دفعات صغيرة يومية تُصفّي مستحقاً شهرياً واحداً كبيراً — فهذا المحرّك يحسب
//   «رصيداً جارياً» مفتوحاً لكل قناة (كي-نت / بطاقات) = كل ما اعتُرف به إيراداً حتى الآن
//   ناقص كل ما صُفِّي مسبقاً عبر تسويات سابقة، ثم يستهلك من هذا الرصيد تدريجياً مع كل دفعة
//   بنكية تصل — تصفية كاملة أو جزئية حسب المتوفر. عام لأي منشأة (الحسابات قابلة للاختيار).
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/bank/reconcile-match', requireAuth, requireAdminAction('bank.reconcile'), (req, res) => {
  const db = loadDB();
  const { lines = [], settleAccount = '1125', bankAccount = '1110' } = req.body;
  const r3f = v => Math.round((Number(v) || 0) * 1000) / 1000;

  // الرصيد الجاري لكل قناة: كي-نت مقابل بطاقات (فيزا/ماستر/لينك) — مستمَدّ من ملاحظات
  // بنود مستحقات الشبكة (settleAccount) في قيود الإيرادات، لا يعتمد على تواريخ التطابق.
  const bucketOf = remarks => /كي-نت|كي نت|knet/i.test(remarks || '') ? 'knet' : 'card';
  let recognized = { knet: 0, card: 0 };
  (db.journalEntries || []).forEach(je => {
    (je.lines || []).forEach(l => {
      if (String(l.accountCode) === String(settleAccount) && (parseFloat(l.debit) || 0) > 0) {
        recognized[bucketOf(l.remarks)] += parseFloat(l.debit) || 0;
      }
    });
  });
  const cleared = db.networkReceivableCleared || { knet: 0, card: 0 };
  const remaining = { knet: r3f(recognized.knet - (cleared.knet || 0)), card: r3f(recognized.card - (cleared.card || 0)) };

  // دفتر البنك المُسجَّل مسبقاً — لاكتشاف الحركات المُدخَلة سابقاً (إيرادات/رواتب/مدفوعات)
  // كي لا تُنشأ قيوداً مكرّرة لحركةٍ موجودة أصلاً في الدفاتر.
  // P0.10 adversarial-review fix (P1 finding): this pool was previously
  // rebuilt from EVERY bank-account journal line on every call with no
  // reference to db.bankMatchedLineIds — usedBookKeys below only dedupes
  // WITHIN a single request, so the same book line could be proposed and
  // committed as 'matched-book' against a different statement line in a
  // later, separate reconcile-match/commit cycle (e.g. a re-uploaded
  // statement with an overlapping date range), double-claiming one real
  // ledger entry as the explanation for two different bank movements.
  const alreadyMatchedBookKeys = new Set(db.bankMatchedLineIds || []);
  const bankLedger = [];
  (db.journalEntries || []).forEach(je => {
    (je.lines || []).forEach((l, i) => {
      if (String(l.accountCode) === String(bankAccount)) {
        const key = `${je.id}#B${i}`;
        if (alreadyMatchedBookKeys.has(key)) return; // already claimed as a match in a prior commit — never re-offer it
        const signed = (parseFloat(l.debit) || 0) - (parseFloat(l.credit) || 0); // + دخول للبنك، - خروج
        if (Math.abs(signed) > 0.0005) bankLedger.push({ key, date: je.date, amt: signed, desc: je.desc || je.description || '' });
      }
    });
  });

  const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5);
  const detectSettleBucket = desc => {
    if (/knet|كي-نت|كي نت/i.test(desc || '')) return 'knet';
    if (/pos|settlement|تسوية|\bcc\b|visa|فيزا|master|ماستر|link|لينك|\bmid\b/i.test(desc || '')) return 'card';
    return null;
  };
  // مفتاح ثابت لكل حركة كشف بنك (تاريخ+بيان+مبلغ) — يمنع ترحيل نفس الحركة مرتين لو أُعيد رفع نفس الكشف
  // P0.10 — known, documented (not fixed) limitation: this key is
  // (date, description, amount) only — it has no line-order/index component.
  // Two GENUINELY DISTINCT transactions on the same statement that share
  // the same date, the same bank-provided description, and the same amount
  // (e.g. two identical KD 5.000 ATM withdrawals on the same day with an
  // identical generic description) collide on the same srcKey. The second
  // one is silently treated as "already posted" by the committedKeys check
  // above and dropped rather than posted — real money movement that never
  // reaches the ledger, with no error surfaced. Fixing this correctly needs
  // a stable per-line identity from the statement source (e.g. the bank's
  // own reference number, when the import format carries one) rather than a
  // derived content hash — out of scope for this milestone (bank-statement
  // import format changes), flagged here for a future import-hardening pass.
  const srcKeyOf = bl => `${bl.date}|${(bl.desc||'').trim()}|${(parseFloat(bl.amount)||0).toFixed(3)}`;
  const committedKeys = new Set(db.bankCommittedLineKeys || []);
  let alreadyPosted = 0;
  const usedBookKeys = new Set();
  const proposals = [];
  lines.forEach((bl, idx) => {
    const amt = parseFloat(bl.amount) || 0;
    if (Math.abs(amt) < 0.0005) return;
    const srcKey = srcKeyOf(bl);
    if (committedKeys.has(srcKey)) { alreadyPosted++; return; } // رُحّلت هذه الحركة مسبقاً — تجاهلها لمنع الازدواج
    // (0) مطابقة مع دفتر البنك: هل الحركة مُسجَّلة مسبقاً؟ → لا حاجة لقيد جديد
    let bookMatch = null, bookScore = Infinity;
    for (const bk of bankLedger) {
      if (usedBookKeys.has(bk.key)) continue;
      if ((bk.amt < 0) !== (amt < 0)) continue;
      if (Math.abs(bk.amt - amt) > 0.005) continue;
      const dd = dayDiff(bl.date, bk.date);
      if (dd > 45) continue; // مهلة واسعة تُغطّي فروقات التوقيت عبر الشهور (المبلغ هو المفتاح الأقوى)
      if (dd < bookScore) { bookScore = dd; bookMatch = bk; }
    }
    if (bookMatch) {
      usedBookKeys.add(bookMatch.key);
      // P0.10 — srcKey/bookMatchKey were previously omitted here, so a
      // 'matched-book' proposal fell through every branch of
      // reconcile-commit's forEach unhandled: never posted, never counted,
      // never protected against duplicate re-commit. Both are now carried
      // through so commit can register the match for real (see reconcile-commit).
      proposals.push({ id: 'P' + idx, srcKey, bookMatchKey: bookMatch.key, kind: 'matched-book', bankDate: bl.date, bankDesc: bl.desc, amount: parseFloat(Math.abs(amt).toFixed(3)), direction: amt < 0 ? 'withdrawal' : 'deposit', bookDate: bookMatch.date, bookDesc: bookMatch.desc });
      return;
    }
    if (amt > 0) {
      const bucket = detectSettleBucket(bl.desc || '');
      if (bucket && remaining[bucket] > 0.001) {
        const consume = r3f(Math.min(amt, remaining[bucket]));
        remaining[bucket] = r3f(remaining[bucket] - consume);
        proposals.push({ id: 'P' + idx, srcKey, kind: 'settlement', bucket, bankDate: bl.date, bankDesc: bl.desc, net: consume, settleAccount, bankAccount });
        const leftover = r3f(amt - consume);
        if (leftover > 0.001) {
          proposals.push({ id: 'P' + idx + 'x', srcKey: srcKey + '#x', kind: 'deposit-unmatched', bankDate: bl.date, bankDesc: (bl.desc || '') + ' (زيادة عن المستحق المفتوح)', amount: leftover, bankAccount, splits: [{ accountCode: '', amount: leftover, desc: bl.desc || '' }] });
        }
      } else {
        proposals.push({ id: 'P' + idx, srcKey, kind: 'deposit-unmatched', bankDate: bl.date, bankDesc: bl.desc, amount: r3f(amt), bankAccount, splits: [{ accountCode: '', amount: r3f(amt), desc: bl.desc || '' }] });
      }
    } else {
      proposals.push({ id: 'P' + idx, srcKey, kind: 'withdrawal', bankDate: bl.date, bankDesc: bl.desc, amount: r3f(Math.abs(amt)), bankAccount, splits: [{ accountCode: '', amount: r3f(Math.abs(amt)), desc: bl.desc || '' }] });
    }
  });

  res.json({
    success: true, proposals, remaining, alreadyPosted,
    summary: {
      deposits: lines.filter(l => (parseFloat(l.amount) || 0) > 0).length,
      withdrawals: lines.filter(l => (parseFloat(l.amount) || 0) < 0).length,
      settlements: proposals.filter(p => p.kind === 'settlement').length,
      matchedBook: proposals.filter(p => p.kind === 'matched-book').length,
      needsInput: proposals.filter(p => p.kind === 'deposit-unmatched' || p.kind === 'withdrawal').length,
      remainingKnet: remaining.knet, remainingCard: remaining.card,
      alreadyPosted,
    }
  });
});

app.post('/api/bank/reconcile-commit', requireAuth, requireAdminAction('bank.reconcile_commit'), async (req, res, next) => {
  try {
  const db = loadDB();
  const { proposals = [] } = req.body;
  const coa = db.chartOfAccounts || [];
  const findAcc = c => coa.find(a => String(a.code) === String(c) || String(a.id) === String(c)) || { id: c, code: c, name: String(c) };
  db.journalEntries = db.journalEntries || [];
  db.bankMatchedLineIds = db.bankMatchedLineIds || [];
  const committedKeys = new Set(db.bankCommittedLineKeys || []);
  const batchId = 'BRECON-' + Date.now();
  // P0.10 — 'skipped' used to merge three unrelated rejection reasons into
  // one opaque counter (locked period vs. no account assigned vs. split
  // total not matching the line amount) — the caller had no way to tell
  // the user WHY a line was skipped. Now broken out per-reason.
  // P0.10 adversarial-review fix (P1 finding): the original split-out still
  // bucketed EVERY JournalValidationError from appendJournalEntry (empty
  // line, unbalanced, unknown/inactive/group account, invalid date — not
  // just an actual locked period) into `periodLocked`, contradicting this
  // exact comment's stated purpose. Now inspects e.code and only credits
  // periodLocked for a real PERIOD_LOCKED rejection; everything else goes
  // to otherRejected.
  let posted = 0, matched = 0, skipped = 0, duplicate = 0;
  const skippedReasons = { periodLocked: 0, noAccountAssigned: 0, splitMismatch: 0, otherRejected: 0 };
  proposals.forEach((p, i) => {
    // منع ترحيل نفس حركة كشف البنك مرتين (لو أُعيد رفع/ترحيل نفس الكشف بالخطأ)
    if (p.srcKey && committedKeys.has(p.srcKey)) { duplicate++; return; }
    const bankAcc = findAcc(p.bankAccount || '1110');
    // R4 (Part C): bank-reconciliation JEs had no source tag at all.
    const jeBase = { id: 'JE-BRC-' + Date.now() + '-' + i, ref: 'BRECON', reference: 'BRECON', _batchId: batchId, _srcKey: p.srcKey || null, createdAt: new Date().toISOString(), source: 'bank-recon', sourceModule: 'bankrecon' };
    if (p.kind === 'matched-book') {
      // الحركة موجودة أصلاً في الدفاتر — لا قيد جديد، فقط تسجيل أنها طابقت
      // كشف البنك (bankMatchedLineIds) ومنع إعادة معالجتها لو أُعيد رفع
      // نفس الكشف (bankCommittedLineKeys)، تماماً كبقية أنواع الاقتراحات.
      if (p.srcKey) committedKeys.add(p.srcKey);
      if (p.bookMatchKey && !db.bankMatchedLineIds.includes(p.bookMatchKey)) db.bankMatchedLineIds.push(p.bookMatchKey);
      matched++;
      return;
    }
    if (p.kind === 'settlement') {
      // العمولة اتّخذت وقت الاعتراف بالإيراد (postCard) — التسوية هنا تصفية صافية بلا عمولة إضافية:
      // مدين البنك / دائن مستحقات الشبكة، بنفس المبلغ المُستهلَك من الرصيد المفتوح لتلك القناة.
      const net = r3(p.net);
      const settleAcc = findAcc(p.settleAccount || '1125');
      const bucketLabel = p.bucket === 'knet' ? 'كي-نت' : 'فيزا/ماستر/لينك';
      const lines = [
        { accountId: bankAcc.id, accountCode: bankAcc.code, accountName: bankAcc.name, debit: net, credit: 0 },
        { accountId: settleAcc.id, accountCode: settleAcc.code, accountName: settleAcc.name, debit: 0, credit: net },
      ];
      // P0.2: كل حركة بنكية مستقلة عن غيرها — ترفض حركة واحدة (فترة مقفلة مثلاً)
      // لا يجوز أن توقف ترحيل بقية حركات نفس كشف البنك.
      try {
        appendJournalEntry(db, { ...jeBase, _bucket: p.bucket, date: p.bankDate, desc: `تسوية إيداع شبكة (${bucketLabel}) — ${p.bankDesc || ''}`, type: 'bank-settlement', totalDebit: net, totalCredit: net, lines });
      } catch (e) {
        if (!(e instanceof JournalValidationError)) throw e;
        skipped++; skippedReasons[e.code === 'PERIOD_LOCKED' ? 'periodLocked' : 'otherRejected']++; return;
      }
      db.networkReceivableCleared = db.networkReceivableCleared || { knet: 0, card: 0 };
      db.networkReceivableCleared[p.bucket] = r3((db.networkReceivableCleared[p.bucket] || 0) + net);
      if (p.srcKey) committedKeys.add(p.srcKey);
      posted++;
    } else if (p.kind === 'deposit-unmatched' || p.kind === 'withdrawal') {
      const isDeposit = p.kind === 'deposit-unmatched';
      const amt = r3(p.amount);
      // أسطر الإسناد: إمّا تقسيم على عدّة حسابات (splits[]) أو حساب واحد (assignAccount)
      let assigns = [];
      if (Array.isArray(p.splits) && p.splits.length) {
        assigns = p.splits
          .filter(s => s && s.accountCode && r3(s.amount) > 0.0005)
          .map(s => ({ acc: findAcc(s.accountCode), amount: r3(s.amount), desc: s.desc || p.bankDesc || '' }));
      } else if (p.assignAccount) {
        assigns = [{ acc: findAcc(p.assignAccount), amount: amt, desc: p.assignDesc || p.bankDesc || '' }];
      }
      if (!assigns.length) { skipped++; skippedReasons.noAccountAssigned++; return; }
      const assignTotal = r3(assigns.reduce((s, a) => s + a.amount, 0));
      if (Math.abs(assignTotal - amt) > 0.005) { skipped++; skippedReasons.splitMismatch++; return; }  // يجب أن يوازن مجموع التقسيم المبلغ
      const otherLines = assigns.map(a => isDeposit
        ? { accountId: a.acc.id, accountCode: a.acc.code, accountName: a.acc.name, debit: 0, credit: a.amount, remarks: a.desc }
        : { accountId: a.acc.id, accountCode: a.acc.code, accountName: a.acc.name, debit: a.amount, credit: 0, remarks: a.desc });
      const bankLine = isDeposit
        ? { accountId: bankAcc.id, accountCode: bankAcc.code, accountName: bankAcc.name, debit: amt, credit: 0 }
        : { accountId: bankAcc.id, accountCode: bankAcc.code, accountName: bankAcc.name, debit: 0, credit: amt };
      const splitLines = isDeposit ? [bankLine, ...otherLines] : [...otherLines, bankLine];
      // P0.10 adversarial-review fix (P1 finding): totalDebit/totalCredit
      // were previously hardcoded to `amt`/`amt` regardless of what the
      // lines actually summed to — assignTotal is only checked against amt
      // within a 0.005 tolerance (never plugged/reconciled to match
      // exactly), so a legitimate small split mismatch (e.g. a 3-way split
      // of 100.000 entered as 33.333×3=99.999) could post a JE whose
      // stored total fields LIE about a real, if small, imbalance. Now
      // derived from the actual lines, matching the jeAmounts()/lines-are-
      // authoritative convention established by P6-017 and used by this
      // same milestone's own disposal journal.
      const totalDr = r3(splitLines.reduce((s, l) => s + (l.debit || 0), 0));
      const totalCr = r3(splitLines.reduce((s, l) => s + (l.credit || 0), 0));
      try {
        appendJournalEntry(db, { ...jeBase, date: p.bankDate,
          desc: p.assignDesc || p.bankDesc || (isDeposit ? 'إيداع بنكي' : 'سحب بنكي'),
          type: isDeposit ? 'bank-deposit' : 'bank-withdrawal', totalDebit: totalDr, totalCredit: totalCr,
          lines: splitLines });
      } catch (e) {
        if (!(e instanceof JournalValidationError)) throw e;
        skipped++; skippedReasons[e.code === 'PERIOD_LOCKED' ? 'periodLocked' : 'otherRejected']++; return;
      }
      if (p.srcKey) committedKeys.add(p.srcKey);
      posted++;
    }
  });
  db.bankCommittedLineKeys = Array.from(committedKeys);
  appendAuditEvent(db, { req, action: 'bank.reconcile_committed', resourceType: 'journal', resourceId: batchId, after: { posted, matched, skipped, skippedReasons, duplicate } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for bank.reconcile_committed:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التسوية البنكية بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true, posted, matched, skipped, skippedReasons, duplicate, batchId });
  } catch (err) {
    next(err);
  }
});

// P0.10 — single-item bank-reconciliation undo (P6-046/bank-recon forensic
// gap: only an all-or-nothing "undo everything" existed — /reconcile-undo-all
// below — with no way to correct one wrongly-committed line without wiping
// every reconciliation entry in the ledger). Mirrors reconcile-undo-all's
// own DELETE-path convention (assertFinancialPeriodOpen → 403 on a locked
// period — never appendJournalEntry's CREATE-path 409) but scoped to exactly
// one item. Two shapes, matching the two things reconcile-commit can produce:
//   (a) jeId — a real JE-BRC-* entry (settlement/deposit/withdrawal): delete
//       it, drop its srcKey from bankCommittedLineKeys, and — for a
//       settlement — restore the consumed amount to networkReceivableCleared
//       using the _bucket/_srcKey breadcrumbs reconcile-commit now stamps on
//       the JE (no separate lookup table needed).
//   (b) srcKey + bookMatchKey — a 'matched-book' pairing: no JE was ever
//       created (the bank line matched an existing book entry), so there is
//       nothing to delete — just clear the match so the line goes back to
//       being unmatched/pending.
// Note: JE-BRC-* entries posted BEFORE this route existed have no
// _srcKey/_bucket breadcrumb (those fields didn't exist yet). A settlement
// JE without a _bucket breadcrumb is now explicitly REJECTED (see
// LEGACY_SETTLEMENT_NO_BREADCRUMB below) rather than deleted with
// networkReceivableCleared silently left stale — the comment used to claim
// "a safe no-op beats a wrong adjustment," but the JE deletion itself was
// never a no-op even when the compensating adjustment was skipped. A
// deposit/withdrawal JE missing only _srcKey is still safe to delete (it
// never touched networkReceivableCleared to begin with); only srcKey
// removal from bankCommittedLineKeys is skipped for those, which is a
// genuine no-op (the key just stays committed, preventing a re-import of
// the same statement line — the safer failure direction).
app.post('/api/bank/reconcile-undo', requireAuth, requireAdminAction('bank.reconcile_undo'), async (req, res, next) => {
  try {
    const db = loadDB();
    const { jeId, srcKey, bookMatchKey } = req.body || {};
    db.bankCommittedLineKeys = db.bankCommittedLineKeys || [];
    db.bankMatchedLineIds = db.bankMatchedLineIds || [];
    db.networkReceivableCleared = db.networkReceivableCleared || { knet: 0, card: 0 };

    let auditAction, auditResourceId, before, after;

    if (jeId) {
      const je = (db.journalEntries || []).find(j => j.id === jeId);
      if (!je) return res.status(404).json({ success: false, error: 'القيد غير موجود' });
      // P0.10 adversarial-review fix (P2 finding): the previous check
      // accepted ANY journal entry whose free-text `ref` field happened to
      // equal exactly 'BRECON' — a manual entry via POST /api/journal
      // never restricts `ref` (public/index.html's manual-entry form has a
      // free-text "رقم المرجع" input), so an accountant typing 'BRECON' as
      // a personal shorthand could have their unrelated entry silently
      // deleted through this route. `id` cannot be forged this way —
      // nextJeId()/POST /api/journal always reassigns a fresh sequential
      // id for any entry whose supplied id doesn't match an EXISTING
      // record, so 'JE-BRC-*' can only ever originate from reconcile-commit
      // itself. The ref-equality path is dropped entirely; type membership
      // is kept as a secondary signal (not client-choosable via the UI).
      const isReconEntry = String(je.id || '').startsWith('JE-BRC-')
        || ['bank-settlement', 'bank-deposit', 'bank-withdrawal'].includes(String(je.type || ''));
      if (!isReconEntry) return res.status(400).json({ success: false, error: 'هذا القيد ليس ناتجاً عن تسوية بنكية', code: 'NOT_RECON_ENTRY' });
      assertFinancialPeriodOpen(db, [je.date]); // 403 — matches reconcile-undo-all's DELETE-path convention

      // P0.10 adversarial-review fix (P2 finding): a legacy settlement JE
      // (posted before _srcKey/_bucket breadcrumbs existed) cannot have its
      // networkReceivableCleared consumption reversed — there is no way to
      // know which bucket/amount to restore. Deleting the JE anyway would
      // leave networkReceivableCleared permanently overstated relative to
      // the ledger, silently understating "remaining" on every future
      // reconcile-match call. Reject outright rather than leave that
      // divergence — a manual, reviewed adjustment is required instead.
      if (je.type === 'bank-settlement' && !je._bucket) {
        return res.status(409).json({ success: false, error: 'قيد تسوية شبكة قديم (سابق لهذا التحديث) بلا بيانات ربط كافية — لا يمكن التراجع عنه تلقائياً بلا تعديل يدوي مُراجَع لرصيد مستحقات الشبكة', code: 'LEGACY_SETTLEMENT_NO_BREADCRUMB' });
      }

      before = { networkReceivableCleared: { ...db.networkReceivableCleared } };
      db.journalEntries = db.journalEntries.filter(j => j.id !== jeId);
      if (je._srcKey) db.bankCommittedLineKeys = db.bankCommittedLineKeys.filter(k => k !== je._srcKey);
      if (je._bucket) {
        const amt = parseFloat(je.totalCredit != null ? je.totalCredit : je.totalDebit) || 0;
        db.networkReceivableCleared[je._bucket] = r3((db.networkReceivableCleared[je._bucket] || 0) - amt);
      }
      auditAction = 'bank.reconcile_undo_single';
      auditResourceId = jeId;
      after = { networkReceivableCleared: db.networkReceivableCleared };
    } else if (srcKey || bookMatchKey) {
      before = { committedKeysCount: db.bankCommittedLineKeys.length, matchedIdsCount: db.bankMatchedLineIds.length };
      if (srcKey) db.bankCommittedLineKeys = db.bankCommittedLineKeys.filter(k => k !== srcKey);
      if (bookMatchKey) db.bankMatchedLineIds = db.bankMatchedLineIds.filter(k => k !== bookMatchKey);
      auditAction = 'bank.reconcile_undo_single_match';
      auditResourceId = srcKey || bookMatchKey;
      after = { committedKeysCount: db.bankCommittedLineKeys.length, matchedIdsCount: db.bankMatchedLineIds.length };
    } else {
      return res.status(400).json({ success: false, error: 'يجب تمرير jeId أو srcKey/bookMatchKey' });
    }

    appendAuditEvent(db, { req, action: auditAction, resourceType: 'bankRecon', resourceId: auditResourceId, before, after });
    try {
      await saveDB(db, { durable: true });
    } catch (e) {
      console.error('❌ Durable save failed for bank.reconcile_undo_single:', e.message);
      return res.status(500).json({ success: false, error: 'تعذّر حفظ التراجع بشكل دائم — حاول مرة أخرى' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// حذف كل القيود الناتجة عن استيراد/تسوية كشف البنك (تنظيف) — لا يمسّ القيود اليدوية
app.post('/api/bank/reconcile-undo-all', requireAuth, requireAdminAction('bank.reconcile_undo'), async (req, res, next) => {
  // P0.6A — Step 22: "destructive reconciliation undo" is explicitly named
  // as needing durable acknowledgement — durable save + outer try/catch
  // (next) for the same Express-4-async-handler safety reason as P0.5A's
  // other 8 durable routes.
  try {
  const db = loadDB();
  const isReconEntry = je => {
    const ref  = String(je.ref || je.reference || '');
    const type = String(je.type || '');
    const id   = String(je.id || '');
    return ref === 'BRECON' || ref === 'BANK'
        || id.startsWith('JE-BRC-')
        || type === 'bank-settlement' || type === 'bank-deposit' || type === 'bank-withdrawal';
  };
  const all = db.journalEntries || [];
  const removedList = all.filter(isReconEntry);
  // P0.6A — Step 5 (P6-013): this is the highest blast-radius destructive
  // action in the app — it can strip reconciliation entries out of MANY
  // periods in one call. All-or-nothing: check every affected entry's date
  // BEFORE removing anything; if even one falls in a locked period, reject
  // the whole undo (no partial undo).
  assertFinancialPeriodOpen(db, removedList.map(je => je.date));
  db.journalEntries = all.filter(je => !isReconEntry(je));
  db.bankMatchedLineIds = [];   // إعادة ضبط المطابقات كي يمكن إعادة التسوية من جديد
  db.networkReceivableCleared = { knet: 0, card: 0 };  // إعادة ضبط رصيد مستحقات الشبكة المُصفّى
  db.bankCommittedLineKeys = [];  // إعادة ضبط حركات الكشف المُرحَّلة كي يمكن ترحيلها من جديد
  const removedTotal = r3(removedList.reduce((s, je) =>
    s + (je.lines || []).reduce((x, l) => x + (parseFloat(l.debit) || 0), 0), 0));
  appendAuditEvent(db, { req, action: 'bank.reconcile_undo_all', resourceType: 'journal', before: { removed: removedList.length, removedTotal } });
  try {
    await saveDB(db, { durable: true });
  } catch (e) {
    console.error('❌ Durable save failed for bank.reconcile_undo_all:', e.message);
    return res.status(500).json({ success: false, error: 'تعذّر حفظ التراجع بشكل دائم — حاول مرة أخرى' });
  }
  res.json({ success: true, removed: removedList.length, remaining: db.journalEntries.length, removedTotal });
  } catch (err) {
    next(err);
  }
});

// نقل إيرادات ما قبل «حسابي» من حساب 1125 إلى البنك مباشرة (صافي) + قيد العمولة
// (أول 5 أشهر كانت البطاقات تدخل البنك مباشرة؛ حسابي بدأ من شهر 6). idempotent.
app.post('/api/migrate/pre-hesabi', requireAuth, requireAdminAction('bank.migrate_pre_hesabi'), (req, res) => {
  const db  = loadDB();
  const cfg = loadConfig();
  const feeKnet     = typeof cfg.feeKnet === 'number' ? cfg.feeKnet : 0.0065;
  const feeCard     = typeof cfg.feeCard === 'number' ? cfg.feeCard : 0.0265;
  const hesabiStart = req.body.hesabiStart || cfg.hesabiStartMonth || '2026-06';
  const coa     = db.chartOfAccounts || [];
  const bank    = coa.find(a => a.code === '1110') || { id:'1110', code:'1110', name:'البنك' };
  const feeAcc  = coa.find(a => a.code === '5750') || { id:'5750', code:'5750', name:'مصاريف بنكية وعمولات' };
  const r3f = v => Math.round((Number(v)||0) * 1000) / 1000;
  let entries = 0, reclassified = 0;
  (db.journalEntries || []).forEach(je => {
    if (je.type !== 'auto-income') return;
    if ((je.date || '').slice(0,7) >= hesabiStart) return; // pre-Hesabi only
    if (je._preHesabiFixed) return;                        // idempotent
    let touched = false;
    const out = [];
    for (const l of (je.lines || [])) {
      if (String(l.accountCode) === '1125' && (parseFloat(l.debit)||0) > 0) {
        const rate  = /كي-نت|knet/i.test(l.remarks || '') ? feeKnet : feeCard;
        const gross = parseFloat(l.debit) || 0;
        const fee   = r3f(gross * rate), net = r3f(gross - fee);
        out.push({ accountId:bank.id, accountCode:bank.code, accountName:bank.name, debit:net, credit:0, remarks:`${l.remarks||''} → البنك مباشرة (صافي)` });
        if (fee > 0) out.push({ accountId:feeAcc.id, accountCode:feeAcc.code, accountName:feeAcc.name, debit:fee, credit:0, remarks:`عمولة بنكية ${(rate*100).toFixed(2)}% — ${l.remarks||''}` });
        touched = true; reclassified++;
      } else out.push(l);
    }
    if (touched) { je.lines = out; je._preHesabiFixed = true; entries++; }
  });
  appendAuditEvent(db, { req, action: 'bank.migrate_pre_hesabi', resourceType: 'journal', after: { entriesFixed: entries, linesReclassified: reclassified, hesabiStart } });
  saveDB(db);
  res.json({ success: true, entriesFixed: entries, linesReclassified: reclassified, hesabiStart });
});

// ── 5. PRO EXPORT — HTML / Print-ready PDF ────────────────────────
app.get('/api/export/report-html', requireAuth, requirePermission('reports', 'export'), (req, res) => {
  const db = loadDB();
  const { type = 'journal', from = '', to = new Date().toISOString().slice(0,10) } = req.query;
  const company = db.companyInfo || {};
  const cName = company.name || 'بوبيان';
  const cur = company.currency || 'د.ك';

  const titles = { journal:'دفتر اليومية', trial:'ميزان المراجعة', pnl:'قائمة الدخل', balance:'الميزانية العمومية' };
  const title = titles[type] || 'تقرير';

  let body = '';
  if (type === 'journal') {
    let jes = (db.journalEntries||[]);
    if (from) jes = jes.filter(e=>e.date>=from);
    if (to)   jes = jes.filter(e=>e.date<=to);
    jes.sort((a,b)=>a.date.localeCompare(b.date));
    const rows = jes.flatMap(e=>(e.lines||[]).map(l=>`<tr>
      <td>${e.date}</td><td>${e.ref||e.id||''}</td><td>${e.description||e.desc||''}</td>
      <td>${l.accountCode||''}</td><td>${l.accountName||''}</td>
      <td class="num">${parseFloat(l.debit||0)>0?parseFloat(l.debit).toFixed(3):''}</td>
      <td class="num">${parseFloat(l.credit||0)>0?parseFloat(l.credit).toFixed(3):''}</td></tr>`)).join('');
    const totD = jes.flatMap(e=>e.lines||[]).reduce((s,l)=>s+parseFloat(l.debit||0),0);
    const totC = jes.flatMap(e=>e.lines||[]).reduce((s,l)=>s+parseFloat(l.credit||0),0);
    body = `<table><thead><tr><th>التاريخ</th><th>المرجع</th><th>البيان</th><th>كود</th><th>الحساب</th><th>مدين</th><th>دائن</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="5" style="font-weight:bold">الإجمالي</td><td class="num bold">${totD.toFixed(3)}</td><td class="num bold">${totC.toFixed(3)}</td></tr></tfoot></table>`;
  } else if (type === 'trial') {
    const bm = {};
    for (const je of (db.journalEntries||[])) {
      if (from&&je.date<from) continue; if (to&&je.date>to) continue;
      for (const ln of (je.lines||[])) {
        if (!ln.accountCode) continue;
        if (!bm[ln.accountCode]) bm[ln.accountCode]={dr:0,cr:0,name:''};
        bm[ln.accountCode].dr+=parseFloat(ln.debit||0);
        bm[ln.accountCode].cr+=parseFloat(ln.credit||0);
        if (ln.accountName) bm[ln.accountCode].name=ln.accountName;
      }
    }
    const rows = Object.entries(bm).sort((a,b)=>a[0].localeCompare(b[0])).map(([code,b])=>`<tr>
      <td>${code}</td><td>${b.name}</td>
      <td class="num">${b.dr>0?b.dr.toFixed(3):''}</td>
      <td class="num">${b.cr>0?b.cr.toFixed(3):''}</td></tr>`).join('');
    const tD=Object.values(bm).reduce((s,b)=>s+b.dr,0);
    const tC=Object.values(bm).reduce((s,b)=>s+b.cr,0);
    body = `<table><thead><tr><th>كود الحساب</th><th>اسم الحساب</th><th>مدين</th><th>دائن</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="2" class="bold">الإجمالي</td><td class="num bold">${tD.toFixed(3)}</td><td class="num bold">${tC.toFixed(3)}</td></tr></tfoot></table>`;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8">
<title>${title} — ${cName}</title>
<style>
*{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1e293b;margin:0;padding:24px;direction:rtl}
.header{text-align:center;border-bottom:3px solid #2563eb;padding-bottom:16px;margin-bottom:20px}
.header h1{font-size:22px;margin:0 0 4px;color:#1e293b}.header .sub{color:#64748b;font-size:12px;margin:2px 0}
table{width:100%;border-collapse:collapse}.th{background:#2563eb;color:#fff;padding:8px 10px;font-size:11px;text-align:right;border:1px solid #1d4ed8}
td{border:1px solid #e2e8f0;padding:6px 8px;font-size:11px}tr:nth-child(even){background:#f8fafc}
.num{text-align:left;font-variant-numeric:tabular-nums}.bold{font-weight:700}
tfoot tr{background:#f0f4f8;font-weight:700}
.footer{margin-top:20px;text-align:center;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px}
.printbtn{background:#2563eb;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:14px;cursor:pointer;margin-bottom:16px}
@media print{.printbtn{display:none}@page{margin:15mm}body{padding:0}}
</style></head><body>
<div style="text-align:center"><button class="printbtn" onclick="window.print()">🖨️ طباعة / حفظ PDF</button></div>
<div class="header"><h1>${cName}</h1><p class="sub">${title}</p>
<p class="sub">الفترة: ${from||'كل الفترات'} — ${to} | العملة: ${cur}</p>
<p class="sub">تاريخ الإصدار: ${new Date().toLocaleDateString('ar-KW',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p></div>
${body}
<div class="footer">بوبيان للمحاسبة الذكية · تم الإنشاء تلقائياً · ${new Date().toISOString()}</div>
</body></html>`);
});

// ── 6. SAVE JOURNAL FROM TEMPLATE ─────────────────────────────────
// P0.11 (saveDB call-site audit): converted to durable-before-ack; the
// pre-existing reliance on Express's synchronous throw→next(err) forwarding
// (for JournalValidationError from appendJournalEntry) does NOT extend to a
// rejected async saveDB() promise, so this now needs its own try/catch.
app.post('/api/journal-from-template', requireAuth, tenantMiddleware, requirePermission('journal', 'add'), async (req, res, next) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const db = loadDB();
    const { templateId, date, description, amounts } = req.body;
    const template = (db.journalMappings||[]).find(t=>t.id===templateId);
    if (!template) return res.status(404).json({ error: 'القالب غير موجود' });

    // P0.12 (closes P6-097)
    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const fingerprint = computeFingerprint('journal:from-template', { templateId, date, description, amounts });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'journal:from-template', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, entry: claim.record.resultReference });
      }
      idemRecord = claim.record;
    }

    const lines = template.lines.map((l,i) => ({
      accountCode: l.accountCode, accountName: l.accountName,
      debit:  parseFloat(amounts?.[i]?.debit  ?? l.debit  ?? 0),
      credit: parseFloat(amounts?.[i]?.credit ?? l.credit ?? 0),
      notes: l.notes || ''
    }));
    const entry = {
      id: genId('JE-'), date: date||new Date().toISOString().slice(0,10),
      description: description||template.name, ref: `TPL-${template.id.slice(-6)}`,
      type: 'template', lines, createdAt: new Date().toISOString(), createdBy: req.user?.username
    };
    try {
      appendJournalEntry(db, entry, { unshift: true });
      if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, entry, entry.id, entry.id);
    } catch (mutErr) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      throw mutErr;
    }
    try {
      await saveDB(db, { durable: true });
    } catch (saveErr) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      throw saveErr;
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, entry });
  } catch (err) {
    if (err instanceof JournalValidationError) return res.status(err.status || 400).json({ error: err.message, code: err.code });
    next(err);
  }
});

// ── 7. EXCEL GRID — BULK JOURNAL SAVE ─────────────────────────────
// P0.2 — Step 13: validate the WHOLE batch first; only commit if every
// entry is valid. A single bad row (unbalanced/locked-period/phantom
// account) used to still leave the other, valid rows half-imported —
// now either the entire batch is saved or none of it is.
// P0.11 (saveDB call-site audit): converted to durable-before-ack + explicit
// try/catch (a rejected async saveDB() promise is not caught by Express's
// synchronous-throw forwarding that the rest of this handler used to rely on).
app.post('/api/journal/bulk', requireAuth, tenantMiddleware, requirePermission('journal', 'add'), async (req, res, next) => {
  const isMongo = !isFileFallbackMode();
  let idemRecord = null;
  try {
    const db = loadDB();
    const { entries } = req.body;
    if (!Array.isArray(entries)||!entries.length)
      return res.status(400).json({ error: 'entries[] مطلوبة' });

    // P0.12 (closes P6-097)
    const idemKey = extractIdempotencyKey(req);
    if (idemKey) {
      const v = validateIdempotencyKey(idemKey);
      if (!v.ok) return res.status(400).json({ error: v.error, code: 'IDEMPOTENCY_KEY_INVALID' });
      const fingerprint = computeFingerprint('journal:bulk', { entries });
      const claim = await claimIdempotencyKey(db, isMongo, req.tenantId || 'default', 'journal:bulk', idemKey, fingerprint);
      if (!claim.claimed && claim.record.status === 'COMPLETED') {
        return res.json({ success: true, idempotentReplay: true, ...claim.record.resultReference });
      }
      idemRecord = claim.record;
    }

    const candidates = entries.map(e => ({
      id: genId('JE-'), date: e.date||new Date().toISOString().slice(0,10),
      description: e.description||e.desc||'', ref: e.ref||'', type: 'grid',
      lines: e.lines||[], createdAt: new Date().toISOString(), createdBy: req.user?.username
    }));

    const { valid, invalid } = validateJournalBatch(db, candidates);
    if (invalid.length) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      return res.status(400).json({
        success: false,
        error: `تعذّر حفظ الدفعة — ${invalid.length} من ${candidates.length} قيداً غير صالح. لم يُحفظ أي قيد من الدفعة.`,
        errors: invalid.map(x => ({ ref: x.entry.ref || '?', error: x.error, code: x.code })),
        saved: 0,
      });
    }

    if (!db.journalEntries) db.journalEntries=[];
    valid.forEach(entry => db.journalEntries.unshift(entry));
    const resultRef = { saved: valid.length, errors: [] };
    if (idemRecord) completeIdempotencyClaim(db, isMongo, idemRecord, resultRef, null, null);
    try {
      await saveDB(db, { durable: true });
    } catch (saveErr) {
      if (idemRecord) await releaseIdempotencyClaim(db, isMongo, idemRecord);
      throw saveErr;
    }
    if (idemRecord && isMongo) await safeFinalizeIdempotencyClaimMongo(idemRecord);
    res.json({ success: true, ...resultRef });
  } catch (err) {
    next(err);
  }
});

console.log('✅ Data Entry Layer v1: Templates, SmartSuggest, BankImport, AutoCategorize, ProExport, BulkJournal loaded');

// ══════════════════════════════════════════════════════════════════════════════
// ADVANCED REPORTS, AI ADVISOR, EMAIL / TELEGRAM DELIVERY
// ══════════════════════════════════════════════════════════════════════════════

// ── Doctor Performance Report ─────────────────────────────────────────────────
// P0.6A — Step 20 (P6-033): this report always returned zero for every
// doctor/every metric — it filtered `db.dailyData` by `.doctor` (a field
// parseDailyIncome() never produces on any row) and filtered
// `db.commissionHistory` by `doctorId`/`status`/`amount`/`paidAt`, none of
// which exist anywhere else in this codebase (db.doctors has no `id` field
// at all; commissionHistory actually uses `doctor` (name string),
// `paid` (boolean), `commission`, `payDate` — see updateCommissions()).
// Rewritten to read the real fields: paymentsData (which does carry
// `.doctor`/`.total`) for revenue, and commissionHistory's real field
// names, joined by doctor NAME throughout.
app.get('/api/reports/doctor-performance', requireAuth, requirePermission('reports', 'view'), (req, res) => {
  const db = loadDB();
  const { from, to } = req.query;
  const inR = d => (!from || d >= from) && (!to || d <= to);
  const perf = (db.doctors || []).map(doc => {
    const payments = (db.paymentsData || []).filter(p => p.doctor === doc.name && p.doctor !== 'Advance' && inR(p.date));
    const revenue = payments.reduce((s, p) => s + (parseFloat(p.total) || 0), 0);
    const commPaid = (db.commissionHistory || [])
      .filter(c => c.doctor === doc.name && c.paid && inR((c.payDate || '').slice(0,10)))
      .reduce((s, c) => s + parseFloat(c.commission || 0), 0);
    const commPending = (db.commissionHistory || [])
      .filter(c => c.doctor === doc.name && !c.paid)
      .reduce((s, c) => s + parseFloat(c.commission || 0), 0);
    const sessions = payments.length;
    return {
      name: doc.name, specialty: doc.specialty || 'طبيب أسنان',
      revenue: parseFloat(revenue.toFixed(3)),
      commPaid: parseFloat(commPaid.toFixed(3)),
      commPending: parseFloat(commPending.toFixed(3)),
      sessions,
      avgPerSession: sessions ? parseFloat((revenue / sessions).toFixed(3)) : 0,
      netAfterComm: parseFloat((revenue - commPaid).toFixed(3)),
      margin: revenue > 0 ? parseFloat(((revenue - commPaid) / revenue * 100).toFixed(1)) : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue);
  res.json({ from, to, doctors: perf, totalRevenue: parseFloat(perf.reduce((s, d) => s + d.revenue, 0).toFixed(3)) });
});

// ── AI Financial Advisor ──────────────────────────────────────────────────────
app.post('/api/ai/advisor', requireAuth, requirePermission('financials', 'view'), rateLimit(10), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  const db = loadDB();
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  const now = new Date(), from = `${now.getFullYear()}-01-01`, to = now.toISOString().slice(0, 10);
  const bm = buildBalanceMap(db, from, to), coa = db.chartOfAccounts || [];
  const rev = coa.filter(a => a.code.startsWith('4')).reduce((s, a) => { const b = bm[a.code]; return s + (b ? (b.credit - b.debit) : 0); }, 0);
  const exp = coa.filter(a => a.code.startsWith('5')).reduce((s, a) => { const b = bm[a.code]; return s + (b ? (b.debit - b.credit) : 0); }, 0);
  const doctors = (db.doctors || []).slice(0, 10).map(d => d.name).join('، ');
  const topExp = coa.filter(a => a.code.startsWith('5'))
    .map(a => { const b = bm[a.code]; return { name: a.name, amt: b ? (b.debit - b.credit) : 0 }; })
    .sort((a, b) => b.amt - a.amt).slice(0, 5).map(e => `${e.name}: ${e.amt.toFixed(3)}`).join('، ');
  const ctx = `أنت مستشار مالي خبير لعيادة أسنان كويتية (بوبيان لطب الأسنان).
بيانات ${now.getFullYear()} حتى ${to}:
- الإيرادات YTD: ${rev.toFixed(3)} د.ك | المصاريف: ${exp.toFixed(3)} د.ك | صافي: ${(rev - exp).toFixed(3)} د.ك | هامش: ${rev > 0 ? ((rev - exp) / rev * 100).toFixed(1) : 0}%
- أكبر المصاريف: ${topExp || 'لا بيانات'} | الأطباء: ${doctors || 'لم يُسجَّل'}
- عدد القيود: ${db.journalEntries?.length || 0} | الأصول الثابتة: ${(db.fixedAssets || []).filter(a => a.status === 'active').length}
أجب بالعربية بشكل عملي ومختصر (3-5 جمل). لا مقدمات.`;
  try {
    const answer = await callAI({
      model: 'claude-haiku-4-5-20251001', max_tokens: 700,
      messages: [{ role: 'user', content: `${ctx}\n\nسؤال: ${question}` }],
    });
    res.json({ answer, context: { revenue: parseFloat(rev.toFixed(3)), expenses: parseFloat(exp.toFixed(3)), netIncome: parseFloat((rev - exp).toFixed(3)) } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AI Revenue Forecast ───────────────────────────────────────────────────────
app.get('/api/ai/forecast', requireAuth, requirePermission('financials', 'view'), rateLimit(5), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  const db = loadDB(), now = new Date(), coa = db.chartOfAccounts || [];
  const historical = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const bm = buildBalanceMap(db, `${key}-01`, `${key}-31`);
    const rev = coa.filter(a => a.code.startsWith('4')).reduce((s, a) => { const b = bm[a.code]; return s + (b ? (b.credit - b.debit) : 0); }, 0);
    historical.push({ month: key, revenue: parseFloat(rev.toFixed(3)) });
  }
  const prompt = `بيانات إيرادات آخر 6 أشهر (د.ك):\n${historical.map(m => `${m.month}: ${m.revenue}`).join('\n')}\nتوقع الـ 3 أشهر القادمة. أجب بـ JSON فقط:\n{"m1":{"month":"YYYY-MM","revenue":0,"confidence":"high|medium|low"},"m2":{"month":"YYYY-MM","revenue":0},"m3":{"month":"YYYY-MM","revenue":0},"trend":"جملة واحدة","avg":0}`;
  try {
    const text = await callAI({ model: 'claude-haiku-4-5-20251001', max_tokens: 350, messages: [{ role: 'user', content: prompt }] });
    const m = text.match(/\{[\s\S]*\}/);
    res.json({ historical, forecast: m ? JSON.parse(m[0]) : { trend: 'بيانات غير كافية', avg: 0 } });
  } catch(e) {
    // الذكاء الاصطناعي غير متاح (رصيد/شبكة)؟ لا ننهار — نرجع توقعاً إحصائياً بسيطاً (اتجاه خطي)
    const vals = historical.map(h => h.revenue);
    const n = vals.length, avg = n ? vals.reduce((s, v) => s + v, 0) / n : 0;
    const slope = n > 1 ? (vals[n - 1] - vals[0]) / (n - 1) : 0;
    const mk = (k) => { const d = new Date(now.getFullYear(), now.getMonth() + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
    const proj = (k) => parseFloat(Math.max(0, vals[n - 1] + slope * k || avg).toFixed(3));
    res.json({
      historical, aiUnavailable: true,
      forecast: {
        m1: { month: mk(1), revenue: proj(1), confidence: 'low' },
        m2: { month: mk(2), revenue: proj(2) },
        m3: { month: mk(3), revenue: proj(3) },
        trend: 'توقع إحصائي مبسّط (خدمة الذكاء الاصطناعي غير متاحة حالياً: ' + (String(e.message).includes('credit') ? 'رصيد API منتهٍ' : 'تعذّر الاتصال') + ')',
        avg: parseFloat(avg.toFixed(3)),
      },
    });
  }
});

// ── AI Monthly Narrative Report ───────────────────────────────────────────────
app.post('/api/ai/monthly-report', requireAuth, requirePermission('financials', 'view'), rateLimit(5), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  const db = loadDB();
  const { month } = req.body;
  if (!month) return res.status(400).json({ error: 'month required' });
  const bm = buildBalanceMap(db, `${month}-01`, `${month}-31`);
  const coa = db.chartOfAccounts || [];
  const rev = coa.filter(a => a.code.startsWith('4')).reduce((s, a) => { const b = bm[a.code]; return s + (b ? (b.credit - b.debit) : 0); }, 0);
  const exp = coa.filter(a => a.code.startsWith('5')).reduce((s, a) => { const b = bm[a.code]; return s + (b ? (b.debit - b.credit) : 0); }, 0);
  const pd = new Date(month + '-01'); pd.setMonth(pd.getMonth() - 1);
  const pk = `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}`;
  const pm = buildBalanceMap(db, `${pk}-01`, `${pk}-31`);
  const pRev = coa.filter(a => a.code.startsWith('4')).reduce((s, a) => { const b = pm[a.code]; return s + (b ? (b.credit - b.debit) : 0); }, 0);
  const jeCount = (db.journalEntries || []).filter(je => je.date?.startsWith(month)).length;
  const topExp = coa.filter(a => a.code.startsWith('5'))
    .map(a => { const b = bm[a.code]; return { name: a.name, amt: b ? (b.debit - b.credit) : 0 }; })
    .sort((a, b) => b.amt - a.amt).slice(0, 3).map(e => `${e.name}: ${e.amt.toFixed(3)} د.ك`).join('، ');
  const prompt = `اكتب تقريراً مالياً شهرياً احترافياً بالعربية لعيادة بوبيان لطب الأسنان — ${month}.
البيانات: إيرادات ${rev.toFixed(3)} د.ك (السابق: ${pRev.toFixed(3)}, تغيير: ${pRev > 0 ? ((rev - pRev) / pRev * 100).toFixed(1) : 'N/A'}%) | مصاريف ${exp.toFixed(3)} | صافي ${(rev - exp).toFixed(3)} | هامش ${rev > 0 ? ((rev - exp) / rev * 100).toFixed(1) : 0}% | قيود: ${jeCount} | أكبر المصاريف: ${topExp || 'لا بيانات'}
الشكل: 3 فقرات قصيرة (ملخص الأداء، أبرز المؤشرات، التوصيات). أسلوب مهني ومختصر.`;
  try {
    const report = await callAI({ model: 'claude-sonnet-4-6', max_tokens: 900, messages: [{ role: 'user', content: prompt }] });
    res.json({ month, report, summary: { revenue: parseFloat(rev.toFixed(3)), expenses: parseFloat(exp.toFixed(3)), netIncome: parseFloat((rev - exp).toFixed(3)), prevRevenue: parseFloat(pRev.toFixed(3)), changePct: pRev > 0 ? parseFloat(((rev - pRev) / pRev * 100).toFixed(1)) : 0 } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AI Auto-Categorize Expense ────────────────────────────────────────────────
app.post('/api/ai/categorize-expense', requireAuth, requirePermission('expenses', 'add'), rateLimit(30), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  const db = loadDB();
  const { description, amount } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });
  const coa5 = (db.chartOfAccounts || []).filter(a => a.code.startsWith('5'));
  const coaList = coa5.length
    ? coa5.map(a => `${a.code}: ${a.name}`).join('\n')
    : '5100: مصاريف طبية\n5200: رواتب وأجور\n5300: إيجار\n5400: كهرباء ومياه\n5500: تسويق وإعلان\n5600: صيانة ومعدات\n5700: إهلاك الأصول\n5800: مصاريف إدارية\n5900: مصاريف أخرى';
  const prompt = `صنّف هذا المصروف في الحساب الأنسب:\n${coaList}\nالمصروف: "${description}"${amount ? ` — ${amount} د.ك` : ''}\nأجب بـ JSON فقط: {"code":"5XXX","name":"اسم الحساب","confidence":0.95,"reason":"سبب قصير"}`;
  try {
    const text = await callAI({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content: prompt }] });
    const m = text.match(/\{[\s\S]*\}/);
    res.json(m ? JSON.parse(m[0]) : { code: '5900', name: 'مصاريف أخرى', confidence: 0.5, reason: 'تصنيف افتراضي' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Telegram: Send Daily Report on demand ────────────────────────────────────
function buildDailySummaryText(db) {
  const now = new Date(), today = now.toISOString().slice(0, 10);
  const bm = buildBalanceMap(db, today, today), coa = db.chartOfAccounts || [];
  const tRev = coa.filter(a => a.code.startsWith('4')).reduce((s, a) => { const b = bm[a.code]; return s + (b ? (b.credit - b.debit) : 0); }, 0);
  const tExp = coa.filter(a => a.code.startsWith('5')).reduce((s, a) => { const b = bm[a.code]; return s + (b ? (b.debit - b.credit) : 0); }, 0);
  const mn = now.toISOString().slice(0, 7);
  const mm = buildBalanceMap(db, `${mn}-01`, `${mn}-31`);
  const mRev = coa.filter(a => a.code.startsWith('4')).reduce((s, a) => { const b = mm[a.code]; return s + (b ? (b.credit - b.debit) : 0); }, 0);
  const mExp = coa.filter(a => a.code.startsWith('5')).reduce((s, a) => { const b = mm[a.code]; return s + (b ? (b.debit - b.credit) : 0); }, 0);
  // P0.6B — Step 28 (NEW-B / P6-070): `db.anomalies` is never written
  // anywhere in this codebase — the real, authoritative anomaly detection
  // is computeAnomalies()/detectAnomalies() (same engine GET /api/anomalies
  // uses). The old line always evaluated to 0, so this report's "⚠️
  // شذوذات" line never appeared even with real, active anomalies.
  const anom = computeAnomalies(db).length;
  return `📊 *تقرير بوبيان اليومي — ${today}*\n\n🌟 *اليوم*\nإيرادات: ${tRev.toFixed(3)} د.ك\nمصاريف: ${tExp.toFixed(3)} د.ك\nصافي: ${(tRev - tExp).toFixed(3)} د.ك\n\n📅 *${mn}*\nإيرادات: ${mRev.toFixed(3)} د.ك\nمصاريف: ${mExp.toFixed(3)} د.ك\nصافي: ${(mRev - mExp).toFixed(3)} د.ك | هامش: ${mRev > 0 ? ((mRev - mExp) / mRev * 100).toFixed(1) : 0}%\n\n${anom > 0 ? `⚠️ شذوذات: ${anom}\n\n` : ''}_تقرير آلي — نظام بوبيان_`;
}

// P0.4A — Step 4: sending a report externally (Telegram/email) is a side
// effect that leaves the tenant's data boundary even though it doesn't
// mutate a balance — gated + audited like any other privileged action.
app.post('/api/reports/send-telegram', requireAuth, requirePermission('reports', 'export'), async (req, res) => {
  if (typeof bot === 'undefined' || !bot) return res.status(503).json({ error: 'Telegram bot not configured' });
  const db = loadDB(), cfg = loadConfig();
  const ids = (cfg.telegramChatIds || []).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'لم يتم تسجيل أي Telegram chat. أرسل /start للبوت أولاً.' });
  const text = buildDailySummaryText(db);
  let sent = 0;
  for (const id of ids) { try { await bot.sendMessage(id, text, { parse_mode: 'Markdown' }); sent++; } catch(e) {} }
  appendAuditEvent(db, { req, action: 'report.sent_telegram', resourceType: 'report', after: { sent, total: ids.length } });
  saveDB(db);
  res.json({ success: true, sent, total: ids.length });
});

// ── Email Report ──────────────────────────────────────────────────────────────
app.post('/api/reports/send-email', requireAuth, requirePermission('reports', 'export'), async (req, res) => {
  const cfg = loadConfig();
  const { to, month } = req.body;
  const emailTo = to || cfg.reportEmail;
  if (!emailTo) return res.status(400).json({ error: 'لم يُحدَّد بريد إلكتروني' });
  if (!cfg.smtpHost) return res.status(400).json({ error: 'يرجى إعداد SMTP في إعدادات التقارير' });
  const db = loadDB(), mn = month || new Date().toISOString().slice(0, 7);
  const bm = buildBalanceMap(db, `${mn}-01`, `${mn}-31`), coa = db.chartOfAccounts || [];
  const rev = coa.filter(a => a.code.startsWith('4')).reduce((s, a) => { const b = bm[a.code]; return s + (b ? (b.credit - b.debit) : 0); }, 0);
  const exp = coa.filter(a => a.code.startsWith('5')).reduce((s, a) => { const b = bm[a.code]; return s + (b ? (b.debit - b.credit) : 0); }, 0);
  const net = rev - exp, margin = rev > 0 ? (net / rev * 100) : 0;
  const comp = cfg.companyName || 'بوبيان لطب الأسنان';
  const g = (v, r, g) => v >= 0 ? g : r;
  const html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;background:#f1f5f9;padding:20px}.card{background:#fff;border-radius:12px;padding:24px;max-width:520px;margin:0 auto;border:1px solid #e2e8f0}h2{color:#1e293b;margin:0 0 4px}.sub{color:#64748b;font-size:13px;margin-bottom:20px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}.kpi{background:#f8fafc;border-radius:8px;padding:14px;text-align:center}.kl{font-size:11px;color:#64748b;margin-bottom:4px}.kv{font-size:20px;font-weight:700}.green{color:#059669}.red{color:#dc2626}.footer{text-align:center;font-size:11px;color:#94a3b8;margin-top:14px}</style></head><body><div class="card"><h2>${comp}</h2><div class="sub">التقرير المالي — ${mn}</div><div class="grid"><div class="kpi"><div class="kl">الإيرادات</div><div class="kv">${rev.toFixed(3)} <span style="font-size:13px">د.ك</span></div></div><div class="kpi"><div class="kl">المصاريف</div><div class="kv">${exp.toFixed(3)} <span style="font-size:13px">د.ك</span></div></div><div class="kpi"><div class="kl">صافي الربح</div><div class="kv ${g(net, 'red', 'green')}">${net.toFixed(3)} <span style="font-size:13px">د.ك</span></div></div><div class="kpi"><div class="kl">هامش الربح</div><div class="kv ${g(margin, 'red', 'green')}">${margin.toFixed(1)}%</div></div></div><div class="footer">تقرير آلي من نظام بوبيان المحاسبي</div></div></body></html>`;
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: cfg.smtpHost, port: parseInt(cfg.smtpPort || 587), secure: cfg.smtpPort == '465', auth: { user: cfg.smtpUser, pass: cfg.smtpPass } });
    await t.sendMail({ from: `"${comp}" <${cfg.smtpUser}>`, to: emailTo, subject: `التقرير المالي — ${mn}`, html });
    { const db2 = loadDB(); appendAuditEvent(db2, { req, action: 'report.sent_email', resourceType: 'report', after: { to: emailTo, month: mn } }); saveDB(db2); }
    res.json({ success: true, to: emailTo, month: mn });
  } catch(e) { res.status(500).json({ error: 'فشل إرسال البريد: ' + e.message }); }
});

// ── Report Settings (SMTP + email) ───────────────────────────────────────────
// P0.4A: this stores an SMTP password in config — admin-only, matches the
// "settings" tab (no non-admin DEFAULT_ROLES role has it), audited without
// ever putting smtpPass itself into the audit event.
app.post('/api/settings/report', requireAuth, requireAdminAction('settings.report_update'), (req, res) => {
  const cfg = loadConfig();
  const { reportEmail, smtpHost, smtpPort, smtpUser, smtpPass, dailyReportEnabled } = req.body;
  const u = { ...cfg };
  if (reportEmail !== undefined)          u.reportEmail = reportEmail;
  if (smtpHost !== undefined)             u.smtpHost = smtpHost;
  if (smtpPort !== undefined)             u.smtpPort = smtpPort;
  if (smtpUser !== undefined)             u.smtpUser = smtpUser;
  if (smtpPass !== undefined)             u.smtpPass = smtpPass;
  if (dailyReportEnabled !== undefined)   u.dailyReportEnabled = dailyReportEnabled;
  saveConfig(u);
  { const db = loadDB(); appendAuditEvent(db, { req, action: 'settings.report_updated', resourceType: 'config', after: { reportEmail: u.reportEmail, smtpHost: u.smtpHost, dailyReportEnabled: u.dailyReportEnabled } }); saveDB(db); }
  res.json({ success: true });
});

app.get('/api/settings/report', requireAuth, requirePermission('settings', 'view'), (req, res) => {
  const cfg = loadConfig();
  res.json({ reportEmail: cfg.reportEmail || '', smtpHost: cfg.smtpHost || '', smtpPort: cfg.smtpPort || 587, smtpUser: cfg.smtpUser || '', dailyReportEnabled: cfg.dailyReportEnabled !== false });
});

// ============================================================
// ── MULTI-TENANCY & SUBSCRIPTION ROUTES (SaaS) ──────────────
// ============================================================
// R3 — P6-037: POST /api/tenants/register moved to server.js:~1210 (right
// before the global `app.use('/api', requireAuth, tenantMiddleware)` gate)
// — it was registered here, thousands of lines AFTER that global mount, so
// it silently inherited requireAuth despite its own comment explicitly
// saying "public — no auth required". This is a REAL, currently-shipped
// blocker: public/landing.html already has a fully wired self-service
// signup form (#registerOverlay/submitRegister()) calling this exact
// endpoint — decisive evidence the current product target genuinely
// includes self-service SaaS registration, not just single-company
// provisioning. See the route's new location for the handler itself.

// ── Get current tenant info ───────────────────────────────────
app.get('/api/tenant', requireAuth, tenantMiddleware, async (req, res) => {
  try {
    // Single-clinic / file-fallback mode: multi-tenancy needs MongoDB.
    if (require('mongoose').connection.readyState !== 1) {
      return res.json({ tenant: { tenantId: 'default', name: 'العيادة', plan: 'enterprise', status: 'active', mode: 'local' }, subscription: null });
    }
    const info = await getTenantInfo(req.tenantId);
    res.json(info);
  } catch (e) {
    // R4 (Part P): getTenantInfo() runs unwrapped Mongoose queries — a
    // connection/timeout error can surface raw driver text.
    console.error('❌ Get tenant info error:', e.message);
    res.status(500).json({ error: 'تعذّر جلب بيانات المستأجر' });
  }
});

// ── Stripe: Create checkout session ──────────────────────────
// P0.4A — Step 5: migrated from an inline `role!=='admin'` check to the
// centralized requireAdminAction() helper — same exact access (admin only),
// now also emits authorization.denied on rejection and a billing audit
// event on success, instead of a bare 403 with no trace.
app.post('/api/subscription/checkout', requireAuth, tenantMiddleware, requireAdminAction('subscription.checkout'), async (req, res) => {
  if (!stripe.isConfigured()) return res.status(503).json({ error: 'بوابة الدفع غير مضبوطة — تواصل مع الدعم' });

  const { plan } = req.body;
  if (!['starter', 'pro', 'enterprise'].includes(plan)) return res.status(400).json({ error: 'الخطة غير صالحة' });

  try {
    const tenant = await Tenant.findOne({ tenantId: req.tenantId });
    if (!tenant) return res.status(404).json({ error: 'المستأجر غير موجود' });

    const { url } = await stripe.createCheckoutSession({
      tenantId: req.tenantId,
      plan,
      email: tenant.email,
      name:  tenant.name,
    });
    { const db = loadDB(); appendAuditEvent(db, { req, action: 'subscription.checkout_started', resourceType: 'subscription', resourceId: req.tenantId, after: { plan } }); saveDB(db); }
    res.json({ url });
  } catch (e) {
    // R4 (Part P): wraps a Mongoose query plus a Stripe API call — either
    // can throw raw driver/HTTP-client error text.
    console.error('❌ Subscription checkout error:', e.message);
    res.status(500).json({ error: 'تعذّر بدء عملية الدفع — حاول مرة أخرى' });
  }
});

// ── Stripe: Get current subscription ─────────────────────────
app.get('/api/subscription', requireAuth, tenantMiddleware, async (req, res) => {
  try {
    // Single-clinic / file-fallback mode: subscriptions require MongoDB.
    if (require('mongoose').connection.readyState !== 1) {
      return res.json({ tenantId: 'default', plan: 'enterprise', status: 'active', mode: 'local' });
    }
    const sub = await Subscription.findOne({ tenantId: req.tenantId }).lean();
    if (!sub) return res.status(404).json({ error: 'لا يوجد اشتراك' });
    res.json(sub);
  } catch (e) {
    // R4 (Part P): unwrapped Mongoose query — a connection/timeout error
    // can surface raw driver text.
    console.error('❌ Get subscription error:', e.message);
    res.status(500).json({ error: 'تعذّر جلب بيانات الاشتراك' });
  }
});

// ── Stripe: Cancel subscription ───────────────────────────────
app.delete('/api/subscription', requireAuth, tenantMiddleware, requireAdminAction('subscription.cancel'), async (req, res) => {
  if (!stripe.isConfigured()) return res.status(503).json({ error: 'بوابة الدفع غير مضبوطة' });

  try {
    const sub = await Subscription.findOne({ tenantId: req.tenantId });
    if (!sub?.stripeSubscriptionId) return res.status(404).json({ error: 'لا يوجد اشتراك Stripe نشط' });

    await stripe.cancelSubscription(sub.stripeSubscriptionId);
    sub.cancelAtPeriodEnd = true;
    await sub.save();
    { const db = loadDB(); appendAuditEvent(db, { req, action: 'subscription.cancelled', resourceType: 'subscription', resourceId: req.tenantId, after: { cancelAtPeriodEnd: true } }); saveDB(db); }
    res.json({ success: true, message: 'سيتم إلغاء الاشتراك عند انتهاء الفترة الحالية' });
  } catch (e) {
    // R4 (Part P): wraps a Mongoose query/save plus a Stripe API call —
    // either can throw raw driver/HTTP-client error text.
    console.error('❌ Subscription cancel error:', e.message);
    res.status(500).json({ error: 'تعذّر إلغاء الاشتراك — حاول مرة أخرى' });
  }
});

// P0.5: the Stripe webhook route now lives near the top of this file
// (right after CORS setup, before express.json()/API_SECRET) — see the
// comment there for why. Kept out of this location deliberately.

// ── إبلاغ أعطال الواجهة + عرض سجل الأعطال للمدير (CLAUDE.md مرحلة 5) ──
app.post('/api/log/client-error', requireAuth, rateLimit(20), (req, res) => {
  const { msg, src, line } = req.body || {};
  logCrash('client', msg, { src: String(src || '').slice(0, 160), line, user: req.user?.username });
  res.json({ success: true });
});
app.get('/api/admin/errors', requireAuth, requireAdminAction('errors.view'), (req, res) => {
  const db = loadDB();
  res.json({ errors: db.errorLog || [] });
});

// ── 404 handler — must be AFTER all routes ───────────
app.use((req, res) => {
  res.status(404).json({ error: 'المسار غير موجود' });
});

// ── مراقبة الأعطال الداخلية (CLAUDE.md مرحلة 5): كل عطل يُسجَّل ليُعرف قبل العميل ──
function logCrash(source, msg, extra) {
  try {
    const db = loadDB();
    (db.errorLog = db.errorLog || []).unshift({
      at: new Date().toISOString(), source, msg: String(msg || '').slice(0, 400), ...extra,
    });
    if (db.errorLog.length > 200) db.errorLog = db.errorLog.slice(0, 200);
    saveDB(db);
  } catch { /* لا نسمح لتسجيل العطل نفسه أن يعطّل */ }
}

// ── Global error handler (must have 4 args) ──────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // P0.2 — the centralized journal-integrity guard (lib/journalGuard.js)
  // throws JournalValidationError instead of each of the ~40 journal-creation
  // routes formatting its own response. Surface it with its real status/code
  // (400 for validation failures, 409 for a locked-period rejection) instead
  // of falling through to a generic 500.
  if (err instanceof JournalValidationError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  // P0.12 — the idempotency service throws this for a reused key (409/
  // IDEMPOTENCY_KEY_REUSED) or a still-in-flight duplicate (409/
  // IDEMPOTENCY_IN_PROGRESS) — same centralized-error-type pattern as
  // JournalValidationError above. `existing` is intentionally omitted from
  // the response — it's an internal record, not meant for the client.
  if (err instanceof IdempotencyConflictError) {
    return res.status(err.status || 409).json({ error: err.message, code: err.code });
  }
  // R5 (staging validation, adversarial review — P3, live-reproduced):
  // express.json() throws a SyntaxError for unparsable request bodies —
  // this is a client input mistake (malformed JSON), not a server fault,
  // but it fell through to the generic 500 below unconditionally, which
  // pollutes error logs/alerting with harmless client errors and gives the
  // caller no actionable "your JSON was malformed" signal.
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'صيغة JSON غير صالحة في جسم الطلب' });
  }
  console.error('❌ Unhandled error:', err.message);
  if (/Not allowed by CORS/.test(err.message || ''))
    return res.status(403).json({ error: 'الطلب مرفوض (CORS) — أضف نطاق موقعك إلى ALLOWED_ORIGINS' });
  logCrash('server', err.message, { path: req.path, method: req.method });
  res.status(500).json({ error: 'خطأ داخلي في الخادم' });
});

