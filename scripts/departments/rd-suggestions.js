#!/usr/bin/env node
'use strict';
/**
 * R&D Department v3.0 — DeptAgent
 * Uses Agent Loop (web_search + AI) to suggest next features
 * Standards: IFRS · Kuwait Law · Dental Clinic Best Practices
 */
const { DeptAgent }                   = require('./_agent');
const { readFile, countLines,
        countPattern }                = require('./_common');
const { callAI }                      = require('../../lib/ai.js');

async function main() {
  const agent = new DeptAgent({
    name:      'rd-suggestions',
    nameAr:    '🔬 قسم البحث والتطوير',
    mission:   'تحليل النظام واقتراح ميزات جديدة لعيادة الأسنان بالكويت',
    standards: ['IFRS', 'قانون العمل الكويتي', 'Dental Clinic Best Practices', 'AI-First Design'],
  });

  agent.loadMemory();

  const server = readFile('server.js');
  const index  = readFile('public/index.html');

  // ── System analysis ───────────────────────────────────────────────────────────
  const serverLines      = countLines(server);
  const endpoints        = (server.match(/app\.(get|post|put|delete)\s*\([`'"]/g) || []).length;
  const aiEndpoints      = (server.match(/\/api\/ai\//g) || []).length;
  const hasPayroll       = server.includes('/api/payroll');
  const hasInventory     = server.includes('/api/inv');
  const hasAssets        = server.includes('/api/assets');
  const hasTelegram      = server.includes('setupBot');
  const hasEmail         = server.includes('nodemailer');
  const hasForecast      = server.includes('/api/ai/forecast');
  const hasBudget        = server.includes('/api/budget');
  const hasApprovalFlow  = server.includes('approval') || server.includes('approve');
  const hasVoice         = server.includes('voice') || server.includes('speech');
  const hasExport        = server.includes('/api/export') || server.includes('pdf');
  const testCount        = countPattern(server, /describe\(|test\(|it\(/g);

  // ── Findings: missing critical features ───────────────────────────────────────
  if (!hasApprovalFlow)
    agent.finding('medium', 'workflow',
      'لا يوجد Approval Workflow',
      'المبالغ الكبيرة تُسجَّل مباشرة بدون موافقة مدير',
      'أضف طلب موافقة للمبالغ > KD 500 — يحسّن الرقابة الداخلية');

  if (testCount < 10)
    agent.finding('medium', 'quality',
      'تغطية الاختبارات منخفضة',
      `${testCount} اختبار فقط في نظام من ${serverLines.toLocaleString()} سطر`,
      'أضف اختبارات وحدة للوظائف الحسابية الحرجة (IFRS calculations)');

  if (!hasVoice)
    agent.finding('low', 'innovation',
      'لا Voice-to-Journal',
      'لا يمكن إدخال القيود بالصوت — ميزة مطلوبة بالعيادات',
      'أضف Telegram voice message → Claude → journal entry تلقائي');

  if (!hasForecast)
    agent.finding('low', 'analytics',
      'لا توقعات مالية (AI Forecast)',
      'لا يوجد endpoint /api/ai/forecast',
      'أضف توقع تدفق نقدي شهري بالـ AI مبني على بيانات العيادة');

  if (!hasExport)
    agent.finding('low', 'reporting',
      'لا تصدير PDF للتقارير',
      'التقارير تُعرض فقط في الواجهة — لا تصدير للطباعة',
      'أضف تصدير PDF للتقارير الشهرية (puppeteer أو pdfkit)');

  // OK checks
  if (hasPayroll)  agent.ok('features', 'نظام الرواتب موجود');
  if (hasInventory) agent.ok('features', 'نظام المخزون موجود');
  if (hasAssets)   agent.ok('features', 'نظام الأصول موجود');
  if (hasTelegram) agent.ok('features', 'Telegram Bot موجود');
  if (hasEmail)    agent.ok('features', 'إشعارات البريد موجودة');
  if (hasBudget)   agent.ok('features', 'نظام الميزانية موجود');

  // ── Metrics ───────────────────────────────────────────────────────────────────
  agent.metric('API Endpoints', endpoints, 'endpoint');
  agent.metric('AI Endpoints', aiEndpoints, 'endpoint');
  agent.metric('حجم server.js', serverLines, 'سطر');
  agent.metric('اختبارات', testCount, 'اختبار');

  agent.saveMemory();

  // ── Agent loop: search for dental + IFRS + Kuwait tech trends ────────────────
  await agent.runAgentLoop();

  // ── AI suggestions (only if no agent insights) ────────────────────────────────
  let suggestions = [];
  if (!agent._agentInsights && process.env.ANTHROPIC_API_KEY) {
    const prompt = `أنت مستشار تطوير لنظام محاسبة عيادة أسنان كويتية (بوبيان).

الوضع الحالي: ${serverLines.toLocaleString()} سطر · ${endpoints} endpoint · ${aiEndpoints} AI endpoint
ميزات موجودة: رواتب=${hasPayroll} · مخزون=${hasInventory} · أصول=${hasAssets} · تيليجرام=${hasTelegram} · ميزانية=${hasBudget}
مشاكل مكتشفة: approval=${!hasApprovalFlow} · voice=${!hasVoice} · forecast=${!hasForecast} · pdf=${!hasExport}

اقترح 5 ميزات عملية قابلة للتنفيذ في أسبوع أو أقل. أجب بـ JSON فقط:
[{"title":"...","description":"...","priority":"HIGH|MEDIUM|LOW","effort":"يوم|3أيام|أسبوع","category":"AI|محاسبة|تقارير|UX|أمان","ifrs_note":"...أو null"}]`;

    try {
      const res = await callAI({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] });
      const m = (res || '').match(/\[[\s\S]*\]/);
      if (m) suggestions = JSON.parse(m[0]);
    } catch { /* fallback below */ }
  }

  if (!suggestions.length) {
    suggestions = [
      { title: 'نظام الموافقات (Approval Workflow)', description: 'موافقة المدير للمبالغ > KD 500 عبر Telegram.', priority: 'HIGH', effort: 'أسبوع', category: 'أمان', ifrs_note: null },
      { title: 'تقرير التدفق النقدي التلقائي', description: 'إنشاء تقرير IAS 7 شهري وإرساله بالبريد.', priority: 'HIGH', effort: '3 أيام', category: 'تقارير', ifrs_note: 'IAS 7' },
      { title: 'مطابقة بنكية بالـ AI', description: 'رفع كشف البنك ومطابقته مع القيود تلقائياً.', priority: 'HIGH', effort: 'أسبوع', category: 'AI', ifrs_note: 'IAS 32' },
      { title: 'Voice-to-Journal (Telegram)', description: 'تحويل رسالة صوتية لقيد محاسبي بالعربية.', priority: 'MEDIUM', effort: '3 أيام', category: 'AI', ifrs_note: null },
      { title: 'تصدير PDF للتقارير', description: 'تصدير الميزانية وقائمة الدخل PDF جاهز للطباعة.', priority: 'MEDIUM', effort: '3 أيام', category: 'تقارير', ifrs_note: null },
    ];
  }

  const emoji = { HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢' };
  const suggRows = suggestions.map((s, i) =>
    `### ${i + 1}. ${emoji[s.priority] || '⚪'} ${s.title}\n` +
    `**الأولوية:** ${s.priority} | **الجهد:** ${s.effort} | **التصنيف:** ${s.category}\n\n` +
    `${s.description}` +
    (s.ifrs_note ? `\n\n> 📋 **IFRS:** ${s.ifrs_note}` : '') +
    `\n\n- [ ] موافقة لتطوير هذه الميزة\n`
  ).join('\n---\n\n');

  const extras = `## 💡 مقترحات R&D للشهر القادم

> تحليل مبني على الكود الحالي واحتياجات عيادات الأسنان في الكويت.
> ✅ على الميزات التي تريد تطويرها ثم أغلق الـ Issue.

${suggRows}

## 📊 إحصائيات النظام الحالي

| المقياس | القيمة |
|---------|--------|
| API Endpoints | ${endpoints} |
| AI Endpoints | ${aiEndpoints} |
| حجم server.js | ${serverLines.toLocaleString()} سطر |
| اختبارات | ${testCount} |`;

  const report = await agent.buildReport(extras);
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[rd-suggestions] خطأ: ${e.message}\n`));
