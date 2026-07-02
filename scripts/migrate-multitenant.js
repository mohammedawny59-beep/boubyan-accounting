#!/usr/bin/env node
'use strict';
/**
 * Migration: Single-tenant → Multi-tenant
 *
 * يضيف tenantId='default' لكل documents الموجودة في:
 *   - EntityChunk
 *   - User
 *   - AppConfig
 *
 * يُنشئ Tenant + Subscription للعيادة الحالية (default).
 *
 * آمن للتشغيل عدة مرات (idempotent).
 *
 * تشغيل: node scripts/migrate-multitenant.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const EntityChunk  = require('../models/EntityChunk');
const User         = require('../models/User');
const AppConfig    = require('../models/AppConfig');
const Tenant       = require('../models/Tenant');
const Subscription = require('../models/Subscription');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/boubyan_accounting';

async function run() {
  console.log('🔄 بدء migration → multi-tenant...\n');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('✅ MongoDB متصل\n');

  // ── 1. EntityChunk ──────────────────────────────────────────────────────────
  const chunkCount = await EntityChunk.countDocuments({ tenantId: { $exists: false } });
  if (chunkCount > 0) {
    const r1 = await EntityChunk.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: 'default' } },
    );
    console.log(`📦 EntityChunk: ${r1.modifiedCount} documents → tenantId='default'`);
  } else {
    console.log('📦 EntityChunk: لا تحتاج migration');
  }

  // ── 2. Users ─────────────────────────────────────────────────────────────────
  const userCount = await User.countDocuments({ tenantId: { $exists: false } });
  if (userCount > 0) {
    const r2 = await User.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: 'default' } },
    );
    console.log(`👤 User: ${r2.modifiedCount} documents → tenantId='default'`);
  } else {
    console.log('👤 User: لا تحتاج migration');
  }

  // ── 3. AppConfig ──────────────────────────────────────────────────────────────
  const cfgCount = await AppConfig.countDocuments({ tenantId: { $exists: false } });
  if (cfgCount > 0) {
    const r3 = await AppConfig.updateMany(
      { tenantId: { $exists: false } },
      { $set: { tenantId: 'default' } },
    );
    console.log(`⚙️  AppConfig: ${r3.modifiedCount} documents → tenantId='default'`);
  } else {
    console.log('⚙️  AppConfig: لا تحتاج migration');
  }

  // ── 4. Create default Tenant (Boubyan Clinic) ─────────────────────────────────
  const existingTenant = await Tenant.findOne({ tenantId: 'default' });
  if (!existingTenant) {
    await Tenant.create({
      tenantId: 'default',
      name:     process.env.CLINIC_NAME || 'بوبيان لطب الأسنان',
      slug:     'default',
      email:    process.env.ADMIN_DEFAULT_EMAIL || 'admin@boubyan.com',
      plan:     'enterprise',
      status:   'active',
    });
    console.log('🏢 Tenant "default" تم إنشاؤه (العيادة الرئيسية)');
  } else {
    console.log('🏢 Tenant "default" موجود مسبقاً');
  }

  // ── 5. Create default Subscription ───────────────────────────────────────────
  const existingSub = await Subscription.findOne({ tenantId: 'default' });
  if (!existingSub) {
    await Subscription.create({
      tenantId: 'default',
      plan:     'enterprise',
      status:   'active',
      seats:    999,
    });
    console.log('💳 Subscription "default" تم إنشاؤه (enterprise)');
  } else {
    console.log('💳 Subscription "default" موجود مسبقاً');
  }

  console.log('\n✅ Migration اكتمل بنجاح!');
  console.log('⚠️  تذكر: أضف "tenantId" للـ JWT عند تسجيل الدخول (راجع server.js requireAuth)');
  await mongoose.connection.close();
}

run().catch(e => {
  console.error('❌ Migration فشل:', e.message);
  process.exit(1);
});
