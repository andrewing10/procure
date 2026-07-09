/**
 * Supabase discovery_enrichment_queue — 异步 Playwright 补 contact（替代 SKIP_SQLITE 本地队列表）。
 */
require('./load-env');
const { createSupabaseClient } = require('./v8_supabase_client');
const { evaluateLead } = require('./v8_quality_gate');
const { normalizeNameCanonical, directIngestQualifiedLeads } = require('./v8_direct_l1_ingest');

const BATCH_SIZE = Math.max(1, Number(process.env.ENRICH_QUEUE_BATCH_SIZE || 20));
const MAX_RETRIES = Math.max(1, Number(process.env.ENRICH_QUEUE_MAX_RETRIES || 3));
const MAX_PER_JOB = Math.max(10, Number(process.env.ENRICH_QUEUE_MAX_PER_JOB || 150));

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createSupabaseClient(url, key);
}

function normalizeCountryIso(country) {
  const c = String(country || '').trim();
  if (c.length === 2 && /^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  return null;
}

/**
 * Step3 主路径：缺 contact 且有 http 域名的 lead 入队（非 fatal）。
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object[]} leads
 * @param {string|null} discoveryJobId
 */
async function enqueueDeferredContacts(supabase, leads, discoveryJobId = null) {
  if (!supabase || !Array.isArray(leads) || leads.length === 0) return { enqueued: 0 };

  const jobId = discoveryJobId || process.env.DISCOVERY_JOB_ID || null;
  const rows = [];

  for (const lead of leads) {
    if (!lead?.company_name) continue;
    const domain = String(lead.domain || '').trim();
    if (!domain.startsWith('http')) continue;
    if (lead.primary_email && lead.primary_phone) continue;
    if (rows.length >= MAX_PER_JOB) break;

    rows.push({
      discovery_job_id: jobId,
      company_name: String(lead.company_name).trim(),
      domain,
      country_iso: normalizeCountryIso(lead.country),
      payload_json: { lead, deferred_at: new Date().toISOString() },
      status: 'pending',
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) return { enqueued: 0 };

  const { error } = await supabase.from('discovery_enrichment_queue').insert(rows);
  if (error) {
    console.warn('[enrich-queue] enqueue failed:', error.message);
    return { enqueued: 0, error: error.message };
  }
  console.log(`[enrich-queue] enqueued ${rows.length} deferred contact jobs (job=${jobId || 'none'})`);
  return { enqueued: rows.length };
}

/**
 * 乐观 claim：pending → processing（多 worker 下可能少量重复，可接受）。
 */
async function claimEnrichmentBatch(supabase, batchSize = BATCH_SIZE) {
  const { data: pending, error } = await supabase
    .from('discovery_enrichment_queue')
    .select('id, discovery_job_id, company_name, domain, country_iso, payload_json, retry_count')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (error) {
    console.warn('[enrich-queue] claim select failed:', error.message);
    return [];
  }
  if (!pending?.length) return [];

  const claimed = [];
  const now = new Date().toISOString();
  for (const row of pending) {
    const { data, error: updErr } = await supabase
      .from('discovery_enrichment_queue')
      .update({ status: 'processing', updated_at: now })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id, discovery_job_id, company_name, domain, country_iso, payload_json, retry_count')
      .maybeSingle();
    if (!updErr && data) claimed.push(data);
  }
  return claimed;
}

async function markQueueRow(supabase, id, status, errorMessage = null) {
  const patch = {
    status,
    updated_at: new Date().toISOString(),
    error_message: errorMessage ? String(errorMessage).slice(0, 1000) : null,
  };
  if (status === 'failed') {
    const { data } = await supabase
      .from('discovery_enrichment_queue')
      .select('retry_count')
      .eq('id', id)
      .maybeSingle();
    patch.retry_count = Number(data?.retry_count ?? 0) + 1;
    if (patch.retry_count < MAX_RETRIES) {
      patch.status = 'pending';
    }
  }
  await supabase.from('discovery_enrichment_queue').update(patch).eq('id', id);
}

/**
 * 异步补 contact 后：升级 L1 + discovery_job_leads（若有关联 job）。
 */
async function applyEnrichedLead(supabase, enrichedLead, discoveryJobId) {
  const { qualified, grade } = evaluateLead(enrichedLead);
  if (!qualified) {
    return { ok: false, reason: 'unqualified_after_enrich' };
  }

  enrichedLead._quality_grade = grade;
  const result = await directIngestQualifiedLeads(supabase, [enrichedLead], {
    discoveryJobId: discoveryJobId || null,
  });
  return { ok: result.ok, ...result };
}

module.exports = {
  getSupabase,
  enqueueDeferredContacts,
  claimEnrichmentBatch,
  markQueueRow,
  applyEnrichedLead,
  BATCH_SIZE,
};
