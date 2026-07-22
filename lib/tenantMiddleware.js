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
const { warmTenantCache, runAsTenant } = require('./database');
const Tenant       = require('../models/Tenant');
const Subscription = require('../models/Subscription');

/**
 * Middleware: injects tenantId from JWT into req + AsyncLocalStorage.
 * Must run AFTER requireAuth (which sets req.user).
 */
function tenantMiddleware(req, res, next) {
  // requireAuth already verified token and set req.user
  const tenantId = req.user?.tenantId || 'default';
  req.tenantId = tenantId;

  // Wrap the rest of the request pipeline in the tenant's async context
  runAsTenant(tenantId, async () => {
    try {
      // Warm up cache for non-default tenants
      if (tenantId !== 'default') {
        await warmTenantCache(tenantId);
      }
      next();
    } catch (e) {
      next(e);
    }
  });
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
