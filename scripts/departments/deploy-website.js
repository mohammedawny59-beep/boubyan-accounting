#!/usr/bin/env node
'use strict';
/**
 * Deploy & Website Department — قسم النشر والموقع
 * CLAUDE.md §3 — القسم الجديد 5
 *
 * يفحص جاهزية المنتج للنشر ويقيّم Landing Page.
 * أي نشر فعلي على production → APPROVAL.BLOCKING (لا يُنفَّذ بدون موافقة).
 * يعمل على staging/dev فقط تلقائياً.
 */
const { DeptAgent } = require('./_agent');
const { APPROVAL }  = require('./_common');
const { readFile, fileExists, countPattern, today } = require('./_common');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

async function main() {
  const agent = new DeptAgent({
    name:      'deploy-website',
    nameAr:    '🚀 قسم النشر والموقع',
    mission:   'فحص جاهزية النشر وتقييم Landing Page — النشر الفعلي يتطلب موافقة يدوية دائماً',
    standards: ['12-Factor App', 'Web Vitals Core', 'SaaS Landing Page Best Practices', 'Lighthouse 90+'],
  });

  agent.loadMemory();

  const server  = readFile('server.js');
  const pkg     = JSON.parse(readFile('package.json') || '{}');
  const index   = readFile('public/index.html');
  const hasEnvExample = fileExists('.env.example') || fileExists('.env.sample');
  const hasDockerfile  = fileExists('Dockerfile');
  const hasProcfile    = fileExists('Procfile');
  const hasRailway     = fileExists('railway.toml') || fileExists('railway.json');
  const hasRenderYaml  = fileExists('render.yaml');
  const hasVercel      = fileExists('vercel.json');
  const hasHeroku      = fileExists('heroku.yml');
  const hasGHActions   = fileExists('.github/workflows');

  // ── 1. Production Readiness ──────────────────────────────────────────────────
  agent._log('🔍 فحص جاهزية الإنتاج...');

  const hasStartScript  = !!(pkg.scripts?.start);
  const hasNodeVersion  = !!(pkg.engines?.node);
  const hasEnvCheck     = /process\.env\./i.test(server);
  const hasHealthCheck  = /\/health|\/ping|healthCheck/i.test(server);
  const hasGracefulStop = /SIGTERM|SIGINT|graceful/i.test(server);
  const hasErrorHandler = /app\.use.*err|error.*middleware|next\(err/i.test(server);
  const hasCompression  = /compression|gzip|deflate/i.test(server);
  const hasHelmet       = /helmet/i.test(server);

  agent.metric('Start Script', hasStartScript ? '✅' : '❌');
  agent.metric('Node Version Pinned', hasNodeVersion ? '✅' : '⚠️');
  agent.metric('Health Check Endpoint', hasHealthCheck ? '✅' : '❌');
  agent.metric('Graceful Shutdown', hasGracefulStop ? '✅' : '❌');
  agent.metric('Error Middleware', hasErrorHandler ? '✅' : '❌');
  agent.metric('Helmet Security', hasHelmet ? '✅' : '❌');
  agent.metric('Compression', hasCompression ? '✅' : '❌');

  if (!hasHealthCheck) {
    agent.finding('high', 'ops', '/health endpoint مفقود',
      'كل منصة cloud (Railway/Render/Heroku) تحتاج health endpoint للـ load balancer',
      'أضف: app.get(\'/health\', (req,res) => res.json({ok:true, ts:Date.now()}))');
  } else {
    agent.ok('ops', '/health endpoint موجود');
  }

  if (!hasGracefulStop) {
    agent.finding('medium', 'ops', 'Graceful Shutdown مفقود',
      'عند إعادة النشر، الطلبات المفتوحة تُقتل فجأة',
      'أضف: process.on(\'SIGTERM\', () => server.close(() => process.exit(0)))');
  } else {
    agent.ok('ops', 'Graceful Shutdown موجود');
  }

  if (!hasHelmet) {
    agent.finding('medium', 'security', 'Helmet.js مفقود',
      'Security headers غير مضبوطة — OWASP يشترطها',
      'npm install helmet ثم app.use(helmet()) في أول السكريبت');
  } else {
    agent.ok('security', 'Helmet.js موجود');
  }

  if (!hasNodeVersion) {
    agent.finding('low', 'ops', 'Node.js version غير محدد في package.json',
      'قد يُنشر على node version خاطئة في cloud environment',
      'أضف: "engines": {"node": ">=20.0.0"} في package.json');
  } else {
    agent.ok('ops', `Node.js version محدد: ${pkg.engines?.node}`);
  }

  // ── 2. Deployment Platform ───────────────────────────────────────────────────
  agent._log('☁️ فحص منصة النشر...');

  const platforms = [];
  if (hasRailway)   platforms.push('Railway');
  if (hasRenderYaml) platforms.push('Render');
  if (hasVercel)    platforms.push('Vercel');
  if (hasHeroku)    platforms.push('Heroku');
  if (hasDockerfile) platforms.push('Docker');

  agent.metric('منصات نشر مهيأة', platforms.length || 0, platforms.join(', ') || 'لا شيء');
  agent.metric('GitHub Actions', hasGHActions ? '✅' : '❌');
  agent.metric('.env.example', hasEnvExample ? '✅' : '❌');

  if (platforms.length === 0) {
    agent.finding('high', 'deploy', 'لا يوجد ملف إعداد لأي منصة نشر',
      'المنتج لا يمكن نشره على cloud بشكل سريع',
      'أنشئ railway.toml أو render.yaml أو Dockerfile',
      APPROVAL.NOTIFY);
  } else {
    agent.ok('deploy', `منصات مهيأة: ${platforms.join(', ')}`);
  }

  if (!hasEnvExample) {
    agent.finding('medium', 'ops', '.env.example مفقود',
      'المطورون الجدد لا يعرفون المتغيرات المطلوبة',
      'أنشئ .env.example بكل متغيرات البيئة (بدون قيم حساسة)');
  } else {
    agent.ok('ops', '.env.example موجود');
  }

  // ── 3. Landing Page Quality ──────────────────────────────────────────────────
  agent._log('🌐 تقييم Landing Page...');

  const hasMetaDesc    = /<meta\s+name=["']description["']/i.test(index);
  const hasOGTags      = /og:title|og:description|og:image/i.test(index);
  const hasCanonical   = /<link\s+rel=["']canonical["']/i.test(index);
  const hasViewport    = /viewport.*width=device-width/i.test(index);
  const hasFavicon     = /rel=["']icon["']|favicon/i.test(index);
  const hasCTA         = /سجّل|ابدأ|تجربة|sign up|get started|free trial|demo/i.test(index);
  const hasPricing     = /تسعير|pricing|plan|price/i.test(index);
  const hasTestimonial = /testimonial|عميل|review|قال/i.test(index);
  const hasFAQ         = /faq|الأسئلة الشائعة|سؤال/i.test(index);
  const hasSSL         = /https:\/\//i.test(index);

  agent.metric('Meta Description', hasMetaDesc ? '✅' : '❌');
  agent.metric('Open Graph Tags', hasOGTags ? '✅' : '❌');
  agent.metric('Canonical URL', hasCanonical ? '✅' : '❌');
  agent.metric('CTA Button', hasCTA ? '✅' : '❌');
  agent.metric('Pricing Section', hasPricing ? '✅' : '❌');

  if (!hasMetaDesc) {
    agent.finding('medium', 'seo', 'Meta Description مفقود',
      'يضر بـ SEO ويقلل CTR في نتائج البحث',
      'أضف: <meta name="description" content="...">');
  } else {
    agent.ok('seo', 'Meta Description موجود');
  }

  if (!hasOGTags) {
    agent.finding('medium', 'social', 'Open Graph Tags مفقودة',
      'المشاركة على LinkedIn وTwitter تبدو بدون صورة أو وصف',
      'أضف og:title + og:description + og:image في <head>');
  } else {
    agent.ok('social', 'Open Graph Tags موجودة');
  }

  if (!hasCTA) {
    agent.finding('high', 'conversion', 'Call-to-Action مفقود',
      'الصفحة الرئيسية بدون CTA واضح = تحويل صفري',
      'أضف زر "ابدأ مجاناً" أو "طلب demo" فوق الطيّة (above the fold)');
  } else {
    agent.ok('conversion', 'CTA موجود');
  }

  if (!hasPricing) {
    agent.finding('medium', 'conversion', 'صفحة تسعير مفقودة',
      'B2B SaaS: المستخدم يريد رؤية الأسعار — غيابها يسبب bounce',
      'أضف قسم Pricing بـ 3 plans: Free, Pro, Enterprise');
  } else {
    agent.ok('conversion', 'قسم التسعير موجود');
  }

  // ── 4. Deployment Block (never auto-deploy to production) ────────────────────
  // This is informational only — no actual deployment happens
  agent.finding('info', 'policy',
    'سياسة النشر: production يتطلب موافقة يدوية دائماً',
    'CLAUDE.md §4 — BLOCKING: أي نشر على production يحتاج إذن صريح',
    'للنشر على staging: اضغط "Deploy to Staging" في GitHub Actions',
    APPROVAL.BLOCKING);

  agent.saveMemory();
  await agent.runAgentLoop();

  // Extras: deployment checklist
  const readyChecks = [
    { item: 'Start script موجود', ok: hasStartScript },
    { item: '/health endpoint', ok: hasHealthCheck },
    { item: 'Graceful Shutdown', ok: hasGracefulStop },
    { item: 'Error Middleware', ok: hasErrorHandler },
    { item: 'Helmet.js', ok: hasHelmet },
    { item: 'Compression', ok: hasCompression },
    { item: 'Node version محدد', ok: hasNodeVersion },
    { item: '.env.example', ok: hasEnvExample },
    { item: 'منصة نشر مهيأة', ok: platforms.length > 0 },
    { item: 'GitHub Actions', ok: hasGHActions },
  ];

  const passCount = readyChecks.filter(c => c.ok).length;
  const totalCount = readyChecks.length;
  const readinessScore = Math.round((passCount / totalCount) * 100);

  const checkRows = readyChecks.map(c => `| ${c.ok ? '✅' : '❌'} | ${c.item} |`).join('\n');

  const extras = `## 🚀 Deployment Readiness Score: ${readinessScore}/100

| الحالة | المعيار |
|--------|---------|
${checkRows}

---

## 🌐 Landing Page SEO/Conversion Score

| المعيار | الحالة |
|---------|--------|
| Meta Description | ${hasMetaDesc ? '✅' : '❌'} |
| Open Graph | ${hasOGTags ? '✅' : '❌'} |
| Canonical URL | ${hasCanonical ? '✅' : '❌'} |
| CTA Button | ${hasCTA ? '✅' : '❌'} |
| Pricing Section | ${hasPricing ? '✅' : '❌'} |
| Testimonials | ${hasTestimonial ? '✅' : '❌'} |
| FAQ Section | ${hasFAQ ? '✅' : '❌'} |

---

## 📋 قائمة النشر — Staging vs Production

### ✅ Staging (آمن — بدون موافقة)
- \`git push origin staging\` → GitHub Actions تنشر تلقائياً
- URL: يُحدَّد في railway.toml أو render.yaml

### 🔴 Production (يتطلب موافقة — BLOCKING)
1. طلب موافقة من صاحب المنتج
2. تشغيل test suite كامل
3. مراجعة CHANGELOG
4. نشر في وقت هادئ (off-peak)
5. مراقبة error rate لـ 30 دقيقة بعد النشر

> 📌 CLAUDE.md §4: أي نشر production بدون إذن صريح = مخالفة`;

  const report = await agent.buildReport(extras);
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[deploy-website] خطأ: ${e.message}\n`));
