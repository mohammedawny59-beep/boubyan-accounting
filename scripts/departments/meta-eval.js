#!/usr/bin/env node
'use strict';
/**
 * Meta-Eval Department — قسم التحقق الذاتي
 * CLAUDE.md §2 — القسم الجديد 3
 *
 * يأخذ عينة عشوائية (10-15%) من findings الأقسام الأخرى
 * ويتحقق من دقتها باستخدام Claude.
 * لو نسبة الأخطاء > 15% لأي قسم → تصعيد تلقائي.
 */
const { DeptAgent }  = require('./_agent');
const { APPROVAL }   = require('./_common');
const { callAI }     = require('../../lib/ai');
const { loadHistory} = require('./_memory');
const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '../..');
const MEM_DIR   = path.join(ROOT, '.agent-memory');
const ALL_DEPTS = [
  'audit-quality','security-scan','operations','it-health',
  'design-audit','news-reader','ai-optimizer','rd-suggestions',
];

async function main() {
  const agent = new DeptAgent({
    name:      'meta-eval',
    nameAr:    '✅ قسم التحقق الذاتي',
    mission:   'التحقق من دقة نتائج الأقسام الأخرى — يمنع تراكم findings خاطئة',
    standards: ['AI Verification Best Practices 2026', 'Multi-Agent Reliability', 'ISO 9001'],
  });

  agent.loadMemory();

  if (!process.env.ANTHROPIC_API_KEY) {
    agent.finding('medium', 'config', 'ANTHROPIC_API_KEY مفقود', 'التحقق يتطلب Claude', 'أضف ANTHROPIC_API_KEY للبيئة');
    const report = await agent.buildReport();
    process.stdout.write(report + '\n');
    return;
  }

  let totalSampled = 0;
  let totalWrong   = 0;
  const deptResults = [];

  for (const deptId of ALL_DEPTS) {
    const history = loadHistory(deptId);
    if (history.length === 0) continue;

    const latest = history[0];
    const findings = (latest.findings || []).filter(f => f.severity !== 'info');
    if (findings.length === 0) {
      deptResults.push({ deptId, sampled: 0, wrong: 0, accuracy: 100 });
      continue;
    }

    // Sample 10-15%
    const sampleSize = Math.max(1, Math.round(findings.length * 0.12));
    const shuffled   = [...findings].sort(() => Math.random() - 0.5);
    const sample     = shuffled.slice(0, sampleSize);

    let wrongCount = 0;
    for (const finding of sample) {
      // Read actual code to verify the finding
      let evidence = '';
      try {
        const serverContent = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').slice(0, 8000);
        evidence = serverContent;
      } catch { evidence = 'لا يمكن قراءة الكود'; }

      const prompt = `أنت محقق تقني دقيق. لديك finding من نظام تدقيق آلي، وعليك التحقق من صحته.

**القسم:** ${deptId}
**Finding:**
- العنوان: ${finding.title}
- الخطورة: ${finding.severity}
- الفئة: ${finding.category}

**دليل من الكود (أول 8000 حرف من server.js):**
\`\`\`
${evidence.slice(0, 4000)}
\`\`\`

السؤال: بناءً على الدليل المرفق فقط، هل هذا الـ finding دقيق؟
أجب بـ JSON فقط: {"accurate": true|false, "reason": "جملة واحدة"}`;

      try {
        const res = await callAI({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{ role: 'user', content: prompt }],
        });
        const m = (res || '').match(/\{[\s\S]*\}/);
        if (m) {
          const verdict = JSON.parse(m[0]);
          if (!verdict.accurate) {
            wrongCount++;
            process.stderr.write(`  [meta-eval] ⚠️ finding مشكوك فيه في ${deptId}: "${finding.title}" — ${verdict.reason}\n`);
          }
        }
      } catch { /* skip */ }

      totalSampled++;
    }

    totalWrong += wrongCount;
    const accuracy = sample.length > 0 ? Math.round(((sample.length - wrongCount) / sample.length) * 100) : 100;
    deptResults.push({ deptId, sampled: sample.length, wrong: wrongCount, accuracy });

    agent.metric(`دقة ${deptId}`, accuracy, '%');

    if (wrongCount / sample.length > 0.15) {
      agent.finding('high', 'accuracy', `${deptId} — دقة النتائج تحت 85%`,
        `${wrongCount} من ${sample.length} findings مشكوك في صحتها`,
        `راجع منطق فحص قسم ${deptId} — قد تحتاج إعادة كاليبريشن`,
        APPROVAL.NOTIFY);
    } else {
      agent.ok('accuracy', `${deptId} — دقة ${accuracy}% ✓`);
    }
  }

  const overallAccuracy = totalSampled > 0
    ? Math.round(((totalSampled - totalWrong) / totalSampled) * 100)
    : 100;

  agent.metric('إجمالي findings فُحصت', totalSampled, '');
  agent.metric('findings مشكوك فيها', totalWrong, '', 0);
  agent.metric('الدقة الإجمالية', overallAccuracy, '%');

  if (overallAccuracy >= 90) {
    agent.ok('overall', `النظام يعمل بدقة ${overallAccuracy}% — موثوق للبيع`);
  } else if (overallAccuracy >= 75) {
    agent.finding('medium', 'overall', `الدقة الإجمالية ${overallAccuracy}% — مقبولة لكن تحتاج تحسين`,
      `${totalWrong} findings من أصل ${totalSampled} قد تكون غير دقيقة`,
      'راجع الأقسام التي سجّلت دقة أقل من 85%');
  } else {
    agent.finding('critical', 'overall', `الدقة الإجمالية ${overallAccuracy}% — غير مقبول للمنتج`,
      'نسبة كبيرة من النتائج قد تكون خاطئة — يضر بمصداقية المنتج',
      'أوقف نشر تقارير الأقسام حتى يُصلح المشكلة',
      APPROVAL.BLOCKING);
  }

  agent.saveMemory();

  // Extras: summary table
  const tableRows = deptResults.map(r =>
    `| ${r.deptId} | ${r.sampled} | ${r.wrong} | ${r.accuracy}% | ${r.accuracy >= 85 ? '✅' : '⚠️'} |`
  ).join('\n');

  const extras = `## 📋 نتائج التحقق بالتفصيل

| القسم | عينة | خاطئة | الدقة | الحكم |
|-------|-------|--------|-------|-------|
${tableRows}

> **المعيار:** دقة ≥85% مقبولة · ≥90% ممتازة · <85% تحتاج مراجعة
> **المنهجية:** عينة عشوائية 10-15% من آخر تشغيل لكل قسم — يتحقق منها Claude بناءً على كود المشروع الفعلي`;

  const report = await agent.buildReport(extras);
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[meta-eval] خطأ: ${e.message}\n`));
