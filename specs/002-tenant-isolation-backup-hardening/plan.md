# Implementation Plan: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Branch**: `002-tenant-isolation-backup-hardening` | **Date**: 2026-09-05 (Design Remediation Pass 2) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-tenant-isolation-backup-hardening/spec.md`. Revised once after a first adversarial `/speckit-analyze` found 8 CRITICAL/6 HIGH/3 MEDIUM defects (Remediation Pass 1), then revised again after a **second** adversarial `/speckit-analyze` — specifically re-verifying Pass 1's own fixes rather than assuming they worked — found 5 CRITICAL/6 HIGH/2 MEDIUM new or incompletely-closed defects **in Pass 1 itself**.

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Pass 1 correctly identified and rejected the root cause of the original design's worst flaw (live-Mongo synthetic-tenant restore staging) and replaced it with offline/logical staging. But re-verification found Pass 1's own replacement mechanism, built quickly under that rejection, had five further problems that would have made it unsafe or non-functional in its own right: (1) the `entityChunks` category's apply-time delete was scoped only by `tenantId`, not also by `key` — meaning an ordinary restore would delete its own in-flight restore lock and the tenant's live idempotency-claim store, both of which happen to live in the same collection; (2) the checkpoint and staging files were keyed by a random per-invocation `runId` rather than by tenant identity, so a resumed invocation (which generates a *new* `runId`) had no defined way to find the *prior* invocation's checkpoint — silently defeating the backup-fingerprint check Pass 1 added specifically to prevent a mismatched resume; (3) the stale-lock policy was internally contradictory — one part of the design said a crash always requires an explicit `--force-unlock`, another part's mandatory test assumed a plain re-run would just work after a real process kill; (4) `--force-unlock` itself was specified as an unconditional delete-then-create, which is not atomic and could let two simultaneous recovery attempts both believe they hold the lock; (5) the digest-based resume mechanism's canonicalization was specified as "sort object keys" with no requirement to sort *array elements* by a stable identity field first, so two logically-identical record sets returned by MongoDB in different physical orders could hash differently and trigger unnecessary destructive re-applies. Separately, and independently of the restore redesign, Pass 1's rewrite of the config-isolation phase **accidentally dropped a fix that existed correctly before that rewrite**: `default`'s own three pre-existing `AppConfig` call sites (`initConfig()`'s read and two legacy-migration writes, `flushToMongo()`'s write) were never given the `_defaultTenantFilter` scoping `persistUsers()`/`persistEntityKey()` already have, while a document elsewhere claimed they were — a real regression, now restored. This pass fixes all of the above at the design-document level; none of it has been implemented as source code. Phase A (`persistUsers()`/`persistEntityKey()`) remains **unchanged** — it has now survived two rounds of adversarial analysis intact.

## Technical Context

**Language/Version**: Node.js (CommonJS) / Express — existing stack, unchanged.

**Primary Dependencies**: Mongoose, Node's built-in `async_hooks`/`crypto`/`fs`. Zero new npm dependencies.

**Storage**: MongoDB (primary) with JSON-file fallback. Tenant configuration persists via a new per-tenant file (`data/tenants/<tid>.config.json`) with its own debounce-timer map and shutdown-flush wiring (second pass — Pass 1 omitted both, which would have reintroduced this codebase's own already-fixed SIGTERM data-loss bug class for the new mechanism specifically). No schema or index change to any model — the restore lock reuses `EntityChunk`'s existing compound unique index; the checkpoint/staging files and the lock are now consistently keyed by tenant identity, not a random run id (second pass).

**Testing**: Jest + `mongodb-memory-server`. Every legacy-no-`tenantId`-field fixture uses the raw MongoDB driver with an explicit read-back absence assertion (spec.md FR-027, unchanged from Pass 1). **New this pass**: the mandatory crash-window/concurrent-restore/digest-resume tests must exercise the corrected lock policy exactly (a real kill always requires `--force-unlock` on the follow-up run — no test may assume a plain re-run succeeds after a real process kill), and the `entityChunks`-category tests must assert the restore lock and the tenant's own live `idempotencyRecords` document both survive an ordinary restore's delete+insert step untouched.

**Target Platform**: Existing deployment target (Render); the two new scripts remain operator-run CLI tools.

**Project Type**: Existing single-repository web application monolith. No UI change.

**Performance Goals**: Unchanged.

**Constraints**: No Mongo multi-document transactions. No schema/index changes. No change to `scripts/backup.js`/`scripts/restore.js` themselves — one deliberate additive guard lives in the shared `lib/backupValidation.js` both import. No partial-collection tenant restore. No new npm dependency. `Tenant`/`Subscription` registry rows remain a permanent exclusion from tenant-scoped backup/restore scope. **New this pass**: no automatic lock expiry or liveness detection of any kind (a real crash always requires an explicit, human `--force-unlock` — this is a deliberate simplicity/safety choice, not an oversight, since a `pid`-liveness check is unreliable across independent hosts and FR-029 requires the lock to hold across independent processes generally).

**Scale/Scope**: Unchanged single-instance scale.

## Constitution Check

*GATE: Re-checked after Design Remediation Pass 2. No gate regressed from Pass 1; Principle V and VI's bases are corrected to reflect what the design now actually specifies, not what Pass 1 merely claimed.*

| Principle | Status | Basis |
|---|---|---|
| I. Accounting Integrity Is Non-Negotiable | **PASS** | Unchanged reasoning; the `entityChunks` delete-scoping fix (second pass) additionally protects the tenant's own live idempotency-claim store from being incidentally destroyed by an ordinary restore — a real accounting-integrity-adjacent risk Pass 1 introduced and this pass closes. |
| II. Historical Financial Data Must Be Preserved | **PASS** | Unchanged — offline staging still never rewrites live history before the validated, digest-gated apply step. |
| III. Production Safety | **PASS** | Unchanged — isolated-dev work only, re-confirmed below. |
| IV. Data Preservation and Backups | **PASS** | Strengthened further: the force-unlock atomicity fix and the tenant-keyed checkpoint lookup (second pass) close two more ways the restore tooling itself could have behaved unsafely under contention or on resume. |
| V. Tenant Isolation and Security | **PASS, corrected basis** | Pass 1 claimed the live-synthetic-identity hazard was "eliminated by construction" — true for staging, but the apply-time `entityChunks` delete (unscoped by key) reopened an adjacent hazard (destroying the in-flight lock, reopening the exact concurrent-restore race the lock exists to prevent) that Pass 1's own re-verification, not this document alone, is what actually caught. Now genuinely closed. |
| VI. Persistence / Concurrency Reality | **PASS, corrected basis** | Pass 1 claimed its lock closed the cross-process safety gap; re-verification found the lock's own recovery path (`--force-unlock`) was itself non-atomic and the checkpoint it coordinates with was unfindable on resume. Both are fixed this pass; the underlying reasoning (no transactions, must design around it) is unchanged and correct. |
| VII. Canonical Calculations | **PASS** | Unchanged. |
| VIII. Testing Before Confidence | **PASS** | Unchanged from Pass 1's FR-027 requirement; this pass adds explicit test coverage for the newly-corrected lock policy and delete scoping so these specific regressions cannot recur silently. |
| IX. Demo / Production Isolation | N/A | Unchanged. |
| X. No Uncontrolled Scope Expansion | **PASS** | All second-pass fixes are corrections to already-in-scope mechanisms (the lock, the checkpoint, the config scoping, the digest) — no new capability is added. |
| XI. Auditability | **PASS** | Unchanged. |
| XII. Deployment Control | N/A this phase | Unchanged. |
| XIII. Spec Kit Usage | **PASS** | `/speckit-analyze` → Remediation Pass 1 → `/speckit-analyze` re-verification → Remediation Pass 2 (this) → a third `/speckit-analyze` re-verification next, per the user's own gate — the process is working exactly as intended: re-verification is catching what a single remediation pass missed. |

No gate failures.

## Project Structure

### Documentation (this feature)

```text
specs/002-tenant-isolation-backup-hardening/
├── spec.md               # Unchanged structurally from Pass 1 (FR-022..FR-032 stand); no new FRs
│                            were needed for Pass 2's fixes — they correct HOW the Pass-1 FRs are
│                            met, not WHAT is required.
├── plan.md               # This file
├── research.md           # Decisions 2, 6, 7, 8, 9, 11, 12, 13, 14 revised again this pass;
│                            new Decision 15 (tenant-keyed checkpoint/staging) inserted; former
│                            Decisions 15/16/17 renumbered to 16/17/18.
├── data-model.md          # AppConfig/checkpoint/lock/state-transition sections corrected;
│                            new _tenantConfigFileTimers state added.
├── quickstart.md          # Steps 6-8 corrected (force-unlock, tenant-keyed paths, key-scoping
│                            check); new "Recovery model" summary added.
├── contracts/
│   ├── tenant-write-isolation-contract.md       # Section B: default-tenant AppConfig scoping
│   │                                               restored, flush-guard fixed, file-mode timer/
│   │                                               shutdown wiring added.
│   ├── telegram-scheduler-boundary-contract.md  # Stale "four" heading corrected to "five".
│   ├── tenant-backup-contract.md                # entityChunks file-mode transform corrected to
│   │                                               skip absent keys; canonicalJson specified;
│   │                                               __restoreLock__ exclusion added.
│   └── tenant-restore-contract.md               # entityChunks delete/digest scoped by key; lock
│                                                    policy made consistent; force-unlock made
│                                                    atomic; checkpoint/staging paths tenant-keyed;
│                                                    fingerprint check confirmed last-in-gate.
└── tasks.md              # Revised — see Task Count in this pass's report.
```

### Source Code (repository root)

```text
lib/database.js                    # A: unchanged (persistUsers()/persistEntityKey(), survived both
                                    # analyze rounds).
                                    # B: warmTenantConfigCache(tenantId) (async); loadConfig()/
                                    # saveConfig() synchronous-only per-tenant branch; _tenantConfigCaches/
                                    # _tenantConfigDirty/_tenantConfigFileTimers (NEW this pass) all
                                    # added to the P0.11 reset block; _flushTenantToMongo()'s early-
                                    # return guard corrected (NEW this pass) to account for a config-
                                    # only dirty tenant; _flushAllTenantsOnShutdown() extended (NEW
                                    # this pass) to flush pending tenant config-file writes;
                                    # default-tenant's initConfig()/flushToMongo() AppConfig calls
                                    # scoped by _defaultTenantFilter (RESTORED this pass — Pass 1
                                    # dropped this without documenting the drop). NEW exported
                                    # TENANT_BACKUP_ENTITY_KEYS and canonicalJson() (the latter now
                                    # precisely specified, not just named).

lib/tenantMiddleware.js            # Unchanged from Pass 1: `await warmTenantConfigCache(tenantId);`
                                    # alongside the existing warm call (:94).

server.js                          # C: unchanged from Pass 1 — the same guard clause in five routes.

lib/backupValidation.js            # D/E: validateTenantBackupObject() — idempotency-exclusion check
                                    # extended (NEW this pass) to also reject a planted __restoreLock__
                                    # entry; canonicalJson() added (NEW this pass, exported alongside
                                    # computeChecksum()). The one additive scope==='tenant' guard on
                                    # the existing validateBackupObject() is unchanged from Pass 1.

scripts/tenant-backup.js           # NEW (D). Default-tenant duplicate pre-flight (research.md
                                    # Decision 16). entityChunks file-mode transform corrected (NEW
                                    # this pass) to skip keys absent from the file blob rather than
                                    # mapping every TENANT_BACKUP_ENTITY_KEYS member unconditionally.

scripts/tenant-restore.js          # NEW (E/F/G/H). Restore lock (Step 0) now specified with an
                                    # atomic force-unlock sequence (NEW this pass) and a policy with
                                    # no exception for the crash-resume case (NEW this pass). Validation
                                    # gate (Step 1) extended to reject a planted __restoreLock__ (NEW
                                    # this pass); fingerprint check confirmed as the last sub-step,
                                    # reusing the already-computed file hash. Offline staging (Step 3)
                                    # writes to a tenant-keyed local file (CHANGED this pass, was
                                    # runId-keyed). Checkpoint (Step 4) is tenant-keyed (CHANGED this
                                    # pass). Apply (Step 5)'s entityChunks delete and live-digest query
                                    # are scoped by key as well as tenantId (NEW this pass), and its
                                    # insertMany uses {ordered:false} (NEW this pass).

docs/PRODUCTION_RUNBOOK.md         # NEW section (research.md Decision 18): unchanged scope from
                                    # Pass 1, now additionally documents the always-force-unlock-
                                    # after-a-crash policy precisely.

package.json                       # Unchanged from Pass 1: "backup:tenant", "restore:tenant".

tests/
├── tenant-write-isolation.test.js       # Unchanged (Phase A).
├── tenant-config-isolation.test.js      # Unchanged from Pass 1's own additions, PLUS (NEW this
│                                          pass): default-tenant-vs-real-tenant AppConfig collision
│                                          case, config-only Mongo-mode flush case, config-only
│                                          file-mode shutdown-flush case.
├── telegram-scheduler-boundary.test.js  # Unchanged (5 routes).
├── tenant-backup.test.js                # PLUS (NEW this pass): file-mode undefined-key case,
│                                          __restoreLock__ exclusion case.
├── tenant-restore.test.js               # SUBSTANTIALLY EXTENDED this pass: entityChunks delete-
│                                          scoping case (lock + idempotencyRecords survive), tenant-
│                                          keyed checkpoint lookup across a different runId,
│                                          force-unlock-required-after-crash case (and its
│                                          atomicity), file-mode ordered:false case. The mandatory
│                                          digest-resume test (from Pass 1) is corrected to include
│                                          --force-unlock on its resume step, and to first assert a
│                                          plain re-run without it is rejected.
├── tenant-default-legacy-restore.test.js # Unchanged.
└── production-hardening.test.js         # PLUS (NEW this pass): __restoreLock__ rejection case for
                                           validateTenantBackupObject().
```

**Structure Decision**: Unchanged in shape from Pass 1. This pass corrects the *content* of specifications for files Pass 1 already identified as in scope — no new file is introduced except the already-planned `docs/PRODUCTION_RUNBOOK.md` update.

## Complexity Tracking

| Item | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Offline/local staging file + a tenant-keyed checkpoint file, rather than a single delete-then-insert per tenant | No Mongo transactions available; a crash mid-restore must leave a recoverable, boundable state discoverable by a resumed invocation, which requires the checkpoint to be findable by tenant identity, not by a value (`runId`) that changes on every invocation. | A plain delete-then-insert reintroduces "silently half-successful, no recovery information" (spec.md FR-013); a `runId`-keyed checkpoint (Pass 1's choice) cannot be found again on resume without an undocumented search mechanism. |
| Two new process-local Maps (`_tenantConfigCaches`/`_tenantConfigDirty`) plus a third (`_tenantConfigFileTimers`, second pass) rather than folding config into the existing `_tenantCaches`/`db` object | Config lives in a different collection with a structurally different write; folding it in would change `loadDB()`'s return shape for ~150 existing call sites. The third map is needed because file-mode config persistence needs its own debounce/shutdown-flush bookkeeping, exactly like the existing entity-data mechanism it mirrors — omitting it (Pass 1's gap) reintroduces a SIGTERM data-loss bug this codebase already fixed once for entity data. | Reusing `_tenantCaches` directly was rejected: blast radius far exceeds this phase's goal. Skipping the third map was Pass 1's actual choice and is now corrected. |
| A cross-process restore lock, reusing `EntityChunk`'s existing unique index, with an atomic compare-and-delete force-unlock sequence (the atomicity requirement is new this pass) | Two independent CLI invocations of the *new* restore tool against the same tenant is a real, demonstrable corruption path with no mitigation otherwise. An unconditional delete-then-create force-unlock (Pass 1's original spec) is not atomic and could let two simultaneous recovery attempts both believe they hold the lock. | A new dedicated `RestoreLock` model was rejected as unnecessary schema surface. A third-party distributed-lock library was rejected as new infrastructure this feature's constraints forbid absent a proven need the existing primitive doesn't meet. An unconditional delete-then-create was tried in Pass 1 and rejected this pass once analysis showed its race window. |

## Plan Consistency Review (re-run for Design Remediation Pass 2)

- **No tenant-owned write remains unscoped**: re-confirmed, now including the corrected `entityChunks` delete (`{tenantId,key:{$in:TENANT_BACKUP_ENTITY_KEYS}}`, never a bare `{tenantId}`) and the restored default-tenant `AppConfig` scoping.
- **`default` tenant compatibility is handled explicitly**: unchanged `_defaultTenantFilter` reuse throughout, now genuinely applied to all three of `default`'s own AppConfig call sites (corrected this pass), paired with the mandatory duplicate pre-flight (Decision 16).
- **No live-Mongo synthetic-tenant staging of any kind remains**: unchanged from Pass 1, confirmed again — the restore lock is the only non-real-tenant-owned-by-the-real-target write in the whole flow, and it is itself now protected from being incidentally deleted by the corrected `entityChunks` scoping.
- **Tenant restore cannot fall into whole-instance restore, and vice versa, deliberately**: unchanged from Pass 1.
- **No plan step depends on Mongo transactions**: confirmed again.
- **Rollback/recovery semantics are concrete, not vague, and now internally consistent**: this pass specifically closes the contradiction between the stale-lock policy and the mandatory crash-window test that Pass 1 left standing — one policy, stated identically everywhere, with the corrected force-unlock atomicity to back it.
- **Backup and restore formats cannot be cross-fed accidentally**: unchanged from Pass 1, now also covering a planted `__restoreLock__` record as a rejected format violation.
- **Tenant/Subscription policy is stated once, consistently, everywhere**: unchanged from Pass 1.
- **A resumed invocation can always find its own prior state** (new check this pass): checkpoint and staging files are tenant-keyed, not `runId`-keyed — verified consistent across research.md, data-model.md, the restore contract, and tasks.md.
- **The digest-resume mechanism is order-independent** (new check this pass): `canonicalJson()` is now precisely specified to sort array elements by identity key before serializing, not just to sort object keys — verified consistent across research.md, both backup/restore contracts, and data-model.md.

## Ready for `/speckit-tasks`?

**YES** — tasks.md is revised alongside this plan in the same remediation pass.
