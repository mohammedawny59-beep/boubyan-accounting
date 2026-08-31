# Data Model: Vendor / Accounts Payable Workspace Upgrade

**No new entities and no schema changes.** This feature is a read-composition layer over existing, already-persisted entities. Every field below is already present on the underlying record today (per Phase 0 research); nothing here is added by this feature.

## Vendor (existing — `db.vendors[]`)

| Field | Source | Notes |
|---|---|---|
| `id` | server.js:5870 | primary key |
| `accountId` | server.js:5871 | GL account code for this vendor's payable account |
| `name` | server.js:5872 | |
| `phone`, `email`, `address` | server.js:5874-5876 | optional; displayed only if present (FR-001) |
| `openingBalance`, `openingDate` | set via `setVendorOpening()` | source of the statement's opening-balance row |

**Citation correction (finding NEW-5, documentation-only)**: the per-field lines above were each off by 1-3 lines against the live source (e.g. `id`/`accountId`/`name` were all previously cited at the object-literal's opening line, 5869, rather than their own individual lines). Corrected against a direct read of `server.js`'s `newVendor` object literal. This never affected any decision, task, or contract — the broader, functionally-relied-upon citation elsewhere in this document set (research.md Decision 5: "server.js:5869-5881") was already correct.

## Vendor Bill (existing — `db.vendorBills[]`)

| Field | Source | Notes |
|---|---|---|
| `id`, `vendorId`, `billNumber`, `billDate`, `dueDate` | server.js:6044-6058 | `dueDate` drives client-side overdue derivation (Decision 4) |
| `grossAmount`, `paidAmount`, `creditedAmount`, `outstandingAmount` | server.js:6044-6058, recomputed at server.js:6214-6216 | `outstandingAmount` is what the open-items list and reconciliation both key off |
| `status` | `POSTED` \| `PARTIALLY_PAID` \| `PAID` \| `CANCELLED` (server.js:5971) | no `OVERDUE` value exists — overdue is a derived, not stored, state |
| `payments[]`, `credits[]` | server.js:6044-6058 | source of the statement's payment/credit rows |
| `journalId`, `source`/`sourceId` | server.js:6055-6056 | how the statement endpoint excludes this bill's own JEs from the legacy-journal merge |

## Legacy Journal Activity (existing — `db.journalEntries[]`, filtered)

| Field | Source | Notes |
|---|---|---|
| `id`, `date`, `desc`/`description`, `ref`/`reference` | server.js:6497-6503 | rendered as a `type:'legacy-journal'` statement row |
| `lines[].accountCode` / `.accountId` / `.account` | server.js:6491-6494 | string-normalized match against the vendor's `accountId` |
| `source`, `sourceId` | server.js:6485-6489 | how double-counting against modern bills/opening is excluded |

Not a new entity — surfaced strictly read-only via the existing statement endpoint; never migrated or rewritten (Principle II).

## AP Aging Bucket (existing — computed by `GET /api/ap-aging`)

| Field | Source | Notes |
|---|---|---|
| `current`, `days30`, `days60`, `over90` | server.js:8788-8794 | bucket boundaries: `<=30` / `31-60` / `61-90` / `>90` days, unchanged by this feature. **Correction, eleventh round**: the live bucket object also initializes a fifth key, `days90` (server.js:8788), but the endpoint's own if/else chain (server.js:8790-8793) never assigns to it — it is permanently `0` and never populated, a pre-existing, dead key this feature does not touch, read, or rely on. |
| per-vendor row: `vendor`, `total`, `buckets`, `count`, `items[]` | server.js:8797 | Decision 2 adds an optional `vendorId` request filter over these rows — the row shape itself is unchanged |

## Vendor Workspace Summary (NEW — derived, not persisted)

Not a database entity. Assembled entirely at request/render time from the entities above; nothing new is written to storage.

| Field | Composed from |
|---|---|
| Vendor identity (name, account code, contact) | `GET /api/vendors` (existing list, client-side lookup) |
| Current GL payable balance, statement balance, reconciliation status/difference | `GET /api/vendors/:id/statement` → `.reconciliation` (Decision 1 — single shared source) |
| Open Bills total, overdue amount | Client-side aggregation over `GET /api/vendor-bills?vendorId=` — **a genuinely new fetch performed by `loadVendorStatement()` itself** (finding I1 correction; see Decision 4/11 — this data was never already available in the workspace's own code path), stored in a **workspace-local variable, `_vndWorkspaceBills`** (ninth round — see below) |
| Next/current open item(s) | Same open-items derivation, most-overdue-first, reusing the same fetch above |
| Total AP Exposure (aging breakdown) | `GET /api/ap-aging?vendorId=` (Decision 2), kept separately labeled from Open Bills (Decision 8) — a legitimately broader, differently-scoped figure, never forced to agree |

**Design simplification, ninth round — the workspace's bill data no longer touches the AP tab's `_vbBills` (closes findings I1/J1/K1/K2/NEW-3/NEW-4/AUDIT-VBWS-1/AUDIT-VBWS-3/AUDIT-VBWS-4/UI-1/UI-2/UI-3/AUDIT-CLOSE-1/NEW-AUDIT-1/TRACE-1)**: earlier rounds required `loadVendorStatement()`'s vendor-bills fetch to also assign into the AP tab's own, pre-existing `_vbBills` array, because the workspace used to open the bill-detail modal (`#vbDetailModal`) directly, stacked on top of itself, and that modal reads exclusively from `_vbBills`. Three consecutive `/speckit-analyze` rounds each found a new UI-state-lifecycle defect in that design (a CSS-stacking bug that made the modal invisible, an unsafe write-context marker, an incomplete close-affordance enumeration, a same-vendor write race) — each individually fixed, each time revealing an adjacent gap. The product decision this round removes the design rather than patching it a fourth time: clicking an open item (T015) now closes the workspace and navigates to the existing "Vendor Bills (AP)" tab, where the AP tab's own, completely unmodified `loadVendorBills()` populates `_vbBills` itself, before the existing, unmodified `openVbDetail(id)` opens the bill in its normal, single-context home. The workspace's own bill data (`_vndWorkspaceBills`) and the AP tab's `_vbBills` are now two fully independent arrays serving two fully independent contexts — there is no click-through path between them left to keep synchronized, so there is nothing left to get out of sync.

**Fetch independence and failure handling (finding I1/J2, Decision 12, spec.md FR-023)**: the statement fetch and the vendor-bills fetch are independent. If the vendor-bills fetch fails, the bill-level fields above show a clear load/error state (reusing the real inline empty-state convention, Decision 7) — never a fabricated `0`/empty result, and no automatic retry — while the statement/reconciliation fields render normally if their own fetch succeeded.

**The statement/reconciliation fetch's own failure now degrades the same way, twelfth round (finding STMT-FETCH-FAILURE-FABRICATES-ZERO, Decision 13, spec.md FR-024) — corrected thirteenth round (findings `T011-CATCH-FALLTHROUGH-OVERWRITES-ERROR-STATE`, `T011-404-CHECK-INSERTION-POINT-FICTIONAL`, `T011-WRONG-404-TASK-REFERENCE`)**: symmetrically, if the *statement* fetch fails (any non-2xx response, a network error, or a `200` response with an unusable body — missing/wrong-typed `rows`/`endingBalance`), the GL balance, statement balance, reconciliation status, and statement activity fields above show a clear load/error state — never `0`, and never a reconciliation status presented as confirmed when it is actually unknown — while the bill-level (open items) and AP aging fields render normally if their own, independent fetches succeeded. The twelfth round's first attempt at this guarantee rendered the error state inside the fetch's `catch` block but never stopped the pre-existing, unconditional success-path render code from running immediately afterward and silently overwriting it — caught by the required final gate check before implementation. The corrected mechanism (tasks.md T011) tracks the fetch's outcome explicitly (`'success' | 'notfound' | 'error'`) and gates every statement-dependent render behind it, so the failure state can no longer be overwritten, while the independent vendor-bills fetch still runs unconditionally afterward regardless of outcome. Before the twelfth round, only the vendor-bills fetch's failure was guarded this way; the statement fetch's own failure silently fell through to a fabricated `0`/`null` state that the reconciliation badge rendered indistinguishably from "genuinely reconciled" — a real gap, since this fetch backs the workspace's own headline figures.

**A stale, slower response must never overwrite a newer one — kept and simplified to a generation counter (finding AUDIT-VBWS-2)**: `loadVendorStatement()`'s two fetches can still overlap across a vendor switch, or across two reopenings of the same vendor's workspace before an earlier call resolves — this property is unrelated to the removed nested-modal design and remains fully in scope, for workspace *reads* only (there is no more write-triggered refresh to guard, since there is no more write-triggered refresh at all). A single monotonically-increasing counter, incremented at the top of every call and re-checked immediately before every write point — **corrected thirteenth round, finding `DATAMODEL-RECENCY-GUARD-ENUM-INCOMPLETE`: this enumeration previously listed only three of the four guarded outcomes, silently omitting the vendor-bills fetch's own failure write** — (a) the statement/reconciliation success write, (b) the vendor-bills-derived success write, (c) — eighth round, finding I1/J2, spec.md FR-023 — the vendor-bills fetch's own failure write, and (d) — tenth round, finding STALE-TOAST-1 — the statement fetch's own error/not-found outcomes too, now all behind the single `outcome`-gated check described above — discards a response if a newer call has since started — one mechanism covering both the cross-vendor and same-vendor cases, not a vendor-id comparison (which the eighth round used, and which finding TRACE-1 showed misses the same-vendor case).

**The navigation function itself needed the same discipline applied to it, tenth round (findings T015-STATUS-FILTER-NOT-SYNCED, T015-DOUBLE-LOADVENDORBILLS-NO-RECENCY-GUARD, T015-NO-REENTRANCY-GUARD)**: removing the nested modal did not, by itself, guarantee the replacement navigation was correct. A fresh-perspective audit found `openVendorBillFromWorkspace(id)` (T016) never reset the AP tab's own status filter (silently excluding the target bill if left on a non-matching value) and set its vendor filter *after* triggering `showTab()`, whose own internal `loadVendorBills()` call fired first with the stale value — a real race, since `loadVendorBills()` (a pre-existing function, otherwise unmodified) had no ordering guard of its own. Fixed with the same class of mechanism used elsewhere in this document: both filters now reset before `showTab()` runs, `loadVendorBills()` itself gains a small request-generation counter (`_vbBillsReqSeq`, T015) so whichever of two overlapping calls started later always wins, and the navigation function gains its own independent counter (`_vndDeepLinkSeq`) so a newer click always suppresses an older, still-in-flight one's detail-open. Neither counter is shared with `loadVendorStatement()`'s own `_vndStmtReqSeq` — each guards a distinct function's own concern, following the same minimal, repeated pattern rather than a shared framework.

## State Transitions

None introduced. The only state machine involved (`VendorBill.status`: `POSTED → PARTIALLY_PAID → PAID`, or `→ CANCELLED`) already exists and is not modified by this feature — the workspace only reads it.

**Important nuance (added after `/speckit-analyze` finding F1)**: this state machine is **not exhaustive of every path to a zero `outstandingAmount`**. A bill fully offset via credit notes alone (`POST /api/vendor-bills/:id/credit`, `postVendorBillCredit()` at server.js:6318-6364) never transitions to `PAID` — only the payment path (server.js:6216) sets `status='PAID'`. Any "is this bill open" check this feature performs MUST therefore key off `status !== 'CANCELLED' && status !== 'PAID' && outstandingAmount > 0.001` together (see research.md Decision 4), never `status` alone.
