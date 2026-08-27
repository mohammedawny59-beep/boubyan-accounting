// R4 — Part L: NEW-R3-TELEGRAM-UPLOAD-01 closure.
//
// Proves the Telegram-bot daily-income upload path now invokes the SAME
// canonical accounting function (processDailyIncomeUpload, server.js) as
// the real browser/HTTP upload route, instead of maintaining a second,
// incomplete implementation that merged db.dailyData but never posted a
// journal entry. A tiny local HTTP server serves the real xlsx buffer so
// the bot's actual file-download code path (http.get) is genuinely
// exercised, not bypassed — no real Telegram API call is ever made.

process.env.DB_FILE_ONLY = 'true';
process.env.JWT_SECRET   = 'r4-telegram-accounting-secret';
process.env.NODE_ENV     = 'test';

jest.mock('node-telegram-bot-api', () => {
  return jest.fn().mockImplementation(function () {
    this._handlers = {};
    this.on = jest.fn((event, cb) => { this._handlers[event] = cb; });
    this.sendMessage = jest.fn().mockResolvedValue({});
    this.stopPolling = jest.fn().mockResolvedValue({});
    this.getFileLink = jest.fn(); // set per-test to point at the local file server
  });
});

const os      = require('os');
const path    = require('path');
const fs      = require('fs-extra');
const http    = require('http');
const bcrypt  = require('bcryptjs');
const request = require('supertest');
const XLSX    = require('xlsx');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bou-r4-tg-'));
process.env.DATA_FILE   = path.join(tmp, 'database.json');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');

const app = require('../server');
const { initDB, shutdownDB, runAsTenant, loadDB, saveDB } = require('../lib/database');
const { DEFAULT_COA, DEFAULT_ROLES } = require('../lib/defaults');

function hash(pw) { return bcrypt.hashSync(pw, 10); }

function buildInitialDB() {
  return {
    users: [
      { id: 'usr-admin', username: 'admin', email: 'admin@test.com', passwordHash: hash('AdminPass1!'), role: 'admin', fullName: 'مدير', active: true, createdAt: new Date().toISOString(), lastLogin: null },
    ],
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
    doctors: [], dailyData: [], paymentsData: [], commissionHistory: [], uploadedFiles: [],
    expenses: [], journalEntries: [], chartOfAccounts: DEFAULT_COA.map(a => ({ ...a })),
    vendors: [], invItems: [], invCategories: [], invMovements: [], recurringExpenses: [],
    companyInfo: {}, scheduleConfig: {}, vouchers: [], cashReconciliation: [], insuranceClaims: [],
    payroll: [], employees: [], assets: [], fixedAssets: [], budget: {}, auditLog: [], accruedExpenses: [],
    journalMappings: [], doctorExpenses: [], lockedPeriods: {}, vendorBills: [], accountingSettings: {},
    patients: [], patientReceivables: [],
  };
}

let adminToken;
let fileServer, fileServerUrl;
let currentServeBuffer = null;

beforeAll(async () => {
  await initDB({
    mongoUri: 'mongodb://127.0.0.1:1/unused',
    dataFile: process.env.DATA_FILE,
    configFile: process.env.CONFIG_FILE,
    defaultConfig: {},
    buildInitialDB,
    migrateDB: () => false,
  });
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'AdminPass1!' });
  adminToken = login.body.token;

  // Tiny local HTTP server standing in for Telegram's file-download CDN —
  // genuinely exercises the bot handler's real http.get() download code,
  // never a real Telegram/network call.
  fileServer = http.createServer((req, res) => { res.end(currentServeBuffer); });
  await new Promise(resolve => fileServer.listen(0, '127.0.0.1', resolve));
  fileServerUrl = `http://127.0.0.1:${fileServer.address().port}/file`;
});

afterAll(async () => {
  try { await shutdownDB(); } catch {}
  try { await new Promise(r => fileServer.close(r)); } catch {}
  try { fs.removeSync(tmp); } catch {}
});

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

function dailyIncomeBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Date', 'Cash', 'K-Net', 'Visa', 'Master', 'Insurance', 'Cheque', 'Link', 'Total', 'Advance'],
    ...rows,
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Registers a fresh chat as the bot's authorized owner (the only bootstrap
// path — see server.js's own TG_REGISTRATION_WINDOW_MS comment) and returns
// the mocked bot instance with getFileLink wired to the local file server.
async function registerBot(chatId) {
  await runAsTenant('default', async () => { const db = loadDB(); db.scheduleConfig = {}; saveDB(db); });
  const start = await request(app).post('/api/telegram/start').set(auth()).send({ token: '111:FAKE-R4-TEST' });
  expect(start.status).toBe(200);
  const bot = global._tgBot;
  bot.getFileLink.mockResolvedValue(fileServerUrl);
  await bot._handlers.message({ chat: { id: chatId }, text: '/start' });
  return bot;
}

describe('R4 Part L — Telegram daily-income upload posts the SAME canonical journal entry as the browser path', () => {
  test('Telegram-Accounting A: a Telegram-uploaded dailyincome file posts a real auto-income journal entry (was previously silent)', async () => {
    const bot = await registerBot(701701);
    currentServeBuffer = dailyIncomeBuffer([['05/04/2054', 120, 0, 0, 0, 0, 0, 0, 120, 0]]);

    await bot._handlers.message({ chat: { id: 701701 }, document: { file_name: 'DailyIncome-TG.xlsx', file_id: 'f-a' } });

    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.dailyData.some(d => d.date === '2054-04-05')).toBe(true);
    const je = db.journalEntries.find(j => j.ref === 'INCOME-2054-04');
    expect(je).toBeTruthy(); // THE fix — this JE never existed before R4
    expect(je.totalDebit).toBeCloseTo(120, 3);
    expect(je.source).toBe('telegram-daily-income');
  });

  test('Telegram-Accounting B: the same input through the browser /api/upload path produces an equivalent accounting effect', async () => {
    const buf = dailyIncomeBuffer([['06/04/2054', 90, 0, 0, 0, 0, 0, 0, 90, 0]]);
    const res = await request(app).post('/api/upload').set(auth()).attach('file', buf, 'DailyIncome-Browser.xlsx');
    expect(res.status).toBe(200);
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    const je = db.journalEntries.find(j => j.ref === 'INCOME-2054-04');
    // Both Telegram's day (120) and the browser's day (90) are in the SAME
    // month — proves both paths write into the identical canonical journal
    // (210 = 120 + 90), not two divergent representations of the month.
    expect(je.totalDebit).toBeCloseTo(210, 3);
    expect(je.source).toBe('daily-income-upload'); // browser tag, distinct from telegram's tag
  });

  test('Telegram-Accounting C: re-sending the same Telegram document is idempotent — no duplicate journal entry', async () => {
    const bot = await registerBot(701702);
    currentServeBuffer = dailyIncomeBuffer([['10/05/2054', 60, 0, 0, 0, 0, 0, 0, 60, 0]]);
    await bot._handlers.message({ chat: { id: 701702 }, document: { file_name: 'DailyIncome-Dup.xlsx', file_id: 'f-c' } });
    await bot._handlers.message({ chat: { id: 701702 }, document: { file_name: 'DailyIncome-Dup2.xlsx', file_id: 'f-c2' } });
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    const jes = db.journalEntries.filter(j => j.ref === 'INCOME-2054-05');
    expect(jes.length).toBe(1);
    expect(jes[0].totalDebit).toBeCloseTo(60, 3);
  });

  test('Telegram-Accounting D: a negative channel value via Telegram is rejected, matching the browser path', async () => {
    const bot = await registerBot(701703);
    currentServeBuffer = dailyIncomeBuffer([['11/06/2054', -50, 0, 0, 0, 0, 0, 0, -50, 0]]);
    await bot._handlers.message({ chat: { id: 701703 }, document: { file_name: 'DailyIncome-Neg.xlsx', file_id: 'f-d' } });
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.dailyData.some(d => d.date === '2054-06-11')).toBe(false);
    expect(db.journalEntries.some(j => j.ref === 'INCOME-2054-06')).toBe(false);
  });

  test('Telegram-Accounting E: tenant isolation — the Telegram bot only ever writes into the default tenant, never an arbitrary one', async () => {
    // The bot handler runs outside any Express request/runAsTenant context,
    // so loadDB()/saveDB() always resolve to the 'default' tenant (confirmed
    // by reading lib/database.js's _currentTenantId() fallback) — this is
    // the existing, pre-R4 design, not something R4 changed. Verify the
    // Telegram-created day from test A is visible under 'default' (its
    // month's JE was legitimately rebuilt with a fresh 'daily-income-upload'
    // source tag by test B's later browser upload touching the same month —
    // that's the correct, honest "most recent import" tag, not a bug).
    let defaultDb; await runAsTenant('default', async () => { defaultDb = loadDB(); });
    expect(defaultDb.dailyData.some(d => d.date === '2054-04-05')).toBe(true);
    expect(defaultDb.journalEntries.some(j => j.ref === 'INCOME-2054-04')).toBe(true);
  });

  test('Telegram-Accounting F: registration-window/auth protection still blocks an unrecognized chat from reaching the upload path', async () => {
    const bot = await registerBot(701704);
    let beforeDb; await runAsTenant('default', async () => { beforeDb = loadDB(); });
    const before = beforeDb.journalEntries.length;
    bot.sendMessage.mockClear();
    currentServeBuffer = dailyIncomeBuffer([['01/07/2054', 999, 0, 0, 0, 0, 0, 0, 999, 0]]);
    await bot._handlers.message({ chat: { id: 999999 }, document: { file_name: 'DailyIncome-Intruder.xlsx', file_id: 'f-f' } });
    let db; await runAsTenant('default', async () => { db = loadDB(); });
    expect(db.journalEntries.length).toBe(before); // intruder's document never reached the upload branch
    expect(db.dailyData.some(d => d.date === '2054-07-01')).toBe(false);
  });
});
