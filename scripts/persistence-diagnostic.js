// P0.11 (Part P) — READ-ONLY production persistence diagnostic.
//
// Reports on persistence health WITHOUT ever mutating anything and WITHOUT
// ever printing a credential:
//   - which backend this process is actually configured for (file vs Mongo),
//     reported as booleans/shape checks — MONGO_URI itself is NEVER printed,
//     only whether it's set and whether it superficially looks well-formed
//     (scheme prefix), matching the same redaction discipline as server.js's
//     own startup log (see redactMongoUri() there, added by this milestone);
//   - ENTITY_KEYS completeness against the on-disk file snapshot (Objective
//     B — no accounting entity may exist only in memory) — if a key is
//     missing from data/database.json, that name is reported, never its
//     content, since content could include patient/vendor personal data;
//   - leftover *.tmp-* files from _atomicWriteJsonSync — a file matching
//     that pattern surviving after startup indicates a previous crash
//     occurred mid-write (the atomic rename never completed);
//   - a basic journal-entry balance smoke check (every entry's lines must
//     sum debit==credit) and a locked-period bypass smoke check (any
//     journal entry dated inside a period currently marked locked) —
//     read-only signals, not fixes.
//
// This script NEVER calls loadDB()/saveDB() or connects to Mongo itself —
// only fs.readFileSync/fs.existsSync against the configured DATA_FILE, plus
// inert env var presence checks. It is safe to run against a real
// deployment's file snapshot (or point DATA_FILE at a copy of one) without
// any risk of mutating production state.
//
// Run with: node scripts/persistence-diagnostic.js
// (respects the same DATA_FILE env override server.js/lib/database.js use)
'use strict';
const fs = require('fs');
const path = require('path');

const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'database.json');
const dataDir = path.dirname(dataFile);
const { ENTITY_KEYS } = require('../lib/database');

const report = { generatedAt: new Date().toISOString(), dataFile, backend: {}, entityKeys: {}, atomicWriteHygiene: {}, journalIntegrity: {}, periodLockBypass: {} };

// ── Backend configuration (no credential exposure) ──────────────────────
const mongoUriSet = !!process.env.MONGO_URI;
const mongoUriLooksWellFormed = mongoUriSet && /^mongodb(\+srv)?:\/\//.test(process.env.MONGO_URI);
report.backend = {
  DB_FILE_ONLY: process.env.DB_FILE_ONLY === 'true',
  NODE_ENV: process.env.NODE_ENV || '(unset)',
  MONGO_URI_set: mongoUriSet,
  MONGO_URI_looksWellFormed: mongoUriLooksWellFormed, // scheme check only — value itself never read into this report
  dataFileExists: fs.existsSync(dataFile),
};

if (!report.backend.dataFileExists) {
  console.log(JSON.stringify(report, null, 2));
  console.log('\n⚠️  No file-mode snapshot found at the configured DATA_FILE — if this deployment is Mongo-backed, that is expected and this diagnostic has nothing further to check from here.');
  process.exit(0);
}

let db;
try {
  db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
} catch (e) {
  report.backend.parseError = e.message;
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

// ── ENTITY_KEYS completeness (Objective B) ───────────────────────────────
// Only the KEY NAME is ever reported for a missing entity — never any of
// its would-be content, in keeping with this script's read-only,
// no-sensitive-disclosure contract.
const missingKeys = ENTITY_KEYS.filter(k => !(k in db));
const presentKeys = ENTITY_KEYS.filter(k => k in db);
report.entityKeys = {
  totalExpected: ENTITY_KEYS.length,
  present: presentKeys.length,
  missing: missingKeys,
  complete: missingKeys.length === 0,
};

// ── Leftover atomic-write temp files (crash-mid-write signal) ───────────
let leftoverTmpFiles = [];
try {
  leftoverTmpFiles = fs.readdirSync(dataDir).filter(f => f.startsWith(path.basename(dataFile) + '.tmp-'));
} catch (e) { /* dataDir unreadable — report nothing rather than throw */ }
report.atomicWriteHygiene = {
  leftoverTmpFiles,
  clean: leftoverTmpFiles.length === 0,
};

// ── Journal-entry balance smoke check ────────────────────────────────────
const journal = Array.isArray(db.journalEntries) ? db.journalEntries : [];
const r3 = v => Math.round((Number(v) || 0) * 1000) / 1000;
const unbalanced = journal.filter(je => {
  const lines = je.lines || [];
  const debit = r3(lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0));
  const credit = r3(lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0));
  return Math.abs(debit - credit) > 0.001;
}).map(je => ({ id: je.id, date: je.date, ref: je.ref }));
report.journalIntegrity = {
  totalEntries: journal.length,
  unbalancedEntries: unbalanced,
  allBalanced: unbalanced.length === 0,
};

// ── Locked-period bypass smoke check ─────────────────────────────────────
const lockedPeriods = db.lockedPeriods || {};
const lockedMonths = new Set(Object.entries(lockedPeriods).filter(([, v]) => v).map(([k]) => k));
const bypassCandidates = journal.filter(je => je.type !== 'closing' && lockedMonths.has(String(je.date || '').slice(0, 7)))
  .map(je => ({ id: je.id, date: je.date, ref: je.ref }));
report.periodLockBypass = {
  lockedMonths: [...lockedMonths],
  entriesInLockedMonths: bypassCandidates,
  // Informational only — a legitimate closing entry is itself dated inside
  // the month it closes and is excluded above; anything else here is worth
  // a human review, not proof of an actual historical bypass (a period can
  // be locked AFTER an entry already inside it was posted legitimately).
  clean: bypassCandidates.length === 0,
};

console.log(JSON.stringify(report, null, 2));
