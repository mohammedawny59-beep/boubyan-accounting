// P0.12 — READ-ONLY historical duplicate-posting diagnostic. Companion
// script for docs/FINANCIAL_DUPLICATE_REMEDIATION_PLAN.md. Reads
// data/database.json directly via fs.readFileSync and NEVER calls
// loadDB()/saveDB() or any write path, never deletes anything, never
// auto-reverses anything — it cannot mutate the database no matter what it
// finds. Run with: node scripts/idempotency-duplicate-diagnostic.js
// (respects the same DATA_FILE env override server.js itself uses).
//
// Purpose: this milestone's server-side fix (lib/idempotency.js) prevents
// FUTURE duplicate postings; it cannot retroactively know whether a
// duplicate already happened in existing historical data BEFORE this
// milestone existed. This script looks for the SIGNATURE such a duplicate
// would leave behind, classified by confidence — never asserts certainty
// where a legitimate coincidence is possible, never proposes automatic
// remediation (see docs/FINANCIAL_DUPLICATE_REMEDIATION_PLAN.md §"سياسة").
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

const journal = db.journalEntries || [];
const out = { highConfidence: {}, possible: {}, legitimate: {} };

// ═══════════════════ HIGH-CONFIDENCE ═══════════════════
// Refs that the app's OWN existing code treats as unique-per-logical-
// operation (a period, a specific payment sequence, a specific disposal) —
// more than one journal entry sharing such a ref is near-certain proof a
// duplicate posting happened, not a coincidence.

// 1. Period-scoped refs that must be unique by construction: CLOSE-<month>,
// DEP-<period>, PIFSS-<month>, EOS-<month>.
const periodRefPattern = /^(CLOSE|DEP|PIFSS|EOS)-\d{4}-\d{2}$/;
const periodRefCounts = {};
journal.forEach(je => { if (je.ref && periodRefPattern.test(je.ref)) periodRefCounts[je.ref] = (periodRefCounts[je.ref] || 0) + 1; });
out.highConfidence.duplicatePeriodRefs = Object.entries(periodRefCounts)
  .filter(([, c]) => c > 1)
  .map(([ref, count]) => ({ ref, count, journalEntryIds: journal.filter(je => je.ref === ref).map(je => je.id) }));

// 2. Per-resource sequential refs that must be unique: BILLPAY-<id>-<seq>,
// PATCOLL-<id>-<seq>, JE-DISPOSE-<id> (asset id itself, not a seq — at most
// one disposal is ever legitimate for a given asset).
const seqRefPattern = /^(BILLPAY|PATCOLL)-.+-\d+$/;
const seqRefCounts = {};
journal.forEach(je => { if (je.ref && seqRefPattern.test(je.ref)) seqRefCounts[je.ref] = (seqRefCounts[je.ref] || 0) + 1; });
out.highConfidence.duplicateSequencedPaymentRefs = Object.entries(seqRefCounts)
  .filter(([, c]) => c > 1)
  .map(([ref, count]) => ({ ref, count, journalEntryIds: journal.filter(je => je.ref === ref).map(je => je.id) }));

const disposeRefCounts = {};
journal.forEach(je => { if (je.id && String(je.id).startsWith('JE-DISPOSE-')) disposeRefCounts[je.id] = (disposeRefCounts[je.id] || 0) + 1; });
out.highConfidence.duplicateDisposalIds = Object.entries(disposeRefCounts).filter(([, c]) => c > 1).map(([id, count]) => ({ id, count }));

// 3. Vendor-bill payments / patient-receivable collections whose OWN array
// contains two entries with identical clientRef (the dedup guard exists
// specifically to prevent this — a hit here means it failed or was bypassed
// for older data written before that guard existed).
out.highConfidence.duplicateClientRefPayments = [];
(db.vendorBills || []).forEach(bill => {
  const seen = {};
  (bill.payments || []).forEach(p => { if (p.clientRef) seen[p.clientRef] = (seen[p.clientRef] || 0) + 1; });
  Object.entries(seen).filter(([, c]) => c > 1).forEach(([ref, count]) =>
    out.highConfidence.duplicateClientRefPayments.push({ type: 'vendorBill', billId: bill.id, clientRef: ref, count }));
});
(db.patientReceivables || []).forEach(rec => {
  const seen = {};
  (rec.collections || []).forEach(c => { if (c.clientRef) seen[c.clientRef] = (seen[c.clientRef] || 0) + 1; });
  Object.entries(seen).filter(([, c]) => c > 1).forEach(([ref, count]) =>
    out.highConfidence.duplicateClientRefPayments.push({ type: 'patientReceivable', receivableId: rec.id, clientRef: ref, count }));
});

// ═══════════════════ POSSIBLE ═══════════════════
// Two journal entries with the SAME date + description + totalDebit +
// totalCredit + identical account-line set — could be a real duplicate
// posting, but (unlike the refs above) has no structural uniqueness
// guarantee to lean on, so this is reported as POSSIBLE, never asserted.
function lineSignature(je) {
  return (je.lines || [])
    .map(l => `${l.accountCode != null ? l.accountCode : l.account}:${r3(l.debit)}:${r3(l.credit)}`)
    .sort()
    .join('|');
}
const exactMatchGroups = {};
journal.forEach(je => {
  const key = `${je.date}|${(je.desc || je.description || '').trim()}|${r3(je.totalDebit)}|${r3(je.totalCredit)}|${lineSignature(je)}`;
  (exactMatchGroups[key] = exactMatchGroups[key] || []).push(je.id);
});
out.possible.identicalJournalEntries = Object.entries(exactMatchGroups)
  .filter(([, ids]) => ids.length > 1)
  .map(([key, ids]) => ({ signature: key, count: ids.length, journalEntryIds: ids }));

// ═══════════════════ LEGITIMATE (explicitly excluded, reported for transparency) ═══════════════════
// Same description + amount but DIFFERENT dates — the normal, expected
// shape of a recurring monthly expense/income, never flagged as a duplicate.
const descAmountGroups = {};
journal.forEach(je => {
  const key = `${(je.desc || je.description || '').trim()}|${r3(je.totalDebit)}`;
  (descAmountGroups[key] = descAmountGroups[key] || new Set()).add(je.date);
});
out.legitimate.recurringLikePatterns = Object.entries(descAmountGroups)
  .filter(([, dates]) => dates.size > 1)
  .map(([key, dates]) => ({ signature: key, distinctDates: dates.size }))
  .slice(0, 20); // informational sample only, not a remediation target

console.log(JSON.stringify({
  meta: {
    dataFile,
    journalCount: journal.length,
    vendorBillCount: (db.vendorBills || []).length,
    patientReceivableCount: (db.patientReceivables || []).length,
    generatedAt: new Date().toISOString(),
    note: 'READ-ONLY diagnostic. No deletion, no auto-reversal, no historical mutation performed by this script or any other part of P0.12.',
  },
  ...out,
}, null, 2));
