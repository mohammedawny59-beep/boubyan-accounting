# Data Model: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Revised in Design Remediation Pass 1, corrected again after a second `/speckit-analyze` re-verification pass found 5 CRITICAL, 6 HIGH, 2 MEDIUM new/incompletely-closed defects in Pass 1 itself** (a dropped default-tenant `AppConfig` scoping fix, an unscoped `entityChunks` delete threatening the lock/idempotency store, a `runId`-keyed checkpoint with no tenant lookup path, an internally-contradictory stale-lock policy, an underspecified digest canonicalization, among others — each marked "second pass" inline below). No new Mongoose *models* are added even after both passes — the restore lock (below) deliberately reuses the existing `EntityChunk` schema/index rather than introducing one. Two logical file formats are substantially redesigned; new in-memory state is added (now including a config-file timer map, second pass), all participating in the existing cross-backend reset.

## Existing entities — write-path scoping change only (UNCHANGED from original pass)

### User (`models/User.js`)
`persistUsers()` (`lib/database.js:424`) filter changes from `{id}`/`{}` to `{..._defaultTenantFilter, id}`/`_defaultTenantFilter`; `$set` gains `tenantId:'default'`. Unchanged by remediation — this fix survived analysis.

### EntityChunk (`models/EntityChunk.js`)
`persistEntityKey()` (`lib/database.js:445`) filter changes from `{key}` to `{..._defaultTenantFilter, key}`; `$set` gains `tenantId:'default'`. Unchanged by remediation. **New reuse, remediation pass 1**: this same model/collection, under a reserved key `'__restoreLock__'` deliberately outside `TENANT_BACKUP_ENTITY_KEYS`, is now also the restore-lock primitive (see "Restore Lock" below) — no schema change, no new index; the existing compound unique `{tenantId,key}` index (`:12`) is exactly what makes the lock's atomic-acquire semantics work.

### AppConfig (`models/AppConfig.js`)
`loadConfig()`/`saveConfig()` stay synchronous; a new async `warmTenantConfigCache()` populates the per-tenant cache before any request-scoped synchronous read (research.md Decision 2). **Correction, second `/speckit-analyze` pass**: `default`'s own three existing AppConfig call sites — `initConfig()`'s read (`lib/database.js:612`) and two legacy-migration writes (`:621-625`, `:633-637`), plus `flushToMongo()`'s default-tenant write (`:490-494`) — were incorrectly left unscoped in Pass 1 despite a document claiming otherwise. All three now get the identical `_defaultTenantFilter` + normalize-forward treatment as `persistUsers()`/`persistEntityKey()` (research.md Decision 2), restoring a fix that was correctly specified before Pass 1's Phase B rewrite dropped it. `_flushTenantToMongo()`'s early-return guard is also corrected to account for a config-only dirty tenant (see "New in-memory state" below).

### Tenant (`models/Tenant.js`) / Subscription (`models/Subscription.js`)
**Removed from tenant-scoped backup/restore scope entirely (remediation pass 1, research.md Decision 10).** No write-path change (none was ever planned), and — new this pass — **no read-path involvement either**: these two models are never queried by `tenant-backup.js`/`tenant-restore.js` at all. `Tenant.slug`'s standalone unique index, and `Subscription`'s Stripe-linked fields, are simply never touched by this feature's tenant-scoped tooling.

## New in-memory state (mirrors existing `_tenantCaches` pattern, `lib/database.js:17-22`)

| Name | Shape | Purpose |
|---|---|---|
| `_tenantConfigCaches` | `Map<tenantId, configObject>` | Per-tenant resolved config, populated **only** by `warmTenantConfigCache()` (async) — never lazily populated inside the synchronous `loadConfig()` itself (that was the original pass's bug). |
| `_tenantConfigDirty` | `Set<tenantId>` | Tenants with an unpersisted `saveConfig()` change, flushed by the existing per-tenant debounce timer in `_flushTenantToMongo()`. |
| `_tenantConfigFileTimers` | `Map<tenantId, Timer>` | **New, second `/speckit-analyze` pass.** Mirrors `_tenantFileTimers` exactly — debounce bookkeeping for the new per-tenant config file writes under `_useFileFallback`, needed so `_flushAllTenantsOnShutdown()` can find and flush a pending config-file write on graceful shutdown (see below). |

**New, remediation pass 1**: both `_tenantConfigCaches`/`_tenantConfigDirty` are added to the existing P0.11 cross-backend reset block (`lib/database.js:945-951`) — `_tenantConfigCaches.clear(); _tenantConfigDirty.clear();` — alongside `_tenantCaches`/`_tenantDirty`/etc., so a same-process backend switch can never leave a stale tenant's config cached against the wrong backend, closing the exact bug class that block already exists to prevent for the sibling `db` cache. **Second pass**: `_tenantConfigFileTimers` is added to the same reset block too, and `_flushAllTenantsOnShutdown()` is extended to flush any pending entry in it before shutdown completes — exactly paralleling how that function already flushes `_tenantFileTimers` — closing a SIGTERM data-loss gap for config that Pass 1 left open (this codebase's own P0.5 milestone already closed the identical gap for entity data; Pass 1's new config mechanism reintroduced it by omission).

**Second pass correction — `_flushTenantToMongo()`'s early-return guard**: the existing guard `if (!db || dirty.size === 0) return;` (`lib/database.js:41`) only inspects the entity-dirty set. Changed to `if ((!db || dirty.size === 0) && !_tenantConfigDirty.has(tenantId)) return;` — otherwise a tenant whose only pending Mongo-mode change in a debounce window is a `saveConfig()` call (no `saveDB()` in the same window) would have that change silently dropped, since the function would return before ever reaching the config-flush branch.

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
| `categoryDigests` | `{users, entityChunks, appConfigs}` (sha256 hex strings) | Computed once, at backup-write time and again identically at restore-staging time, via the now-exported `canonicalJson()` (`lib/backupValidation.js`, alongside `computeChecksum()`) — **second `/speckit-analyze` pass: `canonicalJson()` is now precisely specified**, not just named in prose: sort each category's array by its stable identity field (`id` for `users`, `key` for `entityChunks`/`appConfigs`) **before** recursively sorting object keys at every depth. The array-sort half is required because a live MongoDB query carries no implicit stable order — without it, two logically-identical record sets could hash differently purely from ordering, producing false digest mismatches. |
| `collections` | `{users:[...], entityChunks:[...], appConfigs:[...]}` | `idempotencyRecords` **and `__restoreLock__`** excluded via `TENANT_BACKUP_ENTITY_KEYS` (research.md Decision 8) — enforced by an explicit rejection check in `validateTenantBackupObject()` for *either* reserved key appearing in `collections.entityChunks`, not merely by the backup tool's own good behavior (second pass: the original rejection only named `idempotencyRecords`; a backup illegitimately carrying a planted `__restoreLock__` record is now rejected the same way, closing a hole that could otherwise permanently block a tenant's future restores). **No `tenants`/`subscriptions` key at all** — its presence in a file presented to `tenant-restore.js` is itself now a structural-validation rejection (a leftover shape from an incompatible producer). |

**File-mode production of this exact shape** (research.md Decision 9): `collections.users`/`appConfigs` are synthesized from the tenant's raw per-tenant file blob (`data/tenants/<tid>.json`) and its new per-tenant config file. **`collections.entityChunks` is synthesized only from `TENANT_BACKUP_ENTITY_KEYS` entries actually present in the blob (second pass correction)** — two real keys, `passwordResets`/`errorLog`, are genuinely absent from `emptyDBShape()` for any tenant that never triggered either, and mapping them unconditionally (Pass 1's bug) would insert a schema-invalid, `data`-less `EntityChunk` document. File-mode's `updatedAt` for a synthesized record is the backup run's own `createdAt` (no per-key write time exists in file storage) — never treated as meaningful per-record provenance.

## New logical file format 2 — Restore Checkpoint (REVISED — no longer sole ground truth, now tenant-keyed)

JSON file at **`backups/.restore-checkpoints/<tenantId>.json`** (second `/speckit-analyze` pass — Pass 1 keyed this by `<runId>.json`, which made "find the existing checkpoint for this tenant," required by Decisions 12/13, undefined on a resumed invocation with a fresh `runId`. One live checkpoint per tenant now, exactly matching the one-lock-per-tenant invariant the restore lock already enforces — the lookup is a direct, predictable path, not a search). Written via the existing `_atomicWriteJsonSync` (research.md Decision 14) — never a plain `fs.writeFileSync` — with `fs.mkdirSync(..., {recursive:true})` run first for a freshly-provisioned target.

| Field | Type | Notes |
|---|---|---|
| `runId` | string | Random per invocation — now a field inside the document, not part of its path (see above). |
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

Represented as an `EntityChunk` document: `{tenantId: target, key: '__restoreLock__', data: {runId, pid, acquiredAt}}`. Acquired via a plain `create()` (fails atomically via the existing unique index on a concurrent attempt — a standard, catchable Mongo duplicate-key error, code `11000`), released via a `runId`-conditioned `deleteOne()`. Deliberately excluded from `TENANT_BACKUP_ENTITY_KEYS` so it is never itself backed up or restored as tenant data — and, second pass, `validateTenantBackupObject()` explicitly rejects a backup file that illegitimately contains one (mirroring the `idempotencyRecords` rejection), so a malformed file can never plant a permanent lock-blocking document via restore.

**Stale-lock policy, tightened second pass**: a lock left behind by a non-clean exit is *never* auto-released, auto-expired, or reclaimed via a process-liveness check (unreliable across independent hosts) — recovery always requires an explicit `--force-unlock`, with **no exception for the crash-window/digest-resume scenario itself** (Pass 1 left this inconsistent — some documents implied a plain re-run would work after a kill; it does not, by the same policy that applies to every other non-clean exit). `--force-unlock` is a single, non-looping, conditioned sequence (attempt create → on failure, read the existing lock and delete it conditioned on its own specific `runId` → attempt create once more → report contention on a second failure), never a bare unconditional delete-then-create, which would leave a race window between two operators force-unlocking near-simultaneously. See research.md Decision 11 for the full contract.

## State Transitions

### Restore run (`scripts/tenant-restore.js`) — REVISED
```
locked → validating → staged → applying → completed
                                    ↓
                                  failed (categoriesApplied[] + expected{} show exactly
                                          what is confirmed-correct vs. not yet)
```
- `locked`: the restore lock (Decision 11) is acquired as the very first action, before validation — a second concurrent invocation for the same tenant fails here, before touching the backup file at all.
- `validating`: structural + scope + schema-version + tenant-match + category-shape + idempotency-exclusion (both `idempotencyRecords` and `__restoreLock__`) + record-count/digest checks (research.md Decisions 7/8), then — **last, as sub-step 1.8, second-pass-corrected ordering** — a backup-fingerprint check against the tenant-keyed checkpoint (Decision 15), if one exists and is not yet `completed` (Decision 13).
- `staged`: the backup is sanitized (`_id`/`__v` stripped), counted, digested (with array elements sorted by identity key before hashing — Decision 6), and written to a **local, tenant-keyed** file — no live-database write of any kind (research.md Decision 6). For `default`, the duplicate-identity pre-flight (Decision 16) also runs here, before `staged` is reached, and hard-fails the whole run if a conflict is found.
- `applying`: for each category in a fixed order (`users → entityChunks → appConfigs`), compare live count+digest to `expected`; skip if already matching, else tenant-scoped delete + sanitized insert with the *real* target `tenantId` (never a synthetic one — there is no staged live copy to repoint anymore). **The `entityChunks` category's delete and live-digest query are both additionally scoped by `key:{$in:TENANT_BACKUP_ENTITY_KEYS}` (second pass correction)** — never a bare `{tenantId:target}` — so the restore lock and the tenant's live `idempotencyRecords` document, which share this same collection and tenantId, are structurally outside the delete's reach.
- `completed`: every category confirmed matching. Lock released.
- `failed`: lock released (clean failure) or left held (a hard crash — resolved **only** via explicit `--force-unlock`, with no exception, including for an otherwise-successful digest-based resume demonstration — second-pass-tightened policy); `categoriesApplied` + `expected` together tell an operator, or a resumed run, exactly what is already correct.

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

- **`scripts/detect-duplicate-default-records.js` as a general, opt-in, later tool** — superseded in part by Decision 16's mandatory pre-flight (which hard-blocks the specific backup/restore operations this feature adds), but a broader, non-blocking "scan and report every duplicate across the whole default dataset regardless of whether a backup/restore was requested" tool remains a reasonable, separate, later operational task.
- **`Tenant`/`Subscription` restore or backup of any kind** (research.md Decision 10) — explicitly out of scope, not deferred.
- Any schema/index change to `User`, `EntityChunk`, `AppConfig`, `Tenant`, `Subscription`, or `IdempotencyRecord`.
- Partial/per-collection tenant restore (spec.md FR-020 — full-tenant-replace only, now over exactly three categories).
- Automated lock expiry / automatic liveness-based reclaim / automatic rollback of an already-applied category (research.md Decision 11 — all require explicit operator action, with no exception).
- Adding `passwordResets: []`/`errorLog: []` to `emptyDBShape()` in `lib/database.js` — the file-mode backup transform's fix (filter out absent keys, second pass) is scoped to this feature's own new code, not a change to shared, already-in-production data-shape code outside this feature's boundary.
