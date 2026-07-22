'use strict';
/**
 * قسم العمليات — Operations Department v2.0
 * المهمة: صحة النظام، البنية التحتية، الاختبارات، المتغيرات البيئية
 */
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DeptAgent } = require('./_agent.js');

const ROOT = path.join(__dirname, '../..');

const agent = new DeptAgent({
  name:      'operations',
  nameAr:    '⚙️ قسم العمليات',
  mission:   'ضمان استمرارية النظام وصحة البنية التحتية وسلامة الاختبارات',
  standards: ['SRE Best Practices', 'ITIL v4', 'ISO 20000'],
  version:   '2.0',
});

function checkEnv() {
  agent._log('🔍 فحص المتغيرات البيئية...');
  const required = ['ANTHROPIC_API_KEY', 'JWT_SECRET', 'MONGODB_URI'];
  const optional = ['TELEGRAM_BOT_TOKEN', 'EMAIL_USER', 'PORT'];
  const missing  = required.filter(k => !process.env[k]);

  agent.metric('متغيرات مطلوبة', `${required.length - missing.length}/${required.length}`, '');

  if (missing.length > 0) {
    agent.finding('high', 'configuration',
      `${missing.length} متغير بيئي مفقود`,
      `مفقود: ${missing.join(', ')}`,
      'أضف المتغيرات لـ .env في التطوير أو GitHub Secrets للـ CI'
    );
  } else {
    agent.ok('configuration', 'جميع المتغيرات المطلوبة موجودة');
  }

  agent.metric('متغيرات اختيارية', `${optional.filter(k => process.env[k]).length}/${optional.length}`, '');
}

function checkCriticalFiles() {
  agent._log('📁 فحص الملفات الأساسية...');
  const critical = [
    'server.js', 'package.json', 'lib/ai.js', 'lib/database.js',
    'lib/calcCommission.js', 'public/index.html', '.gitignore',
  ];
  const missing = critical.filter(f => !fs.existsSync(path.join(ROOT, f)));
  agent.metric('ملفات أساسية', `${critical.length - missing.length}/${critical.length}`, '');

  if (missing.length > 0) {
    agent.finding('critical', 'integrity', 'ملفات أساسية مفقودة',
      `مفقود: ${missing.join(', ')}`, 'تحقق من git status');
  } else {
    agent.ok('integrity', 'جميع الملفات الأساسية موجودة');
  }
}

function checkNodeVersion() {
  agent._log('🟢 فحص Node.js...');
  const version = process.version;
  const major   = parseInt(version.slice(1));
  agent.metric('إصدار Node.js', version);
  if (major < 20) {
    agent.finding('high', 'runtime', `Node.js ${version} وصل EOL`, 'ثغرات أمنية غير مصلحة', 'حدث لـ Node.js 24 LTS');
  } else {
    agent.ok('runtime', `Node.js ${version} — مدعوم`);
  }
}

function checkDependencies() {
  agent._log('📦 فحص الحزم...');
  try {
    const out   = execSync('npm audit --json 2>/dev/null', { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    const audit = JSON.parse(out || '{}');
    const v     = audit.metadata?.vulnerabilities || {};
    agent.metric('ثغرات حرجة', v.critical || 0, '', 0);
    agent.metric('ثغرات عالية', v.high    || 0, '', 0);
    if ((v.critical || 0) > 0) {
      agent.finding('critical', 'security', `${v.critical} ثغرة حرجة في الحزم`,
        'قابلة للاستغلال مباشرة', 'npm audit fix --force (اختبر أولاً)');
    } else if ((v.high || 0) > 0) {
      agent.finding('high', 'security', `${v.high} ثغرة عالية`, '', 'npm audit fix');
    } else {
      agent.ok('security', 'لا ثغرات حرجة في الحزم');
    }
  } catch { agent.finding('low', 'dependencies', 'تعذر تشغيل npm audit', '', 'شغّله محلياً'); }
}

function checkTests() {
  agent._log('🧪 تشغيل الاختبارات...');
  try {
    const result = execSync('npm test -- --passWithNoTests --forceExit 2>&1', {
      cwd: ROOT, encoding: 'utf8', timeout: 90000
    });
    const passed = parseInt(result.match(/(\d+) passed/)?.[1] || '0');
    const failed = parseInt(result.match(/(\d+) failed/)?.[1] || '0');
    agent.metric('اختبارات ناجحة', passed, '');
    agent.metric('اختبارات فاشلة', failed, '', 0);
    if (failed > 0) {
      agent.finding('critical', 'testing', `${failed} اختبار فاشل`,
        'يجب الإصلاح قبل أي commit', 'npm test محلياً لرؤية التفاصيل');
    } else if (passed >= 10) {
      agent.ok('testing', `${passed} اختبار نجح ✅`);
    } else {
      agent.finding('medium', 'testing', `${passed} اختبار فقط — تغطية منخفضة`,
        'المعيار ≥20 اختبار للمنطق الأساسي', 'أضف اختبارات لـ commission، auth، journal');
    }
  } catch (e) {
    agent.finding('high', 'testing', 'فشل npm test', e.message.slice(0,150), 'شغّل npm test محلياً');
  }
}

function checkBackup() {
  agent._log('💾 فحص النسخ الاحتياطية...');
  const content   = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const hasMongo  = content.includes('MONGODB_URI') || content.includes('mongodb');
  agent.metric('قاعدة البيانات', hasMongo ? 'MongoDB Atlas ☁️' : 'JSON محلي 📁');
  if (!hasMongo) {
    agent.finding('medium', 'reliability', 'قاعدة بيانات JSON محلية',
      'لا backup تلقائي — بيانات عرضة للضياع', 'انقل لـ MongoDB Atlas');
  } else {
    agent.ok('reliability', 'MongoDB Atlas — backup تلقائي مدمج');
  }
}

async function main() {
  agent._log('🚀 بدء فحص العمليات...');
  checkEnv();
  checkCriticalFiles();
  checkNodeVersion();
  checkDependencies();
  checkTests();
  checkBackup();
  process.stdout.write(await agent.buildReport());
  agent._log(`✅ انتهى — الدرجة: ${agent.calcScore()}/100`);
}

main().catch(e => { process.stderr.write(`خطأ: ${e.message}\n`); process.exit(1); });
