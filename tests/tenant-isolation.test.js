// اختبار عزل المستأجرين (CLAUDE.md بند 2 — Critical)
// القاعدة: كل مستأجر (زبون SaaS) يرى بياناته هو فقط.
// أخطر تسريب ممكن: مستأجر جديد "غير مُحمَّل" يستلم كاش العيادة الافتراضية نفسه.

process.env.DB_FILE_ONLY = 'true'; // وضع الملفات المعزول — لا يلمس Mongo إطلاقاً

const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-iso-'));

const {
  initDB, loadDB, saveDB, runAsTenant, shutdownDB,
} = require('../lib/database');

// شكل قاعدة بيانات العيادة الافتراضية — فيها بيانات "سرية" يجب ألا يراها أي مستأجر
function buildInitialDB() {
  return {
    users: [{ id: 'usr-clinic', username: 'clinic-admin', role: 'admin', active: true }],
    roles: { admin: { tabs: [], actions: {} } },
    journalEntries: [{ id: 'JE-CLINIC-SECRET', desc: 'قيد العيادة السري', date: '2026-01-01', lines: [] }],
    chartOfAccounts: [{ id: '1100', code: '1100', name: 'صندوق العيادة', type: 'asset' }],
    expenses: [], vendors: [], dailyData: [], paymentsData: [], commissionHistory: [],
    uploadedFiles: [], invItems: [], invCategories: [], invMovements: [],
    recurringExpenses: [], companyInfo: { name: 'عيادة الاختبار' }, scheduleConfig: {},
    vouchers: [], cashReconciliation: [], insuranceClaims: [], payroll: [], employees: [],
    assets: [], budget: {}, auditLog: [], accruedExpenses: [], journalMappings: [],
    doctorExpenses: [], doctors: [],
  };
}

beforeAll(async () => {
  await initDB({
    mongoUri: 'mongodb://127.0.0.1:1/unused',
    dataFile: path.join(tmp, 'database.json'),
    configFile: path.join(tmp, 'config.json'),
    defaultConfig: {},
    buildInitialDB,
    migrateDB: () => false,
  });
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

describe('عزل المستأجرين — Tenant isolation (Critical)', () => {
  test('المستأجر الجديد لا يرث بيانات العيادة الافتراضية أبداً', () => {
    runAsTenant('tenant-a', () => {
      const db = loadDB();
      // لو ظهر قيد العيادة أو مستخدموها → تسريب كارثي
      expect((db.journalEntries || []).find(e => e.id === 'JE-CLINIC-SECRET')).toBeUndefined();
      expect((db.users || []).find(u => u.username === 'clinic-admin')).toBeUndefined();
      expect(db.companyInfo?.name).not.toBe('عيادة الاختبار');
    });
  });

  test('قيود المستأجر أ لا تظهر للمستأجر ب ولا للعيادة', () => {
    runAsTenant('tenant-a', () => {
      const db = loadDB();
      db.journalEntries = db.journalEntries || [];
      db.journalEntries.push({ id: 'JE-A-1', desc: 'قيد سري للمستأجر أ', date: '2026-02-01', lines: [] });
      saveDB(db);
    });

    runAsTenant('tenant-b', () => {
      const db = loadDB();
      expect((db.journalEntries || []).find(e => e.id === 'JE-A-1')).toBeUndefined();
    });

    // العيادة الافتراضية (بدون سياق مستأجر) لا ترى قيد المستأجر
    const clinicDb = loadDB();
    expect((clinicDb.journalEntries || []).find(e => e.id === 'JE-A-1')).toBeUndefined();
    // وقيد العيادة الأصلي ما زال عندها وحدها
    expect((clinicDb.journalEntries || []).find(e => e.id === 'JE-CLINIC-SECRET')).toBeDefined();
  });

  test('العزل بالاتجاهين: بيانات ب لا تظهر لـ أ', () => {
    runAsTenant('tenant-b', () => {
      const db = loadDB();
      db.chartOfAccounts = db.chartOfAccounts || [];
      db.chartOfAccounts.push({ id: '9999', code: '9999', name: 'حساب سري للمستأجر ب', type: 'asset' });
      saveDB(db);
    });

    runAsTenant('tenant-a', () => {
      const db = loadDB();
      expect((db.chartOfAccounts || []).find(a => a.code === '9999')).toBeUndefined();
    });
  });

  test('كائنات الذاكرة منفصلة فعلاً (لا مشاركة بالمرجع)', () => {
    let aRef, bRef;
    runAsTenant('tenant-a', () => { aRef = loadDB(); });
    runAsTenant('tenant-b', () => { bRef = loadDB(); });
    const clinicRef = loadDB();
    expect(aRef).not.toBe(bRef);
    expect(aRef).not.toBe(clinicRef);
    expect(bRef).not.toBe(clinicRef);
  });

  test('تعديل مستأجر داخل مصفوفته لا يمس مصفوفة العيادة', () => {
    let clinicCountBefore;
    clinicCountBefore = (loadDB().journalEntries || []).length;
    runAsTenant('tenant-a', () => {
      const db = loadDB();
      db.journalEntries.push({ id: 'JE-A-2', desc: 'قيد إضافي', date: '2026-03-01', lines: [] });
      saveDB(db);
    });
    expect((loadDB().journalEntries || []).length).toBe(clinicCountBefore);
  });
});
