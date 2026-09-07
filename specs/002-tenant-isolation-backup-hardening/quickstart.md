# Quickstart: Verifying Tenant Isolation + Backup/Restore Hardening (P4)

**Revised through Design Remediation Passes 1-5** — steps 6-8 rewritten for the offline-staging redesign; steps 9-12 added for the restore lock, digest-based resume, backup fingerprint, and default-duplicate pre-flight; Pass 2 adds the `--force-unlock`-after-any-crash requirement to steps 7-8, corrects the checkpoint/staging paths to be tenant-keyed, adds an `entityChunks` key-scoping check to step 6, and adds a "Recovery model" summary; **Pass 3 made no change to this file** (its fixes were internal to the digest-computation helper and did not change any operator-facing step); Pass 4 adds step 6a (verify the restart-requirement message) and step 6b (verify the idempotency-staleness note is documented), and extends the "Recovery model" summary below; **Pass 5 adds step 5a (verify the new pre-restore quiesce warning), corrects step 6a's own verification wording (it previously asked to confirm the opposite of the actual risk), and adds step 6c (verify the idempotency-staleness count and staging-file cleanup)**.

All steps run against an **isolated local/test environment** — `DB_FILE_ONLY=true` or a `mongodb-memory-server` instance via `tests/helpers/mongoTestHarness.js`. None touch production or demo.

## 1. Prerequisite: two tenants with colliding identifiers

Seed `default` and a second tenant `acme` with a user sharing the same `id` (e.g. `usr-1`) and an `EntityChunk` sharing the same `key` (e.g. `vendors`) but different data — the exact shape that made the original unscoped filters dangerous.

## 2. Verify tenant-safe Mongo writes (A) — unchanged

As `default`, save; re-read `acme`'s same-`id`/`key` documents directly from Mongo; confirm byte-identical.

## 3. Verify tenant-safe config, including cold-start and file-fallback (B) — revised

1. As `acme`, `saveConfig()`; as `default`, `loadConfig()`; confirm no cross-visibility.
2. **Cold-miss fail-closed (new)**: call `loadConfig()` for a tenant whose config was never warmed (bypassing `tenantMiddleware` deliberately); confirm it throws rather than returning `default`'s config.
3. **File-fallback (new)**: under `DB_FILE_ONLY=true`, `saveConfig()` for `acme`, clear `_tenantConfigCaches`, `warmTenantConfigCache('acme')` again; confirm the value survives and zero Mongo connection was attempted.

## 4. Verify Telegram/monitor default-only boundary (C) — now five routes

Call, as `acme`: `POST /api/telegram/start`, `POST /api/monitor/inventory`, `POST /api/monitor/monthly-report`, `POST /api/reports/send-telegram`, and **`GET /api/monitor/status`**. Confirm `403` + `TELEGRAM_DEFAULT_TENANT_ONLY` on all five, including that the status route discloses no `botActive`/`chatIdSet` value. Repeat as `default`: confirm unchanged behavior.

## 5. Verify tenant-scoped backup, including the default-duplicate pre-flight (D)

```
node scripts/tenant-backup.js --tenant=acme
```
1. `backups/tenant-acme-<stamp>.json` created: `scope:'tenant'`, `tenantId:'acme'`, `collections:{users,entityChunks,appConfigs}` — **no `tenants`/`subscriptions` key**.
2. Confirm zero `default`-owned documents in the file.
3. No `--tenant=` → non-zero exit, no file.
4. `--tenant=default` → legacy no-`tenantId`-field seed data (seeded via the **raw driver**, not `Model.create()`) is present.
5. **Default-duplicate pre-flight (new)**: seed a genuine duplicate `default` identity (raw-driver-seeded legacy copy + explicit `tenantId:'default'` copy of the same `id`); attempt `--tenant=default`; confirm hard failure naming the exact identity, zero file written.
6. Seed a real `IdempotencyRecord` and an `EntityChunk` keyed `idempotencyRecords` for `acme`; back it up; confirm neither appears anywhere in the output.

## 5a. Verify the pre-restore quiesce warning (NEW, Pass 5)

Run `tenant-restore.js` for `acme` (any valid backup file, including a deliberately-invalid `--tenant=` to trigger an early exit) and confirm the loud quiesce warning (Step -1 of the restore contract) prints **unconditionally, before** the Step 0 lock-acquisition message — i.e. even on a run that immediately fails validation, the warning must already have been printed. Confirm the warning names both requirements: quiesce traffic **before** the restore begins, and restart **after** it completes (this is the same warning family as step 6a below, but this half fires first and is not gated on success).

## 6. Verify offline restore staging touches nothing live (E/F)

1. Start `tenant-restore.js` for `acme` against the step-5 backup.
2. **Before** the apply step reaches `entityChunks` (pause via a test hook, or inspect immediately after Step 3 completes): query the live database directly and confirm **zero** documents exist under any placeholder/synthetic `tenantId` — staging wrote only to a local file (`backups/.restore-staging/<tenantId>.json`), never to Mongo.
3. Let it complete; confirm `acme`'s data matches the backup and `default`'s data is untouched, and that the Step-0 restore lock and `acme`'s own live `idempotencyRecords` document (seed one before starting, if not already present) both survived the `entityChunks` category's delete+insert untouched — proving that delete was scoped by `key`, not just `tenantId`.

## 6a. Verify the restart-requirement message (Pass 4; verification wording corrected Pass 5)

Confirm the Step 6 success output explicitly instructs the operator to restart `acme`'s live application server process(es) before any further write to that tenant. If a live server process for `acme` is available in the test environment (optional, for full end-to-end confidence): without restarting it, make one unrelated write for `acme` through that server (e.g. edit a vendor) and confirm — as the concrete illustration of why the warning exists — that the server's own stale in-memory cache **does** silently overwrite the just-restored `entityChunks` category on its next debounced flush when the restart is skipped (**Pass 5 correction: this previously read "does *not*," the exact opposite of the actual risk the warning describes — the point of this check is to confirm the risk is real, not that it is absent**).

## 6b. Verify the idempotency-staleness note is documented (NEW, Pass 4)

Confirm `docs/PRODUCTION_RUNBOOK.md`'s tenant-restore section states plainly that idempotency claims are not rolled back by a restore. No runtime assertion needed — this is a documentation-completeness check.

## 6c. Verify the idempotency-staleness count and staging-file cleanup (NEW, Pass 5)

1. Before starting the restore, complete one `vendor:create` (or `patient:create`) request for `acme` with a timestamp after the backup's own `createdAt` (i.e. seed a `COMPLETED` idempotency record that postdates the backup). Run the restore; confirm the Step 6 success output prints a count of at-risk idempotency records that includes this one (`1 idempotency record(s)...`, not `0`).
2. Repeat without seeding any such record; confirm the output explicitly prints `0 idempotency records at risk` rather than omitting the line.
3. After a successful restore, confirm `backups/.restore-staging/acme.json` no longer exists. Then deliberately fail a restore (e.g. kill the process mid-apply) and confirm the staging file is **still present** afterward (needed for the `--force-unlock` resume path, which reads it rather than re-running Step 3).

## 7. Verify the restore lock, including force-unlock atomicity (NEW)

1. Start two `tenant-restore.js` processes against the same tenant and backup concurrently.
2. Confirm exactly one acquires the lock and proceeds; the other is rejected immediately (before it even opens the backup file), naming the held lock's `runId`/`pid`/age.
3. After the first completes (lock released), confirm a third invocation now succeeds normally.
4. Kill a run mid-apply (a real process kill). Confirm a plain re-run (no `--force-unlock`) is rejected at Step 0, naming the dead run's `pid`/age. Confirm a re-run **with** `--force-unlock` succeeds.

## 8. Verify digest-based resume closes the checkpoint-lies window, with the corrected lock policy (G/H)

1. Apply `users` successfully.
2. Kill the process (a real process kill, not a caught exception) before `entityChunks`'s checkpoint entry is written — simulating a crash exactly between a category's DB write succeeding and its checkpoint write landing.
3. Re-run **with `--force-unlock`** (required after any real process kill — there is no exception for this scenario, per the corrected lock policy) with the **same** backup file. Confirm: `users` is **not** redundantly deleted/reinserted (its live digest already matches `expected`), while `entityChunks`/`appConfigs` proceed normally to completion.
4. Confirm the final checkpoint (now at `backups/.restore-checkpoints/<tenantId>.json`, not a `<runId>.json` path) shows `stage:'completed'` and all three categories in `categoriesApplied`, and that a fresh, different `runId` for this second invocation did not prevent it from finding and comparing against the first invocation's own checkpoint.

## 9. Verify the mandatory mid-apply failure injection (unchanged intent)

Force a failure after `users` applies but before `entityChunks` begins. Confirm: Tenant B untouched; `acme`'s `entityChunks`/`appConfigs` unchanged from pre-restore; `acme`'s `users` matches the backup; checkpoint `stage:'failed'`, `categoriesApplied:['users']`; non-zero exit; no false success message.

## 10. Verify the backup-fingerprint check rejects a mismatched resume (NEW)

After step 9's partial failure, re-invoke `tenant-restore.js` for the same tenant with a **different** backup file. Confirm hard rejection before any further write, naming both files' fingerprints.

## 11. Verify restore rejects the wrong format (E) — updated

1. Feed `acme`'s tenant-scoped backup into `scripts/restore.js` (whole-instance, unmodified): confirm rejection via the new, deliberate `scope==='tenant'` guard in `validateBackupObject()`.
2. Feed a whole-instance backup into `tenant-restore.js`: confirm rejection at Step 1.2.

## 12. Whole-instance path regression check (H) — unchanged

`npm run backup` / `npm run restore -- --target=local-test` behave exactly as before this phase.

## Recovery model (stated once, plainly, for operators)

**Resume is supported. Rollback is not.** After any restore that exits cleanly (a caught failure), a plain re-run with the same backup file resumes correctly, skipping whatever the digest re-check confirms is already applied. After any restore that is killed rather than exiting cleanly, resuming requires the explicit `--force-unlock` flag — with no exception, even for an otherwise-routine crash — because the tool cannot safely tell "genuinely dead" from "merely slow" without an operator's own judgment, especially across independent machines. There is no automatic way to revert a category that already applied successfully back to its pre-restore state; reverting means restoring again, deliberately, from a backup taken before the unwanted one.

**The live application server matters before the restore too, not just after — extended Pass 5.** Pass 4 established that restarting the target tenant's server process(es) after a completed restore is required, not optional (the tool's own success message says so). Pass 5 closes a gap in that story: the same in-memory cache can also race and corrupt the restore **while it runs**, not just revert it afterward — a write accepted by a still-running server during the apply step can recreate a document the restore just deleted, or re-persist an already-applied category's stale pre-restore snapshot. So the operator is now warned twice: quiesce the tenant's live traffic **before** the restore begins (printed unconditionally, before anything else — see step 5a), and restart it **after** the restore completes (the pre-existing Pass 4 requirement, step 6a). Neither is enforced by the tool itself — both are operator-discipline warnings, consistent with this codebase's existing "changing X requires a restart" pattern; automatic write-blocking was considered and deliberately deferred as a later-phase hardening candidate, not silently dropped.

**Idempotency claims are not touched by a restore, and now the tool tells you how many are at risk — extended Pass 5.** A restore never touches idempotency claims — this is intentional and correct, but it means a legitimate retry of a financial operation completed after the backup's cutoff can be silently short-circuited as "already done" post-restore; this is a documented, known limitation, not a bug to work around silently. Pass 5 adds a cheap, read-only count of exactly how many `COMPLETED` idempotency records for the target tenant postdate the backup, printed as part of the same success output (step 6c) — still read-only reporting, no auto-repair, consistent with FR-012.

**The local staging file is cleaned up on success, added Pass 5.** Step 3's offline staging file holds the same sanitized tenant data as the backup itself, including any plaintext secret an `AppConfig` document may carry — it is deleted automatically once the apply step it fed succeeds, and deliberately left in place after a failed run so a `--force-unlock` resume can still read it (step 6c).

## 13. Full regression

```
npm test
```
Full existing suite passes, plus every new test file from this phase.
