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

async function countIntelRows(countryIso, category) {
  // semantic_intent is text[] — ilike doesn't work on arrays.
  // Count all rows for this country written by this pipeline run instead.
  const { count } = await supabase
    .from('data_intel_l1_companies')
    .select('company_id', { count: 'exact', head: true })
    .eq('country', countryIso.toUpperCase())
    .eq('source', 'v8-pipeline');
  return Number(count || 0);
}

async function markDone(job, count) {
  const nowIso = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('discovery_jobs')
    .update({ status: 'done', result_count: count, completed_at: nowIso, error_message: null })
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

async function main() {
  console.log('[worker] discovery worker started');
  while (true) {
    try {
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

      const count = await countIntelRows(job.country_iso, job.category);
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
