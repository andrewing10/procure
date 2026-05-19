/**
 * PILLAR0_PAYLOAD / step0 orchestration 统一读取与 query 主题轮换。
 */
const { sanitizeDiscoveryCategory } = require('./v8_lib_category_sanitize');

function readFullPillar0Payload() {
  const raw = process.env.PILLAR0_PAYLOAD || '';
  if (!raw.trim()) return {};
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

function readInlineSeeds(payload) {
  const p = payload || readFullPillar0Payload();
  const seeds = p.seeds;
  if (!seeds || typeof seeds !== 'object') return { social_urls: [], company_urls: [] };
  const social = Array.isArray(seeds.social_urls)
    ? seeds.social_urls.filter((u) => typeof u === 'string' && u.trim()).slice(0, 50)
    : [];
  const company = Array.isArray(seeds.company_urls)
    ? seeds.company_urls.filter((u) => typeof u === 'string' && u.trim()).slice(0, 50)
    : [];
  return { social_urls: social, company_urls: company };
}

function buildQuerySubjects(step0Data, category, industryAnchor, payload) {
  const p = payload || readFullPillar0Payload();
  const subjects = [];
  const cat = sanitizeDiscoveryCategory(category);
  if (cat) subjects.push(cat);
  if (Array.isArray(step0Data?.pillar0Keywords)) {
    subjects.push(...step0Data.pillar0Keywords);
  }
  if (Array.isArray(p.expanded_keywords)) {
    subjects.push(...p.expanded_keywords);
  }
  if (Array.isArray(p.buyer_personas)) {
    for (const persona of p.buyer_personas) {
      if (persona && typeof persona.industry_en === 'string') subjects.push(persona.industry_en);
      if (persona && typeof persona.industry_zh === 'string') subjects.push(persona.industry_zh);
    }
  }
  if (industryAnchor) {
    subjects.push(...(industryAnchor.en || []), ...(industryAnchor.zh || []));
  }
  const seen = new Set();
  const out = [];
  for (const s of subjects) {
    const t = String(s || '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, 12);
}

function quoteSubject(term) {
  const t = String(term || '').trim().replace(/"/g, '');
  return t ? `"${t}"` : '""';
}

function pickSubject(subjects, category, index) {
  const list = subjects.length > 0 ? subjects : [category];
  return list[index % list.length] || category;
}

function collectBooleanQueries(step0Data, payload) {
  const p = payload || readFullPillar0Payload();
  const fromFile = Array.isArray(step0Data?.pillar0BooleanQueries)
    ? step0Data.pillar0BooleanQueries
    : [];
  const fromPayload = Array.isArray(p.boolean_queries) ? p.boolean_queries : [];
  const seen = new Set();
  const out = [];
  for (const q of [...fromFile, ...fromPayload]) {
    const s = String(q || '').trim();
    if (!s || s.length < 8 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}

function collectProcurementQueries(step0Data, payload) {
  const p = payload || readFullPillar0Payload();
  const fromFile = Array.isArray(step0Data?.procurementQueries)
    ? step0Data.procurementQueries
    : [];
  const fromPayload = Array.isArray(p.procurement_queries) ? p.procurement_queries : [];
  const seen = new Set();
  const out = [];
  for (const q of [...fromFile, ...fromPayload]) {
    const s = String(q || '').trim();
    if (!s || s.length < 8 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 6) break;
  }
  return out;
}

module.exports = {
  readFullPillar0Payload,
  readInlineSeeds,
  buildQuerySubjects,
  quoteSubject,
  pickSubject,
  collectBooleanQueries,
  collectProcurementQueries,
  sanitizeDiscoveryCategory,
};
