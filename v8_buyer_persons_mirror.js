/**
 * P2：Step5 后显式 mirror buyer_persons（source=v8_pipeline），优于 l1_mirror trigger 默认 tier。
 */
require('./load-env');

const PIPELINE_VERSION = process.env.PIPELINE_VERSION || 'v8';

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Array<{ companyId: string, lead: object }>} pairs
 */
async function mirrorBuyerPersonsFromLeads(supabase, pairs) {
  if (!supabase || !Array.isArray(pairs) || pairs.length === 0) {
    return { mirrored: 0, skipped: 0 };
  }

  let mirrored = 0;
  let skipped = 0;

  for (const { companyId, lead } of pairs) {
    const email = lead.primary_email || null;
    const phone = lead.primary_phone || null;
    const linkedin = lead.linkedin_url || lead.source_url || null;
    if (!email && !phone && !linkedin) {
      skipped += 1;
      continue;
    }

    const { data: buyerId, error: ensureErr } = await supabase.rpc('ensure_buyer_profile_for_l1', {
      p_company_id: companyId,
    });
    if (ensureErr || !buyerId) {
      skipped += 1;
      continue;
    }

    const hasLinkedIn = Boolean(linkedin && String(linkedin).includes('linkedin'));
    const confRaw = Number(lead.confidence_score ?? 60);
    const confidence = Math.min(1, Math.max(0, confRaw / 100));

    const { error: upErr } = await supabase.rpc('upsert_buyer_person', {
      p_buyer_id: buyerId,
      p_email: email,
      p_phone: phone,
      p_whatsapp: null,
      p_linkedin_url: linkedin,
      p_full_name: lead.contact_name || null,
      p_title: lead.contact_title || null,
      p_source: 'v8_pipeline',
      p_source_tier: hasLinkedIn ? 'primary_api' : 'fallback_search',
      p_confidence: confidence,
      p_crawl_run_id: process.env.DISCOVERY_JOB_ID || null,
      p_pipeline_version: PIPELINE_VERSION,
      p_raw_excerpt: {
        pillar: lead.pillar || null,
        intent_signal: lead.intent_signal || null,
        discovery_job_id: process.env.DISCOVERY_JOB_ID || null,
      },
    });

    if (upErr) {
      skipped += 1;
    } else {
      mirrored += 1;
    }
  }

  if (mirrored > 0) {
    console.log(`[buyer_persons] mirrored ${mirrored} persons (skipped=${skipped})`);
  }
  return { mirrored, skipped };
}

module.exports = { mirrorBuyerPersonsFromLeads };
