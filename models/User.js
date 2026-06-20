const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  id:           { type: String, required: true, unique: true },
  username:     { type: String, required: true, unique: true },
  email:        { type: String, default: '' },
  passwordHash: { type: String, required: true, select: true },
  role:         { type: String, required: true, default: 'viewer', index: true },
  fullName:     { type: String, default: '' },
  active:       { type: Boolean, default: true },
  createdAt:    { type: String, default: () => new Date().toISOString() },
  lastLogin:    { type: String, default: null },
}, { versionKey: false, minimize: false });

module.exports = mongoose.model('User', userSchema);
