require('dotenv').config();
const fs    = require('fs');
const https = require('https');

const [inputFile, outputFile, countryCode, ...catArgs] = process.argv.slice(2);
const category = catArgs.join(' ') || 'Industrial';

const GEMINI_KEY = process.env.GEMINI_KEY;
if (!GEMINI_KEY) { console.error('[step0] GEMINI_KEY env var is required'); process.exit(1); }

const COUNTRY_NAMES = { mx: 'Mexico', ae: 'UAE', vn: 'Vietnam', sg: 'Singapore', us: 'United States', id: 'Indonesia', th: 'Thailand', my: 'Malaysia', sa: 'Saudi Arabia', br: 'Brazil', co: 'Colombia', de: 'Germany' };
const LANGUAGE_MAP  = { mx: 'Spanish', ae: 'Arabic', vn: 'Vietnamese', sg: 'English', us: 'English', id: 'Indonesian', th: 'Thai', my: 'Malay', sa: 'Arabic', br: 'Portuguese', co: 'Spanish', de: 'German' };

async function run() {
    const targetLang  = LANGUAGE_MAP[countryCode]  || 'English';
    const countryName = COUNTRY_NAMES[countryCode] || countryCode;
    const tld         = `site:.${countryCode} OR site:.com.${countryCode}`;

    let baseQuery = '';

    if (targetLang !== 'English') {
        const prompt   = `Translate industrial category "${category}" to ${targetLang}. Provide 2 native B2B buyer intent keywords (e.g. importer, wholesaler). Return JSON: {"translated_category":"...","native_intents":["...","..."]}`;
        const reqData  = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } });

        const resData = await new Promise(resolve => {
            const req = https.request({ hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
                let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body));
            });
            req.on('error', () => resolve(null)); req.write(reqData); req.end();
        });

        try {
            const parsed  = JSON.parse(resData);
            const content = JSON.parse(parsed.candidates[0].content.parts[0].text);
            const nativeStr = content.native_intents.map(i => `"${i}"`).join(' OR ');
            baseQuery = `"${content.translated_category}" (${nativeStr})`;
        } catch (e) { /* fallback to English below */ }
    }

    if (!baseQuery) {
        baseQuery = `"${category}" ("importer" OR "wholesaler" OR "distributor" OR "buyer")`;
    }

    fs.writeFileSync(outputFile, JSON.stringify({ baseQuery, tld, countryName, countryCode, category }, null, 2));
    console.log(`[step0] Orchestration written → ${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
