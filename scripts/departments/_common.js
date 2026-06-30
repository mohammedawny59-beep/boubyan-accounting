'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function readFile(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; }
}
function fileExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}
function countLines(src) {
  return src ? src.split('\n').length : 0;
}
function countPattern(src, re) {
  return (src.match(re) || []).length;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function thisMonth() {
  return new Date().toISOString().slice(0, 7);
}

module.exports = { ROOT, readFile, fileExists, countLines, countPattern, today, thisMonth };
