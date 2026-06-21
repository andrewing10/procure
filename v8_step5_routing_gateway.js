/**
 * Step 5 — Routing & Persistence Gateway
 *
 * 1. Writes hot leads (score >= 90 with contact) to local SQLite main_db
 * 2. Queues lower-score leads for future enrichment
 * 3. Persists qualified leads to Supabase: data_intel_l1_companies + data_intel_graph_edges
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
require('./load-env');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const { directIngestQualifiedLeads } = require('./v8_direct_l1_ingest');
const { mirrorBuyerPersonsFromLeads } = require('./v8_buyer_persons_mirror');
const { evaluateLead } = require('./v8_quality_gate');

const [inputFile, outputFile] = process.argv.slice(2);

const DISCOVERY_JOB_ID = process.env.DISCOVERY_JOB_ID || null;
const SKIP_SQLITE = process.env.SKIP_SQLITE === 'true';
const FALLBACK_PATH = process.env.OPS_FALLBACK_PATH || 'ops_hot_inbox_fallback.json';

const SEED_PATH = 'zhimao_seed_intelligence.json';
const SEED_CONFIDENCE_MIN = Number(process.env.SEED_CONFIDENCE_MIN) || 90;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[step5] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// ── Local SQLite ────────────────────────────────────────────────────────────
let insertMain = null;
let insertQueue = null;
if (!SKIP_SQLITE) {
  const db = new Database('zhimao_v8_matrix.sqlite');
  db.exec(`CREATE TABLE IF NOT EXISTS main_db (
        company_name TEXT NOT NULL, domain TEXT, country TEXT NOT NULL DEFAULT '',
        primary_email TEXT, primary_phone TEXT,
        confidence_score INTEGER, entity_role TEXT, source TEXT, timestamp TEXT,
        UNIQUE(company_name, country)
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS enrichment_queue (
        company_name TEXT NOT NULL, domain TEXT, country TEXT NOT NULL DEFAULT '',
        score INTEGER, retries INTEGER DEFAULT 0,
        UNIQUE(company_name, country)
    )`);
  insertMain = db.prepare(
    `INSERT OR IGNORE INTO main_db (company_name, domain, country, primary_email, primary_phone, confidence_score, entity_role, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertQueue = db.prepare(
    `INSERT OR IGNORE INTO enrichment_queue (company_name, domain, country, score) VALUES (?, ?, ?, ?)`,
  );
} else {
  console.log('[step5] SKIP_SQLITE=true, local sqlite writes disabled.');
}

function writeFallbackInbox(items, reason) {
  if (!Array.isArray(items) || items.length === 0) return;
  let existing = [];
  try {
    if (fs.existsSync(FALLBACK_PATH)) {
      existing = JSON.parse(fs.readFileSync(FALLBACK_PATH, 'utf8'));
      if (!Array.isArray(existing)) existing = [];
    }
  } catch (_) {
    existing = [];
  }

  const now = new Date().toISOString();
  const records = items.map((lead) => ({
    reason,
    created_at: now,
    discovery_job_id: DISCOVERY_JOB_ID,
    lead,
  }));
  existing.push(...records);
  fs.writeFileSync(FALLBACK_PATH, JSON.stringify(existing, null, 2));
  console.warn(`[step5] fallback inbox appended: +${records.length} -> ${FALLBACK_PATH} (total=${existing.length})`);
}

// ── Quality Gate — 与 zhimao computeQualityGrade 对齐（v8_quality_gate）────

function applySourceBoost(lead) {
  const pillarBoost = Number(lead.verified_source_boost || 0);
  const taxBoost = lead.tax_verified ? 35 : 0;
  let total = pillarBoost + taxBoost;

  const hasHVC = lead.verified_source_id;
  const hasTax = lead.tax_verified;
  const hasBOL =
    lead.intent_signal === 'BOL_SIGNAL' || lead.intent_signal === 'CUSTOMS_SIGNAL';
  const hasDecisionMaker = lead.intent_signal === 'PROCUREMENT_DECISION_MAKER';
  const hasContact = !!(lead.primary_email || lead.primary_phone);
  const ib = lead.inference_breakdown;
  const hasHighL3 = ib && ib.confidence_tier === 'High';

  const dimensionCount = [hasHVC, hasTax || hasBOL, hasDecisionMaker, hasContact && hasHighL3].filter(
    Boolean,
  ).length;

  if (dimensionCount >= 2) {
    const prev = Number(lead.confidence_score ?? 60) + total;
    const forced = Math.max(prev, 92);
    lead.confidence_score = Math.min(100, forced);
    lead._combo_triggered = true;
    return lead;
  }

  if (total > 0) {
    const prev = Number(lead.confidence_score ?? 60);
    lead.confidence_score = Math.min(100, prev + total);
  }
  return lead;
}

const totalLeads = leads.length;
const gradeStats = { premium: 0, qualified: 0, unqualified: 0 };
const validLeads = leads
  .map(applySourceBoost)
  .filter((lead) => {
    if (!String(lead.country || '').trim()) return false;
    const { qualified, grade } = evaluateLead(lead);
    gradeStats[grade] = (gradeStats[grade] || 0) + 1;
    lead._quality_grade = grade;
    return qualified;
  });

const droppedQuality = totalLeads - validLeads.length;
if (droppedQuality > 0) {
  console.log(
    `[step5] quality-gate veto: dropped ${droppedQuality}/${totalLeads} (unqualified). grade distribution: premium=${gradeStats.premium} qualified=${gradeStats.qualified} unqualified=${gradeStats.unqualified}`,
  );
} else {
  console.log(
    `[step5] quality-gate pass: ${validLeads.length}/${totalLeads}. premium=${gradeStats.premium} qualified=${gradeStats.qualified}`,
  );
}

validLeads.forEach((lead) => {
  const hasContact = !!(lead.primary_email || lead.primary_phone);
  const isHot = lead.confidence_score >= 90 && hasContact;
  if (isHot && insertMain) {
    insertMain.run(
      lead.company_name,
      lead.domain,
      lead.country || null,
      lead.primary_email,
      lead.primary_phone,
      lead.confidence_score,
      lead.entity_role || null,
      lead.pillar,
      new Date().toISOString(),
    );
  } else if (lead.domain && insertQueue) {
    insertQueue.run(lead.company_name, lead.domain, lead.country || '', lead.confidence_score);
  }
});

// ── 种子库反哺写回 ───────────────────────────────────────────────────────────
(function writeSeedFeedback() {
  const hotLeads = leads.filter(
    (l) =>
      l.confidence_score >= SEED_CONFIDENCE_MIN &&
      (l.primary_email || l.primary_phone) &&
      l.company_name &&
      l.domain,
  );
  if (hotLeads.length === 0) return;

  let seeds = [];
  try {
    if (fs.existsSync(SEED_PATH)) {
      seeds = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    }
  } catch {
    seeds = [];
  }

  const existingDomains = new Set(seeds.map((s) => (s.domain || '').toLowerCase()));
  let added = 0;
  for (const lead of hotLeads) {
    const domainKey = (lead.domain || '').toLowerCase();
    if (!domainKey || existingDomains.has(domainKey)) continue;
    seeds.push({
      company_name: lead.company_name,
      domain: lead.domain,
      country: lead.country || '',
      category: lead.category || lead.pillar || '',
      primary_email: lead.primary_email || null,
      primary_phone: lead.primary_phone || null,
      confidence_score: lead.confidence_score,
      entity_role: lead.entity_role || null,
      seed_source: 'v8_auto_feedback',
      seeded_at: new Date().toISOString(),
    });
    existingDomains.add(domainKey);
    added += 1;
  }
  if (added > 0) {
    fs.writeFileSync(SEED_PATH, JSON.stringify(seeds, null, 2));
    console.log(
      `[step5] Seed feedback: +${added} new seeds → ${SEED_PATH} (total=${seeds.length}). Next run Pillar0 will activate them.`,
    );
  }
})();

(async () => {
  let ingestResult = null;
  if (validLeads.length > 0) {
    console.log(`[step5] Supabase L1 ingest: ${validLeads.length} leads...`);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    ingestResult = await directIngestQualifiedLeads(supabase, validLeads, {
      discoveryJobId: DISCOVERY_JOB_ID,
    });
    if (ingestResult.errors.length) {
      console.warn('[step5] ingest messages:', JSON.stringify(ingestResult.errors.slice(0, 20)));
      if (ingestResult.errors.length > 20) {
        console.warn(`[step5] ... and ${ingestResult.errors.length - 20} more`);
      }
    }
    if (!ingestResult.ok) {
      console.error('[step5] Supabase L1 ingest failed (see L1 upsert errors above).');
      writeFallbackInbox(validLeads, 'supabase_l1_ingest_failed');
      process.exit(1);
    }
    if (ingestResult.resolvedLeads < validLeads.length) {
      console.warn(
        `[step5] resolved ${ingestResult.resolvedLeads}/${validLeads.length} leads (some rows skipped or id lookup failed).`,
      );
    }
    console.log(
      `[step5] ingest ok: resolvedLeads=${ingestResult.resolvedLeads}, mappedLeads=${ingestResult.mappedLeads ?? ingestResult.resolvedLeads}, edgesWritten=${ingestResult.edgesWritten}`,
    );

    const persons = await mirrorBuyerPersonsFromLeads(
      supabase,
      ingestResult.resolvedPairs || [],
    );
    ingestResult.personsMirrored = persons.mirrored;
  } else {
    console.log('[step5] No valid leads to persist.');
  }

  const { patchFunnelStep } = require('./v8_discovery_funnel');
  await patchFunnelStep('step5', {
    label: 'Routing & Persistence',
    input_total: totalLeads,
    qualified: validLeads.length,
    premium: gradeStats.premium,
    l1_written: ingestResult?.resolvedLeads ?? 0,
    mapped: ingestResult?.mappedLeads ?? ingestResult?.resolvedLeads ?? 0,
    buyer_persons_mirrored: ingestResult?.personsMirrored ?? 0,
  });

  fs.writeFileSync(outputFile, JSON.stringify({ status: 'success', db_injected: validLeads.length }, null, 2));
  console.log(`[step5] Done → ${outputFile}`);
})();
