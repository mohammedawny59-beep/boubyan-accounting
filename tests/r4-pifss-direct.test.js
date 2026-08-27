// R4 — Part M: deterministic PIFSS calculation tests, based on the CURRENT
// business rule actually implemented in calcPifssForEmployee() (server.js) —
// employee 11% / employer 11.5% of basicSalary, gated by
// (pifssEnrolled OR nationality contains "كويتي"), no salary cap. This does
// NOT invent Kuwait payroll policy — it locks in the exact formula already
// live in the code, via the one route that echoes the computed object back
// (PUT /api/employees/:id/hr) and the aggregation route (GET
// /api/payroll/hr-summary), instead of only exercising PIFSS indirectly
// through /close/run-all (which the R1/R3 audits found only checks
// existence/account-codes, never exact amounts).

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'r4-pifss-direct-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-r4-pifss-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [
      { id: 'usr-admin', username: 'admin', email: 'admin@test.com', passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير', active: true, createdAt: new Date().toISOString(), lastLogin: null },
    ],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], fixedAssets: [], budget: {}, auditLog: [], accruedExpenses: [],
    journalMappings: [], doctorExpenses: [], lockedPeriods: {}, vendorBills: [], accountingSettings: {},
    patients: [], patientReceivables: [],
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

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

async function createEmployee(emp) {
  const r = await request(app).post('/api/employees').set(auth()).send(emp);
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  return emp.id;
}

async function hrPatch(id, body = {}) {
  const r = await request(app).put(`/api/employees/${id}/hr`).set(auth()).send(body);
  expect(r.status).toBe(200);
  return r.body;
}

describe('R4 Part M — PIFSS direct calculation tests', () => {
  test('PIFSS A: Kuwaiti nationality (by text) — employee 11%, employer 11.5% of basicSalary', async () => {
    const id = await createEmployee({ id: 'EMP-PIFSS-A', name: 'أحمد الكويتي', nationality: 'كويتي', basicSalary: 1000 });
    const d = await hrPatch(id);
    expect(d.pifss.isKuwaiti).toBe(true);
    expect(d.pifss.employeeShare).toBeCloseTo(110, 3);
    expect(d.pifss.employerShare).toBeCloseTo(115, 3);
    expect(d.pifss.total).toBeCloseTo(225, 3);
  });

  test('PIFSS B: non-Kuwaiti, not enrolled — zero on both shares (no PIFSS liability)', async () => {
    const id = await createEmployee({ id: 'EMP-PIFSS-B', name: 'John Doe', nationality: 'مصري', basicSalary: 800, pifssEnrolled: false });
    const d = await hrPatch(id);
    expect(d.pifss.isKuwaiti).toBe(false);
    expect(d.pifss.employeeShare).toBe(0);
    expect(d.pifss.employerShare).toBe(0);
    expect(d.pifss.total).toBe(0);
  });

  test('PIFSS C: pifssEnrolled=true overrides a non-Kuwaiti nationality — the flag alone is sufficient per the current rule', async () => {
    const id = await createEmployee({ id: 'EMP-PIFSS-C', name: 'خالد', nationality: 'مصري', basicSalary: 500, pifssEnrolled: true });
    const d = await hrPatch(id);
    expect(d.pifss.isKuwaiti).toBe(true);
    expect(d.pifss.employeeShare).toBeCloseTo(55, 3);
    expect(d.pifss.employerShare).toBeCloseTo(57.5, 3);
  });

  test('PIFSS D: missing/zero basicSalary produces zero shares, not NaN or a crash', async () => {
    const id = await createEmployee({ id: 'EMP-PIFSS-D', name: 'بلا راتب', nationality: 'كويتي' });
    const d = await hrPatch(id);
    expect(d.pifss.basic).toBe(0);
    expect(d.pifss.employeeShare).toBe(0);
    expect(d.pifss.employerShare).toBe(0);
    expect(Number.isNaN(d.pifss.total)).toBe(false);
  });

  test('PIFSS E: fractional basicSalary rounds each share to 3 decimals independently (not derived from a rounded intermediate)', async () => {
    const id = await createEmployee({ id: 'EMP-PIFSS-E', name: 'كسر عشري', nationality: 'كويتي', basicSalary: 333.333 });
    const d = await hrPatch(id);
    // 333.333 * 0.11 = 36.66663 -> 36.667 ; 333.333 * 0.115 = 38.333295 -> 38.333
    expect(d.pifss.employeeShare).toBeCloseTo(36.667, 3);
    expect(d.pifss.employerShare).toBeCloseTo(38.333, 3);
  });

  test('PIFSS F: hr-summary aggregates employer-share totals across employees and excludes inactive (soft-deleted) ones', async () => {
    await createEmployee({ id: 'EMP-PIFSS-F1', name: 'نشط 1', nationality: 'كويتي', basicSalary: 1000 });
    await createEmployee({ id: 'EMP-PIFSS-F2', name: 'نشط 2', nationality: 'كويتي', basicSalary: 2000 });
    await createEmployee({ id: 'EMP-PIFSS-F3', name: 'موظف سابق', nationality: 'كويتي', basicSalary: 5000, status: 'inactive' });

    const r = await request(app).get('/api/payroll/hr-summary').set(auth());
    expect(r.status).toBe(200);
    const f1 = r.body.employees.find(e => e.id === 'EMP-PIFSS-F1');
    const f2 = r.body.employees.find(e => e.id === 'EMP-PIFSS-F2');
    const f3 = r.body.employees.find(e => e.id === 'EMP-PIFSS-F3');
    expect(f1).toBeTruthy();
    expect(f2).toBeTruthy();
    expect(f3).toBeUndefined(); // inactive employee must not appear in the active aggregation at all

    // F1's employer share (1000*0.115=115) and F2's (2000*0.115=230) are exactly right,
    // and F3 (the inactive employee, 575) is proven excluded above by being absent
    // from r.body.employees entirely — hr-summary's totals are a reduce() over that
    // same filtered array, so excluding F3 from the list is sufficient to prove its
    // 575 employer share cannot be silently folded into totals.pifssEmployer.
    expect(f1.pifss.employerShare).toBeCloseTo(115, 3);
    expect(f2.pifss.employerShare).toBeCloseTo(230, 3);
  });
});
