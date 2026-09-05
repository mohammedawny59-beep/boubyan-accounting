# Contract: Tenant-Scoped Restore (E) + Offline Staging (F) + Restore Lock + Digest-Based Resume (G/H) + Whole-Instance Separation (H)

**Substantially redesigned in Design Remediation Pass 1.** The original `__restage__<tenant>__<runId>` live-Mongo synthetic-tenant staging design is **rejected outright** (research.md Decision 6) — it collided with `Tenant.slug`'s global uniqueness, with live-tenant `_id`s, and created a reachable authentication identity during staging. This contract replaces it with entirely offline/logical staging, adds a cross-process restore lock, and makes resume derive truth from actual database state rather than trusting the checkpoint file alone.

New CLI script: `scripts/tenant-restore.js`. New npm script: `restore:tenant`. Does not modify `scripts/restore.js`/`npm run restore` in any way, beyond the one additive, deliberate guard described in "Whole-Instance Separation" below (in the *shared validation library* both scripts import, not in `scripts/restore.js` itself).

## Invocation

```
node scripts/tenant-restore.js <backup-file> --tenant=<tenantId> --target=<label> [--yes] [--force-unlock]
```

`<backup-file>`, `--tenant=`, `--target=` all required, no defaults, no fallback to whole-instance behavior. `--force-unlock` is a distinct, explicit, logged flag — see "Restore Lock" below — never implied by `--yes`.

## Step 0 — Restore Lock (acquire first, before anything else touches the backup file)

Research.md Decision 11. Reuses the existing `EntityChunk` compound unique index `{tenantId,key}` — no new model.

- **Acquire**: `EntityChunk.create({tenantId: target, key: '__restoreLock__', data: {runId, pid: process.pid, acquiredAt}})`. A concurrent second invocation for the same `target` hits `E11000` on the existing unique index and is rejected immediately, before opening or even reading the `<backup-file>` argument, printing the existing lock's `runId`/`pid`/age.
- File mode: `fs.writeFileSync(backups/.restore-checkpoints/<target>.lock, {...}, {flag:'wx'})`, same fail-fast semantics.
- **Release**: on any clean terminal outcome (`completed` or a caught `failed`), `EntityChunk.deleteOne({tenantId:target, key:'__restoreLock__', 'data.runId':runId})` (file mode: `fs.unlinkSync`) — conditioned on this run's own `runId`, so a stale release can never remove a different, newer lock.
- **Stale lock (process killed, not a clean failure)**: the lock is never automatically released or expired. A second invocation is rejected until an operator passes `--force-unlock` explicitly (logged, deliberate) — which deletes the existing lock (regardless of its age) before this run acquires its own.
- `__restoreLock__` is deliberately **not** in `TENANT_BACKUP_ENTITY_KEYS`, so it is never itself swept into a tenant backup.

## Step 1 — Validation gate (reject BEFORE any file write, any Mongo write, or any local staging)

Extends `lib/backupValidation.js` with `validateTenantBackupObject(backup, targetTenantId)` — additive; `validateBackupObject()` (whole-instance) unchanged except for the one guard in "Whole-Instance Separation" below.

1. **Structural**: file exists, non-empty, valid JSON, checksum sidecar matches (existing `validateBackupFile()` machinery, unchanged).
2. **Format/scope**: `backup.scope === 'tenant'` and `backup.schemaVersion` known/supported. A whole-instance file (no `scope`, or any `scope` other than `'tenant'`) is rejected here.
3. **Tenant-identity ambiguity**: `backup.tenantId` is a single, unambiguous string.
4. **Tenant match**: `backup.tenantId === targetTenantId` exactly.
5. **Category shape**: `backup.collections` contains exactly `users`/`entityChunks`/`appConfigs` — **a `tenants` or `subscriptions` key present at all is itself a rejection** (a leftover shape from an incompatible producer; research.md Decision 10).
6. **Idempotency-exclusion enforcement (NEW)**: reject if `collections.entityChunks` contains any entry with `key==='idempotencyRecords'`, or any top-level `idempotencyRecords` field exists at all (research.md Decision 8, spec.md FR-024) — defense in depth against a malformed/hand-edited/future-version file, independent of whether the backup tool itself behaved correctly.
7. **Record-count / digest integrity (NEW)**: `recordCounts.<cat>` matches `collections.<cat>.length` for each category, and `categoryDigests.<cat>` matches a freshly-computed digest of `collections.<cat>` — a backup file that was hand-edited after being written is caught here, not silently trusted.
8. **Backup-fingerprint match on resume (NEW, research.md Decision 13)**: if an existing, non-`completed` checkpoint is found for `targetTenantId` (from a prior attempt), compute this invocation's backup file's sha256 and compare it against that checkpoint's recorded `backupFingerprint`. Mismatch → hard reject, naming both files, before any further step. This is the check that replaces the original design's unenforced "resume with the same backup file" assumption.

Any failure at any step: print every problem, exit non-zero, release the Step-0 lock, write no checkpoint, touch no real data.

## Step 2 — Default-tenant duplicate pre-flight (target `default` only)

Identical check to the backup contract's pre-flight (research.md Decision 15), run here against the **live database** (not the backup file) before staging begins: any `default`-owned logical identity (User `id`, EntityChunk/AppConfig `key`) with more than one physical document → hard-fail, name the exact identity, release the lock, write no checkpoint, touch no data.

## Step 3 — Offline/logical staging (NEW — no live-Mongo write of any kind)

Research.md Decision 6. Reads the already-validated backup's `collections` into memory:

1. **Sanitize**: strip `_id`/`__v` from every record in every category (confirmed, by re-reading `models/User.js`/`EntityChunk.js`/`AppConfig.js`, that neither field is ever used as application identity anywhere in this codebase — `id`/`key`/`tenantId` are the only identity fields any query uses).
2. **Recompute count + digest per category** and confirm they match the backup file's own `recordCounts`/`categoryDigests` (a second, independent check beyond Step 1's file-level one, now against the actually-sanitized, actually-staged data).
3. **Ownership check**: every sanitized record's own `tenantId` (or, for `default`, a shape `_defaultTenantFilter` would match) is consistent with `targetTenantId`.
4. **Write the staged, sanitized representation to a local file** — `backups/.restore-staging/<runId>.json` — never to any live collection. **No `Tenant` document, real or synthetic, is ever created anywhere by this step** — closing the reachable-fake-identity hazard the original design had, by construction.
5. **Write the checkpoint** (Step 4 below) with `stage:'staged'`, `expected:{users:{count,digest}, entityChunks:{...}, appConfigs:{...}}` copied from this step's own recomputed values.

**Guarantee**: at the end of Step 3, the real target tenant's live data is byte-for-byte unchanged from before the restore began — nothing in staging ever writes to it.

## Step 4 — Checkpoint (atomic writes, research.md Decision 14)

`backups/.restore-checkpoints/<runId>.json`, written via the existing, exported `_atomicWriteJsonSync` (tmp-file + `fs.renameSync`) — never a plain `fs.writeFileSync`. `fs.mkdirSync(path.dirname(...), {recursive:true})` runs before the first write. Format: see `data-model.md` → "New logical file format 2". A checkpoint that fails to `JSON.parse` on a later resume attempt is treated as "no reliable prior record, proceed as fresh" (safe — see Step 5's digest re-check, which never trusts the checkpoint blindly anyway).

## Step 5 — Apply (the only step that writes to the real target tenant)

For each category, in the fixed order `users → entityChunks → appConfigs`:

1. **Digest re-check (research.md Decision 12)**: compute the category's *current, actual* count+digest for `targetTenantId` in the live database. If it already matches `expected.<cat>` exactly, mark this category `categoriesApplied` and move to the next — **no destructive operation is performed on an already-correct category**, regardless of what the checkpoint's own prior `categoriesApplied` list said (it might be stale or absent from a crash — this re-derivation is authoritative, not the checkpoint alone).
2. If it does not match: **delete** the real target tenant's current documents in this category (`{tenantId:target}` or `_defaultTenantFilter` for `default` — **never** a bare `deleteMany({})`), then **insert** the staged, sanitized records from Step 3's local file directly with `tenantId` set to the *real* target (no synthetic identity of any kind — there is nothing to "repoint" anymore).
3. Append the category to `categoriesApplied`, rewrite the checkpoint (atomically, Step 4's mechanism).
4. On any error: catch it, set `stage:'failed'`, record `error`, rewrite the checkpoint, release the lock (clean failure — not a crash), exit non-zero, print the recovery-model reminder (below).

## Step 6 — Finalize

Once every category is confirmed in `categoriesApplied`: `stage:'completed'`, release the lock, print success — **explicitly naming the target tenant and stating a tenant-scoped restore path was used** (research.md Decision 17, spec.md's operator-honesty requirement) — e.g. `Restored tenant "acme" only, via tenant-scoped filters — no other tenant's data was written by this operation.` This is a claim about the tool's own design guarantee (every write in Step 5 is filtered to `target` by construction), not an empirically runtime-checked claim about every other tenant — the tool does not, and is not required to, scan other tenants' data to "verify" this.

## Recovery model — stated explicitly (research.md Decision 17)

- **Resume: supported.** Re-run the identical command with the identical backup file. Step 0's lock (once released after a *clean* failure) permits it; Step 1's fingerprint check confirms it's the same backup; Step 5's digest re-check skips whatever is already correctly applied and only redoes what isn't.
- **Rollback: NOT supported.** There is no automatic mechanism to revert an already-applied category back to its pre-restore state. Reverting requires an explicit, deliberate restore again, using a backup taken *before* the unwanted one.
- On any `failed` exit, the tool prints: *"Resume: re-run this exact command with the same backup file. Rollback of an already-applied category is not automatic — restore again from an earlier backup if needed. If this process was killed rather than exiting cleanly, the restore lock for this tenant may still be held — use --force-unlock only if you have confirmed no other restore for this tenant is genuinely still running."*

## Whole-Instance Separation (H)

`lib/backupValidation.js`'s existing `validateBackupObject()` (whole-instance, used by the **unmodified** `scripts/restore.js`) gains one new, additive, first check: `if (backup.scope === 'tenant') return {ok:false, problems:['tenant-scoped backup file — use scripts/tenant-restore.js']}`. An absent `scope` (every existing whole-instance file) is unaffected — zero regression. This replaces the original design's incorrect claim that the existing `collections`-presence check already handled this (research.md Decision 7) with a deliberate, tested guard.

## Test contract

1. Restoring Tenant A never changes Tenant B (unchanged from original pass, re-verified: byte-identical before/after, across all three categories).
2. A whole-instance file fed to `tenant-restore.js` is rejected at Step 1.2. A tenant-scoped file fed to `scripts/restore.js` is rejected by the new `validateBackupObject()` guard above — both tests call the real, exported validators, not a reimplementation.
3. A tenant-scoped file with a `tenants`/`subscriptions` key is rejected at Step 1.5.
4. A backup containing an `idempotencyRecords` entity chunk is rejected at Step 1.6.
5. **Concurrent restore (NEW, mandatory)**: start two `tenant-restore.js` processes against the same tenant; assert exactly one acquires the lock and proceeds, the other is rejected at Step 0 before reading the backup file at all.
6. **Digest-based resume (NEW, mandatory)**: apply `users` successfully, then kill the process before `entityChunks`'s checkpoint entry is written (simulating the crash window, not just a thrown JS exception) — re-run; assert `users` is **not** re-deleted/re-inserted (verify via a marker field or write-count instrumentation) because its digest already matches, while `entityChunks`/`appConfigs` proceed normally.
7. **Failure-injection mid-apply (mandatory, unchanged intent, updated mechanism)**: force a failure after `users` applies but before `entityChunks` begins; assert Tenant B untouched, `entityChunches`/`appConfigs` untouched (pre-restore state), `users` matches the backup, checkpoint shows `stage:'failed'`, `categoriesApplied:['users']`, non-zero exit, no false success claim.
8. **Backup-fingerprint mismatch on resume (NEW, mandatory)**: after a partial failure, re-invoke with a *different* backup file for the same tenant; assert hard rejection at Step 1.8, zero additional writes.
9. **`default` duplicate pre-flight (NEW, mandatory)**: seed a genuine duplicate `default` identity (raw-driver-seeded, per spec.md FR-027); attempt a `default` restore; assert hard failure at Step 2, exact identity named, zero writes.
10. **No live synthetic identity at any point (NEW, mandatory)**: throughout a full staging run, assert (via a live query) that no `Tenant`/`User`/`EntityChunk`/`AppConfig` document with any placeholder/synthetic `tenantId` ever exists in the database — staging never touches Mongo at all.
11. `default` restore uses `_defaultTenantFilter` for the delete half of Step 5.2, correctly clearing legacy no-`tenantId`-field documents being replaced (unchanged intent from the original pass, re-verified: legacy record seeded via raw driver per FR-027, restored exactly once, no duplicate pair remains).
