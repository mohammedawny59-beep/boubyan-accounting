'use strict';
/**
 * Web Search module for department agents
 * Backends (by priority):
 *   1. Brave Search API  (BRAVE_SEARCH_API_KEY) — 2000 free/month
 *   2. SerpAPI           (SERPAPI_KEY)           — 100 free/month
 *   3. DuckDuckGo        (no key needed)         — limited, no JS
 */
const https = require('https');
const http  = require('http');

// ── Core fetch helper ─────────────────────────────────────────────────────────
function get(url, headers = {}) {
  return new Promise((resolve) => {
    const lib     = url.startsWith('https') ? https : http;
    const parsed  = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      headers:  { 'User-Agent': 'Boubyan-Agent/2.0', ...headers },
      timeout:  10000,
    };
    lib.get(options, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, data: JSON.parse(buf), status: res.statusCode }); }
        catch { resolve({ ok: false, data: buf, status: res.statusCode }); }
      });
    }).on('error', e => resolve({ ok: false, data: e.message, status: 0 }));
  });
}

// ── 1. Brave Search ───────────────────────────────────────────────────────────
async function braveSearch(query, count = 5) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&lang=ar&country=kw`;
  const res = await get(url, { 'Accept': 'application/json', 'X-Subscription-Token': key });
  if (!res.ok || !res.data?.web?.results) return null;
  return res.data.web.results.map(r => ({
    title:   r.title,
    url:     r.url,
    snippet: r.description || '',
  }));
}

// ── 2. SerpAPI ────────────────────────────────────────────────────────────────
async function serpSearch(query, count = 5) {
  const key = process.env.SERPAPI_KEY;
  if (!key) return null;
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=${count}&api_key=${key}`;
  const res = await get(url);
  if (!res.ok || !res.data?.organic_results) return null;
  return res.data.organic_results.slice(0, count).map(r => ({
    title:   r.title,
    url:     r.link,
    snippet: r.snippet || '',
  }));
}

// ── 3. DuckDuckGo Instant Answer (no key, limited) ───────────────────────────
async function duckSearch(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await get(url);
  if (!res.ok) return null;
  const d   = res.data;
  const results = [];
  if (d.AbstractText) results.push({ title: d.Heading || query, url: d.AbstractURL, snippet: d.AbstractText });
  if (d.RelatedTopics) {
    for (const t of (d.RelatedTopics || []).slice(0, 4)) {
      if (t.Text && t.FirstURL) results.push({ title: t.Text.slice(0,80), url: t.FirstURL, snippet: t.Text });
    }
  }
  return results.length ? results : null;
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Search the web — tries backends in order until one works.
 * @param {string} query
 * @param {number} [count=5]
 * @returns {Promise<Array<{title,url,snippet}>>}
 */
async function search(query, count = 5) {
  const result =
    (await braveSearch(query, count)) ||
    (await serpSearch(query, count))  ||
    (await duckSearch(query));
  return result || [{ title: 'لا نتائج', url: '', snippet: 'لم تتوفر نتائج — تحقق من BRAVE_SEARCH_API_KEY' }];
}

/**
 * Fetch and extract text from a URL (simple scrape, no JS)
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchPage(url) {
  const res = await get(url);
  if (!res.ok) return `فشل تحميل: ${url}`;
  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  // Strip HTML tags and collapse whitespace
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000); // First 3000 chars
}

module.exports = { search, fetchPage };
