// P0.5A — Final Durability & File Storage Closure.
// Every test here runs against isolated temp storage — NO real MongoDB, NO
// real S3/network call, NO production data is ever read or written. The
// SAME live `app` used elsewhere in this suite is reused so route-level
// tests exercise the REAL server.js logic (not a re-implementation).

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-5a-durability-test-secret';
process.env.NODE_ENV     = 'test';

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p05a-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB, warmTenantCache } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');
const {
  buildTenantKey, validateStorageConfig, createLocalAdapter, createS3Adapter, getStorage, _sigV4,
} = require('../lib/storage');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [{ id: 'usr-admin', username: 'admin', email: 'admin@test.com', passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير', active: true, createdAt: new Date().toISOString(), lastLogin: null }],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], budget: {}, auditLog: [], accruedExpenses: [],
    journalMappings: [], doctorExpenses: [], lockedPeriods: {},
  };
}

let adminToken;

beforeAll(async () => {
  await initDB({
    mongoUri: 'mongodb://127.0.0.1:1/unused',
    dataFile: process.env.DATA_FILE,
    configFile: process.env.CONFIG_FILE,
    defaultConfig: {},
    buildInitialDB,
    migrateDB: () => false,
  });
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
  adminToken = login.body.token;
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════
// UPLOAD A–F — lib/storage.js tenant-safe keys + real /api/upload route
// ═══════════════════════════════════════════════════════════════════════
describe('P0.5A — Upload storage safety', () => {
  test('Upload A: two tenants can never collide on the same storage key, even for the identical original filename', () => {
    const keyA1 = buildTenantKey('tenant-a', 'invoices', 'invoice.pdf');
    const keyA2 = buildTenantKey('tenant-a', 'invoices', 'invoice.pdf'); // same tenant, same name, second call
    const keyB1 = buildTenantKey('tenant-b', 'invoices', 'invoice.pdf');

    expect(keyA1).not.toBe(keyA2); // server-generated UUID makes even same-tenant re-uploads unique
    expect(keyA1).not.toBe(keyB1);
    expect(keyA1.startsWith('tenants/tenant-a/')).toBe(true);
    expect(keyB1.startsWith('tenants/tenant-b/')).toBe(true);
  });

  test('Upload B: a path-traversal filename/tenantId/category can never escape the storage root', () => {
    // buildTenantKey() never lets ".." or "/" reach a path segment — the
    // tenantId/category charset is stripped and only the extension is ever
    // taken from the (attacker-influenced) original name.
    const key = buildTenantKey('../../etc', '../passwd', '../../../etc/passwd');
    expect(key).not.toMatch(/\.\./);
    expect(key.startsWith('tenants/')).toBe(true);
    // Extension is not an allow-listed one ("/passwd" has none) → falls back to .bin
    expect(key.endsWith('.bin')).toBe(true);

    // Belt-and-suspenders check: the LOCAL ADAPTER itself refuses to resolve
    // any raw key (even one that didn't come from buildTenantKey) outside
    // its configured root.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p05a-storage-'));
    const adapter = createLocalAdapter(root);
    return expect(adapter.read('../../../../etc/passwd')).rejects.toThrow(/escapes root/);
  });

  test('Upload C: an unguessable per-tenant key means one tenant cannot retrieve another tenant\'s document', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p05a-storage-'));
    const adapter = createLocalAdapter(root);

    const keyA = buildTenantKey('tenant-c1', 'invoices', 'secret.pdf');
    await adapter.save(keyA, Buffer.from('tenant-c1 confidential content'));

    // Tenant C2 has no way to derive tenant C1's UUID — even guessing the
    // exact same category under its OWN prefix resolves to nothing.
    const guessedKey = buildTenantKey('tenant-c2', 'invoices', 'secret.pdf');
    await expect(adapter.read(guessedKey)).rejects.toThrow();

    // The real key still works for whoever legitimately holds it.
    const content = await adapter.read(keyA);
    expect(content.toString()).toBe('tenant-c1 confidential content');
  });

  test('Upload D: an unsupported file type is rejected by the real /api/upload route (never reaches parsing/business logic)', async () => {
    const before = await runAsTenant('default', async () => (loadDB().uploadedFiles || []).length);
    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('not really an executable, just bytes'), 'malware.exe');
    expect(res.status).not.toBe(200);
    let after; await runAsTenant('default', async () => { after = (loadDB().uploadedFiles || []).length; });
    expect(after).toBe(before); // rejected before any upload record was created
  });

  test('Upload E: an oversized file (> 10MB limit) is rejected by the real /api/upload route', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024, 'x'); // 11MB > the route's 10MB multer limit
    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', oversized, 'huge.xlsx');
    expect(res.status).not.toBe(200);
  }, 20000);

  test('Upload F: a transient upload leaves no leaked temp file behind in UPLOADS_DIR, on both the success and failure paths', async () => {
    const XLSX = require('xlsx');
    const UPLOADS_DIR = path.join(ROOT, 'uploads');
    fs.ensureDirSync(UPLOADS_DIR);
    const before = new Set(fs.readdirSync(UPLOADS_DIR));

    // "Success" path: valid extension, filename matches NEITHER known import
    // type (dailyincome/payments) — the route no-ops on business logic but
    // still must clean up the temp file multer wrote to disk.
    const okRes = await request(app)
      .post('/api/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('irrelevant, never parsed'), 'unrelated-report.xlsx');
    expect(okRes.status).toBe(200);

    // Failure path: a REAL, parseable "dailyIncome" workbook (SheetJS is
    // lenient with garbage bytes — it silently reads them as a one-cell
    // sheet instead of throwing, so an actual valid workbook is needed to
    // reach a genuine error branch) whose date falls in a period locked
    // JUST for this test — the auto-journal-entry step deep inside the
    // parse/merge logic throws JournalValidationError, exercising exactly
    // the "later throw" scenario the P0.5A Step 7 fix (server.js's `finally`
    // cleanup, see the comment right above it) was written for.
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.lockedPeriods = db.lockedPeriods || {};
      db.lockedPeriods['2099-01'] = true;
      saveDB(db);
    });
    const header = ['Date', 'Cash', 'K-Net', 'Visa', 'Master', 'Insurance', 'Cheque', 'Link', 'Total', 'Advance'];
    const row = ['31/01/2099', 10, 5, 0, 0, 0, 0, 0, 15, 0];
    const ws = XLSX.utils.aoa_to_sheet([header, row]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const lockedPeriodBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const failRes = await request(app)
      .post('/api/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', lockedPeriodBuffer, 'dailyIncome-locked-period.xlsx');
    expect(failRes.status).toBe(409);
    expect(failRes.body.code).toBe('PERIOD_LOCKED');

    const after = new Set(fs.readdirSync(UPLOADS_DIR));
    expect(after).toEqual(before); // no residue from either request
  });
});

// ═══════════════════════════════════════════════════════════════════════
// STORAGE A–B — lib/storage.js config validation + local adapter
// ═══════════════════════════════════════════════════════════════════════
describe('P0.5A — Storage configuration', () => {
  test('Storage A: production with UPLOAD_STORAGE=s3 and missing credentials fails closed (never silently falls back to local)', () => {
    const result = validateStorageConfig({ NODE_ENV: 'production', UPLOAD_STORAGE: 's3' });
    expect(result.ok).toBe(false);
    const codes = result.problems.map(p => p.code);
    expect(codes).toEqual(expect.arrayContaining([
      'S3_ENDPOINT_MISSING', 'S3_BUCKET_MISSING', 'S3_ACCESS_KEY_ID_MISSING', 'S3_SECRET_ACCESS_KEY_MISSING',
    ]));
    expect(() => getStorage({ NODE_ENV: 'production', UPLOAD_STORAGE: 's3' })).toThrow(/Storage configuration invalid/);

    // A fully-specified config passes validation (no network call made here —
    // validateStorageConfig() is pure and never touches the filesystem/network).
    const complete = validateStorageConfig({
      NODE_ENV: 'production', UPLOAD_STORAGE: 's3',
      S3_ENDPOINT: 'https://fake.example.invalid', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's',
    });
    expect(complete.ok).toBe(true);
  });

  test('Storage B: local mode works end-to-end in an isolated temp directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p05a-storage-'));
    const adapter = getStorage({ UPLOAD_STORAGE: 'local', UPLOAD_LOCAL_ROOT: root });
    const key = buildTenantKey('tenant-storageB', 'imports', 'x.csv');

    expect(await adapter.exists(key)).toBe(false);
    await adapter.save(key, Buffer.from('hello'));
    expect(await adapter.exists(key)).toBe(true);
    expect((await adapter.read(key)).toString()).toBe('hello');
    await adapter.delete(key);
    expect(await adapter.exists(key)).toBe(false);
  });

  test('_sigV4: deterministic, well-formed, and sensitive to every signing input (regression/structural check)', () => {
    // NOTE: this is a self-consistency/regression check, not a verification
    // against AWS's official published SigV4 test-suite vectors — this
    // environment has no network access to fetch or independently confirm
    // those official values, and asserting a specific hex signature from
    // memory without the ability to verify it would risk baking in a WRONG
    // "golden" value that always passes for the wrong reason. What IS
        // verified: correct Authorization-header shape, full determinism for
    // identical inputs, and that every signing input actually changes the
    // output (i.e. the implementation is not silently ignoring any of
    // method/host/path/region/service/keys/date/payload). Operators must
    // still smoke-test against a real S3-compatible endpoint before relying
    // on this in production (see docs/UPLOAD_STORAGE_MIGRATION.md).
    const base = {
      method: 'GET', host: 'example.s3.amazonaws.com', path: '/bucket/key.txt',
      region: 'us-east-1', service: 's3', accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      now: new Date('2026-01-15T12:00:00Z'),
    };

    const r1 = _sigV4(base);
    const r2 = _sigV4({ ...base });
    expect(r1.authorization).toBe(r2.authorization); // deterministic for identical input

    expect(r1.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/
    );

    const variants = {
      method: { ...base, method: 'PUT' },
      host: { ...base, host: 'other.s3.amazonaws.com' },
      path: { ...base, path: '/bucket/other-key.txt' },
      region: { ...base, region: 'eu-west-1' },
      service: { ...base, service: 'other-service' },
      accessKeyId: { ...base, accessKeyId: 'AKIDDIFFERENT' },
      secretAccessKey: { ...base, secretAccessKey: 'differentSecretKeyDifferentSecretKey' },
      payloadHash: { ...base, payloadHash: '0'.repeat(64) },
      date: { ...base, now: new Date('2026-06-01T00:00:00Z') },
    };
    for (const [field, variant] of Object.entries(variants)) {
      const varied = _sigV4(variant);
      expect(varied.authorization).not.toBe(r1.authorization); // every input is load-bearing
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DURABILITY A–D
// ═══════════════════════════════════════════════════════════════════════
describe('P0.5A — Durable save semantics', () => {
  test('Durability A: a critical financial mutation (journal posting) is durably on disk immediately after the HTTP response returns — no wait, no manual flush', async () => {
    const res = await request(app).post('/api/journal').set('Authorization', `Bearer ${adminToken}`).send({
      date: '2026-02-10', desc: 'Durability A durable-ack test',
      lines: [{ accountCode: '1100', debit: 12, credit: 0 }, { accountCode: '4100', debit: 0, credit: 12 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Read directly from DISK — not the in-process cache — proving the
    // durable path actually completed the write before the HTTP response
    // was sent (unlike the debounced path, which needs a manual flush to
    // observe the eventual write — see Persistence A/C in
    // tests/production-hardening.test.js).
    const onDisk = fs.readJsonSync(process.env.DATA_FILE);
    expect(onDisk.journalEntries.some(e => e.id === res.body.id)).toBe(true);
  });

  test('Durability B: a forced durable-persistence failure returns a real error, never a false success, for a journal entry that only exists in RAM', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Deterministically force the durable write to fail: replace the
      // destination directory with a plain FILE, so fs.ensureDirSync()
      // throws before any write happens — the same technique
      // tests/production-hardening.test.js's Persistence B/D use, applied
      // here at the live HTTP route rather than the bare helper function.
      fs.removeSync(tmp);
      fs.writeFileSync(tmp, 'not-a-directory-anymore');
      try {
        const res = await request(app).post('/api/journal').set('Authorization', `Bearer ${adminToken}`).send({
          date: '2026-02-11', desc: 'Durability B forced-failure test',
          lines: [{ accountCode: '1100', debit: 7, credit: 0 }, { accountCode: '4100', debit: 0, credit: 7 }],
        });
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
      } finally {
        // Restore the shared tmp directory for every later test in this file.
        fs.removeSync(tmp);
        fs.ensureDirSync(tmp);
      }
    } finally {
      errSpy.mockRestore();
    }
  });

  test('Durability C: a non-critical route (vendor create) still works via the plain debounced saveDB(db) — unaffected by the new durable option', async () => {
    const res = await request(app).post('/api/vendors').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Durability-C-Vendor', phone: '000' });
    expect(res.status).toBe(200);
    // Reflected in the in-process cache immediately (routes read their own
    // write back correctly) even though the disk write is still debounced.
    let memDb; await runAsTenant('default', async () => { memDb = loadDB(); });
    expect((memDb.vendors || []).some(v => v.name === 'Durability-C-Vendor')).toBe(true);

    await runAsTenant('default', async () => {
      const db = loadDB();
      const result = saveDB(db); // the exact call every other non-critical route still makes
      expect(result).toBeUndefined(); // fire-and-forget, exactly as before P0.5A — no forced sync I/O
    });
  });

  test('Durability D: a tenant-A durable flush cannot accidentally flush or acknowledge tenant B\'s own pending debounced write', async () => {
    await runAsTenant('tenant-durB', async () => {
      const db = loadDB();
      db.__marker = 'tenant-b-pending-debounced';
      saveDB(db); // schedules a debounced write for tenant B — NOT durable
    });

    await runAsTenant('tenant-durA', async () => {
      const db = loadDB();
      db.__marker = 'tenant-a-durable';
      await saveDB(db, { durable: true }); // durable flush — must only touch tenant A
    });

    const fpA = path.join(tmp, 'tenants', 'tenant-durA.json');
    const fpB = path.join(tmp, 'tenants', 'tenant-durB.json');
    expect(fs.existsSync(fpA)).toBe(true);
    expect(fs.readJsonSync(fpA).__marker).toBe('tenant-a-durable');
    // Tenant B's debounced write must NOT have been force-flushed by tenant
    // A's durable call — its file must not exist yet (the 400ms debounce
    // has not elapsed since this assertion runs synchronously right after).
    expect(fs.existsSync(fpB)).toBe(false);
  });
});
