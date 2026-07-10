/**
 * Step2 → Step3 之间的 Top-N 截断：
 * 无论 intake 多少条，只对排序后最好的 N 条跑昂贵 Step3；
 * 溢出条保留轻量字段，Step5 入库后靠更低 confidence 排在后面展示。
 *
 * Env: ENRICH_TOP_N（默认 30；<=0 表示不截断）
 *
 * 贵算力防护：硬噪声（榜单/访谈/商会目录/错配 OEM）在进 Top-N 前直接剔除，
 * 不进 Step3，也不占 ENRICH_TOP_N 名额。
 */
'use strict';

const {
  offCategoryReason,
  categoryRelevanceScore,
  resolveCategory,
} = require('./v8_lib_category_relevance');

const INTENT_SCORE = {
  USER_SEED_INLINE: 35,
  USER_SEED: 32,
  BOL_SIGNAL: 28,
  CUSTOMS_SIGNAL: 28,
  CUSTOMS_DB: 26,
  IMPORT_RECORD: 24,
  PROCUREMENT_DECISION_MAKER: 22,
  PRIVATE_LABEL: 18,
  B2B_BUYER: 16,
  PILLAR0_BOOLEAN: 14,
};

const MATCH_SCORE = { high: 40, medium: 22, low: 8, none: 0 };

/** 标题/公司名像文档、指南、聚合页、平台、展会而非买家公司 */
const JUNK_TITLE_RE =
  /\[?\s*pdf\s*\]?|glossary|guidelines?\b|shipping policy|terms of sale|citizen petition|api\s*docs?|developer docs|importing into the|country requirements|trade facilitation act|comprehensive overview|market size|cagr of|job(s)?\b|vacancies|work from home|wikipedia|how to\b|what is\b|meaning of\b|highest paying|trade mission|rfp\b|visitor registration|apps on google play|online electronic store|industry directory|contract manufacturing services providers|rankings?\b|jun\s+20\d{2}|minimum\s+\d+\s*kg|起订/i;

/** 平台 / 展会 / 媒体 / 海关门户（非目标买家） */
const PLATFORM_TITLE_RE =
  /\b(carousell|facebook|linkedin|google play|youtube|trade show|trade fair|forum\s*&\s*market|exhibition|expo\b|itb\b|atf\b|switch trade|medical\s+fair)\b|海关|singapore customs|customs\.gov|贸易展|展会/i;

/** 榜单 / 访谈 / 商会名录 — 结构性硬噪声（与品类无关，始终可丢） */
const HARD_NOISE_TITLE_RE =
  /\b(membership\s+directory|list\s+of\s+companies|company\s+directory|chamber\s+of\s+commerce|amcham\b|content\s+creator\s+interview|questions\s+with\b|interview\s+with\b|top\s+manufacturing\s+companies|manufacturing\s+companies\s+in\b[^-]*rankings?|20\s+questions\s+with)\b|会员名录|企业名录|商会名录|专访|访谈/i;

/** 域名像目录站 / 媒体 / 占位 / 平台，而非公司官网 */
const JUNK_HOST_RE =
  /\b(seair\.co\.in|importinfo\.com|importyeti\.com|volza\.com|panjiva\.com|trademo\.com|usetorg\.com|indexbox\.io|govtrack\.us|zoom\.us|example\.com|wixpress\.com|sentry-next|freepik|shutterstock|carousell\.com|globalspec\.com|highergov\.com|rxglobal\.com|customs\.gov\.sg|google\.com|play\.google|thesmartlocal\.com|amcham\.com\.sg|mothership\.sg)\b/i;

const PLACEHOLDER_EMAIL_RE =
  /^(user@example\.com|user@domain\.com|info@domain\.com|xxx@organisation\.com|noreply@|no-reply@|orga@|group@thesmartlocal)/i;

/** 邮箱字段被版权串/乱码污染 */
const GARBAGE_EMAIL_RE = /copyright|@organisation\.com$|sales@.+\.sgcopyright/i;

function intentBoost(signal) {
  const key = String(signal || '').toUpperCase();
  if (INTENT_SCORE[key] != null) return INTENT_SCORE[key];
  if (!key) return 0;
  return 6;
}

function pillarBoost(pillar) {
  const p = String(pillar || '');
  if (/Pillar\s*0|Seed/i.test(p)) return 30;
  if (/Pillar\s*10|VerifiedSource/i.test(p)) return 22;
  if (/Pillar\s*7|Customs/i.test(p)) return 18;
  if (/Pillar\s*11|LinkedIn/i.test(p)) return 16;
  if (/Pillar\s*8|B2B/i.test(p)) return 12;
  return 4;
}

function hasUsableDomain(d) {
  if (typeof d !== 'string') return false;
  const cleaned = d.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!cleaned || cleaned.length < 4 || !cleaned.includes('.')) return false;
  return /[a-z]/.test(cleaned) || /^[\d.]+$/.test(cleaned);
}

function hostOf(lead) {
  const raw = String(lead?.domain || lead?.link || lead?.source_url || '').trim();
  if (!raw) return '';
  try {
    const href = raw.startsWith('http') ? raw : `http://${raw}`;
    return new URL(href).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

function leadText(lead) {
  return `${lead?.company_name || ''} ${lead?.snippet || ''} ${lead?.title || ''}`;
}

/**
 * 硬噪声 / 品类错配：进 Top-N / Step3 前剔除（不占贵算力名额）。
 * @param {object} lead
 * @param {string} [category] 用户品类；默认读 DISCOVERY_CATEGORY
 * @returns {string|null} 原因码，或 null 表示可保留
 */
function hardNoiseReason(lead, category) {
  if (!lead || typeof lead !== 'object') return 'empty';
  const title = leadText(lead);
  const host = hostOf(lead);
  const email = String(lead.primary_email || '').trim();

  // 1) 结构性噪声：与品类无关
  if (HARD_NOISE_TITLE_RE.test(title)) return 'directory_or_interview';
  if (/\brankings?\b/i.test(title) && /\b(top|best|companies\s+in)\b/i.test(title)) return 'rankings_list';
  if (host && JUNK_HOST_RE.test(host) && /directory|rankings?|interview|amcham|smartlocal|mothership/i.test(title + host)) {
    return 'junk_host_content';
  }
  if (PLACEHOLDER_EMAIL_RE.test(email) || GARBAGE_EMAIL_RE.test(email)) return 'placeholder_email';

  // 2) 垂直错配：必须对照用户品类（搜护肤时不丢护肤 OEM）
  const off = offCategoryReason(title, category != null ? category : resolveCategory());
  if (off) return off;

  return null;
}

/**
 * 从 intake 列表剔除硬噪声，返回 { clean, rejected, reasons }。
 * @param {object[]} leads
 * @param {string} [category]
 */
function rejectHardNoiseLeads(leads, category) {
  const list = Array.isArray(leads) ? leads : [];
  const cat = category != null ? category : resolveCategory();
  const clean = [];
  const rejected = [];
  const reasons = {};
  for (const lead of list) {
    const why = hardNoiseReason(lead, cat);
    if (why) {
      rejected.push({ ...lead, _hard_noise: why });
      reasons[why] = (reasons[why] || 0) + 1;
    } else {
      clean.push(lead);
    }
  }
  return { clean, rejected, reasons };
}

/**
 * 垃圾/非买家惩罚（负分）。把 PDF 指南、聚合站、占位邮箱等压出 Top-N。
 */
function junkPenalty(lead) {
  if (!lead || typeof lead !== 'object') return 0;
  let pen = 0;
  const title = leadText(lead);
  const host = hostOf(lead);
  const pathHint = String(lead.link || lead.source_url || lead.domain || '').toLowerCase();
  const email = String(lead.primary_email || '').trim();

  if (hardNoiseReason(lead)) pen += 80; // 若未硬剔，排序上也压到底
  if (JUNK_TITLE_RE.test(title)) pen += 35;
  if (PLATFORM_TITLE_RE.test(title)) pen += 40;
  if (/\.pdf(\?|#|$)/i.test(pathHint) || /\[pdf\]/i.test(title)) pen += 25;
  if (host && JUNK_HOST_RE.test(host)) pen += 40;
  if (PLACEHOLDER_EMAIL_RE.test(email) || GARBAGE_EMAIL_RE.test(email)) pen += 45;
  // 纯国家代码 / 过短公司名（如 "SG"、"+ SG"）
  const name = String(lead.company_name || '').trim();
  if (name.length > 0 && name.length <= 3) pen += 25;
  if (/^(sg|us|uk|jp|cn)\b/i.test(name) && name.length < 12 && !/\b(inc|ltd|llc|corp|co)\b/i.test(name)) {
    pen += 15;
  }
  // 无可用域名且无电话 → 富化价值低
  if (!hasUsableDomain(lead.domain) && !(lead.phone || lead.primary_phone) && !lead.place_id) {
    pen += 12;
  }
  // 合同制造 / OEM：仅当与用户品类无关时加重罚（相关则轻罚）
  if (/\b(contract manufacturing|odm services|oem\b|factory outlet)\b/i.test(title)) {
    const rel = categoryRelevanceScore(title);
    pen += rel >= 0.5 ? 8 : 22;
  }
  // 电商零售货架页（非 B2B 买家）
  if (/\b(market\s+fresh\s+pork|bok\s+choy\s+\d|\/pkt\b|add\s+to\s+cart)\b/i.test(title)) {
    pen += 20;
  }
  // 品类相关加分 / 错配惩罚（连续分，配合硬丢）
  const rel = categoryRelevanceScore(title);
  if (rel >= 1) pen -= 15;
  else if (rel >= 0.5) pen -= 8;
  else if (rel < 0) pen += 25;
  return pen;
}

/**
 * 预富化排序分（0–100 量级）。Step3 前尚无 confidence_score / L3，
 * 用 industry_match + 信号源 + pillar + 域名/电话等可观测字段，并扣垃圾分。
 */
function preEnrichRankScore(lead) {
  if (!lead || typeof lead !== 'object') return 0;
  const matchRaw = String(lead.industry_match || '').toLowerCase();
  const matchPts = MATCH_SCORE[matchRaw] != null ? MATCH_SCORE[matchRaw] : 5;
  let score =
    matchPts +
    intentBoost(lead.intent_signal) +
    pillarBoost(lead.pillar) +
    Number(lead.verified_source_boost || 0);

  if (hasUsableDomain(lead.domain)) score += 12;
  if (lead.phone || lead.primary_phone) score += 10;
  if (lead.place_id || lead.maps_url) score += 6;
  if (lead.source_url || lead.link) score += 3;
  if (Array.isArray(lead.social_profile_urls) && lead.social_profile_urls.length) score += 4;

  score -= junkPenalty(lead);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function compareLeads(a, b) {
  const sa = preEnrichRankScore(a);
  const sb = preEnrichRankScore(b);
  if (sb !== sa) return sb - sa;
  const ma = String(a.industry_match || '');
  const mb = String(b.industry_match || '');
  const order = { high: 3, medium: 2, low: 1, none: 0 };
  const da = order[ma] || 0;
  const db = order[mb] || 0;
  if (db !== da) return db - da;
  return String(a.company_name || '').localeCompare(String(b.company_name || ''));
}

/**
 * @param {object[]} leads
 * @param {number} topN  ENRICH_TOP_N；<=0 不截断
 * @returns {{ top: object[], overflow: object[], topN: number, total: number, hardRejected: number, hardReasons: object }}
 */
function splitEnrichTopN(leads, topN, category) {
  const { clean, rejected, reasons } = rejectHardNoiseLeads(leads, category);
  const list = clean.slice();
  const n = Number(topN);
  const total = Array.isArray(leads) ? leads.length : 0;
  const hardRejected = rejected.length;

  if (!Number.isFinite(n) || n <= 0 || list.length <= n) {
    return {
      top: list,
      overflow: [],
      topN: n,
      total,
      hardRejected,
      hardReasons: reasons,
    };
  }
  list.sort(compareLeads);
  // 排序分过低的也不进 Top（避免噪声挤占）
  const MIN_TOP_SCORE = Math.max(0, parseInt(process.env.ENRICH_MIN_TOP_SCORE || '18', 10));
  const eligible = list.filter((l) => preEnrichRankScore(l) >= MIN_TOP_SCORE);
  const weak = list.filter((l) => preEnrichRankScore(l) < MIN_TOP_SCORE);
  const pool = eligible.length >= Math.min(8, n) ? eligible : list;

  const top = pool.slice(0, n).map((lead, i) => ({
    ...lead,
    _enrich_rank: i + 1,
    _pre_enrich_score: preEnrichRankScore(lead),
  }));
  const overflow = [...pool.slice(n), ...weak].map((lead, i) => ({
    ...lead,
    _enrich_deferred: true,
    _enrich_rank: n + i + 1,
    _pre_enrich_score: preEnrichRankScore(lead),
    confidence_score: Math.min(45, Math.max(15, Math.round(preEnrichRankScore(lead) * 0.45))),
  }));
  return { top, overflow, topN: n, total, hardRejected, hardReasons: reasons };
}

function readEnrichTopNFromEnv(env = process.env) {
  const raw = env.ENRICH_TOP_N;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 30;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return 30;
  return n;
}

/**
 * 把溢出线索压成可进 Step4/5 的轻量 lead（跳过 Step3）。
 * 不入 enrichment_queue（_skip_enrichment_queue）。
 */
function materializeOverflowLead(lead, countryCode) {
  const score = Number(lead.confidence_score);
  const confidence = Number.isFinite(score)
    ? score
    : Math.min(45, Math.max(15, Math.round(preEnrichRankScore(lead) * 0.45)));
  return {
    ...lead,
    country: lead.country || countryCode || null,
    confidence_score: confidence,
    _enrich_deferred: true,
    _skip_enrichment_queue: true,
    entity_role: lead.entity_role || null,
  };
}

module.exports = {
  preEnrichRankScore,
  compareLeads,
  splitEnrichTopN,
  readEnrichTopNFromEnv,
  materializeOverflowLead,
  hasUsableDomain,
  junkPenalty,
  hardNoiseReason,
  rejectHardNoiseLeads,
};
