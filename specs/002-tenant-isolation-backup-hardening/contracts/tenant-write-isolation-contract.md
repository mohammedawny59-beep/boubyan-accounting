# Contract: Tenant-Safe Mongo Writes (A) + Tenant-Safe Config (B)

**Revised in Design Remediation Pass 1, corrected again in a second pass** — Section A is unchanged (survived both `/speckit-analyze` rounds). Section B is substantially redesigned (research.md Decision 2, 3); the second pass additionally restores a dropped default-tenant `AppConfig` scoping fix, corrects `_flushTenantToMongo()`'s early-return guard, and adds file-mode config-persist timer/shutdown wiring.

Internal function contracts — not HTTP endpoints. Callers are unaffected (`flushToMongo()`, `persistAll()`, every route that calls `loadConfig()`/`saveConfig()`); only the functions' internal filters/caching change.

## `persistUsers(users)` — default-tenant path (`lib/database.js:424`) — UNCHANGED

**Before**
```js
await User.deleteMany({ id: { $nin: ids } });        // or {} — matches every tenant
...
filter: { id: u.id }                                  // matches every tenant
update: { $set: { ...u } }                            // never writes tenantId
```

**After**
```js
await User.deleteMany(ids.length
  ? { ..._defaultTenantFilter, id: { $nin: ids } }
  : _defaultTenantFilter);
...
filter: { ..._defaultTenantFilter, id: u.id }
update: { $set: { tenantId: 'default', ...u } }       // normalizes forward
```

**Guarantees**: unchanged from the original pass — never matches a real non-`default` tenant's document; still matches a legacy no-`tenantId`-field document; every write normalizes `tenantId:'default'` forward.

## `persistEntityKey(key, data)` — default-tenant path (`lib/database.js:445`) — UNCHANGED

`updateOne({..._defaultTenantFilter, key}, {$set:{tenantId:'default', data, updatedAt}}, {upsert:true})`. Unchanged.

## `loadConfig()` / `saveConfig(cfg)` (`lib/database.js:801-815`) — REDESIGNED

**Rejected (original pass) design**: an inline `AppConfig.findOne(...).lean()` inside `loadConfig()`'s non-default branch. **Rejected because**: `loadConfig()` is, and must remain, synchronous — a Mongo round-trip cannot execute inline inside a sync function, and none of `loadConfig()`'s ~18 existing synchronous call sites in `server.js` may become `await`ers (spec.md FR-022).

**Contract (revised)** — two-part design mirroring `warmTenantCache()`/`loadDB()` exactly:

```
// Async — called by tenantMiddleware, never by a route handler directly
async function warmTenantConfigCache(tenantId):
  if tenantId === 'default': return                      # already synchronously populated at boot
  if _tenantConfigCaches.has(tenantId): return            # already warm
  if _useFileFallback:
    doc = fs.existsSync(_tenantConfigFilePath(tenantId)) ? fs.readJsonSync(...) : null
  else:
    doc = (await AppConfig.findOne({tenantId, key:'config'}).lean())?.data
  resolved = deepMerge(_defaultConfig, doc || {})
  _tenantConfigCaches.set(tenantId, resolved)

// Synchronous — unchanged call signature, every existing caller untouched
function loadConfig():
  tid = _currentTenantId()
  if tid === 'default':
    return deepMerge(_defaultConfig, _configCache)         # UNCHANGED behavior
  if _tenantConfigCaches.has(tid):
    return _tenantConfigCaches.get(tid)
  throw new Error(`Tenant config not warmed for "${tid}"`)  # fail closed — a bug, not a cold path

// Synchronous — unchanged call signature
function saveConfig(cfg):
  tid = _currentTenantId()
  if tid === 'default':
    _configCache = cfg; _configDirty = true; schedulePersist()   # UNCHANGED behavior
  else:
    _tenantConfigCaches.set(tid, cfg)
    if _useFileFallback:
      _scheduleTenantConfigFilePersist(tid)                       # new: writes _tenantConfigFilePath(tid)
    else:
      _tenantConfigDirty.add(tid)
      _scheduleTenantPersist(tid)                                 # EXISTING per-tenant debounce timer (reused)
```

**`lib/tenantMiddleware.js:94`** gains one line, alongside the existing warm call:
```js
await warmTenantCache(tenantId);
await warmTenantConfigCache(tenantId);   // NEW
if (!_refreshLiveUser(req)) return res.status(401)...
```

**`_flushTenantToMongo(tenantId)`'s early-return guard — corrected, second pass** (`lib/database.js:41`):
```js
// Before (Pass 1, wrong — only checks entity-dirty state):
if (!db || dirty.size === 0) return;

// After (second pass):
if ((!db || dirty.size === 0) && !_tenantConfigDirty.has(tenantId)) return;
```
Without this, a tenant whose *only* pending Mongo-mode change in a debounce window is a `saveConfig()` call (no `saveDB()` in the same window) would hit the old guard and return before ever reaching the config-flush branch — silently dropping the write.

**File-mode config persistence — timer map and shutdown wiring (NEW, second pass)**: `_scheduleTenantConfigFilePersist(tid)` registers into a new `_tenantConfigFileTimers = new Map()` (mirroring the existing `_tenantFileTimers`/`_scheduleTenantFilePersist` pair, `lib/database.js:691-712`), added to the P0.11 reset block, and `_flushAllTenantsOnShutdown()` (`lib/database.js:823-853`) is extended to flush any pending entry in it via `_atomicWriteJsonSync(_tenantConfigFilePath(tid), _tenantConfigCaches.get(tid))` before shutdown completes — exactly paralleling the existing entity-data handling. Omitting this (Pass 1's gap) would reintroduce the SIGTERM data-loss bug class this codebase's own P0.5 milestone already closed for entity data.

**Default tenant's own AppConfig calls — corrected, second pass (Pass 1 incorrectly claimed no change was needed here)**: `initConfig()`'s read (`lib/database.js:612`, `AppConfig.findOne({key:'config'})`) and both of its legacy-migration writes (`:621-625`, `:633-637`), plus `flushToMongo()`'s default-tenant config write (`:490-494`, `AppConfig.updateOne({key:'config'},...)`), get the identical `_defaultTenantFilter` + normalize-forward treatment as `persistUsers()`/`persistEntityKey()`:
```js
// initConfig() read:
AppConfig.findOne({ ..._defaultTenantFilter, key: 'config' }).lean()
// every default-tenant write (initConfig()'s two migration writes, flushToMongo()'s write):
AppConfig.updateOne(
  { ..._defaultTenantFilter, key: 'config' },
  { $set: { tenantId: 'default', data: /* ... */, updatedAt: new Date() } },
  { upsert: true },
)
```
Without this, once any non-default tenant has its own `AppConfig` document (permitted by the compound unique index `{tenantId,key}`, `models/AppConfig.js:10`), these three call sites' unscoped `{key:'config'}` filter could read or overwrite the wrong tenant's document, since Mongo gives no ordering guarantee for a filter matching more than one document.

**Guarantees**
- A `saveConfig()` call while `_currentTenantId() === 'A'` MUST NOT become visible to a `loadConfig()` call while `_currentTenantId() === 'B'`, for any `A !== B`.
- `loadConfig()`'s signature, synchronicity, and every existing call site are **completely unchanged** — the only new observable behavior is a thrown error, and only when a non-`default` tenant's config was never warmed (unreachable via any existing route, since `tenantMiddleware` always warms it first — spec.md FR-022).
- `_useFileFallback`: non-`default` tenant config is read from and written to `data/tenants/<tid>.config.json` (a sibling to that tenant's `<tid>.json` data file, both sanitized via the same path helper) — **no Mongo call of any kind is attempted in file mode** (spec.md FR-023) — and a pending debounced write is never lost on graceful shutdown (see above).
- `default`'s own Mongo read/write is genuinely scoped by `_defaultTenantFilter` + normalize-forward, at all three of its existing call sites, not merely asserted to be (see above).
- `_tenantConfigCaches`/`_tenantConfigDirty`/`_tenantConfigFileTimers` are all cleared by `initDB()`'s existing P0.11 cross-backend reset block (`lib/database.js:945-951`), alongside `_tenantCaches`/`_tenantDirty`/`_tenantFileTimers` — no config survives a same-process backend switch.

## Test contract (revised, second pass)

1. **Isolation**: Tenant A's `saveConfig()`, followed by warming and reading Tenant B's config, never observes Tenant A's value.
2. **Cross-tenant write safety**: unchanged from the original pass (seed Tenant B, write via default's path, assert unchanged).
3. **Legacy compatibility**: unchanged (legacy no-`tenantId`-field `AppConfig` document, seeded via the raw driver per spec.md FR-027, with an explicit read-back assertion that the field is genuinely absent before exercising the behavior under test — see `tenant-restore-contract.md`'s test-quality remediation — is normalized in place, never duplicated).
4. **Cold-miss fail-closed**: call `loadConfig()` for a non-`default` tenant that was never warmed (bypassing `tenantMiddleware` deliberately, to simulate the bug this guard exists for) and assert it throws — never returns `_defaultConfig` or another tenant's cached value.
5. **File-fallback persistence**: under `DB_FILE_ONLY=true`, `saveConfig()` for a non-`default` tenant, restart the cache (clear `_tenantConfigCaches`), `warmTenantConfigCache()` again, and assert the value survives — with zero Mongo connection attempted at any point (assert via a Mongo-connection spy/mock that no query fires).
6. **Cross-backend reset**: warm a non-`default` tenant's config under one backend, call `initDB()` again against a different, empty backend, and assert the tenant's config cache does not carry over (mirrors the existing P0.11 regression test pattern for `_tenantCaches`).
7. **Default-tenant cross-tenant AppConfig safety (NEW, second pass)**: seed a real `AppConfig` document for a non-default tenant with `key:'config'`, then trigger `default`'s own `initConfig()`/`flushToMongo()` read/write path; assert `default`'s operations only ever read/write `default`'s own document, never the other tenant's.
8. **Config-only Mongo-mode flush (NEW, second pass)**: as a non-default tenant in Mongo mode, call `saveConfig()` alone (no `saveDB()` in the same window); force the debounce timer; assert the `AppConfig` document was actually written.
9. **Config-only file-mode shutdown flush (NEW, second pass)**: as a non-default tenant under `DB_FILE_ONLY=true`, call `saveConfig()` alone, then invoke `shutdownDB()` before the debounce timer would have fired naturally; assert the config file was written before shutdown completed.
