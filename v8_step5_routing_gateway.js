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
    insertMain = db.prepare(`INSERT OR IGNORE INTO main_db (company_name, domain, country, primary_email, primary_phone, confidence_score, entity_role, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
        // country 列已经在 CREATE TABLE 里声明，但历史 INSERT 漏填会让整列为 NULL —
        // 现在补齐，避免后续按国家做本地分析/重跑时拿到空值。
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

// Bulk API 的硬上限是 2000 条/次（zhimao route.ts payload_too_large=2000）。
// 这里取 1000 作为单批阈值，留足缓冲：
//   - 避免边界 off-by-one
//   - 单批 payload 大约 1~2MB，对 Vercel/Render 都更友好
//   - 让一批失败时丢失面更小，便于人工/自动重抓
const BULK_BATCH_SIZE = Number(process.env.STEP5_BATCH_SIZE) > 0
    ? Number(process.env.STEP5_BATCH_SIZE)
    : 1000;

// 单次请求的硬超时（毫秒）。Vercel cold start + 大批 upsert 偶尔会超 30s，
// 但永远等下去会拖死整个 cron worker，60s 是经验值。
const REQUEST_TIMEOUT_MS = Number(process.env.STEP5_REQUEST_TIMEOUT_MS) > 0
    ? Number(process.env.STEP5_REQUEST_TIMEOUT_MS)
    : 60_000;

// Push a single batch to Catagent (zhimao) Bulk API.
// 返回 { statusCode, body } 以便上层判定 L1 是否落库 + L3 是否分裂失败。
function pushBatchToCatagent(items, batchIndex, batchTotal) {
    return new Promise(resolve => {
        const mappedItems = items.map(mapToBulkL1Item);
        // payload 只发 items —— zhimao Bulk API 已统一以 items 为主，旧的 data
        // 字段重复同一份数组，等于把 payload 体积凭空翻倍，删掉。
        const payload = JSON.stringify({
            batch_id:        `v8_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${batchIndex}of${batchTotal}`,
            timestamp:       new Date().toISOString(),
            target_database: 'Zhimao Main DB',
            workflow_used:   'v8-pipeline',
            total_imported:  mappedItems.length,
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
        let settled = false;
        const settleOnce = (val) => { if (!settled) { settled = true; resolve(val); } };

        const req = transport.request(requestOptions, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch { /* keep null */ }
                console.log(`[step5] batch ${batchIndex}/${batchTotal} Catagent HTTP ${res.statusCode}`);
                if (parsed) {
                    console.log(`[step5] batch ${batchIndex}/${batchTotal} body:`, JSON.stringify(parsed));
                } else if (body) {
                    console.log(`[step5] batch ${batchIndex}/${batchTotal} body(raw):`, body.slice(0, 500));
                }
                settleOnce({ statusCode: res.statusCode, body: parsed });
            });
        });

        // 60s 硬超时：服务端没回响应就主动断开，避免 cron worker 永远挂起。
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            console.error(`[step5] batch ${batchIndex}/${batchTotal} request timeout after ${REQUEST_TIMEOUT_MS}ms — destroying.`);
            req.destroy(new Error('request_timeout'));
        });
        req.on('error', e => {
            console.error(`[step5] batch ${batchIndex}/${batchTotal} Catagent push transport error: ${e.message}`);
            settleOnce({ statusCode: 0, body: null });
        });
        req.write(payload);
        req.end();
    });
}

// 单批最大重试次数（针对 5xx / transport 错误）
const BATCH_MAX_RETRIES = Number(process.env.STEP5_MAX_RETRIES) > 0
    ? Number(process.env.STEP5_MAX_RETRIES)
    : 3;
// 初始退避延迟 ms（指数退避：1s → 2s → 4s）
const BATCH_RETRY_BASE_MS = 1000;

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// 不可重试的状态码：认证失败、payload 过大、客户端错误（4xx 非 429）
function isRetryableStatus(code) {
    if (code === 0) return true;   // transport error
    if (code === 429) return true; // rate limit
    if (code >= 500) return true;  // server error
    return false;                  // 4xx client errors: don't retry
}

// Top-level orchestrator: 按 BULK_BATCH_SIZE 切片，逐批 push，失败自动重试。
// 任一批在 BATCH_MAX_RETRIES 次后仍失败，return failure，上层 main 决定是否 exit(1)。
// 任一批返回 l3_error，仅累计、不中断（L1 已写、L3 部分失败不致命）。
async function pushToCatagentBatched(items) {
    const total = items.length;
    if (total === 0) return { ok: true, attempted: 0, qualified: 0, l3WrittenSum: 0, l3AttemptedSum: 0, l3Errors: [] };

    const batchTotal = Math.ceil(total / BULK_BATCH_SIZE);
    let qualifiedSum = 0;
    let l3WrittenSum = 0;
    let l3AttemptedSum = 0;
    const l3Errors = [];

    for (let batchIndex = 1; batchIndex <= batchTotal; batchIndex++) {
        const start = (batchIndex - 1) * BULK_BATCH_SIZE;
        const slice = items.slice(start, start + BULK_BATCH_SIZE);
        console.log(`[step5] pushing batch ${batchIndex}/${batchTotal} (${slice.length} leads, total=${total})`);

        let lastStatusCode = 0;
        let lastBody = null;
        let succeeded = false;

        for (let attempt = 1; attempt <= BATCH_MAX_RETRIES; attempt++) {
            const { statusCode, body } = await pushBatchToCatagent(slice, batchIndex, batchTotal);
            lastStatusCode = statusCode;
            lastBody = body;

            if (statusCode >= 200 && statusCode < 300) {
                succeeded = true;
                break;
            }

            if (!isRetryableStatus(statusCode)) {
                // 4xx 客户端错误不重试（配置问题，重试无意义）
                console.error(`[step5] batch ${batchIndex}/${batchTotal} non-retryable HTTP ${statusCode} — aborting.`);
                break;
            }

            if (attempt < BATCH_MAX_RETRIES) {
                const delay = BATCH_RETRY_BASE_MS * Math.pow(2, attempt - 1);
                console.warn(`[step5] batch ${batchIndex}/${batchTotal} failed (HTTP ${statusCode}), retrying in ${delay}ms (attempt ${attempt}/${BATCH_MAX_RETRIES})...`);
                await sleep(delay);
            }
        }

        if (!succeeded) {
            console.error(`[step5] batch ${batchIndex}/${batchTotal} FAILED after ${BATCH_MAX_RETRIES} attempts (last HTTP ${lastStatusCode}).`);
            console.error('[step5] Hint: 401=missing/wrong CATAGENT_API_KEY · 404=wrong CATAGENT_API_URL · 413=batch too large (lower STEP5_BATCH_SIZE) · 500=DB schema mismatch (run latest migrations).');
            return {
                ok: false,
                failedBatch: batchIndex,
                batchTotal,
                statusCode: lastStatusCode,
                attempted: start + slice.length,
                qualified: qualifiedSum,
                l3WrittenSum,
                l3AttemptedSum,
                l3Errors,
            };
        }

        if (lastBody && typeof lastBody === 'object') {
            qualifiedSum    += Number(lastBody.qualified)    || 0;
            l3WrittenSum    += Number(lastBody.l3_written)   || 0;
            l3AttemptedSum  += Number(lastBody.l3_attempted) || 0;
            if (lastBody.l3_error) {
                l3Errors.push({ batch: `${batchIndex}/${batchTotal}`, ...lastBody.l3_error });
            }
        }
    }

    return { ok: true, attempted: total, qualified: qualifiedSum, l3WrittenSum, l3AttemptedSum, l3Errors };
}

(async () => {
    if (validLeads.length > 0) {
        console.log(`[step5] Pushing ${validLeads.length} leads to Catagent at ${CATAGENT_API_URL} (batch size=${BULK_BATCH_SIZE}, request timeout=${REQUEST_TIMEOUT_MS}ms)...`);
        const result = await pushToCatagentBatched(validLeads);

        if (!result.ok) {
            console.error(`[step5] aborting after batch ${result.failedBatch}/${result.batchTotal}; cumulative qualified=${result.qualified}, attempted=${result.attempted}/${validLeads.length}.`);
            process.exit(1);
        }

        // 所有批都 2xx。L3 partial failure 仅记录、不致命（保持原行为）。
        if (result.l3Errors.length > 0) {
            console.error(`[step5] L1 ok (qualified=${result.qualified}), L3 partial failures across ${result.l3Errors.length} batch(es):`);
            for (const e of result.l3Errors) console.error(`  - batch ${e.batch}: ${e.message}`);
            console.error('[step5] L3 故障常见原因：data_intel_l3_inferred 表/列不全，请确认最新 schema 迁移已部署。');
        } else {
            console.log(`[step5] All written: L1.qualified=${result.qualified}, L3=${result.l3WrittenSum}/${result.l3AttemptedSum}`);
        }
    } else {
        console.log('[step5] No valid leads to push.');
    }
    fs.writeFileSync(outputFile, JSON.stringify({ status: 'success', db_injected: validLeads.length }, null, 2));
    console.log(`[step5] Done → ${outputFile}`);
})();
