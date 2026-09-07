# Implementation Plan: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Branch**: `002-tenant-isolation-backup-hardening` | **Date**: 2026-09-07 (Design Remediation Pass 5) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-tenant-isolation-backup-hardening/spec.md`. Revised through five rounds of adversarial `/speckit-analyze` + remediation: Pass 1 closed 17 findings (8 CRITICAL/6 HIGH/3 MEDIUM) from the first analyze; Pass 2 closed 13 findings (5 CRITICAL/6 HIGH/2 MEDIUM) a re-verification found in Pass 1 itself; Pass 3 closed 9 findings (3 CRITICAL/2 HIGH/4 MEDIUM) a re-verification found in Pass 2 itself; Pass 4 closed 11 findings (1 CRITICAL/6 HIGH/4 MEDIUM) a re-verification found in Pass 3 itself; **Pass 5 (this revision)** closes 9 findings (1 CRITICAL/5 HIGH/3 MEDIUM) a re-verification found in Pass 4 itself.

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Passes 1-3 progressively replaced live-Mongo synthetic-tenant staging with offline/logical staging and closed a series of scoping, keying, and consistency defects in that replacement (see research.md's own header note for the full history). Pass 4's re-verification of Pass 3 found one genuinely new, previously-unconsidered CRITICAL architectural gap — the live application server's own in-memory per-tenant cache (`_tenantCaches`/`_dbCache`) is never invalidated by the restore CLI's separate-process Mongo write, so the very next unrelated write the server accepts for that tenant can silently undo a completed restore — closed via an explicit operational requirement (Decision 19, FR-033: restart the server process after every restore) rather than new invalidation infrastructure, plus a related HIGH finding acknowledging idempotency-claim survival as a residual risk (Decision 20, FR-034), plus a cluster of Pass-3-introduced citation errors and one config shutdown-flush design mismatch. **Pass 5's re-verification of Pass 4 found that the live-server-cache fix (Decision 19) was incomplete, not merely under-specified** — the same in-memory cache can also race and corrupt the restore *while it is running*, not only revert it after completion, because nothing in the design stopped the live server from accepting a write during the apply step that recreates a document the restore just deleted or re-persists an already-applied category's stale snapshot. This is a genuinely new requirement (a pre-restore quiesce warning, folded into Decision 19/FR-033 alongside the existing post-restore restart requirement), not a wording correction. Two further HIGH findings extend, rather than replace, Pass 4 decisions: idempotency-claim staleness (Decision 20/FR-034) now gains a restore-time-computable count instead of remaining a static warning, and the offline staging file (introduced in the original redesign) is now deleted automatically on a successful restore, since it was found to leave the same plaintext-secret exposure a backup file has sitting on local disk indefinitely. The remaining findings were MEDIUM-severity documentation/citation-completeness gaps: three downstream documents attributed a `default`-tenant digest-query scoping requirement to research.md Decision 12, but Decision 12 itself never stated it (now fixed directly in Decision 12); `quickstart.md`'s own verification step for the restart-requirement message had an inverted assertion (asked to confirm the stale cache does *not* overwrite restored data — the opposite of the actual risk); and, separately from this feature's own findings, a pre-existing factual bug was discovered in `docs/PRODUCTION_RUNBOOK.md` (§5.1 falsely claims no live scheduled job exists in this repository, when `startBackupSchedule()` at `server.js:9942` demonstrably runs one automatically in production) and is corrected while that file is already being edited for this feature's own runbook section. This pass fixes all of the above at the design-document level; none of it has been implemented as source code. Phase A (`persistUsers()`/`persistEntityKey()`) remains **unchanged** — it has now survived five rounds of adversarial analysis intact.

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

*GATE: Re-checked after Design Remediation Pass 5. No gate has regressed across any pass. Rows below still marked "second pass"/"Pass 4" are historically accurate as written and unchanged since; Pass 3 and Pass 4 findings were citation/implementation-detail corrections and two new operational requirements (FR-033/FR-034) respectively — neither changed any gate's PASS/FAIL status. Pass 5 extends, rather than reverses, Pass 4's two new requirements — again no gate's PASS/FAIL status changes, so no row was rewritten solely to relabel its pass number.*

| Principle | Status | Basis |
|---|---|---|
| I. Accounting Integrity Is Non-Negotiable | **PASS** | Unchanged reasoning; the `entityChunks` delete-scoping fix (Pass 2) protects the tenant's own live idempotency-claim store from being incidentally destroyed by an ordinary restore. Pass 4: idempotency-claim survival across a restore is now an explicitly documented residual risk (FR-034) rather than a silently-assumed-safe byproduct — the risk itself is unchanged (it always existed once Decision 8's correct exclusion was adopted), what changed is that it is now acknowledged rather than unconsidered. **Pass 5**: FR-034 is further strengthened from a static acknowledgment to a restore-time-computed count the operator sees on every run, without changing the underlying risk or this row's status. |
| II. Historical Financial Data Must Be Preserved | **PASS** | Unchanged — offline staging still never rewrites live history before the validated, digest-gated apply step. |
| III. Production Safety | **PASS** | Unchanged — isolated-dev work only, re-confirmed below. |
| IV. Data Preservation and Backups | **PASS** | Strengthened further: the force-unlock atomicity fix and the tenant-keyed checkpoint lookup (second pass) close two more ways the restore tooling itself could have behaved unsafely under contention or on resume. **Pass 5**: the local staging file, which held an unencrypted copy of the tenant's own AppConfig secrets after every restore attempt, is now deleted automatically on success rather than left indefinitely. |
| V. Tenant Isolation and Security | **PASS, corrected basis** | Pass 1 claimed the live-synthetic-identity hazard was "eliminated by construction" — true for staging, but the apply-time `entityChunks` delete (unscoped by key) reopened an adjacent hazard (destroying the in-flight lock, reopening the exact concurrent-restore race the lock exists to prevent) that Pass 1's own re-verification, not this document alone, is what actually caught. Now genuinely closed. |
| VI. Persistence / Concurrency Reality | **PASS, corrected basis, extended Pass 5** | Pass 1 claimed its lock closed the cross-process safety gap; Pass 2 found the lock's own recovery path (`--force-unlock`) was itself non-atomic and the checkpoint it coordinates with was unfindable on resume — both fixed in Pass 2. Pass 4: a further, previously-unconsidered instance of this same principle — the live application server's own in-memory per-tenant cache is itself a form of "concurrency" this design had not accounted for (Decision 19) — is now closed via an explicit operational restart requirement (FR-033), consistent with this codebase's existing single-instance, restart-to-pick-up-state-changes architecture rather than new invalidation infrastructure. **Pass 5**: Pass 4's fix only closed the *after*-restore half of this gap — the same live cache can also race the restore *during* its apply step, corrupting it rather than merely reverting it afterward. FR-033 now requires quiescing traffic before the restore begins, in addition to restarting after it completes; both remain operational (not architectural) requirements, deliberately, per this row's own established reasoning. |
| VII. Canonical Calculations | **PASS** | Unchanged. |
| VIII. Testing Before Confidence | **PASS** | Unchanged from Pass 1's FR-027 requirement; this pass adds explicit test coverage for the newly-corrected lock policy and delete scoping so these specific regressions cannot recur silently. |
| IX. Demo / Production Isolation | N/A | Unchanged. |
| X. No Uncontrolled Scope Expansion | **PASS** | All second-pass fixes are corrections to already-in-scope mechanisms (the lock, the checkpoint, the config scoping, the digest) — no new capability is added. **Pass 5**: the pre-restore quiesce warning, the idempotency count, and the staging-file cleanup are all extensions of already-in-scope operational messaging and cleanup, not new capabilities. |
| XI. Auditability | **PASS** | Unchanged. |
| XII. Deployment Control | N/A this phase | Unchanged. |
| XIII. Spec Kit Usage | **PASS** | `/speckit-analyze` → Pass 1 → `/speckit-analyze` → Pass 2 → `/speckit-analyze` → Pass 3 → `/speckit-analyze` → Pass 4 → `/speckit-analyze` → Remediation Pass 5 (this document's current state) → a sixth `/speckit-analyze` re-verification next, per the user's own gate — the process continues to work exactly as intended: each re-verification round, including of Pass 3's own citation "fixes" and Pass 4's own incomplete cache-staleness fix, has caught what the round before it missed, converging (17 → 13 → 9 → 11 → 9 gate-blocking findings) toward zero. |

No gate failures.

## Project Structure

### Documentation (this feature)

```text
specs/002-tenant-isolation-backup-hardening/
├── spec.md               # FR-001..FR-034. FR-022..032 came from Pass 1's remediation session;
│                            FR-033 (quiesce-before-and-restart-after) and FR-034 (idempotency-
│                            staleness acknowledgment + restore-time count) came from Pass 4,
│                            extended by Pass 5 — both are genuine binding requirements, not
│                            implementation-detail corrections.
├── plan.md               # This file.
├── research.md           # 20 decisions. 19 (live-server cache staleness) and 20 (idempotency-
│                            claim survival) are new since Pass 4, both extended in Pass 5 (19: the
│                            cache can also race the restore during apply, not only after
│                            completion; 20: a restore-time-computed count). Decision 12 gained a
│                            fifth-pass bullet (the default-tenant digest-query scoping requirement,
│                            previously stated only in downstream documents). Every decision-number
│                            citation re-swept and corrected across Passes 3-5, including errors
│                            introduced while fixing prior errors (see the document's own header
│                            note for the exact, heterogeneous correction history — not restated
│                            here to avoid this file drifting out of sync with it again).
├── data-model.md          # AppConfig/checkpoint/lock/state-transition sections reflect the
│                            tenant-keyed paths, computeCategoryDigest(), the corrected shutdown-
│                            flush design, the Pass-4 cache-staleness/idempotency notes, and Pass
│                            5's pre-locked quiesce stage, staging-file cleanup, and idempotency count.
├── quickstart.md          # Steps 1-12 plus 5a (Pass 5, quiesce-warning verification), 6a (restart-
│                            message verification, wording corrected Pass 5), 6b (idempotency-note
│                            documentation check), and 6c (Pass 5, idempotency-count + staging-file
│                            cleanup verification); "Recovery model" summary covers all of the above.
├── contracts/
│   ├── tenant-write-isolation-contract.md       # Section B: default-tenant AppConfig scoping,
│   │                                               corrected flush guard, corrected (unconditional)
│   │                                               shutdown-flush design, cites Decision 2 only
│   │                                               (not 2-and-3, a stale Pass-4-fixed mislabel).
│   ├── telegram-scheduler-boundary-contract.md  # Five guarded routes.
│   ├── tenant-backup-contract.md                # 3-category scope; computeCategoryDigest() used
│   │                                               consistently; entityChunks file-mode transform
│   │                                               skips absent-or-null keys; __restoreLock__ and
│   │                                               idempotencyRecords both excluded.
│   └── tenant-restore-contract.md               # Offline staging; tenant-keyed lock/checkpoint/
│                                                    staging paths; entityChunks delete/digest scoped
│                                                    by key; atomic force-unlock, no exception for a
│                                                    crash; computeCategoryDigest() at every digest
│                                                    site; new Step -1 pre-restore quiesce warning
│                                                    (Pass 5, Decision 19); Step 6 requires the
│                                                    restart message (Pass 4), the idempotency-count
│                                                    print, and the staging-file deletion (both Pass
│                                                    5, Decision 20 and the plaintext-secrets finding
│                                                    respectively).
└── tasks.md              # 79 tasks (T001-T075 plus T040a, T056a, T056b, T056c) — see Task Count
                             in this pass's report.
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
                                    # extended (Pass 2) to also reject a planted __restoreLock__ entry;
                                    # canonicalJson() added (Pass 2, exported alongside computeChecksum()).
                                    # NEW, Pass 3: computeCategoryDigest(records) = computeChecksum(
                                    # canonicalJson(records.map(stripMongoMeta))) — the single, only
                                    # function used to compute a categoryDigests.<cat> value anywhere
                                    # (backup-write, restore-staging recompute, restore-apply live
                                    # re-check), closing the _id/__v representation-inconsistency defect
                                    # Pass 2's canonicalJson() alone did not close. The one additive
                                    # scope==='tenant' guard on the existing validateBackupObject() is
                                    # unchanged from Pass 1.

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
                                    # are scoped by key as well as tenantId (Pass 2), and its
                                    # insertMany uses {ordered:false} (Pass 2). NEW, Pass 4: Step 6
                                    # (Finalize) success output MUST also instruct the operator to
                                    # restart the target tenant's live server process(es) (Decision 19,
                                    # FR-033, CRITICAL) — see the new tests/tenant-restore.test.js T056a.

docs/PRODUCTION_RUNBOOK.md         # NEW section (research.md Decision 18): documents the always-
                                    # force-unlock-after-a-crash policy precisely (Pass 2). NEW,
                                    # Pass 4: a mandatory, numbered restart-the-server-process step
                                    # (Decision 19, FR-033), and an idempotency-claim-survival
                                    # limitation paragraph (Decision 20, FR-034).

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

## Plan Consistency Review (re-run for Design Remediation Pass 5)

- **No tenant-owned write remains unscoped**: re-confirmed, now including the corrected `entityChunks` delete (`{tenantId,key:{$in:TENANT_BACKUP_ENTITY_KEYS}}`, never a bare `{tenantId}`) and the restored default-tenant `AppConfig` scoping.
- **`default` tenant compatibility is handled explicitly**: unchanged `_defaultTenantFilter` reuse throughout, now genuinely applied to all three of `default`'s own AppConfig call sites (Pass 2), paired with the mandatory duplicate pre-flight (Decision 16).
- **No live-Mongo synthetic-tenant staging of any kind remains**: unchanged from Pass 1, confirmed again — the restore lock is the only non-real-tenant-owned-by-the-real-target write in the whole flow, and it is itself protected from being incidentally deleted by the Pass-2 `entityChunks` scoping fix.
- **Tenant restore cannot fall into whole-instance restore, and vice versa, deliberately**: unchanged from Pass 1.
- **No plan step depends on Mongo transactions**: confirmed again.
- **Rollback/recovery semantics are concrete, not vague, and internally consistent**: Pass 2 closed the contradiction between the stale-lock policy and the mandatory crash-window test; Pass 4 adds that "the tool's job is done" is itself not the whole recovery picture — a restarted server process is now an explicit, required part of considering a restore actually complete (Decision 19).
- **Backup and restore formats cannot be cross-fed accidentally**: unchanged from Pass 1, also covering a planted `__restoreLock__` record as a rejected format violation (Pass 2).
- **Tenant/Subscription policy is stated once, consistently, everywhere**: unchanged from Pass 1.
- **A resumed invocation can always find its own prior state** (Pass 2): checkpoint and staging files are tenant-keyed, not `runId`-keyed — verified consistent across research.md, data-model.md, the restore contract, and tasks.md.
- **The digest-resume mechanism is order-independent** (Pass 2) **and representation-consistent** (Pass 3): `canonicalJson()` sorts array elements by identity key before serializing; `computeCategoryDigest()` strips `_id`/`__v` identically at all three computation points (backup-write, staging, apply) — both verified consistent across research.md, both backup/restore contracts, data-model.md, and tasks.md this pass.
- **`_tenantConfigFileTimers` gets the same crash-safety treatment as its siblings** (Pass 3/4, new check): `clearTimeout`-before-`.clear()` in the P0.11 reset block (not a bare `.clear()`), and an *unconditional* shutdown flush over `_tenantConfigCaches.keys()` (not a "pending timers only" flush that would miss a tenant mid-retry) — verified consistent across research.md, data-model.md, the write-isolation contract, and tasks.md T008/T015 this pass.
- **A completed restore is genuinely complete, not silently reversible by the live server** (Pass 4, new check): the restart-requirement (Decision 19) is stated identically in the restore contract's Step 6, `tasks.md` T056/T056a, `docs/PRODUCTION_RUNBOOK.md`'s planned T064 section, and quickstart.md's step 6a/Recovery model addendum.
- **Every decision-number citation in research.md resolves to the decision it claims to** (Pass 4, new check, after Pass 3 introduced two wrong ones of its own while fixing others): re-swept end to end in Pass 4 — see research.md's own header note for the corrected list. **Pass 5, new check**: re-swept once more after Pass 4's own summary line was itself found to misstate which decisions it corrected (claimed 7, 11, 12 among them; none of those three actually received a Pass-4 citation fix) — research.md's header now names only the decisions that genuinely did (6, 8, 9, 18), with Decision 12 separately noted as receiving a Pass-5 *content addition* (not a citation fix).
- **A restore cannot be silently corrupted while it is still in progress, not only reverted after it finishes** (NEW, Pass 5, CRITICAL check): the pre-restore quiesce warning (Decision 19's extension) is a distinct requirement from the post-restore restart requirement — verified as two separately-stated, separately-tested items (contract Step -1 vs. Step 6; `tasks.md` T040a vs. T056; quickstart.md step 5a vs. 6a; spec.md's FR-033 covering both explicitly) rather than one being mistaken for covering the other.
- **Operator-facing residual-risk documentation matches what the tool actually computes** (NEW, Pass 5 check): the idempotency-staleness count (Decision 20's extension) is verified to be an actual live query in the restore contract's Step 6 and `tasks.md` T056b, not merely a runbook paragraph asserting a number the tool never computes.
- **No local artifact retains sensitive tenant data past its useful life** (NEW, Pass 5 check, HIGH): the offline staging file's deletion-on-success (and deliberate preservation-on-failure, for `--force-unlock` resume) is verified consistent across the restore contract's Step 3/Step 6, data-model.md's `staged`/`completed`/`failed` state-transition bullets, and `tasks.md` T056c.

## Ready for `/speckit-tasks`?

**YES** — tasks.md is revised alongside this plan in the same remediation pass.
