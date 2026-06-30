'use strict';
/**
 * DeptAgent — Base AI Agent class for all Boubyan departments
 * Quality standard: EY · Microsoft · Apple · SpaceX
 */
const { callAI } = require('../../lib/ai.js');

class DeptAgent {
  constructor({ name, nameAr, mission, standards = [], version = '1.0' }) {
    this.name     = name;
    this.nameAr   = nameAr;
    this.mission  = mission;
    this.standards = standards;
    this.version  = version;
    this.findings = [];
    this.metrics  = {};
    this.timeline = [];
    this.startTime = Date.now();
  }

  // ── Findings ────────────────────────────────────────────────────────────────
  // severity: critical | high | medium | low | info
  finding(severity, category, title, detail, recommendation) {
    this.findings.push({ severity, category, title, detail, recommendation });
    this._log(`[${severity.toUpperCase()}] ${title}`);
    return this;
  }

  ok(category, title) {
    this.findings.push({ severity: 'info', category, title, detail: 'اجتاز الفحص', recommendation: '—' });
    return this;
  }

  // ── Metrics ─────────────────────────────────────────────────────────────────
  metric(label, value, unit = '', max = null) {
    const ok = max === null || (typeof value === 'number' ? value <= max : true);
    this.metrics[label] = { value, unit, ok };
    return this;
  }

  // ── Scoring ─────────────────────────────────────────────────────────────────
  calcScore() {
    const pen = { critical: 25, high: 12, medium: 6, low: 2, info: 0 };
    let score = 100;
    for (const f of this.findings) score -= (pen[f.severity] || 0);
    return Math.max(0, score);
  }

  _grade(score) {
    if (score >= 90) return { letter: 'A', ar: 'ممتاز',    badge: '🟢', bar: this._bar(score) };
    if (score >= 75) return { letter: 'B', ar: 'جيد جداً', badge: '🟡', bar: this._bar(score) };
    if (score >= 60) return { letter: 'C', ar: 'مقبول',    badge: '🟠', bar: this._bar(score) };
    if (score >= 40) return { letter: 'D', ar: 'ضعيف',     badge: '🔴', bar: this._bar(score) };
    return           { letter: 'F', ar: 'حرج',             badge: '⛔', bar: this._bar(score) };
  }

  _bar(score) {
    const filled = Math.round(score / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  }

  _log(msg) {
    process.stderr.write(`[${this.nameAr}] ${msg}\n`);
  }

  // ── AI Analysis via Claude ───────────────────────────────────────────────────
  async aiAnalysis() {
    if (!process.env.ANTHROPIC_API_KEY) return null;

    const score = this.calcScore();
    const criticals = this.findings.filter(f => f.severity === 'critical').map(f => f.title);
    const highs     = this.findings.filter(f => f.severity === 'high').map(f => f.title);

    const prompt = `أنت شريك أول في قسم الاستشارات التقنية بشركة EY (Ernst & Young) مع خبرة 25 عاماً.

تراجع تقرير القسم التالي لنظام محاسبة عيادة أسنان في الكويت:

**القسم:** ${this.nameAr}
**المهمة:** ${this.mission}
**الدرجة:** ${score}/100
**المعايير المطبقة:** ${this.standards.join(', ')}
**مشاكل حرجة:** ${criticals.join(' | ') || 'لا يوجد'}
**مشاكل عالية:** ${highs.join(' | ') || 'لا يوجد'}
**إجمالي المشاكل:** ${this.findings.filter(f=>f.severity!=='info').length}

قدّم تحليلاً موجزاً باللغة العربية بهذا الشكل الدقيق:

**التقييم التنفيذي:**
[جملتان — الوضع الحالي وأثره على الأعمال]

**أولويات الإصلاح الثلاث:**
1. [الأهم — مع سبب تجاري واضح]
2. [الثاني]
3. [الثالث]

**التوصية الاستراتيجية:**
[جملة واحدة — توصية على مستوى الإدارة]

**الإطار الزمني المقترح:** [أسبوع / أسبوعان / شهر]

الرد مهني ومباشر كرسالة إدارة EY.`;

    try {
      this._log('🤖 جاري تحليل AI...');
      return await callAI({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }]
      });
    } catch (e) {
      this._log(`تحذير AI: ${e.message}`);
      return null;
    }
  }

  // ── Report Builder ───────────────────────────────────────────────────────────
  async buildReport(extras = '') {
    const score   = this.calcScore();
    const grade   = this._grade(score);
    const date    = new Date().toISOString().slice(0, 10);
    const runtime = ((Date.now() - this.startTime) / 1000).toFixed(1);

    const bySev = { critical: [], high: [], medium: [], low: [], info: [] };
    for (const f of this.findings) (bySev[f.severity] || bySev.info).push(f);

    const sevIcon = { critical:'🔴', high:'🟠', medium:'🟡', low:'🔵', info:'ℹ️' };
    const sevName = { critical:'حرج', high:'عالي', medium:'متوسط', low:'منخفض', info:'معلومة' };

    let md = '';

    // Header
    md += `# ${this.nameAr}\n`;
    md += `**التاريخ:** ${date} | **الإصدار:** v${this.version} | **المعايير:** ${this.standards.join(' · ')}\n\n`;
    md += `---\n\n`;

    // Scorecard
    md += `## 📊 بطاقة الأداء\n\n`;
    md += `\`\`\`\n`;
    md += `الدرجة الإجمالية:  ${score}/100  ${grade.bar}  ${grade.badge} ${grade.letter} — ${grade.ar}\n`;
    md += `المشاكل:           ${this.findings.filter(f=>f.severity!=='info').length} مشكلة`;
    md += ` (${bySev.critical.length} حرج · ${bySev.high.length} عالي · ${bySev.medium.length} متوسط · ${bySev.low.length} منخفض)\n`;
    md += `وقت الفحص:         ${runtime}s\n`;
    md += `\`\`\`\n\n`;

    // AI Analysis
    const ai = await this.aiAnalysis();
    if (ai) {
      md += `## 🤖 تحليل EY AI\n\n`;
      md += `> *تحليل آلي بمستوى شريك EY*\n\n`;
      md += `${ai}\n\n`;
    }

    // Metrics
    if (Object.keys(this.metrics).length > 0) {
      md += `## 📈 المقاييس\n\n`;
      md += `| المقياس | القيمة | الحالة |\n`;
      md += `|---------|--------|:------:|\n`;
      for (const [label, m] of Object.entries(this.metrics)) {
        const status = m.ok ? '✅' : '⚠️';
        md += `| ${label} | ${m.value}${m.unit ? ' ' + m.unit : ''} | ${status} |\n`;
      }
      md += `\n`;
    }

    // Findings by severity
    const activeSeverities = ['critical','high','medium','low'].filter(s => bySev[s].length > 0);
    if (activeSeverities.length > 0) {
      md += `## 🔍 المشاكل المكتشفة\n\n`;
      for (const sev of activeSeverities) {
        md += `### ${sevIcon[sev]} ${sevName[sev]} (${bySev[sev].length})\n\n`;
        for (const f of bySev[sev]) {
          md += `#### ${f.title}\n`;
          md += `- **الفئة:** \`${f.category}\`\n`;
          md += `- **التفاصيل:** ${f.detail}\n`;
          md += `- **التوصية:** ${f.recommendation}\n\n`;
        }
      }
    }

    // Passed checks
    const passed = bySev.info.filter(f => f.detail === 'اجتاز الفحص');
    if (passed.length > 0) {
      md += `## ✅ اجتاز الفحص (${passed.length})\n\n`;
      md += passed.map(f => `- ${f.title}`).join('\n');
      md += '\n\n';
    }

    if (extras) md += `---\n\n${extras}\n\n`;

    md += `---\n*تقرير آلي — ${this.nameAr} — بوبيان لطب الأسنان*`;
    return md;
  }
}

module.exports = { DeptAgent };
