---

description: "Task list for Tenant Isolation + Safe Backup/Restore Hardening (P4) — Design Remediation Pass 1"
---

# Tasks: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Input**: Design documents from `specs/002-tenant-isolation-backup-hardening/` (plan.md, research.md, data-model.md, contracts/, quickstart.md — all revised in Design Remediation Pass 1)
**Tests**: Explicitly requested — TDD-ordered throughout.

**Revision note (Design Remediation Pass 1)**: Renumbered sequentially from T001 (the prior version's numbering does not carry over cleanly, since Phases B/D/E/F/G/H each gained tasks). **Phase A's task *content* is completely unchanged** — it survived `/speckit-analyze` intact; only its numbers shifted. Every other phase is revised: B (config) gains cold-miss/file-fallback/reset-block tasks; C gains a fifth guarded route; D narrows to 3 categories and gains a default-duplicate pre-flight and real idempotency exclusion; E/F/G/H are substantially restructured around the offline-staging redesign, the restore lock, digest-based resume, and the backup fingerprint; I/J/K are re-confirmed with raw-driver seeding and the narrowed scope. Task count: 72 (T001-T072), up from 59.

## Format: `[ID] [P?] [Phase] Description`

## Task Dependency Rule (unchanged)

`isolation (A) → config (B) → default-only boundaries (C) → backup (D) → restore validation + lock (E) → offline staging (F) → checkpoint/apply (G) → recovery + runbook (H) → default compatibility (I) → separation/regression (J, K)`

---

## Phase 1: Setup

- [ ] T001 Run the existing full test suite once, unmodified, as a pre-implementation baseline (`npm test`); record the pass count for comparison against T072. No dependencies.

---

## Phase A: Tenant Write Isolation — UNCHANGED CONTENT (survived `/speckit-analyze`)

- [ ] T002 [P] [A] Write failing Mongo-backed tests in `tests/tenant-write-isolation.test.js` (`mongoTestHarness`): default save does not delete a Tenant B user sharing the same `id`; default upsert does not overwrite a Tenant B user sharing the same `id`; default entity save does not overwrite a Tenant B `EntityChunk` sharing the same `key`; a legacy default `User`/`EntityChunk` document with no `tenantId` field (seeded via the raw driver — spec.md FR-027) is updated in place, not duplicated; no duplicate default document is created for an existing legacy identity. Depends on: T001.
- [ ] T003 [A] `persistUsers()` (`lib/database.js:424`): filter → `{..._defaultTenantFilter, id:{$nin:ids}}` / `_defaultTenantFilter`; upsert match filter → `{..._defaultTenantFilter, id:u.id}`. `$set` unchanged in this task. Depends on: T002.
- [ ] T004 [A] `persistEntityKey()` (`lib/database.js:445`): filter → `{..._defaultTenantFilter, key}`. Depends on: T002.
- [ ] T005 [A] Normalize-forward: add `tenantId:'default'` to both functions' `$set`. Depends on: T003, T004.
- [ ] T006 [A] Run `tests/tenant-write-isolation.test.js`; confirm all pass. **Checkpoint.** Depends on: T005.

---

## Phase B: Config Isolation — REDESIGNED (research.md Decision 2, 3)

- [ ] T007 [P] [B] Write failing tests in `tests/tenant-config-isolation.test.js`: (1) Tenant A `saveConfig()` never visible to Tenant B `loadConfig()`; (2) fee/card/KNET-shaped settings stay isolated; (3) SMTP/branding stay isolated; (4) a legacy no-`tenantId`-field `AppConfig` document (raw-driver-seeded, FR-027) normalizes in place, never duplicates; (5) **cold-miss fail-closed (NEW)**: calling `loadConfig()` for a non-default tenant whose config was never warmed throws, never returns `_defaultConfig` or another tenant's value; (6) **file-fallback persistence (NEW)**: under `DB_FILE_ONLY=true`, `saveConfig()` for a tenant survives a cache-clear + re-warm, with zero Mongo connection attempted (assert via a connection spy). Depends on: T006.
- [ ] T008 [B] Add `_tenantConfigCaches = new Map()` and `_tenantConfigDirty = new Set()` (`lib/database.js`, alongside `_tenantCaches`/`_tenantDirty` at `:17-22`), **and in the same task** add `_tenantConfigCaches.clear(); _tenantConfigDirty.clear();` to the existing P0.11 cross-backend reset block (`:945-951`) — closing the exact gap analysis found in the original pass (the two concerns are declared together this time, not split across tasks, specifically so the reset-block registration cannot be forgotten again). File: `lib/database.js`. Depends on: T007.
- [ ] T009 [B] Add `_tenantConfigFilePath(tid)` (`lib/database.js`, mirrors `_tenantFilePath(tid)`'s sanitization, sibling path `data/tenants/<tid>.config.json`). File: `lib/database.js`. Depends on: T008.
- [ ] T010 [B] Implement `async function warmTenantConfigCache(tenantId)`: no-op for `default` or already-cached; Mongo mode reads `AppConfig.findOne({tenantId,key:'config'}).lean()`; file mode reads `_tenantConfigFilePath(tid)` via `fs.readJsonSync` if present, else defaults; merges over `_defaultConfig`; caches. File: `lib/database.js`. Depends on: T009.
- [ ] T011 [B] Wire `await warmTenantConfigCache(tenantId);` into `lib/tenantMiddleware.js:94`, alongside the existing `await warmTenantCache(tenantId);`, both before `next()`. File: `lib/tenantMiddleware.js`. Depends on: T010.
- [ ] T012 [B] Implement `loadConfig()`'s per-tenant branch (`lib/database.js:801`): `default` unchanged; non-default returns `_tenantConfigCaches.get(tid)` if present, else **throws** (`Tenant config not warmed for "<tid>"`). Function signature and every existing call site unchanged (spec.md FR-022). File: `lib/database.js`. Depends on: T011.
- [ ] T013 [B] Implement `saveConfig(cfg)`'s per-tenant branch (`lib/database.js:807`): `default` unchanged; non-default sets `_tenantConfigCaches`, and either marks `_tenantConfigDirty` + calls the existing `_scheduleTenantPersist(tid)` (Mongo mode) or schedules a write to `_tenantConfigFilePath(tid)` via the existing atomic-write helper, reusing the existing per-tenant file-persist debounce rather than a new timer (file mode). File: `lib/database.js`. Depends on: T012.
- [ ] T014 [B] Extend `_flushTenantToMongo(tenantId)` (`:38`) with one added branch: if `_tenantConfigDirty.has(tenantId)`, `AppConfig.updateOne({tenantId,key:'config'},{$set:{tenantId,data:_tenantConfigCaches.get(tenantId),updatedAt:new Date()}},{upsert:true})`, then clear the flag — same timer T013 already schedules. File: `lib/database.js`. Depends on: T013.
- [ ] T015 [B] Run `tests/tenant-config-isolation.test.js`; confirm all 6 cases pass. **Checkpoint.** Depends on: T014.

---

## Phase C: Telegram / Monitor Default-Only Boundaries — FIVE routes (research.md Decision 3)

- [ ] T016 [P] [C] Write failing `supertest` tests in `tests/telegram-scheduler-boundary.test.js` for all FIVE routes (`POST /api/telegram/start` :2678, `POST /api/monitor/inventory` :9822, `POST /api/monitor/monthly-report` :9826, `POST /api/reports/send-telegram` :15987, **`GET /api/monitor/status` :9830 — NEW**): default-tenant unchanged behavior; non-default gets `403`+`TELEGRAM_DEFAULT_TENANT_ONLY`; no side effect before rejection (for the status route: response body discloses no `botActive`/`chatIdSet`). 5×3 = 15 cases. Depends on: T015.
- [ ] T017 [P] [C] Guard `POST /api/telegram/start`. Depends on: T016.
- [ ] T018 [P] [C] Guard `POST /api/monitor/inventory`. Depends on: T016.
- [ ] T019 [P] [C] Guard `POST /api/monitor/monthly-report`. Depends on: T016.
- [ ] T020 [P] [C] Guard `POST /api/reports/send-telegram`. Depends on: T016.
- [ ] T021 [P] [C] **NEW**: Guard `GET /api/monitor/status` — insert the identical check before `botActive`/`chatIdSet` are read into the response. Depends on: T016.
- [ ] T022 [C] Re-run the full-file grep for `bot`/`global._tgBot`/`TelegramBot`/route paths containing `telegram`/`monitor` (already performed once during Design Remediation Pass 1, research.md Decision 3) immediately before considering this phase done, to catch any route added since. Depends on: T021.
- [ ] T023 [C] Run `tests/telegram-scheduler-boundary.test.js`; confirm all 15 cases pass. **Checkpoint.** Depends on: T017, T018, T019, T020, T021, T022.

---

## Phase D: Tenant-Scoped Backup — narrowed scope + real idempotency exclusion + duplicate pre-flight (research.md Decisions 8, 9, 10, 15)

- [ ] T024 [P] [D] Write failing tests in `tests/tenant-backup.test.js`: (1) cross-tenant leakage; (2) legacy inclusion (raw-driver-seeded); (3) missing `--tenant=` fails, writes nothing; (4) a tenant with no `Tenant`/`Subscription` row still backs up successfully (trivially true now — these are never queried); (5) **idempotency exclusion (NEW)**: a real `IdempotencyRecord` doc and an `EntityChunk` keyed `idempotencyRecords` for the target tenant appear in NEITHER the output's `collections.entityChunks` NOR anywhere else; (6) **default-duplicate pre-flight (NEW)**: a genuine duplicate `default` identity (raw-driver-seeded) causes a hard failure naming the exact identity, zero file written; (7) **no `tenants`/`subscriptions` key (NEW)**: the output file has neither key, for both `default` and a real tenant that does have such rows. Depends on: T023.
- [ ] T025 [D] Export `_tenantFilePath(tid)` (unchanged from original pass) and add + export `_tenantConfigFilePath(tid)` (already added in T009 — this task just adds it to `module.exports`) from `lib/database.js`. Depends on: T024.
- [ ] T026 [D] Add and export `TENANT_BACKUP_ENTITY_KEYS = ENTITY_KEYS.filter(k => k !== 'idempotencyRecords')` from `lib/database.js` — the single authoritative source for every tenant-backup/restore entity-category query. File: `lib/database.js`. Depends on: T024.
- [ ] T027 [D] Create `scripts/tenant-backup.js`: argument parsing — `--tenant=` required, no default, no positional fallback. File: `scripts/tenant-backup.js` (new). Depends on: T024.
- [ ] T028 [D] **NEW**: Implement the default-tenant duplicate pre-flight (research.md Decision 15) as the first substantive step for `--tenant=default` — scan every `_defaultTenantFilter`-matched logical identity (User `id`, EntityChunk/AppConfig `key`) for more than one physical document; hard-fail naming the exact identity + both `_id`s; write no file. File: `scripts/tenant-backup.js`. Depends on: T027.
- [ ] T029 [D] Implement Mongo-mode queries using `TENANT_BACKUP_ENTITY_KEYS` (T026) — **never raw `ENTITY_KEYS`** — for exactly three categories: `users`, `entityChunks` (`key:{$in:TENANT_BACKUP_ENTITY_KEYS}`), `appConfigs`. `IdempotencyRecord`, `Tenant`, `Subscription` are never queried. File: `scripts/tenant-backup.js`. Depends on: T026, T028.
- [ ] T030 [P] [D] Implement file-mode backup + the unified-shape transform (research.md Decision 9): `collections.users=blob.users`; `collections.entityChunks` synthesized from `TENANT_BACKUP_ENTITY_KEYS.map(key=>({tenantId,key,data:blob[key],updatedAt}))`; `collections.appConfigs` from the tenant's config file (T025) if present, else `[]`. File: `scripts/tenant-backup.js`. Depends on: T025, T026.
- [ ] T031 [D] Implement output format: `{scope:'tenant',schemaVersion:1,tenantId,createdAt,source,recordCounts:{users,entityChunks,appConfigs},categoryDigests:{users,entityChunks,appConfigs},collections}` + checksum sidecar (reuses existing `computeChecksum()` unchanged). `categoryDigests` computed via a stable (sorted-key) JSON serialization of each category's array. File: `scripts/tenant-backup.js`. Depends on: T029, T030.
- [ ] T032 [D] Add `"backup:tenant": "node scripts/tenant-backup.js"` to `package.json`. Depends on: T031.
- [ ] T033 [D] Run `tests/tenant-backup.test.js`; confirm all 7 cases pass. **Checkpoint** — backup is complete and independently testable before restore work begins. Depends on: T032.

---

## Phase E: Restore Lock + Validation Gate (research.md Decisions 7, 8, 11, 13; must run before staging)

- [ ] T034 [P] [E] Write failing tests, **extending** `tests/production-hardening.test.js`, for `validateTenantBackupObject()`: structural rejection; `scope!=='tenant'` rejection; unsupported `schemaVersion` rejection; ambiguous/mismatched `tenantId` rejection; **`tenants`/`subscriptions` key present → rejection (NEW)**; **`idempotencyRecords` entity chunk or top-level field present → rejection (NEW)**; `recordCounts`/`categoryDigests` mismatch → rejection (NEW); a fully valid object passes. PLUS one new test for the additive guard on the EXISTING `validateBackupObject()`: `scope:'tenant'` → rejection; an absent `scope` (a real legacy whole-instance file) → unaffected. Depends on: T033.
- [ ] T035 [E] Implement `validateTenantBackupObject(backup, targetTenantId)` in `lib/backupValidation.js` with every check from T034 — additive export only. File: `lib/backupValidation.js`. Depends on: T034.
- [ ] T036 [E] Add the one-line additive guard to the **existing** `validateBackupObject()`: `if (backup.scope === 'tenant') return {ok:false, problems:[...]}` — the deliberate whole-instance-side half of format separation (research.md Decision 7). File: `lib/backupValidation.js`. Depends on: T034.
- [ ] T037 [E] Create `scripts/tenant-restore.js`: argument parsing — `<backup-file>`, `--tenant=`, `--target=` required; `--yes`, `--force-unlock` optional. File: `scripts/tenant-restore.js` (new). Depends on: T035, T036.
- [ ] T038 [E] **NEW — Step 0, runs first, before validation**: implement the restore lock. Acquire via `EntityChunk.create({tenantId:target, key:'__restoreLock__', data:{runId,pid,acquiredAt}})` (Mongo) or an exclusive lock file (file mode); on `E11000`/`EEXIST`, print the existing lock's `runId`/`pid`/age and exit non-zero before reading the backup file at all; `--force-unlock` deletes the existing lock (regardless of age) before acquiring. `'__restoreLock__'` is deliberately outside `TENANT_BACKUP_ENTITY_KEYS` (T026). File: `scripts/tenant-restore.js`. Depends on: T037.
- [ ] T039 [E] Wire Step 1 (T035's validation gate) immediately after lock acquisition: on any failure, print all problems, release the lock, exit non-zero, write no checkpoint, touch no data. File: `scripts/tenant-restore.js`. Depends on: T038.
- [ ] T040 [E] **NEW**: Implement Step 1.8, the backup-fingerprint check (research.md Decision 13): if a non-`completed` checkpoint already exists for `targetTenantId`, compute this invocation's backup file's sha256 and compare against the checkpoint's recorded `backupFingerprint`; mismatch → hard reject naming both files, release lock, exit non-zero. File: `scripts/tenant-restore.js`. Depends on: T039.
- [ ] T041 [E] **NEW**: Implement Step 2, the default-tenant duplicate pre-flight for restore (mirrors T028, against the *live* database this time, target `default` only) — hard-fail, name the identity, release lock, exit non-zero, before staging begins. File: `scripts/tenant-restore.js`. Depends on: T040.
- [ ] T042 [E] Run all Phase E tests (T034 plus an end-to-end subprocess test asserting each rejection case exits non-zero and writes nothing). **Checkpoint** — no staging or apply code exists yet. Depends on: T041.

---

## Phase F: Offline/Logical Restore Staging — NO live-Mongo writes (research.md Decision 6; replaces the rejected `__restage__` design entirely)

- [ ] T043 [P] [F] Write failing tests in `tests/tenant-restore.test.js`: (1) **no live document under any placeholder/synthetic identity, or under the real target tenantId, is ever created/modified during staging (NEW, mandatory-style assertion — verified via a live query taken immediately after staging completes)**; (2) sanitization strips `_id`/`__v` from every record; (3) recomputed count+digest per category matches the backup file's own `recordCounts`/`categoryDigests`; (4) ownership validation catches an internally-inconsistent record; (5) the local staging file (`backups/.restore-staging/<runId>.json`) is written with the sanitized content. Depends on: T042.
- [ ] T044 [F] Implement sanitization: strip `_id`/`__v` from every record in every category, in memory. File: `scripts/tenant-restore.js`. Depends on: T043.
- [ ] T045 [F] Implement per-category count+digest recomputation and comparison against the backup's own values (a second, independent check beyond T034's file-level one). File: `scripts/tenant-restore.js`. Depends on: T044.
- [ ] T046 [F] Implement ownership validation: each sanitized record's `tenantId` (or, for `default`, `_defaultTenantFilter`-consistent shape) matches `targetTenantId`. File: `scripts/tenant-restore.js`. Depends on: T045.
- [ ] T047 [F] Write the staged, sanitized representation to `backups/.restore-staging/<runId>.json` — **no live-Mongo write of any kind in this entire phase**. File: `scripts/tenant-restore.js`. Depends on: T046.
- [ ] T048 [F] Run `tests/tenant-restore.test.js`'s staging cases (T043); confirm all pass, explicitly re-confirming (test 1) that zero live documents were touched anywhere. **Checkpoint.** Depends on: T047.

---

## Phase G: Checkpoint / Digest-Gated Apply — highest-risk section (research.md Decisions 12, 14)

- [ ] T049 [P] [G] Write failing tests for checkpoint lifecycle: written via the existing, exported `_atomicWriteJsonSync` (never plain `fs.writeFileSync`); `fs.mkdirSync` runs first for a freshly-provisioned target; includes `expected:{users:{count,digest},...}` and `backupFingerprint`; a corrupted/unparseable checkpoint on a later invocation is treated as "no reliable prior record, proceed as fresh" (logged warning, not a crash). Depends on: T048.
- [ ] T050 [G] Implement checkpoint creation (Step 4), written immediately after T047's local staging file is complete, using `_atomicWriteJsonSync` + prior `mkdirSync`, populated with `expected`/`backupFingerprint` from Steps 1/3. File: `scripts/tenant-restore.js`. Depends on: T049.
- [ ] T051 [P] [G] Write failing tests for the digest-gated apply step in isolation: a category whose live count+digest already matches `expected` is **skipped entirely** (no delete, no insert) regardless of the checkpoint's own prior `categoriesApplied`; a non-matching category gets a tenant-scoped delete (`{tenantId:target}` or `_defaultTenantFilter` for `default` — **never** `deleteMany({})`) followed by an insert of the locally-staged sanitized records with the **real** target `tenantId` set directly (no repoint mechanic of any kind — that whole design is gone). Depends on: T050.
- [ ] T052 [G] Implement Step 5 apply, in the fixed order `users → entityChunks → appConfigs`: per-category digest re-check (skip if matching) → tenant-scoped delete + direct insert with real `tenantId` (if not matching) → append to `categoriesApplied` → rewrite checkpoint atomically. File: `scripts/tenant-restore.js`. Depends on: T051.
- [ ] T053 [G] Implement Step 6 finalize: `stage:'completed'` only once all three categories are confirmed in `categoriesApplied`; release the lock; print success explicitly naming the target tenant and stating a tenant-scoped restore path was used (research.md Decision 17). On any error: `stage:'failed'`, record `error`, release the lock (clean failure), exit non-zero, print the recovery-model reminder (T059). File: `scripts/tenant-restore.js`. Depends on: T052.
- [ ] T054 [G] **[MANDATORY] Failure-injection test, real mechanism (not a mock that replaces the code under test)**: using a documented test-only hook the real apply loop checks (or a genuine mid-loop Mongo-connection interruption), force failure after `users` applies but before `entityChunks` begins. Assert: Tenant B untouched (every collection); `acme`'s `entityChunks`/`appConfigs` unchanged from pre-restore; `acme`'s `users` matches the backup; checkpoint `stage:'failed'`, `categoriesApplied:['users']`; non-zero exit; no false success output. File: `tests/tenant-restore.test.js`. Depends on: T053.
- [ ] T055 [G] **[MANDATORY] Digest-based crash-window test**: a real process kill (not a caught exception) between `users`' DB write succeeding and its checkpoint entry being written. Re-run; assert `users` is **not** redundantly re-applied (verified via write-count instrumentation or a marker field), while `entityChunks`/`appConfigs` proceed and the run completes normally — closing the exact crash window `/speckit-analyze` found the original checkpoint design could not honestly detect. File: `tests/tenant-restore.test.js`. Depends on: T054.
- [ ] T056 [G] Run all Phase G tests. **Checkpoint** — no collection-wide destructive operation exists anywhere, and both the mid-apply failure and the checkpoint-vs-reality crash window are provably non-silent and correctly recoverable-from. Depends on: T055.

---

## Phase H: Recovery Behavior, Restore Lock Contention, and the Production Runbook (research.md Decisions 11, 13, 17)

**Stated explicitly, unchanged from the original pass's intent, now backed by a real cross-process mechanism**: P4 supports **resume** (re-running with the identical backup file). P4 does **not** support automated **rollback** of an already-applied category.

- [ ] T057 [P] [H] Write failing tests: (a) **[MANDATORY] two `tenant-restore.js` processes started concurrently against the same tenant** — exactly one acquires the lock and proceeds, the other is rejected before it even opens the backup file; (b) a lock left behind by a killed (not cleanly failed) process blocks a plain re-run, but a re-run with `--force-unlock` succeeds; (c) the lock is released after both a clean success and a clean (caught) failure; (d) **[MANDATORY] a resume attempt with a *different* backup file than the one that partially applied is rejected** before any further write (end-to-end CLI test of T040's fingerprint check). Depends on: T056.
- [ ] T058 [H] Implement lock release in a `finally` covering both success and clean-failure exit paths, plus `--force-unlock` handling (deletes the existing lock regardless of age, logged as an explicit operator action). File: `scripts/tenant-restore.js`. Depends on: T057.
- [ ] T059 [H] Verify/implement resume: after T054's failure-injection scenario, re-run with the identical backup file; confirm it completes successfully, `categoriesApplied` includes all three categories, and no leftover local staging files remain. If T057(d)'s and this task's tests pass with no further code change beyond T058, this is a verification-only checkpoint. File: `scripts/tenant-restore.js` (only if a gap is found). Depends on: T058.
- [ ] T060 [H] Add the recovery-model CLI reminder, printed on any `stage:'failed'` exit: *"Resume: re-run this exact command with the same backup file. Rollback of an already-applied category is not automatic — restore again from an earlier backup if needed. If this process was killed rather than exiting cleanly, the restore lock may still be held — use --force-unlock only if you have confirmed no other restore for this tenant is genuinely still running."* File: `scripts/tenant-restore.js`. Depends on: T059.
- [ ] T061 [H] **NEW**: Update `docs/PRODUCTION_RUNBOOK.md` with a new section: tenant backup/restore commands, the explicit distinction from the whole-instance commands, full-tenant-replace-only semantics, resume-yes/rollback-no, the `default`-duplicate hard-block, and the Telegram/scheduler default-only limitation (research.md Decision 17). File: `docs/PRODUCTION_RUNBOOK.md`. Depends on: T060.
- [ ] T062 [H] Run all Phase H tests. **Checkpoint** — lock contention, stale-lock recovery, fingerprint mismatch, and resume are all provably correct, and the operator-facing documentation matches the tool's actual behavior. Depends on: T061.

---

## Phase I: Default Tenant Restore — real production compatibility case (research.md Decisions 1, 15; spec.md FR-027)

- [ ] T063 [P] [I] Write failing tests, **all fixtures raw-driver-seeded per FR-027 with an explicit absence assertion before exercising behavior**: a legacy `default` `User`/`EntityChunk`/`AppConfig` (no `tenantId` field) is backed up, then restored exactly once, with no duplicate pair remaining and no non-default tenant touched; **plus** the genuine-duplicate-identity case end-to-end (backup-side T028 and restore-side T041 both hard-block on the same seeded conflict). Depends on: T062.
- [ ] T064 [I] Confirm/adjust Step 5's (T052) default-tenant delete step uses `_defaultTenantFilter`, not equality, so it also clears the legacy shape it is replacing. File: `scripts/tenant-restore.js`. Depends on: T063.
- [ ] T065 [I] Run T063's tests. **Checkpoint** — the real, currently-in-production `default` tenant's legacy data shape is provably compatible, and its duplicate-identity failure mode is provably caught, not silently mishandled. Depends on: T064.

---

## Phase J: Whole-Instance Separation — deliberate, not accidental (research.md Decision 7)

- [ ] T066 [P] [J] Write tests: a tenant-scoped backup file fed into the **unmodified** `scripts/restore.js` is rejected via the new, deliberate `scope==='tenant'` guard (T036) in the real, exported `validateBackupObject()` — not a reimplementation; a whole-instance backup file fed into `tenant-restore.js` is rejected at Step 1.2 (T035); omitting `--tenant=`/`--target=` on either script never falls back to the other's behavior. Depends on: T065.
- [ ] T067 [J] Diff-review (no code change): confirm `scripts/backup.js` and `scripts/restore.js` have **zero** line changes from their pre-P4 state, and that `lib/backupValidation.js`'s diff contains exactly the two additive checks from T035/T036 and nothing else. Depends on: T066.
- [ ] T068 [J] Run T066's tests. **Checkpoint.** Depends on: T067.

---

## Phase K: Regression / Safety

- [ ] T069 [P] [K] Run the existing `tests/tenant-isolation.test.js` unmodified; confirm still green. Depends on: T068.
- [ ] T070 [P] [K] Run the full existing Mongo-backed regression suite (every `mongoTestHarness` file, plus every new file from Phases A/B/D/E/F/G/I); confirm all green. Depends on: T068.
- [ ] T071 [P] [K] Run `tests/production-hardening.test.js` (extended in T034/T035/T036); confirm the pre-existing cases and the new ones are all green together. Depends on: T068.
- [ ] T072 [K] Run the full suite (`npm test`) and compare the pass count against T001's baseline. **Final checkpoint**: 0 regressions, every new test from Phases A-J green, 0 accounting-logic change. Depends on: T069, T070, T071.

---

## Dependencies & Execution Order

Unchanged phase-level ordering from the original pass, with the restore lock (research.md Decision 11) folded into the front of Phase E (it must acquire before validation even begins, since validation reads the backup file the lock is meant to serialize access around) and the runbook (Decision 17) folded into the end of Phase H (it documents the same recovery model Phase H implements and tests). Phase G's apply step is structurally incapable of running before Phase F's staging completes and Phase E's lock+validation succeed — `scripts/tenant-restore.js`'s single `run()` sequence is Lock → Validate → Duplicate-pre-flight → Stage → Checkpoint → Apply, in that literal order.

## Task Quality Gate (self-check before `/speckit-analyze` re-verification)

- **No task uses a collection-wide destructive operation**: T052's delete is always `{tenantId:target}` or `_defaultTenantFilter`; T051's own test exists specifically to catch a regression to `deleteMany({})`.
- **Every tenant-owned write has explicit scope**: A (T003-T005), B (T012-T014), G (T052, T064) — unchanged guarantee, now also true of the apply step's direct-real-tenantId insert (no synthetic identity ever exists to lose track of).
- **No live-Mongo synthetic-tenant staging remains anywhere**: T043's own test (case 1) is a direct, mandatory-style assertion of this; the restore lock (T038) is the *only* new EntityChunk-shaped document restore ever creates under a non-real identity, and it lives under the *real* target tenant's own collection space, not a fabricated tenant.
- **Failure-injection tests are present and real**: T054 (mid-apply, real mechanism) and T055 (crash-window, real process kill) — both mandatory, neither satisfiable by a mock that replaces the code under test.
- **Concurrent-restore and fingerprint-mismatch tests are present and mandatory**: T057(a) and T057(d).
- **Default legacy compatibility and duplicate-detection have explicit, raw-driver-seeded tasks**: T002/T007/T024/T063 (legacy), T028/T041/T063 (duplicate hard-block).
- **Recovery semantics are concrete**: Phase H states resume-yes/rollback-no explicitly, backed by T038 (lock)/T040 (fingerprint)/T052 (digest re-check) — not vague.
- **No hidden Mongo-transaction dependency**: none of Phases F/G/H use `startSession`/`withTransaction`.
- **No task silently expands Telegram/scheduler to full multi-tenant**: T017-T021 add rejections (now five), not a new capability.
- **`Tenant`/`Subscription` exclusion is consistent everywhere a task touches backup/restore scope**: T029/T030 (backup, 3 categories only), T035 (restore validation rejects a `tenants`/`subscriptions` key), no task anywhere stages, applies, or counts either.

## Ready for `/speckit-analyze`?

**YES.**
