#!/usr/bin/env node
'use strict';
// Operations Department — weekly system health
// Checks: env vars, file structure, backup status, server config

const { readFile, fileExists, today } = require('./_common');

const pkg     = JSON.parse(readFile('package.json') || '{}');
const env     = readFile('.env');
const envEx   = readFile('.env.example');

// ── Required env vars ─────────────────────────────────────────────────────────
const REQUIRED_ENV = [
  { key: 'MONGODB_URI',           desc: 'اتصال قاعدة البيانات',       critical: true  },
  { key: 'JWT_SECRET',            desc: 'تشفير الجلسات',               critical: true  },
  { key: 'ANTHROPIC_API_KEY',     desc: 'Claude AI API',               critical: false },
  { key: 'ADMIN_DEFAULT_PASSWORD',desc: 'كلمة مرور المدير الافتراضية', critical: false },
  { key: 'PORT',                  desc: 'منفذ الخادم',                  critical: false },
];

const envVarStatus = REQUIRED_ENV.map(e => ({
  ...e,
  present: env ? env.includes(e.key) : false,
}));

// ── Critical files ────────────────────────────────────────────────────────────
const FILES = [
  { path: 'server.js',          name: 'الخادم الرئيسي'      },
  { path: 'lib/database.js',    name: 'قاعدة البيانات'      },
  { path: 'lib/ai.js',          name: 'مكتبة AI'             },
  { path: 'public/index.html',  name: 'الواجهة الرئيسية'    },
  { path: '.gitignore',         name: 'حماية الملفات الحساسة'},
  { path: 'package.json',       name: 'إعدادات المشروع'      },
  { path: 'tests/',             name: 'الاختبارات'            },
];

// ── Backup check ──────────────────────────────────────────────────────────────
const hasBackupScript = fileExists('scripts/backup.js') || fileExists('scripts/backup.sh');
const hasDataDir      = fileExists('data');
const mongoUri        = env ? (env.match(/MONGODB_URI=(.+)/)?.[1] || '') : '';
const isMongoAtlas    = mongoUri.includes('mongodb.net');

// ── Node version ──────────────────────────────────────────────────────────────
const { execSync } = require('child_process');
let nodeVersion = 'غير معروف';
try { nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim(); } catch {}

const engineRequired = pkg.engines?.node || 'غير محدد';

// ── Dependencies health ───────────────────────────────────────────────────────
const deps    = Object.keys(pkg.dependencies    || {}).length;
const devDeps = Object.keys(pkg.devDependencies || {}).length;

const lines = [
  `# ⚙️ Operations Department — تقرير التشغيل`,
  `**التاريخ:** ${today()}`,
  '',
  '## 🔑 متغيرات البيئة (.env)',
  `| المتغير | الوصف | الحالة |`,
  `|---------|-------|--------|`,
  ...envVarStatus.map(e =>
    `| \`${e.key}\` | ${e.desc} | ${e.present ? '✅' : e.critical ? '🔴 مفقود' : '🟡 مفقود'} |`
  ),
  !fileExists('.env.example')
    ? '\n> ❌ `.env.example` غير موجود — يجب إنشاؤه لتوثيق المتغيرات المطلوبة'
    : '\n> ✅ `.env.example` موجود',
  '',
  '## 📁 فحص الملفات الأساسية',
  FILES.map(f => `- ${fileExists(f.path) ? '✅' : '❌'} \`${f.path}\` — ${f.name}`).join('\n'),
  '',
  '## 💾 النسخ الاحتياطية',
  `| البند | الحالة |`,
  `|-------|--------|`,
  `| MongoDB Atlas (Automatic Backup) | ${isMongoAtlas ? '✅ مفعّل تلقائياً' : '⚠️ تحقق من إعدادات Atlas'} |`,
  `| ملف بيانات محلي (data/) | ${hasDataDir ? '✅ موجود' : '🟡 غير موجود (fallback mode)'} |`,
  `| سكريبت backup مخصص | ${hasBackupScript ? '✅' : '🟡 غير موجود'} |`,
  '',
  '## 🖥️ بيئة التشغيل',
  `| المؤشر | القيمة |`,
  `|--------|--------|`,
  `| إصدار Node.js الحالي | ${nodeVersion} |`,
  `| الإصدار المطلوب | ${engineRequired} |`,
  `| عدد المكتبات | ${deps} dependencies + ${devDeps} devDependencies |`,
  '',
  '## ✅ قائمة المراجعة الأسبوعية',
  '- [ ] التحقق من أن الخادم يعمل على Render بدون أخطاء',
  '- [ ] مراجعة logs الخادم للأخطاء المتكررة',
  '- [ ] التأكد من عمل النسخ الاحتياطي لـ MongoDB Atlas',
  '- [ ] اختبار تسجيل الدخول للنظام',
  '- [ ] مراجعة استخدام ذاكرة الخادم',
  !fileExists('.env.example') ? '- [ ] 🔴 إنشاء `.env.example` (مطلوب)' : '',
  envVarStatus.filter(e => !e.present && e.critical).map(e => `- [ ] 🔴 إضافة \`${e.key}\` لـ .env`).join('\n') || '',
  '',
  '---',
  '_تقرير آلي من قسم Operations — بوبيان للمحاسبة_',
].filter(l => l !== null && l !== undefined && l !== false).join('\n');

process.stdout.write(lines + '\n');
