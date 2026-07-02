#!/usr/bin/env node
'use strict';
/**
 * Market Intelligence Department — قسم أبحاث المنافسين والسوق
 * CLAUDE.md §2 — القسم الجديد 1
 *
 * يبحث أسبوعياً عن:
 *   - ميزات جديدة أطلقتها QuickBooks / Zoho / Xero / Wave / FreshBooks
 *   - اتجاهات AI في المحاسبة
 *   - تسعير المنافسين وباقاتهم
 *
 * المخرج: تقرير JSON جاهز لـ rd-suggestions.js
 * قاعدة: يبحث فقط، لا ينسخ. يستخرج المفهوم لا التنفيذ.
 */
const { DeptAgent } = require('./_agent');
const { callAI }    = require('../../lib/ai');
const { search }    = require('./_search');
const { today }     = require('./_common');
const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '../..');
const INTEL_FILE = path.join(ROOT, '.agent-memory', 'market-intel-latest.json');

const COMPETITORS = ['QuickBooks Online', 'Zoho Books', 'Xero', 'Wave Accounting', 'FreshBooks', 'Sage Intacct'];

const SEARCH_QUERIES = [
  'QuickBooks Zoho Xero new features 2026 accounting software',
  'AI accounting automation bookkeeping agent 2026',
  'accounting SaaS pricing plans 2026 comparison',
  'AI bookkeeping startup funding 2026',
  '"accounting software" new feature announcement site:techcrunch.com OR site:producthunt.com',
];

async function main() {
  const agent = new DeptAgent({
    name:      'market-intel',
    nameAr:    '🕵️ قسم أبحاث المنافسين والسوق',
    mission:   'رصد المنافسين واتجاهات السوق أسبوعياً لتغذية خارطة الطريق',
    standards: ['Competitive Intelligence Best Practices', 'SaaS Market Analysis', 'Ethical Research'],
  });

  agent.loadMemory();

  if (!process.env.ANTHROPIC_API_KEY) {
    agent.finding('high', 'config', 'ANTHROPIC_API_KEY مفقود', 'يحتاج Claude لتحليل نتائج البحث', 'أضف المفتاح للبيئة');
    const report = await agent.buildReport();
    process.stdout.write(report + '\n');
    return;
  }

  agent._log('🔍 بدء بحث السوق...');

  const allResults = [];

  for (const query of SEARCH_QUERIES) {
    try {
      agent._log(`🌐 بحث: "${query}"`);
      const results = await search(query, 5);
      allResults.push(...results.map(r => ({ query, title: r.title, snippet: r.snippet, url: r.url })));
    } catch (e) {
      agent._log(`تحذير بحث: ${e.message}`);
    }
  }

  agent.metric('نتائج بحث جُمعت', allResults.length, 'نتيجة');

  if (allResults.length === 0) {
    agent.finding('medium', 'connectivity', 'لا يمكن الوصول للإنترنت', 'البحث فشل — تحقق من الاتصال', 'تحقق من GOOGLE_SEARCH_API_KEY أو الاتصال');
    const report = await agent.buildReport();
    process.stdout.write(report + '\n');
    return;
  }

  // Use Claude to analyze results and extract intelligence
  const resultsText = allResults.map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.snippet}\n${r.url}`
  ).join('\n\n');

  const prompt = `أنت محلل استراتيجي متخصص في سوق برامج المحاسبة SaaS.

نتائج البحث (لا تنسخ منها — استخرج المفاهيم فقط):
${resultsText.slice(0, 6000)}

المنافسون: ${COMPETITORS.join(', ')}

اليوم: ${today()}

المنتج المُحلَّل: برنامج محاسبة AI-Native SaaS يستهدف الشركات الصغيرة والمتوسطة.

أجب بـ JSON فقط — قائمة من 5 اكتشافات استراتيجية:
[
  {
    "title": "اسم الميزة أو الاتجاه",
    "competitor": "اسم المنافس أو 'الصناعة عامة'",
    "insight": "ما الذي اكتشفته بجملة واحدة",
    "why_it_matters": "لماذا يهمنا كـ SaaS",
    "our_response": "ما يجب أن نفعله",
    "effort_estimate": "يوم | 3أيام | أسبوع | شهر",
    "priority": "HIGH | MEDIUM | LOW",
    "category": "AI | UX | pricing | feature | security | compliance"
  }
]

تذكر: لا تنسخ كوداً أو نصاً من مواقع المنافسين — استخرج المفاهيم فقط.`;

  let intelligence = [];
  try {
    const res = await callAI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    const m = (res || '').match(/\[[\s\S]*\]/);
    if (m) intelligence = JSON.parse(m[0]);
  } catch (e) {
    agent._log(`تحذير تحليل: ${e.message}`);
  }

  // Save for rd-suggestions.js to consume
  const intelData = {
    date: today(),
    resultsCount: allResults.length,
    intelligence,
    rawSearchCount: allResults.length,
  };

  try {
    const dir = path.dirname(INTEL_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = INTEL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(intelData, null, 2), 'utf8');
    fs.renameSync(tmp, INTEL_FILE);
    agent._log(`💾 تم حفظ ${intelligence.length} اكتشاف في market-intel-latest.json`);
  } catch (e) {
    agent._log(`تحذير حفظ: ${e.message}`);
  }

  // Generate findings based on intelligence
  const highPriority = intelligence.filter(i => i.priority === 'HIGH');
  const medPriority  = intelligence.filter(i => i.priority === 'MEDIUM');

  if (highPriority.length > 0) {
    agent.finding('high', 'market-gap',
      `${highPriority.length} ميزة منافسة عالية الأولوية`,
      highPriority.map(i => `• ${i.title} (${i.competitor})`).join('\n'),
      `راجع market-intel-latest.json وأضف لخارطة طريق RD`);
  } else {
    agent.ok('market-position', 'لا ثغرات حرجة مكتشفة هذا الأسبوع');
  }

  if (medPriority.length > 0) {
    agent.finding('medium', 'opportunities',
      `${medPriority.length} فرصة تطوير متوسطة الأولوية`,
      medPriority.map(i => `• ${i.title}`).join('\n'),
      'ناقش مع قسم البحث والتطوير في الاجتماع الأسبوعي');
  }

  agent.metric('اكتشافات HIGH', highPriority.length, '');
  agent.metric('اكتشافات MEDIUM', medPriority.length, '');
  agent.metric('مصادر بحثت', SEARCH_QUERIES.length, 'استعلام');

  agent.saveMemory();
  await agent.runAgentLoop();

  // Extras: intelligence table
  const tableRows = intelligence.map(i => {
    const p = i.priority === 'HIGH' ? '🔴' : i.priority === 'MEDIUM' ? '🟡' : '🟢';
    return `| ${p} ${i.title} | ${i.competitor} | ${i.category} | ${i.effort_estimate} |`;
  }).join('\n');

  const detailRows = intelligence.map((i, idx) =>
    `### ${idx + 1}. ${i.title}\n` +
    `**المنافس:** ${i.competitor} | **الأولوية:** ${i.priority} | **الجهد:** ${i.effort_estimate}\n\n` +
    `**الاكتشاف:** ${i.insight}\n\n` +
    `**لماذا يهمنا:** ${i.why_it_matters}\n\n` +
    `**استجابتنا:** ${i.our_response}\n`
  ).join('\n---\n\n');

  const extras = `## 🗺️ ملخص الاكتشافات

| الميزة/الاتجاه | المنافس | الفئة | الجهد |
|----------------|--------|-------|-------|
${tableRows || '| لا اكتشافات هذا الأسبوع | — | — | — |'}

---

## 📋 الاكتشافات بالتفصيل

${detailRows || 'لا اكتشافات كافية.'}

---

> ⚠️ **تذكير:** هذا التقرير يستخرج مفاهيم فقط — لا نسخ من مواقع المنافسين
> 💾 البيانات الكاملة: \`.agent-memory/market-intel-latest.json\``;

  const report = await agent.buildReport(extras);
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[market-intel] خطأ: ${e.message}\n`));
