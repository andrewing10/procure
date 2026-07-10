require('./load-env');
const fs      = require('fs');
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { pMap, callGeminiJson } = require('./v8_lib_concurrency');
const { normalizePurchaseCycle } = require('./v8_l1_field_normalize');
const { extractSocialUrls } = require('./v8_lib_social_extract');
const { enrichContactsForLead, getEnricherWaterfallStats } = require('./v8_lib_contact_enricher');
const { readIcpContext } = require('./v8_lib_pillar0');

const [inputFile, outputFile] = process.argv.slice(2);
const SKIP_L3_INFERENCE = process.env.SKIP_L3_INFERENCE === 'true';
// P6b：供应商模式下，买家"反向验证"会把制造商/出口商判成 seller=none 而误杀目标，
// 因此跳过 REVERSE-VERIFICATION GATE（step5 同步跳过买家闸门）。
const IS_SUPPLIER_MODE = readIcpContext().direction === 'find_suppliers';

/**
 * 买家抓取矩阵：matrix.include_social_profiles 控制社媒 URL 富化。
 * false → extractFromHTML 不传 socials Set，节省 Playwright 分析时间；
 * true（默认）→ 正常聚合社媒 URL。
 */
const MATRIX_INCLUDE_SOCIAL = (() => {
  try {
    const raw = process.env.PILLAR0_PAYLOAD || '';
    if (!raw) return true;
    const p = JSON.parse(raw);
    return p?.matrix?.include_social_profiles !== false;
  } catch { return true; }
})();

const GEMINI_KEY   = process.env.GEMINI_KEY;
// Step3 L3 供应链推断 — 与 zhimao llmClient / render.yaml 对齐（勿用已下线的 preview-04-17）
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const OPENAI_KEY   = process.env.OPENAI_API_KEY || '';
// L3 推断是最复杂的任务；用户指令 2026-05-20：OpenAI 第三位、用 GPT-5.4+
// （render.yaml 生产 env 已设 OPENAI_MODEL=gpt-5.5；本地 .env 可覆盖）
const OPENAI_MODEL = process.env.OPENAI_MODEL   || 'gpt-5.4';
const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
if (!GEMINI_KEY) { console.error('[step3] GEMINI_KEY env var is required'); process.exit(1); }

const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// Browser / proxy config (unchanged) ─────────────────────────────────────────
const BRD_USER  = process.env.BRD_USER  || '';
const BRD_PASS  = process.env.BRD_PASS  || '';
const BRD_PROXY = process.env.BRD_PROXY || 'http://brd.superproxy.io:22225';
const USE_PROXY = process.env.USE_PROXY === 'true';
const USE_BRD_SB = process.env.USE_BRD_SB === 'true';
const BRD_SB_WSS = process.env.BRD_SB_WSS || '';

// 超时从 15s 降低到 10s：大多数公司联系页 2-5s 可加载，15s 超时导致 Step3 是最慢瓶颈
const PLAYWRIGHT_TIMEOUT  = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '10000', 10);

// Tuning knobs --------------------------------------------------------------
//   BOM_BATCH_SIZE / L3_CONCURRENCY  → Gemini L3 inference parallelism
//   STEP3_PAGE_CONCURRENCY           → Playwright contact extraction parallelism
// batch size 减小到 5（默认）：更短 prompt = Gemini 响应更快，减少超时率
// 如需高吞吐可在 .env 中设 BOM_BATCH_SIZE=10（需稳定的 Gemini Pro 配额）
// 默认 8：15 时 Gemini 常截断 JSON → Claude 兜底（+30–40s/batch）
const BOM_BATCH_SIZE        = Math.max(1, parseInt(process.env.BOM_BATCH_SIZE || '8',  10));
const L3_CONCURRENCY        = Math.max(1, parseInt(process.env.L3_CONCURRENCY || '3',  10));
// L3 timeout 提升到 60s：gemini-2.5-flash 通常 10-20s，但高负载时可达 50s+
const L3_TIMEOUT_MS         = Math.max(5_000, parseInt(process.env.L3_TIMEOUT_MS || '60000', 10));
// 默认重试 1：超时场景下 3 次会把单 batch 拖到数分钟，易触发整步 STEP_TIMEOUT
const L3_MAX_RETRIES        = Math.max(0, parseInt(process.env.L3_MAX_RETRIES || '1', 10));
// 并发数提升：4 → 8（在有代理或高带宽环境下可进一步调高至 12）
const PAGE_CONCURRENCY      = Math.max(1, parseInt(process.env.STEP3_PAGE_CONCURRENCY || '8', 10));

/** SIGTERM / 超时杀进程时尽快刷盘，供 master 降级落库 */
let step3Abort = false;
let step3LeadsRef = null;
function flushStep3Checkpoint(reason) {
    if (!outputFile || !Array.isArray(step3LeadsRef) || step3LeadsRef.length === 0) return false;
    try {
        fs.writeFileSync(outputFile, JSON.stringify(step3LeadsRef, null, 2));
        console.warn(`[step3] checkpoint flushed (${reason}): ${step3LeadsRef.length} leads → ${outputFile}`);
        return true;
    } catch (e) {
        console.warn(`[step3] checkpoint flush failed:`, e?.message || e);
        return false;
    }
}
process.on('SIGTERM', () => {
    if (step3Abort) return;
    step3Abort = true;
    console.warn('[step3] SIGTERM — flushing checkpoint then exit so master can persist partial data');
    flushStep3Checkpoint('SIGTERM');
    try { flushDomainCache(); } catch (_) { /* ignore */ }
    try { flushL3Cache(); } catch (_) { /* ignore */ }
    process.exit(0);
});
process.on('SIGINT', () => {
    if (step3Abort) return;
    step3Abort = true;
    flushStep3Checkpoint('SIGINT');
    process.exit(0);
});

// ── 域名抓取缓存（本地文件，跳过 30 天内已爬取的域名）─────────────────────────
// 避免 cron 每次重跑都对同一家公司 Playwright，既浪费时间又增加被封风险
const DOMAIN_CACHE_FILE = 'zhimao_domain_contact_cache.json';
const DOMAIN_CACHE_TTL_DAYS = parseInt(process.env.DOMAIN_CACHE_TTL_DAYS || '30', 10);
let domainContactCache = {};
try {
    if (fs.existsSync(DOMAIN_CACHE_FILE)) {
        domainContactCache = JSON.parse(fs.readFileSync(DOMAIN_CACHE_FILE, 'utf8'));
    }
} catch { domainContactCache = {}; }

function getCachedContact(domain) {
    const entry = domainContactCache[domain];
    if (!entry) return null;
    const ageMs = Date.now() - new Date(entry.cached_at).getTime();
    if (ageMs > DOMAIN_CACHE_TTL_DAYS * 86400 * 1000) return null; // 过期
    return entry; // { primary_email, primary_phone, cached_at }
}

function setCachedContact(domain, email, phone) {
    domainContactCache[domain] = { primary_email: email || null, primary_phone: phone || null, cached_at: new Date().toISOString() };
}

function flushDomainCache() {
    try { fs.writeFileSync(DOMAIN_CACHE_FILE, JSON.stringify(domainContactCache, null, 2)); } catch {}
}

// ── L3 推断缓存（跨 sweep 复用，避免对同一公司重复调 Gemini）─────────────────
// 键 = 公司名(归一化) | 目标品类 | 买家/供应商方向（target_category_match 依赖这两者，必须入键）。
// 缓存未命中 = 完全维持原 LLM 推断行为；命中则套用上次结果，省掉一次 batch 的 token + 时延。
const L3_CACHE_FILE = 'zhimao_l3_inference_cache.json';
const L3_CACHE_TTL_DAYS = parseInt(process.env.L3_CACHE_TTL_DAYS || '30', 10);
let l3InferenceCache = {};
try {
    if (fs.existsSync(L3_CACHE_FILE)) l3InferenceCache = JSON.parse(fs.readFileSync(L3_CACHE_FILE, 'utf8'));
} catch { l3InferenceCache = {}; }

const normNameL3 = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
function l3CacheKeyFor(lead) {
    const cat = String(process.env.DISCOVERY_CATEGORY || '').trim().slice(0, 80).toLowerCase();
    return `${normNameL3(lead.company_name)}|${cat}|${IS_SUPPLIER_MODE ? 'sup' : 'buy'}`;
}
function getCachedL3(key) {
    const entry = l3InferenceCache[key];
    if (!entry || !entry.v) return null;
    const ageMs = Date.now() - new Date(entry.cached_at).getTime();
    if (ageMs > L3_CACHE_TTL_DAYS * 86400 * 1000) return null;
    return entry.v;
}
function setCachedL3(key, value) {
    if (key && value) l3InferenceCache[key] = { v: value, cached_at: new Date().toISOString() };
}
function flushL3Cache() {
    try { fs.writeFileSync(L3_CACHE_FILE, JSON.stringify(l3InferenceCache)); } catch {}
}
// 命中缓存时把已推断字段套回 lead（与下方 LLM 合并路径写入的字段保持一致）。
function applyCachedL3(lead, c) {
    lead.entity_role = c.entity_role || 'Service';
    lead.inferred_bom = Array.isArray(c.inferred_bom) ? c.inferred_bom : [];
    if (lead.entity_role === 'Manufacturer') lead.confidence_score = (lead.confidence_score || 50) + 20;
    else if (lead.entity_role === 'Wholesaler' || lead.entity_role === 'Retailer') lead.confidence_score = (lead.confidence_score || 50) + 10;
    lead.inference_breakdown = c.inference_breakdown;
}

/**
 * L3 Supply Chain Inference (Gemini).
 *
 * Batches run in parallel with bounded concurrency, timeouts, and retry.
 * Each lead gets `inference_breakdown` for Step5 / L1, plus entity_role and inferred_bom.
 */
async function inferL3SupplyChain(leads) {
    if (leads.length === 0) return leads;

    // 跨 sweep 复用：命中 L3 缓存的 lead 直接套用上次推断，不再调 LLM（缓存未命中=维持原行为）。
    const toInfer = [];
    let l3CacheHits = 0;
    for (const lead of leads) {
        const cached = getCachedL3(l3CacheKeyFor(lead));
        if (cached) { applyCachedL3(lead, cached); l3CacheHits += 1; }
        else toInfer.push(lead);
    }
    if (toInfer.length === 0) {
        console.log(`[step3] L3 inference: all ${leads.length} entities served from cache (0 LLM calls)`);
        return leads;
    }

    const batches = [];
    for (let i = 0; i < toInfer.length; i += BOM_BATCH_SIZE) {
        batches.push(toInfer.slice(i, i + BOM_BATCH_SIZE));
    }
    console.log(`[step3] L3 supply-chain inference for ${toInfer.length} entities (cache_hit=${l3CacheHits}/${leads.length}) in ${batches.length} batch(es) of ${BOM_BATCH_SIZE}, concurrency=${L3_CONCURRENCY}, timeout=${L3_TIMEOUT_MS}ms`);

    const overallStart = Date.now();

    await pMap(batches, async (batch, idx) => {
        const batchIndex = idx + 1;
        const batchTotal = batches.length;
        const startedAt = Date.now();

        // 业态画像树工程 — 反向验证锚点：
        // expand-query 已经把"用 ${category} 的下游业态画像"作为 personas 输出，step1 用 personas
        // 的 industry_en 搜到候选公司（不带 category）。这里 L3 必须反向验证"该公司是否真的采购 ${category}"，
        // 否则会把"电子厂"全收进来，但很多电子厂其实不买纸箱（PCB 厂 vs 整机组装厂）。
        const TARGET_CATEGORY = String(process.env.DISCOVERY_CATEGORY || '').trim().slice(0, 80);
        // 供应商模式：不注入买家反向验证（否则 LLM 把目标供应商判 none）。
        const reverseVerifyBlock = (TARGET_CATEGORY && !IS_SUPPLIER_MODE)
            ? `

[REVERSE-VERIFICATION GATE — INDUSTRY PERSONA TREE]
The user's original search target category is: "${TARGET_CATEGORY}".
For EACH company, additionally output:
  "target_category_match": "high" | "medium" | "low" | "none"
    high   = company's primary operations REQUIRE "${TARGET_CATEGORY}" as core input/merchandise (must buy)
    medium = plausibly procures "${TARGET_CATEGORY}" occasionally / auxiliarily
    low    = unlikely buyer (industry adjacent but no clear procurement pathway)
    none   = clearly NOT a buyer (different supply chain, e.g. service-only, software, finance)
  "target_category_evidence": one short English sentence (≤80 chars) explaining WHY this company would
    procure "${TARGET_CATEGORY}" — cite the specific use-case (e.g. "Packages e-commerce orders into
    shipping cartons" / "Imports food products that need outer cartons for distribution").
  "target_category_reason": short snake_case code: "core_input" | "auxiliary" | "adjacent" | "no_pathway"

⚠ This is the most important field — it gates whether the lead is shown to the user.
⚠ "Service" entity_role companies almost always = none/low for physical-goods categories.
⚠ Be conservative: if you cannot articulate a specific procurement use-case, output "low" or "none".

[ENTITY-ROLE DISAMBIGUATION — BUYER vs NON-BUYER]
The following entity types are NEVER direct buyers regardless of industry relevance:
1. Manufacturers/producers of the SAME category: If a company MAKES "${TARGET_CATEGORY}", it is the SELLER,
   not the buyer. E.g. searching "stainless steel tableware" — a tableware manufacturer is the seller.
   → Assign target_category_match: "none", target_category_reason: "no_pathway"
2. Trade associations / federations / councils / membership organizations: The ASSOCIATION ITSELF does not
   procure the category — only its member companies do. E.g. "International Foodservice Distributors
   Association" represents distributors but does NOT buy tableware itself.
   → Assign target_category_match: "none", target_category_reason: "no_pathway"
3. Freight / logistics / customs broker companies: They transport goods, not purchase them.
   → Assign target_category_match: "none" or "low", target_category_reason: "no_pathway"
4. Market research / industry analytics firms: They produce reports, not physical goods.
   → Assign target_category_match: "none", target_category_reason: "no_pathway"

⚠ CRITICAL disambiguation: "entity ITSELF directly procures" = buyer (target_category_match: high/medium)
   "its members / clients / served parties procure" ≠ that entity is a buyer (target_category_match: none)
⚠ Verify entity_role field BEFORE assigning target_category_match — Manufacturer entities are sellers
   for the same category they produce.`
            : '';

        const reverseVerifyJsonHint = (TARGET_CATEGORY && !IS_SUPPLIER_MODE)
            ? `,"target_category_match":"...","target_category_evidence":"...","target_category_reason":"..."`
            : '';

        const prompt = `You are a Supply Chain Intelligence AI. Analyze each company and produce a structured L3 procurement inference.

Rules:
1. entity_role: "Manufacturer" (makes goods), "Wholesaler" (bulk buys/resells), "Retailer" (end-consumer facing), "Service" (services only).
2. primary_materials_top3: exactly 3 upstream raw materials or finished goods they must procure. Use short English snake_case keys (e.g. "memory_foam", "pocket_springs", "fabric_ticking").
3. procurement_items: array of {category, priority(1-3), source:"bom", type:"explicit"}.
4. confidence_tier: "High" (role is unambiguous), "Medium" (probable), "Low" (guessed).
5. intent_summary: one English sentence — "<Name> is a <role> that procures <top materials> from upstream suppliers."
6. purchase_cycle: "weekly" | "monthly" | "quarterly" | "annual" — best estimate.
7. reason_codes: non-empty array from ["BOM_INFERENCE","ENTITY_ROLE_MANUFACTURER","ENTITY_ROLE_WHOLESALER","ENTITY_ROLE_RETAILER","ENTITY_ROLE_SERVICE","SUPPLY_CHAIN_GRAPH"].${reverseVerifyBlock}

Output strict JSON only. results[] MUST be the same length and order as Input (results[i] describes Input[i]).
Copy each company's "name" EXACTLY from Input — do not translate, shorten, or invent names.
{"results":[{"name":"Exact Company Name","entity_role":"...","confidence_tier":"...","primary_materials_top3":["...","...","..."],"procurement_items":[{"category":"...","priority":1,"source":"bom","type":"explicit"}],"intent_summary":"...","purchase_cycle":"...","reason_codes":["..."]${reverseVerifyJsonHint}}]}

Input: ${JSON.stringify(batch.map(l => ({ name: l.company_name, snip: (l.snippet || '').slice(0, 120) })))}`;

        let parsed;
        try {
            parsed = await callGeminiJson(prompt, {
                apiKey: GEMINI_KEY, model: GEMINI_MODEL, temperature: 0.2,
                timeoutMs: L3_TIMEOUT_MS, maxRetries: L3_MAX_RETRIES,
                label: `step3/L3.b${batchIndex}`,
                openaiApiKey: OPENAI_KEY,
                openaiModel:  OPENAI_MODEL,
                claudeApiKey: CLAUDE_KEY,
                claudeModel:  CLAUDE_MODEL,
            });
        } catch (e) {
            console.warn(`[step3] L3 batch ${batchIndex}/${batchTotal} FAILED after ${Date.now() - startedAt}ms: ${e.message}`);
            return;
        }

        const results = Array.isArray(parsed?.results)
            ? parsed.results
            : (Array.isArray(parsed) ? parsed : []);
        const now = new Date().toISOString();
        // 归一化比较：去除多余空格、大小写统一，防止 Gemini 返回名称与原始名称
        // 细微差异（首字母大写/尾部空格）导致 find 失败，inference_breakdown 丢失。
        const normName = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
        const usedLeadIdx = new Set();
        let merged = 0;
        let nameMiss = 0;

        const applyL3Result = (lead, r) => {
            if (!lead || !r || typeof r !== 'object') return false;
            lead.entity_role = r.entity_role || 'Service';
            lead.inferred_bom = Array.isArray(r.primary_materials_top3)
                ? r.primary_materials_top3.map(s => String(s).trim().toLowerCase())
                : [];
            if (r.entity_role === 'Manufacturer') lead.confidence_score = (lead.confidence_score || 50) + 20;
            else if (r.entity_role === 'Wholesaler' || r.entity_role === 'Retailer') lead.confidence_score = (lead.confidence_score || 50) + 10;
            // 业态画像树工程：反向验证字段（仅在 DISCOVERY_CATEGORY 注入时由 LLM 输出）
            // 写入 inference_breakdown 既有 JSON，无需 schema 变更；step5 闸门读这里。
            const reverseMatchRaw = String(r.target_category_match || '').toLowerCase();
            const reverseMatch = ['high', 'medium', 'low', 'none'].includes(reverseMatchRaw)
                ? reverseMatchRaw
                : null;
            const reverseEvidence = typeof r.target_category_evidence === 'string'
                ? r.target_category_evidence.trim().slice(0, 120)
                : '';
            const reverseReasonRaw = String(r.target_category_reason || '').toLowerCase();
            const reverseReason = ['core_input', 'auxiliary', 'adjacent', 'no_pathway'].includes(reverseReasonRaw)
                ? reverseReasonRaw
                : null;

            lead.inference_breakdown = {
                category:               lead.inferred_bom[0] || null,
                entity_role:            r.entity_role,
                confidence_tier:        r.confidence_tier || 'Medium',
                primary_materials_top3: lead.inferred_bom,
                procurement_items:      Array.isArray(r.procurement_items)
                    ? r.procurement_items.map(item =>
                        typeof item === 'object' && item !== null
                            ? { ...item, category: typeof item.category === 'string' ? item.category.trim().toLowerCase() : item.category }
                            : item
                      )
                    : [],
                intent_summary:         r.intent_summary || '',
                purchase_cycle:         normalizePurchaseCycle(r.purchase_cycle) || 'quarterly',
                reason_codes:           Array.isArray(r.reason_codes) ? r.reason_codes : ['BOM_INFERENCE'],
                // ── 业态画像树反向验证（target_category_* 仅在 worker 注入了 DISCOVERY_CATEGORY 时填充）──
                target_category:        process.env.DISCOVERY_CATEGORY || null,
                target_category_match:  reverseMatch,        // 'high'|'medium'|'low'|'none'|null
                target_category_evidence: reverseEvidence || null,
                target_category_reason: reverseReason,       // 'core_input'|'auxiliary'|'adjacent'|'no_pathway'|null
                model_version:          'v8-gemini-l3-v2',   // bump：新增反向验证字段
                demand_source:          'inferred',
                graph_snapshot_version: 'v1',
                created_at:             now,
                rfq_draft: {
                    title:        r.intent_summary || '',
                    description:  r.intent_summary || '',
                    status:       'open',
                    visibility:   'public',
                    source_type:  'l3_inferred',
                    currency:     'USD',
                    published_at: now,
                },
            };
            // 写 L3 缓存：只存合并后用得到的字段，下次同公司+品类直接复用
            setCachedL3(l3CacheKeyFor(lead), {
                entity_role: lead.entity_role,
                inferred_bom: lead.inferred_bom,
                inference_breakdown: lead.inference_breakdown,
            });
            return true;
        };

        for (let ri = 0; ri < results.length; ri++) {
            const r = results[ri];
            if (!r || typeof r !== 'object') continue;
            // LLM 偶发用 company_name 而非 name
            if (!r.name && (r.company_name || r.company)) {
                r.name = r.company_name || r.company;
            }
        }

        // 严格按输入顺序合并：results[i] ↔ batch[i]（prompt 已要求同序同长、name 原样回传）。
        // 不再跨位按名称乱配，避免 A 的推断写到 B。
        const n = Math.min(results.length, batch.length);
        for (let i = 0; i < n; i++) {
            const r = results[i];
            if (!r || typeof r !== 'object') continue;
            const rNorm = normName(r.name);
            const bNorm = normName(batch[i].company_name);
            if (rNorm && bNorm && rNorm !== bNorm) nameMiss += 1;
            if (applyL3Result(batch[i], r)) {
                usedLeadIdx.add(i);
                merged += 1;
            }
        }

        if (results.length === 0) {
            const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? Object.keys(parsed).slice(0, 8)
                : [];
            console.warn(
                `[step3] L3 batch ${batchIndex}/${batchTotal}: empty results ` +
                `(parsed_type=${Array.isArray(parsed) ? 'array' : typeof parsed}, keys=${JSON.stringify(keys)})`,
            );
        } else if (merged === 0) {
            console.warn(
                `[step3] L3 batch ${batchIndex}/${batchTotal}: order-merge got 0; ` +
                `results=${results.length} sample_names=${JSON.stringify(results.slice(0, 3).map((x) => x?.name))} ` +
                `batch_names=${JSON.stringify(batch.slice(0, 3).map((l) => l.company_name))}`,
            );
        }

        console.log(
            `[step3] L3 batch ${batchIndex}/${batchTotal} merged ${merged}/${batch.length}` +
            (nameMiss ? ` (name_drift=${nameMiss})` : '') +
            ` (${Date.now() - startedAt}ms)`,
        );
    }, { concurrency: L3_CONCURRENCY });

    flushL3Cache();
    console.log(`[step3] L3 inference total wall=${Date.now() - overallStart}ms (cache_hit=${l3CacheHits}/${leads.length})`);
    return leads;
}

// ─── 反检测 User-Agent 池（保持最新 Chrome 版本，避免被识别为过期机器人） ──────
const UA_POOL_DESKTOP = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
const UA_POOL_MOBILE = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];
const VIEWPORT_POOL = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900  },
  { width: 1366, height: 768  },
  { width: 1536, height: 864  },
];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// navigator.webdriver 和自动化特征注入脚本
// 在页面加载前执行，覆盖 Playwright 暴露的机器人特征
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
  window.chrome = { runtime: {} };
  const orig = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : orig(params);
`;

// ── WhatsApp 号码规范化（统一输出 +country_code + 纯数字格式） ──────────────
function normalizeWhatsApp(raw) {
    if (!raw) return null;
    // wa.me/+601XXXXXXXX 或 wa.me/601XXXXXXXX 或 tel:+601XXXXXXXX
    const digits = raw.replace(/^.*wa\.me\//i, '').replace(/^tel:/i, '').replace(/[^0-9+]/g, '');
    if (digits.length < 7) return null;
    return digits.startsWith('+') ? digits : `+${digits}`;
}

// ─── HTML 字段提取（邮箱、电话、WhatsApp、公开社媒主页 URL 一并抽取）─────
// 买家抓取矩阵 Batch 3：socials 为 Set<string>，每次合并；不传时仅抽 email/phone（向后兼容）
const extractFromHTML = (html, emails, phones, socials) => {
    const $ = cheerio.load(html);

    $('a[href^="mailto:"]').each((_, el) => {
        const em = $(el).attr('href').replace('mailto:', '').split('?')[0].trim().toLowerCase();
        if (em.includes('@')) emails.add(em);
    });

    $('a[href^="tel:"]').each((_, el) => {
        phones.add($(el).attr('href').replace('tel:', '').trim());
    });

    // WhatsApp 链接专项：wa.me / api.whatsapp.com / WhatsApp 按钮文本附近的号码
    $('a[href*="wa.me/"], a[href*="api.whatsapp.com/send"], a[href*="whatsapp.com/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const wap = normalizeWhatsApp(href);
        if (wap) phones.add(wap); // WhatsApp 号码入 phones（统一格式）
    });

    // 文本正则兜底：匹配 +CountryCode+数字格式的电话号
    const bodyText = $('body').text();
    const phoneRegex = /(\+\d{1,3}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{4,6})/g;
    let m;
    while ((m = phoneRegex.exec(bodyText)) !== null) {
        const num = m[1].replace(/[\s\-.()']/g, '');
        if (num.replace(/\D/g, '').length >= 7) phones.add(num);
    }

    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/g;
    while ((m = emailRegex.exec(bodyText)) !== null) {
        const em = m[1].toLowerCase();
        if (!em.endsWith('.png') && !em.endsWith('.jpg') && !em.endsWith('.jpeg')) emails.add(em);
    }

    if (socials instanceof Set) {
        try {
            const urls = extractSocialUrls($, html);
            for (const u of urls) socials.add(u);
        } catch (_) { /* social extraction is opportunistic */ }
    }
};

// ─── Google Places API：按公司名称查电话 + 官网（节省 Playwright 资源）────────
// 策略：有 GMAPS_KEY + 公司名 → findplacefromtext，命中返回 {phone, website}
// 无 key 或查无 → null（不阻塞主流程）
const https2 = require('https');
function httpsGetStep3(url) {
    return new Promise(resolve => {
        https2.get(url, r => {
            let data = ''; r.on('data', c => data += c);
            r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
        }).on('error', () => resolve({}));
    });
}

async function lookupContactViaGooglePlaces(companyName, countryIso, knownPlaceId = null) {
    if (!GMAPS_KEY || !companyName) return null;
    try {
        // step1 maps pillar 已带 place_id 时直接查详情，省掉一次 findplacefromtext 调用（去重复 Places 计费）。
        let placeId = knownPlaceId || null;
        if (!placeId) {
            const q = encodeURIComponent(`${companyName}${countryIso ? ' ' + countryIso : ''}`);
            const findUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json`
                + `?input=${q}&inputtype=textquery`
                + `&fields=place_id,name,business_status`
                + `&key=${GMAPS_KEY}`;
            const findRes = await httpsGetStep3(findUrl);
            if (findRes.status !== 'OK' || !findRes.candidates?.length) return null;
            placeId = findRes.candidates[0].place_id;
        }
        if (!placeId) return null;

        const detUrl = `https://maps.googleapis.com/maps/api/place/details/json`
            + `?place_id=${encodeURIComponent(placeId)}`
            + `&fields=name,formatted_phone_number,website,business_status`
            + `&key=${GMAPS_KEY}`;
        const detRes = await httpsGetStep3(detUrl);
        if (detRes.status !== 'OK' || !detRes.result) return null;

        const r = detRes.result;
        const phone   = r.formatted_phone_number || null;
        const website = r.website || null;
        if (!phone && !website) return null;
        return { phone, website, business_status: r.business_status || null, source: 'google_places' };
    } catch (_) { return null; }
}

async function extractContactForLead(lead, contexts) {
    let score = lead.confidence_score || 50;
    lead.primary_email = lead.primary_email || lead.email || null;
    lead.primary_phone = lead.primary_phone || lead.phone || null;

    // ── ❶ Google Places API 预填充（比 Playwright 快 10-50x，节省代理配额）────
    // 只对还缺电话/官网的 lead 执行，且必须有公司名
    if (GMAPS_KEY && lead.company_name && (!lead.primary_phone || !lead.domain)) {
        const gmapsResult = await lookupContactViaGooglePlaces(lead.company_name, lead.country_iso || '', lead.place_id || null);
        if (gmapsResult) {
            if (gmapsResult.phone && !lead.primary_phone) {
                lead.primary_phone = gmapsResult.phone;
                score += 20;
            }
            if (gmapsResult.website && !lead.domain) {
                lead.domain = gmapsResult.website;
                score += 15;
            }
            if (gmapsResult.business_status === 'OPERATIONAL') score += 10;
            lead._gmaps_contact_filled = true;
            console.log(`[step3] Google Places prefill: ${lead.company_name} → phone=${gmapsResult.phone || 'none'} website=${gmapsResult.website || 'none'}`);
            // 如果电话和官网都补全了，跳过 Playwright（大幅节约时间）
            if (lead.primary_phone && lead.domain) {
                lead.confidence_score = Math.min(score, 100);
                return lead;
            }
        }
    }

    // ── 缓存命中：跳过 Playwright，直接使用已缓存的联系方式 ──────────────────
    if (lead.domain && lead.domain.startsWith('http')) {
        const cached = getCachedContact(lead.domain);
        if (cached) {
            if (cached.primary_email && !lead.primary_email) lead.primary_email = cached.primary_email;
            if (cached.primary_phone && !lead.primary_phone) lead.primary_phone = cached.primary_phone;
            if (lead.primary_email || lead.primary_phone) {
                score += 30;
                if (lead.pillar?.includes('LBS')) score += 15;
            } else {
                score = Math.min(score, 85);
            }
            lead.confidence_score = Math.min(score, 100);
            return lead; // 命中缓存，跳过 Playwright
        }
    }

    if (lead.domain && lead.domain.startsWith('http')) {
        const isFb = lead.domain.includes('facebook.com');
        const ctx  = isFb ? contexts.mobile : contexts.desktop;
        const emails  = new Set();
        const phones  = new Set();
        // 买家抓取矩阵：matrix.include_social_profiles=false 时跳过社媒 URL 聚合以节省时间
        const socials = MATRIX_INCLUDE_SOCIAL
            ? new Set(Array.isArray(lead.social_profile_urls) ? lead.social_profile_urls : [])
            : null;
        let page;
        try {
            page = await ctx.newPage();
            if (isFb) {
                let fbUrl = lead.domain.replace('www.facebook.com', 'mbasic.facebook.com');
                if (!fbUrl.includes('/groups/') && !fbUrl.includes('/share/') && !fbUrl.includes('/about')) fbUrl = fbUrl.replace(/\/$/, '') + '/about';
                await page.goto(fbUrl, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                extractFromHTML(await page.content(), emails, phones, socials);
            } else {
                await page.goto(lead.domain, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                extractFromHTML(await page.content(), emails, phones, socials);
                try {
                    const contactHref = await page.evaluate(() => {
                        const anchors = Array.from(document.querySelectorAll('a[href]'));
                        const exact   = anchors.find(a => /\/(contact|contacts|contact-us|contactus)(\/|$|\?)/i.test(a.getAttribute('href')));
                        const loose   = exact || anchors.find(a => /contact/i.test(a.textContent.trim()));
                        return loose ? loose.getAttribute('href') : null;
                    });
                    if (contactHref) {
                        const contactUrl = contactHref.startsWith('http') ? contactHref : new URL(contactHref, lead.domain).href;
                        await page.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                        extractFromHTML(await page.content(), emails, phones, socials);
                    }
                } catch (_) { /* contact page unreachable — ignore */ }
            }
        } catch (_) {
            /* timeout / network — keep going */
        } finally {
            if (page) await page.close().catch(() => {});
        }

        if (emails.size > 0) lead.primary_email = Array.from(emails)[0];
        const cleanPhones = Array.from(phones).filter(p => p.length < 20);
        if (cleanPhones.length > 0) lead.primary_phone = cleanPhones[0];
        // 买家抓取矩阵：仅在 includeSocial=true 时写 social_profile_urls
        if (MATRIX_INCLUDE_SOCIAL && socials instanceof Set && socials.size > 0) {
            lead.social_profile_urls = [...socials].slice(0, 8);
        }

        // 写入缓存（无论是否找到联系方式，避免下次重复爬取）
        setCachedContact(lead.domain, lead.primary_email, lead.primary_phone);

        if (lead.primary_email || lead.primary_phone) console.log(`[step3] Enriched: ${lead.company_name} | ${lead.primary_email || ''}`);
    }

    if (lead.primary_email || lead.primary_phone) {
        score += 30;
        if (lead.pillar?.includes('LBS')) score += 15;
    } else {
        score = Math.min(score, 85);
    }
    lead.confidence_score = Math.min(score, 100);

    // ─── 5 层兜底 enricher（仅在 Playwright + GMaps 都空时启用） ───────────
    // 旧实现到此为止：contact 全空就放过，下游 quality_gate 因 procurementSignalCount>0
    // 仍放它进 L1 → 用户看到"信息薄 0 + 优质 30 分"的欺骗卡。
    // 现接入 v8_lib_contact_enricher 的 5 层管道：直连 → 代理 → BFS → LLM → Serper
    // 任一层抓到就回填 primary_email/primary_phone；总 budget ~30s 控成本。
    // B2：无官网域名但有社媒/主页 URL 的私域线索也要触发（走主页深抽取路径）。
    const hasProfileUrls = Array.isArray(lead.social_profile_urls) && lead.social_profile_urls.length > 0;
    if (!lead.primary_email && !lead.primary_phone && (lead.domain || hasProfileUrls)) {
        try {
            const enr = await enrichContactsForLead({
                domain: lead.domain,
                company_name: lead.company_name,
                primary_email: lead.primary_email,
                primary_phone: lead.primary_phone,
                social_profile_urls: lead.social_profile_urls,
                profile_url: lead.profile_url,
                source_url: lead.source_url,
            });
            // B2/B3：开放渠道即便没填 primary_*（社媒主页常只有 IG/LinkedIn/官网外链）也要保留，
            // 供 buildL1Row 合成 contact_channels —— 故挂载移出 filled 门。
            if (Array.isArray(enr.channels) && enr.channels.length) lead._enricher_channels = enr.channels;
            lead._enricher_via = enr.via;
            if (enr.filled) {
                if (!lead.primary_email && enr.primary_email) lead.primary_email = enr.primary_email;
                if (!lead.primary_phone && enr.primary_phone) lead.primary_phone = enr.primary_phone;
                if (enr.primary_whatsapp) lead.primary_whatsapp = enr.primary_whatsapp;
                if (enr.llm_persons && enr.llm_persons.length > 0) {
                    lead._enricher_persons = enr.llm_persons;
                }
                lead.confidence_score = Math.min((lead.confidence_score || 0) + 25, 100);
                // 写缓存避免下次重抓（仅 domain 路径有意义）
                if (lead.domain) setCachedContact(lead.domain, lead.primary_email, lead.primary_phone);
                console.log(`[step3] 5-layer enricher filled (${enr.via}): ${lead.company_name} | ${lead.primary_email || ''} | ${lead.primary_phone || ''}`);
            } else {
                if (enr.any_blocked) lead._enricher_any_blocked = true;
            }
        } catch (e) {
            // 兜底失败一律安静吞，不影响主链
            console.warn(`[step3] 5-layer enricher exception for ${lead.company_name}:`, e && e.message ? e.message : String(e));
        }
    }
    return lead;
}

async function run() {
    let leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    step3LeadsRef = leads;
    if (SKIP_L3_INFERENCE) {
        console.log('[step3] SKIP_L3_INFERENCE=true, skipping L3 inference and only extracting contacts.');
    } else {
        leads = await inferL3SupplyChain(leads);
        step3LeadsRef = leads;
        // L3 完成后立刻落盘：即便后续 Playwright 被超时杀掉，master 也能用已有推断结果落库
        flushStep3Checkpoint('post-L3');
        if (step3Abort) return;
    }

    let browser;
    if (USE_BRD_SB) {
        if (!BRD_SB_WSS) { console.error('[step3] USE_BRD_SB=true but BRD_SB_WSS not set'); process.exit(1); }
        console.log('[step3] Using BrightData Scraping Browser via CDP (反检测最强模式)');
        browser = await chromium.connectOverCDP(BRD_SB_WSS);
    } else {
        // ── 启动参数：隐藏自动化特征，绕过 Cloudflare / Akamai 基础检测 ─────────
        const launchOptions = {
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',  // 最关键：隐藏自动化标识
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--window-size=1920,1080',
                '--disable-infobars',
                '--disable-extensions',
            ],
            ignoreDefaultArgs: ['--enable-automation'],           // 移除 Playwright 默认的自动化标志
        };
        if (USE_PROXY) {
            if (!BRD_USER || !BRD_PASS) { console.error('[step3] USE_PROXY=true but BRD_USER/BRD_PASS not set'); process.exit(1); }
            console.log(`[step3] 住宅IP代理已启用: ${BRD_PROXY}`);
            launchOptions.proxy = { server: BRD_PROXY, username: BRD_USER, password: BRD_PASS };
        } else {
            console.warn('[step3] ⚠️  USE_PROXY=false：使用本机IP。欧美大企业站点可能被 Cloudflare 拦截。');
            console.warn('[step3] ⚠️  建议：设置 USE_PROXY=true + BRD_USER/BRD_PASS 以启用住宅IP代理。');
        }
        try {
            browser = await chromium.launch(launchOptions);
        } catch (launchErr) {
            if (String(launchErr.message).includes("Executable doesn't exist")) {
                console.log("[step3] Chromium not found — installing now (first-run on this host)...");
                require('child_process').execSync(
                    'node ' + require('path').join(__dirname, 'node_modules', '.bin', 'playwright') + ' install chromium',
                    { stdio: 'inherit' }
                );
                console.log("[step3] Chromium install complete — retrying launch...");
                browser = await chromium.launch(launchOptions);
            } else {
                throw launchErr;
            }
        }
    }

    // ── 反检测 Context 配置：随机 UA + 视口 + 语言头 + stealth 脚本注入 ─────────
    const desktopUA = pick(UA_POOL_DESKTOP);
    const mobileUA  = pick(UA_POOL_MOBILE);
    const viewport  = pick(VIEWPORT_POOL);

    const desktopCtx = await browser.newContext({
        ignoreHTTPSErrors: true,
        userAgent: desktopUA,
        viewport,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        },
    });
    const mobileCtx = await browser.newContext({
        ignoreHTTPSErrors: true,
        userAgent: mobileUA,
        viewport: { width: 390, height: 844 },
        locale: 'en-US',
        extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
            'sec-ch-ua-mobile': '?1',
        },
    });

    // ── stealth 脚本：在每个页面加载前注入，覆盖 Playwright 暴露的机器人标识 ────
    await desktopCtx.addInitScript(STEALTH_INIT_SCRIPT);
    await mobileCtx.addInitScript(STEALTH_INIT_SCRIPT);

    console.log(`[step3] Browser ready. UA=${desktopUA.slice(0, 60)}...`);

    console.log(`[step3] Contact extraction over ${leads.length} leads, page concurrency=${PAGE_CONCURRENCY}, page timeout=${PLAYWRIGHT_TIMEOUT}ms`);
    const overallStart = Date.now();
    let contactDone = 0;
    const CHECKPOINT_EVERY = Math.max(1, parseInt(process.env.STEP3_CHECKPOINT_EVERY || '5', 10));
    const enriched = await pMap(
        leads,
        async (lead) => {
            if (step3Abort) return lead;
            const row = await extractContactForLead(lead, { desktop: desktopCtx, mobile: mobileCtx });
            contactDone += 1;
            if (contactDone % CHECKPOINT_EVERY === 0) {
                flushStep3Checkpoint(`contact-${contactDone}/${leads.length}`);
            }
            return row;
        },
        { concurrency: PAGE_CONCURRENCY },
    );

    try { await browser.close(); } catch (_) { /* ignore */ }
    flushDomainCache(); // 持久化本次抓取结果到缓存文件

    // pMap may return Error instances if any worker threw — keep success rows only.
    const finalLeads = enriched.filter(x => x && !(x instanceof Error));
    step3LeadsRef = finalLeads;
    const contactHit = finalLeads.filter(l => l.primary_email || l.primary_phone).length;

    fs.writeFileSync(outputFile, JSON.stringify(finalLeads, null, 2));
    console.log(`[step3] Done — ${finalLeads.length} enriched leads (contact_hit=${contactHit}, hit_rate=${Math.round(contactHit/finalLeads.length*100)}%) in ${Date.now() - overallStart}ms → ${outputFile}`);

    // ── B4 瀑布富化 funnel 打点 + 降级告警（RC-4，设计单源 §B4）────────────────
    try {
        const wf = getEnricherWaterfallStats();
        if (wf.leads > 0) {
            const layerStr = Object.entries(wf.layers)
                .map(([k, v]) => `${k}=${v.hit}/${v.attempted}${v.hit_rate != null ? `(${Math.round(v.hit_rate * 100)}%)` : ''}`)
                .join(' ');
            console.log(
                `[step3] enricher-waterfall: leads=${wf.leads} filled=${wf.filled}(${wf.fill_rate != null ? Math.round(wf.fill_rate * 100) : '–'}%) ` +
                `cost=${wf.cost_units}u(avg ${wf.avg_cost_per_lead}/lead) | ${layerStr}`,
            );
            // 降级告警：某层因缺 key/能力被迫跳过 → 命中率塌陷的根因，明确暴露而非静默
            const deg = wf.degraded;
            if (deg.llm_text_no_key > 0 || deg.vision_no_capability > 0 || deg.serper_no_key > 0) {
                console.warn(
                    `[step3] ⚠️ enricher-degraded: llm_no_key=${deg.llm_text_no_key} vision_no_capability=${deg.vision_no_capability} serper_no_key=${deg.serper_no_key} ` +
                    `— 对应富化层失效，contact 命中率会下降；请检查 GEMINI/SCREENSHOTONE/SERPER 配置。`,
                );
            }
        }
    } catch (e) {
        console.warn('[step3] enricher-waterfall stats failed:', e && e.message ? e.message : String(e));
    }
}

run().catch(e => { console.error('[step3] fatal:', e); process.exit(1); });
