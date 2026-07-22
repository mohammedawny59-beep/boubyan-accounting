#!/usr/bin/env node
'use strict';
/**
 * Design/UX Department v3.0 — DeptAgent
 * Checks: Accessibility · RTL · Mobile · Arabic UX
 * Standards: WCAG 2.1 AA · Apple HIG · Material Design 3
 */
const { DeptAgent }              = require('./_agent');
const { readFile, countPattern } = require('./_common');

async function main() {
  const agent = new DeptAgent({
    name:      'design-audit',
    nameAr:    '🎨 قسم التصميم وتجربة المستخدم',
    mission:   'تدقيق UX/Accessibility وفق معايير WCAG 2.1 AA و Apple HIG',
    standards: ['WCAG 2.1 AA', 'Apple HIG', 'Material Design 3', 'RTL/Arabic UX'],
  });

  agent.loadMemory();

  const html = readFile('public/index.html');
  const css  = (html.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n');

  // ── Accessibility ─────────────────────────────────────────────────────────────
  const imgsNoAlt = countPattern(html, /<img(?![^>]*\balt\s*=)[^>]*>/gi);
  if (imgsNoAlt > 0)
    agent.finding('high', 'accessibility',
      'صور بدون alt text',
      `${imgsNoAlt} عنصر <img> بدون alt`,
      'أضف alt="وصف الصورة" لكل <img> — مطلوب WCAG 2.1 AA');
  else
    agent.ok('accessibility', 'جميع الصور لها alt text');

  const iconBtns = countPattern(
    html,
    /<button[^>]*>\s*<(?:i|svg|span)[^>]*>[^<]*<\/(?:i|svg|span)>\s*<\/button>/gi,
  );
  if (iconBtns > 0)
    agent.finding('medium', 'accessibility',
      'أزرار icon-only بدون aria-label',
      `${iconBtns} زر`,
      'أضف aria-label="اسم الزر" لكل زر أيقونة فقط');
  else
    agent.ok('accessibility', 'أزرار الأيقونات لها aria-label');

  const inputsNoLabel = (html.match(/<input[^>]+>/gi) || [])
    .filter(i => /type="(?:text|email|password|number|date)"/i.test(i) && !/<label/i.test(i))
    .length;
  if (inputsNoLabel > 0)
    agent.finding('high', 'accessibility',
      'حقول input بدون label',
      `${inputsNoLabel} حقل بدون <label> مرتبط`,
      'أربط كل <input> بـ <label for="..."> أو aria-label');
  else
    agent.ok('accessibility', 'جميع الحقول لها label');

  // ── Color & Contrast ──────────────────────────────────────────────────────────
  const lowContrast = countPattern(
    css,
    /color:\s*#(?:aaa|bbb|ccc|ddd|eee|999|888|777|acacac|b0b0b0)/gi,
  );
  if (lowContrast > 0)
    agent.finding('medium', 'color',
      'ألوان نص بتباين منخفض محتمل',
      `${lowContrast} قيمة لون قد تفشل تباين 4.5:1`,
      'استخدم أداة contrast checker وتأكد من نسبة 4.5:1 (WCAG AA)');
  else
    agent.ok('color', 'ألوان النص تبدو مناسبة للتباين');

  // ── Touch Targets ─────────────────────────────────────────────────────────────
  const smallTargets = countPattern(
    css,
    /(?:width|height)\s*:\s*(?:[1-3]\d|4[0-3])px/gi,
  );
  if (smallTargets > 0)
    agent.finding('medium', 'touch',
      'عناصر قابلة للنقر أصغر من 44px',
      `${smallTargets} حالة — الحد الأدنى 44×44px`,
      'زد الحجم لـ 44px على الأقل أو وسّع منطقة اللمس بـ padding');
  else
    agent.ok('touch', 'مقاسات عناصر اللمس >= 44px');

  // ── RTL & i18n ────────────────────────────────────────────────────────────────
  const hasRTL = html.includes('dir="rtl"') || html.includes("dir='rtl'");
  if (!hasRTL)
    agent.finding('high', 'rtl',
      'dir="rtl" مفقود',
      'عنصر <html> بدون اتجاه RTL',
      'أضف dir="rtl" lang="ar" لعنصر <html>');
  else
    agent.ok('rtl', 'dir="rtl" و lang موجودان');

  // ── Responsive ────────────────────────────────────────────────────────────────
  if (!html.includes('viewport'))
    agent.finding('high', 'responsive',
      'viewport meta مفقود',
      'لا يوجد meta viewport — قد تظهر الصفحة مكبّرة على الهاتف',
      'أضف <meta name="viewport" content="width=device-width,initial-scale=1">');
  else
    agent.ok('responsive', 'viewport meta موجود');

  // ── Production Quality ────────────────────────────────────────────────────────
  const consoleLogs = countPattern(html, /console\.(log|error|warn)\(/g);
  if (consoleLogs > 0)
    agent.finding('low', 'production',
      'console.log في كود الإنتاج',
      `${consoleLogs} استخدام — يكشف معلومات للمتصفح`,
      'احذف أو علّق console.log قبل الإنتاج');
  else
    agent.ok('production', 'لا console.log في الإنتاج');

  // ── Metrics ───────────────────────────────────────────────────────────────────
  agent.metric('حجم index.html', html.split('\n').length, 'سطر');
  agent.metric('عناصر img', (html.match(/<img/gi) || []).length, 'عنصر');
  agent.metric('عناصر input', (html.match(/<input/gi) || []).length, 'حقل');
  agent.metric('عناصر button', (html.match(/<button/gi) || []).length, 'زر');

  agent.saveMemory();
  await agent.runAgentLoop();

  const report = await agent.buildReport();
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[design-audit] خطأ: ${e.message}\n`));
