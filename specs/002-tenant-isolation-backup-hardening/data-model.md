# Data Model: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Revised in Design Remediation Pass 1.** No new Mongoose *models* are added even after remediation — the restore lock (below) deliberately reuses the existing `EntityChunk` schema/index rather than introducing one. Two logical file formats are substantially redesigned; one new in-memory state pair is added (unchanged from the original pass, now also participating in the existing cross-backend reset).

## Existing entities — write-path scoping change only (UNCHANGED from original pass)

### User (`models/User.js`)
`persistUsers()` (`lib/database.js:424`) filter changes from `{id}`/`{}` to `{..._defaultTenantFilter, id}`/`_defaultTenantFilter`; `$set` gains `tenantId:'default'`. Unchanged by remediation — this fix survived analysis.

### EntityChunk (`models/EntityChunk.js`)
`persistEntityKey()` (`lib/database.js:445`) filter changes from `{key}` to `{..._defaultTenantFilter, key}`; `$set` gains `tenantId:'default'`. Unchanged by remediation. **New reuse, remediation pass 1**: this same model/collection, under a reserved key `'__restoreLock__'` deliberately outside `TENANT_BACKUP_ENTITY_KEYS`, is now also the restore-lock primitive (see "Restore Lock" below) — no schema change, no new index; the existing compound unique `{tenantId,key}` index (`:12`) is exactly what makes the lock's atomic-acquire semantics work.

### AppConfig (`models/AppConfig.js`)
Unchanged reasoning from the original pass, revised mechanism (research.md Decision 2): `loadConfig()`/`saveConfig()` stay synchronous; a new async `warmTenantConfigCache()` populates the per-tenant cache before any request-scoped synchronous read.

### Tenant (`models/Tenant.js`) / Subscription (`models/Subscription.js`)
**Removed from tenant-scoped backup/restore scope entirely (remediation pass 1, research.md Decision 10).** No write-path change (none was ever planned), and — new this pass — **no read-path involvement either**: these two models are never queried by `tenant-backup.js`/`tenant-restore.js` at all. `Tenant.slug`'s standalone unique index, and `Subscription`'s Stripe-linked fields, are simply never touched by this feature's tenant-scoped tooling.

## New in-memory state (mirrors existing `_tenantCaches` pattern, `lib/database.js:17-22`)

| Name | Shape | Purpose |
|---|---|---|
| `_tenantConfigCaches` | `Map<tenantId, configObject>` | Per-tenant resolved config, populated **only** by `warmTenantConfigCache()` (async) — never lazily populated inside the synchronous `loadConfig()` itself (that was the original pass's bug). |
| `_tenantConfigDirty` | `Set<tenantId>` | Tenants with an unpersisted `saveConfig()` change, flushed by the existing per-tenant debounce timer in `_flushTenantToMongo()`. |

**New, remediation pass 1**: both containers are added to the existing P0.11 cross-backend reset block (`lib/database.js:945-951`) — `_tenantConfigCaches.clear(); _tenantConfigDirty.clear();` — alongside `_tenantCaches`/`_tenantDirty`/etc., so a same-process backend switch can never leave a stale tenant's config cached against the wrong backend, closing the exact bug class that block already exists to prevent for the sibling `db` cache.

## New logical file format 1 — Tenant-Scoped Backup File (REVISED shape and scope)

JSON file written by `scripts/tenant-backup.js` to `backups/tenant-<tenantId>-<stamp>.json` (+ `.sha256` sidecar).

| Field | Type | Notes |
|---|---|---|
| `scope` | `'tenant'` (literal) | Discriminator, now checked **explicitly and mutually** by both restore paths (research.md Decision 7) — not an accidental byproduct. |
| `schemaVersion` | integer, starts at `1` | Independent of the whole-instance file's `version` counter. |
| `tenantId` | string | The exact tenant this backup covers, matched via `_defaultTenantFilter` for `default`, plain equality otherwise. |
| `createdAt` | ISO 8601 string | |
| `source` | `'mongodb'` \| `'file'` | The *output* shape below is identical regardless (research.md Decision 9) — the reader never needs to know which. |
| `recordCounts` | `{users, entityChunks, appConfigs}` (numbers) | **`tenants`/`subscriptions` removed** (research.md Decision 10) — those two collections are no longer part of this format at all, in either direction. |
| `categoryDigests` | `{users, entityChunks, appConfigs}` (sha256 hex strings) | **New, remediation pass 1.** Computed once, at backup-write time and again identically at restore-staging time, from a stable (sorted-key) JSON serialization of each category's sanitized array — the basis for Decision 12's idempotent-resume check. |
| `collections` | `{users:[...], entityChunks:[...], appConfigs:[...]}` | `idempotencyRecords` excluded via `TENANT_BACKUP_ENTITY_KEYS`, not raw `ENTITY_KEYS` (research.md Decision 8) — enforced by an explicit rejection check in `validateTenantBackupObject()`, not merely by the backup tool's own good behavior. **No `tenants`/`subscriptions` key at all** — its presence in a file presented to `tenant-restore.js` is itself now a structural-validation rejection (a leftover shape from an incompatible producer). |

**File-mode production of this exact shape** (research.md Decision 9): `collections.users`/`entityChunks`/`appConfigs` are synthesized from the tenant's raw per-tenant file blob (`data/tenants/<tid>.json`) and its new per-tenant config file (below) — never left as an undefined "default only" special case.

## New logical file format 2 — Restore Checkpoint (REVISED — no longer sole ground truth)

JSON file at `backups/.restore-checkpoints/<runId>.json`, written via the existing `_atomicWriteJsonSync` (research.md Decision 14) — never a plain `fs.writeFileSync`.

| Field | Type | Notes |
|---|---|---|
| `runId` | string | Random per invocation. |
| `targetTenantId` | string | |
| `backupFile` | string | Path, retained for operator readability only — **no longer the identity check** (see `backupFingerprint`). |
| `backupFingerprint` | string (sha256 hex) | **New, remediation pass 1** (research.md Decision 13). The backup file's own content hash — the actual identity check on resume. "Filename alone is not identity." |
| `expected` | `{users:{count,digest}, entityChunks:{count,digest}, appConfigs:{count,digest}}` | **New, remediation pass 1.** Copied from the backup file's own `recordCounts`/`categoryDigests` at staging time — the reference Decision 12's resume check compares live state against. |
| `startedAt` / `updatedAt` | ISO 8601 strings | |
| `stage` | `'locked' \| 'validating' \| 'staged' \| 'applying' \| 'completed' \| 'failed'` | Monotonically advances. |
| `categoriesApplied` | `string[]` | Populated by **re-deriving actual state**, not merely by "this step ran" bookkeeping (research.md Decision 12) — a category appears here once its live count+digest is confirmed to match `expected`, whether that confirmation came from this run's own apply step or from discovering it was already correct on resume. |
| `error` | string \| null | |

**Recovery contract (revised, remediation pass 1)**: `categoriesApplied` is a **hint that accelerates a correct resume**, not the sole authority a resumed run trusts blindly. On any invocation (fresh or resumed) that reaches the apply phase, each category's live count+digest is (re-)computed and compared against `expected` *before* deciding whether to apply it — closing the crash window between "DB write for category X succeeds" and "checkpoint write for category X lands" (research.md Decision 12) that made the original design's "ground truth" claim falsifiable.

## New — Restore Lock (NEW, remediation pass 1; not a new model — see EntityChunk above)

Represented as an `EntityChunk` document: `{tenantId: target, key: '__restoreLock__', data: {runId, pid, acquiredAt}}`. Acquired via a plain `create()` (fails atomically via the existing unique index on a concurrent attempt), released via a `runId`-conditioned `deleteOne()`. See research.md Decision 11 for the full acquire/release/stale-lock contract. Deliberately excluded from `TENANT_BACKUP_ENTITY_KEYS` so it is never itself backed up or restored as tenant data.

## State Transitions

### Restore run (`scripts/tenant-restore.js`) — REVISED
```
locked → validating → staged → applying → completed
                                    ↓
                                  failed (categoriesApplied[] + expected{} show exactly
                                          what is confirmed-correct vs. not yet)
```
- `locked`: the restore lock (Decision 11) is acquired as the very first action, before validation — a second concurrent invocation for the same tenant fails here, before touching the backup file at all.
- `validating`: structural + scope + schema-version + tenant-match + idempotency-exclusion + record-count checks (research.md Decisions 7/8), plus a backup-fingerprint check against any existing non-completed checkpoint for this tenant (Decision 13).
- `staged`: the backup is sanitized (`_id`/`__v` stripped), counted, digested, and written to a **local** file — no live-database write of any kind (research.md Decision 6). For `default`, the duplicate-identity pre-flight (Decision 15) also runs here, before `staged` is reached, and hard-fails the whole run if a conflict is found.
- `applying`: for each category in a fixed order (`users → entityChunks → appConfigs`), compare live count+digest to `expected`; skip if already matching, else tenant-scoped delete + sanitized insert with the *real* target `tenantId` (never a synthetic one — there is no staged live copy to repoint anymore).
- `completed`: every category confirmed matching. Lock released.
- `failed`: lock released (clean failure) or left held (a hard crash — resolved only via explicit `--force-unlock`); `categoriesApplied` + `expected` together tell an operator, or a resumed run, exactly what is already correct.

### Config resolution — REVISED
```
warmTenantConfigCache(tid), awaited by tenantMiddleware before any route runs:
  tid === 'default'        → no-op (already synchronously populated by initConfig() at boot)
  tid !== 'default', cached → no-op
  tid !== 'default', cold   → Mongo: AppConfig.findOne({tenantId:tid,key:'config'})
                               File:  read data/tenants/<tid>.config.json, or defaults if absent
                               → merge over _defaultConfig, cache in _tenantConfigCaches

loadConfig() (synchronous, unchanged signature):
  tid === 'default'         → existing global _configCache / _defaultConfig merge (unchanged)
  tid !== 'default', cached → return cached value
  tid !== 'default', cold   → THROW (bug: middleware should have warmed it — fail closed)
```

## Out of scope for this phase (documented, not silently dropped)

- **`scripts/detect-duplicate-default-records.js` as a general, opt-in, later tool** — superseded in part by Decision 15's mandatory pre-flight (which hard-blocks the specific backup/restore operations this feature adds), but a broader, non-blocking "scan and report every duplicate across the whole default dataset regardless of whether a backup/restore was requested" tool remains a reasonable, separate, later operational task.
- **`Tenant`/`Subscription` restore or backup of any kind** (research.md Decision 10) — explicitly out of scope, not deferred.
- Any schema/index change to `User`, `EntityChunk`, `AppConfig`, `Tenant`, `Subscription`, or `IdempotencyRecord`.
- Partial/per-collection tenant restore (spec.md FR-020 — full-tenant-replace only, now over exactly three categories).
- Automated lock expiry / automatic rollback of an already-applied category (research.md Decisions 11/17 — both require explicit operator action).
