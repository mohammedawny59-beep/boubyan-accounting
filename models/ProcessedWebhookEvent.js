'use strict';
const mongoose = require('mongoose');

// P0.5 — Step 13/16: durable webhook-event idempotency store. Stripe retries
// delivery on anything but a 2xx response and can deliver the same event
// twice under normal operation; the same applies in principle to any future
// webhook-style provider (kept generic via `provider` rather than a
// Stripe-only collection). A durable, unique-indexed record is required —
// an in-memory Set forgets everything on every restart/redeploy and is not
// shared across multiple instances, so it does not actually provide
// idempotency in production.
const schema = new mongoose.Schema({
  provider:    { type: String, required: true },   // 'stripe' | 'telegram'
  eventId:     { type: String, required: true },    // Stripe event.id / Telegram update_id
  type:        { type: String, default: null },
  processedAt: { type: Date, default: Date.now },
}, { versionKey: false });

schema.index({ provider: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.model('ProcessedWebhookEvent', schema);
