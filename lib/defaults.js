'use strict';
// البيانات الافتراضية للنظام — أول وحدة مفكوكة من server.js (CLAUDE.md بند 6)
// تُستخدم في: server.js + بذر قاعدة كل مستأجر جديد (onboarding تلقائي)

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
  { id:'1125', code:'1125', name:'حسابي — مدفوعات إلكترونية',        type:'asset', parent:'1000', balance:0 },
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
  { id:'5760', code:'5760', name:'خصم التأمين — حسم شركات التأمين', type:'expense', parent:'5700', balance:0 },
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

module.exports = { ALL_TABS, ALL_ACTIONS, DEFAULT_COA, DEFAULT_ROLES };
