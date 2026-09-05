# Contract: Tenant-Safe Mongo Writes (A) + Tenant-Safe Config (B)

Internal function contracts — not HTTP endpoints. Callers are unaffected (`flushToMongo()`, `persistAll()`, every route that calls `loadConfig()`/`saveConfig()`); only the functions' internal filters change.

## `persistUsers(users)` — default-tenant path (`lib/database.js:424`)

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

**Guarantees**
- MUST NOT match, delete, or overwrite any document whose `tenantId` is a real non-`default` tenant identity.
- MUST still match a legacy document with no `tenantId` field, or `tenantId: null`, or `tenantId: 'default'` (all three shapes `_defaultTenantFilter` covers).
- Every document written by this path MUST carry an explicit `tenantId: 'default'` after the write, even if it did not before.

**Non-goal**: does not retroactively deduplicate a pre-existing pair of (legacy no-field doc, already-normalized doc) sharing the same `id` — see research.md Decision 1's residual-risk note.

## `persistEntityKey(key, data)` — default-tenant path (`lib/database.js:445`)

**Before**: `updateOne({key}, {$set:{data,updatedAt}}, {upsert:true})` — matches any tenant's chunk for that key.

**After**: `updateOne({..._defaultTenantFilter, key}, {$set:{tenantId:'default', data, updatedAt}}, {upsert:true})`.

**Guarantees**: identical shape to `persistUsers()` above — never touches a real tenant's `EntityChunk` document; always normalizes `tenantId` forward on write.

## `loadConfig()` / `saveConfig(cfg)` (`lib/database.js:801-815`)

**Contract (new)**:
```
loadConfig():
  tid = _currentTenantId()
  if tid === 'default':
    return deepMerge(_defaultConfig, _configCache)          # unchanged behavior
  else:
    if _tenantConfigCaches.has(tid): return cached value
    doc = AppConfig.findOne({ tenantId: tid, key: 'config' }).lean()
    resolved = deepMerge(_defaultConfig, doc?.data || {})
    _tenantConfigCaches.set(tid, resolved)
    return resolved

saveConfig(cfg):
  tid = _currentTenantId()
  if tid === 'default':
    _configCache = cfg; _configDirty = true; schedulePersist()  # unchanged behavior
  else:
    _tenantConfigCaches.set(tid, cfg)
    _tenantConfigDirty.add(tid)
    _scheduleTenantPersist(tid)   # existing per-tenant debounce timer
```

**Guarantees**
- A `saveConfig()` call while `_currentTenantId() === 'A'` MUST NOT become visible to a subsequent `loadConfig()` call while `_currentTenantId() === 'B'`, for any `A !== B`.
- `default`'s own Mongo read/write (inside the `tid==='default'` branch's underlying `initConfig()`/`flushToMongo()` calls) gets the identical `_defaultTenantFilter` + normalize-forward treatment as User/EntityChunk, for the identical legacy-record reason.
- A tenant's first-ever `loadConfig()` call (no existing `AppConfig` document) returns a merge over `_defaultConfig` — never `{}` or a crash.
- This contract does NOT decide whether a request lacking any resolved tenant context is allowed to reach `loadConfig()`/`saveConfig()` at all — that fail-closed decision belongs to `tenantMiddleware` (existing FR-002), not to these functions.

## Test contract (both)

1. **Isolation**: Tenant A saves a config value; Tenant B's `loadConfig()` in the same process never observes it (direct unit test against the two new Maps, no HTTP layer needed).
2. **Cross-tenant write safety**: seed a `User`/`EntityChunk` document for Tenant B; call the default-tenant `persistUsers()`/`persistEntityKey()` with data that would, under the old unscoped filter, have matched Tenant B's document (e.g. same `id`/`key`); assert Tenant B's document is byte-for-byte unchanged afterward.
3. **Legacy compatibility**: seed a `User`/`EntityChunk` document with no `tenantId` field at all; call the default-tenant write path; assert the *same* document is updated (not duplicated) and now carries `tenantId:'default'` explicitly.
4. **Default config legacy compatibility**: seed an `AppConfig` document with no `tenantId` field; call `saveConfig()` under `tid==='default'`; assert no duplicate `AppConfig` document is created.
