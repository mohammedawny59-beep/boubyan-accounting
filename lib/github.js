'use strict';
/**
 * GitHub commit helper — makes apply-fix changes PERMANENT.
 *
 * لماذا؟ نظام ملفات Render مؤقت — أي تعديل على القرص يُمسح عند إعادة التشغيل.
 * الحل: نرفع التعديل مباشرة على GitHub عبر الـ Contents API، فيبقى للأبد
 * وينشره Render تلقائياً.
 *
 * الإعداد (مطلوب مرة واحدة):
 *   GITHUB_TOKEN   — توكن GitHub بصلاحية "repo" أو "Contents: write"
 *   GITHUB_REPO    — اختياري، مثل: mohammedawny59-beep/boubyan-accounting
 *                    (يُستنتج تلقائياً من remote إن لم يُحدَّد)
 *   GITHUB_BRANCH  — اختياري، الافتراضي: main
 */
const { execSync } = require('child_process');

function isConfigured() {
  return !!process.env.GITHUB_TOKEN;
}

// Resolve owner/repo from env or the local git remote.
function getRepo() {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO.replace(/\.git$/, '');
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {}
  return null;
}

function getBranch() {
  return process.env.GITHUB_BRANCH || 'main';
}

const API = 'https://api.github.com';

function authHeaders() {
  return {
    'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    'Accept':        'application/vnd.github+json',
    'User-Agent':    'boubyan-accounting-bot',
  };
}

/**
 * Commit a file's new content to GitHub (create-or-update).
 * Returns { committed:true, url, sha } or throws with a clear message.
 *
 * @param {string} filePath  repo-relative path, e.g. 'public/index.html'
 * @param {string} content   full new file content
 * @param {string} message   commit message
 */
async function commitFile(filePath, content, message) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN غير مضبوط — أضفه في إعدادات Render');
  const repo = getRepo();
  if (!repo) throw new Error('تعذّر تحديد مستودع GitHub — أضف GITHUB_REPO في الإعدادات');
  const branch = getBranch();
  const path = filePath.replace(/\\/g, '/');

  // 1. Get current file SHA (required to update an existing file)
  let sha = null;
  const getRes = await fetch(`${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${branch}`, {
    headers: authHeaders(),
  });
  if (getRes.status === 200) {
    const info = await getRes.json();
    sha = info.sha;
  } else if (getRes.status !== 404) {
    const t = await getRes.text();
    throw new Error(`GitHub قراءة الملف فشلت (${getRes.status}): ${t.slice(0, 120)}`);
  }

  // 2. PUT new content
  const putRes = await fetch(`${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!putRes.ok) {
    const t = await putRes.text();
    if (putRes.status === 401 || putRes.status === 403) {
      throw new Error('توكن GitHub غير صالح أو لا يملك صلاحية الكتابة — تحقق من التوكن');
    }
    throw new Error(`GitHub رفض الحفظ (${putRes.status}): ${t.slice(0, 160)}`);
  }

  const out = await putRes.json();
  return {
    committed: true,
    url: out.commit?.html_url || null,
    sha: out.content?.sha || null,
    repo, branch,
  };
}

module.exports = { isConfigured, getRepo, getBranch, commitFile };
