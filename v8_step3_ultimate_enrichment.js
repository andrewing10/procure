require('dotenv').config();
const fs      = require('fs');
const https   = require('https');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

const [inputFile, outputFile] = process.argv.slice(2);

const GEMINI_KEY   = process.env.GEMINI_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
if (!GEMINI_KEY) { console.error('[step3] GEMINI_KEY env var is required'); process.exit(1); }

// BrightData proxy ??optional; set USE_PROXY=true in .env to enable
const BRD_USER  = process.env.BRD_USER  || '';
const BRD_PASS  = process.env.BRD_PASS  || '';
const BRD_PROXY = process.env.BRD_PROXY || 'http://brd.superproxy.io:22225';
const USE_PROXY = process.env.USE_PROXY === 'true';
const USE_BRD_SB = process.env.USE_BRD_SB === 'true';
const BRD_SB_WSS = process.env.BRD_SB_WSS || '';

const PLAYWRIGHT_TIMEOUT = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '15000', 10);
const BOM_BATCH_SIZE     = parseInt(process.env.BOM_BATCH_SIZE || '20', 10);

async function callGemini(promptText) {
    const reqData = JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } });
    return new Promise(resolve => {
        const req = https.request({ hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body));
        });
        req.on('error', () => resolve(null)); req.write(reqData); req.end();
    });
}

async function inferBOMGraph(leads) {
    if (leads.length === 0) return leads;
    console.log(`[step3] BOM deduction for ${leads.length} entities in batches of ${BOM_BATCH_SIZE}...`);

    for (let i = 0; i < leads.length; i += BOM_BATCH_SIZE) {
        const batch  = leads.slice(i, i + BOM_BATCH_SIZE);
        const prompt = `As a Supply Chain Analyst, analyze these companies based on their name and snippet.
1. Determine entity_role: "Manufacturer", "Wholesaler", "Retailer", or "Service".
2. If Manufacturer/Assembler, deduce 3-5 upstream raw materials/components they procure (BOM). If Retailer/Wholesaler, deduce finished goods they procure.
Format: {"results": [{"name": "Exact Name", "role": "...", "pre_procurement_bom": ["item1", "item2"]}]}
Input: ${JSON.stringify(batch.map(l => ({ name: l.company_name, snip: l.snippet })))}`;

        try {
            const resData = await callGemini(prompt);
            const bomData = JSON.parse(JSON.parse(resData).candidates[0].content.parts[0].text).results;
            bomData.forEach(bom => {
                const lead = batch.find(l => l.company_name === bom.name);
                if (lead) {
                    lead.entity_role  = bom.role;
                    lead.inferred_bom = bom.pre_procurement_bom;
                    if (bom.role === 'Manufacturer') lead.confidence_score = (lead.confidence_score || 50) + 20;
                }
            });
            console.log(`[step3] BOM batch ${Math.floor(i / BOM_BATCH_SIZE) + 1} done`);
        } catch (e) {
            console.warn(`[step3] BOM batch ${Math.floor(i / BOM_BATCH_SIZE) + 1} failed: ${e.message}`);
        }
    }
    return leads;
}

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

async function run() {
    let leads = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

    leads = await inferBOMGraph(leads);

    let browser;
    if (USE_BRD_SB) {
        if (!BRD_SB_WSS) {
            console.error('[step3] USE_BRD_SB=true but BRD_SB_WSS not set');
            process.exit(1);
        }
        console.log('[step3] Using BrightData Scraping Browser via CDP');
        browser = await chromium.connectOverCDP(BRD_SB_WSS);
    } else {
        const launchOptions = { headless: true };
        if (USE_PROXY) {
            if (!BRD_USER || !BRD_PASS) { console.error('[step3] USE_PROXY=true but BRD_USER/BRD_PASS not set'); process.exit(1); }
            console.log(`[step3] Proxy enabled: ${BRD_PROXY}`);
            launchOptions.proxy = { server: BRD_PROXY, username: BRD_USER, password: BRD_PASS };
        }
        // Self-heal: if chromium binary is missing (e.g. Render ephemeral filesystem),
        // install it on the spot then retry once.
        try {
            browser = await chromium.launch(launchOptions);
        } catch (launchErr) {
            if (String(launchErr.message).includes("Executable doesn't exist")) {
                console.log("[step3] Chromium not found — installing now (first-run on this host)...");
                require('child_process').execSync(
                    'node ' + require('path').join(__dirname, 'node_modules', '.bin', 'playwright') + ' install chromium --with-deps',
                    { stdio: 'inherit' }
                );
                console.log("[step3] Chromium install complete — retrying launch...");
                browser = await chromium.launch(launchOptions);
            } else {
                throw launchErr;
            }
        }
    }
    const context        = await browser.newContext({ ignoreHTTPSErrors: true });
    const mobileContext  = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36' });

    const enriched = [];
    for (const l of leads) {
        let score = l.confidence_score || 50;
        l.primary_email = l.primary_email || l.email || null;
        l.primary_phone = l.primary_phone || l.phone || null;

        if (l.domain && l.domain.startsWith('http')) {
            const isFb   = l.domain.includes('facebook.com');
            const emails = new Set();
            const phones = new Set();
            let page;
            try {
                if (isFb) {
                    page = await mobileContext.newPage();
                    let fbUrl = l.domain.replace('www.facebook.com', 'mbasic.facebook.com');
                    if (!fbUrl.includes('/groups/') && !fbUrl.includes('/share/') && !fbUrl.includes('/about')) fbUrl = fbUrl.replace(/\/$/, '') + '/about';
                    await page.goto(fbUrl, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                    extractFromHTML(await page.content(), emails, phones);
                } else {
                    page = await context.newPage();
                    await page.goto(l.domain, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                    extractFromHTML(await page.content(), emails, phones);

                    // Auto-find and visit /contact page for richer contact data
                    try {
                        // Prefer exact href match first, then partial-text anchor
                        const contactHref = await page.evaluate(() => {
                            const anchors = Array.from(document.querySelectorAll('a[href]'));
                            const exact   = anchors.find(a => /\/(contact|contacts|contact-us|contactus)(\/|$|\?)/i.test(a.getAttribute('href')));
                            const loose   = exact || anchors.find(a => /contact/i.test(a.textContent.trim()));
                            return loose ? loose.getAttribute('href') : null;
                        });
                        if (contactHref) {
                            const contactUrl = contactHref.startsWith('http') ? contactHref : new URL(contactHref, l.domain).href;
                            await page.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_TIMEOUT });
                            extractFromHTML(await page.content(), emails, phones);
                        }
                    } catch (_) { /* contact page unreachable ??ignore */ }
                }
            } catch (e) { /* timeout / network error ??continue */ } finally { if (page) await page.close().catch(() => {}); }

            if (emails.size > 0) l.primary_email = Array.from(emails)[0];
            const cleanPhones = Array.from(phones).filter(p => p.length < 20);
            if (cleanPhones.length > 0) l.primary_phone = cleanPhones[0];

            if (l.primary_email || l.primary_phone) console.log(`[step3] Enriched: ${l.company_name} | ${l.primary_email || ''}`);
        }

        if (l.primary_email || l.primary_phone) {
            score += 30;
            if (l.pillar?.includes('LBS')) score += 15;
        } else {
            score = Math.min(score, 85);
        }
        l.confidence_score = Math.min(score, 100);
        enriched.push(l);
    }

    await browser.close();
    fs.writeFileSync(outputFile, JSON.stringify(enriched, null, 2));
    console.log(`[step3] Done ??${enriched.length} enriched leads ??${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
