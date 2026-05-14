require('dotenv').config();
const fs    = require('fs');
const https = require('https');

// ── P0 垃圾域名黑名单（与 zhimao lib/data-intel/quality.ts 保持一致） ─────────
const JUNK_DOMAIN_HOSTS = new Set([
  'scribd.com','www.scribd.com',
  'reddit.com','www.reddit.com','old.reddit.com',
  'quora.com','www.quora.com',
  'alibaba.com','www.alibaba.com','m.alibaba.com',
  'aliexpress.com','www.aliexpress.com',
  '1688.com','www.1688.com',
  'taobao.com','www.taobao.com',
  'jd.com','www.jd.com',
  'pinduoduo.com',
  'linkedin.com','www.linkedin.com',
  'facebook.com','www.facebook.com','m.facebook.com',
  'twitter.com','www.twitter.com','x.com',
  'instagram.com','www.instagram.com',
  'youtube.com','www.youtube.com',
  'tiktok.com','www.tiktok.com',
  'pinterest.com','www.pinterest.com',
  'made-in-china.com','www.made-in-china.com',
  'globalsources.com','www.globalsources.com',
  'tradeindia.com','www.tradeindia.com',
  'tradekey.com','www.tradekey.com',
  'exportersindia.com','www.exportersindia.com',
  'ec21.com','www.ec21.com',
  'ecplaza.net','www.ecplaza.net',
  'kompass.com','www.kompass.com',
  'yellowpages.com','www.yellowpages.com',
  'yelp.com','www.yelp.com',
  'amazon.com','www.amazon.com',
  'ebay.com','www.ebay.com',
  'etsy.com','www.etsy.com',
  'importyeti.com','www.importyeti.com',
  'volza.com','www.volza.com',
  'panjiva.com','www.panjiva.com',
  'tradesparq.com',
  'bing.com','www.bing.com',
  'google.com','www.google.com',
  'wikipedia.org','en.wikipedia.org',
]);
const JUNK_DOMAIN_PATTERNS = [
  /scribd\./i, /1688\.com/i, /wikip/i, /fandom\.com/i,
  /blogspot\./i, /wordpress\.com/i, /medium\.com/i,
];

/** 返回 true 说明这条 lead 是垃圾，应丢弃 */
function isJunkLead(lead) {
  if (!lead || !lead.link) return false;
  try {
    const url = lead.link.trim().toLowerCase();
    const domain = url.replace(/^https?:\/\//,'').replace(/\/.*/,'').replace(/:\d+$/,'');
    if (JUNK_DOMAIN_HOSTS.has(domain)) return true;
    if (JUNK_DOMAIN_PATTERNS.some(p => p.test(domain))) return true;
  } catch(_) {}
  return false;
}

const [inputFile, outputFile, countryCode] = process.argv.slice(2);

const API_KEY = process.env.SERPER_API_KEY;
if (!API_KEY) { console.error('[step1] SERPER_API_KEY env var is required'); process.exit(1); }

async function fetchPlaces(query, gl) {
    return new Promise(resolve => {
        const req = https.request({ hostname: 'google.serper.dev', path: '/places', method: 'POST', headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' } }, r => {
            let body = ''; r.on('data', c => body += c); r.on('end', () => resolve(JSON.parse(body || '{}').places || []));
        });
        req.on('error', () => resolve([])); req.write(JSON.stringify({ q: query, gl })); req.end();
    });
}

async function searchOrganic(query, gl) {
    return new Promise(resolve => {
        const req = https.request({ hostname: 'google.serper.dev', path: '/search', method: 'POST', headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' } }, r => {
            let body = ''; r.on('data', c => body += c); r.on('end', () => resolve(JSON.parse(body || '{}').organic || []));
        });
        req.on('error', () => resolve([])); req.write(JSON.stringify({ q: query, gl, num: 20 })); req.end();
    });
}

async function run() {
    const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const { baseQuery, countryName, category, tld } = data;
    const allLeads = [];
    const currentYear = new Date().getFullYear();

    // Pillar 0: Seed DB Activation
    console.log(`[step1] Pillar 0: Seed DB Activation...`);
    try {
        if (fs.existsSync('zhimao_seed_intelligence.json')) {
            const seeds = JSON.parse(fs.readFileSync('zhimao_seed_intelligence.json', 'utf8'));
            const matched = seeds.filter(s => s.country?.toLowerCase() === countryCode?.toLowerCase() && s.category?.toLowerCase().includes(category.toLowerCase()));
            matched.forEach(s => allLeads.push({ title: s.company_name, link: s.domain, snippet: 'Seed DB Verified Buyer', pillar: 'Pillar 0 Seed' }));
            console.log(`[step1] Activated ${matched.length} seed entities.`);
        }
    } catch (e) { console.log(`[step1] Seed DB unavailable, skipping.`); }

    // Pillar 1: LBS Maps
    console.log(`[step1] Pillar 1: LBS Maps...`);
    const places = await fetchPlaces(`${category} wholesaler OR distributor in ${countryName}`, countryCode);
    places.forEach(p => { if (p.website || p.phoneNumber) allLeads.push({ title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber, pillar: 'Pillar 1 LBS' }); });

    // Pillar 2: Local B2B Directory
    console.log(`[step1] Pillar 2: Local B2B Directory...`);
    const b2b = await searchOrganic(`"${category}" ("b2b" OR "directory" OR "suppliers" OR "manufacturers") ${tld} -site:alibaba.com -site:globalsources.com -site:made-in-china.com`, countryCode);
    b2b.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 2 Local B2B' }));

    // Pillar 3: Customs / Import Trade Records
    // Strategy: query public import-data aggregators (ImportYeti, Volza, Panjiva public pages)
    // and generic BoL-signal searches. All three paths degrade gracefully on 0 results.
    console.log(`[step1] Pillar 3: Customs / Import Trade Records...`);
    try {
        // Path A: ImportYeti -- free public importer profiles
        const importyeti = await searchOrganic(
            `site:importyeti.com "${category}" "${countryName}"`,
            countryCode
        );
        importyeti.forEach(o => allLeads.push({
            title:   o.title,
            link:    o.link,
            snippet: o.snippet,
            pillar:  'Pillar 3 Customs/ImportYeti',
        }));

        // Path B: Volza / Panjiva public pages
        const volza = await searchOrganic(
            `(site:volza.com OR site:panjiva.com) "${category}" importer "${countryName}"`,
            countryCode
        );
        volza.forEach(o => allLeads.push({
            title:   o.title,
            link:    o.link,
            snippet: o.snippet,
            pillar:  'Pillar 3 Customs/Volza',
        }));

        // Path C: Generic BoL / customs declaration signal
        const bol = await searchOrganic(
            `"${category}" ("bill of lading" OR "customs importer" OR "import record" OR "HS code") "${countryName}" -site:alibaba.com`,
            countryCode
        );
        bol.forEach(o => allLeads.push({
            title:   o.title,
            link:    o.link,
            snippet: o.snippet,
            pillar:  'Pillar 3 Customs/BoL',
        }));

        const p3count = importyeti.length + volza.length + bol.length;
        console.log(`[step1] Pillar 3: ${p3count} customs/trade signals found${p3count === 0 ? ' (no public records for this query -- skipping gracefully)' : ''}.`);
    } catch (e) {
        console.warn(`[step1] Pillar 3 failed (non-fatal): ${e.message}`);
    }

    // Pillar 4: Social -- 在原有探针基础上并发4路深度意图探针（原标签 'Pillar 4 Social' 保持不变）
    console.log(`[step1] Pillar 4: Social + Deep Intent Probes...`);
    const [social, socialFbIntent, socialLinkedInIntent, socialWhatsApp, socialThreads] = await Promise.all([
        // 原有探针（保留原逻辑不变）
        searchOrganic(`${baseQuery} "${countryName}" site:linkedin.com/company OR site:facebook.com/groups`, countryCode),
        // FB Groups 主动采购意图
        searchOrganic(`"${category}" ("need supplier" OR "sourcing" OR "looking for supplier" OR "buying" OR "RFQ") site:facebook.com/groups "${countryName}"`, countryCode),
        // LinkedIn 采购职位
        searchOrganic(`"${category}" ("procurement manager" OR "sourcing manager" OR "purchasing" OR "import") site:linkedin.com/in "${countryName}"`, countryCode),
        // WhatsApp 商业联系
        searchOrganic(`"${category}" ("whatsapp group" OR "wa.me" OR "whatsapp business") "${countryName}" buyer OR importer`, countryCode),
        // Threads/Instagram 采购意图
        searchOrganic(`"${category}" ("looking for supplier" OR "where to buy" OR "need" OR "sourcing") "${countryName}" (site:threads.net OR site:instagram.com)`, countryCode),
    ]);
    social.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social' }));
    socialFbIntent.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social', intent_signal: 'ACTIVE_SOURCING' }));
    socialLinkedInIntent.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social', intent_signal: 'PROCUREMENT_ROLE' }));
    socialWhatsApp.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social', intent_signal: 'WHATSAPP_CONTACT' }));
    socialThreads.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social', intent_signal: 'ACTIVE_SOURCING' }));
    console.log(`[step1] Pillar 4 total: ${social.length + socialFbIntent.length + socialLinkedInIntent.length + socialWhatsApp.length + socialThreads.length} signals`);

    // Pillar 5: Tenders & Procurement
    console.log(`[step1] Pillar 5: Tenders & Procurement...`);
    const tenders = await searchOrganic(`"${category}" (tender OR RFP OR "request for proposal" OR procurement) ${tld} OR site:.gov.${countryCode}`, countryCode);
    tenders.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 5 Tenders' }));

    // Pillar 5b: Compliance Registries -- 认证申请人 = 正在生产/采购该品类的前端信号（非致命）
    console.log(`[step1] Pillar 5b: Compliance Registries...`);
    try {
        const compliance = await searchOrganic(
            `"${category}" ("Applicant" OR "Grantee" OR "certificate holder" OR "registered manufacturer") (site:fccid.io OR site:tuv.com OR site:ul.com OR site:ce-check.eu OR site:intertek.com)`,
            countryCode
        );
        compliance.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 5 Tenders', intent_signal: 'COMPLIANCE_REGISTRANT' }));
        console.log(`[step1] Pillar 5b: ${compliance.length} compliance signals found.`);
    } catch (e) {
        console.warn(`[step1] Pillar 5b failed (non-fatal): ${e.message}`);
    }

    // Pillar 6: Exhibitions
    console.log(`[step1] Pillar 6: Exhibitions...`);
    const exhibitions = await searchOrganic(`"${category}" ("exhibitor list" OR "exhibitors directory") ${currentYear} "${countryName}"`, countryCode);
    exhibitions.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 6 Exhibitions' }));

    // 注入 source_timestamp（新增字段，不影响任何现有字段和逻辑）
    const nowIso = new Date().toISOString();
    allLeads.forEach(l => { l.source_timestamp = l.source_timestamp || nowIso; });

    // P0 出口过滤：丢弃垃圾域名 leads（不影响无 link 的 Pillar 0/1 结果）
    const beforeFilter = allLeads.length;
    const filteredLeads = allLeads.filter(l => !isJunkLead(l));
    const junkCount = beforeFilter - filteredLeads.length;
    if (junkCount > 0) {
        console.log(`[step1] P0 junk filter: removed ${junkCount}/${beforeFilter} leads (junk domains)`);
    }

    fs.writeFileSync(outputFile, JSON.stringify(filteredLeads, null, 2));
    console.log(`[step1] Done -- ${filteredLeads.length} clean leads written -> ${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
