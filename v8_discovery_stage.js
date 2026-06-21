/**
 * discovery_job_record_stage RPC 薄封装 — worker / master 共用。
 * 非 fatal：RPC 失败只打 warn，不阻断流水线。
 */
require('./load-env');
const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getSupabase() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _client;
}

const CLAIMED_BY = process.env.RENDER_INSTANCE_ID
  ? `v8-worker/${process.env.RENDER_INSTANCE_ID}`
  : 'v8-worker/local';

/**
 * @param {'claimed'|'fetching'|'parsing'|'scoring'|'persisting'|'done'|'failed'} stage
 * @param {Record<string, unknown>|null} [payload]
 * @param {string|null} [jobIdOverride]
 */
async function reportDiscoveryStage(stage, payload = null, jobIdOverride = null) {
  const jobId = jobIdOverride || process.env.DISCOVERY_JOB_ID;
  if (!jobId) return { skipped: true, reason: 'no_job_id' };

  const supabase = getSupabase();
  if (!supabase) {
    console.warn('[stage] missing supabase env, skip report:', stage);
    return { skipped: true, reason: 'no_supabase' };
  }

  const { data, error } = await supabase.rpc('discovery_job_record_stage', {
    p_job_id: jobId,
    p_stage: stage,
    p_claimed_by: CLAIMED_BY,
    p_payload: payload,
  });

  if (error) {
    console.warn(`[stage] record_stage ${stage} failed:`, error.message);
    return { ok: false, error: error.message };
  }

  if (data && data.no_op) {
    console.log(`[stage] ${stage} no-op (${data.reason || 'locked'})`);
  } else {
    console.log(`[stage] reported ${stage}`);
  }
  return { ok: true, data };
}

module.exports = { reportDiscoveryStage, CLAIMED_BY };
