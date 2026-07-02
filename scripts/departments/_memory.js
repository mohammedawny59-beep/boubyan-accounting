'use strict';
/**
 * Agent Memory System
 * يحفظ تقارير كل قسم ويقارن الأسبوع بالماضي ويكتشف الاتجاهات
 */
const fs   = require('fs');
const path = require('path');

const MEMORY_DIR   = path.join(__dirname, '../../.agent-memory');
const STATE_FILE   = path.join(MEMORY_DIR, 'company-state.json');
const HISTORY_KEEP = 12; // أحدث 12 تقرير لكل قسم

function ensureDir() {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// ── Save department snapshot after each run ──────────────────────────────────
function saveSnapshot(deptName, { score, findings, metrics }) {
  ensureDir();
  const histFile = path.join(MEMORY_DIR, `${deptName}-history.json`);
  let history = [];
  if (fs.existsSync(histFile)) {
    try { history = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch { history = []; }
  }

  const snapshot = {
    date:     new Date().toISOString().slice(0, 10),
    score,
    critical: findings.filter(f => f.severity === 'critical').length,
    high:     findings.filter(f => f.severity === 'high').length,
    medium:   findings.filter(f => f.severity === 'medium').length,
    findings: findings.map(f => ({ severity: f.severity, title: f.title, category: f.category })),
    metrics,
  };

  history.unshift(snapshot);
  if (history.length > HISTORY_KEEP) history = history.slice(0, HISTORY_KEEP);
  fs.writeFileSync(histFile, JSON.stringify(history, null, 2), 'utf8');

  // Update company-wide state
  updateCompanyState(deptName, { score, critical: snapshot.critical, date: snapshot.date });

  return snapshot;
}

// ── Load history for a department ────────────────────────────────────────────
function loadHistory(deptName) {
  ensureDir();
  const histFile = path.join(MEMORY_DIR, `${deptName}-history.json`);
  if (!fs.existsSync(histFile)) return [];
  try { return JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch { return []; }
}

// ── Compare current run to previous ─────────────────────────────────────────
function compareWithPrevious(deptName, currentScore, currentFindings) {
  const history = loadHistory(deptName);
  if (history.length === 0) return { trend: 'new', message: 'أول تشغيل — لا يوجد تاريخ للمقارنة', repeats: [], newIssues: [], resolved: [], weeksTracked: 0 };

  const prev = history[0]; // Most recent saved (before this run)
  const diff  = currentScore - prev.score;
  const prevTitles = new Set(prev.findings.map(f => f.title));
  const repeats    = currentFindings.filter(f => prevTitles.has(f.title) && f.severity !== 'info');
  const newIssues  = currentFindings.filter(f => !prevTitles.has(f.title) && f.severity !== 'info');
  const resolved   = prev.findings.filter(f => !currentFindings.find(c => c.title === f.title));

  let trend = 'stable';
  if (diff > 5)  trend = 'improving';
  if (diff < -5) trend = 'degrading';

  const trendAr = { improving: '📈 تحسّن', stable: '➡️ مستقر', degrading: '📉 تراجع' };

  return {
    trend,
    trendAr:    trendAr[trend],
    scoreDiff:  diff,
    prevScore:  prev.score,
    repeats:    repeats.map(f => f.title),
    newIssues:  newIssues.map(f => f.title),
    resolved:   resolved.map(f => f.title),
    weeksTracked: history.length,
    message: `${trendAr[trend]} | كان ${prev.score}/100 → الآن ${currentScore}/100 (${diff > 0 ? '+' : ''}${diff})`
             + (repeats.length  ? ` | ${repeats.length} مشكلة متكررة` : '')
             + (newIssues.length ? ` | ${newIssues.length} مشكلة جديدة` : '')
             + (resolved.length  ? ` | ✅ ${resolved.length} تم حلها`  : ''),
  };
}

// ── Company-wide state (for inter-dept communication) ────────────────────────
function updateCompanyState(deptName, { score, critical, date }) {
  let state = {};
  if (fs.existsSync(STATE_FILE)) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  }
  state[deptName] = { score, critical, date, status: critical > 0 ? 'alert' : score >= 75 ? 'healthy' : 'warning' };
  state._updated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function readCompanyState() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

// ── Trend summary across last N runs ────────────────────────────────────────
function getTrendSummary(deptName) {
  const history = loadHistory(deptName);
  if (history.length < 2) return null;
  const scores  = history.map(h => h.score);
  const avg     = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const best    = Math.max(...scores);
  const worst   = Math.min(...scores);
  const trend   = scores[0] > scores[scores.length - 1] ? 'محسّن' : scores[0] < scores[scores.length - 1] ? 'متراجع' : 'مستقر';
  return { avg, best, worst, trend, runsCount: history.length };
}

module.exports = { saveSnapshot, loadHistory, compareWithPrevious, readCompanyState, updateCompanyState, getTrendSummary };
