'use strict';
/**
 * P0.4 — Server-side authorization policy.
 *
 * Reuses the application's EXISTING permission model exactly as already
 * defined in lib/defaults.js (DEFAULT_ROLES: each role has a `tabs` array
 * and an `actions` map of tab -> [view|add|edit|delete|export]) and exactly
 * as already implemented by server.js's own `can(user, tab, action)`
 * helper. This module does not invent a new permission-string system — it
 * centralizes the SAME tab/action check so it can be reused as Express
 * middleware and unit-tested directly, instead of being hand-copied inline
 * across routes (`can()` was previously called from exactly one route).
 *
 * A second, narrower concept — admin-only resources — covers the handful of
 * things the existing UI never modeled as a tab at all (user/role
 * management, period lock/close, fixed assets, bank reconciliation). These
 * were already either explicitly `role==='admin'`-gated or completely
 * unguarded; DEFAULT_ROLES already grants every one of those tabs/screens
 * to `admin` only (no other role's `tabs` array lists them, so they were
 * already invisible in the UI to every non-admin role). Formalizing that as
 * "admin required" closes the server-side gap without changing who could
 * already see/use these screens.
 */

const { DEFAULT_ROLES } = require('./defaults');

/**
 * Pure permission check — identical logic to server.js's pre-existing
 * `can()`, but takes `db` explicitly (no implicit loadDB() call) so it is
 * directly unit-testable and has no hidden dependency on module state.
 */
function hasPermission(user, tab, action, db) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const roles = (db && db.roles) || {};
  const roleObj = roles[user.role] || DEFAULT_ROLES[user.role];
  if (!roleObj) return false;
  const allowed = (roleObj.actions || {})[tab] || [];
  return allowed.includes(action || 'view');
}

/** Admin-only resources with no tab/action equivalent in the existing model. */
function isAdmin(user) {
  return !!user && user.role === 'admin';
}

module.exports = { hasPermission, isAdmin };
