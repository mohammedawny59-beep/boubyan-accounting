---

description: "Task list for Tenant Isolation + Safe Backup/Restore Hardening (P4)"
---

# Tasks: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Input**: Design documents from `specs/002-tenant-isolation-backup-hardening/`
**Prerequisites**: plan.md, spec.md (Clarified), research.md, data-model.md, contracts/, quickstart.md (all present)
**Tests**: Explicitly requested — TDD-ordered (failing test task precedes its implementation task) throughout every phase.

## Format: `[ID] [P?] [Phase] Description`

- **[P]**: Genuinely parallelizable — different file AND no dependency on an incomplete task.
- **[Phase]**: A–K, mapping to the product owner's explicit phase list (this deviates from Spec Kit's default user-story grouping — there are no independent user-facing "stories" in this backend/data-layer hardening phase; the product owner's own Phase A–K order is the primary organization, matching the precedent already set by `specs/001-vendor-ap-workspace/tasks.md`'s backend-first deviation).

## Task Dependency Rule (as specified)

`isolation (A) → config (B) → default-only boundaries (C) → backup (D) → restore validation (E) → staging (F) → checkpoint/apply (G) → recovery (H) → default compatibility (I) → separation/regression (J, K)`

Restore-apply tasks (Phase G) are structurally incapable of running before Phase E (validation) and Phase F (staging) complete — `scripts/tenant-restore.js`'s single entry point calls validate → stage → verify-staged → checkpoint → swap in that literal order (contracts/tenant-restore-contract.md); there is no flag or code path that reaches the swap step without passing through the earlier ones.

---

## Phase 1: Setup

- [ ] T001 Run the existing full test suite once, unmodified, as a pre-implementation baseline (`npm test`); record the pass count for comparison against T059 (Phase K's final regression checkpoint). File: `tests/` (whole suite, no changes made). No dependencies.

---

## Phase A: Tenant Write Isolation — `persistUsers()` / `persistEntityKey()`

Closes CRITICAL findings 1 and 2 (default-tenant Mongo writes can delete/overwrite another tenant's `User`/`EntityChunk` documents). Grounded in `contracts/tenant-write-isolation-contract.md` and `research.md` Decision 1.

- [ ] T002 [P] [A] Write failing Mongo-backed tests in **new** `tests/tenant-write-isolation.test.js` (using `tests/helpers/mongoTestHarness.js`), covering all 5 required assertions: (1) default-tenant save does not delete a Tenant B user sharing the same `id`; (2) default-tenant upsert does not overwrite a Tenant B user sharing the same `id`; (3) default-tenant entity save does not overwrite a Tenant B `EntityChunk` sharing the same `key`; (4) a legacy default `User`/`EntityChunk` document with no `tenantId` field at all is updated in place (not duplicated) by a default-tenant write; (5) no duplicate default-tenant document is created when a legacy no-`tenantId`-field document already exists for the same `id`/`key`. Seed data must include an actual `id`/`key` collision between `default` and Tenant B, matching the real-world shape that made the original bug dangerous (quickstart.md §1). Expected to **FAIL** against current `lib/database.js`. Depends on: T001.
- [ ] T003 [A] Implement the scoping fix for `persistUsers()` (`lib/database.js:424`): change the delete filter from `{id:{$nin:ids}}`/`{}` to `{..._defaultTenantFilter, id:{$nin:ids}}`/`_defaultTenantFilter`, and the upsert match filter from `{id:u.id}` to `{..._defaultTenantFilter, id:u.id}`. Do **not** change the `$set` payload in this task (that is T005) — this task closes the cross-tenant leakage bug on its own, independently reviewable from the normalize-forward behavior. File: `lib/database.js`. Depends on: T002.
- [ ] T004 [A] Implement the identical scoping fix for `persistEntityKey()` (`lib/database.js:445`): change the filter from `{key}` to `{..._defaultTenantFilter, key}`. `$set` payload unchanged in this task (T005). File: `lib/database.js`. Depends on: T002 (same file as T003 — sequential, not parallel).
- [ ] T005 [A] Implement default-tenant normalize-forward behavior: add `tenantId: 'default'` to the `$set` payload in both `persistUsers()`'s `bulkWrite` `updateOne` and `persistEntityKey()`'s `updateOne` (`lib/database.js:424-451`). This is the smaller, separately-reviewable follow-up that makes every default-tenant write converge a legacy no-`tenantId`-field document to an explicit `tenantId:'default'` over time, closing the "matches via `_defaultTenantFilter` but never gets an explicit field" gap T003/T004 alone would leave open. File: `lib/database.js`. Depends on: T003, T004.
- [ ] T006 [A] Run `tests/tenant-write-isolation.test.js`; confirm all 5 assertions from T002 now pass. **Checkpoint**: Tenant write isolation for `User`/`EntityChunk` is complete, tested, and independently verifiable. Depends on: T005.

---

## Phase B: Config Isolation — `_configCache` / `AppConfig`

Closes HIGH finding 4 (process-global config shared across every tenant in the process). Grounded in `contracts/tenant-write-isolation-contract.md` and `research.md` Decision 2.

- [ ] T007 [P] [B] Write failing tests in **new** `tests/tenant-config-isolation.test.js` covering all 4 required proofs: (1) Tenant A's `saveConfig()` never becomes visible to Tenant B's `loadConfig()` in the same process; (2) fee-rate/card/KNET-shaped settings stay isolated across tenants; (3) SMTP/branding-shaped settings stay isolated across tenants; (4) a legacy default `AppConfig` document with no `tenantId` field is normalized in place by a default-tenant `saveConfig()`, never duplicated (mirrors T002's case 4/5 for the `AppConfig` collection specifically). Cases 1-3 use the lightweight `DB_FILE_ONLY`-style harness (pure in-process Map assertions); case 4 uses `mongoTestHarness.js`. Expected to **FAIL** against current `lib/database.js`. Depends on: T006 (sequential phase order per the dependency rule — config isolation does not begin until write isolation is checkpointed).
- [ ] T008 [B] Add the two new module-level state containers to `lib/database.js`, alongside the existing `_tenantCaches`/`_tenantDirty` declarations (`:17-22`): `_tenantConfigCaches = new Map()` and `_tenantConfigDirty = new Set()`. Declaration only, unused until T009-T011. File: `lib/database.js`. Depends on: T007.
- [ ] T009 [B] Implement tenant-aware `loadConfig()` (`lib/database.js:801`): branch on `_currentTenantId()`; `'default'` keeps today's exact `deepMerge(_defaultConfig, _configCache)` behavior unchanged; any other tenant reads from `_tenantConfigCaches` if cached, else lazily loads `AppConfig.findOne({tenantId, key:'config'})` (plain equality — a real tenant's config always carries an explicit `tenantId`, research.md Decision 2), merges over `_defaultConfig`, and caches the result. File: `lib/database.js`. Depends on: T008.
- [ ] T010 [B] Implement tenant-aware `saveConfig(cfg)` (`lib/database.js:807`): branch identically; `'default'` unchanged; any other tenant writes into `_tenantConfigCaches`, marks `_tenantConfigDirty`, and calls the existing `_scheduleTenantPersist(tid)` debounce timer (`:57`). File: `lib/database.js`. Depends on: T009 (same file).
- [ ] T011 [B] Wire config flush into the existing per-tenant debounce cycle: extend `_flushTenantToMongo(tenantId)` (`lib/database.js:38`) with one added branch — if `_tenantConfigDirty.has(tenantId)`, write `AppConfig.updateOne({tenantId, key:'config'}, {$set:{tenantId, data:_tenantConfigCaches.get(tenantId), updatedAt:new Date()}}, {upsert:true})` and clear the dirty flag — reusing the **same** timer T010 already schedules, not a second parallel one (research.md Decision 2, Complexity Tracking entry 2). File: `lib/database.js`. Depends on: T010.
- [ ] T012 [B] Implement default-tenant `_defaultTenantFilter` + normalize-forward for the config collection: change `initConfig()`'s read (`lib/database.js:612`, `AppConfig.findOne({key:'config'})`) to `AppConfig.findOne({..._defaultTenantFilter, key:'config'})`, and `flushToMongo()`'s config write (`:488-496`, `AppConfig.updateOne({key:'config'},...)`) to `AppConfig.updateOne({..._defaultTenantFilter, key:'config'}, {$set:{tenantId:'default', data:_configCache, updatedAt:new Date()}}, {upsert:true})`. File: `lib/database.js`. Depends on: T011.
- [ ] T013 [B] Run `tests/tenant-config-isolation.test.js`; confirm all 4 proofs from T007 now pass. **Checkpoint**: config isolation is complete, tested, and independently verifiable. Depends on: T012.

---

## Phase C: Telegram / Monitor Default-Only Boundaries

Closes HIGH finding 5. Grounded in `contracts/telegram-scheduler-boundary-contract.md` and `research.md` Decision 3. **Internal Telegram business logic (`setupBot()`'s ~50 `bot.sendMessage()` call sites) is not modified anywhere in this phase** — the root-cause gate at the entry points makes that unnecessary (see contract doc).

- [ ] T014 [P] [C] Write failing `supertest`-based tests in **new** `tests/telegram-scheduler-boundary.test.js` covering, for each of the 4 routes (`POST /api/telegram/start`, `POST /api/monitor/inventory`, `POST /api/monitor/monthly-report`, `POST /api/reports/send-telegram`): (a) a `default`-tenant user with the route's existing required permission gets today's unchanged behavior (regression guard); (b) a non-`default`-tenant user with the same permission gets `403` + `code:'TELEGRAM_DEFAULT_TENANT_ONLY'`; (c) for the non-`default` case, assert no side effect occurred before rejection — `global._tgBot`/`bot` unchanged for route 1, a mocked `sendMessage` never called for routes 2-4. 4 routes × 3 assertions = 12 cases. Expected to **FAIL** against current `server.js`. Depends on: T013 (sequential phase order).
- [ ] T015 [C] Add the default-only guard (contract doc's exact check) to `POST /api/telegram/start` (`server.js:2678`), inserted after the existing `requireAuth, requirePermission('telegram','edit')` gate, before the bot-stop/bot-instantiate side effect. File: `server.js`. Depends on: T014.
- [ ] T016 [P] [C] Add the identical guard to `POST /api/monitor/inventory` (`server.js:9822`), after `requireAuth, requireAdminAction('monitor.trigger_inventory')`, before `runInventoryCheck()`. File: `server.js`. Depends on: T014 (parallel with T015/T017/T018 — same file, but non-overlapping line ranges; run sequentially in practice to avoid merge friction, kept `[P]`-labeled per the format's "different concern, no logical dependency" intent).
- [ ] T017 [P] [C] Add the identical guard to `POST /api/monitor/monthly-report` (`server.js:9826`), after `requireAuth, requireAdminAction('monitor.trigger_monthly_report')`, before `runMonthlyReport()`. File: `server.js`. Depends on: T014.
- [ ] T018 [P] [C] Add the identical guard to `POST /api/reports/send-telegram` (`server.js:15987`), after `requireAuth, requirePermission('reports','export')`, before the bot-existence check/send loop. File: `server.js`. Depends on: T014.
- [ ] T019 [C] Re-run the `bot`/`global._tgBot`/`TelegramBot`/`bot.sendMessage` grep from `research.md` Decision 3 against the current `server.js`, immediately before considering this phase done, to confirm no 5th route touching the process-global bot singleton was added since this plan was written. Verification task — no code change expected; if a new route IS found, it must receive the same guard (T015-T018 pattern) before this phase's checkpoint. Depends on: T018.
- [ ] T020 [C] Run `tests/telegram-scheduler-boundary.test.js`; confirm all 12 cases from T014 now pass. **Checkpoint**: the default-only boundary is complete, tested, and does not silently expand Telegram/scheduler to a full multi-tenant capability. Depends on: T015, T016, T017, T018, T019.

---

## Phase D: Tenant-Scoped Backup

New, additive tooling. Grounded in `contracts/tenant-backup-contract.md` and `research.md` Decisions 5, 7, 8, 9. **Must be complete and independently testable before Phase E (restore) begins** — restore's own tests in Phase E/F/G consume backup files this phase's tooling produces.

- [ ] T021 [P] [D] Write failing tests in **new** `tests/tenant-backup.test.js` (`mongoTestHarness`) covering the full test contract: (1) cross-tenant leakage — seed Tenant A/B with a colliding `id`/`key`, back up A, assert zero B-owned documents anywhere in the output; (2) legacy inclusion — seed a legacy no-`tenantId`-field default user/entity-chunk, back up `default`, assert it IS included; (3) missing `--tenant=` exits non-zero before any Mongo connection or file write; (4) a tenant with no `Tenant`/`Subscription` registry row (including `default`) still produces a successful backup with empty arrays for those two collections. Expected to **FAIL** (script does not exist yet). Depends on: T020 (sequential phase order).
- [ ] T022 [D] Export `_tenantFilePath(tid)` from `lib/database.js`'s `module.exports` (`:1081`) — no behavior change, purely making an already-existing, already-correct helper reusable by T024 below (research.md Decision 9). File: `lib/database.js`. Depends on: T021.
- [ ] T023 [D] Create `scripts/tenant-backup.js`: argument parsing only in this task — `--tenant=` required, no default, no positional fallback; missing/empty prints usage and exits `1` before any Mongo/file access (spec.md FR-018/FR-021). File: `scripts/tenant-backup.js` (new). Depends on: T021.
- [ ] T024 [D] Implement Mongo-mode collection queries in `scripts/tenant-backup.js`, per `contracts/tenant-backup-contract.md`'s table: `_defaultTenantFilter` (imported from `lib/database.js`) for `tenantId==='default'` across `users`/`entityChunks` (`key:{$in:ENTITY_KEYS}`)/`appConfigs`, plain `{tenantId}` for `tenants`/`subscriptions` and for any non-`default` tenant across all five. `idempotencyRecords` is never queried (research.md Decision 8). File: `scripts/tenant-backup.js`. Depends on: T023.
- [ ] T025 [P] [D] Implement file-mode tenant backup in `scripts/tenant-backup.js`: `default` reads `data/database.json`/`data/config.json` (existing paths, unchanged); any other tenant reads exactly `data/tenants/<sanitized-tenantId>.json` via T022's exported `_tenantFilePath()` — no other tenant's file is ever opened. File: `scripts/tenant-backup.js`. Depends on: T022 (parallel with T024 — distinct code branch, same file, low overlap risk).
- [ ] T026 [D] Implement the output format and integrity metadata in `scripts/tenant-backup.js`: `{scope:'tenant', schemaVersion:1, tenantId, createdAt, source, recordCounts, collections}` (data-model.md format 1), `recordCounts` computed from the same in-memory arrays just written (never a second query), checksum sidecar via the existing, unmodified `computeChecksum()` from `lib/backupValidation.js`. File: `scripts/tenant-backup.js`. Depends on: T024, T025.
- [ ] T027 [D] Add `"backup:tenant": "node scripts/tenant-backup.js"` to `package.json`, alongside (not replacing) the existing `"backup"` script. File: `package.json`. Depends on: T026.
- [ ] T028 [D] Run `tests/tenant-backup.test.js`; confirm all 4 cases from T021 now pass. **Checkpoint**: tenant-scoped backup is complete and independently testable — restore implementation (Phase E onward) may now begin. Depends on: T027.

---

## Phase E: Restore Validation (must run before any staging or destructive/swap behavior)

Grounded in `contracts/tenant-restore-contract.md`'s ordered validation gate and `research.md` Decision 7. **No task in this phase writes to Mongo or a real data file.**

- [ ] T029 [P] [E] Write failing unit tests, **extending** `tests/production-hardening.test.js` (which already owns backup/restore validation coverage, per plan.md Project Structure), for `validateTenantBackupObject(backup, targetTenantId)` covering, in order: (1) structural rejection (reuses existing `validateBackupFile()` checks — non-existent/empty/unparseable file); (2) `scope!=='tenant'` rejection (feeding a whole-instance-shaped object); (3) unknown/unsupported `schemaVersion` rejection; (4) ambiguous/missing `tenantId` rejection; (5) `backup.tenantId !== targetTenantId` rejection; (6) `recordCounts` not matching actual `collections` array lengths rejection; (7) a fully valid tenant-scoped object passes. Expected to **FAIL** (function does not exist yet). Depends on: T028 (sequential phase order — restore validation does not begin until backup is checkpointed).
- [ ] T030 [E] Implement `validateTenantBackupObject(backup, targetTenantId)` in `lib/backupValidation.js`, additive export only — `validateBackupObject()`/`validateBackupFile()`/`computeChecksum()`/`extractTenantIds()` unchanged (zero regression risk to the existing whole-instance validation path). Implements the 6-step ordered gate from T029. File: `lib/backupValidation.js`. Depends on: T029.
- [ ] T031 [E] Create `scripts/tenant-restore.js`: argument parsing — `<backup-file>` positional, `--tenant=`, `--target=` all required (no defaults, no fallback to whole-instance behavior), `--yes` optional, mirroring `scripts/restore.js`'s own established `--target=` convention exactly. File: `scripts/tenant-restore.js` (new). Depends on: T029.
- [ ] T032 [E] Wire the validation gate as the literal first thing `scripts/tenant-restore.js`'s `run()` does: load and `JSON.parse` the file, call T030's `validateTenantBackupObject()`, and on ANY failure print every problem (mirrors `scripts/restore.js:91-95`'s "print all problems, write nothing" convention) and exit non-zero **before opening a Mongo connection or touching any real file** — no staging, no checkpoint file, nothing. File: `scripts/tenant-restore.js`. Depends on: T030, T031.
- [ ] T033 [E] Run the extended `tests/production-hardening.test.js` validation cases (T029) plus a new end-to-end test asserting `scripts/tenant-restore.js` exits non-zero and creates zero files/writes for each of the 6 rejection cases when run as a real subprocess (not just the unit-level function). **Checkpoint**: no staging or swap code exists yet, and none can run until Phase F/G are implemented — validation is structurally the only thing this script can currently do. Depends on: T032.

---

## Phase F: Restore Staging (no real tenant records touched)

Grounded in `contracts/tenant-restore-contract.md` step 2-3 and `research.md` Decision 6.

- [ ] T034 [P] [F] Write failing tests in **new** `tests/tenant-restore.test.js` (`mongoTestHarness`) covering: (1) staged documents are written under a synthetic `__restage__<target>__<runId>` `tenantId`, never the real target `tenantId`; (2) staged document counts match the backup's own `recordCounts`; (3) staged documents' identity (every non-key field) matches the backup's `collections` content exactly; (4) a leftover synthetic-tenantId document from a prior failed run (pre-seeded by the test) is deleted before a new staging attempt writes its own; (5) **no document under the real target `tenantId`, or any other tenant's `tenantId`, changes at all during staging** — the core "no real tenant records touched in this phase" guarantee. Expected to **FAIL** (staging code does not exist yet). Depends on: T033 (sequential phase order — staging does not begin until validation is checkpointed).
- [ ] T035 [F] Implement synthetic staging-tenantId generation and pre-stage cleanup in `scripts/tenant-restore.js`: generate `runId`, derive `__restage__<target>__<runId>`, and before writing anything new, delete any documents matching `tenantId` patterns `__restage__<target>__*` left over from a prior failed run (idempotent re-run — this is also what Phase H's resume path relies on). File: `scripts/tenant-restore.js`. Depends on: T034.
- [ ] T036 [F] Implement the staging write itself: `insertMany()` the validated backup's `collections` content into `users`/`entityChunks`/`appConfigs`/`tenants`/`subscriptions`, with each document's `tenantId` field rewritten to the synthetic value from T035 — reusing the exact `insertMany` mechanics `scripts/restore.js:41` already uses, substituting only the `tenantId` field, per research.md Decision 6 ("reuse existing primitives, one small new file-based checkpoint" — not a new query/write idiom). File: `scripts/tenant-restore.js`. Depends on: T035.
- [ ] T037 [F] Implement staged-count and staged-ownership verification: re-query the just-staged documents by the synthetic `tenantId`, compare counts against `backup.recordCounts`, and confirm every staged document's non-`tenantId` fields match the backup's `collections` content. On any mismatch, abort here — **before** T038's checkpoint file is created and **before** any real-tenant document is touched. File: `scripts/tenant-restore.js`. Depends on: T036.
- [ ] T038 [F] Run `tests/tenant-restore.test.js`'s staging cases (T034); confirm all 5 pass, and explicitly assert (via a direct query) that zero documents under the real target `tenantId` or any other tenant's `tenantId` were modified during the whole of Phase F. **Checkpoint**: staging is complete, tested, and provably non-destructive to any real tenant's data. Depends on: T037.

---

## Phase G: Checkpoint / Apply — highest-risk section

Grounded in `contracts/tenant-restore-contract.md` steps 4-6. Every task here is deliberately narrow — no task performs more than one class of dangerous operation.

- [ ] T039 [P] [G] Write failing tests in `tests/tenant-restore.test.js` for the checkpoint file's own lifecycle (independent of the swap logic itself): a checkpoint file is created at `backups/.restore-checkpoints/<runId>.json` (data-model.md format 2) **before** the first real-tenant delete of Phase G occurs — assert this by checking the file exists with `stage:'staged-verified'` at the exact moment immediately after T037/T038 and before any `deleteMany`/`updateMany` against a real `tenantId` runs; `runId`, `targetTenantId`, `backupFile`, timestamps are all present and correct. Expected to **FAIL** (checkpoint code does not exist yet). Depends on: T038 (sequential phase order).
- [ ] T040 [G] Implement checkpoint file creation in `scripts/tenant-restore.js`, written immediately after T037's staged-verification succeeds and before any real-collection delete: `{runId, targetTenantId, backupFile, startedAt, updatedAt, stage:'staged-verified', collectionsSwapped:[], error:null}`. File: `scripts/tenant-restore.js`. Depends on: T039.
- [ ] T041 [P] [G] Write failing tests for the per-collection swap step in isolation: for one collection at a time (start with `users`), assert (a) the real target tenant's old documents in that collection are deleted using a scope that is `{tenantId:target}` or `_defaultTenantFilter` for `default` — **never** a bare `deleteMany({})`; (b) the staged synthetic-tenantId documents for that collection are then repointed to the real target `tenantId` via `updateMany`; (c) `collectionsSwapped` in the checkpoint file gains that collection's name only after both (a) and (b) succeed; (d) a different tenant's documents in the same collection are provably untouched by this step. Expected to **FAIL**. Depends on: T040.
- [ ] T042 [G] Implement the per-collection swap step in `scripts/tenant-restore.js`, in the fixed order `users → entityChunks → appConfigs → [tenants, subscriptions if target !== 'default']`: for each collection, delete the real target tenant's current documents (tenant-scoped filter — never collection-wide), `updateMany()` the staged documents' `tenantId` from the synthetic value to the real target, then append the collection's name to `collectionsSwapped` and rewrite the checkpoint file (`stage:'swapping'`) — progress persisted to disk after **every** completed collection, not just at the end. File: `scripts/tenant-restore.js`. Depends on: T041.
- [ ] T043 [G] Implement the finalize step: once every collection in the fixed order has been swapped and recorded, rewrite the checkpoint file with `stage:'completed'`, and only then does `scripts/tenant-restore.js` print/return a success result. On any error at any point in T042's loop, catch it, set `stage:'failed'` + `error:<message>` in the checkpoint file (leaving `collectionsSwapped` exactly as far as it got), and exit non-zero — there is no code path that prints or returns success while `collectionsSwapped` is incomplete. File: `scripts/tenant-restore.js`. Depends on: T042.
- [ ] T044 [G] **[MANDATORY] Failure-injection test** — write in `tests/tenant-restore.test.js`: force a thrown error inside T042's loop specifically **after** the `users` collection has fully swapped (deleted-old + repointed-staged + `collectionsSwapped` updated) but **before** the `entityChunks` collection's swap begins (e.g. mock `EntityChunk.deleteMany` to throw once, or an injectable test-only failure hook). Assert **all** of: (a) Tenant B's documents in every collection are byte-identical to before the run; (b) the target tenant's `entityChunks`/`appConfigs`/etc. (everything after `users` in the fixed order) are byte-identical to their pre-restore state — not partially written; (c) the target tenant's `users` DOES match the backup (the one collection that legitimately completed); (d) the checkpoint file shows `stage:'failed'`, `collectionsSwapped:['users']`, and a non-null `error`; (e) the script process exits non-zero; (f) no stdout/return value from the script claims success. This test explicitly does **not** count if it only exercises Phase E's pre-validation rejection — the failure must occur mid-swap, after at least one real collection replacement. File: `tests/tenant-restore.test.js`. Depends on: T043.
- [ ] T045 [G] Run all of Phase G's tests (T039, T041, and the mandatory T044); confirm all pass. **Checkpoint**: checkpoint/apply is complete, no task in this phase used a collection-wide destructive operation, and a genuine mid-swap failure is provably non-silent and deterministically recoverable-from. Depends on: T044.

---

## Phase H: Recovery Behavior

**Stated explicitly, not left vague, per the instruction**: P4 supports **resume** (re-running `tenant-restore.js` from scratch with the same backup file after a failed/interrupted run). P4 does **NOT** support automated **rollback** of an already-completed collection swap back to its pre-restore state — once a collection is recorded in `collectionsSwapped`, its pre-restore data is gone from that collection; the only way to revert it is to run `tenant-restore.js` again, deliberately, with a backup taken *before* the unwanted restore (an ordinary, operator-driven restore using this same tool — not a distinct "rollback" feature or code path).

- [ ] T046 [P] [H] Write a test in `tests/tenant-restore.test.js` proving **resume** works: starting from T044's failure-injection scenario (checkpoint `stage:'failed'`, `collectionsSwapped:['users']`), re-run `scripts/tenant-restore.js` with the identical arguments and backup file; assert it completes successfully (`stage:'completed'`, `collectionsSwapped` includes every collection), and assert zero leftover synthetic `__restage__` documents remain in any collection afterward. Depends on: T045.
- [ ] T047 [H] Verify (and fix if the test finds a gap) that resume needs no code beyond what T035 (pre-stage cleanup) and T042 (per-collection swap, idempotent by construction — deleting-then-inserting a collection a second time produces the same end state) already implement. If T046 passes without any further code change, this task is a verification-only checkpoint; if it does not, the minimal fix belongs here, not a new resume-specific mechanism. File: `scripts/tenant-restore.js` (only if a gap is found). Depends on: T046.
- [ ] T048 [H] Document the recovery model explicitly in two places so an operator sees it immediately during an incident, not only in `quickstart.md`: (a) add a "Recovery model" paragraph to `quickstart.md` stating the resume-yes/rollback-no distinction from this phase's header verbatim; (b) make `scripts/tenant-restore.js`'s own failure output print a one-line reminder — *"Resume: re-run this exact command with the same backup file. Rollback of an already-swapped collection is not automatic — restore again from a backup taken before this run if needed."* — alongside the checkpoint file path, whenever it exits with `stage:'failed'`. Files: `quickstart.md`, `scripts/tenant-restore.js`. Depends on: T047.

---

## Phase I: Default Tenant Restore — real production compatibility case

Grounded in `research.md` Decisions 1 and 5, `contracts/tenant-restore-contract.md`'s `default`-specific guarantees.

- [ ] T049 [P] [I] Write failing tests in `tests/tenant-restore.test.js` (or a dedicated `tests/tenant-default-legacy-restore.test.js` if the file is getting large) seeding a legacy `default` `User`, `EntityChunk`, and `AppConfig` document — **each with no `tenantId` field at all** — then: (1) `tenant-backup.js --tenant=default` includes all three; (2) mutate/delete them locally, then `tenant-restore.js ... --tenant=default`; (3) assert all three are restored exactly once; (4) assert no duplicate pair (one legacy no-field copy, one explicit `tenantId:'default'` copy) exists for any of the three afterward; (5) assert no non-`default` tenant's document is touched by this restore. Expected to **FAIL** until T050. Depends on: T045 (Phase G checkpointed) and T028 (Phase D checkpointed) — the last of the dependency-rule's ordering, run after both backup and the full restore pipeline exist.
- [ ] T050 [I] Confirm/implement that T042's per-collection swap step uses `_defaultTenantFilter` (not `{tenantId:'default'}` equality) for the delete-old half of the swap when `targetTenantId==='default'`, exactly like every other default-tenant write path in this phase (T003-T005, T012) — so a `default` restore's delete step also clears legacy no-`tenantId`-field documents it is replacing, and the subsequent repoint-staged step (which always writes explicit `tenantId:'default'`) never leaves a duplicate pair behind. File: `scripts/tenant-restore.js`. Depends on: T049.
- [ ] T051 [I] Run T049's tests; confirm all pass. **Checkpoint**: the real, currently-in-production `default` tenant's legacy data shape is provably compatible with tenant-scoped backup/restore. Depends on: T050.

---

## Phase J: Whole-Instance Separation

Grounded in `contracts/tenant-restore-contract.md`'s format-discriminator guarantees and `research.md` Decision 7.

- [ ] T052 [P] [J] Write tests proving structural, not just documentational, separation: (1) feed a tenant-scoped backup file (from T028's `tenant-backup.js` output) into the **existing, unmodified** `scripts/restore.js`; assert rejection via its existing `validateBackupFile()`/`validateBackupObject()` checks (missing `collections`/`database` shape it expects) with zero writes; (2) feed a whole-instance backup file (from the existing, unmodified `scripts/backup.js`) into the **new** `scripts/tenant-restore.js`; assert rejection at the `scope!=='tenant'` validation step (T030) with zero writes; (3) confirm omitting `--tenant=` on `tenant-restore.js`, or `--target=` on either script, never silently falls back to whole-instance behavior — both exit non-zero. Depends on: T051.
- [ ] T053 [J] Diff-review task (no code change): confirm `scripts/backup.js` and `scripts/restore.js` have **zero** line changes from their pre-P4 committed state (`git diff fe35770..HEAD -- scripts/backup.js scripts/restore.js` returns empty) — explicit proof that no compatibility fix was found strictly necessary in either file, per the instruction to leave them unchanged unless one is. File: none (verification only). Depends on: T052.
- [ ] T054 [J] Run T052's tests; confirm all 3 pass. **Checkpoint**: whole-instance and tenant-scoped backup/restore are structurally, not just procedurally, incapable of cross-feeding each other. Depends on: T053.

---

## Phase K: Regression / Safety

No test in this phase modifies production or demo — every test here runs against `mongodb-memory-server` or `DB_FILE_ONLY=true`, matching every other test in this plan.

- [ ] T055 [P] [K] Run the existing `tests/tenant-isolation.test.js` unmodified; confirm it is still fully green (no regression introduced by Phase A/B's changes to the functions it already exercises at the in-memory-cache layer). Depends on: T054.
- [ ] T056 [P] [K] Run the full existing Mongo-backed regression suite (every test file using `tests/helpers/mongoTestHarness.js`, plus the new files from Phases A/D/E/F/G/I); confirm all green. Depends on: T054.
- [ ] T057 [P] [K] Run `tests/production-hardening.test.js` (extended in T029/T030 with `validateTenantBackupObject()` cases); confirm the pre-existing Backup/Restore B/C cases and the new tenant-scoped cases are all green together. Depends on: T054.
- [ ] T058 [P] [K] Run the existing accounting-integrity-relevant suites (journal validation, `lockedPeriods`, AP/AR lifecycle) unmodified; confirm zero change in outcome — this phase touches no accounting logic, so this is a pure regression confirmation, not new coverage. Depends on: T054.
- [ ] T059 [K] Run the full suite (`npm test`) and compare the pass count against T001's baseline. **Final checkpoint**: 0 regressions, every new test from Phases A-J green, 0 accounting-logic change. Depends on: T055, T056, T057, T058.

---

## Dependencies & Execution Order

### Phase Dependencies (matches the product owner's required order exactly)

1. **A — Tenant Write Isolation**: no dependency beyond Phase 1 setup.
2. **B — Config Isolation**: depends on A being checkpointed (T006).
3. **C — Telegram/Monitor Boundaries**: depends on B being checkpointed (T013).
4. **D — Tenant Backup**: depends on C being checkpointed (T020).
5. **E — Restore Validation**: depends on D being checkpointed (T028) — backup must exist and be tested before restore validation is written against its output format.
6. **F — Restore Staging**: depends on E being checkpointed (T033) — cannot stage from an unvalidated file.
7. **G — Checkpoint/Apply**: depends on F being checkpointed (T038) — cannot swap real data before staged data is verified. This is enforced structurally, not just by task order (contracts/tenant-restore-contract.md's single linear `run()` sequence).
8. **H — Recovery**: depends on G being checkpointed (T045) — resume is meaningless before a failure mode exists to resume from.
9. **I — Default Tenant Restore**: depends on both D (T028) and G (T045) — needs the full backup→restore pipeline to exist before testing `default`'s specific legacy-compatibility case.
10. **J — Whole-Instance Separation**: depends on I (T051).
11. **K — Regression/Safety**: depends on J (T054); final task T059 depends on all of K's parallel checks.

### Parallel Opportunities

- Within each phase's test-writing task (`[P]`-marked), nothing blocks starting the next phase's design review, but implementation tasks within a phase are mostly sequential (same file, `lib/database.js` or `scripts/tenant-restore.js`, edited incrementally) — the `[P]` marks in Phases C/D/F/G/K reflect genuinely distinct files or non-overlapping concerns, not intra-file parallelism.
- Phase K's four regression-suite tasks (T055-T058) are fully independent of each other and may run in parallel.

---

## Task Quality Gate (self-check before `/speckit-analyze`)

- **No task uses a collection-wide destructive operation**: verified — every delete in T003/T004/T042/T050 is filtered by `_defaultTenantFilter` or an explicit `{tenantId:target}`; T041's own test exists specifically to catch a regression to `deleteMany({})`.
- **Every tenant-owned write has explicit scope**: A (T003-T005), B (T009-T012), G (T042, T050) — no unscoped write remains in any task.
- **Failure-injection test is present**: T044, mandatory, fails mid-swap (after `users`, before `entityChunks`) — not merely at pre-validation.
- **Default legacy compatibility has explicit tasks**: T005/T012 (normalize-forward), T050 (restore-side `_defaultTenantFilter`), T049/T051 (dedicated test phase).
- **Recovery semantics are concrete**: Phase H states resume-yes/rollback-no explicitly, with a task (T048) to surface that statement in the tool's own failure output, not just documentation.
- **No hidden Mongo-transaction dependency**: no task in Phases F/G uses `startSession`/`withTransaction`; the staged/checkpoint design is the direct substitute (research.md Decision 4/6).
- **No task silently expands Telegram/scheduler to full multi-tenant**: T015-T018 add a rejection, not a new capability; T019 is a verification task, not a feature-expansion task.

## Ready for `/speckit-analyze`?

**YES.**
