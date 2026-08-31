# Feature Specification: Vendor / Accounts Payable Workspace Upgrade

**Feature Branch**: `chore/spec-kit-adoption` (no dedicated feature branch — no `before_specify` git hook is configured in this repository, so branch creation was skipped; per Spec Kit's own decoupling of spec directories from branch names, this spec lives at `specs/001-vendor-ap-workspace/` regardless of which branch it is later implemented on)

**Created**: 2026-08-29

**Status**: Draft

**Input**: User description: "Build a production-safe Vendor / Accounts Payable Workspace Upgrade for Boubyan Accounting. Improve the existing Vendor / AP experience so an accountant can open any vendor and understand the full payable position quickly and confidently without navigating multiple disconnected screens. Enhancement of existing functionality, not a rebuild of AP."

## Clarifications

### Session 2026-08-29

- Q: Should the vendor workspace's summary reconciliation status (FR-003) and the full vendor statement's reconciliation summary (FR-011) be guaranteed to always agree with each other — i.e., computed by one single shared check rather than two independently-implemented ones? → A: Yes — a single shared reconciliation check (Option A). The workspace card and the full statement must always report the identical reconciled/difference value; they must never be allowed to disagree.
- Q: When an accountant applies a date range filter to the vendor statement, should the reconciliation summary keep showing reconciliation for the vendor's full, unfiltered history, or recalculate for just the filtered range? → A: Full, unfiltered history always (Option A). The date-range filter narrows only which rows are listed; the reconciliation summary never changes because of it.
- Q: Should the vendor's GL reconciliation figures be visible to every role that can already view vendor/AP data today, or restricted to accountant/admin roles specifically? → A: No new restriction (Option A). Reconciliation figures follow whatever access control already gates this vendor's data today; no new, narrower permission tier is introduced for them.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand a vendor's payable position at a glance (Priority: P1)

An accountant opens a vendor's workspace and immediately sees who the vendor is, how much is currently owed, how much of that is overdue, and whether the vendor's own statement agrees with the general ledger — without opening any other screen.

**Why this priority**: This is the core value of the feature. Every other capability exists to support or drill into this single view. On its own, it already replaces the accountant's current need to cross-reference multiple screens just to answer "how much do we owe this vendor, and can I trust that number?"

**Independent Test**: Open any existing vendor with posted activity and confirm the workspace displays vendor identity, current GL payable balance, statement/subledger balance, reconciliation status, total outstanding AP, and overdue amount — all sourced from the application's existing balance and reconciliation logic, with no new calculation introduced.

**Acceptance Scenarios**:

1. **Given** a vendor with a mix of paid, partially paid, and open bills, **When** the accountant opens that vendor's workspace, **Then** the workspace shows the vendor's name, account code, current GL payable balance, statement balance, and a reconciliation status (reconciled / not reconciled with a difference amount).
2. **Given** a vendor whose statement balance matches the GL exactly, **When** the workspace loads, **Then** the reconciliation status is shown as reconciled with no warning.
3. **Given** a vendor whose statement balance does not match the GL, **When** the workspace loads, **Then** a clear warning is shown stating the exact difference, and no data is changed automatically.
4. **Given** a brand-new vendor with no activity yet, **When** the accountant opens that vendor's workspace, **Then** all balances display as zero and the workspace loads without error.

---

### User Story 2 - Review which bills are still open (Priority: P2)

An accountant looks at a vendor's unpaid and partially paid bills to decide what still needs attention, without hunting through the full transaction history.

**Why this priority**: This is the next most common accountant task after "how much do we owe" — deciding what to act on. It is independently valuable even without the full chronological statement.

**Independent Test**: Open the open-items list for a vendor with at least one fully paid bill, one partially paid bill, and one fully unpaid bill, and confirm only the partially paid and unpaid bills appear, each with correct remaining balance.

**Acceptance Scenarios**:

1. **Given** a vendor with bills in different payment states, **When** the accountant views open items, **Then** only bills that are unpaid or partially paid appear, each showing reference, bill date, due date, original amount, amount paid/credited, remaining balance, and whether it is overdue.
2. **Given** a bill that has been fully paid, **When** the accountant views open items, **Then** that bill does not appear in the open-items list.
3. **Given** a bill with a partial credit/reversal applied against it, **When** the accountant views its remaining balance, **Then** the remaining balance reflects both payments and credits, not payments alone.
4. **Given** an open item the application already has a detail view for, **When** the accountant selects it, **Then** they are taken to that existing detail view rather than a new, separate one.

---

### User Story 3 - Review the full vendor statement, including history predating the current bill-tracking system (Priority: P3)

An accountant reviews a vendor's complete chronological activity — including activity recorded before the vendor-bill system was introduced — to understand exactly how the current balance was reached, with no entry counted twice.

**Why this priority**: This preserves and surfaces the legacy-compatibility behavior already fixed in the vendor statement, and is essential for vendors with a long history, but a user can already get the headline numbers from User Story 1 without needing the full statement.

**Independent Test**: Open the statement for a vendor known to have both modern vendor-bill activity and older, pre-vendorBills journal activity, and confirm every amount appears exactly once, legacy rows are visually distinguishable from modern rows, and the statement's ending balance matches the GL.

**Acceptance Scenarios**:

1. **Given** a vendor with an opening balance, **When** the accountant opens the statement, **Then** the opening balance appears as the first row.
2. **Given** a vendor with both vendor-bill activity and older direct-journal activity for the same account, **When** the accountant opens the statement, **Then** every amount appears exactly once — no activity is shown both as a modern bill row and as a legacy journal row.
3. **Given** a statement containing a legacy (pre-vendorBills) row, **When** the accountant views it, **Then** that row is clearly and visibly labeled as legacy/historical, distinct from modern rows.
4. **Given** a fully rendered statement, **When** the accountant reaches the end, **Then** a reconciliation summary shows the statement's ending balance, the GL balance, the difference, and whether they reconcile.
5. **Given** a vendor with payments and credits/reversals recorded, **When** the accountant reviews the statement, **Then** those payments and credits appear in chronological order alongside the bills and journal rows they relate to.

---

### User Story 4 - Understand a vendor's AP aging position (Priority: P4)

An accountant sees how much of a vendor's balance is current versus overdue, using the same aging model already used elsewhere in the application, so the vendor-level view agrees with the firm-wide AP aging report.

**Why this priority**: Aging context deepens the picture from User Story 1's single "overdue amount" figure into a fuller breakdown, but the single headline overdue figure already covers the most common question.

**Independent Test**: Compare a vendor's aging breakdown shown in the workspace against that same vendor's row in the application's existing AP aging report and confirm the bucket totals match exactly.

**Acceptance Scenarios**:

1. **Given** a vendor with bills in different age ranges, **When** the accountant views the vendor's aging breakdown, **Then** the buckets and totals match the application's existing AP aging model exactly — no new bucket boundaries are introduced.
2. **Given** a vendor with no overdue bills, **When** the accountant views aging, **Then** all amounts appear in the current bucket and the overdue total is zero.
3. **Given** the same vendor's totals appear in both the vendor workspace and the firm-wide AP aging report, **When** both are compared, **Then** the total outstanding figures agree.

---

### User Story 5 - Search and filter vendors and their open items (Priority: P5)

An accountant narrows a long vendor list or a vendor's own activity to just what they need — outstanding vendors, overdue items, a date range, or a specific activity type — instead of scanning everything.

**Why this priority**: This is a usability layer on top of Stories 1-4; it makes them faster to use but is not itself a standalone source of new information, so it is valuable only once those views exist.

**Independent Test**: Apply "outstanding only" and "overdue only" filters independently to a vendor list containing a mix of vendors and confirm each filter narrows the list correctly and can be cleared.

**Acceptance Scenarios**:

1. **Given** a list of vendors with and without outstanding balances, **When** the accountant applies "outstanding only," **Then** only vendors with a non-zero outstanding balance appear.
2. **Given** a vendor's open items with and without overdue bills, **When** the accountant applies "overdue only," **Then** only overdue items appear.
3. **Given** a vendor's statement, **When** the accountant sets a date range, **Then** only statement rows within that range appear, while the reconciliation summary continues to show the reconciliation for the vendor's full, unfiltered history, unchanged by the filter.
4. **Given** any filter is active with no matching results, **When** the accountant views the filtered list, **Then** a clear "no results" state is shown rather than an empty or broken screen.
5. **Given** the accountant types a vendor name or code into vendor search, **When** results update, **Then** only matching vendors appear.

### Edge Cases

- What happens when a vendor's statement balance and GL balance disagree? The workspace and statement both show a clear warning with the exact difference; nothing is auto-corrected and no historical data is altered.
- What happens when a vendor has only legacy (pre-vendorBills) journal activity and no modern bills at all? The workspace, open items, statement, and aging views must all still function correctly and show accurate figures, with no error and no crash.
- What happens when a vendor has an opening balance but zero activity since? The workspace shows the opening balance as the current balance, reconciled, with no open items.
- What happens when a bill has one or more credits/reversals applied? Its remaining/outstanding amount reflects payments and credits together, not payments alone.
- What happens when an accountant filters for "overdue only" or "outstanding only" and there are no matches? A clear empty state is shown, not an error or a blank screen.
- What happens when a vendor has a very large volume of historical statement activity? The statement and open-items views remain usable (e.g., via the date-range filter), without requiring the accountant to load the entire history at once to get an answer.
- What happens when the accountant navigates to a vendor's workspace for a vendor that has since been deleted or does not exist? A clear "vendor not found" state is shown instead of a broken or partially-populated screen.
- What happens when the vendor's bill-level data (open bills, outstanding/overdue amounts) fails to load while the rest of the workspace loads successfully? The bill-level section shows a clear load/error state — never a fabricated zero, and never an empty list presented as confirmed data. The statement/reconciliation section, sourced independently, still renders normally if its own data loaded successfully. No automatic write or retry occurs as a result of this failure (see FR-023).
- What happens when the vendor's statement/reconciliation data (GL balance, statement balance, reconciliation status, statement activity) fails to load while the rest of the workspace loads successfully? The summary/reconciliation area and the full statement's activity section both show a clear load/error state — never a fabricated zero balance, and never a reconciliation status presented as confirmed (reconciled or otherwise) when it is actually unknown. The bill-level (open items) and AP-aging sections, sourced independently, still render normally if their own data loaded successfully. No automatic write or retry occurs as a result of this failure (see FR-024).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The vendor workspace MUST display the vendor's name, account/vendor code, and any contact information already present on the vendor record.
- **FR-002**: The vendor workspace MUST display the vendor's current GL payable balance and its statement/subledger balance, computed using the application's existing canonical balance and reconciliation logic — no new balance-calculation method may be introduced for this feature.
- **FR-003**: The vendor workspace MUST display a reconciliation status (reconciled or not) and, when not reconciled, the exact difference amount, with a clearly visible warning. This status MUST be produced by the exact same reconciliation check as the full statement's reconciliation summary (FR-011) — the two MUST NEVER disagree.
- **FR-004**: The vendor workspace MUST display total outstanding AP and the overdue amount for the vendor.
- **FR-005**: The vendor workspace MUST display the vendor's next/current open item(s) as a summary, in addition to the full open-items list (User Story 2).
- **FR-006**: The system MUST provide a list of the vendor's unpaid and partially paid bills, each showing reference, bill date, due date, original amount, amount paid/credited, remaining balance, and overdue state, where that data is available on the underlying record.
- **FR-007**: A fully paid or fully credited bill MUST NOT appear in the open-items list.
- **FR-008**: Where the application already has an existing detail view for an open item's underlying record (bill or journal entry), selecting that item MUST navigate to that existing view rather than introducing a new, separate detail view.
- **FR-009**: The vendor statement MUST continue to include, without double-counting: the opening balance, modern vendor-bill activity, legacy direct-journal activity, payments, and credits/reversals — preserving the compatibility behavior already implemented for legacy vendor history.
- **FR-010**: Legacy (pre-vendorBills) rows in the vendor statement MUST remain visually and structurally distinguishable from modern rows.
- **FR-011**: The vendor statement MUST include a reconciliation summary showing the statement's ending balance, the GL balance, the difference, and whether they reconcile — computed using the application's existing reconciliation logic, not a newly written one. This is the single shared reconciliation check also used by the workspace summary's reconciliation status (FR-003); there is exactly one reconciliation calculation for a vendor, never two.
- **FR-012**: The vendor's AP aging breakdown MUST use the same bucket definitions the application's existing AP aging model already uses; this feature MUST NOT introduce new bucket boundaries.
- **FR-013**: The vendor-level aging totals MUST agree with the same vendor's totals in the application's existing firm-wide AP aging report.
- **FR-014**: The system MUST support filtering the vendor list by outstanding-balance-only and support filtering a vendor's open items by overdue-only.
- **FR-015**: The system MUST support filtering a vendor's statement by date range and by activity type. Applying a date range MUST only narrow which rows are listed — the reconciliation summary (FR-011) MUST continue to reflect the vendor's full, unfiltered history and MUST NOT be recalculated for the filtered range.
- **FR-016**: The system MUST support searching vendors by name or code.
- **FR-017**: Any filter or search that returns no results MUST present a clear empty state rather than an error or a blank screen.
- **FR-018**: All balances, activity, and history shown anywhere in the vendor workspace MUST be derived from the application's existing vendor-bill records, statement logic, journal links, and payment records — this feature MUST NOT create a second, parallel source of vendor activity history.
- **FR-019**: Any existing write action reachable from the vendor workspace (e.g., recording a payment) MUST continue to use its current, unmodified posting path — this feature MUST NOT introduce a new journal-posting path.
- **FR-020**: When a reconciliation difference is detected, the system MUST NOT automatically create a balancing/correcting journal entry or alter historical records — the workspace only displays the warning.
- **FR-021**: The vendor workspace MUST visually match the application's current design language; this feature MUST NOT introduce a new visual design system.
- **FR-022**: The vendor workspace, including its reconciliation figures (FR-003, FR-011), MUST be visible to exactly the same set of roles that can already view this vendor's data today. This feature MUST NOT introduce a new, narrower permission tier restricting reconciliation data, and MUST NOT expand any role's visibility beyond what it can already see.
- **FR-023**: If the vendor's bill-level data (open bills, outstanding/overdue amounts) cannot be loaded while the workspace is open, the system MUST NOT fabricate a zero outstanding/open-bills figure, and MUST NOT present an empty open-items list as if it were confirmed, correct data. The system MUST instead show a clear load/error state for the bill-level section specifically. The statement/reconciliation section (FR-002, FR-003, FR-011) MAY still render normally if its own, independently-sourced data loaded successfully — one section's data failing to load MUST NOT be treated as a failure of the whole workspace. The system MUST NOT automatically retry the failed load or perform any write as a result of this failure.
- **FR-024** *(added, twelfth remediation round, finding STMT-FETCH-FAILURE-FABRICATES-ZERO)*: If the vendor's statement/reconciliation data (GL balance, statement balance, reconciliation status, statement activity) cannot be loaded while the workspace is open — whether due to a network error, a server error, or an unusable response — the system MUST NOT fabricate a zero GL/statement balance, and MUST NOT present the reconciliation status as reconciled, or as any other confirmed status, when it is actually unknown. The system MUST instead show a clear load/error state for both the summary/reconciliation area and the full statement's activity section. The bill-level (open items, FR-023) and AP aging (FR-012/FR-013) sections MAY still render normally if their own, independently-sourced data loaded successfully — one section's data failing to load MUST NOT be treated as a failure of the whole workspace. The system MUST NOT automatically retry the failed load or perform any write as a result of this failure.

### Out of Scope

- Redesigning the Accounts Payable module as a whole.
- Any change to canonical journal-posting logic, the Chart of Accounts, Trial Balance calculation, or Balance Sheet calculation.
- Rewriting, reclassifying, or migrating historical vendor data, including migrating legacy journal activity into the vendorBills model.
- Any change to vendor opening balances.
- Automatic creation of correction or balancing journal entries.
- Any production data change, production reset, production seed, or production migration.
- Any deployment activity.

### Key Entities *(include if feature involves data)*

- **Vendor**: The party being paid; identified by name and account/vendor code, with an opening balance and optional contact details. Already exists; not modified by this feature.
- **Vendor Bill**: A modern AP obligation with an original amount, amount paid, amount credited, remaining outstanding amount, due date, and status. Already exists; not modified by this feature.
- **Legacy Journal Activity**: Historical postings against a vendor's account recorded before the vendor-bill model existed. Already exists; surfaced read-only, never migrated or rewritten by this feature.
- **Vendor Payment / Credit**: A payment or credit/reversal applied against a vendor bill, reducing its outstanding amount. Already exists; not modified by this feature.
- **AP Aging Bucket**: The existing current/overdue bucket classification applied to outstanding vendor amounts. Already exists; reused, not redefined, by this feature.
- **Vendor Workspace Summary**: A read-only, derived view combining a vendor's identity, GL balance, statement balance, reconciliation status, total outstanding, overdue amount, and next open items. Not a new persisted entity — it is assembled at display time from the entities above.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a vendor's workspace alone, an accountant can state how much is currently owed to that vendor within 30 seconds.
- **SC-002**: From a vendor's workspace alone, an accountant can state how much of that balance is overdue within 30 seconds.
- **SC-003**: From a vendor's workspace alone, an accountant can identify which bills are still open within 30 seconds.
- **SC-004**: From a vendor's workspace alone, an accountant can identify what payments have been made and how they affected the balance within 30 seconds.
- **SC-005**: From a vendor's workspace alone, an accountant can explain why the current balance is what it is (the underlying activity) within 30 seconds.
- **SC-006**: From a vendor's workspace alone, an accountant can state whether the vendor's statement reconciles to the GL, and if not, by how much, within 30 seconds.
- **SC-007**: 100% of vendor statements produced by the workspace either reconcile exactly to the GL or clearly display the exact difference — never a silent, unexplained mismatch.
- **SC-008**: 100% of vendors with activity recorded before the modern vendor-bill system show that historical activity correctly in the workspace and statement, with zero amounts counted twice.
- **SC-009**: For a vendor with a typical volume of activity (up to a few hundred statement lines), the vendor workspace, statement, and aging views each become usable within a couple of seconds of being opened.

## Assumptions

- The existing vendor statement's composition rules (opening balance, modern vendor-bill activity, legacy journal activity, payments, credits, no double-counting) are reused as-is; this feature changes how that information is surfaced, not how it is computed.
- The existing AP aging model's bucket definitions are reused unchanged; this feature does not define new aging thresholds.
- "Contact information" means whatever contact fields already exist on the vendor record today; this feature does not add new contact fields to the vendor data model.
- Deep-linking from an open item goes to whatever existing detail view the application already uses for that record type; if no such view exists for a given record type, the item is instead shown as read-only summary data in place.
- Navigating from a vendor's workspace into one of its open bills (FR-008) sets the destination "Vendor Bills (AP)" screen's own vendor and status filters to match that context — the workspace's vendor, and all statuses, so the target bill is never hidden by an unrelated filter left over from an earlier visit. This is treated as expected navigation context, not as an unwanted side effect: the accountant has just indicated, by clicking, that this vendor's AP context is what they want to see next. The AP screen's own filters are not captured or restored to their prior state afterward — this feature does not add filter-state preservation for this navigation.
- This is a read/display-oriented enhancement built entirely on existing data and existing write/posting paths; any write action already reachable from the vendor area continues to work exactly as it does today.
- All specification, planning, implementation, and testing work uses isolated test data only; no production database is written to, reset, seeded, or migrated as part of delivering this feature, and no deployment occurs as part of it.
- The application's current visual design language and component patterns are reused; no new design system is introduced.
