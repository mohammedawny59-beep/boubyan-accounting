<!--
Sync Impact Report
Version change: (none — template only) → 1.0.0
Change type: Initial ratification
Modified principles: n/a (first authored version)
Added principles:
  I. Accounting Integrity Is Non-Negotiable
  II. Historical Financial Data Must Be Preserved
  III. Production Safety
  IV. Data Preservation and Backups
  V. Tenant Isolation and Security
  VI. Persistence / Concurrency Reality
  VII. Canonical Calculations
  VIII. Testing Before Confidence
  IX. Demo / Production Isolation
  X. No Uncontrolled Scope Expansion
  XI. Auditability
  XII. Deployment Control
  XIII. Spec Kit Usage
Added sections: Known Architectural Risks & Non-Goals; Governance
Removed sections: n/a
Template note: the template's second generic "Additional Constraints" slot
  (SECTION_3) was intentionally left unused — the 13 Core Principles plus
  Known Architectural Risks fully cover this project's governance needs;
  no further generic section was needed. Not a deferred TODO.
Deferred TODOs: none — all placeholder tokens resolved.
Templates requiring alignment review (not modified in this task, out of
  scope per this command's Scope Guard): .specify/templates/plan-template.md,
  spec-template.md, tasks-template.md, checklist-template.md. Recommend a
  follow-up pass to confirm none of them embed assumptions that conflict
  with this version.
-->

# Boubyan Accounting Constitution

## Core Principles

### I. Accounting Integrity Is Non-Negotiable
Every financial write MUST go through the repository's canonical journal
validation path (`appendJournalEntry()` / `validateJournalEntry()` in
`lib/journalGuard.js`) — never a direct `journalEntries.push()` or an
equivalent bypass. Every posted entry MUST balance (debit == credit within
the existing tolerance) and MUST be rejected if it carries a negative
amount, a dual-sided line, or a posting to an unknown, group, inactive, or
system-reserved account. Any write dated into a period recorded in
`db.lockedPeriods` MUST be rejected (IAS 8) — for creation, edit, and
deletion alike, including cascaded/linked entries. No feature may balance
a discrepancy with a hidden or manual plug entry. Any spec/plan touching
journal posting, account balances, AP, AR, payroll, assets, bank
reconciliation, or financial statements MUST define explicit accounting
reconciliation tests as acceptance criteria before `/speckit-implement`
may run against it.

### II. Historical Financial Data Must Be Preserved
Never silently rewrite, reclassify, delete, "normalize," or migrate
historical financial records merely to make a new feature's data model
fit. Prefer, in this order: compatibility layers, read-time
normalization, additive migration, accountant-approved corrections, and
reversals — over destructive rewriting of history. Existing production
financial history is authoritative evidence; a new feature adapts to it,
not the reverse. Any migration touching financial history MUST have,
before it runs against production: explicit owner approval, a verified
backup, a dry run in an isolated reproduction, a documented before/after
reconciliation, and a rollback plan.

### III. Production Safety
Production holds real clinic data. No Spec Kit workflow may reset, seed,
or restore production, modify production Mongo manually, change
production environment variables, deploy automatically, or run a
destructive migration — unless the product owner explicitly authorizes
that exact action. Default validation against production is READ-ONLY.
Production deployment is always a separate, explicit step, performed only
after isolated tests, full regression, review, and owner approval — never
an automatic continuation of implementation.

### IV. Data Preservation and Backups
Before any risky production change: create or verify a trusted backup,
verify its integrity, and preserve the rollback code/version. Restore is
never a casual debugging mechanism — it requires explicit target
verification and owner approval, matching the existing
`--target=<name>` + typed-confirmation gate in `scripts/restore.js`. This
gate MUST NOT be weakened, defaulted, or bypassed by a feature that finds
it inconvenient.

### V. Tenant Isolation and Security
Every authenticated data path MUST preserve tenant isolation, RBAC,
server-side permission enforcement, and fail-closed authorization,
matching the existing `requireAuth` + `tenantMiddleware` +
`requirePermission` / `requireAdminAction` pattern. UI hiding is never
sufficient authorization by itself. Stale client-side roles or
permissions MUST NOT be trusted whenever live server-side validation is
available. Any new write endpoint's spec MUST explicitly state its
authentication requirement, its tenant scope, its permission requirement,
and its audit behavior before implementation begins.

### VI. Persistence / Concurrency Reality
The current single-instance safety assumption (in-process cache,
in-memory rate limiter and bot state, debounced full-document writes) is
preserved unless a future milestone explicitly redesigns persistence and
concurrency together. No feature may introduce horizontal scaling,
multiple live writers, or multi-instance assumptions without first
addressing process-global state, in-memory caches, scheduled jobs,
persistence semantics, idempotency, and restore blast radius as one
reviewed change. Multi-instance safety MUST NOT be assumed by default for
any new feature.

### VII. Canonical Calculations
Reuse the existing canonical helpers — `buildBalanceMap()` for GL
balances, the existing reconciliation logic, and `lib/journalGuard.js`
for journal validation — rather than writing a parallel implementation. A
duplicate calculation path is permitted only with a documented reason and
explicit tests proving equivalence to the canonical path. The
trial-balance endpoint's separate, non-canonical aggregation loop is a
known, accepted risk area (see Known Architectural Risks) and MUST NOT be
used as a template for new report code.

### VIII. Testing Before Confidence
Every feature spec MUST define its acceptance tests before implementation
begins. Where applicable, a spec MUST include: targeted regression tests,
accounting reconciliation tests, tenant-isolation tests, RBAC negative
tests, legacy-data compatibility tests, idempotency tests, and
failure/rollback tests. Tests run only against isolated test databases,
matching the existing `mongodb-memory-server` harness pattern in
`tests/helpers/mongoTestHarness.js`, which verifies a database's
test-only identity before any destructive action. Test infrastructure
MUST NEVER be capable of dropping or resetting a production-like
database. Full regression is required before any change becomes a
production deployment candidate.

### IX. Demo / Production Isolation
Demo and production are separate environments. Demo-specific
functionality MUST NOT depend on production Mongo, secrets, credentials,
integrations, or data. Demo reset functionality MUST fail closed unless
the connected database is positively identified as a demo database —
never default-allow. No production data may ever be copied into a demo
dataset, in whole or in part.

### X. No Uncontrolled Scope Expansion
A milestone implements only its approved scope. While implementing one
feature: do not opportunistically refactor unrelated modules, do not fix
unrelated bugs unless they block the feature, do not change dependencies
without need, and do not casually redesign architecture. Newly discovered
unrelated defects are documented as a separate, later item, not folded
into the current change.

### XI. Auditability
New privileged or financial functionality MUST use the canonical audit
mechanism (`appendAuditEvent()` in `lib/auditLog.js`) unless a documented
exception is recorded in the spec. The existing direct `db.auditLog`
writes that bypass `appendAuditEvent()` (password-reset, startup
auto-repair, COA fix-codes) are recorded technical debt — not a pattern
to copy into new code.

### XII. Deployment Control
CI success is not equivalent to deployment approval. The required
workflow for a feature is: SPEC → PLAN → TASKS → IMPLEMENT → TEST →
ANALYZE/CONVERGE → OWNER REVIEW → CONTROLLED DEPLOY → READ-ONLY
POST-DEPLOY VALIDATION. No workflow may automatically proceed from
implementation into a production deployment step.

### XIII. Spec Kit Usage
For a substantial feature, use the Spec Kit sequence: `/speckit-specify`
→ `/speckit-clarify` → `/speckit-plan` → `/speckit-tasks` →
`/speckit-analyze` → `/speckit-implement` → `/speckit-converge`.
Completing `/speckit-implement` is never, by itself, permission to
deploy. Product-owner approval remains required for every production
action, independent of which Spec Kit phase has completed.

## Known Architectural Risks & Non-Goals

These are recorded as known, accepted state — not to be fixed as part of
constitution adoption, and not to be treated as license to replicate the
same pattern in new code:

- `GET /api/trial-balance` uses its own separate aggregation loop instead
  of the canonical `buildBalanceMap()`, a documented historical source of
  silently dropped entries.
- Several direct `db.auditLog` writes bypass `appendAuditEvent()`
  (password-reset, startup auto-repair, COA fix-codes) — see Principle
  XI.
- `/api/auth/login` has no dedicated `rateLimit()` wrapper the way
  `/api/auth/forgot` and `/api/auth/reset` do; it relies only on
  per-identity progressive lockout plus the blanket per-path rate limit.
- The current architecture is single-instance constrained (Principle VI)
  — a real limit, not an oversight to silently work around.
- Multi-document Mongo ACID transactions (`session.withTransaction`) are
  not generally used; consistency instead relies on idempotency
  unique-indexes and durable-flush writes.

## Governance

This constitution supersedes ad-hoc practice for all Spec Kit-driven work
on this project. Any amendment requires product-owner review and
explicit approval before being written back to
`.specify/memory/constitution.md`, and MUST be recorded in a Sync Impact
Report (prepended as an HTML comment) stating the version change, the
principles touched, and any deferred items.

Versioning follows semantic versioning: MAJOR for a backward-incompatible
principle removal or redefinition, MINOR for a new principle or
materially expanded guidance, PATCH for wording or clarification only.

`/speckit-plan` and `/speckit-analyze` MUST check a plan against every
Core Principle above before `/speckit-implement` is allowed to proceed. A
plan that conflicts with a Principle must either be revised or receive an
explicit, owner-approved, documented exception before implementation.

**Version**: 1.0.0 | **Ratified**: 2026-08-29 | **Last Amended**: 2026-08-29
