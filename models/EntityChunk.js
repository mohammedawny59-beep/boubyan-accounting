const mongoose = require('mongoose');

// One document per (tenantId, key) — multi-tenant aware
const entityChunkSchema = new mongoose.Schema({
  tenantId:  { type: String, required: true, default: 'default', index: true },
  key:       { type: String, required: true, index: true },
  data:      { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false, minimize: false });

// Compound unique: one chunk per (tenant, key)
entityChunkSchema.index({ tenantId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('EntityChunk', entityChunkSchema);
