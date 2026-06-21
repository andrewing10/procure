/**
 * 简化版 L1 直写 Supabase — 对齐 catagent bulk 的核心落库语义（不做严格门 / 工商校验 / RFQ）。
 *
 * - L1：自然键 (name_canonical, country)，upsert + ignoreDuplicates（冲突不更新已有行）
 * - 主键列：company_id（PostgREST select 使用 company_id，不用 id）
 * - 边：PURCHASES，to_id = 品类 key（≤32，非 other），from_id = company_id 小写字符串
 * - discovery_job_leads mapping（P1 流式写入 + 增量 result_count）
 * - discovery_job_finalize 由 worker 统一收尾 result_count（不再在此写终态）
 *
 * 表列名需与线上 data_intel_l1_companies / data_intel_graph_edges 一致；若迁移有差异，请改 buildL1Row。
 */

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

/**
 * @param {object} lead — v8 流水线 lead（与 mapToBulkL1Item 同源字段）
 * @param {string} nowIso
 */
function buildL1Row(lead, nowIso) {
  const name = String(lead.company_name || '').trim();
  const name_canonical = normalizeNameCanonical(name);
  const country = normalizeCountry(lead.country);
  const ib = lead.inference_breakdown && typeof lead.inference_breakdown === 'object' ? lead.inference_breakdown : null;

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
    source: 'bulk',
    source_tags: ['bulk_import'],
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

function normalizeQualityGrade(lead) {
  const g = String(lead._quality_grade || 'qualified').toLowerCase();
  if (g === 'premium' || g === 'qualified' || g === 'unqualified') return g;
  return 'qualified';
}

async function upsertJobLeadsMapping(supabase, discoveryJobId, mappings, errors) {
  if (!discoveryJobId || mappings.length === 0) return 0;
  const rows = mappings.map(({ companyId, grade }) => ({
    discovery_job_id: discoveryJobId,
    company_id: companyId,
    quality_grade: grade,
  }));
  const { error } = await supabase
    .from('discovery_job_leads')
    .upsert(rows, { onConflict: 'discovery_job_id,company_id' });
  if (error) {
    errors.push(`discovery_job_leads: ${error.message}`);
    return 0;
  }
  return rows.filter((r) => r.quality_grade !== 'unqualified').length;
}

async function refreshJobResultCount(supabase, discoveryJobId, errors) {
  const { count, error } = await supabase
    .from('discovery_job_leads')
    .select('company_id', { count: 'exact', head: true })
    .eq('discovery_job_id', discoveryJobId)
    .neq('quality_grade', 'unqualified');
  if (error) {
    errors.push(`result_count refresh: ${error.message}`);
    return;
  }
  const { error: jobErr } = await supabase
    .from('discovery_jobs')
    .update({ result_count: count ?? 0 })
    .eq('id', discoveryJobId);
  if (jobErr) errors.push(`discovery_jobs.result_count: ${jobErr.message}`);
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
  let mappedLeads = 0;
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

    const chunkMappings = [];
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
      resolvedPairs.push({ companyId, lead });
      chunkMappings.push({ companyId, grade: normalizeQualityGrade(lead) });

      const edgeBatch = collectEdgeRows(lead, companyId);
      if (edgeBatch.length === 0) continue;
      edgesWritten += await insertEdgesWithFallback(supabase, edgeBatch, errors);
    }

    if (discoveryJobId && chunkMappings.length > 0) {
      mappedLeads += await upsertJobLeadsMapping(supabase, discoveryJobId, chunkMappings, errors);
      await refreshJobResultCount(supabase, discoveryJobId, errors);
    }
  }

  const fatalUpsert = errors.some((e) => String(e).startsWith('L1 upsert:'));
  const noneResolved = leads.length > 0 && resolvedLeads === 0;
  const ok = !fatalUpsert && !noneResolved;
  return {
    ok,
    resolvedLeads,
    mappedLeads,
    edgesWritten,
    resolvedPairs,
    errors,
  };
}

module.exports = {
  directIngestQualifiedLeads,
  normalizeNameCanonical,
  normalizeCategoryToKey,
  buildL1Row,
};
