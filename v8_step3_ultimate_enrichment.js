require('dotenv').config();
const fs      = require('fs');
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { pMap, callGeminiJson } = require('./v8_lib_concurrency');

const [inputFile, outputFile] = process.argv.slice(2);

const GEMINI_KEY   = process.env.GEMINI_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
if (!GEMINI_KEY) { console.error('[step3] GEMINI_KEY env var is required'); process.exit(1); }

// Browser / proxy config (unchanged) ─────────────────────────────────────────
const BRD_USER  = process.env.BRD_USER  || '';
const BRD_PASS  = process.env.BRD_PASS  || '';
const BRD_PROXY = process.env.BRD_PROXY || 'http://brd.superproxy.io:22225';
const USE_PROXY = process.env.USE_PROXY === 'true';
const USE_BRD_SB = process.env.USE_BRD_SB === 'true';
const BRD_SB_WSS = process.env.BRD_SB_WSS || '';

const PLAYWRIGHT_TIMEOUT  = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '15000', 10);

// Tuning knobs --------------------------------------------------------------
//   BOM_BATCH_SIZE / L3_CONCURRENCY  → Gemini L3 inference parallelism
//   STEP3_PAGE_CONCURRENCY           → Playwright contact extraction parallelism
const BOM_BATCH_SIZE        = Math.max(1, parseInt(process.env.BOM_BATCH_SIZE || '10', 10));
const L3_CONCURRENCY        = Math.max(1, parseInt(process.env.L3_CONCURRENCY || '3',  10));
const L3_TIMEOUT_MS         = Math.max(5_000, parseInt(process.env.L3_TIMEOUT_MS || '30000', 10));
const L3_MAX_RETRIES        = Math.max(0, parseInt(process.env.L3_MAX_RETRIES || '3', 10));
const PAGE_CONCURRENCY      = Math.max(1, parseInt(process.env.STEP3_PAGE_CONCURRENCY || '4', 10));

/**
 * L3 Supply Chain Inference (Gemini).
 *
 * Now runs batches in parallel with bounded concurrency, hard timeouts, and
 * exponential backoff retry. A single 429 no longer stalls every later batch.
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
                purchase_cycle:         r.purchase_cycle || 'quarterly',
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

// ─── Cheap HTML field extractors (unchanged behavior) ───────────────────────
const extractFromHTML = (html, emails, phones) => {
    const $ = cheerio.load(html);
    $('a[href^="mailto:"]').each((_, el) => emails.add($(el).attr('href').replace('mailto:', '').split('?')[0].trim()));
    $('a[href^="tel:"]').each((_, el) => phones.add($(el).attr('href').replace('tel:', '').trim()));
    $('a[href*="wa.me/"]').each((_, el) => phones.add($(el).attr('href')));
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/g;
    let match;
    while ((match = emailRegex.exec($('body').text())) !== null) {
        const em = match[1].toLowerCase();
        if (!em.endsWith('.png') && !em.endsWith('.jpg') && !em.endsWith('.jpeg')) emails.add(em);
    }
};

async function extractContactForLead(lead, contexts) {
    let score = lead.confidence_score || 50;
    lead.primary_email = lead.primary_email || lead.email || null;
    lead.primary_phone = lead.primary_phone || lead.phone || null;

    if (lead.domain && lead.domain.startsWith('http')) {
        const isFb = lead.domain.includes('facebook.com');
        const ctx  = isFb ? contexts.mobile : contexts.desktop;
        const emails = new Set();
        const phones = new Set();
        let page;
        try {
            page = await ctx.newPage();
            if (isFb) {
                let fbUrl = lead.domain.replace('www.facebook.com', 'mbasic.facebook.com');
                if (!fbUrl.includes('/groups/') && !fbUrl.includes('/share/') && !fbUrl.includes('/about')) fbUrl = fbUrl.replace(/\/$/, '') + '/about';
                await page.goto(fbUrl, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                extractFromHTML(await page.content(), emails, phones);
            } else {
                await page.goto(lead.domain, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                extractFromHTML(await page.content(), emails, phones);
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
                        extractFromHTML(await page.content(), emails, phones);
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

    leads = await inferL3SupplyChain(leads);

    let browser;
    if (USE_BRD_SB) {
        if (!BRD_SB_WSS) { console.error('[step3] USE_BRD_SB=true but BRD_SB_WSS not set'); process.exit(1); }
        console.log('[step3] Using BrightData Scraping Browser via CDP');
        browser = await chromium.connectOverCDP(BRD_SB_WSS);
    } else {
        const launchOptions = { headless: true };
        if (USE_PROXY) {
            if (!BRD_USER || !BRD_PASS) { console.error('[step3] USE_PROXY=true but BRD_USER/BRD_PASS not set'); process.exit(1); }
            console.log(`[step3] Proxy enabled: ${BRD_PROXY}`);
            launchOptions.proxy = { server: BRD_PROXY, username: BRD_USER, password: BRD_PASS };
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
    const desktopCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    const mobileCtx  = await browser.newContext({
        ignoreHTTPSErrors: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
    });

    console.log(`[step3] Contact extraction over ${leads.length} leads, page concurrency=${PAGE_CONCURRENCY}, page timeout=${PLAYWRIGHT_TIMEOUT}ms`);
    const overallStart = Date.now();
    const enriched = await pMap(
        leads,
        (lead) => extractContactForLead(lead, { desktop: desktopCtx, mobile: mobileCtx }),
        { concurrency: PAGE_CONCURRENCY },
    );

    await browser.close();

    // pMap may return Error instances if any worker threw — keep success rows only.
    const finalLeads = enriched.filter(x => x && !(x instanceof Error));

    fs.writeFileSync(outputFile, JSON.stringify(finalLeads, null, 2));
    console.log(`[step3] Done — ${finalLeads.length} enriched leads in ${Date.now() - overallStart}ms → ${outputFile}`);
}

run().catch(e => { console.error('[step3] fatal:', e); process.exit(1); });
