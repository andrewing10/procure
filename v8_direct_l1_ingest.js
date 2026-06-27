/**
 * 简化版 L1 直写 Supabase — 对齐 catagent bulk 的核心落库语义（不做严格门 / 工商校验 / RFQ）。
 *
 * - L1：自然键 (name_canonical, country)，upsert + ignoreDuplicates（冲突不更新已有行）
 * - 主键列：company_id（PostgREST select 使用 company_id，不用 id）
 * - 边：PURCHASES，to_id = 品类 key（≤32，非 other），from_id = company_id 小写字符串
 * - 可选：discovery_jobs.result_count（与 v8_discovery_worker 读表逻辑一致）
 *
 * 表列名需与线上 data_intel_l1_companies / data_intel_graph_edges 一致；若迁移有差异，请改 buildL1Row。
 */

const { upsertJobLeadMapping } = require('./v8_zhimao_contract');
const { inferProcurementSignalCount, inferEntityType } = require('./v8_quality_gate');
const { normalizePurchaseCycle } = require('./v8_l1_field_normalize');
const { buildContactChannels } = require('./v8_lib_channel_spec');
const { readIcpContext } = require('./v8_lib_pillar0');
// P6b：直写 L1 路径不经 zhimao bulk HTTP 路由，故在此处镜像 find_suppliers 的
// trade_role/biz_type 强化（bulk/route.ts 已对 HTTP 路径做同样覆盖）。
const IS_SUPPLIER_MODE = readIcpContext().direction === 'find_suppliers';
// ── buyer-commerce 内联（原 @zhimao/buyer-commerce/l1Commerce.cjs）──────────
// 跨仓 file: 依赖在 Render 单仓部署时不存在，直接内联避免运行时 MODULE_NOT_FOUND。
const PILLAR_DEBUG_RE = /^pillar\s*\d/i;
function _trimOrNull(v) { const s = String(v == null ? '' : v).trim(); return s || null; }
function buildContactBundleFromL1(row) {
  return {
    email: _trimOrNull(row.primary_email),
    phone: _trimOrNull(row.primary_phone),
    website: _trimOrNull(row.domain),
    address: _trimOrNull(row.snippet) || _trimOrNull(row.city),
    maps_place_id: _trimOrNull(row.place_id),
  };
}
function contactabilityFromL1Bundle(bundle, row = {}) {
  let s = 0;
  if (bundle.website) s += 30;
  if (bundle.email)   s += 20;
  if (bundle.phone)   s += 10;
  if (bundle.maps_place_id || bundle.address) s += 20;
  if (Number(row.procurement_score ?? 0) > 0) s += 10;
  return Math.min(100, Math.max(0, s));
}
function inferDataArchetypeFromL1(bundle, row = {}) {
  const via = String(row.discovered_via ?? '').toLowerCase();
  if (via.includes('maps') || via.includes('yellowpages') || via.includes('places')) return 'local_entity';
  if (Number(row.procurement_score ?? 0) >= 40) return 'trade_intel';
  if (bundle.email) return 'contact_graph';
  if (bundle.phone) return 'local_entity';
  return 'contact_graph';
}
function computeSellableSkusFromL1(bundle, row = {}, archetype) {
  if (row.quality_grade === 'unqualified') return ['preview_only'];
  const skus = [];
  if (bundle.email) skus.push('email_reveal');
  if (bundle.phone) skus.push('phone_reveal');
  if (archetype === 'trade_intel' || Number(row.procurement_score ?? 0) >= 35) skus.push('trade_bundle');
  if (!skus.length) skus.push('preview_only');
  return [...new Set(skus)];
}
function sanitizeL1IntentText(raw, fallback) {
  const t = _trimOrNull(raw);
  if (!t || PILLAR_DEBUG_RE.test(t)) return _trimOrNull(fallback);
  return t;
}
function deriveL1CommerceFields(row) {
  const bundle = buildContactBundleFromL1(row);
  const data_archetype = inferDataArchetypeFromL1(bundle, row);
  const sellable_skus = computeSellableSkusFromL1(bundle, row, data_archetype);
  const contactability_score = contactabilityFromL1Bundle(bundle, row);
  const semanticRaw = typeof row.semantic_intent === 'string'
    ? row.semantic_intent
    : Array.isArray(row.semantic_intent) ? row.semantic_intent.join(', ') : null;
  const cleanedSemantic = sanitizeL1IntentText(semanticRaw, row.intent_summary_zh);
  const intent_patch = cleanedSemantic !== _trimOrNull(semanticRaw) ? { semantic_intent: cleanedSemantic } : {};
  return { contact_bundle: bundle, sellable_skus, data_archetype, contactability_score, intent_patch };
}
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_L1 = Math.min(Math.max(Number(process.env.DIRECT_L1_CHUNK || 80), 10), 200);

/** zhimao 迁移 20260625100000；未部署时 PostgREST 报 PGRST204，step5 会 HALT */
const ICP_EVIDENCE_COLUMNS = ['industry_match', 'industry_evidence', 'category_key'];

/** zhimao 迁移 20260626120000 + 20260626130000；未部署时 strip 后由 DB 触发器补写 */
const COMMERCE_COLUMNS = ['contact_bundle', 'sellable_skus', 'data_archetype', 'contactability_score'];

/** entity_type 列（读路径 dataIntelPublic 已依赖，正常必存在）；旧库缺列时 strip 兜底 */
const ENTITY_TYPE_COLUMNS = ['entity_type'];

/** zhimao 迁移 20260793000000；未部署时 strip 后照常入库（channels 仅缺展示，不阻断） */
const CHANNELS_COLUMNS = ['contact_channels'];

function stripIcpEvidenceColumns(row) {
  const out = { ...row };
  for (const col of ICP_EVIDENCE_COLUMNS) delete out[col];
  return out;
}

function stripEntityTypeColumns(row) {
  const out = { ...row };
  for (const col of ENTITY_TYPE_COLUMNS) delete out[col];
  return out;
}

function isMissingEntityTypeColumnError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (err?.code !== 'PGRST204' && !msg.includes('schema cache')) return false;
  return ENTITY_TYPE_COLUMNS.some((col) => msg.includes(col));
}

function stripCommerceColumns(row) {
  const out = { ...row };
  for (const col of COMMERCE_COLUMNS) delete out[col];
  return out;
}

function stripChannelsColumns(row) {
  const out = { ...row };
  for (const col of CHANNELS_COLUMNS) delete out[col];
  return out;
}

function isMissingChannelsColumnError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (err?.code !== 'PGRST204' && !msg.includes('schema cache')) return false;
  return CHANNELS_COLUMNS.some((col) => msg.includes(col));
}

function isMissingIcpColumnError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (err?.code !== 'PGRST204' && !msg.includes('schema cache')) return false;
  return ICP_EVIDENCE_COLUMNS.some((col) => msg.includes(col));
}

function isMissingCommerceColumnError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (err?.code !== 'PGRST204' && !msg.includes('schema cache')) return false;
  return COMMERCE_COLUMNS.some((col) => msg.includes(col));
}

async function upsertL1Chunk(supabase, batchPayload) {
  let payload = batchPayload;
  let res = await supabase
    .from('data_intel_l1_companies')
    .upsert(payload, { onConflict: 'name_canonical,country', ignoreDuplicates: true })
    .select('company_id,name_canonical,country');
  if (res.error && isMissingIcpColumnError(res.error)) {
    console.warn(
      '[direct-l1] ICP columns missing on DB; retrying without industry_match/evidence/category_key. ' +
        'Deploy zhimao migration 20260625100000_l1_industry_match_columns.sql',
    );
    payload = batchPayload.map(stripIcpEvidenceColumns);
    res = await supabase
      .from('data_intel_l1_companies')
      .upsert(payload, { onConflict: 'name_canonical,country', ignoreDuplicates: true })
      .select('company_id,name_canonical,country');
  }
  if (res.error && isMissingCommerceColumnError(res.error)) {
    console.warn(
      '[direct-l1] commerce columns missing; retrying without contact_bundle/sellable_skus. ' +
        'Deploy zhimao migrations 20260626120000_buyer_commerce_entity.sql + 20260626130000_l1_commerce_ingest_trigger.sql',
    );
    payload = payload.map(stripCommerceColumns);
    res = await supabase
      .from('data_intel_l1_companies')
      .upsert(payload, { onConflict: 'name_canonical,country', ignoreDuplicates: true })
      .select('company_id,name_canonical,country');
  }
  if (res.error && isMissingEntityTypeColumnError(res.error)) {
    console.warn('[direct-l1] entity_type column missing; retrying without entity_type.');
    payload = payload.map(stripEntityTypeColumns);
    res = await supabase
      .from('data_intel_l1_companies')
      .upsert(payload, { onConflict: 'name_canonical,country', ignoreDuplicates: true })
      .select('company_id,name_canonical,country');
  }
  if (res.error && isMissingChannelsColumnError(res.error)) {
    console.warn(
      '[direct-l1] contact_channels column missing; retrying without it. ' +
        'Deploy zhimao migration 20260793000000_l1_contact_channels.sql',
    );
    payload = payload.map(stripChannelsColumns);
    res = await supabase
      .from('data_intel_l1_companies')
      .upsert(payload, { onConflict: 'name_canonical,country', ignoreDuplicates: true })
      .select('company_id,name_canonical,country');
  }
  return res;
}

function normalizeNameCanonical(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return '';
  return s.length > 500 ? s.slice(0, 500) : s;
}

function normalizeCountry(country) {
  const c = String(country || '').trim();
  if (c.length === 2) return c.toUpperCase();
  return c;
}

// ── 国家推断（与 zhimao quality.ts inferActualCountryFromSignals 对齐） ────────
const _CCTLD_TO_ISO = {
  us: 'US', cn: 'CN', sg: 'SG', my: 'MY', th: 'TH', vn: 'VN', id: 'ID', ph: 'PH',
  jp: 'JP', kr: 'KR', uk: 'GB', gb: 'GB', de: 'DE', fr: 'FR', it: 'IT', es: 'ES',
  ca: 'CA', au: 'AU', ch: 'CH', br: 'BR', in: 'IN', tr: 'TR', ae: 'AE', sa: 'SA',
};
const _CALLING_CODE_TO_ISO = {
  '1': 'US', '86': 'CN', '65': 'SG', '60': 'MY', '66': 'TH', '84': 'VN', '62': 'ID',
  '63': 'PH', '81': 'JP', '82': 'KR', '44': 'GB', '49': 'DE', '33': 'FR', '39': 'IT',
  '34': 'ES', '61': 'AU', '41': 'CH', '55': 'BR', '91': 'IN', '90': 'TR', '971': 'AE', '966': 'SA',
};

/**
 * 从域名 ccTLD / 电话国际区号推断公司实际所在国；
 * 与 zhimao quality.ts inferActualCountryFromSignals 逻辑一致，解决 country 字段分叉问题。
 * @param {{ searchCountry?: string, domain?: string|null, phone?: string|null }} params
 * @returns {string|null} 两位 ISO 或 null
 */
function inferActualCountryFromSignals({ searchCountry, domain, phone }) {
  // 1. 先尝试域名 ccTLD
  if (domain) {
    try {
      const host = new URL(domain.startsWith('http') ? domain : `https://${domain}`).hostname.toLowerCase();
      const suffix = host.split('.').pop();
      const fromTld = suffix ? _CCTLD_TO_ISO[suffix] : null;
      if (fromTld) return fromTld;
    } catch { /* ignore */ }
  }
  // 2. 再尝试电话区号
  if (phone) {
    const m = String(phone).trim().match(/^\+(\d{1,3})/);
    if (m) {
      const fromPhone = _CALLING_CODE_TO_ISO[m[1]];
      if (fromPhone) return fromPhone;
    }
  }
  // 3. 回落到搜索目标国
  return searchCountry ? normalizeCountry(searchCountry) : null;
}

function extractDomain(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const h = u.hostname.replace(/^www\./i, '');
    return h || null;
  } catch {
    const part = s.replace(/^www\./i, '').split('/')[0];
    return part || null;
  }
}

/**
 * 证据出处 URL 规范化：保留完整可点击 http(s) 链接（区别于 extractDomain 只取域名）。
 * 用于 procurement_signals[].source_url，让 zhimao 命中卡的信号 chip 能 ↗ 跳到证据页。
 * 仅接受 http/https、补全裸域名为 https://、截断 ≤500（与 social_profile_urls 列宽对齐）。
 */
function normalizeEvidenceUrl(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s || s.length > 2000) return null;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const out = u.toString();
    return out.length <= 500 ? out : out.slice(0, 500);
  } catch {
    return null;
  }
}

/**
 * 证据出处 URL 分级解析（行业级单源）。一条 lead 不同来源档的可用锚点不同，
 * 按「精确证据页 > 地图深链 > 社媒主页 > 公司主页 > 地图按名搜索」优先级取首个可用：
 *   1. source_url —— 信号源站 / LinkedIn / 海关聚合站 / 社媒公开主页等真实证据页（link=null 时唯一锚点）
 *   2. link       —— organic 精确命中页（公司页本身即 snippet 出处）
 *   3. maps_url   —— Google Maps 深链（LBS 命中买家的天然出处，cid/place_id 派生）
 *   4. place_id   —— 退化构造 Maps place 深链
 *   5. social_profile_urls[0] —— 社媒公开主页（FB/YT/X/TG pillar）
 *   6. https://{domain} —— 退化到公司主页（organic 仅剩 domain 时的诚实出处）
 *   7. Maps 按名搜索 —— 仅地图档 lead 的最后兜底：name+country 生成 Google Maps 搜索深链，
 *                       让用户能定位该商家（明确是"地图查找"而非精确证据页，不虚标为来源页）。
 * 返回 { url, kind } 或 null。kind 用于读侧区分 ↗(来源页) / 📍(地图查找)。
 */
function resolveEvidenceUrl(lead) {
  const direct = normalizeEvidenceUrl(lead.source_url || lead.link || null);
  if (direct) return { url: direct, kind: 'source_page' };
  const maps = normalizeEvidenceUrl(lead.maps_url || null);
  if (maps) return { url: maps, kind: 'maps_place' };
  const pid = lead.place_id ? String(lead.place_id).trim() : '';
  if (pid) return { url: `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(pid)}`, kind: 'maps_place' };
  if (Array.isArray(lead.social_profile_urls)) {
    for (const u of lead.social_profile_urls) {
      const s = normalizeEvidenceUrl(u);
      if (s) return { url: s, kind: 'social_profile' };
    }
  }
  const dom = extractDomain(lead.domain);
  if (dom) return { url: `https://${dom}`, kind: 'company_home' };
  // 地图档（LBS）最后兜底：仅剩 name+country 时给 Maps 按名搜索深链。
  const sigType = String(lead.intent_signal || '').toUpperCase();
  const isMapsLead = /MAP_|TRADING_COMPANY|PERSONA_VERIFIED|MAP_VERIFIED/.test(sigType)
    || /Pillar 1 LBS/i.test(String(lead.pillar || ''));
  if (isMapsLead) {
    const name = String(lead.company_name || '').trim();
    const cc = String(lead.country || '').trim();
    if (name) {
      const q = encodeURIComponent(cc ? `${name} ${cc}` : name);
      return { url: `https://www.google.com/maps/search/?api=1&query=${q}`, kind: 'maps_lookup' };
    }
  }
  return null;
}

/** 对齐 bulk 文档：normalizeCategoryToKey 的极简版（小写、非字母数字→_、trim、≤32、排除 other）。 */
function normalizeCategoryToKey(cat) {
  const raw = String(cat || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!raw || raw === 'other') return null;
  const k = raw.slice(0, 32);
  return k.length ? k : null;
}

function canonicalKey(nameCanonical, country) {
  return `${nameCanonical}\u0000${country}`;
}

/** 将 V8 entity_role → zhimao biz_type（C1 对齐，允许 importer/wholesaler/retailer/distributor/manufacturer/service/unknown） */
function mapEntityRoleToBizType(entityRole) {
    const role = String(entityRole || '').trim().toLowerCase();
    if (!role) return null;
    const map = {
        importer: 'importer',
        'import company': 'importer',
        'trading company': 'wholesaler',
        trader: 'wholesaler',
        wholesaler: 'wholesaler',
        wholesale: 'wholesaler',
        retailer: 'retailer',
        retail: 'retailer',
        distributor: 'distributor',
        distribution: 'distributor',
        manufacturer: 'manufacturer',
        factory: 'manufacturer',
        'service provider': 'service',
        service: 'service',
        buyer: 'importer',
    };
    return map[role] || 'unknown';
}

/**
 * @param {object} lead — v8 流水线 lead（与 mapToBulkL1Item 同源字段）
 * @param {string} nowIso
 */
/**
 * 买家抓取矩阵（Batch 3）：根据 lead.pillar / lead._gmaps_source 推导 discovered_via 标签。
 * 与 zhimao apps/web/lib/discovery/matrixDefaults KNOWN_PLATFORMS 标签集对齐。
 */
function inferDiscoveredVia(lead) {
  const pillar = String(lead.pillar || '');
  if (lead._gmaps_source) return 'maps';
  if (/Pillar 1 LBS|Maps/i.test(pillar)) return 'maps';
  if (/Pillar Yellow/i.test(pillar)) return 'yellowpages';
  if (/Pillar FB Public/i.test(pillar)) return 'facebook_public';
  if (/Pillar 11 LinkedIn/i.test(pillar)) return 'linkedin_snippet';
  if (/Pillar YT About/i.test(pillar)) return 'youtube_about';
  if (/Pillar X Public/i.test(pillar)) return 'x_public';
  if (/Pillar TG Public/i.test(pillar)) return 'telegram_public';
  if (/Pillar 0 Seed/i.test(pillar)) return 'seed';
  if (/Pillar 9 Lookalike/i.test(pillar)) return 'lookalike';
  // P6b 供应商目录 / 工厂直采 pillar 标签（与 zhimao matrixDefaults SUPPLIER_PLATFORMS 对齐）
  if (/Pillar S MadeInChina/i.test(pillar)) return 'made_in_china';
  if (/Pillar S GlobalSources/i.test(pillar)) return 'global_sources';
  if (/Pillar S ThomasNet/i.test(pillar)) return 'thomasnet';
  if (/Pillar S Alibaba/i.test(pillar)) return 'alibaba_intl';
  if (/Pillar S Factory|Pillar S Exporter/i.test(pillar)) return 'supplier_direct';
  if (pillar) return 'organic_search';
  return null;
}

function buildL1Row(lead, nowIso) {
  const name = String(lead.company_name || '').trim();
  const name_canonical = normalizeNameCanonical(name);
  // 使用 inferActualCountryFromSignals（与 zhimao bulk 路径对齐），解决 country 字段分叉问题
  const country = inferActualCountryFromSignals({
    searchCountry: lead.country,
    domain: lead.domain || null,
    phone: lead.primary_phone || null,
  }) || normalizeCountry(lead.country);
  const ib = lead.inference_breakdown && typeof lead.inference_breakdown === 'object' ? lead.inference_breakdown : null;
  const qualityGrade = lead._quality_grade || 'qualified';

    /** 与当前线上 data_intel_l1_companies 列一致（无单独 name / company_name 列）。 */
  const row = {
    name_canonical,
    country,
    // 买家抓取矩阵 Batch 3：city / maps_url / place_id / social_profile_urls / discovered_via
    city: (lead._city && String(lead._city).slice(0, 120)) || (ib && ib.city ? String(ib.city).slice(0, 120) : null) || null,
    maps_url: lead.maps_url ? String(lead.maps_url).slice(0, 500) : null,
    place_id: lead.place_id ? String(lead.place_id).slice(0, 200) : null,
    social_profile_urls: Array.isArray(lead.social_profile_urls)
      ? lead.social_profile_urls.filter((u) => typeof u === 'string' && u.length <= 500).slice(0, 8)
      : [],
    discovered_via: inferDiscoveredVia(lead),
    // Batch A.4：ICP 闸门 4 个新列（迁移 20260625100000）
    industry_match: (() => {
      const m = String(lead.industry_match || '').toLowerCase();
      return ['high', 'medium', 'low', 'none'].includes(m) ? m : null;
    })(),
    industry_evidence: (() => {
      const ev = lead.industry_evidence;
      if (!ev || typeof ev !== 'object') return {};
      const out = {};
      if (typeof ev.reason === 'string' && ev.reason.trim()) out.reason = ev.reason.trim().slice(0, 200);
      if (typeof ev.extracted_industry === 'string' && ev.extracted_industry.trim()) {
        out.extracted_industry = ev.extracted_industry.trim().slice(0, 80);
      }
      if (typeof ev.source_text === 'string' && ev.source_text.trim()) {
        out.source_text = ev.source_text.trim().slice(0, 400);
      }
      return out;
    })(),
    category_key: lead.category_key ? String(lead.category_key).slice(0, 64) : null,
    industry_key: lead.industry_key ? String(lead.industry_key).slice(0, 64) : null,
    domain: extractDomain(lead.domain) || null,
    primary_email: lead.primary_email || null,
    primary_phone: lead.primary_phone || null,
    // address_line 必须是真实地址：仅在 Google Places 等真实地址源命中时填写。
    // 严禁灌入 step1 搜索 snippet（搜索摘要会是文章/词典/营销文案，造成"地址=法律定义"等问题）。
    // 原始 snippet 仍写入 .snippet 字段，供调试追溯，但前端展示层只取 address_line。
    address_line: (lead._gmaps_address || lead.formatted_address || null) || null,
    place_type: lead.entity_role || null,
    // 入库即落 entity_type（根治 NULL 行被读路径 .neq 误杀的雷；zhimao 读路径仍保留
    // NULL-safe 兜底做防御层）。Pillar 0 seed/HVC 跳过 evaluateLead，此处补判可挡住
    // 漏网的 aggregator/social/media。与 zhimao quality.ts inferEntityType 同源。
    entity_type: inferEntityType({
      domain: lead.domain || null,
      snippet: lead.snippet || null,
      companyName: lead.company_name || name_canonical || null,
      primaryEmail: lead.primary_email || null,
      category: lead.category || lead.category_key || process.env.DISCOVERY_CATEGORY || null,
    }) || null,
    snippet: lead.snippet ? String(lead.snippet).slice(0, 2000) : null,
    source: 'v8_pipeline',
    source_tags: ['v8_pipeline'],
    landed_at: nowIso,
    updated_at: nowIso,
    l1_updated_at: nowIso,
    confidence_score: (() => {
      if (lead.confidence_score == null || lead.confidence_score === '') return null;
      const n = Number(lead.confidence_score);
      return Number.isFinite(n) ? n : null;
    })(),
    semantic_intent: Array.isArray(lead.inferred_bom) && lead.inferred_bom.length ? lead.inferred_bom : null,
    inference_breakdown: ib || null,
    intent_summary: ib && ib.intent_summary ? String(ib.intent_summary).slice(0, 4000) : null,
    purchase_cycle: normalizePurchaseCycle(ib && ib.purchase_cycle),
    event_timestamp: lead.source_timestamp ? String(lead.source_timestamp) : nowIso,
    quality_grade: qualityGrade,
    // ── C1 新增字段 ────────────────────────────────────────────────────────
    biz_type: mapEntityRoleToBizType(
      (ib && ib.entity_role) || lead.entity_role || null,
    ),
    procurement_score: (() => {
      const sigCount = inferProcurementSignalCount(lead);
      // 基础评分：信号数 × 20，上限 100
      // BOL/CUSTOMS = 高权重；tax_verified = 中权重
      let score = sigCount * 20;
      if (lead.tax_verified) score = Math.max(score, 40);
      const boostScore = Number(lead.verified_source_boost || 0);
      score = Math.min(100, score + boostScore);
      return Math.max(0, score);
    })(),
    procurement_signals: (() => {
      const sigs = [];
      // 证据出处（zhimao 命中卡「信号 chip 挂 source_url ↗/📍」+ 证据卡数据源）：
      // 用分级解析器按来源档取首个可用锚点（见 resolveEvidenceUrl）。source_kind 让读侧
      // 区分「来源页 ↗」与「地图查找 📍」，避免把 Maps 按名搜索误标成精确证据页。
      const evidence = resolveEvidenceUrl(lead);
      const withUrl = (sig) =>
        evidence ? { ...sig, source_url: evidence.url, source_kind: evidence.kind } : sig;
      const sigType = String(lead.intent_signal || '').toUpperCase();
      if (sigType === 'BOL_SIGNAL' || sigType === 'CUSTOMS_SIGNAL' || sigType === 'IMPORT_RECORD') {
        sigs.push(withUrl({ type: 'customs_import', source: 'v8_pipeline', confidence: 0.85, date: nowIso }));
      }
      if (sigType === 'PROCUREMENT_DECISION_MAKER') {
        sigs.push(withUrl({ type: 'social', source: 'v8_pipeline', confidence: 0.7, date: nowIso }));
      }
      if (lead.tax_verified) {
        sigs.push(withUrl({ type: 'customs_import', source: 'v8_tax_verifier', confidence: 0.9, date: nowIso }));
      }
      if (lead.verified_source_id) {
        sigs.push(withUrl({ type: 'website_change', source: 'v8_verified_source', confidence: 0.75, date: nowIso }));
      }
      const items = ib && Array.isArray(ib.procurement_items) ? ib.procurement_items : [];
      for (const it of items) {
        if (typeof it === 'string' && it.trim()) {
          sigs.push(withUrl({ type: 'procurement_item', source: 'v8-l3', detail: it.trim(), date: nowIso }));
        } else if (it && typeof it === 'object') {
          const detail = String(it.item || it.name || it.category || '').trim();
          if (detail) sigs.push(withUrl({ type: 'procurement_item', source: 'v8-l3', detail, date: nowIso }));
        }
      }
      if (ib && ib.intent_summary) {
        sigs.push(withUrl({
          type: 'intent_summary',
          source: 'v8-l3',
          detail: String(ib.intent_summary).slice(0, 500),
          date: nowIso,
        }));
      }
      // 禁止 null：显式 null 会绕过 DB DEFAULT 并触发 NOT NULL 约束
      return sigs;
    })(),
  };

  // P6b：供应商方向强化（镜像 bulk/route.ts）。直写路径无 inferTradeRole，
  // 供应商 pillar 命中的公司本就是供应商：trade_role=supplier，biz_type 兜底 manufacturer。
  if (IS_SUPPLIER_MODE) {
    if (!row.biz_type || row.biz_type === 'unknown') row.biz_type = 'manufacturer';
    row.trade_role = 'supplier';
  }

  const commerceInput = {
    ...row,
    intent_summary_zh: row.intent_summary || lead.intent_summary_zh || null,
  };
  const { intent_patch, ...commerce } = deriveL1CommerceFields(commerceInput);
  Object.assign(row, commerce, intent_patch);

  // B3：把买家可达渠道「开放集合」合成进 L1（不写死成 email/phone/WA）。
  // 来源：L1 现有 primary_email/phone + lead.primary_whatsapp + social_profile_urls
  //       + step3 enricher 产出的 channels（lead._enricher_channels）。
  row.contact_channels = buildContactChannels({
    email: row.primary_email,
    phone: row.primary_phone,
    whatsapp: lead.primary_whatsapp || null,
    socialUrls: row.social_profile_urls,
    extraChannels: Array.isArray(lead._enricher_channels) ? lead._enricher_channels : [],
  });

  Object.keys(row).forEach((k) => {
    if (row[k] === undefined) delete row[k];
  });
  return row;
}

function collectEdgeRows(lead, companyId) {
  const fromId = String(companyId).toLowerCase();
  const keys = new Set();
  const edges = [];
  const bom = Array.isArray(lead.inferred_bom) ? lead.inferred_bom : [];
  for (const c of bom) {
    const toId = normalizeCategoryToKey(c);
    if (!toId) continue;
    const dedupe = `${fromId}|${toId}|PURCHASES`;
    if (keys.has(dedupe)) continue;
    keys.add(dedupe);
    edges.push({
      from_id: fromId,
      to_id: toId,
      edge_type: 'PURCHASES',
      weight: 1,
      snapshot_version: 'v1',
    });
  }
  return edges;
}

async function insertEdgesWithFallback(supabase, edgeBatch, errors) {
  if (!edgeBatch.length) return 0;
  const { error } = await supabase.from('data_intel_graph_edges').insert(edgeBatch);
  if (!error) return edgeBatch.length;
  let written = 0;
  for (const one of edgeBatch) {
    const { error: e1 } = await supabase.from('data_intel_graph_edges').insert(one);
    if (!e1) written += 1;
    else if (!/duplicate|unique|23505/i.test(String(e1.message || ''))) {
      errors.push(`edge: ${e1.message}`);
    }
  }
  return written;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object[]} leads — 已通过 Step5 isQualifiedLead 的列表
 * @param {{
 *   discoveryJobId?: string|null,
 *   incrementalMode?: boolean,
 *   incrementalParentJobId?: string|null,
 *   incrementalBlacklistSet?: Set<string>,
 * }} opts
 *
 * PR-DEDUP-CACHE L2-2 (2026-05-28)：
 *   incrementalMode=true 时，命中 incrementalBlacklistSet 的 company_id
 *   不写 discovery_job_leads 映射（即"已存在于 parent job 的公司"不计入本次"增量补抓"
 *   的产出）。L1 公司主表照常 upsert，避免丢失新拿到的字段更新（如新发现的 email/phone）。
 *   返回 result.incrementalSkipped 给 step5 输出日志。
 */
async function directIngestQualifiedLeads(supabase, leads, opts = {}) {
  const discoveryJobId = opts.discoveryJobId || null;
  const incrementalMode = Boolean(opts.incrementalMode);
  const blacklistSet =
    opts.incrementalBlacklistSet instanceof Set ? opts.incrementalBlacklistSet : new Set();
  const nowIso = new Date().toISOString();
  const errors = [];
  let edgesWritten = 0;
  let incrementalSkipped = 0;
  /** 本批每条 lead 是否解析到 company id（含已存在自然键） */
  let resolvedLeads = 0;
  /** @type {Array<{ companyId: string, lead: object }>} */
  const resolvedPairs = [];

  for (let i = 0; i < leads.length; i += CHUNK_L1) {
    const chunk = leads.slice(i, i + CHUNK_L1);
    const rows = [];
    for (const lead of chunk) {
      const r = buildL1Row(lead, nowIso);
      if (!r.name_canonical || !r.country) {
        errors.push(`skip: empty name_canonical/country in chunk @${i}`);
        continue;
      }
      rows.push({ lead, row: r });
    }

    if (rows.length === 0) continue;

    const batchPayload = rows.map((x) => x.row);
    const { data: inserted, error: upErr } = await upsertL1Chunk(supabase, batchPayload);

    if (upErr) {
      errors.push(`L1 upsert: ${upErr.message}`);
      continue;
    }

    const idByKey = new Map();
    for (const rec of inserted || []) {
      idByKey.set(canonicalKey(rec.name_canonical, rec.country), rec.company_id);
    }

    for (const { lead, row } of rows) {
      const k = canonicalKey(row.name_canonical, row.country);
      let companyId = idByKey.get(k);
      if (!companyId) {
        const { data: ex, error: selErr } = await supabase
          .from('data_intel_l1_companies')
          .select('company_id')
          .eq('name_canonical', row.name_canonical)
          .eq('country', row.country)
          .maybeSingle();
        if (selErr) {
          errors.push(`L1 select company_id: ${selErr.message}`);
          continue;
        }
        companyId = ex?.company_id;
      }
      if (!companyId) {
        errors.push(`no company_id for name_canonical=${row.name_canonical} / ${row.country}`);
        continue;
      }
      idByKey.set(k, companyId);
      resolvedLeads += 1;
      resolvedPairs.push({ companyId, lead });

      if (discoveryJobId) {
        // PR-DEDUP-CACHE L2-2：增量补抓模式下命中 blacklist 的公司跳过映射写入。
        //   语义：这家公司在 parent job 已经被抓到过，不计入本次"增量补抓"的产出
        //   （但 L1 公司主表上面已经 upsert 过 — 字段新发现的信息保留）。
        if (incrementalMode && blacklistSet.has(String(companyId))) {
          incrementalSkipped += 1;
        } else {
          const mapRes = await upsertJobLeadMapping(
            supabase,
            discoveryJobId,
            companyId,
            lead._quality_grade || 'qualified',
          );
          if (!mapRes.ok) {
            errors.push(`discovery_job_leads: ${mapRes.error?.message || 'upsert_failed'}`);
          }
        }
      }

      const edgeBatch = collectEdgeRows(lead, companyId);
      if (edgeBatch.length === 0) continue;
      edgesWritten += await insertEdgesWithFallback(supabase, edgeBatch, errors);
    }
  }

  // result_count / status=done 由 worker 调 discovery_job_finalize 统一收尾（按 mapping 真实行数统计）。
  // 此处仅保留 resolvedLeads 供 step5 日志；不再直写 jobs.result_count，避免与 finalize 双写打架。

  const fatalUpsert = errors.some((e) => String(e).startsWith('L1 upsert:'));
  const noneResolved = leads.length > 0 && resolvedLeads === 0;
  const ok = !fatalUpsert && !noneResolved;
  return {
    ok,
    resolvedLeads,
    resolvedPairs,
    edgesWritten,
    errors,
    incrementalSkipped,
  };
}

module.exports = {
  directIngestQualifiedLeads,
  normalizeNameCanonical,
  normalizeCategoryToKey,
  buildL1Row,
  inferDiscoveredVia,
};
