require('./load-env');
const fs = require('fs');
const { pMap, callGeminiJson, preFilterRawLeads } = require('./v8_lib_concurrency');
const { appendFunnelStep } = require('./v8_lib_funnel');
const { isJunkName } = require('./v8_quality_gate');
const { readIndustryHintFromEnv } = require('./v8_constants_geo');
const { getIndustryHint: deriveIndustryHint } = require('./v8_icp_taxonomy');
const { readIcpContext } = require('./v8_lib_pillar0');

// P6b：找供应商时，整套买家口径要翻面（不再把中国制造商/出口商/目录站当污染）。
const IS_SUPPLIER_MODE = readIcpContext().direction === 'find_suppliers';

const [inputFile, outputFile] = process.argv.slice(2);

// 将搜索结果 URL 规范化为「公司主页域名」。
// 搜索引擎 link 可能是 PDF、sitemap、CMS 上传附件等，不应直接当官网域名。
// 规则：
//   1. 解析 URL，取 origin（protocol + host）作为规范主页
//   2. path 以 .pdf / .doc / .docx / .xls / .ppt / /wp-content/ / /uploads/ 开头 → 退回 origin
//   3. 解析失败（非 URL） → 原样保留，让 isJunkDomain 后续兜底
function normalizeLinkToDomain(rawLink) {
    if (!rawLink || typeof rawLink !== 'string') return rawLink;
    const s = rawLink.trim();
    try {
        const u = new URL(s);
        const path = u.pathname.toLowerCase();
        const NON_PAGE_EXT  = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|zip|rar|gz|xml|json|txt|rss)$/;
        const NON_PAGE_PATH = /^\/(wp-content|uploads|static|assets|cdn|files)\//;
        if (NON_PAGE_EXT.test(path) || NON_PAGE_PATH.test(path)) {
            // 退回至站点首页 origin，去掉附件路径
            return u.origin;
        }
        return s; // 普通 HTML 页面：保留完整 URL，isJunkDomain 会再做宿主校验
    } catch {
        return s;
    }
}

// ─── Industry context (unchanged) ──────────────────────────────────────────
function loadIndustryContext(samplePillar) {
    try {
        if (!fs.existsSync('zhimao_supply_chain_economics.json')) return null;
        const knowledge = JSON.parse(fs.readFileSync('zhimao_supply_chain_economics.json', 'utf8')).industries || {};
        if (!samplePillar) return null;
        for (const [name, data] of Object.entries(knowledge)) {
            if (samplePillar.toLowerCase().includes(name.toLowerCase().split(' ')[0].toLowerCase())) {
                return { name, ...data };
            }
        }
    } catch (_) { /* fall through */ }
    return null;
}

const GEMINI_KEY   = process.env.GEMINI_KEY;
// Step2 仅做公司名称提取和垃圾过滤，是简单任务 → 用 Flash-Lite（快 5-10x，省费用）
const GEMINI_MODEL   = process.env.GEMINI_FAST_MODEL  || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const OPENAI_KEY     = process.env.OPENAI_API_KEY     || '';
// 名称提取兜底用快速低成本模型
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || 'gpt-4.1-mini';
if (!GEMINI_KEY) { console.error('[step2] GEMINI_KEY env var is required'); process.exit(1); }

// 调小默认 batch（20）：减少单批 token 占用 → 降低 429 风险；提高语义解析准确率。
const BATCH_SIZE   = Math.max(1, parseInt(process.env.INTAKE_BATCH_SIZE   || '20', 10));
// 并发批数：经验上 Gemini 1.5 Pro 个人配额下 3 较安全；可通过 env 调到 4-6。
const CONCURRENCY  = Math.max(1, parseInt(process.env.INTAKE_CONCURRENCY  || '3',  10));
const TIMEOUT_MS   = Math.max(5_000, parseInt(process.env.INTAKE_TIMEOUT_MS || '25000', 10));
const MAX_RETRIES  = Math.max(0, parseInt(process.env.INTAKE_MAX_RETRIES  || '3',  10));

const SOCIAL_HOST_RE = /(facebook|instagram|linkedin|twitter|x\.com|youtube|tiktok|pinterest)\./i;
const MEDIA_TEXT_RE = /\b(news|press|journal|报道|新闻|记者|通讯社)\b/i;
const AGGREGATOR_HOST_RE = /(yellowpages|yelp|kompass|tradeindia|tradekey|ec21|ecplaza)\./i;

function inferEntityType({ title, snippet, link }) {
    const host = String(link || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const t = `${title || ''} ${snippet || ''}`;
    // 顺序与 v8_quality_gate.js 保持一致：社媒 → 聚合平台 → 媒体 → 公司
    if (SOCIAL_HOST_RE.test(String(link || ''))) return 'social';
    if (AGGREGATOR_HOST_RE.test(String(link || ''))) return 'aggregator';
    if (MEDIA_TEXT_RE.test(t)) return 'media';
    return 'company';
}

function buildPrompt(batch, triggerBlock, industryHint) {
    // P6b 供应商模式：industry_match 语义翻面——high = 该公司"生产/出口"该品类（卖家），
    // 而不是"采购"。否则买家口径会把目标供应商全部判 low/none 丢光。
    const icpBlock = industryHint && industryHint.hit
        ? (IS_SUPPLIER_MODE
            ? `\n[ICP GATE — SUPPLIER MODE]
- Target category_key="${industryHint.category_key}"${industryHint.industry_key ? `, industry_key="${industryHint.industry_key}"` : ''}.
- We are sourcing SUPPLIERS (manufacturers / factories / exporters) of this category. For EACH item ALSO return:
    "industry_match": "high" | "medium" | "low" | "none"
      high   = company MANUFACTURES / EXPORTS / wholesales "${industryHint.category_key}" (a real supplier)
      medium = trading company / OEM-ODM / general exporter that PLAUSIBLY supplies "${industryHint.category_key}"
      low    = adjacent supplier (raw-material / component / packaging) only loosely related
      none   = clearly not a supplier of it (end-buyer-only / finance / law / IT / unrelated mfg)
    "industry_evidence": "≤80 chars English single-sentence reason"
- If "industry_match" is "low" or "none", you may still extract company_name (kept for audit), but it will be soft-rejected.`
            : `\n[ICP GATE]
- Target category_key="${industryHint.category_key}"${industryHint.industry_key ? `, industry_key="${industryHint.industry_key}"` : ''}.
- For EACH item ALSO return:
    "industry_match": "high" | "medium" | "low" | "none"
      high   = company's primary business is buying/distributing/selling "${industryHint.category_key}"
      medium = general trading / import-export / hospitality / retail that PLAUSIBLY purchases "${industryHint.category_key}"
      low    = adjacent industry (logistics / packaging / consultancy / marketing) that occasionally touches it
      none   = clearly unrelated (finance / law / accounting / insurance / real estate / IT services / unrelated mfg)
    "industry_evidence": "≤80 chars English single-sentence reason"
- If "industry_match" is "low" or "none", you may still extract company_name (we keep it for audit), but the worker will mark it as soft-rejected.`)
        : '';
    const fmt = industryHint && industryHint.hit
        ? `Format: {"results": [{"company_name": "Exact Name or null", "industry_match": "high|medium|low|none", "industry_evidence": "..."}]}`
        : `Format: {"results": [{"company_name": "Exact Name or null"}]}`;
    // 供应商模式：放行制造商/出口商与供应商目录条目；仅保留通用反污染（博客/定义/参考文档）。
    const criticalRules = IS_SUPPLIER_MODE
        ? `1. TARGET: We WANT manufacturers, factories, exporters and trading companies (including Chinese suppliers). Extract their company names.
2. ANTI-BLOG: If the title/snippet is a listicle, article, review, or guide (e.g. "Top 10 ...", "Best ... for ...", "How to ...", "Guide to ...", "Review:", "vs."), YOU MUST return null.
3. DIRECTORY LISTINGS OK: If the item is a supplier-directory listing (Made-in-China / GlobalSources / Thomasnet / Alibaba), extract the listed SUPPLIER company name (not the platform name); if no concrete supplier name is present, return null.
4. ANTI-DEFINITION: If the snippet is a legal clause, dictionary entry, technical definition, or academic description, YOU MUST return null.
5. ANTI-REFERENCE-DOC: If the snippet is clearly from a document index, shipping manifest, or invoice template rather than a company webpage, return null.`
        : `1. ANTI-POLLUTION: If the snippet indicates the company is based in China, or is a Chinese exporter/supplier selling abroad, YOU MUST return null.
2. ANTI-BLOG: If the title/snippet is a listicle, article, review, or guide (e.g. "Top 10 ...", "Best ... for ...", "How to ...", "Guide to ...", "X things you should ...", "Review:", "vs."), YOU MUST return null -- we only want real buyer company entities.
3. ANTI-PLATFORM: If the result is a known marketplace, directory platform, or aggregator (Alibaba, Amazon, Thomasnet, etc.) rather than an end-buyer company, return null.
4. ANTI-DEFINITION: If the snippet is a legal clause, dictionary entry, technical definition, or academic description (e.g. "A clause inserted in...", "In law, ...", "Definition of ...", "refers to the practice of..."), YOU MUST return null -- these are not company profiles.
5. ANTI-REFERENCE-DOC: If the snippet is clearly from a document index, shipping manifest, bill of lading reference, or invoice template rather than a company webpage, return null.`;
    return `Extract exact formal Company Name from each item.
[CRITICAL RULES]
${criticalRules}${triggerBlock}${icpBlock}
${fmt}
Input: ${JSON.stringify(batch.map(r => ({ t: r.title, s: r.snippet })))}`;
}

async function processBatch(batch, batchIndex, batchTotal, triggerBlock, industryHint) {
    const startedAt = Date.now();
    const prompt = buildPrompt(batch, triggerBlock, industryHint);
    let parsed;
    try {
        parsed = await callGeminiJson(prompt, {
            apiKey: GEMINI_KEY, model: GEMINI_MODEL,
            timeoutMs: TIMEOUT_MS, maxRetries: MAX_RETRIES,
            label: `step2/b${batchIndex}`,
            openaiApiKey: OPENAI_KEY,
            openaiModel:  OPENAI_FAST_MODEL,
        });
    } catch (e) {
        console.warn(`[step2] Batch ${batchIndex}/${batchTotal} FAILED after ${Date.now() - startedAt}ms: ${e.message}`);
        return { accepted: [], failed: true };
    }
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    const accepted = [];
    let junkNameDropped = 0;
    const VALID_MATCH = new Set(['high', 'medium', 'low', 'none']);
    batch.forEach((r, idx) => {
        const cn = results[idx]?.company_name;
        if (!cn || cn === 'null' || typeof cn !== 'string' || !cn.trim()) return;
        const name = cn.trim();
        // 用与 zhimao quality_gate 对齐的 isJunkName 过滤，避免垃圾名进入 Step3 浪费 Gemini
        if (isJunkName(name)) { junkNameDropped += 1; return; }
        const entityType = inferEntityType({ title: r.title, snippet: r.snippet, link: r.link });
        if (entityType !== 'company') return;
        const matchRaw = String(results[idx]?.industry_match || '').toLowerCase();
        const industryMatch = VALID_MATCH.has(matchRaw) ? matchRaw : null;
        const industryEvidenceRaw = results[idx]?.industry_evidence;
        const industryEvidence = typeof industryEvidenceRaw === 'string'
            ? industryEvidenceRaw.trim().slice(0, 200)
            : '';
        accepted.push({
            company_name: name,
            domain:        normalizeLinkToDomain(r.link),
            snippet:       r.snippet,
            phone:         r.phone,
            pillar:        r.pillar,
            intent_signal: r.intent_signal,
            entity_type:   entityType,
            // Batch A.4：透传给 step5 quality gate 与 ingest L1
            industry_match: industryMatch,
            industry_evidence: industryEvidence ? { reason: industryEvidence } : null,
            place_id: r.place_id || null,
            maps_url: r.maps_url || null,
            social_profile_urls: Array.isArray(r.social_profile_urls) ? r.social_profile_urls : null,
            _city: r._city || null,
        });
    });
    console.log(`[step2] Batch ${batchIndex}/${batchTotal}: ${accepted.length}/${batch.length} accepted, junk_name_dropped=${junkNameDropped} (${Date.now() - startedAt}ms)`);
    return { accepted, failed: false };
}

async function run() {
    const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    if (raw.length === 0) { fs.writeFileSync(outputFile, '[]'); return; }

    // ── Pre-filter: drop obvious noise BEFORE we spend Gemini quota ──
    const { kept: filtered, dropped, reasons } = preFilterRawLeads(raw, { supplierMode: IS_SUPPLIER_MODE });
    if (IS_SUPPLIER_MODE) console.log('[step2] SUPPLIER MODE: anti-pollution/anti-platform/cn_supplier relaxed; industry_match flipped to supplier semantics.');
    if (dropped > 0) {
        console.log(`[step2] pre-filter dropped ${dropped}/${raw.length} (listicle=${reasons.listicle}, platform=${reasons.platform}, cn_supplier=${reasons.cn_supplier}, no_signal=${reasons.no_signal})`);
    }
    if (filtered.length === 0) {
        console.warn('[step2] pre-filter removed everything; nothing to extract.');
        fs.writeFileSync(outputFile, '[]');
        return;
    }

    // ── Industry context (unchanged) ──
    const samplePillar = filtered.find(r => r.pillar)?.pillar || '';
    const industryCtx  = loadIndustryContext(samplePillar);
    const triggerBlock = industryCtx?.make_vs_buy_triggers
        ? `\nINDUSTRY CONTEXT (${industryCtx.name}):
- BUY signals (these companies ARE buyers/importers -- accept): ${industryCtx.make_vs_buy_triggers.buy_signals.join(', ')}
- MAKE signals (these are manufacturers -- still accept, but note): ${industryCtx.make_vs_buy_triggers.make_signals.join(', ')}`
        : '';
    if (industryCtx) console.log(`[step2] Industry context injected: ${industryCtx.name}`);

    // Batch A.4：ICP 业态 hint（zhimao submit 注入；缺失则按 raw lead category 兜底）
    let industryHint = null;
    try {
        industryHint = readIndustryHintFromEnv();
        if (!industryHint) {
            const sampleCategoryGuess =
                (filtered.find(r => typeof r.title === 'string')?.title || '').slice(0, 80);
            industryHint = sampleCategoryGuess ? deriveIndustryHint(sampleCategoryGuess) : null;
        }
    } catch (_) { industryHint = null; }
    if (industryHint && industryHint.hit) {
        console.log(`[step2] industry_match enforcement: category_key=${industryHint.category_key} industry_key=${industryHint.industry_key || '-'}`);
    }

    // ── Build batches ──
    const batches = [];
    for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
        batches.push(filtered.slice(i, i + BATCH_SIZE));
    }
    console.log(`[step2] Gemini extraction -- ${filtered.length} items in ${batches.length} batch(es) of ${BATCH_SIZE}, concurrency=${CONCURRENCY}, timeout=${TIMEOUT_MS}ms, retries=${MAX_RETRIES}`);

    // ── Run batches in parallel, bounded concurrency ──
    const overallStart = Date.now();
    const results = await pMap(
        batches,
        (batch, idx) => processBatch(batch, idx + 1, batches.length, triggerBlock, industryHint),
        { concurrency: CONCURRENCY },
    );

    const accepted = [];
    let failedBatches = 0;
    for (const r of results) {
        if (r instanceof Error) { failedBatches += 1; continue; }
        if (r?.failed) { failedBatches += 1; continue; }
        if (r?.accepted?.length) accepted.push(...r.accepted);
    }

    const jobId = process.env.DISCOVERY_JOB_ID || '';
    if (jobId) {
        appendFunnelStep(jobId, 'step2', {
            raw_in: raw.length,
            prefilter_kept: filtered.length,
            accepted: accepted.length,
            failed_batches: failedBatches,
        });
    }

    fs.writeFileSync(outputFile, JSON.stringify(accepted, null, 2));
    console.log(`[step2] Done -- ${accepted.length} valid entities (failed batches: ${failedBatches}/${batches.length}, wall=${Date.now() - overallStart}ms) -> ${outputFile}`);
}

run().catch(e => { console.error('[step2] fatal:', e); process.exit(1); });
