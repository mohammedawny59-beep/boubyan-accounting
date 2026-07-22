#!/usr/bin/env node
'use strict';
/**
 * HR Department v3.0 — DeptAgent
 * Kuwait Labor Law No. 6/2010 + PIFSS Law 61/1976
 * Standards: Kuwait WPS · PIFSS · IFRS
 */
const { DeptAgent } = require('./_agent');

async function main() {
  const agent = new DeptAgent({
    name:      'hr-reminders',
    nameAr:    '👥 قسم الموارد البشرية',
    mission:   'الالتزام بقانون العمل الكويتي رقم 6/2010 وقانون PIFSS 61/1976',
    standards: ['قانون العمل الكويتي 6/2010', 'قانون PIFSS 61/1976', 'WPS', 'IFRS'],
  });

  agent.loadMemory();

  const now          = new Date();
  const month        = now.getMonth() + 1;
  const year         = now.getFullYear();
  const day          = now.getDate();
  const daysInMonth  = new Date(year, month, 0).getDate();
  const daysUntilPIF = 15 - day;

  // ── PIFSS deadline: 15th of each month ───────────────────────────────────────
  if (daysUntilPIF < 0)
    agent.finding('high', 'pifss',
      'PIFSS متأخر عن الموعد',
      `تأخر ${Math.abs(daysUntilPIF)} يوم عن موعد 15/${String(month).padStart(2,'0')}`,
      'سدّد التأمينات الاجتماعية فوراً وتواصل مع PIFSS لتجنب الغرامات');
  else if (daysUntilPIF <= 3)
    agent.finding('medium', 'pifss',
      'موعد PIFSS خلال 3 أيام',
      `متبقي ${daysUntilPIF} ${daysUntilPIF === 1 ? 'يوم' : 'أيام'} فقط`,
      'جهّز المبلغ وسدّد الآن: صاحب العمل 11% + الموظف 7% من الراتب الأساسي');
  else
    agent.ok('pifss', `PIFSS — متبقي ${daysUntilPIF} يوم (15/${String(month).padStart(2,'0')}/${year})`);

  // ── WPS: last week of month ───────────────────────────────────────────────────
  if (day >= daysInMonth - 6)
    agent.finding('medium', 'wps',
      'نهاية الشهر — تجهيز ملف WPS',
      `اليوم ${day} من ${daysInMonth} — نافذة WPS مفتوحة`,
      'أعدّ ملف WPS للبنك وتأكد من صحة IBAN للموظفين الجدد');
  else
    agent.ok('wps', `WPS — متبقي ${daysInMonth - day} يوم على نهاية الشهر`);

  // ── EOS: quarterly ────────────────────────────────────────────────────────────
  const isQuarter = [3, 6, 9, 12].includes(month);
  if (isQuarter)
    agent.finding('low', 'eos',
      'مراجعة ربع سنوية لمخصص EOS',
      'الربع الحالي يستوجب مراجعة مكافأة نهاية الخدمة',
      'راجع وحدّث مخصص EOS (1-5 سنوات: 15 يوم/سنة · أكثر: 30 يوم/سنة)');
  else
    agent.ok('eos', 'EOS — ليس شهر مراجعة ربع سنوية');

  // ── Annual leave: January ─────────────────────────────────────────────────────
  if (month === 1)
    agent.finding('medium', 'leave',
      'تجديد رصيد الإجازات السنوية',
      'يناير — وقت تجديد الإجازات السنوية (30 يوم)',
      'جدّد رصيد الإجازات لكل موظف وراجع الرصيد المتراكم من العام السابق');
  else
    agent.ok('leave', 'رصيد الإجازات — لا إجراء مطلوب هذا الشهر');

  // ── Kuwait public holidays (within 14 days) ───────────────────────────────────
  const HOLIDAYS = [
    { date: `${year}-01-01`, name: 'رأس السنة الميلادية' },
    { date: `${year}-02-25`, name: 'اليوم الوطني الكويتي' },
    { date: `${year}-02-26`, name: 'يوم التحرير' },
    { date: `${year}-05-01`, name: 'عيد العمال العالمي' },
  ];
  const upcoming = HOLIDAYS.find(h => {
    const diff = (new Date(h.date) - now) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 14;
  });
  if (upcoming)
    agent.finding('low', 'holiday',
      `إجازة رسمية قادمة: ${upcoming.name}`,
      `${upcoming.date} — خلال أسبوعين`,
      'نظّم جدول الدوام وأبلغ الموظفين مسبقاً');

  // ── Metrics ───────────────────────────────────────────────────────────────────
  agent.metric('يوم من الشهر', day, `/ ${daysInMonth}`);
  agent.metric('أيام حتى PIFSS', Math.max(0, daysUntilPIF), 'يوم');

  // ── Monthly checklist (appended as extras) ────────────────────────────────────
  const checklist = `## 📋 قائمة مراجعة HR — ${String(month).padStart(2,'0')}/${year}

### التأمينات الاجتماعية (PIFSS)
- [ ] حصر الموظفين الكويتيين وإجمالي رواتبهم الأساسية
- [ ] احتساب حصة صاحب العمل (11%) وحصة الموظف (7%)
- [ ] تحويل المبلغ لحساب PIFSS قبل 15/${String(month).padStart(2,'0')}/${year}
- [ ] حفظ إيصال التحويل في ملف الشركة
- [ ] تسجيل القيد: **مدين** مصروف تأمينات + **مدين** ذمم موظفين — **دائن** البنك

### نظام حماية الأجور (WPS)
- [ ] تجهيز ملف WPS للبنك
- [ ] مطابقة إجمالي الرواتب مع ملف WPS
- [ ] التأكد من صحة IBAN للموظفين الجدد

### مكافأة نهاية الخدمة (EOS)
${isQuarter
  ? '- [ ] مراجعة مخصص EOS لكل موظف وتحديثه\n- [ ] التحقق من القيد: مدين مصروف EOS — دائن مخصص EOS'
  : '- ℹ️ المراجعة ربع سنوية (مارس · يونيو · سبتمبر · ديسمبر)'}

### متابعة عامة
- [ ] مراجعة عقود الموظفين الجدد
- [ ] تجديد تصاريح عمل الموظفين الأجانب
- [ ] حساب العمل الإضافي (25% ليل + 50% إجازة)
- [ ] تسوية السُّلَف والعُهَد المفتوحة`;

  agent.saveMemory();
  await agent.runAgentLoop();

  const report = await agent.buildReport(checklist);
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[hr-reminders] خطأ: ${e.message}\n`));
