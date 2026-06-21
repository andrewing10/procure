/**
 * Supabase discovery_enrichment_queue — Render SKIP_SQLITE=true 时的异步富化替代。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function enqueueEnrichmentLeads(supabase, rows) {
  if (!supabase || !Array.isArray(rows) || rows.length === 0) return 0;
  const payload = rows
    .filter((r) => r && r.company_name && r.domain)
    .map((r) => ({
      discovery_job_id: r.discovery_job_id || null,
      company_name: String(r.company_name).slice(0, 200),
      domain: String(r.domain).slice(0, 512),
      country_iso: r.country_iso ? String(r.country_iso).slice(0, 2).toUpperCase() : null,
      payload_json: r.payload_json || {},
      status: 'pending',
    }));
  if (payload.length === 0) return 0;
  const { error } = await supabase.from('discovery_enrichment_queue').insert(payload);
  if (error) {
    console.warn('[enrichment-queue] enqueue failed:', error.message);
    return 0;
  }
  return payload.length;
}

async function processEnrichmentBatch(supabase, limit = 5) {
  if (!supabase) return { processed: 0 };
  const { data: pending, error } = await supabase
    .from('discovery_enrichment_queue')
    .select('id,company_name,domain,country_iso,payload_json,retry_count')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error || !pending || pending.length === 0) return { processed: 0 };

  let processed = 0;
  for (const row of pending) {
    await supabase
      .from('discovery_enrichment_queue')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', row.id);

    const items = [{
      company_name: row.company_name,
      domain: row.domain,
      country: row.country_iso || '',
      pillar: 'enrichment_queue',
    }];
    const ts = Date.now();
    const inFile = path.join(process.cwd(), `.tmp_eq_${ts}.json`);
    const outFile = path.join(process.cwd(), `.tmp_eq_out_${ts}.json`);
    try {
      fs.writeFileSync(inFile, JSON.stringify(items, null, 2));
      execSync(`node v8_step3_ultimate_enrichment.js "${inFile}" "${outFile}"`, {
        stdio: 'inherit',
        env: { ...process.env, SKIP_L3_INFERENCE: 'true' },
      });
      const enriched = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const hit = Array.isArray(enriched) && enriched.some((l) => l.primary_email || l.primary_phone);
      await supabase.from('discovery_enrichment_queue').update({
        status: hit ? 'done' : 'failed',
        error_message: hit ? null : 'no_contact_found',
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
      if (hit) processed += 1;
    } catch (e) {
      const retries = Number(row.retry_count || 0) + 1;
      await supabase.from('discovery_enrichment_queue').update({
        status: retries >= 3 ? 'failed' : 'pending',
        retry_count: retries,
        error_message: String(e.message || e).slice(0, 200),
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
    } finally {
      try { if (fs.existsSync(inFile)) fs.unlinkSync(inFile); } catch { /* */ }
      try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* */ }
    }
  }
  return { processed };
}

module.exports = { enqueueEnrichmentLeads, processEnrichmentBatch };
