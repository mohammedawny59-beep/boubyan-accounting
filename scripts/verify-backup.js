#!/usr/bin/env node
'use strict';
/**
 * التحقق من صحة نسخة احتياطية — Verify Backup (P0.5 — Step 9)
 *
 * يتحقق فقط — لا يكتب ولا يمسّ أي بيانات إنتاج أو محلية:
 *   - الملف موجود وحجمه > 0
 *   - JSON صالح
 *   - المفاتيح البنيوية المطلوبة موجودة (createdAt/version/source/...)
 *   - checksum مطابق (إن وُجد ملف .sha256 المرافق)
 *   - هوية المستأجر(ين) الموجودة في النسخة
 *
 * التشغيل: node scripts/verify-backup.js backups/backup-XXXX.json
 * كود الخروج: 0 = صالحة، 1 = غير صالحة (قابل للاستخدام في سكربتات آلية)
 */
const path = require('path');
const { validateBackupFile } = require('../lib/backupValidation');

function run() {
  const file = process.argv[2];
  if (!file) {
    console.error('الاستخدام: node scripts/verify-backup.js <ملف النسخة>');
    process.exit(1);
  }

  const result = validateBackupFile(path.resolve(file));

  console.log(`🔎 التحقق من: ${file}`);
  if (result.sizeBytes != null) console.log(`   الحجم: ${(result.sizeBytes / 1024).toFixed(1)} KB`);
  if (result.createdAt)   console.log(`   تاريخ الإنشاء: ${result.createdAt}`);
  if (result.version)     console.log(`   الإصدار: ${result.version}`);
  if (result.source)      console.log(`   المصدر: ${result.source}`);
  if (result.tenantIds)   console.log(`   المستأجرون: ${result.tenantIds.length ? result.tenantIds.join(', ') : '(لا يوجد)'}`);
  if (result.checksumOk !== null && result.checksumOk !== undefined) {
    console.log(`   checksum: ${result.checksumOk ? '✅ مطابق' : '❌ غير مطابق'}`);
  } else {
    console.log('   checksum: ⚠️  لا يوجد ملف .sha256 مرافق (لم يُنشأ بالنسخة الحديثة أو نُقل بدونه)');
  }

  if (result.ok) {
    console.log('\n✅ النسخة صالحة.');
    process.exit(0);
  } else {
    console.log('\n❌ النسخة غير صالحة:');
    for (const p of result.problems) console.log(`   - ${p}`);
    process.exit(1);
  }
}

run();
