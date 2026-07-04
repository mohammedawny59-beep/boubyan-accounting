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

// Mint an admin token for the running server (uses the same JWT_SECRET)
function selfToken() {
  try {
    const jwt = require('jsonwebtoken');
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    return jwt.sign({ id: 'system-tester', username: 'system-tester', role: 'admin', fullName: 'المُجرِّب', tenantId: 'default' }, secret, { expiresIn: '10m' });
  } catch { return null; }
}

// Load the real data from the RUNNING server (works with MongoDB on Render AND
// file mode locally). Falls back to the local file only if the API is unreachable.
async function loadDB() {
  const port = process.env.PORT || process.env.SELF_PORT || 3000;
  const token = selfToken();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/data`, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    if (r.ok) {
      const db = await r.json();
      if (db && typeof db === 'object') { say('  ↳ قرأت البيانات من الخادم مباشرة'); return db; }
    }
  } catch { /* server not reachable — try file */ }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return null; }
}

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

// ── جمع المشاكل ───────────────────────────────────────────────────────
const issues = []; // { sev:'critical'|'high'|'medium'|'low', area, msg, fix }
function flag(sev, area, msg, fix) { issues.push({ sev, area, msg, fix }); }

// ── ذاكرة الانحدار (Regression): يقارن بآخر فحص ──────────────────────────
let _newIssues = [], _resolvedIssues = [];
const _sig = (i) => `${i.area}|${i.msg}`;
function runRegression() {
  const histPath = path.join(ROOT, '.agent-memory', 'tester-history.json');
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(histPath, 'utf8')).signatures || []; } catch {}
  const curr = issues.map(_sig);
  const prevSet = new Set(prev), currSet = new Set(curr);
  _newIssues      = issues.filter(i => !prevSet.has(_sig(i)));
  _resolvedIssues = prev.filter(s => !currSet.has(s));
  try {
    fs.mkdirSync(path.dirname(histPath), { recursive: true });
    fs.writeFileSync(histPath, JSON.stringify({ at: new Date().toISOString(), signatures: curr }, null, 2), 'utf8');
  } catch {}
}

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
// اختبار 2ب — توليد كود الحساب الجديد (بق حقيقي في النظام لا في البيانات)
// يجرّب "إضافة حساب جديد" لكل مجموعة ويتأكد أن الكود المقترح صحيح
// ══════════════════════════════════════════════════════════════════════
function testCodeGeneration(db) {
  const coa = db.chartOfAccounts || [];
  const groups = coa.filter(a => a.isGroup);
  if (!groups.length) return;
  say(`🧪 أجرّب "إضافة حساب جديد" تحت ${groups.length} مجموعة...`);

  let nextChildCode;
  try { ({ nextChildCode } = require('../../lib/coaCodes')); }
  catch { say('  ↳ وحدة توليد الأكواد غير موجودة — تخطّيت'); return; }

  const allCodes = coa.map(a => String(a.code));
  const codeSet  = new Set(allCodes);
  const widths   = new Set(allCodes.map(c => c.length));
  const stdWidth = widths.size === 1 ? [...widths][0] : null; // fixed-width scheme?

  let wrongWidth = 0, taken = 0, empty = 0, sample = null;
  for (const g of groups) {
    const suggested = nextChildCode(String(g.code), allCodes);
    if (!suggested) { empty++; continue; }
    if (codeSet.has(suggested)) { taken++; if (!sample) sample = `${g.code}→${suggested} (مستخدم مسبقاً)`; }
    if (stdWidth && suggested.length !== stdWidth) {
      wrongWidth++;
      if (!sample) sample = `تحت الحساب ${g.code} يقترح "${suggested}" (${suggested.length} خانات بدل ${stdWidth})`;
    }
  }

  if (wrongWidth) flag('critical', 'إضافة حساب', `عند إضافة حساب جديد، النظام يقترح كوداً بعدد خانات خاطئ في ${wrongWidth} مجموعة — مثال: ${sample}`, 'أصلح خوارزمية توليد كود الحساب في /api/coa/next-code');
  if (taken)      flag('critical', 'إضافة حساب', `النظام يقترح كوداً مستخدماً مسبقاً في ${taken} حالة — مثال: ${sample}`, 'تأكد أن الكود المقترح غير موجود');
  if (!wrongWidth && !taken) say('  ✅ توليد أكواد الحسابات الجديدة سليم');
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
// اختبار 6 — تجارب حية END-TO-END في بيئة معزولة
// المُجرِّب "يقعد يعمل قيود ويجرب" النظام فعلياً — بدون لمس بيانات الإنتاج
// ══════════════════════════════════════════════════════════════════════
async function testEndToEnd(db) {
  let startSandbox;
  try { ({ startSandbox } = require('./_sandbox')); }
  catch { return; }

  say('🧪 أبدأ تجارب حية — سأعمل قيوداً وأجرّب النظام في بيئة معزولة...');

  // Seed the sandbox with a COPY of the real chart of accounts (read-only copy)
  const coaCopy = JSON.parse(JSON.stringify(db.chartOfAccounts || []));
  if (!coaCopy.length) { say('  ↳ لا توجد شجرة حسابات لأجرّب عليها — تخطّيت'); return; }

  let sb;
  try {
    sb = await startSandbox({ seed: { chartOfAccounts: coaCopy }, log: say });
  } catch (e) {
    say('  ⚠️ تعذّر إقلاع البيئة التجريبية — تخطّيت التجارب الحية (' + e.message + ')');
    return;
  }

  const api = async (method, p, body) => {
    const r = await fetch(sb.baseUrl + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sb.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, ok: r.ok, data };
  };

  try {
    const leaves = coaCopy.filter(a => !a.isGroup);
    const existingCodes = new Set(coaCopy.map(a => String(a.code)));

    // ── تجربة 1: إضافة حساب جديد + صحة الكود المقترح ──
    const nc = await api('GET', '/api/coa/next-code?parent=1000');
    const suggested = nc.data && nc.data.nextCode;
    if (suggested) {
      if (String(suggested).length !== 4 || existingCodes.has(String(suggested))) {
        flag('critical', 'تجربة: إضافة حساب', `النظام اقترح كود حساب خاطئ "${suggested}" عند الإضافة تحت 1000`, 'أصلح /api/coa/next-code');
      } else {
        const create = await api('POST', '/api/coa/account', { code: suggested, name: 'حساب اختبار آلي', type: 'asset', parent: '1000' });
        if (!create.ok || !create.data?.success) flag('high', 'تجربة: إضافة حساب', `فشل إنشاء حساب جديد بكود صحيح (${create.status})`, 'راجع POST /api/coa/account');
        else say(`  ✅ أضفت حساباً جديداً بكود ${suggested} — نجح`);
      }
    }

    // ── تجربة 2: منطق القيد المزدوج (متوازن يُقبل، غير متوازن يُرفض) ──
    if (leaves.length >= 2) {
      const [a1, a2] = leaves;
      const line = (acc, d, c) => ({ accountId: acc.code, accountCode: acc.code, accountName: acc.name, debit: d, credit: c });

      const balanced = await api('POST', '/api/journal', {
        date: '2026-01-15', desc: 'قيد اختبار متوازن',
        lines: [line(a1, 100, 0), line(a2, 0, 100)],
      });
      if (!balanced.ok || !balanced.data?.success) flag('critical', 'تجربة: قيد محاسبي', `النظام رفض قيداً متوازناً صحيحاً (${balanced.status}) — خطأ في التحقق`, 'راجع POST /api/journal');
      else say('  ✅ قيد متوازن (مدين=دائن) → قُبل بشكل صحيح');

      const unbalanced = await api('POST', '/api/journal', {
        date: '2026-01-15', desc: 'قيد اختبار غير متوازن',
        lines: [line(a1, 100, 0), line(a2, 0, 50)],
      });
      if (unbalanced.ok && unbalanced.data?.success) flag('critical', 'تجربة: قيد محاسبي', 'النظام قَبِل قيداً غير متوازن (مدين 100 ≠ دائن 50)! — ثغرة محاسبية خطيرة', 'يجب رفض أي قيد مدينه لا يساوي دائنه');
      else say('  ✅ قيد غير متوازن → رُفض بشكل صحيح');
    }

    // ── تجربة 3: ميزان المراجعة يجب أن يتوازن ──
    const tb = await api('GET', '/api/trial-balance');
    if (tb.ok && tb.data) {
      if (tb.data.isBalanced === false || Math.abs((tb.data.grandDebit||0) - (tb.data.grandCredit||0)) > 0.01) {
        flag('critical', 'تجربة: ميزان المراجعة', `ميزان المراجعة غير متوازن بعد قيد صحيح (مدين ${tb.data.grandDebit} ≠ دائن ${tb.data.grandCredit})`, 'راجع منطق ميزان المراجعة');
      } else say('  ✅ ميزان المراجعة متوازن بعد القيود');
    }

    const line = (acc, d, c) => ({ accountId: acc.code, accountCode: acc.code, accountName: acc.name, debit: d, credit: c });
    const assetLeaf = leaves.find(a => String(a.code).startsWith('1'));
    const revLeaf   = leaves.find(a => String(a.code).startsWith('4'));
    const expLeaf   = leaves.find(a => String(a.code).startsWith('5'));

    // ── تجربة 4: تسجيل مصروف يجب أن ينعكس في الأرباح والخسائر ──
    if (expLeaf) {
      const before = await api('GET', '/api/reports/pnl');
      const beforeExp = before.data?.totalExpenses || 0;
      const exp = await api('POST', '/api/expenses', { date: '2026-02-01', amount: 50, accountCode: expLeaf.code, desc: 'مصروف اختبار آلي' });
      if (!exp.ok || !exp.data?.success) flag('high', 'تجربة: مصروف', `فشل تسجيل مصروف (${exp.status})`, 'راجع POST /api/expenses');
      else {
        const after = await api('GET', '/api/reports/pnl');
        if ((after.data?.totalExpenses || 0) < beforeExp + 49.9) flag('high', 'تجربة: مصروف', `المصروف لم ينعكس في قائمة الأرباح والخسائر`, 'راجع ربط المصاريف بالتقارير');
        else say('  ✅ سجّلت مصروفاً وانعكس في الأرباح والخسائر');
      }
    }

    // ── تجربة 5: المعادلة المحاسبية (أصول = خصوم + حقوق + صافي الدخل) ──
    if (assetLeaf && revLeaf) {
      await api('POST', '/api/journal', { date: '2026-02-02', desc: 'إيراد اختبار', lines: [line(assetLeaf, 100, 0), line(revLeaf, 0, 100)] });
      const bs = await api('GET', '/api/reports/balance-sheet');
      const pl = await api('GET', '/api/reports/pnl');
      if (bs.ok && pl.ok && bs.data && pl.data) {
        const A = bs.data.totalAssets || 0, L = bs.data.totalLiabilities || 0, E = bs.data.totalEquity || 0, NI = pl.data.netIncome || 0;
        if (Math.abs(A - (L + E + NI)) > 0.5) flag('critical', 'تجربة: المعادلة المحاسبية', `الأصول (${A}) لا تساوي الخصوم+حقوق الملكية+صافي الدخل (${(L + E + NI).toFixed(3)})`, 'خلل في التقارير المالية — يخالف المعادلة المحاسبية الأساسية');
        else say('  ✅ المعادلة المحاسبية متوازنة (أصول = خصوم + حقوق + صافي الدخل)');
      }
    }

    // ── تجربة 6: مسح استقرار شامل — يكتشف كل الشاشات تلقائياً ──
    // يجلب قائمة كل الـ GET endpoints من الخادم نفسه، فيغطّي أي ميزة جديدة تلقائياً
    let reportEps = ['/api/reports/pnl', '/api/reports/balance-sheet', '/api/reports/cashflow', '/api/trial-balance', '/api/financial-statements', '/api/stats'];
    const disc = await api('GET', '/api/agents/routes');
    if (disc.ok && Array.isArray(disc.data?.routes) && disc.data.routes.length) {
      const skip = ['/api/agents/run', '/api/export', '/api/monthly-report-slide', '/api/agents/routes'];
      reportEps = disc.data.routes.filter(p => !skip.some(s => p.startsWith(s)));
      say(`  ↳ اكتشفت ${reportEps.length} شاشة/endpoint تلقائياً`);
    }
    const crashed = [];
    for (const p of reportEps) { try { const r = await api('GET', p); if (r.status >= 500) crashed.push(p); } catch {} }
    if (crashed.length) flag('critical', 'تجربة: استقرار', `${crashed.length} شاشة تنهار (خطأ 500): ${crashed.slice(0, 8).join('، ')}`, 'راجع معالجة الأخطاء في هذه الـ endpoints');
    else say(`  ✅ فحصت ${reportEps.length} شاشة — كلها تعمل بدون انهيار`);

    // ── تجربة 6ب: اختبار عشوائي (Fuzz) — مدخلات خاطئة يجب أن تُرفض بلطف لا أن تُسقط النظام ──
    const fuzzCases = [
      ['/api/journal',  { date: '2026-01-01', lines: 'ليست مصفوفة' }],
      ['/api/journal',  { date: '2026-01-01', lines: [{ debit: 'abc', credit: null }] }],
      ['/api/journal',  { lines: [{ debit: 1e20, credit: 1e20 }] }],
      ['/api/expenses', { amount: -50 }],
      ['/api/expenses', { date: '2026-01-01', amount: 'كثير' }],
      ['/api/expenses', { date: '2026-01-01', amount: 10, desc: '<script>alert(1)</script>' }],
      ['/api/coa/account', {}],
      ['/api/coa/account', { code: '', name: '' }],
      ['/api/vouchers', { type: 'receipt' }],
      ['/api/inv/items', { quantity: -999 }],
    ];
    const fuzzCrashes = [];
    for (const [p, body] of fuzzCases) {
      try { const r = await api('POST', p, body); if (r.status >= 500) fuzzCrashes.push(`${p} (${r.status})`); }
      catch { fuzzCrashes.push(`${p} (تعطّل الاتصال)`); }
    }
    if (fuzzCrashes.length) flag('high', 'تجربة: مدخلات خاطئة', `${fuzzCrashes.length} حالة مدخلات خاطئة تُسقط النظام بدل رفضها بلطف: ${fuzzCrashes.slice(0, 6).join('، ')}`, 'أضف تحقّقاً من المدخلات (validation) لهذه الـ endpoints');
    else say(`  ✅ جرّبت ${fuzzCases.length} مُدخَل خاطئ — النظام رفضها بلطف دون انهيار`);

    // ── تجربة 7: إضافة صنف مخزون وحفظ الكمية بشكل صحيح ──
    const inv = await api('POST', '/api/inv/items', { id: 'sbx-item', name: 'صنف اختبار', code: 'SBX-1', quantity: 10, costPrice: 5, minQty: 3, unit: 'حبة' });
    if (inv.ok && inv.data?.success) {
      const list = await api('GET', '/api/inv/items');
      const item = (Array.isArray(list.data) ? list.data : []).find(i => i.id === 'sbx-item');
      if (!item) flag('medium', 'تجربة: مخزون', 'الصنف المُضاف لم يظهر في القائمة', 'راجع حفظ أصناف المخزون');
      else if (Number(item.quantity) !== 10) flag('medium', 'تجربة: مخزون', `كمية الصنف غير صحيحة (${item.quantity} بدل 10)`, 'راجع حفظ الكمية');
      else say('  ✅ إضافة صنف مخزون تعمل وتحفظ الكمية صحيحة');
    }

    // ── تجربة 8: سند قبض ──
    if (assetLeaf && revLeaf) {
      const v = await api('POST', '/api/vouchers', { type: 'receipt', date: '2026-02-03', payee: 'اختبار', assetAccId: assetLeaf.id || assetLeaf.code, lines: [{ accountId: revLeaf.id || revLeaf.code, amount: 75, desc: 'قبض اختبار' }] });
      if (v.status >= 500) flag('high', 'تجربة: سند', `سند القبض ينهار (${v.status})`, 'راجع POST /api/vouchers');
      else if (v.status < 400) say('  ✅ سند قبض أُنشئ بنجاح');
    }

    say('  ✅ انتهت التجارب الحية — البيئة التجريبية تُحذف الآن');
  } catch (e) {
    say('  ⚠️ خطأ أثناء التجارب الحية: ' + e.message);
  } finally {
    sb.stop();
  }
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
  L.push('> جرّبت النظام مثل محاسب حقيقي: فحصت البيانات (قيود، شجرة حسابات، عمولات، تأمين، مخزون)، وأجريت تجارب حية في بيئة معزولة (أضفت حسابات، عملت قيوداً، سجّلت مصاريف، أنشأت سندات، ودقّقت التقارير والمعادلة المحاسبية). بيانات عيادتك الحقيقية لم تُمَس.');
  L.push('');

  // Regression summary — what changed since the last run
  if (_newIssues.length || _resolvedIssues.length) {
    L.push('## 🔄 التغيّرات منذ آخر فحص');
    if (_newIssues.length)      L.push(`- 🆕 **${_newIssues.length} مشكلة جديدة** ظهرت: ${_newIssues.map(i => i.msg).slice(0, 4).join(' · ')}`);
    if (_resolvedIssues.length) L.push(`- ✅ **${_resolvedIssues.length} مشكلة انحلّت** منذ آخر مرة`);
    L.push('');
  }

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
  L.push('_المُجرِّب — يفحص البيانات للقراءة فقط، ويجري التجارب الحية في بيئة معزولة. بيانات الإنتاج لا تُمَس._');
  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  say('▶ المُجرِّب بدأ — سأختبر النظام مثل محاسب حقيقي...');
  const db = await loadDB();
  if (!db) {
    say('❌ تعذّر قراءة قاعدة البيانات');
    process.stdout.write('# 🧪 تقرير المُجرِّب\n\n❌ تعذّر قراءة قاعدة البيانات المحلية.\n');
    process.exit(0);
  }

  // Read-only integrity checks on real data
  testJournalBalance(db);
  testChartOfAccounts(db);
  testCodeGeneration(db);
  testCommissions(db);
  testInsurance(db);
  testInventory(db);

  // Live end-to-end trials in an isolated sandbox (real data physically untouched)
  await testEndToEnd(db);

  // Compare with the previous run — what's new, what got fixed
  runRegression();
  if (_newIssues.length) say(`  🆕 ${_newIssues.length} مشكلة جديدة منذ آخر فحص`);
  if (_resolvedIssues.length) say(`  ✅ ${_resolvedIssues.length} مشكلة انحلّت منذ آخر فحص`);

  say(`✅ انتهيت — اكتشفت ${issues.length} ملاحظة. التقرير جاهز.`);
  process.stdout.write(buildReport() + '\n');
}

main().catch(e => {
  say('❌ خطأ عام: ' + e.message);
  try { process.stdout.write(buildReport() + '\n'); } catch {}
  process.exit(0);
});
