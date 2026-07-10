require('./load-env');
const { spawn, execSync } = require('child_process');
const { createSupabaseClient } = require('./v8_supabase_client');
const {
  recordStage,
  finalizeJob,
  failJob,
  isJobCancelled,
  releaseStaleClaims,
  claimNextDiscoveryJob,
  resolveWorkerInstanceId,
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

const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const POLL_MS = Math.max(Number(process.env.DISCOVERY_POLL_MS || 15000), 3000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// exit code 约定（master 与 worker 共同维护）：
//   0 → 全量写入成功
//   1 → 脚本崩溃 / 配置错误 → markFailed
//   2 → 本轮无新数据（graceful stop）→ markDone 但标记 result_count 来自 bulk 侧
//   3 → 子进程被 cancel SIGTERM 终止（无数据持久化），语义上不是"失败"
//   4 → graceful cancel with data：SIGTERM 到达后 master 仍完成了 step4/5 持久化
//   5 → 看门狗硬超时：pipeline 超过 DISCOVERY_PIPELINE_MAX_MS 仍未结束，被强杀（markFailed）
const PIPELINE_EXIT = {
  SUCCESS: 0,
  CRASH: 1,
  NO_DATA: 2,
  CANCELLED: 3,
  GRACEFUL_CANCEL_WITH_DATA: 4,
  TIMEOUT: 5,
};

// 看门狗参数（env 可调）：
//   DISCOVERY_PIPELINE_MAX_MS  → 单个 job pipeline 软上限，到点先 SIGTERM master 走 graceful cancel
//   DISCOVERY_PIPELINE_KILL_GRACE_MS → SIGTERM 后等多久还没退就 SIGKILL 整个进程组
//   DISCOVERY_PIPELINE_HEARTBEAT_MS  → 运行期间多久回写一次 stage_heartbeat_at + funnel_json
const PIPELINE_MAX_MS = Math.max(Number(process.env.DISCOVERY_PIPELINE_MAX_MS || 18 * 60 * 1000), 60_000);
const PIPELINE_KILL_GRACE_MS = Math.max(Number(process.env.DISCOVERY_PIPELINE_KILL_GRACE_MS || 90_000), 10_000);
const PIPELINE_HEARTBEAT_MS = Math.max(Number(process.env.DISCOVERY_PIPELINE_HEARTBEAT_MS || 45_000), 10_000);

// 并发车道数：一次最多同时认领并跑几个 job。claim_next_discovery_job 用 FOR UPDATE SKIP
// LOCKED，多车道并发认领互不抢占（各拿一单）。默认 2，env 可调，封顶 6（防 Render 实例
// 内存/外部 API 速率被多个 Playwright + Gemini pipeline 同时打爆）。
const PIPELINE_CONCURRENCY = Math.min(
  Math.max(Number(process.env.DISCOVERY_PIPELINE_CONCURRENCY || 2), 1),
  6,
);

const ACTIVE_JOB_STATUSES = ['pending', 'running', 'claimed', 'fetching', 'parsing', 'scoring', 'persisting'];

/**
 * 把 funnel_<jobId>.json 的 { steps: { step1: {...} } } 物理结构转成前端
 * useDiscoveryJobRunner 期望的数组形态 [{ step:'step1', signals, accepted, pillars... }]。
 * 旧实现直接把对象塞进 funnel_json，前端 `Array.isArray()` 判否后丢弃 → 真实进度数字一直不显示。
 */
function funnelDocToArray(doc) {
  if (!doc || !doc.steps || typeof doc.steps !== 'object') return null;
  const order = ['step0', 'step1', 'step2', 'step3', 'step4', 'step5'];
  const keys = Object.keys(doc.steps).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const arr = keys.map((k) => ({ step: k, ...doc.steps[k] }));
  return arr.length ? arr : null;
}

/** 由 funnel 文件里最新出现的 step 粗映射到 discovery_jobs.current_stage。 */
function funnelLatestStage(doc) {
  if (!doc || !doc.steps) return null;
  if (doc.steps.step5) return 'persisting';
  if (doc.steps.step4) return 'scoring';
  if (doc.steps.step3 || doc.steps.step2) return 'parsing';
  if (doc.steps.step1) return 'fetching';
  return null;
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
  let realtimeDisabled = false;
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
        if (realtimeDisabled) return;
        realtimeDisabled = true;
        const detail = err?.message ? `: ${err.message}` : '';
        console.warn(`[worker] cancel realtime channel ${status} for job ${jobId}${detail}, relying on poll fallback`);
        supabase.removeChannel(channel).catch(() => { /* ignore */ });
      }
    });

  // 兜底路径：每 30s 轮询一次（仅在 Realtime 掉线时作为安全网）
  isJobCancelled(supabase, jobId).then((isCancelled) => {
    if (isCancelled) triggerCancel();
  }).catch(() => { /* ignore */ });
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
        // 自成进程组：看门狗需要时可 process.kill(-pid) 连同 master 用 execSync spawn 的
        // 孙进程（卡死的 step1/3）一起杀掉。master 阻塞在同步 execSync 时，单发 SIGTERM 给
        // master 是无效的（信号处理函数排在被阻塞的事件循环后面），必须组级 SIGKILL 兜底。
        detached: true,
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
          DISCOVERY_COUNTRY_ISO: countryIso || '',
          DISCOVERY_CATEGORY: category || '',
          // proxy_hint 桥接：Render env (USE_PROXY/BRD_USER/BRD_PASS) 优先；
          // 若 Render 未配置，则从 action_payload.proxy_hint 读取（由 zhimao submit 注入）
          ...(() => {
            const hint = pillar0?.proxy_hint;
            if (!hint?.enabled) return {};
            if (process.env.USE_PROXY === 'true') return {};  // Render 已配置，不覆盖
            return {
              USE_PROXY:  'true',
              BRD_USER:   String(hint.username || ''),
              BRD_PASS:   String(hint.password || ''),
              BRD_PROXY:  `http://${hint.host}:${hint.port}`,
            };
          })(),
        },
      },
    );

    // 组级杀进程：优先 process.kill(-pid) 命中整个进程组，失败再退化为只杀 master。
    const killTree = (sig) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch (_) {
        try { child.kill(sig); } catch (__) { /* ignore */ }
      }
    };

    // 双路取消监听：Realtime（快）+ 30s 轮询（兜底）
    const watcher = makeCancelWatcher(jobId);
    watcher.promise.then(() => {
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    });

    // ── A 看门狗：pipeline 硬上限，避免单个 job 卡死后无终态（用户等满 60min 才自愈）──
    //   软触发：SIGTERM master → master 在 step 之间会进入 graceful cancel，跑完 step4+5
    //          落库已采集数据并 exit 4；用户随后能看到"部分结果 + 完成"。
    //   硬触发：宽限期后仍未退出（多半卡死在某个 step 的同步 execSync 里）→ 组级 SIGKILL，
    //          回报 TIMEOUT → markFailed('pipeline_timeout')，让用户拿到明确失败可重试。
    let watchdogState = 'armed'; // armed | soft | hard
    let killTimer = null;
    const softTimer = setTimeout(() => {
      watchdogState = 'soft';
      console.warn(`[worker] pipeline watchdog: job ${jobId} exceeded ${PIPELINE_MAX_MS}ms — SIGTERM master (graceful cancel, will try to persist partial data)`);
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
      killTimer = setTimeout(() => {
        watchdogState = 'hard';
        console.warn(`[worker] pipeline watchdog: job ${jobId} still alive ${PIPELINE_KILL_GRACE_MS}ms after SIGTERM — SIGKILL process group`);
        killTree('SIGKILL');
      }, PIPELINE_KILL_GRACE_MS);
    }, PIPELINE_MAX_MS);

    // ── C 运行期心跳 + 真实进度回写 ──────────────────────────────────────────
    //   pipeline 是黑盒子进程，期间不回写 DB 会让 current_stage 冻在 fetching、
    //   stage_heartbeat_at 不动、funnel 数字到结束才出现。这里每 N 秒：
    //     1) 读 funnel 文件 → 以数组形态写 funnel_json（前端真实进度数字立刻可见）
    //     2) 按最新 step 粗推 current_stage + bump stage_heartbeat_at
    //   只更新仍处于活态的行（.in 守卫），绝不覆盖已 cancelled/done/failed 的终态。
    const heartbeat = setInterval(async () => {
      try {
        const doc = readFunnelDoc(jobId);
        const arr = funnelDocToArray(doc);
        const stage = funnelLatestStage(doc);
        const patch = { stage_heartbeat_at: new Date().toISOString() };
        if (arr) patch.funnel_json = arr;
        if (stage) patch.current_stage = stage;
        await supabase
          .from('discovery_jobs')
          .update(patch)
          .eq('id', jobId)
          .in('status', ACTIVE_JOB_STATUSES);
      } catch (_) { /* 非致命 */ }
    }, PIPELINE_HEARTBEAT_MS);

    const cleanupTimers = () => {
      clearTimeout(softTimer);
      if (killTimer) clearTimeout(killTimer);
      clearInterval(heartbeat);
    };

    child.on('close', (code, signal) => {
      cleanupTimers();
      watcher.cleanup();
      // 看门狗硬杀：无优雅落库 → 回报 TIMEOUT，由主循环 markFailed。
      if (watchdogState === 'hard') {
        console.warn(`[worker] job ${jobId} hard-killed by watchdog (code=${code}, signal=${signal})`);
        resolve(PIPELINE_EXIT.TIMEOUT);
        return;
      }
      if (watcher.triggered) {
        // cancel 信号已发送。
        // exit 4 = master 完成了 graceful cancel with data，应 finalize
        // 其他 = 被中途杀死，跳过 finalize
        if (code === PIPELINE_EXIT.GRACEFUL_CANCEL_WITH_DATA) {
          resolve(PIPELINE_EXIT.GRACEFUL_CANCEL_WITH_DATA);
        } else {
          resolve(PIPELINE_EXIT.CANCELLED);
        }
        return;
      }
      // 看门狗软触发后 master 优雅退出（exit 4 = 已落库部分数据）由下面的 code 透传处理。
      resolve(code ?? 1);
    });
    child.on('error', () => {
      cleanupTimers();
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

  if (process.env.CRM_WATCH_EMIT_ON_FAILURE === 'true') {
    try {
      const { emitDiscoveryJobFailed } = require('./v8_crm_watch_emit');
      const { data: job } = await supabase
        .from('discovery_jobs')
        .select('id,category,country_iso,requested_by')
        .eq('id', jobId)
        .maybeSingle();
      if (job) {
        const emitRes = await emitDiscoveryJobFailed(job, String(detailedMsg || 'pipeline_failed'));
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
    } catch (e) {
      console.warn('[worker] crm-watch failed emit error:', e?.message || e);
    }
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
    if (error.message && error.message.toLowerCase().includes('schema cache')) {
      console.warn('[worker] heartbeat write error (schema cache refreshing):', error.message);
    } else {
      console.warn('[worker] heartbeat write error:', error.message);
    }
  }
}

/**
 * 认领并跑完一个 job（一个并发车道的一次迭代）。
 * 返回 true = 确实认领并处理了一个 job；false = 队列暂时没活，调用方应 sleep 后再试。
 * 多车道并发调用安全：claim 用 FOR UPDATE SKIP LOCKED，各车道各拿一单。
 */
async function claimAndProcessOne(workerId) {
  const claim = await claimNextDiscoveryJob(supabase, workerId);
  if (!claim.ok || !claim.job || !claim.job.job_id) return false;

  const job = await readClaimedJob(claim.job.job_id);
  if (!job) return false;

  try {
    await recordStage(supabase, job.id, 'fetching');

    // 读取该 job 的历史 sweep 次数，传入流水线做深分页
    const { data: jobMeta } = await supabase
      .from('discovery_jobs')
      .select('sweep_count')
      .eq('id', job.id)
      .maybeSingle();
    const sweepCount = Number(jobMeta?.sweep_count ?? 0) + 1;

    const reweightPolicies = await readReweightPolicies(job);
    console.log(`[worker] [${workerId}] running job ${job.id}: ${job.category} / ${job.country_iso} (sweep=${sweepCount}, action=${job.action_type || 'new_search'}, reweight=${reweightPolicies.length})`);
    const exitCode = await runPipeline(job.country_iso, job.category, job.id, sweepCount, job, reweightPolicies);

    // CANCELLED 退出码 或 DB 仍显示 cancelled → 均跳过 finalize，不计为失败
    // 例外：退出码 4（GRACEFUL_CANCEL_WITH_DATA）= master 已完成 step4/5，有数据入库 → 正常 finalize
    if (exitCode === PIPELINE_EXIT.CANCELLED || await isJobCancelled(supabase, job.id)) {
      if (exitCode === PIPELINE_EXIT.GRACEFUL_CANCEL_WITH_DATA) {
        console.log(`[worker] job ${job.id} cancelled but master persisted data (exit 4) — running finalize`);
        // 继续往下走，正常 markDone
      } else {
        console.log(`[worker] job ${job.id} cancelled — skip finalize`);
        return true;
      }
    }

    if (exitCode === PIPELINE_EXIT.CRASH) {
      await markFailed(job.id, 'pipeline_exit_non_zero');
      return true;
    }

    // 看门狗硬超时：pipeline 卡死被强杀，无优雅落库 → markFailed，让用户拿到明确失败可重试。
    if (exitCode === PIPELINE_EXIT.TIMEOUT) {
      console.warn(`[worker] job ${job.id} aborted by pipeline watchdog (timeout) — marking failed`);
      await markFailed(job.id, 'pipeline_timeout');
      return true;
    }

    // exit(2) = no new data this sweep — mark done 但 completion_reason=completed_empty
    let completionReason = 'success';
    if (exitCode === PIPELINE_EXIT.NO_DATA) {
      completionReason = 'completed_empty';
      console.log(`[worker] job ${job.id} sweep=${sweepCount}: no new data (graceful stop).`);
    }

    const funnelDoc = readFunnelDoc(job.id);
    if (funnelDoc) {
      // 与心跳一致：写数组形态，前端 useDiscoveryJobRunner 才认（Array.isArray 判定）。
      const funnelArr = funnelDocToArray(funnelDoc) ?? funnelDoc;
      await supabase
        .from('discovery_jobs')
        .update({ funnel_json: funnelArr })
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
    console.log(`[worker] [${workerId}] job done ${job.id}, mapping_count=${count}, sweep=${sweepCount}`);
  } catch (e) {
    console.error(`[worker] [${workerId}] job ${job.id} error:`, e instanceof Error ? e.message : e);
    // 兜底：异常落地为 failed，避免任务永远卡在 in-flight（stale 释放兜底也会补）。
    try { await markFailed(job.id, 'worker_loop_error'); } catch (_) { /* ignore */ }
  }
  return true;
}

/**
 * 一个并发车道：不停认领 + 处理 job；没活时 sleep(POLL_MS)，有活时只 sleep 一小段再抢下一单。
 */
async function lane(laneId) {
  const workerId = `${resolveWorkerInstanceId()}#lane${laneId}`;
  while (true) {
    let processed = false;
    try {
      processed = await claimAndProcessOne(workerId);
    } catch (e) {
      console.error(`[worker] [${workerId}] lane error:`, e instanceof Error ? e.message : e);
    }
    await sleep(processed ? 1000 : POLL_MS);
  }
}

// ENRICH_IDLE_IN_DISCOVERY_WORKER=0（默认）时不抢 enrichment 队列，交给 dedicated enrich worker。
// 旧逻辑无条件 processEnrichmentBatch → 与 procure-enrichment 双跑，出现 .tmp_eq_out_ 空转。
const ENRICH_IDLE_IN_DISCOVERY =
  String(process.env.ENRICH_IDLE_IN_DISCOVERY_WORKER || '0').trim() === '1';

/**
 * 单例后台维护循环：心跳 + 释放 stale 认领；可选 enrichment_queue。
 * 这些是全局性工作，只跑一份，不随并发车道数翻倍。
 */
async function housekeeping() {
  if (!ENRICH_IDLE_IN_DISCOVERY) {
    console.log('[worker] enrichment_queue idle consume OFF (ENRICH_IDLE_IN_DISCOVERY_WORKER!=1)');
  }
  while (true) {
    try {
      // Heartbeat so admin panel shows last-seen time.
      await writeHeartbeat();
      await releaseStaleClaims(supabase, 900);
      if (ENRICH_IDLE_IN_DISCOVERY) {
        try {
          const eq = await processEnrichmentBatch(supabase, 5);
          if (eq.processed > 0) {
            console.log(`[worker] enrichment_queue processed=${eq.processed}`);
          }
        } catch (e) {
          console.warn('[worker] enrichment_queue tick failed:', e?.message || e);
        }
      }
    } catch (e) {
      console.error('[worker] housekeeping error:', e instanceof Error ? e.message : e);
    }
    await sleep(POLL_MS);
  }
}

async function main() {
  console.log(`[worker] discovery worker started (concurrency=${PIPELINE_CONCURRENCY})`);
  // Write initial heartbeat on startup so admin can see the worker came online.
  await writeHeartbeat();

  const lanes = [];
  for (let i = 1; i <= PIPELINE_CONCURRENCY; i++) {
    lanes.push(lane(i));
  }
  // housekeeping 与所有车道并行常驻；任一意外退出都不应让进程整体退出（各自 while(true) 内已兜底）。
  await Promise.all([housekeeping(), ...lanes]);
}

main().catch((e) => {
  console.error('[worker] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
