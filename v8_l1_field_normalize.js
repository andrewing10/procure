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
  // 精确匹配
  if (PURCHASE_CYCLE_ALIASES[s]) return PURCHASE_CYCLE_ALIASES[s];
  if (PURCHASE_CYCLE_ALLOWED.has(s)) return s;
  // 模糊匹配：处理 LLM 返回的自由文本，如 "quarterly purchasing cycle"、"every month"
  if (s.includes('week')) return 'weekly';
  if (s.includes('month') || s.includes('bi-week') || s.includes('biweek') || s.includes('fortnightly')) return 'monthly';
  if (s.includes('quarter') || s.includes('semi-annual') || s.includes('half-year') || s.includes('half year')) return 'quarterly';
  if (s.includes('year') || s.includes('annual')) return 'annual';
  // 无法识别 → null（绝不写入不合法值，避免 purchase_cycle_chk 约束拒绝）
  return null;
}

module.exports = { normalizePurchaseCycle, PURCHASE_CYCLE_ALLOWED };
