/**
 * Normalize L1 column values to match zhimao data_intel_l1_companies CHECK constraints.
 */
const PURCHASE_CYCLE_ALLOWED = new Set(['weekly', 'monthly', 'quarterly', 'annual']);

const PURCHASE_CYCLE_ALIASES = {
  week: 'weekly',
  weekly: 'weekly',
  'bi-weekly': 'monthly',
  biweekly: 'monthly',
  fortnightly: 'monthly',
  month: 'monthly',
  monthly: 'monthly',
  quarter: 'quarterly',
  quarterly: 'quarterly',
  qtr: 'quarterly',
  'semi-annual': 'quarterly',
  semiannual: 'quarterly',
  biannual: 'quarterly',
  'half-yearly': 'quarterly',
  year: 'annual',
  yearly: 'annual',
  annual: 'annual',
  annually: 'annual',
};

/**
 * @param {unknown} raw
 * @returns {'weekly'|'monthly'|'quarterly'|'annual'|null}
 */
function normalizePurchaseCycle(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (PURCHASE_CYCLE_ALIASES[s]) return PURCHASE_CYCLE_ALIASES[s];
  if (PURCHASE_CYCLE_ALLOWED.has(s)) return s;
  return null;
}

module.exports = { normalizePurchaseCycle, PURCHASE_CYCLE_ALLOWED };
