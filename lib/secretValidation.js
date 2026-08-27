'use strict';
/**
 * P0.5 — Step 17/18: production must not silently boot with a dangerous
 * secret default (empty JWT key, "secret"/"changeme", a localhost Mongo URI,
 * the documented default admin password, a Stripe key with no matching
 * webhook secret). This module only DECIDES — it never calls
 * process.exit()/console itself — so it is safe to unit-test in isolation
 * (Secrets A/B in tests/production-hardening.test.js) without booting a
 * real server or touching real secrets. The caller (server.js) is
 * responsible for acting on the verdict.
 *
 * Never logs/returns the actual secret VALUES — only which check failed.
 */

const DANGEROUS_JWT_VALUES = new Set([
  'secret', 'changeme', 'change-me', 'change_me', 'password', '123456',
  'test', 'default', 'jwt-secret', 'your-secret-key',
  'boubyan-dental-dev-only-not-for-production',
]);

/**
 * @param {object} env  process.env (or an isolated fake for tests)
 * @returns {{ ok: boolean, problems: Array<{level:'fatal'|'warn', code:string, message:string}> }}
 */
function validateProductionSecrets(env) {
  const problems = [];
  if (env.NODE_ENV !== 'production') return { ok: true, problems };

  const jwt = String(env.JWT_SECRET || '').trim();
  if (!jwt) {
    problems.push({ level: 'fatal', code: 'JWT_SECRET_MISSING', message: 'JWT_SECRET is not set' });
  } else if (DANGEROUS_JWT_VALUES.has(jwt.toLowerCase())) {
    problems.push({ level: 'fatal', code: 'JWT_SECRET_DANGEROUS_DEFAULT', message: 'JWT_SECRET is a known-dangerous/placeholder value' });
  } else if (jwt.length < 32) {
    problems.push({ level: 'fatal', code: 'JWT_SECRET_TOO_SHORT', message: 'JWT_SECRET is shorter than 32 characters' });
  }

  const mongoUri = String(env.MONGO_URI || '').trim();
  const explicitFileMode = env.DB_FILE_ONLY === 'true';
  if (!explicitFileMode) {
    if (!mongoUri) {
      problems.push({ level: 'warn', code: 'MONGO_URI_MISSING', message: 'MONGO_URI is not set — the built-in localhost default will be used and will almost certainly fail in a hosted environment' });
    } else if (/^mongodb:\/\/(127\.0\.0\.1|localhost)/i.test(mongoUri)) {
      problems.push({ level: 'warn', code: 'MONGO_URI_LOCALHOST', message: 'MONGO_URI points at localhost — unlikely to be reachable from a hosted production process' });
    }
  }

  // R3 — NEW-R1-SEC-01 fix: this used to check ONLY the literal-match case
  // (`=== 'Admin@2026'`) at `warn` level — an UNSET variable (the common
  // real-world case, since server.js/lib/database.js all fall back to the
  // exact same published '.env.example' default when it's empty) produced
  // no warning at all, and even the matched case never blocked boot.
  // Promoted to `fatal` (same class as JWT_SECRET above) and the unset case
  // is now caught explicitly — production must refuse to seed a known-
  // password admin account rather than warn and continue.
  const adminPw = String(env.ADMIN_DEFAULT_PASSWORD || '').trim();
  if (!adminPw) {
    problems.push({ level: 'fatal', code: 'ADMIN_DEFAULT_PASSWORD_MISSING', message: 'ADMIN_DEFAULT_PASSWORD is not set — the server would silently seed the admin account with the publicly-known .env.example default' });
    // R3 (adversarial review): the match below used to be case-sensitive
    // (`===`) with no length floor — unlike the JWT check above (which
    // lowercases before comparing, line 32, and enforces a 32-char floor,
    // line 34) — so 'admin@2026'/'ADMIN@2026' (a trivially-guessable case
    // variant of the one PUBLISHED value) and even 'ADMIN_DEFAULT_PASSWORD=1'
    // both passed validation fatal-free in production.
  } else if (adminPw.toLowerCase() === 'admin@2026') {
    problems.push({ level: 'fatal', code: 'ADMIN_DEFAULT_PASSWORD_UNCHANGED', message: 'ADMIN_DEFAULT_PASSWORD is still the documented .env.example default (or a case variant of it)' });
  } else if (adminPw.length < 8) {
    problems.push({ level: 'fatal', code: 'ADMIN_DEFAULT_PASSWORD_TOO_SHORT', message: 'ADMIN_DEFAULT_PASSWORD is shorter than 8 characters — matches this app\'s own minimum password-length policy (see /api/auth/reset)' });
  }

  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
    problems.push({ level: 'warn', code: 'STRIPE_WEBHOOK_SECRET_MISSING', message: 'STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing — checkout can start but the webhook that activates a subscription will reject every event' });
  }

  if (env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    problems.push({ level: 'warn', code: 'STRIPE_TEST_KEY_IN_PRODUCTION', message: 'STRIPE_SECRET_KEY looks like a Stripe TEST-mode key (sk_test_...) in a production environment' });
  }

  const fatal = problems.some(p => p.level === 'fatal');
  return { ok: !fatal, problems };
}

module.exports = { validateProductionSecrets, DANGEROUS_JWT_VALUES };
