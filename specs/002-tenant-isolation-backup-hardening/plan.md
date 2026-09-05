# Implementation Plan: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Branch**: `002-tenant-isolation-backup-hardening` | **Date**: 2026-09-05 (Design Remediation Pass 1) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-tenant-isolation-backup-hardening/spec.md`, revised after an adversarial `/speckit-analyze` pass found 8 CRITICAL, 6 HIGH, 3 MEDIUM defects in the original version of this plan.

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Two classes of defect drove this revision. **First**, the original config-isolation design (Phase B) required a Mongo round-trip inside `loadConfig()`, a function that is — and per explicit product-owner direction must remain — synchronous with ~18 unguarded synchronous callers in `server.js`; it also never defined a file-fallback path at all. The fix mirrors the codebase's own proven pattern exactly: an async `warmTenantConfigCache()` (parallel to the existing `warmTenantCache()`) resolves a tenant's config before any route synchronously reads it via `tenantMiddleware`; `loadConfig()` itself never changes shape and fails closed (throws) only on a genuine bug — a cache that was never warmed. **Second**, the original restore design staged an entire tenant's data as a synthetic/fake tenant directly inside the live Mongo collections before swapping it into place — this collided with `Tenant.slug`'s global-uniqueness index on the ordinary case of restoring an already-registered tenant, collided with Mongo `_id`s on the ordinary case of restoring a tenant whose data changed since backup, and created a real, reachable authentication identity for the whole staging window. The fix removes live-Mongo staging entirely: a backup is validated, sanitized, counted, and digested **offline** (in memory / to a local file) before the only step that ever touches the real target tenant's collections. This is paired with three further hardenings analysis found necessary once staging left the database: a cross-process restore lock (reusing `EntityChunk`'s existing unique index, not a new model), a resume mechanism that re-derives truth from the target tenant's *actual* current state (a count+digest check) rather than trusting the checkpoint file alone, and a backup-fingerprint check so a resumed run can never silently apply the wrong backup. A third, smaller but load-bearing change removes `Tenant`/`Subscription` registry rows from tenant-scoped backup/restore scope entirely — they are billing/operational metadata this feature's own non-goals already exclude, and removing them eliminates the `slug`-uniqueness hazard at its root rather than managing it. Phase A (`persistUsers()`/`persistEntityKey()`) is **unchanged** — it survived analysis intact.

## Technical Context

**Language/Version**: Node.js (CommonJS) / Express — existing stack, unchanged.

**Primary Dependencies**: Mongoose, Node's built-in `async_hooks`/`crypto`/`fs`. Zero new npm dependencies — the restore lock reuses `EntityChunk`'s existing schema rather than adding a locking library.

**Storage**: MongoDB (primary, existing models) with JSON-file fallback. **Revised**: tenant configuration now also persists via a new per-tenant file (`data/tenants/<tid>.config.json`), a sibling to the existing per-tenant data file, not a new storage backend. No schema or index change to any model — the restore lock deliberately reuses `EntityChunk`'s existing compound unique index.

**Testing**: Jest + `mongodb-memory-server` via `tests/helpers/mongoTestHarness.js` for every Mongo-write-path, lock, digest-resume, and staging test. **Revised, binding requirement (spec.md FR-027)**: every test seeding a "legacy, no-`tenantId`-field" fixture MUST use the raw MongoDB driver (`Model.collection.insertOne(...)`), never `Model.create()`/`insertMany()`, and MUST assert the field's genuine absence before exercising the behavior under test — analysis found the original task descriptions would have been silently satisfied by Mongoose's own schema default, testing nothing.

**Target Platform**: Existing deployment target (Render) for the application; `scripts/tenant-backup.js`/`scripts/tenant-restore.js` remain operator-run CLI tools.

**Project Type**: Existing single-repository web application monolith. No UI change.

**Performance Goals**: Unchanged — this phase fixes correctness of existing paths and adds operator-invoked tooling, not request-path performance-sensitive code.

**Constraints**: No Mongo multi-document transactions (unchanged, Constitution Principle VI). No schema/index changes (the lock reuses an existing index). No change to `scripts/backup.js`/`scripts/restore.js` themselves — the one deliberate new guard lives in the shared `lib/backupValidation.js` both already import. No partial-collection tenant restore. No new npm dependency. `Tenant`/`Subscription` registry rows are now an explicit, permanent exclusion from tenant-scoped backup/restore scope (not merely unimplemented).

**Scale/Scope**: Unchanged single-instance scale.

## Constitution Check

*GATE: Re-checked after Design Remediation Pass 1. No gate regressed; two gates (V, VIII) are more thoroughly satisfied than the original pass.*

| Principle | Status | Basis |
|---|---|---|
| I. Accounting Integrity Is Non-Negotiable | **PASS** | Unchanged reasoning; strengthened by the idempotency-exclusion now being enforced by an explicit validation rejection (Decision 8), not just the backup tool's own intended behavior. |
| II. Historical Financial Data Must Be Preserved | **PASS** | Offline staging never rewrites live history before the validated apply step; digest-based resume (Decision 12) specifically prevents redundant destructive rewrites of already-correct data. |
| III. Production Safety | **PASS** | Unchanged — isolated-dev work only, re-confirmed below. |
| IV. Data Preservation and Backups | **PASS** | Strengthened: the restore lock and fingerprint check are new safeguards beyond what the original pass had, both additive to the existing `--target=`+confirmation gate. |
| V. Tenant Isolation and Security | **PASS, more thoroughly** | The live-synthetic-tenant staging hazard (a reachable authentication identity during restore) is eliminated by construction, not mitigated; the fifth guarded route (`/api/monitor/status`) closes a read-only cross-tenant disclosure the original pass missed. |
| VI. Persistence / Concurrency Reality | **PASS, more thoroughly** | The original pass reasoned about single-instance safety for the *app's* existing write paths but never asked the same question for two CLI invocations of the *new* restore tool — the restore lock closes exactly that gap, using an existing index rather than new infrastructure. |
| VII. Canonical Calculations | **PASS** | Unchanged — no accounting math touched. |
| VIII. Testing Before Confidence | **PASS, more thoroughly** | The raw-driver legacy-fixture requirement (spec.md FR-027) closes a test-quality gap that would have let the original pass's own CRITICAL fix regress completely undetected. |
| IX. Demo / Production Isolation | N/A | Unchanged. |
| X. No Uncontrolled Scope Expansion | **PASS** | The `Tenant`/`Subscription` exclusion *narrows* scope relative to the original pass, consistent with this feature's existing non-goals — not scope creep. |
| XI. Auditability | **PASS** | Unchanged. |
| XII. Deployment Control | N/A this phase | Unchanged. |
| XIII. Spec Kit Usage | **PASS** | `/speckit-analyze` → Design Remediation Pass 1 (this) → `/speckit-analyze` re-verification next, per the user's own gate. |

No gate failures. Complexity Tracking below now has three entries (two carried over, one new), all justified.

## Project Structure

### Documentation (this feature)

```text
specs/002-tenant-isolation-backup-hardening/
├── spec.md               # Remediation Pass 1 — new Clarifications subsection, FR-022..FR-032
├── plan.md               # This file
├── research.md           # Decisions 1,3-5 unchanged; 2,6-9 revised; 10-17 new
├── data-model.md          # Revised formats; Tenant/Subscription removed; Restore Lock/Digest added
├── quickstart.md          # Steps 3,4,6-8 revised; 7,10 new
├── contracts/
│   ├── tenant-write-isolation-contract.md       # Section A unchanged; Section B redesigned
│   ├── telegram-scheduler-boundary-contract.md  # Fifth route added
│   ├── tenant-backup-contract.md                # Scope narrowed; pre-flight added
│   └── tenant-restore-contract.md               # Substantially redesigned (offline staging, lock, digest resume, fingerprint)
└── tasks.md              # Revised — see Task Count in this pass's report
```

### Source Code (repository root)

```text
lib/database.js                    # A (unchanged from original pass): persistUsers()/persistEntityKey()
                                    # normalize-forward fix.
                                    # B (redesigned): NEW warmTenantConfigCache(tenantId) (async);
                                    # loadConfig()/saveConfig() gain a synchronous-only per-tenant
                                    # branch (throw on unwarmed cold miss); NEW _tenantConfigCaches/
                                    # _tenantConfigDirty added to the existing P0.11 reset block
                                    # (:945-951); NEW _tenantConfigFilePath(tid) mirrors
                                    # _tenantFilePath(tid) for file-fallback config persistence.
                                    # NEW exported TENANT_BACKUP_ENTITY_KEYS = ENTITY_KEYS minus
                                    # 'idempotencyRecords'. _tenantFilePath() exported (unchanged
                                    # from original pass).

lib/tenantMiddleware.js            # NEW: `await warmTenantConfigCache(tenantId);` alongside the
                                    # existing `await warmTenantCache(tenantId);` (:94).

server.js                          # C: the SAME guard clause now inserted into FIVE routes
                                    # (POST /api/telegram/start :2678, POST /api/monitor/inventory
                                    # :9822, POST /api/monitor/monthly-report :9826,
                                    # POST /api/reports/send-telegram :15987, and NEW
                                    # GET /api/monitor/status :9830). No other route touched.

lib/backupValidation.js            # D/E: NEW validateTenantBackupObject(backup, targetTenantId)
                                    # (structural/scope/schema/tenant-match/category-shape/
                                    # idempotency-exclusion/count-digest checks). ONE additive guard
                                    # added to the EXISTING validateBackupObject(): reject
                                    # backup.scope==='tenant' — the one deliberate change to the
                                    # whole-instance validation path this remediation makes (research.md
                                    # Decision 7). computeChecksum()/extractTenantIds() unchanged.

scripts/tenant-backup.js           # NEW (D). Default-tenant duplicate pre-flight (research.md
                                    # Decision 15) runs before any file is written. Scope narrowed to
                                    # users/entityChunks/appConfigs (Decision 10). Does not modify
                                    # scripts/backup.js.
scripts/tenant-restore.js          # NEW (E/F/G/H). Restore lock (Step 0, reuses EntityChunk),
                                    # validation gate (Step 1, includes fingerprint check), default
                                    # duplicate pre-flight (Step 2), OFFLINE staging to a local file
                                    # (Step 3 — no live-Mongo synthetic tenant of any kind), atomic
                                    # checkpoint (Step 4), digest-gated apply (Step 5), finalize with
                                    # explicit scope-honest success output (Step 6). Does not modify
                                    # scripts/restore.js.

docs/PRODUCTION_RUNBOOK.md         # NEW section (research.md Decision 17): tenant backup/restore
                                    # commands, explicit distinction from whole-instance commands,
                                    # full-tenant-replace-only semantics, resume-yes/rollback-no,
                                    # default-duplicate blocker, Telegram/scheduler default-only limit.

package.json                       # Additive: "backup:tenant", "restore:tenant". Unchanged existing
                                    # "backup"/"restore" scripts.

tests/
├── tenant-write-isolation.test.js       # Unchanged scope from original pass (Phase A).
├── tenant-config-isolation.test.js      # REVISED: adds cold-miss-throws and file-fallback cases;
│                                          all legacy-record cases now raw-driver-seeded (FR-027).
├── telegram-scheduler-boundary.test.js  # REVISED: 5 routes, not 4.
├── tenant-backup.test.js                # REVISED: 3-category scope, idempotency-exclusion case,
│                                          default-duplicate-pre-flight case, no tenants/subscriptions
│                                          key assertion.
├── tenant-restore.test.js               # SUBSTANTIALLY REVISED: offline-staging-touches-nothing-live
│                                          case, concurrent-restore-lock case, digest-based-resume
│                                          case (crash between DB write and checkpoint write —
│                                          a real kill, not a caught exception), backup-fingerprint-
│                                          mismatch case, default-duplicate-pre-flight case, plus the
│                                          mandatory mid-apply failure-injection case (unchanged intent).
├── tenant-default-legacy-restore.test.js # Unchanged scope from original pass, now raw-driver-seeded.
└── production-hardening.test.js         # EXTENDED: validateTenantBackupObject() unit cases,
                                           including the new category-shape/idempotency-exclusion/
                                           digest-integrity checks, and the new one-line
                                           scope==='tenant' guard added to validateBackupObject().
```

**Structure Decision**: Unchanged from the original pass in shape (two new CLI scripts, in-place edits to `lib/database.js`/`server.js`/`lib/backupValidation.js`, no new top-level directories) — the *content* of those edits is what changed. One new file appears that the original pass did not touch at all: `docs/PRODUCTION_RUNBOOK.md`, an existing operational document this remediation adds a section to rather than a new artifact.

## Complexity Tracking

| Item | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Offline/local staging file + a checkpoint file, rather than a single delete-then-insert per tenant | Unchanged from original pass: no Mongo transactions available; a crash mid-restore must leave a recoverable, boundable state. | A plain delete-then-insert reintroduces "silently half-successful, no recovery information" (spec.md FR-013). |
| Two new process-local Maps (`_tenantConfigCaches`/`_tenantConfigDirty`) rather than folding config into the existing `_tenantCaches`/`db` object | Unchanged from original pass: config lives in a different collection with a structurally different write, and folding it in would change `loadDB()`'s return shape for ~150 existing call sites. | Reusing `_tenantCaches` directly was rejected: blast radius far exceeds this phase's goal. |
| **NEW**: A cross-process restore lock, reusing `EntityChunk`'s existing unique index rather than a new dedicated lock model or a third-party locking library | Analysis found the original design reasoned about single-instance safety for the app's *existing* write paths but never re-asked the same question for two independent CLI invocations of the *new* restore tool pointed at the same database — a real, demonstrable corruption path with no mitigation. | A new dedicated `RestoreLock` model was rejected as an unnecessary new schema/index surface for a concern an existing compound unique index already solves atomically; a third-party distributed-lock library was rejected outright as new infrastructure this feature's own constraints explicitly forbid absent a proven need the existing primitive doesn't already meet. |

## Plan Consistency Review (re-run for Design Remediation Pass 1)

- **No tenant-owned write remains unscoped**: unchanged from the original pass's write-isolation fix (A), now also true of the offline-staged, digest-gated apply step (Decision 12) — a category is either already-verified-matching (untouched) or tenant-scoped delete+insert, never a bare `deleteMany({})`.
- **`default` tenant compatibility is handled explicitly**: unchanged `_defaultTenantFilter` reuse throughout, now paired with a mandatory pre-flight (Decision 15) that hard-blocks on a pre-existing duplicate rather than silently double-counting or silently collapsing it.
- **No live-Mongo synthetic-tenant staging of any kind remains** (new gate this pass): confirmed structurally — Step 3 of the restore contract writes only to a local file; the only Mongo write in the entire restore flow that touches an identity other than the real target tenant is the restore-lock document itself, which is scoped to the *real* target tenant's own `EntityChunk` collection under a reserved key, never a fabricated tenant identity.
- **Tenant restore cannot fall into whole-instance restore, and vice versa, deliberately** (strengthened this pass): the guard is now an explicit, additive check in the shared validation library, not an accidental byproduct of an unrelated field (Decision 7).
- **No plan step depends on Mongo transactions**: confirmed again this pass; the restore lock and digest-resume mechanisms are both transaction-free by design.
- **Rollback/recovery semantics are concrete, not vague**: strengthened this pass — resume now re-derives truth from actual database state (Decision 12), not a potentially-stale checkpoint file alone, closing the specific crash window analysis identified.
- **Backup and restore formats cannot be cross-fed accidentally**: strengthened this pass with the deliberate `scope`-based guard added to both validators (Decision 7).
- **Tenant/Subscription policy is stated once, consistently, everywhere** (new check this pass): spec.md's Out of Scope, research.md Decision 10, data-model.md, and both backup/restore contracts all state the identical policy — excluded entirely, not merely deferred — with no document still claiming a "full tenant backup."

## Ready for `/speckit-tasks`?

**YES** — tasks.md is revised alongside this plan in the same remediation pass (see the P4 REMEDIATION RESULT report for the task count and re-analysis status).
