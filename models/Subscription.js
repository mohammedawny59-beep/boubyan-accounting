'use strict';
const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  tenantId:             { type: String, required: true, unique: true, index: true },
  plan:                 { type: String, enum: ['trial', 'starter', 'pro', 'enterprise'], default: 'trial' },
  status:               { type: String, enum: ['trialing', 'active', 'past_due', 'cancelled', 'paused'], default: 'trialing' },
  stripeCustomerId:     { type: String, default: null },
  stripeSubscriptionId: { type: String, default: null },
  stripePriceId:        { type: String, default: null },
  currentPeriodStart:   { type: Date, default: null },
  currentPeriodEnd:     { type: Date, default: null },
  trialEnd:             { type: Date, default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) },
  cancelAtPeriodEnd:    { type: Boolean, default: false },
  seats:                { type: Number, default: 3 },
  createdAt:            { type: Date, default: Date.now },
  updatedAt:            { type: Date, default: Date.now },
}, { versionKey: false });

subscriptionSchema.pre('save', function () { this.updatedAt = new Date(); });

// Plan limits
subscriptionSchema.statics.LIMITS = {
  trial:      { seats: 2,   storage: 100,   transactions: 500  },
  starter:    { seats: 5,   storage: 1000,  transactions: 5000 },
  pro:        { seats: 20,  storage: 10000, transactions: 50000 },
  enterprise: { seats: 999, storage: 99999, transactions: 999999 },
};

module.exports = mongoose.model('Subscription', subscriptionSchema);
