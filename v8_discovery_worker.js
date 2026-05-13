require('dotenv').config();
const { spawn, execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

// Self-heal: ensure Playwright Chromium binary is present before the first job runs.
// Render's build and runtime filesystems are separate; the browser cache from buildCommand
// does not persist into the worker process. This runs once at startup (~30s on cold start).
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const POLL_MS = Math.max(Number(process.env.DISCOVERY_POLL_MS || 15000), 3000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runPipeline(countryIso, category, jobId) {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      ['zhimao_v8_ultimate_master.js', countryIso, category],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          DISCOVERY_JOB_ID: String(jobId),
        },
      },
    );
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function pickPendingJob() {
  const { data, error } = await supabase
    .from('discovery_jobs')
    .select('id,category,country_iso,requested_by')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[worker] select pending job error:', error.message);
    return null;
  }
  return data || null;
}

async function markRunning(jobId) {
  // Guard: only update if still pending — prevents double-pickup in multi-worker setups
  const { data, error } = await supabase
    .from('discovery_jobs')
    .update({ status: 'running', started_at: new Date().toISOString(), error_message: null })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[worker] mark running error:', error.message);
    return false;
  }
  if (!data) {
    console.warn(`[worker] job ${jobId} was already picked up by another worker, skipping`);
    return false;
  }
  return true;
}

async function readResultCountFromBulk(jobId) {
  // Bulk API (Step 5 → /api/data-intel/l1/procurement/bulk) is the single source of
  // truth for how many rows this job actually wrote into data_intel_l1_companies.
  // The worker only reads that value — it must not overwrite it with a country-wide count,
  // otherwise unrelated prior runs leak into this job's reported number.
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

async function markDone(job, count) {
  const nowIso = new Date().toISOString();
  // Only update status/completed_at. result_count was already written by Bulk API
  // (Step 5) using the exact rows.length actually upserted in this job — that is
  // the authoritative number and must not be overridden here.
  const { error: updateErr } = await supabase
    .from('discovery_jobs')
    .update({ status: 'done', completed_at: nowIso, error_message: null })
    .eq('id', job.id);
  if (updateErr) {
    console.error('[worker] mark done error:', updateErr.message);
  }

  if (job.requested_by) {
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
}

async function markFailed(jobId, msg) {
  const { error } = await supabase
    .from('discovery_jobs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: String(msg || 'pipeline_failed').slice(0, 1000),
    })
    .eq('id', jobId);
  if (error) {
    console.error('[worker] mark failed error:', error.message);
  }
}

/**
 * Write a heartbeat timestamp to platform_runtime_settings so that the zhimao
 * admin panel can detect whether this worker is alive.
 * Key: procure_worker_heartbeat  Value: ISO timestamp
 * Non-fatal: if the upsert fails we just log and continue.
 */
async function writeHeartbeat() {
  const { error } = await supabase
    .from('platform_runtime_settings')
    .upsert(
      { key: 'procure_worker_heartbeat', value_json: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) {
    console.warn('[worker] heartbeat write error:', error.message);
  }
}

async function main() {
  console.log('[worker] discovery worker started');
  // Write initial heartbeat on startup so admin can see the worker came online.
  await writeHeartbeat();

  while (true) {
    try {
      // Heartbeat every loop so admin panel shows last-seen time.
      await writeHeartbeat();

      const job = await pickPendingJob();
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }

      const runningOk = await markRunning(job.id);
      if (!runningOk) {
        await sleep(POLL_MS);
        continue;
      }

      console.log(`[worker] running job ${job.id}: ${job.category} / ${job.country_iso}`);
      const ok = await runPipeline(job.country_iso, job.category, job.id);
      if (!ok) {
        await markFailed(job.id, 'pipeline_exit_non_zero');
        await sleep(1000);
        continue;
      }

      const count = await readResultCountFromBulk(job.id);
      await markDone(job, count);
      console.log(`[worker] job done ${job.id}, count=${count}`);
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
