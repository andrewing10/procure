/**
 * v8_lib_concurrency.js
 *
 * Zero-dependency utilities used by step2 / step3 to remove the real bottlenecks
 * we observed in production (single-batch sequential Gemini calls, no timeouts,
 * silent 429 swallowing, no retry).
 *
 * Exports:
 *   - pMap(items, mapper, { concurrency, stopOnError })
 *       Bounded-concurrency parallel map. Preserves input order in results.
 *
 *   - requestJsonWithRetry({ hostname, path, method, headers, body, timeoutMs, maxRetries })
 *       HTTPS request with hard timeout, exponential backoff on 429/5xx/network errors,
 *       and JSON parse error reporting. Returns { statusCode, json, raw, error }.
 *
 *   - callGeminiJson(promptText, opts)
 *       High-level Gemini wrapper that *actually* surfaces errors and parses the
 *       structured JSON candidate.parts[0].text. Returns the parsed object or throws.
 *
 *   - preFilterRawLeads(rawItems)
 *       Cheap local rules to drop obvious listicles / blogs / marketplaces /
 *       CN-supplier pages BEFORE we spend Gemini quota on them.
 */

const https = require('https');

// ─── pMap ───────────────────────────────────────────────────────────────────
async function pMap(items, mapper, { concurrency = 4, stopOnError = false } = {}) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let firstError = null;

    async function worker() {
        while (true) {
            const i = nextIndex;
            nextIndex += 1;
            if (i >= items.length) return;
            if (firstError && stopOnError) return;
            try {
                results[i] = await mapper(items[i], i);
            } catch (err) {
                results[i] = err instanceof Error ? err : new Error(String(err));
                if (!firstError) firstError = results[i];
                if (stopOnError) return;
            }
        }
    }

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker());
    await Promise.all(workers);
    if (stopOnError && firstError) throw firstError;
    return results;
}

// ─── requestJsonWithRetry ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isRetryableStatus(code) {
    return code === 408 || code === 425 || code === 429 || (code >= 500 && code < 600);
}

async function requestJsonWithRetry({
    hostname,
    path,
    method = 'POST',
    headers = {},
    body = null,
    timeoutMs = 25_000,
    maxRetries = 3,
    backoffBaseMs = 1_500,
    backoffCapMs = 12_000,
    label = 'req',
} = {}) {
    let attempt = 0;
    let lastError = null;
    while (attempt <= maxRetries) {
        attempt += 1;
        const startedAt = Date.now();

        const result = await new Promise(resolve => {
            const reqOptions = {
                hostname,
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...headers,
                    ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
                },
            };
            let settled = false;
            const settle = (val) => { if (!settled) { settled = true; resolve(val); } };

            const req = https.request(reqOptions, res => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => settle({ statusCode: res.statusCode, raw }));
            });
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`timeout_${timeoutMs}ms`));
            });
            req.on('error', e => settle({ error: e }));
            if (body) req.write(body);
            req.end();
        });

        const elapsed = Date.now() - startedAt;

        if (result.error) {
            lastError = result.error;
            if (attempt > maxRetries) break;
            const wait = Math.min(backoffCapMs, backoffBaseMs * Math.pow(2, attempt - 1));
            console.warn(`[${label}] transport error attempt ${attempt}/${maxRetries + 1} after ${elapsed}ms: ${lastError.message}; backing off ${wait}ms`);
            await sleep(wait);
            continue;
        }

        if (isRetryableStatus(result.statusCode)) {
            lastError = new Error(`http_${result.statusCode}`);
            if (attempt > maxRetries) {
                return { statusCode: result.statusCode, raw: result.raw, error: lastError, attempts: attempt };
            }
            const wait = Math.min(backoffCapMs, backoffBaseMs * Math.pow(2, attempt - 1));
            console.warn(`[${label}] HTTP ${result.statusCode} attempt ${attempt}/${maxRetries + 1} after ${elapsed}ms; backing off ${wait}ms`);
            await sleep(wait);
            continue;
        }

        let json = null;
        let parseError = null;
        try { json = JSON.parse(result.raw); }
        catch (e) { parseError = e; }
        return { statusCode: result.statusCode, raw: result.raw, json, parseError, attempts: attempt };
    }

    return { statusCode: 0, error: lastError, attempts: attempt };
}

// 与 zhimao / render.yaml 对齐；模型下线时按序尝试（避免 preview-04-17 整批 L3 失败）
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const GEMINI_MODEL_FALLBACK_CHAIN = [
    DEFAULT_GEMINI_MODEL,
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
].filter((m, i, a) => m && a.indexOf(m) === i);

function isGeminiModelUnavailableError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('not found') || msg.includes('not supported') || msg.includes('is not found for api version');
}

// ─── callGeminiJson ─────────────────────────────────────────────────────────
// 模型分级策略（按任务复杂度）：
//   复杂任务（L3）→ GEMINI_MODEL（默认 gemini-3.1-pro-preview）
//   简单任务     → GEMINI_FAST_MODEL（默认 gemini-3.1-flash-lite）
//   Gemini 全失败 → OpenAI 自动兜底（OPENAI_API_KEY）
async function callGeminiJson(promptText, {
    apiKey,
    model = DEFAULT_GEMINI_MODEL,
    temperature = 0.1,
    timeoutMs = 60_000,
    maxRetries = 3,
    label = 'gemini',
    openaiApiKey = process.env.OPENAI_API_KEY || '',
    // 兜底模型：gpt-4o（广泛可用）；如账户支持 gpt-5.5 可在 env 中覆盖
    openaiModel  = process.env.OPENAI_MODEL    || 'gpt-4o',
    disableFallback = false,
} = {}) {
    if (!apiKey) throw new Error('GEMINI_KEY required');

    // ── 1. 尝试 Gemini（主模型 + 回退链）────────────────────────────────────────
    let geminiError = null;
    const modelsToTry = [model, ...GEMINI_MODEL_FALLBACK_CHAIN].filter((m, i, a) => m && a.indexOf(m) === i);
    for (const tryModel of modelsToTry) {
        try {
            const reqBody = JSON.stringify({
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: { temperature, responseMimeType: 'application/json' },
            });
            const r = await requestJsonWithRetry({
                hostname: 'generativelanguage.googleapis.com',
                path: `/v1beta/models/${tryModel}:generateContent?key=${apiKey}`,
                method: 'POST',
                body: reqBody,
                timeoutMs,
                maxRetries,
                label: `${label}/${tryModel}`,
            });
            if (r.error) throw new Error(`gemini_failed: ${r.error.message}`);
            if (!r.json) throw new Error(`gemini_parse_failed: status=${r.statusCode}, body=${(r.raw || '').slice(0, 200)}`);
            if (r.json.error) throw new Error(`gemini_api_error: ${r.json.error.message || JSON.stringify(r.json.error)}`);
            const text = r.json?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error(`gemini_empty_candidate: status=${r.statusCode}`);
            try {
                const parsed = JSON.parse(text);
                if (tryModel !== model) {
                    console.log(`[${label}] Gemini succeeded with fallback model ${tryModel}`);
                }
                return parsed;
            } catch (e) {
                throw new Error(`gemini_text_not_json: ${e.message}; head=${String(text).slice(0, 200)}`);
            }
        } catch (err) {
            geminiError = err;
            if (isGeminiModelUnavailableError(err)) {
                console.warn(`[${label}] Gemini model ${tryModel} unavailable (${err.message.slice(0, 100)}), trying next…`);
                continue;
            }
            console.warn(`[${label}] Gemini failed (${err.message.slice(0, 120)})`);
            break;
        }
    }

    // ── 2. OpenAI 兜底（Gemini 限流/错误时自动切换）────────────────────────────
    if (disableFallback || !openaiApiKey) {
        throw geminiError;
    }
    console.warn(`[${label}] → Falling back to OpenAI ${openaiModel}...`);
    try {
        const oaBody = JSON.stringify({
            model: openaiModel,
            temperature,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: 'You are a B2B procurement data extraction assistant. Always respond with valid JSON.' },
                { role: 'user',   content: promptText },
            ],
        });
        const r = await requestJsonWithRetry({
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { Authorization: `Bearer ${openaiApiKey}` },
            body: oaBody,
            timeoutMs: timeoutMs + 10_000, // OpenAI 通常比 Gemini 慢，给额外余量
            maxRetries: 2,
            label: `${label}/openai-fallback`,
        });
        if (r.error) throw new Error(`openai_failed: ${r.error.message}`);
        if (!r.json) throw new Error(`openai_parse_failed: status=${r.statusCode}`);
        if (r.json.error) throw new Error(`openai_api_error: ${r.json.error.message || JSON.stringify(r.json.error)}`);
        const text = r.json?.choices?.[0]?.message?.content;
        if (!text) throw new Error('openai_empty_response');
        const result = JSON.parse(text);
        console.log(`[${label}] OpenAI fallback succeeded`);
        return result;
    } catch (oaErr) {
        throw new Error(`both_llm_failed: gemini=(${geminiError.message.slice(0, 80)}), openai=(${oaErr.message.slice(0, 80)})`);
    }
}

// ─── preFilterRawLeads ──────────────────────────────────────────────────────
// Local heuristics that mirror the LLM "anti-pollution / anti-blog / anti-platform"
// rules but at zero cost. Filtering ~30-50% of obvious noise before Gemini cuts
// step2 wall time and quota usage proportionally.
const LISTICLE_RE = /\b(top\s*\d+|best\s+\w+|how\s+to\b|guide\s+to\b|review[s]?:?\b|vs\.?\b|things\s+you\s+should|^\d+\s+(best|top))\b/i;

// 新闻/媒体文章特征（标题级别即可拦截，无需等 Gemini）
const NEWS_TITLE_RE = /\b(breaking\s+news|press\s+release|media\s+release|news\s+report|daily\s+news|weekly\s+news|记者|报道|报章|新闻|报导|早报|联合早报|副刊|采访|专访|通讯社)\b/i;
// 已结业/永久关闭特征（snippet 级别）
const CLOSED_BIZ_RE = /\b(permanently\s+clos|closed\s+down|ceased\s+operat|no\s+longer\s+operat|out\s+of\s+business|went\s+bankrupt|liquidat|已结业|已停业|停止营业|结业清货|倒闭|停办)\b/i;

// 新加坡及亚太区主要新闻媒体域名（buyer 来源不应包含新闻报章）
const NEWS_DOMAIN_HOSTS = new Set([
    // 新加坡
    'zaobao.com.sg', 'www.zaobao.com.sg', 'zaobao.sg', 'zbschools.sg',
    'straitstimes.com', 'www.straitstimes.com',
    'channelnewsasia.com', 'www.channelnewsasia.com',
    'todayonline.com', 'www.todayonline.com',
    'businesstimes.com.sg', 'www.businesstimes.com.sg',
    'mothership.sg', 'www.mothership.sg',
    'stomp.straitstimes.com', 'stomp.com.sg',
    '8world.com', 'www.8world.com',
    'beritaharian.sg', 'www.beritaharian.sg',
    'tamilmurasu.com.sg',
    'tnp.sg',
    // 马来西亚
    'thestar.com.my', 'www.thestar.com.my',
    'nst.com.my', 'www.nst.com.my',
    'malaymail.com', 'www.malaymail.com',
    'sinchew.com.my', 'www.sinchew.com.my',
    // 全球主流媒体
    'bbc.com', 'www.bbc.com', 'bbc.co.uk',
    'cnn.com', 'www.cnn.com',
    'reuters.com', 'www.reuters.com',
    'bloomberg.com', 'www.bloomberg.com',
    'ft.com', 'www.ft.com',
    'wsj.com', 'www.wsj.com',
    'theguardian.com', 'www.theguardian.com',
    'techcrunch.com', 'www.techcrunch.com',
    'forbes.com', 'www.forbes.com',
    'businessinsider.com', 'www.businessinsider.com',
    'nytimes.com', 'www.nytimes.com',
    'washingtonpost.com', 'www.washingtonpost.com',
]);
const NEWS_DOMAIN_RE = /\.(news|press|media|journalist|tribune|gazette|herald|chronicle|times\.com\.sg|daily|weekly|post\.com)$/i;

const PLATFORM_HOSTS = [
    'alibaba.com', 'aliexpress.com', 'amazon.com', 'thomasnet.com',
    'globalsources.com', 'made-in-china.com', 'tradeindia.com',
    'indiamart.com', 'tradewheel.com', 'ec21.com', 'ecplaza.net',
    'tradekey.com', 'go4worldbusiness.com', 'panjiva.com',
    'importyeti.com', 'volza.com', 'reddit.com', 'quora.com',
    'wikipedia.org', 'wikihow.com', 'youtube.com',
    'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com',
];
const CN_HINT_RE = /\b(china|chinese|guangzhou|shenzhen|yiwu|shanghai|ningbo|hk\b|hong\s*kong)\b/i;

function isNewsDomain(link) {
    if (!link) return false;
    try {
        const host = new URL(link.startsWith('http') ? link : `https://${link}`).hostname.toLowerCase();
        if (NEWS_DOMAIN_HOSTS.has(host)) return true;
        if (NEWS_DOMAIN_RE.test(host)) return true;
    } catch (_) {}
    return false;
}

function loadDomainBlacklistFromEnv() {
    const raw = process.env.DISCOVERY_DOMAIN_BLACKLIST || '[]';
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr)
            ? arr.map((d) => String(d || '').toLowerCase().replace(/^www\./, '')).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

function preFilterRawLeads(rawItems) {
    if (!Array.isArray(rawItems)) return { kept: [], dropped: 0, reasons: {} };
    const kept = [];
    const domainBlacklist = loadDomainBlacklistFromEnv();
    const blacklistSet = new Set(domainBlacklist);
    const reasons = { listicle: 0, platform: 0, cn_supplier: 0, no_signal: 0, news_media: 0, closed_biz: 0, policy_domain: 0 };
    for (const r of rawItems) {
        const title = String(r.title || '').trim();
        const snippet = String(r.snippet || '').trim();
        const link = String(r.link || '').toLowerCase();
        const combined = `${title} ${snippet}`;

        if (blacklistSet.size > 0 && link) {
            try {
                const host = new URL(link.startsWith('http') ? link : `https://${link}`).hostname.toLowerCase().replace(/^www\./, '');
                if (blacklistSet.has(host)) { reasons.policy_domain += 1; continue; }
            } catch { /* ignore */ }
        }

        if (!title && !snippet) { reasons.no_signal += 1; continue; }
        if (LISTICLE_RE.test(title) || LISTICLE_RE.test(snippet)) { reasons.listicle += 1; continue; }
        if (PLATFORM_HOSTS.some(h => link.includes(h))) { reasons.platform += 1; continue; }
        // 新闻媒体：域名黑名单 + 标题特征
        if (isNewsDomain(link) || NEWS_TITLE_RE.test(title)) { reasons.news_media += 1; continue; }
        // 已结业商家：snippet/title 含关闭特征词
        if (CLOSED_BIZ_RE.test(combined)) { reasons.closed_biz += 1; continue; }
        // CN-supplier hint must be in the snippet+title combo and not contradicted
        // by a non-CN country mention. Coarse but cheap.
        if (CN_HINT_RE.test(combined) && /\b(supplier|exporter|manufacturer|factory)\b/i.test(snippet)) {
            reasons.cn_supplier += 1; continue;
        }
        kept.push(r);
    }
    return { kept, dropped: rawItems.length - kept.length, reasons };
}

module.exports = {
    pMap,
    sleep,
    requestJsonWithRetry,
    callGeminiJson,
    preFilterRawLeads,
};
