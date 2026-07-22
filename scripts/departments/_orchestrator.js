'use strict';
/**
 * المدير الذكي — Chief AI Orchestrator
 *
 * يحل 7 مشاكل من مراجعة المعمارية دفعة واحدة:
 *  #1 Orchestrator    — يشغّل الوكلاء ويجمع نتائجهم
 *  #2 Shared results  — كل النتائج في مكان واحد
 *  #8 Priority        — يرتّب حسب الخطورة
 *  #9 Duplicate merge — يدمج المشكلة المكررة ويذكر كل من اكتشفها
 *  #11 Health Score   — درجة صحة عامة + حسب المجال
 *  #12 Trend          — يقارن بآخر تشغيل
 *  #13 Agent KPIs     — عدّاد لكل وكيل
 */
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AGENTS, DOMAIN_AR } = require('./_registry');

const ROOT     = path.join(__dirname, '..', '..');
const HIST_FILE = path.join(ROOT, '.agent-memory', 'orchestrator-history.json');

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
const SEV_AR    = { critical: 'حرجة', high: 'عالية', medium: 'متوسطة', low: 'بسيطة' };
const SEV_EMOJI = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
const SEV_PENALTY = { critical: 25, high: 12, medium: 6, low: 2 };

// ── تشغيل وكيل واحد (spawn) وإرجاع تقريره ─────────────────────────────────────
function runAgentScript(scriptRel, onLog) {
  return new Promise((resolve) => {
    const proc = spawn('node', [scriptRel], { cwd: ROOT, env: { ...process.env } });
    let report = '';
    proc.stdout.on('data', c => { report += c.toString(); });
    proc.stderr.on('data', c => {
      c.toString().split('\n').filter(l => l.trim()).forEach(l => onLog && onLog(l));
    });
    proc.on('close', code => resolve({ report, code }));
    proc.on('error', () => resolve({ report: '', code: 1 }));
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ report, code: 124 }); }, 120000);
  });
}

// ── استخراج الدرجة والمشاكل + الأدلّة من تقرير Markdown (#4 Evidence) ──────────
function parseReport(md, agentId) {
  const scoreMatch = md.match(/(\d+)\s*\/\s*100/);
  const score = scoreMatch ? parseInt(scoreMatch[1]) : null;

  const findings = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!(line.startsWith('- ') || line.startsWith('• '))) continue;
    let text = line.replace(/^[-•]\s*/, '').replace(/\*\*/g, '').trim();
    if (!text || text.length < 6) continue;
    if (text.startsWith('💡')) continue; // سطر الحل التابع

    let sev = null;
    if (/🔴|\[حرجة\]|\bcritical\b/i.test(text)) sev = 'critical';
    else if (/🟠|\[عالية\]|\bhigh\b/i.test(text)) sev = 'high';
    else if (/🟡|\[متوسطة\]|\bmedium\b/i.test(text)) sev = 'medium';
    else if (/🔵|\[بسيطة\]|\blow\b/i.test(text)) sev = 'low';
    if (!sev) continue;

    // الدليل: المجال بين قوسين (area) + الحل من السطر التالي إن وُجد
    const areaMatch = text.match(/\(([^)]{2,40})\)/);
    const area = areaMatch ? areaMatch[1].trim() : null;
    let fix = null;
    const next = (lines[i + 1] || '').trim();
    const fixMatch = next.match(/💡\s*(?:الحل:)?\s*(.+)/);
    if (fixMatch) fix = fixMatch[1].trim();

    const clean = text
      .replace(/[🔴🟠🟡🔵🟢✅⚠️❌]/g, '')
      .replace(/\[(حرجة|عالية|متوسطة|بسيطة|critical|high|medium|low)\]/gi, '')
      .trim()
      .replace(/^\([^)]*\)\s*/, '')
      .trim();
    if (clean.length < 6) continue;
    findings.push({ severity: sev, text: clean, agentId, evidence: { area, fix, agent: agentId } });
  }
  return { score, findings };
}

// ── #3 محرك الثقة (Confidence) ───────────────────────────────────────────────
// يعتمد على: عدد الوكلاء المكتشفين + تطابق تخصص الوكيل مع نوع المشكلة + وجود دليل
function computeConfidence(finding) {
  let c = 55;
  c += Math.min(30, (finding.detectedBy.length - 1) * 15); // كل مكتشف إضافي +15
  // تطابق التخصص: أمن يكتشف مشكلة أمنية، محاسبة تكتشف مشكلة محاسبية...
  const domainMatch = finding.detectedBy.some(id => {
    const dom = AGENTS[id]?.domain;
    return (dom === 'security' && /أمن|كلمة سر|ثغرة|اختراق/.test(finding.text))
        || (dom === 'accounting' && /قيد|حساب|ميزان|مدين|دائن|محاسب/.test(finding.text))
        || (dom === 'design' && /تصميم|واجهة|label|aria|لون|زر/.test(finding.text));
  });
  if (domainMatch) c += 12;
  if (finding.evidence && (finding.evidence.area || finding.evidence.fix)) c += 8; // وجود دليل
  return Math.max(40, Math.min(99, c));
}

// ── #10 محرك القرار (Decision Engine) ────────────────────────────────────────
// يقرر الإجراء بناءً على: الثقة + الخطورة + نوع المشكلة (تصميم/محاسبة/خلفي)
function decide(finding) {
  const isDesign = finding.detectedBy.some(id => AGENTS[id]?.domain === 'design')
    || /تصميم|واجهة|label|aria|لون|زر|contrast|تباين/i.test(finding.text);
  const isAccounting = /قيد|حساب|ميزان|مدين|دائن|محاسب|تأمين|عمولة/.test(finding.text);

  // محاسبة أو خطورة حرجة → مراجعة بشرية إلزامية (لا مساس بالمنطق المالي تلقائياً)
  if (isAccounting || finding.severity === 'critical') return { action: 'human', ar: 'مراجعة بشرية', reason: isAccounting ? 'يمسّ المحاسبة' : 'خطورة حرجة' };
  // تصميم بثقة عالية → إصلاح تلقائي مسموح
  if (isDesign && finding.confidence >= 80) return { action: 'auto', ar: 'إصلاح تلقائي', reason: 'تصميم موثوق' };
  // ثقة منخفضة → مراجعة
  if (finding.confidence < 65) return { action: 'human', ar: 'مراجعة بشرية', reason: 'ثقة منخفضة' };
  // الباقي → إشعار المطور
  return { action: 'notify', ar: 'إشعار المطوّر', reason: 'يحتاج مطوّراً' };
}

// ── دمج المكرر (#9): توقيع مبسّط للنص ─────────────────────────────────────────
function signature(text) {
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ').slice(0, 8).join(' '); // أول 8 كلمات كبصمة
}

function mergeFindings(allFindings) {
  const map = new Map();
  for (const f of allFindings) {
    const sig = signature(f.text);
    if (map.has(sig)) {
      const ex = map.get(sig);
      if (!ex.detectedBy.includes(f.agentId)) ex.detectedBy.push(f.agentId);
      if (SEV_ORDER.indexOf(f.severity) < SEV_ORDER.indexOf(ex.severity)) ex.severity = f.severity;
      // ادمج الأدلّة (خذ أول حل متاح)
      if (!ex.evidence.fix && f.evidence?.fix) ex.evidence.fix = f.evidence.fix;
      if (!ex.evidence.area && f.evidence?.area) ex.evidence.area = f.evidence.area;
    } else {
      map.set(sig, { severity: f.severity, text: f.text, detectedBy: [f.agentId], evidence: { ...(f.evidence || {}) } });
    }
  }
  const merged = [...map.values()];
  // #3 الثقة + #10 القرار لكل مشكلة
  for (const m of merged) {
    m.confidence = computeConfidence(m);
    m.decision   = decide(m);
  }
  // ترتيب: الخطورة أولاً ثم الثقة الأعلى (#8 Priority)
  return merged.sort((a, b) =>
    SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || b.confidence - a.confidence);
}

// ── درجة الصحة (#11) ──────────────────────────────────────────────────────────
function computeHealth(perAgent) {
  const scored = Object.values(perAgent).filter(a => a.score !== null && a.score !== undefined);
  const overall = scored.length ? Math.round(scored.reduce((s, a) => s + a.score, 0) / scored.length) : null;

  const byDomain = {};
  for (const [id, a] of Object.entries(perAgent)) {
    if (a.score === null || a.score === undefined) continue;
    const dom = AGENTS[id]?.domain || 'operations';
    (byDomain[dom] = byDomain[dom] || []).push(a.score);
  }
  const domainScores = {};
  for (const [dom, arr] of Object.entries(byDomain)) {
    domainScores[dom] = Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
  }
  return { overall, domainScores };
}

// ── الاتجاه (#12) ─────────────────────────────────────────────────────────────
function trend(currentIssues) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
  try {
    fs.mkdirSync(path.dirname(HIST_FILE), { recursive: true });
    fs.writeFileSync(HIST_FILE, JSON.stringify({ at: new Date().toISOString(), issues: currentIssues }, null, 2), 'utf8');
  } catch {}
  if (!prev || typeof prev.issues !== 'number') return null;
  return { was: prev.issues, now: currentIssues, delta: currentIssues - prev.issues, at: prev.at };
}

// ── التنسيق النهائي ───────────────────────────────────────────────────────────
function buildUnifiedReport({ health, merged, perAgent, tr }) {
  const L = [];
  const bar = (n) => '█'.repeat(Math.round((n || 0) / 10)) + '░'.repeat(10 - Math.round((n || 0) / 10));
  L.push('# 🧠 تقرير المدير الذكي — نظرة شاملة على النظام');
  L.push(`**التاريخ:** ${new Date().toISOString().slice(0, 10)} | **درجة صحة النظام:** ${health.overall ?? '—'}/100`);
  L.push('');

  if (health.overall !== null) {
    const emoji = health.overall >= 80 ? '🟢' : health.overall >= 60 ? '🟡' : '🔴';
    L.push(`## ${emoji} صحة النظام: ${health.overall}/100`);
    L.push('');
    L.push('| المجال | الدرجة | |');
    L.push('|--------|--------|--|');
    for (const [dom, sc] of Object.entries(health.domainScores).sort((a, b) => a[1] - b[1])) {
      L.push(`| ${DOMAIN_AR[dom] || dom} | ${sc}/100 | \`${bar(sc)}\` |`);
    }
    L.push('');
  }

  if (tr) {
    const arrow = tr.delta < 0 ? '📉 تحسّن' : tr.delta > 0 ? '📈 تراجع' : '➡️ ثابت';
    L.push(`## 🔄 الاتجاه منذ آخر فحص`);
    L.push(`- ${arrow}: كانت ${tr.was} مشكلة → الآن ${merged.length} (${tr.delta >= 0 ? '+' : ''}${tr.delta})`);
    L.push('');
  }

  const crit = merged.filter(m => m.severity === 'critical').length;
  const high = merged.filter(m => m.severity === 'high').length;
  L.push(`## 🚩 المشاكل المجمّعة (${merged.length}) — بعد حذف المكرر`);
  L.push(`> 🔴 حرجة: ${crit} · 🟠 عالية: ${high} · الإجمالي: ${merged.length}`);
  L.push('');
  if (!merged.length) {
    L.push('✅ لا مشاكل — كل الوكلاء أعطوا نتائج سليمة.');
  } else {
    const decEmoji = { auto: '🟢', notify: '🟡', human: '🔴' };
    for (const m of merged.slice(0, 40)) {
      const who = m.detectedBy.map(id => AGENTS[id]?.nameAr || id).join('، ');
      L.push(`- ${SEV_EMOJI[m.severity]} **[${SEV_AR[m.severity]}]** ${m.text}`);
      // سطر الدليل والثقة والقرار (#3 #4 #10)
      const bits = [`🎯 ثقة ${m.confidence}%`, `${decEmoji[m.decision.action]} ${m.decision.ar}`];
      if (m.evidence.area) bits.push(`📍 ${m.evidence.area}`);
      bits.push(m.detectedBy.length > 1 ? `👥 اكتشفها ${m.detectedBy.length} (${who})` : `👤 ${who}`);
      L.push(`  - ${bits.join(' · ')}`);
      if (m.evidence.fix) L.push(`  - 💡 الحل: ${m.evidence.fix}`);
    }
    if (merged.length > 40) L.push(`- … و${merged.length - 40} مشكلة أخرى`);
  }
  L.push('');

  // KPIs لكل وكيل (#13)
  L.push('## 📊 أداء الوكلاء');
  L.push('| الوكيل | الدرجة | مشاكل | الحالة |');
  L.push('|--------|--------|-------|--------|');
  for (const [id, a] of Object.entries(perAgent)) {
    const nm = AGENTS[id]?.nameAr || id;
    const st = a.code === 0 ? '✅' : '⚠️';
    L.push(`| ${AGENTS[id]?.icon || ''} ${nm} | ${a.score ?? '—'} | ${a.findingsCount} | ${st} |`);
  }
  L.push('');
  L.push('---');
  L.push('_المدير الذكي — يجمع نتائج كل الوكلاء، يحذف المكرر، ويعطي صورة واحدة._');
  return L.join('\n');
}

/**
 * يشغّل مجموعة وكلاء ويجمع النتائج.
 * @param {string[]} agentIds
 * @param {function} onLog  (agentId, line) => void
 * @param {function} onAgentDone (agentId, {score,findingsCount,code}) => void
 * @returns {Promise<{report, health, merged, perAgent}>}
 */
async function orchestrate(agentIds, onLog, onAgentDone) {
  const ids = (agentIds && agentIds.length) ? agentIds : Object.keys(AGENTS);
  const perAgent = {};
  const allFindings = [];

  for (const id of ids) {
    const meta = AGENTS[id];
    if (!meta) continue;
    onLog && onLog('chief', `▶ أشغّل ${meta.nameAr}...`);
    const { report, code } = await runAgentScript(meta.script, (l) => onLog && onLog(id, l));
    const { score, findings } = parseReport(report, id);
    perAgent[id] = { score, findingsCount: findings.length, code, report };
    allFindings.push(...findings);
    onAgentDone && onAgentDone(id, { score, findingsCount: findings.length, code });
    onLog && onLog('chief', `✅ ${meta.nameAr}: الدرجة ${score ?? '—'} — ${findings.length} مشكلة`);
  }

  const merged = mergeFindings(allFindings);
  const health = computeHealth(perAgent);
  const tr = trend(merged.length);
  const report = buildUnifiedReport({ health, merged, perAgent, tr });
  return { report, health, merged, perAgent };
}

module.exports = { orchestrate, parseReport, mergeFindings, computeHealth };
