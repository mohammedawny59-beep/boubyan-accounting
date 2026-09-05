# Contract: Tenant-Scoped Restore (E) + Recovery Semantics (F) + Whole-Instance Separation (H)

New CLI script: `scripts/tenant-restore.js`. New npm script: `restore:tenant`. Does not modify `scripts/restore.js`/`npm run restore` in any way — that remains the only path to a whole-instance restore, unchanged, with its own existing `--target=`+typed-confirmation gate (Constitution Principle IV) untouched.

## Invocation

```
node scripts/tenant-restore.js <backup-file> --tenant=<tenantId> --target=<label> [--yes]
```

- `<backup-file>`, `--tenant=`, `--target=` are all **required**. `--tenant=` names which tenant's live data will be replaced; `--target=` is the existing operator-facing "what environment am I pointed at" confirmation (`scripts/restore.js:72-86` convention, reused verbatim).
- No flag defaults to whole-instance behavior. There is no code path in this script that ever calls a collection-wide `deleteMany({})`.

## Validation gate — reject BEFORE any write, in this order (spec.md, Clarification Q6)

Extends `lib/backupValidation.js` additively with `validateTenantBackupObject(backup, targetTenantId)` — the existing `validateBackupObject()` (whole-instance) is not modified.

1. **Structural**: file exists, non-empty, valid JSON, checksum sidecar matches (reuses existing `validateBackupFile()` machinery unchanged).
2. **Format/scope**: `backup.scope === 'tenant'` and `backup.schemaVersion` is a known, supported value. A whole-instance file (no `scope` field) is rejected here, before its `tenantId` is ever inspected.
3. **Tenant-identity ambiguity**: `backup.tenantId` must be a single, unambiguous string. (The format never allows more than one value here by construction — this step guards against a hand-edited or corrupted file.)
4. **Tenant match**: `backup.tenantId === targetTenantId` (the `--tenant=` argument) exactly. Mismatch → hard reject, regardless of how "close" the names look. This is the check that stops "I meant to restore Tenant A's backup but typed `--tenant=B`" from ever reaching a write.
5. **Record-count integrity**: `recordCounts` matches the actual lengths of the arrays in `collections`.

Any failure at any step: exit non-zero, print every problem found (mirrors `scripts/restore.js:91-95`'s existing "print all problems, write nothing" convention), no Mongo connection opened, no file touched, no checkpoint file created.

## Staged restore sequence (spec.md requirement F)

```
1. validate         — the gate above, fully, before touching Mongo/files
2. stage            — insertMany() the backup's documents into the SAME collections,
                       with tenantId rewritten to a synthetic `__restage__<target>__<runId>`
                       value that cannot collide with any real tenant identity.
                       Before staging, delete any leftover `__restage__<target>__*` documents
                       from a prior failed run (idempotent re-run, research.md Decision 6).
3. staged-verified  — re-query the staged documents; compare counts against the backup's
                       own recordCounts. Mismatch → abort here; the target tenant's REAL
                       data has not been touched yet.
4. checkpoint        — write backups/.restore-checkpoints/<runId>.json (data-model.md format),
                       stage:'staging' → 'staged-verified' recorded before any real-collection
                       delete happens.
5. swap (per collection, in a fixed order: users → entityChunks → appConfigs →
         [tenants, subscriptions if target != 'default']):
       a. delete the target tenant's CURRENT real documents in this collection
          ({tenantId:target} or _defaultTenantFilter for 'default')
       b. updateMany() the staged documents' tenantId from the synthetic value to `target`
       c. append this collection's name to collectionsSwapped in the checkpoint file
6. finalize          — checkpoint stage → 'completed' once every collection is swapped.
```

## Explicit "what is/isn't atomic" statement (required by spec.md FR-013)

- **Atomic per collection, in practice**: step 5's delete+repoint for one collection is two fast operations with no other write path touching that same tenant's same collection concurrently (this codebase's own single-instance/no-horizontal-scaling assumption, Constitution Principle VI) — not a database-guaranteed atomic unit, but not exposed to real concurrent interference either.
- **NOT atomic across collections**: a crash between two collections in step 5 leaves earlier-listed collections on the backup's data and later ones on the pre-restore data. This is the accepted, documented trade-off of not using Mongo transactions (research.md Decision 4/6).
- **Never partially-written within one document**: no single record is ever half-old/half-new — the only failure granularity is "this whole collection swapped or it didn't."
- **Recovery on failure**: the checkpoint file's `collectionsSwapped` array is the ground truth for exactly how far a failed run got (data-model.md). The operator's recovery action is to re-run `tenant-restore.js` from the start with the same backup file — staging is idempotent (step 2 cleans up any leftover synthetic-tenantId documents from the failed attempt first) — not to hand-edit partial state.
- **Never "silently half-successful"**: the script's process exit code is non-zero on any failure at any stage, and the checkpoint file's `stage` field is never left at anything but an explicit terminal or resumable value — there is no code path that reports success while `collectionsSwapped` is incomplete.

## Guarantees

- Restoring Tenant A MUST NOT change any Tenant B document, in any collection, at any intermediate step — including during staging (synthetic tenantId never collides with a real one) and during the swap (delete/repoint filters are always scoped to `target`).
- A malformed, wrong-scope, wrong-tenant, or checksum-mismatched backup file MUST be rejected before any Mongo write, including before staging.
- `default`'s restore MUST use `_defaultTenantFilter` for the delete-old step (so it also clears legacy no-`tenantId`-field documents being replaced), matching the same filter used everywhere else in this phase for `default`.
- No target-tenant registry check is required for `tenantId==='default'` (research.md Decision 5); for any other tenant, a missing `Tenant` row produces a warning + extra confirmation prompt (not a hard block — this is an operator-driven CLI tool with its own existing typed-confirmation gate, not an unattended automated path).

## Test contract

1. Restore Tenant A's backup; assert Tenant B's documents (all collections) are byte-identical before/after.
2. Feed a whole-instance-format file (no `scope`) into `tenant-restore.js`; assert rejection at validation step 2, zero writes.
3. Feed a tenant-scoped backup whose `tenantId` doesn't match `--tenant=`; assert rejection at step 4, zero writes.
4. Simulate a failure between two collections in step 5 (e.g. force an error after `users` swaps but before `entityChunks`); assert `entityChunks`/`appConfigs` for the target tenant are byte-identical to pre-restore state, and the checkpoint file shows `collectionsSwapped: ['users']`.
5. Re-run after the simulated failure in #4 with the same backup; assert it completes successfully and leaves no leftover `__restage__` documents in any collection.
6. Restore `default` from a backup containing a legacy no-`tenantId`-field user; assert it lands correctly and the old legacy-shaped document is gone (replaced, not duplicated).
7. Restore a tenant with no `Tenant` registry row and no `--yes`; assert the extra warning/confirmation prompt appears (manual/quickstart verification, matches the existing `scripts/restore.js` confirmation-prompt testing convention).
