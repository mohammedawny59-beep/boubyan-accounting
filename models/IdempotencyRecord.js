const mongoose = require('mongoose');

// P0.12 — dedicated collection (NOT stored via the generic EntityChunk
// array-per-key model) specifically so Mongo can provide a REAL uniqueness
// guarantee for concurrent claim attempts. EntityChunk stores one whole
// array per (tenantId,key) and offers no way to reject a second insert
// into that array atomically — two concurrent requests could both read the
// same cached array, both fail to find an existing record, and both push a
// new one ("find then insert", exactly what this milestone's Part E Step 16
// says not to rely on). A real unique index lets MongoDB itself reject the
// second concurrent insert with a duplicate-key error (E11000), which the
// claim logic (lib/idempotency.js) catches and treats as "someone else
// claimed this key first" — this is what actually closes the race, not
// just a same-process in-memory check.
const idempotencyRecordSchema = new mongoose.Schema({
  tenantId:        { type: String, required: true, default: 'default', index: true },
  operationScope:  { type: String, required: true },
  key:             { type: String, required: true },
  fingerprint:     { type: String, required: true },
  status:          { type: String, enum: ['PROCESSING', 'COMPLETED', 'FAILED'], default: 'PROCESSING' },
  resultReference: { type: mongoose.Schema.Types.Mixed, default: null },
  sourceId:        { type: String, default: null },
  journalId:       { type: String, default: null },
  createdAt:       { type: Date, default: Date.now },
  completedAt:     { type: Date, default: null },
}, { versionKey: false, minimize: false });

// The actual concurrency guarantee — MongoDB rejects a second concurrent
// insert for the same (tenant, operation, key) with E11000, atomically.
idempotencyRecordSchema.index({ tenantId: 1, operationScope: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
