# Feature Specification: Tenant Isolation & Safe Backup/Restore Hardening

**Feature Branch**: `002-tenant-isolation-backup-hardening`

**Created**: 2026-09-05

**Status**: Draft — awaiting `/speckit-clarify`

**Input**: User description: "P4 — a major hardening phase for Boubyan Accounting, not a new accounting feature. Design and implement a safe tenant-isolation and tenant-scoped backup/restore architecture without risking current production data. The two most important problems: (1) tenant isolation must remain correct across all shared Mongo-backed collections and process-level caches/state, (2) backup/restore must support one tenant without creating whole-instance blast radius."

**Preceding work**: A read-only architecture audit (Phase 1) and risk register (Phase 2) were completed before this spec was written. Their findings are summarized in the P4 Architecture Audit report delivered alongside this spec, and are referenced here only where they define *why* a requirement exists — the full file:line evidence trail belongs in `research.md`, produced later by `/speckit-plan`, not duplicated here.

## Clarifications

*(none yet — this section is populated by `/speckit-clarify`)*

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A tenant's own data is the only data any of its requests can ever see or change (Priority: P1)

An operator onboards a second paying clinic onto the platform. From that moment on, nothing either clinic's staff does — logging in, viewing a vendor, changing a setting, running a report, using the Telegram bot, waiting for the nightly automation to run — can ever show them the other clinic's data, or change a number the other clinic's accounting depends on.

**Why this priority**: This is the precondition for the platform being safe to sell to more than one customer at all. Everything else in this spec (backup, restore) only matters once this is true; a backup/restore system that perfectly protects an unsafe tenant boundary still ships an unsafe product.

**Independent Test**: With two active tenants seeded with distinguishable data, exercise every documented shared-state surface (see the audit's Process-Global-State findings) from Tenant A's authenticated session and confirm none of it reflects or mutates Tenant B's data, including surfaces that are not simple HTTP request/response pairs (a background scheduler tick, an inbound Telegram bot message, a settings write that feeds automated journal posting).

**Acceptance Scenarios**:

1. **Given** Tenant A and Tenant B both exist, **When** Tenant A's admin changes any application-wide-looking setting (fee rates, commission formula, branding, SMTP credentials) via the settings UI, **Then** Tenant B's own settings, and any calculation Tenant B's data feeds (e.g. automatically-posted journal entries), are unaffected.
2. **Given** Tenant A and Tenant B both exist, **When** either tenant's own scheduled background automation runs (inventory check, monthly report, hourly posting engine), **Then** it operates only on the tenant it was scheduled for — no scheduled job may silently execute against a different tenant's data, and no tenant's automation may silently never run at all without that being an explicit, documented product decision.
3. **Given** a tenant integrates an external notification channel (e.g. Telegram) with the application, **When** that channel delivers inbound data (a file, a message) or receives an outbound broadcast, **Then** the data is attributed to, and the broadcast reflects, that tenant's own records only.
4. **Given** a request arrives with no tenant context, an unrecognized tenant, or a tenant that has been deactivated, **When** it reaches any route that touches tenant-owned data, **Then** the system rejects it rather than silently serving or writing to a default/fallback tenant's data.
5. **Given** any two tenants share the same underlying Mongo collections, **When** either tenant's data is created, read, updated, or deleted through the application's normal write paths (not just its read paths), **Then** the operation is provably scoped to that tenant at the database-query level, not only at the in-memory cache level.

---

### User Story 2 - An operator can back up exactly one tenant, and knows what they got (Priority: P2)

An operator (or a scheduled job acting on an operator's behalf) needs to capture one tenant's data — for migration, for a support investigation, for a pre-restore safety net — without capturing every other tenant sharing the same database, and without having to guess afterward what the resulting file actually contains.

**Why this priority**: A tenant-scoped restore (User Story 3) is meaningless without a tenant-scoped backup to restore from. This also stands alone as real value: today, taking a backup for any single-tenant purpose still means handling a file containing every other paying customer's complete accounting data, which is itself a real handling/confidentiality risk this story removes.

**Independent Test**: With at least two tenants holding distinguishable data, request a backup for exactly one named tenant, and confirm the resulting artifact contains only that tenant's records, records unambiguous tenant identity and enough metadata (timestamp, format/schema version, record counts, integrity check) that its contents can be verified without a live database, and that requesting a backup for an unrecognized tenant fails rather than silently producing an empty or whole-instance file.

**Acceptance Scenarios**:

1. **Given** two or more tenants exist, **When** an operator requests a backup scoped to Tenant A, **Then** the resulting artifact contains Tenant A's records only — no record belonging to Tenant B, or to any other tenant, appears in it.
2. **Given** a completed tenant-scoped backup artifact, **When** it is inspected without a live database connection, **Then** its own metadata alone (not inference from its contents) identifies which tenant it belongs to, when it was created, its format/schema version, how many records of each kind it contains, and an integrity check sufficient to detect corruption or truncation.
3. **Given** a request to back up a tenant identifier that does not exist or is not active, **When** the backup is attempted, **Then** it fails with a clear error and produces no artifact, rather than succeeding with an empty or wrong-scope file.
4. **Given** the existing whole-instance backup capability continues to exist for legitimate whole-instance use (e.g. disaster recovery of the entire platform), **When** a tenant-scoped backup is requested instead, **Then** the two remain clearly distinguishable operations with clearly distinguishable output — an operator can never mistake one for the other by looking at the artifact alone.

---

### User Story 3 - Restoring one tenant never touches another tenant's data (Priority: P1)

An operator needs to recover a single tenant's data from a backup — because that tenant's own data was corrupted or accidentally deleted — on a shared instance that also serves other active tenants, without any of those other tenants experiencing data loss, a service interruption, or a silent change to their own records.

**Why this priority**: This is the other half of the platform's core safety precondition alongside User Story 1. A shared-database multi-tenant platform is not viable to operate if the only way to fix one customer's data problem is an operation that can destroy every other customer's data — this is not a hypothetical: the audit confirms the current restore mechanism does exactly that today.

**Independent Test**: With at least two tenants holding distinguishable, verifiable data, restore Tenant A from a Tenant-A-only backup while Tenant B remains active on the same instance, and confirm Tenant B's data, login capability, and configuration are provably unchanged before and after — including under a deliberately interrupted/failed restore attempt.

**Acceptance Scenarios**:

1. **Given** Tenant A and Tenant B both hold data on the same instance, **When** an operator restores Tenant A from a Tenant-A-scoped backup, **Then** every one of Tenant B's records (across every collection Tenant A's restore touches) is unchanged, and Tenant B's users can still log in and see their own data exactly as before the restore.
2. **Given** a backup file that is malformed, from an incompatible format/schema version, or does not match the tenant identity the operator specified, **When** a restore is attempted with it, **Then** the restore is refused before any destructive action is taken, with a clear reason.
3. **Given** a restore operation is interrupted partway through (a crash, a network failure, a manual abort), **When** the operator investigates afterward, **Then** the system's own state (not just the operator's memory of what step it reached) makes it possible to determine whether the target tenant's data is now fully restored, fully original, or in a known partial state — and provides a documented path back to a consistent state in every case. An unrecoverable, undetectable mixed state is not an acceptable outcome of a failed restore.
4. **Given** a completed, successful tenant-scoped restore, **When** the restored tenant's accounting data is examined, **Then** every journal entry, balance, and historical record matches the backup exactly — the restore process never invents a balancing entry, never silently drops a record it could not restore, and never "fixes" a discrepancy it notices on its own initiative.
5. **Given** an operator provides a backup and a target that do not match (e.g. a backup for Tenant A pointed at "restore Tenant B", or a backup whose declared tenant identity does not match its own record contents), **When** the restore is attempted, **Then** it is rejected before any write occurs, rather than trusting the operator's stated intent over the backup's actual, verifiable contents.

### Edge Cases

- What happens when a request's tenant context is missing, expired, malformed, or references a suspended/deleted tenant? Every route that touches tenant-owned data must reject it — never silently serve or write default-tenant data on its behalf, and never silently serve or write to whatever tenant happened to be resolved by a prior, unrelated request on the same process.
- What happens when a background job (scheduler, integration callback) has no natural per-request tenant context to inherit? It must still resolve to a specific, correct tenant for whatever data it is about to touch — either because it is explicitly iterating known tenants one at a time with a real tenant context established for each, or because the feature it powers is explicitly scoped to remain single-tenant-only until a later phase, and that limitation is documented, not silent.
- What happens when two tenants' records could otherwise collide on a non-tenant-scoped key (e.g. two tenants seeding a user with the same literal id, or two tenants' records sharing a lookup key that isn't itself tenant-qualified)? The system must not let one tenant's write on that key ever reach, overwrite, or delete the other tenant's record.
- What happens when an operator backs up a tenant that has zero data yet (a brand-new signup)? The backup succeeds and correctly represents "this tenant, with no records," not an error and not another tenant's data.
- What happens when a tenant-scoped restore target already has data that isn't in the backup being restored (e.g. changes made since the backup was taken)? This must be an explicit, informed decision surfaced to the operator before the restore proceeds — never a silent, unannounced loss of the tenant's own more-recent data.
- What happens when the underlying database deployment does not support multi-document transactions reliably (confirmed true for the current architecture — see the audit's persistence findings)? The tenant-scoped restore design must not assume transactional all-or-nothing semantics it cannot actually get from the current infrastructure; it must achieve the same safety guarantee (no observable inconsistent state survives a failure) through a means the current architecture genuinely supports.
- What happens when a whole-instance (all-tenants) backup or restore is still genuinely needed (true disaster recovery)? That capability must continue to exist and must remain clearly, unmistakably distinct from the new tenant-scoped operations — this feature narrows what a *tenant-scoped* operation can reach, it does not remove the platform's ability to do a full, deliberate, whole-instance operation when that is genuinely what is being asked for.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every tenant-owned record MUST have exactly one authoritative tenant identity, and every read or write of that record MUST be scoped by that identity at the point the database is actually queried — not only at an in-memory cache layer that sits in front of the database.
- **FR-002**: Any code path that touches tenant-owned data MUST fail closed (reject the operation) when the tenant context for that request is missing, unrecognized, or ambiguous. It MUST NOT fall back to a default tenant's data, and MUST NOT fall back to whichever tenant happened to be active in a prior, unrelated call on the same process.
- **FR-003**: No process-wide, module-level, or otherwise shared piece of application state MAY hold or return tenant-dependent content unless it is explicitly keyed by tenant identity. Where a piece of shared state is determined to be single-tenant by architectural necessity (not merely unfinished), that limitation MUST be an explicit, documented product decision, not a silent gap.
- **FR-004**: Any scheduled or background process that touches tenant-owned data MUST establish an explicit, correct tenant context for each tenant it processes before touching that tenant's data — it MUST NOT default to a single implicit tenant merely because it was not invoked from within a tenant-scoped request.
- **FR-005**: The system MUST provide a way to produce a backup artifact scoped to exactly one named, existing, active tenant, containing no record belonging to any other tenant.
- **FR-006**: Every backup artifact (tenant-scoped or whole-instance) MUST record, in its own metadata, at minimum: which tenant(s) it covers, when it was created, its format/schema version, a per-collection record count, and an integrity check sufficient to detect corruption or truncation without needing a live database to verify against.
- **FR-007**: Requesting a tenant-scoped backup for a tenant identifier that does not exist, or is not active, MUST fail with a clear error and produce no artifact.
- **FR-008**: The system MUST provide a way to restore exactly one named tenant's data from a tenant-scoped backup, such that no other tenant's records (in any collection the restore touches) are read, modified, or deleted as a result.
- **FR-009**: The system MUST NOT provide, as part of this feature, any new way for a whole-instance (all-tenants) destructive restore to be triggered more easily or with fewer safeguards than exist today; the existing whole-instance capability MAY continue to exist for genuine disaster-recovery use, but MUST remain clearly distinguished from — and never be the accidental result of — a tenant-scoped restore request.
- **FR-010**: Before any destructive restore action is taken, the system MUST validate, in order: that the backup file is well-formed and of a compatible format/version; that the backup's own declared tenant identity is unambiguous; and that the tenant identity being restored matches what the operator explicitly specified as the target. A validation failure at any of these steps MUST prevent all writes for that restore attempt.
- **FR-011**: A restore operation that fails or is interrupted partway through MUST leave the system in a state from which an operator can determine, without guessing, whether the target tenant's data is fully restored, unchanged from before the attempt, or in a specific, documented partial state — and MUST NOT leave any *other* tenant's data touched at all as a result of that failure.
- **FR-012**: Restore MUST NOT invent a balancing or correcting journal entry, MUST NOT silently discard a record it is unable to restore, and MUST NOT automatically "repair" a discrepancy it detects between the backup and the current state — any such discrepancy MUST be surfaced to the operator and MUST block the restore (or the affected portion of it) rather than being resolved automatically.
- **FR-013**: The tenant-scoped restore design MUST NOT depend on multi-document database transactions being available, unless a specific investigation (recorded in `research.md` once `/speckit-plan` runs) confirms the current production database deployment reliably supports them. Where transactions are not available, the design MUST achieve equivalent safety (no destructive step taken before it is safe to do so; no observable inconsistent state survives a failure) through a means the current architecture actually supports (e.g. staged/shadow-copy validation before an atomic-enough swap, or an explicitly recoverable checkpoint sequence) rather than assuming atomicity it cannot get.
- **FR-014**: This feature MUST NOT change canonical journal-posting logic, MUST NOT alter historical journal entries or balances outside of a legitimate, operator-directed restore, and MUST NOT introduce any automatic data "repair" or reconciliation-adjustment behavior anywhere in the tenant-isolation or backup/restore code paths.

### Out of Scope

- Redesigning the accounting engine, journal-posting logic, or any existing financial calculation.
- Billing, subscription, or customer-onboarding feature work beyond what tenant isolation itself requires to be correct.
- Any new accounting module or user-facing accounting feature.
- A general-purpose distributed-systems platform, message queue, or new microservice — this remains the existing single-process monolith; multi-instance/horizontal-scaling support is explicitly not a goal of this feature (the audit confirms the current architecture is deliberately single-instance for reasons independent of tenant isolation).
- New infrastructure (a new datastore, a new message broker, a new hosting platform) unless the threat model produced in this phase concludes the current infrastructure genuinely cannot deliver the required safety guarantees at all — the default assumption is that the existing Mongo-backed monolith is sufficient.
- Any change to how a genuinely whole-instance (all-tenants) backup or restore is performed, beyond making it clearly distinguishable from the new tenant-scoped operations.
- Any production data change, production reset, production seed, or production migration performed as part of specifying, planning, or implementing this feature.
- Any deployment activity performed as part of specifying, planning, or implementing this feature.

### Key Entities *(include if feature involves data)*

- **Tenant**: An existing entity (already modeled) identifying one customer/clinic. This feature does not change what a Tenant is; it changes what is guaranteed about every other entity's relationship to it.
- **Tenant-Owned Record**: Any persisted record (a user, a journal entry, a chart-of-accounts entry, a vendor, a configuration value, an idempotency record, etc.) that conceptually belongs to exactly one tenant. This feature's central concern is that every such record's tenant identity is authoritative and enforced, not merely present.
- **Tenant-Scoped Backup Artifact**: A new kind of backup output, distinct from today's whole-instance backup, containing only one tenant's records plus enough self-describing metadata (tenant identity, timestamp, format/schema version, record counts, integrity check) to be verified and safely restored without additional context.
- **Restore Operation**: The process of applying a backup artifact (tenant-scoped or whole-instance) back into the live system. This feature defines a new, safe tenant-scoped variant; the existing whole-instance variant is preserved for legitimate disaster-recovery use.
- **Shared Process-Level State**: Any in-memory cache, singleton, or module-level variable that is not itself a persisted record but can influence what tenant-owned data a request sees or changes (e.g. a shared configuration cache, a shared external-integration client). This feature's tenant-isolation concern applies here too, not only to database collections.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With two or more tenants active on the same instance, 100% of the shared-state surfaces identified in the P4 audit (configuration, external-integration singletons, scheduled automation) are demonstrated — by an automated, repeatable test — to be tenant-isolated or explicitly, documentedly single-tenant-by-design; zero are left silently unaddressed.
- **SC-002**: A tenant-scoped backup of a tenant with a realistic volume of data, followed by a tenant-scoped restore of that same tenant onto an instance that also holds a second, untouched tenant's data, results in zero observable change to the second tenant's records, login capability, or configuration.
- **SC-003**: 100% of attempted tenant-scoped restores using a backup that is malformed, wrong-version, or tenant-mismatched are rejected before any write occurs — zero such attempts result in any data mutation.
- **SC-004**: A deliberately interrupted tenant-scoped restore, when investigated afterward, allows an operator to determine the exact resulting state (fully restored / fully original / documented partial state) without needing to inspect raw database contents by hand — and in every case, the previously-active *other* tenant's data is confirmed unchanged.
- **SC-005**: Every accounting record present in a tenant immediately before a tenant-scoped backup is taken is present, byte-for-byte unchanged, in that tenant immediately after that backup is successfully restored onto a fresh or corrupted copy of that tenant's data — zero invented, dropped, or "repaired" records.
- **SC-006**: The existing single-tenant ("default" clinic) production behavior — every currently-passing accounting, RBAC, and workflow test — continues to pass unchanged after this feature ships.

## Assumptions

- The current architecture (Node/Express monolith, MongoDB as the primary persistence layer with a file-fallback mode, single-process/single-instance deployment) remains the foundation this feature builds on; nothing in this feature requires or assumes a move to a different backend, a different deployment topology, or multiple concurrent application instances.
- Multi-document Mongo transactions are not assumed to be available; the actual current deployment's transaction feasibility (replica-set status, driver/version support) will be verified as part of `/speckit-plan`'s `research.md`, and the design will not rely on an assumption the codebase's own constitution already states is not generally used today.
- "Tenant isolation" in this spec covers every shared-state surface identified by the P4 audit (Mongo collections, the process-wide configuration cache, the external Telegram-bot integration singleton, scheduled background automation) — not database collections alone.
- The existing whole-instance backup/restore capability (`scripts/backup.js`, `scripts/restore.js`) continues to exist for genuine disaster-recovery use; this feature adds a new, additional, tenant-scoped capability rather than removing or replacing the whole-instance one.
- All specification, planning, implementation, and testing work for this feature uses isolated test data only; no production database is read from, written to, reset, seeded, or migrated as part of delivering this feature, and no deployment occurs as part of it.
- This feature is architecture/safety hardening, not a new user-facing accounting capability; where a functional requirement here would otherwise change accounting math, journal-posting behavior, or historical records outside of an operator-directed restore, that requirement is out of scope by construction (see FR-014).
