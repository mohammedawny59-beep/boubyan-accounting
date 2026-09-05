# Data Model: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**No new Mongoose models and no schema field changes to any existing model.** Every existing collection already carries the `tenantId` field and index this phase needs (`models/User.js:4`, `models/EntityChunk.js:5`, `models/AppConfig.js:4`, `models/Tenant.js:5`, `models/Subscription.js:5` — all re-verified this pass). This phase changes **which filters** existing write paths use, adds **two new logical file formats** (not Mongo models), and adds **one small new in-memory cache pair** mirroring an existing pattern.

## Existing entities — write-path scoping change only

### User (`models/User.js`)
| Field | Existing constraint | Change in this phase |
|---|---|---|
| `tenantId` | required, default `'default'`, part of compound unique indexes `{tenantId,id}` and `{tenantId,username}` | none to the schema. `persistUsers()` (`lib/database.js:424-443`) changes its **filter** from bare `{id}`/`{}` to `{..._defaultTenantFilter, id}` / `_defaultTenantFilter`, and its **update `$set`** gains an explicit `tenantId: 'default'` (see research.md Decision 1). The already-correct `_persistUsersTenant()` (non-default path, `:75-92`) is unchanged. |

### EntityChunk (`models/EntityChunk.js`)
| Field | Existing constraint | Change in this phase |
|---|---|---|
| `tenantId`, `key` | compound unique index `{tenantId,key}` (`:12`); each field also individually indexed (`:5-6`), which is why an unscoped `updateOne({key})` can match an arbitrary tenant's document | `persistEntityKey()` (`lib/database.js:445-451`) changes its filter to `{..._defaultTenantFilter, key}` and `$set` gains `tenantId:'default'`. `_persistEntityKeyTenant()` (non-default path) is unchanged. |

### AppConfig (`models/AppConfig.js`)
| Field | Existing constraint | Change in this phase |
|---|---|---|
| `tenantId`, `key` | compound unique index `{tenantId,key}` (`:10`) — schema already supports per-tenant config; nothing before this phase actually used the tenant dimension on this collection | `initConfig()`'s read (`lib/database.js:612`) and `flushToMongo()`'s write (`:488-496`) gain the same `_defaultTenantFilter` + normalize-forward treatment as User/EntityChunk. A parallel **non-default** read/write path is added for the first time (new, not a change to existing behavior — see "New in-memory state" below). |

### Tenant (`models/Tenant.js`) / Subscription (`models/Subscription.js`)
No write-path change. Read-only inputs to tenant-scoped backup (Decision 5/8) and to the restore target-validation step (existence/active-status check, skipped for `tenantId==='default'` per the verified absence of a registry row).

## New in-memory state (mirrors existing `_tenantCaches` pattern, `lib/database.js:17-22`)

| Name | Shape | Purpose |
|---|---|---|
| `_tenantConfigCaches` | `Map<tenantId, configObject>` | Per-tenant resolved config, lazily populated on first `loadConfig()` call for that tenant — same lazy-load shape as `_tenantCaches`/`_loadTenantDB()`. |
| `_tenantConfigDirty` | `Set<tenantId>` | Tenants with an unpersisted `saveConfig()` change, flushed by the **existing** per-tenant debounce timer in `_flushTenantToMongo()` (one added branch, not a new timer). |

Both are process-local, non-persisted, and rebuilt from Mongo on demand exactly like `_tenantCaches` already is — no new durability requirement.

## New logical file format 1 — Tenant-Scoped Backup File

Not a Mongo document; a JSON file written by `scripts/tenant-backup.js` to `backups/tenant-<tenantId>-<stamp>.json` (+ `.sha256` sidecar, reusing `computeChecksum()` unchanged from `lib/backupValidation.js:16-18`).

| Field | Type | Notes |
|---|---|---|
| `scope` | `'tenant'` (literal) | The discriminator that makes cross-feeding into the whole-instance restore path fail fast (research.md Decision 7). Whole-instance files never carry this field. |
| `schemaVersion` | integer, starts at `1` | Independent of the whole-instance file's `version` counter — never compared against it. |
| `tenantId` | string | The exact tenant this backup covers. For `default`, covers `_defaultTenantFilter`-matched records (Decision 1/5), not a naive `{tenantId:'default'}` equality set. |
| `createdAt` | ISO 8601 string | |
| `source` | `'mongodb'` \| `'file'` | Same meaning as the whole-instance format. |
| `recordCounts` | `{users, entityChunks, appConfigs, tenants, subscriptions}` (numbers, `0`/`1` for the singleton-per-tenant `appConfigs`/`tenants`/`subscriptions`) | Integrity metadata (spec.md requirement D) — compared against actual array lengths at both backup-write time and restore-validate time. |
| `collections` | `{users:[...], entityChunks:[...], appConfigs:[...], tenants:[...], subscriptions:[...]}` (mongodb source) **or** `database`/`config` (file source, `default` only) | `idempotencyRecords` deliberately excluded (research.md Decision 8). For `default`, `tenants`/`subscriptions` are legitimately empty arrays (Decision 5) — not a validation failure. |

## New logical file format 2 — Restore Checkpoint

Not a Mongo document; a JSON file at `backups/.restore-checkpoints/<runId>.json`, written/updated by `scripts/tenant-restore.js` during the staged sequence (research.md Decision 6). Purely operational bookkeeping for one CLI run — never read by the running application server, never part of tenant business data.

| Field | Type | Notes |
|---|---|---|
| `runId` | string | Random per invocation; also the synthetic staging `tenantId` suffix (`__restage__<targetTenantId>__<runId>`). |
| `targetTenantId` | string | The tenant being restored. |
| `backupFile` | string | Path of the backup file this run is restoring. |
| `startedAt` / `updatedAt` | ISO 8601 strings | |
| `stage` | `'validating' \| 'staging' \| 'staged-verified' \| 'swapping' \| 'completed' \| 'failed'` | Monotonically advances; never rewound. |
| `collectionsSwapped` | `string[]` | Appended to, one entry per collection, only after that collection's delete-old+repoint-staged step both succeed. **This is the recovery contract**: any collection not yet in this list still holds its exact pre-restore data; any collection in this list holds the backup's data. There is no state where a single collection is partially old/partially new. |
| `error` | string \| null | Set on failure; the file is left in place (never deleted) so an operator can inspect exactly where a failed run stopped. |

## State transitions

### Restore run (`scripts/tenant-restore.js`) — see `contracts/tenant-restore-contract.md` for the full contract
```
validating → staging → staged-verified → swapping → completed
                                              ↓
                                            failed (collectionsSwapped[] shows exactly how far it got)
```
No transition writes to a real tenant's live collections before `swapping`; no transition after `swapping` begins can revert a collection that has already been recorded in `collectionsSwapped`.

### Config resolution (`loadConfig()`) — new per-tenant branch, no change to existing state machine
```
_currentTenantId() === 'default'  → existing global _configCache / _defaultConfig merge (unchanged)
_currentTenantId() !== 'default'  → _tenantConfigCaches.get(tid) if cached
                                     else AppConfig.findOne({tenantId:tid,key:'config'}) merged over _defaultConfig, then cached
```

## Out of scope for this phase (documented, not silently dropped)

- **`scripts/detect-duplicate-default-records.js`** (research.md Decision 1's residual-risk follow-up) — a read-only reporting script for pre-existing duplicate default-tenant documents. Not required for this phase's fixes to be correct going forward; recommended as a separate, later operational task.
- Any schema/index change to `User`, `EntityChunk`, `AppConfig`, `Tenant`, `Subscription`, or `IdempotencyRecord`.
- Partial/per-collection tenant restore (spec.md FR-020 — full-tenant-replace only).
