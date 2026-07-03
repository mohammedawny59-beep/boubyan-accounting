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

module.exports = { nextChildCode };
