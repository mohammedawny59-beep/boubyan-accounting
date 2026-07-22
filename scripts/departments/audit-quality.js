'use strict';
/**
 * قسم التدقيق والمتابعة والجودة
 * منهجية: EY Global Audit Methodology + ISO 9001 + CMMI Level 3
 * يراقب: جميع الأقسام + جودة الكود + الامتثال + المشاكل المفتوحة
 */
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');
const { DeptAgent } = require('./_agent.js');

const ROOT = path.join(__dirname, '../..');

const agent = new DeptAgent({
  name:      'audit-quality',
  nameAr:    '🔍 قسم التدقيق والمتابعة والجودة',
  mission:   'التدقيق المستمر على صحة النظام ومتابعة تنفيذ القرارات وضمان الجودة والامتثال',
  standards: ['EY GAM', 'ISO 9001:2015', 'CMMI L3', 'IFRS', 'Kuwait Labor Law No.6/2010'],
  version:   '2.0',
});

// ── 1. GitHub Issues Follow-up (EY: Follow-up Procedures) ───────────────────
async function auditOpenIssues() {
  agent._log('🔎 فحص Issues المفتوحة...');

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY || 'mohammedawny59-beep/boubyan-accounting';

  if (!token) {
    agent.finding('medium', 'follow-up', 'GITHUB_TOKEN غير متاح', 'لا يمكن قراءة Issues — يعمل بدون API', 'أضف GITHUB_TOKEN للـ workflow environment');
    return;
  }

  let issues = [];
  try { issues = await fetchIssues(token, repo, 'open'); } catch { return; }

  const today = new Date();
  const needsReview = [];
  const overdue14   = [];
  const overdue7    = [];
  const deptCounts  = {};
  const repeatMap   = {};

  for (const iss of issues) {
    const created  = new Date(iss.created_at);
    const days     = Math.floor((today - created) / 86400000);
    const deptLbl  = (iss.labels || []).find(l => l.name.startsWith('department:'));
    const dept     = deptLbl ? deptLbl.name.replace('department:', '') : '—';
    const hasReview= (iss.labels || []).some(l => l.name === 'needs-review');

    deptCounts[dept] = (deptCounts[dept] || 0) + 1;
    if (hasReview) needsReview.push({ title: iss.title, dept, days });
    if (days > 14) overdue14.push({ title: iss.title, dept, days });
    else if (days > 7) overdue7.push({ title: iss.title, dept, days });

    // Detect repeated issues (same dept + similar title this month)
    const key = dept + iss.title.slice(0, 20);
    repeatMap[key] = (repeatMap[key] || 0) + 1;
  }

  const repeats = Object.entries(repeatMap).filter(([,v]) => v > 1);

  agent.metric('إجمالي Issues مفتوحة',   issues.length,      '');
  agent.metric('تنتظر مراجعة (needs-review)', needsReview.length, '');
  agent.metric('متأخرة +14 يوم',          overdue14.length,   '', 0);
  agent.metric('متأخرة 7-14 يوم',         overdue7.length,    '');
  agent.metric('مشاكل متكررة',            repeats.length,     '', 0);

  if (overdue14.length > 0) {
    const list = overdue14.map(i => `- **${i.title}** (قسم: ${i.dept} | ${i.days} يوم)`).join('\n');
    agent.finding('high', 'follow-up',
      `${overdue14.length} Issue مفتوحة منذ أكثر من 14 يوم`,
      list,
      'راجع وأغلق أو حوّل لـ milestone — المعيار: إغلاق كل Issue خلال 14 يوم'
    );
  }

  if (repeats.length > 0) {
    agent.finding('medium', 'quality',
      'مشاكل متكررة من نفس القسم',
      `${repeats.length} نمط مكرر — قد يدل على عدم معالجة جذرية`,
      'ابحث عن السبب الجذري (Root Cause Analysis) بدل الحلول المؤقتة'
    );
  }

  // Check department coverage — all depts should report weekly
  const expected = ['Operations','IT','Security','Design','HR','News','RD','AI','Audit'];
  for (const dept of expected) {
    if (!deptCounts[dept]) {
      agent.finding('low', 'coverage',
        `لا يوجد تقرير مفتوح من قسم ${dept}`,
        'إما أن القسم لم يعمل أو أغلق Issue مبكراً',
        'تحقق من workflow الخاص بالقسم على GitHub Actions'
      );
    }
  }

  if (needsReview.length === 0 && issues.length === 0) {
    agent.ok('follow-up', 'لا توجد Issues معلقة — ممتاز');
  }
}

function fetchIssues(token, repo, state) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${repo}/issues?state=${state}&per_page=100`,
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'boubyan-audit-agent/2.0' },
    };
    https.get(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

// ── 2. Code Quality Gates (EY: Substantive Testing) ─────────────────────────
function auditCodeQuality() {
  agent._log('📐 فحص جودة الكود...');

  const serverPath = path.join(ROOT, 'server.js');
  const indexPath  = path.join(ROOT, 'public/index.html');

  const serverSize = fs.statSync(serverPath).size;
  const indexSize  = fs.statSync(indexPath).size;
  const serverLines = fs.readFileSync(serverPath, 'utf8').split('\n').length;
  const indexLines  = fs.readFileSync(indexPath,  'utf8').split('\n').length;

  agent.metric('server.js  حجم', Math.round(serverSize / 1024), 'KB',   600);
  agent.metric('server.js  سطور', serverLines,                  'سطر',  10000);
  agent.metric('index.html حجم', Math.round(indexSize / 1024),  'KB',   1000);
  agent.metric('index.html سطور', indexLines,                   'سطر',  20000);

  if (serverSize > 600 * 1024) {
    agent.finding('medium', 'maintainability',
      'server.js تجاوز 600KB',
      `الحجم الحالي: ${Math.round(serverSize/1024)}KB — يصعب الصيانة والاختبار`,
      'ابدأ تقسيمه لـ modules: routes/, controllers/, services/'
    );
  } else {
    agent.ok('maintainability', `server.js بحجم مقبول (${Math.round(serverSize/1024)}KB)`);
  }

  // Raw fetch check
  const serverContent = fs.readFileSync(serverPath, 'utf8');
  const rawFetches    = (serverContent.match(/(?<!\/\/.*)fetch\s*\(/g) || []).length;
  agent.metric('raw fetch() في server.js', rawFetches, '', 1);

  if (rawFetches > 1) {
    agent.finding('high', 'architecture',
      `${rawFetches} raw fetch() بدون استخدام callAI()`,
      'المعيار: كل استدعاء Anthropic يجب أن يمر عبر lib/ai.js',
      'استبدل كل fetch مباشر بـ callAI() أو callAIVision()'
    );
  } else {
    agent.ok('architecture', `raw fetch: ${rawFetches} (مسموح ≤1 للـ streaming)`);
  }

  // TODO/FIXME
  const todos = (serverContent.match(/\b(TODO|FIXME|HACK|XXX)\b/g) || []).length;
  agent.metric('TODO/FIXME في الكود', todos, '');
  if (todos > 10) {
    agent.finding('low', 'code-debt',
      `${todos} TODO/FIXME في الكود`,
      'تراكم الديون التقنية يبطئ التطوير مستقبلاً',
      'حوّل كل TODO لـ GitHub Issue مع label "tech-debt"'
    );
  }

  // Console.log in production
  const consoleLogs = (serverContent.match(/console\.log\s*\(/g) || []).length;
  agent.metric('console.log في server.js', consoleLogs, '');
  if (consoleLogs > 20) {
    agent.finding('low', 'code-quality',
      `${consoleLogs} console.log في production code`,
      'يبطئ الأداء ويكشف بيانات داخلية في السجلات',
      'استخدم logger مخصص (winston/pino) بدلاً من console.log'
    );
  }
}

// ── 3. Test Coverage (EY: Control Testing) ──────────────────────────────────
function auditTestCoverage() {
  agent._log('🧪 فحص الاختبارات...');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  if (!pkg.scripts?.test) {
    agent.finding('critical', 'testing', 'لا يوجد test script', 'أي تغيير قد يكسر النظام بدون علم', 'أضف Jest فوراً');
    return;
  }

  const testFiles = fs.readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.test.js'));
  agent.metric('ملفات الاختبار', testFiles.length, 'ملف');

  // Run tests
  try {
    const result = execSync('npm test -- --passWithNoTests 2>&1', {
      cwd: ROOT, encoding: 'utf8', timeout: 60000
    });
    const passed = (result.match(/(\d+) passed/)?.[1]) || '?';
    const failed = (result.match(/(\d+) failed/)?.[1]) || '0';
    agent.metric('اختبارات ناجحة', passed, '');
    agent.metric('اختبارات فاشلة', parseInt(failed), '', 0);

    if (parseInt(failed) > 0) {
      agent.finding('critical', 'testing',
        `${failed} اختبار فاشل`,
        'كود معطوب يجب إصلاحه قبل أي deployment',
        'شغّل npm test محلياً وأصلح الأخطاء'
      );
    } else {
      agent.ok('testing', `جميع الاختبارات نجحت (${passed} test)`);
    }
  } catch {
    agent.finding('high', 'testing', 'فشل تشغيل الاختبارات', 'npm test يرجع خطأ', 'راجع npm test محلياً');
  }
}

// ── 4. Security Controls (EY: IT General Controls) ──────────────────────────
function auditSecurityControls() {
  agent._log('🔒 فحص ضوابط الأمان...');

  const gitignorePath = path.join(ROOT, '.gitignore');
  const envExPath     = path.join(ROOT, '.env.example');
  const gitignore     = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';

  // .env protection
  if (!gitignore.includes('.env')) {
    agent.finding('critical', 'security',
      '.env غير مدرج في .gitignore',
      'خطر تسريب كلمات مرور وAPI keys لـ GitHub',
      'أضف ".env" سطراً في .gitignore فوراً'
    );
  } else {
    agent.ok('security', '.env محمي في .gitignore');
  }

  // .env.example
  if (!fs.existsSync(envExPath)) {
    agent.finding('medium', 'security',
      '.env.example مفقود',
      'المطورون الجدد لا يعرفون المتغيرات المطلوبة',
      'أنشئ .env.example بقائمة المتغيرات بدون قيم'
    );
  } else {
    agent.ok('security', '.env.example موجود');
  }

  // Hardcoded secrets scan
  const serverContent = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const secretPatterns = [
    /password\s*[:=]\s*['"][^'"]{8,}/i,
    /api[_-]?key\s*[:=]\s*['"][^'"]{10,}/i,
    /secret\s*[:=]\s*['"][^'"]{8,}/i,
  ];
  const found = secretPatterns.filter(p => p.test(serverContent));
  if (found.length > 0) {
    agent.finding('critical', 'security',
      'بيانات حساسة مدمجة في الكود',
      `وجد ${found.length} نمط يشبه كلمة مرور أو مفتاح`,
      'انقل كل الأسرار لـ .env وادعُ process.env'
    );
  } else {
    agent.ok('security', 'لا توجد أسرار مدمجة');
  }

  // Rate limiting
  const hasRateLimit = serverContent.includes('rateLimit') || serverContent.includes('rate-limit') || serverContent.includes('express-rate');
  agent.metric('Rate Limiting', hasRateLimit ? '✅ موجود' : '⚠️ مفقود');
  if (!hasRateLimit) {
    agent.finding('medium', 'security',
      'لا يوجد Rate Limiting',
      'واجهة API مكشوفة لهجمات Brute Force',
      'أضف express-rate-limit على endpoints الحساسة'
    );
  }
}

// ── 5. IFRS & Regulatory Compliance (EY: Compliance Testing) ────────────────
function auditCompliance() {
  agent._log('📋 فحص الامتثال...');

  const serverContent = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  // IAS 8 Period Lock
  const hasPeriodLock = serverContent.includes('periodLock') || serverContent.includes('PeriodLock') || serverContent.includes('period_lock');
  agent.metric('IAS 8 — Period Lock', hasPeriodLock ? '✅' : '❌');
  if (!hasPeriodLock) {
    agent.finding('high', 'ifrs',
      'IAS 8: Period Lock غير موجود',
      'يسمح بتعديل قيود في فترات مغلقة — مخالف لـ IAS 8',
      'أضف middleware يرفض أي قيد بتاريخ في فترة مقفلة'
    );
  } else {
    agent.ok('ifrs', 'IAS 8 Period Lock موجود');
  }

  // PIFSS (Kuwait Law 61/1976)
  const hasPifss = /pifss/i.test(serverContent);
  agent.metric('Kuwait Law 61/1976 — PIFSS', hasPifss ? '✅' : '❌');
  if (hasPifss) agent.ok('compliance', 'حساب PIFSS موجود');

  // Audit Trail
  const hasAuditLog = serverContent.includes('auditLog') || serverContent.includes('audit_log');
  agent.metric('Audit Trail (IFRS)', hasAuditLog ? '✅' : '⚠️');
  if (!hasAuditLog) {
    agent.finding('medium', 'ifrs',
      'Audit Trail غير مكتمل',
      'IFRS يشترط تتبع كل تعديل: من فعله؟ متى؟ ماذا غيّر؟',
      'أضف middleware يسجل كل write operation مع userId + timestamp'
    );
  } else {
    agent.ok('ifrs', 'Audit Trail موجود');
  }

  // Double-entry validation
  const hasBalanceCheck = serverContent.includes('debit') && serverContent.includes('credit') &&
    (serverContent.includes('balance') || serverContent.includes('مجموع'));
  agent.metric('Double-Entry Validation', hasBalanceCheck ? '✅' : '⚠️');
  if (!hasBalanceCheck) {
    agent.finding('high', 'accounting',
      'التحقق من القيد المزدوج غير واضح',
      'القيود غير المتوازنة تفسد القوائم المالية',
      'أضف validation: sum(debits) === sum(credits) قبل حفظ أي قيد'
    );
  }
}

// ── 6. DevOps & CI/CD Health (EY: IT Application Controls) ─────────────────
function auditDevOps() {
  agent._log('⚙️ فحص CI/CD...');

  const wfDir = path.join(ROOT, '.github', 'workflows');
  if (!fs.existsSync(wfDir)) {
    agent.finding('high', 'devops', 'لا توجد GitHub Actions workflows', 'لا يوجد CI/CD — النشر يدوي وغير موثوق', 'أضف .github/workflows/ci.yml');
    return;
  }

  const workflows = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  agent.metric('عدد Workflows', workflows.length, '', 5);

  const hasCI        = workflows.some(w => w.includes('ci'));
  const hasSecurity  = workflows.some(w => w.includes('security'));
  const hasCompliance= workflows.some(w => w.includes('compliance'));

  if (hasCI)         agent.ok('devops', 'CI workflow موجود');
  else               agent.finding('high', 'devops', 'لا يوجد CI workflow', 'لا يوجد اختبار تلقائي عند push', 'أضف ci.yml يشغّل npm test');

  if (!hasSecurity)  agent.finding('medium', 'devops', 'لا يوجد Security workflow', 'فحص الأمان غير مؤتمت', 'أضف security scan workflow');
  if (!hasCompliance) agent.finding('low', 'devops', 'لا يوجد Compliance workflow', 'قائمة الامتثال يدوية', 'أضف compliance.yml شهرياً');

  // Check Node version in workflows
  let outdatedNode = 0;
  for (const wf of workflows) {
    const content = fs.readFileSync(path.join(wfDir, wf), 'utf8');
    if (content.includes("node-version: '18'") || content.includes("node-version: '20'")) {
      outdatedNode++;
    }
  }
  if (outdatedNode > 0) {
    agent.finding('low', 'devops',
      `${outdatedNode} workflow يستخدم Node.js قديم`,
      'Node.js 18/20 سيصل EOL — يسبب تحذيرات',
      'حدث لـ node-version: "24"'
    );
  }

  agent.metric('Workflows تستخدم Node 18/20', outdatedNode, '');
}

// ── 7. Performance Indicators ────────────────────────────────────────────────
function auditPerformance() {
  agent._log('⚡ فحص مؤشرات الأداء...');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps    = Object.keys(pkg.dependencies    || {}).length;
  const devDeps = Object.keys(pkg.devDependencies || {}).length;

  agent.metric('Dependencies الإنتاج', deps,    '', 30);
  agent.metric('Dependencies التطوير',  devDeps, '', 20);

  if (deps > 30) {
    agent.finding('low', 'performance',
      `${deps} dependency — أكثر من المعتاد`,
      'كل dependency يزيد حجم البرنامج ومساحة الهجوم',
      'راجع npm audit و npm outdated — احذف غير المستخدم'
    );
  } else {
    agent.ok('performance', `Dependencies مقبول (${deps} prod · ${devDeps} dev)`);
  }

  // Check for compression/caching middleware
  const serverContent = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const hasCompression = serverContent.includes('compression') || serverContent.includes('gzip');
  const hasCache       = serverContent.includes('Cache-Control') || serverContent.includes('etag');

  agent.metric('HTTP Compression', hasCompression ? '✅' : '⚠️ مفقود');
  agent.metric('HTTP Caching',     hasCache       ? '✅' : '⚠️ مفقود');

  if (!hasCompression) {
    agent.finding('low', 'performance',
      'لا يوجد HTTP Compression',
      'ردود API غير مضغوطة — تبطئ الاستجابة',
      'أضف: app.use(require("compression")())'
    );
  }
}

// ── Executive Summary ────────────────────────────────────────────────────────
function buildExecutiveSummary(score) {
  const { letter, ar } = score >= 90 ? {letter:'A',ar:'ممتاز'} :
                         score >= 75 ? {letter:'B',ar:'جيد جداً'} :
                         score >= 60 ? {letter:'C',ar:'مقبول'} :
                         score >= 40 ? {letter:'D',ar:'ضعيف'} :
                                       {letter:'F',ar:'حرج'};
  return `## 📋 ملخص تنفيذي

| | |
|--|--|
| **تاريخ التدقيق** | ${new Date().toISOString().slice(0,10)} |
| **المدقق** | نظام التدقيق الذكي — بوبيان للمحاسبة |
| **المنهجية** | EY Global Audit Methodology |
| **التقييم النهائي** | **${letter} — ${ar} (${score}/100)** |

> هذا التقرير آلي ويجب أن يراجعه المدير المالي شهرياً.
`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  agent._log('🚀 بدء التدقيق الشامل...');

  auditCodeQuality();
  auditTestCoverage();
  auditSecurityControls();
  auditCompliance();
  auditDevOps();
  auditPerformance();
  await auditOpenIssues();

  const score   = agent.calcScore();
  const summary = buildExecutiveSummary(score);
  const report  = await agent.buildReport(summary);

  process.stdout.write(report);
  agent._log(`✅ التدقيق اكتمل — الدرجة: ${score}/100`);
}

main().catch(e => {
  process.stderr.write(`خطأ فادح: ${e.message}\n`);
  process.exit(1);
});
