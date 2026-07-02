'use strict';
const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
  tenantId:    { type: String, required: true, unique: true, index: true },
  name:        { type: String, required: true },
  slug:        { type: String, required: true, unique: true, index: true },
  email:       { type: String, required: true },
  plan:        { type: String, enum: ['trial', 'starter', 'pro', 'enterprise'], default: 'trial' },
  status:      { type: String, enum: ['active', 'suspended', 'cancelled'], default: 'active' },
  trialEndsAt: { type: Date, default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) },
  timezone:    { type: String, default: 'Asia/Kuwait' },
  currency:    { type: String, default: 'KWD' },
  language:    { type: String, default: 'ar' },
  logoUrl:     { type: String, default: '' },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
}, { versionKey: false });

tenantSchema.pre('save', function () { this.updatedAt = new Date(); });

module.exports = mongoose.model('Tenant', tenantSchema);
