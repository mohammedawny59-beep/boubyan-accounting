#!/usr/bin/env node
'use strict';
// IT Department — weekly health check
// Checks: npm outdated, npm audit, missing files, code size warnings
// Output: Markdown report → GitHub Issue

const { execSync } = require('child_process');
const { readFile, fileExists, countLines, today } = require('./_common');

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); }
  catch (e) { return e.stdout || ''; }
}

// ── npm outdated ──────────────────────────────────────────────────────────────
let outdated = {};
try { outdated = JSON.parse(run('npm outdated --json') || '{}'); } catch {}

const outdatedRows = Object.entries(outdated).map(([pkg, info]) => {
  const severity = info.current !== info.latest ? '🔴' : '🟡';
  return `| ${severity} ${pkg} | ${info.current} | ${info.wanted} | ${info.latest} |`;
});

// ── npm audit ─────────────────────────────────────────────────────────────────
let audit = { metadata: { vulnerabilities: {} } };
try { audit = JSON.parse(run('npm audit --json') || '{}'); } catch {}
const vulns = audit.metadata?.vulnerabilities || {};
const totalVulns = (vulns.critical||0)+(vulns.high||0)+(vulns.moderate||0)+(vulns.low||0);

// ── File checks ───────────────────────────────────────────────────────────────
const checks = [
  ['.env.example',  fileExists('.env.example'),  '`.env.example` مفقود — المطورون الجدد لن يعرفوا المتغيرات المطلوبة'],
  ['.gitignore',    fileExists('.gitignore'),     '`.gitignore` مفقود — ملفات حساسة قد ترفع لـ GitHub'],
  ['lib/ai.js',     fileExists('lib/ai.js'),      'مكتبة AI مفقودة'],
  ['tests/',        fileExists('tests'),           'مجلد الاختبارات مفقود'],
];

// ── Code size ─────────────────────────────────────────────────────────────────
const serverLines = countLines(readFile('server.js'));
const indexLines  = countLines(readFile('public/index.html'));
const sizeWarn    = serverLines > 9000 || indexLines > 15000;

// ── Build report ──────────────────────────────────────────────────────────────
const lines = [
  `# 💻 IT Department — تقرير الصحة الأسبوعي`,
  `**التاريخ:** ${today()} | **الحالة:** ${totalVulns === 0 && !outdatedRows.length ? '✅ سليم' : '⚠️ يحتاج مراجعة'}`,
  '',
  '## 📦 تحديثات المكتبات',
  outdatedRows.length
    ? `| الحالة | المكتبة | الحالي | المطلوب | الأحدث |\n|--------|---------|--------|---------|--------|\n${outdatedRows.join('\n')}`
    : '✅ جميع المكتبات محدّثة',
  '',
  '## 🛡️ الثغرات الأمنية (npm audit)',
  `| Critical | High | Moderate | Low | الإجمالي |`,
  `|----------|------|----------|-----|---------|`,
  `| ${vulns.critical||0} | ${vulns.high||0} | ${vulns.moderate||0} | ${vulns.low||0} | ${totalVulns} |`,
  totalVulns > 0 ? '\n> ⚠️ شغّل `npm audit fix` لإصلاح الثغرات التلقائية' : '\n> ✅ لا ثغرات',
  '',
  '## 📁 فحص الملفات المطلوبة',
  checks.map(([name, ok, msg]) => `- ${ok ? '✅' : '❌'} \`${name}\`${ok ? '' : ` — ${msg}`}`).join('\n'),
  '',
  '## 📏 حجم الكود',
  `| الملف | الأسطر | الحالة |`,
  `|-------|--------|--------|`,
  `| server.js | ${serverLines.toLocaleString()} | ${serverLines > 9000 ? '⚠️ كبير جداً — يحتاج تقسيم' : '✅'} |`,
  `| public/index.html | ${indexLines.toLocaleString()} | ${indexLines > 15000 ? '⚠️ كبير جداً — يحتاج تقسيم' : '✅'} |`,
  '',
  '## 🎯 الإجراءات المطلوبة',
  outdatedRows.length ? `- [ ] مراجعة وتحديث ${outdatedRows.length} مكتبة` : '',
  totalVulns > 0 ? `- [ ] إصلاح ${totalVulns} ثغرة أمنية` : '',
  sizeWarn ? '- [ ] دراسة تقسيم الملفات الكبيرة' : '',
  !fileExists('.env.example') ? '- [ ] إنشاء `.env.example`' : '',
  '',
  '---',
  '_تقرير آلي من قسم IT — بوبيان للمحاسبة_',
].filter(l => l !== '').join('\n');

process.stdout.write(lines + '\n');
