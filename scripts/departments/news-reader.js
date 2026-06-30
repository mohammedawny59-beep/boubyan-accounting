#!/usr/bin/env node
'use strict';
// News Department — weekly news reader
// Sources: IFRS/IASB, Anthropic, npm security, Kuwait finance

const { today } = require('./_common');

async function fetchRSS(url, label) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Boubyan-Accounting-Bot/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const xml  = await res.text();
    const items = [];
    const itemRe = /<item[\s\S]*?<\/item>/g;
    let match;
    while ((match = itemRe.exec(xml)) !== null && items.length < 5) {
      const item  = match[0];
      const title = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                     item.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() || '—';
      const link  = (item.match(/<link>([\s\S]*?)<\/link>/) ||
                     item.match(/<link\s+href="([^"]+)"/))?.[1]?.trim() || '';
      const date  = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/))?.[1]?.trim() || '';
      const cleanTitle = title.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      const cleanLink  = link.replace(/<[^>]+>/g,'').trim();
      items.push({ title: cleanTitle, link: cleanLink, date, source: label });
    }
    return items;
  } catch { return []; }
}

const FEEDS = [
  { url: 'https://www.ifrs.org/news-and-events/news/rss/',          label: 'IFRS / IASB' },
  { url: 'https://www.anthropic.com/rss.xml',                       label: 'Anthropic AI' },
  { url: 'https://github.blog/category/security/feed/',             label: 'GitHub Security' },
  { url: 'https://feeds.feedburner.com/TheHackersNews',             label: 'Cyber Security' },
];

const KUWAIT_LINKS = [
  { title: 'الجريدة الرسمية — القوانين الجديدة',       url: 'https://www.moj.gov.kw' },
  { title: 'وزارة المالية الكويتية',                    url: 'https://www.mof.gov.kw' },
  { title: 'بنك الكويت المركزي (CBK)',                  url: 'https://www.cbk.gov.kw' },
  { title: 'مؤسسة التأمينات الاجتماعية (PIFSS)',        url: 'https://www.pifss.gov.kw' },
  { title: 'وزارة الشؤون الاجتماعية والعمل',            url: 'https://www.mosal.gov.kw' },
];

async function main() {
  const allItems = (await Promise.all(FEEDS.map(f => fetchRSS(f.url, f.label)))).flat();

  const grouped = {};
  allItems.forEach(item => {
    if (!grouped[item.source]) grouped[item.source] = [];
    grouped[item.source].push(item);
  });

  const sections = Object.entries(grouped).map(([source, items]) => {
    const rows = items.map(i => `- [${i.title}](${i.link})${i.date ? ` *(${i.date.slice(0,16)})*` : ''}`).join('\n');
    return `### 📡 ${source}\n${rows}`;
  });

  const lines = [
    `# 📰 News Department — أخبار الأسبوع`,
    `**التاريخ:** ${today()}`,
    '',
    '> هذا التقرير يجمع آخر الأخبار من مصادر موثوقة تتعلق بالمحاسبة والقوانين الكويتية والذكاء الاصطناعي.',
    '',
    '## 🌍 أخبار المصادر الدولية',
    sections.length ? sections.join('\n\n') : '> ⚠️ لم يتم استرجاع أخبار هذا الأسبوع (تحقق من الاتصال بالإنترنت)',
    '',
    '## 🇰🇼 مصادر الأخبار الكويتية (مراجعة يدوية)',
    '> يُرجى مراجعة هذه المصادر يدوياً للاطلاع على أي تحديثات قانونية:',
    KUWAIT_LINKS.map(l => `- [ ] [${l.title}](${l.url})`).join('\n'),
    '',
    '## ✅ قائمة المتابعة الأسبوعية',
    '- [ ] قراءة تحديثات IFRS/IASB أعلاه',
    '- [ ] التحقق من أي ثغرات أمنية جديدة في GitHub Security',
    '- [ ] مراجعة الجريدة الرسمية الكويتية للقوانين الجديدة',
    '- [ ] متابعة نشرات بنك الكويت المركزي',
    '',
    '---',
    '_تقرير آلي من قسم News — بوبيان للمحاسبة_',
  ].join('\n');

  process.stdout.write(lines + '\n');
}

main().catch(e => {
  process.stdout.write(`# 📰 News Department\n\n> ❌ خطأ: ${e.message}\n`);
});
