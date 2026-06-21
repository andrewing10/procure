/**
 * zhimao 平台契约辅助（procure worker / step5 共用）
 *
 * 生产架构：V8 矩阵 **直写 Supabase**（v8_direct_l1_ingest），不走 HTTP bulk。
 * 本模块把 B1+ 平台侧 RPC/字段与现网 worker 对齐：
 *   - discovery_job_record_stage
 *   - discovery_job_finalize
 *   - pipeline_version lineage（与 zhimao assertOrFallback 一致）
 */

const V8_SUPPORTED_ISO2 = new Set([
  'AE', 'AR', 'AT', 'AU', 'BD', 'BE', 'BG', 'BH', 'BR', 'CA', 'CH', 'CL', 'CN', 'CO', 'CY', 'CZ',
  'DE', 'DK', 'EE', 'EG', 'ES', 'ET', 'FI', 'FR', 'GB', 'GH', 'HK', 'HR', 'HU', 'ID', 'IE', 'IL',
  'IN', 'IS', 'IT', 'JO', 'JP', 'KE', 'KH', 'KR', 'KW', 'LK', 'LT', 'LU', 'LV', 'MM', 'MO', 'MT',
  'MX', 'MY', 'NG', 'NL', 'NO', 'NP', 'NZ', 'OM', 'PE', 'PH', 'PK', 'PL', 'PT', 'QA', 'RO', 'RU',
  'SA', 'SE', 'SG', 'SI', 'SK', 'TH', 'TR', 'TW', 'US', 'VN', 'ZA',
]);

const DEFAULT_PIPELINE_VERSION = 'v8';

function resolvePipelineVersion(jobOrIso) {
  const iso = typeof jobOrIso === 'string'
    ? jobOrIso
    : String(jobOrIso?.country_iso || '').trim().toUpperCase();
  const payload = jobOrIso && typeof jobOrIso === 'object' ? jobOrIso.action_payload : null;
  const fromPayload = payload && typeof payload === 'object' && payload.pipeline_version
    ? String(payload.pipeline_version).trim()
    : '';
  if (fromPayload) return fromPayload;
  const suffix = V8_SUPPORTED_ISO2.has(iso) ? '' : '.fallback';
  return `${DEFAULT_PIPELINE_VERSION}${suffix}`;
}

async function recordStage(supabase, jobId, stage, payload = null) {
  if (!jobId || !stage) return { ok: false };
  const { data, error } = await supabase.rpc('discovery_job_record_stage', {
    p_job_id: jobId,
    p_stage: stage,
    p_claimed_by: process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || 'procure-worker',
    p_payload: payload,
  });
  if (error) {
    console.warn(`[zhimao-contract] record_stage ${stage}:`, error.message);
    return { ok: false, error };
  }
  if (data && data.no_op) {
    console.log(`[zhimao-contract] record_stage ${stage} no_op:`, data.reason || data.current_status);
  }
  return { ok: true, data };
}

async function finalizeJob(supabase, job, errorSummary = null) {
  const pipelineVersion = resolvePipelineVersion(job);
  const { data, error } = await supabase.rpc('discovery_job_finalize', {
    p_job_id: job.id,
    p_pipeline_version: pipelineVersion,
    p_error_summary: errorSummary,
  });
  if (error) {
    console.warn('[zhimao-contract] discovery_job_finalize failed:', error.message);
    return { ok: false, error };
  }
  if (data && data.no_op) {
    console.log('[zhimao-contract] finalize no_op:', data.reason || data.current_status);
  }
  return { ok: true, data, pipelineVersion };
}

async function failJob(supabase, jobId, errorCode) {
  const msg = String(errorCode || 'pipeline_failed').slice(0, 1000);
  const stageRes = await recordStage(supabase, jobId, 'failed', { error_message: msg });
  if (!stageRes.ok) {
    const { error } = await supabase
      .from('discovery_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: msg,
      })
      .eq('id', jobId)
      .in('status', ['pending', 'running', 'claimed', 'fetching', 'parsing', 'scoring', 'persisting']);
    if (error) console.error('[zhimao-contract] failJob fallback:', error.message);
  }
  return { ok: true };
}

async function isJobCancelled(supabase, jobId) {
  const { data, error } = await supabase
    .from('discovery_jobs')
    .select('status')
    .eq('id', jobId)
    .maybeSingle();
  if (error) return false;
  return data?.status === 'cancelled';
}

async function releaseStaleClaims(supabase, staleSeconds = 900) {
  const { data, error } = await supabase.rpc('release_stale_discovery_claims', {
    p_stale_seconds: staleSeconds,
  });
  if (error) {
    console.warn('[zhimao-contract] release_stale_discovery_claims failed:', error.message);
    return { ok: false, error };
  }
  return { ok: true, released: Number(data || 0) };
}

async function claimNextDiscoveryJob(supabase, workerId) {
  const { data, error } = await supabase.rpc('claim_next_discovery_job', {
    p_worker_id: workerId || process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || 'procure-worker',
  });
  if (error) {
    console.warn('[zhimao-contract] claim_next_discovery_job failed:', error.message);
    return { ok: false, error };
  }
  if (!data || data.ok !== true) {
    return { ok: true, job: null, reason: data?.reason || 'no_pending_job' };
  }
  return { ok: true, job: data };
}

/** discovery_job_leads 硬绑定：与 zhimao listDiscoveryJobIntelLeads 契约一致 */
async function upsertJobLeadMapping(supabase, discoveryJobId, companyId, qualityGrade) {
  const grade = qualityGrade || 'qualified';
  if (!discoveryJobId || !companyId || grade === 'unqualified') return { ok: true, skipped: true };
  const { error } = await supabase
    .from('discovery_job_leads')
    .upsert(
      {
        discovery_job_id: discoveryJobId,
        company_id: companyId,
        quality_grade: grade,
      },
      { onConflict: 'discovery_job_id,company_id' },
    );
  if (error) {
    return { ok: false, error };
  }
  return { ok: true };
}

module.exports = {
  V8_SUPPORTED_ISO2,
  resolvePipelineVersion,
  recordStage,
  finalizeJob,
  failJob,
  isJobCancelled,
  releaseStaleClaims,
  claimNextDiscoveryJob,
  upsertJobLeadMapping,
};
