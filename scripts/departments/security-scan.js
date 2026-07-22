'use strict';
/**
 * قسم الأمن — Security Department v2.0
 * المهمة: فحص الأمن والثغرات وضوابط الوصول
 * معايير: OWASP Top 10 · NIST CSF · ISO 27001
 */
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DeptAgent } = require('./_agent.js');

const ROOT = path.join(__dirname, '../..');

const agent = new DeptAgent({
  name:      'security',
  nameAr:    '🔒 قسم الأمن',
  mission:   'حماية النظام من الثغرات وضمان سلامة البيانات وامتثال OWASP',
  standards: ['OWASP Top 10', 'NIST CSF', 'ISO 27001', 'CIS Controls'],
  version:   '2.0',
});

// OWASP A01 — Broken Access Control
function checkAccessControl() {
  agent._log('🔐 A01 — Access Control...');
  const content = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routes  = (content.match(/app\.(get|post|put|delete|patch)\s*\(['"]/g) || []).length;
  const protected_ = (content.match(/requireAuth/g) || []).length;

  agent.metric('إجمالي Routes',       routes,      '');
  agent.metric('Routes محمية',        protected_,  '');
  agent.metric('نسبة الحماية',        routes > 0 ? `${Math.round(protected_/routes*100)}%` : '0%');

  const ratio = routes > 0 ? protected_ / routes : 0;
  if (ratio < 0.6) {
    agent.finding('high', 'A01-access-control',
      `${Math.round((1-ratio)*100)}% من الـ routes بدون حماية`,
      `${routes} route — ${protected_} محمي فقط`,
      'أضف requireAuth middleware لكل endpoint يحتوي بيانات'
    );
  } else {
    agent.ok('A01-access-control', `${Math.round(ratio*100)}% من الـ routes محمية`);
  }

  // Check for mass assignment
  const massAssign = (content.match(/req\.body\b(?!\.)/g) || []).length;
  agent.metric('استخدام req.body مباشر', massAssign, '', 5);
  if (massAssign > 10) {
    agent.finding('medium', 'A01-access-control',
      `${massAssign} استخدام مباشر لـ req.body`,
      'خطر Mass Assignment — قد يسمح للمستخدم بتغيير حقول لا يجب',
      'استخدم destructuring صريح: const { field1, field2 } = req.body'
    );
  }
}

// OWASP A02 — Cryptographic Failures
function checkCryptography() {
  agent._log('🔑 A02 — Cryptography...');
  const content = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  // JWT
  const jwtSecret = process.env.JWT_SECRET || '';
  agent.metric('JWT_SECRET', jwtSecret ? `${jwtSecret.length} حرف` : '❌ مفقود');
  if (!jwtSecret) {
    agent.finding('critical', 'A02-crypto', 'JWT_SECRET غير موجود في البيئة', 'JWT مكسور — أي شخص يقدر يزور tokens', 'أضف JWT_SECRET قوي (32+ حرف عشوائي)');
  } else if (jwtSecret.length < 32) {
    agent.finding('high', 'A02-crypto', 'JWT_SECRET قصير جداً', `${jwtSecret.length} حرف — يجب ≥32`, 'ولّد: openssl rand -hex 32');
  } else {
    agent.ok('A02-crypto', 'JWT_SECRET قوي');
  }

  // bcrypt / password hashing
  const hasBcrypt = content.includes('bcrypt') || content.includes('argon2') || content.includes('scrypt');
  agent.metric('تشفير كلمات المرور', hasBcrypt ? 'bcrypt ✅' : '❌ مفقود');
  if (!hasBcrypt) {
    agent.finding('critical', 'A02-crypto', 'لا يوجد تشفير لكلمات المرور',
      'كلمات المرور مخزنة بدون hash — خطر جسيم', 'استخدم bcrypt: const hash = await bcrypt.hash(password, 12)');
  } else {
    agent.ok('A02-crypto', 'كلمات المرور مشفرة بـ bcrypt');
  }

  // HTTPS
  const forceHttps = content.includes('https') || content.includes('ssl') || content.includes('secure');
  agent.metric('HTTPS', forceHttps ? '✅ مفعّل' : '⚠️ غير واضح');
}

// OWASP A03 — Injection
function checkInjection() {
  agent._log('💉 A03 — Injection...');
  const content = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  // eval
  const evalCount = (content.match(/\beval\s*\(/g) || []).length;
  agent.metric('استخدام eval()', evalCount, '', 0);
  if (evalCount > 0) {
    agent.finding('critical', 'A03-injection', `${evalCount} استخدام لـ eval()`,
      'eval() يسمح بتنفيذ كود عشوائي — Code Injection', 'احذف كل eval() واستبدل بمنطق صريح');
  } else {
    agent.ok('A03-injection', 'لا يوجد eval()');
  }

  // SQL-like injection patterns (even for MongoDB)
  const noSqlInjection = (content.match(/\$where|\$regex.*req\.|new RegExp.*req\./g) || []).length;
  if (noSqlInjection > 0) {
    agent.finding('high', 'A03-injection', 'نمط NoSQL Injection محتمل',
      `${noSqlInjection} استخدام لـ $where أو regex من user input`, 'تحقق من sanitization قبل استخدام user input في MongoDB queries');
  }

  // Command injection
  const execPatterns = (content.match(/exec\s*\(.*req\.|spawn\s*\(.*req\./g) || []).length;
  if (execPatterns > 0) {
    agent.finding('critical', 'A03-injection', 'Command Injection محتمل',
      `${execPatterns} استخدام لـ exec/spawn مع user input`, 'لا تمرر user input لـ exec/spawn أبداً');
  } else {
    agent.ok('A03-injection', 'لا أنماط Command Injection');
  }
}

// OWASP A05 — Security Misconfiguration
function checkMisconfiguration() {
  agent._log('⚙️ A05 — Misconfiguration...');
  const content = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  // Helmet
  const hasHelmet = content.includes('helmet');
  agent.metric('Helmet (Security Headers)', hasHelmet ? '✅' : '❌ مفقود');
  if (!hasHelmet) {
    agent.finding('medium', 'A05-misconfig', 'Helmet غير مستخدم',
      'HTTP Security Headers مفقودة (XSS، clickjacking، MIME sniffing)',
      'أضف: app.use(require("helmet")())');
  } else {
    agent.ok('A05-misconfig', 'Helmet مفعّل — Security Headers موجودة');
  }

  // CORS
  const hasCors = content.includes('cors');
  agent.metric('CORS', hasCors ? '✅ مضبوط' : '⚠️ غير واضح');
  if (!hasCors) {
    agent.finding('medium', 'A05-misconfig', 'CORS غير صريح',
      'قد يسمح لأي موقع بالوصول للـ API', 'أضف: app.use(require("cors")({ origin: allowedOrigins }))');
  }

  // Rate Limiting
  const hasRateLimit = content.includes('rateLimit') || content.includes('rate-limit');
  agent.metric('Rate Limiting', hasRateLimit ? '✅' : '❌ مفقود');
  if (!hasRateLimit) {
    agent.finding('high', 'A05-misconfig', 'لا يوجد Rate Limiting',
      'API مكشوفة لـ Brute Force وـ DDoS', 'أضف: express-rate-limit على /api/login وكل endpoints حساسة');
  } else {
    agent.ok('A05-misconfig', 'Rate Limiting مفعّل');
  }

  // Error details exposure
  const exposeErrors = (content.match(/res\.json\s*\(\s*\{\s*error\s*:\s*e\b/g) || []).length;
  if (exposeErrors > 3) {
    agent.finding('medium', 'A05-misconfig',
      `${exposeErrors} endpoint يكشف تفاصيل الخطأ للعميل`,
      'رسائل الخطأ الداخلية تساعد المهاجم', 'أرجع رسائل عامة للعميل، سجّل التفاصيل server-side');
  }
}

// OWASP A07 — Identification & Authentication
function checkAuthentication() {
  agent._log('👤 A07 — Authentication...');
  const content = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  // JWT expiry
  const hasExpiry = content.includes('expiresIn') || content.includes('exp:');
  agent.metric('JWT Expiry', hasExpiry ? '✅ موجود' : '❌ مفقود');
  if (!hasExpiry) {
    agent.finding('high', 'A07-auth', 'JWT بدون expiry',
      'Token صالح للأبد — خطر كبير إذا سُرق', 'أضف: { expiresIn: "8h" } في jwt.sign()');
  } else {
    agent.ok('A07-auth', 'JWT له مدة انتهاء');
  }

  // Password minimum length
  const hasMinLength = content.includes('minLength') || content.includes('.length < ') || content.includes('length >= ');
  agent.metric('التحقق من قوة كلمة المرور', hasMinLength ? '✅' : '⚠️');
  if (!hasMinLength) {
    agent.finding('medium', 'A07-auth', 'لا يوجد تحقق من طول كلمة المرور',
      'يسمح بكلمات مرور ضعيفة جداً', 'أضف: if (password.length < 8) return error');
  }
}

// Hardcoded Secrets Scan
function checkHardcodedSecrets() {
  agent._log('🕵️ فحص الأسرار المدمجة...');
  const files   = ['server.js', 'lib/ai.js', 'lib/database.js'];
  const patterns= [
    { regex: /api[_-]?key\s*[:=]\s*['"][a-zA-Z0-9\-_]{20,}/gi, name: 'API Key' },
    { regex: /password\s*[:=]\s*['"][^'"]{8,}/gi,               name: 'Password' },
    { regex: /secret\s*[:=]\s*['"][^'"]{8,}/gi,                 name: 'Secret' },
    { regex: /sk-[a-zA-Z0-9]{20,}/g,                            name: 'OpenAI Key' },
  ];

  let totalFound = 0;
  for (const file of files) {
    const fpath = path.join(ROOT, file);
    if (!fs.existsSync(fpath)) continue;
    const content = fs.readFileSync(fpath, 'utf8');
    for (const p of patterns) {
      const matches = content.match(p.regex) || [];
      // Filter out process.env references and comments
      const real = matches.filter(m => !m.includes('process.env') && !m.includes('//'));
      totalFound += real.length;
    }
  }

  agent.metric('أسرار مدمجة', totalFound, '', 0);
  if (totalFound > 0) {
    agent.finding('critical', 'secrets',
      `${totalFound} سر مدمج في الكود`,
      'API keys أو كلمات مرور في الكود مباشرة',
      'انقل كل الأسرار لـ .env واستخدم process.env'
    );
  } else {
    agent.ok('secrets', 'لا أسرار مدمجة في الكود');
  }
}

async function main() {
  agent._log('🚀 بدء الفحص الأمني...');

  checkAccessControl();
  checkCryptography();
  checkInjection();
  checkMisconfiguration();
  checkAuthentication();
  checkHardcodedSecrets();

  const score = agent.calcScore();
  process.stdout.write(await agent.buildReport());
  agent._log(`✅ انتهى — درجة الأمن: ${score}/100`);

  // Exit with error if critical security issues found
  const criticals = agent.findings.filter(f => f.severity === 'critical').length;
  if (criticals > 0) process.exitCode = 1;
}

main().catch(e => { process.stderr.write(`خطأ: ${e.message}\n`); process.exit(1); });
