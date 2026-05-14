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
const { evaluateLead } = require('./v8_quality_gate');

const [inputFile, outputFile] = process.argv.slice(2);

const CATAGENT_API_URL = (process.env.CATAGENT_API_URL || '').replace(/\/$/, '');
const CATAGENT_API_KEY = process.env.CATAGENT_API_KEY || '';
const DISCOVERY_JOB_ID = process.env.DISCOVERY_JOB_ID || null;
const SKIP_SQLITE = process.env.SKIP_SQLITE === 'true';
const FALLBACK_PATH = process.env.OPS_FALLBACK_PATH || 'ops_hot_inbox_fallback.json';

// 种子库反哺路径 — 高置信线索写回后供 Pillar0 下轮激活，并驱动 Lookalike 裂变
const SEED_PATH           = 'zhimao_seed_intelligence.json';
// 置信度门槛：>= 90 且有联系方式 → 种子级，值得在下轮 Pillar0 激活并做 Lookalike
const SEED_CONFIDENCE_MIN = Number(process.env.SEED_CONFIDENCE_MIN) || 90;
if (!CATAGENT_API_URL) { console.error('[step5] CATAGENT_API_URL env var is required'); process.exit(1); }

const leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// ── Local SQLite ────────────────────────────────────────────────────────────
let insertMain = null;
let insertQueue = null;
if (!SKIP_SQLITE) {
    const db = new Database('zhimao_v8_matrix.sqlite');
    // 唯一约束为 (company_name, country) — 与 zhimao DB 的 UNIQUE(name_canonical, country) 对齐。
    // 跨国同名公司（如"Samsung"在 KR 和 VN）是不同实体，不能合并。
    // 注：若本地已有旧 main_db 表（仅 company_name UNIQUE），需手动 DROP TABLE main_db 重建。
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
    insertMain = db.prepare(`INSERT OR IGNORE INTO main_db (company_name, domain, country, primary_email, primary_phone, confidence_score, entity_role, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertQueue = db.prepare(`INSERT OR IGNORE INTO enrichment_queue (company_name, domain, country, score) VALUES (?, ?, ?, ?)`);
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

// ── Quality Gate (P0) — 与 zhimao computeQualityGrade 完全对齐 ───────────────
// 使用 v8_quality_gate.js（镜像 zhimao/apps/web/lib/data-intel/quality.ts）。
//
// 规则对齐的意义：
//   V8 在此处拦截的数据 ≡ zhimao 在搜索层用 .neq(quality_grade,unqualified) 隐藏的数据。
//   两端规则一致 → 不再出现"上传消耗配额但展示不了"的浪费，也不再有"能展示但内容为空卡"的客诉。
//
// grade 分布统计帮助运营判断数据管线健康度：
//   premium   — 高置信 L3 + 真实联系方式（解锁 30 分）
//   qualified — 有联系方式（解锁 10 分）
//   unqualified — 丢弃，不上传

// ── 区域专属高价值源置信度加权 ───────────────────────────────────────────────
// 来自 Pillar10 VerifiedSource（seznam.cz/b2bbrazil/thomasnet 等）的线索：
//   verified_source_boost 已由 Step1 附加到 lead，在质量门前统一应用
let _sourceRegistry = null;
try {
    if (fs.existsSync('zhimao_verified_source_registry.json')) {
        _sourceRegistry = JSON.parse(fs.readFileSync('zhimao_verified_source_registry.json', 'utf8'));
    }
} catch (_) {}

function applySourceBoost(lead) {
    // Pillar10 命中时已附带 verified_source_boost
    const pillarBoost = Number(lead.verified_source_boost || 0);
    // tax_verified 由 v8_tax_verifier.js 标记（若在流水线中启用）
    const taxBoost    = lead.tax_verified ? 35 : 0;
    let total         = pillarBoost + taxBoost;

    // ── 产品规格"95分满级组合触发"规则 ────────────────────────────────────────
    // 当多个高质量维度同时命中时，将 confidence_score 强制提升到 95（而不只是叠加）
    // 对应产品描述：黄页有名字 + 社交媒体有决策人 + AliceWeb 海关记录 → 95分
    const hasHVC = lead.verified_source_id;                              // 命中高价值源
    const hasTax = lead.tax_verified;                                    // 税务验证通过
    const hasBOL = lead.intent_signal === 'BOL_SIGNAL' ||
                   lead.intent_signal === 'CUSTOMS_SIGNAL';              // 海关信号
    const hasDecisionMaker = lead.intent_signal === 'PROCUREMENT_DECISION_MAKER'; // 决策人
    const hasContact = !!(lead.primary_email || lead.primary_phone);     // 有联系方式
    const ib = lead.inference_breakdown;
    const hasHighL3 = ib && ib.confidence_tier === 'High';               // L3高置信

    // 满级条件：同时满足 ≥2 个独立维度
    const dimensionCount = [hasHVC, hasTax || hasBOL, hasDecisionMaker, hasContact && hasHighL3]
        .filter(Boolean).length;

    if (dimensionCount >= 2) {
        const prev = Number(lead.confidence_score ?? 60) + total;
        const forced = Math.max(prev, 92); // 至少 92 分，封顶 100
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
    .map(applySourceBoost) // 先加权，再过质量门
    .filter(lead => {
        const { qualified, grade } = evaluateLead(lead);
        gradeStats[grade] = (gradeStats[grade] || 0) + 1;
        lead._quality_grade = grade; // 附加到 lead 供日志使用
        return qualified;
    });
const droppedQuality = totalLeads - validLeads.length;
if (droppedQuality > 0) {
    console.log(`[step5] quality-gate veto: dropped ${droppedQuality}/${totalLeads} (unqualified). grade distribution: premium=${gradeStats.premium} qualified=${gradeStats.qualified} unqualified=${gradeStats.unqualified}`);
} else {
    console.log(`[step5] quality-gate pass: ${validLeads.length}/${totalLeads}. premium=${gradeStats.premium} qualified=${gradeStats.qualified}`);
}

// 仅对 validLeads（已过质量门）做本地 SQLite 分流，避免 unqualified 数据
// 污染本地分析库和 enrichment_queue（否则队列会被无价值条目永远占满）
validLeads.forEach(lead => {
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
        // 有域名但分数未达热铅门槛 → 进 enrichment_queue 等待二次 Playwright 补全联系
        insertQueue.run(lead.company_name, lead.domain, lead.country || '', lead.confidence_score);
    }
});

// ── 种子库反哺写回（闭环核心）────────────────────────────────────────────────
// 设计逻辑：
//   1. 选出本轮 hot leads（confidence >= 90 且有联系方式）
//   2. 追加写入 zhimao_seed_intelligence.json（去重，已有 domain 不重复写）
//   3. 下轮 Step1 Pillar0 读取后激活这些种子
//   4. Cron expandSparseIndustries 读取种子品类后可做 Lookalike 裂变
(function writeSeedFeedback() {
    const hotLeads = leads.filter(l =>
        l.confidence_score >= SEED_CONFIDENCE_MIN &&
        (l.primary_email || l.primary_phone) &&
        l.company_name && l.domain
    );
    if (hotLeads.length === 0) return;

    let seeds = [];
    try {
        if (fs.existsSync(SEED_PATH)) {
            seeds = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
        }
    } catch { seeds = []; }

    // 已有种子的 domain 集合（去重基准）
    const existingDomains = new Set(seeds.map(s => (s.domain || '').toLowerCase()));
    let added = 0;
    for (const lead of hotLeads) {
        const domainKey = (lead.domain || '').toLowerCase();
        if (!domainKey || existingDomains.has(domainKey)) continue;
        seeds.push({
            company_name:    lead.company_name,
            domain:          lead.domain,
            country:         lead.country   || '',
            category:        lead.category  || lead.pillar || '',
            primary_email:   lead.primary_email  || null,
            primary_phone:   lead.primary_phone  || null,
            confidence_score: lead.confidence_score,
            entity_role:     lead.entity_role    || null,
            seed_source:     'v8_auto_feedback',
            seeded_at:       new Date().toISOString(),
        });
        existingDomains.add(domainKey);
        added++;
    }
    if (added > 0) {
        fs.writeFileSync(SEED_PATH, JSON.stringify(seeds, null, 2));
        console.log(`[step5] 🌱 Seed feedback: +${added} new seeds → ${SEED_PATH} (total=${seeds.length}). Next run Pillar0 will activate them.`);
    }
})();

// ── Catagent API Push (BulkL1Item format) ───────────────────────────────────
function mapToBulkL1Item(lead) {
    // categories 语义：采购品类/行业标签（字符串数组），
    // 不应用 inferred_bom（BOM 材料键名，格式不同）。
    // 优先取 L3 推断的 procurement_items，降级到 pillar/category 来源标签。
    const ib = lead.inference_breakdown;
    let categories;
    if (ib && Array.isArray(ib.procurement_items) && ib.procurement_items.length > 0) {
        // procurement_items 元素是 { category, priority, ... } 对象，必须提取 .category 字符串；
        // 直接传整个对象会让 bulk/route.ts String(obj) → "[object Object]"
        categories = ib.procurement_items
            .slice(0, 5)
            .map(item => (item && typeof item === 'object' && typeof item.category === 'string')
                ? item.category.trim()
                : (typeof item === 'string' ? item.trim() : null))
            .filter(Boolean);
        if (categories.length === 0) categories = undefined;
    } else if (lead.category && typeof lead.category === 'string') {
        categories = [lead.category];                         // 来自 Step0 的品类标签
    } else if (lead.pillar && typeof lead.pillar === 'string') {
        categories = [lead.pillar];                           // 降级：pillar 名称作为品类
    }

    return {
        name:                 lead.company_name || '',
        country:              lead.country      || '',
        domain:               lead.domain       || undefined,
        primary_email:        lead.primary_email || undefined,
        primary_phone:        lead.primary_phone || undefined,
        categories:           categories || undefined,
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
                failedItems: slice,
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
            const failed = Array.isArray(result.failedItems) ? result.failedItems : [];
            if (failed.length > 0) {
                writeFallbackInbox(failed, `catagent_push_failed_http_${result.statusCode}`);
            } else {
                writeFallbackInbox(validLeads, `catagent_push_failed_http_${result.statusCode}_unknown_slice`);
            }
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
