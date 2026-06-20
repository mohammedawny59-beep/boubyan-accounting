const mongoose = require('mongoose');

// One document per top-level app data key (doctors, expenses, roles, etc.)
const entityChunkSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true, index: true },
  data:      { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false, minimize: false });

module.exports = mongoose.model('EntityChunk', entityChunkSchema);
