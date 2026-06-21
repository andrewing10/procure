/**
 * 品类词净化 — 与 zhimao apps/web/lib/discovery/categorySanitize.ts 同步。
 */
function sanitizeDiscoveryCategory(category) {
  const raw = String(category || '').trim();
  if (!raw) return raw;
  const cleaned = raw
    .replace(/\s+buyers?\s+(?:in|from|at|within|across|for)\s+.+$/i, '')
    .replace(/[\s]*(买家|进口商|购买者|采购商|采购方|采购代理)\s*$/i, '')
    .replace(/[\s]+(buyer|buyers|importer|importers|purchaser|purchasers)\s*$/i, '')
    .trim();
  return cleaned || raw;
}

module.exports = { sanitizeDiscoveryCategory };
