#!/usr/bin/env node
'use strict';
// Security Department — weekly security scan
// Checks: hardcoded secrets, insecure patterns, auth gaps, JWT config

const { execSync } = require('child_process');
const { readFile, countPattern, today } = require('./_common');

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); }
  catch (e) { return e.stdout || ''; }
}

const server = readFile('server.js');
const index  = readFile('public/index.html');
const db     = readFile('lib/database.js');

// ── Pattern checks ────────────────────────────────────────────────────────────
const PATTERNS = [
  { name: 'كلمات مرور مكتوبة في الكود',       re: /password\s*[:=]\s*['"][^'"]{3,}/gi,             severity: 'CRITICAL' },
  { name: 'API keys مكتوبة مباشرة',            re: /api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_\-]{10,}/gi, severity: 'CRITICAL' },
  { name: 'JWT secrets مكتوبة',                re: /jwt[_-]?secret\s*[:=]\s*['"][^'"]{3,}/gi,        severity: 'HIGH'     },
  { name: 'eval() خطر التنفيذ',                re: /\beval\s*\(/g,                                    severity: 'HIGH'     },
  { name: 'SQL Injection احتمال',              re: /query\s*\+\s*(req\.|user\.)/gi,                   severity: 'MEDIUM'   },
  { name: 'HTTP بدل HTTPS في الـ URLs',        re: /http:\/\/(?!localhost|127)/gi,                    severity: 'MEDIUM'   },
  { name: 'console.log بيانات حساسة محتملة',  re: /console\.log\(.*?(pass|token|secret|key)/gi,      severity: 'LOW'      },
];

const findings = PATTERNS.map(p => {
  const count = countPattern(server + db, p.re);
  return { ...p, count };
}).filter(f => f.count > 0);

// ── npm audit critical/high only ──────────────────────────────────────────────
let criticalVulns = 0, highVulns = 0;
try {
  const a = JSON.parse(run('npm audit --json') || '{}');
  criticalVulns = a.metadata?.vulnerabilities?.critical || 0;
  highVulns     = a.metadata?.vulnerabilities?.high || 0;
} catch {}

// ── Auth checks ───────────────────────────────────────────────────────────────
const unprotectedPosts = (server.match(/app\.(post|put|delete)\s*\(['"]/g) || []).length;
const protectedPosts   = (server.match(/requireAuth/g) || []).length;
const rawFetch         = countPattern(server, /api\.anthropic\.com\/v1\/messages/g);

// ── .gitignore check ──────────────────────────────────────────────────────────
const gitignore = readFile('.gitignore');
const sensitiveFiles = ['.env', 'database.json', '*.key', 'config.json'];
const missingFromGitignore = sensitiveFiles.filter(f => !gitignore.includes(f.replace('*','').split('.')[0]));

// ── Risk score ────────────────────────────────────────────────────────────────
let score = 100;
findings.forEach(f => {
  if (f.severity === 'CRITICAL') score -= f.count * 20;
  if (f.severity === 'HIGH')     score -= f.count * 10;
  if (f.severity === 'MEDIUM')   score -= f.count * 5;
  if (f.severity === 'LOW')      score -= f.count * 1;
});
score -= criticalVulns * 20 + highVulns * 10;
score = Math.max(0, Math.min(100, score));

const scoreEmoji = score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴';

// ── Report ────────────────────────────────────────────────────────────────────
const lines = [
  `# 🔒 Security Department — تقرير الأمان الأسبوعي`,
  `**التاريخ:** ${today()} | **درجة الأمان:** ${scoreEmoji} ${score}/100`,
  '',
  '## 🚨 نتائج فحص الكود',
  findings.length === 0
    ? '✅ لم يتم اكتشاف أنماط خطرة في الكود'
    : `| الخطورة | المشكلة | العدد |\n|---------|---------|-------|\n${findings.map(f => `| ${f.severity === 'CRITICAL' ? '🔴 CRITICAL' : f.severity === 'HIGH' ? '🟠 HIGH' : f.severity === 'MEDIUM' ? '🟡 MEDIUM' : '🔵 LOW'} | ${f.name} | ${f.count} |`).join('\n')}`,
  '',
  '## 📦 ثغرات المكتبات',
  `- 🔴 Critical: **${criticalVulns}**`,
  `- 🟠 High: **${highVulns}**`,
  criticalVulns + highVulns > 0 ? '\n> ⚠️ شغّل `npm audit fix --force` أو حدّث المكتبات المتأثرة فوراً' : '\n> ✅ لا ثغرات عالية الخطورة',
  '',
  '## 🛡️ فحص المصادقة',
  `- Routes محمية بـ requireAuth: **${protectedPosts}**`,
  `- Raw Anthropic fetch (يجب أن تكون 1 للـ streaming): **${rawFetch}** ${rawFetch <= 1 ? '✅' : '❌'}`,
  '',
  '## 📂 .gitignore',
  missingFromGitignore.length === 0
    ? '✅ جميع الملفات الحساسة مستثناة'
    : `⚠️ هذه الملفات قد لا تكون مستثناة: ${missingFromGitignore.map(f => `\`${f}\``).join(', ')}`,
  '',
  '## ✅ الإجراءات المطلوبة',
  findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH').map(f => `- [ ] معالجة: ${f.name} (${f.count} موضع)`).join('\n') || '- لا إجراءات عاجلة',
  criticalVulns + highVulns > 0 ? `- [ ] تحديث المكتبات ذات الثغرات الحرجة` : '',
  '',
  '---',
  '_تقرير آلي من قسم Security — بوبيان للمحاسبة_',
].filter(l => l !== null && l !== undefined).join('\n');

process.stdout.write(lines + '\n');
