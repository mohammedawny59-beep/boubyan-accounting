#!/usr/bin/env node
'use strict';
/**
 * Global Compliance Department — قسم الامتثال العالمي
 * CLAUDE.md §2 — بديل compliance-check.js الكويتي للنسخة العالمية
 *
 * يفحص امتثال المنتج للمعايير الدولية القابلة للتطبيق على أي عميل:
 *   IFRS · GDPR · SOC 2 · ISO 27001 · PCI DSS (payments) · WCAG 2.1
 */
const { DeptAgent } = require('./_agent');
const { APPROVAL }  = require('./_common');
const { readFile, countPattern, today } = require('./_common');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

async function main() {
  const agent = new DeptAgent({
    name:      'global-compliance',
    nameAr:    '⚖️ قسم الامتثال العالمي',
    mission:   'ضمان امتثال المنتج للمعايير الدولية — يُمكّن البيع لأي عميل في أي دولة',
    standards: ['IFRS 2024', 'GDPR', 'SOC 2 Type II', 'ISO 27001:2022', 'WCAG 2.1 AA', 'PCI DSS v4'],
  });

  agent.loadMemory();

  const server = readFile('server.js');
  const index  = readFile('public/index.html');
  const pkg    = JSON.parse(readFile('package.json') || '{}');

  // ── 1. IFRS Core Requirements ────────────────────────────────────────────────
  agent._log('📋 فحص IFRS...');

  const hasDoubleEntry  = server.includes('debit') && server.includes('credit');
  const hasPeriodLock   = /periodLock|period_lock|PeriodLock/i.test(server);
  const hasAuditTrail   = /auditLog|audit_log|auditTrail/i.test(server);
  const hasMultiCurrency= /currency|forex|exchange_rate/i.test(server);

  if (!hasDoubleEntry) {
    agent.finding('critical', 'IFRS', 'القيد المزدوج غير موجود أو غير موثق',
      'IFRS يشترط double-entry accounting لكل معاملة',
      'أضف validation: sum(debits) === sum(credits) في كل قيد', APPROVAL.BLOCKING);
  } else {
    agent.ok('IFRS', 'القيد المزدوج موجود');
  }

  if (!hasPeriodLock) {
    agent.finding('high', 'IFRS', 'IAS 8: Period Lock مفقود',
      'يسمح بتعديل فترات مغلقة — مخالف لـ IAS 8 ومرفوض من المراجعين',
      'أضف middleware يرفض أي قيد في فترة مقفلة', APPROVAL.BLOCKING);
  } else {
    agent.ok('IFRS', 'IAS 8 Period Lock موجود');
  }

  if (!hasAuditTrail) {
    agent.finding('high', 'IFRS', 'Audit Trail غير مكتمل',
      'IFRS + كل معايير الحوكمة تشترط: من؟ متى؟ ماذا غيّر؟',
      'سجّل كل write operation: userId + timestamp + before + after');
  } else {
    agent.ok('IFRS', 'Audit Trail موجود');
  }

  if (!hasMultiCurrency) {
    agent.finding('medium', 'IFRS', 'IAS 21: دعم العملات المتعددة مفقود',
      'المنتج العالمي يجب أن يدعم USD, EUR, GBP, KWD, AED كحد أدنى',
      'أضف حقل currency + exchange_rate لكل معاملة');
  } else {
    agent.ok('IFRS', 'IAS 21 — عملات متعددة مدعومة');
  }

  agent.metric('IFRS — Double Entry', hasDoubleEntry ? '✅' : '❌');
  agent.metric('IFRS — Period Lock', hasPeriodLock   ? '✅' : '❌');
  agent.metric('IFRS — Audit Trail', hasAuditTrail   ? '✅' : '❌');
  agent.metric('IFRS — Multi-Currency', hasMultiCurrency ? '✅' : '⚠️');

  // ── 2. GDPR (required for EU customers) ─────────────────────────────────────
  agent._log('🇪🇺 فحص GDPR...');

  const hasPrivacyPolicy = server.includes('privacy') || index.includes('privacy');
  const hasDataDeletion  = server.includes('delete') && (server.includes('user') || server.includes('account'));
  const hasConsentLog    = server.includes('consent') || server.includes('gdpr');
  const encryptsAtRest   = /encrypt|bcrypt|argon|scrypt/i.test(server);

  if (!hasPrivacyPolicy) {
    agent.finding('high', 'GDPR', 'لا سياسة خصوصية',
      'GDPR المادة 13 تشترط إعلام المستخدم بكيفية استخدام بياناته',
      'أضف صفحة /privacy-policy وربطها في الـ footer');
  } else {
    agent.ok('GDPR', 'سياسة الخصوصية موجودة');
  }

  if (!hasDataDeletion) {
    agent.finding('high', 'GDPR', 'حق المستخدم في المحو (Right to Erasure) غير مطبّق',
      'GDPR المادة 17 تشترط إمكانية حذف بيانات المستخدم كاملة',
      'أضف endpoint DELETE /api/users/:id يحذف جميع البيانات المرتبطة');
  } else {
    agent.ok('GDPR', 'Data Deletion موجود');
  }

  if (!encryptsAtRest) {
    agent.finding('high', 'GDPR', 'تشفير البيانات الحساسة غير واضح',
      'GDPR + SOC 2 يشترطان تشفير البيانات الشخصية أثناء التخزين',
      'تأكد من تشفير كلمات المرور + أي PII في قاعدة البيانات');
  } else {
    agent.ok('GDPR', 'تشفير البيانات موجود');
  }

  agent.metric('GDPR — Privacy Policy', hasPrivacyPolicy ? '✅' : '❌');
  agent.metric('GDPR — Data Deletion', hasDataDeletion   ? '✅' : '❌');
  agent.metric('GDPR — Encryption', encryptsAtRest        ? '✅' : '⚠️');

  // ── 3. SOC 2 Type II Indicators ──────────────────────────────────────────────
  agent._log('🔐 فحص SOC 2...');

  const hasRateLimit  = /rateLimit|rate.limit|express-rate/i.test(server);
  const hasLogging    = /winston|pino|morgan|console\.log/i.test(server);
  const hasJWT        = server.includes('jwt') || server.includes('jsonwebtoken');
  const hasMFA        = /mfa|2fa|totp|otp/i.test(server);
  const hasBackup     = /backup|restore|export/i.test(server);

  if (!hasRateLimit) {
    agent.finding('high', 'SOC2', 'Rate Limiting مفقود',
      'SOC 2 CC6.6 يشترط الحماية من الهجمات الآلية',
      'أضف express-rate-limit على /api/auth وكل endpoints الحساسة');
  } else {
    agent.ok('SOC2', 'Rate Limiting موجود');
  }

  if (!hasMFA) {
    agent.finding('medium', 'SOC2', 'Multi-Factor Authentication (MFA) مفقود',
      'SOC 2 + أي عميل Enterprise يطلب MFA',
      'أضف TOTP (Google Authenticator) كخيار إلزامي لحسابات الإدارة');
  } else {
    agent.ok('SOC2', 'MFA موجود');
  }

  if (!hasBackup) {
    agent.finding('medium', 'SOC2', 'لا يوجد نظام نسخ احتياطي موثّق',
      'SOC 2 A1.2 يشترط وجود backup + خطة استعادة (DR Plan)',
      'أضف تصدير بيانات JSON/CSV + توثيق خطة الاستعادة');
  } else {
    agent.ok('SOC2', 'نظام نسخ احتياطي موجود');
  }

  agent.metric('SOC 2 — Rate Limiting', hasRateLimit ? '✅' : '❌');
  agent.metric('SOC 2 — MFA', hasMFA     ? '✅' : '❌');
  agent.metric('SOC 2 — Backup/DR', hasBackup ? '✅' : '⚠️');

  // ── 4. Multi-tenancy Readiness (for SaaS) ────────────────────────────────────
  agent._log('🏢 فحص Multi-tenancy...');

  const hasTenantId    = /tenantId|tenant_id|organizationId|orgId/i.test(server);
  const hasRowLevelSec = /tenant|organization/i.test(server);
  const hasOnboarding  = /onboard|signup|register|trial/i.test(server);
  const hasSubscription= /subscription|plan|billing|stripe|payment/i.test(server);

  if (!hasTenantId) {
    agent.finding('critical', 'SaaS', 'نظام Multi-tenancy غير موجود',
      'كل عميل يجب أن يرى بياناته فقط — tenantId مفقود من النموذج',
      'أضف tenantId لكل collection في MongoDB + middleware يفلتر تلقائياً', APPROVAL.BLOCKING);
  } else {
    agent.ok('SaaS', 'Multi-tenancy موجود');
  }

  if (!hasSubscription) {
    agent.finding('high', 'SaaS', 'نظام الاشتراكات والفوترة مفقود',
      'المنتج لا يُباع بدون subscription management + payment gateway',
      'أدمج Stripe أو Paddle لإدارة الاشتراكات والمدفوعات', APPROVAL.BLOCKING);
  } else {
    agent.ok('SaaS', 'نظام الاشتراكات موجود');
  }

  if (!hasOnboarding) {
    agent.finding('medium', 'SaaS', 'تجربة Onboarding للعملاء الجدد مفقودة',
      'العميل الجديد يجب أن يصل للقيمة خلال 5 دقائق (Time-to-Value)',
      'أضف wizard إعداد حساب جديد: شركة + عملة + مستخدمين');
  } else {
    agent.ok('SaaS', 'Onboarding موجود');
  }

  agent.metric('SaaS — Multi-tenant', hasTenantId     ? '✅' : '❌');
  agent.metric('SaaS — Subscriptions', hasSubscription ? '✅' : '❌');
  agent.metric('SaaS — Onboarding', hasOnboarding      ? '✅' : '⚠️');

  agent.saveMemory();
  await agent.runAgentLoop();

  // Monthly checklist extras
  const checklist = `## 📅 قائمة المراجعة الشهرية — الامتثال العالمي

### IFRS
- [ ] تحقق من تطابق الميزانية مع معيار IAS 1
- [ ] راجع الإفصاحات المطلوبة في القوائم المالية
- [ ] تأكد من Period Lock للشهر المنتهي

### GDPR (للعملاء الأوروبيين)
- [ ] راجع طلبات حذف البيانات المعلقة
- [ ] تحقق من صحة ملف privacy-policy (تاريخ آخر تحديث)
- [ ] تأكد أن Data Processor Agreements (DPAs) محدّثة

### SOC 2 (للعملاء Enterprise)
- [ ] راجع access logs للـ 30 يوم الماضية
- [ ] تأكد من تشغيل backup وتحقق من قابلية الاستعادة
- [ ] راجع user access: أزل الحسابات غير النشطة

### SaaS Health
- [ ] راجع churn rate الشهر الماضي
- [ ] تحقق من invoice generation لكل مشترك
- [ ] راجع failed payments وحالات التجديد

> 📌 هذه القائمة آلية — راجعها مع فريقك وأغلق الـ Issue عند الإتمام`;

  const report = await agent.buildReport(checklist);
  process.stdout.write(report + '\n');
}

main().catch(e => process.stderr.write(`[global-compliance] خطأ: ${e.message}\n`));
