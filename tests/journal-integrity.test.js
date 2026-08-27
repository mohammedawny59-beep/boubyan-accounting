// P0.2 — Accounting Integrity Guardrails, proven over the REAL Express app +
// REAL middleware/route stack (Supertest), exercising the centralized
// journal guard (lib/journalGuard.js) exactly as every real workflow does.
//
// Safety: DB_FILE_ONLY=true (no MongoDB ever touched), DATA_FILE/CONFIG_FILE
// point at a fresh os.tmpdir() directory removed in afterAll(). No production
// or real tenant data is read or written anywhere in this file.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-2-journal-integrity-test-secret';
process.env.NODE_ENV     = 'test';

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-journal-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB, warmTenantCache } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [{
      id: 'usr-admin', username: 'admin', email: 'admin@clinic.com',
      passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير',
      active: true, createdAt: new Date().toISOString(), lastLogin: null,
    }],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [],
    chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: { name: 'عيادة الاختبار' }, scheduleConfig: {},
    vouchers: [], cashReconciliation: [], insuranceClaims: [], payroll: [],
    employees: [], fixedAssets: [], assets: [], budget: {}, auditLog: [],
    accruedExpenses: [], journalMappings: [], doctorExpenses: [], lockedPeriods: {},
  };
}

let token;
const OPEN_DATE   = '2031-03-15';   // a period we never lock in these tests
const OPEN_MONTH  = '2031-03';
const LOCK_MONTH  = '2031-01';
const LOCK_DATE   = '2031-01-15';

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
  token = login.body.token;

  // Lock LOCK_MONTH so every "locked period" test has a real closed period to hit.
  await request(app).post('/api/period-lock').set('Authorization', `Bearer ${token}`).send({ period: LOCK_MONTH, locked: true });
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

describe('P0.2 — Central journal guard: core invariants (Tests A/B/C)', () => {
  test('Test A: a balanced open-period manual journal succeeds', async () => {
    const res = await auth(request(app).post('/api/journal')).send({
      date: OPEN_DATE, desc: 'Test A balanced entry',
      lines: [
        { accountCode: '1100', debit: 10, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 10 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('Test B: an unbalanced journal is rejected', async () => {
    const res = await auth(request(app).post('/api/journal')).send({
      date: OPEN_DATE, desc: 'Test B unbalanced entry',
      lines: [
        { accountCode: '1100', debit: 10, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 5 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNBALANCED');
  });

  test('Test C: an unknown account code is rejected', async () => {
    const res = await auth(request(app).post('/api/journal')).send({
      date: OPEN_DATE, desc: 'Test C phantom account',
      lines: [
        { accountCode: '9999', debit: 10, credit: 0 },
        { accountCode: '4100', debit: 0, credit: 10 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_ACCOUNT');
  });

  test('rejects a line with both debit and credit set, and a negative amount', async () => {
    const dual = await auth(request(app).post('/api/journal')).send({
      date: OPEN_DATE, desc: 'dual-sided',
      lines: [{ accountCode: '1100', debit: 10, credit: 5 }, { accountCode: '4100', debit: 0, credit: 5 }],
    });
    expect(dual.status).toBe(400);

    const neg = await auth(request(app).post('/api/journal')).send({
      date: OPEN_DATE, desc: 'negative amount',
      lines: [{ accountCode: '1100', debit: -10, credit: 0 }, { accountCode: '4100', debit: 0, credit: -10 }],
    });
    expect(neg.status).toBe(400);
  });
});

describe('P0.2 — Period lock coverage across workflows (Tests D–J)', () => {
  test('Test D: a locked-period manual journal is rejected (409)', async () => {
    const res = await auth(request(app).post('/api/journal')).send({
      date: LOCK_DATE, desc: 'Test D locked manual',
      lines: [{ accountCode: '1100', debit: 10, credit: 0 }, { accountCode: '4100', debit: 0, credit: 10 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('Test E: locked-period payroll accrual is rejected (409)', async () => {
    const res = await auth(request(app).post('/api/payroll')).send({
      month: LOCK_MONTH,
      entries: [{ name: 'Test Employee', role: 'admin', basicSalary: 100, allowances: 0, deductions: 0 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('Test F: a locked-period voucher is rejected (409)', async () => {
    const res = await auth(request(app).post('/api/vouchers')).send({
      type: 'receipt', date: LOCK_DATE, assetAccId: '1100',
      lines: [{ accountId: '4100', amount: 20 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('Test G: a recurring expense due in a locked period is skipped, not posted', async () => {
    // Lock the current month so recurringIsDue's "today" falls inside it.
    const thisMonth = new Date().toISOString().slice(0, 7);
    await auth(request(app).post('/api/period-lock')).send({ period: thisMonth, locked: true });

    await runAsTenant('default', async () => {
      const db = loadDB();
      db.recurringExpenses = db.recurringExpenses || [];
      db.recurringExpenses.push({ id: 'REC-TESTG', desc: 'Test G recurring', cat: 'إيجار', amount: 15, day: 1, frequency: 'monthly' });
      saveDB(db);
    });

    const res = await auth(request(app).post('/api/recurring/run')).send({});
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(0);

    await runAsTenant('default', async () => {
      const db = loadDB();
      expect((db.journalEntries || []).some(j => j.desc === 'Test G recurring (متكرر)')).toBe(false);
      expect((db.expenses || []).some(e => e.desc === 'Test G recurring (متكرر)')).toBe(false);
    });

    // Unlock again so it doesn't interfere with later tests in this file.
    await auth(request(app).post('/api/period-lock')).send({ period: thisMonth, locked: false });
  });

  test('Test H: locked-period inventory posting is rejected (409)', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.invItems = db.invItems || [];
      db.invItems.push({ id: 'ITEM-H', name: 'Test Item', qty: 0, cost: 0 });
      saveDB(db);
    });
    const res = await auth(request(app).post('/api/inv/operation')).send({
      type: 'purchase', date: LOCK_DATE, payAccount: '1100',
      lines: [{ itemId: 'ITEM-H', qty: 5, cost: 2 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('Test I: depreciation into a locked period is rejected (409)', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.fixedAssets = db.fixedAssets || [];
      db.fixedAssets.push({
        id: 'AST-I', name: 'Test Asset', cost: 1200, salvageValue: 0, usefulLife: 5,
        accumulatedDep: 0, status: 'active', depExpAccount: '5800', accDepAccount: '1590',
      });
      saveDB(db);
    });
    const res = await auth(request(app).post('/api/assets/depreciate')).send({ period: LOCK_MONTH });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('Test J: a locked-period AI-confirmed journal entry is rejected (409)', async () => {
    const res = await auth(request(app).post('/api/ai/confirm-entry')).send({
      suggestion: {
        date: LOCK_DATE, description: 'Test J AI entry',
        lines: [{ accountCode: '1100', debit: 8, credit: 0 }, { accountCode: '4100', debit: 0, credit: 8 }],
      },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });
});

describe('P0.2 — Phantom account elimination (Test K) and PIFSS/EOS accounts (Test L)', () => {
  test('Test K: an automated posting path can no longer reference a phantom account — inventory purchase now posts to real account 1300, never the old phantom 1160', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.invItems = db.invItems || [];
      db.invItems.push({ id: 'ITEM-K', name: 'Test Item K', qty: 0, cost: 0 });
      saveDB(db);
    });
    const res = await auth(request(app).post('/api/inv/operation')).send({
      type: 'purchase', date: OPEN_DATE, payAccount: '1100',
      lines: [{ itemId: 'ITEM-K', qty: 3, cost: 4 }],
    });
    expect(res.status).toBe(200);

    await runAsTenant('default', async () => {
      const db = loadDB();
      const je = (db.journalEntries || []).find(j => j.type === 'inventory' && j.desc.includes('شراء'));
      expect(je).toBeDefined();
      const codes = je.lines.map(l => l.accountCode);
      expect(codes).toContain('1300');
      expect(codes).not.toContain('1160');
      // 1300 must be a real, resolvable account in the tenant's own COA.
      expect((db.chartOfAccounts || []).some(a => a.code === '1300')).toBe(true);
    });
  });

  test('Test L: PIFSS and EOS postings use accounts that genuinely exist in the chart of accounts', async () => {
    await runAsTenant('default', async () => {
      const db = loadDB();
      db.employees = db.employees || [];
      db.employees.push({
        id: 'EMP-L', name: 'Kuwaiti Employee', basicSalary: 500,
        nationality: 'كويتي', pifssEnrolled: true,
        hireDate: '2020-01-01',
      });
      saveDB(db);
    });

    // EOS — standalone route.
    const eosRes = await auth(request(app).post('/api/payroll/eos-run')).send({ month: OPEN_MONTH });
    expect(eosRes.status).toBe(200);
    const eosCodes = (eosRes.body.journalEntry.lines || []).map(l => l.accountCode);
    expect(eosCodes).toEqual(expect.arrayContaining(['5140', '2700']));
    expect(eosCodes).not.toContain('5260');
    expect(eosCodes).not.toContain('2300');

    // PIFSS — only reachable via month-end close; use a fresh open month.
    const closeRes = await auth(request(app).post('/api/close/run-all')).send({
      month: OPEN_MONTH, options: { depreciation: false, eos: false, closing: false, lock: false },
    });
    expect(closeRes.status).toBe(200);
    const pifssStep = closeRes.body.log.find(s => s.id === 'pifss');
    expect(pifssStep.status).toBe('done');

    await runAsTenant('default', async () => {
      const db = loadDB();
      const coa = db.chartOfAccounts || [];
      const je = (db.journalEntries || []).find(j => j.type === 'pifss');
      expect(je).toBeDefined();
      const codes = je.lines.map(l => l.accountCode);
      expect(codes).toEqual(expect.arrayContaining(['5130', '2600']));
      expect(codes).not.toContain('5250');
      // Every code the entry references must resolve in the COA (the core P0.2 invariant).
      for (const code of codes) expect(coa.some(a => a.code === code)).toBe(true);
    });
  });
});

describe('P0.2 — Financial statement integrity (Test M)', () => {
  test('Test M: automated postings (inventory purchase expense side, EOS/PIFSS) are recognized correctly and never silently dropped', async () => {
    const pnl = await auth(request(app).get(`/api/reports/pnl?from=2031-01-01&to=2031-12-31`));
    expect(pnl.status).toBe(200);
    // The Test L PIFSS/EOS expense lines (5130/5140) must surface in the P&L.
    const codes = pnl.body.expenses.map(e => e.code);
    expect(codes).toEqual(expect.arrayContaining(['5130', '5140']));

    // Trial-balance-equivalent: every account referenced anywhere in the
    // journal universe must resolve in the COA (no "unknown account" rows).
    await runAsTenant('default', async () => {
      const db = loadDB();
      const coa = db.chartOfAccounts || [];
      const coaCodes = new Set(coa.map(a => a.code));
      const allCodes = new Set();
      (db.journalEntries || []).forEach(je => (je.lines || []).forEach(l => {
        const c = l.accountCode || l.account; if (c) allCodes.add(String(c));
      }));
      const unresolved = [...allCodes].filter(c => !coaCodes.has(c));
      expect(unresolved).toEqual([]);
    });
  });
});

describe('P0.2 — Default tenant regression and tenant isolation (Tests N/O)', () => {
  test('Test N: the default/existing-tenant accounting flow still works end to end', async () => {
    const create = await auth(request(app).post('/api/journal')).send({
      date: OPEN_DATE, desc: 'Test N regression entry',
      lines: [{ accountCode: '1100', debit: 33, credit: 0 }, { accountCode: '4100', debit: 0, credit: 33 }],
    });
    expect(create.status).toBe(200);
    const data = await auth(request(app).get('/api/data'));
    expect(data.body.journalEntries.some(j => j.desc === 'Test N regression entry')).toBe(true);
  });

  test('Test O: journal validation stays isolated between Tenant A and Tenant B (P0.1 boundary still holds)', async () => {
    await runAsTenant('tenant-a-p02', async () => {
      await warmTenantCache('tenant-a-p02');
      const db = loadDB();
      db.users = [{ id: 'u-a', tenantId: 'tenant-a-p02', username: 'owner-a-p02', passwordHash: hash('PassA!123'), role: 'admin', active: true }];
      db.chartOfAccounts = [
        { id: '1100', code: '1100', name: 'Cash', type: 'asset' },
        { id: '4100', code: '4100', name: 'Revenue', type: 'revenue' },
      ];
      db.lockedPeriods = { [LOCK_MONTH]: true };
      saveDB(db);
    });
    await runAsTenant('tenant-b-p02', async () => {
      await warmTenantCache('tenant-b-p02');
      const db = loadDB();
      db.users = [{ id: 'u-b', tenantId: 'tenant-b-p02', username: 'owner-b-p02', passwordHash: hash('PassB!123'), role: 'admin', active: true }];
      db.chartOfAccounts = [
        { id: '1100', code: '1100', name: 'Cash', type: 'asset' },
        { id: '4100', code: '4100', name: 'Revenue', type: 'revenue' },
      ];
      // Tenant B never locks LOCK_MONTH.
      saveDB(db);
    });

    const loginA = await request(app).post('/api/auth/login').send({ username: 'owner-a-p02', password: 'PassA!123', tenantId: 'tenant-a-p02' });
    const loginB = await request(app).post('/api/auth/login').send({ username: 'owner-b-p02', password: 'PassB!123', tenantId: 'tenant-b-p02' });

    const entryBody = {
      date: LOCK_DATE, desc: 'cross-tenant lock check',
      lines: [{ accountCode: '1100', debit: 5, credit: 0 }, { accountCode: '4100', debit: 0, credit: 5 }],
    };
    const resA = await request(app).post('/api/journal').set('Authorization', `Bearer ${loginA.body.token}`).send(entryBody);
    const resB = await request(app).post('/api/journal').set('Authorization', `Bearer ${loginB.body.token}`).send(entryBody);

    expect(resA.status).toBe(409); // A's period is locked
    expect(resB.status).toBe(200); // B's identical period is open — independent guard state
  });
});

describe('P0.2 — Bulk import atomicity (Test P)', () => {
  test('Test P: a bulk journal batch with one invalid entry leaves the database completely unchanged', async () => {
    let before;
    await runAsTenant('default', async () => { before = (loadDB().journalEntries || []).length; });

    const res = await auth(request(app).post('/api/journal/bulk')).send({
      entries: [
        { date: OPEN_DATE, ref: 'BATCH-OK', description: 'valid batch row', lines: [{ accountCode: '1100', debit: 7, credit: 0 }, { accountCode: '4100', debit: 0, credit: 7 }] },
        { date: OPEN_DATE, ref: 'BATCH-BAD', description: 'unbalanced batch row', lines: [{ accountCode: '1100', debit: 7, credit: 0 }, { accountCode: '4100', debit: 0, credit: 3 }] },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.saved).toBe(0);

    await runAsTenant('default', async () => {
      const db = loadDB();
      expect((db.journalEntries || []).length).toBe(before);
      expect((db.journalEntries || []).some(j => j.ref === 'BATCH-OK')).toBe(false);
    });
  });
});
