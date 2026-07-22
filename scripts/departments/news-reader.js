#!/usr/bin/env node
'use strict';
/**
 * News Department v3.0 — DeptAgent
 * Sources: IFRS/IASB · Anthropic · GitHub Security · Kuwait Finance
 * Agent uses web_search to find Kuwait regulatory updates
 */
const https    = require('https');
const { DeptAgent } = require('./_agent');

// ── RSS Fetcher ───────────────────────────────────────────────────────────────
function getRaw(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Boubyan-Agent/3.0' },
      timeout: 10000,
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ ok: res.statusCode < 400, body: buf }));
    });
    req.on('error', () => resolve({ ok: false, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '' }); });
  });
}

async function fetchRSS(url, label) {
  try {
    const { ok, body } = await getRaw(url);
    if (!ok || !body) return { label, items: [], failed: true };
    const items = [];
    const re    = /<item[\s\S]*?<\/item>/g;
    let match;
    while ((match = re.exec(body)) !== null && items.length < 5) {
      const it    = match[0];
      const title = (it.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                     it.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() || '—';
      const link  = (it.match(/<link>([\s\S]*?)<\/link>/) ||
                     it.match(/<link\s+href="([^"]+)"/))?.[1]?.trim() || '';
      const date  = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/))?.[1]?.slice(0, 16) || '';
      const clean = title.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      items.push({ title: clean, link: link.replace(/<[^>]+>/g,'').trim(), date });
    }
    return { label, items, failed: false };
  } catch {
    return { label, items: [], failed: true };
  }
}

const FEEDS = [
  { url: 'https://www.ifrs.org/news-and-events/news/rss/',      label: 'IFRS / IASB' },
  { url: 'https://www.anthropic.com/rss.xml',                   label: 'Anthropic AI' },
  { url: 'https://github.blog/category/security/feed/',         label: 'GitHub Security' },
  { url: 'https://feeds.feedburner.com/TheHackersNews',         label: 'Cyber Security' },
];

const KUWAIT_LINKS = [
  { title: 'وزارة العدل — الجريدة الرسمية', url: 'https://www.moj.gov.kw' },
  { title: 'وزارة المالية الكويتية',          url: 'https://www.mof.gov.kw' },
  { title: 'بنك الكويت المركزي (CBK)',        url: 'https://www.cbk.gov.kw' },
  { title: 'مؤسسة التأمينات (PIFSS)',         url: 'https://www.pifss.gov.kw' },
  { title: 'وزارة الشؤون والعمل',             url: 'https://www.mosal.gov.kw' },
];

async function main() {
  const agent = new DeptAgent({
    name:      'news-reader',
    nameAr:    '📰 قسم متابعة الأخبار والتشريعات',
    mission:   'مراقبة تحديثات IFRS والأمن السيبراني والقوانين الكويتية المالية',
    standards: ['IFRS/IASB', 'CBK Regulations', 'Kuwait MOJ', 'MOSAL'],
  });

  agent.loadMemory();

  // ── Fetch all RSS feeds in parallel ──────────────────────────────────────────
  const results = await Promise.all(FEEDS.map(f => fetchRSS(f.url, f.label)));

  let failedCount = 0;
  const newsContent = [];

  for (const { label, items, failed } of results) {
    if (failed || items.length === 0) {
      failedCount++;
      agent.finding('low', 'connectivity',
        `فشل تحميل: ${label}`,
        'تعذّر الوصول للمصدر — شبكة أو تغيير URL',
        'تحقق من الاتصال بالإنترنت أو راجع رابط RSS');
    } else {
      agent.ok('connectivity', `${label} — ${items.length} خبر`);
      const rows = items.map(i =>
        `- [${i.title}](${i.link})${i.date ? ` *(${i.date})*` : ''}`
      ).join('\n');
      newsContent.push(`### 📡 ${label}\n${rows}`);
    }
  }

  agent.metric('مصادر RSS', FEEDS.length, 'مصدر', FEEDS.length);
  agent.metric('مصادر نشطة', FEEDS.length - failedCount, 'مصدر');
  agent.metric('أخبار مُسترجعة', results.reduce((s, r) => s + r.items.length, 0), 'خبر');

  // ── Extras: actual news content ───────────────────────────────────────────────
  const extras = [
    '## 🌍 أخبار المصادر الدولية',
    newsContent.length
      ? newsContent.join('\n\n')
      : '> ⚠️ لم يُسترجع أي خبر هذا الأسبوع',
    '',
    '## 🇰🇼 مصادر الأخبار الكويتية (مراجعة يدوية)',
    '> يُرجى مراجعة هذه المصادر يدوياً للاطلاع على أي تحديثات قانونية:',
    KUWAIT_LINKS.map(l => `- [ ] [${l.title}](${l.url})`).join('\n'),
    '',
    '## ✅ قائمة المتابعة الأسبوعية',
    '- [ ] قراءة تحديثات IFRS/IASB أعلاه',
    '- [ ] التحقق من أي ثغرات أمنية جديدة في GitHub Security',
    '- [ ] مراجعة الجريدة الرسمية الكويتية',
    '- [ ] متابعة نشرات بنك الكويت المركزي (CBK)',
  ].join('\n');

  agent.saveMemory();
  await agent.runAgentLoop();

  const report = await agent.buildReport(extras);
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[news-reader] خطأ: ${e.message}\n`));
