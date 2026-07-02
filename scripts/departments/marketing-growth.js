#!/usr/bin/env node
'use strict';
/**
 * Marketing & Growth Department — قسم التسويق والنمو
 * CLAUDE.md §3 — القسم الجديد 4
 *
 * ينتج مسودات محتوى تسويقي (LinkedIn, Twitter/X, Product Hunt).
 * كل قطعة محتوى → APPROVAL.NOTIFY → يُنشر فقط بعد موافقة يدوية.
 * لا ينشر مباشرة — يحفظ في marketing-drafts.json للمراجعة.
 */
const { DeptAgent } = require('./_agent');
const { APPROVAL }  = require('./_common');
const { callAI }    = require('../../lib/ai');
const { today }     = require('./_common');
const fs   = require('fs');
const path = require('path');

const ROOT         = path.join(__dirname, '../..');
const INTEL_FILE   = path.join(ROOT, '.agent-memory', 'market-intel-latest.json');
const DRAFTS_FILE  = path.join(ROOT, '.agent-memory', 'marketing-drafts.json');

async function main() {
  const agent = new DeptAgent({
    name:      'marketing-growth',
    nameAr:    '📣 قسم التسويق والنمو',
    mission:   'توليد مسودات محتوى تسويقي احترافي لبيع المنتج عالمياً — كل شيء يمر بالموافقة',
    standards: ['Content Marketing Best Practices', 'SaaS GTM', 'GDPR-compliant Marketing'],
  });

  agent.loadMemory();

  // Load market intelligence from market-intel.js (if available)
  let marketContext = '';
  try {
    if (fs.existsSync(INTEL_FILE)) {
      const intel = JSON.parse(fs.readFileSync(INTEL_FILE, 'utf8'));
      if (intel.intelligence && intel.intelligence.length > 0) {
        marketContext = intel.intelligence.slice(0, 3).map(i =>
          `• ${i.title}: ${i.insight}`
        ).join('\n');
      }
    }
  } catch { /* silently skip */ }

  if (!process.env.ANTHROPIC_API_KEY) {
    agent.finding('high', 'config', 'ANTHROPIC_API_KEY مفقود',
      'توليد المحتوى يتطلب Claude', 'أضف ANTHROPIC_API_KEY للبيئة');
    const report = await agent.buildReport();
    process.stdout.write(report + '\n');
    return;
  }

  agent._log('✍️ توليد مسودات المحتوى التسويقي...');

  const contextBlock = marketContext
    ? `\n\nاتجاهات السوق الأسبوعية:\n${marketContext}`
    : '';

  const prompt = `أنت كاتب تسويق محترف متخصص في SaaS وتقنية المحاسبة. مهمتك كتابة محتوى تسويقي يبيع فعلاً.

المنتج: برنامج محاسبة AI-Native يهدف إلى منافسة QuickBooks وZoho وXero.
الميزة الفريدة: وكلاء AI يراجعون البرنامج نفسه ويطوّرونه باستمرار.
الجمهور المستهدف: مدراء مالية، أصحاب شركات صغيرة-متوسطة، عيادات، محاسبون.
اللغة: بالعربية أولاً ثم نسخة انجليزية.${contextBlock}

اليوم: ${today()}

أنشئ 3 مسودات محتوى، كل واحدة لمنصة مختلفة:

1. LinkedIn Post (عربي + انجليزي): مقال احترافي عن ميزة AI في المحاسبة
2. Twitter/X Thread (انجليزي): 5 tweets عن كيف يختلف المنتج عن QuickBooks
3. Product Hunt Tagline + Description (انجليزي): للإطلاق على Product Hunt

أجب بـ JSON فقط:
{
  "linkedin": {
    "ar": "النص العربي (200-300 كلمة)",
    "en": "English version (200-300 words)",
    "hashtags": ["#SaaS", "#AIAccounting"],
    "cta": "Call to action"
  },
  "twitter": {
    "thread": [
      "Tweet 1/5 (280 chars max)",
      "Tweet 2/5...",
      "Tweet 3/5...",
      "Tweet 4/5...",
      "Tweet 5/5..."
    ],
    "hashtags": ["#AI", "#Accounting"]
  },
  "producthunt": {
    "tagline": "Short tagline (60 chars max)",
    "description": "Description (300 chars max)",
    "topics": ["FinTech", "AI", "SaaS"]
  }
}`;

  let drafts = null;
  try {
    const res = await callAI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    });
    const m = (res || '').match(/\{[\s\S]*\}/);
    if (m) drafts = JSON.parse(m[0]);
  } catch (e) {
    agent._log(`تحذير توليد المحتوى: ${e.message}`);
  }

  if (drafts) {
    // Save drafts atomically
    const draftsData = {
      date: today(),
      status: 'PENDING_REVIEW',
      drafts,
    };
    try {
      const dir = path.dirname(DRAFTS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = DRAFTS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(draftsData, null, 2), 'utf8');
      fs.renameSync(tmp, DRAFTS_FILE);
      agent._log(`💾 ${3} مسودات محفوظة في marketing-drafts.json`);
    } catch (e) {
      agent._log(`تحذير حفظ: ${e.message}`);
    }

    // All drafts → NOTIFY (never auto-publish)
    agent.finding('info', 'content',
      '3 مسودات تسويقية جاهزة للمراجعة',
      '• LinkedIn Post (عربي/انجليزي)\n• Twitter/X Thread (5 tweets)\n• Product Hunt Launch Copy',
      'راجع .agent-memory/marketing-drafts.json وانشر يدوياً بعد الموافقة',
      APPROVAL.NOTIFY);

    // Quality metrics
    const linkedinLen = (drafts.linkedin?.ar || '').split(' ').length;
    const twitterCount = (drafts.twitter?.thread || []).length;
    const phTagline = (drafts.producthunt?.tagline || '').length;

    agent.metric('LinkedIn كلمات (عربي)', linkedinLen, 'كلمة');
    agent.metric('Twitter tweets', twitterCount, 'tweet');
    agent.metric('PH Tagline طول', phTagline, 'حرف');
    agent.metric('حالة المسودات', 'PENDING_REVIEW');

    if (phTagline > 60) {
      agent.finding('low', 'quality', 'Product Hunt tagline طويل جداً',
        `${phTagline} حرف — الحد 60`,
        'قصّر الـ tagline قبل النشر على Product Hunt');
    } else {
      agent.ok('quality', 'Product Hunt tagline في الحد المسموح');
    }
  } else {
    agent.finding('medium', 'generation', 'فشل توليد المسودات',
      'Claude لم يُنتج JSON صالحاً',
      'أعد التشغيل أو راجع الـ prompt');
  }

  agent.saveMemory();
  await agent.runAgentLoop();

  // Extras: show drafts
  const extras = drafts ? `## 📝 مسودات المحتوى التسويقي — ${today()}

> ⚠️ **تذكير CLAUDE.md §4:** هذه المسودات لا تُنشر تلقائياً — يجب المراجعة والموافقة اليدوية أولاً (APPROVAL.NOTIFY)

---

### 1. LinkedIn Post

**العربية:**
${drafts.linkedin?.ar || 'غير متوفر'}

**English:**
${drafts.linkedin?.en || 'Not available'}

**Hashtags:** ${(drafts.linkedin?.hashtags || []).join(' ')}
**CTA:** ${drafts.linkedin?.cta || '—'}

---

### 2. Twitter/X Thread

${(drafts.twitter?.thread || []).map((t, i) => `**${i + 1}/5:** ${t}`).join('\n\n')}

**Hashtags:** ${(drafts.twitter?.hashtags || []).join(' ')}

---

### 3. Product Hunt

**Tagline:** "${drafts.producthunt?.tagline || '—'}"

**Description:** ${drafts.producthunt?.description || '—'}

**Topics:** ${(drafts.producthunt?.topics || []).join(', ')}

---

> 💾 الملف الكامل: \`.agent-memory/marketing-drafts.json\`` : '## لا مسودات — راجع الأخطاء أعلاه';

  const report = await agent.buildReport(extras);
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[marketing-growth] خطأ: ${e.message}\n`));
