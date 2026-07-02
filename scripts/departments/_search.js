'use strict';
/**
 * Web Search module for department agents
 * Backends (by priority):
 *   1. Google Custom Search  (GOOGLE_SEARCH_API_KEY + GOOGLE_CSE_ID) — 100 free/day
 *   2. Brave Search API      (BRAVE_SEARCH_API_KEY)                  — 2000 free/month
 *   3. DuckDuckGo            (no key needed)                         — fallback
 */
const https = require('https');
const http  = require('http');

function get(url, headers = {}) {
  return new Promise((resolve) => {
    const lib    = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const opts   = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      headers:  { 'User-Agent': 'Boubyan-Agent/3.0', ...headers },
      timeout:  12000,
    };
    lib.get(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, data: JSON.parse(buf), status: res.statusCode }); }
        catch { resolve({ ok: false, data: buf, status: res.statusCode }); }
      });
    }).on('error', e => resolve({ ok: false, data: e.message, status: 0 }));
  });
}

// ── 1. Google Custom Search (100 free/day) ───────────────────────────────────
async function googleSearch(query, count = 5) {
  const key = process.env.GOOGLE_SEARCH_API_KEY;
  const cx  = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return null;

  const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=${Math.min(count, 10)}&hl=ar`;
  const res = await get(url);
  if (!res.ok || !res.data?.items) return null;

  return res.data.items.map(item => ({
    title:   item.title,
    url:     item.link,
    snippet: item.snippet || '',
  }));
}

// ── 2. Brave Search API (2000 free/month) ────────────────────────────────────
async function braveSearch(query, count = 5) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await get(url, { 'Accept': 'application/json', 'X-Subscription-Token': key });
  if (!res.ok || !res.data?.web?.results) return null;

  return res.data.web.results.map(r => ({
    title:   r.title,
    url:     r.url,
    snippet: r.description || '',
  }));
}

// ── 3. DuckDuckGo Instant Answer (no key) ────────────────────────────────────
async function duckSearch(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await get(url);
  if (!res.ok) return null;

  const d       = res.data;
  const results = [];
  if (d.AbstractText) results.push({ title: d.Heading || query, url: d.AbstractURL, snippet: d.AbstractText });
  for (const t of (d.RelatedTopics || []).slice(0, 4)) {
    if (t.Text && t.FirstURL) results.push({ title: t.Text.slice(0, 80), url: t.FirstURL, snippet: t.Text });
  }
  return results.length ? results : null;
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Search the web — tries backends: Google → Brave → DuckDuckGo
 * @param {string} query
 * @param {number} [count=5]
 * @returns {Promise<Array<{title,url,snippet}>>}
 */
async function search(query, count = 5) {
  const result =
    (await googleSearch(query, count)) ||
    (await braveSearch(query, count))  ||
    (await duckSearch(query));

  return result || [{ title: 'لا نتائج', url: '', snippet: 'لم تتوفر نتائج بحث' }];
}

/**
 * Fetch and extract plain text from a URL
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchPage(url) {
  const res = await get(url);
  if (!res.ok) return `فشل تحميل: ${url}`;
  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

module.exports = { search, fetchPage };
