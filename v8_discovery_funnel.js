/**
 * P1-E：discovery_jobs.funnel_json 增量回写（各 step 完成后 patch 对应计数）。
 * 格式对齐 zhimao FunnelStep[]（step / signals / accepted / pillars / wall_ms 等）。
 */
require('./load-env');
const { createSupabaseClient } = require('./v8_supabase_client');

let _client = null;

function getSupabase() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  _client = createSupabaseClient(url, key);
  return _client;
}

/**
 * @param {string} stepName — 如 step1 / step2 / step3 / step5
 * @param {Record<string, unknown>} fields
 */
async function patchFunnelStep(stepName, fields) {
  const jobId = process.env.DISCOVERY_JOB_ID;
  if (!jobId) return;

  const supabase = getSupabase();
  if (!supabase) {
    console.warn('[funnel] supabase env missing, skip patch', stepName);
    return;
  }

  const { data: row, error: readErr } = await supabase
    .from('discovery_jobs')
    .select('funnel_json')
    .eq('id', jobId)
    .maybeSingle();

  if (readErr) {
    console.warn(`[funnel] read funnel_json failed (${stepName}):`, readErr.message);
    return;
  }

  const prev = Array.isArray(row?.funnel_json) ? row.funnel_json : [];
  const arr = prev.map((x) => ({ ...x }));
  const idx = arr.findIndex((s) => s && s.step === stepName);
  const patch = { step: stepName, at: new Date().toISOString(), ...fields };
  if (idx >= 0) {
    arr[idx] = { ...arr[idx], ...patch };
  } else {
    arr.push(patch);
  }

  const { error: writeErr } = await supabase
    .from('discovery_jobs')
    .update({ funnel_json: arr })
    .eq('id', jobId);

  if (writeErr) {
    console.warn(`[funnel] patch ${stepName} failed:`, writeErr.message);
    return;
  }
  console.log(`[funnel] patched ${stepName}:`, JSON.stringify(fields));
}

module.exports = { patchFunnelStep, getSupabase };
