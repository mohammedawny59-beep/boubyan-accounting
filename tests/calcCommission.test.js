const { calcCommission } = require('../lib/calcCommission');

const dr = { name: 'د. أحمد', target: 1000, commission: 20, lab: 50, insRate: 10 };

describe('calcCommission — percentage method', () => {
  test('zero revenue returns 0', () => {
    expect(calcCommission(dr, 0)).toBe(0);
  });

  test('revenue below target returns 0 (above_target base)', () => {
    expect(calcCommission(dr, 900, { base: 'above_target', method: 'percentage' })).toBe(0);
  });

  test('basic percentage commission', () => {
    // revenue=2000, insRate=10% → net=1800, above_target=800, lab-50=750, 20%=150
    expect(calcCommission(dr, 2000, { base: 'above_target', deductions: ['lab'], method: 'percentage' })).toBe(150);
  });

  test('gross_revenue base ignores target', () => {
    // net=1800, lab-50=1750, 20%=350
    expect(calcCommission(dr, 2000, { base: 'gross_revenue', deductions: ['lab'], method: 'percentage' })).toBe(350);
  });

  test('no lab deduction', () => {
    // net=1800, above_target=800, 20%=160
    expect(calcCommission(dr, 2000, { base: 'above_target', deductions: [], method: 'percentage' })).toBe(160);
  });
});

describe('calcCommission — fixed method', () => {
  test('fixed commission regardless of revenue', () => {
    const fixedDr = { ...dr, commission: 500 };
    expect(calcCommission(fixedDr, 5000, { method: 'fixed' })).toBe(500);
  });
});

describe('calcCommission — tiered method', () => {
  const formula = {
    method: 'tiered',
    base: 'gross_revenue',
    deductions: [],
    tiers: [
      { from: 0,    to: 1000, rate: 10 },
      { from: 1000, to: 2000, rate: 15 },
      { from: 2000, to: null, rate: 20 },
    ],
  };

  test('first tier only', () => {
    const simpleDr = { insRate: 0 };
    // revenue=500, net=500, tier1: 500*10%=50
    expect(calcCommission(simpleDr, 500, formula)).toBe(50);
  });

  test('spans two tiers', () => {
    const simpleDr = { insRate: 0 };
    // revenue=1500: 1000*10%=100 + 500*15%=75 = 175
    expect(calcCommission(simpleDr, 1500, formula)).toBe(175);
  });
});

describe('calcCommission — edge cases', () => {
  test('insRate stored as decimal (0.1) treated correctly', () => {
    const drDec = { ...dr, insRate: 0.1, target: 0 };
    // insRate=0.1 → insPercent=0.1, net=2000*0.9=1800, lab-50=1750, 20%=350
    expect(calcCommission(drDec, 2000, { base: 'gross_revenue', deductions: ['lab'], method: 'percentage' })).toBe(350);
  });

  test('result never goes negative', () => {
    expect(calcCommission(dr, 10, { method: 'percentage' })).toBe(0);
  });

  test('result rounded to 3 decimal places', () => {
    const r = calcCommission({ insRate: 0, target: 0, commission: 33.333, lab: 0 }, 100, { method: 'percentage', base: 'gross_revenue', deductions: [] });
    expect(r).toBe(33.333);
  });
});
