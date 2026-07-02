const mongoose = require('mongoose');

const appConfigSchema = new mongoose.Schema({
  tenantId:  { type: String, required: true, default: 'default', index: true },
  key:       { type: String, required: true, default: 'config' },
  data:      { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false, minimize: false });

appConfigSchema.index({ tenantId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('AppConfig', appConfigSchema);
