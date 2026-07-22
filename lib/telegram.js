'use strict';
/**
 * Telegram Approval Gateway — CLAUDE.md §4 Governance
 *
 * يرسل findings من نوع BLOCKING إلى Telegram ويسجّلها
 * في pending-approvals.json بانتظار الرد.
 *
 * لا ينشر أي شيء مباشرة — يُنبّه فقط.
 * النشر الفعلي يتطلب /approve <id> من المستخدم في Telegram.
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT         = path.join(__dirname, '..');
const APPROVALS_FILE = path.join(ROOT, '.agent-memory', 'pending-approvals.json');

function getConfig() {
  return {
    token:  process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  };
}

function isConfigured() {
  const { token, chatId } = getConfig();
  return !!(token && chatId);
}

// Low-level send — avoids axios dependency
function _sendRaw(token, chatId, text, parseMode = 'Markdown') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function _loadApprovals() {
  try {
    if (fs.existsSync(APPROVALS_FILE)) return JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

function _saveApprovals(data) {
  const dir = path.dirname(APPROVALS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = APPROVALS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, APPROVALS_FILE);
}

/**
 * Send a BLOCKING finding to Telegram for approval.
 * Returns the approval ID (use to track status).
 */
async function sendApprovalRequest({ deptName, deptNameAr, finding }) {
  const { token, chatId } = getConfig();
  const id = `${deptName}_${Date.now()}`;

  const msg = [
    `🔴 *طلب موافقة — BLOCKING*`,
    ``,
    `*القسم:* ${deptNameAr}`,
    `*المشكلة:* ${finding.title}`,
    `*الخطورة:* ${finding.severity}`,
    ``,
    `*التفاصيل:*`,
    finding.detail,
    ``,
    `*التوصية:*`,
    finding.recommendation,
    ``,
    `─────────────────`,
    `للموافقة: /approve ${id}`,
    `للرفض:   /reject ${id}`,
    ``,
    `_CLAUDE.md §4 — يتوقف التنفيذ حتى ردّك_`,
  ].join('\n');

  // Store in pending approvals
  const approvals = _loadApprovals();
  approvals[id] = {
    id,
    dept:        deptName,
    deptAr:      deptNameAr,
    finding:     { title: finding.title, severity: finding.severity, recommendation: finding.recommendation },
    status:      'pending',
    createdAt:   new Date().toISOString(),
    resolvedAt:  null,
    resolvedBy:  null,
  };
  _saveApprovals(approvals);

  if (token && chatId) {
    try {
      await _sendRaw(token, chatId, msg);
    } catch (e) {
      process.stderr.write(`[telegram] فشل الإرسال: ${e.message}\n`);
    }
  } else {
    process.stderr.write(`[telegram] غير مهيأ — TELEGRAM_BOT_TOKEN أو TELEGRAM_CHAT_ID مفقود. الـ finding محفوظ: ${id}\n`);
  }

  return id;
}

/**
 * Send a simple notification (NOTIFY level — no approval needed).
 */
async function sendNotification({ deptNameAr, title, detail }) {
  const { token, chatId } = getConfig();
  if (!token || !chatId) return;

  const msg = [
    `🟡 *إشعار — ${deptNameAr}*`,
    ``,
    `*${title}*`,
    detail,
  ].join('\n');

  try { await _sendRaw(token, chatId, msg); }
  catch (e) { process.stderr.write(`[telegram] فشل الإشعار: ${e.message}\n`); }
}

/**
 * Process /approve or /reject command from Telegram webhook.
 * Returns { found, id, action } or null.
 */
function processCommand(text) {
  const m = (text || '').match(/^\/(approve|reject)\s+(\S+)/i);
  if (!m) return null;

  const action = m[1].toLowerCase(); // 'approve' | 'reject'
  const id     = m[2];

  const approvals = _loadApprovals();
  if (!approvals[id]) return { found: false, id, action };

  approvals[id].status     = action === 'approve' ? 'approved' : 'rejected';
  approvals[id].resolvedAt = new Date().toISOString();
  _saveApprovals(approvals);

  return { found: true, id, action, item: approvals[id] };
}

function getPendingApprovals() {
  const all = _loadApprovals();
  return Object.values(all).filter(a => a.status === 'pending');
}

module.exports = { sendApprovalRequest, sendNotification, processCommand, getPendingApprovals, isConfigured };
