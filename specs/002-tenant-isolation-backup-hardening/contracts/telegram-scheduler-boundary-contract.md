# Contract: Telegram / Scheduler Default-Tenant-Only Boundary (C)

**Revised in Design Remediation Pass 1**: a fifth route (`GET /api/monitor/status`) is added to the guarded list (research.md Decision 3) — `/speckit-analyze` found it reads the same process-global `bot`/config state the other four protect, but was excluded because the original design only reasoned about routes that could *change* that state, not ones that merely *read* it (spec.md FR-032).

HTTP contract — five existing routes gain one explicit check each. No route's existing `requireAuth`/`tenantMiddleware`/`requirePermission`/`requireAdminAction` gate is weakened, removed, or reordered; the new check is inserted immediately after those, before any Telegram/scheduler side effect (or, for the status route, before any process-global state is read into the response).

## Guarded routes

| Route | File:line | Existing gate (unchanged) |
|---|---|---|
| `POST /api/telegram/start` | `server.js:2678` | `requireAuth, requirePermission('telegram','edit')` |
| `POST /api/monitor/inventory` | `server.js:9822` | `requireAuth, requireAdminAction('monitor.trigger_inventory')` |
| `POST /api/monitor/monthly-report` | `server.js:9826` | `requireAuth, requireAdminAction('monitor.trigger_monthly_report')` |
| `POST /api/reports/send-telegram` | `server.js:15987` | `requireAuth, requirePermission('reports','export')` |
| `GET /api/monitor/status` | `server.js:9830` | `requireAuth, requirePermission('financials','view')` |

## New check (identical shape on all five)

```js
if (req.tenantId && req.tenantId !== 'default') {
  return res.status(403).json({
    error: 'ميزة تيليجرام/الجدولة الآلية متاحة حالياً لعيادة بوبيان الافتراضية فقط — الدعم الكامل لكل مستأجر قادم في مرحلة لاحقة',
    code: 'TELEGRAM_DEFAULT_TENANT_ONLY',
  });
}
```

**Response contract**: `403`, structured JSON body with a stable `code` field (`TELEGRAM_DEFAULT_TENANT_ONLY`) so a future frontend can detect and message this distinctly from a generic permission failure — never a silent `200` that pretends the action happened, and never a silent fallback that acts on the `default` tenant's behalf without telling the caller.

## Why these five and not the ~50 `bot.sendMessage()` call sites inside `setupBot()`

`setupBot(bot)`'s inbound-message handlers (`server.js:2700-3735`) fire from Telegram's own polling loop — outside any `runAsTenant()` context — so they already, unconditionally, operate on the `default` tenant's `loadDB()`/`loadConfig()` (AsyncLocalStorage has no active store, `_currentTenantId()` falls back to `'default'`, `lib/database.js:24-26`). The only way a non-`default` tenant could ever cause those handlers to run against a bot that isn't `default`'s own is by reaching route (1) above and reconfiguring the process-global `bot` singleton. Blocking route (1) for non-`default` tenants makes every downstream handler's tenant identity moot — they can only ever be `default`'s bot, talking to `default`'s Telegram chat, mutating `default`'s data, exactly as today's single-clinic deployment already behaves. Routes (2)-(5) are blocked independently because they are additional entry points that touch the same singleton/its config directly (mutating it, or — route 5 — merely reading and disclosing its live status to a caller of any tenant), not because the root-cause fix in (1) is insufficient — defense in depth, not redundant plumbing. Route 5 (`GET /api/monitor/status`) uses the identical `403`/`code` response, chosen for consistency over a softer "safe tenant-local status" alternative — a caller integrating against this boundary should not need to special-case one of five otherwise-identical routes (research.md Decision 3).

## Already-safe, unchanged (verified, not modified)

`runScheduledTasks()` (`server.js:4072`) and the `startMonitorSchedule()`-driven automatic timers run from process-boot-installed `setTimeout`/interval callbacks, never inside `runAsTenant()`. No code change; listed here so `/speckit-analyze` and a future reviewer don't mistake "not modified" for "not checked."

## Test contract

1. Authenticate as a non-`default` tenant user with every permission needed to normally pass each route's existing gate; call each of the five routes; assert `403` + `code:'TELEGRAM_DEFAULT_TENANT_ONLY'`, and assert `global._tgBot`/`bot` is unchanged (for route 1) / no message was sent (for routes 2-4, via a mocked `sendMessage`) / the response body discloses no `botActive`/`chatIdSet` value (for route 5).
2. Authenticate as a `default`-tenant user with the same permissions; call each route; assert unchanged pre-existing behavior (regression guard — this phase must not break the single-clinic flow every current test already exercises).
3. Confirm via code inspection (not a runtime test — no real Telegram credentials in this repo) that no sixth route touching the process-global `bot`/`global._tgBot` singleton this contract exists to protect — via the identifiers `bot`, `global._tgBot`, or `TelegramBot` — exists beyond the five listed (re-confirmed by a full-file grep during remediation pass 1, research.md Decision 3); `/speckit-tasks` MUST re-run that same grep immediately before implementation to catch any route added since. **Lean-review-pass correction, MEDIUM (this contract's own claim was previously imprecise about what "no sixth route" actually means)**: this grep is scoped to the `bot` singleton this contract protects, not to "every telegram/monitor-shaped route in the codebase" — a sixth route, `POST /api/telegram/webhook` (`server.js:4849`, a Telegram-bot-webhook receiver in `lib/telegram.js` for the unrelated agent-approval governance workflow, sending via raw `https.request` rather than the `bot`/`global._tgBot` singleton), does exist and is correctly outside this grep's match, and correctly outside this contract's own tenant-isolation scope — it never reads or writes any tenant-scoped `loadDB()`/`loadConfig()` data, so it cannot leak or corrupt any tenant's financial data across the boundary this contract exists to guard. It DOES have its own, unrelated authorization gap (missing an admin-role check that its sibling `/api/agents/approvals/:id/approve|reject` REST endpoints both enforce) — flagged separately for dedicated remediation with its own review, since it is a role-based-access-control defect, not a tenant-isolation defect, and out of this feature's own scope. This test item's own wording is corrected here to state precisely what it verifies, rather than the broader, easily-misread "no sixth route... exists" claim.
