/**
 * PILLAR0_PAYLOAD / step0 orchestration 统一读取与 query 主题轮换。
 */
const { sanitizeDiscoveryCategory } = require('./v8_lib_category_sanitize');

/**
 * 判定一个字符串是否为"纯拉丁可搜索词"（与 zhimao apps/web/lib/skills/querySearchKeywords.ts
 * isLatinSearchKeyword 镜像）。CJK 字符进 SERP quoted 查询命中率几乎为 0
 * （SERP 主要索引拉丁文）；buildQuerySubjects 会把 subjects 用 quoteSubject 包成
 * `"主题"` quoted long string 丢给 SERP，所以 CJK 主题必须过滤掉。
 */
function isLatinSearchSubject(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/[\u4e00-\u9fff]/.test(t)) return false;
  const latin = t.replace(/[^a-zA-Z]/g, '');
  return latin.length >= 3;
}

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
      // industry_zh 不再 push 进 subjects —— 它们是展示用 label，不是 SERP 搜索词；
      // CJK quoted 字符串送 SERP 必 0 命中，反而挤占有效 query 配额。
    }
  }
  if (industryAnchor) {
    subjects.push(...(industryAnchor.en || []));
    // industryAnchor.zh 同上，不进 subjects
  }
  // 统一过 latin filter（双保险，防 zhimao 老 cache 含 CJK 污染 term）
  // + dedupe + 取前 12 条
  const seen = new Set();
  const out = [];
  for (const s of subjects) {
    if (!isLatinSearchSubject(s)) continue;
    const t = String(s).trim();
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  // 兜底：如果过滤后空了（极端情况：用户输入纯中文 + 翻译失败），保留原始
  // category 字面值，让 step1 至少能跑（后续 boolean_queries 仍可能命中）
  if (out.length === 0 && cat) {
    out.push(cat);
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

/**
 * P1 本地化（2026-05-21）：收集目标国母语 boolean_queries（日文/西文/...）。
 * 与 collectBooleanQueries 完全独立通道；step1 的 p_pillar0_boolean pillar
 * 会同时跑英文 + 本地语两批，最大化命中本地买家网站。
 */
function collectLocalBooleanQueries(step0Data, payload) {
  const p = payload || readFullPillar0Payload();
  const fromFile = Array.isArray(step0Data?.pillar0LocalBooleanQueries)
    ? step0Data.pillar0LocalBooleanQueries
    : [];
  const fromPayload = Array.isArray(p.boolean_queries_local) ? p.boolean_queries_local : [];
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

/**
 * P1 本地化：构建本地语 querySubjects（独立于英文 querySubjects）。
 * 用于 step1 multi-lang rotation：让部分 pillar 用本地语 subject 拼 query。
 */
function buildLocalQuerySubjects(step0Data, payload) {
  const p = payload || readFullPillar0Payload();
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const t = String(s || '').trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  // step0 落盘字段优先（zhimao 已生成）
  if (step0Data?.translatedCategory) push(step0Data.translatedCategory);
  if (Array.isArray(step0Data?.pillar0LocalKeywords)) {
    for (const k of step0Data.pillar0LocalKeywords) push(k);
  }
  if (Array.isArray(step0Data?.pillar0LocalPersonas)) {
    for (const k of step0Data.pillar0LocalPersonas) push(k);
  }
  // PILLAR0_PAYLOAD 兜底（极少用，因为 step0 已经把 payload 内容落盘）
  if (Array.isArray(p.expanded_keywords_local)) {
    for (const k of p.expanded_keywords_local) push(k);
  }
  if (Array.isArray(p.buyer_personas)) {
    for (const persona of p.buyer_personas) {
      if (persona && typeof persona.industry_local === 'string') push(persona.industry_local);
    }
  }
  return out.slice(0, 12);
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

/**
 * PR-DEDUP-CACHE L2-2 (2026-05-28): 读 incremental_search 黑名单
 *
 * zhimao 仓 submit route 在 action_type='incremental_search' 时注入：
 *   - incremental_mode: true
 *   - incremental_parent_job_id: <uuid>
 *   - incremental_blacklist_company_ids: string[]
 *
 * v8_direct_l1_ingest.directIngestQualifiedLeads 据此跳过黑名单 company_id
 * 的 discovery_job_leads 写入（不影响 L1 公司主表本身更新；只是不把这些
 * 公司计入本次"增量补抓"的产出）。
 *
 * 性能：Set 查 O(1)；blacklist 上限 1000（submit route 端 slice 截断）。
 *
 * @param {Record<string, unknown>|null} payload
 * @returns {{ enabled: boolean, parentJobId: string|null, blacklistSet: Set<string> }}
 */
function readIncrementalBlacklist(payload) {
  const p = payload || readFullPillar0Payload();
  const enabled = Boolean(p && p.incremental_mode === true);
  if (!enabled) {
    return { enabled: false, parentJobId: null, blacklistSet: new Set() };
  }
  const parentJobId =
    typeof p.incremental_parent_job_id === 'string' ? p.incremental_parent_job_id.trim() : null;
  const raw = Array.isArray(p.incremental_blacklist_company_ids)
    ? p.incremental_blacklist_company_ids
    : [];
  const set = new Set();
  for (const id of raw) {
    const s = String(id || '').trim();
    if (s) set.add(s);
  }
  return { enabled: true, parentJobId, blacklistSet: set };
}

module.exports = {
  readFullPillar0Payload,
  readInlineSeeds,
  buildQuerySubjects,
  buildLocalQuerySubjects,
  quoteSubject,
  pickSubject,
  collectBooleanQueries,
  collectLocalBooleanQueries,
  collectProcurementQueries,
  sanitizeDiscoveryCategory,
  readIncrementalBlacklist,
};
