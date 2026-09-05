---

description: "Task list for Tenant Isolation + Safe Backup/Restore Hardening (P4) — Design Remediation Pass 2"
---

# Tasks: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Input**: Design documents from `specs/002-tenant-isolation-backup-hardening/` (all revised through Design Remediation Pass 2)
**Tests**: Explicitly requested — TDD-ordered throughout.

**Revision note (Design Remediation Pass 2)**: A second adversarial `/speckit-analyze` re-verified Pass 1's own fixes (rather than assuming they worked) and found 5 CRITICAL, 6 HIGH, 2 MEDIUM new or incompletely-closed defects in Pass 1's design — a dropped default-tenant `AppConfig` scoping fix, an unscoped `entityChunks` delete threatening the restore lock and the tenant's own idempotency store, a `runId`-keyed checkpoint with no tenant-lookup path, an internally-contradictory stale-lock policy, a non-atomic force-unlock sequence, an underspecified digest canonicalization, and a file-mode transform that could insert schema-invalid records. Renumbered sequentially T001-T075 (up from 72). **Phase A's task content remains completely unchanged** — it has now survived two rounds of adversarial analysis intact.

## Format: `[ID] [P?] [Phase] Description`

## Task Dependency Rule (unchanged)

`isolation (A) → config (B) → default-only boundaries (C) → backup (D) → restore validation + lock (E) → offline staging (F) → checkpoint/apply (G) → recovery + runbook (H) → default compatibility (I) → separation/regression (J, K)`

---

## Phase 1: Setup

- [ ] T001 Run the existing full test suite once, unmodified, as a pre-implementation baseline (`npm test`); record the pass count for comparison against T075. No dependencies.

---

## Phase A: Tenant Write Isolation — UNCHANGED CONTENT (survived two `/speckit-analyze` rounds)

- [ ] T002 [P] [A] Write failing Mongo-backed tests in `tests/tenant-write-isolation.test.js`: default save does not delete a Tenant B user sharing the same `id`; default upsert does not overwrite a Tenant B user sharing the same `id`; default entity save does not overwrite a Tenant B `EntityChunk` sharing the same `key`; a legacy default `User`/`EntityChunk` document with no `tenantId` field (raw-driver-seeded per spec.md FR-027, with an explicit read-back assertion that the field is genuinely absent before exercising the behavior under test) is updated in place, not duplicated; no duplicate default document is created for an existing legacy identity. Depends on: T001.
- [ ] T003 [A] `persistUsers()` (`lib/database.js:424`): filter → `{..._defaultTenantFilter, id:{$nin:ids}}` / `_defaultTenantFilter`; upsert match filter → `{..._defaultTenantFilter, id:u.id}`. `$set` unchanged in this task. Depends on: T002.
- [ ] T004 [A] `persistEntityKey()` (`lib/database.js:445`): filter → `{..._defaultTenantFilter, key}`. Depends on: T002.
- [ ] T005 [A] Normalize-forward: add `tenantId:'default'` to both functions' `$set`. Depends on: T003, T004.
- [ ] T006 [A] Run `tests/tenant-write-isolation.test.js`; confirm all pass. **Checkpoint.** Depends on: T005.

---

## Phase B: Config Isolation (research.md Decision 2, 3 — corrected in Pass 2)

- [ ] T007 [P] [B] Write failing tests in `tests/tenant-config-isolation.test.js`: (1) Tenant A `saveConfig()` never visible to Tenant B `loadConfig()`; (2) fee/card/KNET-shaped settings stay isolated; (3) SMTP/branding stay isolated; (4) a legacy no-`tenantId`-field `AppConfig` document (raw-driver-seeded, FR-027, absence asserted before use) normalizes in place, never duplicates; (5) cold-miss fail-closed: `loadConfig()` for a non-default tenant whose config was never warmed throws, never returns `_defaultConfig` or another tenant's value; (6) file-fallback persistence: under `DB_FILE_ONLY=true`, `saveConfig()` for a tenant survives a cache-clear + re-warm, zero Mongo connection attempted; (7) **default-tenant AppConfig collision (NEW, Pass 2)**: seed a real `AppConfig` document for a non-default tenant with `key:'config'`, then trigger `default`'s own `initConfig()`/`flushToMongo()` read/write path; assert `default`'s operations only ever touch `default`'s own document; (8) **config-only Mongo-mode flush (NEW, Pass 2)**: as a non-default tenant in Mongo mode, call `saveConfig()` alone (no `saveDB()` in the same debounce window); force the timer; assert the `AppConfig` document was actually written; (9) **config-only file-mode shutdown flush (NEW, Pass 2)**: as a non-default tenant under `DB_FILE_ONLY=true`, call `saveConfig()` alone, then invoke `shutdownDB()` before the debounce timer would fire naturally; assert the config file was written before shutdown completed. Depends on: T006.
- [ ] T008 [B] Add `_tenantConfigCaches = new Map()`, `_tenantConfigDirty = new Set()`, and `_tenantConfigFileTimers = new Map()` (`lib/database.js`, alongside `_tenantCaches`/`_tenantDirty`/`_tenantFileTimers`), **and in the same task** add `.clear()` for all three to the existing P0.11 cross-backend reset block (`:945-951`) — declaring the reset-block registration together with the declaration itself, specifically so it cannot be dropped again as it was for the first two Maps during Pass 1's own Phase-B rewrite. File: `lib/database.js`. Depends on: T007.
- [ ] T009 [B] Add `_tenantConfigFilePath(tid)` (mirrors `_tenantFilePath(tid)`'s sanitization, sibling path `data/tenants/<tid>.config.json`). File: `lib/database.js`. Depends on: T008.
- [ ] T010 [B] Implement `async function warmTenantConfigCache(tenantId)`: no-op for `default` or already-cached; Mongo mode reads `AppConfig.findOne({tenantId,key:'config'}).lean()`; file mode reads `_tenantConfigFilePath(tid)` via `fs.readJsonSync` if present, else defaults; merges over `_defaultConfig`; caches. File: `lib/database.js`. Depends on: T009.
- [ ] T011 [B] Wire `await warmTenantConfigCache(tenantId);` into `lib/tenantMiddleware.js:94`, alongside the existing `await warmTenantCache(tenantId);`, both before `next()`. File: `lib/tenantMiddleware.js`. Depends on: T010.
- [ ] T012 [B] Implement `loadConfig()`'s per-tenant branch (`lib/database.js:801`): `default` unchanged; non-default returns `_tenantConfigCaches.get(tid)` if present, else **throws**. Function signature and every existing call site unchanged (spec.md FR-022). File: `lib/database.js`. Depends on: T011.
- [ ] T013 [B] Implement `saveConfig(cfg)`'s per-tenant branch (`lib/database.js:807`): `default` unchanged; non-default sets `_tenantConfigCaches`, and either marks `_tenantConfigDirty` + calls `_scheduleTenantPersist(tid)` (Mongo mode) or schedules a debounced write to `_tenantConfigFilePath(tid)` registered into `_tenantConfigFileTimers` (file mode). File: `lib/database.js`. Depends on: T012.
- [ ] T014 [B] Extend `_flushTenantToMongo(tenantId)` (`:38`) with the config-flush branch, **and correct its early-return guard in the same task (Pass 2 fix)**: change `if (!db || dirty.size === 0) return;` to `if ((!db || dirty.size === 0) && !_tenantConfigDirty.has(tenantId)) return;` — without this, a tenant whose only pending Mongo-mode change is `saveConfig()` (no `saveDB()` in the same window) would have the guard return before the new branch ever runs. If dirty, `AppConfig.updateOne({tenantId,key:'config'},{$set:{tenantId,data:_tenantConfigCaches.get(tenantId),updatedAt:new Date()}},{upsert:true})`, then clear the flag. File: `lib/database.js`. Depends on: T013.
- [ ] T015 [B] **NEW, Pass 2**: extend `_flushAllTenantsOnShutdown()` (`:823-853`) to iterate `_tenantConfigFileTimers` and flush any pending entry via `_atomicWriteJsonSync(_tenantConfigFilePath(tid), _tenantConfigCaches.get(tid))` before shutdown completes — exactly paralleling how that function already flushes `_tenantFileTimers` for entity data. Without this, a pending debounced config-file write is silently lost on SIGTERM, reintroducing the exact bug class this codebase's own P0.5 milestone already closed for entity data. File: `lib/database.js`. Depends on: T014.
- [ ] T016 [B] **NEW, Pass 2 — restores a fix Pass 1 incorrectly dropped**: scope `default`'s own three existing `AppConfig` call sites to `_defaultTenantFilter` + normalize-forward, exactly like `persistUsers()`/`persistEntityKey()`: `initConfig()`'s read (`:612`, `AppConfig.findOne({key:'config'})` → `AppConfig.findOne({..._defaultTenantFilter,key:'config'})`), both of `initConfig()`'s legacy-migration writes (`:621-625`, `:633-637`), and `flushToMongo()`'s default-tenant write (`:490-494`) — each write's `$set` gains `tenantId:'default'`. Without this, once any non-default tenant has its own `AppConfig` document (permitted by the compound unique index), these three unscoped-by-`{key:'config'}` call sites could read or overwrite the wrong tenant's document. File: `lib/database.js`. Depends on: T015.
- [ ] T017 [B] Run `tests/tenant-config-isolation.test.js`; confirm all 9 cases pass. **Checkpoint.** Depends on: T016.

---

## Phase C: Telegram / Monitor Default-Only Boundaries — FIVE routes (unchanged from Pass 1)

- [ ] T018 [P] [C] Write failing `supertest` tests in `tests/telegram-scheduler-boundary.test.js` for all FIVE routes (`POST /api/telegram/start` :2678, `POST /api/monitor/inventory` :9822, `POST /api/monitor/monthly-report` :9826, `POST /api/reports/send-telegram` :15987, `GET /api/monitor/status` :9830): default-tenant unchanged behavior; non-default gets `403`+`TELEGRAM_DEFAULT_TENANT_ONLY`; no side effect before rejection (status route: response body discloses no `botActive`/`chatIdSet`). 5×3 = 15 cases. Depends on: T017.
- [ ] T019 [P] [C] Guard `POST /api/telegram/start`. Depends on: T018.
- [ ] T020 [P] [C] Guard `POST /api/monitor/inventory`. Depends on: T018.
- [ ] T021 [P] [C] Guard `POST /api/monitor/monthly-report`. Depends on: T018.
- [ ] T022 [P] [C] Guard `POST /api/reports/send-telegram`. Depends on: T018.
- [ ] T023 [P] [C] Guard `GET /api/monitor/status`. Depends on: T018.
- [ ] T024 [C] Re-run the full-file grep for `bot`/`global._tgBot`/`TelegramBot`/route paths containing `telegram`/`monitor` immediately before considering this phase done, to catch any route added since. Depends on: T023.
- [ ] T025 [C] Run `tests/telegram-scheduler-boundary.test.js`; confirm all 15 cases pass. **Checkpoint.** Depends on: T019, T020, T021, T022, T023, T024.

---

## Phase D: Tenant-Scoped Backup (research.md Decisions 8, 9, 10, 16 — corrected in Pass 2)

- [ ] T026 [P] [D] Write failing tests in `tests/tenant-backup.test.js`: (1) cross-tenant leakage; (2) legacy inclusion (raw-driver-seeded, absence asserted); (3) missing `--tenant=` fails, writes nothing; (4) a tenant with no `Tenant`/`Subscription` row still backs up successfully; (5) idempotency exclusion: a real `IdempotencyRecord` doc and an `EntityChunk` keyed `idempotencyRecords` appear in neither the output nor anywhere else; (6) default-duplicate pre-flight: a genuine duplicate `default` identity (raw-driver-seeded) causes hard failure naming the exact identity, zero file written; (7) no `tenants`/`subscriptions` key, for both `default` and a real tenant that has such rows; (8) **file-mode undefined-key handling (NEW, Pass 2)**: under `DB_FILE_ONLY=true`, back up an ordinary tenant that never triggered a password reset or logged error; assert `collections.entityChunks` contains no `passwordResets`/`errorLog` entry at all (not a `data:undefined` entry); (9) **`__restoreLock__` exclusion (NEW, Pass 2)**: seed an `EntityChunk` keyed `__restoreLock__` for the target tenant; back it up; assert it does not appear anywhere in the output. Depends on: T025.
- [ ] T027 [D] Export `_tenantFilePath(tid)` and `_tenantConfigFilePath(tid)` from `lib/database.js`'s `module.exports`. Depends on: T026.
- [ ] T028 [D] Add and export `TENANT_BACKUP_ENTITY_KEYS = ENTITY_KEYS.filter(k => k !== 'idempotencyRecords')` from `lib/database.js`. File: `lib/database.js`. Depends on: T026.
- [ ] T029 [D] **NEW, Pass 2**: implement and export `canonicalJson(value)` from `lib/backupValidation.js`, alongside `computeChecksum()`: recursively sorts object keys at every depth, and — for a value that is an array of records — first sorts the array by each record's stable identity field (`id` for user-shaped records, `key` for entity-chunk/config-shaped records) before the key-sorting pass. Add a dedicated unit test asserting the same logical input always produces byte-identical output regardless of key-insertion order or array element order. File: `lib/backupValidation.js`. Depends on: T026.
- [ ] T030 [D] Create `scripts/tenant-backup.js`: argument parsing — `--tenant=` required, no default, no positional fallback. File: `scripts/tenant-backup.js` (new). Depends on: T026.
- [ ] T031 [D] Implement the default-tenant duplicate pre-flight (research.md Decision 16) as the first substantive step for `--tenant=default` — scan every `_defaultTenantFilter`-matched logical identity for more than one physical document; hard-fail naming the exact identity + both `_id`s; write no file. File: `scripts/tenant-backup.js`. Depends on: T030.
- [ ] T032 [D] Implement Mongo-mode queries using `TENANT_BACKUP_ENTITY_KEYS` (T028) — never raw `ENTITY_KEYS` — for exactly `users`, `entityChunks` (`key:{$in:TENANT_BACKUP_ENTITY_KEYS}`), `appConfigs`. `IdempotencyRecord`, `Tenant`, `Subscription` never queried. File: `scripts/tenant-backup.js`. Depends on: T028, T031.
- [ ] T033 [P] [D] Implement file-mode backup + the unified-shape transform, **corrected, Pass 2**: `collections.users=blob.users`; `collections.appConfigs` from the tenant's config file (T027) if present, else `[]`; `collections.entityChunks = TENANT_BACKUP_ENTITY_KEYS.filter(key => blob[key] !== undefined).map(key => ({tenantId,key,data:blob[key],updatedAt:backupCreatedAt}))` — **filtering out keys absent from the blob (Pass 1 mapped every key unconditionally, which inserts a schema-invalid, `data`-less record for any tenant that never triggered a password reset or a logged error)**. File: `scripts/tenant-backup.js`. Depends on: T027, T028.
- [ ] T034 [D] Implement output format: `{scope:'tenant',schemaVersion:1,tenantId,createdAt,source,recordCounts:{users,entityChunks,appConfigs},categoryDigests:{users,entityChunks,appConfigs},collections}` + checksum sidecar (existing `computeChecksum()`, unchanged). `categoryDigests.<cat> = computeChecksum(canonicalJson(collections.<cat>))` (T029). File: `scripts/tenant-backup.js`. Depends on: T029, T032, T033.
- [ ] T035 [D] Add `"backup:tenant": "node scripts/tenant-backup.js"` to `package.json`. Depends on: T034.
- [ ] T036 [D] Run `tests/tenant-backup.test.js`; confirm all 9 cases pass. **Checkpoint** — backup is complete and independently testable before restore work begins. Depends on: T035.

---

## Phase E: Restore Lock + Validation Gate (research.md Decisions 8, 11, 13, 15 — corrected in Pass 2; must run before staging)

- [ ] T037 [P] [E] Write failing tests, **extending** `tests/production-hardening.test.js`, for `validateTenantBackupObject()`: structural rejection; `scope!=='tenant'` rejection; unsupported `schemaVersion` rejection; ambiguous/mismatched `tenantId` rejection; `tenants`/`subscriptions` key present → rejection; `idempotencyRecords` entity chunk or top-level field present → rejection; **`__restoreLock__` entity chunk present → rejection (NEW, Pass 2)**; `recordCounts`/`categoryDigests` mismatch → rejection; a fully valid object passes. PLUS one test for the additive guard on the existing `validateBackupObject()`: `scope:'tenant'` → rejection; an absent `scope` → unaffected. Depends on: T036.
- [ ] T038 [E] Implement `validateTenantBackupObject(backup, targetTenantId)` in `lib/backupValidation.js` with every check from T037, including the `__restoreLock__` rejection alongside the `idempotencyRecords` one. File: `lib/backupValidation.js`. Depends on: T037.
- [ ] T039 [E] Add the one-line additive guard to the existing `validateBackupObject()`: `if (backup.scope === 'tenant') return {ok:false, problems:[...]}`. File: `lib/backupValidation.js`. Depends on: T037.
- [ ] T040 [E] Create `scripts/tenant-restore.js`: argument parsing — `<backup-file>`, `--tenant=`, `--target=` required; `--yes`, `--force-unlock` optional. File: `scripts/tenant-restore.js` (new). Depends on: T038, T039.
- [ ] T041 [E] **Step 0, runs first, before validation.** Implement the restore lock with the corrected, atomic recovery sequence (research.md Decision 11, Pass 2): acquire via `EntityChunk.create({tenantId:target,key:'__restoreLock__',data:{runId,pid,acquiredAt}})`; on a duplicate-key error, print the existing lock's `runId`/`pid`/age and exit non-zero before reading the backup file at all; `--force-unlock` is a single, non-looping sequence — attempt `create()`, on failure read the existing lock and delete it conditioned on **that lock's own `runId`**, attempt `create()` exactly once more, report contention on a second failure (never an unconditional delete-then-create, never a retry loop). File: `scripts/tenant-restore.js`. Depends on: T040.
- [ ] T042 [E] Wire Step 1 (T038's validation gate) immediately after lock acquisition: on any failure, print all problems, release the lock, exit non-zero, write no checkpoint, touch no data. File: `scripts/tenant-restore.js`. Depends on: T041.
- [ ] T043 [E] Implement Step 1.8, the backup-fingerprint check, **as the last validation sub-step, reusing the file hash already computed in Step 1.1** (research.md Decision 13's corrected ordering — Pass 1 had this contradicted between documents): look up any existing, non-`completed` checkpoint at the **tenant-keyed** path `backups/.restore-checkpoints/<targetTenantId>.json` (research.md Decision 15 — not a `runId`-keyed search); if found, compare its `backupFingerprint` against this invocation's file hash; mismatch → hard reject naming both files, release lock, exit non-zero. File: `scripts/tenant-restore.js`. Depends on: T042.
- [ ] T044 [E] Implement Step 2, the default-tenant duplicate pre-flight for restore (mirrors T031, against the live database, target `default` only) — hard-fail, name the identity, release lock, exit non-zero, before staging begins. File: `scripts/tenant-restore.js`. Depends on: T043.
- [ ] T045 [E] Run all Phase E tests (T037 plus an end-to-end subprocess test per rejection case). **Checkpoint** — no staging or apply code exists yet. Depends on: T044.

---

## Phase F: Offline/Logical Restore Staging — tenant-keyed, no live-Mongo writes (research.md Decisions 6, 15 — corrected in Pass 2)

- [ ] T046 [P] [F] Write failing tests in `tests/tenant-restore.test.js`: (1) no live document under any placeholder identity, or under the real target tenantId, is ever created/modified during staging (verified via a live query immediately after staging completes); (2) sanitization strips `_id`/`__v` from every record; (3) recomputed count+digest per category (via `canonicalJson()`, T029) matches the backup file's own `recordCounts`/`categoryDigests`; (4) ownership validation catches an internally-inconsistent record; (5) the local staging file is written at the **tenant-keyed** path `backups/.restore-staging/<targetTenantId>.json` (**NEW, Pass 2** — was `<runId>.json`, which made it unfindable/ambiguous across a resumed invocation's new `runId`). Depends on: T045.
- [ ] T047 [F] Implement sanitization: strip `_id`/`__v` from every record in every category, in memory. File: `scripts/tenant-restore.js`. Depends on: T046.
- [ ] T048 [F] Implement per-category count+digest recomputation (via `canonicalJson()`, T029) and comparison against the backup's own values. File: `scripts/tenant-restore.js`. Depends on: T047.
- [ ] T049 [F] Implement ownership validation: each sanitized record's `tenantId` (or, for `default`, `_defaultTenantFilter`-consistent shape) matches `targetTenantId`. File: `scripts/tenant-restore.js`. Depends on: T048.
- [ ] T050 [F] Write the staged, sanitized representation to `backups/.restore-staging/<targetTenantId>.json` (**tenant-keyed path, Pass 2**), with `fs.mkdirSync` for this directory run first — no live-Mongo write of any kind in this entire phase. File: `scripts/tenant-restore.js`. Depends on: T049.
- [ ] T051 [F] Run `tests/tenant-restore.test.js`'s staging cases (T046); confirm all pass, explicitly re-confirming zero live documents were touched. **Checkpoint.** Depends on: T050.

---

## Phase G: Checkpoint / Digest-Gated Apply — highest-risk section (research.md Decisions 12, 14, 15 — corrected in Pass 2)

- [ ] T052 [P] [G] Write failing tests for checkpoint lifecycle: written via `_atomicWriteJsonSync` (never plain `fs.writeFileSync`); `fs.mkdirSync` runs first; located at the **tenant-keyed** path `backups/.restore-checkpoints/<targetTenantId>.json`; includes `runId` as a field (not part of the path), `expected:{...}`, and `backupFingerprint`; a corrupted checkpoint is treated as "no reliable prior record, proceed as fresh." Depends on: T051.
- [ ] T053 [G] Implement checkpoint creation (Step 4) at the tenant-keyed path, using `_atomicWriteJsonSync` + prior `mkdirSync`, populated with `expected`/`backupFingerprint` from Steps 1/3. File: `scripts/tenant-restore.js`. Depends on: T052.
- [ ] T054 [P] [G] Write failing tests for the digest-gated apply step in isolation: a category whose live count+digest already matches `expected` is skipped entirely; a non-matching category gets a tenant-scoped delete followed by an insert of the locally-staged records with the real target `tenantId`; **the `entityChunks` category's delete AND its live-digest query are BOTH additionally scoped by `key:{$in:TENANT_BACKUP_ENTITY_KEYS}` (NEW, mandatory, Pass 2)** — a bare `{tenantId:target}` delete for `entityChunks` is explicitly asserted to be a defect (it would destroy the Step-0 restore lock and the tenant's own live `idempotencyRecords` document, both living in this same collection under this same tenantId); `entityChunks`'s `insertMany` uses `{ordered:false}` (**NEW, Pass 2**, mirroring `scripts/restore.js:41`'s own precedent) so one unexpected record cannot abort unrelated ones; delete is never a bare `deleteMany({})`. Depends on: T053.
- [ ] T055 [G] Implement Step 5 apply, in the fixed order `users → entityChunks → appConfigs`: per-category digest re-check (skip if matching; `entityChunks`'s check and delete both scoped by `key:{$in:TENANT_BACKUP_ENTITY_KEYS}`) → tenant-scoped delete + direct insert with real `tenantId` (`{ordered:false}` for `entityChunks`) → append to `categoriesApplied` → rewrite checkpoint atomically. File: `scripts/tenant-restore.js`. Depends on: T054.
- [ ] T056 [G] Implement Step 6 finalize: `stage:'completed'` only once all three categories are confirmed; release the lock; print success explicitly naming the target tenant and stating a tenant-scoped restore path was used. On any error: `stage:'failed'`, record `error`, release the lock (clean failure), exit non-zero, print the recovery-model reminder (T063). File: `scripts/tenant-restore.js`. Depends on: T055.
- [ ] T057 [G] **[MANDATORY] Failure-injection test, real mechanism**: using a documented test-only hook the real apply loop checks (or a genuine mid-loop Mongo-connection interruption), force failure after `users` applies but before `entityChunks` begins. Assert: Tenant B untouched; `acme`'s `entityChunks`/`appConfigs` unchanged from pre-restore; `acme`'s `users` matches the backup; checkpoint `stage:'failed'`, `categoriesApplied:['users']`; non-zero exit; no false success output; **and this is a clean (caught) failure, so the lock is released and a plain re-run (no `--force-unlock`) is expected to work for this specific scenario** (distinguishing it from T058's real-kill scenario below). File: `tests/tenant-restore.test.js`. Depends on: T056.
- [ ] T058 [G] **[MANDATORY] Digest-based crash-window test, corrected lock policy, Pass 2**: a real process kill (not a caught exception) between `users`' DB write succeeding and its checkpoint entry being written. First assert a plain re-run (no `--force-unlock`) is **rejected at Step 0** (the lock is still held — a real kill never releases it). Then re-run **with `--force-unlock`**; assert `users` is not redundantly re-applied (verified via write-count instrumentation or a marker field), while `entityChunks`/`appConfigs` proceed and the run completes normally — closing the crash window analysis found the original checkpoint design could not honestly detect, now via a policy that is internally consistent (Pass 1's version of this test contradicted the stale-lock policy stated elsewhere). File: `tests/tenant-restore.test.js`. Depends on: T057.
- [ ] T059 [G] Run all Phase G tests. **Checkpoint** — no collection-wide destructive operation exists anywhere, the restore lock and the tenant's own idempotency store both survive an ordinary `entityChunks` apply, and both the mid-apply failure and the checkpoint-vs-reality crash window are provably non-silent and correctly (and consistently) recoverable-from. Depends on: T058.

---

## Phase H: Recovery Behavior, Restore Lock Contention, and the Production Runbook (research.md Decisions 11, 13, 18 — corrected in Pass 2)

**Stated explicitly, corrected Pass 2 — no exception for the crash-resume case**: P4 supports **resume**, always via `--force-unlock` after any non-clean (killed) prior exit — there is no scenario, including the routine crash-window demonstration itself, where a plain re-run succeeds after a real process kill. A prior attempt that exited cleanly (a caught, non-crash failure) releases its lock normally and a plain re-run suffices. P4 does **not** support automated **rollback** of an already-applied category.

- [ ] T060 [P] [H] Write failing tests: (a) **[MANDATORY] two `tenant-restore.js` processes started concurrently against the same tenant** — exactly one acquires the lock and proceeds, the other is rejected before it even opens the backup file; (b) **[MANDATORY, corrected Pass 2] a lock left behind by a killed process blocks a plain re-run unconditionally** (no scenario succeeds without `--force-unlock` after a real kill), but a re-run **with** `--force-unlock` succeeds; (c) the lock is released after both a clean success and a clean (caught) failure, and a plain re-run then succeeds without `--force-unlock` in those two cases specifically; (d) **[MANDATORY] a resume attempt with a *different* backup file than the one that partially applied is rejected** before any further write; (e) **[MANDATORY, NEW Pass 2] `--force-unlock` atomicity**: simulate two near-simultaneous `--force-unlock` invocations against the same stale lock; assert exactly one succeeds in creating the new lock and the other correctly detects contention against it (not against the already-deleted stale one) rather than both believing they hold the lock. Depends on: T059.
- [ ] T061 [H] Implement lock release in a `finally` covering both success and clean-failure exit paths, plus the atomic `--force-unlock` sequence from T041 (verify/finish here if T041's implementation needs the release-path integration completed). File: `scripts/tenant-restore.js`. Depends on: T060.
- [ ] T062 [H] Verify/implement resume: after T058's failure-injection scenario (with the required `--force-unlock`), re-run with the identical backup file; confirm it completes successfully, `categoriesApplied` includes all three categories, and no leftover local staging file remains. File: `scripts/tenant-restore.js` (only if a gap is found). Depends on: T061.
- [ ] T063 [H] Add the recovery-model CLI reminder, printed on any `stage:'failed'` exit, stating the corrected policy precisely: *"Resume: re-run this exact command with the same backup file. If this process was killed rather than exiting cleanly, the restore lock is still held — re-running requires --force-unlock, which you should only pass once you have confirmed no other restore for this tenant is genuinely still running. Rollback of an already-applied category is not automatic — restore again from an earlier backup if needed."* File: `scripts/tenant-restore.js`. Depends on: T062.
- [ ] T064 [H] Update `docs/PRODUCTION_RUNBOOK.md` with a new section: tenant backup/restore commands, the explicit distinction from whole-instance commands, full-tenant-replace-only semantics, resume (always via `--force-unlock` after a crash — stated precisely, not glossed over) versus no-rollback, the `default`-duplicate hard-block, and the Telegram/scheduler default-only limitation. File: `docs/PRODUCTION_RUNBOOK.md`. Depends on: T063.
- [ ] T065 [H] Run all Phase H tests. **Checkpoint** — lock contention, the corrected stale-lock policy, force-unlock atomicity, fingerprint mismatch, and resume are all provably correct and internally consistent, and the operator-facing documentation matches the tool's actual behavior. Depends on: T064.

---

## Phase I: Default Tenant Restore — real production compatibility case (research.md Decisions 1, 16; spec.md FR-027)

- [ ] T066 [P] [I] Write failing tests, all fixtures raw-driver-seeded per FR-027 with an explicit absence assertion: a legacy `default` `User`/`EntityChunk`/`AppConfig` (no `tenantId` field) is backed up, then restored exactly once, with no duplicate pair remaining and no non-default tenant touched; plus the genuine-duplicate-identity case end-to-end (backup-side T031 and restore-side T044 both hard-block on the same seeded conflict). Depends on: T065.
- [ ] T067 [I] Confirm/adjust Step 5's (T055) default-tenant delete step uses `_defaultTenantFilter`, not equality, for `users`/`appConfigs` (and `_defaultTenantFilter` combined with `key:{$in:TENANT_BACKUP_ENTITY_KEYS}` for `entityChunks`) so it also clears the legacy shape it is replacing. File: `scripts/tenant-restore.js`. Depends on: T066.
- [ ] T068 [I] Run T066's tests. **Checkpoint.** Depends on: T067.

---

## Phase J: Whole-Instance Separation — deliberate, not accidental (research.md Decision 7)

- [ ] T069 [P] [J] Write tests: a tenant-scoped backup file fed into the unmodified `scripts/restore.js` is rejected via the deliberate `scope==='tenant'` guard (T039) in the real, exported `validateBackupObject()`; a whole-instance backup file fed into `tenant-restore.js` is rejected at Step 1.2 (T038); omitting `--tenant=`/`--target=` on either script never falls back to the other's behavior. Depends on: T068.
- [ ] T070 [J] Diff-review (no code change): confirm `scripts/backup.js` and `scripts/restore.js` have zero line changes from their pre-P4 state, and that `lib/backupValidation.js`'s diff contains exactly the additive checks from T038/T039/T029 and nothing else. Depends on: T069.
- [ ] T071 [J] Run T069's tests. **Checkpoint.** Depends on: T070.

---

## Phase K: Regression / Safety

- [ ] T072 [P] [K] Run the existing `tests/tenant-isolation.test.js` unmodified; confirm still green. Depends on: T071.
- [ ] T073 [P] [K] Run the full existing Mongo-backed regression suite (every `mongoTestHarness` file, plus every new file from Phases A/B/D/E/F/G/I); confirm all green. Depends on: T071.
- [ ] T074 [P] [K] Run `tests/production-hardening.test.js` (extended in T037/T038/T039); confirm the pre-existing cases and the new ones are all green together. Depends on: T071.
- [ ] T075 [K] Run the full suite (`npm test`) and compare the pass count against T001's baseline. **Final checkpoint**: 0 regressions, every new test from Phases A-J green, 0 accounting-logic change. Depends on: T072, T073, T074.

---

## Dependencies & Execution Order

Unchanged phase-level ordering from prior passes. The restore lock (Decision 11) is acquired at the front of Phase E, before validation; the runbook (Decision 18) is at the end of Phase H. `scripts/tenant-restore.js`'s single `run()` sequence is Lock → Validate (incl. fingerprint) → Duplicate-pre-flight → Stage → Checkpoint → Apply, in that literal order — Phase G's apply step is structurally incapable of running before Phase F's staging and Phase E's lock+validation succeed.

## Task Quality Gate (self-check before `/speckit-analyze` re-verification)

- **No task uses a collection-wide destructive operation**: T055's delete is always `{tenantId:target}` (or `_defaultTenantFilter`) — and, for `entityChunks` specifically, additionally `key:{$in:TENANT_BACKUP_ENTITY_KEYS}` (Pass 2 correction); T054's own test exists specifically to catch a regression to a bare `{tenantId}` delete on `entityChunks`.
- **Every tenant-owned write has explicit scope**: A (T003-T005), B (T012-T014, T016 — the last restoring the dropped default-tenant AppConfig fix), G (T055, T067).
- **No live-Mongo synthetic-tenant staging remains anywhere**: T046's own test (case 1) is a direct assertion of this; the restore lock (T041) is the only new EntityChunk-shaped document restore ever creates under a non-real identity, and it lives under the real target tenant's own collection space — now provably protected from the category delete by T054/T055's key-scoping fix.
- **Failure-injection tests are present, real, and internally consistent**: T057 (mid-apply, clean failure, plain re-run works) and T058 (crash-window, real kill, `--force-unlock` required) — Pass 2 specifically resolves the contradiction between these two that Pass 1 left standing.
- **Concurrent-restore, fingerprint-mismatch, and force-unlock-atomicity tests are present and mandatory**: T060(a), T060(d), T060(e).
- **A resumed invocation can always find its own prior checkpoint**: T043/T052 key the checkpoint by `targetTenantId`, not `runId` — T046(5) and the checkpoint tests confirm this explicitly.
- **The digest-resume mechanism is order-independent**: T029's `canonicalJson()` sorts arrays by identity key before serializing, with a dedicated task and test proving this.
- **Default legacy compatibility and duplicate-detection have explicit, raw-driver-seeded tasks**: T002/T007/T026/T066 (legacy), T031/T044/T066 (duplicate hard-block).
- **Recovery semantics are concrete and internally consistent (Pass 2)**: Phase H states resume-always-via-force-unlock-after-a-crash explicitly, with no carve-out, backed by T041 (lock)/T043 (fingerprint)/T055 (digest re-check).
- **No hidden Mongo-transaction dependency**: none of Phases F/G/H use `startSession`/`withTransaction`.
- **No task silently expands Telegram/scheduler to full multi-tenant**: T019-T023 add rejections, not a new capability.
- **`Tenant`/`Subscription` exclusion is consistent everywhere a task touches backup/restore scope**: T032/T033 (backup, 3 categories only), T037 (restore validation rejects a `tenants`/`subscriptions` key), no task anywhere stages, applies, or counts either.

## Ready for `/speckit-analyze`?

**YES.**
