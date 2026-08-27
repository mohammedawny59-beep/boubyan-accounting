#!/usr/bin/env node
'use strict';
/**
 * استعادة نسخة احتياطية — Restore
 *
 * التشغيل: node scripts/restore.js backups/backup-XXXX.json
 *
 * ⚠️ خطير: يستبدل البيانات الحالية بمحتوى النسخة. لا يُشغَّل إلا بوعي.
 *    يطلب تأكيداً صريحاً (اكتب: نعم) قبل الكتابة.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const readline = require('readline');
const { validateBackupFile } = require('../lib/backupValidation');

const ROOT = path.join(__dirname, '..');
const MONGO_URI = process.env.MONGO_URI;

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}

async function restoreMongo(collections) {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const models = {
    users:         require('../models/User'),
    entityChunks:  require('../models/EntityChunk'),
    appConfigs:    require('../models/AppConfig'),
    tenants:       require('../models/Tenant'),
    subscriptions: require('../models/Subscription'),
  };
  for (const [name, Model] of Object.entries(models)) {
    const docs = collections[name];
    if (!Array.isArray(docs)) continue;
    await Model.deleteMany({});
    if (docs.length) {
      const clean = docs.map(({ _id, __v, ...d }) => d);
      await Model.insertMany(clean, { ordered: false });
    }
    console.log(`   ↳ ${name}: استُعيد ${docs.length} سجل`);
  }
  await mongoose.connection.close();
}

function restoreFiles(database, config) {
  const dataFile = process.env.DATA_FILE   || path.join(ROOT, 'data', 'database.json');
  const cfgFile  = process.env.CONFIG_FILE || path.join(ROOT, 'data', 'config.json');
  // P0.5 — Step 10: a restore into a freshly-provisioned target (no data/
  // directory yet) must not fail with ENOENT — ensure the parent directory
  // exists before writing, same as lib/database.js's own file-persist path.
  if (database) {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(database, null, 2), 'utf8');
    console.log('   ↳ database.json استُعيد');
  }
  if (config) {
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2), 'utf8');
    console.log('   ↳ config.json استُعيد');
  }
}

// P0.5 — Step 10: --target=<label> is REQUIRED (not just the file path) —
// the operator must name what they believe they are about to overwrite
// (e.g. --target=staging, --target=local-dev). This is echoed back next to
// the ACTUAL resolved MONGO_URI/DATA_FILE before the confirmation prompt,
// so "I meant to restore into staging but MONGO_URI still points at
// production" is visible before anything is written, not after.
function parseTarget(argv) {
  const arg = argv.find(a => a.startsWith('--target='));
  return arg ? arg.slice('--target='.length) : null;
}

async function run() {
  const file = process.argv[2];
  if (!file) { console.error('الاستخدام: node scripts/restore.js <ملف النسخة> --target=<اسم الوجهة> [--yes]'); process.exit(1); }

  const target = parseTarget(process.argv);
  if (!target) {
    console.error('❌ يجب تحديد الوجهة صراحة: --target=<اسم> (مثال: --target=staging)');
    console.error('   هذا يمنع استعادة عرضية على بيئة خاطئة بسبب متغيرات env متروكة من جلسة سابقة.');
    process.exit(1);
  }

  // P0.5 — Step 10: validate BEFORE anything else — refuse a malformed
  // backup outright, before even asking for confirmation, let alone writing.
  const check = validateBackupFile(file);
  if (!check.ok) {
    console.error(`❌ النسخة غير صالحة — رُفضت الاستعادة (لم يُكتب أي شيء):`);
    for (const p of check.problems) console.error(`   - ${p}`);
    process.exit(1);
  }

  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`🗄️  نسخة بتاريخ: ${backup.createdAt} | المصدر: ${backup.source} | المستأجرون: ${(check.tenantIds||[]).join(', ') || '(لا يوجد)'}`);
  console.log(`🎯 الوجهة المُعلَنة: ${target}`);
  if (backup.source === 'mongodb') console.log(`   ↳ سيُكتب إلى MONGO_URI الحالي: ${MONGO_URI ? MONGO_URI.replace(/\/\/[^@]+@/, '//<credentials>@') : '(غير مضبوط)'}`);
  else console.log(`   ↳ سيُكتب إلى الملفات: ${process.env.DATA_FILE || path.join(ROOT, 'data', 'database.json')}`);
  console.log('⚠️  سيتم استبدال كل البيانات الحالية في الوجهة أعلاه بمحتوى هذه النسخة.');
  // RESTORE_YES=1 أو --yes → غير تفاعلي (للاختبار الدوري الآلي فقط على وجهة معزولة)
  if (process.env.RESTORE_YES !== '1' && !process.argv.includes('--yes')) {
    const ans = await ask(`اكتب "نعم" للتأكيد أنك تريد الاستعادة إلى "${target}": `);
    if (ans !== 'نعم') { console.log('أُلغيت الاستعادة.'); process.exit(0); }
  }

  if (backup.source === 'mongodb' && MONGO_URI) {
    await restoreMongo(backup.collections || {});
  } else {
    restoreFiles(backup.database, backup.config);
  }
  console.log(`✅ اكتملت الاستعادة إلى "${target}".`);
}

run().catch(e => { console.error('❌ فشلت الاستعادة:', e.message); process.exit(1); });
