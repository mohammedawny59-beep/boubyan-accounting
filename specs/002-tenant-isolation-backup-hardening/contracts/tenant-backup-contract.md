# Contract: Tenant-Scoped Backup (D)

**Revised in Design Remediation Pass 1**: scope narrowed to exactly three categories (research.md Decision 10), idempotency exclusion made real (Decision 8), a mandatory default-duplicate pre-flight added (Decision 15), file-mode output shape fully defined (Decision 9), category digests added (for restore's Decision 12 resume logic).

New CLI script: `scripts/tenant-backup.js`. New npm script: `backup:tenant`. Does not modify `scripts/backup.js`/`npm run backup` in any way.

## Invocation

```
node scripts/tenant-backup.js --tenant=<tenantId>
```

`--tenant=` required, no default, no positional fallback. Missing/empty → usage + exit `1`, nothing written. `--tenant=default` is valid and is the primary way to back up the current production clinic under the new, safer format.

## Pre-flight (default tenant only) — MUST run and pass before anything else

For `--tenant=default`: scan every logical identity matched by `_defaultTenantFilter` (a `User.id`, an `EntityChunk`/`AppConfig` `key`) and count distinct physical documents per identity. **Any identity with more than one document → hard-fail**, printing the exact category + identity + both documents' `_id`s, and write **no** backup file (research.md Decision 15, spec.md FR-026). This is a detection gate, not a repair — the tool never merges or guesses.

## Output file format

See `data-model.md` → "New logical file format 1". `{scope:'tenant', schemaVersion:1, tenantId, createdAt, source, recordCounts:{users,entityChunks,appConfigs}, categoryDigests:{users,entityChunks,appConfigs}, collections:{users,entityChunks,appConfigs}}`. **No `tenants`/`subscriptions` field of any kind** — `Tenant`/`Subscription` are out of scope for this tool entirely (research.md Decision 10); this backup is never described as a "full tenant backup," only as covering users, accounting data, and configuration. Written to `backups/tenant-<tenantId>-<stamp>.json` + `.sha256` sidecar.

## Source selection

- `MONGO_URI` set → Mongo mode.
- Else → file mode: `default` reads `data/database.json`/`data/config.json` (unchanged paths); any other tenant reads exactly `data/tenants/<sanitized-tenantId>.json` and `data/tenants/<sanitized-tenantId>.config.json` (the new per-tenant config file, research.md Decision 2) via the exported `_tenantFilePath()`/`_tenantConfigFilePath()` helpers.

## Mongo-mode collection queries

| Category | Filter |
|---|---|
| `users` | `_defaultTenantFilter` if `tenantId==='default'`, else `{tenantId}` |
| `entityChunks` | same tenant filter, plus `key: {$in: TENANT_BACKUP_ENTITY_KEYS}` — **never raw `ENTITY_KEYS`** (research.md Decision 8; `TENANT_BACKUP_ENTITY_KEYS` is `ENTITY_KEYS` minus `'idempotencyRecords'`, exported from `lib/database.js`) |
| `appConfigs` | same tenant filter, `key:'config'` |

`IdempotencyRecord` (the dedicated model) is never queried. `Tenant`/`Subscription` are never queried (research.md Decision 10).

## File-mode transform (unified shape, research.md Decision 9)

`collections.users = blob.users`; `collections.entityChunks = TENANT_BACKUP_ENTITY_KEYS.map(key => ({tenantId, key, data: blob[key], updatedAt}))`, synthesized from the raw per-tenant file blob's own fields; `collections.appConfigs = [{tenantId, key:'config', data: <that tenant's config file content>}]` if it exists, else `[]`. The output shape is identical to Mongo mode's — a restore never needs to know which backend produced the file.

## Category digests

For each of `users`/`entityChunks`/`appConfigs`: `recordCounts.<cat> = collections.<cat>.length`; `categoryDigests.<cat> = computeChecksum(canonicalJson(collections.<cat>))` (reusing the existing, unmodified `computeChecksum()`), computed from the same in-memory arrays just written — never a second query.

## Guarantees

- No document belonging to any tenant other than `--tenant=` may appear anywhere in the output.
- `recordCounts`/`categoryDigests` are always computed from the exact arrays written, never re-derived later.
- Missing `--tenant=` fails before any Mongo connection or file read.
- A `default`-tenant backup with an undetected duplicate identity is impossible — the pre-flight above blocks it structurally.

## Test contract

1. Cross-tenant leakage (unchanged from original pass): seed A/B with a colliding `id`/`key`, back up A, assert zero B-owned documents.
2. Legacy inclusion: seed a legacy no-`tenantId`-field `default` user via the **raw driver** (spec.md FR-027 — not `Model.create()`), back up `default`, assert included.
3. Missing `--tenant=` exits non-zero, writes nothing.
4. Idempotency exclusion (NEW): seed a real `IdempotencyRecord` document and an `EntityChunk` with `key:'idempotencyRecords'` for the target tenant; back it up; assert neither appears anywhere in the output, and `TENANT_BACKUP_ENTITY_KEYS` (not `ENTITY_KEYS`) is confirmed (by import, not by re-implementing the filter in the test) to be the query source.
5. Default-duplicate pre-flight (NEW): seed a genuine duplicate identity for `default` (a legacy no-`tenantId` user and an explicit `tenantId:'default'` user sharing the same `id`, both via the raw driver); attempt a `default` backup; assert hard failure, exact identity named, zero file written.
6. `Tenant`/`Subscription` absence (NEW): confirm the output file has no `tenants`/`subscriptions` key at all, for both `default` (which has no such rows) and a real tenant (which does, but they must not appear).
