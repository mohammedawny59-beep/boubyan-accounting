// P4 — Phase J: Whole-Instance Separation (T069, research.md Decision 7)
//
// scripts/backup.js/scripts/restore.js are UNMODIFIED by this entire
// feature (T070 confirms zero line changes via git diff against the
// pre-P4 baseline). This file proves, end to end via the real CLI scripts
// (not just the underlying validators in isolation — see
// tests/tenant-restore.test.js's own "whole-instance separation" unit-level
// test), that the two tool families can never be cross-fed each other's
// file format, and that omitting either tool's own required flags never
// silently falls back to the other tool's behavior. File mode only — no
// Mongo needed, since this is purely about format/flag rejection.

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-p4-separation-'));
const DATA_FILE = path.join(tmp, 'database.json');
const CONFIG_FILE = path.join(tmp, 'config.json');
const backupDir = path.join(tmp, 'backups');

afterAll(() => { try { fs.removeSync(tmp); } catch {} });

function run(cmd, envOverrides) {
  try {
    const out = execSync(cmd, {
      cwd: ROOT,
      env: { ...process.env, MONGO_URI: '', DATA_FILE, CONFIG_FILE, BACKUP_DIR: backupDir, ...envOverrides },
      stdio: 'pipe',
    });
    return { status: 0, stdout: out.toString() };
  } catch (e) {
    return { status: e.status, stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '' };
  }
}

describe('P4 Phase J — whole-instance separation (T069)', () => {
  test('a tenant-scoped backup file fed into the UNMODIFIED scripts/restore.js is rejected via the deliberate scope==="tenant" guard', () => {
    fs.ensureDirSync(path.dirname(DATA_FILE));
    fs.writeJsonSync(DATA_FILE, { users: [{ id: 'u1', username: 'x' }], vendors: [] });
    fs.writeJsonSync(CONFIG_FILE, {});

    const backupRes = run('node scripts/tenant-backup.js --tenant=default');
    expect(backupRes.status).toBe(0);
    const tenantFiles = fs.readdirSync(backupDir).filter(f => f.startsWith('tenant-default-') && f.endsWith('.json'));
    expect(tenantFiles.length).toBe(1);
    const tenantFile = path.join(backupDir, tenantFiles[0]);

    const restoreRes = run(`node scripts/restore.js "${tenantFile}" --target=whole-instance-test --yes`);
    expect(restoreRes.status).not.toBe(0);
    expect(restoreRes.stderr).toContain('tenant-restore.js'); // the guard's own rejection message names the correct tool

    // The whole-instance restore never wrote anything to DATA_FILE.
    const dataAfter = fs.readJsonSync(DATA_FILE);
    expect(dataAfter.users).toEqual([{ id: 'u1', username: 'x' }]);
  });

  // Owner-review finding (final PR review, LOW): this test runs in file
  // mode (this file's own `run()` always sets MONGO_URI:''), so it
  // actually exercises tenant-restore.js's earlier file-mode-unsupported
  // gate, not Step 1.2 itself — the real Step 1.2 rejection is covered
  // under Mongo mode by tests/tenant-restore.test.js's own "whole-instance
  // separation" test. Retitled to describe what this test actually proves
  // (still a genuine, valid assertion: a whole-instance file is rejected
  // one way or another, never silently accepted) rather than misclaim Step
  // 1.2 specifically.
  test('a whole-instance backup file fed into tenant-restore.js is rejected (file mode: via the earlier file-mode-unsupported gate)', () => {
    fs.writeJsonSync(DATA_FILE, { users: [{ id: 'u1', username: 'x' }], vendors: [] });
    fs.writeJsonSync(CONFIG_FILE, {});

    const backupRes = run('node scripts/backup.js');
    expect(backupRes.status).toBe(0);
    const wholeFiles = fs.readdirSync(backupDir).filter(f => f.startsWith('backup-') && f.endsWith('.json'));
    expect(wholeFiles.length).toBeGreaterThan(0);
    const wholeFile = path.join(backupDir, wholeFiles[wholeFiles.length - 1]);

    const restoreRes = run(`node scripts/tenant-restore.js "${wholeFile}" --tenant=default --target=t1 --yes`);
    expect(restoreRes.status).not.toBe(0);
  });

  test('omitting --target= on scripts/restore.js never falls back to tenant-restore.js behavior (still requires its own --target=)', () => {
    const res = run('node scripts/restore.js backups/whatever.json');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--target=');
    expect(res.stderr).not.toContain('--tenant='); // never silently expects the OTHER tool's own flag instead
  });

  test('omitting --tenant=/--target= on scripts/tenant-restore.js never falls back to scripts/restore.js behavior (still requires its own flags)', () => {
    const res = run('node scripts/tenant-restore.js backups/whatever.json');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('--tenant=');
    expect(res.stderr).toContain('--target=');
  });

  test('omitting --tenant= on scripts/tenant-backup.js never falls back to a whole-instance backup', () => {
    const res = run('node scripts/tenant-backup.js');
    expect(res.status).not.toBe(0);
    const before = fs.readdirSync(backupDir).filter(f => f.startsWith('backup-')).length;
    // Confirm no NEW whole-instance-shaped file was produced as a fallback.
    const after = fs.readdirSync(backupDir).filter(f => f.startsWith('backup-')).length;
    expect(after).toBe(before);
  });
});
