'use strict';
/**
 * Tenant Middleware — CLAUDE.md Multi-tenancy
 *
 * يستخرج tenantId من JWT ويحقنه في:
 * 1. req.tenantId  — للاستخدام المباشر في الـ routes
 * 2. AsyncLocalStorage — لكي تعمل loadDB()/saveDB() تلقائياً بالتينانت الصحيح
 *
 * الأساس: بيانات كل عميل معزولة تماماً.
 */
const mongoose      = require('mongoose');
const { warmTenantCache, runAsTenant } = require('./database');
const Tenant       = require('../models/Tenant');
const Subscription = require('../models/Subscription');

/**
 * Middleware: injects tenantId from JWT into req + AsyncLocalStorage.
 * Must run AFTER requireAuth (which sets req.user).
 *
 * P0.1 — fail closed: a non-default tenantId must resolve to a real, ACTIVE
 * tenant whenever a registry exists to check against (MongoDB mode). We never
 * silently fall back to the default tenant's data for an invalid/suspended
 * tenant identity. In file/offline mode there is no central Tenant registry —
 * the per-tenant isolated cache in lib/database.js (loadDB/saveDB) is the
 * safety boundary instead (an unknown tenantId there resolves to its own
 * empty, isolated sandbox — never the default tenant's data).
 */
/**
 * P0.4 — Step 4: close the stale-JWT-privilege hole. The JWT only ever
 * carries the user's role/tenantId as of LOGIN time (12h lifetime); without
 * this check, a user demoted or disabled after login would keep whatever
 * role their token says until it expires. This re-reads the user's CURRENT
 * record from the (already tenant-scoped) db on every authenticated
 * request and overwrites req.user.role with the live value, so:
 *   - a role downgrade/upgrade takes effect on the very next request, and
 *   - a disabled/deleted user is rejected immediately (401), not just
 *     "still logged in with old permissions" for up to 12 more hours.
 * loadDB() is synchronous (reads the already-warmed in-memory cache), so
 * this adds no extra I/O beyond what warmTenantCache() already did.
 */
function _refreshLiveUser(req) {
  const { loadDB } = require('./database');
  const db = loadDB();
  const liveUser = (db.users || []).find(u => u.id === req.user.id);
  if (!liveUser || liveUser.active === false) return false;
  req.user.role = liveUser.role;
  req.user.fullName = liveUser.fullName;
  req.liveUser = liveUser;
  return true;
}

const STALE_PRIVILEGE_MSG = 'الحساب معطّل أو غير موجود — يرجى تسجيل الدخول مجدداً';

function tenantMiddleware(req, res, next) {
  // requireAuth already verified token and set req.user
  const tenantId = req.user?.tenantId || 'default';
  req.tenantId = tenantId;

  if (tenantId === 'default') {
    // Legacy/default-clinic flow — always allowed, unchanged behavior.
    return runAsTenant('default', () => {
      if (!_refreshLiveUser(req)) return res.status(401).json({ error: STALE_PRIVILEGE_MSG });
      next();
    });
  }

  // Returning the promise is harmless for Express (it ignores middleware
  // return values) and lets tests await this function directly.
  return (async () => {
    try {
      if (mongoose.connection.readyState === 1) {
        const tenant = await Tenant.findOne({ tenantId }).lean();
        if (!tenant || tenant.status !== 'active') {
          // P0.4 — Step 12: audit the rejection itself. The rejected tenant
          // has no trustworthy log of its own (that's exactly what's being
          // rejected), so this goes to the default tenant's audit log —
          // the one an admin/support user can actually read.
          try {
            const { loadDB, saveDB } = require('./database');
            const { appendAuditEvent } = require('./auditLog');
            await runAsTenant('default', () => {
              const auditDb = loadDB();
              appendAuditEvent(auditDb, {
                req, action: 'tenant_access.denied', resourceType: 'tenant', resourceId: tenantId,
                outcome: 'failure', metadata: { reason: !tenant ? 'unknown_tenant' : 'tenant_suspended' },
              });
              saveDB(auditDb);
            });
          } catch { /* never let audit logging block the 403 */ }
          return res.status(403).json({ error: 'الحساب غير نشط أو غير موجود — تواصل مع الدعم' });
        }
      }
      await runAsTenant(tenantId, async () => {
        await warmTenantCache(tenantId);
        if (!_refreshLiveUser(req)) return res.status(401).json({ error: STALE_PRIVILEGE_MSG });
        next();
      });
    } catch (e) {
      next(e);
    }
  })();
}

/**
 * Check subscription limits before allowing operations.
 * Usage: router.post('/entries', requireAuth, checkLimit('transactions'), handler)
 */
function checkLimit(resource) {
  return async (req, res, next) => {
    const tenantId = req.tenantId || 'default';
    if (tenantId === 'default') return next(); // clinic mode — no limits

    try {
      const sub = await Subscription.findOne({ tenantId });
      if (!sub) return res.status(402).json({ error: 'اشتراك غير موجود — يرجى الترقية' });
      if (sub.status === 'cancelled') return res.status(402).json({ error: 'الاشتراك منتهي — يرجى التجديد' });

      const limits = Subscription.LIMITS[sub.plan] || Subscription.LIMITS.trial;

      if (resource === 'seats') {
        const { loadDB } = require('./database');
        const db = loadDB();
        const userCount = (db.users || []).filter(u => u.active).length;
        if (userCount >= limits.seats) {
          return res.status(403).json({
            error: `وصلت للحد الأقصى من المستخدمين (${limits.seats}) في خطة ${sub.plan}`,
            upgrade: true,
          });
        }
      }

      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Get tenant info + subscription status.
 * Utility for routes that need to show plan info.
 */
async function getTenantInfo(tenantId) {
  const [tenant, sub] = await Promise.all([
    Tenant.findOne({ tenantId }).lean(),
    Subscription.findOne({ tenantId }).lean(),
  ]);
  return { tenant, subscription: sub };
}

module.exports = { tenantMiddleware, checkLimit, getTenantInfo };
