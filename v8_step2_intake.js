require('dotenv').config();
const fs = require('fs');
const { pMap, callGeminiJson, preFilterRawLeads } = require('./v8_lib_concurrency');

const [inputFile, outputFile] = process.argv.slice(2);

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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
if (!GEMINI_KEY) { console.error('[step2] GEMINI_KEY env var is required'); process.exit(1); }

// 调小默认 batch（20）：减少单批 token 占用 → 降低 429 风险；提高语义解析准确率。
const BATCH_SIZE   = Math.max(1, parseInt(process.env.INTAKE_BATCH_SIZE   || '20', 10));
// 并发批数：经验上 Gemini 1.5 Pro 个人配额下 3 较安全；可通过 env 调到 4-6。
const CONCURRENCY  = Math.max(1, parseInt(process.env.INTAKE_CONCURRENCY  || '3',  10));
const TIMEOUT_MS   = Math.max(5_000, parseInt(process.env.INTAKE_TIMEOUT_MS || '25000', 10));
const MAX_RETRIES  = Math.max(0, parseInt(process.env.INTAKE_MAX_RETRIES  || '3',  10));

function buildPrompt(batch, triggerBlock) {
    return `Extract exact formal Company Name from each item.
[CRITICAL RULES]
1. ANTI-POLLUTION: If the snippet indicates the company is based in China, or is a Chinese exporter/supplier selling abroad, YOU MUST return null.
2. ANTI-BLOG: If the title/snippet is a listicle, article, review, or guide (e.g. "Top 10 ...", "Best ... for ...", "How to ...", "Guide to ...", "X things you should ...", "Review:", "vs."), YOU MUST return null -- we only want real buyer company entities.
3. ANTI-PLATFORM: If the result is a known marketplace, directory platform, or aggregator (Alibaba, Amazon, Thomasnet, etc.) rather than an end-buyer company, return null.${triggerBlock}
Format: {"results": [{"company_name": "Exact Name or null"}]}
Input: ${JSON.stringify(batch.map(r => ({ t: r.title, s: r.snippet })))}`;
}

async function processBatch(batch, batchIndex, batchTotal, triggerBlock) {
    const startedAt = Date.now();
    const prompt = buildPrompt(batch, triggerBlock);
    let parsed;
    try {
        parsed = await callGeminiJson(prompt, {
            apiKey: GEMINI_KEY, model: GEMINI_MODEL,
            timeoutMs: TIMEOUT_MS, maxRetries: MAX_RETRIES,
            label: `step2/b${batchIndex}`,
        });
    } catch (e) {
        console.warn(`[step2] Batch ${batchIndex}/${batchTotal} FAILED after ${Date.now() - startedAt}ms: ${e.message}`);
        return { accepted: [], failed: true };
    }
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    const accepted = [];
    batch.forEach((r, idx) => {
        const cn = results[idx]?.company_name;
        if (cn && cn !== 'null' && typeof cn === 'string' && cn.trim()) {
            accepted.push({
                company_name: cn.trim(),
                domain:        r.link,
                snippet:       r.snippet,
                phone:         r.phone,
                pillar:        r.pillar,
                intent_signal: r.intent_signal,
            });
        }
    });
    console.log(`[step2] Batch ${batchIndex}/${batchTotal}: ${accepted.length}/${batch.length} accepted (${Date.now() - startedAt}ms)`);
    return { accepted, failed: false };
}

async function run() {
    const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    if (raw.length === 0) { fs.writeFileSync(outputFile, '[]'); return; }

    // ── Pre-filter: drop obvious noise BEFORE we spend Gemini quota ──
    const { kept: filtered, dropped, reasons } = preFilterRawLeads(raw);
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
        (batch, idx) => processBatch(batch, idx + 1, batches.length, triggerBlock),
        { concurrency: CONCURRENCY },
    );

    const accepted = [];
    let failedBatches = 0;
    for (const r of results) {
        if (r instanceof Error) { failedBatches += 1; continue; }
        if (r?.failed) { failedBatches += 1; continue; }
        if (r?.accepted?.length) accepted.push(...r.accepted);
    }

    fs.writeFileSync(outputFile, JSON.stringify(accepted, null, 2));
    console.log(`[step2] Done -- ${accepted.length} valid entities (failed batches: ${failedBatches}/${batches.length}, wall=${Date.now() - overallStart}ms) -> ${outputFile}`);
}

run().catch(e => { console.error('[step2] fatal:', e); process.exit(1); });
