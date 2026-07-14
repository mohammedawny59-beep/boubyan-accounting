// اختبارات وحدات المحاسبة النقية (CLAUDE.md بند 8 — رفع التغطية)
// lib/accounting.js + lib/coaCodes.js — نفس الدوال التي يستخدمها الخادم والمُجرِّب.

const { expCatToAccount, payMethodToAccount } = require('../lib/accounting');
const { nextChildCode, suggestChildCode, repairChart, payrollAccounts } = require('../lib/coaCodes');
const { DEFAULT_COA } = require('../lib/defaults');

const coa = () => DEFAULT_COA.map(a => ({ ...a }));

describe('expCatToAccount — الفئة → حساب موجود فعلاً', () => {
  test('الفئات الشائعة تذهب لحساباتها الصحيحة في الشجرة', () => {
    expect(expCatToAccount('إيجار', coa()).code).toBe('5300');
    expect(expCatToAccount('فاتورة كهرباء', coa()).code).toBe('5400');
    expect(expCatToAccount('هاتف وإنترنت', coa()).code).toBe('5710');
    expect(expCatToAccount('رواتب الموظفين', coa()).code).toBe('5120');
    expect(expCatToAccount('صيانة الجهاز', coa()).code).toBe('5500');
  });

  test('لا يُرجع أبداً حساباً غير موجود — فئة مجهولة → 5900', () => {
    const r = expCatToAccount('فئة غريبة تماماً', coa());
    expect(coa().some(a => a.code === r.code)).toBe(true);
    expect(r.code).toBe('5900');
  });

  test('الحساب الموقوف يُتجاهل ويُستخدم الاحتياط', () => {
    const c = coa();
    c.find(a => a.code === '5300').status = 'inactive';
    const r = expCatToAccount('إيجار', c);
    expect(r.code).not.toBe('5300');
    expect(c.some(a => a.code === r.code && a.status !== 'inactive')).toBe(true);
  });

  test('شجرة فارغة → احتياط آمن 5900 (لا انهيار)', () => {
    expect(expCatToAccount('إيجار', []).code).toBe('5900');
  });
});

describe('payMethodToAccount — طريقة الدفع → حساب نقدية موجود', () => {
  test('بنك/تحويل/شيك → 1110، بطاقات → 1120، الافتراضي كاش → 1100', () => {
    expect(payMethodToAccount('تحويل بنكي').code).toBe('1110');
    expect(payMethodToAccount('cheque شيك').code).toBe('1110');
    expect(payMethodToAccount('KNET').code).toBe('1120');
    expect(payMethodToAccount('visa').code).toBe('1120');
    expect(payMethodToAccount('cash').code).toBe('1100');
    expect(payMethodToAccount('').code).toBe('1100');
  });

  test('كل الأكواد المُرجَعة موجودة فعلاً في الشجرة الافتراضية', () => {
    const codes = new Set(coa().map(a => a.code));
    for (const m of ['بنك', 'knet', 'كاش', 'visa', '']) {
      expect(codes.has(payMethodToAccount(m).code)).toBe(true);
    }
  });
});

describe('coaCodes — توليد أكواد الحسابات', () => {
  test('nextChildCode: مجموعة فيها مكان → الكود التالي الصحيح', () => {
    expect(nextChildCode('1000', coa().map(a => a.code))).toBe('1600');
  });

  test('suggestChildCode: المجموعة الممتلئة 5000 تنزل تلقائياً لمجموعة فرعية (5910)', () => {
    const s = suggestChildCode('5000', coa());
    expect(s.code).toBe('5910');
    expect(s.parentCode).toBe('5900');
    expect(s.cascaded).toBe(true);
  });

  test('الكود المقترح دائماً 4 خانات وغير مستخدم — لكل المجموعات', () => {
    const c = coa();
    const codes = new Set(c.map(a => a.code));
    for (const g of c.filter(a => a.isGroup)) {
      const s = suggestChildCode(String(g.code), c);
      if (!s) continue;
      expect(s.code.length).toBe(4);
      expect(codes.has(s.code)).toBe(false);
    }
  });
});

describe('repairChart — الإصلاح الذاتي للشجرة', () => {
  test('كود رقمي (يعطّل شاشة التعديل) → يُطبَّع لنص', () => {
    const c = coa();
    c.push({ id: 6100, code: 6100, name: 'حساب رقمي', type: 'expense', parent: '5000' });
    const changes = repairChart(c, []);
    const fixed = c.find(a => a.name === 'حساب رقمي');
    expect(typeof fixed.code).toBe('string');
    expect(changes.some(ch => ch.action === 'code-normalized')).toBe(true);
  });

  test('كود بعرض خاطئ (50) → يُعاد ترقيمه وتُحدَّث قيوده', () => {
    const c = coa();
    c.push({ code: '50', name: 'نفايات', type: 'expense', parent: '5000' });
    const je = [{ lines: [{ accountCode: '50', debit: 5 }, { accountCode: '4100', credit: 5 }] }];
    repairChart(c, je);
    const acc = c.find(a => a.name === 'نفايات');
    expect(acc.code.length).toBe(4);
    expect(je[0].lines[0].accountCode).toBe(acc.code); // القيد تبع الحساب
  });

  test('idempotent: تشغيل ثانٍ على شجرة سليمة = صفر تغييرات', () => {
    const c = coa();
    c.push({ code: '50', name: 'خربان', type: 'expense', parent: '5000' });
    repairChart(c, []);
    expect(repairChart(c, []).length).toBe(0);
  });
});

describe('payrollAccounts — حسابات الرواتب (IAS 19)', () => {
  test('يعيد 2200/2210/5110/5120 وينشئ الناقص', () => {
    const c = coa().filter(a => a.code !== '2200'); // احذف 2200 عمداً
    const pa = payrollAccounts(c);
    expect(pa.payable.code).toBe('2200');
    expect(pa.deductions.code).toBe('2210');
    expect(pa.expMedical.code).toBe('5110');
    expect(pa.expAdmin.code).toBe('5120');
    expect(c.some(a => a.code === '2200')).toBe(true); // أُنشئ فعلاً
  });

  test('لا يستخدم أبداً 2100 (موردين) أو 5200 (مواد)', () => {
    const pa = payrollAccounts(coa());
    const used = [pa.payable.code, pa.deductions.code, pa.expMedical.code, pa.expAdmin.code];
    expect(used).not.toContain('2100');
    expect(used).not.toContain('5200');
  });
});
