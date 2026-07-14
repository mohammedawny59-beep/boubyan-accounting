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
  if (database) { fs.writeFileSync(dataFile, JSON.stringify(database, null, 2), 'utf8'); console.log('   ↳ database.json استُعيد'); }
  if (config)   { fs.writeFileSync(cfgFile,  JSON.stringify(config, null, 2), 'utf8');   console.log('   ↳ config.json استُعيد'); }
}

async function run() {
  const file = process.argv[2];
  if (!file) { console.error('الاستخدام: node scripts/restore.js <ملف النسخة>'); process.exit(1); }
  if (!fs.existsSync(file)) { console.error('الملف غير موجود:', file); process.exit(1); }

  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`🗄️  نسخة بتاريخ: ${backup.createdAt} | المصدر: ${backup.source}`);
  console.log('⚠️  سيتم استبدال كل البيانات الحالية بمحتوى هذه النسخة.');
  // RESTORE_YES=1 أو --yes → غير تفاعلي (للاختبار الدوري الآلي فقط)
  if (process.env.RESTORE_YES !== '1' && !process.argv.includes('--yes')) {
    const ans = await ask('اكتب "نعم" للتأكيد: ');
    if (ans !== 'نعم') { console.log('أُلغيت الاستعادة.'); process.exit(0); }
  }

  if (backup.source === 'mongodb' && MONGO_URI) {
    await restoreMongo(backup.collections || {});
  } else {
    restoreFiles(backup.database, backup.config);
  }
  console.log('✅ اكتملت الاستعادة.');
}

run().catch(e => { console.error('❌ فشلت الاستعادة:', e.message); process.exit(1); });
