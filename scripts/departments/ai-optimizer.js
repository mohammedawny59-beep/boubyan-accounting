#!/usr/bin/env node
'use strict';
// AI Department — monthly AI optimization report
// Checks model versions, usage patterns, suggests improvements

const { readFile, countPattern, today } = require('./_common');

const server = readFile('server.js');
const ai     = readFile('lib/ai.js');

// ── Model inventory ───────────────────────────────────────────────────────────
const modelMatches = [...(server + ai).matchAll(/claude-[\w-]+/g)];
const modelCounts  = {};
modelMatches.forEach(m => { modelCounts[m[0]] = (modelCounts[m[0]]||0) + 1; });

// Known latest models as of 2026
const LATEST_MODELS = {
  'claude-haiku':  { latest: 'claude-haiku-4-5-20251001',  tier: 'Fast & Cheap'   },
  'claude-sonnet': { latest: 'claude-sonnet-4-6',           tier: 'Balanced'       },
  'claude-opus':   { latest: 'claude-opus-4-8',             tier: 'Most Capable'   },
};

const DEPRECATED = ['claude-3-haiku-20240307','claude-3-sonnet-20240229','claude-3-opus-20240229','claude-2','claude-instant','claude-sonnet-4-20250514','claude-haiku-4-5'];

const deprecatedFound = Object.keys(modelCounts).filter(m => DEPRECATED.some(d => m.includes(d)));

// ── AI endpoint inventory ─────────────────────────────────────────────────────
const aiEndpoints = (server.match(/app\.(post|get)\s*\(['"](\/api\/ai\/[^'"]+)/g)||[])
  .map(m => m.match(/['"](\/api\/ai\/[^'"]+)/)?.[1])
  .filter(Boolean);

// ── Prompt quality checks ─────────────────────────────────────────────────────
const longPrompts = (server.match(/`[\s\S]{500,}/g)||[]).length;
const hasSystemPrompts = countPattern(server + ai, /system\s*:/g);
const hasRetry = server.includes('retry') || ai.includes('retry');
const hasCache  = server.includes('cache_control') || server.includes('cacheControl');
const streamingEndpoints = (server.match(/stream:\s*true/g)||[]).length;

// ── Cost estimation (rough) ───────────────────────────────────────────────────
const haikuCalls  = Object.entries(modelCounts).filter(([k]) => k.includes('haiku')).reduce((s,[,v])=>s+v,0);
const sonnetCalls = Object.entries(modelCounts).filter(([k]) => k.includes('sonnet')).reduce((s,[,v])=>s+v,0);

const lines = [
  `# 🤖 AI Department — تقرير التحسين ${today().slice(0,7)}`,
  `**التاريخ:** ${today()}`,
  '',
  '## 📋 جرد النماذج المستخدمة',
  `| النموذج | عدد الاستخدامات | الحالة |`,
  `|---------|----------------|--------|`,
  ...Object.entries(modelCounts).map(([model, count]) => {
    const isDeprecated = DEPRECATED.some(d => model.includes(d));
    return `| \`${model}\` | ${count} | ${isDeprecated ? '⚠️ قديم' : '✅ حديث'} |`;
  }),
  '',
  deprecatedFound.length > 0
    ? `## ⚠️ نماذج قديمة يجب التحديث\n${deprecatedFound.map(m => `- [ ] تحديث \`${m}\` → نموذج أحدث`).join('\n')}`
    : '## ✅ جميع النماذج محدّثة',
  '',
  '## 🔌 AI Endpoints الحالية',
  aiEndpoints.length
    ? aiEndpoints.map(e => `- \`${e}\``).join('\n')
    : '- لا endpoints AI',
  '',
  '## 📊 مؤشرات الجودة',
  `| المؤشر | الحالة | الملاحظة |`,
  `|--------|--------|----------|`,
  `| System Prompts | ${hasSystemPrompts > 0 ? '✅' : '❌'} | ${hasSystemPrompts} prompt نظام موجود |`,
  `| Streaming | ${streamingEndpoints > 0 ? '✅' : '🟡'} | ${streamingEndpoints} endpoint streaming |`,
  `| Retry Logic | ${hasRetry ? '✅' : '❌'} | ${hasRetry ? 'موجود' : 'غير موجود — أضف retry للمكالمات الفاشلة'} |`,
  `| Prompt Caching | ${hasCache ? '✅' : '🟡'} | ${hasCache ? 'موجود' : 'غير مفعّل — يوفر 90% من تكلفة system prompts'} |`,
  '',
  '## 💡 توصيات التحسين',
  '',
  !hasRetry ? '### 1. 🔄 إضافة Retry Logic\nعند فشل API call، أعد المحاولة 2-3 مرات مع تأخير تصاعدي.\n```javascript\n// في lib/ai.js\nasync function callAIWithRetry(opts, retries = 3) {\n  for (let i = 0; i < retries; i++) {\n    try { return await callAI(opts); }\n    catch (e) { if (i === retries-1) throw e; await new Promise(r=>setTimeout(r, 1000*(i+1))); }\n  }\n}\n```\n- [ ] موافقة لتطبيق Retry Logic\n' : '',
  !hasCache ? '### 2. 💰 تفعيل Prompt Caching\nأضف `cache_control` للـ system prompts الثابتة لتوفير 90% من التكلفة.\n- [ ] موافقة لتفعيل Prompt Caching\n' : '',
  '### 3. 📊 إضافة AI Usage Tracking\nسجّل كل AI call: النموذج، الـ tokens، الوقت، والـ endpoint.\n- [ ] موافقة لإضافة Usage Tracking\n',
  '### 4. 🎯 نموذج مخصص للتصنيف السريع\nللمهام البسيطة (تصنيف مصروف، اقتراح حساب) استخدم Haiku دائماً لخفض التكلفة.\n',
  '## 🆕 ميزات AI مقترحة',
  '- [ ] **Voice-to-Journal عربي:** تحويل رسالة صوتية بالعربية لقيد محاسبي (Telegram)',
  '- [ ] **Smart Duplicate Detection:** كشف القيود المكررة بالـ AI',
  '- [ ] **AI Budget Forecast:** توقع الميزانية للشهر القادم تلقائياً',
  '- [ ] **Arabic OCR Enhancement:** استخراج بيانات الفواتير العربية بدقة أعلى',
  '',
  '---',
  '_تقرير آلي من قسم AI — بوبيان للمحاسبة_',
].filter(l => l !== null && l !== undefined && l !== false).join('\n');

process.stdout.write(lines + '\n');
