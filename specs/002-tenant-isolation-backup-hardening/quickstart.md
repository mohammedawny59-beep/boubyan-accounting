# Quickstart: Verifying Tenant Isolation + Backup/Restore Hardening (P4)

All steps run against an **isolated local/test environment** — `DB_FILE_ONLY=true` or a `mongodb-memory-server` instance started via `tests/helpers/mongoTestHarness.js`. None of these steps touch production or demo. This mirrors the existing project convention (see `feedback-staging-environment-safety` operating note) rather than inventing a new verification environment.

## 1. Prerequisite: two tenants with colliding identifiers

Seed data deliberately shaped to reproduce the original bugs, not just "two tenants with different data":
- Tenant `default` and a second tenant `acme` (or any real-flow-registered tenant id).
- Give both a user with the **same** `id` value (e.g. `usr-1`) and an `EntityChunk` with the **same** `key` (e.g. `vendors`) but different `data`.
- This is the exact shape that made `persistUsers()`/`persistEntityKey()`'s unscoped filters dangerous — two tenants sharing an identifier value is normal (ids are assigned per-tenant, not globally), not a contrived edge case.

## 2. Verify tenant-safe Mongo writes (A)

1. As `default`, trigger any write that flows through `saveDB()` (e.g. create/edit an expense).
2. Re-read `acme`'s `usr-1` user and `vendors` entity chunk directly from Mongo.
3. Expected: byte-identical to before step 1. Before this phase's fix, `acme`'s documents could be deleted or overwritten by `default`'s own save.

## 3. Verify tenant-safe config (B)

1. As `acme`, change a config value (e.g. a fee rate or branding field) via whatever route calls `saveConfig()`.
2. As `default`, call `loadConfig()` (any route that reads config).
3. Expected: `default` never sees `acme`'s value, and vice versa. Before this phase's fix, there was exactly one shared `_configCache` for every tenant in the process.

## 4. Verify Telegram/monitor default-only boundary (C)

1. As an authenticated `acme` user with the relevant permission, call each of: `POST /api/telegram/start`, `POST /api/monitor/inventory`, `POST /api/monitor/monthly-report`, `POST /api/reports/send-telegram`.
2. Expected: `403` with `code: 'TELEGRAM_DEFAULT_TENANT_ONLY'` on all four, and no message sent / no bot state changed.
3. Repeat as a `default`-tenant user: expected unchanged, pre-existing behavior (regression guard).

## 5. Verify tenant-scoped backup (D)

```
node scripts/tenant-backup.js --tenant=acme
```
1. Expected: `backups/tenant-acme-<stamp>.json` created, `scope:'tenant'`, `tenantId:'acme'`.
2. Open the file; confirm zero documents belong to `default` or any other tenant.
3. Run `node scripts/tenant-backup.js` (no `--tenant=`): expected non-zero exit, no file written.
4. Run `node scripts/tenant-backup.js --tenant=default`: expected the legacy no-`tenantId`-field seed data from step 1 IS present.

## 6. Verify tenant-scoped restore (E/F) — full staged sequence

1. Mutate `acme`'s data further (so it now differs from the step-5 backup).
2. `node scripts/tenant-restore.js backups/tenant-acme-<stamp>.json --tenant=acme --target=local-test --yes`
3. Expected: `acme`'s data matches the backup exactly; `default`'s data (and any other seeded tenant) is byte-identical to before the restore.
4. Inspect `backups/.restore-checkpoints/<runId>.json`: `stage:'completed'`, `collectionsSwapped` includes every expected collection.

## 7. Verify restore rejects the wrong input (E)

1. Feed `acme`'s tenant-scoped backup with `--tenant=default` (mismatched target): expected hard rejection, zero writes, before any Mongo connection's data is touched.
2. Feed a whole-instance backup file (from `npm run backup`) into `tenant-restore.js`: expected rejection at the `scope` check, zero writes.

## 8. Verify partial-failure recovery is deterministic (F)

1. Using a test hook or manual interruption, force `tenant-restore.js` to fail after the `users` collection swaps but before `entityChunks`.
2. Expected: `acme`'s `users` now match the backup; `acme`'s `entityChunks`/`appConfigs` are unchanged from before the restore attempt; checkpoint file shows `collectionsSwapped: ['users']`, `stage:'failed'`.
3. Re-run the same command: expected it completes successfully with no leftover synthetic `__restage__` documents in any collection afterward.

## 9. Whole-instance path regression check (H)

1. Run the existing `npm run backup` / `npm run restore -- --target=local-test` exactly as before this phase.
2. Expected: byte-identical behavior to before this phase — these two scripts are not modified at all.

## 10. Full regression

```
npm test
```
Expected: the full existing suite still passes (single-tenant/`default` behavior is a required regression target per spec.md, "Regression" test category), plus every new test file this phase adds (see `plan.md` Project Structure).
