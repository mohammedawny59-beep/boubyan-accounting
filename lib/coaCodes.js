'use strict';
/**
 * Chart-of-Accounts code generation.
 *
 * The COA uses a fixed-width hierarchical numbering scheme, e.g.:
 *   1000 (group)  →  1100, 1200 …  (level 2, step 100)
 *   1100          →  1110, 1120 …  (level 3, step 10)
 *   1110          →  1111, 1112 …  (level 4, step 1)
 *
 * The child "step" is the place value of the parent's lowest zero:
 *   trailingZeros(1000)=3 → step = 10^(3-1) = 100
 *   trailingZeros(1100)=2 → step = 10
 *   trailingZeros(1110)=1 → step = 1
 *
 * This module is the single source of truth so both the API and the
 * system-tester agent exercise the exact same logic.
 */

/**
 * Suggest the next available child account code under a base code.
 * @param {string|number} baseCode  parent account code, e.g. "1000"
 * @param {Array<string|number>} allCodes  every code currently in the COA
 * @returns {string} next free child code (same width as parent) or '' if none
 */
function nextChildCode(baseCode, allCodes) {
  const base = String(baseCode || '').trim();
  if (!/^\d+$/.test(base)) return '';

  const width = base.length;
  const trailingZeros = width - base.replace(/0+$/, '').length;
  if (trailingZeros === 0) return ''; // leaf in fixed-width scheme — no room for a same-width child

  const baseNum = parseInt(base, 10);
  const step    = Math.pow(10, trailingZeros - 1);
  const span    = step * 10; // exclusive upper bound: base + span is the next sibling

  const taken = new Set(
    (allCodes || [])
      .map(c => parseInt(String(c), 10))
      .filter(n => Number.isFinite(n) && n > baseNum && n < baseNum + span && (n - baseNum) % step === 0)
  );

  let next = baseNum + step;
  while (taken.has(next) && next < baseNum + span) next += step;
  if (next >= baseNum + span) return ''; // all 9 slots full — let the user choose manually

  return String(next).padStart(width, '0');
}

/**
 * Suggest a code even when the parent group is FULL (all 9 direct slots taken).
 * Falls back by cascading into the parent's sub-groups — preferring a
 * "misc/other" bucket (أخرى/متنوعة/عامة) then the highest-coded child —
 * so e.g. المصاريف 5000 (5100–5900 all taken) suggests 5910 under 5900.
 *
 * @param {string|number} baseCode  requested parent code
 * @param {Array<{code:string|number,id?:string,name?:string,parent?:string}>} accounts full COA
 * @param {number} depth  internal recursion guard
 * @returns {{code:string, parentCode:string, cascaded:boolean}|null}
 */
function suggestChildCode(baseCode, accounts, depth) {
  depth = depth || 0;
  if (depth > 3) return null;
  const base = String(baseCode || '').trim();
  if (!/^\d+$/.test(base)) return null;

  const allCodes = (accounts || []).map(a => String(a.code));
  const direct = nextChildCode(base, allCodes);
  if (direct) return { code: direct, parentCode: base, cascaded: depth > 0 };

  // Group full (or leaf) — cascade into sub-groups that still have room
  const baseAcc = (accounts || []).find(a => String(a.code) === base);
  const kids = (accounts || []).filter(a => {
    const p = a.parent == null ? '' : String(a.parent);
    return p === base || (baseAcc && baseAcc.id != null && p === String(baseAcc.id));
  });
  if (!kids.length) return null;

  const isMisc = a => /أخرى|متنوع|عام|other|misc/i.test(String(a.name || ''));
  const sorted = [...kids].sort((a, b) => {
    if (isMisc(a) !== isMisc(b)) return isMisc(a) ? -1 : 1;      // misc bucket first
    return String(b.code).localeCompare(String(a.code));          // then highest code
  });
  for (const k of sorted) {
    const kc = String(k.code);
    if (!/^\d+$/.test(kc) || kc.replace(/0+$/, '').length === kc.length) continue; // no room
    const r = suggestChildCode(kc, accounts, depth + 1);
    if (r) return { ...r, cascaded: true };
  }
  return null;
}

/**
 * Repair a chart of accounts in place. Idempotent & conservative:
 *  1. Missing/empty id            → id = code
 *  2. Parent doesn't exist        → reparent to the root group of the same class (first digit)
 *  3. Non-standard-width numeric code (e.g. "50", "59010")
 *                                 → reassign via suggestChildCode, update journal refs
 *                                   and children refs, and reparent to the real group.
 * Duplicate codes are NOT auto-renamed (journal references would be ambiguous).
 *
 * @param {Array} coa               chart of accounts (mutated in place)
 * @param {Array} journalEntries    journal entries (lines' account refs updated in place)
 * @returns {Array<{action:string, name:string, from?:string, to?:string}>} applied changes
 */
function repairChart(coa, journalEntries) {
  coa = coa || [];
  journalEntries = journalEntries || [];
  const changes = [];
  const findByRef = ref => coa.find(a => String(a.id) === String(ref) || String(a.code) === String(ref));

  // 0. تطبيع: كل كود/معرّف يجب أن يكون نصاً. كود رقمي (من الذكاء الاصطناعي/بيانات قديمة)
  //    كان يُسقط شاشة التعديل بأكملها (a.code.localeCompare ترمي استثناء → 500).
  for (const a of coa) {
    if (a.code != null && typeof a.code !== 'string') { a.code = String(a.code); changes.push({ action: 'code-normalized', name: a.name, to: a.code }); }
    if (a.id   != null && typeof a.id   !== 'string') { a.id   = String(a.id);   }
    if (a.parent != null && typeof a.parent !== 'string') a.parent = String(a.parent);
  }
  const rootOf = firstDigit => coa.find(a => !a.parent && /^\d+$/.test(String(a.code)) && String(a.code)[0] === String(firstDigit));

  // 1. missing ids
  for (const a of coa) {
    if (a.id == null || String(a.id).trim() === '' || String(a.id) === 'undefined' || String(a.id) === 'null') {
      a.id = String(a.code);
      changes.push({ action: 'id-repaired', name: a.name, to: a.id });
    }
  }

  // 2. orphan parents
  for (const a of coa) {
    if (!a.parent) continue;
    if (findByRef(a.parent)) continue;
    const root = /^\d+$/.test(String(a.code)) ? rootOf(String(a.code)[0]) : null;
    const from = String(a.parent);
    a.parent = root && root !== a ? String(root.id || root.code) : null;
    changes.push({ action: 'reparented', name: a.name, from, to: a.parent || '(رئيسي)' });
  }

  // 3. wrong-width codes
  const numeric = coa.filter(a => /^\d+$/.test(String(a.code)));
  const freq = {};
  numeric.filter(a => !a.isGroup).forEach(a => { const w = String(a.code).length; freq[w] = (freq[w] || 0) + 1; });
  const stdWidth = Number(Object.keys(freq).sort((x, y) => freq[y] - freq[x])[0] || 0);
  if (stdWidth) {
    for (const a of numeric) {
      const oldCode = String(a.code);
      if (oldCode.length === stdWidth) continue;
      // skip legitimate roots (1000/2000/… already std width) — anything else is malformed
      const parentAcc = a.parent ? findByRef(a.parent) : null;
      const baseCode = parentAcc ? String(parentAcc.code) : (rootOf(oldCode[0]) ? String(rootOf(oldCode[0]).code) : null);
      if (!baseCode) continue;
      const s = suggestChildCode(baseCode, coa);
      if (!s || coa.some(x => String(x.code) === s.code)) continue;
      const oldId = String(a.id);
      const newParent = findByRef(s.parentCode);
      // update journal refs
      for (const e of journalEntries) {
        for (const l of (e.lines || [])) {
          if (String(l.accountCode) === oldCode) l.accountCode = s.code;
          if (String(l.accountId) === oldCode || String(l.accountId) === oldId) l.accountId = s.code;
          if (String(l.account) === oldCode || String(l.account) === oldId) l.account = s.code;
        }
      }
      // update children refs
      for (const c of coa) {
        if (c === a) continue;
        if (String(c.parent) === oldCode || String(c.parent) === oldId) c.parent = s.code;
      }
      a.code = s.code;
      a.id = s.code;
      if (newParent) a.parent = String(newParent.id || newParent.code);
      changes.push({ action: 'code-fixed', name: a.name, from: oldCode, to: s.code });
    }
  }

  return changes;
}

module.exports = { nextChildCode, suggestChildCode, repairChart };
