# Contract: Telegram / Scheduler Default-Tenant-Only Boundary (C)

HTTP contract — four existing routes gain one explicit check each. No route's existing `requireAuth`/`tenantMiddleware`/`requirePermission`/`requireAdminAction` gate is weakened, removed, or reordered; the new check is inserted immediately after those, before any Telegram/scheduler side effect.

## Guarded routes

| Route | File:line | Existing gate (unchanged) |
|---|---|---|
| `POST /api/telegram/start` | `server.js:2678` | `requireAuth, requirePermission('telegram','edit')` |
| `POST /api/monitor/inventory` | `server.js:9822` | `requireAuth, requireAdminAction('monitor.trigger_inventory')` |
| `POST /api/monitor/monthly-report` | `server.js:9826` | `requireAuth, requireAdminAction('monitor.trigger_monthly_report')` |
| `POST /api/reports/send-telegram` | `server.js:15987` | `requireAuth, requirePermission('reports','export')` |

## New check (identical shape on all four)

```js
if (req.tenantId && req.tenantId !== 'default') {
  return res.status(403).json({
    error: 'ميزة تيليجرام/الجدولة الآلية متاحة حالياً لعيادة بوبيان الافتراضية فقط — الدعم الكامل لكل مستأجر قادم في مرحلة لاحقة',
    code: 'TELEGRAM_DEFAULT_TENANT_ONLY',
  });
}
```

**Response contract**: `403`, structured JSON body with a stable `code` field (`TELEGRAM_DEFAULT_TENANT_ONLY`) so a future frontend can detect and message this distinctly from a generic permission failure — never a silent `200` that pretends the action happened, and never a silent fallback that acts on the `default` tenant's behalf without telling the caller.

## Why these four and not the ~50 `bot.sendMessage()` call sites inside `setupBot()`

`setupBot(bot)`'s inbound-message handlers (`server.js:2700-3735`) fire from Telegram's own polling loop — outside any `runAsTenant()` context — so they already, unconditionally, operate on the `default` tenant's `loadDB()`/`loadConfig()` (AsyncLocalStorage has no active store, `_currentTenantId()` falls back to `'default'`, `lib/database.js:24-26`). The only way a non-`default` tenant could ever cause those handlers to run against a bot that isn't `default`'s own is by reaching route (1) above and reconfiguring the process-global `bot` singleton. Blocking route (1) for non-`default` tenants makes every downstream handler's tenant identity moot — they can only ever be `default`'s bot, talking to `default`'s Telegram chat, mutating `default`'s data, exactly as today's single-clinic deployment already behaves. Routes (2)-(4) are blocked independently because they are additional entry points that touch the same singleton/its config directly, not because the root-cause fix in (1) is insufficient — defense in depth, not redundant plumbing.

## Already-safe, unchanged (verified, not modified)

`runScheduledTasks()` (`server.js:4072`) and the `startMonitorSchedule()`-driven automatic timers run from process-boot-installed `setTimeout`/interval callbacks, never inside `runAsTenant()`. No code change; listed here so `/speckit-analyze` and a future reviewer don't mistake "not modified" for "not checked."

## Test contract

1. Authenticate as a non-`default` tenant user with every permission needed to normally pass each route's existing gate; call each of the four routes; assert `403` + `code:'TELEGRAM_DEFAULT_TENANT_ONLY'`, and assert `global._tgBot`/`bot` is unchanged (for route 1) / no message was sent (for routes 2-4, via a mocked `sendMessage`).
2. Authenticate as a `default`-tenant user with the same permissions; call each route; assert unchanged pre-existing behavior (regression guard — this phase must not break the single-clinic flow every current test already exercises).
3. Confirm via code inspection (not a runtime test — no real Telegram credentials in this repo) that no fifth route touching `bot`/`global._tgBot`/`TelegramBot` exists beyond the four listed; `/speckit-tasks` MUST re-run the grep in research.md Decision 3 immediately before implementation to catch any route added between this plan and implementation.
