# Implementation Plan: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Branch**: `002-tenant-isolation-backup-hardening` | **Date**: 2026-09-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-tenant-isolation-backup-hardening/spec.md` (Clarified), the prior-turn P4 read-only architecture audit, and this plan's own direct re-verification of every cited source file.

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Three CRITICAL/HIGH findings from the architecture audit share one root cause: default-tenant write/read paths in `lib/database.js` were written before multi-tenancy existed and were never re-scoped when `_tenantCaches`/`AsyncLocalStorage`-based tenant context was added — they use bare, unscoped Mongo filters (`persistUsers()`, `persistEntityKey()`) or no tenant keying at all (`_configCache`). This plan's core fix (A, B) is **not** a redesign: it makes the default-tenant path use the exact same tenant-scoping discipline the non-default path (`_persistUsersTenant()`, `_persistEntityKeyTenant()`, `_tenantCaches`) already demonstrates correctly — with one necessary refinement, reusing the already-existing `_defaultTenantFilter` on the write side (not just its current read-only use) so `default`'s real legacy no-`tenantId`-field records are normalized forward instead of duplicated or orphaned. The Telegram/scheduler boundary (C) is fixed by gating the one entry point that can inject a non-`default` identity into an otherwise-inherently-`default`-scoped process-global bot singleton, plus three sibling routes found by direct grep. Tenant-scoped backup/restore (D-H) is entirely new, additive tooling (`scripts/tenant-backup.js`, `scripts/tenant-restore.js`) that never modifies the existing, production-relied-on whole-instance `scripts/backup.js`/`scripts/restore.js` — restore uses a staged synthetic-tenantId write, per-collection swap, and a file-based checkpoint to give deterministic, boundable recovery semantics without assuming Mongo transactions, which this codebase's own constitution (Principle VI) already documents as unavailable.

## Technical Context

**Language/Version**: Node.js (CommonJS) / Express — existing stack, unchanged.

**Primary Dependencies**: Mongoose (existing), Node's built-in `async_hooks`/`crypto`/`fs` (existing, already used by `lib/database.js`/`lib/backupValidation.js`). Zero new npm dependencies.

**Storage**: MongoDB (primary, existing models `User`/`EntityChunk`/`AppConfig`/`Tenant`/`Subscription`) with JSON-file fallback (existing `lib/database.js` file-mode + existing per-tenant file convention `data/tenants/<tid>.json`). No schema or index change to any model (data-model.md).

**Testing**: Jest + `mongodb-memory-server` via the existing `tests/helpers/mongoTestHarness.js` (required for the Mongo-write-path tests in A/D/E — these are exactly the tests the existing `tests/tenant-isolation.test.js` suite does NOT cover today, per the audit's own finding that it only exercises the in-memory cache layer). `DB_FILE_ONLY=true` per-file bootstrap for the config-isolation (B) and file-mode backup/restore tests, matching the lighter-weight existing convention used by `tests/p0-7-ap-lifecycle.test.js` and others.

**Target Platform**: Existing deployment target (Render) for the application; `scripts/tenant-backup.js`/`scripts/tenant-restore.js` are operator-run CLI tools, same execution model as the existing `scripts/backup.js`/`scripts/restore.js` (run against `MONGO_URI` from an operator's own machine, not scheduled in-process).

**Project Type**: Existing single-repository web application monolith — not a frontend/backend-split project. No UI change of any kind in this phase (spec.md's product/architecture outcomes are entirely backend/data-layer).

**Performance Goals**: No new performance target — this phase fixes correctness of existing, already-in-production write paths and adds operator-invoked (not request-path) backup/restore tooling. `_tenantConfigCaches`/`_tenantConfigDirty` add O(1) map operations per config read/write, matching the existing `_tenantCaches` overhead already accepted for entity/user data.

**Constraints**: No Mongo multi-document transactions (Constitution Principle VI, research.md Decision 4). No schema/index changes (data-model.md). No change to `scripts/backup.js`/`scripts/restore.js` (H). No partial-collection tenant restore (spec.md FR-020). No new npm dependency. No change to journal-posting logic, RBAC system, onboarding, subscriptions/billing, or the full multi-tenant Telegram/scheduler architecture (spec.md Out of Scope, Constitution Principle X).

**Scale/Scope**: Same single-instance, debounced-write, in-process-cache scale this codebase already operates at (Constitution Principle VI) — this phase does not introduce or assume horizontal scaling.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (this section reflects the post-design re-check — no gate regressed between the two passes).*

| Principle | Status | Basis |
|---|---|---|
| I. Accounting Integrity Is Non-Negotiable | **PASS** | Zero changes to `appendJournalEntry()`/`validateJournalEntry()`/`lib/journalGuard.js` or any journal-posting route. The restore path never invents, discards, or auto-repairs a record — it either replaces a tenant's full data set with the validated backup's exact contents or rejects before writing anything (contracts/tenant-restore-contract.md). Idempotency records are explicitly excluded from restore (research.md Decision 8) specifically to avoid the accounting-integrity risk of a stale duplicate-posting claim being silently reintroduced. |
| II. Historical Financial Data Must Be Preserved | **PASS** | The default-tenant write-path fix (A) is a pure filter-scoping change with no new normalization or reclassification beyond what `normalizeCanonicalKeys()` already does; legacy no-`tenantId`-field records are matched and updated in place (via `_defaultTenantFilter`), never deleted-and-recreated with new identity. Tenant-scoped restore replaces a tenant's own data with its own prior backup — not a migration or reclassification of history. |
| III. Production Safety | **PASS** | This entire phase is isolated-dev work; no production/demo Mongo access at any point (verified below). `scripts/tenant-backup.js`/`scripts/tenant-restore.js` are operator-run CLI tools requiring explicit `--tenant=`/`--target=` arguments, matching the existing production-safety posture of `scripts/restore.js`. |
| IV. Data Preservation and Backups | **PASS** | Tenant-scoped restore reuses and extends (never weakens) the existing `--target=`+typed-confirmation gate; adds a stronger set of pre-write validation checks (contracts/tenant-restore-contract.md) than the whole-instance path has today, not a weaker one. |
| V. Tenant Isolation and Security | **PASS (this phase's core purpose)** | Directly closes the two CRITICAL cross-tenant Mongo-write bugs and the HIGH process-global-config leak found by the Phase 1 audit; the Telegram/scheduler fix is an explicit, fail-closed (not silent-fallback) boundary. No RBAC/permission model change — the four guarded routes keep their existing `requirePermission`/`requireAdminAction` checks unchanged and gain one additional check. |
| VI. Persistence / Concurrency Reality | **PASS** | Explicitly designed around the existing single-instance, no-transaction reality (research.md Decision 4/6) rather than assuming it away. The new `_tenantConfigCaches`/`_tenantConfigDirty` state is process-local and rebuildable from Mongo, exactly like the existing `_tenantCaches`. |
| VII. Canonical Calculations | **PASS** | No new parallel calculation path of any kind — this phase touches persistence/backup/restore/config plumbing, not accounting math. |
| VIII. Testing Before Confidence | **PASS** | Every contract document (A/B/C/D/E) defines its own test list; `mongodb-memory-server` via the existing `tests/helpers/mongoTestHarness.js` is used for every Mongo-write-path test, matching Principle VIII's required harness exactly. |
| IX. Demo / Production Isolation | N/A | No demo-specific behavior touched. |
| X. No Uncontrolled Scope Expansion | **PASS** | Scoped strictly to the 7 audit findings (3 CRITICAL + 4 HIGH) the user designated as mandatory P4 scope; the residual duplicate-record risk (research.md Decision 1) and the automatic-scheduler already-safe finding (Decision 3) are documented, not folded into this phase's implementation. |
| XI. Auditability | **PASS** | The four newly-guarded Telegram/scheduler routes keep their existing audit behavior unchanged; the new `403 TELEGRAM_DEFAULT_TENANT_ONLY` response is a rejection, not a privileged action, so no new `appendAuditEvent()` call is required by this phase's own scope. |
| XII. Deployment Control | N/A this phase | Planning only; no deployment step occurs or is implied. |
| XIII. Spec Kit Usage | **PASS** | Following the sequence exactly: `/speckit-specify` → `/speckit-clarify` → `/speckit-plan` (this) → `/speckit-tasks` next, gated on 0 CRITICAL/HIGH/MEDIUM at `/speckit-analyze` before `/speckit-implement` per the user's own stated gate. |

No gate failures. **Complexity Tracking is not empty** — see below; both entries are justified, not violations requiring a design change.

## Project Structure

### Documentation (this feature)

```text
specs/002-tenant-isolation-backup-hardening/
├── spec.md               # Clarified (prior turn)
├── plan.md               # This file (/speckit-plan command output)
├── research.md           # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md         # Phase 1 output (/speckit-plan command)
├── contracts/            # Phase 1 output (/speckit-plan command)
│   ├── tenant-write-isolation-contract.md       # A + B
│   ├── telegram-scheduler-boundary-contract.md  # C
│   ├── tenant-backup-contract.md                # D
│   └── tenant-restore-contract.md               # E + F + H
└── tasks.md              # Phase 2 output (/speckit-tasks command — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
lib/database.js                    # MODIFIED: persistUsers() (:424), persistEntityKey() (:445),
                                    # initConfig() (:609), flushToMongo()'s config branch (:488-496)
                                    # gain _defaultTenantFilter + normalize-forward writes (A).
                                    # loadConfig()/saveConfig() (:801-815) gain a per-tenant branch
                                    # using two new module-level Maps, _tenantConfigCaches and
                                    # _tenantConfigDirty, flushed via the existing per-tenant debounce
                                    # timer in _flushTenantToMongo() (B). _tenantFilePath() (:651)
                                    # exported for reuse by the new backup/restore scripts (D).
                                    # No other function in this file changes.

server.js                          # MODIFIED: one identical guard clause inserted into each of
                                    # 4 existing routes — POST /api/telegram/start (:2678),
                                    # POST /api/monitor/inventory (:9822),
                                    # POST /api/monitor/monthly-report (:9826),
                                    # POST /api/reports/send-telegram (:15987) (C). No other route,
                                    # and no line inside setupBot()'s ~50 bot.sendMessage() call
                                    # sites, is touched — the root-cause gate makes them moot
                                    # (research.md Decision 3).

lib/backupValidation.js            # MODIFIED, additive only: new exported
                                    # validateTenantBackupObject(backup, targetTenantId) function.
                                    # Existing validateBackupObject()/validateBackupFile()/
                                    # computeChecksum()/extractTenantIds() unchanged (D/E).

scripts/tenant-backup.js           # NEW (D). Does not import from or modify scripts/backup.js.
scripts/tenant-restore.js          # NEW (E/F). Does not import from or modify scripts/restore.js.
scripts/detect-duplicate-default-records.js
                                    # NEW, OUT OF SCOPE for this phase's own implementation —
                                    # listed here only because research.md Decision 1 recommends it
                                    # as a follow-up; /speckit-tasks decides whether to include it.

package.json                       # MODIFIED, additive only: two new npm scripts,
                                    # "backup:tenant": "node scripts/tenant-backup.js" and
                                    # "restore:tenant": "node scripts/tenant-restore.js". Existing
                                    # "backup"/"restore" scripts unchanged.

tests/
├── tenant-write-isolation.test.js      # NEW — Mongo-backed (mongoTestHarness), covers A's
│                                          test contract (cross-tenant safety + legacy compatibility
│                                          for persistUsers()/persistEntityKey())
├── tenant-config-isolation.test.js     # NEW — covers B's test contract (isolation + default
│                                          legacy compatibility); DB_FILE_ONLY-style lightweight
│                                          harness sufficient for the in-process Map assertions,
│                                          mongoTestHarness for the Mongo-backed default-tenant
│                                          legacy-record case
├── telegram-scheduler-boundary.test.js # NEW — covers C's test contract (4 routes × 2 tenant
│                                          identities), supertest against the existing route
│                                          mounting, no real Telegram credentials needed (bot
│                                          instantiation itself is what's being blocked/observed)
├── tenant-backup.test.js               # NEW — covers D's test contract, mongoTestHarness
├── tenant-restore.test.js              # NEW — covers E/F's test contract including the
│                                          simulated-partial-failure and re-run-idempotency cases,
│                                          mongoTestHarness
├── p0-11-mongo-parity... / tenant-isolation.test.js
│                                        # EXTENDED (not replaced) — the audit's own finding was
│                                          that this existing suite only exercises the in-memory
│                                          cache layer; this phase adds the Mongo-write-path cases
│                                          above as NEW files rather than retrofitting this one,
│                                          so its existing passing assertions are never put at risk
│                                          of an unrelated edit breaking them (Constitution X)
└── production-hardening.test.js        # EXTENDED — add validateTenantBackupObject() unit cases
                                          alongside its existing Backup/Restore B/C validation
                                          coverage (same file already owns this kind of test)
```

**Structure Decision**: No new top-level directories. Two new CLI scripts and five new test files, following this project's own established pattern of adding a new script alongside (never replacing) an existing hardened one when the new capability has a materially different blast radius (exactly how `scripts/verify-backup.js` sits alongside `scripts/backup.js`/`scripts/restore.js` today). `lib/database.js` and `server.js` are modified in place — both are already-monolithic files this project deliberately extends rather than splits (matching the 001 feature's own precedent and Constitution's acceptance of the current monolith as a known, not-being-fixed-here architectural reality).

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Staged synthetic-tenantId restore + file-based checkpoint (F), rather than a single `deleteMany`+`insertMany` per tenant | Constitution Principle VI documents that multi-document transactions are unavailable; a direct delete-then-insert with no staging would mean a crash mid-restore leaves the target tenant with **partially deleted, no-longer-recoverable** data and no record of how far it got — unacceptable for an operation whose entire purpose is data safety. The staged approach ensures the target tenant's real data is never deleted until the replacement data is already validated and sitting safely under a synthetic identity. | A plain delete-then-insert (no staging) was rejected: it is simpler, but reintroduces exactly the "silently half-successful, no recovery information" failure mode spec.md FR-013 explicitly requires this phase to avoid. |
| Two new process-local Maps (`_tenantConfigCaches`, `_tenantConfigDirty`) rather than reusing the existing `_tenantCaches`/`_tenantDirty` Maps directly | Config lives in a different Mongo collection (`AppConfig`) from entity/user data (`EntityChunk`/`User`), flushed by a structurally different write (`AppConfig.updateOne({key:'config'},...)` vs. per-`ENTITY_KEYS`-key writes) — folding it into the existing `db[key]`-shaped cache would require `loadConfig()`'s callers to reach into `loadDB()`'s object instead of the current small, distinct top-level API surface every route already imports (`{loadConfig, saveConfig}` alongside `{loadDB, saveDB}`), a materially larger and riskier refactor than adding one parallel, symmetrically-named pair of Maps. | Reusing `_tenantCaches` directly (storing config under a reserved key inside each tenant's `db` object) was rejected: it would silently change `loadDB()`'s return shape for every one of the ~150 existing call sites that destructure fields off it today, a blast radius far exceeding this phase's config-isolation goal. |

## Plan Consistency Review (required before `/speckit-tasks`)

- **No tenant-owned write remains unscoped**: `persistUsers()`, `persistEntityKey()` (A), `initConfig()`/`flushToMongo()`'s config branch, `saveConfig()` (B) are the complete set the audit identified; re-verified by direct re-read this pass, not assumed from the prior audit summary alone.
- **`default` tenant compatibility is handled explicitly**: every write-path fix reuses `_defaultTenantFilter` (never naive equality) and normalizes `tenantId` forward on write (A, B, D, E); backup/restore for `default` documented to legitimately produce empty `tenants`/`subscriptions` arrays (Decision 5), with no `Tenant`-registry check required for it (contracts/tenant-restore-contract.md).
- **Tenant restore cannot fall into whole-instance restore**: enforced structurally — `scripts/tenant-restore.js` and `scripts/restore.js` are separate files, separate npm scripts, and the tenant-scoped format's `scope:'tenant'` discriminator causes a whole-instance file to fail `tenant-restore.js`'s own validation immediately, and vice versa (a tenant-scoped file has no `collections`/`database` shape a whole-instance restore's existing checks would accept as complete — `lib/backupValidation.js:33-42`).
- **No plan step depends on Mongo transactions**: confirmed by direct grep this pass (research.md Decision 4) in addition to the constitution's own documented statement; the staged-restore design (F) is the direct consequence of this constraint, not an oversight.
- **Rollback/recovery semantics are concrete, not vague**: the checkpoint file's `collectionsSwapped` array is the single, explicit source of truth for exactly what state a failed restore left behind (contracts/tenant-restore-contract.md's "what is/isn't atomic" section) — not a general "consult the logs" instruction.
- **Backup and restore formats cannot be cross-fed accidentally**: `scope`/`schemaVersion` (new format) vs. no-`scope`/`version` (existing format) are structurally distinct fields checked at the very first validation step on both sides (research.md Decision 7).

## Ready for `/speckit-tasks`?

**YES.**
