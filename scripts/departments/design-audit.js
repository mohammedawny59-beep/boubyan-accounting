#!/usr/bin/env node
'use strict';
// Design/UX Department — monthly UI audit
// Checks: accessibility, RTL, mobile, Arabic UX patterns

const { readFile, countPattern, today } = require('./_common');

const html = readFile('public/index.html');
const css  = (html.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n');

// ── Accessibility checks ──────────────────────────────────────────────────────
const checks = [
  {
    name: 'صور بدون alt text',
    count: countPattern(html, /<img(?![^>]*\balt\s*=)[^>]*>/gi),
    severity: 'HIGH',
    fix: 'أضف `alt="وصف الصورة"` لكل عنصر `<img>`',
  },
  {
    name: 'أزرار بدون aria-label (icon-only)',
    count: countPattern(html, /<button[^>]*>\s*<(?:i|svg|span)[^>]*>[^<]*<\/(?:i|svg|span)>\s*<\/button>/gi),
    severity: 'MEDIUM',
    fix: 'أضف `aria-label="اسم الزر"` للأزرار التي تحتوي فقط على أيقونة',
  },
  {
    name: 'حقول input بدون label',
    count: (()=>{
      const inputs = (html.match(/<input[^>]+>/gi)||[]).filter(i => !/<label/i.test(i) && /type="(?:text|email|password|number|date)"/i.test(i));
      return inputs.length;
    })(),
    severity: 'HIGH',
    fix: 'كل `<input>` يجب أن يكون له `<label>` مرتبط',
  },
  {
    name: 'لون متباين منخفض محتمل',
    count: countPattern(css, /color:\s*#(?:aaa|bbb|ccc|ddd|eee|999|888|777|acacac|b0b0b0)/gi),
    severity: 'MEDIUM',
    fix: 'استخدم ألوان نص بتباين لا يقل عن 4.5:1 مع الخلفية (WCAG AA)',
  },
  {
    name: 'عناصر قابلة للنقر صغيرة (<44px)',
    count: countPattern(css, /(?:width|height)\s*:\s*(?:[1-3]\d|4[0-3])px/gi),
    severity: 'MEDIUM',
    fix: 'الحد الأدنى لعناصر اللمس هو 44×44px (Apple HIG)',
  },
  {
    name: 'نص dir="rtl" أو lang="ar" مفقود',
    count: html.includes('dir="rtl"') || html.includes("dir='rtl'") ? 0 : 1,
    severity: 'HIGH',
    fix: 'أضف `dir="rtl"` و`lang="ar"` لعنصر `<html>`',
  },
  {
    name: 'viewport meta مفقود',
    count: html.includes('viewport') ? 0 : 1,
    severity: 'HIGH',
    fix: 'أضف `<meta name="viewport" content="width=device-width, initial-scale=1">`',
  },
  {
    name: 'console.error/log في الكود الإنتاجي',
    count: countPattern(html, /console\.(log|error|warn)\(/g),
    severity: 'LOW',
    fix: 'احذف أو علّق console.log في الإنتاج',
  },
];

const issues   = checks.filter(c => c.count > 0);
const passed   = checks.filter(c => c.count === 0);
const score    = Math.round((passed.length / checks.length) * 100);
const scoreEmoji = score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴';

// ── UX suggestions ────────────────────────────────────────────────────────────
const UX_SUGGESTIONS = [
  '**Loading States:** أضف skeleton screens بدل spinner للعمليات التي تتجاوز 300ms',
  '**Error Messages:** رسائل الخطأ يجب أن تشرح المشكلة والحل (لا "خطأ" فقط)',
  '**Empty States:** أضف رسالة + زر إجراء عندما تكون القائمة فارغة',
  '**Keyboard Navigation:** تأكد من إمكانية التنقل بين العناصر بمفتاح Tab',
  '**Toast Notifications:** اجعل الإشعارات تختفي تلقائياً بعد 4 ثوانٍ مع زر إغلاق',
  '**Mobile:** تأكد من أن الجداول قابلة للتمرير أفقياً على الهاتف',
  '**Arabic Numbers:** استخدم الأرقام العربية (٠١٢٣) أو الإنجليزية بشكل موحد',
  '**Focus Trap:** في الـ modals، احبس التركيز داخل النافذة المنبثقة',
];

const lines = [
  `# 🎨 Design/UX Department — تدقيق ${today().slice(0,7)}`,
  `**التاريخ:** ${today()} | **درجة UX:** ${scoreEmoji} ${score}/100`,
  '',
  '## 🔍 نتائج الفحص التلقائي',
  issues.length === 0
    ? '✅ لم تُكتشف مشاكل UX/Accessibility تلقائياً'
    : `| الخطورة | المشكلة | العدد | الحل |\n|---------|---------|-------|------|\n${issues.map(c => `| ${c.severity === 'HIGH' ? '🔴 عالي' : c.severity === 'MEDIUM' ? '🟡 متوسط' : '🔵 منخفض'} | ${c.name} | ${c.count} | ${c.fix} |`).join('\n')}`,
  '',
  '## ✅ اجتاز الفحص',
  passed.map(c => `- ✅ ${c.name}`).join('\n') || '(لا شيء)',
  '',
  '## 💡 توصيات UX للشهر القادم',
  UX_SUGGESTIONS.map((s, i) => `${i+1}. ${s}`).join('\n'),
  '',
  '## 🎯 إجراءات مقترحة',
  issues.filter(c => c.severity === 'HIGH').map(c => `- [ ] 🔴 ${c.name}: ${c.fix}`).join('\n') || '',
  issues.filter(c => c.severity === 'MEDIUM').map(c => `- [ ] 🟡 ${c.name}: ${c.fix}`).join('\n') || '',
  '',
  '---',
  '_تقرير آلي من قسم Design/UX — بوبيان للمحاسبة_',
].filter(l => l !== null && l !== undefined).join('\n');

process.stdout.write(lines + '\n');
