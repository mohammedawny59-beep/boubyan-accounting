/**
 * Pure commission calculation — no side effects, no DB access.
 * Extracted from server.js calcCommission() so it can be unit-tested independently.
 *
 * @param {object} dr       - Doctor record: { name, target, commission, lab, insRate, insurance }
 * @param {number} revenue  - Gross revenue for the period (KD)
 * @param {object} formula  - commissionFormula from config:
 *                            { base, deductions, method, tiers, fixedAmount }
 * @returns {number}        - Commission amount rounded to 3 decimal places (KD)
 */
function calcCommission(dr, revenue, formula = {}) {
  const base       = formula.base       || 'above_target';
  const deductions = formula.deductions || ['lab'];
  const method     = formula.method     || 'percentage';

  // Step 0: exclude insurance portion from revenue (insRate stored as 0-100)
  const insRate    = (dr.insRate || dr.insurance || 0);
  const insPercent = insRate > 1 ? insRate / 100 : insRate;
  const netRevenue = revenue * (1 - insPercent);

  // Step 1: base amount
  let amount = base === 'above_target'
    ? Math.max(0, netRevenue - (dr.target || 0))
    : netRevenue;

  // Step 2: lab deduction (fixed KD amount)
  if (deductions.includes('lab')) amount = Math.max(0, amount - (dr.lab || 0));

  // Step 3: apply commission method
  let commission = 0;
  if (method === 'percentage') {
    commission = amount * ((dr.commission || 0) / 100);
  } else if (method === 'tiered') {
    const tiers = formula.tiers || [];
    let remaining = amount;
    for (const tier of tiers) {
      if (remaining <= 0) break;
      const bracket = tier.to !== null && tier.to !== undefined
        ? Math.min(remaining, tier.to - (tier.from || 0))
        : remaining;
      if (bracket <= 0) continue;
      commission += bracket * ((tier.rate || 0) / 100);
      remaining  -= bracket;
    }
  } else if (method === 'fixed') {
    commission = dr.commission || 0;
  } else if (method === 'fixed_plus_percentage') {
    commission = (formula.fixedAmount || 0) + amount * ((dr.commission || 0) / 100);
  }

  return parseFloat(Math.max(0, commission).toFixed(3));
}

module.exports = { calcCommission };
