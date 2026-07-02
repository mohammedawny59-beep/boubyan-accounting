#!/usr/bin/env node
'use strict';
/**
 * AI Optimizer Department v3.0 — DeptAgent
 * Checks: model versions · prompt quality · retry logic · caching
 * Standards: Anthropic Best Practices · Cost Optimization · Reliability
 */
const { DeptAgent }              = require('./_agent');
const { readFile, countPattern } = require('./_common');

async function main() {
  const agent = new DeptAgent({
    name:      'ai-optimizer',
    nameAr:    '🤖 قسم تحسين الذكاء الاصطناعي',
    mission:   'مراجعة جودة استخدام Claude API وتحسين الأداء والتكلفة',
    standards: ['Anthropic Best Practices', 'Prompt Engineering', 'Cost Optimization'],
  });

  agent.loadMemory();

  const server = readFile('server.js');
  const ai     = readFile('lib/ai.js');
  const depts  = readFile('scripts/departments/_agent.js');
  const allCode = server + ai + depts;

  // ── Model inventory ───────────────────────────────────────────────────────────
  const modelMatches = [...allCode.matchAll(/claude-[\w.-]+/g)];
  const modelCounts  = {};
  modelMatches.forEach(m => { modelCounts[m[0]] = (modelCounts[m[0]] || 0) + 1; });

  const DEPRECATED = [
    'claude-3-haiku-20240307',
    'claude-3-sonnet-20240229',
    'claude-3-opus-20240229',
    'claude-2',
    'claude-instant',
    'claude-sonnet-4-20250514',
    'claude-haiku-4-5',
  ];

  const deprecatedFound = Object.keys(modelCounts)
    .filter(m => DEPRECATED.some(d => m.includes(d) && m !== d + '-20251001'));

  if (deprecatedFound.length > 0)
    agent.finding('high', 'models',
      'نماذج قديمة (Deprecated) في الكود',
      deprecatedFound.join(', '),
      'حدّث للنماذج الحديثة: haiku-4-5-20251001 · sonnet-4-6 · opus-4-8');
  else
    agent.ok('models', 'جميع النماذج المستخدمة حديثة');

  // ── Prompt quality ────────────────────────────────────────────────────────────
  const hasSystemPrompts = countPattern(allCode, /system\s*:/g);
  if (hasSystemPrompts === 0)
    agent.finding('medium', 'prompts',
      'لا system prompts موجودة',
      'الـ system prompt يحسّن الاتساق ويقلل الـ tokens',
      'أضف system prompt لكل callAI في المهام المتكررة');
  else
    agent.ok('prompts', `System Prompts موجودة (${hasSystemPrompts} استخدام)`);

  const hasRetry = server.includes('retry') || ai.includes('retry');
  if (!hasRetry)
    agent.finding('medium', 'reliability',
      'لا Retry Logic للـ API calls',
      'فشل واحد يكسر العملية — شبكة أو rate limit',
      'أضف retry بـ exponential backoff في lib/ai.js (2-3 محاولات)');
  else
    agent.ok('reliability', 'Retry Logic موجود');

  const hasCache = server.includes('cache_control') || server.includes('cacheControl');
  if (!hasCache)
    agent.finding('low', 'cost',
      'Prompt Caching غير مفعّل',
      'System prompts الثابتة تُعاد إرسالها في كل طلب — تكلفة إضافية',
      'أضف cache_control للـ system prompts الثابتة لتوفير 90% من تكلفتها');
  else
    agent.ok('cost', 'Prompt Caching مفعّل');

  // ── Streaming ─────────────────────────────────────────────────────────────────
  const streamingCount = (server.match(/stream:\s*true/g) || []).length;
  if (streamingCount === 0)
    agent.finding('low', 'ux',
      'لا Streaming Responses',
      'المستخدم ينتظر الإجابة كاملة قبل رؤية أي نص',
      'فعّل stream:true للردود الطويلة لتحسين تجربة المستخدم');
  else
    agent.ok('ux', `Streaming مفعّل (${streamingCount} endpoint)`);

  // ── Endpoints inventory ───────────────────────────────────────────────────────
  const aiEndpoints = (server.match(/app\.(post|get)\s*\(['"](\/api\/ai\/[^'"]+)/g) || [])
    .map(m => m.match(/['"](\/api\/ai\/[^'"]+)/)?.[1])
    .filter(Boolean);

  // ── Metrics ───────────────────────────────────────────────────────────────────
  agent.metric('نماذج Claude مستخدمة', Object.keys(modelCounts).length, 'نموذج');
  agent.metric('AI Endpoints', aiEndpoints.length, 'endpoint');
  agent.metric('نماذج قديمة', deprecatedFound.length, 'نموذج', 0);
  agent.metric('System Prompts', hasSystemPrompts, 'استخدام');

  // ── Extras: model table ───────────────────────────────────────────────────────
  const modelRows = Object.entries(modelCounts).map(([model, count]) => {
    const old = DEPRECATED.some(d => model.includes(d));
    return `| \`${model}\` | ${count} | ${old ? '⚠️ قديم' : '✅ حديث'} |`;
  }).join('\n');

  const endpointList = aiEndpoints.length
    ? aiEndpoints.map(e => `- \`${e}\``).join('\n')
    : '- لا AI endpoints';

  const extras = `## 📋 جرد النماذج

| النموذج | الاستخدامات | الحالة |
|---------|------------|:------:|
${modelRows}

## 🔌 AI Endpoints الحالية

${endpointList}`;

  agent.saveMemory();
  await agent.runAgentLoop();

  const report = await agent.buildReport(extras);
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[ai-optimizer] خطأ: ${e.message}\n`));
