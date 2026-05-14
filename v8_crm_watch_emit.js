/**
 * 智猫 Web — POST /api/internal/crm-watch/emit（B2 CRM 监测闭环）
 * 规格见 zhimao 侧 runbook；失败不抛异常，由调用方打日志。
 */
const axios = require('axios');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveAppBaseUrl() {
  const u = (process.env.ZHIMAO_APP_URL || process.env.CRM_WATCH_APP_URL || '').trim().replace(/\/$/, '');
  return u || '';
}

function resolveEmitSecret() {
  return (
    process.env.CRM_WATCH_EMIT_SECRET ||
    process.env.ZHIMAO_CRM_WATCH_EMIT_SECRET ||
    ''
  ).trim();
}

/**
 * @param {object} body
 * @param {string} label 日志用
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, status?: number, data?: unknown, error?: string }>}
 */
async function postCrmWatchEmit(body, label) {
  const baseUrl = resolveAppBaseUrl();
  const secret = resolveEmitSecret();
  if (!baseUrl || !secret) {
    return { ok: false, skipped: true, reason: 'missing_zhimao_app_url_or_emit_secret' };
  }

  const url = `${baseUrl}/api/internal/crm-watch/emit`;
  const timeout = Math.max(Number(process.env.CRM_WATCH_EMIT_TIMEOUT_MS || 15000), 3000);
  const maxAttempts = Math.min(Math.max(Number(process.env.CRM_WATCH_EMIT_MAX_RETRIES || 3), 1), 8);
  let lastMsg = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        timeout,
        validateStatus: () => true,
      });
      const data = res.data;
      if (res.status >= 200 && res.status < 300) {
        if (data && typeof data === 'object' && data.ok === true) {
          return { ok: true, status: res.status, data };
        }
        lastMsg = `HTTP ${res.status} body not ok: ${JSON.stringify(data).slice(0, 400)}`;
      } else if (res.status === 401 || res.status === 400 || res.status === 403 || res.status === 404) {
        return { ok: false, status: res.status, data, error: lastMsg || `HTTP ${res.status}` };
      } else {
        lastMsg = `HTTP ${res.status} ${typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : String(data)}`;
      }
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e);
    }
    if (attempt < maxAttempts) {
      const backoff = Math.min(2000 * 2 ** (attempt - 1), 30_000);
      await sleep(backoff);
    }
  }
  return { ok: false, error: lastMsg || 'emit_exhausted_retries' };
}

/**
 * @param {{ id: string, category?: string, country_iso?: string, requested_by: string }} job
 */
async function emitDiscoveryJobCompleted(job) {
  const owner = job.requested_by;
  if (!owner) return { ok: false, skipped: true, reason: 'no_requested_by' };

  const jid = String(job.id);
  const body = {
    owner_user_id: String(owner),
    dedupe_key: `discovery_job:${jid}:completed`,
    signal_type: 'discovery_completed',
    severity: 2,
    entity_type: 'discovery_job',
    entity_key: jid,
    event_type: 'discovery.completed',
    timeline_title: `深度搜索已完成 · ${jid.slice(0, 8)}`,
    timeline_body: '数据已写入情报库，请回到找买家用相近关键词再搜。',
    notification_title: '深度搜索任务已完成',
    notification_body: `你的深度搜索任务「${job.category ?? ''} / ${job.country_iso ?? ''}」已完成，可前往任务详情或重新搜索查看新线索。`,
    notification_type: 'crm_watch_signal',
    deeplink_path: `/my-discovery-jobs/${jid}`,
    payload_json: {
      discovery_job_id: jid,
      category: job.category ?? null,
      country_iso: job.country_iso ?? null,
    },
  };
  return postCrmWatchEmit(body, 'discovery.completed');
}

/**
 * @param {{ id: string, category?: string, country_iso?: string, requested_by?: string|null }} job
 * @param {string} errorCode 稳定短码，如 pipeline_exit_non_zero
 */
async function emitDiscoveryJobFailed(job, errorCode) {
  const owner = job.requested_by;
  if (!owner) return { ok: false, skipped: true, reason: 'no_requested_by' };

  const jid = String(job.id);
  const code = String(errorCode || 'failed').slice(0, 200);
  const body = {
    owner_user_id: String(owner),
    dedupe_key: `discovery_job:${jid}:failed`,
    signal_type: 'discovery_failed',
    severity: 3,
    entity_type: 'discovery_job',
    entity_key: jid,
    event_type: 'discovery.failed',
    timeline_title: `深度搜索失败 · ${jid.slice(0, 8)}`,
    timeline_body: `任务未成功完成。错误码：${code}`,
    notification_title: '深度搜索任务失败',
    notification_body: `你的深度搜索任务「${job.category ?? ''} / ${job.country_iso ?? ''}」失败：${code}`,
    notification_type: 'crm_watch_signal',
    deeplink_path: `/my-discovery-jobs/${jid}`,
    payload_json: {
      discovery_job_id: jid,
      error_code: code,
      category: job.category ?? null,
      country_iso: job.country_iso ?? null,
    },
  };
  return postCrmWatchEmit(body, 'discovery.failed');
}

function discoveryCompletionNotifyMode() {
  const m = (process.env.DISCOVERY_COMPLETION_NOTIFY || 'supabase').trim().toLowerCase();
  if (m === 'legacy' || m === 'supabase') return 'supabase';
  if (m === 'emit' || m === 'http') return 'emit';
  if (m === 'both') return 'both';
  return 'supabase';
}

module.exports = {
  emitDiscoveryJobCompleted,
  emitDiscoveryJobFailed,
  discoveryCompletionNotifyMode,
  resolveAppBaseUrl,
  resolveEmitSecret,
};
