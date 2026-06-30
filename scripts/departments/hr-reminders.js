#!/usr/bin/env node
'use strict';
// HR Department — monthly reminders
// Kuwait Labor Law No. 6/2010 + PIFSS Law 61/1976

const { today, thisMonth } = require('./_common');

const now   = new Date();
const month = now.getMonth() + 1; // 1-12
const year  = now.getFullYear();
const day   = now.getDate();

// ── PIFSS deadline: 15th of each month ───────────────────────────────────────
const daysUntilPIFSS = 15 - day;
const pifssStatus = daysUntilPIFSS > 0
  ? `⏰ متبقي ${daysUntilPIFSS} يوم (الموعد: ${year}-${String(month).padStart(2,'0')}-15)`
  : daysUntilPIFSS === 0
    ? '🚨 اليوم هو آخر يوم!'
    : `🔴 تأخر ${Math.abs(daysUntilPIFSS)} يوم`;

// ── Annual leave resets: January ──────────────────────────────────────────────
const isJanuary = month === 1;

// ── EOS reminder: quarterly ───────────────────────────────────────────────────
const isQuarter = [3,6,9,12].includes(month);

// ── WPS reminder: last week of month ─────────────────────────────────────────
const daysInMonth = new Date(year, month, 0).getDate();
const isLastWeek = day >= daysInMonth - 6;

// ── Kuwait public holidays (approximate) ─────────────────────────────────────
const HOLIDAYS = [
  { date: `${year}-01-01`, name: 'رأس السنة الميلادية' },
  { date: `${year}-02-25`, name: 'اليوم الوطني الكويتي' },
  { date: `${year}-02-26`, name: 'يوم التحرير' },
  { date: `${year}-05-01`, name: 'عيد العمال العالمي' },
];
const upcomingHoliday = HOLIDAYS.find(h => {
  const diff = (new Date(h.date) - now) / (1000*60*60*24);
  return diff >= 0 && diff <= 14;
});

// ── Build report ──────────────────────────────────────────────────────────────
const lines = [
  `# 👥 HR Department — تذكيرات ${thisMonth()}`,
  `**التاريخ:** ${today()}`,
  '',
  '## 🏛️ التأمينات الاجتماعية (PIFSS)',
  `| البند | التفاصيل |`,
  `|-------|----------|`,
  `| موعد السداد | 15 من كل شهر |`,
  `| الحالة | ${pifssStatus} |`,
  `| نسبة صاحب العمل | 11% من الراتب الأساسي |`,
  `| نسبة الموظف الكويتي | 7% من الراتب الأساسي |`,
  '',
  `### ✅ قائمة مراجعة PIFSS — ${thisMonth()}`,
  '- [ ] حصر الموظفين الكويتيين وإجمالي رواتبهم الأساسية',
  '- [ ] احتساب حصة صاحب العمل (11%)',
  '- [ ] احتساب حصة الموظفين (7%) وخصمها من الرواتب',
  '- [ ] تحويل المبلغ الإجمالي لحساب PIFSS',
  '- [ ] حفظ إيصال التحويل في ملف الشركة',
  '- [ ] تسجيل القيد المحاسبي:',
  '  - مدين: مصروف تأمينات اجتماعية (حصة صاحب العمل)',
  '  - مدين: ذمم موظفين — PIFSS (حصة الموظف)',
  '  - دائن: البنك / الصندوق',
  '',
  '## 💰 مكافأة نهاية الخدمة (EOS)',
  isQuarter ? '> ⏰ **ربع سنوي:** الوقت المناسب لمراجعة مخصص نهاية الخدمة' : '',
  '| سنوات الخدمة | المعدل |',
  '|-------------|--------|',
  '| 1 - 5 سنوات | 15 يوم/سنة من آخر راتب أساسي |',
  '| أكثر من 5 سنوات | 30 يوم/سنة من آخر راتب أساسي |',
  '',
  '### ✅ مهام EOS',
  isQuarter ? '- [ ] مراجعة وتحديث مخصص EOS لكل موظف' : '- ℹ️ المراجعة ربع سنوية (مارس، يونيو، سبتمبر، ديسمبر)',
  '- [ ] التحقق من قيد: مدين مصروف EOS — دائن مخصص EOS',
  '',
  '## 💳 نظام حماية الأجور (WPS)',
  isLastWeek ? '> ⏰ **نهاية الشهر قريبة:** تأكد من تجهيز ملف WPS' : '',
  '- [ ] تجهيز ملف WPS للبنك قبل نهاية الشهر',
  '- [ ] مطابقة إجمالي الرواتب مع ملف WPS',
  '- [ ] التأكد من صحة أرقام IBAN للموظفين الجدد',
  '',
  isJanuary ? '## 🏖️ الإجازات السنوية\n- [ ] تذكير: تجديد رصيد الإجازات السنوية لجميع الموظفين (30 يوم)\n- [ ] مراجعة الرصيد المتراكم من العام السابق\n' : '',
  upcomingHoliday ? `## 📅 إجازة رسمية قادمة\n> 🎌 **${upcomingHoliday.name}** — ${upcomingHoliday.date}\n- [ ] تنظيم جدول الدوام خلال الإجازة\n` : '',
  '## 📋 قائمة مراجعة شاملة',
  '- [ ] مراجعة عقود الموظفين الجدد (إن وجد)',
  '- [ ] التحقق من تجديد تصاريح عمل الموظفين الأجانب',
  '- [ ] مراجعة ساعات العمل الإضافي وحساب المكافأة (25% - 50%)',
  '- [ ] التأكد من تسوية السُّلَف والعُهَد المفتوحة',
  '',
  '---',
  '_تقرير آلي من قسم HR — بوبيان للمحاسبة_',
].filter(l => l !== null && l !== undefined && l !== false).join('\n');

process.stdout.write(lines + '\n');
