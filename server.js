require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initDB, loadDB, saveDB, loadConfig, saveConfig, shutdownDB,
} = require('./lib/database');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== PATHS =====
const DATA_FILE   = path.join(__dirname, 'data', 'database.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.ensureDirSync(path.join(__dirname, 'data'));
fs.ensureDirSync(UPLOADS_DIR);

// ===== MONGODB =====
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/boubyan_accounting';

// ===== CONFIG HELPERS =====
const DEFAULT_CONFIG = {
  brand: { name: 'بوبيان لطب الأسنان', tagline: 'نظام المحاسبة والمالية' },
  modules: { dashboard:true, upload:true, import:true, manual:true, vouchers:true, cashrecon:true,
    insurance:true, payroll:true, doctors:true, expenses:true, vendors:true, journal:true,
    coa:true, financials:true, trialbalance:true, opening:true, bankrecon:true, assets:true,
    reports:true, ledger:true, inventory:true, ai:true, users:true, telegram:true, settings:true },
  labels: { agents:'الدكاترة', agent:'دكتور', agentsTab:'عمولات الدكاترة',
    agentsSubtitle:'محسوبة تلقائياً — تراكمية', commission:'العمولة', target:'الهدف الشهري',
    lab:'خصم المختبر', insurance:'التأمين', revenue:'الإيراد', agentIdField:'اسم الدكتور' },
  nav: { 'cat.main':'الرئيسية','cat.finance':'العمليات المالية','cat.accounting':'المحاسبة',
    'cat.reports':'التقارير','cat.inventory':'المخزون','cat.ai':'الذكاء الاصطناعي','cat.admin':'النظام',
    dashboard:'لوحة التحكم', upload:'رفع البيانات', import:'استيراد Excel', manual:'إدخال يدوي',
    vouchers:'السندات', cashrecon:'تسوية الصندوق', insurance:'مطالبات التأمين', payroll:'الرواتب',
    doctors:'الدكاترة', expenses:'المصاريف', vendors:'الموردون', journal:'القيود اليومية',
    coa:'دليل الحسابات', financials:'القوائم المالية', trialbalance:'ميزان المراجعة',
    opening:'الأرصدة الافتتاحية', bankrecon:'التسوية البنكية', assets:'الأصول الثابتة',
    reports:'التقارير', ledger:'دفتر الأستاذ', inventory:'المخزون', ai:'الذكاء الاصطناعي',
    users:'المستخدمون', telegram:'تيليجرام', settings:'الإعدادات' },
  commissionFormula: { base:'above_target', deductions:['lab'], method:'percentage',
    tiers:[{from:0,to:3000,rate:15},{from:3000,to:6000,rate:20},{from:6000,to:null,rate:25}] },
  dashboard: { kpi: {
    kTotal:'إجمالي الإيرادات', kNet:'صافي (بدون تأمين)', kIns:'حصة التأمين',
    kComm:'إجمالي العمولات', kPend:'عمولات معلّقة'
  }},
  importTemplates: {
    expenses:'المصاريف', inventory:'الأرصدة الافتتاحية للمخزون',
    doctors:'مدفوعات الدكاترة', journal:'قيود يومية جماعية', patients:'أرصدة المرضى الافتتاحية'
  },
  automation: {
    dailySummary:      { enabled: true,  hour: 20 },
    inventoryAlert:    { enabled: true },
    targetAlert:       { enabled: true },
    pendingReminder:   { enabled: true,  dayOfWeek: 4 },
    insuranceAlert:    { enabled: true,  daysThreshold: 30 },
    closingReminder:   { enabled: true,  daysBeforeEnd: 3 },
    anomalyDetection:  { enabled: true,  multiplier: 2.0 },
    revenueVariance:   { enabled: true,  threshold: 30 },
    doctorRanking:     { enabled: true },
    goalProgress:      { enabled: true }
  }
};

// Safe unique ID — timestamp + random suffix to prevent collision under concurrent load
function genId(prefix = '') {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ===== SECURITY MIDDLEWARE =====

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data:; " +
    "connect-src 'self';"
  );
  next();
});

// CORS — restrict to same origin in production
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Optional machine-to-machine API key — browser SPA uses JWT instead.
const API_SECRET = process.env.API_SECRET;
app.use('/api', (req, res, next) => {
  if (!API_SECRET) return next();
  // Public login + JWT-authenticated SPA requests must not require x-api-secret.
  if (req.path.startsWith('/auth/')) return next();
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) return next();
  const token = req.headers['x-api-secret'] || req.query._secret;
  if (token !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Rate limiting — max 200 req/min per IP for API, 10/min for AI endpoints
const rateCounts = new Map();
// Cleanup old entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateCounts.entries()) {
    if (now - entry.start > 120000) rateCounts.delete(key);
  }
}, 5 * 60 * 1000);

function rateLimit(max, windowMs = 60000) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const entry = rateCounts.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
    entry.count++;
    rateCounts.set(key, entry);
    if (entry.count > max) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}
app.use('/api/ai', rateLimit(10));  // 10 AI calls/min
app.use('/api', rateLimit(200));    // 200 API calls/min

// Body size limit + depth limit (prevent deeply nested JSON DoS)
app.use(express.json({ limit: '5mb', strict: true }));
app.use(express.static(path.join(__dirname, 'public')));

// File upload — restrict to Excel only, max 10MB
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('Only Excel files allowed'));
    cb(null, true);
  }
});

// Sanitize string helper — encode HTML entities to prevent XSS
function sanitize(val, maxLen = 500) {
  if (typeof val !== 'string') return val;
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .substring(0, maxLen);
}
// Reverse for display (when data is already sanitized and we need the original)
function desanitize(val) {
  if (typeof val !== 'string') return val;
  return val
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
}

// ===== JWT =====
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    console.error('🚨 FATAL: JWT_SECRET not set in production!');
    process.exit(1);
  }
  console.warn('⚠️  JWT_SECRET not set — using insecure default (dev only)');
  return 'boubyan-dental-dev-only-NOT-for-production';
})();
const JWT_EXPIRES = '12h';

// All 18 tabs and their possible actions
const ALL_TABS = ['dashboard','upload','manual','doctors','expenses','vendors','reports','vouchers','cashrecon','insurance','payroll','journal','coa','ledger','recurring','financials','inventory','telegram','settings','ai'];
const ALL_ACTIONS = ['view','add','edit','delete','export'];

// ═══════════════════════════════════════════════════
// DEFAULT CHART OF ACCOUNTS — عيادة الأسنان (Kuwait)
// ═══════════════════════════════════════════════════
const DEFAULT_COA = [
  // ── الأصول المتداولة ──────────────────────────────
  { id:'1000', code:'1000', name:'الأصول',              type:'asset',    parent:null, isGroup:true, balance:0 },
  { id:'1100', code:'1100', name:'الصندوق — نقدي',      type:'asset',    parent:'1000', balance:0 },
  { id:'1110', code:'1110', name:'البنك — الحساب الجاري',             type:'asset', parent:'1000', balance:0 },
  { id:'1120', code:'1120', name:'K-Net / Visa / Master — مستحقات',  type:'asset', parent:'1000', balance:0 },
  { id:'1130', code:'1130', name:'ذمم مدينة — شركات التأمين',        type:'asset', parent:'1000', balance:0 },
  { id:'1200', code:'1200', name:'الذمم المدينة — مرضى', type:'asset',   parent:'1000', balance:0 },
  { id:'1210', code:'1210', name:'مطالبات التأمين المعلقة', type:'asset', parent:'1000', balance:0 },
  { id:'1300', code:'1300', name:'المخزون — مستلزمات طبية', type:'asset', parent:'1000', balance:0 },
  { id:'1400', code:'1400', name:'مصاريف مدفوعة مقدماً', type:'asset',  parent:'1000', balance:0 },
  // ── الأصول الثابتة ────────────────────────────────
  { id:'1500', code:'1500', name:'الأصول الثابتة',      type:'asset',    parent:'1000', isGroup:true, balance:0 },
  { id:'1510', code:'1510', name:'معدات وأجهزة طبية',   type:'asset',    parent:'1500', balance:0 },
  { id:'1520', code:'1520', name:'أثاث وتجهيزات',       type:'asset',    parent:'1500', balance:0 },
  { id:'1530', code:'1530', name:'أجهزة حاسوب ومعدات مكتبية', type:'asset', parent:'1500', balance:0 },
  { id:'1590', code:'1590', name:'(-) مجمع الإهلاك',   type:'asset',    parent:'1500', balance:0 },
  // ── الالتزامات ────────────────────────────────────
  { id:'2000', code:'2000', name:'الالتزامات',           type:'liability', parent:null, isGroup:true, balance:0 },
  { id:'2100', code:'2100', name:'الذمم الدائنة — موردون', type:'liability', parent:'2000', balance:0 },
  { id:'2200', code:'2200', name:'الرواتب المستحقة الدفع', type:'liability', parent:'2000', balance:0 },
  { id:'2300', code:'2300', name:'إيجار مستحق',          type:'liability', parent:'2000', balance:0 },
  { id:'2400', code:'2400', name:'قرض بنكي',             type:'liability', parent:'2000', balance:0 },
  { id:'2500', code:'2500', name:'أمانات ودفعات مقدمة مرضى', type:'liability', parent:'2000', balance:0 },
  // ── حقوق الملكية ─────────────────────────────────
  { id:'3000', code:'3000', name:'حقوق الملكية',         type:'equity',   parent:null, isGroup:true, balance:0 },
  { id:'3100', code:'3100', name:'رأس المال',            type:'equity',   parent:'3000', balance:0 },
  { id:'3200', code:'3200', name:'الأرباح المحتجزة',     type:'equity',   parent:'3000', balance:0 },
  { id:'3300', code:'3300', name:'أرباح/خسائر الفترة الحالية', type:'equity', parent:'3000', balance:0 },
  // ── الإيرادات ─────────────────────────────────────
  { id:'4000', code:'4000', name:'الإيرادات',                    type:'revenue', parent:null,   isGroup:true, balance:0 },
  { id:'4100', code:'4100', name:'إيرادات نقدية — كاش',          type:'revenue', parent:'4000', balance:0 },
  { id:'4110', code:'4110', name:'إيرادات K-Net',                type:'revenue', parent:'4000', balance:0 },
  { id:'4120', code:'4120', name:'إيرادات Visa',                 type:'revenue', parent:'4000', balance:0 },
  { id:'4130', code:'4130', name:'إيرادات Master',               type:'revenue', parent:'4000', balance:0 },
  { id:'4140', code:'4140', name:'إيرادات Link',                 type:'revenue', parent:'4000', balance:0 },
  { id:'4150', code:'4150', name:'إيرادات تأمين — إجمالي',       type:'revenue', parent:'4000', balance:0 },
  { id:'4160', code:'4160', name:'إيرادات شيكات',                type:'revenue', parent:'4000', balance:0 },
  { id:'4200', code:'4200', name:'إيرادات أخرى',                 type:'revenue', parent:'4000', balance:0 },
  // ── المصاريف ─────────────────────────────────────
  { id:'5000', code:'5000', name:'المصاريف',             type:'expense',  parent:null, isGroup:true, balance:0 },
  { id:'5100', code:'5100', name:'رواتب وأجور',          type:'expense',  parent:'5000', balance:0 },
  { id:'5110', code:'5110', name:'راتب الكادر الطبي',    type:'expense',  parent:'5100', balance:0 },
  { id:'5120', code:'5120', name:'راتب الكادر الإداري',  type:'expense',  parent:'5100', balance:0 },
  { id:'5200', code:'5200', name:'تكلفة المواد والمستلزمات', type:'expense', parent:'5000', balance:0 },
  { id:'5210', code:'5210', name:'مواد مختبر أسنان',     type:'expense',  parent:'5200', balance:0 },
  { id:'5220', code:'5220', name:'مستلزمات طبية',        type:'expense',  parent:'5200', balance:0 },
  { id:'5300', code:'5300', name:'إيجار العيادة',         type:'expense',  parent:'5000', balance:0 },
  { id:'5400', code:'5400', name:'مرافق — كهرباء وماء',  type:'expense',  parent:'5000', balance:0 },
  { id:'5500', code:'5500', name:'صيانة وإصلاح',         type:'expense',  parent:'5000', balance:0 },
  { id:'5600', code:'5600', name:'تسويق وإعلان',         type:'expense',  parent:'5000', balance:0 },
  { id:'5700', code:'5700', name:'مصاريف إدارية عمومية', type:'expense',  parent:'5000', balance:0 },
  { id:'5710', code:'5710', name:'هاتف وإنترنت',         type:'expense',  parent:'5700', balance:0 },
  { id:'5720', code:'5720', name:'إقامات وتأشيرات',      type:'expense',  parent:'5700', balance:0 },
  { id:'5730', code:'5730', name:'تأمين طبي وعمالي',     type:'expense',  parent:'5700', balance:0 },
  { id:'5740', code:'5740', name:'قرطاسية ومطبوعات',     type:'expense',  parent:'5700', balance:0 },
  { id:'5750', code:'5750', name:'مصاريف بنكية وعمولات', type:'expense',  parent:'5700', balance:0 },
  { id:'5800', code:'5800', name:'إهلاك الأصول الثابتة', type:'expense',  parent:'5000', balance:0 },
  { id:'5900', code:'5900', name:'مصاريف أخرى متنوعة',   type:'expense',  parent:'5000', balance:0 },
];

// Default role templates
const DEFAULT_ROLES = {
  admin: {
    name: 'مدير النظام',
    color: '#4f8ef7',
    tabs: ALL_TABS,
    actions: Object.fromEntries(ALL_TABS.map(t => [t, ALL_ACTIONS]))
  },
  accountant: {
    name: 'محاسب',
    color: '#2dd4bf',
    tabs: ['dashboard','manual','expenses','vendors','vouchers','cashrecon','insurance','payroll','journal','coa','ledger','recurring','financials','reports','ai'],
    actions: {
      dashboard: ['view','export'], manual: ['view','add'], expenses: ['view','add','edit'],
      vendors: ['view','add','edit'], vouchers: ['view','add','edit','delete'],
      cashrecon: ['view','add'], insurance: ['view','add','edit'],
      payroll: ['view','add','edit'], journal: ['view','add','edit'],
      coa: ['view','add','edit'], ledger: ['view','export'],
      recurring: ['view','add','edit','delete'], financials: ['view','export'],
      reports: ['view','export'], ai: ['view']
    }
  },
  receptionist: {
    name: 'موظف استقبال',
    color: '#fbbf24',
    tabs: ['dashboard','manual','reports'],
    actions: {
      dashboard: ['view'], manual: ['view','add'], reports: ['view']
    }
  },
  inventory: {
    name: 'مسؤول مخزون',
    color: '#a78bfa',
    tabs: ['dashboard','inventory'],
    actions: {
      dashboard: ['view'], inventory: ['view','add','edit']
    }
  },
  viewer: {
    name: 'مشاهد فقط',
    color: '#94a3b8',
    tabs: ['dashboard','reports','financials'],
    actions: {
      dashboard: ['view'], reports: ['view','export'], financials: ['view']
    }
  }
};

// Auth middleware — verifies JWT on all /api routes except /api/auth/*
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  // Also accept token as query param (for direct-download links like Excel/PPTX)
  const token = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query._token || null;
  if (!token) return res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'انتهت جلسة العمل — يرجى تسجيل الدخول مجدداً' });
  }
}

// Permission check helper
function can(user, tab, action = 'view') {
  if (user.role === 'admin') return true;
  const db = loadDB();
  const roleObj = (db.roles || {})[user.role] || DEFAULT_ROLES[user.role];
  if (!roleObj) return false;
  const allowed = (roleObj.actions || {})[tab] || [];
  return allowed.includes(action);
}

// ===== DATABASE (MongoDB-backed, in-memory cache for sync access) =====
function buildInitialDB() {
  return {
    users: [],
    roles: {
      admin:       { ...DEFAULT_ROLES.admin,       id: 'admin' },
      accountant:  { ...DEFAULT_ROLES.accountant,  id: 'accountant' },
      receptionist:{ ...DEFAULT_ROLES.receptionist,id: 'receptionist' },
      inventory:   { ...DEFAULT_ROLES.inventory,   id: 'inventory' },
      viewer:      { ...DEFAULT_ROLES.viewer,       id: 'viewer' },
    },
    doctors: [
      { name: 'DR.NASSER',      target: 4000, commission: 20, lab: 10, insurance: 45 },
      { name: 'DR.KAMAL',       target: 3500, commission: 20, lab: 8,  insurance: 45 },
      { name: 'Dr.VASIM',       target: 3000, commission: 20, lab: 12, insurance: 45 },
      { name: 'DR. ABDULWAHAB', target: 2000, commission: 15, lab: 5,  insurance: 45 },
      { name: 'DR.SAJEDA',      target: 2000, commission: 15, lab: 5,  insurance: 45 },
    ],
    dailyData: [],
    paymentsData: [],
    commissionHistory: [],
    uploadedFiles: [],
    expenses: [],
    journalEntries: [],
    chartOfAccounts: [],
    vendors: [],
    invItems: [],
    invCategories: [],
    invMovements: [],
    recurringExpenses: [],
    companyInfo: {},
    scheduleConfig: { weeklyReport: true, weeklyDay: 0, monthlyReport: true },
    vouchers: [],
    cashReconciliation: [],
    insuranceClaims: [],
    payroll: [],
    employees: []
  };
}

// Apply idempotent migrations/seeds to a db object. Returns true if mutated.
function migrateDB(db) {
  let changed = false;
  if (!db.chartOfAccounts || db.chartOfAccounts.length === 0) {
    db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
    changed = true;
  } else {
    // Fix misnamed accounts and add missing ones
    const coaFixes = {
      '4100': 'إيرادات نقدية — كاش',
      '4110': 'إيرادات K-Net',
      '4120': 'إيرادات Visa',
      '4130': 'إيرادات Master',
      '4140': 'إيرادات Link',
      '1110': 'البنك — الحساب الجاري',
      '1120': 'K-Net / Visa / Master — مستحقات',
      '1130': 'ذمم مدينة — شركات التأمين',
    };
    for (const [code, correctName] of Object.entries(coaFixes)) {
      const acc = db.chartOfAccounts.find(a => a.code === code);
      if (acc && acc.name !== correctName) { acc.name = correctName; changed = true; }
    }
    // Add missing revenue accounts
    const newAccounts = [
      { id:'4150', code:'4150', name:'إيرادات تأمين — إجمالي', type:'revenue', parent:'4000', balance:0 },
      { id:'4160', code:'4160', name:'إيرادات شيكات',           type:'revenue', parent:'4000', balance:0 },
    ];
    for (const acc of newAccounts) {
      if (!db.chartOfAccounts.find(a => a.code === acc.code)) {
        db.chartOfAccounts.push({ ...acc });
        changed = true;
      }
    }
  }
  if (!db.users || db.users.length === 0) {
    const adminHash = bcrypt.hashSync(process.env.ADMIN_DEFAULT_PASSWORD || 'Admin@2026', 10);
    db.users = [{
      id: 'usr-1',
      username: (process.env.ADMIN_DEFAULT_USERNAME || 'admin').trim(),
      email: (process.env.ADMIN_DEFAULT_EMAIL || 'admin@boubyan.com').trim(),
      passwordHash: adminHash, role: 'admin',
      fullName: process.env.ADMIN_DEFAULT_FULLNAME || 'مدير النظام', active: true,
      createdAt: new Date().toISOString(), lastLogin: null
    }];
    db.roles = {
      admin:       { ...DEFAULT_ROLES.admin,        id: 'admin' },
      accountant:  { ...DEFAULT_ROLES.accountant,   id: 'accountant' },
      receptionist:{ ...DEFAULT_ROLES.receptionist, id: 'receptionist' },
      inventory:   { ...DEFAULT_ROLES.inventory,    id: 'inventory' },
      viewer:      { ...DEFAULT_ROLES.viewer,        id: 'viewer' },
    };
    changed = true;
  }
  return changed;
}

['SIGINT', 'SIGTERM'].forEach(sig =>
  process.once(sig, () => { shutdownDB().finally(() => process.exit(0)); }));

// ===== EXCEL PARSER =====
function parseDailyIncome(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  
  const records = [];
  
  // Find header row and map column positions
  let colMap = null;
  let headerRowIdx = -1;
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowStr = row.map(c => String(c)).join('|').toLowerCase();
    if (rowStr.includes('date') && rowStr.includes('cash') && rowStr.includes('k-net')) {
      headerRowIdx = i;
      // Map columns by name
      colMap = {};
      for (let j = 0; j < row.length; j++) {
        const h = String(row[j]).trim().toLowerCase();
        if (h === 'date') colMap.date = j;
        else if (h === 'cash') colMap.cash = j;
        else if (h === 'k-net') colMap.knet = j;
        else if (h === 'visa') colMap.visa = j;
        else if (h === 'master') colMap.master = j;
        else if (h === 'insurance') colMap.insurance = j;
        else if (h === 'cheque') colMap.cheque = j;
        else if (h === 'link') colMap.link = j;
        else if (h === 'total') colMap.total = j;
        else if (h === 'advance') colMap.advance = j;
      }
      break;
    }
  }
  
  if (!colMap) return records;
  
  // Parse data rows
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const firstCell = String(row[colMap.date] || '').trim();
    
    if (!firstCell || firstCell === '0') continue;
    if (!/\d{2}\/\d{2}\/\d{4}/.test(firstCell)) continue;
    
    const parts = firstCell.split('/');
    const isoDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
    
    const getVal = (col) => col !== undefined ? (parseFloat(row[col]) || 0) : 0;
    
    const record = {
      date:      isoDate,
      cash:      getVal(colMap.cash),
      knet:      getVal(colMap.knet),
      visa:      getVal(colMap.visa),
      master:    getVal(colMap.master),
      insurance: getVal(colMap.insurance),
      cheque:    getVal(colMap.cheque),
      link:      getVal(colMap.link),
      total:     getVal(colMap.total),
      advance:   getVal(colMap.advance),
    };
    
    records.push(record);
  }
  return records;
}

function parsePaymentsDetails(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  
  const records = [];
  let colMap = null;
  let headerRowIdx = -1;
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowStr = row.map(c => String(c)).join('|').toLowerCase();
    if (rowStr.includes('doctor') && (rowStr.includes('inv id') || rowStr.includes('inv. total'))) {
      headerRowIdx = i;
      colMap = {};
      for (let j = 0; j < row.length; j++) {
        const h = String(row[j]).trim().toLowerCase();
        if (h === 'inv id') colMap.invId = j;
        else if (h === 'patient name') colMap.patient = j;
        else if (h === 'file no') colMap.fileNo = j;
        else if (h === 'date') colMap.date = j;
        else if (h === 'doctor') colMap.doctor = j;
        else if (h === 'k-net') colMap.knet = j;
        else if (h === 'visa') colMap.visa = j;
        else if (h === 'master') colMap.master = j;
        else if (h === 'link') colMap.link = j;
        else if (h === 'gig-globmed') colMap.gig = j;
        else if (h === 'inv. total') colMap.total = j;
      }
      break;
    }
  }
  
  if (!colMap) return records;
  
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const invId = parseInt(row[colMap.invId]);
    if (!invId || isNaN(invId)) continue;
    
    const dateStr = String(row[colMap.date] || '').trim();
    if (!/\d{2}\/\d{2}\/\d{4}/.test(dateStr)) continue;
    const parts = dateStr.split('/');
    const isoDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
    
    const getVal = (col) => col !== undefined ? (parseFloat(row[col]) || 0) : 0;
    
    records.push({
      invId,
      patient: String(row[colMap.patient] || '').trim(),
      fileNo:  String(row[colMap.fileNo] || '').trim(),
      date:    isoDate,
      doctor:  String(row[colMap.doctor] || '').trim(),
      knet:    getVal(colMap.knet),
      visa:    getVal(colMap.visa),
      master:  getVal(colMap.master),
      link:    getVal(colMap.link),
      gig:     getVal(colMap.gig),
      total:   getVal(colMap.total),
    });
  }
  return records;
}

function calcCommission(dr, revenue) {
  const cfg = loadConfig();
  const formula = cfg.commissionFormula || {};
  const base       = formula.base       || 'above_target';
  const deductions = formula.deductions || ['lab'];
  const method     = formula.method     || 'percentage';

  // Step 1: determine base amount
  let amount = base === 'above_target'
    ? Math.max(0, revenue - (dr.target || 0))
    : revenue;

  // Step 2: apply deductions
  if (deductions.includes('lab'))       amount = amount * (1 - (dr.lab      || 0) / 100);
  if (deductions.includes('insurance')) amount = amount * (1 - (dr.insurance|| 0) / 100);

  // Step 3: apply method
  let commission = 0;
  if (method === 'percentage') {
    commission = amount * (dr.commission / 100);
  } else if (method === 'tiered') {
    const tiers = formula.tiers || [];
    let remaining = amount;
    for (const tier of tiers) {
      const from = tier.from || 0;
      const to   = tier.to;
      if (remaining <= 0) break;
      const bracket = to !== null ? Math.min(remaining, to - from) : remaining;
      if (bracket <= 0) continue;
      commission += bracket * (tier.rate / 100);
      remaining  -= bracket;
    }
  } else if (method === 'fixed') {
    commission = dr.commission || 0;
  } else if (method === 'fixed_plus_percentage') {
    commission = (formula.fixedAmount || 0) + amount * (dr.commission / 100);
  }

  return parseFloat(Math.max(0, commission).toFixed(3));
}

function getMonth(dateStr) {
  return dateStr.substring(0, 7); // yyyy-mm
}

// ===== AUTH ROUTES (public — no token needed) =====

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });

  const db = loadDB();
  const user = (db.users || []).find(u => u.username === username || u.email === username);
  if (!user || !user.active) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

  const valid = bcrypt.compareSync(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

  // Update lastLogin
  user.lastLogin = new Date().toISOString();
  saveDB(db);

  // Build permissions from role
  const roleObj = (db.roles || {})[user.role] || DEFAULT_ROLES[user.role] || DEFAULT_ROLES.viewer;
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, fullName: user.fullName },
    JWT_SECRET, { expiresIn: JWT_EXPIRES }
  );

  res.json({
    success: true,
    token,
    user: { id: user.id, username: user.username, email: user.email, fullName: user.fullName, role: user.role },
    permissions: { tabs: roleObj.tabs || [], actions: roleObj.actions || {} }
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const db = loadDB();
  const user = (db.users || []).find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const roleObj = (db.roles || {})[user.role] || DEFAULT_ROLES[user.role] || DEFAULT_ROLES.viewer;
  res.json({
    user: { id: user.id, username: user.username, email: user.email, fullName: user.fullName, role: user.role, lastLogin: user.lastLogin },
    permissions: { tabs: roleObj.tabs || [], actions: roleObj.actions || {} }
  });
});

// ── User Management (admin only) ──────────────────
app.get('/api/users', requireAuth, (req, res) => {
  if (!can(req.user, 'settings', 'view')) return res.status(403).json({ error: 'غير مصرح' });
  const db = loadDB();
  const users = (db.users || []).map(u => ({ id: u.id, username: u.username, email: u.email, fullName: u.fullName, role: u.role, active: u.active, createdAt: u.createdAt, lastLogin: u.lastLogin }));
  res.json(users);
});

app.post('/api/users', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'غير مصرح — المدير فقط' });
  const { username, password, email, fullName, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
  const db = loadDB();
  if ((db.users || []).find(u => u.username === username)) return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });
  const newUser = {
    id: genId('usr-'),
    username: sanitize(username, 50),
    email: sanitize(email || '', 100),
    fullName: sanitize(fullName || username, 100),
    passwordHash: bcrypt.hashSync(password, 10),
    role: role || 'viewer',
    active: true,
    createdAt: new Date().toISOString(),
    lastLogin: null
  };
  db.users.push(newUser);
  saveDB(db);
  res.json({ success: true, id: newUser.id });
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'غير مصرح' });
  const db = loadDB();
  const idx = db.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const { email, fullName, role, active, password } = req.body;
  if (email)    db.users[idx].email    = sanitize(email, 100);
  if (fullName) db.users[idx].fullName = sanitize(fullName, 100);
  if (role)     db.users[idx].role     = role;
  if (active !== undefined) db.users[idx].active = !!active;
  if (password) db.users[idx].passwordHash = bcrypt.hashSync(password, 10);
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'غير مصرح' });
  const db = loadDB();
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'لا يمكن حذف حسابك الخاص' });
  db.users = db.users.filter(u => u.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// ── Role/Permission Management (admin only) ────────
app.get('/api/roles', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.roles || DEFAULT_ROLES);
});

app.put('/api/roles/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'غير مصرح' });
  const db = loadDB();
  if (!db.roles) db.roles = { ...DEFAULT_ROLES };
  const { name, color, tabs, actions } = req.body;
  db.roles[req.params.id] = { id: req.params.id, name, color, tabs: tabs || [], actions: actions || {} };
  saveDB(db);
  res.json({ success: true });
});

// ── Change own password ───────────────────────────
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'كلمتا المرور مطلوبتان' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!bcrypt.compareSync(oldPassword, user.passwordHash)) return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveDB(db);
  res.json({ success: true });
});

// ── Apply auth to all remaining API routes ─────────
app.use('/api', requireAuth);

// ===== API ROUTES =====

// Get all data — strip sensitive fields before returning
app.get('/api/data', (req, res) => {
  const db = loadDB();
  const safe = { ...db };
  // Never expose password hashes
  safe.users = (db.users || []).map(({ passwordHash, ...u }) => u);
  res.json(safe);
});

// Upload Excel
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    const db = loadDB();
    const filePath = req.file.path;
    const fileName = req.file.originalname.toLowerCase();
    
    let parsed = [];
    let type = '';
    
    if (fileName.includes('dailyincome')) {
      parsed = parseDailyIncome(filePath);
      type = 'daily';
      
      // Merge — avoid duplicates by date
      const existing = new Set(db.dailyData.map(d => d.date));
      let added = 0;
      for (const rec of parsed) {
        if (!existing.has(rec.date)) {
          db.dailyData.push(rec);
          added++;
        } else {
          // Update existing
          const idx = db.dailyData.findIndex(d => d.date === rec.date);
          db.dailyData[idx] = rec;
        }
      }
      db.dailyData.sort((a, b) => b.date.localeCompare(a.date));

      // === AUTO JOURNAL ENTRIES FOR DAILY INCOME (monthly grouping) ===
      if (!db.journalEntries) db.journalEntries = [];
      const coa = db.chartOfAccounts || [];
      const findAcc = (code) => {
        const a = coa.find(a => a.code === code || a.id === code);
        return a || { id: code, code, name: code };
      };

      // Revenue credit accounts
      const rev4100 = findAcc('4100'); // Cash
      const rev4110 = findAcc('4110'); // K-Net
      const rev4120 = findAcc('4120'); // Visa
      const rev4130 = findAcc('4130'); // Master
      const rev4140 = findAcc('4140'); // Link
      const rev4150 = findAcc('4150'); // Insurance
      const rev4160 = findAcc('4160'); // Cheque
      // Asset debit accounts
      const cash1100 = findAcc('1100'); // Sundry cash
      const bank1110 = findAcc('1110'); // Bank (Link / Cheque)
      const knet1120 = findAcc('1120'); // K-Net / Visa / Master receivables
      const ins1130  = findAcc('1130'); // Insurance receivable

      // Group uploaded records by month (YYYY-MM)
      const monthGroups = {};
      for (const rec of parsed) {
        const month = rec.date.substring(0, 7);
        if (!monthGroups[month]) monthGroups[month] = { cash:0, knet:0, visa:0, master:0, link:0, cheque:0, insurance:0 };
        const g = monthGroups[month];
        g.cash      += rec.cash      || 0;
        g.knet      += rec.knet      || 0;
        g.visa      += rec.visa      || 0;
        g.master    += rec.master    || 0;
        g.link      += rec.link      || 0;
        g.cheque    += rec.cheque    || 0;
        g.insurance += rec.insurance || 0;
      }

      for (const [month, g] of Object.entries(monthGroups)) {
        // Remove any previous auto-income entry for this month (re-upload replaces it)
        db.journalEntries = db.journalEntries.filter(
          e => !(e.type === 'auto-income' && e.ref === `INCOME-${month}`)
        );

        const r = (v) => parseFloat(v.toFixed(3));
        const lines = [];
        let totalRev = 0;

        // Debit lines
        if (g.cash      > 0) { const v=r(g.cash);      lines.push({ accountId:cash1100.id, accountCode:'1100', accountName:cash1100.name, debit:v, credit:0 }); totalRev+=v; }
        if (g.knet      > 0) { const v=r(g.knet);      lines.push({ accountId:knet1120.id, accountCode:'1120', accountName:knet1120.name, debit:v, credit:0 }); totalRev+=v; }
        if (g.visa      > 0) { const v=r(g.visa);      lines.push({ accountId:knet1120.id, accountCode:'1120', accountName:knet1120.name, debit:v, credit:0 }); totalRev+=v; }
        if (g.master    > 0) { const v=r(g.master);    lines.push({ accountId:knet1120.id, accountCode:'1120', accountName:knet1120.name, debit:v, credit:0 }); totalRev+=v; }
        if (g.link      > 0) { const v=r(g.link);      lines.push({ accountId:bank1110.id, accountCode:'1110', accountName:bank1110.name, debit:v, credit:0 }); totalRev+=v; }
        if (g.cheque    > 0) { const v=r(g.cheque);    lines.push({ accountId:bank1110.id, accountCode:'1110', accountName:bank1110.name, debit:v, credit:0 }); totalRev+=v; }
        if (g.insurance > 0) { const v=r(g.insurance); lines.push({ accountId:ins1130.id,  accountCode:'1130', accountName:ins1130.name,  debit:v, credit:0 }); totalRev+=v; }

        // Credit lines
        if (g.cash      > 0) { const v=r(g.cash);      lines.push({ accountId:rev4100.id, accountCode:'4100', accountName:rev4100.name, debit:0, credit:v }); }
        if (g.knet      > 0) { const v=r(g.knet);      lines.push({ accountId:rev4110.id, accountCode:'4110', accountName:rev4110.name, debit:0, credit:v }); }
        if (g.visa      > 0) { const v=r(g.visa);      lines.push({ accountId:rev4120.id, accountCode:'4120', accountName:rev4120.name, debit:0, credit:v }); }
        if (g.master    > 0) { const v=r(g.master);    lines.push({ accountId:rev4130.id, accountCode:'4130', accountName:rev4130.name, debit:0, credit:v }); }
        if (g.link      > 0) { const v=r(g.link);      lines.push({ accountId:rev4140.id, accountCode:'4140', accountName:rev4140.name, debit:0, credit:v }); }
        if (g.cheque    > 0) { const v=r(g.cheque);    lines.push({ accountId:rev4160.id, accountCode:'4160', accountName:rev4160.name, debit:0, credit:v }); }
        if (g.insurance > 0) { const v=r(g.insurance); lines.push({ accountId:rev4150.id, accountCode:'4150', accountName:rev4150.name, debit:0, credit:v }); }

        if (lines.length < 2 || totalRev === 0) continue;

        const lastDay = new Date(month + '-28'); // safe last day for all months
        db.journalEntries.push({
          id:          `JE-INC-${month}`,
          date:        month + '-30', // end of month reference date
          desc:        `إيرادات شهر ${month}`,
          ref:         `INCOME-${month}`,
          type:        'auto-income',
          totalDebit:  r(totalRev),
          totalCredit: r(totalRev),
          createdAt:   new Date().toISOString(),
          lines,
          autoGenerated: true,
        });
      }
      db.journalEntries.sort((a, b) => b.date.localeCompare(a.date));
      // === END AUTO JOURNAL ===

    } else if (fileName.includes('payments')) {
      parsed = parsePaymentsDetails(filePath);
      type = 'payments';
      
      // Merge by invId
      const existingIds = new Set(db.paymentsData.map(d => d.invId));
      let added = 0;
      for (const rec of parsed) {
        if (!existingIds.has(rec.invId)) {
          db.paymentsData.push(rec);
          added++;
        }
      }
      db.paymentsData.sort((a, b) => b.date.localeCompare(a.date));
      
      // Auto-calculate commissions per doctor per month
      updateCommissions(db);
    }
    
    // Log upload
    db.uploadedFiles.push({
      name: req.file.originalname,
      type,
      records: parsed.length,
      date: new Date().toISOString(),
    });
    
    saveDB(db);
    fs.removeSync(filePath);

    // real-time target achievement check after upload
    if (type === 'payments') {
      const currentMonth = new Date().toISOString().substring(0,7);
      const groups = {};
      for (const p of db.paymentsData) {
        if ((p.date||'').startsWith(currentMonth) && p.doctor && p.doctor !== 'Advance') {
          groups[p.doctor] = (groups[p.doctor]||0) + (p.total||0);
        }
      }
      Object.entries(groups).forEach(([doctor, rev]) => checkTargetAchievement(doctor, rev));
    }

    res.json({ success: true, type, records: parsed.length, message: `تم رفع ${parsed.length} سجل بنجاح` });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ success: false, message: 'خطأ في قراءة الملف — تأكد من صحة الصيغة' });
  }
});

function updateCommissions(db) {
  // Group payments by doctor+month
  const groups = {};
  for (const p of db.paymentsData) {
    const month = getMonth(p.date);
    const doctor = p.doctor;
    if (doctor === 'Advance' || !doctor) continue;
    const key = `${doctor}|${month}`;
    if (!groups[key]) groups[key] = { doctor, month, revenue: 0 };
    groups[key].revenue += p.total;
  }
  
  // Update commission history + create insurance expense journal entries
  const coa = db.chartOfAccounts || [];
  const findAcc = (code) => coa.find(a => a.code === code) || { id: code, code, name: code };
  const insExpAcc  = findAcc('5730'); // تأمين طبي وعمالي
  const insLiabAcc = findAcc('2200'); // رواتب / التزامات مستحقة

  for (const key of Object.keys(groups)) {
    const g = groups[key];
    const dr = db.doctors.find(d =>
      d.name === g.doctor ||
      d.name.toLowerCase().replace(/\s+/g,'') === g.doctor.toLowerCase().replace(/\s+/g,'')
    );
    if (!dr) continue;
    const commission = calcCommission(dr, g.revenue);

    // Calculate insurance deduction amount
    const cfg = loadConfig();
    const formula = cfg.commissionFormula || {};
    const base = formula.base || 'above_target';
    const baseAmt = base === 'above_target' ? Math.max(0, g.revenue - (dr.target || 0)) : g.revenue;
    const insRate = (formula.deductions || ['lab']).includes('insurance') ? (dr.insurance || 0) : 0;
    const insDeduction = parseFloat((baseAmt * insRate / 100).toFixed(3));

    const existing = db.commissionHistory.find(c => c.doctor === g.doctor && c.month === g.month);
    if (existing) {
      existing.revenue = g.revenue;
      existing.commission = commission;
    } else {
      db.commissionHistory.push({
        id: genId('comm-'),
        doctor: g.doctor,
        month: g.month,
        revenue: g.revenue,
        commission,
        paid: false,
        payMethod: '',
        payDate: ''
      });
    }

    // Insurance expense journal entry (only if insurance deduction exists)
    if (insDeduction > 0) {
      const jeRef = `INS-EXP-${g.doctor}-${g.month}`.replace(/\s/g,'-');
      db.journalEntries = db.journalEntries || [];
      db.journalEntries = db.journalEntries.filter(e => e.ref !== jeRef);
      db.journalEntries.push({
        id: genId('JE-INS-'),
        date: g.month + '-30',
        desc: `مصاريف تأمين — ${g.doctor} — ${g.month}`,
        ref: jeRef,
        type: 'insurance-expense',
        totalDebit: insDeduction,
        totalCredit: insDeduction,
        createdAt: new Date().toISOString(),
        autoGenerated: true,
        lines: [
          { accountId: insExpAcc.id,  accountCode: '5730', accountName: insExpAcc.name,  debit: insDeduction, credit: 0 },
          { accountId: insLiabAcc.id, accountCode: '2200', accountName: insLiabAcc.name, debit: 0, credit: insDeduction },
        ],
      });
    }
  }
}

// Save doctors — validate structure before writing
app.post('/api/doctors', (req, res) => {
  const db = loadDB();
  const incoming = req.body.doctors;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'doctors must be array' });
  db.doctors = incoming.map(d => ({
    name:       sanitize(String(d.name || ''), 100),
    target:     Math.max(0, parseFloat(d.target) || 0),
    commission: Math.min(100, Math.max(0, parseFloat(d.commission) || 0)),
    lab:        Math.min(100, Math.max(0, parseFloat(d.lab) || 0)),
    insurance:  Math.min(100, Math.max(0, parseFloat(d.insurance) || 0)),
  }));
  updateCommissions(db);
  saveDB(db);
  res.json({ success: true });
});

// Mark commission paid
app.post('/api/commission/pay', (req, res) => {
  const { doctor, month, payMethod, payDate } = req.body;
  const db = loadDB();
  const entry = db.commissionHistory.find(c => c.doctor === doctor && c.month === month);
  if (entry) {
    entry.paid = true;
    entry.payMethod = payMethod;
    entry.payDate = payDate;
    saveDB(db);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, message: 'لم يتم إيجاد العمولة' });
  }
});

// Add expense — whitelist only known fields
// Map expense category → debit account code
function expCatToAccount(cat, coa) {
  const catNorm = (cat||'').trim();
  // Fallback keyword map (checked first — fast and reliable)
  const MAP = [
    ['إيجار',    '5510','مصاريف إيجار'],
    ['راتب',     '5200','مصاريف رواتب'],
    ['رواتب',    '5200','مصاريف رواتب'],
    ['كهرباء',   '5560','مصاريف كهرباء'],
    ['ماء',      '5570','مصاريف ماء'],
    ['اتصال',    '5580','مصاريف اتصالات'],
    ['هاتف',     '5580','مصاريف اتصالات'],
    ['زين',      '5580','مصاريف اتصالات'],
    ['STC',      '5580','مصاريف اتصالات'],
    ['ooredoo',  '5580','مصاريف اتصالات'],
    ['مواد',     '5210','مواد طب أسنان'],
    ['دواء',     '5220','أدوية ومستلزمات'],
    ['مختبر',   '5230','مصاريف مختبر'],
    ['صيانة',    '5540','مصاريف صيانة'],
    ['تأمين',    '5550','مصاريف تأمين'],
    ['تسويق',    '5610','مصاريف تسويق'],
    ['إعلان',    '5610','مصاريف تسويق'],
    ['ضيافة',    '5620','مصاريف ضيافة'],
    ['سفر',      '5630','مصاريف سفر'],
    ['عمولة',    '5650','عمولات'],
    ['اهتلاك',   '5680','مصاريف اهتلاك'],
    ['استهلاك',  '5680','مصاريف اهتلاك'],
    ['متفرق',    '5690','مصاريف متفرقة'],
    ['عامة',     '5699','مصاريف عامة'],
  ];
  for (const [key, code, name] of MAP) {
    if (catNorm.includes(key)) return { code, name };
  }
  // Then try COA — find expense account whose name contains the category
  if (coa && coa.length) {
    const match = coa.find(a => a.type==='expense' && a.status!=='inactive'
      && catNorm.length >= 3 && (a.name||'').includes(catNorm.substring(0,4)));
    if (match) return { code: match.code, name: match.name };
  }
  return { code: '5699', name: 'مصاريف عامة' };
}

// Map payment method → credit account
function payMethodToAccount(method) {
  const m = (method||'').toLowerCase();
  if (m.includes('بنك') || m.includes('bank') || m.includes('تحويل')) return { code:'1110', name:'البنك' };
  if (m.includes('knet') || m.includes('كي') || m.includes('visa') || m.includes('master')) return { code:'1115', name:'بطاقة ائتمانية' };
  return { code:'1100', name:'الصندوق' }; // default: cash
}

app.post('/api/expenses', (req, res) => {
  const db = loadDB();
  const { date, desc, cat, amount, vendor, payMethod, notes } = req.body;
  if (!date || !amount) return res.status(400).json({ error: 'date and amount required' });
  const amt = Math.max(0, parseFloat(amount) || 0);
  const jeId = 'JE-EXP-' + Date.now();
  const newExpense = {
    id: genId('exp-'),
    date: sanitize(date, 10),
    desc: sanitize(desc, 300),
    cat:  sanitize(cat, 100),
    amount: amt,
    vendor: sanitize(vendor, 200),
    payMethod: sanitize(payMethod, 50),
    notes: sanitize(notes, 500),
    journalId: jeId
  };
  // Auto-create balanced journal entry
  const debitAcc  = expCatToAccount(cat, db.chartOfAccounts);
  const creditAcc = payMethodToAccount(payMethod);
  const je = {
    id: jeId,
    date: sanitize(date, 10),
    description: (desc || cat || 'مصروف') + (vendor ? ' — ' + vendor : ''),
    reference: 'EXP-AUTO',
    type: 'expense',
    source: 'expenses',
    expenseId: newExpense.id,
    lines: [
      { accountCode: debitAcc.code,  accountName: debitAcc.name,  debit: amt, credit: 0 },
      { accountCode: creditAcc.code, accountName: creditAcc.name, debit: 0,   credit: amt }
    ],
    createdAt: new Date().toISOString()
  };
  db.expenses = db.expenses || [];
  db.journalEntries = db.journalEntries || [];
  db.expenses.push(newExpense);
  db.journalEntries.push(je);
  saveDB(db);
  checkExpenseAnomaly(newExpense).catch(()=>{});
  res.json({ success: true, journalId: jeId, debitAccount: debitAcc, creditAccount: creditAcc });
});

// Delete expense + its auto-generated journal entry
app.delete('/api/expenses/:id', (req, res) => {
  const db = loadDB();
  const exp = (db.expenses||[]).find(e => String(e.id) === String(req.params.id));
  db.expenses = (db.expenses||[]).filter(e => String(e.id) !== String(req.params.id));
  // Remove linked JE if it was auto-created by expenses route
  if (exp && exp.journalId) {
    const je = (db.journalEntries||[]).find(j => j.id === exp.journalId && j.source === 'expenses');
    if (je) db.journalEntries = db.journalEntries.filter(j => j.id !== exp.journalId);
  }
  saveDB(db);
  res.json({ success: true });
});

// ===== RESET DATA (admin only) =====
app.post('/api/reset-data', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'المدير فقط' });
  const { scope } = req.body; // 'all' | 'transactions'
  const db = loadDB();

  // Always wipe transaction data
  db.dailyData        = [];
  db.paymentsData     = [];
  db.commissionHistory = [];
  db.journalEntries   = [];
  db.expenses         = [];
  db.uploadedFiles    = [];
  db.vouchers         = [];
  db.cashReconciliation = [];
  db.insuranceClaims  = [];
  db.payroll          = [];
  db.invMovements     = [];

  if (scope === 'all') {
    // Also reset doctors, vendors, inventory, assets, COA (re-seed defaults)
    db.doctors      = [];
    db.vendors      = [];
    db.invItems     = [];
    db.invCategories = [];
    db.employees    = [];
    db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
  }

  saveDB(db);
  res.json({ success: true, scope });
});

// Stats endpoint — reads from journal entries (source of truth)
app.get('/api/stats', (req, res) => {
  const { from, to } = req.query;
  const db = loadDB();
  const r3 = v => parseFloat(v.toFixed(3));

  // Filter journal entries by date range
  let entries = db.journalEntries || [];
  if (from) entries = entries.filter(e => e.date >= from);
  if (to)   entries = entries.filter(e => e.date <= to);

  // Revenue accounts: any account whose code starts with '4'
  const coa = db.chartOfAccounts || [];
  const isRevAccount = (accountId) => {
    const acc = coa.find(a => a.id === accountId || a.code === accountId);
    return acc ? acc.code.startsWith('4') : false;
  };

  // Sum credit amounts per revenue account from journal lines
  const revByCode = {};
  for (const entry of entries) {
    for (const line of entry.lines || []) {
      if ((line.credit || 0) > 0 && isRevAccount(line.accountId)) {
        const acc = coa.find(a => a.id === line.accountId);
        const code = acc?.code || line.accountCode || line.accountId;
        revByCode[code] = (revByCode[code] || 0) + (line.credit || 0);
      }
    }
  }

  const totalRevenue = Object.values(revByCode).reduce((s, v) => s + v, 0);
  const insRevenue   = revByCode['4150'] || 0; // إيرادات تأمين
  const cashRevenue  = revByCode['4100'] || 0;
  const knetRevenue  = revByCode['4110'] || 0;
  const visaRevenue  = revByCode['4120'] || 0;
  const masterRevenue= revByCode['4130'] || 0;
  const linkRevenue  = revByCode['4140'] || 0;
  const chequeRevenue= revByCode['4160'] || 0;

  // Insurance share (25% of the gross insurance amount)
  const insOriginal  = insRevenue > 0 ? insRevenue / 0.75 : 0;
  const insShare     = r3(insOriginal * 0.25);

  // Work days = unique dates with revenue > 0 from daily data (unchanged)
  let daily = db.dailyData || [];
  if (from) daily = daily.filter(d => d.date >= from);
  if (to)   daily = daily.filter(d => d.date <= to);
  const workDays = daily.filter(d => d.total > 0).length;

  const totalComm  = (db.commissionHistory || []).reduce((s, c) => s + (c.commission || 0), 0);
  const pendingComm= (db.commissionHistory || []).filter(c => !c.paid).reduce((s, c) => s + (c.commission || 0), 0);

  res.json({
    totalRevenue:  r3(totalRevenue),
    insRecorded:   r3(insRevenue),
    insOriginal:   r3(insOriginal),
    insShare,
    insNet:        r3(insRevenue),
    netCash:       r3(totalRevenue - insRevenue),
    workDays,
    totalComm:     r3(totalComm),
    pendingComm:   r3(pendingComm),
    // breakdown by payment method
    byMethod: {
      cash:   r3(cashRevenue),
      knet:   r3(knetRevenue),
      visa:   r3(visaRevenue),
      master: r3(masterRevenue),
      link:   r3(linkRevenue),
      cheque: r3(chequeRevenue),
      insurance: r3(insRevenue),
    }
  });
});

// ===== TELEGRAM BOT =====
let bot = null;

// Allowed chat IDs — set TG_ALLOWED_CHATS=123456,789012 in .env, or auto-register first user
const _tgAllowedChats = new Set(
  (process.env.TG_ALLOWED_CHATS || '').split(',').filter(Boolean).map(Number)
);
function _isTgAllowed(chatId) {
  if (_tgAllowedChats.has(chatId)) return true;
  const db = loadDB();
  const saved = db.scheduleConfig?.chatId;
  if (saved && Number(saved) === Number(chatId)) return true;
  return false;
}

app.post('/api/telegram/start', async (req, res) => {
  const { token } = req.body;

  // Stop old bot completely before starting new one
  if (bot) {
    try { await bot.stopPolling({ cancel: true }); } catch(e) {}
    bot = null;
    global._tgBot = null;
    await new Promise(r => setTimeout(r, 1500));
  }

  try {
    const cleanToken = String(token || '').trim().replace(/[\s\n\r]/g, '');
    bot = new TelegramBot(cleanToken, { polling: { interval: 1000, params: { timeout: 10 } } });
    setupBot(bot);

    // Save token encrypted (base64 obfuscation — not true encryption, but keeps it out of plaintext)
    const db = loadDB();
    db.telegramToken = Buffer.from(cleanToken).toString('base64');
    saveDB(db);

    res.json({ success: true, message: 'البوت شغال ✅' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'فشل تشغيل البوت: ' + err.message });
  }
});

function setupBot(bot) {
  global._tgBot = bot;
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // ── Auto-register first user, then enforce whitelist ──
    if (!_isTgAllowed(chatId)) {
      const db = loadDB();
      if (!db.scheduleConfig?.chatId) {
        // First user to message becomes the admin
        if (!db.scheduleConfig) db.scheduleConfig = {};
        db.scheduleConfig.chatId = chatId;
        _tgAllowedChats.add(chatId);
        saveDB(db);
        bot.sendMessage(chatId, '✅ تم تسجيلك كمستخدم رئيسي للبوت.\n\nاكتب /start لقائمة الأوامر.');
      } else {
        bot.sendMessage(chatId, '⛔ غير مصرح.');
      }
      return;
    }

    // File received
    if (msg.document) {
      const fileName = msg.document.file_name || '';
      bot.sendMessage(chatId, `📂 استلمت الملف: ${fileName}\nجاري المعالجة...`);
      
      try {
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const https = require('https');
        const http = require('http');
        const client = fileLink.startsWith('https') ? https : http;
        const tempPath = path.join(UPLOADS_DIR, `tg_${Date.now()}_${fileName}`);
        
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tempPath);
          client.get(fileLink, res => { res.pipe(file); file.on('finish', resolve); }).on('error', reject);
        });
        
        const db = loadDB();
        const lowerName = fileName.toLowerCase();
        let parsed = [];
        let type = '';
        
        if (lowerName.includes('dailyincome')) {
          parsed = parseDailyIncome(tempPath);
          type = 'daily';
          const existing = new Set(db.dailyData.map(d => d.date));
          for (const rec of parsed) {
            if (!existing.has(rec.date)) db.dailyData.push(rec);
            else { const idx = db.dailyData.findIndex(d => d.date === rec.date); db.dailyData[idx] = rec; }
          }
          db.dailyData.sort((a, b) => b.date.localeCompare(a.date));
        } else if (lowerName.includes('payments')) {
          parsed = parsePaymentsDetails(tempPath);
          type = 'payments';
          const existingIds = new Set(db.paymentsData.map(d => d.invId));
          for (const rec of parsed) { if (!existingIds.has(rec.invId)) db.paymentsData.push(rec); }
          db.paymentsData.sort((a, b) => b.date.localeCompare(a.date));
          updateCommissions(db);
        }
        
        db.uploadedFiles.push({ name: fileName, type, records: parsed.length, date: new Date().toISOString() });
        saveDB(db);
        fs.removeSync(tempPath);
        
        bot.sendMessage(chatId, `✅ تم حفظ ${parsed.length} سجل بنجاح!\nاكتب /stats لرؤية الإحصائيات`);
      } catch (err) {
        bot.sendMessage(chatId, `❌ خطأ: ${err.message}`);
      }
      return;
    }
    
    // Photo received — invoice AI reader
    if (msg.photo) {
      bot.sendMessage(chatId, '🔍 جاري قراءة الفاتورة...');
      try {
        const largestPhoto = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(largestPhoto.file_id);
        const https = require('https');
        const http  = require('http');
        const client = fileLink.startsWith('https') ? https : http;
        const tempPath = path.join(UPLOADS_DIR, `invoice_${Date.now()}.jpg`);
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tempPath);
          client.get(fileLink, r => { r.pipe(file); file.on('finish', resolve); }).on('error', reject);
        });
        const base64Image = fs.readFileSync(tempPath).toString('base64');
        fs.removeSync(tempPath);

        const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514', max_tokens: 500,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
              { type: 'text', text: `استخرج بيانات هذه الفاتورة وأجب بـ JSON فقط:\n{"vendor":"اسم المورد","amount":رقم,"date":"YYYY-MM-DD","category":"مواد مختبر/رواتب/إيجار/كهرباء/صيانة/أخرى","description":"وصف قصير"}\nإذا ما قدرت تقرأ قيمة حط null. اليوم: ${new Date().toISOString().split('T')[0]}` }
            ]}]
          })
        });
        const rawText = (await aiResponse.json()).content?.[0]?.text || '{}';
        let invoice;
        try { invoice = JSON.parse(rawText.replace(/```json|```/g, '').trim()); } catch(e) { invoice = {}; }

        const db = loadDB();
        if (!db.pendingInvoices) db.pendingInvoices = {};
        db.pendingInvoices[chatId] = { step: 'confirm_data', invoice };
        saveDB(db);

        const esc = s => String(s||'').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        bot.sendMessage(chatId,
          '📄 *قرأت الفاتورة:*\n\n' +
          '🏢 المورد: ' + esc(invoice.vendor || 'غير واضح') + '\n' +
          '💰 المبلغ: ' + esc(invoice.amount ? invoice.amount + ' د.ك' : 'غير واضح') + '\n' +
          '📅 التاريخ: ' + esc(invoice.date || 'غير واضح') + '\n' +
          '📂 التصنيف: ' + esc(invoice.category || 'غير واضح') + '\n' +
          '📝 الوصف: ' + esc(invoice.description || '—') + '\n\n' +
          'هل البيانات صحيحة؟',
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
            { text: '✅ نعم، صحيحة', callback_data: 'inv_confirm_data' },
            { text: '❌ إلغاء', callback_data: 'inv_cancel' }
          ]]}}
        );
      } catch(err) {
        bot.sendMessage(chatId, '❌ خطأ في قراءة الفاتورة: ' + err.message);
      }
      return;
    }

    // Cancel invoice (text fallback)
    if (text === '/cancel_invoice') {
      const db = loadDB();
      if (db.pendingInvoices) delete db.pendingInvoices[chatId];
      saveDB(db);
      bot.sendMessage(chatId, '❌ تم إلغاء الفاتورة.');
      return;
    }

    // Manual expense entry: /expense 50 مواد مختبر
    if (text.startsWith('/expense ')) {
      const parts = text.replace('/expense ', '').split(' ');
      const amount = parseFloat(parts[0]);
      const desc = sanitize(parts.slice(1).join(' '), 300);
      if (!amount || !desc) {
        bot.sendMessage(chatId, '❌ الصيغة: /expense [المبلغ] [الوصف]\nمثال: /expense 50 مواد مختبر');
        return;
      }
      const db = loadDB();
      db.expenses.push({
        id: genId('exp-'),
        desc,
        cat: 'أخرى',
        amount: Math.max(0, amount),
        date: new Date().toISOString().split('T')[0],
        source: 'telegram_manual'
      });
      saveDB(db);
      bot.sendMessage(chatId, '✅ تم تسجيل المصروف: ' + desc + ' — ' + amount + ' د.ك');
      return;
    }

    // Show expenses — grouped by category
    if (text === '/expenses') {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0, 7);
      const expenses = (db.expenses || []).filter(e => e.date && e.date.startsWith(thisMonth));
      if (!expenses.length) { bot.sendMessage(chatId, '💸 لا توجد مصاريف هذا الشهر.\nأضف مصروف: /expense [مبلغ] [وصف]'); return; }
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      const total = expenses.reduce((s,e) => s + (e.amount||0), 0);
      // Group by category
      const catTotals = {};
      expenses.forEach(e => { catTotals[e.cat||'أخرى'] = (catTotals[e.cat||'أخرى']||0) + (e.amount||0); });
      const sorted = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
      let msg = `💸 *مصاريف ${thisMonth}*\n\n`;
      sorted.forEach(([cat, amt]) => {
        const pct = Math.round(amt/total*100);
        const bar = '█'.repeat(Math.min(8,Math.floor(pct/13))) + '░'.repeat(Math.max(0,8-Math.min(8,Math.floor(pct/13))));
        msg += `📂 *${cat}*: ${fmt(amt)} د.ك (${pct}%)\n${bar}\n`;
      });
      msg += `\n💰 *الإجمالي: ${fmt(total)} د.ك*`;
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      return;
    }

    // ---- Inventory Telegram Commands ----
    if (text === '/stock' || text === '/مخزون') {
      const db = loadDB();
      const items = db.invItems || [];
      if (!items.length) { bot.sendMessage(chatId, '📦 لا توجد أصناف مسجّلة في المخزون.'); return; }
      // Support both field naming conventions (qty/quantity, minQty/minQuantity, nameAr/name)
      const qty  = i => parseFloat(i.qty ?? i.quantity ?? 0);
      const minQ = i => parseFloat(i.minQty ?? i.minQuantity ?? 0);
      const nm   = i => i.nameAr || i.name || i.nameEn || '—';
      const totalVal = items.reduce((s,i) => s + qty(i) * (parseFloat(i.cost)||0), 0);
      const low  = items.filter(i => qty(i) > 0 && qty(i) <= minQ(i));
      const out  = items.filter(i => qty(i) <= 0);
      let msg = `📦 *ملخص المخزون*\n\n`;
      msg += `🔢 إجمالي الأصناف: *${items.length}*\n`;
      msg += `💰 القيمة الكلية: *${totalVal.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك*\n`;
      if (out.length)  msg += `\n🔴 *نفد (${out.length}):*\n` + out.map(i=>`  • ${nm(i)}`).join('\n');
      if (low.length)  msg += `\n🟡 *منخفض (${low.length}):*\n` + low.map(i=>`  • ${nm(i)}: ${qty(i)} ${i.unit||''} (حد: ${minQ(i)})`).join('\n');
      if (!out.length && !low.length) msg += `\n✅ جميع الأصناف بمستويات كافية.`;
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/lowstock') {
      const db = loadDB();
      const items = db.invItems || [];
      const qty  = i => parseFloat(i.qty ?? i.quantity ?? 0);
      const minQ = i => parseFloat(i.minQty ?? i.minQuantity ?? 0);
      const nm   = i => i.nameAr || i.name || i.nameEn || '—';
      const low = items.filter(i => qty(i) <= minQ(i));
      if (!low.length) { bot.sendMessage(chatId, '✅ لا توجد أصناف منخفضة أو نافدة.'); return; }
      let msg = `⚠️ *أصناف تحتاج إعادة طلب*\n\n`;
      low.forEach(i => {
        const icon = qty(i) <= 0 ? '🔴' : '🟡';
        msg += `${icon} *${nm(i)}*\n   الكمية: ${qty(i)} ${i.unit||''} | الحد: ${minQ(i)}\n\n`;
      });
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/item ')) {
      const db = loadDB();
      const query = text.replace('/item ', '').trim().toLowerCase();
      const qty  = i => parseFloat(i.qty ?? i.quantity ?? 0);
      const minQ = i => parseFloat(i.minQty ?? i.minQuantity ?? 0);
      const nm   = i => i.nameAr || i.name || i.nameEn || '—';
      const item = (db.invItems || []).find(i =>
        nm(i).toLowerCase().includes(query) ||
        (i.code && i.code.toLowerCase() === query) ||
        (i.nameEn && i.nameEn.toLowerCase().includes(query))
      );
      if (!item) { bot.sendMessage(chatId, `❌ لم أجد صنفاً باسم "${query}"`); return; }
      const val = qty(item) * (parseFloat(item.cost)||0);
      bot.sendMessage(chatId,
        `📦 *${nm(item)}*\n` +
        (item.code ? `كود: \`${item.code}\`\n` : '') +
        `الكمية: *${qty(item)} ${item.unit||''}*\n` +
        `سعر الوحدة: *${(parseFloat(item.cost)||0).toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك*\n` +
        `القيمة الكلية: *${val.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك*\n` +
        `الحد الأدنى: ${minQ(item)} ${item.unit||''}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // /goals — تقدم أهداف الدكاترة
    if (text === '/goals' || text === '/أهداف') {
      const db = loadDB();
      const doctors = db.doctors || [];
      const thisMonth = new Date().toISOString().substring(0,7);
      const mEntries = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(thisMonth));
      const drRevMap = {};
      mEntries.forEach(day => {
        // Support both formats: day.doctor (string) and day.doctors[] (array)
        if (day.doctor) {
          drRevMap[day.doctor] = (drRevMap[day.doctor]||0) + (parseFloat(day.total)||0);
        }
        (day.doctors||[]).forEach(dr => { drRevMap[dr.name] = (drRevMap[dr.name]||0) + (dr.revenue||0); });
      });
      const withTarget = doctors.filter(d=>d.target>0);
      if (!withTarget.length) { bot.sendMessage(chatId, '🎯 لم يُحدَّد هدف لأي دكتور بعد.\nحدّد الأهداف من لوحة التحكم.'); return; }
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      let msg = `🎯 *تقدم الأهداف — ${thisMonth}*\n\n`;
      withTarget.forEach(dr => {
        const rev = drRevMap[dr.name] || 0;
        const pct = Math.round((rev / dr.target) * 100);
        const filled = Math.min(10, Math.floor(pct/10));
        const bar = '█'.repeat(filled) + '░'.repeat(10-filled);
        const icon = pct >= 80 ? '✅' : pct >= 50 ? '⚠️' : '🔴';
        msg += `${icon} *${dr.name}*\n  ${bar} ${pct}%\n  ${fmt(rev)} / ${fmt(dr.target)} د.ك\n\n`;
      });
      const totalRev = withTarget.reduce((s,d)=>(s + (drRevMap[d.name]||0)), 0);
      const totalTarget = withTarget.reduce((s,d)=>s+d.target, 0);
      const overallPct = totalTarget > 0 ? Math.round(totalRev/totalTarget*100) : 0;
      msg += `📊 *الإجمالي: ${overallPct}% من الهدف*`;
      bot.sendMessage(chatId, msg, { parse_mode:'Markdown' });
      return;
    }

    // /doctors — تصنيف الدكاترة هذا الشهر
    if (text === '/doctors' || text === '/دكاترة') {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0,7);
      const mEntries = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(thisMonth));
      const drMap = {};
      mEntries.forEach(day => {
        if (day.doctor) {
          drMap[day.doctor] = (drMap[day.doctor]||0) + (parseFloat(day.total)||0);
        }
        (day.doctors||[]).forEach(dr => { drMap[dr.name] = (drMap[dr.name]||0) + (dr.revenue||0); });
      });
      const ranked = Object.entries(drMap).sort((a,b)=>b[1]-a[1]);
      if (!ranked.length) { bot.sendMessage(chatId, '📭 لا توجد بيانات دكاترة لهذا الشهر.'); return; }
      const medals = ['🥇','🥈','🥉'];
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      let msg = `🏆 *تصنيف الدكاترة — ${thisMonth}*\n\n`;
      const total = ranked.reduce((s,[,r])=>s+r,0);
      ranked.forEach(([name, rev], i) => {
        const medal = medals[i] || `${i+1}.`;
        const share = total > 0 ? Math.round(rev/total*100) : 0;
        msg += `${medal} *${name}*: ${fmt(rev)} د.ك (${share}%)\n`;
      });
      msg += `\n💰 *الإجمالي: ${fmt(total)} د.ك*`;
      bot.sendMessage(chatId, msg, { parse_mode:'Markdown' });
      return;
    }

    // /summary — ملخص سريع متكامل
    if (text === '/summary' || text === '/ملخص') {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0,7);
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      const daily = (db.dailyData||[]).filter(d=>d.date?.startsWith(thisMonth));
      const totalRev = daily.reduce((s,d)=>s+(d.total||0),0);
      const totalIns = daily.reduce((s,d)=>s+(d.insurance||0),0);
      const totalExp = (db.expenses||[]).filter(e=>e.date?.startsWith(thisMonth)).reduce((s,e)=>s+(e.amount||0),0);
      const pendingComm = (db.commissionHistory||[]).filter(c=>!c.paid).reduce((s,c)=>s+(c.commission||0),0);
      const lowStock = (db.invItems||[]).filter(i=>(parseFloat(i.qty??i.quantity??0))<=(parseFloat(i.minQty??i.minQuantity??0))).length;
      const pendingIns = (db.insuranceClaims||[]).filter(c=>c.status!=='received').reduce((s,c)=>s+(c.amount||0),0);
      const net = totalRev - totalExp;
      bot.sendMessage(chatId,
        `📋 *الملخص السريع — ${thisMonth}*\n\n` +
        `💰 الإيرادات: *${fmt(totalRev)} د.ك*\n` +
        `💸 المصاريف: ${fmt(totalExp)} د.ك\n` +
        `✅ الصافي: *${fmt(net)} د.ك*\n` +
        `🏥 التأمين: ${fmt(totalIns)} د.ك\n\n` +
        `⏳ عمولات معلقة: ${fmt(pendingComm)} د.ك\n` +
        `📋 مطالبات تأمين معلقة: ${fmt(pendingIns)} د.ك\n` +
        `📦 أصناف منخفضة: ${lowStock} صنف`,
        { parse_mode:'Markdown' }
      );
      return;
    }

    // Text commands
    if (text === '/start') {
      bot.sendMessage(chatId,
        '👋 *مرحباً بك في نظام بوبيان المحاسبي*\n\n' +
        '📊 *الإيرادات:*\n/income — إيرادات اليوم\n/stats — إحصائيات الشهر\n/summary — ملخص سريع\n\n' +
        '👨‍⚕️ *الدكاترة:*\n/comm — عمولات الدكاترة\n/pending — غير المدفوعة\n/doctors — تصنيف الدكاترة\n/goals — تقدم الأهداف\n\n' +
        '💸 *المصاريف:*\n📸 صوّر فاتورة — AI يقرأها تلقائياً\n/expense 50 مواد مختبر — إدخال يدوي\n/expenses — مصاريف الشهر\n\n' +
        '📦 *المخزون:*\n/stock — ملخص المخزون\n/lowstock — المنخفض فقط\n\n' +
        '🏥 *التأمين والموردون:*\n/insurance — حالة المطالبات\n/vendors — أرصدة الموردين\n\n' +
        '🤖 *الذكاء الاصطناعي:*\n/analyze — تحليل مالي ذكي\n/forecast — توقعات الشهر القادم\n\n' +
        '📂 ابعث Excel — يُحفَظ تلقائياً',
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [
            [{ text:'📊 إيرادات اليوم', callback_data:'quick_income' }, { text:'📋 ملخص الشهر', callback_data:'quick_summary' }],
            [{ text:'🏆 تصنيف الدكاترة', callback_data:'quick_doctors' }, { text:'🎯 الأهداف', callback_data:'quick_goals' }],
            [{ text:'📦 المخزون', callback_data:'quick_stock' }, { text:'⏳ عمولات معلقة', callback_data:'quick_pending' }],
            [{ text:'🤖 تحليل ذكي', callback_data:'quick_analyze' }]
          ]}
        }
      );
      return;
    }
    
    if (text === '/help') {
      bot.sendMessage(chatId,
        '📖 *قائمة الأوامر المتاحة*\n\n' +
        '/start — القائمة الرئيسية\n' +
        '/today — إيرادات اليوم\n' +
        '/income — تفصيل إيرادات اليوم\n' +
        '/stats — إحصائيات الشهر\n' +
        '/summary — ملخص سريع\n' +
        '/doctors — تصنيف الدكاترة\n' +
        '/goals — تقدم الأهداف\n' +
        '/stock — ملخص المخزون\n' +
        '/lowstock — المخزون المنخفض\n' +
        '/insurance — حالة التأمين\n' +
        '/vendors — أرصدة الموردين\n' +
        '/analyze — تحليل مالي بالذكاء الاصطناعي\n' +
        '/forecast — توقعات الشهر القادم\n' +
        '/report — تقرير شهري مختصر\n' +
        '/comm — عمولات الدكاترة\n' +
        '/pending — العمولات المعلقة\n' +
        '/expenses — مصاريف الشهر\n' +
        '/expense <مبلغ> <وصف> — إضافة مصروف',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/today') {
      const db = loadDB();
      const today = new Date().toISOString().split('T')[0];
      const dayData = (db.dailyData||[]).find(d => d.date === today);
      if (!dayData || !dayData.total) {
        bot.sendMessage(chatId, '📅 لا توجد إيرادات مسجلة لليوم ' + today);
        return;
      }
      const fmt = n => (parseFloat(n)||0).toFixed(3) + ' د.ك';
      bot.sendMessage(chatId,
        '📅 *إيرادات اليوم — ' + today + '*\n\n' +
        '💰 الإجمالي: ' + fmt(dayData.total) + '\n' +
        '🏥 التأمين: ' + fmt(dayData.insurance) + '\n' +
        (dayData.doctor ? '👨‍⚕️ الدكتور: ' + dayData.doctor + '\n' : '') +
        (dayData.notes ? '📝 ملاحظات: ' + dayData.notes : ''),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/report' || text.startsWith('/report ')) {
      const db = loadDB();
      const now = new Date();
      const targetMonth = text.split(' ')[1] || now.toISOString().substring(0,7);
      const daily = (db.dailyData||[]).filter(d => d.date.startsWith(targetMonth));
      if (!daily.length) { bot.sendMessage(chatId, '❌ لا توجد بيانات للفترة ' + targetMonth); return; }
      const totalRev = daily.reduce((s,d) => s+(parseFloat(d.total)||0), 0);
      const totalIns = daily.reduce((s,d) => s+(parseFloat(d.insurance)||0), 0);
      const expenses = (db.expenses||[]).filter(e => e.date && e.date.startsWith(targetMonth));
      const totalExp = expenses.reduce((s,e) => s+(parseFloat(e.amount)||0), 0);
      const net = totalRev - totalExp;
      const fmt = n => n.toFixed(3) + ' د.ك';
      const daysWorked = daily.filter(d=>d.total>0).length;
      bot.sendMessage(chatId,
        '📊 *التقرير الشهري — ' + targetMonth + '*\n\n' +
        '💰 إجمالي الإيرادات: ' + fmt(totalRev) + '\n' +
        '🏥 حصة التأمين: ' + fmt(totalIns) + '\n' +
        '💸 إجمالي المصاريف: ' + fmt(totalExp) + '\n' +
        '📈 صافي الربح: ' + fmt(net) + '\n' +
        '📅 أيام العمل: ' + daysWorked + '\n' +
        '📊 متوسط اليوم: ' + fmt(daysWorked > 0 ? totalRev/daysWorked : 0),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/stats' || text.startsWith('/stats ')) {
      const db = loadDB();
      const monthNames = {'01':'يناير','02':'فبراير','03':'مارس','04':'أبريل','05':'مايو','06':'يونيو','07':'يوليو','08':'أغسطس','09':'سبتمبر','10':'أكتوبر','11':'نوفمبر','12':'ديسمبر'};
      const allMonths = [...new Set(db.dailyData.map(d => d.date.substring(0,7)))].sort().reverse();
      if (!allMonths.length) { bot.sendMessage(chatId, '❌ لا توجد بيانات. ارفع ملف Excel أولاً.'); return; }
      const requestedMonth = text.split(' ')[1];
      const targetMonth = requestedMonth || allMonths[0];
      const daily = db.dailyData.filter(d => d.date.startsWith(targetMonth));
      const total = daily.reduce((s, d) => s + d.total, 0);
      const ins = daily.reduce((s, d) => s + d.insurance, 0);
      const insOrig = ins > 0 ? ins / 0.75 : 0;
      const insShare = insOrig * 0.25;
      const days = daily.filter(d => d.total > 0).length;
      const [y, m] = targetMonth.split('-');
      const monthLabel = (monthNames[m] || m) + ' ' + y;
      const otherMonths = allMonths.filter(mo => mo !== targetMonth).slice(0, 5);
      const otherStr = otherMonths.length ? '\n\n📅 *أشهر أخرى:*\n' + otherMonths.map(mo => {
        const [y2,m2] = mo.split('-'); return '• /stats ' + mo + ' — ' + (monthNames[m2]||m2) + ' ' + y2;
      }).join('\n') : '';
      bot.sendMessage(chatId,
        '📊 *إحصائيات ' + monthLabel + '*\n\n' +
        '💰 إجمالي الإيرادات: *' + total.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3}) + '* د.ك\n' +
        '🏥 حصة التأمين: ' + insShare.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3}) + ' د.ك\n' +
        '✅ صافي العيادة: *' + (total - insShare).toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3}) + '* د.ك\n' +
        '📅 أيام العمل: ' + days + ' يوم' + otherStr,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    if (text === '/comm') {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0, 7);
      const comms = db.commissionHistory.filter(c => c.month === thisMonth);
      
      if (!comms.length) { bot.sendMessage(chatId, 'لا توجد عمولات للشهر الحالي'); return; }
      
      let msg2 = `👨‍⚕️ *عمولات ${thisMonth}*\n\n`;
      for (const c of comms) {
        msg2 += `${c.doctor}\n`;
        msg2 += `  إيراد: ${c.revenue.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} | عمولة: ${c.commission.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك\n`;
        msg2 += `  ${c.paid ? '✅ مدفوع' : '⏳ غير مدفوع'}\n\n`;
      }
      bot.sendMessage(chatId, msg2, { parse_mode: 'Markdown' });
      return;
    }
    
    if (text === '/pending') {
      const db = loadDB();
      const pending = db.commissionHistory.filter(c => !c.paid);
      if (!pending.length) { bot.sendMessage(chatId, '✅ كل العمولات مدفوعة!'); return; }
      
      let msg3 = `⏳ *العمولات غير المدفوعة*\n\n`;
      const total = pending.reduce((s, c) => s + c.commission, 0);
      for (const c of pending) {
        msg3 += `• ${c.doctor} — ${c.month}: ${c.commission.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك\n`;
      }
      msg3 += `\n*الإجمالي: ${total.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك*`;
      bot.sendMessage(chatId, msg3, { parse_mode: 'Markdown' });
      return;
    }
    
    // /income — إيرادات اليوم
    if (text === '/income' || text === '/اليوم') {
      const db = loadDB();
      const today = new Date().toISOString().split('T')[0];
      const rec = (db.dailyData || []).find(d => d.date === today);
      if (!rec || !rec.total) {
        bot.sendMessage(chatId, `📅 *${today}*\n\nلم تُرفع بيانات اليوم بعد.\nأرسل ملف Excel أو استخدم /stats للأشهر السابقة.`, { parse_mode:'Markdown' });
        return;
      }
      const net = (rec.cash||0)+(rec.knet||0)+(rec.visa||0)+(rec.master||0)+(rec.link||0);
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      bot.sendMessage(chatId,
        `📅 *إيرادات ${today}*\n\n` +
        `💰 الإجمالي: *${fmt(rec.total)} د.ك*\n` +
        `  💵 كاش: ${fmt(rec.cash||0)} د.ك\n` +
        `  💳 K-Net: ${fmt(rec.knet||0)} د.ك\n` +
        `  💳 Visa: ${fmt(rec.visa||0)} د.ك\n` +
        `  🔗 Link: ${fmt(rec.link||0)} د.ك\n` +
        `  🏥 تأمين: ${fmt(rec.insurance||0)} د.ك\n` +
        `  ✅ صافي نقدي+شبكة: *${fmt(net)} د.ك*`,
        { parse_mode:'Markdown' }
      );
      return;
    }

    // /vendors — أرصدة الموردين
    if (text === '/vendors' || text === '/موردون') {
      const db = loadDB();
      const vendors = db.vendors || [];
      if (!vendors.length) { bot.sendMessage(chatId, '📭 لا يوجد موردون مسجّلون.'); return; }
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      const entries = db.journalEntries || [];
      let msg = `🏭 *أرصدة الموردين*\n\n`;
      let totalOwing = 0;
      vendors.forEach(v => {
        const vEntries = entries.filter(e => e.lines && e.lines.some(l => l.accountId === v.accountId));
        let balance = 0;
        vEntries.forEach(e => e.lines.forEach(l => { if(l.accountId===v.accountId){ balance += (l.credit||0)-(l.debit||0); }}));
        if (balance > 0) {
          msg += `• *${v.name}*: ${fmt(balance)} د.ك مستحق\n`;
          totalOwing += balance;
        }
      });
      if (totalOwing === 0) msg += '✅ لا توجد مستحقات للموردين حالياً.\n';
      else msg += `\n*الإجمالي المستحق: ${fmt(totalOwing)} د.ك*`;
      bot.sendMessage(chatId, msg, { parse_mode:'Markdown' });
      return;
    }

    // /insurance — حالة مطالبات التأمين
    if (text === '/insurance' || text === '/تأمين') {
      const db = loadDB();
      const claims = db.insuranceClaims || [];
      if (!claims.length) { bot.sendMessage(chatId, '🏥 لا توجد مطالبات تأمين مسجّلة.'); return; }
      const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
      const pending   = claims.filter(c => c.status === 'pending');
      const submitted = claims.filter(c => c.status === 'submitted');
      const received  = claims.filter(c => c.status === 'received');
      const totalPending = pending.concat(submitted).reduce((s,c) => s+(c.amount||0), 0);
      const totalReceived = received.reduce((s,c) => s+(c.receivedAmount||c.amount||0), 0);
      bot.sendMessage(chatId,
        `🏥 *مطالبات التأمين*\n\n` +
        `⏳ معلقة: *${pending.length}* مطالبة — ${fmt(pending.reduce((s,c)=>s+(c.amount||0),0))} د.ك\n` +
        `📤 مقدّمة: *${submitted.length}* مطالبة — ${fmt(submitted.reduce((s,c)=>s+(c.amount||0),0))} د.ك\n` +
        `✅ مستلمة: *${received.length}* مطالبة — ${fmt(totalReceived)} د.ك\n\n` +
        `💰 إجمالي المعلق: *${fmt(totalPending)} د.ك*`,
        { parse_mode:'Markdown' }
      );
      return;
    }

    // /analyze — AI تحليل شامل
    if (text === '/analyze' || text === '/تحليل') {
      if (!process.env.ANTHROPIC_API_KEY) { bot.sendMessage(chatId, '❌ ANTHROPIC_API_KEY غير مضبوط.'); return; }
      bot.sendMessage(chatId, '🤖 جاري التحليل الذكي...');
      try {
        const db = loadDB();
        const now = new Date();
        const thisMonth = now.toISOString().substring(0,7);
        const lastMonth = new Date(now.getFullYear(), now.getMonth()-1).toISOString().substring(0,7);
        const daily = db.dailyData || [];
        const expenses = db.expenses || [];
        const tmRev = daily.filter(d=>d.date.startsWith(thisMonth)).reduce((s,d)=>s+(d.total||0),0);
        const lmRev = daily.filter(d=>d.date.startsWith(lastMonth)).reduce((s,d)=>s+(d.total||0),0);
        const tmExp = expenses.filter(e=>e.date?.startsWith(thisMonth)).reduce((s,e)=>s+(e.amount||0),0);
        const lmExp = expenses.filter(e=>e.date?.startsWith(lastMonth)).reduce((s,e)=>s+(e.amount||0),0);
        const pendingComm = (db.commissionHistory||[]).filter(c=>!c.paid).reduce((s,c)=>s+(c.commission||0),0);
        const lowStock = (db.invItems||[]).filter(i=>(parseFloat(i.qty??i.quantity??0))<=(parseFloat(i.minQty??i.minQuantity??0))).length;
        const pendingClaims = (db.insuranceClaims||[]).filter(c=>c.status!=='received').reduce((s,c)=>s+(c.amount||0),0);
        const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
        const context = `بيانات عيادة بوبيان:\n- إيرادات ${thisMonth}: ${fmt(tmRev)} د.ك\n- إيرادات ${lastMonth}: ${fmt(lmRev)} د.ك\n- نمو الإيرادات: ${lmRev?((tmRev-lmRev)/lmRev*100).toFixed(1)+'%':'لا يوجد'}\n- مصاريف ${thisMonth}: ${fmt(tmExp)} د.ك\n- مصاريف ${lastMonth}: ${fmt(lmExp)} د.ك\n- صافي الشهر الحالي: ${fmt(tmRev-tmExp)} د.ك\n- عمولات معلقة: ${fmt(pendingComm)} د.ك\n- مطالبات تأمين معلقة: ${fmt(pendingClaims)} د.ك\n- أصناف مخزون منخفضة: ${lowStock}`;
        const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
          body: JSON.stringify({
            model:'claude-haiku-4-5-20251001', max_tokens:600,
            system:'أنت محلل مالي خبير لعيادة أسنان. قدّم تحليلاً موجزاً وذكياً باللغة العربية في 5-7 نقاط. استخدم إيموجي. ركّز على النقاط المهمة والتوصيات.',
            messages:[{role:'user',content:`حلّل هذه البيانات وأعطني أهم الملاحظات والتوصيات:\n${context}`}]
          })
        });
        const aiData = await aiResp.json();
        const analysis = aiData.content?.[0]?.text || 'لم أستطع التحليل';
        bot.sendMessage(chatId, `🤖 *التحليل الذكي — ${thisMonth}*\n\n${analysis}`, { parse_mode:'Markdown' });
      } catch(e) {
        bot.sendMessage(chatId, '❌ خطأ في التحليل: ' + e.message);
      }
      return;
    }

    // /forecast — AI توقع الشهر القادم
    if (text === '/forecast' || text === '/توقع') {
      if (!process.env.ANTHROPIC_API_KEY) { bot.sendMessage(chatId, '❌ ANTHROPIC_API_KEY غير مضبوط.'); return; }
      bot.sendMessage(chatId, '📈 جاري حساب التوقعات...');
      try {
        const db = loadDB();
        const daily = db.dailyData || [];
        const revByMonth = {};
        daily.forEach(d => {
          const m = d.date?.substring(0,7);
          if (m) revByMonth[m] = (revByMonth[m]||0) + (d.total||0);
        });
        const months = Object.entries(revByMonth).sort((a,b)=>a[0].localeCompare(b[0])).slice(-6);
        if (months.length < 2) { bot.sendMessage(chatId, '⚠️ البيانات غير كافية للتوقع. تحتاج على الأقل شهرين.'); return; }
        const fmt = n => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
        const history = months.map(([m,v])=>`${m}: ${fmt(v)} د.ك`).join('\n');
        const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
          body: JSON.stringify({
            model:'claude-haiku-4-5-20251001', max_tokens:400,
            system:'أنت محلل مالي. بناء على بيانات الإيرادات الشهرية، توقّع الشهر القادم. أجب باختصار بالعربية مع الرقم المتوقع والأسباب.',
            messages:[{role:'user',content:`إيرادات الأشهر الماضية:\n${history}\n\nتوقّع الشهر القادم مع تبرير.`}]
          })
        });
        const aiData = await aiResp.json();
        const forecast = aiData.content?.[0]?.text || 'لم أستطع التوقع';
        bot.sendMessage(chatId, `📈 *توقعات الشهر القادم*\n\n${forecast}`, { parse_mode:'Markdown' });
      } catch(e) {
        bot.sendMessage(chatId, '❌ خطأ: ' + e.message);
      }
      return;
    }

    // AI answer using Anthropic
    try {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0, 7);
      const daily = db.dailyData.filter(d => d.date.startsWith(thisMonth));
      const total = daily.reduce((s, d) => s + d.total, 0);
      const ins = daily.reduce((s, d) => s + d.insurance, 0);
      const comms = db.commissionHistory.filter(c => c.month === thisMonth);
      
      const context = `بيانات عيادة بوبيان لطب الأسنان - ${thisMonth}:
إجمالي الإيرادات: ${total.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك
التأمين المسجّل: ${ins.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك
أيام العمل: ${daily.filter(d=>d.total>0).length}
العمولات: ${comms.map(c=>`${c.doctor}: ${c.commission.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} د.ك (${c.paid?'مدفوع':'غير مدفوع'})`).join(', ')}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: `أنت مساعد محاسبي لعيادة بوبيان. ${context}. أجب باختصار بالعربي.`,
          messages: [{ role: 'user', content: text }]
        })
      });
      const data = await response.json();
      const answer = data.content?.[0]?.text || 'ما قدرت أجاوب';
      bot.sendMessage(chatId, answer);
    } catch(e) {
      bot.sendMessage(chatId, 'اكتب /stats أو /comm أو /pending للحصول على المعلومات');
    }
  });

  // ===== CALLBACK QUERIES (inline keyboard buttons) =====
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;
    const esc    = s => String(s||'').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

    const catMap = {'مواد مختبر':'5210','رواتب':'5100','إيجار':'5510','كهرباء':'5520','كهرباء/ماء':'5520','صيانة':'5540','تسويق':'5610','إقامة':'5720','تأشيرات':'5170','تأمين':'5740','هاتف':'5530','أخرى':'5670'};
    const payMethods = {
      pay_cash:   { code:'1100', name:'الصندوق — نقدي',              label:'💵 كاش' },
      pay_knet:   { code:'1120', name:'K-Net / Visa / Master',       label:'📳 K-Net' },
      pay_link:   { code:'1120', name:'K-Net / Visa / Master',       label:'🔗 Link' },
      pay_cheque: { code:'1110', name:'البنك — الحساب الجاري',       label:'🧾 شيك' },
    };

    // Quick-menu shortcuts from /start inline keyboard
    const quickHandlers = {
      quick_income:  '/income',
      quick_summary: '/summary',
      quick_doctors: '/doctors',
      quick_goals:   '/goals',
      quick_stock:   '/stock',
      quick_pending: '/pending',
      quick_analyze: '/analyze',
    };
    if (quickHandlers[data]) {
      bot.answerCallbackQuery(query.id);
      // Re-emit as if the user typed the command
      bot.emit('message', { ...query.message, text: quickHandlers[data], chat: query.message.chat, from: query.from });
      return;
    }

    // Step 1: user confirmed invoice data → ask payment method
    if (data === 'inv_confirm_data') {
      const db = loadDB();
      const pending = db.pendingInvoices?.[chatId];
      if (!pending) { bot.answerCallbackQuery(query.id, { text: 'انتهت الجلسة، أعد إرسال الفاتورة' }); return; }
      pending.step = 'choose_payment';
      saveDB(db);
      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId, '💳 كيف تم الدفع؟', { reply_markup: { inline_keyboard: [
        [{ text:'💵 كاش', callback_data:'pay_cash' }, { text:'📳 K-Net', callback_data:'pay_knet' }],
        [{ text:'🔗 Link', callback_data:'pay_link' }, { text:'🧾 شيك', callback_data:'pay_cheque' }],
        [{ text:'🤝 على الآجل (ذمم دائنة)', callback_data:'pay_credit' }],
        [{ text:'❌ إلغاء', callback_data:'inv_cancel' }]
      ]}});
      return;
    }

    // Step 2: payment method chosen → build journal entry → ask confirmation
    if (['pay_cash','pay_knet','pay_link','pay_cheque','pay_credit'].includes(data)) {
      const db = loadDB();
      const pending = db.pendingInvoices?.[chatId];
      if (!pending?.invoice) { bot.answerCallbackQuery(query.id, { text: 'انتهت الجلسة' }); return; }

      const invoice  = pending.invoice;
      const amount   = parseFloat(invoice.amount) || 0;
      const date     = invoice.date || new Date().toISOString().split('T')[0];
      const desc     = invoice.description || invoice.vendor || 'فاتورة';
      const accounts = db.chartOfAccounts || [];

      // Expense account
      const expCode = catMap[invoice.category || 'أخرى'] || '5670';
      const expAcc  = accounts.find(a => a.code === expCode) || { id: expCode, code: expCode, name: invoice.category || 'مصاريف متنوعة' };

      // Credit account
      let creditAcc, payLabel, vendorWarning = '';
      if (data === 'pay_credit') {
        const vendorName = (invoice.vendor || '').toLowerCase();
        const vendorAcc  = vendorName ? accounts.find(a => a.type === 'liability' && a.name.toLowerCase().includes(vendorName)) : null;
        if (vendorAcc) {
          creditAcc = vendorAcc;
          payLabel  = '🤝 على الآجل — ' + vendorAcc.name;
        } else {
          creditAcc    = accounts.find(a => a.code === '2100') || { id:'2100', code:'2100', name:'ذمم دائنة — موردون' };
          payLabel     = '🤝 على الآجل';
          vendorWarning = invoice.vendor
            ? `\n⚠️ المورد "${invoice.vendor}" غير موجود في شجرة الحسابات — تم استخدام "ذمم دائنة — موردون (2100)". أضفه من الموقع إن أردت.`
            : '';
        }
      } else {
        const pm  = payMethods[data];
        creditAcc = accounts.find(a => a.code === pm.code) || { id: pm.code, code: pm.code, name: pm.name };
        payLabel  = pm.label;
      }

      const jeId = 'JE-TG-' + Date.now();
      const je   = {
        id: jeId, date, desc, ref: 'TG-INV', type: 'ai',
        totalDebit: amount, totalCredit: amount, createdAt: new Date().toISOString(),
        lines: [
          { accountId: expAcc.id,    accountCode: expAcc.code,    accountName: expAcc.name,    debit: amount, credit: 0 },
          { accountId: creditAcc.id, accountCode: creditAcc.code, accountName: creditAcc.name, debit: 0,      credit: amount }
        ]
      };

      pending.step = 'confirm_journal';
      pending.payLabel = payLabel;
      pending.journalEntry = je;
      saveDB(db);

      bot.answerCallbackQuery(query.id);
      if (vendorWarning) bot.sendMessage(chatId, vendorWarning);
      bot.sendMessage(chatId,
        '📝 *القيد المحاسبي المقترح:*\n\n' +
        '📅 ' + esc(date) + ' — ' + esc(desc) + '\n' +
        '💳 ' + esc(payLabel) + '\n\n' +
        '  مدين:  ' + esc(expAcc.code) + ' — ' + esc(expAcc.name) + '\n' +
        '         ' + esc(amount.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})) + ' د.ك\n\n' +
        '  دائن:  ' + esc(creditAcc.code) + ' — ' + esc(creditAcc.name) + '\n' +
        '         ' + esc(amount.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})) + ' د.ك\n\n' +
        'راجع القيد — إذا مزبوط اضغط ترحيل:',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '✅ ترحيل وحفظ', callback_data: 'inv_save' },
          { text: '❌ إلغاء', callback_data: 'inv_cancel' }
        ]]}}
      );
      return;
    }

    // Step 3: save everything
    if (data === 'inv_save') {
      const db = loadDB();
      const pending = db.pendingInvoices?.[chatId];
      if (!pending?.journalEntry) { bot.answerCallbackQuery(query.id, { text: 'انتهت الجلسة' }); return; }

      const je      = pending.journalEntry;
      const invoice = pending.invoice;
      const amount  = parseFloat(invoice.amount) || 0;
      const date    = invoice.date || new Date().toISOString().split('T')[0];
      const desc    = invoice.description || invoice.vendor || 'فاتورة';

      if (!db.expenses)      db.expenses      = [];
      if (!db.journalEntries) db.journalEntries = [];

      db.expenses.push({ id: genId('exp-'), desc, cat: invoice.category || 'أخرى', amount, date, vendor: invoice.vendor || '', source: 'telegram_photo', journalId: je.id });
      db.journalEntries.push(je);
      db.journalEntries.sort((a,b) => b.date.localeCompare(a.date));
      delete db.pendingInvoices[chatId];
      saveDB(db);

      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId,
        '✅ *تم الترحيل والحفظ!*\n\n' +
        '💸 ' + desc + ' — ' + amount.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3}) + ' د.ك\n' +
        '💳 ' + (pending.payLabel || '') + '\n\n' +
        'القيد موجود في القيود اليومية على الموقع 🌐',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Cancel
    if (data === 'inv_cancel') {
      const db = loadDB();
      if (db.pendingInvoices) delete db.pendingInvoices[chatId];
      saveDB(db);
      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId, '❌ تم إلغاء الفاتورة.');
      return;
    }

    bot.answerCallbackQuery(query.id);
  });

  // Voice / audio → AI inventory query
  bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '🎙️ جاري معالجة رسالتك الصوتية...');
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const fileLink  = await bot.getFileLink(msg.voice.file_id);
      const https     = require('https');
      const http      = require('http');
      const client2   = fileLink.startsWith('https') ? https : http;
      const chunks    = [];
      await new Promise((resolve, reject) => {
        client2.get(fileLink, res => {
          res.on('data', d => chunks.push(d));
          res.on('end', resolve);
        }).on('error', reject);
      });
      const audioBase64 = Buffer.concat(chunks).toString('base64');

      const db    = loadDB();
      const items = db.invItems || [];
      const stockSummary = items.map(i => `${i.nameAr} [${i.code}]: ${i.qty} ${i.unit} @ ${i.cost.toLocaleString("en-US",{minimumFractionDigits:3,maximumFractionDigits:3})} KD`).join('\n');

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `أنت مساعد مخزون لعيادة أسنان. بيانات المخزون الحالية:\n${stockSummary || 'لا توجد أصناف'}\n\nأجب على سؤال المستخدم الصوتي بشكل موجز باللغة العربية.` },
            { type: 'document', source: { type: 'base64', media_type: 'audio/ogg', data: audioBase64 } }
          ]
        }]
      });
      bot.sendMessage(chatId, response.content[0].text, { parse_mode: 'Markdown' });
    } catch(e) {
      // Fallback: treat as text query if audio not supported
      bot.sendMessage(chatId, '❌ لم أتمكن من معالجة الصوت. استخدم /stock أو /item [اسم الصنف]');
    }
  });
}

// Auto-start bot if token saved (token stored as base64) — called after initDB()
function autoStartBot() {
  const db = loadDB();
  if (!db.telegramToken) return;
  try {
    const decoded = Buffer.from(db.telegramToken, 'base64').toString('utf8').trim().replace(/[\s\n\r]/g, '');
    if (decoded && /^\d+:[A-Za-z0-9_-]+$/.test(decoded)) {
      bot = new TelegramBot(decoded, { polling: { params: { timeout: 10 } } });
      setupBot(bot);
      console.log('✅ Telegram bot started automatically');
    } else {
      console.log('⚠️  Telegram token format invalid, skipping bot start');
    }
  } catch(e) {
    console.log('⚠️  Telegram token invalid, skipping bot start');
  }
}

// ===== EXPORT: EXCEL =====
app.get('/api/export/excel', (req, res) => {
  const db = loadDB();
  const { type = 'income', from, to } = req.query;
  const wb = XLSX.utils.book_new();

  const filterDate = arr => arr.filter(r => {
    const d = r.date || '';
    return (!from || d >= from) && (!to || d <= to);
  });

  const headerStyle = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0a1628' } }, alignment: { horizontal: 'center' } };

  if (type === 'income') {
    const data = filterDate(db.dailyData || []);
    const rows = [
      ['التاريخ', 'كاش', 'K-Net', 'Visa', 'Mastercard', 'تأمين', 'Link', 'الإجمالي'],
      ...data.map(d => [d.date, d.cash||0, d.knet||0, d.visa||0, d.master||0, d.insurance||0, d.link||0, d.total||0]),
      ['الإجمالي',
        data.reduce((s,d)=>s+(d.cash||0),0),
        data.reduce((s,d)=>s+(d.knet||0),0),
        data.reduce((s,d)=>s+(d.visa||0),0),
        data.reduce((s,d)=>s+(d.master||0),0),
        data.reduce((s,d)=>s+(d.insurance||0),0),
        data.reduce((s,d)=>s+(d.link||0),0),
        data.reduce((s,d)=>s+(d.total||0),0),
      ]
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [14,12,12,12,12,12,12,14].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'الإيرادات اليومية');

  } else if (type === 'expenses') {
    const data = filterDate(db.expenses || []);
    const rows = [
      ['التاريخ', 'البيان', 'الفئة', 'المبلغ (د.ك)'],
      ...data.map(e => [e.date, e.desc, e.cat, e.amount||0]),
      ['الإجمالي', '', '', data.reduce((s,e)=>s+(e.amount||0),0)]
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [14,30,16,14].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'المصاريف');

  } else if (type === 'financials') {
    const journals = filterDate(db.journalEntries || []);
    const coa = db.chartOfAccounts || [];
    const acName = {};
    coa.forEach(a => { acName[a.code] = a.name; });

    const bal = {};
    journals.forEach(je => {
      (je.lines||[]).forEach(l => {
        const key = l.accountCode || l.accountId || l.account || 'unknown';
        if (!bal[key]) bal[key] = { name: acName[key]||l.accountName||key, dr:0, cr:0 };
        bal[key].dr += parseFloat(l.debit)||0;
        bal[key].cr += parseFloat(l.credit)||0;
      });
    });

    // Income Statement sheet
    const incRows = [['الحساب', 'الكود', 'الإيرادات (د.ك)', 'المصاريف (د.ك)', 'الرصيد (د.ك)']];
    let totRev = 0, totExp = 0;
    Object.entries(bal).forEach(([code, b]) => {
      const n = parseInt(code);
      if (n >= 4000 && n < 5000) { const net = b.cr-b.dr; totRev+=net; incRows.push([b.name, code, net, '', net]); }
      if (n >= 5000 && n < 6000) { const net = b.dr-b.cr; totExp+=net; incRows.push([b.name, code, '', net, -net]); }
    });
    incRows.push(['', '', '', '', '']);
    incRows.push(['إجمالي الإيرادات', '', totRev, '', '']);
    incRows.push(['إجمالي المصاريف', '', '', totExp, '']);
    incRows.push([totRev-totExp >= 0 ? 'صافي الربح' : 'صافي الخسارة', '', '', '', totRev-totExp]);
    const wsInc = XLSX.utils.aoa_to_sheet(incRows);
    wsInc['!cols'] = [28,10,16,16,16].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsInc, 'قائمة الدخل');

    // Balance Sheet sheet
    const bsRows = [['البند', 'الكود', 'المبلغ (د.ك)']];
    bsRows.push(['═══ الأصول ═══', '', '']);
    let totAss = 0;
    Object.entries(bal).forEach(([code, b]) => {
      if (parseInt(code)>=1000 && parseInt(code)<2000) { const net=b.dr-b.cr; totAss+=net; bsRows.push([b.name, code, net]); }
    });
    bsRows.push(['إجمالي الأصول', '', totAss]);
    bsRows.push(['', '', '']);
    bsRows.push(['═══ الخصوم ═══', '', '']);
    let totLiab = 0;
    Object.entries(bal).forEach(([code, b]) => {
      if (parseInt(code)>=2000 && parseInt(code)<3000) { const net=b.cr-b.dr; totLiab+=net; bsRows.push([b.name, code, net]); }
    });
    bsRows.push(['إجمالي الخصوم', '', totLiab]);
    bsRows.push(['صافي الدخل (مرحّل)', '', totRev-totExp]);
    bsRows.push(['إجمالي الخصوم + حقوق الملكية', '', totLiab+(totRev-totExp)]);
    const wsBs = XLSX.utils.aoa_to_sheet(bsRows);
    wsBs['!cols'] = [30,10,16].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsBs, 'الميزانية العمومية');

  } else if (type === 'journal') {
    const data = filterDate(db.journalEntries || []);
    const rows = [['التاريخ', 'رقم القيد', 'البيان', 'الحساب', 'مدين (د.ك)', 'دائن (د.ك)', 'النوع']];
    data.forEach(je => {
      (je.lines||[]).forEach((l,i) => {
        rows.push([i===0?je.date:'', i===0?je.id:'', i===0?je.desc:'', l.accountName||l.account, l.debit||0, l.credit||0, i===0?je.type:'']);
      });
      rows.push(['','','','','','','']);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [12,18,24,20,14,14,12].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, 'القيود اليومية');
  }

  const fileName = `boubyan-${type}-${new Date().toISOString().substring(0,10)}.xlsx`;
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ===== EXPORT: PPTX =====
app.get('/api/export/pptx', (req, res) => {
  const db = loadDB();
  const { from, to } = req.query;

  // Try to use pptxgenjs if installed, else return JSON for client-side generation
  let PptxGenJS;
  try { PptxGenJS = require('pptxgenjs'); } catch(e) { PptxGenJS = null; }

  const filterDate = arr => arr.filter(r => {
    const d = r.date || '';
    return (!from || d >= from) && (!to || d <= to);
  });

  const daily = filterDate(db.dailyData || []);
  const expenses = filterDate(db.expenses || []);
  const journals = filterDate(db.journalEntries || []);

  const totRev   = daily.reduce((s,d)=>s+(d.total||0),0);
  const totExp   = expenses.reduce((s,e)=>s+(e.amount||0),0);
  const netInc   = totRev - totExp;
  const totCash  = daily.reduce((s,d)=>s+(d.cash||0),0);
  const totKnet  = daily.reduce((s,d)=>s+(d.knet||0),0);
  const totVisa  = daily.reduce((s,d)=>s+(d.visa||0),0);
  const totIns   = daily.reduce((s,d)=>s+(d.insurance||0),0);

  // By month
  const byMonth = {};
  daily.forEach(d => {
    const m = (d.date||'').substring(0,7);
    if (!byMonth[m]) byMonth[m] = 0;
    byMonth[m] += d.total||0;
  });

  if (!PptxGenJS) {
    // Return data for client-side use
    return res.json({ totRev, totExp, netInc, totCash, totKnet, totVisa, totIns, byMonth,
      workDays: daily.filter(d=>d.total>0).length, period: from ? `${from} → ${to||'الآن'}` : 'كل الفترات' });
  }

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = 'بوبيان للمحاسبة — تقرير دوري';

  const NAVY='0a1628', CYAN='00d4ff', GREEN='00ff9d', ORANGE='ff6b35', WHITE='FFFFFF', GRAY='94a3b8';
  const fmt = n => (+n).toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});

  // Slide 1: Title
  const s1 = pptx.addSlide();
  s1.background = { color: NAVY };
  s1.addShape(pptx.ShapeType.rect, { x:0, y:2.5, w:10, h:0.05, fill:{color:CYAN} });
  s1.addText('بوبيان لطب الأسنان', { x:0.5, y:0.8, w:9, h:1, fontSize:40, bold:true, color:WHITE, align:'center', fontFace:'Arial' });
  s1.addText('التقرير المالي الدوري', { x:0.5, y:1.8, w:9, h:0.6, fontSize:22, color:CYAN, align:'center', fontFace:'Arial' });
  s1.addText(from ? `الفترة: ${from} → ${to||'الآن'}` : 'كل الفترات', { x:0.5, y:2.8, w:9, h:0.5, fontSize:14, color:GRAY, align:'center', fontFace:'Arial' });

  // Slide 2: KPIs
  const s2 = pptx.addSlide();
  s2.background = { color: NAVY };
  s2.addText('المؤشرات الرئيسية', { x:0.3, y:0.2, w:9.4, h:0.6, fontSize:24, bold:true, color:WHITE, fontFace:'Arial' });
  const kpis = [
    { label:'إجمالي الإيرادات', val:fmt(totRev)+' د.ك', color:CYAN,  x:0.3 },
    { label:'إجمالي المصاريف',  val:fmt(totExp)+' د.ك', color:ORANGE, x:2.65 },
    { label:'صافي الربح',       val:fmt(netInc)+' د.ك', color:GREEN,  x:5.0 },
    { label:'أيام العمل',       val:String(daily.filter(d=>d.total>0).length)+' يوم', color:'fbbf24', x:7.35 },
  ];
  kpis.forEach(k => {
    s2.addShape(pptx.ShapeType.roundRect, { x:k.x, y:0.9, w:2.25, h:1.6, fill:{color:'111827'}, line:{color:k.color,pt:1}, rectRadius:0.1 });
    s2.addText(k.val,   { x:k.x, y:1.1, w:2.25, h:0.7, fontSize:16, bold:true, color:k.color, align:'center', fontFace:'IBM Plex Mono' });
    s2.addText(k.label, { x:k.x, y:1.9, w:2.25, h:0.4, fontSize:10, color:GRAY, align:'center', fontFace:'Arial' });
  });

  // Slide 3: Payment breakdown
  const s3 = pptx.addSlide();
  s3.background = { color: NAVY };
  s3.addText('توزيع طرق الدفع', { x:0.3, y:0.2, w:9.4, h:0.6, fontSize:24, bold:true, color:WHITE, fontFace:'Arial' });
  const pays = [ ['كاش',totCash,CYAN], ['K-Net',totKnet,GREEN], ['Visa',totVisa,ORANGE], ['تأمين',totIns,'f87171'] ];
  pays.forEach(([label,val,color],i) => {
    const pct = totRev > 0 ? (val/totRev*100).toFixed(1)+'%' : '0%';
    s3.addShape(pptx.ShapeType.roundRect, { x:0.3+i*2.4, y:0.9, w:2.2, h:2.0, fill:{color:'111827'}, line:{color,pt:1}, rectRadius:0.1 });
    s3.addText(pct,        { x:0.3+i*2.4, y:1.0, w:2.2, h:0.7, fontSize:28, bold:true, color, align:'center', fontFace:'IBM Plex Mono' });
    s3.addText(fmt(val)+' د.ك', { x:0.3+i*2.4, y:1.8, w:2.2, h:0.35, fontSize:11, color:WHITE, align:'center', fontFace:'Arial' });
    s3.addText(label,      { x:0.3+i*2.4, y:2.2, w:2.2, h:0.4, fontSize:12, color:GRAY, align:'center', fontFace:'Arial' });
  });

  // Slide 4: Monthly trend table
  const months = Object.keys(byMonth).sort();
  if (months.length > 0) {
    const s4 = pptx.addSlide();
    s4.background = { color: NAVY };
    s4.addText('الإيرادات الشهرية', { x:0.3, y:0.2, w:9.4, h:0.6, fontSize:24, bold:true, color:WHITE, fontFace:'Arial' });
    const tableRows = [
      [{ text:'الشهر',fontSize:11,bold:true,color:WHITE,fill:{color:'111827'} }, { text:'الإيراد (د.ك)',fontSize:11,bold:true,color:WHITE,fill:{color:'111827'} }],
      ...months.map(m => [{ text:m,fontSize:10,color:GRAY }, { text:fmt(byMonth[m]),fontSize:10,color:CYAN }])
    ];
    s4.addTable(tableRows, { x:1.5, y:0.9, w:7, colW:[4,3], border:{color:'1e2d45',pt:0.5} });
  }

  // Slide 5: Closing
  const s5 = pptx.addSlide();
  s5.background = { color: NAVY };
  s5.addShape(pptx.ShapeType.rect, { x:0, y:2.5, w:10, h:0.05, fill:{color:CYAN} });
  s5.addText('شكراً', { x:0.5, y:1.2, w:9, h:1, fontSize:48, bold:true, color:WHITE, align:'center', fontFace:'Arial' });
  s5.addText('بوبيان لطب الأسنان — نظام المحاسبة الذكي', { x:0.5, y:2.8, w:9, h:0.5, fontSize:13, color:GRAY, align:'center', fontFace:'Arial' });

  const fileName = `boubyan-report-${new Date().toISOString().substring(0,10)}.pptx`;
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  pptx.write('nodebuffer').then(buf => res.send(buf)).catch(e => res.status(500).json({ error: e.message }));
});

// ===== SCHEDULED REPORTS =====
// API to get/set schedule config
app.get('/api/schedule', (req, res) => {
  const db = loadDB();
  res.json(db.scheduleConfig || { weeklyReport: true, weeklyDay: 0, monthlyReport: true });
});

app.post('/api/schedule', (req, res) => {
  const db = loadDB();
  db.scheduleConfig = { ...db.scheduleConfig, ...req.body };
  saveDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
// AUTOMATION ENGINE — runs every hour
// ═══════════════════════════════════════════════════
function getAutoCfg() {
  const cfg = loadConfig();
  return cfg.automation || {};
}

function tgSend(msg, opts) {
  const db = loadDB();
  const chatId = (db.scheduleConfig||{}).chatId || process.env.TG_CHAT_ID;
  if (!global._tgBot || !chatId) return;
  global._tgBot.sendMessage(chatId, msg, opts||{}).catch(()=>{});
}

const fmt3 = n => Number(n||0).toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});

function runScheduledTasks() {
  if (!global._tgBot) return;
  const db  = loadDB();
  const aut = getAutoCfg();
  const cfg = db.scheduleConfig || {};
  const now = new Date();
  const hour    = now.getHours();
  const day     = now.getDay();
  const date    = now.getDate();
  const todayStr = now.toISOString().substring(0,10);
  const thisMonth = todayStr.substring(0,7);

  // ── 1. ملخص يومي (كل مساء — الساعة القابلة للتخصيص)
  const dailyHour = Number(aut.dailySummary?.hour ?? 20);
  if (aut.dailySummary?.enabled !== false && hour === dailyHour) {
    const lastKey = 'lastDailySummary';
    if (cfg[lastKey] !== todayStr) {
      const dayRec = (db.dailyData||[]).find(d => d.date === todayStr);
      const yestStr = new Date(now-864e5).toISOString().substring(0,10);
      const yestRec = (db.dailyData||[]).find(d => d.date === yestStr);
      const todayRev = dayRec?.total || 0;
      const yestRev  = yestRec?.total || 0;
      const todayExp = (db.expenses||[]).filter(e=>e.date===todayStr).reduce((s,e)=>s+(e.amount||0),0);
      const diff = todayRev - yestRev;
      const arrow = diff > 0 ? '📈' : diff < 0 ? '📉' : '➡️';
      tgSend(
        `🌙 *ملخص ${todayStr}*\n\n` +
        `💰 الإيرادات: *${fmt3(todayRev)} د.ك* ${arrow}\n` +
        `💸 المصاريف: ${fmt3(todayExp)} د.ك\n` +
        `📊 الصافي: *${fmt3(todayRev-todayExp)} د.ك*\n` +
        (yestRev ? `\nمقارنة بالأمس: ${diff>=0?'+':''}${fmt3(diff)} د.ك` : '') +
        `\n\n_تقرير يومي تلقائي_`,
        { parse_mode:'Markdown' }
      );
      db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
      saveDB(db);
    }
  }

  // ── 2. تقرير أسبوعي (الأحد أو اليوم المحدد الساعة 9)
  if (cfg.weeklyReport !== false && day === (cfg.weeklyDay ?? 0) && hour === 9) {
    const lastKey = 'lastWeeklyReport';
    if (cfg[lastKey] !== todayStr) {
      const d7 = new Date(now); d7.setDate(d7.getDate()-7);
      const from7 = d7.toISOString().substring(0,10);
      const week  = (db.dailyData||[]).filter(d=>d.date>=from7);
      const totRev = week.reduce((s,d)=>s+(d.total||0),0);
      const totExp = (db.expenses||[]).filter(e=>e.date>=from7).reduce((s,e)=>s+(e.amount||0),0);
      tgSend(
        `📅 *التقرير الأسبوعي — ${from7} إلى ${todayStr}*\n\n` +
        `💰 الإيرادات: *${fmt3(totRev)} د.ك*\n` +
        `💸 المصاريف: *${fmt3(totExp)} د.ك*\n` +
        `📊 صافي الربح: *${fmt3(totRev-totExp)} د.ك*\n` +
        `🗓 أيام العمل: ${week.filter(d=>d.total>0).length} يوم\n\n_تقرير أسبوعي_`,
        { parse_mode:'Markdown' }
      );
      db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
      saveDB(db);
    }
  }

  // ── 3. تقرير شهري (أول الشهر الساعة 9)
  if (cfg.monthlyReport !== false && date === 1 && hour === 9) {
    const lastKey = 'lastMonthlyReport';
    if (cfg[lastKey] !== todayStr) {
      const prevMonth = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().substring(0,7);
      const mDays = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(prevMonth));
      const totRev = mDays.reduce((s,d)=>s+(d.total||0),0);
      const totExp = (db.expenses||[]).filter(e=>(e.date||'').startsWith(prevMonth)).reduce((s,e)=>s+(e.amount||0),0);
      tgSend(
        `📊 *التقرير الشهري — ${prevMonth}*\n\n` +
        `💰 الإيرادات: *${fmt3(totRev)} د.ك*\n` +
        `  ├ كاش: ${fmt3(mDays.reduce((s,d)=>s+(d.cash||0),0))} د.ك\n` +
        `  ├ K-Net: ${fmt3(mDays.reduce((s,d)=>s+(d.knet||0),0))} د.ك\n` +
        `  └ تأمين: ${fmt3(mDays.reduce((s,d)=>s+(d.insurance||0),0))} د.ك\n` +
        `💸 المصاريف: *${fmt3(totExp)} د.ك*\n` +
        `📈 صافي الربح: *${fmt3(totRev-totExp)} د.ك*\n` +
        `🗓 أيام العمل: ${mDays.filter(d=>d.total>0).length} يوم\n\n_تقرير شهري تلقائي_`,
        { parse_mode:'Markdown' }
      );
      db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
      saveDB(db);
    }
  }

  // ── 4. تذكير عمولات معلقة (الخميس الساعة 10)
  const pendDay = Number(aut.pendingReminder?.dayOfWeek ?? 4);
  if (aut.pendingReminder?.enabled !== false && day === pendDay && hour === 10) {
    const lastKey = 'lastPendingReminder';
    if (cfg[lastKey] !== todayStr) {
      const pending = (db.commissionHistory||[]).filter(c=>!c.paid);
      if (pending.length > 0) {
        const total = pending.reduce((s,c)=>s+(c.commission||0),0);
        let msg = `⏰ *تذكير — عمولات غير مدفوعة*\n\n`;
        pending.forEach(c => { msg += `• ${c.doctor} (${c.month}): ${fmt3(c.commission)} د.ك\n`; });
        msg += `\n*الإجمالي: ${fmt3(total)} د.ك*\n_يرجى الصرف قريباً_`;
        tgSend(msg, { parse_mode:'Markdown' });
        db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
        saveDB(db);
      }
    }
  }

  // ── 5. تنبيه مطالبات التأمين المتأخرة (يومياً الساعة 11)
  const insDays = Number(aut.insuranceAlert?.daysThreshold ?? 30);
  if (aut.insuranceAlert?.enabled !== false && hour === 11) {
    const lastKey = 'lastInsuranceAlert';
    if (cfg[lastKey] !== todayStr) {
      const cutoff = new Date(now - insDays*864e5).toISOString().substring(0,10);
      const old = (db.insuranceClaims||[]).filter(c => c.status !== 'received' && c.date < cutoff);
      if (old.length > 0) {
        const total = old.reduce((s,c)=>s+(c.amount||0),0);
        tgSend(
          `🏥 *تنبيه — مطالبات تأمين متأخرة (+${insDays} يوم)*\n\n` +
          old.slice(0,5).map(c=>`• ${c.patientName||c.description||'مطالبة'} (${c.date}): ${fmt3(c.amount)} د.ك`).join('\n') +
          (old.length>5 ? `\n... و${old.length-5} مطالبات أخرى` : '') +
          `\n\n*الإجمالي المعلق: ${fmt3(total)} د.ك*`,
          { parse_mode:'Markdown' }
        );
        db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
        saveDB(db);
      }
    }
  }

  // ── 6. تذكير إغلاق الشهر (آخر N أيام الساعة 9)
  const closingDays = Number(aut.closingReminder?.daysBeforeEnd ?? 3);
  if (aut.closingReminder?.enabled !== false && hour === 9) {
    const lastDay = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    if (date >= lastDay - closingDays + 1) {
      const lastKey = 'lastClosingReminder';
      if (cfg[lastKey] !== todayStr) {
        const daysLeft = lastDay - date;
        tgSend(
          `📋 *تذكير — إغلاق الشهر*\n\n` +
          `⏰ تبقّى *${daysLeft} ${daysLeft===1?'يوم':'أيام'}* على نهاية ${thisMonth}\n\n` +
          `✅ تأكد من:\n• رفع جميع بيانات الإيرادات\n• تسوية الصندوق\n• مراجعة مطالبات التأمين\n• تسوية البنك\n• قيود الاستهلاك`,
          { parse_mode:'Markdown' }
        );
        db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
        saveDB(db);
      }
    }
  }

  // ── 7. فحص المخزون المنخفض (يومياً الساعة 8)
  if (aut.inventoryAlert?.enabled !== false && hour === 8) {
    const lastKey = 'lastInventoryCheck';
    if (cfg[lastKey] !== todayStr) {
      const _iqty = i => parseFloat(i.qty??i.quantity??0);
      const _iminq = i => parseFloat(i.minQty??i.minQuantity??0);
      const _inm = i => i.nameAr||i.name||i.nameEn||'—';
      const low = (db.invItems||[]).filter(i => _iqty(i) <= _iminq(i));
      if (low.length > 0) {
        const out = low.filter(i=>_iqty(i)<=0);
        const min = low.filter(i=>_iqty(i)>0);
        let msg = `📦 *تنبيه المخزون — ${todayStr}*\n\n`;
        if (out.length) msg += `🔴 *نفد (${out.length}):*\n`+out.map(i=>`  • ${_inm(i)}`).join('\n')+'\n\n';
        if (min.length) msg += `🟡 *منخفض (${min.length}):*\n`+min.map(i=>`  • ${_inm(i)}: ${_iqty(i)} ${i.unit||''} (حد: ${_iminq(i)})`).join('\n');
        tgSend(msg, { parse_mode:'Markdown' });
        db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
        saveDB(db);
      }
    }
  }

  // ── 8. تحليل انحراف الإيراد اليومي (يومياً الساعة 21)
  // يقارن إيراد اليوم بمتوسط آخر 30 يوم — ينبّه إذا كان الانحراف > 30%
  if (aut.revenueVariance?.enabled !== false && hour === 21) {
    const lastKey = 'lastRevenueVariance';
    if (cfg[lastKey] !== todayStr) {
      const dayRec = (db.dailyData||[]).find(d => d.date === todayStr);
      const todayRev = dayRec?.total || 0;
      const past30 = (db.dailyData||[])
        .filter(d => d.date < todayStr && d.total > 0)
        .slice(-30);
      if (past30.length >= 5 && todayRev > 0) {
        const avg30 = past30.reduce((s,d)=>s+(d.total||0),0) / past30.length;
        const threshold = Number(aut.revenueVariance?.threshold ?? 30) / 100;
        const variance = (todayRev - avg30) / avg30;
        if (Math.abs(variance) > threshold) {
          const icon = variance > 0 ? '📈' : '📉';
          const dir  = variance > 0 ? 'أعلى' : 'أدنى';
          tgSend(
            `${icon} *تحليل الإيراد — ${todayStr}*\n\n` +
            `💰 إيراد اليوم: *${fmt3(todayRev)} د.ك*\n` +
            `📊 المتوسط (30 يوم): ${fmt3(avg30)} د.ك\n` +
            `⚡ الانحراف: *${dir} بنسبة ${(Math.abs(variance)*100).toFixed(1)}%*\n\n` +
            (variance < 0
              ? `_الإيراد أقل من المعتاد — يُنصح بمراجعة السجلات_`
              : `_يوم ممتاز! الإيراد فوق المتوسط_`),
            { parse_mode:'Markdown' }
          );
          db.scheduleConfig = { ...cfg, [lastKey]: todayStr };
          saveDB(db);
        }
      }
    }
  }

  // ── 9. تصنيف الدكاترة شهرياً (يوم 5 من كل شهر الساعة 9)
  if (aut.doctorRanking?.enabled !== false && date === 5 && hour === 9) {
    const lastKey = 'lastDoctorRanking';
    const rankMonth = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().substring(0,7);
    if (cfg[lastKey] !== rankMonth) {
      const mEntries = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(rankMonth));
      const drMap = {};
      mEntries.forEach(day => {
        (day.doctors||[]).forEach(dr => {
          drMap[dr.name] = (drMap[dr.name]||0) + (dr.revenue||0);
        });
      });
      const ranked = Object.entries(drMap).sort((a,b)=>b[1]-a[1]);
      if (ranked.length > 0) {
        const medals = ['🥇','🥈','🥉'];
        let msg = `🏆 *تصنيف الدكاترة — ${rankMonth}*\n\n`;
        ranked.forEach(([name, rev], i) => {
          const medal = medals[i] || `${i+1}.`;
          msg += `${medal} ${name}: *${fmt3(rev)} د.ك*\n`;
        });
        const total = ranked.reduce((s,[,r])=>s+r,0);
        msg += `\n📊 إجمالي الشهر: *${fmt3(total)} د.ك*`;
        tgSend(msg, { parse_mode:'Markdown' });
        db.scheduleConfig = { ...cfg, [lastKey]: rankMonth };
        saveDB(db);
      }
    }
  }

  // ── 10. تذكير تقدم الأهداف منتصف الشهر (يوم 15 الساعة 10)
  if (aut.goalProgress?.enabled !== false && date === 15 && hour === 10) {
    const lastKey = 'lastGoalProgress';
    if (cfg[lastKey] !== thisMonth) {
      const doctors = db.doctors || [];
      const mEntries = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(thisMonth));
      const drRevMap = {};
      mEntries.forEach(day => {
        (day.doctors||[]).forEach(dr => {
          drRevMap[dr.name] = (drRevMap[dr.name]||0) + (dr.revenue||0);
        });
      });
      const withTarget = doctors.filter(d=>d.target>0);
      if (withTarget.length > 0) {
        let msg = `🎯 *تقدم الأهداف — منتصف ${thisMonth}*\n\n`;
        withTarget.forEach(dr => {
          const rev = drRevMap[dr.name] || 0;
          const pct = Math.round((rev / dr.target) * 100);
          const bar = '█'.repeat(Math.min(10,Math.floor(pct/10))) + '░'.repeat(Math.max(0,10-Math.floor(pct/10)));
          const icon = pct >= 50 ? '✅' : pct >= 30 ? '⚠️' : '🔴';
          msg += `${icon} ${dr.name}\n  ${bar} ${pct}%\n  ${fmt3(rev)} / ${fmt3(dr.target)} د.ك\n\n`;
        });
        tgSend(msg, { parse_mode:'Markdown' });
        db.scheduleConfig = { ...cfg, [lastKey]: thisMonth };
        saveDB(db);
      }
    }
  }
}

// تنبيه فوري عند نفاد مخزون صنف
function checkInventoryAlert(item) {
  const aut = getAutoCfg();
  const _qty = parseFloat(item.qty??item.quantity??0);
  const _minq = parseFloat(item.minQty??item.minQuantity??0);
  const _nm = item.nameAr||item.name||item.nameEn||'—';
  if (!aut.inventoryAlert?.enabled || _qty > _minq) return;
  const icon = _qty <= 0 ? '🔴 *نفد*' : '🟡 *منخفض*';
  tgSend(`📦 ${icon}: *${_nm}*\nالكمية: ${_qty} ${item.unit||''} | الحد الأدنى: ${_minq}`, { parse_mode:'Markdown' });
}

// تنبيه فوري عند شذوذ مصروف
async function checkExpenseAnomaly(expense) {
  const aut = getAutoCfg();
  if (!aut.anomalyDetection?.enabled) return;
  const multiplier = Number(aut.anomalyDetection?.multiplier ?? 2);
  const db = loadDB();
  const now = new Date().toISOString().substring(0,7);
  const sameCategory = (db.expenses||[]).filter(e => e.cat === expense.cat && e.date?.substring(0,7) !== now);
  if (sameCategory.length < 3) return;
  const avg = sameCategory.reduce((s,e)=>s+(e.amount||0),0) / sameCategory.length;
  if (expense.amount > avg * multiplier) {
    tgSend(
      `⚠️ *مصروف غير عادي — تنبيه ذكي*\n\n` +
      `📂 الفئة: ${expense.cat}\n` +
      `💰 المبلغ: *${fmt3(expense.amount)} د.ك*\n` +
      `📊 المعدل الطبيعي: ${fmt3(avg)} د.ك\n` +
      `📈 الفرق: *${((expense.amount/avg-1)*100).toFixed(0)}% أعلى من المعتاد*\n` +
      `📝 الوصف: ${expense.desc||'—'}`,
      { parse_mode:'Markdown' }
    );
  }
}

// تنبيه فوري عند تجاوز هدف الدكتور
function checkTargetAchievement(doctor, newRevenue) {
  const aut = getAutoCfg();
  if (!aut.targetAlert?.enabled) return;
  const db = loadDB();
  const dr = (db.doctors||[]).find(d => d.name === doctor);
  if (!dr || !dr.target) return;
  if (newRevenue >= dr.target) {
    tgSend(
      `🎯 *تجاوز الهدف!*\n\n` +
      `👨‍⚕️ الدكتور: *${doctor}*\n` +
      `💰 الإيراد الحالي: *${fmt3(newRevenue)} د.ك*\n` +
      `🎯 الهدف الشهري: ${fmt3(dr.target)} د.ك\n` +
      `📈 التجاوز: *${fmt3(newRevenue-dr.target)} د.ك (${((newRevenue/dr.target-1)*100).toFixed(0)}%)*`,
      { parse_mode:'Markdown' }
    );
  }
}

// Check every hour
setInterval(runScheduledTasks, 60 * 60 * 1000);
// Also check on startup after 5 seconds
setTimeout(runScheduledTasks, 5000);

// ═══════════════════════════════════════════════════
// MONTHLY REPORT SLIDE — HTML Presentation
// ═══════════════════════════════════════════════════
app.get('/api/monthly-report-slide', async (req, res) => {
  const db = loadDB();
  const now = new Date();
  const targetMonth = req.query.month || now.toISOString().substring(0, 7);
  const [yr, mo] = targetMonth.split('-').map(Number);
  const monthNames = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const monthLabel = `${monthNames[mo-1]} ${yr}`;

  const daily    = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(targetMonth));
  const expenses = (db.expenses||[]).filter(e=>(e.date||'').startsWith(targetMonth));
  const claims   = (db.insuranceClaims||[]);

  const totalRev = daily.reduce((s,d)=>s+(d.total||0),0);
  const cashRev  = daily.reduce((s,d)=>s+(d.cash||0),0);
  const knetRev  = daily.reduce((s,d)=>s+(d.knet||0)+(d.visa||0)+(d.master||0),0);
  const insRev   = daily.reduce((s,d)=>s+(d.insurance||0),0);
  const linkRev  = daily.reduce((s,d)=>s+(d.link||0),0);
  const totalExp = expenses.reduce((s,e)=>s+(e.amount||0),0);
  const netProfit = totalRev - totalExp;
  const margin   = totalRev ? (netProfit/totalRev*100).toFixed(1) : 0;
  const workDays = daily.filter(d=>d.total>0).length;
  const avgPerDay = workDays ? (totalRev/workDays).toFixed(3) : 0;

  // Previous month for comparison
  const prevMonth = new Date(yr, mo-2).toISOString().substring(0,7);
  const prevRev = (db.dailyData||[]).filter(d=>(d.date||'').startsWith(prevMonth)).reduce((s,d)=>s+(d.total||0),0);
  const revGrowth = prevRev ? ((totalRev-prevRev)/prevRev*100).toFixed(1) : null;

  // Top doctor
  const drRev = {};
  (db.paymentsData||[]).filter(p=>(p.date||'').startsWith(targetMonth)).forEach(p=>{
    if(p.doctor && p.doctor!=='Advance') drRev[p.doctor]=(drRev[p.doctor]||0)+(p.total||0);
  });
  const topDr = Object.entries(drRev).sort((a,b)=>b[1]-a[1])[0];

  // Expense categories
  const expCat = {};
  expenses.forEach(e=>{ expCat[e.cat||'أخرى']=(expCat[e.cat||'أخرى']||0)+(e.amount||0); });
  const topExpCats = Object.entries(expCat).sort((a,b)=>b[1]-a[1]).slice(0,5);

  // Pending insurance
  const pendingIns = claims.filter(c=>c.status!=='received').reduce((s,c)=>s+(c.amount||0),0);

  const f = v => (+v).toLocaleString('ar-KW',{minimumFractionDigits:3,maximumFractionDigits:3});

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>التقرير المالي الشهري — ${monthLabel}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
:root{
  --bg:#040915;--surface:#080d1e;--surface2:#0d1530;
  --accent:#4f8ef7;--accent2:#2dd4bf;--gold:#fbbf24;
  --danger:#f87171;--text:#e4ecff;--text2:#94a3b8;--border:#1a2d57;
}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',Tahoma,Arial,sans-serif;min-height:100vh;overflow-x:hidden;}
body::before{content:'';position:fixed;inset:0;background-image:radial-gradient(circle,rgba(79,142,247,.05) 1px,transparent 1px);background-size:24px 24px;pointer-events:none;}

.slides-wrap{width:100%;max-width:1100px;margin:0 auto;padding:24px;}

/* ── Slide Card ── */
.slide{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:36px;margin-bottom:24px;position:relative;overflow:hidden;}
.slide::before{content:'';position:absolute;top:0;right:0;width:4px;height:100%;background:linear-gradient(180deg,var(--accent),var(--accent2));}

/* ── Cover Slide ── */
.slide-cover{background:linear-gradient(135deg,#060d2a 0%,#0e1c3a 50%,#040915 100%);text-align:center;padding:64px 48px;}
.slide-cover .logo-circle{width:80px;height:80px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:24px;display:flex;align-items:center;justify-content:center;font-size:36px;margin:0 auto 24px;}
.slide-cover h1{font-size:32px;font-weight:800;letter-spacing:-.02em;margin-bottom:8px;}
.slide-cover .subtitle{font-size:16px;color:var(--text2);margin-bottom:32px;}
.slide-cover .period-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(79,142,247,.12);border:1px solid rgba(79,142,247,.3);border-radius:99px;padding:8px 20px;font-size:14px;color:var(--accent);}

/* ── KPI Grid ── */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:0;}
.kpi{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:20px 16px;text-align:center;position:relative;overflow:hidden;}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--kpi-color,var(--accent));}
.kpi .kpi-label{font-size:11px;color:var(--text2);margin-bottom:8px;letter-spacing:.02em;}
.kpi .kpi-value{font-size:22px;font-weight:800;font-family:monospace;letter-spacing:-.01em;}
.kpi .kpi-sub{font-size:10px;color:var(--text2);margin-top:4px;}
.kpi.good{--kpi-color:var(--accent2);}
.kpi.warn{--kpi-color:var(--gold);}
.kpi.bad{--kpi-color:var(--danger);}

/* ── Section title ── */
.slide-title{font-size:20px;font-weight:700;margin-bottom:24px;display:flex;align-items:center;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--border);}
.slide-num{font-size:10px;color:var(--text2);position:absolute;top:20px;left:36px;font-family:monospace;}

/* ── Chart containers ── */
.chart-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.chart-box{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:16px;}
.chart-box h3{font-size:12px;color:var(--text2);margin-bottom:12px;}

/* ── Table ── */
.rtable{width:100%;border-collapse:collapse;font-size:12px;}
.rtable th{background:var(--surface2);padding:10px 14px;text-align:right;font-weight:600;color:var(--text2);border-bottom:1px solid var(--border);}
.rtable td{padding:8px 14px;border-bottom:1px solid rgba(26,45,87,.5);color:var(--text);}
.rtable tr:last-child td{border-bottom:none;font-weight:700;}
.rtable .num{text-align:left;font-family:monospace;}
.rtable .good{color:var(--accent2);}
.rtable .bad{color:var(--danger);}

/* ── Insight Cards ── */
.insights{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}
.insight{background:var(--surface2);border-radius:10px;padding:16px;border-right:3px solid var(--insight-color,var(--accent));}
.insight.good{--insight-color:var(--accent2);}
.insight.warn{--insight-color:var(--gold);}
.insight.bad{--insight-color:var(--danger);}
.insight .ins-label{font-size:10px;color:var(--text2);margin-bottom:6px;}
.insight .ins-val{font-size:14px;font-weight:700;}

/* ── Print / Nav ── */
.print-btn{position:fixed;bottom:24px;left:24px;background:var(--accent);color:#fff;border:none;border-radius:10px;padding:12px 20px;font-size:13px;cursor:pointer;font-family:inherit;box-shadow:0 4px 20px rgba(79,142,247,.4);z-index:999;}
@media print{.print-btn,.slide-num{display:none;}.slide{page-break-after:always;border:none;}}
</style>
</head>
<body>
<div class="slides-wrap">

<!-- SLIDE 1: COVER -->
<div class="slide slide-cover">
  <div class="logo-circle">🦷</div>
  <h1>التقرير المالي الشهري</h1>
  <div class="subtitle">بوبيان لطب الأسنان — نظام المحاسبة الذكي</div>
  <div class="period-badge">📅 ${monthLabel}</div>
  ${revGrowth !== null ? `<div style="margin-top:16px;font-size:13px;color:${+revGrowth>=0?'#2dd4bf':'#f87171'}">${+revGrowth>=0?'📈 نمو':'📉 تراجع'} ${Math.abs(+revGrowth)}% مقارنة بالشهر السابق</div>` : ''}
</div>

<!-- SLIDE 2: KPIs -->
<div class="slide">
  <span class="slide-num">01</span>
  <div class="slide-title">📊 مؤشرات الأداء الرئيسية — ${monthLabel}</div>
  <div class="kpi-grid">
    <div class="kpi ${totalRev > (prevRev||0) ? 'good':'warn'}">
      <div class="kpi-label">إجمالي الإيرادات</div>
      <div class="kpi-value" style="color:var(--accent2);font-size:18px">${f(totalRev)}</div>
      <div class="kpi-sub">دينار كويتي</div>
    </div>
    <div class="kpi ${netProfit>=0?'good':'bad'}">
      <div class="kpi-label">صافي الربح</div>
      <div class="kpi-value" style="color:${netProfit>=0?'var(--accent2)':'var(--danger)'};font-size:18px">${f(Math.abs(netProfit))}</div>
      <div class="kpi-sub">هامش ${margin}%</div>
    </div>
    <div class="kpi warn">
      <div class="kpi-label">إجمالي المصاريف</div>
      <div class="kpi-value" style="color:var(--gold);font-size:18px">${f(totalExp)}</div>
      <div class="kpi-sub">${Object.keys(expCat).length} تصنيف</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">أيام العمل الفعلية</div>
      <div class="kpi-value" style="color:var(--accent)">${workDays}</div>
      <div class="kpi-sub">معدل ${f(avgPerDay)} د.ك/يوم</div>
    </div>
  </div>
</div>

<!-- SLIDE 3: REVENUE BREAKDOWN -->
<div class="slide">
  <span class="slide-num">02</span>
  <div class="slide-title">💰 تحليل الإيرادات — توزيع طرق الدفع</div>
  <div class="chart-row">
    <div class="chart-box">
      <h3>توزيع طرق الدفع</h3>
      <div id="payChart" style="height:220px;"></div>
    </div>
    <div>
      <table class="rtable">
        <thead><tr><th>طريقة الدفع</th><th class="num">المبلغ (د.ك)</th><th class="num">النسبة</th></tr></thead>
        <tbody>
          ${totalRev > 0 ? [
            ['💵 نقد', cashRev],
            ['💳 K-Net / شبكة', knetRev],
            ['🏥 تأمين', insRev],
            ['🔗 Link', linkRev],
          ].filter(([,v])=>v>0).map(([name,val])=>`
            <tr><td>${name}</td><td class="num good">${f(val)}</td><td class="num">${totalRev?(val/totalRev*100).toFixed(1):0}%</td></tr>
          `).join('') : '<tr><td colspan="3" style="text-align:center;color:var(--text2)">لا يوجد بيانات</td></tr>'}
          <tr style="border-top:2px solid var(--border)"><td style="font-weight:800">الإجمالي</td><td class="num good" style="font-size:14px">${f(totalRev)}</td><td class="num">100%</td></tr>
        </tbody>
      </table>
      ${pendingIns > 0 ? `<div style="margin-top:12px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--gold)">⚠️ مطالبات تأمين معلقة: ${f(pendingIns)} د.ك</div>` : ''}
    </div>
  </div>
</div>

<!-- SLIDE 4: EXPENSES -->
<div class="slide">
  <span class="slide-num">03</span>
  <div class="slide-title">📉 تحليل المصاريف — ${monthLabel}</div>
  <div class="chart-row">
    <div class="chart-box">
      <h3>المصاريف حسب التصنيف</h3>
      <div id="expChart" style="height:220px;"></div>
    </div>
    <div>
      <table class="rtable">
        <thead><tr><th>التصنيف</th><th class="num">المبلغ (د.ك)</th><th class="num">%</th></tr></thead>
        <tbody>
          ${topExpCats.length ? topExpCats.map(([cat,amt])=>`
            <tr><td>${cat}</td><td class="num bad">${f(amt)}</td><td class="num">${totalExp?(amt/totalExp*100).toFixed(1):0}%</td></tr>
          `).join('') : '<tr><td colspan="3" style="text-align:center;color:var(--text2)">لا يوجد مصاريف</td></tr>'}
          <tr style="border-top:2px solid var(--border)"><td>الإجمالي</td><td class="num bad" style="font-size:14px">${f(totalExp)}</td><td class="num">100%</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- SLIDE 5: INSIGHTS & RECOMMENDATIONS -->
<div class="slide">
  <span class="slide-num">04</span>
  <div class="slide-title">💡 التحليل والتوصيات</div>
  <div class="insights">
    <div class="insight ${netProfit>=0?'good':'bad'}">
      <div class="ins-label">الربحية</div>
      <div class="ins-val">${netProfit>=0?'✅ ربح':'❌ خسارة'} — هامش ${margin}%</div>
    </div>
    <div class="insight ${+revGrowth>=0?'good':'bad'}">
      <div class="ins-label">نمو الإيرادات</div>
      <div class="ins-val">${revGrowth!==null?(+revGrowth>=0?'📈 نمو +':'📉 تراجع ')+Math.abs(+revGrowth)+'%':'📊 أول شهر'}</div>
    </div>
    <div class="insight ${pendingIns>0?'warn':'good'}">
      <div class="ins-label">مطالبات التأمين</div>
      <div class="ins-val">${pendingIns>0?`⚠️ معلق ${f(pendingIns)} د.ك`:'✅ لا مطالبات معلقة'}</div>
    </div>
    ${topDr ? `<div class="insight good"><div class="ins-label">أفضل دكتور</div><div class="ins-val">⭐ ${topDr[0]}: ${f(topDr[1])} د.ك</div></div>` : ''}
    <div class="insight ${totalRev>0&&cashRev/totalRev>0.5?'good':'warn'}">
      <div class="ins-label">نسبة النقد</div>
      <div class="ins-val">${totalRev?(cashRev/totalRev*100).toFixed(0):0}% من الإيرادات نقداً</div>
    </div>
    <div class="insight ${workDays>=20?'good':workDays>=15?'warn':'bad'}">
      <div class="ins-label">كثافة العمل</div>
      <div class="ins-val">${workDays} يوم عمل — معدل ${f(avgPerDay)} د.ك</div>
    </div>
  </div>
  <div style="margin-top:20px;padding:16px;background:rgba(79,142,247,.06);border:1px solid rgba(79,142,247,.2);border-radius:10px;font-size:12px;line-height:1.8;color:var(--text2)">
    <strong style="color:var(--text)">📋 ملخص تنفيذي:</strong><br>
    ${totalRev > 0 ? `حققت العيادة إيرادات ${f(totalRev)} د.ك خلال ${monthLabel} بمعدل ${f(avgPerDay)} د.ك يومياً على مدى ${workDays} يوم عمل.` : 'لا توجد بيانات إيرادات لهذا الشهر.'}
    ${netProfit >= 0 ? ` حقق صافي ربح ${f(netProfit)} د.ك بهامش ${margin}%.` : ` سجلت خسارة صافية ${f(Math.abs(netProfit))} د.ك — يُنصح بمراجعة هيكل المصاريف.`}
    ${pendingIns > 0 ? ` تنبيه: ${f(pendingIns)} د.ك مطالبات تأمين معلقة تحتاج متابعة.` : ''}
  </div>
</div>

</div><!-- /slides-wrap -->

<button class="print-btn" onclick="window.print()">🖨️ طباعة / PDF</button>

<script>
// Payment methods pie chart
const payData = [
  {value:${cashRev.toFixed(3)},name:'نقد'},
  {value:${knetRev.toFixed(3)},name:'K-Net'},
  {value:${insRev.toFixed(3)},name:'تأمين'},
  {value:${linkRev.toFixed(3)},name:'Link'},
].filter(d=>d.value>0);

if(payData.length && document.getElementById('payChart')){
  echarts.init(document.getElementById('payChart'),null,{renderer:'canvas'}).setOption({
    backgroundColor:'transparent',
    tooltip:{trigger:'item',formatter:'{b}: {c} KWD ({d}%)'},
    legend:{bottom:0,textStyle:{color:'#94a3b8',fontSize:9}},
    series:[{type:'pie',radius:['40%','68%'],center:['50%','45%'],
      data:payData,
      label:{formatter:'{d}%',fontSize:10,color:'#e4ecff'},
      itemStyle:{borderColor:'#040915',borderWidth:2},
    }],
    color:['#4f8ef7','#2dd4bf','#fbbf24','#a78bfa'],
  });
}

// Expenses bar chart
const expData = ${JSON.stringify(topExpCats)};
if(expData.length && document.getElementById('expChart')){
  echarts.init(document.getElementById('expChart'),null,{renderer:'canvas'}).setOption({
    backgroundColor:'transparent',
    tooltip:{trigger:'axis'},
    grid:{left:10,right:10,top:10,bottom:50,containLabel:true},
    xAxis:{type:'category',data:expData.map(d=>d[0]),axisLabel:{color:'#94a3b8',fontSize:9,rotate:15}},
    yAxis:{type:'value',axisLabel:{color:'#94a3b8',fontSize:9},splitLine:{lineStyle:{color:'#1a2d57'}}},
    series:[{type:'bar',data:expData.map(d=>d[1].toFixed(3)),
      itemStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'#f87171'},{offset:1,color:'#dc2626'}])},
      label:{show:true,position:'top',fontSize:9,color:'#f87171',formatter:v=>v.value>0?v.value:''},
    }]
  });
}
<\/script>
</body></html>`;

  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(html);
});

initDB({
  mongoUri: MONGO_URI,
  dataFile: DATA_FILE,
  configFile: CONFIG_FILE,
  defaultConfig: DEFAULT_CONFIG,
  buildInitialDB,
  migrateDB,
})
  .then(() => {
    autoStartBot();
    app.listen(PORT, () => {
      console.log(`\n✅ بوبيان للمحاسبة - يعمل على http://localhost:${PORT}`);
      console.log(`📂 البيانات محفوظة في: MongoDB (${MONGO_URI})`);
    });
  })
  .catch(err => {
    console.error('❌ فشل الاتصال بقاعدة البيانات MongoDB:', err.message);
    process.exit(1);
  });

// ═══════════════════════════════════════════════════
// AI ACCOUNTING MASTER — المحاسب الذكي المتقدم
// ═══════════════════════════════════════════════════

// ── 1. Period Lock — قفل/فتح الفترة المحاسبية ──────
app.post('/api/period-lock', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'المدير فقط' });
  const { period, locked } = req.body; // period = 'YYYY-MM'
  if (!period) return res.status(400).json({ error: 'period مطلوب' });
  const db = loadDB();
  if (!db.lockedPeriods) db.lockedPeriods = {};
  db.lockedPeriods[period] = !!locked;
  saveDB(db);
  res.json({ success: true, period, locked: !!locked });
});

app.get('/api/period-lock', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.lockedPeriods || {});
});

// Helper: check if a date is in a locked period
function isPeriodLocked(date) {
  const db = loadDB();
  if (!db.lockedPeriods) return false;
  const period = (date || '').substring(0, 7);
  return !!db.lockedPeriods[period];
}

// ── 2. Month-End Close Checklist ──────────────────
app.get('/api/month-close/:period', requireAuth, (req, res) => {
  const { period } = req.params; // YYYY-MM
  const db = loadDB();
  const saved = (db.monthClose || {})[period] || {};

  // Build checklist status
  const monthDays = (db.dailyData || []).filter(d => (d.date || '').startsWith(period));
  const monthExp  = (db.expenses || []).filter(e => (e.date || '').startsWith(period));
  const monthJE   = (db.journalEntries || []).filter(j => (j.date || '').startsWith(period));
  const pendIns   = (db.insuranceClaims || []).filter(c => (c.date || '').startsWith(period) && c.status !== 'received');
  const cashRecon = (db.cashReconciliation || []).filter(c => (c.period || '').startsWith(period));
  const bankRecon = (db.bankReconciliation || []).filter(b => (b.period || '').startsWith(period));
  const payroll   = (db.payroll || []).filter(p => (p.period || '').startsWith(period));

  const steps = [
    { id: 'transactions',   label: 'رفع جميع الإيرادات والمدفوعات',         auto: monthDays.length > 0,  count: `${monthDays.length} يوم مرفوع`, manual: saved.transactions },
    { id: 'cash_recon',     label: 'تسوية الصندوق النقدي',                  auto: cashRecon.length > 0,  count: `${cashRecon.length} تسوية`, manual: saved.cash_recon },
    { id: 'bank_recon',     label: 'التسوية البنكية',                        auto: bankRecon.length > 0,  count: `${bankRecon.length} تسوية`, manual: saved.bank_recon },
    { id: 'expenses',       label: 'تسجيل جميع المصاريف',                   auto: monthExp.length > 0,   count: `${monthExp.length} مصروف`, manual: saved.expenses },
    { id: 'insurance',      label: 'مراجعة مطالبات التأمين',                auto: pendIns.length === 0,  count: pendIns.length > 0 ? `${pendIns.length} معلقة` : 'لا معلقات', manual: saved.insurance },
    { id: 'payroll',        label: 'صرف الرواتب وتسجيل قيودها',             auto: payroll.length > 0,    count: `${payroll.length} كشف`, manual: saved.payroll },
    { id: 'journal',        label: 'مراجعة القيود اليومية',                  auto: monthJE.length > 0,    count: `${monthJE.length} قيد`, manual: saved.journal },
    { id: 'accruals',       label: 'قيود الاستحقاق (مصاريف لم تُسدَّد)',    auto: false,                 count: '', manual: saved.accruals },
    { id: 'depreciation',   label: 'قيد الاستهلاك الشهري',                  auto: false,                 count: '', manual: saved.depreciation },
    { id: 'financials',     label: 'مراجعة القوائم المالية والتوقيع عليها',  auto: false,                 count: '', manual: saved.financials },
  ];

  const completed = steps.filter(s => s.auto || s.manual).length;
  const locked = (db.lockedPeriods || {})[period] || false;

  res.json({ period, steps, completed, total: steps.length, locked });
});

app.post('/api/month-close/:period/step', requireAuth, (req, res) => {
  const { period } = req.params;
  const { stepId, done } = req.body;
  const db = loadDB();
  if (!db.monthClose) db.monthClose = {};
  if (!db.monthClose[period]) db.monthClose[period] = {};
  db.monthClose[period][stepId] = !!done;
  saveDB(db);
  res.json({ success: true });
});

// ── 3. Audit Prep Agent — فحص القيود المشبوهة ────
app.post('/api/ai/audit-prep', requireAuth, rateLimit(5), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  const { period } = req.body;
  const db = loadDB();

  const entries = (db.journalEntries || []).filter(j =>
    !period || (j.date || '').startsWith(period)
  ).slice(0, 200);

  const expenses = (db.expenses || []).filter(e =>
    !period || (e.date || '').startsWith(period)
  ).slice(0, 200);

  const prompt = `أنت محاسب قانوني متخصص في كشف الأخطاء والتلاعب. راجع البيانات التالية وأعطني قائمة بالمخاطر باللغة العربية.

أنماط الخطر:
- مبالغ مستديرة تماماً (1000, 5000, 10000)
- مدخلات في عطل نهاية الأسبوع (جمعة/سبت)
- وصف مبهم (متنوع، تعديل، مصروف عام)
- مبالغ كبيرة غير عادية مقارنة بالمعتاد
- مصاريف بدون فئة محددة
- تكرار نفس المبلغ لنفس المورد

القيود اليومية:
${JSON.stringify(entries.slice(0,50), null, 1)}

المصاريف:
${JSON.stringify(expenses.slice(0,50), null, 1)}

أعد JSON فقط بهذا الشكل:
{"findings": [{"id": "...", "risk": "HIGH|MEDIUM|LOW", "type": "...", "description": "...", "action": "..."}], "summary": "...", "score": 0-100}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    res.json(jsonMatch ? JSON.parse(jsonMatch[0]) : { findings: [], summary: 'لا توجد مخاطر', score: 100 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 4. Financial Narrative — تقرير CFO ───────────
app.post('/api/ai/financial-narrative', requireAuth, rateLimit(5), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  const { period } = req.body;
  const db = loadDB();

  const monthDays = (db.dailyData || []).filter(d => (d.date || '').startsWith(period));
  const prevPeriod = new Date(period + '-01');
  prevPeriod.setMonth(prevPeriod.getMonth() - 1);
  const prevStr = prevPeriod.toISOString().substring(0, 7);
  const prevDays = (db.dailyData || []).filter(d => (d.date || '').startsWith(prevStr));

  const totRev  = monthDays.reduce((s, d) => s + (d.total || 0), 0);
  const prevRev = prevDays.reduce((s, d) => s + (d.total || 0), 0);
  const totExp  = (db.expenses || []).filter(e => (e.date || '').startsWith(period)).reduce((s, e) => s + (e.amount || 0), 0);
  const prevExp = (db.expenses || []).filter(e => (e.date || '').startsWith(prevStr)).reduce((s, e) => s + (e.amount || 0), 0);
  const totIns  = monthDays.reduce((s, d) => s + (d.insurance || 0), 0);
  const totCash = monthDays.reduce((s, d) => s + (d.cash || 0), 0);
  const totKnet = monthDays.reduce((s, d) => s + (d.knet || 0), 0);

  // Expenses by category
  const expByCat = {};
  (db.expenses || []).filter(e => (e.date || '').startsWith(period)).forEach(e => {
    expByCat[e.cat || 'أخرى'] = (expByCat[e.cat || 'أخرى'] || 0) + (e.amount || 0);
  });
  const topExp = Object.entries(expByCat).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const data = {
    period, currency: 'د.ك',
    revenue: { current: totRev, previous: prevRev, change_pct: prevRev ? ((totRev - prevRev) / prevRev * 100).toFixed(1) : 0 },
    expenses: { current: totExp, previous: prevExp, change_pct: prevExp ? ((totExp - prevExp) / prevExp * 100).toFixed(1) : 0 },
    net_profit: totRev - totExp,
    revenue_mix: { cash: totCash, knet: totKnet, insurance: totIns },
    top_expense_categories: topExp,
    work_days: monthDays.filter(d => d.total > 0).length
  };

  const prompt = `أنت مدير مالي CFO خبير. اكتب تقريراً تنفيذياً باللغة العربية للفترة ${period} بناءً على البيانات التالية.

البيانات:
${JSON.stringify(data, null, 2)}

اكتب التقرير بهذا التنسيق:
1. **ملخص الأداء** (فقرة واحدة - 3 جمل، أرقام محددة)
2. **تحليل الإيرادات** (فقرة واحدة - قارن بالشهر السابق)
3. **تحليل المصاريف** (فقرة واحدة - أكبر 3 بنود)
4. **المخاطر والفرص** (3 نقاط)

استخدم الأرقام بالدينار الكويتي. كن محدداً ومهنياً. لا تزيد عن 350 كلمة.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }] })
    });
    const resp = await response.json();
    res.json({ narrative: resp.content?.[0]?.text || '', data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 5. OCR فواتير — استخراج بيانات الفاتورة ──────
const uploadImg = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('صور فقط (JPG, PNG, PDF, WebP)'));
    cb(null, true);
  }
});

app.post('/api/ai/ocr-invoice', requireAuth, uploadImg.single('file'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  if (!req.file) return res.status(400).json({ error: 'الملف مطلوب' });

  try {
    const imageData = fs.readFileSync(req.file.path);
    const base64 = imageData.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const db = loadDB();
    const coa = (db.chartOfAccounts || []).filter(a => !a.isGroup).map(a => `${a.code}: ${a.name}`).join('\n');
    const vendors = (db.vendors || []).map(v => v.name).join(', ');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: `استخرج بيانات هذه الفاتورة وأعد JSON فقط:

دليل الحسابات المتاحة:
${coa}

الموردون المسجلون: ${vendors}

أعد:
{
  "vendor": "اسم المورد",
  "vendor_match": "اسم المورد المطابق من القائمة أو null",
  "date": "YYYY-MM-DD",
  "invoice_number": "رقم الفاتورة",
  "amount": 0.000,
  "tax": 0.000,
  "total": 0.000,
  "description": "وصف المشتريات",
  "suggested_account": "كود الحساب المقترح",
  "suggested_account_name": "اسم الحساب",
  "confidence": 0.0,
  "items": [{"description": "", "qty": 0, "unit_price": 0, "total": 0}]
}` }
          ]
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    fs.removeSync(req.file.path);
    res.json(jsonMatch ? JSON.parse(jsonMatch[0]) : { error: 'لم يتمكن AI من قراءة الفاتورة' });
  } catch(e) {
    try { fs.removeSync(req.file.path); } catch(_) {}
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════
// CONFIG ENGINE — إعدادات التخصيص
// ═══════════════════════════════════════════════════
app.get('/api/config', requireAuth, (req, res) => {
  res.json(loadConfig());
});

app.put('/api/config', requireAuth, (req, res) => {
  try {
    const current = loadConfig();
    // Deep merge
    const updated = {
      brand:             { ...current.brand,             ...(req.body.brand             || {}) },
      modules:           { ...current.modules,           ...(req.body.modules           || {}) },
      labels:            { ...current.labels,            ...(req.body.labels            || {}) },
      nav:               { ...current.nav,               ...(req.body.nav               || {}) },
      commissionFormula: { ...current.commissionFormula, ...(req.body.commissionFormula || {}) },
      dashboard:         { kpi: { ...(current.dashboard?.kpi||{}), ...(req.body.dashboard?.kpi||{}) } },
      importTemplates:   { ...(current.importTemplates||{}), ...(req.body.importTemplates||{}) },
      automation:        Object.fromEntries(
        Object.entries({ ...(current.automation||{}), ...(req.body.automation||{}) })
          .map(([k,v]) => [k, typeof v === 'object' ? { ...((current.automation||{})[k]||{}), ...v } : v])
      ),
    };
    if (req.body.commissionFormula?.tiers) updated.commissionFormula.tiers = req.body.commissionFormula.tiers;
    saveConfig(updated);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Recalculate all commissions with new formula (called after formula change)
app.post('/api/config/recalc-commissions', requireAuth, (req, res) => {
  try {
    const db = loadDB();
    db.commissionHistory = db.commissionHistory || [];
    const groups = {};
    // Aggregate from dailyData (doctor-level revenue per month)
    (db.dailyData || []).forEach(r => {
      if (!r.doctor) return;
      const k = `${r.doctor}|${getMonth(r.date)}`;
      if (!groups[k]) groups[k] = { doctor: r.doctor, month: getMonth(r.date), revenue: 0 };
      groups[k].revenue += (parseFloat(r.total) || 0);
    });
    // Also aggregate from paymentsData (more granular)
    (db.paymentsData || []).forEach(p => {
      if (!p.doctor || p.doctor === 'Advance') return;
      const k = `${p.doctor}|${getMonth(p.date)}`;
      if (!groups[k]) groups[k] = { doctor: p.doctor, month: getMonth(p.date), revenue: 0 };
      // paymentsData may double-count dailyData — only add if no dailyData for same key
    });
    let created = 0, updated = 0;
    for (const key of Object.keys(groups)) {
      const g  = groups[key];
      if (!g.doctor || !g.month) continue;
      const dr = (db.doctors || []).find(d => d.name === g.doctor);
      if (!dr) continue;
      const commission = calcCommission(dr, g.revenue);
      const existing   = db.commissionHistory.find(c => c.doctor === g.doctor && c.month === g.month);
      if (existing) {
        existing.revenue = g.revenue;
        existing.commission = commission;
        updated++;
      } else {
        db.commissionHistory.push({
          id: genId('comm-'),
          doctor: g.doctor,
          month: g.month,
          revenue: parseFloat(g.revenue.toFixed(3)),
          commission: parseFloat(commission.toFixed(3)),
          paid: false,
          payMethod: '',
          payDate: ''
        });
        created++;
      }
    }
    saveDB(db);
    res.json({ success: true, recalculated: Object.keys(groups).length, created, updated });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Company info endpoints
app.get('/api/company', (req, res) => {
  const db = loadDB();
  res.json(db.companyInfo || {});
});

app.post('/api/company', (req, res) => {
  const db = loadDB();
  db.companyInfo = req.body;
  saveDB(db);
  res.json({ success: true });
});

// ===== VENDORS API =====
app.get('/api/vendors', (req, res) => {
  const db = loadDB();
  res.json(db.vendors || []);
});

app.post('/api/vendors', (req, res) => {
  const db = loadDB();
  if (!db.vendors) db.vendors = [];
  const body = req.body;
  const isEdit = body.id && db.vendors.some(v => v.id === body.id);

  if (isEdit) {
    const idx = db.vendors.findIndex(v => v.id === body.id);
    db.vendors[idx] = { ...db.vendors[idx], ...body };
    const coa = db.chartOfAccounts || [];
    const caIdx = coa.findIndex(a => a.id === db.vendors[idx].accountId);
    if (caIdx !== -1) coa[caIdx].name = body.name;
    db.chartOfAccounts = coa;
    saveDB(db);
    return res.json({ success: true, vendor: db.vendors[idx] });
  }

  const coa = db.chartOfAccounts || [];
  const children = coa.filter(a => a.parent === '2100' || a.parentId === '2100');
  const maxCode = children.reduce((m, a) => {
    const n = parseInt(a.code || a.id, 10);
    return isNaN(n) ? m : Math.max(m, n);
  }, 2100);
  const accountCode = String(maxCode + 1);

  const newVendor = {
    id:          'VND-' + Date.now(),
    accountId:   accountCode,
    name:        body.name,
    type:        body.type        || 'أخرى',
    phone:       body.phone       || '',
    email:       body.email       || '',
    address:     body.address     || '',
    terms:       body.terms       || 'نقد',
    creditLimit: body.creditLimit || 0,
    notes:       body.notes       || '',
    createdAt:   new Date().toISOString(),
  };

  db.vendors.push(newVendor);
  db.chartOfAccounts = [...coa, { id: accountCode, code: accountCode, name: body.name, type: 'liability', parent: '2100', parentId: '2100', balance: 0 }];
  saveDB(db);
  res.json({ success: true, vendor: newVendor });
});

app.delete('/api/vendors/:id', (req, res) => {
  const db = loadDB();
  const vendor = (db.vendors || []).find(v => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ success: false, message: 'مورد غير موجود' });
  db.vendors = db.vendors.filter(v => v.id !== req.params.id);
  const hasEntries = (db.journalEntries || []).some(e => e.lines.some(l => l.accountId === vendor.accountId));
  if (!hasEntries) db.chartOfAccounts = (db.chartOfAccounts || []).filter(a => a.id !== vendor.accountId);
  saveDB(db);
  res.json({ success: true });
});

// ===== INVENTORY API =====
const DEFAULT_INV_CATS = [
  { id:'CAT-1', name:'مواد التقويم', subs:['براكيت','أسلاك','مواد طبع'] },
  { id:'CAT-2', name:'مواد الزراعة', subs:['غرسات','أطواق','أغطية'] },
  { id:'CAT-3', name:'مواد الحشو', subs:['كمبوزيت','أملغم','مواد تجويف'] },
  { id:'CAT-4', name:'مواد التبييض', subs:['جل تبييض','صواني'] },
  { id:'CAT-5', name:'أدوية ومخدرات', subs:['مخدر موضعي','مضادات حيوية','مسكنات'] },
  { id:'CAT-6', name:'مستلزمات عامة', subs:['قفازات','كمامات','إبر','مناديل'] },
];

// Items CRUD
app.get('/api/inv/items', (req, res) => {
  const db = loadDB();
  res.json(db.invItems || []);
});

app.post('/api/inv/items', (req, res) => {
  const db = loadDB();
  if (!db.invItems) db.invItems = [];
  const body = req.body;
  const idx = db.invItems.findIndex(i => i.id === body.id);
  if (idx !== -1) {
    db.invItems[idx] = { ...db.invItems[idx], ...body };
  } else {
    db.invItems.push(body);
  }
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/inv/items/:id', (req, res) => {
  const db = loadDB();
  db.invItems = (db.invItems || []).filter(i => i.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// Categories
app.post('/api/inv/categories', (req, res) => {
  const db = loadDB();
  db.invCategories = req.body.categories;
  saveDB(db);
  res.json({ success: true });
});

// Inventory Operations (purchase / consume / adjust)
app.post('/api/inv/operation', (req, res) => {
  const db = loadDB();
  if (!db.invItems)     db.invItems = [];
  if (!db.invMovements) db.invMovements = [];
  if (!db.journalEntries) db.journalEntries = [];

  const { type, date, lines, notes, vendorId, invoice, payAccount, extra } = req.body;
  const movId = 'MOV-' + Date.now();
  const jeId  = 'JE-INV-' + Date.now();
  const total = lines.reduce((s, l) => s + l.qty * l.cost, 0);

  // --- update item quantities (FIFO tracked via cost) ---
  lines.forEach(l => {
    const item = db.invItems.find(i => i.id === l.itemId);
    if (!item) return;
    if (type === 'purchase')      item.qty += l.qty;
    else if (type === 'consume')  item.qty = Math.max(0, item.qty - l.qty);
    else if (type === 'adjust') {
      item.qty = Math.max(0, item.qty + l.qty); // qty can be negative for decrease
    }
    item.cost = l.cost; // update unit cost on purchase (FIFO last-in simplification)
  });

  // --- build journal entry ---
  const accounts = db.chartOfAccounts || [];
  const findAcc  = (code) => accounts.find(a => a.code === code || a.id === code) || { id: code, code, name: code };
  const inv1160  = findAcc('1160');

  let jeLines = [];
  let desc = '';

  if (type === 'purchase') {
    const payAcc = findAcc(payAccount || '2100');
    const vendor = (db.vendors || []).find(v => v.id === vendorId);
    desc = `شراء مواد مخزون${vendor ? ' من ' + vendor.name : ''}${invoice ? ' — فاتورة ' + invoice : ''}`;
    jeLines = [
      { accountId: inv1160.id, accountCode: inv1160.code || '1160', accountName: inv1160.name || 'مخزون', debit: total, credit: 0 },
      { accountId: payAcc.id,  accountCode: payAcc.code  || payAccount, accountName: payAcc.name || payAccount, debit: 0, credit: total },
    ];
    // if credit/AP, also link to vendor account
    if (payAccount === '2100' && vendor) {
      const vendorAcc = findAcc(vendor.accountId);
      jeLines[1] = { accountId: vendorAcc.id, accountCode: vendorAcc.code || vendor.accountId, accountName: vendor.name, debit: 0, credit: total };
    }
  } else if (type === 'consume') {
    const exp5210 = findAcc('5210');
    desc = `استهلاك مواد مخزون${extra ? ' — ' + extra : ''}`;
    jeLines = [
      { accountId: exp5210.id, accountCode: exp5210.code || '5210', accountName: exp5210.name || 'مصروف مواد', debit: total, credit: 0 },
      { accountId: inv1160.id, accountCode: inv1160.code || '1160', accountName: inv1160.name || 'مخزون', debit: 0, credit: total },
    ];
  } else if (type === 'adjust') {
    const netQtyChange = lines.reduce((s,l) => s + l.qty, 0);
    if (netQtyChange < 0) {
      // decrease: debit misc expense 5670 (or 5215 if present), credit inventory
      const exp5215 = findAcc('5215') || findAcc('5670');
      desc = `تسوية مخزون (نقص)${extra ? ' — ' + extra : ''}`;
      jeLines = [
        { accountId: exp5215.id, accountCode: exp5215.code || '5215', accountName: exp5215.name || 'إهلاك مخزون', debit: Math.abs(total), credit: 0 },
        { accountId: inv1160.id, accountCode: inv1160.code || '1160', accountName: inv1160.name || 'مخزون', debit: 0, credit: Math.abs(total) },
      ];
    } else {
      // increase: debit inventory, credit equity adjustment 3200
      const eq3200 = findAcc('3200');
      desc = `تسوية مخزون (زيادة)${extra ? ' — ' + extra : ''}`;
      jeLines = [
        { accountId: inv1160.id, accountCode: inv1160.code || '1160', accountName: inv1160.name || 'مخزون', debit: total, credit: 0 },
        { accountId: eq3200.id,  accountCode: eq3200.code || '3200', accountName: eq3200.name || 'حقوق الملكية', debit: 0, credit: total },
      ];
    }
  }

  const journalEntry = {
    id: jeId, date, desc, ref: movId, type: 'inventory',
    totalDebit: total, totalCredit: total,
    createdAt: new Date().toISOString(),
    lines: jeLines,
  };

  db.journalEntries.push(journalEntry);

  // save movement record
  db.invMovements.push({
    id: movId, type, date, notes: notes || '',
    journalId: jeId,
    vendorId, invoice, payAccount, extra,
    items: lines,
    total,
  });

  saveDB(db);

  // real-time low-stock alert via automation engine
  lines.forEach(l => {
    const item = db.invItems.find(i => i.id === l.itemId);
    if (item) checkInventoryAlert(item);
  });

  res.json({ success: true, journalId: jeId, movId });
});

// COA endpoint
// ═══ COA — دليل الحسابات ════════════════════════════════

// Helper: compute balances for all accounts from journal entries
function computeCoaBalances(accounts, entries) {
  const bal = {};
  (entries || []).forEach(je => {
    (je.lines || []).forEach(l => {
      const key = l.accountId || l.accountCode || l.account;
      if (!key) return;
      if (!bal[key]) bal[key] = { debit: 0, credit: 0 };
      bal[key].debit  += parseFloat(l.debit)  || 0;
      bal[key].credit += parseFloat(l.credit) || 0;
    });
  });
  const DEBIT_NATURE  = ['asset','expense'];
  const CREDIT_NATURE = ['liability','equity','revenue'];
  return accounts.map(a => {
    const b = bal[a.id] || bal[a.code] || { debit:0, credit:0 };
    const net = DEBIT_NATURE.includes(a.type)
      ? b.debit - b.credit
      : b.credit - b.debit;
    return { ...a, debit: b.debit, credit: b.credit, balance: net };
  });
}

// Helper: check if account has journal entries
function accountHasEntries(db, id) {
  return (db.journalEntries || []).some(je =>
    (je.lines || []).some(l => l.accountId === id || l.accountCode === id || l.account === id)
  );
}

// Bulk save (legacy - keep for backward compat)
app.post('/api/coa', (req, res) => {
  const db = loadDB();
  db.chartOfAccounts = req.body.chartOfAccounts;
  saveDB(db);
  res.json({ success: true });
});

// GET all accounts (with optional balances)
app.get('/api/coa', (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  if (req.query.withBalances === '1') {
    res.json(computeCoaBalances(coa, db.journalEntries));
  } else {
    res.json(coa);
  }
});

// GET with balances
app.get('/api/coa/balances', (req, res) => {
  const db = loadDB();
  res.json(computeCoaBalances(db.chartOfAccounts || [], db.journalEntries));
});

// GET duplicates
app.get('/api/coa/duplicates', (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  const codeSeen = {}, nameSeen = {}, dups = [];
  coa.forEach(a => {
    if (codeSeen[a.code]) dups.push({ type:'code', value:a.code, ids:[codeSeen[a.code], a.id] });
    else codeSeen[a.code] = a.id;
    const nameKey = a.name?.trim().toLowerCase();
    if (nameKey && nameSeen[nameKey]) dups.push({ type:'name', value:a.name, ids:[nameSeen[nameKey], a.id] });
    else if (nameKey) nameSeen[nameKey] = a.id;
  });
  res.json(dups);
});

// POST — add single account
app.post('/api/coa/account', (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  const { code, name, type, parent, description, isGroup, normalBalance } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'رقم الحساب والاسم مطلوبان' });
  if (coa.find(a => a.code === code)) return res.status(400).json({ error: 'رقم الحساب موجود مسبقاً' });
  const acc = {
    id: code, code, name, type: type||'expense',
    parent: parent||null, description: description||'', isGroup: !!isGroup,
    normalBalance: normalBalance || (['asset','expense'].includes(type) ? 'debit' : 'credit'),
    status: 'active', balance: 0, createdAt: new Date().toISOString()
  };
  coa.push(acc);
  coa.sort((a,b) => a.code.localeCompare(b.code));
  db.chartOfAccounts = coa;
  saveDB(db);
  res.json({ success: true, account: acc });
});

// PUT — edit single account
app.put('/api/coa/account/:id', (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  const idx = coa.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'الحساب غير موجود' });
  const { code, name, type, parent, description, isGroup, normalBalance, status } = req.body;
  // If code changed and new code already exists → reject
  if (code && code !== coa[idx].code && coa.find(a => a.code === code))
    return res.status(400).json({ error: 'رقم الحساب موجود مسبقاً' });
  coa[idx] = { ...coa[idx], ...{ code: code||coa[idx].code, name: name||coa[idx].name, type: type||coa[idx].type,
    parent: parent !== undefined ? parent : coa[idx].parent,
    description: description !== undefined ? description : coa[idx].description,
    isGroup: isGroup !== undefined ? !!isGroup : coa[idx].isGroup,
    normalBalance: normalBalance||coa[idx].normalBalance, status: status||coa[idx].status,
    updatedAt: new Date().toISOString() }};
  coa.sort((a,b) => a.code.localeCompare(b.code));
  db.chartOfAccounts = coa;
  saveDB(db);
  res.json({ success: true, account: coa[idx] });
});

// DELETE — single account with journal-entry protection
app.delete('/api/coa/account/:id', (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  const acc = coa.find(a => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: 'الحساب غير موجود' });
  // Block: has children
  if (coa.some(a => a.parent === req.params.id))
    return res.status(409).json({ error: 'لا يمكن حذف الحساب — يحتوي على حسابات فرعية', code:'HAS_CHILDREN' });
  // Block: has journal entries
  if (accountHasEntries(db, req.params.id))
    return res.status(409).json({ error: 'لا يمكن حذف الحساب — مرتبط بقيود محاسبية', code:'HAS_ENTRIES' });
  db.chartOfAccounts = coa.filter(a => a.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// POST — AI analyze COA for IFRS compliance
app.post('/api/coa/ai-analyze', requireAuth, rateLimit(5), async (req, res) => {
  const db = loadDB();
  const coa = db.chartOfAccounts || [];
  const je  = db.journalEntries  || [];

  // Client-side rules (fast, no AI needed for basic checks)
  const issues = [];
  const REQUIRED_ROOTS = [
    { code:'1', name:'الأصول', type:'asset' },
    { code:'2', name:'الالتزامات', type:'liability' },
    { code:'3', name:'حقوق الملكية', type:'equity' },
    { code:'4', name:'الإيرادات', type:'revenue' },
    { code:'5', name:'المصاريف', type:'expense' },
  ];

  // Check root categories exist
  REQUIRED_ROOTS.forEach(r => {
    if (!coa.some(a => a.code.startsWith(r.code) && !a.parent)) {
      issues.push({ severity:'error', msg:`مجموعة "${r.name}" (${r.code}xxx) غير موجودة كحساب رئيسي`, fix:`أضف حساب رئيسي من نوع ${r.name}` });
    }
  });

  // Check placement: code prefix vs type
  const typeMap = { '1':'asset','2':'liability','3':'equity','4':'revenue','5':'expense' };
  coa.forEach(a => {
    const expected = typeMap[a.code[0]];
    if (expected && a.type !== expected) {
      issues.push({ severity:'warning', id:a.id, code:a.code, msg:`حساب "${a.name}" (${a.code}) من نوع "${a.type}" لكن رقمه يشير إلى "${expected}"`, fix:`غيّر نوع الحساب إلى "${expected}" أو غيّر رقمه` });
    }
  });

  // Check duplicates
  const codeSeen = {};
  coa.forEach(a => {
    if (codeSeen[a.code]) issues.push({ severity:'error', code:a.code, msg:`رقم الحساب "${a.code}" مكرر`, fix:`احذف أو أعد ترقيم أحد الحسابين` });
    else codeSeen[a.code] = true;
  });

  // Check orphan accounts (parent referenced but not exists)
  const idSet = new Set(coa.map(a => a.id));
  coa.forEach(a => {
    if (a.parent && !idSet.has(a.parent)) {
      issues.push({ severity:'error', id:a.id, code:a.code, msg:`حساب "${a.name}" (${a.code}) يشير إلى حساب أب غير موجود`, fix:`حدّث الحساب الأب أو اجعله حساباً رئيسياً` });
    }
  });

  // Missing recommended accounts for dental clinic (IFRS)
  const RECOMMENDED = [
    { check: coa => !coa.some(a=>a.type==='asset' && a.code.startsWith('1') && (a.name.includes('نقد')||a.name.includes('صندوق')||a.name.includes('بنك'))), msg:'لا يوجد حساب للنقد أو البنك (IFRS IAS 7 — بيان التدفقات النقدية)', severity:'warning' },
    { check: coa => !coa.some(a=>a.type==='asset' && (a.name.includes('ذمم')||a.name.includes('مدين'))), msg:'لا يوجد حساب ذمم مدينة (IFRS IFRS 9 — الأدوات المالية)', severity:'warning' },
    { check: coa => !coa.some(a=>a.type==='expense' && a.code.startsWith('5') && a.name.includes('إهلاك')), msg:'لا يوجد حساب إهلاك (IFRS IAS 16 — الأصول الثابتة)', severity:'info' },
    { check: coa => !coa.some(a=>a.type==='equity'), msg:'لا يوجد حسابات حقوق الملكية — مطلوبة وفق IFRS', severity:'error' },
  ];
  RECOMMENDED.forEach(r => { if (r.check(coa)) issues.push({ severity:r.severity, msg:r.msg }); });

  const errors   = issues.filter(i=>i.severity==='error').length;
  const warnings = issues.filter(i=>i.severity==='warning').length;
  const score    = Math.max(0, 100 - errors*15 - warnings*5);

  // If ANTHROPIC_API_KEY set, enrich with AI narrative
  let aiNarrative = null;
  if (process.env.ANTHROPIC_API_KEY && coa.length > 0) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic();
      const coaSummary = coa.map(a=>`${a.code}: ${a.name} [${a.type}]${a.parent?` → ${a.parent}`:''}`).join('\n');
      const msg = await client.messages.create({
        model:'claude-haiku-4-5-20251001', max_tokens:600,
        messages:[{ role:'user', content:
          `أنت مدقق حسابات محترف متخصص في معايير IFRS. قيّم شجرة الحسابات التالية لعيادة أسنان:\n\n${coaSummary}\n\nالمشاكل المكتشفة تلقائياً: ${JSON.stringify(issues.map(i=>i.msg))}\n\nأعطني تقييماً موجزاً في 3-4 نقاط باللغة العربية، مع أبرز التوصيات لتحسين الشجرة وفق IFRS.` }]
      });
      aiNarrative = msg.content[0].text;
    } catch(e) { aiNarrative = null; }
  }

  res.json({ score, issues, errors, warnings, totalAccounts: coa.length, aiNarrative });
});

// POST — AI chat builder for COA
app.post('/api/coa/ai-chat', requireAuth, rateLimit(10), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ reply:'❌ ANTHROPIC_API_KEY غير مضبوط. أضفه في ملف .env لتفعيل مساعد الذكاء الاصطناعي.' });
  const { messages, currentCoa } = req.body;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const coaSummary = (currentCoa||[]).slice(0,30).map(a=>`${a.code}: ${a.name}`).join(', ');
    const systemPrompt = `أنت مساعد محاسبة ذكي متخصص في بناء شجرة الحسابات لعيادات الأسنان وفق معايير IFRS الدولية. مهمتك مساعدة المستخدم (الذي قد لا يكون محاسباً) في بناء شجرة حسابات مناسبة.

الشجرة الحالية تحتوي على: ${coaSummary || 'فارغة'}

قواعد مهمة:
- الحسابات من 1000-1999 = أصول (asset)
- الحسابات من 2000-2999 = التزامات (liability)
- الحسابات من 3000-3999 = حقوق الملكية (equity)
- الحسابات من 4000-4999 = إيرادات (revenue)
- الحسابات من 5000-5999 = مصاريف (expense)
- المستويات الخمسة: رئيسي > مجموعة > حساب > تفصيلي > تحليلي

عندما يطلب المستخدم إضافة حسابات، أعطه JSON على شكل:
{"action":"addAccounts","accounts":[{"code":"XXXX","name":"...","type":"asset/liability/equity/revenue/expense","parent":"PARENT_CODE_OR_NULL","isGroup":false}]}

تحدث بالعربية الفصحى وكن مختصراً وعملياً.`;

    const resp = await client.messages.create({
      model:'claude-haiku-4-5-20251001', max_tokens:800,
      system: systemPrompt,
      messages: (messages||[]).map(m => ({ role:m.role, content:m.content }))
    });
    res.json({ reply: resp.content[0].text });
  } catch(e) {
    res.status(500).json({ reply: 'حدث خطأ: ' + e.message });
  }
});

// Reset COA to defaults
app.post('/api/coa/reset-defaults', (req, res) => {
  const db = loadDB();
  db.chartOfAccounts = DEFAULT_COA.map(a => ({ ...a }));
  saveDB(db);
  res.json({ success: true, count: db.chartOfAccounts.length });
});

// ═══════════════════════════════════════════════════
// TRIAL BALANCE — ميزان المراجعة
// ═══════════════════════════════════════════════════
app.get('/api/trial-balance', (req, res) => {
  const db = loadDB();
  const { period, year, month } = req.query;
  const accounts = db.chartOfAccounts || [];
  const entries  = db.journalEntries  || [];

  const now = new Date();
  const targetYear  = parseInt(year)  || now.getFullYear();
  const targetMonth = parseInt(month) || now.getMonth() + 1;
  const monthStr    = `${targetYear}-${String(targetMonth).padStart(2,'0')}`;

  // Filter entries by period
  const filteredEntries = entries.filter(e => {
    if (!period || period === 'all') return true;
    if (period === 'year')  return (e.date||'').startsWith(String(targetYear));
    if (period === 'month') return (e.date||'').startsWith(monthStr);
    return true;
  });

  // Aggregate debits/credits per account code
  const totals = {};
  filteredEntries.forEach(entry => {
    (entry.lines || []).forEach(line => {
      const code = line.accountCode || line.accountId;
      if (!code) return;
      if (!totals[code]) totals[code] = { debit: 0, credit: 0 };
      totals[code].debit  += line.debit  || 0;
      totals[code].credit += line.credit || 0;
    });
  });

  // Add opening balances
  accounts.forEach(acc => {
    if (acc.openingDebit || acc.openingCredit) {
      if (!totals[acc.code]) totals[acc.code] = { debit: 0, credit: 0 };
      totals[acc.code].debit  += acc.openingDebit  || 0;
      totals[acc.code].credit += acc.openingCredit || 0;
    }
  });

  // Build rows (leaf accounts only, exclude groups)
  const rows = accounts
    .filter(a => !a.isGroup)
    .map(acc => {
      const t = totals[acc.code] || { debit: 0, credit: 0 };
      const netDebit  = Math.max(0, t.debit - t.credit);
      const netCredit = Math.max(0, t.credit - t.debit);
      return { code: acc.code, name: acc.name, type: acc.type, totalDebit: t.debit, totalCredit: t.credit, netDebit, netCredit };
    })
    .filter(r => r.totalDebit !== 0 || r.totalCredit !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));

  const grandDebit  = rows.reduce((s, r) => s + r.netDebit,  0);
  const grandCredit = rows.reduce((s, r) => s + r.netCredit, 0);
  const isBalanced  = Math.abs(grandDebit - grandCredit) < 0.001;

  res.json({ rows, grandDebit, grandCredit, isBalanced, period: period || 'all', monthStr });
});

// ═══════════════════════════════════════════════════
// OPENING BALANCES — الأرصدة الافتتاحية
// ═══════════════════════════════════════════════════
app.post('/api/opening-balance', (req, res) => {
  const db = loadDB();
  const { balances, date } = req.body; // balances: [{code, debit, credit}]
  if (!Array.isArray(balances)) return res.status(400).json({ error: 'balances array required' });

  const accounts = db.chartOfAccounts || [];
  balances.forEach(b => {
    const acc = accounts.find(a => a.code === b.code);
    if (acc) {
      acc.openingDebit  = parseFloat(b.debit)  || 0;
      acc.openingCredit = parseFloat(b.credit) || 0;
    }
  });
  db.chartOfAccounts = accounts;

  // Create opening journal entry
  const lines = balances
    .filter(b => b.debit > 0 || b.credit > 0)
    .map(b => {
      const acc = accounts.find(a => a.code === b.code);
      return { accountId: b.code, accountCode: b.code, accountName: acc?.name || b.code, debit: parseFloat(b.debit)||0, credit: parseFloat(b.credit)||0 };
    });

  if (lines.length > 0) {
    const openEntry = {
      id: 'JE-OPEN-' + Date.now(),
      date: date || new Date().toISOString().substring(0,10),
      desc: 'قيد الأرصدة الافتتاحية',
      ref: 'OPENING',
      type: 'opening',
      lines,
      createdAt: new Date().toISOString()
    };
    if (!db.journalEntries) db.journalEntries = [];
    db.journalEntries = db.journalEntries.filter(e => e.type !== 'opening'); // replace previous
    db.journalEntries.unshift(openEntry);
  }

  saveDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════
// PERIOD CLOSING ENTRY — قيد الإقفال
// ═══════════════════════════════════════════════════
app.post('/api/closing-entry', (req, res) => {
  const db = loadDB();
  const { year, month } = req.body;
  const entries = db.journalEntries || [];
  const now = new Date();
  const targetYear  = parseInt(year)  || now.getFullYear();
  const targetMonth = parseInt(month) || now.getMonth() + 1;
  const monthStr    = `${targetYear}-${String(targetMonth).padStart(2,'0')}`;
  const closeDate   = `${monthStr}-${new Date(targetYear, targetMonth, 0).getDate()}`;

  // Sum revenues and expenses for the period
  const totals = {};
  entries
    .filter(e => (e.date||'').startsWith(monthStr) && e.type !== 'closing')
    .forEach(entry => {
      (entry.lines||[]).forEach(line => {
        const code = line.accountCode;
        if (!code) return;
        if (!totals[code]) totals[code] = { debit:0, credit:0, name: line.accountName, type: '' };
        totals[code].debit  += line.debit  || 0;
        totals[code].credit += line.credit || 0;
      });
    });

  const accounts = db.chartOfAccounts || [];
  accounts.forEach(a => { if (totals[a.code]) totals[a.code].type = a.type; });

  // Revenue accounts (4xxx) close to 3300
  // Expense accounts (5xxx) close to 3300
  const closingLines = [];
  let netToRetained  = 0;

  Object.entries(totals).forEach(([code, t]) => {
    const acc = accounts.find(a => a.code === code);
    if (!acc) return;
    if (acc.type === 'revenue') {
      const netCredit = t.credit - t.debit;
      if (netCredit !== 0) {
        closingLines.push({ accountId:code, accountCode:code, accountName:acc.name, debit: netCredit > 0 ? netCredit : 0, credit: netCredit < 0 ? -netCredit : 0 });
        netToRetained += netCredit;
      }
    } else if (acc.type === 'expense') {
      const netDebit = t.debit - t.credit;
      if (netDebit !== 0) {
        closingLines.push({ accountId:code, accountCode:code, accountName:acc.name, debit: netDebit < 0 ? -netDebit : 0, credit: netDebit > 0 ? netDebit : 0 });
        netToRetained -= netDebit;
      }
    }
  });

  if (closingLines.length === 0) return res.status(400).json({ error: 'لا توجد قيود إيرادات أو مصاريف في هذه الفترة' });

  // Final line: transfer to retained earnings (3200)
  closingLines.push({
    accountId: '3200', accountCode: '3200', accountName: 'الأرباح المحتجزة',
    debit:  netToRetained < 0 ? -netToRetained : 0,
    credit: netToRetained > 0 ?  netToRetained : 0
  });

  const closingEntry = {
    id: `JE-CLOSE-${monthStr}-${Date.now()}`,
    date: closeDate,
    desc: `قيد إقفال الفترة — ${monthStr}`,
    ref: `CLOSE-${monthStr}`,
    type: 'closing',
    lines: closingLines,
    netResult: netToRetained,
    createdAt: new Date().toISOString()
  };

  db.journalEntries = entries.filter(e => e.ref !== `CLOSE-${monthStr}`);
  db.journalEntries.push(closingEntry);
  db.journalEntries.sort((a,b) => b.date.localeCompare(a.date));
  saveDB(db);

  res.json({ success: true, netResult: netToRetained, linesCount: closingLines.length, entry: closingEntry });
});

// ═══════════════════════════════════════════════════
// AP / AR AGING — تقادم الذمم
// ═══════════════════════════════════════════════════
app.get('/api/ar-aging', (req, res) => {
  const db = loadDB();
  const claims = db.insuranceClaims || [];
  const today  = new Date();

  const buckets = { current: [], days30: [], days60: [], days90: [], over90: [] };
  claims.filter(c => c.status !== 'received').forEach(c => {
    const days = Math.floor((today - new Date(c.date || today)) / 86400000);
    const item = { id: c.id, company: c.company || 'غير محدد', amount: c.amount || 0, date: c.date, days };
    if      (days <= 30)  buckets.current.push(item);
    else if (days <= 60)  buckets.days30.push(item);
    else if (days <= 90)  buckets.days60.push(item);
    else if (days <= 120) buckets.days90.push(item);
    else                  buckets.over90.push(item);
  });

  const sum = arr => arr.reduce((s, i) => s + i.amount, 0);
  res.json({
    buckets,
    totals: { current: sum(buckets.current), days30: sum(buckets.days30), days60: sum(buckets.days60), days90: sum(buckets.days90), over90: sum(buckets.over90) },
    grandTotal: claims.filter(c=>c.status!=='received').reduce((s,c)=>s+(c.amount||0),0)
  });
});

app.get('/api/ap-aging', (req, res) => {
  const db = loadDB();
  const vendors  = db.vendors  || [];
  const expenses = db.expenses || [];
  const vouchers = db.vouchers || [];
  const today    = new Date();

  // Unpaid vendor expenses
  const unpaid = expenses.filter(e => e.vendor && e.paymentStatus !== 'paid');
  const byVendor = {};
  unpaid.forEach(e => {
    if (!byVendor[e.vendor]) byVendor[e.vendor] = [];
    byVendor[e.vendor].push({ date: e.date, amount: e.amount || 0, desc: e.desc });
  });

  const rows = Object.entries(byVendor).map(([vendor, items]) => {
    const buckets = { current:0, days30:0, days60:0, over60:0 };
    items.forEach(i => {
      const days = Math.floor((today - new Date(i.date || today)) / 86400000);
      if      (days <= 30) buckets.current += i.amount;
      else if (days <= 60) buckets.days30  += i.amount;
      else if (days <= 90) buckets.days60  += i.amount;
      else                 buckets.over60  += i.amount;
    });
    const total = items.reduce((s,i)=>s+i.amount,0);
    return { vendor, total, buckets, count: items.length };
  });

  res.json({ rows, grandTotal: rows.reduce((s,r)=>s+r.total,0) });
});

// ═══════════════════════════════════════════════════
// ACCOUNTING SETTINGS — إعدادات السنة المالية
// ═══════════════════════════════════════════════════
app.get('/api/accounting-settings', (req, res) => {
  const db = loadDB();
  res.json(db.accountingSettings || { fiscalYearStart: '01', fiscalYearEnd: '12', currency: 'KWD', currencySymbol: 'د.ك', decimalPlaces: 3, bookStartDate: '' });
});

app.put('/api/accounting-settings', (req, res) => {
  const db = loadDB();
  db.accountingSettings = { ...(db.accountingSettings || {}), ...req.body };
  saveDB(db);
  res.json({ success: true });
});

// Journal endpoints
app.post('/api/journal', (req, res) => {
  const db = loadDB();
  if (!db.journalEntries) db.journalEntries = [];
  const entry = req.body;
  const existing = db.journalEntries.findIndex(e => e.id === entry.id);
  if (existing >= 0) db.journalEntries[existing] = entry;
  else db.journalEntries.push(entry);
  db.journalEntries.sort((a,b) => b.date.localeCompare(a.date));
  saveDB(db);
  res.json({ success: true });
});

app.put('/api/journal/:id', (req, res) => {
  const db = loadDB();
  const idx = (db.journalEntries || []).findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'القيد غير موجود' });
  const { date, desc, ref, lines } = req.body;
  const existing = db.journalEntries[idx];
  const updated = {
    ...existing,
    id: req.params.id,
    date: date ? sanitize(date, 10) : existing.date,
    desc: desc ? sanitize(desc, 500) : existing.desc,
    ref:  ref  ? sanitize(ref, 100)  : existing.ref,
    lines: Array.isArray(lines) ? lines : existing.lines,
    updatedAt: new Date().toISOString()
  };
  db.journalEntries[idx] = updated;
  db.journalEntries.sort((a, b) => b.date.localeCompare(a.date));
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/journal/:id', (req, res) => {
  const db = loadDB();
  db.journalEntries = (db.journalEntries || []).filter(e => e.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// AI Journal Entry from invoice image
app.post('/api/ai/journal', async (req, res) => {
  try {
    const { image, accounts } = req.body;
    const accountList = accounts.map(a => `${a.code}: ${a.name} (${a.type})`).join('\n');
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: `أنت محاسب خبير. اقرأ هذه الفاتورة وولّد قيد محاسبي.

شجرة الحسابات المتاحة:
${accountList}

أجب بـ JSON فقط بدون أي نص إضافي:
{
  "description": "بيان القيد",
  "ref": "رقم الفاتورة إن وجد",
  "lines": [
    {"accountId": "رقم الحساب من الشجرة", "debit": 0, "credit": 0},
    {"accountId": "رقم الحساب من الشجرة", "debit": 0, "credit": 0}
  ]
}

القواعد: مجموع المدين = مجموع الدائن. للمصروف: مدين حساب المصروف، دائن الصندوق أو البنك. للإيراد: مدين الصندوق أو البنك، دائن حساب الإيراد.` }
          ]
        }]
      })
    });
    
    const data = await response.json();
    const raw = data.content?.[0]?.text || '{}';
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ success: true, ...result });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════
// AI ACCOUNTING ASSISTANT
// ═══════════════════════════════════════════════════
app.post('/api/ai/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const db = loadDB();

    // Build financial snapshot for AI context
    const now = new Date();
    const thisMonth = now.toISOString().substring(0, 7);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1).toISOString().substring(0, 7);

    const daily = db.dailyData || [];
    const expenses = db.expenses || [];
    const vouchers = db.vouchers || [];
    const claims = db.insuranceClaims || [];
    const payroll = db.payroll || [];
    const entries = db.journalEntries || [];
    const inventory = db.invItems || [];

    // Monthly revenue
    const revByMonth = {};
    daily.forEach(d => {
      const m = (d.date || '').substring(0, 7);
      if (!revByMonth[m]) revByMonth[m] = 0;
      revByMonth[m] += d.total || 0;
    });

    // Monthly expenses
    const expByMonth = {};
    expenses.forEach(e => {
      const m = (e.date || '').substring(0, 7);
      if (!expByMonth[m]) expByMonth[m] = 0;
      expByMonth[m] += e.amount || 0;
    });

    const totalRevenue = daily.reduce((s, d) => s + (d.total || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const thisMonthRev = revByMonth[thisMonth] || 0;
    const lastMonthRev = revByMonth[lastMonth] || 0;
    const thisMonthExp = expByMonth[thisMonth] || 0;
    const revenueGrowth = lastMonthRev ? ((thisMonthRev - lastMonthRev) / lastMonthRev * 100).toFixed(1) : null;

    // Doctor performance
    const drRev = {};
    daily.forEach(d => {
      if (d.doctor) {
        drRev[d.doctor] = (drRev[d.doctor] || 0) + (d.total || 0);
      }
    });

    // Expense categories
    const expByCat = {};
    expenses.forEach(e => {
      expByCat[e.cat || 'أخرى'] = (expByCat[e.cat || 'أخرى'] || 0) + (e.amount || 0);
    });

    // Payment methods breakdown
    const payMix = { cash: 0, knet: 0, visa: 0, master: 0, insurance: 0, link: 0 };
    daily.forEach(d => {
      payMix.cash += d.cash || 0;
      payMix.knet += d.knet || 0;
      payMix.visa += d.visa || 0;
      payMix.master += d.master || 0;
      payMix.insurance += d.insurance || 0;
      payMix.link += d.link || 0;
    });

    // Insurance claims summary
    const claimPending = claims.filter(c => c.status !== 'received').reduce((s, c) => s + c.amount, 0);
    const claimReceived = claims.filter(c => c.status === 'received').reduce((s, c) => s + (c.receivedAmount || c.amount), 0);

    // Payroll total
    const payrollTotal = payroll.reduce((s, p) => s + (p.totalNet || 0), 0);
    const payrollPending = payroll.filter(p => p.status !== 'paid').reduce((s, p) => s + (p.totalNet || 0), 0);

    // Top expense categories
    const topExpenses = Object.entries(expByCat)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, amt]) => `${cat}: ${amt.toFixed(3)} د.ك`)
      .join(' | ');

    // Recent vouchers
    const recentVouchers = vouchers.slice(-5).map(v =>
      `${v.number} (${v.type === 'receipt' ? 'قبض' : 'صرف'}) ${v.amount.toFixed(3)} د.ك — ${v.payee || '—'}`
    ).join('\n');

    const systemPrompt = `أنت مساعد محاسبي ذكي متخصص في عيادة الأسنان "بوبيان". لديك وصول كامل لبيانات العيادة الحقيقية.

═══════════════════════════════════════
📊 الملف المالي الكامل للعيادة (${now.toLocaleDateString('ar-KW')})
═══════════════════════════════════════

💰 الإيرادات:
• إجمالي الإيرادات (كل الفترات): ${totalRevenue.toFixed(3)} د.ك
• إيرادات ${thisMonth}: ${thisMonthRev.toFixed(3)} د.ك
• إيرادات ${lastMonth}: ${lastMonthRev.toFixed(3)} د.ك
• النمو الشهري: ${revenueGrowth !== null ? revenueGrowth + '%' : 'لا يوجد بيانات كافية'}

💸 المصاريف:
• إجمالي المصاريف: ${totalExpenses.toFixed(3)} د.ك
• مصاريف ${thisMonth}: ${thisMonthExp.toFixed(3)} د.ك
• أعلى التصنيفات: ${topExpenses || 'لا يوجد'}

📈 صافي الربح (تقريبي): ${(totalRevenue - totalExpenses).toFixed(3)} د.ك
• هامش الربح: ${totalRevenue ? ((totalRevenue - totalExpenses) / totalRevenue * 100).toFixed(1) + '%' : '—'}

💳 توزيع طرق الدفع (إجمالي):
• كاش: ${payMix.cash.toFixed(3)} د.ك (${totalRevenue ? (payMix.cash / totalRevenue * 100).toFixed(1) : 0}%)
• K-Net: ${payMix.knet.toFixed(3)} د.ك (${totalRevenue ? (payMix.knet / totalRevenue * 100).toFixed(1) : 0}%)
• Visa/Master: ${(payMix.visa + payMix.master).toFixed(3)} د.ك
• تأمين: ${payMix.insurance.toFixed(3)} د.ك (${totalRevenue ? (payMix.insurance / totalRevenue * 100).toFixed(1) : 0}%)
• Link: ${payMix.link.toFixed(3)} د.ك

👨‍⚕️ أداء الدكاترة:
${Object.entries(drRev).map(([dr, rev]) => `• ${dr}: ${rev.toFixed(3)} د.ك`).join('\n') || '• لا يوجد بيانات حسب الدكتور'}

🏥 مطالبات التأمين:
• معلقة/مقدّمة: ${claimPending.toFixed(3)} د.ك (${claims.filter(c => c.status !== 'received').length} مطالبة)
• مستلمة: ${claimReceived.toFixed(3)} د.ك
• شركات التأمين: ${[...new Set(claims.map(c => c.company))].join(', ') || 'لا يوجد'}

👥 الرواتب:
• إجمالي الرواتب المسجّلة: ${payrollTotal.toFixed(3)} د.ك
• رواتب معلقة (غير مدفوعة): ${payrollPending.toFixed(3)} د.ك
• عدد الموظفين: ${(db.employees || []).length}

🧾 السندات:
• إجمالي سندات القبض: ${vouchers.filter(v => v.type === 'receipt').reduce((s, v) => s + v.amount, 0).toFixed(3)} د.ك
• إجمالي سندات الصرف: ${vouchers.filter(v => v.type === 'payment').reduce((s, v) => s + v.amount, 0).toFixed(3)} د.ك

📦 المخزون:
• عدد الأصناف: ${inventory.length}
• أصناف تحت الحد الأدنى: ${inventory.filter(i => (i.quantity || 0) <= (i.minQty || 0)).length}

📝 القيود المحاسبية:
• إجمالي القيود: ${entries.length}
• آخر قيد: ${entries.length ? entries[entries.length - 1]?.date : 'لا يوجد'}

📅 الشهور المتاحة: ${Object.keys(revByMonth).sort().join(', ') || 'لا يوجد'}

═══════════════════════════════════════

قواعد الإجابة:
1. أجب دائماً بالعربي بأسلوب مهني وواضح
2. استخدم الأرقام الحقيقية من البيانات أعلاه
3. عند تحليل المخاطر كن صريحاً ومحدداً
4. قدم توصيات قابلة للتطبيق
5. استخدم الـ emojis لتنظيم الإجابة
6. عند توليد قيد محاسبي أجب بـ JSON في كتلة \`\`\`json
7. لا تخترع أرقاماً غير موجودة في البيانات`;

    // Build conversation history
    const messages = [];
    if (history && Array.isArray(history)) {
      history.slice(-10).forEach(h => {
        messages.push({ role: h.role, content: h.content });
      });
    }
    messages.push({ role: 'user', content: message });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: systemPrompt,
        messages
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const reply = data.content?.[0]?.text || 'لم أتمكن من الإجابة';
    res.json({ success: true, reply });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════
// AI CHAT — STREAMING (SSE)
// ═══════════════════════════════════════════════════
app.post('/api/ai/chat/stream', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const db = loadDB();
    const now = new Date();
    const thisMonth = now.toISOString().substring(0, 7);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1).toISOString().substring(0, 7);

    const daily = db.dailyData || [];
    const expenses = db.expenses || [];
    const inventory = db.invItems || [];
    const claims = db.insuranceClaims || [];
    const payroll = db.payroll || [];
    const vouchers = db.vouchers || [];

    const revByMonth = {};
    daily.forEach(d => { const m = (d.date||'').substring(0,7); revByMonth[m] = (revByMonth[m]||0) + (d.total||0); });
    const expByMonth = {};
    expenses.forEach(e => { const m = (e.date||'').substring(0,7); expByMonth[m] = (expByMonth[m]||0) + (e.amount||0); });
    const drRev = {};
    daily.forEach(d => { if (d.doctor) drRev[d.doctor] = (drRev[d.doctor]||0) + (d.total||0); });
    const expByCat = {};
    expenses.forEach(e => { expByCat[e.cat||'أخرى'] = (expByCat[e.cat||'أخرى']||0) + (e.amount||0); });
    const payMix = { cash:0, knet:0, visa:0, master:0, insurance:0, link:0 };
    daily.forEach(d => { payMix.cash+=d.cash||0; payMix.knet+=d.knet||0; payMix.visa+=d.visa||0; payMix.master+=d.master||0; payMix.insurance+=d.insurance||0; payMix.link+=d.link||0; });

    const totalRevenue = daily.reduce((s,d) => s+(d.total||0), 0);
    const totalExpenses = expenses.reduce((s,e) => s+(e.amount||0), 0);
    const thisMonthRev = revByMonth[thisMonth]||0;
    const lastMonthRev = revByMonth[lastMonth]||0;
    const thisMonthExp = expByMonth[thisMonth]||0;
    const revenueGrowth = lastMonthRev ? ((thisMonthRev-lastMonthRev)/lastMonthRev*100).toFixed(1) : null;
    const claimPending = claims.filter(c=>c.status!=='received').reduce((s,c)=>s+c.amount,0);
    const lowStock = inventory.filter(i=>(i.qty||0)<=(i.minQty||0));
    const topExpenses = Object.entries(expByCat).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([c,a])=>`${c}: ${a.toFixed(3)} د.ك`).join(' | ');

    const systemPrompt = `أنت مساعد محاسبي ذكي متخصص في عيادة الأسنان "بوبيان". لديك وصول كامل لبيانات العيادة الحقيقية.

═══════════════════════════════════════
📊 الملف المالي الكامل للعيادة (${now.toLocaleDateString('ar-KW')})
═══════════════════════════════════════
💰 الإيرادات:
• إجمالي كل الفترات: ${totalRevenue.toFixed(3)} د.ك
• ${thisMonth}: ${thisMonthRev.toFixed(3)} د.ك | ${lastMonth}: ${lastMonthRev.toFixed(3)} د.ك
• النمو الشهري: ${revenueGrowth !== null ? revenueGrowth+'%' : 'لا يوجد بيانات'}
• توزيع الدفع — نقد: ${payMix.cash.toFixed(3)} | K-Net: ${payMix.knet.toFixed(3)} | تأمين: ${payMix.insurance.toFixed(3)} | Link: ${payMix.link.toFixed(3)}

💸 المصاريف:
• إجمالي: ${totalExpenses.toFixed(3)} د.ك | هذا الشهر: ${thisMonthExp.toFixed(3)} د.ك
• أكبر فئات: ${topExpenses}

👨‍⚕️ الدكاترة: ${Object.entries(drRev).map(([d,r])=>`${d}: ${r.toFixed(3)}`).join(' | ')||'لا يوجد'}

🏥 التأمين: مطالبات معلقة ${claimPending.toFixed(3)} د.ك

📦 المخزون: ${inventory.length} صنف، منخفض: ${lowStock.map(i=>i.name||i.id).join(', ')||'لا يوجد'}

💼 الرواتب: إجمالي ${payroll.reduce((s,p)=>s+(p.totalNet||0),0).toFixed(3)} د.ك

صافي الربح (إجمالي): ${(totalRevenue-totalExpenses-payroll.reduce((s,p)=>s+(p.totalNet||0),0)).toFixed(3)} د.ك

تعليمات: أجب بالعربي مهنياً. استخدم الأرقام الحقيقية. استخدم emojis للتنظيم. عند توليد قيد محاسبي أجب بـ JSON في \`\`\`json. لا تخترع أرقاماً.`;

    const messages = [];
    if (history && Array.isArray(history)) history.slice(-10).forEach(h => messages.push({ role: h.role, content: h.content }));
    messages.push({ role: 'user', content: message });

    send('tool', { name: 'قراءة البيانات المالية', status: 'done', summary: `${daily.length} سجل، ${expenses.length} مصروف، ${inventory.length} صنف مخزون` });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'messages-2023-12-15' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system: systemPrompt, messages, stream: true })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            send('delta', { text: evt.delta.text });
          }
        } catch {}
      }
    }

    send('done', { success: true });
    res.end();

  } catch (err) {
    send('error', { message: err.message });
    res.end();
  }
});

// ═══════════════════════════════════════════════════
// MONITORING AGENT — مراقب تلقائي للعيادة
// ═══════════════════════════════════════════════════
function buildFinancialSummary(db) {
  const now = new Date();
  const thisMonth = now.toISOString().substring(0, 7);
  const daily = db.dailyData || [];
  const expenses = db.expenses || [];
  const payroll = db.payroll || [];
  const inventory = db.invItems || [];
  const claims = db.insuranceClaims || [];

  const monthlyRev = daily.filter(d=>(d.date||'').startsWith(thisMonth)).reduce((s,d)=>s+(d.total||0),0);
  const monthlyExp = expenses.filter(e=>(e.date||'').startsWith(thisMonth)).reduce((s,e)=>s+(e.amount||0),0);
  const monthlyPayroll = payroll.filter(p=>(p.period||'').startsWith(thisMonth)).reduce((s,p)=>s+(p.totalNet||0),0);
  const totalRev = daily.reduce((s,d)=>s+(d.total||0),0);
  const pendingClaims = claims.filter(c=>c.status!=='received').reduce((s,c)=>s+c.amount,0);
  const lowItems = inventory.filter(i=>(i.qty||0)<=(i.minQty||0));

  return { now, thisMonth, monthlyRev, monthlyExp, monthlyPayroll, totalRev, pendingClaims, lowItems, inventory };
}

async function runInventoryCheck() {
  const db = loadDB();
  const bot = global._tgBot;
  if (!bot || !db.telegramChatId) return;

  const { lowItems } = buildFinancialSummary(db);
  if (!lowItems.length) return;

  const lines = lowItems.map(i => `• ${i.name||i.id}: ${i.qty||0} ${i.unit||''} (الحد الأدنى: ${i.minQty||0})`).join('\n');
  const msg = `⚠️ *تنبيه المخزون — بوبيان للأسنان*\n\nالأصناف التالية وصلت للحد الأدنى:\n${lines}\n\n📅 ${new Date().toLocaleDateString('ar-KW')}`;
  try { await bot.sendMessage(db.telegramChatId, msg, { parse_mode: 'Markdown' }); } catch {}
}

async function runMonthlyReport() {
  const db = loadDB();
  const bot = global._tgBot;
  if (!bot || !db.telegramChatId) return;

  const { thisMonth, monthlyRev, monthlyExp, monthlyPayroll, pendingClaims, lowItems, inventory } = buildFinancialSummary(db);
  const net = monthlyRev - monthlyExp - monthlyPayroll;

  const msg = `📊 *التقرير الشهري — ${thisMonth}*\n*عيادة بوبيان للأسنان*\n\n` +
    `💰 *الإيرادات:* ${monthlyRev.toFixed(3)} د.ك\n` +
    `💸 *المصاريف:* ${monthlyExp.toFixed(3)} د.ك\n` +
    `👥 *الرواتب:* ${monthlyPayroll.toFixed(3)} د.ك\n` +
    `📈 *صافي الربح:* ${net.toFixed(3)} د.ك\n` +
    `🏥 *مطالبات معلقة:* ${pendingClaims.toFixed(3)} د.ك\n` +
    `📦 *المخزون:* ${inventory.length} صنف، ${lowItems.length} منخفض\n\n` +
    `_تم الإرسال تلقائياً من نظام المحاسبة_`;

  try { await bot.sendMessage(db.telegramChatId, msg, { parse_mode: 'Markdown' }); } catch {}
}

// Endpoint لتشغيل الفحص يدوياً
app.post('/api/monitor/inventory', async (req, res) => {
  await runInventoryCheck();
  res.json({ success: true, message: 'تم فحص المخزون وإرسال التنبيهات' });
});
app.post('/api/monitor/monthly-report', async (req, res) => {
  await runMonthlyReport();
  res.json({ success: true, message: 'تم إرسال التقرير الشهري' });
});
app.get('/api/monitor/status', (req, res) => {
  const db = loadDB();
  const { lowItems, inventory, monthlyRev, monthlyExp, thisMonth } = buildFinancialSummary(db);
  res.json({
    botActive: !!global._tgBot,
    chatIdSet: !!db.telegramChatId,
    inventoryItems: inventory.length,
    lowStockItems: lowItems.length,
    thisMonth, monthlyRev, monthlyExp
  });
});

// جدولة تلقائية بدون مكتبة خارجية
(function startMonitorSchedule() {
  function msUntilNext(hour, minute, dayOfMonth) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (dayOfMonth) {
      next.setDate(dayOfMonth);
      if (next <= now) { next.setMonth(next.getMonth() + 1); next.setDate(dayOfMonth); }
    } else {
      if (next <= now) next.setDate(next.getDate() + 1);
    }
    return next - now;
  }

  // فحص المخزون يومياً الساعة 8 صباحاً
  function scheduleInventoryCheck() {
    const delay = msUntilNext(8, 0);
    setTimeout(() => { runInventoryCheck(); scheduleInventoryCheck(); }, delay);
  }

  // تقرير شهري كل أول الشهر الساعة 9 صباحاً
  function scheduleMonthlyReport() {
    const delay = msUntilNext(9, 0, 1);
    setTimeout(() => { runMonthlyReport(); scheduleMonthlyReport(); }, delay);
  }

  scheduleInventoryCheck();
  scheduleMonthlyReport();
  console.log('🤖 Monitoring agent started — daily inventory check @ 8:00am, monthly report @ 1st of month 9:00am');
})();

// ═══════════════════════════════════════════════════
// FINANCIAL STATEMENTS — 3-Statement Model
// P&L + Balance Sheet + Cash Flow (linked)
// ═══════════════════════════════════════════════════
app.get('/api/financial-statements', (req, res) => {
  const db = loadDB();
  const { period = 'month', year, month } = req.query;

  const daily   = db.dailyData        || [];
  const expenses = db.expenses        || [];
  const payroll  = db.payroll         || [];
  const claims   = db.insuranceClaims || [];
  const vouchers = db.vouchers        || [];

  // ── Filter by period ──────────────────────────────
  const now = new Date();
  const targetYear  = parseInt(year)  || now.getFullYear();
  const targetMonth = parseInt(month) || now.getMonth() + 1;
  const monthStr = `${targetYear}-${String(targetMonth).padStart(2,'0')}`;

  const filterByPeriod = (items, dateField = 'date') => {
    if (period === 'month')  return items.filter(i => (i[dateField]||'').startsWith(monthStr));
    if (period === 'year')   return items.filter(i => (i[dateField]||'').startsWith(String(targetYear)));
    return items; // all-time
  };

  const pDaily    = filterByPeriod(daily);
  const pExpenses = filterByPeriod(expenses);
  const pPayroll  = filterByPeriod(payroll, 'period');
  const pVouchers = filterByPeriod(vouchers);

  // ══════════════════════════════════════════════════
  // INCOME STATEMENT (P&L)
  // ══════════════════════════════════════════════════
  const cashRev     = pDaily.reduce((s,d) => s + (d.cash||0), 0);
  const knetRev     = pDaily.reduce((s,d) => s + (d.knet||0) + (d.visa||0) + (d.master||0), 0);
  const linkRev     = pDaily.reduce((s,d) => s + (d.link||0), 0);
  const insRev      = pDaily.reduce((s,d) => s + (d.insurance||0), 0);
  const totalRevenue = cashRev + knetRev + linkRev + insRev;

  // ── Build COA balance map from journal entries (real numbers) ──
  const coaBalMap = {};  // accountCode → { debit, credit }
  const periodJE = (db.journalEntries||[]).filter(je => {
    if (period === 'month') return (je.date||'').startsWith(monthStr);
    if (period === 'year')  return (je.date||'').startsWith(String(targetYear));
    return true;
  });
  periodJE.forEach(je => {
    (je.lines||[]).forEach(l => {
      const code = String(l.accountCode || l.account || '');
      if (!code) return;
      if (!coaBalMap[code]) coaBalMap[code] = { debit:0, credit:0, name:l.accountName||'' };
      coaBalMap[code].debit  += parseFloat(l.debit)  || 0;
      coaBalMap[code].credit += parseFloat(l.credit) || 0;
    });
  });

  // Sum by COA type from journal entries
  const coaAccounts = db.chartOfAccounts || [];
  const coaTypeSum = (type) => {
    return coaAccounts.filter(a=>a.type===type).reduce((s,a) => {
      const b = coaBalMap[a.code];
      if (!b) return s;
      // For expense/asset: balance = debit - credit; for revenue/liability/equity: credit - debit
      const bal = (type==='expense'||type==='asset') ? b.debit - b.credit : b.credit - b.debit;
      return s + Math.max(0, bal);
    }, 0);
  };

  // Real expense breakdown from journal entries (expense-type accounts)
  const expByCat = {};
  pExpenses.forEach(e => {
    const cat = e.cat || 'مصاريف عامة';
    expByCat[cat] = (expByCat[cat] || 0) + (e.amount || 0);
  });

  // Real figures from journal entries
  const salaryExpense  = pPayroll.reduce((s,p) => s + (p.totalNet||0), 0);
  const totalExpenses  = pExpenses.reduce((s,e) => s + (e.amount||0), 0);

  // Real depreciation from JE (type=depreciation in period)
  const depreciation = periodJE
    .filter(je => je.type==='depreciation')
    .reduce((s,je) => s + (je.lines||[]).filter(l=>l.debit>0).reduce((ss,l)=>ss+(parseFloat(l.debit)||0),0), 0);

  // Real expenses from COA (type=expense accounts in JE) — more accurate than expense array
  const jeExpenseTotal = coaTypeSum('expense');
  const totalOpEx  = jeExpenseTotal > 0 ? jeExpenseTotal : (totalExpenses + salaryExpense);
  const totalCOGS  = 0; // dental clinic: no traditional COGS — direct costs already in expenses

  const grossProfit  = totalRevenue - totalCOGS;
  const grossMargin  = totalRevenue ? (grossProfit / totalRevenue * 100) : 0;
  const ebitda       = grossProfit - totalOpEx;
  const ebit         = ebitda - depreciation;
  const netProfit    = ebit;
  const netMargin    = totalRevenue ? (netProfit / totalRevenue * 100) : 0;

  // ══════════════════════════════════════════════════
  // BALANCE SHEET
  // ══════════════════════════════════════════════════

  // Assets
  const allDaily   = daily;
  const allExpenses = expenses;
  const totalAllRev = allDaily.reduce((s,d) => s + (d.total||0), 0);
  const totalAllExp = allExpenses.reduce((s,e) => s + (e.amount||0), 0);
  const totalAllSal = (db.payroll||[]).reduce((s,p) => s + (p.totalNet||0), 0);

  // Current Assets
  const cashBalance    = allDaily.reduce((s,d) => s + (d.cash||0), 0) - allExpenses.reduce((s,e) => s + (e.amount||0)*0.6,0);
  const bankBalance    = allDaily.reduce((s,d) => s + (d.knet||0)+(d.visa||0)+(d.master||0)+(d.link||0), 0);
  const insReceivable  = (db.insuranceClaims||[]).filter(c=>c.status!=='received').reduce((s,c)=>s+(c.amount||0),0);
  const inventory      = (db.invItems||[]).reduce((s,i)=>s+((i.quantity||0)*(i.unitCost||0)),0);

  const currentAssets  = Math.max(0, cashBalance) + Math.max(0, bankBalance) + insReceivable + inventory;

  // Fixed Assets — real from db.fixedAssets
  const fixedAssetsGross = (db.fixedAssets||[]).filter(a=>a.status==='active').reduce((s,a)=>s+(parseFloat(a.cost)||0),0) || 15000;
  const accumDeprReal    = (db.fixedAssets||[]).reduce((s,a)=>s+(parseFloat(a.accumulatedDep)||0),0);
  const netFixedAssets   = Math.max(0, fixedAssetsGross - accumDeprReal);
  const totalAssets    = currentAssets + netFixedAssets;

  // Liabilities — from COA liability accounts via JE (all-time)
  const allJE = db.journalEntries || [];
  const allCoaBalMap = {};
  allJE.forEach(je => {
    (je.lines||[]).forEach(l => {
      const code = String(l.accountCode || l.account || '');
      if (!code) return;
      if (!allCoaBalMap[code]) allCoaBalMap[code] = { debit:0, credit:0 };
      allCoaBalMap[code].debit  += parseFloat(l.debit)  || 0;
      allCoaBalMap[code].credit += parseFloat(l.credit) || 0;
    });
  });
  const coaLiabTotal = coaAccounts.filter(a=>a.type==='liability').reduce((s,a) => {
    const b = allCoaBalMap[a.code]; if (!b) return s;
    return s + Math.max(0, b.credit - b.debit);
  }, 0);
  const unpaidPayroll   = (db.payroll||[]).filter(p=>p.status!=='paid').reduce((s,p)=>s+(p.totalNet||0),0);
  const totalLiab       = Math.max(coaLiabTotal, unpaidPayroll);

  // Equity — from COA equity accounts + retained earnings
  const coaEquityTotal = coaAccounts.filter(a=>a.type==='equity').reduce((s,a) => {
    const b = allCoaBalMap[a.code]; if (!b) return s;
    return s + Math.max(0, b.credit - b.debit);
  }, 0);
  const retainedEarnings = totalAllRev - totalAllExp - totalAllSal;
  const ownerEquity      = coaEquityTotal > 0 ? coaEquityTotal : 5000;
  const totalEquity      = ownerEquity + Math.max(0, retainedEarnings);
  const balanceCheck     = Math.abs(totalAssets - (totalLiab + totalEquity)) < 50;

  // ══════════════════════════════════════════════════
  // CASH FLOW STATEMENT
  // ══════════════════════════════════════════════════
  const cfOperating = netProfit + depreciation
    - (insReceivable / 12) // change in AR estimate
    + (totalLiab / 12);    // change in AP estimate
  const cfInvesting  = -depreciation;
  const cfFinancing  = 0;
  const netCashFlow  = cfOperating + cfInvesting + cfFinancing;

  // ══════════════════════════════════════════════════
  // KEY RATIOS
  // ══════════════════════════════════════════════════
  const currentRatio    = totalLiab ? (currentAssets / totalLiab) : null;
  const debtToEquity    = totalEquity ? (totalLiab / totalEquity) : 0;
  const returnOnEquity  = totalEquity ? (netProfit / totalEquity * 100) : 0;
  const returnOnAssets  = totalAssets ? (netProfit / totalAssets * 100) : 0;

  // Revenue breakdown by doctor
  const drRevenue = {};
  (db.paymentsData||[]).forEach(p => {
    if (!p.doctor || p.doctor === 'Advance') return;
    drRevenue[p.doctor] = (drRevenue[p.doctor]||0) + (p.total||0);
  });

  res.json({
    period: { type: period, year: targetYear, month: targetMonth, label: period === 'month' ? monthStr : String(targetYear) },
    incomeStatement: {
      revenue: {
        cash: cashRev, knet: knetRev, link: linkRev, insurance: insRev, total: totalRevenue
      },
      cogs: totalCOGS,
      grossProfit, grossMarginPct: grossMargin,
      operatingExpenses: {
        byCategory: expByCat,
        salaries: salaryExpense,
        total: totalOpEx
      },
      ebitda,
      depreciation,
      ebit,
      netProfit, netMarginPct: netMargin,
    },
    balanceSheet: {
      assets: {
        current: {
          cash: Math.max(0, cashBalance),
          bank: Math.max(0, bankBalance),
          insuranceReceivable: insReceivable,
          inventory,
          total: currentAssets,
        },
        fixed: { gross: fixedAssetsGross, accumulatedDepreciation: accumDeprReal, net: netFixedAssets },
        total: totalAssets,
      },
      liabilities: {
        current: { unpaidPayroll, total: totalLiab },
        total: totalLiab,
      },
      equity: {
        ownerCapital: ownerEquity,
        retainedEarnings: Math.max(0, retainedEarnings),
        total: totalEquity,
      },
      totalLiabAndEquity: totalLiab + totalEquity,
      balanced: balanceCheck,
    },
    cashFlow: {
      operating: cfOperating,
      investing: cfInvesting,
      financing: cfFinancing,
      netChange: netCashFlow,
    },
    ratios: {
      currentRatio, debtToEquity,
      returnOnEquity, returnOnAssets,
      grossMargin, netMargin,
    },
    doctorRevenue: drRevenue,
  });
});

// Recurring expenses endpoints
app.post('/api/recurring', (req, res) => {
  const db = loadDB();
  if (!db.recurringExpenses) db.recurringExpenses = [];
  db.recurringExpenses.push(req.body);
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/recurring/:id', (req, res) => {
  const db = loadDB();
  db.recurringExpenses = (db.recurringExpenses||[]).filter(r => r.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/recurring/run', (req, res) => {
  const db = loadDB();
  const items = db.recurringExpenses || [];
  const today = new Date();
  const thisMonth = today.toISOString().substring(0, 7);
  let applied = 0;

  items.forEach(r => {
    if (!r.active) return;
    if (r.lastApplied && r.lastApplied.startsWith(thisMonth)) return; // already applied this month

    // Add expense
    if (!db.expenses) db.expenses = [];
    const date = `${thisMonth}-${String(r.day).padStart(2,'0')}`;
    db.expenses.push({
      id: Date.now() + Math.random(),
      desc: r.desc + ' (متكرر)',
      cat: r.cat,
      amount: r.amount,
      date,
      source: 'recurring'
    });

    // Add journal entry
    if (!db.journalEntries) db.journalEntries = [];
    const accounts = db.chartOfAccounts || [];
    const expAcc = accounts.find(a => a.id === r.accountId) || { id: r.accountId||'5670', code: '5670', name: r.cat };
    const cashAcc = accounts.find(a => a.code === '1100') || { id: '1100', code: '1100', name: 'الصندوق' };
    db.journalEntries.push({
      id: 'JE-REC-' + Date.now(),
      date, desc: r.desc + ' (متكرر)',
      ref: 'REC', type: 'expense',
      totalDebit: r.amount, totalCredit: r.amount,
      createdAt: new Date().toISOString(),
      lines: [
        { accountId: expAcc.id, accountCode: expAcc.code, accountName: expAcc.name, debit: r.amount, credit: 0 },
        { accountId: cashAcc.id, accountCode: cashAcc.code, accountName: cashAcc.name, debit: 0, credit: r.amount }
      ]
    });

    r.lastApplied = date;
    applied++;
  });

  saveDB(db);
  res.json({ success: true, applied });
});

// ═══════════════════════════════════════════════════
// MANUAL INCOME ENTRY
// ═══════════════════════════════════════════════════
app.post('/api/manual-entry', (req, res) => {
  const db = loadDB();
  const { date, doctor, cash, knet, visa, master, insurance, link, notes } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });

  const cash_=parseFloat(cash)||0, knet_=parseFloat(knet)||0,
        visa_=parseFloat(visa)||0, master_=parseFloat(master)||0,
        ins_=parseFloat(insurance)||0, link_=parseFloat(link)||0;
  const total = cash_+knet_+visa_+master_+ins_+link_;

  const entry = {
    id: 'MAN-'+Date.now(), source:'manual',
    date, doctor: doctor||'',
    cash:cash_, knet:knet_, visa:visa_, master:master_,
    insurance:ins_, link:link_, total, notes:notes||''
  };
  if (!db.dailyData) db.dailyData = [];
  db.dailyData.push(entry);

  // Auto journal entry
  const accounts = db.chartOfAccounts||[];
  const cashAcc = accounts.find(a=>a.code==='1100')||{id:'1100',code:'1100',name:'الصندوق'};
  const knetAcc = accounts.find(a=>a.code==='1110')||{id:'1110',code:'1110',name:'K-Net'};
  const revAcc  = accounts.find(a=>a.code==='4100')||{id:'4100',code:'4100',name:'إيرادات العيادة'};

  if (!db.journalEntries) db.journalEntries=[];
  const lines=[];
  if(cash_>0) lines.push({accountId:cashAcc.id,accountCode:'1100',accountName:'الصندوق',debit:cash_,credit:0});
  if(knet_>0||visa_>0||master_>0||link_>0){
    const netCard=knet_+visa_+master_+link_;
    lines.push({accountId:knetAcc.id,accountCode:'1110',accountName:'مدفوعات شبكة',debit:netCard,credit:0});
  }
  if(ins_>0){
    const insAcc=accounts.find(a=>a.code==='1120')||{id:'1120',code:'1120',name:'ذمم التأمين'};
    lines.push({accountId:insAcc.id,accountCode:'1120',accountName:'ذمم التأمين',debit:ins_,credit:0});
  }
  lines.push({accountId:revAcc.id,accountCode:'4100',accountName:'إيرادات العيادة',debit:0,credit:total});

  db.journalEntries.push({
    id:'JE-MAN-'+Date.now(), date,
    desc:`إيراد يدوي ${date}${doctor?' — '+doctor:''}`,
    ref:'MAN', type:'revenue',
    totalDebit:total, totalCredit:total,
    createdAt:new Date().toISOString(), lines
  });

  saveDB(db);
  res.json({ success:true, entry });
});

// ═══════════════════════════════════════════════════
// VOUCHERS — سندات القبض والصرف
// ═══════════════════════════════════════════════════
function nextVoucherNo(db, type) {
  const prefix = type==='receipt'?'RV':'PV';
  const all = (db.vouchers||[]).filter(v=>v.type===type);
  const nums = all.map(v=>parseInt((v.number||'0').replace(/\D/g,''))||0);
  const next = nums.length ? Math.max(...nums)+1 : 1;
  return `${prefix}-${String(next).padStart(4,'0')}`;
}

app.get('/api/vouchers', (req,res)=>{
  const db=loadDB();
  let v=db.vouchers||[];
  if(req.query.type) v=v.filter(x=>x.type===req.query.type);
  if(req.query.from) v=v.filter(x=>x.date>=req.query.from);
  if(req.query.to)   v=v.filter(x=>x.date<=req.query.to);
  res.json(v.sort((a,b)=>b.date.localeCompare(a.date)));
});

app.post('/api/vouchers', (req,res)=>{
  const db=loadDB();
  const {type,date,amount,payee,category,notes,debitAccId,creditAccId} = req.body;
  if(!type||!date||!amount) return res.status(400).json({error:'missing fields'});

  const accounts=db.chartOfAccounts||[];
  const debitAcc  = accounts.find(a=>a.id===debitAccId)  || {id:debitAccId||'',  code:debitAccId||'',  name:'حساب مدين'};
  const creditAcc = accounts.find(a=>a.id===creditAccId) || {id:creditAccId||'', code:creditAccId||'', name:'حساب دائن'};

  const number = nextVoucherNo(db, type);
  const amt = parseFloat(amount)||0;
  const voucher = {
    id:'VCH-'+Date.now(), number, type, date, amount:amt,
    payee:payee||'', category:category||'', notes:notes||'',
    debitAccId:debitAcc.id,   debitAccName:debitAcc.name,
    creditAccId:creditAcc.id, creditAccName:creditAcc.name,
    createdAt:new Date().toISOString()
  };
  if(!db.vouchers) db.vouchers=[];
  db.vouchers.push(voucher);

  // Auto journal entry
  if(!db.journalEntries) db.journalEntries=[];
  const jeDesc = type==='receipt'
    ? `سند قبض ${number} — ${payee||''}`
    : `سند صرف ${number} — ${payee||''}`;
  db.journalEntries.push({
    id:'JE-'+number, date, desc:jeDesc,
    ref:number, type, totalDebit:amt, totalCredit:amt,
    createdAt:new Date().toISOString(),
    lines:[
      {accountId:debitAcc.id,  accountCode:debitAcc.code,  accountName:debitAcc.name,  debit:amt, credit:0},
      {accountId:creditAcc.id, accountCode:creditAcc.code, accountName:creditAcc.name, debit:0,   credit:amt}
    ]
  });

  saveDB(db);
  res.json({success:true, voucher});
});

app.delete('/api/vouchers/:id', (req,res)=>{
  const db=loadDB();
  db.vouchers=(db.vouchers||[]).filter(v=>String(v.id)!==String(req.params.id));
  saveDB(db);
  res.json({success:true});
});

// ═══════════════════════════════════════════════════
// CASH RECONCILIATION — تسوية الصندوق
// ═══════════════════════════════════════════════════
app.get('/api/cash-reconciliation', (req,res)=>{
  const db=loadDB();
  let r=db.cashReconciliation||[];
  if(req.query.from) r=r.filter(x=>x.date>=req.query.from);
  if(req.query.to)   r=r.filter(x=>x.date<=req.query.to);
  res.json(r.sort((a,b)=>b.date.localeCompare(a.date)));
});

app.post('/api/cash-reconciliation', (req,res)=>{
  const db=loadDB();
  const {date,openingBalance,physicalCash,notes} = req.body;
  if(!date) return res.status(400).json({error:'date required'});

  // Calculate expected from dailyData that day
  const daily=db.dailyData||[];
  const dayData=daily.filter(d=>d.date===date);
  const expectedCash=dayData.reduce((s,d)=>s+(d.cash||0),0);
  const expectedKnet=dayData.reduce((s,d)=>s+(d.knet||0)+(d.visa||0)+(d.master||0)+(d.link||0),0);
  const totalRevenue=dayData.reduce((s,d)=>s+(d.total||0),0);
  const dayExpenses=(db.expenses||[]).filter(e=>e.date===date).reduce((s,e)=>s+(e.amount||0),0);

  const open=parseFloat(openingBalance)||0;
  const physical=parseFloat(physicalCash)||0;
  const expectedClosing=open+expectedCash-dayExpenses;
  const diff=physical-expectedClosing;

  const rec={
    id:'REC-'+Date.now(), date,
    openingBalance:open, physicalCash:physical,
    expectedCash, expectedKnet, totalRevenue,
    dayExpenses, expectedClosing,
    difference:diff, status:Math.abs(diff)<0.001?'balanced':diff>0?'surplus':'shortage',
    notes:notes||'', createdAt:new Date().toISOString()
  };

  if(!db.cashReconciliation) db.cashReconciliation=[];
  // Remove existing for same date
  db.cashReconciliation=db.cashReconciliation.filter(r=>r.date!==date);
  db.cashReconciliation.push(rec);
  saveDB(db);
  res.json({success:true, rec});
});

// ═══════════════════════════════════════════════════
// INSURANCE CLAIMS — مطالبات التأمين
// ═══════════════════════════════════════════════════
app.get('/api/insurance-claims', (req,res)=>{
  const db=loadDB();
  let c=db.insuranceClaims||[];
  if(req.query.status) c=c.filter(x=>x.status===req.query.status);
  if(req.query.company) c=c.filter(x=>x.company===req.query.company);
  res.json(c.sort((a,b)=>b.claimDate.localeCompare(a.claimDate)));
});

app.post('/api/insurance-claims', (req,res)=>{
  const db=loadDB();
  const {company,claimDate,amount,period,notes} = req.body;
  if(!company||!claimDate||!amount) return res.status(400).json({error:'missing fields'});

  const all=db.insuranceClaims||[];
  const nums=all.map(c=>parseInt((c.claimNo||'0').replace(/\D/g,''))||0);
  const claimNo='IC-'+String(nums.length?Math.max(...nums)+1:1).padStart(4,'0');

  const claim={
    id:'CLM-'+Date.now(), claimNo,
    company, claimDate, amount:parseFloat(amount)||0,
    period:period||'', status:'pending',
    notes:notes||'', createdAt:new Date().toISOString()
  };
  if(!db.insuranceClaims) db.insuranceClaims=[];
  db.insuranceClaims.push(claim);

  // Journal: debit insurance receivable, credit insurance revenue
  const accounts=db.chartOfAccounts||[];
  const insRecAcc=accounts.find(a=>a.code==='1120')||{id:'1120',code:'1120',name:'ذمم التأمين'};
  const insRevAcc=accounts.find(a=>a.code==='4200')||{id:'4200',code:'4200',name:'إيرادات التأمين'};
  if(!db.journalEntries) db.journalEntries=[];
  db.journalEntries.push({
    id:'JE-'+claimNo, date:claimDate,
    desc:`مطالبة تأمين ${claimNo} — ${company}`,
    ref:claimNo, type:'insurance',
    totalDebit:claim.amount, totalCredit:claim.amount,
    createdAt:new Date().toISOString(),
    lines:[
      {accountId:insRecAcc.id,accountCode:'1120',accountName:'ذمم التأمين',debit:claim.amount,credit:0},
      {accountId:insRevAcc.id,accountCode:'4200',accountName:'إيرادات التأمين',debit:0,credit:claim.amount}
    ]
  });

  saveDB(db);
  res.json({success:true,claim});
});

app.put('/api/insurance-claims/:id', (req,res)=>{
  const db=loadDB();
  const claim=(db.insuranceClaims||[]).find(c=>String(c.id)===String(req.params.id));
  if(!claim) return res.status(404).json({error:'not found'});

  const {status,receivedDate,receivedAmount} = req.body;
  claim.status=status||claim.status;
  if(receivedDate) claim.receivedDate=receivedDate;
  if(receivedAmount!=null) claim.receivedAmount=parseFloat(receivedAmount)||0;

  // If marking as received, add journal entry to close the receivable
  if(status==='received' && receivedAmount){
    const accounts=db.chartOfAccounts||[];
    const cashAcc=accounts.find(a=>a.code==='1100')||{id:'1100',code:'1100',name:'الصندوق'};
    const insRecAcc=accounts.find(a=>a.code==='1120')||{id:'1120',code:'1120',name:'ذمم التأمين'};
    const amt=parseFloat(receivedAmount)||0;
    if(!db.journalEntries) db.journalEntries=[];
    db.journalEntries.push({
      id:'JE-CLM-RCV-'+Date.now(), date:receivedDate||new Date().toISOString().slice(0,10),
      desc:`استلام تأمين ${claim.claimNo} — ${claim.company}`,
      ref:claim.claimNo+'-RCV', type:'insurance_received',
      totalDebit:amt, totalCredit:amt,
      createdAt:new Date().toISOString(),
      lines:[
        {accountId:cashAcc.id,accountCode:'1100',accountName:'الصندوق',debit:amt,credit:0},
        {accountId:insRecAcc.id,accountCode:'1120',accountName:'ذمم التأمين',debit:0,credit:amt}
      ]
    });
  }

  saveDB(db);
  res.json({success:true,claim});
});

app.delete('/api/insurance-claims/:id', (req,res)=>{
  const db=loadDB();
  db.insuranceClaims=(db.insuranceClaims||[]).filter(c=>String(c.id)!==String(req.params.id));
  saveDB(db);
  res.json({success:true});
});

// ═══════════════════════════════════════════════════
// PAYROLL — كشف الرواتب
// ═══════════════════════════════════════════════════
app.get('/api/payroll', (req,res)=>{
  const db=loadDB();
  let p=db.payroll||[];
  if(req.query.month) p=p.filter(x=>x.month===req.query.month);
  res.json(p.sort((a,b)=>b.month.localeCompare(a.month)));
});

app.post('/api/payroll', (req,res)=>{
  const db=loadDB();
  const {month, entries} = req.body; // entries: [{name,role,basicSalary,allowances,deductions,notes}]
  if(!month||!entries||!entries.length) return res.status(400).json({error:'missing fields'});

  const totalGross=entries.reduce((s,e)=>s+(parseFloat(e.basicSalary)||0)+(parseFloat(e.allowances)||0),0);
  const totalDeductions=entries.reduce((s,e)=>s+(parseFloat(e.deductions)||0),0);
  const totalNet=totalGross-totalDeductions;

  const record={
    id:'PAY-'+Date.now(), month, entries:entries.map(e=>({
      ...e,
      basicSalary:parseFloat(e.basicSalary)||0,
      allowances:parseFloat(e.allowances)||0,
      deductions:parseFloat(e.deductions)||0,
      netSalary:(parseFloat(e.basicSalary)||0)+(parseFloat(e.allowances)||0)-(parseFloat(e.deductions)||0)
    })),
    totalGross, totalDeductions, totalNet,
    status:'pending', createdAt:new Date().toISOString()
  };

  if(!db.payroll) db.payroll=[];
  db.payroll.push(record);

  // Auto journal entry for payroll
  const payDate=`${month}-01`;
  const accounts=db.chartOfAccounts||[];
  const salaryExp=accounts.find(a=>a.code==='5200')||{id:'5200',code:'5200',name:'مصاريف الرواتب'};
  const cashAcc=accounts.find(a=>a.code==='1100')||{id:'1100',code:'1100',name:'الصندوق'};
  if(!db.journalEntries) db.journalEntries=[];
  db.journalEntries.push({
    id:'JE-PAY-'+Date.now(), date:payDate,
    desc:`رواتب شهر ${month}`,
    ref:'PAY-'+month, type:'payroll',
    totalDebit:totalNet, totalCredit:totalNet,
    createdAt:new Date().toISOString(),
    lines:[
      {accountId:salaryExp.id,accountCode:'5200',accountName:'مصاريف الرواتب',debit:totalNet,credit:0},
      {accountId:cashAcc.id,accountCode:'1100',accountName:'الصندوق',debit:0,credit:totalNet}
    ]
  });

  saveDB(db);
  res.json({success:true,record});
});

app.put('/api/payroll/:id/status', (req,res)=>{
  const db=loadDB();
  const rec=(db.payroll||[]).find(p=>String(p.id)===String(req.params.id));
  if(!rec) return res.status(404).json({error:'not found'});
  rec.status=req.body.status||'paid';
  rec.paidDate=req.body.paidDate||new Date().toISOString().slice(0,10);
  saveDB(db);
  res.json({success:true,rec});
});

app.delete('/api/payroll/:id', (req,res)=>{
  const db=loadDB();
  db.payroll=(db.payroll||[]).filter(p=>String(p.id)!==String(req.params.id));
  saveDB(db);
  res.json({success:true});
});

// Employees CRUD
app.get('/api/employees', (req,res)=>{
  const db=loadDB();
  res.json(db.employees||[]);
});

app.post('/api/employees', (req,res)=>{
  const db=loadDB();
  if(!db.employees) db.employees=[];
  db.employees.push({id:'EMP-'+Date.now(),...req.body,createdAt:new Date().toISOString()});
  saveDB(db);
  res.json({success:true});
});

app.delete('/api/employees/:id', (req,res)=>{
  const db=loadDB();
  db.employees=(db.employees||[]).filter(e=>String(e.id)!==String(req.params.id));
  saveDB(db);
  res.json({success:true});
});

// ─── FIXED ASSETS ───────────────────────────────────────────────────────────
app.get('/api/assets', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.fixedAssets || []);
});

app.post('/api/assets', requireAuth, (req, res) => {
  const db = loadDB();
  if (!db.fixedAssets) db.fixedAssets = [];
  const asset = {
    id: 'AST-' + Date.now(),
    code: sanitize(req.body.code || '', 20),
    name: sanitize(req.body.name || '', 200),
    category: sanitize(req.body.category || '', 100),
    purchaseDate: sanitize(req.body.purchaseDate || '', 10),
    cost: parseFloat(req.body.cost) || 0,
    usefulLife: parseInt(req.body.usefulLife) || 5,
    method: req.body.method || 'straight-line',
    salvageValue: parseFloat(req.body.salvageValue) || 0,
    coaAccount: sanitize(req.body.coaAccount || '1510', 10),
    accDepAccount: sanitize(req.body.accDepAccount || '1590', 10),
    depExpAccount: sanitize(req.body.depExpAccount || '5800', 10),
    accumulatedDep: 0,
    status: 'active',
    createdAt: new Date().toISOString()
  };
  db.fixedAssets.push(asset);
  saveDB(db);
  res.json({ success: true, asset });
});

app.put('/api/assets/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const idx = (db.fixedAssets || []).findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'الأصل غير موجود' });
  db.fixedAssets[idx] = { ...db.fixedAssets[idx], ...req.body, id: req.params.id };
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/assets/:id', requireAuth, (req, res) => {
  const db = loadDB();
  db.fixedAssets = (db.fixedAssets || []).filter(a => a.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/assets/depreciate', requireAuth, (req, res) => {
  const db = loadDB();
  const { period } = req.body; // e.g. "2026-06"
  if (!period) return res.status(400).json({ error: 'يجب تحديد الفترة' });
  if (!db.fixedAssets || db.fixedAssets.length === 0)
    return res.status(400).json({ error: 'لا توجد أصول ثابتة' });

  // Auto-fill missing depreciation accounts on old assets
  db.fixedAssets.forEach(a => {
    if (!a.depExpAccount) a.depExpAccount = '5800';
    if (!a.accDepAccount) a.accDepAccount = '1590';
    if (!a.usefulLife)    a.usefulLife    = 5;
    if (!a.salvageValue)  a.salvageValue  = 0;
    if (!a.status)        a.status        = 'active';
    if (a.accumulatedDep === undefined) a.accumulatedDep = 0;
  });

  const lines = [];
  let totalDep = 0;

  db.fixedAssets.forEach(asset => {
    if (asset.status !== 'active') return;
    const annualDep = (asset.cost - asset.salvageValue) / asset.usefulLife;
    const monthlyDep = annualDep / 12;
    const nbv = asset.cost - (asset.accumulatedDep || 0);
    if (nbv <= asset.salvageValue || monthlyDep <= 0) return;

    const dep = Math.min(monthlyDep, nbv - asset.salvageValue);
    asset.accumulatedDep = (asset.accumulatedDep || 0) + dep;
    totalDep += dep;

    lines.push({ account: asset.depExpAccount, accountName: 'مصروف اهتلاك - ' + asset.name, debit: dep, credit: 0 });
    lines.push({ account: asset.accDepAccount, accountName: 'مجمع اهتلاك - ' + asset.name, debit: 0, credit: dep });
  });

  if (lines.length === 0) return res.json({ success: true, message: 'لا توجد أصول تستحق اهتلاكاً', totalDep: 0 });

  if (!db.journalEntries) db.journalEntries = [];
  const je = {
    id: 'JE-DEP-' + Date.now(),
    date: period + '-01',
    desc: 'قيد اهتلاك شهر ' + period,
    ref: 'DEP-' + period,
    type: 'depreciation',
    lines,
    createdAt: new Date().toISOString()
  };
  db.journalEntries.push(je);
  saveDB(db);
  res.json({ success: true, journalEntry: je, totalDep, assetsCount: lines.length / 2 });
});

// ─── BANK RECONCILIATION ─────────────────────────────────────────────────────
app.get('/api/bank-recon', requireAuth, (req, res) => {
  const db = loadDB();
  const { account, period } = req.query;
  if (!account || !period) return res.status(400).json({ error: 'account و period مطلوبان' });

  const recons = db.bankRecons || [];
  const existing = recons.find(r => r.account === account && r.period === period);

  // Get journal lines for this account in this period
  const [year, month] = period.split('-');
  const journalLines = [];
  (db.journalEntries || []).forEach(je => {
    if (!je.date.startsWith(period)) return;
    (je.lines || []).forEach(line => {
      if (String(line.account) === String(account)) {
        journalLines.push({
          id: je.id + '-' + (line.account),
          date: je.date,
          desc: je.desc,
          ref: je.ref,
          debit: line.debit || 0,
          credit: line.credit || 0,
          matched: existing?.matchedLines?.includes(je.id + '-' + line.account) || false
        });
      }
    });
  });

  // Opening balance from opening entries
  const openingBalance = (db.chartOfAccounts || []).find(a => String(a.code) === String(account))?.openingDebit || 0;

  res.json({
    account,
    period,
    bankStatementLines: existing?.bankStatementLines || [],
    matchedLines: existing?.matchedLines || [],
    bankEndBalance: existing?.bankEndBalance || 0,
    notes: existing?.notes || '',
    journalLines,
    openingBalance
  });
});

app.post('/api/bank-recon', requireAuth, (req, res) => {
  const db = loadDB();
  if (!db.bankRecons) db.bankRecons = [];
  const { account, period, bankStatementLines, matchedLines, bankEndBalance, notes } = req.body;
  const idx = db.bankRecons.findIndex(r => r.account === account && r.period === period);
  const rec = { account, period, bankStatementLines: bankStatementLines || [], matchedLines: matchedLines || [], bankEndBalance: parseFloat(bankEndBalance) || 0, notes: notes || '', updatedAt: new Date().toISOString() };
  if (idx >= 0) db.bankRecons[idx] = rec;
  else db.bankRecons.push(rec);
  saveDB(db);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// EXCEL TEMPLATES — تحميل قوالب الاستيراد
// ═══════════════════════════════════════════════════════════════════════════

function styleHeader(ws, headers, rowNum) {
  headers.forEach((h, i) => {
    const cellRef = XLSX.utils.encode_cell({ r: rowNum - 1, c: i });
    if (!ws[cellRef]) ws[cellRef] = {};
    ws[cellRef].s = {
      font: { bold: true, color: { rgb: 'FFFFFF' }, name: 'Arial', sz: 11 },
      fill: { fgColor: { rgb: '1E3A5F' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: {
        top: { style: 'thin', color: { rgb: 'AAAAAA' } },
        bottom: { style: 'thin', color: { rgb: 'AAAAAA' } },
        left: { style: 'thin', color: { rgb: 'AAAAAA' } },
        right: { style: 'thin', color: { rgb: 'AAAAAA' } }
      }
    };
  });
}

// Helper: build and send an xlsx workbook
function sendWorkbook(res, wb, filename) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', bookSST: false });
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

// ── 1. قالب المصاريف ──────────────────────────────────────────────────────
app.get('/api/templates/expenses', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Data entry
  const headers = ['التاريخ','الوصف','المبلغ (د.ك)','الفئة','طريقة الدفع','المورد','رقم الفاتورة','رقم حساب المدين','رقم حساب الدائن','ملاحظات'];
  const sample = [
    ['2026-06-13','مستلزمات طبية',150.500,'مستلزمات طبية','نقداً','شركة الخليج الطبية','INV-001','5100','1010',''],
    ['2026-06-13','إيجار العيادة',800.000,'إيجار','تحويل بنكي','المالك','','5200','2100','إيجار يونيو 2026'],
    ['2026-06-13','كهرباء وماء',95.750,'مرافق','بطاقة','','','5300','1010',''],
  ];
  const wsData = [headers, ...sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [12,28,14,18,14,22,14,18,18,22].map(w => ({ wch: w }));
  ws['!rows'] = [{ hpt: 36 }];
  styleHeader(ws, headers, 1);
  XLSX.utils.book_append_sheet(wb, ws, 'المصاريف');

  // Sheet 2: Instructions
  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['📋 تعليمات قالب المصاريف'],
    [''],
    ['الحقل', 'وصف', 'مثال', 'إلزامي؟'],
    ['التاريخ', 'تاريخ المصروف بصيغة YYYY-MM-DD', '2026-06-13', 'نعم'],
    ['الوصف', 'وصف مختصر للمصروف', 'مستلزمات طبية', 'نعم'],
    ['المبلغ', 'المبلغ بالدينار الكويتي - ثلاث خانات عشرية', '150.500', 'نعم'],
    ['الفئة', 'فئة المصروف', 'مستلزمات طبية / إيجار / رواتب ...', 'لا'],
    ['طريقة الدفع', 'كيف تم الدفع', 'نقداً / بطاقة / تحويل بنكي', 'لا'],
    ['المورد', 'اسم الجهة الموردة أو المستفيدة', 'شركة الخليج الطبية', 'لا'],
    ['رقم الفاتورة', 'رقم الفاتورة إن وجد', 'INV-001', 'لا'],
    ['رقم حساب المدين', 'رقم الحساب من دليل الحسابات (يُترك فارغاً للنظام)', '5100', 'لا'],
    ['رقم حساب الدائن', 'رقم الحساب الدائن (يُترك فارغاً للنظام)', '1010', 'لا'],
    ['ملاحظات', 'أي ملاحظات إضافية', '', 'لا'],
    [''],
    ['⚠️ ملاحظات مهمة:'],
    ['- لا تعدّل رؤوس الأعمدة في الصف الأول'],
    ['- إذا تركت حسابات المدين/الدائن فارغة، سيختار النظام الحسابات الافتراضية'],
    ['- يمكن إدخال أكثر من 500 سطر في ورقة واحدة'],
  ]);
  wsInfo['!cols'] = [20, 38, 28, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsInfo, 'تعليمات');

  sendWorkbook(res, wb, 'قالب_المصاريف.xlsx');
});

// ── 2. قالب الأرصدة الافتتاحية للمخزون ──────────────────────────────────
app.get('/api/templates/inventory-opening', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();

  const headers = ['اسم المادة','الوحدة','الكمية الافتتاحية','تكلفة الوحدة (د.ك)','إجمالي التكلفة (د.ك)','الكمية الدنيا (تنبيه)','الفئة','الموقع / المستودع','رقم الحساب','ملاحظات'];
  const sample = [
    ['مخدر موضعي','علبة',20,2.500,'=C2*D2',5,'مواد طبية','مستودع رئيسي','1310',''],
    ['إبر الحقن','صندوق',15,3.750,'=C3*D3',3,'مواد طبية','مستودع رئيسي','1310',''],
    ['قفازات لاتكس','صندوق',30,1.800,'=C4*D4',10,'مستلزمات','مستودع رئيسي','1310',''],
    ['مواد حشو','عبوة',8,12.000,'=C5*D5',2,'مواد علاجية','مستودع طب الأسنان','1310',''],
  ];
  const wsData = [headers, ...sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [22,10,16,18,18,16,14,18,14,22].map(w => ({ wch: w }));
  ws['!rows'] = [{ hpt: 36 }];
  styleHeader(ws, headers, 1);
  XLSX.utils.book_append_sheet(wb, ws, 'أرصدة_المخزون');

  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['📋 تعليمات قالب الأرصدة الافتتاحية للمخزون'],
    [''],
    ['الحقل', 'وصف', 'مثال', 'إلزامي؟'],
    ['اسم المادة', 'اسم المادة أو المستلزم', 'مخدر موضعي', 'نعم'],
    ['الوحدة', 'وحدة القياس', 'علبة / صندوق / قطعة / مل', 'نعم'],
    ['الكمية الافتتاحية', 'الكمية الموجودة حالياً', '20', 'نعم'],
    ['تكلفة الوحدة', 'تكلفة الشراء لكل وحدة بالدينار', '2.500', 'نعم'],
    ['إجمالي التكلفة', 'يحتسب تلقائياً = الكمية × التكلفة', 'معادلة تلقائية', 'لا'],
    ['الكمية الدنيا', 'حد إعادة الطلب — يظهر تنبيه عنده', '5', 'لا'],
    ['الفئة', 'تصنيف المادة', 'مواد طبية / مستلزمات / أدوات', 'لا'],
    ['الموقع', 'مكان التخزين', 'مستودع رئيسي', 'لا'],
    ['رقم الحساب', 'حساب المخزون من دليل الحسابات (اتركه فارغاً للافتراضي)', '1310', 'لا'],
    [''],
    ['⚠️ ملاحظات:'],
    ['- سيُنشئ النظام قيداً يومياً يُدين حساب المخزون ويُدائن رأس المال'],
    ['- تأكد من صحة الكميات — هذه أرصدة البداية ولا يمكن تعديلها لاحقاً بسهولة'],
    ['- العمود E (إجمالي التكلفة) يحتسب تلقائياً في Excel ولكن النظام يحسبه مجدداً'],
  ]);
  wsInfo['!cols'] = [20, 38, 28, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsInfo, 'تعليمات');

  sendWorkbook(res, wb, 'قالب_أرصدة_المخزون.xlsx');
});

// ── 3. قالب مدفوعات الدكاترة ─────────────────────────────────────────────
app.get('/api/templates/doctor-payments', requireAuth, (req, res) => {
  const db = loadDB();
  const wb = XLSX.utils.book_new();

  const headers = ['اسم الدكتور','الشهر (YYYY-MM)','إجمالي الإيرادات (د.ك)','خصومات المختبر (د.ك)','خصومات التأمين (د.ك)','صافي الوعاء','نسبة العمولة %','العمولة المستحقة (د.ك)','السُّلف المصروفة (د.ك)','صافي المستحق (د.ك)','تاريخ الدفع','طريقة الدفع','ملاحظات'];
  const doctors = (db.doctors || []).map((d, i) => [
    d.name, '2026-06', 0, 0, 0, `=C${i+2}-D${i+2}-E${i+2}`, d.commission, `=F${i+2}*G${i+2}/100`, 0, `=H${i+2}-I${i+2}`, '', 'تحويل بنكي', ''
  ]);
  const sample = doctors.length ? doctors : [
    ['DR.NASSER','2026-06',5000,200,300,'=C2-D2-E2',20,'=F2*G2/100',0,'=H2-I2','2026-06-30','تحويل بنكي',''],
  ];
  const wsData = [headers, ...sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [18,14,18,16,16,14,14,18,16,16,14,14,18].map(w => ({ wch: w }));
  ws['!rows'] = [{ hpt: 36 }];
  styleHeader(ws, headers, 1);
  XLSX.utils.book_append_sheet(wb, ws, 'مدفوعات_الدكاترة');

  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['📋 تعليمات قالب مدفوعات الدكاترة'],
    [''],
    ['الحقل', 'وصف', 'ملاحظة'],
    ['اسم الدكتور', 'اسم الدكتور كما هو في النظام', 'يجب أن يتطابق تماماً'],
    ['الشهر', 'الشهر المحاسبي بصيغة YYYY-MM', '2026-06'],
    ['إجمالي الإيرادات', 'إجمالي ما حققه الدكتور قبل الخصومات', 'د.ك'],
    ['خصومات المختبر', 'تكاليف المختبر الخارجي', 'د.ك'],
    ['خصومات التأمين', 'خصومات شركات التأمين', 'د.ك'],
    ['صافي الوعاء', 'يحتسب تلقائياً = الإيرادات - خصومات', 'معادلة'],
    ['نسبة العمولة %', 'النسبة المتفق عليها مع الدكتور', '%'],
    ['العمولة المستحقة', 'يحتسب تلقائياً = الوعاء × النسبة', 'معادلة'],
    ['السُّلف', 'أي سُلف صُرفت للدكتور مسبقاً', 'د.ك'],
    ['صافي المستحق', 'العمولة - السُّلف', 'معادلة'],
    ['تاريخ الدفع', 'تاريخ صرف المبلغ', 'YYYY-MM-DD'],
    ['طريقة الدفع', 'نقداً / بطاقة / تحويل بنكي / شيك', ''],
    [''],
    ['⚠️ سيُنشئ النظام قيداً يومياً: مدين حساب عمولات الدكاترة — دائن الخزينة/البنك'],
  ]);
  wsInfo['!cols'] = [20, 38, 22].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsInfo, 'تعليمات');

  sendWorkbook(res, wb, 'قالب_مدفوعات_الدكاترة.xlsx');
});

// ── 4. قالب قيود يومية جماعية ────────────────────────────────────────────
app.get('/api/templates/bulk-journal', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();

  const headers = ['رقم القيد (مشترك لسطور نفس القيد)','التاريخ','الوصف','رقم الحساب','اسم الحساب','مدين (د.ك)','دائن (د.ك)','مرجع','ملاحظات'];
  const sample = [
    ['JE-001','2026-06-13','شراء مستلزمات طبية','5100','مصاريف مستلزمات طبية',150.500,0,'INV-001',''],
    ['JE-001','2026-06-13','شراء مستلزمات طبية','1010','الصندوق',0,150.500,'INV-001','الطرف المقابل'],
    ['','','','','','','','',''],
    ['JE-002','2026-06-13','إيجار يونيو 2026','5200','مصروف الإيجار',800.000,0,'',''],
    ['JE-002','2026-06-13','إيجار يونيو 2026','2100','دائنون متنوعون',0,800.000,'',''],
  ];
  const wsData = [headers, ...sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [28,13,28,14,24,14,14,14,20].map(w => ({ wch: w }));
  ws['!rows'] = [{ hpt: 36 }];
  styleHeader(ws, headers, 1);
  XLSX.utils.book_append_sheet(wb, ws, 'قيود_جماعية');

  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['📋 تعليمات قالب القيود اليومية الجماعية'],
    [''],
    ['⚙️ كيفية الاستخدام:'],
    ['1. كل قيد يتكون من سطرين أو أكثر يشتركون في نفس رقم القيد'],
    ['2. مجموع المدين = مجموع الدائن لكل قيد (شرط التوازن)'],
    ['3. رقم الحساب يجب أن يتطابق مع دليل الحسابات في النظام'],
    ['4. اترك صف فارغاً بين القيود المختلفة (اختياري للوضوح)'],
    [''],
    ['الحقل', 'وصف', 'إلزامي؟'],
    ['رقم القيد', 'معرّف القيد — نفس الرقم لسطور القيد الواحد', 'نعم'],
    ['التاريخ', 'تاريخ القيد YYYY-MM-DD', 'نعم'],
    ['الوصف', 'وصف القيد (نفسه لكل سطور القيد)', 'نعم'],
    ['رقم الحساب', 'الكود من دليل الحسابات', 'نعم'],
    ['اسم الحساب', 'للمرجعية فقط — النظام يستخدم رقم الحساب', 'لا'],
    ['مدين', 'المبلغ المدين (0 للسطور الدائنة)', 'نعم'],
    ['دائن', 'المبلغ الدائن (0 للسطور المدينة)', 'نعم'],
    ['مرجع', 'رقم الفاتورة أو المستند المرجعي', 'لا'],
    [''],
    ['❌ أخطاء شائعة:'],
    ['- عدم توازن القيد (مدين ≠ دائن) → سيرفض النظام القيد'],
    ['- رقم حساب غير موجود في دليل الحسابات → خطأ في الاستيراد'],
    ['- تكرار رقم قيد مع تواريخ مختلفة → يجب أن يكون لكل قيد تاريخ واحد'],
  ]);
  wsInfo['!cols'] = [20, 42, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsInfo, 'تعليمات');

  sendWorkbook(res, wb, 'قالب_قيود_جماعية.xlsx');
});

// ── 5. قالب أرصدة المرضى الافتتاحية ─────────────────────────────────────
app.get('/api/templates/patient-opening', requireAuth, (req, res) => {
  const wb = XLSX.utils.book_new();

  const headers = ['اسم المريض','رقم الملف','التاريخ الافتتاحي','المبلغ المستحق (د.ك)','نوع التأمين','شركة التأمين','ملاحظات'];
  const sample = [
    ['أحمد محمد الشمري','P-001','2026-01-01',250.000,'تأمين اختياري','شركة الخليج للتأمين','رصيد منقول من النظام القديم'],
    ['سارة علي العتيبي','P-002','2026-01-01',180.500,'نقدي','',''],
    ['خالد يوسف البدر','P-003','2026-01-01',95.750,'تأمين إلزامي','AXA التأمين',''],
  ];
  const wsData = [headers, ...sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [24,12,16,18,14,24,28].map(w => ({ wch: w }));
  ws['!rows'] = [{ hpt: 36 }];
  styleHeader(ws, headers, 1);
  XLSX.utils.book_append_sheet(wb, ws, 'أرصدة_المرضى');

  const wsInfo = XLSX.utils.aoa_to_sheet([
    ['📋 تعليمات قالب الأرصدة الافتتاحية للمرضى'],
    [''],
    ['⚙️ الغرض:'],
    ['يُستخدم هذا القالب عند الترحيل من نظام محاسبي آخر لنقل الذمم المدينة للمرضى'],
    [''],
    ['الحقل', 'وصف', 'إلزامي؟'],
    ['اسم المريض', 'الاسم الكامل للمريض', 'نعم'],
    ['رقم الملف', 'رقم ملف المريض في النظام', 'لا'],
    ['التاريخ الافتتاحي', 'تاريخ بداية الرصيد YYYY-MM-DD', 'نعم'],
    ['المبلغ المستحق', 'المبلغ المستحق على المريض بالدينار', 'نعم'],
    ['نوع التأمين', 'نقدي / تأمين إلزامي / تأمين اختياري', 'لا'],
    ['شركة التأمين', 'اسم شركة التأمين إن وجدت', 'لا'],
    [''],
    ['⚠️ سيُنشئ النظام: قيد مدين ذمم مرضى — دائن رأس المال (ترحيل)'],
  ]);
  wsInfo['!cols'] = [20, 42, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsInfo, 'تعليمات');

  sendWorkbook(res, wb, 'قالب_أرصدة_المرضى.xlsx');
});

// ═══════════════════════════════════════════════════════════════════════════
// EXCEL IMPORT — استيراد البيانات من Excel
// ═══════════════════════════════════════════════════════════════════════════

// ── IMPORT: المصاريف ──────────────────────────────────────────────────────
app.post('/api/import/expenses', requireAuth, upload.single('file'), (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.removeSync(req.file.path);

    const db = loadDB();
    if (!db.expenses) db.expenses = [];
    if (!db.journalEntries) db.journalEntries = [];
    const settings = db.accountingSettings || {};
    const cashAcc = settings.accCash || '1010';
    const errors = [];
    const created = [];

    rows.forEach((row, i) => {
      const date   = String(row['التاريخ'] || '').trim();
      const desc   = String(row['الوصف'] || '').trim();
      const amount = parseFloat(row['المبلغ (د.ك)'] || row['المبلغ'] || 0);
      if (!date || !desc || !amount) { errors.push(`سطر ${i+2}: بيانات ناقصة`); return; }

      const id = `EXP-${Date.now()}-${i}`;
      const expense = {
        id, date, description: desc, amount,
        category:    String(row['الفئة'] || 'متنوعة'),
        paymentMethod: String(row['طريقة الدفع'] || 'نقداً'),
        vendor:      String(row['المورد'] || ''),
        invoiceNo:   String(row['رقم الفاتورة'] || ''),
        notes:       String(row['ملاحظات'] || ''),
        createdAt:   new Date().toISOString()
      };
      db.expenses.push(expense);

      const debitAcc  = String(row['رقم حساب المدين'] || '5100').trim() || '5100';
      const creditAcc = String(row['رقم حساب الدائن'] || cashAcc).trim() || cashAcc;
      const je = {
        id: `JE-IMP-EXP-${Date.now()}-${i}`,
        date, description: desc,
        lines: [
          { accountCode: debitAcc,  debit: amount,  credit: 0 },
          { accountCode: creditAcc, debit: 0, credit: amount }
        ],
        reference: expense.invoiceNo || id,
        source: 'import-expenses',
        createdAt: new Date().toISOString()
      };
      db.journalEntries.push(je);
      created.push({ id, jeId: je.id });
    });

    saveDB(db);
    res.json({ success: true, created: created.length, errors });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── IMPORT: المخزون الافتتاحي ────────────────────────────────────────────
app.post('/api/import/inventory-opening', requireAuth, upload.single('file'), (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.removeSync(req.file.path);

    const db = loadDB();
    if (!db.inventory) db.inventory = [];
    if (!db.journalEntries) db.journalEntries = [];
    const settings = db.accountingSettings || {};
    const errors = [];
    const created = [];
    let totalValue = 0;
    const jeLines = [];

    rows.forEach((row, i) => {
      const name = String(row['اسم المادة'] || '').trim();
      const qty  = parseFloat(row['الكمية الافتتاحية'] || row['الكمية'] || 0);
      const cost = parseFloat(row['تكلفة الوحدة (د.ك)'] || row['تكلفة الوحدة'] || 0);
      if (!name || !qty) { errors.push(`سطر ${i+2}: اسم أو كمية ناقصة`); return; }

      const id = `INV-${Date.now()}-${i}`;
      const total = parseFloat((qty * cost).toFixed(3));
      const invAcct = String(row['رقم الحساب'] || settings.accInventory || '1310').trim();

      const item = {
        id, name,
        unit:         String(row['الوحدة'] || 'قطعة'),
        quantity:     qty,
        costPerUnit:  cost,
        totalCost:    total,
        minQuantity:  parseFloat(row['الكمية الدنيا (تنبيه)'] || 0),
        category:     String(row['الفئة'] || 'عام'),
        location:     String(row['الموقع / المستودع'] || ''),
        accountCode:  invAcct,
        notes:        String(row['ملاحظات'] || ''),
        isOpening:    true,
        createdAt:    new Date().toISOString()
      };

      // Merge if exists
      const existing = db.inventory.findIndex(it => it.name === name);
      if (existing >= 0) {
        db.inventory[existing].quantity += qty;
        db.inventory[existing].totalCost = parseFloat(((db.inventory[existing].totalCost || 0) + total).toFixed(3));
      } else {
        db.inventory.push(item);
      }

      totalValue += total;
      jeLines.push({ accountCode: invAcct, debit: total, credit: 0 });
      created.push(name);
    });

    // Single journal entry for all opening inventory
    if (jeLines.length > 0) {
      const equityAcc = settings.accRetained || '3100';
      jeLines.push({ accountCode: equityAcc, debit: 0, credit: parseFloat(totalValue.toFixed(3)) });
      db.journalEntries.push({
        id: `JE-INV-OPEN-${Date.now()}`,
        date: new Date().toISOString().split('T')[0],
        description: `أرصدة افتتاحية للمخزون — استيراد Excel (${created.length} مادة)`,
        lines: jeLines,
        source: 'import-inventory-opening',
        createdAt: new Date().toISOString()
      });
    }

    saveDB(db);
    res.json({ success: true, created: created.length, totalValue: parseFloat(totalValue.toFixed(3)), errors });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── IMPORT: مدفوعات الدكاترة ─────────────────────────────────────────────
app.post('/api/import/doctor-payments', requireAuth, upload.single('file'), (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.removeSync(req.file.path);

    const db = loadDB();
    if (!db.doctorPayments) db.doctorPayments = [];
    if (!db.journalEntries) db.journalEntries = [];
    const settings = db.accountingSettings || {};
    const cashAcc = settings.accCash || '1010';
    const errors = [];
    const created = [];

    rows.forEach((row, i) => {
      const doctor = String(row['اسم الدكتور'] || '').trim();
      const month  = String(row['الشهر (YYYY-MM)'] || row['الشهر'] || '').trim();
      const net    = parseFloat(row['صافي المستحق (د.ك)'] || row['صافي المستحق'] || 0);
      if (!doctor || !month) { errors.push(`سطر ${i+2}: دكتور أو شهر ناقص`); return; }

      const id = `DPAY-${Date.now()}-${i}`;
      const commission = parseFloat(row['العمولة المستحقة (د.ك)'] || row['العمولة المستحقة'] || 0);
      const advances   = parseFloat(row['السُّلف المصروفة (د.ك)'] || row['السلف'] || 0);
      const payDate    = String(row['تاريخ الدفع'] || month + '-30').trim();
      const payMethod  = String(row['طريقة الدفع'] || 'تحويل بنكي').trim();

      const payment = {
        id, doctor, month, commission, advances, net,
        payDate, payMethod,
        revenue:   parseFloat(row['إجمالي الإيرادات (د.ك)'] || 0),
        labDeduct: parseFloat(row['خصومات المختبر (د.ك)'] || 0),
        insDeduct: parseFloat(row['خصومات التأمين (د.ك)'] || 0),
        notes:     String(row['ملاحظات'] || ''),
        createdAt: new Date().toISOString()
      };
      db.doctorPayments.push(payment);

      if (net > 0) {
        db.journalEntries.push({
          id: `JE-DPAY-${Date.now()}-${i}`,
          date: payDate,
          description: `عمولة ${doctor} — ${month}`,
          lines: [
            { accountCode: '5400', debit: commission, credit: 0 },
            { accountCode: cashAcc, debit: 0, credit: net },
            ...(advances > 0 ? [{ accountCode: '1200', debit: 0, credit: advances }] : [])
          ],
          source: 'import-doctor-payments',
          createdAt: new Date().toISOString()
        });
      }
      created.push(doctor);
    });

    saveDB(db);
    res.json({ success: true, created: created.length, errors });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── IMPORT: قيود جماعية ───────────────────────────────────────────────────
app.post('/api/import/bulk-journal', requireAuth, upload.single('file'), (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.removeSync(req.file.path);

    const db = loadDB();
    if (!db.journalEntries) db.journalEntries = [];

    // Group rows by journal entry ID
    const groups = {};
    rows.forEach((row, i) => {
      const jeId   = String(row['رقم القيد (مشترك لسطور نفس القيد)'] || row['رقم القيد'] || '').trim();
      const date   = String(row['التاريخ'] || '').trim();
      const desc   = String(row['الوصف'] || '').trim();
      const acct   = String(row['رقم الحساب'] || '').trim();
      const debit  = parseFloat(row['مدين (د.ك)'] || row['مدين'] || 0);
      const credit = parseFloat(row['دائن (د.ك)'] || row['دائن'] || 0);
      if (!jeId || !date || !acct) return;
      if (!groups[jeId]) groups[jeId] = { id: jeId, date, description: desc, lines: [], reference: String(row['مرجع'] || ''), notes: String(row['ملاحظات'] || '') };
      groups[jeId].lines.push({ accountCode: acct, debit, credit });
    });

    const errors = [];
    const created = [];

    Object.values(groups).forEach(je => {
      const totalDebit  = je.lines.reduce((s, l) => s + l.debit, 0);
      const totalCredit = je.lines.reduce((s, l) => s + l.credit, 0);
      if (Math.abs(totalDebit - totalCredit) > 0.005) {
        errors.push(`قيد ${je.id}: غير متوازن (مدين ${totalDebit.toFixed(3)} ≠ دائن ${totalCredit.toFixed(3)})`);
        return;
      }
      const entry = { ...je, id: `JE-IMP-${je.id}-${Date.now()}`, source: 'import-bulk-journal', createdAt: new Date().toISOString() };
      const exists = db.journalEntries.findIndex(e => e.reference === je.id);
      if (exists < 0) db.journalEntries.push(entry);
      created.push(je.id);
    });

    saveDB(db);
    res.json({ success: true, created: created.length, total: Object.keys(groups).length, errors });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── IMPORT: أرصدة المرضى الافتتاحية ─────────────────────────────────────
app.post('/api/import/patient-opening', requireAuth, upload.single('file'), (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.removeSync(req.file.path);

    const db = loadDB();
    if (!db.patientAR) db.patientAR = [];
    if (!db.journalEntries) db.journalEntries = [];
    const settings = db.accountingSettings || {};
    const errors = [];
    const created = [];
    let total = 0;
    const jeLines = [];

    rows.forEach((row, i) => {
      const name   = String(row['اسم المريض'] || '').trim();
      const amount = parseFloat(row['المبلغ المستحق (د.ك)'] || row['المبلغ'] || 0);
      const date   = String(row['التاريخ الافتتاحي'] || new Date().toISOString().split('T')[0]).trim();
      if (!name || !amount) { errors.push(`سطر ${i+2}: اسم أو مبلغ ناقص`); return; }

      const id = `PAT-AR-${Date.now()}-${i}`;
      db.patientAR.push({
        id, name,
        fileNo:     String(row['رقم الملف'] || ''),
        date, amount,
        insurance:  String(row['نوع التأمين'] || 'نقدي'),
        insCompany: String(row['شركة التأمين'] || ''),
        notes:      String(row['ملاحظات'] || ''),
        isOpening:  true,
        createdAt:  new Date().toISOString()
      });

      const arAcc = settings.accReceivable || '1200';
      jeLines.push({ accountCode: arAcc, debit: amount, credit: 0 });
      total += amount;
      created.push(name);
    });

    if (jeLines.length > 0) {
      const equityAcc = settings.accRetained || '3100';
      jeLines.push({ accountCode: equityAcc, debit: 0, credit: parseFloat(total.toFixed(3)) });
      db.journalEntries.push({
        id: `JE-PAT-OPEN-${Date.now()}`,
        date: new Date().toISOString().split('T')[0],
        description: `أرصدة افتتاحية — ذمم مرضى (${created.length} مريض)`,
        lines: jeLines,
        source: 'import-patient-opening',
        createdAt: new Date().toISOString()
      });
    }

    saveDB(db);
    res.json({ success: true, created: created.length, totalAmount: parseFloat(total.toFixed(3)), errors });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ═══════════════════════════════════════════════════════════════
//  AI AGENT  |  AI CFO  |  AI BANK RECONCILIATION
// ═══════════════════════════════════════════════════════════════
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse  = require('pdf-parse');
const multerPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });

function buildFinancialSnapshot(db) {
  const now       = new Date();
  const thisMonth = now.toISOString().substring(0,7);
  const lastMonth = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString().substring(0,7);
  const expenses  = db.expenses   || [];
  const coa       = db.chartOfAccounts || [];
  const entries   = db.journalEntries || [];

  // Revenue from journal entries (credit side of accounts starting with '4')
  const isRevAcc = (accountId) => {
    const acc = coa.find(a => a.id === accountId || a.code === accountId);
    return acc ? acc.code.startsWith('4') : (String(accountId).startsWith('4'));
  };
  const isExpAcc = (accountId) => {
    const acc = coa.find(a => a.id === accountId || a.code === accountId);
    return acc ? acc.code.startsWith('5') : (String(accountId).startsWith('5'));
  };

  const rev = m => entries
    .filter(e => e.date && e.date.startsWith(m))
    .reduce((s, e) => s + (e.lines||[]).filter(l => isRevAcc(l.accountId) && (l.credit||0) > 0)
      .reduce((ss, l) => ss + (l.credit||0), 0), 0);

  const expFromJournals = m => entries
    .filter(e => e.date && e.date.startsWith(m))
    .reduce((s, e) => s + (e.lines||[]).filter(l => isExpAcc(l.accountId) && (l.debit||0) > 0)
      .reduce((ss, l) => ss + (l.debit||0), 0), 0);

  const exp = m => {
    const fromExpenses = expenses.filter(e=>e.date&&e.date.startsWith(m)).reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
    const fromJournals = expFromJournals(m);
    // Use whichever source has data; prefer journals if both exist to avoid double-count
    return fromJournals > 0 ? fromJournals : fromExpenses;
  };

  const tmRev = rev(thisMonth), lmRev = rev(lastMonth);
  const tmExp = exp(thisMonth), lmExp = exp(lastMonth);
  const tmNet = tmRev - tmExp, lmNet = lmRev - lmExp;

  const dayOfMonth  = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const projRev     = dayOfMonth > 0 ? (tmRev / dayOfMonth) * daysInMonth : 0;
  const projProfit  = projRev - tmExp;

  const expByCategory = {};
  // Build expense-by-category from journal entries (debit side of expense accounts)
  entries.filter(e=>e.date&&e.date.startsWith(thisMonth)).forEach(entry => {
    (entry.lines||[]).filter(l => isExpAcc(l.accountId) && (l.debit||0) > 0).forEach(l => {
      const acc = coa.find(a => a.id === l.accountId);
      const cat = acc?.name || l.accountName || 'أخرى';
      expByCategory[cat] = (expByCategory[cat]||0) + (l.debit||0);
    });
  });
  // Fallback to raw expenses if no journal entries for this month
  if (!Object.keys(expByCategory).length) {
    expenses.filter(e=>e.date&&e.date.startsWith(thisMonth)).forEach(e => {
      const cat = e.category || 'أخرى';
      expByCategory[cat] = (expByCategory[cat]||0) + (parseFloat(e.amount)||0);
    });
  }

  const drRevMap = {};
  const daily = db.dailyData || [];
  daily.forEach(d => { if(d.doctor){ drRevMap[d.doctor]=(drRevMap[d.doctor]||0)+(parseFloat(d.total)||0); } });

  const avgDailyExp = dayOfMonth > 0 ? tmExp / dayOfMonth : 0;

  return {
    thisMonth, lastMonth,
    revenue:  { thisMonth: tmRev, lastMonth: lmRev, change: lmRev>0?((tmRev-lmRev)/lmRev*100):0, projected: projRev },
    expenses: { thisMonth: tmExp, lastMonth: lmExp, change: lmExp>0?((tmExp-lmExp)/lmExp*100):0, byCategory: expByCategory },
    profit:   { thisMonth: tmNet, lastMonth: lmNet, projected: projProfit },
    doctors:  drRevMap,
    avgDailyExpense:    avgDailyExp,
    pendingInsurance:   (db.insuranceClaims||[]).filter(c=>c.status==='pending').reduce((s,c)=>s+(parseFloat(c.amount)||0),0),
    lowStock:           (db.invItems||[]).filter(i=>(parseFloat(i.quantity||i.qty)||0) <= (parseFloat(i.minQuantity||i.minQty)||0)).length,
    totalJournalEntries:(db.journalEntries||[]).length,
    daysInMonth, dayOfMonth
  };
}

// ─── 1. AI ACCOUNTANT AGENT ────────────────────────────────────
// ─── AI MEMORY helpers ─────────────────────────────────────────
function getRelevantMemories(db, command) {
  const mems = db.aiMemory || [];
  if (!mems.length) return [];
  const words = command.toLowerCase().split(/\s+/);
  return mems
    .filter(m => {
      const triggers = (m.trigger||'').toLowerCase().split(',').map(t=>t.trim());
      return triggers.some(t => t && words.some(w => w.includes(t) || t.includes(w)));
    })
    .sort((a,b) => (b.count||0)-(a.count||0))
    .slice(0, 8);
}

function buildMemoryBlock(memories) {
  if (!memories.length) return '';
  return '\n\nذاكرة التعلم (قرارات المحاسب السابقة — اتبعها دائماً):\n' +
    memories.map(m => `• "${m.trigger}" → ${m.field==='category'?'فئة: '+m.to : m.field+': '+m.to} (استُخدم ${m.count} مرة)`).join('\n');
}

// ─── AI AGENT core (shared between preview & execute) ──────────
async function callAgentAI(command, db) {
  const snap = buildFinancialSnapshot(db);
  const coa  = (db.chartOfAccounts||[]).filter(a=>a.status!=='inactive')
                 .map(a=>`${a.code} — ${a.name} (${a.type})`).join('\n');
  const today = new Date().toISOString().split('T')[0];
  const memories = getRelevantMemories(db, command);
  const memBlock = buildMemoryBlock(memories);

  const systemPrompt = `أنت وكيل محاسبي ذكي لعيادة أسنان بوبيان الكويت. العملة: KWD (د.ك).
حلل أمر المستخدم وخطط لتنفيذه.

شجرة الحسابات المتاحة:
${coa.substring(0,2000)}

البيانات الحالية (${snap.thisMonth}):
- الإيرادات: ${snap.revenue.thisMonth.toFixed(3)} د.ك
- المصاريف: ${snap.expenses.thisMonth.toFixed(3)} د.ك
- صافي الربح: ${snap.profit.thisMonth.toFixed(3)} د.ك${memBlock}

أعد فقط JSON (لا نص خارجه):
{
  "understanding": "فهمت الأمر: ...",
  "actions": [
    {
      "type": "add_expense",
      "data": { "id": "exp-AGT-TS", "date": "${today}", "amount": 0, "category": "...", "description": "...", "vendor": "...", "paymentMethod": "نقد" }
    },
    {
      "type": "add_journal",
      "data": {
        "id": "JE-AGT-TS", "date": "${today}", "description": "...", "reference": "AGT-TS",
        "lines": [ { "accountCode": "...", "accountName": "...", "debit": 0, "credit": 0 } ]
      }
    }
  ],
  "summary": "سأقوم بـ: ...",
  "details": ["تفصيل 1", "تفصيل 2"]
}
استبدل TS برقم timestamp. القيود يجب أن تكون متوازنة (debit = credit).`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 2048,
    system: systemPrompt, messages: [{ role:'user', content: command }]
  });
  const raw = msg.content[0].text.trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('لم يتمكن الوكيل من فهم الأمر');
  return JSON.parse(m[0]);
}

function executePlan(plan, db) {
  const ts = Date.now();
  const results = [];
  for (const action of (plan.actions||[])) {
    const d = action.data || {};
    const fixId = id => (id||'').toString().replace('TS', ts);
    if (action.type === 'add_expense') {
      const entry = Object.assign({}, d, { id: fixId(d.id)||('exp-AGT-'+ts), createdBy:'AI-Agent' });
      db.expenses = db.expenses || [];
      db.expenses.push(entry);
      results.push({ action:'add_expense', label:'مصروف', description:d.description, amount:d.amount, category:d.category, vendor:d.vendor });
    }
    if (action.type === 'add_journal') {
      const je = Object.assign({}, d, { id: fixId(d.id)||('JE-AGT-'+ts), source:'AI-Agent', createdAt: new Date().toISOString() });
      if (je.lines) je.lines = je.lines.map(l=>Object.assign({},l,{debit:parseFloat(l.debit)||0,credit:parseFloat(l.credit)||0}));
      db.journalEntries = db.journalEntries || [];
      db.journalEntries.push(je);
      results.push({ action:'add_journal', label:'قيد محاسبي', description:d.description, lines:d.lines });
    }
    if (action.type === 'add_daily') {
      const entry = Object.assign({}, d, { id: d.id||('DAY-AGT-'+ts) });
      db.dailyData = db.dailyData || [];
      db.dailyData.push(entry);
      results.push({ action:'add_daily', label:'إيراد يومي', amount:d.total });
    }
    if (action.type === 'update_vendor') {
      const v = (db.vendors||[]).find(x=>x.name===d.name||x.id===d.id);
      if (v) { Object.assign(v,d); results.push({ action:'update_vendor', label:'مورد', name:d.name }); }
    }
  }
  return results;
}

// ─── 1a. AGENT PREVIEW (no DB write) ──────────────────────────
app.post('/api/ai/agent/preview', requireAuth, rateLimit(20), async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  try {
    const db   = loadDB();
    const plan = await callAgentAI(command, db);
    res.json({ success: true, plan, command });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── 1b. AGENT EXECUTE (approved plan) ────────────────────────
app.post('/api/ai/agent/execute', requireAuth, rateLimit(20), async (req, res) => {
  const { plan, command, corrections } = req.body;
  if (!plan || !plan.actions) return res.status(400).json({ error: 'plan required' });
  try {
    const db = loadDB();
    // Apply any user corrections to the plan before executing
    if (corrections && corrections.length) {
      corrections.forEach(c => {
        plan.actions.forEach(a => {
          if (a.data && c.field in a.data) a.data[c.field] = c.newValue;
        });
      });
    }
    const results = executePlan(plan, db);
    saveDB(db);
    // Auto-learn: if corrections were made, store them as memories
    if (corrections && corrections.length && command) {
      db.aiMemory = db.aiMemory || [];
      corrections.forEach(c => {
        const existing = db.aiMemory.find(m => m.trigger===c.trigger && m.field===c.field);
        if (existing) { existing.to=c.newValue; existing.count=(existing.count||0)+1; existing.lastUsed=new Date().toISOString().split('T')[0]; }
        else db.aiMemory.push({ id:'mem-'+Date.now()+'-'+Math.random().toString(36).substring(2,6), trigger:c.trigger, field:c.field, from:c.oldValue, to:c.newValue, count:1, learnedFrom:command, lastUsed:new Date().toISOString().split('T')[0], createdAt:new Date().toISOString().split('T')[0] });
      });
      saveDB(db);
    }
    res.json({ success:true, summary:plan.summary, details:plan.details||[], results, actionsCount:results.length });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

// ─── 1c. AGENT (legacy — direct execute, no approval) ─────────
app.post('/api/ai/agent', requireAuth, rateLimit(20), async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });
  try {
    const db      = loadDB();
    const plan    = await callAgentAI(command, db);
    const results = executePlan(plan, db);
    saveDB(db);
    res.json({ success:true, understanding:plan.understanding, summary:plan.summary, details:plan.details||[], results, actionsCount:results.length });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

// ─── AI MEMORY CRUD ────────────────────────────────────────────
app.get('/api/ai/memory', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.aiMemory || []);
});

app.post('/api/ai/memory', requireAuth, (req, res) => {
  const { trigger, field, from, to } = req.body;
  if (!trigger || !field || !to) return res.status(400).json({ error: 'trigger, field, to required' });
  const db = loadDB();
  db.aiMemory = db.aiMemory || [];
  const existing = db.aiMemory.find(m => m.trigger===trigger && m.field===field);
  if (existing) {
    existing.to = to; existing.count = (existing.count||0)+1;
    existing.lastUsed = new Date().toISOString().split('T')[0];
    saveDB(db); return res.json({ success:true, updated:true, memory:existing });
  }
  const mem = { id:'mem-'+Date.now(), trigger, field, from:from||'', to, count:1, createdAt:new Date().toISOString().split('T')[0], lastUsed:new Date().toISOString().split('T')[0] };
  db.aiMemory.push(mem);
  saveDB(db);
  res.json({ success:true, updated:false, memory:mem });
});

app.delete('/api/ai/memory/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const before = (db.aiMemory||[]).length;
  db.aiMemory = (db.aiMemory||[]).filter(m => m.id !== req.params.id);
  if (db.aiMemory.length === before) return res.status(404).json({ error: 'not found' });
  saveDB(db);
  res.json({ success:true });
});

// Record a manual correction (called when user edits AI output)
app.post('/api/ai/memory/correct', requireAuth, (req, res) => {
  const { trigger, field, oldValue, newValue, command } = req.body;
  if (!trigger || !field || !newValue) return res.status(400).json({ error: 'trigger, field, newValue required' });
  const db = loadDB();
  db.aiMemory = db.aiMemory || [];
  const existing = db.aiMemory.find(m => m.trigger===trigger && m.field===field);
  if (existing) {
    existing.to = newValue; existing.from = oldValue||existing.from;
    existing.count = (existing.count||0)+1;
    existing.lastUsed = new Date().toISOString().split('T')[0];
  } else {
    db.aiMemory.push({ id:'mem-'+Date.now(), trigger, field, from:oldValue||'', to:newValue, count:1, learnedFrom:command||'', createdAt:new Date().toISOString().split('T')[0], lastUsed:new Date().toISOString().split('T')[0] });
  }
  saveDB(db);
  res.json({ success:true, memoriesCount:(db.aiMemory||[]).length });
});

// ─── 2. AI CFO ─────────────────────────────────────────────────
app.post('/api/ai/cfo', requireAuth, rateLimit(10), async (req, res) => {
  const db   = loadDB();
  const snap = buildFinancialSnapshot(db);
  const daily    = db.dailyData || [];
  const expenses = db.expenses  || [];
  const now      = new Date();

  // Last 6 months trend
  const months = [];
  for (let i=5; i>=0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const m = d.toISOString().substring(0,7);
    const r = daily.filter(x=>x.date&&x.date.startsWith(m)).reduce((s,x)=>s+(parseFloat(x.total)||0),0);
    const e = expenses.filter(x=>x.date&&x.date.startsWith(m)).reduce((s,x)=>s+(parseFloat(x.amount)||0),0);
    months.push({ month: m, revenue: r, expenses: e, profit: r-e });
  }

  const avgDailyRev  = snap.dayOfMonth>0 ? snap.revenue.thisMonth / snap.dayOfMonth : 0;
  const dailyNet     = avgDailyRev - snap.avgDailyExpense;
  const liquidityDays = dailyNet < 0 ? Math.round(snap.revenue.thisMonth / Math.abs(dailyNet)) : 999;

  const salaryExp = expenses.filter(e=>e.date&&e.date.startsWith(snap.thisMonth)&&(e.category||'').includes('راتب'))
    .reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  const salaryPct = snap.revenue.thisMonth > 0 ? (salaryExp/snap.revenue.thisMonth*100) : 0;

  const topExp = Object.entries(snap.expenses.byCategory).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const alerts = [];
  if (snap.revenue.change < -10) alerts.push({ level:'danger', msg: 'الإيرادات انخفضت '+Math.abs(snap.revenue.change).toFixed(1)+'% عن الشهر الماضي' });
  if (salaryPct > 35) alerts.push({ level:'warning', msg: 'الرواتب '+salaryPct.toFixed(1)+'% من الإيرادات — أعلى من المعدل الصحي (35%)' });
  if (liquidityDays < 45 && liquidityDays < 999) alerts.push({ level:'danger', msg: 'مشكلة سيولة محتملة خلال '+liquidityDays+' يوم' });
  if (snap.pendingInsurance > 1000) alerts.push({ level:'warning', msg: snap.pendingInsurance.toFixed(3)+' د.ك تأمين معلق يحتاج متابعة' });
  if (snap.lowStock > 0) alerts.push({ level:'info', msg: snap.lowStock+' صنف وصل للحد الأدنى في المخزون' });
  if (snap.profit.projected > snap.profit.lastMonth) alerts.push({ level:'success', msg: 'توقع: ربح الشهر الحالي سيتجاوز الشهر الماضي بـ '+(snap.profit.projected - snap.profit.lastMonth).toFixed(3)+' د.ك' });

  const metrics = { months, snap, liquidityDays, salaryPct, salaryExp, topExp, alerts,
    projectedRevenue: snap.revenue.projected, projectedProfit: snap.profit.projected };

  if (!process.env.ANTHROPIC_API_KEY) return res.json({ success: true, metrics, narrative: null });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: 'أنت CFO ذكي لعيادة أسنان. اكتب تحليلاً مالياً مختصراً ودقيقاً باللغة العربية (5-7 جمل). ركز على: أبرز رقم، أكبر خطر، أهم توصية. لا تعيد الأرقام فقط — حللها.',
      messages: [{ role:'user', content: JSON.stringify(metrics) }]
    });
    res.json({ success: true, metrics, narrative: msg.content[0].text });
  } catch(e) {
    res.json({ success: true, metrics, narrative: null, aiError: e.message });
  }
});

// ─── 3. AI BANK RECONCILIATION ─────────────────────────────────
app.post('/api/ai/bank-recon', requireAuth, multerPdf.single('pdf'), rateLimit(5), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY غير مضبوط' });

  let bankText = req.body.bankText || '';

  if (req.file) {
    try {
      const parsed = await pdfParse(req.file.buffer);
      bankText = parsed.text;
    } catch(e) {
      return res.status(400).json({ error: 'فشل قراءة PDF: ' + e.message });
    }
  }

  if (!bankText.trim()) return res.status(400).json({ error: 'لم يتم إرسال بيانات البنك' });

  const db = loadDB();
  const coa = (db.chartOfAccounts||[]).map(a=>a.code+'|'+a.name+'|'+a.type).join('\n');
  const recentJE = (db.journalEntries||[]).slice(-50).map(je =>
    je.date+'|'+je.description+'|'+((je.lines||[]).reduce((s,l)=>s+(l.debit||0),0)).toFixed(3)
  ).join('\n');

  const systemPrompt = `أنت محاسب متخصص في مطابقة البنك. العملة: KWD.

شجرة الحسابات:
${coa.substring(0,1500)}

القيود المحاسبية الأخيرة:
${recentJE.substring(0,1000)}

مهمتك:
1. استخرج كل عملية من كشف البنك (تاريخ، وصف، مبلغ، نوع: دائن/مدين)
2. طابق كل عملية مع القيود الموجودة إن أمكن
3. للعمليات غير المطابقة أنشئ قيوداً مقترحة

أعد JSON فقط:
{
  "bankTransactions": [
    { "date":"YYYY-MM-DD", "description":"...", "amount":0, "type":"debit|credit", "matched":true, "matchedJE":"id أو null" }
  ],
  "unmatched": [
    { "date":"YYYY-MM-DD", "description":"...", "amount":0, "type":"debit|credit" }
  ],
  "suggestedJournalEntries": [
    { "date":"YYYY-MM-DD", "description":"...", "lines":[{"accountCode":"...","accountName":"...","debit":0,"credit":0}] }
  ],
  "summary": {
    "totalTransactions":0, "matched":0, "unmatched":0,
    "totalDebits":0, "totalCredits":0, "reconStatus":"متوافق|فروقات موجودة"
  }
}`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role:'user', content: 'كشف الحساب البنكي:\n\n'+bankText.substring(0,6000) }]
    });

    const raw = msg.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ success: false, error: 'فشل تحليل كشف البنك', raw: raw.substring(0,200) });

    const result = JSON.parse(jsonMatch[0]);
    res.json(Object.assign({ success: true }, result));
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

