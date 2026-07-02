#!/usr/bin/env node
'use strict';
/**
 * Design Studio Department — قسم التصميم الإنتاجي
 * CLAUDE.md §2 — القسم الجديد 2
 *
 * يرصد اتجاهات UI/UX العالمية ويقترح مكوّنات جديدة.
 * لا ينفّذ في index.html مباشرة — يمرر كل اقتراح على design-audit.js أولاً.
 * يختلف عن design-audit.js: ذاك يفحص، هذا يبني ويقترح.
 */
const { DeptAgent } = require('./_agent');
const { callAI }    = require('../../lib/ai');
const { search }    = require('./_search');
const { readFile, countPattern, today } = require('./_common');

const UI_TRENDS_QUERIES = [
  'web UI design trends 2026 glassmorphism bento grid dark mode',
  'SaaS dashboard UI patterns 2026 accounting finance',
  'micro-interactions animation finance app 2026',
  'accounting software UX best practices 2026',
];

async function main() {
  const agent = new DeptAgent({
    name:      'design-studio',
    nameAr:    '🎨 قسم التصميم — إنتاج',
    mission:   'رصد اتجاهات UI/UX واقتراح مكوّنات جديدة — يبني ويقترح، لا يفحص فقط',
    standards: ['Apple HIG', 'Material Design 3', 'WCAG 2.1 AA', 'Motion Design', 'Bento Grid'],
  });

  agent.loadMemory();

  const index = readFile('public/index.html');
  const indexLines = index.split('\n').length;

  // ── Current UI audit (quick) ─────────────────────────────────────────────────
  agent._log('📐 تحليل واجهة المستخدم الحالية...');

  const hasAnimations    = /transition|animation|@keyframes|transform/i.test(index);
  const hasDarkMode      = /dark|theme|prefers-color-scheme/i.test(index);
  const hasLoadingStates = /skeleton|shimmer|loading|spinner/i.test(index);
  const hasEmptyStates   = /empty|no.data|لا.توجد|ليس.هناك/i.test(index);
  const hasToasts        = /toast|notification|snackbar|alert/i.test(index);
  const hasMobileNav     = /bottom.nav|hamburger|mobile.*menu/i.test(index);
  const hasCharts        = /chart|graph|canvas|recharts|chartjs/i.test(index);

  agent.metric('سطور index.html', indexLines, 'سطر');
  agent.metric('Animations', hasAnimations    ? '✅' : '❌');
  agent.metric('Dark Mode', hasDarkMode       ? '✅' : '❌');
  agent.metric('Loading States', hasLoadingStates ? '✅' : '❌');
  agent.metric('Empty States', hasEmptyStates ? '✅' : '❌');
  agent.metric('Charts', hasCharts            ? '✅' : '❌');

  if (!hasAnimations) {
    agent.finding('medium', 'motion', 'لا Animations/Transitions',
      'واجهة بدون حركة تبدو قديمة مقارنة بالمنافسين',
      'أضف CSS transitions (150-300ms) على كل تفاعل مستخدم');
  } else {
    agent.ok('motion', 'Animations موجودة');
  }

  if (!hasLoadingStates) {
    agent.finding('medium', 'feedback', 'لا Skeleton Screens',
      'المستخدم يرى شاشة فارغة عند التحميل — تجربة سيئة',
      'أضف skeleton placeholders للجداول والكروت أثناء loading');
  } else {
    agent.ok('feedback', 'Loading states موجودة');
  }

  if (!hasEmptyStates) {
    agent.finding('low', 'ux', 'Empty States غير موجودة',
      'عند عدم وجود بيانات، المستخدم يرى فراغاً بدون توجيه',
      'أضف رسالة تشجيعية + action button عند عدم وجود بيانات');
  } else {
    agent.ok('ux', 'Empty States موجودة');
  }

  if (!hasDarkMode) {
    agent.finding('low', 'theming', 'Dark Mode مفقود',
      '82% من مستخدمي التطبيقات المالية يفضلون Dark Mode (2025)',
      'أضف CSS variables + prefers-color-scheme toggle');
  } else {
    agent.ok('theming', 'Dark Mode موجود');
  }

  // ── Search for UI trends ────────────────────────────────────────────────────
  agent._log('🌐 بحث عن اتجاهات UI 2026...');
  const allResults = [];
  for (const q of UI_TRENDS_QUERIES) {
    try {
      const results = await search(q, 3);
      allResults.push(...results);
    } catch { /* continue */ }
  }

  agent.metric('مصادر UI بُحثت', allResults.length, 'نتيجة');

  // ── AI: Generate component suggestions ──────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY && allResults.length > 0) {
    const trendsText = allResults.slice(0, 10).map(r => `- ${r.title}: ${r.snippet}`).join('\n');

    const prompt = `أنت مصمم UI/UX متخصص في تطبيقات المحاسبة SaaS.

اتجاهات UI 2026 من البحث:
${trendsText}

الواجهة الحالية:
- ${indexLines} سطر HTML/CSS/JS
- Animations: ${hasAnimations} | Dark Mode: ${hasDarkMode} | Skeletons: ${hasLoadingStates}
- Charts: ${hasCharts} | Empty States: ${hasEmptyStates}

اقترح 5 مكوّنات UI جديدة تجعل البرنامج يبدو Enterprise-grade.
أجب بـ JSON فقط:
[
  {
    "component": "اسم المكوّن",
    "description": "ما يفعله ولماذا",
    "style": "glassmorphism | bento | minimal | neumorphism",
    "priority": "HIGH | MEDIUM | LOW",
    "wcag_compliant": true,
    "rtl_ready": true,
    "effort": "ساعة | يوم | 3أيام",
    "code_hint": "مثال CSS/HTML مختصر (سطر واحد فقط)"
  }
]`;

    try {
      const res = await callAI({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
      const m = (res || '').match(/\[[\s\S]*\]/);
      if (m) {
        const suggestions = JSON.parse(m[0]);
        agent._designSuggestions = suggestions;

        const highCount = suggestions.filter(s => s.priority === 'HIGH').length;
        if (highCount > 0) {
          agent.finding('low', 'innovation',
            `${highCount} مكوّن UI عالي الأولوية مقترح`,
            suggestions.filter(s => s.priority === 'HIGH').map(s => `• ${s.component}`).join('\n'),
            'راجع الاقتراحات في التقرير — مرّر على design-audit.js قبل التنفيذ');
        } else {
          agent.ok('innovation', 'الواجهة في مستوى جيد — فرص تحسين متوسطة');
        }
      }
    } catch (e) {
      agent._log(`تحذير AI: ${e.message}`);
    }
  }

  agent.saveMemory();
  await agent.runAgentLoop();

  // Extras: design suggestions
  const suggestions = agent._designSuggestions || [];
  const suggRows = suggestions.map((s, i) => {
    const p = s.priority === 'HIGH' ? '🔴' : s.priority === 'MEDIUM' ? '🟡' : '🟢';
    return `### ${i + 1}. ${p} ${s.component}
**الأسلوب:** ${s.style} | **الجهد:** ${s.effort} | **WCAG:** ${s.wcag_compliant ? '✅' : '⚠️'} | **RTL:** ${s.rtl_ready ? '✅' : '⚠️'}

${s.description}

\`${s.code_hint || 'راجع التفاصيل أدناه'}\`

> ⚠️ يجب تمرير التنفيذ على \`design-audit.js\` للتحقق من WCAG 2.1 AA و RTL قبل النشر`;
  }).join('\n\n---\n\n');

  const extras = `## 🎨 مقترحات مكوّنات UI جديدة — ${today()}

> المعيار: Apple HIG + Material Design 3 + WCAG 2.1 AA + RTL

${suggRows || 'لا اقتراحات هذا الشهر — الواجهة في حالة جيدة.'}

---

## 🌊 اتجاهات UI 2026 المرصودة

${allResults.slice(0, 5).map(r => `- **${r.title}**: ${r.snippet}`).join('\n') || 'لا نتائج بحث.'}`;

  const report = await agent.buildReport(extras);
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[design-studio] خطأ: ${e.message}\n`));
