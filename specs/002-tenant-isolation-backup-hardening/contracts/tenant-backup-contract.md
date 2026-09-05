# Contract: Tenant-Scoped Backup (D)

New CLI script: `scripts/tenant-backup.js`. New npm script: `backup:tenant`. Does not modify `scripts/backup.js`/`npm run backup` in any way (zero regression risk to the existing, production-relied-on whole-instance path).

## Invocation

```
node scripts/tenant-backup.js --tenant=<tenantId>
```

- `--tenant=` is **required**, no default, no positional-argument fallback. Missing/empty → print usage, exit `1`, write nothing. (spec.md FR-018/FR-021 — mirrors `scripts/restore.js`'s own already-established `--target=` requirement, `scripts/restore.js:72-86`.)
- `--tenant=default` is valid and is the primary way to back up the current production clinic's data under the new, safer, self-describing format.

## Output file format

See `data-model.md` → "New logical file format 1". Written to `backups/tenant-<tenantId>-<stamp>.json` + `.sha256` sidecar (reuses `computeChecksum()` unchanged).

## Source selection (mirrors `scripts/backup.js:57-67` unchanged decision tree)

- `MONGO_URI` set → Mongo mode.
- Else → file mode: for `tenantId==='default'`, read `data/database.json`/`data/config.json` (existing files, unchanged paths); for any other `tenantId`, read exactly `data/tenants/<sanitized-tenantId>.json` via the exported `_tenantFilePath()` helper (research.md Decision 9) — **no other tenant's file is ever opened**.

## Mongo-mode collection queries

| Collection | Filter |
|---|---|
| `users` | `_defaultTenantFilter` if `tenantId==='default'`, else `{tenantId}` |
| `entityChunks` | same, plus `key: {$in: ENTITY_KEYS}` |
| `appConfigs` | same filter, `key:'config'` |
| `tenants` | `{tenantId}` (always empty for `default` — Decision 5, documented as expected) |
| `subscriptions` | `{tenantId}` (always empty for `default`) |

`idempotencyRecords` is never queried (research.md Decision 8).

## Guarantees

- No document belonging to any tenant other than the one named by `--tenant=` MAY appear anywhere in the output file — verified by asserting every returned document's `tenantId` (or its absence, for legacy `default` records) is consistent with the requested tenant before it is written to disk.
- `recordCounts` in the output MUST equal the actual length of each corresponding array in `collections` — computed from the same in-memory arrays just written, not recomputed by a second query (avoids a race against a concurrent write).
- Missing `--tenant=` MUST fail before any Mongo connection is opened or any file is read.

## Test contract

1. Seed Tenant A and Tenant B with distinct, non-overlapping data (including an `id`/`key` collision between them, mirroring the real-world shape that made the original bugs dangerous); run `tenant-backup.js --tenant=A`; assert zero Tenant-B-owned documents appear anywhere in the output.
2. Seed a legacy `default` user/entity-chunk with no `tenantId` field; run `--tenant=default`; assert it IS included (legacy-inclusion regression guard — the opposite failure mode from #1).
3. Run with `--tenant=` omitted; assert non-zero exit, no file written.
4. Run for a tenant with no `Tenant`/`Subscription` row (`default`, or a freshly-seeded tenant before its registry row exists); assert the backup still succeeds with empty arrays for those two collections, not an error.
