require('./load-env');
const fs      = require('fs');
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { pMap, callGeminiJson } = require('./v8_lib_concurrency');
const { normalizePurchaseCycle } = require('./v8_l1_field_normalize');
const { extractSocialUrls } = require('./v8_lib_social_extract');

const [inputFile, outputFile] = process.argv.slice(2);
const SKIP_L3_INFERENCE = process.env.SKIP_L3_INFERENCE === 'true';

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
// L3 推断是最复杂的任务，兜底用最强模型 gpt-4o（gpt-5.5 仅在部分账户可用）
const OPENAI_MODEL = process.env.OPENAI_MODEL   || 'gpt-4o';
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
const BOM_BATCH_SIZE        = Math.max(1, parseInt(process.env.BOM_BATCH_SIZE || '5',  10));
const L3_CONCURRENCY        = Math.max(1, parseInt(process.env.L3_CONCURRENCY || '3',  10));
// L3 timeout 提升到 60s：gemini-2.5-flash 通常 10-20s，但高负载时可达 50s+
const L3_TIMEOUT_MS         = Math.max(5_000, parseInt(process.env.L3_TIMEOUT_MS || '60000', 10));
const L3_MAX_RETRIES        = Math.max(0, parseInt(process.env.L3_MAX_RETRIES || '3', 10));
// 并发数提升：4 → 8（在有代理或高带宽环境下可进一步调高至 12）
const PAGE_CONCURRENCY      = Math.max(1, parseInt(process.env.STEP3_PAGE_CONCURRENCY || '8', 10));

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

/**
 * L3 Supply Chain Inference (Gemini).
 *
 * Batches run in parallel with bounded concurrency, timeouts, and retry.
 * Each lead gets `inference_breakdown` for Step5 / L1, plus entity_role and inferred_bom.
 */
async function inferL3SupplyChain(leads) {
    if (leads.length === 0) return leads;

    const batches = [];
    for (let i = 0; i < leads.length; i += BOM_BATCH_SIZE) {
        batches.push(leads.slice(i, i + BOM_BATCH_SIZE));
    }
    console.log(`[step3] L3 supply-chain inference for ${leads.length} entities in ${batches.length} batch(es) of ${BOM_BATCH_SIZE}, concurrency=${L3_CONCURRENCY}, timeout=${L3_TIMEOUT_MS}ms`);

    const overallStart = Date.now();

    await pMap(batches, async (batch, idx) => {
        const batchIndex = idx + 1;
        const batchTotal = batches.length;
        const startedAt = Date.now();

        const prompt = `You are a Supply Chain Intelligence AI. Analyze each company and produce a structured L3 procurement inference.

Rules:
1. entity_role: "Manufacturer" (makes goods), "Wholesaler" (bulk buys/resells), "Retailer" (end-consumer facing), "Service" (services only).
2. primary_materials_top3: exactly 3 upstream raw materials or finished goods they must procure. Use short English snake_case keys (e.g. "memory_foam", "pocket_springs", "fabric_ticking").
3. procurement_items: array of {category, priority(1-3), source:"bom", type:"explicit"}.
4. confidence_tier: "High" (role is unambiguous), "Medium" (probable), "Low" (guessed).
5. intent_summary: one English sentence — "<Name> is a <role> that procures <top materials> from upstream suppliers."
6. purchase_cycle: "weekly" | "monthly" | "quarterly" | "annual" — best estimate.
7. reason_codes: non-empty array from ["BOM_INFERENCE","ENTITY_ROLE_MANUFACTURER","ENTITY_ROLE_WHOLESALER","ENTITY_ROLE_RETAILER","ENTITY_ROLE_SERVICE","SUPPLY_CHAIN_GRAPH"].

Output strict JSON only:
{"results":[{"name":"Exact Company Name","entity_role":"...","confidence_tier":"...","primary_materials_top3":["...","...","..."],"procurement_items":[{"category":"...","priority":1,"source":"bom","type":"explicit"}],"intent_summary":"...","purchase_cycle":"...","reason_codes":["..."]}]}

Input: ${JSON.stringify(batch.map(l => ({ name: l.company_name, snip: (l.snippet || '').slice(0, 120) })))}`;

        let parsed;
        try {
            parsed = await callGeminiJson(prompt, {
                apiKey: GEMINI_KEY, model: GEMINI_MODEL, temperature: 0.2,
                timeoutMs: L3_TIMEOUT_MS, maxRetries: L3_MAX_RETRIES,
                label: `step3/L3.b${batchIndex}`,
                openaiApiKey: OPENAI_KEY,
                openaiModel:  OPENAI_MODEL,
            });
        } catch (e) {
            console.warn(`[step3] L3 batch ${batchIndex}/${batchTotal} FAILED after ${Date.now() - startedAt}ms: ${e.message}`);
            return;
        }

        const results = Array.isArray(parsed?.results) ? parsed.results : [];
        const now = new Date().toISOString();
        // 归一化比较：去除多余空格、大小写统一，防止 Gemini 返回名称与原始名称
        // 细微差异（首字母大写/尾部空格）导致 find 失败，inference_breakdown 丢失。
        const normName = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
        let merged = 0;
        for (const r of results) {
            const rNorm = normName(r.name);
            const lead = batch.find(l => normName(l.company_name) === rNorm);
            if (!lead) continue;
            lead.entity_role = r.entity_role || 'Service';
            lead.inferred_bom = Array.isArray(r.primary_materials_top3)
                ? r.primary_materials_top3.map(s => String(s).trim().toLowerCase())
                : [];
            if (r.entity_role === 'Manufacturer') lead.confidence_score = (lead.confidence_score || 50) + 20;
            else if (r.entity_role === 'Wholesaler' || r.entity_role === 'Retailer') lead.confidence_score = (lead.confidence_score || 50) + 10;
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
                model_version:          'v8-gemini-l3-v1',
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
            merged += 1;
        }
        console.log(`[step3] L3 batch ${batchIndex}/${batchTotal} merged ${merged}/${batch.length} (${Date.now() - startedAt}ms)`);
    }, { concurrency: L3_CONCURRENCY });

    console.log(`[step3] L3 inference total wall=${Date.now() - overallStart}ms`);
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

async function lookupContactViaGooglePlaces(companyName, countryIso) {
    if (!GMAPS_KEY || !companyName) return null;
    try {
        const q = encodeURIComponent(`${companyName}${countryIso ? ' ' + countryIso : ''}`);
        const findUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json`
            + `?input=${q}&inputtype=textquery`
            + `&fields=place_id,name,business_status`
            + `&key=${GMAPS_KEY}`;
        const findRes = await httpsGetStep3(findUrl);
        if (findRes.status !== 'OK' || !findRes.candidates?.length) return null;

        const placeId = findRes.candidates[0].place_id;
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
        const gmapsResult = await lookupContactViaGooglePlaces(lead.company_name, lead.country_iso || '');
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
    return lead;
}

async function run() {
    let leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    if (SKIP_L3_INFERENCE) {
        console.log('[step3] SKIP_L3_INFERENCE=true, skipping L3 inference and only extracting contacts.');
    } else {
        leads = await inferL3SupplyChain(leads);
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
    const enriched = await pMap(
        leads,
        (lead) => extractContactForLead(lead, { desktop: desktopCtx, mobile: mobileCtx }),
        { concurrency: PAGE_CONCURRENCY },
    );

    await browser.close();
    flushDomainCache(); // 持久化本次抓取结果到缓存文件

    // pMap may return Error instances if any worker threw — keep success rows only.
    const finalLeads = enriched.filter(x => x && !(x instanceof Error));
    const contactHit = finalLeads.filter(l => l.primary_email || l.primary_phone).length;

    fs.writeFileSync(outputFile, JSON.stringify(finalLeads, null, 2));
    console.log(`[step3] Done — ${finalLeads.length} enriched leads (contact_hit=${contactHit}, hit_rate=${Math.round(contactHit/finalLeads.length*100)}%) in ${Date.now() - overallStart}ms → ${outputFile}`);
}

run().catch(e => { console.error('[step3] fatal:', e); process.exit(1); });
