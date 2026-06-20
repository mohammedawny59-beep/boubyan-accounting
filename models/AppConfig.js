const mongoose = require('mongoose');

const appConfigSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true, default: 'config' },
  data:      { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false, minimize: false });

module.exports = mongoose.model('AppConfig', appConfigSchema);
