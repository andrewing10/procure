/**
 * discovery_enrichment_queue 消费者 — Playwright 补 contact（SKIP_L3，仅联系方式）。
 * 由 v8_discovery_worker 空闲时调用，或独立运行：node v8_discovery_enrichment_worker.js
 */
require('./load-env');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  getSupabase,
  claimEnrichmentBatch,
  markQueueRow,
  applyEnrichedLead,
  BATCH_SIZE,
} = require('./v8_supabase_enrichment_queue');
const { sleep } = require('./v8_lib_concurrency');

const DEDICATED = process.env.ENRICH_WORKER_DEDICATED === '1';
const POLL_MS = Math.max(2000, parseInt(process.env.ENRICH_POLL_MS || '5000', 10));

function runStep3ContactOnly(items) {
  const ts = Date.now();
  const inFile = path.join(process.cwd(), `.tmp_deq_in_${ts}.json`);
  const outFile = path.join(process.cwd(), `.tmp_deq_out_${ts}.json`);
  try {
    fs.writeFileSync(inFile, JSON.stringify(items, null, 2));
    execSync(`node v8_step3_ultimate_enrichment.js "${inFile}" "${outFile}"`, {
      stdio: 'inherit',
      env: { ...process.env, SKIP_L3_INFERENCE: 'true', STEP3_DEFER_CONTACT: '0' },
    });
    const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('[deq-worker] step3 contact failed:', e.message);
    return [];
  } finally {
    try { if (fs.existsSync(inFile)) fs.unlinkSync(inFile); } catch (_) {}
    try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) {}
  }
}

/**
 * 处理一批队列；返回处理条数（0 = 队列空或失败）。
 * @param {import('@supabase/supabase-js').SupabaseClient|null} [supabaseOverride]
 */
async function processEnrichmentQueueBatch(supabaseOverride = null) {
  const supabase = supabaseOverride || getSupabase();
  if (!supabase) {
    console.warn('[deq-worker] supabase env missing, skip');
    return 0;
  }

  const claimed = await claimEnrichmentBatch(supabase, BATCH_SIZE);
  if (claimed.length === 0) return 0;

  console.log(`[deq-worker] processing ${claimed.length} deferred contact rows`);

  const inputs = claimed.map((row) => {
    const base = row.payload_json?.lead && typeof row.payload_json.lead === 'object'
      ? row.payload_json.lead
      : {};
    return {
      ...base,
      company_name: base.company_name || row.company_name,
      domain: base.domain || row.domain,
      country: base.country || row.country_iso || '',
      pillar: base.pillar || 'DeferredEnrichment',
    };
  });

  const enriched = runStep3ContactOnly(inputs);
  const byKey = new Map(
    enriched.map((l) => [
      `${(l.company_name || '').toLowerCase().trim()}|${(l.country || '').toUpperCase()}`,
      l,
    ]),
  );

  let promoted = 0;
  for (const row of claimed) {
    const key = `${row.company_name.toLowerCase().trim()}|${(row.country_iso || '').toUpperCase()}`;
    const lead = byKey.get(key);
    const hasContact = !!(lead?.primary_email || lead?.primary_phone);

    if (!hasContact) {
      await markQueueRow(supabase, row.id, 'failed', 'no_contact_found');
      continue;
    }

    try {
      const merged = {
        ...(row.payload_json?.lead || {}),
        ...lead,
        company_name: lead.company_name || row.company_name,
        domain: lead.domain || row.domain,
        country: lead.country || row.country_iso,
      };
      const res = await applyEnrichedLead(supabase, merged, row.discovery_job_id);
      if (res.ok) {
        await markQueueRow(supabase, row.id, 'done');
        promoted += 1;
        console.log(`[deq-worker] promoted ${merged.company_name} contact=${merged.primary_email || merged.primary_phone}`);
      } else {
        await markQueueRow(supabase, row.id, 'failed', res.reason || 'ingest_failed');
      }
    } catch (e) {
      await markQueueRow(supabase, row.id, 'failed', e.message);
    }
  }

  console.log(`[deq-worker] batch done: promoted=${promoted}/${claimed.length}`);
  return promoted;
}

async function runDedicatedLoop() {
  console.log(`[deq-worker] dedicated loop started (poll=${POLL_MS}ms, batch=${BATCH_SIZE})`);
  while (true) {
    try {
      const n = await processEnrichmentQueueBatch();
      if (n === 0) await sleep(POLL_MS);
    } catch (e) {
      console.error('[deq-worker] loop error:', e?.message || e);
      await sleep(POLL_MS);
    }
  }
}

if (require.main === module) {
  if (DEDICATED) {
    runDedicatedLoop().catch((e) => {
      console.error('[deq-worker] fatal:', e);
      process.exit(1);
    });
  } else {
    processEnrichmentQueueBatch()
      .then((n) => {
        if (n === 0) console.log('[deq-worker] nothing to process');
        process.exit(0);
      })
      .catch((e) => {
        console.error('[deq-worker] fatal:', e);
        process.exit(1);
      });
  }
}

module.exports = { processEnrichmentQueueBatch };
