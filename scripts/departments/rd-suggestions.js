#!/usr/bin/env node
'use strict';
// R&D Department — monthly feature suggestions via AI
// Analyzes codebase and suggests next improvements

const { readFile, countLines, countPattern, today } = require('./_common');

async function callAI(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const { Anthropic } = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content?.[0]?.text || null;
  } catch { return null; }
}

async function main() {
  const server   = readFile('server.js');
  const index    = readFile('public/index.html');

  const endpoints = (server.match(/app\.(get|post|put|delete)\s*\(['"`]([^'"`]+)/g) || []).length;
  const aiEndpoints = (server.match(/\/api\/ai\//g) || []).length;
  const hasPayroll   = server.includes('/api/payroll');
  const hasInventory = server.includes('/api/inv');
  const hasAssets    = server.includes('/api/assets');
  const hasTelegram  = server.includes('setupBot');
  const hasEmail     = server.includes('nodemailer');
  const hasForecast  = server.includes('/api/ai/forecast');
  const hasBudget    = server.includes('/api/budget');
  const serverLines  = countLines(server);
  const tests        = countPattern(server, /describe\(|test\(|it\(/g);

  const context = `أنت مستشار تطوير برمجي لنظام محاسبة عيادة أسنان كويتية (بوبيان).

الوضع الحالي للنظام:
- Node.js/Express backend (${serverLines.toLocaleString()} سطر)
- ${endpoints} API endpoint
- ${aiEndpoints} AI endpoint (Claude API)
- ميزات موجودة: رواتب=${hasPayroll}, مخزون=${hasInventory}, أصول=${hasAssets}, تيليجرام=${hasTelegram}, بريد=${hasEmail}, توقعات=${hasForecast}, ميزانية=${hasBudget}
- اختبارات: ${tests}

اقترح 5 ميزات عملية لتطوير هذا النظام خلال الشهر القادم. كل ميزة يجب أن:
1. تخدم احتياجات عيادة أسنان كويتية فعلاً
2. تكون قابلة للتنفيذ في أسبوع أو أقل
3. تستخدم الـ AI بشكل ذكي إن أمكن
4. تلتزم بمعايير IFRS والقانون الكويتي

أجب بـ JSON فقط:
[
  {
    "title": "اسم الميزة",
    "description": "وصف قصير (جملتين)",
    "priority": "HIGH|MEDIUM|LOW",
    "effort": "يوم واحد|3 أيام|أسبوع",
    "category": "AI|محاسبة|تقارير|UX|أمان|تكامل",
    "ifrs_note": "ملاحظة IFRS إن وجد أو null"
  }
]`;

  const aiResponse = await callAI(context);
  let suggestions = [];
  if (aiResponse) {
    try {
      const m = aiResponse.match(/\[[\s\S]*\]/);
      if (m) suggestions = JSON.parse(m[0]);
    } catch {}
  }

  // Fallback suggestions if AI unavailable
  if (!suggestions.length) {
    suggestions = [
      { title: 'تقرير التدفق النقدي التلقائي', description: 'إنشاء تقرير تدفق نقدي شهري تلقائي وإرساله بالبريد.', priority: 'HIGH', effort: '3 أيام', category: 'تقارير', ifrs_note: 'IAS 7' },
      { title: 'تنبيهات المخزون المنخفض', description: 'إشعار Telegram عند وصول مخزون لحد أدنى.', priority: 'HIGH', effort: 'يوم واحد', category: 'AI', ifrs_note: null },
      { title: 'مطابقة بنكية بالـ AI', description: 'رفع كشف البنك وتطابقه مع القيود تلقائياً.', priority: 'HIGH', effort: 'أسبوع', category: 'AI', ifrs_note: 'IAS 32' },
      { title: 'تقرير أداء الأطباء الشهري (PDF)', description: 'تصدير تقرير PDF جاهز للطباعة لكل طبيب.', priority: 'MEDIUM', effort: '3 أيام', category: 'تقارير', ifrs_note: null },
      { title: 'نظام الموافقات (Approval Workflow)', description: 'طلب موافقة المدير للمبالغ التي تتجاوز حداً معيناً.', priority: 'MEDIUM', effort: 'أسبوع', category: 'أمان', ifrs_note: null },
    ];
  }

  const priorityEmoji = { HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢' };

  const rows = suggestions.map((s, i) =>
    `### ${i+1}. ${priorityEmoji[s.priority] || '⚪'} ${s.title}\n` +
    `**الأولوية:** ${s.priority} | **الجهد:** ${s.effort} | **التصنيف:** ${s.category}\n\n` +
    `${s.description}\n` +
    (s.ifrs_note ? `\n> 📋 **IFRS:** ${s.ifrs_note}` : '') +
    `\n\n- [ ] موافقة لتطوير هذه الميزة\n`
  ).join('\n---\n\n');

  const lines = [
    `# 🔬 R&D Department — مقترحات ${today().slice(0,7)}`,
    `**التاريخ:** ${today()} | **المصدر:** ${aiResponse ? 'Claude AI' : 'قائمة افتراضية'}`,
    '',
    '> هذه مقترحات مبنية على تحليل الكود الحالي واحتياجات عيادات الأسنان في الكويت.',
    '> ضع ✅ على الميزات التي تريد تطويرها ثم أغلق الـ Issue.',
    '',
    rows,
    '',
    '## 📊 إحصائيات الكود الحالي',
    `| المقياس | القيمة |`,
    `|--------|--------|`,
    `| API Endpoints | ${endpoints} |`,
    `| AI Endpoints | ${aiEndpoints} |`,
    `| حجم server.js | ${countLines(server).toLocaleString()} سطر |`,
    '',
    '---',
    '_تقرير آلي من قسم R&D — بوبيان للمحاسبة_',
  ].join('\n');

  process.stdout.write(lines + '\n');
}

main().catch(e => {
  process.stdout.write(`# 🔬 R&D Department\n\n> ❌ خطأ: ${e.message}\n`);
});
