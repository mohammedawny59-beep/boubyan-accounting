'use strict';
/**
 * سجل الوكلاء المشترك — single source of truth for agent metadata.
 * يستخدمه المدير الذكي (Orchestrator) ليعرف من يشغّل وكيف يصنّفهم.
 */
const AGENTS = {
  'audit-quality':     { script: 'scripts/departments/audit-quality.js',    nameAr: 'التدقيق والجودة',   icon: '🔍', category: 'internal', domain: 'code-quality' },
  'security-scan':     { script: 'scripts/departments/security-scan.js',    nameAr: 'الأمن السيبراني',   icon: '🔒', category: 'internal', domain: 'security' },
  'operations':        { script: 'scripts/departments/operations.js',       nameAr: 'العمليات',          icon: '⚙️', category: 'internal', domain: 'operations' },
  'it-health':         { script: 'scripts/departments/it-health.js',        nameAr: 'صحة النظام',        icon: '💻', category: 'internal', domain: 'infrastructure' },
  'hr-reminders':      { script: 'scripts/departments/hr-reminders.js',     nameAr: 'الموارد البشرية',   icon: '👥', category: 'internal', domain: 'operations' },
  'design-audit':      { script: 'scripts/departments/design-audit.js',     nameAr: 'التصميم وUX',       icon: '🎨', category: 'internal', domain: 'design' },
  'news-reader':       { script: 'scripts/departments/news-reader.js',      nameAr: 'متابعة الأخبار',    icon: '📰', category: 'internal', domain: 'research' },
  'ai-optimizer':      { script: 'scripts/departments/ai-optimizer.js',     nameAr: 'تحسين الذكاء',      icon: '🤖', category: 'internal', domain: 'ai' },
  'rd-suggestions':    { script: 'scripts/departments/rd-suggestions.js',   nameAr: 'البحث والتطوير',    icon: '🔬', category: 'internal', domain: 'research' },
  'compliance':        { script: 'scripts/compliance-check.js',             nameAr: 'الامتثال القانوني', icon: '✅', category: 'internal', domain: 'compliance' },
  'system-tester':     { script: 'scripts/departments/system-tester.js',    nameAr: 'المُجرِّب',         icon: '🧪', category: 'internal', domain: 'accounting' },
  'market-intel':      { script: 'scripts/departments/market-intel.js',     nameAr: 'أبحاث المنافسين',   icon: '🕵️', category: 'saas', domain: 'research' },
  'design-studio':     { script: 'scripts/departments/design-studio.js',    nameAr: 'التصميم الإنتاجي',  icon: '🪄', category: 'saas', domain: 'design' },
  'global-compliance': { script: 'scripts/departments/global-compliance.js',nameAr: 'الامتثال العالمي',  icon: '⚖️', category: 'saas', domain: 'compliance' },
  'meta-eval':         { script: 'scripts/departments/meta-eval.js',        nameAr: 'التحقق الذاتي',     icon: '🔎', category: 'saas', domain: 'ai' },
  'marketing-growth':  { script: 'scripts/departments/marketing-growth.js', nameAr: 'التسويق والنمو',    icon: '📣', category: 'saas', domain: 'growth' },
  'deploy-website':    { script: 'scripts/departments/deploy-website.js',   nameAr: 'النشر والموقع',     icon: '🚀', category: 'saas', domain: 'infrastructure' },
};

// المجالات بالعربي (لدرجة الصحة حسب المجال)
const DOMAIN_AR = {
  'security': 'الأمن', 'code-quality': 'جودة الكود', 'infrastructure': 'البنية التحتية',
  'accounting': 'سلامة المحاسبة', 'ai': 'الذكاء الاصطناعي', 'design': 'التصميم',
  'operations': 'العمليات', 'compliance': 'الامتثال', 'research': 'الأبحاث', 'growth': 'النمو',
};

module.exports = { AGENTS, DOMAIN_AR };
