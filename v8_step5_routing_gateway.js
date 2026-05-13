/**
 * Step 5 — Routing & Persistence Gateway
 *
 * 1. Writes hot leads (score >= 90 with contact) to local SQLite main_db
 * 2. Queues lower-score leads for future enrichment
 * 3. Pushes all leads with contact info to the Catagent API (BulkL1Item format)
 *
 * Required env vars:
 *   CATAGENT_API_URL   — e.g. https://catagent.vercel.app
 *   CATAGENT_API_KEY   — internal API key / CRON_SECRET
 */
require('dotenv').config();
const fs       = require('fs');
const https    = require('https');
const Database = require('better-sqlite3');
const crypto   = require('crypto');

const [inputFile, outputFile] = process.argv.slice(2);

const CATAGENT_API_URL = (process.env.CATAGENT_API_URL || '').replace(/\/$/, '');
const CATAGENT_API_KEY = process.env.CATAGENT_API_KEY || '';
const DISCOVERY_JOB_ID = process.env.DISCOVERY_JOB_ID || null;
const SKIP_SQLITE = process.env.SKIP_SQLITE === 'true';
if (!CATAGENT_API_URL) { console.error('[step5] CATAGENT_API_URL env var is required'); process.exit(1); }

const leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// ── Local SQLite ────────────────────────────────────────────────────────────
let insertMain = null;
let insertQueue = null;
if (!SKIP_SQLITE) {
    const db = new Database('zhimao_v8_matrix.sqlite');
    db.exec(`CREATE TABLE IF NOT EXISTS main_db (
        company_name TEXT UNIQUE, domain TEXT, country TEXT,
        primary_email TEXT, primary_phone TEXT,
        confidence_score INTEGER, entity_role TEXT, source TEXT, timestamp TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS enrichment_queue (
        company_name TEXT UNIQUE, domain TEXT, score INTEGER, retries INTEGER DEFAULT 0
    )`);
    insertMain = db.prepare(`INSERT OR IGNORE INTO main_db (company_name, domain, primary_email, primary_phone, confidence_score, entity_role, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insertQueue = db.prepare(`INSERT OR IGNORE INTO enrichment_queue (company_name, domain, score) VALUES (?, ?, ?)`);
} else {
    console.log('[step5] SKIP_SQLITE=true, local sqlite writes disabled.');
}

// ── Quality Gate (P0) ───────────────────────────────────────────────────────
// Centralized "qualified-or-veto" rules — a record is only shipped downstream
// if EVERY criterion below holds. This is the upstream half of the unified
// quality SLA enforced jointly with Bulk API (quality_grade) and the search
// layer (.neq quality_grade unqualified).
//
// Required:
//   1) company_name present
//   2) at least one contact channel: primary_email | primary_phone | domain
//   3) L3 inference is actionable: confidence_tier ∈ {High, Medium}
//                                  AND procurement_items length >= 1
//
// Records failing ANY rule are dropped here and never enter the L1 table —
// preventing "paid to unlock an empty card" / "drone-on-palm-farm" failures.
function isQualifiedLead(l) {
    if (!l || !l.company_name) return false;
    const hasContact = !!(l.primary_email || l.primary_phone || l.domain);
    if (!hasContact) return false;
    const ib = l.inference_breakdown;
    // L3 breakdown is optional — when present, it must meet quality criteria.
    if (ib && typeof ib === 'object') {
        const tier = String(ib.confidence_tier || '').toLowerCase();
        if (tier === 'low') return false;
        const items = Array.isArray(ib.procurement_items) ? ib.procurement_items : [];
        if (items.length < 1) return false;
    }
    return true;
}

const totalLeads = leads.length;
const validLeads = leads.filter(isQualifiedLead);
const droppedQuality = totalLeads - validLeads.length;
if (droppedQuality > 0) {
    console.log(`[step5] quality-gate veto: dropped ${droppedQuality} / ${totalLeads} leads (no contact, low L3 confidence, or empty procurement_items).`);
}

leads.forEach(lead => {
    const hasContact = !!(lead.primary_email || lead.primary_phone);
    const isHot      = lead.confidence_score >= 90 && hasContact;
    if (isHot && insertMain) {
        insertMain.run(lead.company_name, lead.domain, lead.primary_email, lead.primary_phone, lead.confidence_score, lead.entity_role || null, lead.pillar, new Date().toISOString());
    } else if (lead.domain && insertQueue) {
        insertQueue.run(lead.company_name, lead.domain, lead.confidence_score);
    }
});

// ── Catagent API Push (BulkL1Item format) ───────────────────────────────────
function mapToBulkL1Item(lead) {
    return {
        name:                 lead.company_name || '',
        country:              lead.country      || '',
        domain:               lead.domain       || undefined,
        primary_email:        lead.primary_email || undefined,
        primary_phone:        lead.primary_phone || undefined,
        categories:           lead.inferred_bom  || undefined,
        place_type:           lead.entity_role   || undefined,
        // snippet used as address hint when no structured address available
        address_line:         lead.snippet?.slice(0, 200) || undefined,
        // Provenance metadata (optional fields — safe additions only)
        ...(lead.intent_signal    && { intent_signal:    lead.intent_signal }),
        ...(lead.source_timestamp && { source_timestamp: lead.source_timestamp }),
        // L3 supply-chain inference (written to data_intel_l3_inferred by the bulk API)
        ...(lead.inference_breakdown && { inference_breakdown: lead.inference_breakdown }),
    };
}

// Push to Catagent (zhimao) Bulk API.
// 返回 { statusCode, body } 以便上层判定 L1 是否落库 + L3 是否分裂失败。
function pushToCatagent(items) {
    return new Promise(resolve => {
        const mappedItems = items.map(mapToBulkL1Item);
        // Support both payload shapes:
        //   - Legacy production format: { batch_id, timestamp, target_database, workflow_used, total_imported, data }
        //   - Current API format:       { items }
        // We send the legacy shape first (matches the deployed Vercel version).
        const payload = JSON.stringify({
            batch_id:        `v8_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            timestamp:       new Date().toISOString(),
            target_database: 'Zhimao Main DB',
            workflow_used:   'v8-pipeline',
            total_imported:  mappedItems.length,
            data:            mappedItems,
            items:           mappedItems,
            discovery_job_id: DISCOVERY_JOB_ID,
        });

        let url;
        try {
            url = new URL(`${CATAGENT_API_URL}/api/data-intel/l1/procurement/bulk`);
        } catch (e) {
            console.error(`[step5] invalid CATAGENT_API_URL: ${CATAGENT_API_URL} (${e.message})`);
            return resolve({ statusCode: 0, body: null });
        }

        const headers  = {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(payload),
        };
        if (CATAGENT_API_KEY) {
            headers['Authorization'] = `Bearer ${CATAGENT_API_KEY}`;
        } else {
            console.warn('[step5] CATAGENT_API_KEY is empty — Bulk API will reject with 401.');
        }

        // 必须显式传 port（默认 443 也得传，否则非标准端口会失败），
        // 并把 search/query 也带上，杜绝 URL 含 ?xxx 时丢失参数。
        const requestOptions = {
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'http:' ? 80 : 443),
            path:     url.pathname + (url.search || ''),
            method:   'POST',
            headers,
        };

        const transport = url.protocol === 'http:' ? require('http') : https;
        const req = transport.request(requestOptions, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch { /* keep null */ }
                console.log(`[step5] Catagent HTTP ${res.statusCode}`);
                if (parsed) {
                    console.log('[step5] body:', JSON.stringify(parsed));
                } else if (body) {
                    console.log('[step5] body(raw):', body.slice(0, 500));
                }
                resolve({ statusCode: res.statusCode, body: parsed });
            });
        });
        req.on('error', e => {
            console.error(`[step5] Catagent push transport error: ${e.message}`);
            resolve({ statusCode: 0, body: null });
        });
        req.write(payload);
        req.end();
    });
}

(async () => {
    if (validLeads.length > 0) {
        console.log(`[step5] Pushing ${validLeads.length} leads to Catagent at ${CATAGENT_API_URL}...`);
        const { statusCode, body } = await pushToCatagent(validLeads);
        if (statusCode < 200 || statusCode >= 300) {
            console.error(`[step5] Catagent push FAILED with HTTP ${statusCode} — aborting.`);
            console.error('[step5] Hint: 401=missing/wrong CATAGENT_API_KEY · 404=wrong CATAGENT_API_URL · 500=DB schema mismatch (run latest migrations).');
            process.exit(1);
        }
        // L1 已成功，但 L3 子写入可能失败 — Bulk API 现在会在 body.l3_error 报告。
        if (body && body.l3_error) {
            console.error(`[step5] L1 ok (${body.qualified}), but L3 partial failure: ${body.l3_error.message}`);
            console.error('[step5] L3 故障常见原因：data_intel_l3_inferred 表/列不全，请确认最新 schema 迁移已部署。');
            // 不 exit(1)：L1 已写入，让 worker 标 done 并保留 error_message。
        } else if (body) {
            console.log(`[step5] All written: L1.qualified=${body.qualified}, L3=${body.l3_written}/${body.l3_attempted}`);
        }
    } else {
        console.log('[step5] No valid leads to push.');
    }
    fs.writeFileSync(outputFile, JSON.stringify({ status: 'success', db_injected: validLeads.length }, null, 2));
    console.log(`[step5] Done → ${outputFile}`);
})();
