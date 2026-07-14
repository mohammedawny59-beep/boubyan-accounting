// اختبار الاستعادة الدوري (CLAUDE.md مرحلة 5):
// النسخة الاحتياطية لا قيمة لها ما لم تثبت الاستعادة أنها تعمل فعلاً.
// دورة كاملة: بيانات → نسخ → إتلاف متعمد → استعادة → تطابق بالحرف.

const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-bak-'));
const dataFile = path.join(tmp, 'database.json');
const cfgFile = path.join(tmp, 'config.json');
const backupDir = path.join(tmp, 'backups');

const ORIGINAL = {
  journalEntries: [{ id: 'JE-BK-1', desc: 'قيد أصلي قبل النسخ', date: '2026-01-01', lines: [] }],
  chartOfAccounts: [{ id: '1100', code: '1100', name: 'الصندوق', type: 'asset' }],
  users: [{ id: 'u1', username: 'admin' }],
};

const env = {
  ...process.env,
  MONGO_URI: '',            // وضع الملفات — لا يلمس Mongo
  DATA_FILE: dataFile,
  CONFIG_FILE: cfgFile,
  BACKUP_DIR: backupDir,
  BACKUP_KEEP: '5',
  RESTORE_YES: '1',         // غير تفاعلي
};

afterAll(() => { try { fs.removeSync(tmp); } catch {} });

describe('النسخ الاحتياطي والاستعادة — دورة كاملة', () => {
  test('نسخ → إتلاف → استعادة → البيانات تعود بالحرف', () => {
    // 1) بيانات أصلية
    fs.writeJsonSync(dataFile, ORIGINAL, { spaces: 2 });
    fs.writeJsonSync(cfgFile, { companyName: 'شركة الاختبار' }, { spaces: 2 });

    // 2) نسخ احتياطي
    execSync('node scripts/backup.js', { cwd: ROOT, env, stdio: 'pipe' });
    const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('backup-'));
    expect(backups.length).toBe(1);

    // النسخة تحتوي البيانات فعلاً
    const payload = fs.readJsonSync(path.join(backupDir, backups[0]));
    expect(payload.source).toBe('file');
    expect(payload.database.journalEntries[0].id).toBe('JE-BK-1');

    // 3) إتلاف متعمد (محاكاة كارثة)
    fs.writeJsonSync(dataFile, { journalEntries: [], chartOfAccounts: [], users: [] });
    expect(fs.readJsonSync(dataFile).journalEntries.length).toBe(0);

    // 4) استعادة
    execSync(`node scripts/restore.js "${path.join(backupDir, backups[0])}"`, { cwd: ROOT, env, stdio: 'pipe' });

    // 5) البيانات عادت بالحرف
    const restored = fs.readJsonSync(dataFile);
    expect(restored).toEqual(ORIGINAL);
    expect(fs.readJsonSync(cfgFile).companyName).toBe('شركة الاختبار');
  });

  test('التدوير: لا يُحتفظ بأكثر من BACKUP_KEEP نسخ', () => {
    for (let i = 0; i < 7; i++) {
      // طابع الوقت بدقة ثانية — نضمن اسماً مختلفاً لكل نسخة
      execSync('node scripts/backup.js', { cwd: ROOT, env, stdio: 'pipe' });
      const now = Date.now(); while (Date.now() - now < 1100) { /* انتظار ثانية */ }
    }
    const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('backup-'));
    expect(backups.length).toBeLessThanOrEqual(5);
  });
});
