#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readFile(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; }
}

function countLines(src) { return src ? src.split('\n').length : 0; }

function countPattern(src, re) { return (src.match(re) || []).length; }

const serverSrc  = readFile('server.js');
const indexSrc   = readFile('public/index.html');
const dbSrc      = readFile('lib/database.js');
const aiSrc      = readFile('lib/ai.js');

const rawFetchCount = countPattern(serverSrc, /api\.anthropic\.com\/v1\/messages/g);
const todoCount     = countPattern(serverSrc + indexSrc, /\/\/\s*TODO|\/\/\s*FIXME|\/\/\s*HACK/gi);
const consoleLogs   = countPattern(serverSrc, /console\.log\(/g);
const testFiles     = fs.existsSync(path.join(ROOT, 'tests'))
  ? fs.readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.test.js'))
  : [];

const pkg = JSON.parse(readFile('package.json') || '{}');
const deps    = Object.keys(pkg.dependencies    || {});
const devDeps = Object.keys(pkg.devDependencies || {});

const now = new Date().toISOString().slice(0, 10);

const lines = [
  `# تقرير الصيانة الأسبوعي — ${now}`,
  '',
  '## حجم الكود',
  `| الملف | الأسطر |`,
  `|-------|--------|`,
  `| server.js | ${countLines(serverSrc).toLocaleString()} |`,
  `| public/index.html | ${countLines(indexSrc).toLocaleString()} |`,
  `| lib/database.js | ${countLines(dbSrc).toLocaleString()} |`,
  `| lib/ai.js | ${countLines(aiSrc).toLocaleString()} |`,
  '',
  '## جودة الكود',
  `- Raw Anthropic fetch calls (يجب أن تكون 1 للـ streaming فقط): **${rawFetchCount}** ${rawFetchCount <= 1 ? '✅' : '❌'}`,
  `- TODO/FIXME/HACK comments: **${todoCount}**`,
  `- console.log() calls في server.js: **${consoleLogs}**`,
  '',
  '## الاختبارات',
  `- ملفات الاختبار: **${testFiles.length}**`,
  testFiles.map(f => `  - ${f}`).join('\n'),
  '',
  '## المكتبات',
  `- Dependencies: **${deps.length}**`,
  `- DevDependencies: **${devDeps.length}**`,
  '',
  '## الملفات المطلوب مراجعتها يدوياً',
  '',
  rawFetchCount > 1
    ? `- ⚠️ يوجد ${rawFetchCount} raw fetch calls — الرجاء تحويلها إلى callAI() في lib/ai.js`
    : '',
  todoCount > 0
    ? `- 📝 يوجد ${todoCount} TODO/FIXME تحتاج مراجعة`
    : '',
  '',
  '---',
  `_تم إنشاء هذا التقرير تلقائياً بواسطة scripts/maintenance-report.js_`,
].join('\n');

process.stdout.write(lines + '\n');
