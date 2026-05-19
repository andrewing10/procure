require('dotenv').config();
const { spawn, execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const {
  recordStage,
  finalizeJob,
  failJob,
  isJobCancelled,
  releaseStaleClaims,
  claimNextDiscoveryJob,
} = require('./v8_zhimao_contract');
const { readFunnelDoc, deleteFunnelFile } = require('./v8_lib_funnel');
const { processEnrichmentBatch } = require('./v8_lib_enrichment_supabase');

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

// exit code 约定（master 与 worker 共同维护）：
//   0 → 全量写入成功
//   1 → 脚本崩溃 / 配置错误 → markFailed
//   2 → 本轮无新数据（graceful stop）→ markDone 但标记 result_count 来自 bulk 侧
const PIPELINE_EXIT = {
  SUCCESS: 0,
  CRASH: 1,
  NO_DATA: 2,
  CANCELLED: 3, // 子进程被 cancel SIGTERM 终止，语义上不是"失败"
};

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
    for (const row of (data || [])) {
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
 * 监听 discovery_jobs 的取消信号，双路并行：
 *   - 快路径：Supabase Realtime postgres_changes（毫秒级响应，与 DB trigger pg_notify 同效）
 *   - 兜底路径：30s 轮询 isJobCancelled（WebSocket 断线或首次订阅延迟时的安全网）
 *
 * 返回一个 { promise, cleanup } 对象：
 *   promise   → 当 job 被取消时 resolve（void）
 *   cleanup   → 必须在 pipeline 结束后调用，关闭 realtime channel + clearInterval
 */
function makeCancelWatcher(jobId) {
  let resolveCancel;
  let cancelled = false;
  const promise = new Promise((resolve) => { resolveCancel = resolve; });

  function triggerCancel() {
    if (cancelled) return;
    cancelled = true;
    console.warn(`[worker] job ${jobId} cancel signal received — terminating pipeline child`);
    resolveCancel();
  }

  // 快路径：Supabase Realtime 实时订阅
  // 依赖 discovery_jobs 表的 realtime 在 Supabase dashboard 已启用（默认开启）
  const channel = supabase
    .channel(`job-cancel-${jobId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'discovery_jobs', filter: `id=eq.${jobId}` },
      (payload) => {
        const newStatus = payload.new && payload.new.status;
        if (newStatus === 'cancelled') triggerCancel();
      },
    )
    .subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[worker] cancel realtime channel ${status} for job ${jobId}, relying on poll fallback`);
      }
    });

  // 兜底路径：每 30s 轮询一次（仅在 Realtime 掉线时作为安全网）
  const fallbackPoll = setInterval(async () => {
    if (cancelled) return;
    if (await isJobCancelled(supabase, jobId)) triggerCancel();
  }, 30_000);

  function cleanup() {
    clearInterval(fallbackPoll);
    supabase.removeChannel(channel).catch(() => { /* ignore */ });
  }

  return { promise, cleanup, get triggered() { return cancelled; } };
}

function mergeDomainBlacklist(policies) {
  const hosts = new Set();
  for (const row of (policies || [])) {
    for (const d of (row?.domain_blacklist || [])) {
      const h = String(d || '').toLowerCase().replace(/^www\./, '');
      if (h) hosts.add(h);
    }
  }
  return [...hosts];
}

function runPipeline(countryIso, category, jobId, sweepCount = 1, meta = {}, reweightPolicies = []) {
  return new Promise((resolve) => {
    // 提取 Pillar 0 产业链扩展结果（由 zhimao interpret → expand-query 生成）
    // 注入 step0 用于替换单一品类词为多样化买家画像搜索词
    const pillar0 = (meta.action_payload && typeof meta.action_payload === 'object')
      ? meta.action_payload
      : null;
    const pillar0Json = pillar0 ? JSON.stringify(pillar0) : '';
    const domainBlacklist = mergeDomainBlacklist(reweightPolicies);

    const child = spawn(
      'node',
      ['zhimao_v8_ultimate_master.js', countryIso, category],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          DISCOVERY_JOB_ID: String(jobId),
          SWEEP_COUNT:       String(sweepCount),
          DISCOVERY_SESSION_ID: meta.session_id ? String(meta.session_id) : '',
          DISCOVERY_PARENT_JOB_ID: meta.parent_job_id ? String(meta.parent_job_id) : '',
          DISCOVERY_ACTION_TYPE: meta.action_type ? String(meta.action_type) : 'new_search',
          DISCOVERY_REWEIGHT_JSON: JSON.stringify(Array.isArray(reweightPolicies) ? reweightPolicies : []),
          DISCOVERY_DOMAIN_BLACKLIST: JSON.stringify(domainBlacklist),
          PILLAR0_PAYLOAD: pillar0Json,
        },
      },
    );

    // 双路取消监听：Realtime（快）+ 30s 轮询（兜底）
    const watcher = makeCancelWatcher(jobId);
    watcher.promise.then(() => {
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    });

    child.on('close', (code) => {
      watcher.cleanup();
      if (watcher.triggered) {
        // 被 cancel 信号终止，使用专属退出码，不污染"失败"统计
        resolve(PIPELINE_EXIT.CANCELLED);
        return;
      }
      resolve(code ?? 1);
    });
    child.on('error', () => {
      watcher.cleanup();
      resolve(PIPELINE_EXIT.CRASH);
    });
  });
}

async function readClaimedJob(jobId) {
  const { data, error } = await supabase
    .from('discovery_jobs')
    .select('id,category,country_iso,requested_by,session_id,parent_job_id,action_type,action_payload,sweep_count')
    .eq('id', jobId)
    .maybeSingle();
  if (error) {
    console.error('[worker] read claimed job error:', error.message);
    return null;
  }
  return data || null;
}

async function readMappingCount(jobId) {
  const { count, error } = await supabase
    .from('discovery_job_leads')
    .select('company_id', { count: 'exact', head: true })
    .eq('discovery_job_id', jobId)
    .neq('quality_grade', 'unqualified');
  if (error) {
    console.error('[worker] read mapping count error:', error.message);
    return 0;
  }
  return Number(count ?? 0);
}

async function markDone(job) {
  await recordStage(supabase, job.id, 'persisting', { phase: 'pre_finalize' });
  const fin = await finalizeJob(supabase, job);
  if (!fin.ok) {
    const nowIso = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from('discovery_jobs')
      .update({ status: 'done', completed_at: nowIso })
      .eq('id', job.id)
      .in('status', ['pending', 'running', 'claimed', 'fetching', 'parsing', 'scoring', 'persisting']);
    if (updateErr) console.error('[worker] mark done fallback error:', updateErr.message);
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
  // 尝试读取 master 写入的 job-scoped 崩溃文件，细化错误定位
  let detailedMsg = msg;
  const crashFile = `crash_${jobId}.json`;
  try {
    if (require('fs').existsSync(crashFile)) {
      const info = JSON.parse(require('fs').readFileSync(crashFile, 'utf8'));
      detailedMsg = `pipeline_crash:${info.step || 'unknown'}`;
      require('fs').unlinkSync(crashFile);
      console.warn(`[worker] crash detail: step=${info.step} script=${info.script} error=${info.error?.slice(0, 120)}`);
    }
  } catch (_) { /* non-fatal */ }
  await failJob(supabase, jobId, detailedMsg);
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
    if (error.message && error.message.toLowerCase().includes('schema cache')) {
      console.warn('[worker] heartbeat write error (schema cache refreshing):', error.message);
    } else {
      console.warn('[worker] heartbeat write error:', error.message);
    }
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

      await releaseStaleClaims(supabase, 900);
      try {
        const eq = await processEnrichmentBatch(supabase, 5);
        if (eq.processed > 0) {
          console.log(`[worker] enrichment_queue processed=${eq.processed}`);
        }
      } catch (e) {
        console.warn('[worker] enrichment_queue tick failed:', e?.message || e);
      }
      const claim = await claimNextDiscoveryJob(supabase);
      if (!claim.ok) {
        await sleep(POLL_MS);
        continue;
      }
      if (!claim.job || !claim.job.job_id) {
        await sleep(POLL_MS);
        continue;
      }

      const job = await readClaimedJob(claim.job.job_id);
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }

      await recordStage(supabase, job.id, 'fetching');

      // 读取该 job 的历史 sweep 次数，传入流水线做深分页
      const { data: jobMeta } = await supabase
        .from('discovery_jobs')
        .select('sweep_count')
        .eq('id', job.id)
        .maybeSingle();
      const sweepCount = Number(jobMeta?.sweep_count ?? 0) + 1;

      const reweightPolicies = await readReweightPolicies(job);
      console.log(`[worker] running job ${job.id}: ${job.category} / ${job.country_iso} (sweep=${sweepCount}, action=${job.action_type || 'new_search'}, reweight=${reweightPolicies.length})`);
      const exitCode = await runPipeline(job.country_iso, job.category, job.id, sweepCount, job, reweightPolicies);

      // CANCELLED 退出码 或 DB 仍显示 cancelled → 均跳过 finalize，不计为失败
      if (exitCode === PIPELINE_EXIT.CANCELLED || await isJobCancelled(supabase, job.id)) {
        console.log(`[worker] job ${job.id} cancelled — skip finalize`);
        await sleep(1000);
        continue;
      }

      if (exitCode === PIPELINE_EXIT.CRASH) {
        await markFailed(job.id, 'pipeline_exit_non_zero');
        await sleep(1000);
        continue;
      }

      // exit(2) = no new data this sweep — mark done 但 completion_reason=completed_empty
      let completionReason = 'success';
      if (exitCode === PIPELINE_EXIT.NO_DATA) {
        completionReason = 'completed_empty';
        console.log(`[worker] job ${job.id} sweep=${sweepCount}: no new data (graceful stop).`);
      }

      const funnelDoc = readFunnelDoc(job.id);
      if (funnelDoc) {
        await supabase
          .from('discovery_jobs')
          .update({ funnel_json: funnelDoc })
          .eq('id', job.id);
        deleteFunnelFile(job.id);
      }

      // 补报中间 stage：流水线（step1-5）以黑盒子进程运行，这里在 markDone 前
      // 补上 parsing / scoring，让 UI 进度条不出现 fetching→persisting 长空白。
      await recordStage(supabase, job.id, 'parsing',  { phase: 'step1_step3_complete' });
      await recordStage(supabase, job.id, 'scoring',  { phase: 'step4_step5_complete', sweep: sweepCount });

      // 更新 sweep_count 方便下轮深分页
      await supabase
        .from('discovery_jobs')
        .update({
          sweep_count: sweepCount,
          completion_reason: completionReason,
        })
        .eq('id', job.id);

      await markDone(job);
      const count = await readMappingCount(job.id);
      console.log(`[worker] job done ${job.id}, mapping_count=${count}, sweep=${sweepCount}`);
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
