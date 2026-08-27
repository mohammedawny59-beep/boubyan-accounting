'use strict';
/**
 * Centralized journal-entry integrity gate — P0.2 (Boubyan Production Hardening).
 *
 * Every code path that creates a journal entry (manual, payroll, PIFSS/EOS,
 * vouchers, recurring, Excel imports, bank reconciliation, AI/OCR/Telegram,
 * month-end close, ...) must route its final `journalEntries.push()` through
 * `appendJournalEntry()` instead of pushing directly. This is the single
 * place that enforces the non-negotiable invariants:
 *
 *   A. valid, well-formed accounting date
 *   B. the entry's period is not locked (IAS 8)
 *   C. sum(debit) === sum(credit), within the project's existing 0.005 KWD tolerance
 *   D. every line has a valid, non-negative, single-sided numeric amount
 *   E. every accountCode resolves to a real account in the tenant's chart of accounts
 *
 * It does NOT decide how an entry's amounts/accounts are computed — that
 * business logic stays in server.js exactly as before. This module only
 * decides whether the finished entry is allowed to be persisted.
 */

// R5 (staging validation, adversarial review — P0, live-reproduced): this was
// 0.005 — LOOSER than GET /api/trial-balance's own sanity check, which uses
// `Math.abs(grandDebit - grandCredit) < 0.001` (server.js:7994). The gap
// between the two meant a genuinely unbalanced entry (e.g. debit 10.003 /
// credit 10.000, a real 0.003 KWD imbalance — not floating-point rounding
// noise, which at 3dp is at most ~0.0005/line) was ACCEPTED and PERSISTED
// here, then immediately flagged isBalanced:false by the trial balance —
// the single most basic accounting invariant (debits=credits) silently
// violated by the entry gate that exists specifically to enforce it.
// Tightened to match trial-balance's existing, stricter 0.001 so the two
// checks agree — this can only REJECT entries that previously slipped
// through, never permit anything that was blocked before.
const BALANCE_TOLERANCE = 0.001;

class JournalValidationError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'JournalValidationError';
    this.status = status || 400;
    this.code = code || 'INVALID_JOURNAL';
  }
}

/**
 * Pure validation — never mutates db or entry.
 * @returns {{ok:true, totalDebit:number, totalCredit:number} | {ok:false, status:number, code:string, error:string}}
 */
function validateJournalEntry(db, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, status: 400, code: 'INVALID_ENTRY', error: 'بيانات القيد غير صحيحة' };
  }

  // ── Invariant A: valid date ──────────────────────────────────────────────
  const date = entry.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return { ok: false, status: 400, code: 'INVALID_DATE', error: 'تاريخ القيد مطلوب بصيغة صحيحة (YYYY-MM-DD)' };
  }

  // ── Invariant B: period must not be locked ───────────────────────────────
  const period = String(date).slice(0, 7);
  if ((db.lockedPeriods || {})[period]) {
    return { ok: false, status: 409, code: 'PERIOD_LOCKED', error: `الفترة ${period} مقفلة — لا يمكن إنشاء قيود جديدة فيها (IAS 8)` };
  }

  // ── Invariant F: structure ────────────────────────────────────────────────
  const lines = entry.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: false, status: 400, code: 'NO_LINES', error: 'القيد يجب أن يحتوي على بنود' };
  }

  const coa = db.chartOfAccounts || [];
  let totalDebit = 0, totalCredit = 0;

  for (const line of lines) {
    if (!line || typeof line !== 'object') {
      return { ok: false, status: 400, code: 'INVALID_LINE', error: 'بند قيد غير صحيح' };
    }

    // ── Invariant D: valid numerical amounts ──────────────────────────────
    const debit  = Number(line.debit);
    const credit = Number(line.credit);
    if (!Number.isFinite(debit) || !Number.isFinite(credit)) {
      return { ok: false, status: 400, code: 'INVALID_AMOUNT', error: 'مبلغ غير صالح في بند القيد' };
    }
    if (debit < 0 || credit < 0) {
      return { ok: false, status: 400, code: 'NEGATIVE_AMOUNT', error: 'لا يمكن أن يكون مبلغ مدين أو دائن سالباً' };
    }
    if (debit === 0 && credit === 0) {
      return { ok: false, status: 400, code: 'EMPTY_LINE', error: 'كل بند بالقيد يجب أن يحتوي مبلغاً مديناً أو دائناً' };
    }
    if (debit > 0 && credit > 0) {
      return { ok: false, status: 400, code: 'DUAL_SIDED_LINE', error: 'لا يمكن أن يحتوي بند واحد على مدين ودائن معاً' };
    }

    // ── Invariant E: account must exist in the tenant's COA ───────────────
    const rawCode = line.accountCode != null ? line.accountCode : line.account;
    const code = rawCode != null ? String(rawCode) : '';
    if (!code) {
      return { ok: false, status: 400, code: 'MISSING_ACCOUNT', error: 'بند القيد بلا رقم حساب' };
    }
    const acc = coa.find(a => String(a.code) === code);
    if (!acc) {
      return { ok: false, status: 400, code: 'UNKNOWN_ACCOUNT', error: `الحساب ${code} غير موجود في شجرة الحسابات — لا يمكن الترحيل إليه` };
    }
    // P0.9 — P6-005: a group/header account (isGroup:true) exists only to
    // parent real leaf accounts — posting directly to it breaks the parent/
    // child aggregation the reports rely on. This checks the explicit
    // `isGroup` flag only (not a derived "has children" scan) — several
    // DEFAULT_COA accounts have children without being flagged isGroup (a
    // separate, documented data-quality gap, P6-005 remains PARTIAL for
    // that reason) and enforcing a derived check would reject long-standing
    // legitimate postings this milestone must not regress.
    if (acc.isGroup) {
      return { ok: false, status: 400, code: 'GROUP_ACCOUNT_POSTING', error: `الحساب ${code} (${acc.name}) حساب تجميعي (Group) — لا يمكن الترحيل إليه مباشرة` };
    }
    // P0.9 — Part H/Step 26: a deactivated account must not receive NEW
    // postings — historical reports are unaffected (they read journal lines
    // directly, never filtered by the account's CURRENT status; verified
    // across computeCoaBalances/buildBalanceMap/trial-balance/financial-
    // statements — none of them filter by status). Checks the explicit
    // 'inactive' value only — most DEFAULT_COA accounts carry no `status`
    // field at all, and undefined must never be treated as inactive.
    if (acc.status === 'inactive') {
      return { ok: false, status: 400, code: 'INACTIVE_ACCOUNT_POSTING', error: `الحساب ${code} (${acc.name}) غير نشط — لا يمكن الترحيل إليه` };
    }
    // P0.11 (adversarial review finding, financial-statements persona):
    // account 3300 is the system-reserved period-close profit/loss transfer
    // account (computeAndPostClosingEntry, server.js — the sole legitimate
    // writer, always posts with entry.type === 'closing'). GET
    // /api/financial-statements' totalEquity is built from currentPeriodNI
    // (revenue/expense accounts only — never reads 3300) plus
    // priorClosedRetained (3300 activity dated strictly BEFORE the reported
    // period) — a manual entry crediting/debiting 3300 WITHIN the current
    // period was invisible to both terms while any paired line (e.g. a real
    // asset account) still moved totalAssets, silently breaking
    // Assets == Liabilities + Equity with no error surfaced anywhere. Any
    // entry touching 3300 outside the canonical closing path is rejected
    // here, before it can ever reach that blind spot.
    if (code === '3300' && entry.type !== 'closing') {
      return { ok: false, status: 400, code: 'SYSTEM_ACCOUNT_POSTING', error: `الحساب 3300 (تحويل نتيجة إقفال الفترة) مُدار حصرًا عبر عملية الإقفال — لا يمكن الترحيل إليه يدويًا` };
    }

    totalDebit  += debit;
    totalCredit += credit;
  }

  totalDebit  = parseFloat(totalDebit.toFixed(3));
  totalCredit = parseFloat(totalCredit.toFixed(3));

  // ── Invariant C: double entry ─────────────────────────────────────────────
  if (Math.abs(totalDebit - totalCredit) > BALANCE_TOLERANCE) {
    return {
      ok: false, status: 400, code: 'UNBALANCED',
      error: `القيد غير متوازن: المدين ${totalDebit.toFixed(3)} ≠ الدائن ${totalCredit.toFixed(3)}`,
    };
  }

  return { ok: true, totalDebit, totalCredit };
}

/**
 * P0.6B — Step 2 (P6-017): the single, shared source of truth for "what does
 * this journal entry actually total" — every consumer (anomaly detection,
 * dashboards, future reports) must call this instead of trusting
 * `je.totalDebit`/`je.totalCredit` directly. Several write paths (Excel
 * import routes in particular — POST /api/import/expenses,
 * /api/import/doctor-payments) build a valid `lines` array but never set
 * `totalDebit`/`totalCredit` on the entry itself; reading those fields raw
 * silently returns 0/undefined even though the entry is real and balanced.
 * Recomputing from `lines` (already the correct, validated source of truth
 * for the entry's actual amounts) is always safe and always current — same
 * principle as P6-011's journal-edit-totals fix. Falls back to the stored
 * totals only for the pathological case of an entry with no `lines` array
 * at all (should not normally occur — appendJournalEntry() requires lines).
 * @returns {{debit:number, credit:number}}
 */
function jeAmounts(je) {
  if (je && Array.isArray(je.lines) && je.lines.length) {
    const debit  = je.lines.reduce((s, l) => s + (parseFloat(l && l.debit)  || 0), 0);
    const credit = je.lines.reduce((s, l) => s + (parseFloat(l && l.credit) || 0), 0);
    return { debit: parseFloat(debit.toFixed(3)), credit: parseFloat(credit.toFixed(3)) };
  }
  return {
    debit:  parseFloat(je && je.totalDebit)  || 0,
    credit: parseFloat(je && je.totalCredit) || 0,
  };
}

/**
 * Validate then append a single entry to db.journalEntries. Throws
 * JournalValidationError (never mutates db) if the entry is invalid.
 * @param {object} opts.unshift  push to the front instead of the back (a few
 *   routes historically unshift so the newest entry sorts first before the
 *   caller's own re-sort — preserved for behavioral parity).
 */
function appendJournalEntry(db, entry, opts) {
  opts = opts || {};
  const result = validateJournalEntry(db, entry);
  if (!result.ok) throw new JournalValidationError(result.error, result.status, result.code);

  if (!db.journalEntries) db.journalEntries = [];
  if (opts.unshift) db.journalEntries.unshift(entry);
  else db.journalEntries.push(entry);
  return entry;
}

/**
 * Validate a whole batch (e.g. an Excel/bulk import) WITHOUT mutating db.
 * Returns { valid: Entry[], invalid: {entry, error, code}[] } — callers that
 * need all-or-nothing batch semantics should check `invalid.length === 0`
 * before calling appendJournalEntry for each entry in `valid`.
 */
function validateJournalBatch(db, entries) {
  const valid = [], invalid = [];
  for (const entry of entries) {
    const result = validateJournalEntry(db, entry);
    if (result.ok) valid.push(entry);
    else invalid.push({ entry, error: result.error, code: result.code });
  }
  return { valid, invalid };
}

/**
 * P0.3 — Historical Ledger Reconciliation Audit.
 *
 * READ-ONLY. Never mutates `db`. Scans every journal line in the requested
 * date range and reports every accountCode that does not resolve in the
 * tenant's own chartOfAccounts — the exact condition that makes a line
 * silently disappear from the P&L/Balance Sheet/Trial Balance (those reports
 * iterate `chartOfAccounts`, not journal lines, so an unresolved code is
 * invisible to them even though the journal entry itself still exists).
 *
 * This function detects the SYMPTOM (an unresolved code) generically — it
 * does not know which historical business workflow produced any given line,
 * so it cannot itself distinguish "this 2200 line was a legitimate salary
 * accrual" from "this 2200 line was a mis-posted PIFSS/EOS/asset-purchase
 * entry" for codes that already exist in the COA. That classification is a
 * human/report-level judgment — see the P0.3 report's confidence-graded
 * findings, built by cross-referencing this scanner's output against each
 * entry's `type`/`ref`/`source`/`desc` metadata.
 */
function scanUnresolvedAccounts(db, fromDate, toDate) {
  const coa = db.chartOfAccounts || [];
  const coaCodes = new Set(coa.map(a => String(a.code)));

  const entries = (db.journalEntries || []).filter(je => {
    if (fromDate && je.date < fromDate) return false;
    if (toDate && je.date > toDate) return false;
    return true;
  });

  const round3 = n => parseFloat((Number(n) || 0).toFixed(3));
  const byCode = {};
  let totalLines = 0;

  entries.forEach(je => {
    (je.lines || []).forEach(line => {
      totalLines++;
      const raw = line.accountCode != null ? line.accountCode : line.account;
      const code = raw != null ? String(raw) : '';
      if (!code || coaCodes.has(code)) return; // blank/resolved — not our concern here

      if (!byCode[code]) {
        byCode[code] = {
          code, count: 0, debitTotal: 0, creditTotal: 0,
          entryIds: new Set(), earliestDate: null, latestDate: null,
          refs: new Set(), sources: new Set(), types: new Set(), descriptions: new Set(),
        };
      }
      const b = byCode[code];
      b.count++;
      b.debitTotal  += Number(line.debit)  || 0;
      b.creditTotal += Number(line.credit) || 0;
      b.entryIds.add(je.id);
      if (!b.earliestDate || je.date < b.earliestDate) b.earliestDate = je.date;
      if (!b.latestDate  || je.date > b.latestDate)  b.latestDate  = je.date;
      if (je.ref)    b.refs.add(je.ref);
      if (je.source) b.sources.add(je.source);
      if (je.type)   b.types.add(je.type);
      const d = je.desc || je.description;
      if (d) b.descriptions.add(d);
    });
  });

  const unresolvedCodes = Object.values(byCode).map(b => ({
    code: b.code,
    affectedEntries: b.entryIds.size,
    affectedLines: b.count,
    debitTotal: round3(b.debitTotal),
    creditTotal: round3(b.creditTotal),
    earliestDate: b.earliestDate,
    latestDate: b.latestDate,
    sampleRefs: [...b.refs].slice(0, 5),
    sampleSources: [...b.sources].slice(0, 5),
    sampleTypes: [...b.types].slice(0, 5),
    sampleDescriptions: [...b.descriptions].slice(0, 5),
  })).sort((a, b) => b.affectedLines - a.affectedLines);

  return {
    scannedFrom: fromDate || null,
    scannedTo: toDate || null,
    totalEntries: entries.length,
    totalLines,
    hasUnresolvedAccounts: unresolvedCodes.length > 0,
    unresolvedCount: unresolvedCodes.length,
    unresolvedCodes,
  };
}

/**
 * P0.6A — Step 4 (P6-012/P6-013): the ONE shared guard every destructive
 * financial operation (delete / undo / bulk-reversal) must call BEFORE
 * mutating anything. `validateJournalEntry`'s own Invariant B already
 * protects the CREATE/EDIT path; this is the equivalent for the DELETE/UNDO
 * side, which previously had no single shared implementation — each route
 * either checked `lockedPeriods` ad hoc (inconsistently) or not at all,
 * letting a locked-period journal entry be silently destroyed via whichever
 * "front door" (the owning business record, or a bulk undo) happened not to
 * check.
 *
 * Pure — never mutates `db`, never touches anything else. Throws
 * JournalValidationError (status 403, matching the pre-existing convention
 * `DELETE /api/journal/:id` already used for this exact rejection) the
 * moment ANY affected date falls in a locked period — callers must call
 * this BEFORE removing/altering anything, so a caught rejection here always
 * leaves the operation as a complete no-op (all-or-nothing).
 *
 * @param {object} db
 * @param {(string|null|undefined)[]|string} affectedDates one date
 *   (YYYY-MM-DD) per journal entry/record the operation would remove or
 *   alter — pass every one for a cascading/bulk delete, not just the
 *   "primary" record's date. Falsy entries are ignored.
 */
function assertFinancialPeriodOpen(db, affectedDates) {
  const locked = (db && db.lockedPeriods) || {};
  const dates = Array.isArray(affectedDates) ? affectedDates : [affectedDates];
  for (const date of dates) {
    if (!date) continue;
    const period = String(date).slice(0, 7);
    if (locked[period]) {
      throw new JournalValidationError(
        `الفترة ${period} مقفلة — لا يمكن تنفيذ هذا الإجراء على بيانات مالية ضمنها (IAS 8)`,
        403, 'PERIOD_LOCKED',
      );
    }
  }
}

module.exports = {
  validateJournalEntry,
  appendJournalEntry,
  validateJournalBatch,
  scanUnresolvedAccounts,
  assertFinancialPeriodOpen,
  jeAmounts,
  JournalValidationError,
  BALANCE_TOLERANCE,
};
