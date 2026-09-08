# Implementation Plan: Tenant Isolation + Safe Backup/Restore Hardening (P4)

**Branch**: `002-tenant-isolation-backup-hardening` | **Date**: 2026-09-08 (Design Remediation Pass 10) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-tenant-isolation-backup-hardening/spec.md`. Revised through ten rounds of adversarial `/speckit-analyze` + remediation: Pass 1 closed 17 findings (8 CRITICAL/6 HIGH/3 MEDIUM) from the first analyze; Pass 2 closed 13 findings (5 CRITICAL/6 HIGH/2 MEDIUM) a re-verification found in Pass 1 itself; Pass 3 closed 9 findings (3 CRITICAL/2 HIGH/4 MEDIUM) a re-verification found in Pass 2 itself; Pass 4 closed 11 findings (1 CRITICAL/6 HIGH/4 MEDIUM) a re-verification found in Pass 3 itself; Pass 5 closed 9 findings (1 CRITICAL/5 HIGH/3 MEDIUM) a re-verification found in Pass 4 itself; Pass 6 closed 8 findings (0 CRITICAL/1 HIGH/7 MEDIUM) a re-verification found in Pass 5 itself; Pass 7 closed 9 findings (1 CRITICAL/2 HIGH/6 MEDIUM) a re-verification found in Pass 6 itself; Pass 8 closed 11 unique findings (0 CRITICAL/7 HIGH/4 MEDIUM — 14 raw across independently-overlapping review dimensions before deduplication) a re-verification found in Pass 7 itself; Pass 9 closed 19 findings (2 CRITICAL/9 HIGH/8 MEDIUM) a re-verification found in Pass 8 itself; **Pass 10 (this revision)** closes 15 findings (0 CRITICAL/7 HIGH/8 MEDIUM) a re-verification found in Pass 9 itself.

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Passes 1-3 progressively replaced live-Mongo synthetic-tenant staging with offline/logical staging and closed a series of scoping, keying, and consistency defects in that replacement (see research.md's own header note for the full history). Pass 4's re-verification of Pass 3 found one genuinely new, previously-unconsidered CRITICAL architectural gap — the live application server's own in-memory per-tenant cache (`_tenantCaches`/`_dbCache`) is never invalidated by the restore CLI's separate-process Mongo write, so the very next unrelated write the server accepts for that tenant can silently undo a completed restore — closed via an explicit operational requirement (Decision 19, FR-033: restart the server process after every restore) rather than new invalidation infrastructure, plus a related HIGH finding acknowledging idempotency-claim survival as a residual risk (Decision 20, FR-034), plus a cluster of Pass-3-introduced citation errors and one config shutdown-flush design mismatch. Pass 5's re-verification of Pass 4 found that the live-server-cache fix (Decision 19) was incomplete, not merely under-specified — the same in-memory cache can also race and corrupt the restore *while it is running*, not only revert it after completion, because nothing in the design stopped the live server from accepting a write during the apply step that recreates a document the restore just deleted or re-persists an already-applied category's stale snapshot. This was a genuinely new requirement (a pre-restore quiesce warning, folded into Decision 19/FR-033 alongside the existing post-restore restart requirement), not a wording correction. Two further HIGH findings extended, rather than replaced, Pass 4 decisions: idempotency-claim staleness (Decision 20/FR-034) gained a restore-time-computable count instead of remaining a static warning, and the offline staging file (introduced in the original redesign) is now deleted automatically on a successful restore, since it was found to leave the same plaintext-secret exposure a backup file has sitting on local disk indefinitely. The remaining Pass 5 findings were MEDIUM-severity documentation/citation-completeness gaps, including a pre-existing, feature-unrelated factual bug discovered in `docs/PRODUCTION_RUNBOOK.md` §5.1. Pass 6's re-verification of Pass 5 found no new architectural gap — every one of its 8 findings was a specification-level correction to Pass 5's own new material, not a new product decision. The one HIGH finding was scope drift in this very document: plan.md's own Source Code manifest for `scripts/tenant-restore.js` and `docs/PRODUCTION_RUNBOOK.md` was never updated past Pass 4 content despite both files' underlying tasks being substantially extended in Pass 5 — corrected in Pass 6. Two MEDIUM findings closed defects Pass 5 itself introduced while fixing something else: the new idempotency-staleness count (Decision 20's extension) never specified which of two genuinely divergent physical representations of a tenant's idempotency data it queries — the dedicated `IdempotencyRecord` collection and the `EntityChunk`-embedded array can briefly disagree, and only the former was specified as authoritative; and the new staging-file-preservation-after-failure rationale (Decision 14's extension) incorrectly claimed a `--force-unlock` resume "reads" the preserved file, when staging in fact reruns unconditionally on every invocation regardless — corrected to the actual rationale (a forensic artifact for the operator) everywhere it appeared. Two more MEDIUM findings closed stale cross-references left behind when Pass 5 introduced new material ahead of older, previously-stable decisions: Decision 11's lock-acquisition-order claim, and Decision 8's "never queried by backup/restore at all" claim. A further MEDIUM closed a citation-completeness gap in research.md's own header line — the very sentence Pass 5 rewrote to fix one such error contained a second, different one — resolved by de-itemizing that line rather than risking a third imperfect summary. The final MEDIUM specified a deterministic kill-point mechanism for the mandatory crash-window test (T058), which previously had no way to avoid wall-clock-timing flakiness, unlike its sibling test.

Pass 7's re-verification of Pass 6 found, via an open-ended sweep, the first genuinely new CRITICAL architectural gap since Pass 4 — and it predated every remediation pass. spec.md's own original FR-007 (a nonexistent-or-inactive tenant identifier must fail a tenant-scoped backup, present in the very first version of this spec) was never actually implemented by any decision, contract, or task across six passes, and Decision 10's own "never queried" language for `Tenant`/`Subscription` technically foreclosed the only mechanism that could satisfy it. Closed via new Decision 21 — a narrow, deliberate, explicitly-carved-out exception permitting exactly one read-only `Tenant.findOne().lean()` existence/active-status check, reusing `lib/tenantMiddleware.js:72-73`'s own already-proven pattern, and new FR-035, task T031a, and a backup-contract pre-flight step. A MEDIUM finding, elevated for how much surface area it touched: every illustrative operator-facing message this feature drafted across six passes was in English, contradicting the already-shipped `scripts/restore.js`'s own established Arabic convention and this same feature's own Telegram/monitor 403 boundary's Arabic error text — closed via new Decision 22, new FR-036, and every literal example message in research.md, both contracts, and `tasks.md` corrected to Arabic. Two HIGH findings closed gaps in Pass 6's own fixes to this document, and the remaining MEDIUM findings closed stale cross-references Pass 6's fixes left behind.

Pass 8's re-verification of Pass 7 found no new CRITICAL, but the largest raw finding count of any round to that point (14 raw across independently-overlapping review dimensions, 11 unique after deduplication: 7 HIGH, 4 MEDIUM — this document, tasks.md, and research.md's own header all originally miscounted this as "7 HIGH, 7 MEDIUM," an arithmetic error corrected across all three in Pass 9) and two findings of real substance rather than mere staleness. First, Pass 7's own new Decision 21 had a genuine design flaw in its file-mode fallback: treating a missing per-tenant file as proof the tenant does not exist would have wrongly rejected a real, active, freshly-onboarded tenant that simply had not yet triggered a durable write — `loadDB()` creates non-default tenant files lazily, not eagerly — reproducing, one layer down, the exact failure FR-035 itself was written to prevent. Withdrawn; file mode no longer enforces FR-007 in this phase, a deliberate, documented scope limitation. Second, and structurally the most significant finding across the first eight passes: an open-ended sweep checked this feature's own new capability against every principle in this project's binding constitution for the first time, and found Principle XI (Auditability) had never been examined — `scripts/tenant-restore.js` and `scripts/tenant-backup.js` are new, privileged, destructive functionality with no audit-logging requirement and no documented spec exception, the one condition the constitution's own text says would excuse this, while this document's own Constitution Check table had certified "PASS | Unchanged" for this row every single time without ever re-deriving that status. Closed via new Decision 23/FR-037 and new tasks T034a/T056d: both tools now call the canonical `appendAuditEvent()` exactly once per terminal outcome, writing to `default`'s own audit log — never the target tenant's, since a restore's own apply step could otherwise destroy the very record documenting it — mirroring `lib/tenantMiddleware.js`'s own existing precedent for cross-tenant accountability logging. The remaining findings were stale cross-references and misattributions Pass 7's own sweep left behind, several of them the identical error class Pass 7 had just finished correcting elsewhere in the same document. Phase A (`persistUsers()`/`persistEntityKey()`) remained **unchanged** through Pass 8 — it had by then survived eight rounds of adversarial analysis intact.

**Pass 9's re-verification of Pass 8 found the largest count of the process so far (19 findings: 2 CRITICAL, 9 HIGH, 8 MEDIUM) — the first round to surface two CRITICAL gaps simultaneously, both in Pass 8's own new Auditability material.** First: Decision 23's own new audit-log write was itself destroyed by an ordinary restore of `default`, since `auditLog` had never been excluded from `TENANT_BACKUP_ENTITY_KEYS` — the identical self-destruction hazard Decision 23 exists to prevent, one level up, with a system-wide blast radius (every tenant's accountability trail, not only `default`'s). Closed by extending research.md Decision 8's exclusion filter, propagated through the validation gate, both contracts, and every affected task. Second: this project's own constitution (Principle IV, "Data Preservation and Backups") requires an explicit, unweakenable typed-confirmation gate before any destructive restore, matching `scripts/restore.js`'s own existing "type نعم to confirm" pattern — `scripts/tenant-restore.js` had never specified this behavior across nine passes, an omission Pass 8's own "swept every constitutional principle" claim itself missed. Closed by new Decision 25, spec.md FR-039, a new restore-contract Step 4a, and new task T053a. A related HIGH gap the CRITICAL `TENANT_BACKUP_ENTITY_KEYS` fix does not itself close was also found and acknowledged as a residual risk rather than mandated away: `default`'s own live application server, if running (the normal case), can still silently overwrite the audit event via the identical stale-in-memory-cache mechanism Decision 19 already documents for tenant data — closing this fully would require either new cache-invalidation infrastructure or a disruptive `default`-server restart after every tenant operation, both judged disproportionate to this feature's scope, so the risk is documented rather than architecturally eliminated, mirroring Decision 19's own precedent for a comparable tradeoff. The remaining findings closed: a newly-discovered, previously-unexamined backup-file retention gap (new Decision 24, spec.md FR-038, new task T035a); an incomplete restore-side audit scope (Step 1/Step 2 rejections were never audited, unlike backup's own equivalent pre-flights) and a Step-5-vs-Step-6 location contradiction in how the audit call was described, both corrected in T056d and the restore contract; a missing synthetic-request-context instruction for both T034a and T056d, without which every audit event's own tenant identity would silently default to `default`; a factual misattribution of what this project's constitution records as technical debt; disagreeing audit-event metadata fields across three documents, now unified; a stale `plan.md` tests/ manifest for both new-tool test files; a missing Complexity Tracking row for the new audit-write mechanism, added above; a self-contradictory "14 raw vs. 11 deduplicated" accounting error in this document's own Pass-8 paragraph (corrected above) and in research.md's and tasks.md's own Pass-8 notes; and a pre-existing (since Pass 1) factual inaccuracy in research.md Decision 7 about `validateBackupObject()`'s real behavior. This pass fixes all of the above at the design-document level; none of it has been implemented as source code. Phase A (`persistUsers()`/`persistEntityKey()`) remains **unchanged** — it has now survived nine rounds of adversarial analysis intact.

**Pass 10's re-verification of Pass 9 found no new CRITICAL, but a real HIGH-severity design bug in Pass 9's own new retention mechanism, plus a cluster of "Pass 9 claimed X was fixed everywhere, but wasn't" findings — the exact self-congratulatory-completeness-claim failure this document set has been repeatedly bitten by, recurring inside the very pass that added a review dimension specifically to guard against it.** The design bug: Decision 24's per-tenant backup-file retention (new Pass 9) matched candidate files by raw string prefix with no delimiter safety, so rotating tenant `acme`'s own backups could also match and delete tenant `acme-corp`'s files, since `tenant-acme-corp-<stamp>.json` literally starts with `tenant-acme-` — directly contradicting FR-038's own "no tenant's own retention count is affected by another tenant's" guarantee, in a feature whose entire purpose is tenant isolation. Closed by switching to an exact-equality match on the fixed-width-stamp-stripped tenantId, propagated to the backup contract and task T035a, with a new collision-specific test case. The most consequential completeness-claim failure: Decision 25's new Step 4a confirmation gate (Pass 9) silently blocks every pre-existing mandatory automated restore test that was never updated to pass `--yes`/`RESTORE_YES=1` — T057, T058, T060, T066, and most of the restore contract's own Test contract items — since Pass 9 only wired the flag into its own new tests. Closed via a deliberate blanket requirement added to the restore contract's Test contract and to `tasks.md`, rather than per-test enumeration, to avoid repeating the "some fixed, some missed" failure mode itself. Also closed: a stale "Decision 23/25" citation for the audit-event requirement (Decision 25 has nothing to do with auditing) in both `tasks.md` and the restore contract; this document's own task-count claim off by one ("85" instead of 84, corrected above); `tasks.md`'s Dependencies & Execution Order summary and Task Quality Gate section never mentioning Step 4a/Decisions 24/25 at all; T064 (the runbook task) never extended for either of Pass 9's two new operator-facing requirements; spec.md's own newly-backfilled Pass-8 note still carrying the "7 HIGH, 7 MEDIUM" (=14) arithmetic error Pass 9 claimed to have fixed in three *other* documents but never checked spec.md itself for; research.md Decision 7's own ninth-pass factual correction over-generalizing a Mongo-source-only code path to "a tenant-scoped file" unconditionally, when the file-sourced case takes a structurally different validation branch with fewer rejection causes; and an orphaned paragraph — verbatim Decision-22 content — misfiled at the end of research.md instead of inside Decision 22 itself. Two newly-identified, previously-unexamined categories are now documented in research.md and the restore contract as acknowledged residual risks rather than architecturally solved, consistent with this document set's own established disposition for comparably-scoped gaps (Decision 19's, Decision 20's, and Decision 23's own precedent): SIGINT/SIGTERM handling during the new Step 4a prompt, and the composition of the pre-restore quiesce window, the restore lock, and the new unbounded confirmation wait, never discussed together across any of the prior nine passes. This pass fixes all of the above at the design-document level; none of it has been implemented as source code, and Phase A remains **unchanged** — it has now survived ten rounds of adversarial analysis intact.

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

*GATE: Re-checked after Design Remediation Pass 10. No gate has regressed across any pass. Rows below still marked "second pass"/"Pass 4"/"Pass 5" are historically accurate as written and unchanged since; Pass 3 and Pass 4 findings were citation/implementation-detail corrections and two new operational requirements (FR-033/FR-034) respectively — neither changed any gate's PASS/FAIL status. Pass 5 extended, rather than reversed, Pass 4's two new requirements — again no gate's PASS/FAIL status changed. Pass 6 found zero new architectural gaps — no gate's PASS/FAIL status changed there either. Pass 7 found one genuinely new CRITICAL gap (FR-007/Decision 21) and one broad MEDIUM gap (Arabic messaging, FR-036/Decision 22). Pass 8 found one genuinely new HIGH gap this table itself had never actually analyzed in seven prior passes — row XI (Auditability), certified "PASS | Unchanged" every time without re-derivation. Pass 9 found this table's own Pass-8 fix to row XI was itself incomplete (the audit-log write it mandated was destroyed by a `default` restore, and by `default`'s own live-server cache) and found a second constitutional principle (IV, the typed-confirmation gate) that row IV had likewise never actually analyzed against this feature's new capability — see rows IV and XI below for the real, now-complete analysis and the requirements (Decisions 24/25, FR-038/FR-039) that close both. **Pass 10 found no new gate-affecting gap — the retention-mechanism design bug and the confirmation-gate test-blocking gap it found (see the Summary section above) are both corrections to Pass 9's own new material, not new principles this table had never examined; row IV's basis is refreshed below to reflect the corrected retention mechanics.***

| Principle | Status | Basis |
|---|---|---|
| I. Accounting Integrity Is Non-Negotiable | **PASS** | Unchanged reasoning; the `entityChunks` delete-scoping fix (Pass 2) protects the tenant's own live idempotency-claim store from being incidentally destroyed by an ordinary restore. Pass 4: idempotency-claim survival across a restore is now an explicitly documented residual risk (FR-034) rather than a silently-assumed-safe byproduct — the risk itself is unchanged (it always existed once Decision 8's correct exclusion was adopted), what changed is that it is now acknowledged rather than unconsidered. **Pass 5**: FR-034 is further strengthened from a static acknowledgment to a restore-time-computed count the operator sees on every run, without changing the underlying risk or this row's status. |
| II. Historical Financial Data Must Be Preserved | **PASS** | Unchanged — offline staging still never rewrites live history before the validated, digest-gated apply step. |
| III. Production Safety | **PASS** | Unchanged — isolated-dev work only, re-confirmed below. |
| IV. Data Preservation and Backups | **PASS, actually analyzed against its own confirmation-gate text for the first time Pass 9** | Strengthened further: the force-unlock atomicity fix and the tenant-keyed checkpoint lookup (second pass) close two more ways the restore tooling itself could have behaved unsafely under contention or on resume. Pass 5: the local staging file, which held an unencrypted copy of the tenant's own AppConfig secrets after every restore attempt, is now deleted automatically on success rather than left indefinitely. Pass 7, CRITICAL: a tenant-scoped backup for a nonexistent or inactive tenant identifier — FR-007, present since this spec's original version — is now actually rejected before any data is read (Decision 21), closing a gap present, unimplemented, across six prior passes. Pass 8: Decision 21's own Mongo-mode check is unaffected, but its original file-mode fallback (a missing per-tenant file treated as "does not exist") was found to risk rejecting a real, active tenant that simply had not yet triggered a durable write — the wrong direction of error for this principle's own "preserve real data" concern — and is withdrawn; file mode does not enforce FR-007 in this phase, a documented scope limitation rather than a broken heuristic. **Pass 9, CRITICAL**: this principle's own text also states, explicitly, that restore "requires... owner approval, matching the existing `--target=<name>` + typed-confirmation gate in `scripts/restore.js`. This gate MUST NOT be weakened, defaulted, or bypassed" — a requirement this row's own "PASS" status had certified through eight passes without ever checking `scripts/tenant-restore.js` actually specified this behavior. It never did. Closed via new Decision 25/FR-039 and a new Step 4a, mirroring `scripts/restore.js`'s own typed-`نعم` gate exactly. **Pass 9, also**: a per-tenant backup-file retention policy is added (Decision 24/FR-038), closing a previously-unexamined gap in this same principle's own "backup files must not accumulate indefinitely with unmanaged plaintext-secret exposure" concern, one this row had also never separately checked. **Pass 10, HIGH**: Decision 24's own retention-matching logic was itself found unsafe — a raw string-prefix match could rotate one tenant's backups into deleting a different, hyphen-prefix-colliding tenant's own files (e.g. `acme` vs. `acme-corp`), the opposite of "preserved" for the *other* tenant's backup, corrected to an exact-equality match on the extracted tenantId. This row's status remains PASS — the fix corrects Pass 9's own new mechanism, it does not reveal a previously-unexamined gap in this principle itself. |
| V. Tenant Isolation and Security | **PASS, corrected basis** | Pass 1 claimed the live-synthetic-identity hazard was "eliminated by construction" — true for staging, but the apply-time `entityChunks` delete (unscoped by key) reopened an adjacent hazard (destroying the in-flight lock, reopening the exact concurrent-restore race the lock exists to prevent) that Pass 1's own re-verification, not this document alone, is what actually caught. Now genuinely closed. **Pass 7**: every new operator-facing message this feature introduces is now Arabic (Decision 22, FR-036), matching this codebase's own established convention for security/safety-relevant operator text (`scripts/restore.js`, the Telegram/monitor 403 boundary) — a consistency gap, not a security hole, but one that risked an operator misreading or skipping a safety-critical instruction (the quiesce/restart warnings) in a codebase whose other operator-facing text is uniformly Arabic. |
| VI. Persistence / Concurrency Reality | **PASS, corrected basis, extended Pass 5** | Pass 1 claimed its lock closed the cross-process safety gap; Pass 2 found the lock's own recovery path (`--force-unlock`) was itself non-atomic and the checkpoint it coordinates with was unfindable on resume — both fixed in Pass 2. Pass 4: a further, previously-unconsidered instance of this same principle — the live application server's own in-memory per-tenant cache is itself a form of "concurrency" this design had not accounted for (Decision 19) — is now closed via an explicit operational restart requirement (FR-033), consistent with this codebase's existing single-instance, restart-to-pick-up-state-changes architecture rather than new invalidation infrastructure. **Pass 5**: Pass 4's fix only closed the *after*-restore half of this gap — the same live cache can also race the restore *during* its apply step, corrupting it rather than merely reverting it afterward. FR-033 now requires quiescing traffic before the restore begins, in addition to restarting after it completes; both remain operational (not architectural) requirements, deliberately, per this row's own established reasoning. |
| VII. Canonical Calculations | **PASS** | Unchanged. |
| VIII. Testing Before Confidence | **PASS** | Unchanged from Pass 1's FR-027 requirement; this pass adds explicit test coverage for the newly-corrected lock policy and delete scoping so these specific regressions cannot recur silently. |
| IX. Demo / Production Isolation | N/A | Unchanged. |
| X. No Uncontrolled Scope Expansion | **PASS** | All second-pass fixes are corrections to already-in-scope mechanisms (the lock, the checkpoint, the config scoping, the digest) — no new capability is added. **Pass 5**: the pre-restore quiesce warning, the idempotency count, and the staging-file cleanup are all extensions of already-in-scope operational messaging and cleanup, not new capabilities. |
| XI. Auditability | **PASS, first analyzed Pass 8, that analysis found incomplete and completed Pass 9** | This row certified "Unchanged" in every one of the first seven passes without ever re-deriving that status against this feature's own new capability — an assertion, not an analysis. Pass 8, HIGH: the constitution's own Principle XI requires new privileged functionality to use `appendAuditEvent()` unless a documented spec exception exists; `scripts/tenant-restore.js` (a full-tenant-replace operation) and `scripts/tenant-backup.js` had neither the audit-logging requirement nor a documented exception, across all seven prior passes. Closed via new Decision 23/FR-037: both tools now call `appendAuditEvent()` exactly once per terminal outcome, writing to `default`'s own audit log (never the target tenant's, since Step 5's own apply would otherwise be capable of destroying the record of itself). **Pass 9, CRITICAL — Pass 8's own fix was itself incomplete**: `auditLog` was never excluded from `TENANT_BACKUP_ENTITY_KEYS`, so a restore *of* `default` (a normal, supported target) would delete-and-reinsert `default`'s own `entityChunks` category — `auditLog` included — silently reverting the centralized log every tenant's events are concentrated into, system-wide. Closed by extending research.md Decision 8's exclusion filter. **Pass 9, also**: the "mirrors `lib/tenantMiddleware.js`'s own existing precedent" claim was corrected — only the *purpose* is shared; the actual write mechanism (a direct `EntityChunk` read-modify-write) is new to this codebase. A related residual risk is now explicitly acknowledged rather than silently assumed away: `default`'s own live server, if running, can still overwrite the audit event via its own stale-cache mechanism (Decision 19's own mechanism, unaddressed by the `TENANT_BACKUP_ENTITY_KEYS` fix, which only protects against restore, not the live server's ordinary writes) — documented, not architecturally eliminated, for the same "disproportionate to this feature's scope" reasoning Decision 19 itself already established. Retrofitting the existing, unmodified whole-instance `scripts/backup.js`/`scripts/restore.js` remains explicitly out of scope, consistent with this feature's standing "never touch those two files" boundary — **not**, as this row previously claimed, because the constitution itself records their absence of audit logging as "pre-existing technical debt" (it does not; that citation was corrected in Pass 9 — the constitution's own recorded technical debt is a different, unrelated set of direct `db.auditLog` call sites). |
| XII. Deployment Control | N/A this phase | Unchanged. |
| XIII. Spec Kit Usage | **PASS** | `/speckit-analyze` → Pass 1 → `/speckit-analyze` → Pass 2 → `/speckit-analyze` → Pass 3 → `/speckit-analyze` → Pass 4 → `/speckit-analyze` → Pass 5 → `/speckit-analyze` → Pass 6 → `/speckit-analyze` → Pass 7 → `/speckit-analyze` → Pass 8 → `/speckit-analyze` → Pass 9 → `/speckit-analyze` → Remediation Pass 10 (this document's current state) → an eleventh `/speckit-analyze` re-verification next, per the user's own gate — the process continues to work exactly as intended: each re-verification round, including of Pass 3's own citation "fixes," Pass 4's own incomplete cache-staleness fix, an FR present since the original spec that six passes of mechanics-focused review never checked was actually implemented (Pass 7), an entire constitution principle (Auditability) no pass had ever checked this feature's own new capability against (Pass 8), Pass 8's own fix to that same principle found itself incomplete plus a *second* constitutional principle (IV) Pass 8's own "swept every principle" claim had itself missed (Pass 9), and — this round — a real design bug in Pass 9's own new retention mechanism plus a cluster of "Pass 9 claimed X was fixed everywhere, but wasn't" findings recurring inside the very pass that added a dedicated review dimension to guard against that exact failure class, has caught what the round(s) before it missed, with total findings (17 → 13 → 9 → 11 → 9 → 8 → 9 → 14 raw/11 unique → 19 → 15) not monotonically shrinking round-over-round but each round finding genuinely new, previously-unexamined material or genuinely incomplete prior fixes rather than exhausting a fixed, shrinking list — Pass 10 is the first round with zero CRITICAL findings since Pass 6, a legible convergence signal on architectural soundness even as documentation-consistency and self-verification-completeness findings continue. |

No gate failures.

## Project Structure

### Documentation (this feature)

```text
specs/002-tenant-isolation-backup-hardening/
├── spec.md               # FR-001..FR-039. FR-022..032 came from Pass 1's remediation session;
│                            FR-033/FR-034 (Pass 4, extended Pass 5), FR-035/FR-036 (Pass 7), FR-037
│                            (Pass 8, scope widened Pass 9), FR-038/FR-039 (Pass 9) are all genuine
│                            binding requirements, not implementation-detail corrections. SC-010/
│                            SC-011 (Pass 6) give FR-033/034 measurable success criteria. FR-035's
│                            Edge Case (Pass 7) is narrowed Pass 8 to note file mode does not enforce
│                            it. NEW, Pass 9: two Design Remediation notes (Pass 8's own, never
│                            written at the time, and Pass 9's own) were added retroactively — Pass
│                            8's own status line and note were simply never updated past Pass 7.
│                            NEW, Pass 10: the Pass-8 note's own backfilled "7 HIGH, 7 MEDIUM" (=14)
│                            arithmetic error — the exact one Pass 9 claimed to have fixed in three
│                            other documents but never checked spec.md itself for — is corrected.
├── plan.md               # This file.
├── research.md           # 25 decisions. 19/20 (Pass 4, both extended Pass 5) cover live-server
│                            cache staleness and idempotency-claim survival respectively; 21/22
│                            (Pass 7) cover the FR-007 existence-check gap and the Arabic-messaging
│                            gap; 23 (Pass 8, extended Pass 9) covers Auditability; 24 (backup-file
│                            retention) and 25 (typed-confirmation gate) are new, Pass 9. Decision 12
│                            gained a fifth-pass bullet; Decision 7 gained a ninth-pass factual
│                            correction (a pre-existing, since-Pass-1 inaccuracy about
│                            validateBackupObject()'s real behavior); Decision 8 gained a ninth-pass
│                            extension (the auditLog exclusion, CRITICAL); Decisions 11/14 gained
│                            sixth-pass narrowing/correction notes; Decisions 5/10 gained
│                            seventh-pass cross-references to 21; Decisions 10/16 gained eighth-pass
│                            narrowing/clarification notes for Decision 21's file-mode behavior.
│                            Every decision-number citation re-swept across Passes 3-9 (see the
│                            document's own header note for the exact, heterogeneous correction
│                            history — not restated here to avoid this file drifting out of sync
│                            with it again, the exact failure Pass 6, Pass 8, and Pass 9 have each
│                            found in this file's own header line). NEW, Pass 10, HIGH: Decision 24's
│                            retention-matching logic corrected (exact-equality on the extracted
│                            tenantId, not a `startsWith()` prefix, closing a cross-tenant-deletion
│                            collision bug). Decision 7's own ninth-pass correction re-corrected
│                            (properly scoped to Mongo-source-only; the file-source case has two
│                            causes, not three). An orphaned paragraph — verbatim Decision-22
│                            content, previously misfiled at the document's end after Decision 25 —
│                            relocated into Decision 22 itself. Decision 25 gains two new
│                            acknowledged-residual-risk addenda (signal handling during the Step 4a
│                            prompt; the quiesce+lock+confirmation-wait composition window).
├── data-model.md          # AppConfig/checkpoint/lock/state-transition sections reflect the
│                            tenant-keyed paths, computeCategoryDigest(), the corrected shutdown-
│                            flush design, the Pass-4 cache-staleness/idempotency notes, Pass 5's
│                            pre-locked quiesce stage/staging-file cleanup/idempotency count, Pass
│                            6's IdempotencyRecord-vs-embedded-array specification and corrected
│                            staging-file rationale, and Pass 7's `locked:` bullet wording fix. Pass
│                            8: the Tenant/Subscription entity section's stale "never queried at
│                            all" claim is narrowed to payload-exclusion (Decision 21 made the old
│                            claim false); the `completed`/`failed` bullets gain the new mandatory
│                            audit-event requirement (Decision 23, FR-037). NEW, Pass 9: the
│                            Restore Lock section's own residual-risk note gains the auditLog
│                            self-destruction fix and the live-server-cache-staleness acknowledgment
│                            (Decision 8/23's own ninth-pass extensions).
├── quickstart.md          # Steps 1-12 plus 5a (Pass 5, quiesce-warning verification), 6a (restart-
│                            message verification, wording corrected Pass 5), 6b (idempotency-note
│                            documentation check, extended Pass 6 for the sourceId/journalId check
│                            — eighth-pass correction: this entry previously misattributed that
│                            extension to Pass 7), and 6c (Pass 5, idempotency-count + staging-file
│                            cleanup verification, rationale corrected Pass 6); "Recovery model"
│                            summary covers all of the above, also corrected Pass 6. Pass 7 adds
│                            section 5's step 7 (non-default existence/active-status pre-check) and
│                            Arabic-message notes throughout. Pass 8 corrects two remaining English
│                            placeholder examples in step 6c that Pass 7's own sweep missed, adds
│                            section 5's step 8 (the withdrawn file-mode existence heuristic) and
│                            step 12a (the audit-event requirement), and extends the "Recovery
│                            model" summary with both.
├── contracts/
│   ├── tenant-write-isolation-contract.md       # Section B: default-tenant AppConfig scoping,
│   │                                               corrected flush guard, corrected (unconditional)
│   │                                               shutdown-flush design, cites Decision 2 only
│   │                                               (not 2-and-3, a stale Pass-4-fixed mislabel).
│   ├── telegram-scheduler-boundary-contract.md  # Five guarded routes.
│   ├── tenant-backup-contract.md                # 3-category scope; computeCategoryDigest() used
│   │                                               consistently; entityChunks file-mode transform
│   │                                               skips absent-or-null keys; __restoreLock__ and
│   │                                               idempotencyRecords both excluded. Pass 7,
│   │                                               CRITICAL: a non-default existence/active-status
│   │                                               pre-flight (Decision 21, FR-007/FR-035), Mongo
│   │                                               mode only (**scope corrected Pass 8** — file
│   │                                               mode's own withdrawn fallback could have
│   │                                               rejected a real empty tenant) — the one
│   │                                               deliberate exception to the Tenant/Subscription
│   │                                               payload exclusion above. All operator-facing text
│   │                                               is Arabic (Pass 7, Decision 22, FR-036). Pass 8,
│   │                                               HIGH: a mandatory audit-event section (Decision
│   │                                               23, FR-037). NEW, Pass 9: `auditLog` exclusion
│   │                                               (test 8a) and a per-tenant backup-file retention
│   │                                               section (Decision 24, FR-038, test 12). NEW, Pass
│   │                                               10, HIGH: retention section's matching logic
│   │                                               corrected to exact-equality on the extracted
│   │                                               tenantId, closing a hyphen-prefix cross-tenant
│   │                                               deletion collision; new collision-specific test
│   │                                               12a and Guarantees bullet.
│   └── tenant-restore-contract.md               # Offline staging; tenant-keyed lock/checkpoint/
│                                                    staging paths; entityChunks delete/digest scoped
│                                                    by key; atomic force-unlock, no exception for a
│                                                    crash; computeCategoryDigest() at every digest
│                                                    site; Step -1 pre-restore quiesce warning (Pass
│                                                    5, Decision 19); Step 6's restart message (Pass
│                                                    4), idempotency-count print (representation
│                                                    specified Pass 6), staging-file deletion
│                                                    (rationale corrected Pass 6), and Pass 8, HIGH,
│                                                    mandatory audit-event call (Decision 23,
│                                                    FR-037). All operator-facing text is Arabic
│                                                    (Pass 7, Decision 22, FR-036; one Step 6 example
│                                                    missed by Pass 7 corrected Pass 8). NEW, Pass 9,
│                                                    CRITICAL: new Step 4a, a mandatory typed-`نعم`
│                                                    confirmation gate before Step 5 (Decision 25,
│                                                    FR-039). NEW, Pass 9, HIGH: the audit-event
│                                                    requirement (above) widened to also fire on a
│                                                    Step 1/Step 2 rejection, not only Step 5/6's own
│                                                    exit, with a corrected synthetic-request-context
│                                                    instruction and unified metadata fields. NEW,
│                                                    Pass 10: stale "Decision 23/25" citation
│                                                    corrected to Decision 23 alone; Test contract
│                                                    gains a blanket `--yes`/`RESTORE_YES=1`
│                                                    requirement so Step 4a does not silently block
│                                                    every pre-existing mandatory test, and Test item
│                                                    16 is corrected to reflect it; Step 4a gains two
│                                                    acknowledged residual-risk notes (signal handling,
│                                                    unbounded confirmation-wait composition).
└── tasks.md              # 84 tasks (T001-T075 plus T031a, T034a, T035a, T040a, T053a, T056a,
                             T056b, T056c, T056d) — see Task Count in this pass's report.
                             (Tenth-pass correction: this line previously said "85," an arithmetic
                             error — T001-T075 is 75, plus the 9 lettered tasks listed is 84.)
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
                                    # unchanged from Pass 1. NEW, Pass 9: validateTenantBackupObject()
                                    # (T038) also rejects an auditLog entity chunk, alongside the
                                    # existing idempotencyRecords/__restoreLock__ rejections.

scripts/tenant-backup.js           # NEW (D). Default-tenant duplicate pre-flight (research.md
                                    # Decision 16). entityChunks file-mode transform corrected (Pass
                                    # 2/3) to skip keys absent from the file blob rather than mapping
                                    # every TENANT_BACKUP_ENTITY_KEYS member unconditionally. Pass 7,
                                    # CRITICAL: a non-default-tenant existence/active-status pre-check
                                    # (T031a, research.md Decision 21, spec.md FR-007/FR-035), Mongo
                                    # mode only (**scope corrected Pass 8** — the original file-mode
                                    # fallback, treating a missing per-tenant file as nonexistent,
                                    # could reject a real active tenant with no durable write yet;
                                    # withdrawn) — a single `Tenant.findOne().lean()` read, discarded
                                    # after the pass/fail decision, mirroring
                                    # lib/tenantMiddleware.js:72-73's own pattern; the one deliberate
                                    # exception to Decision 10's Tenant/Subscription payload
                                    # exclusion. All operator-facing error text is Arabic (Decision
                                    # 22, FR-036). Pass 8, HIGH: on any terminal outcome, calls
                                    # appendAuditEvent() (T034a, research.md Decision 23, spec.md
                                    # FR-037) exactly once, writing to default's own auditLog via a
                                    # direct EntityChunk read-modify-write — closes a Principle-XI
                                    # (Auditability) gap unexamined across the first seven passes.
                                    # NEW, Pass 9: T034a's audit-event call now passes a synthetic
                                    # req:{tenantId:target} (without it every event's own tenantId
                                    # silently defaults to 'default') and uses metadata unified with
                                    # T056d's own shared minimum (backupFingerprint, createdAt).
                                    # NEW, Pass 9, MEDIUM: T035a adds per-tenant backup-file retention
                                    # (research.md Decision 24, spec.md FR-038), mirroring
                                    # scripts/backup.js's own BACKUP_KEEP rotation, scoped per tenant.

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
                                    # reminder) is Arabic (Pass 7, Decision 22, FR-036 — was English
                                    # through Pass 6; one Step 6 example missed by Pass 7's own sweep
                                    # is corrected Pass 8). Pass 8, HIGH: Step 6, on either terminal
                                    # outcome, calls appendAuditEvent() (T056d, research.md Decision
                                    # 23, spec.md FR-037) exactly once, writing to default's own
                                    # auditLog, never the target tenant's — closes the same
                                    # Principle-XI gap as scripts/tenant-backup.js above. NEW, Pass 9,
                                    # HIGH: T056d's own scope is widened to fire on the first terminal
                                    # outcome the invocation reaches — a Step 1 validation-gate or
                                    # Step 2 default-duplicate rejection, not only Step 5/6's own exit
                                    # — since those are genuine terminal outcomes this codebase's own
                                    # constitution does not exempt; the call now passes a synthetic
                                    # req:{tenantId:target} (without it every event's tenantId
                                    # silently defaults to 'default'); its metadata is unified with
                                    # T034a's own shared minimum. NEW, Pass 9, CRITICAL: T053a adds
                                    # Step 4a, a mandatory typed-`نعم` confirmation gate before Step
                                    # 5's first write (research.md Decision 25, spec.md FR-039, per
                                    # this project's own constitution Principle IV), mirroring
                                    # scripts/restore.js:104-107's own gate exactly, bypassable only
                                    # via --yes/RESTORE_YES=1.

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
                                    # runbook TASK itself did not require it until Pass 6). Pass 7: a
                                    # mandatory non-default existence/active-status pre-check paragraph
                                    # for tenant-scoped backup, referencing the tool's own Arabic error
                                    # text (T031a, Decision 21, FR-007/FR-035). **NEW, Pass 8**: one
                                    # sentence noting every tenant-scoped backup/restore leaves a
                                    # durable, admin-readable audit-log entry in default's own log
                                    # (Decision 23, FR-037); and a correction narrowing Pass 7's own
                                    # existence-check paragraph to Mongo mode only (Decision 21,
                                    # scope corrected eighth pass). See T064 for the complete,
                                    # itemized list this manifest summarizes.

package.json                       # Unchanged from Pass 1: "backup:tenant", "restore:tenant".

tests/
├── tenant-write-isolation.test.js       # Unchanged (Phase A).
├── tenant-config-isolation.test.js      # Unchanged from Pass 1's own additions, plus (Pass 2):
│                                          default-tenant-vs-real-tenant AppConfig collision case,
│                                          config-only Mongo-mode flush case, config-only file-mode
│                                          shutdown-flush case.
├── telegram-scheduler-boundary.test.js  # Unchanged (5 routes).
├── tenant-backup.test.js                # Pass 2: file-mode undefined-key case, __restoreLock__
│                                          exclusion case (T026 cases 8-9). Pass 7, CRITICAL:
│                                          non-default existence/active-status pre-check case (T026
│                                          case 10). Pass 8: file-mode non-enforcement case (case 11)
│                                          and the audit-event case (case 12). NEW, Pass 9: the
│                                          audit-event case (12) gains an event-tenantId assertion;
│                                          auditLog exclusion case (13); backup-file retention case
│                                          (14) — 14 cases total (**corrected, Pass 9** — this entry
│                                          previously stopped at 10, never updated for Pass 8's own
│                                          two additions, an omission Pass 9's own sweep found), T036
│                                          checkpoint updated to match. NEW, Pass 10, HIGH: retention
│                                          case (14) extended with a hyphen-prefix-collision case
│                                          (14a — tenants `acme`/`acme-corp`) proving the fix is
│                                          exact-equality, not `startsWith()` — 15 cases total, T036
│                                          checkpoint updated to match.
├── tenant-restore.test.js               # Pass 2: entityChunks delete-scoping case (lock +
│                                          idempotencyRecords survive), tenant-keyed checkpoint
│                                          lookup across a different runId, force-unlock-required-
│                                          after-crash case (and its atomicity), file-mode
│                                          ordered:false case. The mandatory digest-resume test
│                                          (from Pass 1) is corrected to include --force-unlock on
│                                          its resume step, and to first assert a plain re-run
│                                          without it is rejected. Pass 4: T056a's restart-message
│                                          content assertion. Pass 5: T040a's Step -1 quiesce-warning
│                                          test (including the early-exit-path case), T056b's
│                                          idempotency-count tests, T056c's staging-file
│                                          cleanup/preservation tests. Pass 6: T056b's representation
│                                          test (dedicated collection, not the embedded array); T058's
│                                          deterministic-kill-point mechanism. Pass 7: every content
│                                          assertion above updated to match Arabic text, not English.
│                                          Pass 8: T056d's audit-event tests. **NEW, Pass 9 (corrected
│                                          — this entry previously stopped at Pass 7, never mentioning
│                                          T056d at all)**: T056d's tests extended for Step 1/Step 2
│                                          audit coverage and the event-tenantId assertion; T053a's
│                                          new typed-confirmation-gate tests (no-response-cancels,
│                                          نعم-proceeds, --yes/RESTORE_YES-skips, prompt-text-echo).
│                                          NEW, Pass 10, CRITICAL for test-suite integrity: every
│                                          pre-existing test in this file other than T053a's own
│                                          confirmation-gate tests now explicitly passes
│                                          --yes/RESTORE_YES=1, closing the gap where Pass 9's new
│                                          Step 4a gate would otherwise have silently blocked every
│                                          one of them from ever reaching Step 5.
├── tenant-default-legacy-restore.test.js # Unchanged.
└── production-hardening.test.js         # Pass 2: __restoreLock__ rejection case for
                                           validateTenantBackupObject().
```

**Structure Decision**: Unchanged in shape from Pass 1 — no new test file is introduced across any pass; every addition above extends an existing file Pass 1 already identified as in scope, plus the already-planned `docs/PRODUCTION_RUNBOOK.md` update.

## Complexity Tracking

| Item | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Offline/local staging file + a tenant-keyed checkpoint file, rather than a single delete-then-insert per tenant | No Mongo transactions available; a crash mid-restore must leave a recoverable, boundable state discoverable by a resumed invocation, which requires the checkpoint to be findable by tenant identity, not by a value (`runId`) that changes on every invocation. | A plain delete-then-insert reintroduces "silently half-successful, no recovery information" (spec.md FR-013); a `runId`-keyed checkpoint (Pass 1's choice) cannot be found again on resume without an undocumented search mechanism. |
| Two new process-local Maps (`_tenantConfigCaches`/`_tenantConfigDirty`) plus a third (`_tenantConfigFileTimers`, second pass) rather than folding config into the existing `_tenantCaches`/`db` object | Config lives in a different collection with a structurally different write; folding it in would change `loadDB()`'s return shape for ~150 existing call sites. The third map is needed because file-mode config persistence needs its own debounce/shutdown-flush bookkeeping, exactly like the existing entity-data mechanism it mirrors — omitting it (Pass 1's gap) reintroduces a SIGTERM data-loss bug this codebase already fixed once for entity data. | Reusing `_tenantCaches` directly was rejected: blast radius far exceeds this phase's goal. Skipping the third map was Pass 1's actual choice and is now corrected. |
| A cross-process restore lock, reusing `EntityChunk`'s existing unique index, with an atomic compare-and-delete force-unlock sequence (the atomicity requirement is new this pass) | Two independent CLI invocations of the *new* restore tool against the same tenant is a real, demonstrable corruption path with no mitigation otherwise. An unconditional delete-then-create force-unlock (Pass 1's original spec) is not atomic and could let two simultaneous recovery attempts both believe they hold the lock. | A new dedicated `RestoreLock` model was rejected as unnecessary schema surface. A third-party distributed-lock library was rejected as new infrastructure this feature's constraints forbid absent a proven need the existing primitive doesn't meet. An unconditional delete-then-create was tried in Pass 1 and rejected this pass once analysis showed its race window. |
| A direct `EntityChunk{tenantId:'default',key:'auditLog'}` read-modify-write for the new audit-event requirement (NEW, ninth pass — research.md Decision 23), rather than the full `loadDB()`/`saveDB()` cache machinery | A short-lived CLI process has no reason to instantiate the full request-scoped tenant-cache machinery just to append one log entry; the restore lock already establishes the precedent of a direct `EntityChunk` primitive being sufficient for a CLI tool's own narrow write. | Going through `loadDB()`/`saveDB()` would not actually close the acknowledged residual risk this same write has (a concurrent live-server flush can still overwrite it, research.md Decision 23) — it would only add machinery this CLI process doesn't otherwise need. An atomic MongoDB `$push`/`$slice` was considered as a way to close the separate, non-atomicity residual risk this same decision documents, and is recorded as a follow-on hardening candidate, not built this phase. |

## Plan Consistency Review (re-run for Design Remediation Pass 10)

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
- **Every decision-number citation in research.md resolves to the decision it claims to** (Pass 4, new check, after Pass 3 introduced two wrong ones of its own while fixing others): re-swept end to end in Pass 4. Pass 5, new check: re-swept once more after Pass 4's own summary line was itself found to misstate which decisions it corrected (claimed 7, 11, 12 among them; none of those three actually received a Pass-4 citation fix). Pass 6: found a *second* inaccuracy in that same corrected sentence (Decisions 13/14 wrongly called "unchanged"; 7/11 omitted) and, rather than risk a third imperfect itemization, de-itemized research.md's header line entirely in favor of pointing to each decision's own heading. **Eighth-pass correction**: this bullet itself had gone stale, still describing research.md's header as itemizing "6, 8, 9, 18" a full two passes after Pass 6 removed that itemization — corrected to describe the current, de-itemized state; see research.md's own header for the authoritative, currently-accurate account.
- **A restore cannot be silently corrupted while it is still in progress, not only reverted after it finishes** (NEW, Pass 5, CRITICAL check): the pre-restore quiesce warning (Decision 19's extension) is a distinct requirement from the post-restore restart requirement — verified as two separately-stated, separately-tested items (contract Step -1 vs. Step 6; `tasks.md` T040a vs. T056; quickstart.md step 5a vs. 6a; spec.md's FR-033 covering both explicitly) rather than one being mistaken for covering the other.
- **Operator-facing residual-risk documentation matches what the tool actually computes** (NEW, Pass 5 check): the idempotency-staleness count (Decision 20's extension) is verified to be an actual live query in the restore contract's Step 6 and `tasks.md` T056b, not merely a runbook paragraph asserting a number the tool never computes.
- **No local artifact retains sensitive tenant data past its useful life** (Pass 5 check, HIGH; rationale corrected Pass 6): the offline staging file's deletion-on-success, and deliberate preservation-on-failure as a forensic artifact for the operator (**not**, as Pass 5's own wording wrongly claimed, so a `--force-unlock` resume can "re-read" it — staging reruns unconditionally on every invocation per research.md Decision 14), is verified consistent across the restore contract's Step 3/Step 6, data-model.md's `staged`/`completed`/`failed` state-transition bullets, and `tasks.md` T056c.
- **A tool's own design manifest (this document) describes what its own tasks actually require** (Pass 6 check, HIGH; found still incomplete Pass 7): the Source Code section's `scripts/tenant-restore.js` and `docs/PRODUCTION_RUNBOOK.md` entries were found stale at Pass 4 content in Pass 6 (corrected then), but Pass 7 found the `docs/PRODUCTION_RUNBOOK.md` entry's own Pass-6 fix misattributed one requirement to the wrong pass, and found the entire *Documentation* manifest section (as opposed to Source Code) had never been touched at all across Passes 6 — both corrected this pass, along with `scripts/tenant-backup.js`'s own entry for Pass 7's new T031a.
- **An operator-facing count queries the representation it can actually trust** (Pass 6 check): the idempotency-staleness count (Decision 20's fifth-pass extension) is verified to name the dedicated `IdempotencyRecord` collection specifically, not the `EntityChunk`-embedded array that can briefly disagree with it — consistent across research.md Decision 20, the restore contract's Step 6, data-model.md, and `tasks.md` T056b. **Pass 7**: this check is re-verified to also cover `tasks.md`'s own Plan/Task Consistency Review section, which had been missed in Pass 6's sweep and still named the wrong representation.
- **A decision's own claim about execution order stays true as later decisions change that order** (Pass 6 check; found incomplete Pass 7): Decision 11's lock-acquisition-order language and Decision 8's "never queried... at all" claim were corrected directly in research.md in Pass 6, on the claim that "no downstream document was found to repeat either stale claim" — **that claim was itself wrong**: Pass 7 found data-model.md's `locked:` state-transition bullet and `tasks.md`'s Dependencies & Execution Order summary both still repeated Decision 11's exact retired phrasing ("the very first action"); both are now corrected to match research.md's own Pass-6 wording.
- **The mandatory crash-window test can actually land its own target window, not just describe it** (Pass 6 check, MEDIUM; guarantee closed Pass 7): T058 specifies the same class of documented test-only hook its sibling T057 already uses. Pass 7: T057's own hook is now mandatory rather than an optional alternative, so T058's cross-reference to it is finally guaranteed to have something real to point at.
- **Every FR in spec.md has a real, findable implementation path — not merely a promise** (NEW, Pass 7 check, CRITICAL): swept every FR (FR-001 through the new FR-036) against research.md/the contracts/tasks.md for an actual corresponding decision, contract step, or task; FR-007 was the one gap found — present since the original spec, never implemented, actively foreclosed by Decision 10's own "never queried" language — now closed by Decision 21/FR-035/T031a. No other FR was found to have this gap.
- **New operator-facing text matches this codebase's own established convention, everywhere it appears** (Pass 7 check; found incomplete Pass 8): every literal example message in research.md, both new contracts, and `tasks.md` was intended to be verified Arabic in Pass 7, on the claim that "no remaining English placeholder text found in any of the ten documents" — **that claim was itself wrong**: Pass 8 found one English example in research.md's own Decision 20 (the zero-count idempotency message) and two English-worded verification steps in quickstart.md's step 6c, all missed by Pass 7's own sweep; all three corrected, and the T063/restore-contract Recovery-model quote reconciled to identical wording across both documents.
- **This feature's own new capability is checked against every principle in this project's binding constitution, not only the ones prior passes happened to think of** (Pass 8 check, HIGH; found itself incomplete on two counts Pass 9): Principle XI (Auditability) had never been re-derived against `scripts/tenant-backup.js`/`scripts/tenant-restore.js` in seven passes — `plan.md`'s own Constitution Check table certified "PASS | Unchanged" every time without analysis. Closed via Decision 23/FR-037/T034a/T056d in Pass 8 — **but that closure was itself incomplete**: Pass 9 found the audit-log write it mandated was destroyed by a `default` restore (closed via Decision 8's ninth-pass extension) and by `default`'s own live-server cache (acknowledged as a residual risk); and Pass 8's own claim to have "checked every principle" was itself an overstatement — Principle IV's own explicit typed-confirmation-gate requirement was missed by that same sweep and only found in Pass 9 (Decision 25/FR-039).
- **A file-mode fallback heuristic must not be able to reject a case it is meant to accept** (Pass 8 check, HIGH): Decision 21's original file-mode existence check (missing file ⇒ nonexistent tenant) could have rejected a real, active tenant with no durable write yet — the exact class of error FR-035 itself exists to forbid, one layer lower. Withdrawn; file mode does not enforce this check, verified consistent across research.md, both contracts, `tasks.md`, spec.md, and quickstart.md.
- **A centralized accountability mechanism must not be destroyable by the very tenant-scoped operations it exists to hold accountable — including the one tenant (`default`) whose own log it lives in** (NEW, Pass 9 check, CRITICAL): `auditLog` was never excluded from `TENANT_BACKUP_ENTITY_KEYS`, so a `default` restore would silently revert every tenant's own accountability trail. Verified closed via research.md Decision 8's ninth-pass extension, propagated through the validation gate (T038), both contracts, and data-model.md's own new residual-risk note.
- **Every constitutional principle this feature's own new capability could plausibly implicate is checked, not just the first one found** (NEW, Pass 9 check, CRITICAL): re-swept all thirteen constitution principles against `scripts/tenant-backup.js`/`scripts/tenant-restore.js`'s actual new behavior; Principle IV's own explicit "MUST NOT be weakened, defaulted, or bypassed" typed-confirmation-gate text was the one gap found, present unspecified since this feature's very first draft. Closed via Decision 25/FR-039/T053a/Step 4a.
- **An audit event's own recorded tenant identity is not merely asserted to be correct — the mechanism that makes it correct is actually specified** (NEW, Pass 9 check, HIGH): `buildAuditEvent()`'s `tenantId` derivation depends on a `req` object no bare CLI invocation has; without an explicit synthetic-`req` construction, every event would have silently recorded `'default'` regardless of the real target. Verified now specified in research.md Decision 23 and both T034a/T056d, with a dedicated test assertion in both contracts and `tasks.md`.
- **A rotation/retention filter matching by string prefix cannot mistake one tenant's own identifier for another's** (NEW, Pass 10 check, HIGH): Decision 24's original `` `tenant-${tenantId}-` `` `startsWith()` match had no delimiter boundary, so tenant `acme`'s own rotation could also match and delete tenant `acme-corp`'s files — a real cross-tenant-isolation violation in a feature whose entire purpose is tenant isolation. Verified closed via an exact-equality match on the fixed-width-stamp-stripped tenantId, consistent across research.md Decision 24, the backup contract's retention section and Guarantees, and `tasks.md` T035a/T026 case 14a — the delimiter-safety property does not depend on real tenantIds happening to avoid hyphens, which they routinely do not (`server.js`'s own tenantId-generation shape).
- **A new mandatory gate does not silently strand the tests that already existed before it** (NEW, Pass 10 check, CRITICAL for test-suite integrity): Decision 25's new Step 4a confirmation gate (Pass 9) blocks on interactive stdin unless `--yes`/`RESTORE_YES=1` is passed — but Pass 9 wired that flag into only its own new tests (T053a), leaving every pre-existing mandatory automated test (T057, T058, T060, T066, and most of the restore contract's own Test contract items) to hang or short-circuit the moment they reached the new gate, never exercising the Step 5 apply logic they exist to verify. Verified closed via a single blanket requirement in the restore contract's Test contract intro and in `tasks.md` immediately after T053a — deliberately not a per-test enumeration, since per-test enumeration is exactly the pattern that let this gap slip through Pass 9 undetected in the first place.
- **A design-document set's own claim to have fixed something "everywhere" is independently re-checked, not taken on faith from the pass that made the claim** (NEW, Pass 10 check, the meta-finding this round's dedicated review dimension specifically targeted): found recurring in the very pass (9) that first added language explicitly claiming completeness sweeps — spec.md's own backfilled Pass-8 note still carried the "14 raw = 7+7" arithmetic error Pass 9 claimed to have fixed in research.md/tasks.md/this document but never checked spec.md itself for; this document's own task-count claim said "85" when the real count is 84; a wrong "Decision 23/25" audit citation persisted in two documents after Pass 9's own audit-scope rewrite; and Decision 7's ninth-pass "correction" itself over-generalized a Mongo-source-only code path. All four independently verified closed this pass — the common root cause (a claim of completeness substituting for a re-check against the actual current state of every document) is not itself architecturally fixable, only mitigated by continuing to run a dedicated adversarial dimension against exactly this failure class each round, which this round's own workflow script did.

## Ready for `/speckit-tasks`?

**YES** — tasks.md is revised alongside this plan in the same remediation pass.
