// P0.10 — READ-ONLY historical diagnostic for Fixed Assets + Bank
// Reconciliation. Companion script for docs/ASSET_BANK_REMEDIATION_PLAN.md
// (§1) — reads data/database.json directly via fs.readFileSync and NEVER
// calls loadDB()/saveDB() or any write path; it cannot mutate the database
// no matter what it finds. Run with: node scripts/asset-bank-diagnostic.js
// (respects the same DATA_FILE env override server.js itself uses).
'use strict';
const fs = require('fs');
const path = require('path');

const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'database.json');

if (!fs.existsSync(dataFile)) {
  console.error('Data file not found at', dataFile);
  process.exit(1);
}
const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

const r3 = v => Math.round((Number(v) || 0) * 1000) / 1000;
const out = { fixedAssets: {}, bankRecon: {} };

// ═══════════════════ FIXED ASSETS (docs §1.1) ═══════════════════
const assets = db.fixedAssets || [];
const journal = db.journalEntries || [];

// 1. Duplicate depreciation journals for the same period
const depRefCounts = {};
journal.forEach(je => { if (je.ref && String(je.ref).startsWith('DEP-')) depRefCounts[je.ref] = (depRefCounts[je.ref] || 0) + 1; });
out.fixedAssets.duplicateDepreciationRefs = Object.entries(depRefCounts).filter(([, c]) => c > 1).map(([ref, count]) => ({ ref, count }));

// 2. Register vs GL mismatch (mirrors GET /api/assets/reconciliation's own computation)
const registerCost = r3(assets.filter(a => a.status !== 'disposed').reduce((s, a) => s + (parseFloat(a.cost) || 0), 0));
const registerAccumDep = r3(assets.filter(a => a.status !== 'disposed').reduce((s, a) => s + (parseFloat(a.accumulatedDep) || 0), 0));
let glCostBal = 0, glAccumBal = 0;
journal.forEach(je => (je.lines || []).forEach(l => {
  const code = String(l.accountCode != null ? l.accountCode : l.account);
  if (code === '1510') glCostBal += (parseFloat(l.debit) || 0) - (parseFloat(l.credit) || 0);
  if (code === '1590') glAccumBal += (parseFloat(l.credit) || 0) - (parseFloat(l.debit) || 0);
}));
out.fixedAssets.registerVsGL = {
  registerCost, glCost: r3(glCostBal), costDifference: r3(registerCost - glCostBal),
  registerAccumDep, glAccumDep: r3(glAccumBal), accumDepDifference: r3(registerAccumDep - glAccumBal),
};

// 3. Negative NBV
out.fixedAssets.negativeNBV = assets.filter(a => {
  const nbv = (parseFloat(a.cost) || 0) - (parseFloat(a.accumulatedDep) || 0);
  return nbv < -0.005;
}).map(a => ({ id: a.id, name: a.name, cost: a.cost, accumulatedDep: a.accumulatedDep, nbv: r3((parseFloat(a.cost) || 0) - (parseFloat(a.accumulatedDep) || 0)) }));

// 4. Depreciation beyond useful life (accumulatedDep > cost - salvageValue)
out.fixedAssets.depreciationBeyondUsefulLife = assets.filter(a => {
  const depreciableBase = (parseFloat(a.cost) || 0) - (parseFloat(a.salvageValue) || 0);
  return (parseFloat(a.accumulatedDep) || 0) > depreciableBase + 0.005;
}).map(a => ({ id: a.id, name: a.name, cost: a.cost, salvageValue: a.salvageValue, accumulatedDep: a.accumulatedDep }));

// 5. Disposed assets with a depreciation-affecting event after disposalDate
out.fixedAssets.disposedButStillDepreciating = assets.filter(a => a.status === 'disposed' && a.disposalDate).filter(a => {
  return journal.some(je => je.ref && String(je.ref).startsWith('DEP-') && je.date > a.disposalDate &&
    (je.lines || []).some(l => (l.accountName || '').includes(a.name)));
}).map(a => ({ id: a.id, name: a.name, disposalDate: a.disposalDate }));

// 6. Missing acquisition journal (no AST-<id> ref anywhere)
out.fixedAssets.missingAcquisitionJournal = assets.filter(a => !journal.some(je => je.ref === 'AST-' + a.id))
  .map(a => ({ id: a.id, name: a.name, cost: a.cost, purchaseDate: a.purchaseDate }));

// 7. Orphan journal references (AST-/DISPOSE- ref pointing at a non-existent asset id)
const assetIds = new Set(assets.map(a => String(a.id)));
out.fixedAssets.orphanJournalRefs = journal.filter(je => {
  const ref = String(je.ref || '');
  const m = ref.match(/^(AST|DISPOSE)-(.+)$/);
  return m && !assetIds.has(m[2]);
}).map(je => ({ id: je.id, ref: je.ref, date: je.date }));

// ═══════════════════ BANK RECONCILIATION (docs §1.2) ═══════════════════
const bankRecons = db.bankRecons || [];

// 1. Duplicate statement transactions within a single record
out.bankRecon.duplicateStatementLines = [];
bankRecons.forEach(rec => {
  const seen = {};
  (rec.bankStatementLines || []).forEach(l => {
    const key = `${l.date}|${(l.desc || '').trim()}|${r3(l.amount)}`;
    seen[key] = (seen[key] || 0) + 1;
  });
  const dups = Object.entries(seen).filter(([, c]) => c > 1);
  if (dups.length) out.bankRecon.duplicateStatementLines.push({ account: rec.account, period: rec.period, duplicates: dups.map(([k, c]) => ({ key: k, count: c })) });
});

// 2. Duplicate reconciliation records (same account+period appearing more than once)
const reconKeyCounts = {};
bankRecons.forEach(rec => { const k = `${rec.account}|${rec.period}`; reconKeyCounts[k] = (reconKeyCounts[k] || 0) + 1; });
out.bankRecon.duplicateReconciliationRecords = Object.entries(reconKeyCounts).filter(([, c]) => c > 1).map(([k, c]) => ({ key: k, count: c }));

// 3. Double-reconciled items (matchedLines array containing the same id twice)
out.bankRecon.doubleMatchedLineIds = [];
bankRecons.forEach(rec => {
  const seen = {};
  (rec.matchedLines || []).forEach(id => { seen[id] = (seen[id] || 0) + 1; });
  const dups = Object.entries(seen).filter(([, c]) => c > 1);
  if (dups.length) out.bankRecon.doubleMatchedLineIds.push({ account: rec.account, period: rec.period, duplicateIds: dups });
});

// 3b. bankMatchedLineIds (P0.10 matched-book engine) duplicates
const bmliSeen = {};
(db.bankMatchedLineIds || []).forEach(id => { bmliSeen[id] = (bmliSeen[id] || 0) + 1; });
out.bankRecon.duplicateBankMatchedLineIds = Object.entries(bmliSeen).filter(([, c]) => c > 1).map(([id, c]) => ({ id, count: c }));

// 3c. bankCommittedLineKeys duplicates (should be structurally impossible — Set-backed — but checked anyway)
const bcklSeen = {};
(db.bankCommittedLineKeys || []).forEach(k => { bcklSeen[k] = (bcklSeen[k] || 0) + 1; });
out.bankRecon.duplicateCommittedLineKeys = Object.entries(bcklSeen).filter(([, c]) => c > 1).map(([k, c]) => ({ key: k, count: c }));

// 4. Malformed bankRecons structure
out.bankRecon.malformedRecords = bankRecons.filter(rec =>
  !rec.account || !rec.period || !Array.isArray(rec.bankStatementLines) || !Array.isArray(rec.matchedLines)
).map(rec => ({ account: rec.account, period: rec.period }));

// 5. JE-BRC-* journal entries with mismatched debit/credit — should never happen
// post-P0.10 (appendJournalEntry rejects it before it's ever written), so any
// hit here means either pre-P0.10 data or a direct file edit outside the app.
out.bankRecon.unbalancedReconJEs = journal.filter(je => String(je.id || '').startsWith('JE-BRC-')).filter(je => {
  const dr = r3((je.lines || []).reduce((s, l) => s + (parseFloat(l.debit) || 0), 0));
  const cr = r3((je.lines || []).reduce((s, l) => s + (parseFloat(l.credit) || 0), 0));
  return Math.abs(dr - cr) > 0.005;
}).map(je => ({ id: je.id, date: je.date }));

console.log(JSON.stringify({
  meta: { dataFile, assetCount: assets.length, journalCount: journal.length, bankReconCount: bankRecons.length, generatedAt: new Date().toISOString() },
  ...out,
}, null, 2));
