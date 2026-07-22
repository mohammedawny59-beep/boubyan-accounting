'use strict';
/**
 * Isolated sandbox instance for the system-tester.
 *
 * Boots a SECOND copy of the app against a throwaway database file in a temp
 * directory (DB_FILE_ONLY — never touches MongoDB, never touches the real
 * data/database.json). The tester drives this instance via HTTP: it can create
 * accounts, post journal entries, run reports — and if anything goes wrong,
 * only the disposable sandbox is affected. Real production data is physically
 * separate and untouched (CLAUDE.md security rule).
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const net  = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Start an isolated sandbox server.
 * @param {object} opts
 * @param {object} [opts.seed]  db keys to seed (e.g. { chartOfAccounts: [...] })
 * @param {function} [opts.log] progress logger
 * @returns {Promise<{baseUrl,token,stop,tmpDir}>}
 */
async function startSandbox({ seed = {}, log = () => {} } = {}) {
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'boubyan-sandbox-'));
  const dataFile = path.join(tmpDir, 'database.json');
  const cfgFile  = path.join(tmpDir, 'config.json');
  const PASSWORD = 'Sandbox@Test123';

  // Seed the throwaway DB (only what the caller passes — everything else empty)
  fs.writeFileSync(dataFile, JSON.stringify(seed, null, 2), 'utf8');
  fs.writeFileSync(cfgFile, JSON.stringify({}, null, 2), 'utf8');

  const port = await findFreePort();

  // Child env: force file-only, isolated files, disable Telegram (avoid polling
  // clash with the real bot), keep JWT_SECRET so tokens verify.
  const env = { ...process.env,
    PORT: String(port),
    DATA_FILE: dataFile,
    CONFIG_FILE: cfgFile,
    DB_FILE_ONLY: 'true',
    ADMIN_DEFAULT_PASSWORD: PASSWORD,
    JWT_SECRET: process.env.JWT_SECRET || 'sandbox-secret',
  };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.MONGO_URI;

  log(`🧪 أُقلع بيئة تجريبية معزولة على منفذ ${port}...`);
  const child = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'] });

  const baseUrl = `http://127.0.0.1:${port}`;
  let token = null;

  // Wait for boot: poll login until it succeeds (or time out)
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (child.exitCode !== null) throw new Error('توقّفت البيئة التجريبية أثناء الإقلاع');
    try {
      const r = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: PASSWORD }),
      });
      if (r.ok) { const d = await r.json(); token = d.token; break; }
    } catch { /* not up yet */ }
  }
  if (!token) { try { child.kill(); } catch {} throw new Error('تعذّر تسجيل الدخول للبيئة التجريبية (لم تُقلع)'); }

  log('✅ البيئة التجريبية جاهزة — أبدأ التجارب...');

  function stop() {
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  return { baseUrl, token, stop, tmpDir, port };
}

module.exports = { startSandbox };
