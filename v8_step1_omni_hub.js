require('dotenv').config();
const fs    = require('fs');
const https = require('https');

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

    // Pillar 4: Social
    console.log(`[step1] Pillar 4: Social...`);
    const social = await searchOrganic(`${baseQuery} "${countryName}" site:linkedin.com/company OR site:facebook.com/groups`, countryCode);
    social.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 4 Social' }));

    // Pillar 5: Tenders & Procurement
    console.log(`[step1] Pillar 5: Tenders & Procurement...`);
    const tenders = await searchOrganic(`"${category}" (tender OR RFP OR "request for proposal" OR procurement) ${tld} OR site:.gov.${countryCode}`, countryCode);
    tenders.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 5 Tenders' }));

    // Pillar 6: Exhibitions
    console.log(`[step1] Pillar 6: Exhibitions...`);
    const exhibitions = await searchOrganic(`"${category}" ("exhibitor list" OR "exhibitors directory") ${currentYear} "${countryName}"`, countryCode);
    exhibitions.forEach(o => allLeads.push({ title: o.title, link: o.link, snippet: o.snippet, pillar: 'Pillar 6 Exhibitions' }));

    fs.writeFileSync(outputFile, JSON.stringify(allLeads, null, 2));
    console.log(`[step1] Done — ${allLeads.length} raw leads written → ${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
