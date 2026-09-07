# Implementation Plan: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Branch**: `002-tenant-isolation-backup-hardening` | **Date**: 2026-09-07 (Design Remediation Pass 7) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-tenant-isolation-backup-hardening/spec.md`. Revised through seven rounds of adversarial `/speckit-analyze` + remediation: Pass 1 closed 17 findings (8 CRITICAL/6 HIGH/3 MEDIUM) from the first analyze; Pass 2 closed 13 findings (5 CRITICAL/6 HIGH/2 MEDIUM) a re-verification found in Pass 1 itself; Pass 3 closed 9 findings (3 CRITICAL/2 HIGH/4 MEDIUM) a re-verification found in Pass 2 itself; Pass 4 closed 11 findings (1 CRITICAL/6 HIGH/4 MEDIUM) a re-verification found in Pass 3 itself; Pass 5 closed 9 findings (1 CRITICAL/5 HIGH/3 MEDIUM) a re-verification found in Pass 4 itself; Pass 6 closed 8 findings (0 CRITICAL/1 HIGH/7 MEDIUM) a re-verification found in Pass 5 itself; **Pass 7 (this revision)** closes 9 findings (1 CRITICAL/2 HIGH/6 MEDIUM) a re-verification found in Pass 6 itself.

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Passes 1-3 progressively replaced live-Mongo synthetic-tenant staging with offline/logical staging and closed a series of scoping, keying, and consistency defects in that replacement (see research.md's own header note for the full history). Pass 4's re-verification of Pass 3 found one genuinely new, previously-unconsidered CRITICAL architectural gap — the live application server's own in-memory per-tenant cache (`_tenantCaches`/`_dbCache`) is never invalidated by the restore CLI's separate-process Mongo write, so the very next unrelated write the server accepts for that tenant can silently undo a completed restore — closed via an explicit operational requirement (Decision 19, FR-033: restart the server process after every restore) rather than new invalidation infrastructure, plus a related HIGH finding acknowledging idempotency-claim survival as a residual risk (Decision 20, FR-034), plus a cluster of Pass-3-introduced citation errors and one config shutdown-flush design mismatch. Pass 5's re-verification of Pass 4 found that the live-server-cache fix (Decision 19) was incomplete, not merely under-specified — the same in-memory cache can also race and corrupt the restore *while it is running*, not only revert it after completion, because nothing in the design stopped the live server from accepting a write during the apply step that recreates a document the restore just deleted or re-persists an already-applied category's stale snapshot. This was a genuinely new requirement (a pre-restore quiesce warning, folded into Decision 19/FR-033 alongside the existing post-restore restart requirement), not a wording correction. Two further HIGH findings extended, rather than replaced, Pass 4 decisions: idempotency-claim staleness (Decision 20/FR-034) gained a restore-time-computable count instead of remaining a static warning, and the offline staging file (introduced in the original redesign) is now deleted automatically on a successful restore, since it was found to leave the same plaintext-secret exposure a backup file has sitting on local disk indefinitely. The remaining Pass 5 findings were MEDIUM-severity documentation/citation-completeness gaps, including a pre-existing, feature-unrelated factual bug discovered in `docs/PRODUCTION_RUNBOOK.md` §5.1. Pass 6's re-verification of Pass 5 found no new architectural gap — every one of its 8 findings was a specification-level correction to Pass 5's own new material, not a new product decision. The one HIGH finding was scope drift in this very document: plan.md's own Source Code manifest for `scripts/tenant-restore.js` and `docs/PRODUCTION_RUNBOOK.md` was never updated past Pass 4 content despite both files' underlying tasks being substantially extended in Pass 5 — corrected in Pass 6. Two MEDIUM findings closed defects Pass 5 itself introduced while fixing something else: the new idempotency-staleness count (Decision 20's extension) never specified which of two genuinely divergent physical representations of a tenant's idempotency data it queries — the dedicated `IdempotencyRecord` collection and the `EntityChunk`-embedded array can briefly disagree, and only the former was specified as authoritative; and the new staging-file-preservation-after-failure rationale (Decision 14's extension) incorrectly claimed a `--force-unlock` resume "reads" the preserved file, when staging in fact reruns unconditionally on every invocation regardless — corrected to the actual rationale (a forensic artifact for the operator) everywhere it appeared. Two more MEDIUM findings closed stale cross-references left behind when Pass 5 introduced new material ahead of older, previously-stable decisions: Decision 11's lock-acquisition-order claim, and Decision 8's "never queried by backup/restore at all" claim. A further MEDIUM closed a citation-completeness gap in research.md's own header line — the very sentence Pass 5 rewrote to fix one such error contained a second, different one — resolved by de-itemizing that line rather than risking a third imperfect summary. The final MEDIUM specified a deterministic kill-point mechanism for the mandatory crash-window test (T058), which previously had no way to avoid wall-clock-timing flakiness, unlike its sibling test.

**Pass 7's re-verification of Pass 6 found, via an open-ended sweep, the first genuinely new CRITICAL architectural gap since Pass 4** — and it predates every remediation pass. spec.md's own original FR-007 (a nonexistent-or-inactive tenant identifier must fail a tenant-scoped backup, present in the very first version of this spec) was never actually implemented by any decision, contract, or task across six passes, and Decision 10's own "never queried" language for `Tenant`/`Subscription` technically foreclosed the only mechanism that could satisfy it. Closed via new Decision 21 — a narrow, deliberate, explicitly-carved-out exception permitting exactly one read-only `Tenant.findOne().lean()` existence/active-status check, reusing `lib/tenantMiddleware.js:72-73`'s own already-proven pattern, and new FR-035, task T031a, and a backup-contract pre-flight step. A MEDIUM finding, elevated here for how much surface area it touched: every illustrative operator-facing message this feature drafted across six passes was in English, contradicting the already-shipped `scripts/restore.js`'s own established Arabic convention (confirmed by direct re-reading) and this same feature's own Telegram/monitor 403 boundary's Arabic error text — closed via new Decision 22, new FR-036, and every literal example message in research.md, both contracts, and `tasks.md` corrected to Arabic. Two HIGH findings closed gaps in Pass 6's own fixes to this document: the Source Code manifest's `docs/PRODUCTION_RUNBOOK.md` entry had misattributed a Pass-6-only requirement (naming both `sourceId` and `journalId`) to Pass 4; and the entire Documentation manifest section (research.md/data-model.md/quickstart.md/the restore contract/spec.md) had been left describing only through-Pass-5 content despite every one of those five files being substantively edited in Pass 6 — both corrected below, alongside this document's own `scripts/tenant-backup.js` and `scripts/tenant-restore.js` entries, updated for Pass 7's own new material. The remaining MEDIUM findings closed stale cross-references Pass 6's fixes left behind in `data-model.md` and `tasks.md`, and a hook-existence assumption in T058's cross-reference to T057, all corrected in those files directly. This pass fixes all of the above at the design-document level; none of it has been implemented as source code. Phase A (`persistUsers()`/`persistEntityKey()`) remains **unchanged** — it has now survived seven rounds of adversarial analysis intact.

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

*GATE: Re-checked after Design Remediation Pass 7. No gate has regressed across any pass. Rows below still marked "second pass"/"Pass 4"/"Pass 5" are historically accurate as written and unchanged since; Pass 3 and Pass 4 findings were citation/implementation-detail corrections and two new operational requirements (FR-033/FR-034) respectively — neither changed any gate's PASS/FAIL status. Pass 5 extended, rather than reversed, Pass 4's two new requirements — again no gate's PASS/FAIL status changed. Pass 6 found zero new architectural gaps (0 CRITICAL, all specification-level corrections to Pass 5's own new material) — no gate's PASS/FAIL status changed there either. Pass 7 found one genuinely new CRITICAL gap (FR-007/Decision 21) and one broad MEDIUM gap (Arabic messaging, FR-036/Decision 22) — both closed via new, narrowly-scoped requirements rather than any change to an already-PASS-ing gate's actual status; see rows IV and V below for where each is now recorded.*

| Principle | Status | Basis |
|---|---|---|
| I. Accounting Integrity Is Non-Negotiable | **PASS** | Unchanged reasoning; the `entityChunks` delete-scoping fix (Pass 2) protects the tenant's own live idempotency-claim store from being incidentally destroyed by an ordinary restore. Pass 4: idempotency-claim survival across a restore is now an explicitly documented residual risk (FR-034) rather than a silently-assumed-safe byproduct — the risk itself is unchanged (it always existed once Decision 8's correct exclusion was adopted), what changed is that it is now acknowledged rather than unconsidered. **Pass 5**: FR-034 is further strengthened from a static acknowledgment to a restore-time-computed count the operator sees on every run, without changing the underlying risk or this row's status. |
| II. Historical Financial Data Must Be Preserved | **PASS** | Unchanged — offline staging still never rewrites live history before the validated, digest-gated apply step. |
| III. Production Safety | **PASS** | Unchanged — isolated-dev work only, re-confirmed below. |
| IV. Data Preservation and Backups | **PASS** | Strengthened further: the force-unlock atomicity fix and the tenant-keyed checkpoint lookup (second pass) close two more ways the restore tooling itself could have behaved unsafely under contention or on resume. Pass 5: the local staging file, which held an unencrypted copy of the tenant's own AppConfig secrets after every restore attempt, is now deleted automatically on success rather than left indefinitely. **Pass 7, CRITICAL**: a tenant-scoped backup for a nonexistent or inactive tenant identifier — FR-007, present since this spec's original version — is now actually rejected before any data is read (Decision 21), closing a gap present, unimplemented, across six prior passes. |
| V. Tenant Isolation and Security | **PASS, corrected basis** | Pass 1 claimed the live-synthetic-identity hazard was "eliminated by construction" — true for staging, but the apply-time `entityChunks` delete (unscoped by key) reopened an adjacent hazard (destroying the in-flight lock, reopening the exact concurrent-restore race the lock exists to prevent) that Pass 1's own re-verification, not this document alone, is what actually caught. Now genuinely closed. **Pass 7**: every new operator-facing message this feature introduces is now Arabic (Decision 22, FR-036), matching this codebase's own established convention for security/safety-relevant operator text (`scripts/restore.js`, the Telegram/monitor 403 boundary) — a consistency gap, not a security hole, but one that risked an operator misreading or skipping a safety-critical instruction (the quiesce/restart warnings) in a codebase whose other operator-facing text is uniformly Arabic. |
| VI. Persistence / Concurrency Reality | **PASS, corrected basis, extended Pass 5** | Pass 1 claimed its lock closed the cross-process safety gap; Pass 2 found the lock's own recovery path (`--force-unlock`) was itself non-atomic and the checkpoint it coordinates with was unfindable on resume — both fixed in Pass 2. Pass 4: a further, previously-unconsidered instance of this same principle — the live application server's own in-memory per-tenant cache is itself a form of "concurrency" this design had not accounted for (Decision 19) — is now closed via an explicit operational restart requirement (FR-033), consistent with this codebase's existing single-instance, restart-to-pick-up-state-changes architecture rather than new invalidation infrastructure. **Pass 5**: Pass 4's fix only closed the *after*-restore half of this gap — the same live cache can also race the restore *during* its apply step, corrupting it rather than merely reverting it afterward. FR-033 now requires quiescing traffic before the restore begins, in addition to restarting after it completes; both remain operational (not architectural) requirements, deliberately, per this row's own established reasoning. |
| VII. Canonical Calculations | **PASS** | Unchanged. |
| VIII. Testing Before Confidence | **PASS** | Unchanged from Pass 1's FR-027 requirement; this pass adds explicit test coverage for the newly-corrected lock policy and delete scoping so these specific regressions cannot recur silently. |
| IX. Demo / Production Isolation | N/A | Unchanged. |
| X. No Uncontrolled Scope Expansion | **PASS** | All second-pass fixes are corrections to already-in-scope mechanisms (the lock, the checkpoint, the config scoping, the digest) — no new capability is added. **Pass 5**: the pre-restore quiesce warning, the idempotency count, and the staging-file cleanup are all extensions of already-in-scope operational messaging and cleanup, not new capabilities. |
| XI. Auditability | **PASS** | Unchanged. |
| XII. Deployment Control | N/A this phase | Unchanged. |
| XIII. Spec Kit Usage | **PASS** | `/speckit-analyze` → Pass 1 → `/speckit-analyze` → Pass 2 → `/speckit-analyze` → Pass 3 → `/speckit-analyze` → Pass 4 → `/speckit-analyze` → Pass 5 → `/speckit-analyze` → Pass 6 → `/speckit-analyze` → Remediation Pass 7 (this document's current state) → an eighth `/speckit-analyze` re-verification next, per the user's own gate — the process continues to work exactly as intended: each re-verification round, including of Pass 3's own citation "fixes," Pass 4's own incomplete cache-staleness fix, and — this round — an FR present since the original spec that six passes of mechanics-focused review never checked was actually implemented, has caught what the round(s) before it missed, with total findings converging (17 → 13 → 9 → 11 → 9 → 8 → 9 gate-blocking findings) toward zero even though Pass 7's own count ticked up from Pass 6's, because it found a genuinely new gap via an open-ended sweep rather than merely re-checking Pass 6's specific fixes. |

No gate failures.

## Project Structure

### Documentation (this feature)

```text
specs/002-tenant-isolation-backup-hardening/
├── spec.md               # FR-001..FR-036. FR-022..032 came from Pass 1's remediation session;
│                            FR-033/FR-034 (Pass 4, extended Pass 5), FR-035/FR-036 (Pass 7) are all
│                            genuine binding requirements, not implementation-detail corrections.
│                            SC-010/SC-011 (Pass 6) give FR-033/034 measurable success criteria.
├── plan.md               # This file.
├── research.md           # 22 decisions. 19/20 (Pass 4, both extended Pass 5) cover live-server
│                            cache staleness and idempotency-claim survival respectively; 21/22
│                            (Pass 7) cover the FR-007 existence-check gap and the Arabic-messaging
│                            gap. Decision 12 gained a fifth-pass bullet; Decisions 8/11/14 gained
│                            sixth-pass narrowing/correction notes; Decisions 5/8/10 gained further
│                            seventh-pass cross-references to 21. Every decision-number citation
│                            re-swept across Passes 3-7 (see the document's own header note for the
│                            exact, heterogeneous correction history — not restated here to avoid
│                            this file drifting out of sync with it again, the exact failure Pass 6
│                            found in this file's own header line).
├── data-model.md          # AppConfig/checkpoint/lock/state-transition sections reflect the
│                            tenant-keyed paths, computeCategoryDigest(), the corrected shutdown-
│                            flush design, the Pass-4 cache-staleness/idempotency notes, Pass 5's
│                            pre-locked quiesce stage/staging-file cleanup/idempotency count, Pass
│                            6's IdempotencyRecord-vs-embedded-array specification and corrected
│                            staging-file rationale, and Pass 7's `locked:` bullet wording fix.
├── quickstart.md          # Steps 1-12 plus 5a (Pass 5, quiesce-warning verification), 6a (restart-
│                            message verification, wording corrected Pass 5), 6b (idempotency-note
│                            documentation check, extended Pass 7 for the sourceId/journalId check),
│                            and 6c (Pass 5, idempotency-count + staging-file cleanup verification,
│                            rationale corrected Pass 6); "Recovery model" summary covers all of the
│                            above, also corrected Pass 6.
├── contracts/
│   ├── tenant-write-isolation-contract.md       # Section B: default-tenant AppConfig scoping,
│   │                                               corrected flush guard, corrected (unconditional)
│   │                                               shutdown-flush design, cites Decision 2 only
│   │                                               (not 2-and-3, a stale Pass-4-fixed mislabel).
│   ├── telegram-scheduler-boundary-contract.md  # Five guarded routes.
│   ├── tenant-backup-contract.md                # 3-category scope; computeCategoryDigest() used
│   │                                               consistently; entityChunks file-mode transform
│   │                                               skips absent-or-null keys; __restoreLock__ and
│   │                                               idempotencyRecords both excluded. NEW, Pass 7,
│   │                                               CRITICAL: a non-default existence/active-status
│   │                                               pre-flight (Decision 21, FR-007/FR-035) — the
│   │                                               one deliberate exception to the Tenant/Subscription
│   │                                               payload exclusion above. All operator-facing text
│   │                                               is Arabic (Pass 7, Decision 22, FR-036).
│   └── tenant-restore-contract.md               # Offline staging; tenant-keyed lock/checkpoint/
│                                                    staging paths; entityChunks delete/digest scoped
│                                                    by key; atomic force-unlock, no exception for a
│                                                    crash; computeCategoryDigest() at every digest
│                                                    site; Step -1 pre-restore quiesce warning (Pass
│                                                    5, Decision 19); Step 6's restart message (Pass
│                                                    4), idempotency-count print (representation
│                                                    specified Pass 6), and staging-file deletion
│                                                    (rationale corrected Pass 6). All operator-facing
│                                                    text is Arabic (Pass 7, Decision 22, FR-036).
└── tasks.md              # 80 tasks (T001-T075 plus T031a, T040a, T056a, T056b, T056c) — see Task
                             Count in this pass's report.
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
                                    # Decision 16). entityChunks file-mode transform corrected (Pass
                                    # 2/3) to skip keys absent from the file blob rather than mapping
                                    # every TENANT_BACKUP_ENTITY_KEYS member unconditionally. NEW,
                                    # Pass 7, CRITICAL: a non-default-tenant existence/active-status
                                    # pre-check (T031a, research.md Decision 21, spec.md FR-007/
                                    # FR-035) — a single `Tenant.findOne().lean()` read, discarded
                                    # after the pass/fail decision, mirroring
                                    # lib/tenantMiddleware.js:72-73's own pattern; the one deliberate
                                    # exception to Decision 10's Tenant/Subscription payload
                                    # exclusion. All operator-facing error text is Arabic (Decision
                                    # 22, FR-036).

scripts/tenant-restore.js          # NEW (E/F/G/H). Step -1 (NEW, Pass 5, CRITICAL): a loud,
                                    # unconditional warning, printed before Step 0's lock acquisition
                                    # and before any other action, instructing the operator to quiesce
                                    # the target tenant's live traffic before the restore begins
                                    # (Decision 19's fifth-pass extension, FR-033) — see T040a. Restore
                                    # lock (Step 0) now specified with an atomic force-unlock sequence
                                    # (Pass 2) and a policy with no exception for the crash-resume case
                                    # (Pass 2). Validation gate (Step 1) extended to reject a planted
                                    # __restoreLock__ (Pass 2); fingerprint check confirmed as the last
                                    # sub-step, reusing the already-computed file hash. Offline staging
                                    # (Step 3) writes to a tenant-keyed local file (Pass 2, was
                                    # runId-keyed) and now runs unconditionally on every invocation,
                                    # resumed or not (Decision 14, Pass 6 clarification). Checkpoint
                                    # (Step 4) is tenant-keyed (Pass 2). Apply (Step 5)'s entityChunks
                                    # delete and live-digest query are scoped by key as well as
                                    # tenantId (Pass 2), and its insertMany uses {ordered:false}
                                    # (Pass 2). Step 6 (Finalize) success output MUST also instruct the
                                    # operator to restart the target tenant's live server process(es)
                                    # (Pass 4, Decision 19, FR-033, CRITICAL — see T056a); MUST print a
                                    # restore-time count of idempotency records at risk, queried from
                                    # the dedicated IdempotencyRecord collection specifically in Mongo
                                    # mode (Pass 5, Decision 20; representation specified Pass 6 — see
                                    # T056b); and, on success only, MUST delete the local staging file
                                    # written by Step 3, left in place after any failure purely as a
                                    # forensic artifact for the operator, not because a resume reads it
                                    # back (Pass 5, HIGH; rationale corrected Pass 6 — see T056c). All
                                    # operator-facing text (Step -1, Step 6, the recovery-model
                                    # reminder) is Arabic (NEW, Pass 7, Decision 22, FR-036 — was
                                    # English through Pass 6).

docs/PRODUCTION_RUNBOOK.md         # NEW section (research.md Decision 18): documents the always-
                                    # force-unlock-after-a-crash policy precisely (Pass 2). Pass 4: a
                                    # mandatory, numbered restart-the-server-process step (Decision 19,
                                    # FR-033), and an idempotency-claim-survival limitation paragraph
                                    # (Decision 20, FR-034). Pass 5: a second mandatory numbered step,
                                    # placed before the restart step in the operator's run order, for
                                    # the pre-restore quiesce requirement (Decision 19's fifth-pass
                                    # extension); a cross-reference to the tool's own restore-time
                                    # idempotency count (T056b); a note that the local staging file is
                                    # deleted automatically on success; and a correction to this
                                    # runbook's own pre-existing, feature-unrelated §5.1 claim that no
                                    # live scheduled job exists in this repository — false, given
                                    # startBackupSchedule() at server.js:9942 — plus an operational
                                    # note about that scheduler potentially running concurrently with
                                    # a tenant-scoped restore. **Corrected, Pass 7**: naming both
                                    # sourceId and journalId in the idempotency-claim-survival
                                    # paragraph was actually a Pass 6 requirement, not Pass 4 as this
                                    # manifest previously misattributed it (T064's own text is explicit
                                    # this was "sixth pass" — Decision 20's fifth-pass correction and
                                    # the restore contract's Step 6 message already named both, but the
                                    # runbook TASK itself did not require it until Pass 6). **NEW,
                                    # Pass 7**: a mandatory non-default existence/active-status
                                    # pre-check paragraph for tenant-scoped backup, referencing the
                                    # tool's own Arabic error text (T031a, Decision 21, FR-007/FR-035).
                                    # See T064 for the complete, itemized list this manifest summarizes.

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

## Plan Consistency Review (re-run for Design Remediation Pass 7)

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
- **No local artifact retains sensitive tenant data past its useful life** (Pass 5 check, HIGH; rationale corrected Pass 6): the offline staging file's deletion-on-success, and deliberate preservation-on-failure as a forensic artifact for the operator (**not**, as Pass 5's own wording wrongly claimed, so a `--force-unlock` resume can "re-read" it — staging reruns unconditionally on every invocation per research.md Decision 14), is verified consistent across the restore contract's Step 3/Step 6, data-model.md's `staged`/`completed`/`failed` state-transition bullets, and `tasks.md` T056c.
- **A tool's own design manifest (this document) describes what its own tasks actually require** (Pass 6 check, HIGH; found still incomplete Pass 7): the Source Code section's `scripts/tenant-restore.js` and `docs/PRODUCTION_RUNBOOK.md` entries were found stale at Pass 4 content in Pass 6 (corrected then), but Pass 7 found the `docs/PRODUCTION_RUNBOOK.md` entry's own Pass-6 fix misattributed one requirement to the wrong pass, and found the entire *Documentation* manifest section (as opposed to Source Code) had never been touched at all across Passes 6 — both corrected this pass, along with `scripts/tenant-backup.js`'s own entry for Pass 7's new T031a.
- **An operator-facing count queries the representation it can actually trust** (Pass 6 check): the idempotency-staleness count (Decision 20's fifth-pass extension) is verified to name the dedicated `IdempotencyRecord` collection specifically, not the `EntityChunk`-embedded array that can briefly disagree with it — consistent across research.md Decision 20, the restore contract's Step 6, data-model.md, and `tasks.md` T056b. **Pass 7**: this check is re-verified to also cover `tasks.md`'s own Plan/Task Consistency Review section, which had been missed in Pass 6's sweep and still named the wrong representation.
- **A decision's own claim about execution order stays true as later decisions change that order** (Pass 6 check; found incomplete Pass 7): Decision 11's lock-acquisition-order language and Decision 8's "never queried... at all" claim were corrected directly in research.md in Pass 6, on the claim that "no downstream document was found to repeat either stale claim" — **that claim was itself wrong**: Pass 7 found data-model.md's `locked:` state-transition bullet and `tasks.md`'s Dependencies & Execution Order summary both still repeated Decision 11's exact retired phrasing ("the very first action"); both are now corrected to match research.md's own Pass-6 wording.
- **The mandatory crash-window test can actually land its own target window, not just describe it** (Pass 6 check, MEDIUM; guarantee closed Pass 7): T058 specifies the same class of documented test-only hook its sibling T057 already uses. Pass 7: T057's own hook is now mandatory rather than an optional alternative, so T058's cross-reference to it is finally guaranteed to have something real to point at.
- **Every FR in spec.md has a real, findable implementation path — not merely a promise** (NEW, Pass 7 check, CRITICAL): swept every FR (FR-001 through the new FR-036) against research.md/the contracts/tasks.md for an actual corresponding decision, contract step, or task; FR-007 was the one gap found — present since the original spec, never implemented, actively foreclosed by Decision 10's own "never queried" language — now closed by Decision 21/FR-035/T031a. No other FR was found to have this gap.
- **New operator-facing text matches this codebase's own established convention, everywhere it appears** (NEW, Pass 7 check): every literal example message in research.md, both new contracts, and `tasks.md` is verified Arabic, in `scripts/restore.js`'s own register (emoji prefix + concise imperative Arabic + English kept only for untranslatable identifiers) — no remaining English placeholder text found in any of the ten documents for a message the actual tool will print.

## Ready for `/speckit-tasks`?

**YES** — tasks.md is revised alongside this plan in the same remediation pass.
