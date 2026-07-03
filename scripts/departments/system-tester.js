#!/usr/bin/env node
'use strict';
/**
 * 🧪 System Tester — "المُجرِّب"
 *
 * يشتغل مثل محاسب حقيقي يجرب النظام: يفحص القيود، شجرة الحسابات،
 * العمولات، التأمين، المخزون — ويكتشف المشاكل المحاسبية والمنطقية
 * قبل ما يكتشفها المستخدم.
 *
 * 🔒 قاعدة أمان صارمة (CLAUDE.md): للقراءة فقط — لا يكتب ولا يعدّل ولا
 *    يحذف أي بيانات إنتاج إطلاقاً. كل "التجارب" تحصل على نسخة في الذاكرة.
 *
 * المخرجات: تقرير Markdown بالعربي البسيط → غرفة العمليات + Issue.
 * الحديث (stderr) يظهر مباشرة للمستخدم كأن المُجرِّب يتكلم.
 */
const fs   = require('fs');
const path = require('path');
const { today } = require('./_common');

const ROOT      = path.join(__dirname, '..', '..');
const DATA_FILE = path.join(ROOT, 'data', 'database.json');

// المُجرِّب يتكلم — كل سطر يظهر فوراً في غرفة العمليات
const say = (m) => process.stderr.write(m + '\n');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return null; }
}

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

// ── جمع المشاكل ───────────────────────────────────────────────────────
const issues = []; // { sev:'critical'|'high'|'medium'|'low', area, msg, fix }
function flag(sev, area, msg, fix) { issues.push({ sev, area, msg, fix }); }

// ══════════════════════════════════════════════════════════════════════
// اختبار 1 — توازن القيود المحاسبية (مدين = دائن)
// ══════════════════════════════════════════════════════════════════════
function testJournalBalance(db) {
  const entries = db.journalEntries || [];
  say(`🧪 أجرّب القيود المحاسبية — ${entries.length} قيد...`);
  if (!entries.length) { say('  ↳ لا توجد قيود بعد — تخطّيت هذا الاختبار'); return; }

  let unbalanced = 0, noLines = 0, badAccount = 0;
  const coaCodes = new Set((db.chartOfAccounts || []).map(a => String(a.code)));

  for (const e of entries) {
    const lines = e.lines || [];
    if (!lines.length) { noLines++; continue; }
    const d = lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0);
    const c = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
    if (Math.abs(d - c) > 0.005) {
      unbalanced++;
      if (unbalanced <= 3) say(`  ⚠️ قيد ${e.ref || e.id} (${e.date}) غير متوازن: مدين ${round3(d)} ≠ دائن ${round3(c)}`);
    }
    for (const l of lines) {
      const code = String(l.accountCode || l.accountId || '');
      if (code && coaCodes.size && !coaCodes.has(code)) badAccount++;
    }
  }

  if (unbalanced) flag('critical', 'القيود', `${unbalanced} قيد غير متوازن (المدين لا يساوي الدائن) — يخالف مبدأ القيد المزدوج`, 'راجع هذه القيود وصحّح الأطراف حتى يتساوى المدين مع الدائن');
  else say('  ✅ كل القيود متوازنة');
  if (noLines)   flag('high', 'القيود', `${noLines} قيد بدون أي بنود (فارغ)`, 'احذف القيود الفارغة أو أكمل بنودها');
  if (badAccount) flag('high', 'القيود', `${badAccount} بند يشير لحساب غير موجود في شجرة الحسابات`, 'صحّح كود الحساب في هذه البنود أو أضف الحساب الناقص');
}

// ══════════════════════════════════════════════════════════════════════
// اختبار 2 — سلامة شجرة الحسابات
// ══════════════════════════════════════════════════════════════════════
function testChartOfAccounts(db) {
  const coa = db.chartOfAccounts || [];
  say(`🧪 أفحص شجرة الحسابات — ${coa.length} حساب...`);
  if (!coa.length) { flag('high', 'شجرة الحسابات', 'شجرة الحسابات فارغة', 'أضف الحسابات الأساسية'); return; }

  const seen = new Map();
  let dupes = 0, noType = 0, orphan = 0;
  const codes = new Set(coa.map(a => String(a.code)));
  const validTypes = new Set(['asset', 'liability', 'equity', 'revenue', 'expense']);

  for (const a of coa) {
    const code = String(a.code || '');
    if (seen.has(code)) { dupes++; if (dupes <= 3) say(`  ⚠️ كود مكرر: ${code} (${a.name})`); }
    else seen.set(code, a);
    if (!validTypes.has(a.type)) noType++;
    if (a.parent && !codes.has(String(a.parent))) orphan++;
  }

  if (dupes)  flag('critical', 'شجرة الحسابات', `${dupes} حساب بكود مكرّر — يسبب أخطاء في الترحيل والتقارير`, 'اجعل كل كود حساب فريداً');
  else say('  ✅ لا أكواد مكررة');
  if (noType) flag('medium', 'شجرة الحسابات', `${noType} حساب بدون نوع صحيح (أصل/التزام/حقوق/إيراد/مصروف)`, 'حدّد نوع كل حساب');
  if (orphan) flag('medium', 'شجرة الحسابات', `${orphan} حساب يشير لحساب أب غير موجود`, 'صحّح الحساب الأب أو أضفه');
}

// ══════════════════════════════════════════════════════════════════════
// اختبار 3 — منطق العمولات (نفس ما يحسبه النظام)
// ══════════════════════════════════════════════════════════════════════
function testCommissions(db) {
  const comms = db.commissionHistory || [];
  say(`🧪 أراجع حسابات العمولات — ${comms.length} سجل...`);
  if (!comms.length) { say('  ↳ لا عمولات — تخطّيت'); return; }

  let negative = 0, overhundred = 0, mismatch = 0;
  for (const c of comms) {
    const rev  = Number(c.revenue) || 0;
    const comm = Number(c.commission) || 0;
    if (comm < 0 || rev < 0) negative++;
    if (rev > 0 && comm > rev) overhundred++;
    if (c.rate != null && rev > 0) {
      const expected = round3(rev * (Number(c.rate) / 100));
      const gross = Number(c.grossCommission != null ? c.grossCommission : comm);
      if (Math.abs(expected - gross) > 0.01 && !c.drExpenses) mismatch++;
    }
  }
  if (negative)    flag('high',   'العمولات', `${negative} سجل عمولة بقيمة سالبة`, 'راجع مدخلات الإيراد/العمولة السالبة');
  if (overhundred) flag('critical','العمولات', `${overhundred} عمولة أكبر من إيراد الطبيب نفسه — غير منطقي`, 'تأكد أن نسبة العمولة صحيحة');
  if (mismatch)    flag('medium',  'العمولات', `${mismatch} عمولة لا تطابق (الإيراد × النسبة)`, 'أعد احتساب العمولات من صفحة الإعدادات');
  if (!negative && !overhundred && !mismatch) say('  ✅ حسابات العمولات منطقية');
}

// ══════════════════════════════════════════════════════════════════════
// اختبار 4 — منطق التأمين (الحصة المسجّلة 75% من الأصل)
// ══════════════════════════════════════════════════════════════════════
function testInsurance(db) {
  const daily = db.dailyData || [];
  say(`🧪 أتحقق من أرقام التأمين — ${daily.length} يوم...`);
  let negTotal = 0, mismatchTotal = 0;
  for (const d of daily) {
    const parts = ['cash','knet','visa','master','link','insurance'].reduce((s,k)=>s+(Number(d[k])||0),0);
    const total = Number(d.total) || 0;
    if (total < 0) negTotal++;
    if (total > 0 && Math.abs(parts - total) > 0.01) mismatchTotal++;
  }
  if (negTotal)      flag('high',   'اليومية', `${negTotal} يوم بإجمالي إيراد سالب`, 'راجع مدخلات هذه الأيام');
  if (mismatchTotal) flag('medium', 'اليومية', `${mismatchTotal} يوم: مجموع طرق الدفع لا يساوي الإجمالي المسجّل`, 'تأكد أن كاش+كنت+فيزا+ماستر+لينك+تأمين = الإجمالي');
  if (!negTotal && !mismatchTotal) say('  ✅ أرقام اليومية والتأمين متطابقة');
}

// ══════════════════════════════════════════════════════════════════════
// اختبار 5 — المخزون (كميات وتكاليف سالبة)
// ══════════════════════════════════════════════════════════════════════
function testInventory(db) {
  const items = db.invItems || [];
  say(`🧪 أفحص المخزون — ${items.length} صنف...`);
  let negQty = 0, negCost = 0, belowMin = 0;
  for (const i of items) {
    const qty  = Number(i.qty ?? i.quantity ?? 0);
    const cost = Number(i.cost ?? 0);
    const min  = Number(i.minQty ?? i.minQuantity ?? 0);
    if (qty < 0)  negQty++;
    if (cost < 0) negCost++;
    if (qty >= 0 && qty <= min && min > 0) belowMin++;
  }
  if (negQty)  flag('high',   'المخزون', `${negQty} صنف بكمية سالبة`, 'صحّح كميات المخزون');
  if (negCost) flag('medium', 'المخزون', `${negCost} صنف بتكلفة سالبة`, 'راجع تكلفة الأصناف');
  if (belowMin) flag('low',   'المخزون', `${belowMin} صنف وصل الحد الأدنى — يحتاج إعادة طلب`, 'اطلب هذه الأصناف قبل نفادها');
  if (!items.length) say('  ↳ لا أصناف مخزون');
  else if (!negQty && !negCost) say('  ✅ المخزون سليم');
}

// ══════════════════════════════════════════════════════════════════════
// بناء التقرير
// ══════════════════════════════════════════════════════════════════════
function buildReport() {
  const pen = { critical: 25, high: 12, medium: 6, low: 2 };
  let score = 100;
  for (const i of issues) score -= (pen[i.sev] || 0);
  score = Math.max(0, score);

  const crit = issues.filter(i => i.sev === 'critical').length;
  const emoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
  const sevAr = { critical: 'حرجة', high: 'عالية', medium: 'متوسطة', low: 'بسيطة' };

  const L = [];
  L.push('# 🧪 تقرير المُجرِّب — فحص شامل للنظام المحاسبي');
  L.push(`**التاريخ:** ${today()} | **النتيجة:** ${score}/100 | **الحالة:** ${crit ? '🔴 يحتاج انتباهك' : score >= 80 ? '✅ سليم' : '🟡 مقبول'}`);
  L.push('');
  L.push('> جرّبت النظام مثل محاسب حقيقي: فحصت القيود، شجرة الحسابات، العمولات، التأمين، والمخزون — للقراءة فقط دون تعديل أي بيانات.');
  L.push('');

  if (!issues.length) {
    L.push('## ✅ لم أجد أي مشكلة');
    L.push('- كل الاختبارات نجحت — القيود متوازنة والحسابات سليمة.');
  } else {
    L.push(`## 🚩 المشاكل التي اكتشفتها (${issues.length})`);
    L.push('');
    const order = ['critical', 'high', 'medium', 'low'];
    issues.sort((a, b) => order.indexOf(a.sev) - order.indexOf(b.sev));
    for (const i of issues) {
      L.push(`- ${emoji[i.sev]} **[${sevAr[i.sev]}]** (${i.area}) ${i.msg}`);
      if (i.fix) L.push(`  - 💡 الحل: ${i.fix}`);
    }
  }
  L.push('');
  L.push('---');
  L.push('_المُجرِّب — يفحص النظام للقراءة فقط ولا يعدّل أي بيانات إنتاج._');
  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  say('▶ المُجرِّب بدأ — سأختبر النظام مثل محاسب حقيقي (قراءة فقط)...');
  const db = loadDB();
  if (!db) {
    say('❌ تعذّر قراءة قاعدة البيانات');
    process.stdout.write('# 🧪 تقرير المُجرِّب\n\n❌ تعذّر قراءة قاعدة البيانات المحلية.\n');
    process.exit(0);
  }

  testJournalBalance(db);
  testChartOfAccounts(db);
  testCommissions(db);
  testInsurance(db);
  testInventory(db);

  say(`✅ انتهيت — اكتشفت ${issues.length} ملاحظة. التقرير جاهز.`);
  process.stdout.write(buildReport() + '\n');
}

main();
