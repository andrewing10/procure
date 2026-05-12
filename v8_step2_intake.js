require('dotenv').config();
const fs    = require('fs');
const https = require('https');

const [inputFile, outputFile] = process.argv.slice(2);

const GEMINI_KEY = process.env.GEMINI_KEY;
if (!GEMINI_KEY) { console.error('[step2] GEMINI_KEY env var is required'); process.exit(1); }

const BATCH_SIZE = parseInt(process.env.INTAKE_BATCH_SIZE || '50', 10);

async function callGemini(promptText) {
    const reqData = JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } });
    const resData = await new Promise(resolve => {
        const req = https.request({ hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body));
        });
        req.on('error', () => resolve(null)); req.write(reqData); req.end();
    });
    return resData;
}

async function run() {
    const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    if (raw.length === 0) { fs.writeFileSync(outputFile, '[]'); return; }

    console.log(`[step2] Gemini strict entity extraction — ${raw.length} items in batches of ${BATCH_SIZE}...`);

    let intakeData = [];

    for (let i = 0; i < raw.length; i += BATCH_SIZE) {
        const batch   = raw.slice(i, i + BATCH_SIZE);
        const prompt  = `Extract exact formal Company Name from each item.
[CRITICAL RULES]
1. ANTI-POLLUTION: If the snippet indicates the company is based in China, or is a Chinese exporter/supplier selling abroad, YOU MUST return null.
2. ANTI-BLOG: If the title/snippet is a listicle, article, review, or guide (e.g. "Top 10 ...", "Best ... for ...", "How to ...", "Guide to ...", "X things you should ...", "Review:", "vs."), YOU MUST return null — we only want real buyer company entities.
3. ANTI-PLATFORM: If the result is a known marketplace, directory platform, or aggregator (Alibaba, Amazon, Thomasnet, etc.) rather than an end-buyer company, return null.
Format: {"results": [{"company_name": "Exact Name or null"}]}
Input: ${JSON.stringify(batch.map(r => ({ t: r.title, s: r.snippet })))}`;

        try {
            const resData = await callGemini(prompt);
            const parsed  = JSON.parse(resData);
            const content = JSON.parse(parsed.candidates[0].content.parts[0].text).results;
            batch.forEach((r, idx) => {
                if (content[idx]?.company_name && content[idx].company_name !== 'null') {
                    intakeData.push({ company_name: content[idx].company_name, domain: r.link, snippet: r.snippet, phone: r.phone, pillar: r.pillar });
                }
            });
            console.log(`[step2] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${content.filter(c => c?.company_name && c.company_name !== 'null').length} accepted`);
        } catch (e) {
            console.warn(`[step2] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${e.message}`);
        }
    }

    fs.writeFileSync(outputFile, JSON.stringify(intakeData, null, 2));
    console.log(`[step2] Done — ${intakeData.length} valid entities → ${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
