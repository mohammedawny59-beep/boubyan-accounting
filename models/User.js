const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  tenantId:     { type: String, required: true, default: 'default', index: true },
  id:           { type: String, required: true },
  username:     { type: String, required: true },
  email:        { type: String, default: '' },
  passwordHash: { type: String, required: true, select: true },
  role:         { type: String, required: true, default: 'viewer', index: true },
  fullName:     { type: String, default: '' },
  active:       { type: Boolean, default: true },
  createdAt:    { type: String, default: () => new Date().toISOString() },
  lastLogin:    { type: String, default: null },
}, { versionKey: false, minimize: false });

// Unique per tenant: id and username scoped to tenant
userSchema.index({ tenantId: 1, id: 1 },       { unique: true });
userSchema.index({ tenantId: 1, username: 1 },  { unique: true });

module.exports = mongoose.model('User', userSchema);
