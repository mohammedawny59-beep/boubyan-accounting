# Contract: Tenant-Safe Mongo Writes (A) + Tenant-Safe Config (B)

**Revised in Design Remediation Pass 1** — Section A is unchanged (survived `/speckit-analyze`). Section B is substantially redesigned (research.md Decision 2, 3).

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

**Guarantees**
- A `saveConfig()` call while `_currentTenantId() === 'A'` MUST NOT become visible to a `loadConfig()` call while `_currentTenantId() === 'B'`, for any `A !== B`.
- `loadConfig()`'s signature, synchronicity, and every existing call site are **completely unchanged** — the only new observable behavior is a thrown error, and only when a non-`default` tenant's config was never warmed (unreachable via any existing route, since `tenantMiddleware` always warms it first — spec.md FR-022).
- `_useFileFallback`: non-`default` tenant config is read from and written to `data/tenants/<tid>.config.json` (a sibling to that tenant's `<tid>.json` data file, both sanitized via the same path helper) — **no Mongo call of any kind is attempted in file mode** (spec.md FR-023).
- `default`'s own Mongo read/write gets the identical `_defaultTenantFilter` + normalize-forward treatment as User/EntityChunk (unchanged from the original pass).
- `_tenantConfigCaches`/`_tenantConfigDirty` are cleared by `initDB()`'s existing P0.11 cross-backend reset block (`lib/database.js:945-951`), alongside `_tenantCaches`/`_tenantDirty` — no config survives a same-process backend switch.

## Test contract (revised)

1. **Isolation**: Tenant A's `saveConfig()`, followed by warming and reading Tenant B's config, never observes Tenant A's value.
2. **Cross-tenant write safety**: unchanged from the original pass (seed Tenant B, write via default's path, assert unchanged).
3. **Legacy compatibility**: unchanged (legacy no-`tenantId`-field `AppConfig` document, seeded via the raw driver per spec.md FR-027 — see the test-quality remediation in `tenant-restore-contract.md` — is normalized in place, never duplicated).
4. **Cold-miss fail-closed (NEW)**: call `loadConfig()` for a non-`default` tenant that was never warmed (bypassing `tenantMiddleware` deliberately, to simulate the bug this guard exists for) and assert it throws — never returns `_defaultConfig` or another tenant's cached value.
5. **File-fallback persistence (NEW)**: under `DB_FILE_ONLY=true`, `saveConfig()` for a non-`default` tenant, restart the cache (clear `_tenantConfigCaches`), `warmTenantConfigCache()` again, and assert the value survives — with zero Mongo connection attempted at any point (assert via a Mongo-connection spy/mock that no query fires).
6. **Cross-backend reset (NEW)**: warm a non-`default` tenant's config under one backend, call `initDB()` again against a different, empty backend, and assert the tenant's config cache does not carry over (mirrors the existing P0.11 regression test pattern for `_tenantCaches`).
