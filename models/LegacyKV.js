const mongoose = require('mongoose');

// Read-only source for one-time migration from the old monolithic blob store.
const legacyKVSchema = new mongoose.Schema({
  key:  { type: String, unique: true, index: true },
  data: { type: mongoose.Schema.Types.Mixed },
}, { minimize: false, versionKey: false });

module.exports = mongoose.model('LegacyKV', legacyKVSchema, 'kvs');
