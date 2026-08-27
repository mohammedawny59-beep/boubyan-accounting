// P0.8 — Patient Accounts Receivable & Collections (P6-029).
//
// Isolated, real-app tests (DB_FILE_ONLY, os.tmpdir()) via supertest against
// the real exported Express app — no production data, no real network.
// Covers the new db.patients[]/db.patientReceivables[] subledger:
// recognition, cash-sale-creates-no-AR, partial/full collection,
// idempotency, credits/cancellation, bad-debt write-off, patient statement,
// AR aging (non-insurance), GL reconciliation (honest, not forced), import
// non-integration (evidence-based — see server.js's own forensic comment
// block above the module), RBAC, audit, tenant isolation, persistence
// survival, and regression of P0.6A/P0.6B/P0.7 scenarios.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'p0-8-ar-lifecycle-secret';
process.env.NODE_ENV     = 'test';

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const bcrypt  = require('bcryptjs');
const request = require('supertest');
const XLSX    = require('xlsx');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p08-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB, warmTenantCache } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [
      { id: 'usr-admin', username: 'admin', email: 'admin@test.com', passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير', active: true, createdAt: new Date().toISOString(), lastLogin: null },
      { id: 'usr-recep', username: 'receptionist1', email: 'r@test.com', passwordHash: hash('RecepPass1!'), role: 'receptionist', fullName: 'استقبال', active: true, createdAt: new Date().toISOString(), lastLogin: null },
      { id: 'usr-inv',   username: 'inventory1', email: 'i@test.com', passwordHash: hash('InvPass1!'), role: 'inventory', fullName: 'مخزون', active: true, createdAt: new Date().toISOString(), lastLogin: null },
    ],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], fixedAssets: [], budget: {}, auditLog: [], accruedExpenses: [],
    journalMappings: [], doctorExpenses: [], lockedPeriods: {}, vendorBills: [], accountingSettings: {},
    patientAR: [], patients: [], patientReceivables: [],
  };
}

let adminToken, recepToken, invToken;

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
  const login2 = await request(app).post('/api/auth/login').send({ username: 'receptionist1', password: 'RecepPass1!' });
  recepToken = login2.body.token;
  const login3 = await request(app).post('/api/auth/login').send({ username: 'inventory1', password: 'InvPass1!' });
  invToken = login3.body.token;
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

async function createPatient(name, fileNumber) {
  const res = await request(app).post('/api/patients').set(auth()).send({ name, fileNumber: fileNumber || '' });
  expect(res.status).toBe(200);
  return res.body.patient;
}

async function runAsTenantRec(recId) {
  let rec;
  await runAsTenant('default', async () => { rec = loadDB().patientReceivables.find(r => r.id === recId); });
  return rec;
}

async function runAsTenantJe(jeId) {
  let je;
  await runAsTenant('default', async () => { je = loadDB().journalEntries.find(j => j.id === jeId); });
  return je;
}

// ═══════════════════════════════════════════════════════════════════════
// AR Recognition A-F
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — Recognition: credit patient revenue (P6-029)', () => {
  test('Recognition A: a posted credit receivable produces the correct Dr AR / Cr Revenue journal', async () => {
    const patient = await createPatient('Patient-Rec-A');
    const res = await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-05-01', amount: 1000, description: 'حشو أسنان',
    });
    expect(res.status).toBe(200);
    const rec = res.body.receivable;
    expect(rec.grossAmount).toBeCloseTo(1000, 3);
    expect(rec.outstandingAmount).toBeCloseTo(1000, 3);
    expect(rec.status).toBe('POSTED');
    const je = await runAsTenantJe(rec.recognitionJournalId);
    expect(je).toBeTruthy();
    const arLine  = je.lines.find(l => l.accountCode === '1200');
    const revLine = je.lines.find(l => l.accountCode === '4200');
    expect(arLine.debit).toBeCloseTo(1000, 3);
    expect(revLine.credit).toBeCloseTo(1000, 3);
  });

  test('Recognition B: an unknown patient is rejected', async () => {
    const res = await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: 'PAT-DOES-NOT-EXIST', serviceDate: '2049-05-01', amount: 500,
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
  });

  test('Recognition C: an invalid/unknown account is rejected', async () => {
    const patient = await createPatient('Patient-Rec-C');
    const res = await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-05-01', amount: 500, revenueAccountCode: '9999-NOPE',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_ACCOUNT');
  });

  test('Recognition D: a receivable dated into an already-locked period is rejected', async () => {
    const patient = await createPatient('Patient-Rec-D');
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2049-06', locked: true }).expect(200);
    const res = await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-06-10', amount: 300,
    });
    // Posting a receivable creates a brand-new journal entry, so — same
    // reasoning independently re-verified in P0.7 — this is the CREATE-path
    // guard (409/PERIOD_LOCKED via validateJournalEntry's Invariant B), not
    // the DELETE/UNDO guard (403/assertFinancialPeriodOpen).
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('Recognition E: a duplicate reference for the same patient is rejected', async () => {
    const patient = await createPatient('Patient-Rec-E');
    await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-05-02', amount: 200, reference: 'INV-500',
    }).expect(200);
    const res = await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-05-03', amount: 250, reference: 'INV-500',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_REFERENCE');
  });

  test('Recognition F: a forced durable-persistence failure returns a real error, never a false success', async () => {
    const patient = await createPatient('Patient-Rec-F');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fs.removeSync(tmp);
      fs.writeFileSync(tmp, 'not-a-directory-anymore');
      try {
        const res = await request(app).post('/api/patient-receivables').set(auth()).send({
          patientId: patient.id, serviceDate: '2049-05-04', amount: 400,
        });
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
      } finally {
        fs.removeSync(tmp);
        fs.ensureDirSync(tmp);
      }
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cash/KNET Revenue A-B — critical: must create NO lingering AR
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — Immediate cash/KNET revenue creates no patient AR', () => {
  test('Cash A: an immediate cash payment (manual-entry) creates no AR', async () => {
    let before;
    await runAsTenant('default', async () => { before = loadDB().patientReceivables.length; });
    const res = await request(app).post('/api/manual-entry').set(auth()).send({ date: '2049-05-05', cash: 500 });
    expect(res.status).toBe(200);
    let after, je;
    await runAsTenant('default', async () => {
      const db = loadDB();
      after = db.patientReceivables.length;
      // POST /api/manual-entry's response carries the dailyData entry
      // (`entry.id`), not a journal id — the journal itself is identified
      // by its own ref/type/date, so look it up that way.
      je = db.journalEntries.find(j => j.type === 'revenue' && j.ref === 'MAN' && j.date === '2049-05-05');
    });
    expect(after).toBe(before); // zero new patient receivables
    expect(je.lines.some(l => l.accountCode === '1200')).toBe(false); // no AR account touched at all
  });

  test('Cash B: an immediate KNET payment (manual-entry) creates no lingering AR', async () => {
    let before;
    await runAsTenant('default', async () => { before = loadDB().patientReceivables.length; });
    const res = await request(app).post('/api/manual-entry').set(auth()).send({ date: '2049-05-06', knet: 300 });
    expect(res.status).toBe(200);
    let after, je;
    await runAsTenant('default', async () => {
      const db = loadDB();
      after = db.patientReceivables.length;
      je = db.journalEntries.find(j => j.type === 'revenue' && j.ref === 'MAN' && j.date === '2049-05-06');
    });
    expect(after).toBe(before);
    expect(je.lines.some(l => l.accountCode === '1200')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Collections A-F
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — Collections: settles AR, never re-recognizes revenue', () => {
  test('Collection A: a partial collection reduces outstanding correctly (1,000 -> 700)', async () => {
    const patient = await createPatient('Patient-Coll-A');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-07-01', amount: 1000,
    })).body.receivable;
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 300, collectDate: '2049-07-05', collectAccount: '1100' });
    expect(res.status).toBe(200);
    expect(res.body.receivable.outstandingAmount).toBeCloseTo(700, 3);
    expect(res.body.receivable.status).toBe('PARTIALLY_COLLECTED');
  });

  test('Collection B: the final collection closes the receivable (outstanding 0, status COLLECTED)', async () => {
    const patient = await createPatient('Patient-Coll-B');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-07-01', amount: 1000,
    })).body.receivable;
    await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 300, collectDate: '2049-07-05', collectAccount: '1100' }).expect(200);
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 700, collectDate: '2049-07-10', collectAccount: '1100' });
    expect(res.status).toBe(200);
    expect(res.body.receivable.outstandingAmount).toBeCloseTo(0, 3);
    expect(res.body.receivable.status).toBe('COLLECTED');
    let recState;
    await runAsTenant('default', async () => { recState = loadDB().patientReceivables.find(r => r.id === rec.id); });
    const bm = require('../server'); // app already loaded; recompute GL for this item via statement instead
    const stmt = await request(app).get(`/api/patients/${patient.id}/statement`).set(auth());
    expect(stmt.body.endingBalance).toBeCloseTo(0, 3);
  });

  test('Collection C: overcollection (beyond outstanding) is rejected', async () => {
    const patient = await createPatient('Patient-Coll-C');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-07-01', amount: 500,
    })).body.receivable;
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 600, collectAccount: '1100' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OVERCOLLECTION');
  });

  test('Collection D: a retried collection request with the same clientRef is idempotent, not duplicated', async () => {
    const patient = await createPatient('Patient-Coll-D');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-07-01', amount: 500,
    })).body.receivable;
    const first = await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 200, collectAccount: '1100', clientRef: 'RETRY-KEY-8' });
    const retry = await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 200, collectAccount: '1100', clientRef: 'RETRY-KEY-8' });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(true);
    expect(retry.body.receivable.outstandingAmount).toBeCloseTo(300, 3); // not 100
  });

  test('Collection E: a collection dated into a locked period is rejected', async () => {
    const patient = await createPatient('Patient-Coll-E');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-08-01', amount: 400,
    })).body.receivable;
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2049-09', locked: true }).expect(200);
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 100, collectDate: '2049-09-15', collectAccount: '1100' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('Collection F: a forced durable-persistence failure during collection returns a real error, never a false success', async () => {
    const patient = await createPatient('Patient-Coll-F');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-07-01', amount: 300,
    })).body.receivable;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try {
      fs.removeSync(tmp);
      fs.writeFileSync(tmp, 'not-a-directory-anymore');
      try {
        res = await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 100, collectAccount: '1100' });
      } finally {
        fs.removeSync(tmp);
        fs.ensureDirSync(tmp);
      }
    } finally {
      errSpy.mockRestore();
    }
    // Same assertion boundary as P0.7's own "Payment F"/"Bill F": the route
    // mutates the in-memory cached `rec` BEFORE attempting the durable save
    // (same prepare-then-commit-to-disk pattern used everywhere in this
    // codebase), so the in-memory object is not a meaningful atomicity
    // witness here — the durable-save failure is only observable, and only
    // meaningful to a caller, via the HTTP response itself never claiming a
    // false success.
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Statement A-B
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — Patient Statement: chronological running balance', () => {
  test('Statement A: running balance is correct across receivable + collection + credit', async () => {
    const patient = await createPatient('Patient-Stmt-A');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-04-01', amount: 800,
    })).body.receivable;
    await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 300, collectDate: '2049-04-05', collectAccount: '1100' }).expect(200);
    await request(app).post(`/api/patient-receivables/${rec.id}/credit`).set(auth()).send({ amount: 100, reason: 'خصم', date: '2049-04-06' }).expect(200);

    const stmt = await request(app).get(`/api/patients/${patient.id}/statement`).set(auth());
    expect(stmt.body.rows.length).toBe(3);
    expect(stmt.body.rows[0].runningBalance).toBeCloseTo(800, 3);
    expect(stmt.body.rows[1].runningBalance).toBeCloseTo(500, 3);
    expect(stmt.body.rows[2].runningBalance).toBeCloseTo(400, 3);
  });

  test('Statement B: the statement ending balance equals the derived patient outstanding', async () => {
    const patient = await createPatient('Patient-Stmt-B');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2049-04-01', amount: 900,
    })).body.receivable;
    await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 250, collectAccount: '1100' }).expect(200);

    const stmt = await request(app).get(`/api/patients/${patient.id}/statement`).set(auth());
    let recs;
    await runAsTenant('default', async () => { recs = loadDB().patientReceivables.filter(r => r.patientId === patient.id); });
    const expectedOutstanding = recs.reduce((s, r) => s + r.outstandingAmount, 0);
    expect(stmt.body.endingBalance).toBeCloseTo(expectedOutstanding, 3);
    expect(stmt.body.endingBalance).toBeCloseTo(650, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AR Aging A-D
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — AR Aging: non-insurance patient receivables', () => {
  test('Aging A: multiple receivables land in the correct aging buckets', async () => {
    const patient = await createPatient('Patient-Aging-A');
    const items = [
      { due: '2050-01-15', amount: 100 }, // 15 days before asOf -> current
      { due: '2049-12-15', amount: 200 }, // 46 days -> days30
      { due: '2049-11-15', amount: 300 }, // 76 days -> days60
      { due: '2049-10-15', amount: 400 }, // ~107 days -> over90 (avoids 2049-09, locked by an earlier Collection-E test in this shared-tenant file)
    ];
    for (const it of items) {
      const res = await request(app).post('/api/patient-receivables').set(auth()).send({
        patientId: patient.id, serviceDate: it.due, dueDate: it.due, amount: it.amount,
      });
      expect(res.status).toBe(200);
    }
    const aging = await request(app).get('/api/patient-ar-aging').set(auth()).query({ asOf: '2050-01-30' });
    const row = aging.body.rows.find(r => r.patient === 'Patient-Aging-A');
    expect(row.buckets.current).toBeCloseTo(100, 3);
    expect(row.buckets.days30).toBeCloseTo(200, 3);
    expect(row.buckets.days60).toBeCloseTo(300, 3);
    expect(row.buckets.over90).toBeCloseTo(400, 3);
    expect(row.total).toBeCloseTo(1000, 3);
  });

  test('Aging B: a partially-collected receivable ages only its outstanding remainder', async () => {
    const patient = await createPatient('Patient-Aging-B');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-01-01', dueDate: '2050-01-01', amount: 800,
    })).body.receivable;
    await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 300, collectAccount: '1100' }).expect(200);

    const aging = await request(app).get('/api/patient-ar-aging').set(auth()).query({ asOf: '2050-01-10' });
    const row = aging.body.rows.find(r => r.patient === 'Patient-Aging-B');
    expect(row.total).toBeCloseTo(500, 3); // never 800
  });

  test('Aging C: a fully-collected receivable is excluded from aging entirely', async () => {
    const patient = await createPatient('Patient-Aging-C');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-01-01', amount: 350,
    })).body.receivable;
    await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 350, collectAccount: '1100' }).expect(200);

    const aging = await request(app).get('/api/patient-ar-aging').set(auth()).query({ asOf: '2050-01-10' });
    const row = aging.body.rows.find(r => r.patient === 'Patient-Aging-C');
    expect(row).toBeUndefined();
  });

  test('Aging D: multiple patients total correctly, each isolated to their own row', async () => {
    const vA = await createPatient('Patient-Aging-D-A');
    const vB = await createPatient('Patient-Aging-D-B');
    await request(app).post('/api/patient-receivables').set(auth()).send({ patientId: vA.id, serviceDate: '2050-02-01', amount: 600 }).expect(200);
    await request(app).post('/api/patient-receivables').set(auth()).send({ patientId: vB.id, serviceDate: '2050-02-01', amount: 900 }).expect(200);

    const aging = await request(app).get('/api/patient-ar-aging').set(auth()).query({ asOf: '2050-02-05' });
    const rowA = aging.body.rows.find(r => r.patient === 'Patient-Aging-D-A');
    const rowB = aging.body.rows.find(r => r.patient === 'Patient-Aging-D-B');
    expect(rowA.total).toBeCloseTo(600, 3);
    expect(rowB.total).toBeCloseTo(900, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AR Reconciliation A-B
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — AR Reconciliation: subledger vs GL, honest not forced', () => {
  test('Reconciliation A: the AR subledger total reconciles exactly to the GL for clean data', async () => {
    const patient = await createPatient('Patient-Recon-A');
    await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-03-01', amount: 777,
    }).expect(200);

    const aging = await request(app).get('/api/patient-ar-aging').set(auth()).query({ asOf: '2050-03-10' });
    const row = aging.body.rows.find(r => r.patient === 'Patient-Recon-A');
    expect(row.total).toBeCloseTo(777, 3);
    // Global reconciliation flag is also expected true here since every
    // receivable in this whole test file posts exclusively through
    // buildAndPostPatientReceivable()/postPatientReceivableCredit() up to
    // this point in file order — no ad-hoc journal touching 1200 yet.
    expect(aging.body.reconciliation.reconciled).toBe(true);
    expect(aging.body.reconciliation.difference).toBeCloseTo(0, 3);
  });

  test('Reconciliation B: a historical patient-opening balance plus an out-of-subledger 1200 movement causes an honestly-reported (not hidden) difference', async () => {
    const before = await request(app).get('/api/patient-ar-aging').set(auth()).query({ asOf: '2050-04-15' });
    const glBefore = before.body.reconciliation.glTotal;
    const subBefore = before.body.reconciliation.subledgerTotal;

    // Step 1: a legacy patient-opening import (real Dr 1200 / Cr 3100 journal).
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([
      { 'اسم المريض': 'Patient-ReconB-Legacy', 'المبلغ المستحق (د.ك)': 300, 'التاريخ الافتتاحي': '2050-04-01', 'رقم الملف': 'F-9001' },
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const importRes = await request(app).post('/api/import/patient-opening').set(auth()).attach('file', buf, 'opening.xlsx');
    expect(importRes.status).toBe(200);

    // Step 2: an unrelated generic manual journal ALSO credits 1200 by 120 —
    // simulating a historical collection that was recorded outside this new
    // subledger entirely (the exact scenario documented in server.js's own
    // Step-25 comment above GET /api/patient-ar-aging).
    await request(app).post('/api/journal').set(auth()).send({
      date: '2050-04-10', desc: 'تحصيل تاريخي عام — خارج دفتر الذمم الجديد',
      lines: [
        { accountCode: '1100', debit: 120, credit: 0 },
        { accountCode: '1200', debit: 0, credit: 120 },
      ],
    }).expect(200);

    const after = await request(app).get('/api/patient-ar-aging').set(auth()).query({ asOf: '2050-04-15' });
    // subledgerTotal grew by the FULL 300 (patientAR[] has no collection
    // tracking of its own — this is P6-029's original finding, honestly
    // reflected here) — it does NOT know about the 120 collected via the
    // generic journal.
    expect(after.body.reconciliation.subledgerTotal).toBeCloseTo(subBefore + 300, 3);
    // glTotal reflects BOTH real movements: +300 (opening) - 120 (generic collection) = +180
    expect(after.body.reconciliation.glTotal).toBeCloseTo(glBefore + 180, 3);
    expect(after.body.reconciliation.reconciled).toBe(false);
    expect(after.body.reconciliation.difference).toBeCloseTo(120, 3);
    expect(after.body.reconciliation.note).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Credits / Cancellation A-D
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — Credits / Cancellation: reversal journal, never deletion', () => {
  test('Credit A: a credit note reduces AR outstanding correctly', async () => {
    const patient = await createPatient('Patient-Credit-A');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-05-01', amount: 1000,
    })).body.receivable;
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/credit`).set(auth()).send({ amount: 200, reason: 'تخفيض سعر' });
    expect(res.status).toBe(200);
    expect(res.body.receivable.outstandingAmount).toBeCloseTo(800, 3);
  });

  test('Credit B: the ORIGINAL recognition journal is preserved (not deleted/rewritten) after a credit', async () => {
    const patient = await createPatient('Patient-Credit-B');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-05-01', amount: 600,
    })).body.receivable;
    await request(app).post(`/api/patient-receivables/${rec.id}/credit`).set(auth()).send({ amount: 150, reason: 'x' }).expect(200);

    const originalJe = await runAsTenantJe(rec.recognitionJournalId);
    expect(originalJe).toBeTruthy();
    expect(originalJe.lines.some(l => l.accountCode === '1200' && l.debit === 600)).toBe(true);
    const recState = await runAsTenantRec(rec.id);
    expect(recState.credits[0].jeId).not.toBe(rec.recognitionJournalId); // the credit is a SEPARATE journal, linked
  });

  test('Credit C: a credit dated into a locked period is rejected', async () => {
    const patient = await createPatient('Patient-Credit-C');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-06-15', amount: 400,
    })).body.receivable;
    await request(app).post('/api/period-lock').set(auth()).send({ period: '2050-05', locked: true }).expect(200);
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/credit`).set(auth()).send({ amount: 100, reason: 'x', date: '2050-05-20' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_LOCKED');
  });

  test('Cancellation A: cancelling a receivable that already has a collection is rejected, not silently handled', async () => {
    const patient = await createPatient('Patient-Cancel-A');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-07-01', amount: 500,
    })).body.receivable;
    await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 200, collectAccount: '1100' }).expect(200);
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/cancel`).set(auth()).send({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RECEIVABLE_HAS_COLLECTIONS');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Bad-Debt Write-Off A-C
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — Bad-Debt Write-Off', () => {
  test('Write-off A: writes off the outstanding balance with the correct Dr Bad-Debt / Cr AR journal', async () => {
    const patient = await createPatient('Patient-WO-A');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-08-01', amount: 400,
    })).body.receivable;
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/writeoff`).set(auth()).send({ reason: 'تعذّر التحصيل' });
    expect(res.status).toBe(200);
    expect(res.body.receivable.outstandingAmount).toBeCloseTo(0, 3);
    expect(res.body.receivable.status).toBe('WRITTEN_OFF');
    const je = await runAsTenantJe(res.body.journalId);
    // R2 fix: bad-debt account moved from '5710' to '5920' — '5710' is
    // already seeded in DEFAULT_COA as "هاتف وإنترنت" (Phone & Internet),
    // so write-offs were silently misclassifying bad-debt expense as a
    // phone bill. Discovered via live UI testing during Milestone R2.
    const bdLine = je.lines.find(l => l.accountCode === '5920');
    const arLine = je.lines.find(l => l.accountCode === '1200');
    expect(bdLine.debit).toBeCloseTo(400, 3);
    expect(bdLine.accountName).toBe('ديون معدومة');
    expect(arLine.credit).toBeCloseTo(400, 3);
  });

  test('Write-off B: cannot exceed the current outstanding amount', async () => {
    const patient = await createPatient('Patient-WO-B');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-08-01', amount: 300,
    })).body.receivable;
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/writeoff`).set(auth()).send({ amount: 500 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WRITEOFF_EXCEEDS_OUTSTANDING');
  });

  test('Write-off C: a role without manual:delete permission cannot write off', async () => {
    const patient = await createPatient('Patient-WO-C');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-08-01', amount: 300,
    })).body.receivable;
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/writeoff`).set(auth(recepToken)).send({});
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Import Non-Integration A-C (evidence-based: no import creates AR — see
// server.js's own Part-A forensic comment above the patient-AR module)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — Import: neither dailyData nor paymentsData creates patient AR', () => {
  test('Import A: a dailyincome-style Excel upload creates revenue but never a lingering patient receivable', async () => {
    let before;
    await runAsTenant('default', async () => { before = loadDB().patientReceivables.length; });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Date', 'Cash', 'K-Net', 'Visa', 'Master', 'Insurance', 'Cheque', 'Link', 'Total', 'Advance'],
      ['15/07/2050', 200, 100, 0, 0, 0, 0, 0, 300, 0], // avoids 2050-05, locked by an earlier Credit-C test in this shared-tenant file
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const res = await request(app).post('/api/upload').set(auth()).attach('file', buf, 'DailyIncome.xlsx');
    expect(res.status).toBe(200);
    let after;
    await runAsTenant('default', async () => { after = loadDB().patientReceivables.length; });
    expect(after).toBe(before); // zero new patient receivables from this import
  });

  test('Import B: a payments-detail Excel upload (real patient/doctor identity) still creates zero AR — no unpaid-amount signal exists in this format', async () => {
    let before;
    await runAsTenant('default', async () => { before = loadDB().patientReceivables.length; });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Inv ID', 'Patient Name', 'File No', 'Date', 'Doctor', 'K-Net', 'Visa', 'Master', 'Link', 'GIG-GlobMed', 'Inv. Total'],
      [9001, 'Patient-Import-B', 'F-2001', '16/05/2050', 'Dr. X', 50, 0, 0, 0, 0, 50],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const res = await request(app).post('/api/upload').set(auth()).attach('file', buf, 'Payments.xlsx');
    expect(res.status).toBe(200);
    let after;
    await runAsTenant('default', async () => { after = loadDB().patientReceivables.length; });
    expect(after).toBe(before);
  });

  test('Import C: re-importing the same payments file does not duplicate anything (existing invId dedup still holds)', async () => {
    let before;
    await runAsTenant('default', async () => { before = loadDB().paymentsData.length; });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Inv ID', 'Patient Name', 'File No', 'Date', 'Doctor', 'K-Net', 'Visa', 'Master', 'Link', 'GIG-GlobMed', 'Inv. Total'],
      [9001, 'Patient-Import-B', 'F-2001', '16/05/2050', 'Dr. X', 50, 0, 0, 0, 0, 50],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await request(app).post('/api/upload').set(auth()).attach('file', buf, 'Payments2.xlsx').expect(200);
    let after;
    await runAsTenant('default', async () => { after = loadDB().paymentsData.length; });
    expect(after).toBe(before); // invId 9001 already existed — not duplicated
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RBAC A-B / Tenant A / Audit A-B
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — RBAC, Tenant Isolation, Audit', () => {
  test('RBAC A: a role without manual:add permission cannot post a patient receivable', async () => {
    const patient = await createPatient('Patient-RBAC-A');
    const res = await request(app).post('/api/patient-receivables').set(auth(invToken)).send({
      patientId: patient.id, serviceDate: '2050-09-01', amount: 100,
    });
    expect(res.status).toBe(403);
  });

  test('RBAC B: a role without manual:edit permission cannot collect', async () => {
    const patient = await createPatient('Patient-RBAC-B');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-09-01', amount: 200,
    })).body.receivable;
    const res = await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth(recepToken)).send({ amount: 50, collectAccount: '1100' });
    expect(res.status).toBe(403);
  });

  test('Tenant A: Tenant A patient receivables never leak into Tenant B', async () => {
    await runAsTenant('tenant-b-p08', async () => {
      await warmTenantCache('tenant-b-p08');
      const db = loadDB();
      db.users = [{ id: 'usr-tb', username: 'tenantb', email: 'tb@test.com', passwordHash: hash('TenantB1!'), role: 'admin', fullName: 'Tenant B Admin', active: true, createdAt: new Date().toISOString(), lastLogin: null }];
      db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
      db.patients = []; db.patientReceivables = []; db.journalEntries = []; db.lockedPeriods = {};
      saveDB(db);
    });
    const loginB = await request(app).post('/api/auth/login').send({ username: 'tenantb', password: 'TenantB1!', tenantId: 'tenant-b-p08' });
    const tokenB = loginB.body.token;

    const patientA = await createPatient('Patient-Tenant-A');
    await request(app).post('/api/patient-receivables').set(auth()).send({ patientId: patientA.id, serviceDate: '2050-09-05', amount: 999 }).expect(200);

    const listB = await request(app).get('/api/patient-receivables').set(auth(tokenB));
    expect(listB.status).toBe(200);
    expect(listB.body.find(r => r.patientName === 'Patient-Tenant-A')).toBeUndefined();
  });

  test('Audit A: posting a receivable writes an audit event', async () => {
    const patient = await createPatient('Patient-Audit-A');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-09-10', amount: 150,
    })).body.receivable;
    let audit;
    await runAsTenant('default', async () => {
      audit = loadDB().auditLog.find(a => a.action === 'patient_receivable.posted' && a.resourceId === rec.id);
    });
    expect(audit).toBeTruthy();
  });

  test('Audit B: collection and credit both write audit events', async () => {
    const patient = await createPatient('Patient-Audit-B');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-09-10', amount: 500,
    })).body.receivable;
    await request(app).post(`/api/patient-receivables/${rec.id}/collect`).set(auth()).send({ amount: 100, collectAccount: '1100' }).expect(200);
    await request(app).post(`/api/patient-receivables/${rec.id}/credit`).set(auth()).send({ amount: 50, reason: 'x' }).expect(200);
    let collAudit, credAudit;
    await runAsTenant('default', async () => {
      const log = loadDB().auditLog;
      collAudit = log.find(a => a.action === 'patient_receivable.collection_posted' && a.resourceId === rec.id);
      credAudit = log.find(a => a.action === 'patient_receivable.credited' && a.resourceId === rec.id);
    });
    expect(collAudit).toBeTruthy();
    expect(credAudit).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Persistence A — new roots survive a real reload (Step 36, not repeating P6-040)
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — Persistence: patients/patientReceivables survive a reload', () => {
  test('Persistence A: a patient and its receivable are still present after shutdownDB/initDB against the same data file', async () => {
    const patient = await createPatient('Patient-Persist-A');
    const rec = (await request(app).post('/api/patient-receivables').set(auth()).send({
      patientId: patient.id, serviceDate: '2050-10-01', amount: 250,
    })).body.receivable;

    await shutdownDB();
    await initDB({
      mongoUri: 'mongodb://127.0.0.1:1/unused',
      dataFile: process.env.DATA_FILE,
      configFile: process.env.CONFIG_FILE,
      defaultConfig: {},
      buildInitialDB,
      migrateDB: () => false,
    });

    let reloadedPatient, reloadedRec;
    await runAsTenant('default', async () => {
      const db = loadDB();
      reloadedPatient = db.patients.find(p => p.id === patient.id);
      reloadedRec = db.patientReceivables.find(r => r.id === rec.id);
    });
    expect(reloadedPatient).toBeTruthy();
    expect(reloadedPatient.name).toBe('Patient-Persist-A');
    expect(reloadedRec).toBeTruthy();
    expect(reloadedRec.grossAmount).toBeCloseTo(250, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Regression A-C — P0.7 AP / P0.6B doctor-EOS-close / P0.6A TB smoke checks
// ═══════════════════════════════════════════════════════════════════════
describe('P0.8 — Regression: P0.7/P0.6B/P0.6A scenarios remain correct', () => {
  test('Regression A: the P0.7 AP vendor-bill lifecycle remains green', async () => {
    const vendorRes = await request(app).post('/api/vendors').set(auth()).send({ name: 'Vendor-P08-Regression', phone: '000' });
    expect(vendorRes.status).toBe(200);
    const billRes = await request(app).post('/api/vendor-bills').set(auth()).send({
      vendorId: vendorRes.body.vendor.id, billDate: '2050-11-01', allocations: [{ accountCode: '5100', amount: 500 }],
    });
    expect(billRes.status).toBe(200);
    const payRes = await request(app).post(`/api/vendor-bills/${billRes.body.bill.id}/pay`).set(auth()).send({ amount: 500, payAccount: '1100' });
    expect(payRes.status).toBe(200);
    expect(payRes.body.bill.status).toBe('PAID');
  });

  test('Regression B: P0.6B doctor commission liability recognition remains correct', async () => {
    // POST /api/doctors is a bulk-replace endpoint (req.body.doctors: []),
    // not a single-doctor create — matches its actual current contract.
    const docRes = await request(app).post('/api/doctors').set(auth()).send({ doctors: [{ name: 'Dr-P08-Regression', target: 0, commission: 40, lab: 0, insurance: 0 }] });
    expect(docRes.status).toBe(200);
    const recon = await request(app).get('/api/doctors/commission-reconciliation').set(auth());
    expect(recon.status).toBe(200);
    expect(typeof recon.body).toBe('object');
  });

  test('Regression C: P0.6A Trial Balance remains internally balanced after this whole file\'s activity', async () => {
    const tb = await request(app).get('/api/trial-balance').set(auth());
    expect(tb.status).toBe(200);
    expect(tb.body.isBalanced).toBe(true);
  });
});
