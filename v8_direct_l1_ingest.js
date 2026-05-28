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
const { inferProcurementSignalCount } = require('./v8_quality_gate');
const { normalizePurchaseCycle } = require('./v8_l1_field_normalize');
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

function stripIcpEvidenceColumns(row) {
  const out = { ...row };
  for (const col of ICP_EVIDENCE_COLUMNS) delete out[col];
  return out;
}

function stripCommerceColumns(row) {
  const out = { ...row };
  for (const col of COMMERCE_COLUMNS) delete out[col];
  return out;
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
      const sigType = String(lead.intent_signal || '').toUpperCase();
      if (sigType === 'BOL_SIGNAL' || sigType === 'CUSTOMS_SIGNAL' || sigType === 'IMPORT_RECORD') {
        sigs.push({ type: 'customs_import', source: 'v8_pipeline', confidence: 0.85, date: nowIso });
      }
      if (sigType === 'PROCUREMENT_DECISION_MAKER') {
        sigs.push({ type: 'social', source: 'v8_pipeline', confidence: 0.7, date: nowIso });
      }
      if (lead.tax_verified) {
        sigs.push({ type: 'customs_import', source: 'v8_tax_verifier', confidence: 0.9, date: nowIso });
      }
      if (lead.verified_source_id) {
        sigs.push({ type: 'website_change', source: 'v8_verified_source', confidence: 0.75, date: nowIso });
      }
      const items = ib && Array.isArray(ib.procurement_items) ? ib.procurement_items : [];
      for (const it of items) {
        if (typeof it === 'string' && it.trim()) {
          sigs.push({ type: 'procurement_item', source: 'v8-l3', detail: it.trim(), date: nowIso });
        } else if (it && typeof it === 'object') {
          const detail = String(it.item || it.name || it.category || '').trim();
          if (detail) sigs.push({ type: 'procurement_item', source: 'v8-l3', detail, date: nowIso });
        }
      }
      if (ib && ib.intent_summary) {
        sigs.push({
          type: 'intent_summary',
          source: 'v8-l3',
          detail: String(ib.intent_summary).slice(0, 500),
          date: nowIso,
        });
      }
      // 禁止 null：显式 null 会绕过 DB DEFAULT 并触发 NOT NULL 约束
      return sigs;
    })(),
  };

  const commerceInput = {
    ...row,
    intent_summary_zh: row.intent_summary || lead.intent_summary_zh || null,
  };
  const { intent_patch, ...commerce } = deriveL1CommerceFields(commerceInput);
  Object.assign(row, commerce, intent_patch);

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
};
