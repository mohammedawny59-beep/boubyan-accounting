# Implementation Plan: Vendor / Accounts Payable Workspace Upgrade

**Branch**: `chore/spec-kit-adoption` (no dedicated feature branch — no `before_specify` git hook configured; see spec.md header) | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-vendor-ap-workspace/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Enhance the existing per-vendor statement modal (`openVendorStatement()` / `#vendorStmtModal` in `public/index.html`) into a fuller "workspace" that also surfaces open bills, overdue amount, next open items, and a per-vendor AP aging breakdown — all sourced from endpoints that already exist and already do the accounting correctly. The technical approach is almost entirely additive-on-the-frontend: one existing endpoint (`GET /api/vendors/:id/statement`) already returns the exact reconciliation object (statement balance vs. GL, via `buildBalanceMap()`) that both the summary card and the full statement will share, satisfying the single-shared-reconciliation-check requirement from clarification. The only backend change is a small, precedented additive one: an optional `?vendorId=` filter on `GET /api/ap-aging`, so a single vendor's aging buckets can be fetched without a fragile client-side name match. The workspace also performs one genuinely new frontend fetch — `GET /api/vendor-bills?vendorId=` — reusing the existing, unmodified route (finding I1: this data was incorrectly assumed to already be available; it is not — see research.md Decision 4/11); the endpoint itself is unchanged, only a new caller is added. **Open-item deep-linking is a plain navigation, not a nested modal (ninth-round simplification)**: clicking an open item closes the workspace, switches to the existing "Vendor Bills (AP)" tab, and opens that bill's existing, unmodified detail view there — the same experience a user gets navigating there manually. An earlier design opened the bill-detail modal stacked on top of the still-open workspace; three consecutive `/speckit-analyze` rounds found genuine new UI-state-lifecycle defects in that design, so it was replaced rather than patched a fourth time (see research.md Decision 3/4). **Tenth-round hardening**: a fresh-perspective audit of the simplified navigation itself found two real bugs (a never-reset AP-tab status filter, and a stale-filtered fetch racing the deliberate one) — fixed with two small request-generation counters, one added to the pre-existing `loadVendorBills()` function itself (its only modification anywhere in this plan) and one new to the navigation function, plus reordering the filter resets to happen before navigating. **Eleventh-round hardening**: reordering those filter resets earlier exposed one more pre-existing dependency — the AP tab's vendor filter has no real `<option>`s to select from until a function it already calls internally, `populateVbVendorSelects()`, has run at least once; fixed by calling that same existing function one step earlier. The resulting filter change (AP tab scoped to the workspace's vendor and all statuses) is now an explicit, documented product decision, not an incidental side effect. **Twelfth-round correction, corrected again thirteenth round**: a comprehensive final review found the statement/reconciliation fetch itself — the source of the workspace's own headline GL balance/statement balance/reconciliation badge (T009/T010, this feature's own new UI) — had no equivalent no-fabricate-zero protection for its own failure, unlike its sibling vendor-bills fetch; a first fix (T011) was added mirroring T008's pattern, anchored to a new requirement, FR-024 — but the required final gate check on that fix found it did not actually work: the pre-existing, unconditional success-path render code sat outside the fetch's own `catch` block, so a rendered error state was silently overwritten by a fall-through to a fabricated `0`/`null` state before repaint (finding `T011-CATCH-FALLTHROUGH-OVERWRITES-ERROR-STATE`, CRITICAL), and the fix's own text cited a 404 check that did not exist under the wrong task number (`T011-404-CHECK-INSERTION-POINT-FICTIONAL`/`T011-WRONG-404-TASK-REFERENCE`, HIGH/MEDIUM). T011 was rewritten, thirteenth round, to classify the fetch's outcome explicitly (`'success'`/`'notfound'`/`'error'`) and gate every render behind it — never a bare `return`, which would also have wrongly blocked the independent vendor-bills fetch — and to build its own 404 branch directly rather than citing a nonexistent prior one; T013 was retargeted from adding that 404 branch to verifying it. No new persisted entity, no new journal-posting path, and no RBAC change.

## Technical Context

**Language/Version**: Node.js (CommonJS) / Express — existing stack, unchanged.

**Primary Dependencies**: Express, Mongoose, bcryptjs, jsonwebtoken (all existing; this feature adds zero new dependencies).

**Storage**: MongoDB (primary) with a JSON-file fallback (`lib/database.js`) — unchanged. No new persisted entity or schema field is introduced by this feature; it is a read-composition layer over `vendors`, `vendorBills`, and `journalEntries`, all of which already exist.

**Testing**: Jest + supertest, `DB_FILE_ONLY=true` per-file bootstrap (the established lightweight pattern used by `tests/p0-7-ap-lifecycle.test.js`, `tests/p3-vendor-statement-hotfix.test.js`, `tests/rbac-and-audit.test.js`) — no isolated-Mongo harness (`mongodb-memory-server`) is needed since no new persisted data or Mongo-specific behavior is introduced.

**Target Platform**: Existing deployment target (Render, per the constitution's Known Architectural Risks — genuinely unconfirmed from code alone) plus any modern browser for the vanilla-JS frontend in `public/index.html`. Unaffected by this feature.

**Project Type**: Existing single-repository web application monolith (`server.js` + `public/index.html`) — not a frontend/backend-split project. The generic "Option 2: Web application" structure in this template's Source Code section does not apply; see Structure Decision below.

**Performance Goals**: Matches spec SC-009 — vendor workspace, statement, and aging views usable within a couple of seconds for a vendor with up to a few hundred statement lines. All reused endpoints are existing, already-in-production, in-memory array scans (`db.vendors`/`db.vendorBills`/`db.journalEntries`) with no new indexing or query pattern introduced.

**Constraints**: Zero new journal-posting paths (Principle I); zero new persisted entities or schema changes (Principle VI); zero new RBAC/permission keys (Principle V, clarify Q3); reconciliation MUST be computed exactly once and shared (clarify Q1); AP aging bucket logic MUST be reused unchanged, only filtered (Principle VII, FR-012).

**Scale/Scope**: Single-clinic tenant scale — tens of vendors, up to a few hundred bills/journal lines per vendor (matches the spec's own "typical volume" assumption in SC-009 and the scale already exercised by the existing 39-file test suite).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Basis |
|---|---|---|
| I. Accounting Integrity Is Non-Negotiable | **PASS** | Zero new posting/write paths of this feature's own; the workspace's deep link is a plain navigation (ninth-round simplification) to the existing "Vendor Bills (AP)" tab and its pre-existing, unmodified vendor-bill detail modal, whose already-gated pay/credit/cancel/reverse actions (corrected wording, finding NEW-2 — a prior revision understated this as "the one write action"; corrected again, finding NEW-6 — pay/credit are gated by `requirePermission('vendors','edit')`, cancel/reverse-payment by `requirePermission('vendors','delete')`, not uniformly by `'edit'`) are reused completely unchanged, under their existing, unmodified gates. This feature does not change, expand, or promise access to any of them. |
| II. Historical Financial Data Must Be Preserved | **PASS** | Legacy journal rows stay read-only, sourced via the existing, already-fixed `/statement` endpoint; no migration or rewrite planned. |
| III. Production Safety | **PASS** | This is a planning artifact only; no production/demo/Mongo/Render access occurs in this phase. |
| IV. Data Preservation and Backups | N/A this phase | No destructive operation is planned by this feature at all (read-only + one unchanged existing write path). |
| V. Tenant Isolation and Security | **PASS** | Every reused route already sits behind the global `requireAuth`+`tenantMiddleware` gate (server.js:1327) plus its own `requirePermission(...)` check; the one new backend touch (aging `vendorId` filter) inherits the route's existing `requirePermission('financials','view')` gate — no new permission surface. |
| VI. Persistence / Concurrency Reality | **PASS** | No new persisted entity, no new write path, no schema change; single-instance assumption unaffected. |
| VII. Canonical Calculations | **PASS** | GL balance via the existing `buildBalanceMap()`; reconciliation via the existing statement endpoint's own reconciliation block, reused for both summary card and full statement (satisfies clarify Q1); aging bucket math untouched, only filtered. |
| VIII. Testing Before Confidence | **PASS** | See this file's own Project Structure section below (`tests/` tree) for the full list of extended/new test files — existing test files identified for extension rather than duplication. *(Corrected, twelfth round, finding DANGLING-COMPLETION-REPORT-CITATION: a prior revision cited a "Completion Report" that does not exist anywhere in this repository or its Spec Kit templates; the substance was always present in this document's own Project Structure section instead.)* |
| IX. Demo / Production Isolation | N/A | This feature has no demo-specific behavior; `DEMO_MODE` does not exist on this branch at all. |
| X. No Uncontrolled Scope Expansion | **PASS** | Scoped strictly to spec.md's FRs; the aging filter is framed as the one minimal, precedented backend addition, not a broader refactor. |
| XI. Auditability | **PASS** | No new privileged/financial write path is introduced; the existing, already-`appendAuditEvent`-covered bill-payment route is reused unchanged. |
| XII. Deployment Control | N/A this phase | Planning only; the constitution's SPEC→…→DEPLOY pipeline still governs when/if this is eventually shipped. |
| XIII. Spec Kit Usage | **PASS** | Following the sequence exactly: `/speckit-specify` → `/speckit-clarify` → `/speckit-plan` (this) → `/speckit-tasks` next. |

No gate failures. **Complexity Tracking is empty** — no violation requires justification.

## Project Structure

### Documentation (this feature)

```text
specs/001-vendor-ap-workspace/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
server.js                          # ONE additive change: optional ?vendorId= filter on
                                    # GET /api/ap-aging (server.js:8728), reusing existing
                                    # bucket logic unchanged. No other backend file touched.

public/index.html                  # Enhancement of the existing vendor workspace surface:
├── #vendorStmtModal                 (~line 5564) — extend with summary-card fields
├── openVendorStatement()/           (~line 9738) — existing entry point, enhanced.
│   loadVendorStatement()            (~line 9753)   loadVendorStatement() now performs a
│                                                     SECOND, genuinely new fetch — GET
│                                                     /api/vendor-bills?vendorId=<id> — in
│                                                     addition to its existing statement fetch
│                                                     (finding I1 — this data was never already
│                                                     available; see research.md Decision 4/11),
│                                                     stored in a NEW, workspace-local variable,
│                                                     _vndWorkspaceBills (~line 9588, next to
│                                                     currentVendorId) — NOT the AP tab's _vbBills
│                                                     (ninth-round simplification: the two contexts
│                                                     no longer share a click-through path, so
│                                                     there is nothing to keep synchronized between
│                                                     them). All four of loadVendorStatement()'s
│                                                     user-visible outcomes (the statement/
│                                                     reconciliation write, the vendor-bills-
│                                                     derived write, T008's failure-state write,
│                                                     and — eleventh round, finding
│                                                     STALE-TOAST-1-DOC-GAP — the pre-existing
│                                                     statement-fetch's own error-toast branch) now
│                                                     carry an async-recency guard — a single
│                                                     request-generation counter, _vndStmtReqSeq,
│                                                     incremented per call and re-checked
│                                                     immediately before each (finding AUDIT-VBWS-2,
│                                                     kept and simplified this round from a
│                                                     vendor-id comparison, per finding TRACE-1). A
│                                                     superseded call can no longer surface stale
│                                                     data, a stale empty/error state, or a stale
│                                                     toast over the vendor now active. T011
│                                                     (finding STMT-FETCH-FAILURE-FABRICATES-ZERO;
│                                                     rewritten thirteenth round, findings
│                                                     T011-CATCH-FALLTHROUGH-OVERWRITES-ERROR-STATE
│                                                     [CRITICAL] / T011-404-CHECK-INSERTION-POINT-
│                                                     FICTIONAL [HIGH] / T011-WRONG-404-TASK-
│                                                     REFERENCE [MEDIUM]) now OWNS the statement
│                                                     fetch's ENTIRE response-branching structure —
│                                                     success, vendor-not-found, and general failure
│                                                     — not just the general-failure branch a first,
│                                                     since-corrected attempt covered. The fetch's
│                                                     outcome is classified explicitly into one of
│                                                     three mutually exclusive states, tracked in a
│                                                     local variable starting pessimistic ('error'):
│                                                     'notfound' if r.status===404 (checked BEFORE
│                                                     the general !r.ok branch, and built directly
│                                                     here — the twelfth round's fix wrongly cited a
│                                                     "pre-existing" 404 check that never existed
│                                                     under any task number); 'error' if !r.ok, a
│                                                     network throw, OR — new this round — a 200
│                                                     response whose body fails a minimum-shape
│                                                     check (Array.isArray(rows) &&
│                                                     typeof endingBalance==='number', matching the
│                                                     documented contract and server.js:6523-6526)
│                                                     so an unusable-but-200 body is never mistaken
│                                                     for success; 'success' otherwise. The
│                                                     PRE-EXISTING success-path render code (the
│                                                     summary/reconciliation area AND the statement
│                                                     activity section, previously unconditional) is
│                                                     RELOCATED — not merely supplemented — into the
│                                                     'success' branch, so a failed or not-found
│                                                     load can never fall through into it: this is
│                                                     the CRITICAL fix itself — the first attempt
│                                                     rendered an error state inside catch{} but left
│                                                     the old unconditional render code in place
│                                                     right after it, silently overwriting that error
│                                                     state with a fabricated 0 balance / absent-
│                                                     therefore-reconciled badge before repaint. The
│                                                     'error' and 'notfound' branches each render
│                                                     their own genuine load/error or vendor-not-
│                                                     found state for both areas instead — never a
│                                                     fabricated 0, never a silently-reconciled
│                                                     badge, never an empty-but-confirmed activity
│                                                     table. Because the three branches are mutually
│                                                     exclusive and none contains an await, ONE
│                                                     _vndStmtReqSeq recency check placed immediately
│                                                     before the three-way branch — not one per
│                                                     branch — suppresses a stale success render, a
│                                                     stale not-found render, a stale error render,
│                                                     AND a stale error toast alike. There is no bare
│                                                     return anywhere in this logic besides that one
│                                                     recency check, so T007's own, separate vendor-
│                                                     bills fetch (Open Bills/overdue/open-items) and
│                                                     T026's AP-aging fetch always still run and
│                                                     render on their own independent outcomes,
│                                                     regardless of which of the three statement
│                                                     outcomes fires. T013 (below the checkpoint) no
│                                                     longer adds the 404 branch — it is retargeted,
│                                                     thirteenth round, to verifying the 'notfound'
│                                                     branch T011 already builds, mirroring T012's
│                                                     own already-verification-only pattern. See
│                                                     research.md Decision 13, spec.md FR-024,
│                                                     data-model.md, and contracts/vendor-ap-
│                                                     workspace-api.md for the fully consistent,
│                                                     independently-verified mechanism.
├── loadVendorBills()                (~line 13466) — PRE-EXISTING AP-tab function, modified for
│   (modified, tenth round)                            the first time: gains a small request-
│                                                        generation counter, _vbBillsReqSeq
│                                                        (findings T015-STATUS-FILTER-NOT-SYNCED /
│                                                        T015-DOUBLE-LOADVENDORBILLS-NO-RECENCY-
│                                                        GUARD) — whichever of two overlapping
│                                                        calls to it was started later always wins,
│                                                        regardless of network resolution order.
│                                                        Needed because openVendorBillFromWorkspace
│                                                        (below) and showTab()'s own internal
│                                                        dispatch (line 6149) both call this
│                                                        function in quick succession; incidentally
│                                                        hardens the AP tab's own pre-existing
│                                                        behavior too, not only this feature's use
├── openVendorBillFromWorkspace(id)  (~line 9820,   — NEW, small function (T016, ninth round;
│   (new function, corrected             near            corrected tenth AND eleventh rounds):
│    eleventh round)                                     the open-item click handler no longer
│                                                        opens #vbDetailModal stacked on top of
│                                                        #vendorStmtModal (the sixth-through-
│                                                        eighth rounds' design, removed after three
│                                                        consecutive audits found new UI-state-
│                                                        lifecycle defects in it — see research.md
│                                                        Decision 3/4). It reuses the app's own
│                                                        pre-existing "redirect to AP" pattern (the
│                                                        same one recordVendorPayment() already
│                                                        uses, ~9802-9808), in this order: call the
│                                                        existing, unmodified populateVbVendorSelects()
│                                                        FIRST (eleventh-round fix, finding
│                                                        T016-VENDOR-FILTER-SYNC-RACE — #vbVendorFilt
│                                                        holds no real <option>s until this runs,
│                                                        under the plan's own primary "direct-to-
│                                                        workspace" case, so the vendor-filter
│                                                        assignment below would otherwise silently
│                                                        no-op); reset #vbVendorFilt AND #vbStatusFilt
│                                                        to currentVendorId / neutral BEFORE
│                                                        navigating (tenth-round fix — a prior draft
│                                                        synced after navigating, letting showTab()'s
│                                                        own internal loadVendorBills() call fire
│                                                        with stale filters) — this filter change is
│                                                        an explicit product decision (eleventh
│                                                        round, finding T016-FILTER-RESET-
│                                                        UNDOCUMENTED-UX-SIDEEFFECT), not an
│                                                        incidental side effect: no capture/restore
│                                                        of the AP tab's prior filter state is added;
│                                                        navigate to "Vendor Bills (AP)", explicitly
│                                                        await the now-guarded loadVendorBills() (no
│                                                        more arbitrary setTimeout), then call the
│                                                        existing, unmodified openVbDetail(id) —
│                                                        guarded by its own small reentrancy counter,
│                                                        _vndDeepLinkSeq, so a newer click always
│                                                        wins over an older, still-in-flight one
├── #vbDetailModal / openVbDetail(id) (~line 13568) — target view AND openVbDetail(id) itself
│                                                     reused completely unchanged (corrected
│                                                     citation, finding NEW-1 — a prior revision
│                                                     cited ~13489, inside the unrelated
│                                                     renderVendorBills() render loop). No new
│                                                     module-scoped state is added to this modal
│                                                     or its four write-action handlers anymore —
│                                                     the entire _vbDetailFromWorkspace/write-
│                                                     context/z-index/close-affordance mechanism
│                                                     from prior rounds is removed, not patched
│                                                     (closes findings K1/K2/NEW-3/NEW-4/
│                                                     AUDIT-VBWS-1/AUDIT-VBWS-3/AUDIT-VBWS-4/
│                                                     UI-1/UI-2/UI-3/AUDIT-CLOSE-1/NEW-AUDIT-1/
│                                                     TRACE-1 by removing their shared premise).
│                                                     The two pre-existing AP-tab call sites
│                                                     (~13491, ~13497) are untouched by this
│                                                     feature. See research.md Decision 3/4.
├── #ledgerEntryModal /              (~line 15589,  — target DETAIL VIEW reused unchanged; the
│   showLedgerEntry(id)                9329)           legacy-journal row's click wiring to it
│                                                      is new (small task, finding F2 —
│                                                      statement rows carry no onclick today).
│                                                      NOT viewJournal(id)/#journalModal (finding
│                                                      G1 — that pairing was wrong; viewJournal(id)
│                                                      opens the editable form, never used here).
│                                                      NOT "read-only" (finding H4 correction) —
│                                                      this modal has its own pre-existing,
│                                                      already-gated Edit/Delete actions; this
│                                                      feature's click-through is view/navigation
│                                                      only and changes no RBAC/write path
├── #tab-aging / loadAgingAP()       (~line 13244) — visual/badge pattern reused for
│                                                     the workspace's own reconciliation badge
├── #vndSearch/#vndTypeFilt/         (~line 3093)  — extended with an "outstanding only" /
│   #vndBalFilt / renderVendors()                    "overdue only" option, not rebuilt; search
│                                                     minimally extended in place to also match
│                                                     account code (finding H1 — reverted from a
│                                                     shared-module extraction; no new file)
└── existing inline empty-state      (~line 9637,   — reused, unchanged, for every "no
    styling (text-align:center;       13200, 13250,    results"/"not found" state this feature
    color:var(--text3); padding)      13303)            adds, including vendor-not-found (finding
                                                        G4). NOT the `.empty-state` CSS class
                                                        (finding H5 correction — that class is
                                                        defined but unused dead code; the real,
                                                        already-live convention is this inline
                                                        style, already visible on the vendor grid
                                                        and the AP-aging tab this feature extends)

tests/
├── p3-vendor-statement-hotfix.test.js   # extend: add summary-vs-statement-reconciliation-
│                                          agreement cases (existing file, existing pattern)
├── p0-7-ap-lifecycle.test.js            # extend: add vendor-scoped AP-aging filter cases,
│                                          incl. asserting grandTotal/reconciliation stay
│                                          firm-wide under the filter (finding H3) (shared
│                                          backend behavior — this file already owns AP-aging
│                                          coverage; corrected per finding F3, which is why
│                                          "open-items derivation" is NOT listed here — see
│                                          the line below instead)
├── rbac-and-audit.test.js               # extend: add workspace-route RBAC cases, incl. the
│                                          new GET /api/ap-aging?vendorId= filter
└── p3-vendor-ap-workspace.test.js       # NEW: workspace-specific composition cases —
                                           open-items derivation (incl. the credited-to-zero
                                           case, finding F1), date-range-vs-reconciliation,
                                           outstanding/overdue filters, cross-view
                                           no-duplication. (Vendor search, finding H1, is
                                           verified manually via quickstart.md instead — no
                                           unit test file for it.)
```

**Structure Decision**: No new top-level directories, and no new files at all (finding H1 confirms this holds even for vendor search, which was briefly proposed as needing a new shared file and has been reverted). This is an in-place enhancement of the existing monolith (`server.js` for the one additive backend filter, `public/index.html` for the UI), following the project's own established pattern of extending a large single file rather than splitting into new modules — consistent with Principle X (No Uncontrolled Scope Expansion) and the IMPLEMENTATION PREFERENCE for minimal, additive change. This statement is now internally consistent throughout the document (finding H1's prior version had a self-contradiction here against the Project Structure table's "new, small, shared file" line — resolved by removing that line entirely).

## Complexity Tracking

*(Empty — no constitution gate was violated by this plan.)*
