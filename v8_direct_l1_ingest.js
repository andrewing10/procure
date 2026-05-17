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

const CHUNK_L1 = Math.min(Math.max(Number(process.env.DIRECT_L1_CHUNK || 80), 10), 200);

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
    domain: extractDomain(lead.domain) || null,
    primary_email: lead.primary_email || null,
    primary_phone: lead.primary_phone || null,
    address_line: lead.snippet ? String(lead.snippet).slice(0, 500) : null,
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
    purchase_cycle: ib && ib.purchase_cycle ? String(ib.purchase_cycle).slice(0, 64) : null,
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
      return sigs.length ? sigs : null;
    })(),
  };

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
 * @param {{ discoveryJobId?: string|null }} opts
 */
async function directIngestQualifiedLeads(supabase, leads, opts = {}) {
  const discoveryJobId = opts.discoveryJobId || null;
  const nowIso = new Date().toISOString();
  const errors = [];
  let edgesWritten = 0;
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
    const { data: inserted, error: upErr } = await supabase
      .from('data_intel_l1_companies')
      .upsert(batchPayload, { onConflict: 'name_canonical,country', ignoreDuplicates: true })
      .select('company_id,name_canonical,country');

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
  };
}

module.exports = {
  directIngestQualifiedLeads,
  normalizeNameCanonical,
  normalizeCategoryToKey,
  buildL1Row,
};
