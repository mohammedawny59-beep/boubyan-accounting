#!/usr/bin/env node
'use strict';
/**
 * نسخ احتياطي كامل لبيانات النظام — Backup
 *
 * يصدّر كل البيانات (المستخدمون، الحسابات، القيود، المصاريف، كل شيء) إلى ملف
 * JSON مؤرّخ في مجلد backups/. يعمل في وضعين:
 *   - MongoDB متصل  → يصدّر كل المجموعات (collections)
 *   - وضع الملفات     → ينسخ data/database.json + config.json
 *
 * التشغيل:  node scripts/backup.js
 * الاستعادة: node scripts/restore.js backups/<الملف>.json
 *
 * ⚠️ مهم: شغّله على جهازك مقابل قاعدة الإنتاج (MONGO_URI) للحصول على نسخة
 *    خارج الخادم. النسخة على Render نفسها تُمسح عند إعادة التشغيل.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { computeChecksum, extractTenantIds } = require('../lib/backupValidation');

const ROOT      = path.join(__dirname, '..');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'backups'); // قابل للتحديد (للاختبار الدوري)
const KEEP       = Number(process.env.BACKUP_KEEP || 30); // كم نسخة نحتفظ بها
const MONGO_URI  = process.env.MONGO_URI;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function fromMongo() {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const models = {
    users:         require('../models/User'),
    entityChunks:  require('../models/EntityChunk'),
    appConfigs:    require('../models/AppConfig'),
    tenants:       require('../models/Tenant'),
    subscriptions: require('../models/Subscription'),
  };
  const out = {};
  for (const [name, Model] of Object.entries(models)) {
    try { out[name] = await Model.find().lean(); }
    catch { out[name] = []; }
  }
  await mongoose.connection.close();
  return { source: 'mongodb', collections: out };
}

function fromFiles() {
  const dataFile = process.env.DATA_FILE   || path.join(ROOT, 'data', 'database.json');
  const cfgFile  = process.env.CONFIG_FILE || path.join(ROOT, 'data', 'config.json');
  let database = null, config = null;
  try { database = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch {}
  try { config   = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}
  return { source: 'file', database, config };
}

async function run() {
  console.log('🗄️  بدء النسخ الاحتياطي...');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  let payload;
  if (MONGO_URI) {
    try { payload = await fromMongo(); console.log('   ↳ المصدر: MongoDB'); }
    catch (e) { console.log(`   ⚠️ تعذّر الاتصال بـ Mongo (${e.message}) — أنسخ من الملفات`); payload = fromFiles(); }
  } else {
    payload = fromFiles(); console.log('   ↳ المصدر: ملفات محلية');
  }

  // P0.5 — Step 6/9: version 2 adds a tenant-identity manifest field (which
  // tenants this backup actually covers, at a glance) — version stays
  // readable by verify-backup/restore either way since both only require
  // createdAt/version/source/collections|database, never a specific version
  // number.
  const tenantIds = extractTenantIds(payload);
  const meta = { createdAt: new Date().toISOString(), version: 2, tenantIds, ...payload };
  const json = JSON.stringify(meta, null, 2);
  const file = path.join(BACKUP_DIR, `backup-${stamp()}.json`);
  fs.writeFileSync(file, json, 'utf8');

  // P0.5 — Step 9: checksum sidecar — a backup that can't be verified isn't
  // really a backup. verify-backup.js / restore.js both check this file
  // hashes to the same value before trusting its contents.
  const checksum = computeChecksum(json);
  fs.writeFileSync(file + '.sha256', `${checksum}  ${path.basename(file)}\n`, 'utf8');

  const sizeMB = (fs.statSync(file).size / 1048576).toFixed(2);
  console.log(`✅ تم — ${path.basename(file)} (${sizeMB} MB)`);
  console.log(`   ↳ tenants: ${tenantIds.length ? tenantIds.join(', ') : '(none found)'}`);
  console.log(`   ↳ sha256:  ${checksum}`);

  // تدوير: احتفظ بآخر KEEP نسخة فقط (والملف .sha256 المرافق لكل نسخة قديمة)
  const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-') && f.endsWith('.json')).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - KEEP));
  for (const old of excess) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
    try { fs.unlinkSync(path.join(BACKUP_DIR, old + '.sha256')); } catch {}
  }
  if (excess.length) console.log(`🧹 حُذفت ${excess.length} نسخة قديمة (نحتفظ بآخر ${KEEP})`);

  console.log(`\n📁 كل النسخ في: ${BACKUP_DIR}`);
  console.log(`🔎 للتحقق: node scripts/verify-backup.js ${file}`);
}

run().catch(e => { console.error('❌ فشل النسخ الاحتياطي:', e.message); process.exit(1); });
