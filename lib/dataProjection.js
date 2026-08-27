'use strict';
/**
 * P0.4A — Primary Objective B: permission-aware projection for GET /api/data.
 *
 * Before this module, /api/data returned a shallow copy of the ENTIRE tenant
 * database (minus users[].passwordHash) to ANY authenticated user regardless
 * of role — a viewer/inventory/receptionist account got the same payload as
 * admin, including payroll, insurance, bank reconciliation, the audit log,
 * and (critically) db.passwordResets — an array of {token, userId, expiresAt}
 * that POST /api/auth/reset accepts with NO other proof of identity. Any
 * authenticated user could read another user's live reset token from
 * /api/data and take over that account. db.telegramToken (the tenant's
 * Telegram bot token, base64-"encoded" but not encrypted) was exposed the
 * same way.
 *
 * This module builds the response server-side per request, using the SAME
 * hasPermission()/isAdmin() engine every other route already uses — not a
 * second authorization model — so a user who cannot GET /api/payroll
 * directly cannot obtain the same data by reading /api/data either.
 */
const { hasPermission, isAdmin } = require('./authz');

// Never included in ANY /api/data response, for ANY role, including admin —
// these are secrets/tokens, not data an authenticated tenant user should
// ever need to read back through a bootstrap endpoint.
const NEVER_SEND_KEYS = ['passwordResets', 'telegramToken'];

// Collections that carry no access-relevant sensitivity — every authenticated
// tenant user may read these in full (company branding, period-lock booleans,
// fiscal-year/currency/decimal formatting settings — no fee rates or
// credentials live here). Matches the direct GET routes for the same data
// (/api/company, /api/period-lock, /api/accounting-settings), which are
// intentionally left at requireAuth-only for the same reason — Step 10
// requires the projection and the direct route to agree.
const PUBLIC_IN_TENANT_KEYS = ['companyInfo', 'lockedPeriods', 'accountingSettings'];

// Every other collection maps to the exact (tab, action) pair its equivalent
// direct read route already requires (e.g. payroll -> GET /api/payroll's
// requirePermission('payroll','view')) — kept as one table so the mapping is
// auditable in one place instead of scattered per-field ad hoc checks.
// 'admin' means "isAdmin(user) only" for domains with no tab representation
// (matches the requireAdminAction()-gated routes for the same resource).
const COLLECTION_PERMISSION = {
  journalEntries:     ['journal', 'view'],
  journalMappings:    ['journal', 'view'],
  anomalies:          ['journal', 'view'],
  dismissedAnomalies: ['journal', 'view'],
  monthClose:         ['journal', 'view'],
  pendingVoiceJE:     ['journal', 'view'],

  expenses:           ['expenses', 'view'],
  accruedExpenses:    ['expenses', 'view'],

  vendors:            ['vendors', 'view'],

  invItems:           ['inventory', 'view'],
  invCategories:      ['inventory', 'view'],
  invMovements:       ['inventory', 'view'],
  inventory:          ['inventory', 'view'],

  chartOfAccounts:    ['coa', 'view'],

  recurringExpenses:  ['recurring', 'view'],

  dailyData:          ['manual', 'view'],
  paymentsData:       ['manual', 'view'],

  doctorExpenses:     ['doctors', 'view'],
  doctorPayments:     ['doctors', 'view'],
  commissionHistory:  ['doctors', 'view'],

  uploadedFiles:      ['upload', 'view'],

  vouchers:           ['vouchers', 'view'],

  cashReconciliation: ['cashrecon', 'view'],

  insuranceClaims:    ['insurance', 'view'],

  budget:             ['financials', 'view'],

  pendingInvoices:    ['ai', 'view'],

  payroll:            ['payroll', 'view'],
  employees:          ['payroll', 'view'],

  scheduleConfig:     ['settings', 'view'],
  telegramChatId:     ['settings', 'view'],
  errorLog:           'admin',
  users:              'admin',
  roles:              'admin',
  auditLog:           'admin',
  assets:             'admin',
  fixedAssets:        'admin',
  patientAR:          'admin',
  bankRecons:              'admin',
  bankCommittedLineKeys:   'admin',
  bankMatchedLineIds:      'admin',
  networkReceivableCleared:'admin',
  bankReconciliation:      'admin',
};

// "doctors" needs FIELD-level (not just collection-level) projection: the
// existing /api/manual-entry workflow (used by receptionist/accountant, who
// have "manual" tab access but NOT the admin-only "doctors" tab) needs the
// {id, name} identity fields to populate its doctor picker — but target/
// commission/lab/insurance are compensation-rate fields that should still
// require "doctors" permission. Returning [] here would silently break that
// screen for the roles that actually use it today (Step 19 compatibility).
function projectDoctors(doctors, user, db) {
  const full = hasPermission(user, 'doctors', 'view', db);
  return (doctors || []).map(d => full
    ? d
    : { id: d.id, name: d.name });
}

/**
 * Build the permission-projected /api/data payload for the given user.
 * @param {object} db   the CURRENT tenant's db (already AsyncLocalStorage-scoped)
 * @param {object} user req.user (post live-role-refresh — see tenantMiddleware)
 */
function projectDataForUser(db, user) {
  const out = {};
  for (const [key, value] of Object.entries(db)) {
    if (NEVER_SEND_KEYS.includes(key)) continue;

    if (key === 'users') {
      if (isAdmin(user)) out.users = (value || []).map(({ passwordHash, ...u }) => u);
      continue; // never included at all for non-admin — matches GET /api/users being admin-only
    }
    if (key === 'doctors') {
      out.doctors = projectDoctors(value, user, db);
      continue;
    }
    if (PUBLIC_IN_TENANT_KEYS.includes(key)) { out[key] = value; continue; }

    const perm = COLLECTION_PERMISSION[key];
    if (perm === 'admin') {
      if (isAdmin(user)) out[key] = value;
      continue;
    }
    if (Array.isArray(perm)) {
      if (hasPermission(user, perm[0], perm[1], db)) out[key] = value;
      continue;
    }
    // Unmapped key (should not happen once COLLECTION_PERMISSION is kept in
    // sync with the db shape) — fail closed, never leak an unclassified field.
  }
  return out;
}

module.exports = { projectDataForUser, COLLECTION_PERMISSION, NEVER_SEND_KEYS, PUBLIC_IN_TENANT_KEYS };
