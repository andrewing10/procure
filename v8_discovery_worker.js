require('./load-env');
const { spawn, execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const {
  emitDiscoveryJobCompleted,
  emitDiscoveryJobFailed,
  discoveryCompletionNotifyMode,
} = require('./v8_crm_watch_emit');

try {
  console.log('[worker] ensuring playwright chromium is installed...');
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  console.log('[worker] playwright chromium ready');
} catch (e) {
  console.warn('[worker] playwright install warning (may already be present):', e.message);
}

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[worker] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const { reportDiscoveryStage } = require('./v8_discovery_stage');
const { processEnrichmentQueueBatch } = require('./v8_discovery_enrichment_worker');
const { DiscoveryCancelListener } = require('./v8_discovery_cancel_listener');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const cancelListener = new DiscoveryCancelListener();

const WORKER_ID =
  process.env.RENDER_INSTANCE_ID ||
  process.env.WORKER_ID ||
  `v8-discovery-worker-${process.pid}`;

const POLL_MS = Math.max(Number(process.env.DISCOVERY_POLL_MS || 15000), 3000);
const CANCEL_POLL_MS = Math.max(Number(process.env.CANCEL_POLL_MS || 3000), 1000);
const STALE_CLAIM_SECONDS = Math.max(Number(process.env.STALE_CLAIM_SECONDS || 900), 120);

const PIPELINE_EXIT = { SUCCESS: 0, CRASH: 1, NO_DATA: 2 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readReweightPolicies(job) {
  const country = String(job.country_iso || '').trim().toUpperCase();
  const category = String(job.category || '').trim().toLowerCase();
  const merged = new Map();
  async function pull(countryScoped, categoryScoped) {
    let q = supabase
      .from('discovery_reweight_policies')
      .select('source_kind,weight_delta,sample_count,country_iso,category_key,updated_at,last_reason');
    q = countryScoped ? q.eq('country_iso', country) : q.is('country_iso', null);
    q = categoryScoped ? q.eq('category_key', category) : q.is('category_key', null);
    const { data } = await q.limit(50);
    for (const row of data || []) {
      const key = String(row.source_kind || 'generic');
      const prev = merged.get(key) || { source_kind: key, weight_delta: 0, sample_count: 0 };
      prev.weight_delta += Number(row.weight_delta || 0);
      prev.sample_count += Number(row.sample_count || 0);
      merged.set(key, prev);
    }
  }
  try {
    await pull(true, true);
    await pull(true, false);
    await pull(false, true);
    await pull(false, false);
  } catch (e) {
    console.warn('[worker] read reweight policies failed:', e?.message || e);
  }
  return Array.from(merged.values());
}

/**
 * P1-D：spawn 流水线 + cancel 轮询（LISTEN 命中或 DB status=cancelled → SIGTERM）。
 */
function runPipeline(countryIso, category, jobId, sweepCount = 1, meta = {}, reweightPolicies = []) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearInterval(checkInterval);
      resolve(code ?? PIPELINE_EXIT.CRASH);
    };

    const child = spawn('node', ['zhimao_v8_ultimate_master.js', countryIso, category], {
      stdio: 'inherit',
      env: {
        ...process.env,
        DISCOVERY_JOB_ID: String(jobId),
        SWEEP_COUNT: String(sweepCount),
        DISCOVERY_SESSION_ID: meta.session_id ? String(meta.session_id) : '',
        DISCOVERY_PARENT_JOB_ID: meta.parent_job_id ? String(meta.parent_job_id) : '',
        DISCOVERY_ACTION_TYPE: meta.action_type ? String(meta.action_type) : 'new_search',
        DISCOVERY_REWEIGHT_JSON: JSON.stringify(Array.isArray(reweightPolicies) ? reweightPolicies : []),
      },
    });

    const checkInterval = setInterval(() => {
      void (async () => {
        if (await cancelListener.isCancelled(jobId)) {
          console.log(`[worker] cancel detected for job ${jobId}, terminating pipeline`);
          child.kill('SIGTERM');
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch (_) {
              /* already dead */
            }
          }, 8000);
        }
      })();
    }, CANCEL_POLL_MS);

    child.on('close', (code) => finish(code));
    child.on('error', () => finish(PIPELINE_EXIT.CRASH));
  });
}

async function releaseStaleClaims() {
  const { data, error } = await supabase.rpc('release_stale_discovery_claims', {
    p_stale_seconds: STALE_CLAIM_SECONDS,
  });
  if (error) {
    console.warn('[worker] release_stale_discovery_claims failed:', error.message);
    return 0;
  }
  const n = Number(data ?? 0);
  if (n > 0) console.log(`[worker] released ${n} stale in-flight claim(s)`);
  return n;
}

/** P1-D：原子领单（优先级 + SKIP LOCKED）。 */
async function claimNextJob() {
  await releaseStaleClaims();

  const { data: claim, error } = await supabase.rpc('claim_next_discovery_job', {
    p_worker_id: WORKER_ID,
  });

  if (error) {
    if (error.message && error.message.toLowerCase().includes('schema cache')) {
      console.warn('[worker] claim RPC error (schema cache refreshing, waiting 30s):', error.message);
      await sleep(30_000);
    } else {
      console.error('[worker] claim_next_discovery_job error:', error.message);
    }
    return null;
  }

  if (!claim?.ok || !claim.job_id) {
    return null;
  }

  const { data: job, error: jobErr } = await supabase
    .from('discovery_jobs')
    .select('id,category,country_iso,requested_by,session_id,parent_job_id,action_type,sweep_count,status')
    .eq('id', claim.job_id)
    .maybeSingle();

  if (jobErr || !job) {
    console.error('[worker] load claimed job failed:', jobErr?.message || claim.job_id);
    return null;
  }

  if (job.status === 'cancelled') {
    console.log(`[worker] claimed job ${job.id} already cancelled, skipping`);
    return null;
  }

  console.log(
    `[worker] claimed job ${job.id} (${job.category}/${job.country_iso}, action=${job.action_type || 'new_search'})`,
  );
  return job;
}

async function readResultCountFromBulk(jobId) {
  const { data, error } = await supabase
    .from('discovery_jobs')
    .select('result_count,status')
    .eq('id', jobId)
    .maybeSingle();
  if (error) {
    console.error('[worker] read result_count error:', error.message);
    return 0;
  }
  return Number(data?.result_count ?? 0);
}

async function writeCompletionReason(jobId, reason) {
  const { error } = await supabase
    .from('discovery_jobs')
    .update({ completion_reason: reason })
    .eq('id', jobId)
    .eq('status', 'done');
  if (error) {
    console.warn('[worker] completion_reason update failed:', error.message);
  }
}

async function markDone(job, count, pipelineExit) {
  if (await cancelListener.isCancelled(job.id)) {
    console.log(`[worker] markDone skipped — job ${job.id} is cancelled`);
    return;
  }

  const completionReason =
    pipelineExit === PIPELINE_EXIT.NO_DATA || count === 0 ? 'completed_empty' : 'success';

  const pipelineVersion = process.env.PIPELINE_VERSION || 'v8';
  const { data, error } = await supabase.rpc('discovery_job_finalize', {
    p_job_id: job.id,
    p_pipeline_version: pipelineVersion,
    p_error_summary: null,
  });

  if (error) {
    console.error('[worker] finalize RPC failed:', error.message);
    const nowIso = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from('discovery_jobs')
      .update({
        status: 'done',
        completed_at: nowIso,
        error_message: null,
        current_stage: 'done',
        completion_reason: completionReason,
      })
      .eq('id', job.id)
      .in('status', ['claimed', 'fetching', 'parsing', 'scoring', 'persisting', 'running', 'pending']);
    if (updateErr) {
      console.error('[worker] mark done fallback error:', updateErr.message);
    }
  } else if (data?.no_op) {
    console.log(`[worker] finalize no-op: ${data.reason || 'locked'}`);
    return;
  } else {
    console.log(
      `[worker] finalize ok: result_count=${data?.result_count ?? count}, completion_reason=${completionReason}`,
    );
    await writeCompletionReason(job.id, completionReason);
  }

  const notifyMode = discoveryCompletionNotifyMode();

  if ((notifyMode === 'supabase' || notifyMode === 'both') && job.requested_by) {
    const { error: notifyErr } = await supabase.from('notifications').insert({
      recipient_user_id: job.requested_by,
      notification_type: 'discovery_complete',
      title: 'AI找客任务已完成',
      body: `您的任务「${job.category} / ${job.country_iso}」已完成，可进入搜索页查看结果。`,
      biz_type: 'discovery_job',
      biz_id: job.id,
      status: 'unread',
      sent_via: 'in_app',
    });
    if (notifyErr) {
      console.error('[worker] notify error:', notifyErr.message);
    }
  }

  if (notifyMode === 'emit' || notifyMode === 'both') {
    const emitRes = await emitDiscoveryJobCompleted(job);
    if (emitRes.skipped) {
      if (emitRes.reason && emitRes.reason !== 'missing_zhimao_app_url_or_emit_secret') {
        console.warn('[worker] crm-watch emit skipped:', emitRes.reason);
      }
    } else if (!emitRes.ok) {
      console.error('[worker] crm-watch emit failed:', emitRes.error || emitRes.status, emitRes.data || '');
    } else if (emitRes.data && typeof emitRes.data === 'object' && emitRes.data.deduped) {
      console.log('[worker] crm-watch emit deduped=true');
    } else {
      console.log('[worker] crm-watch emit ok');
    }
  }
}

async function markFailed(job, msg) {
  if (await cancelListener.isCancelled(job.id)) {
    console.log(`[worker] markFailed skipped — job ${job.id} is cancelled`);
    return;
  }

  const jobId = job.id;
  const errText = String(msg || 'pipeline_failed').slice(0, 1000);

  const { error: stageErr } = await supabase.rpc('discovery_job_record_stage', {
    p_job_id: jobId,
    p_stage: 'failed',
    p_claimed_by: WORKER_ID,
    p_payload: { error_message: errText },
  });
  if (stageErr) {
    console.error('[worker] record_stage failed:', stageErr.message);
    const { error } = await supabase
      .from('discovery_jobs')
      .update({
        status: 'failed',
        current_stage: 'failed',
        completed_at: new Date().toISOString(),
        error_message: errText,
      })
      .eq('id', jobId)
      .in('status', ['claimed', 'fetching', 'parsing', 'scoring', 'persisting', 'running', 'pending']);
    if (error) {
      console.error('[worker] mark failed fallback error:', error.message);
    }
  }

  if (process.env.CRM_WATCH_EMIT_ON_FAILURE === 'true') {
    const emitRes = await emitDiscoveryJobFailed(job, String(msg || 'pipeline_failed'));
    if (emitRes.skipped) {
      if (emitRes.reason && emitRes.reason !== 'missing_zhimao_app_url_or_emit_secret') {
        console.warn('[worker] crm-watch failed emit skipped:', emitRes.reason);
      }
    } else if (!emitRes.ok) {
      console.error('[worker] crm-watch failed emit:', emitRes.error || emitRes.status);
    } else {
      console.log('[worker] crm-watch failed emit ok');
    }
  }
}

async function writeHeartbeat() {
  const { error } = await supabase
    .from('platform_runtime_settings')
    .upsert(
      { key: 'procure_worker_heartbeat', value_json: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) {
    if (error.message && error.message.toLowerCase().includes('schema cache')) {
      console.warn('[worker] heartbeat write error (schema cache refreshing):', error.message);
    } else {
      console.warn('[worker] heartbeat write error:', error.message);
    }
  }
}

async function main() {
  console.log(`[worker] discovery worker started (id=${WORKER_ID})`);
  await cancelListener.start(supabase);
  await writeHeartbeat();

  while (true) {
    try {
      await writeHeartbeat();

      const job = await claimNextJob();
      if (!job) {
        if (process.env.ENRICH_IDLE_IN_DISCOVERY_WORKER !== '0') {
          try {
            const promoted = await processEnrichmentQueueBatch(supabase);
            if (promoted > 0) {
              console.log(`[worker] idle enrichment batch promoted=${promoted}`);
            }
          } catch (e) {
            console.warn('[worker] idle enrichment error:', e?.message || e);
          }
        }
        await sleep(POLL_MS);
        continue;
      }

      if (await cancelListener.isCancelled(job.id)) {
        console.log(`[worker] job ${job.id} cancelled before pipeline start`);
        await sleep(1000);
        continue;
      }

      const sweepCount = Number(job.sweep_count ?? 0) + 1;
      const reweightPolicies = await readReweightPolicies(job);
      console.log(
        `[worker] running job ${job.id}: ${job.category} / ${job.country_iso} (sweep=${sweepCount}, action=${job.action_type || 'new_search'}, reweight=${reweightPolicies.length})`,
      );

      const exitCode = await runPipeline(
        job.country_iso,
        job.category,
        job.id,
        sweepCount,
        job,
        reweightPolicies,
      );

      if (await cancelListener.isCancelled(job.id)) {
        console.log(`[worker] job ${job.id} cancelled — pipeline stopped, no finalize`);
        await sleep(1000);
        continue;
      }

      if (exitCode === PIPELINE_EXIT.CRASH) {
        await markFailed(job, 'pipeline_exit_non_zero');
        await sleep(1000);
        continue;
      }

      if (exitCode === PIPELINE_EXIT.NO_DATA) {
        console.log(`[worker] job ${job.id} sweep=${sweepCount}: no new data (graceful stop).`);
      }

      await supabase.from('discovery_jobs').update({ sweep_count: sweepCount }).eq('id', job.id);

      const count = await readResultCountFromBulk(job.id);
      await markDone(job, count, exitCode);
      console.log(`[worker] job done ${job.id}, count=${count}, sweep=${sweepCount}, exit=${exitCode}`);
    } catch (e) {
      console.error('[worker] loop error:', e instanceof Error ? e.message : e);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error('[worker] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
