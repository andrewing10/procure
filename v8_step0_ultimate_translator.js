require('dotenv').config();
const fs    = require('fs');
const https = require('https');

const [inputFile, outputFile, countryCode, ...catArgs] = process.argv.slice(2);
const category = catArgs.join(' ') || 'Industrial';

const GEMINI_KEY   = process.env.GEMINI_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
if (!GEMINI_KEY) { console.error('[step0] GEMINI_KEY env var is required'); process.exit(1); }

// 国家名称映射（扩展至 40+ 主要采购市场）
const COUNTRY_NAMES = {
  // 亚洲
  vn: 'Vietnam', th: 'Thailand', id: 'Indonesia', my: 'Malaysia', sg: 'Singapore',
  ph: 'Philippines', mm: 'Myanmar', kh: 'Cambodia', bd: 'Bangladesh', pk: 'Pakistan',
  in: 'India', lk: 'Sri Lanka', np: 'Nepal', jp: 'Japan', kr: 'South Korea', tw: 'Taiwan',
  // 中东
  ae: 'UAE', sa: 'Saudi Arabia', qa: 'Qatar', kw: 'Kuwait', bh: 'Bahrain', om: 'Oman',
  tr: 'Turkey', il: 'Israel', jo: 'Jordan', eg: 'Egypt',
  // 美洲
  us: 'United States', mx: 'Mexico', br: 'Brazil', co: 'Colombia', cl: 'Chile',
  pe: 'Peru', ar: 'Argentina', ca: 'Canada',
  // 欧洲
  de: 'Germany', gb: 'United Kingdom', fr: 'France', it: 'Italy', es: 'Spain',
  nl: 'Netherlands', pl: 'Poland', se: 'Sweden', no: 'Norway', dk: 'Denmark',
  // 非洲
  ng: 'Nigeria', za: 'South Africa', ke: 'Kenya', gh: 'Ghana', et: 'Ethiopia',
  // 大洋洲
  au: 'Australia', nz: 'New Zealand',
};

// 语言映射（用于 Gemini 翻译品类意图词）
const LANGUAGE_MAP  = {
  vn: 'Vietnamese', th: 'Thai', id: 'Indonesian', my: 'Malay', ph: 'Filipino',
  mm: 'Burmese', kh: 'Khmer', bd: 'Bengali', pk: 'Urdu', in: 'Hindi', lk: 'Sinhala',
  jp: 'Japanese', kr: 'Korean', tw: 'Traditional Chinese',
  ae: 'Arabic', sa: 'Arabic', qa: 'Arabic', kw: 'Arabic', bh: 'Arabic', om: 'Arabic',
  tr: 'Turkish', il: 'Hebrew', jo: 'Arabic', eg: 'Arabic',
  us: 'English', ca: 'English', gb: 'English', au: 'English', nz: 'English', sg: 'English',
  mx: 'Spanish', co: 'Spanish', cl: 'Spanish', pe: 'Spanish', ar: 'Spanish',
  br: 'Portuguese',
  de: 'German', fr: 'French', it: 'Italian', es: 'Spanish', nl: 'Dutch',
  pl: 'Polish', se: 'Swedish', no: 'Norwegian', dk: 'Danish',
  ng: 'English', za: 'English', ke: 'English', gh: 'English', et: 'Amharic',
};

async function run() {
    const targetLang  = LANGUAGE_MAP[countryCode]  || 'English';
    const countryName = COUNTRY_NAMES[countryCode] || countryCode;
    const tld         = `site:.${countryCode} OR site:.com.${countryCode}`;

    let baseQuery = '';

    if (targetLang !== 'English') {
        // 生成 3 类买家意图词：进口/批发渠道词 + 采购行为词 + 本地行业身份词
        const prompt = `You are a B2B procurement data expert.
Translate the industrial category "${category}" to ${targetLang} and provide buyer intent keywords.
Return ONLY valid JSON with this exact structure:
{
  "translated_category": "...",
  "buyer_channel_words": ["importer equivalent", "wholesaler equivalent"],
  "buying_intent_words": ["looking for supplier equivalent", "sourcing equivalent"],
  "company_type_words": ["trading company equivalent", "distributor equivalent"]
}`;
        const reqData  = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } });

        const resData = await new Promise(resolve => {
            const req = https.request({
                hostname: 'generativelanguage.googleapis.com',
                path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
                method: 'POST', headers: { 'Content-Type': 'application/json' },
            }, res => {
                let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body));
            });
            req.setTimeout(15000, () => { req.destroy(); resolve(null); });
            req.on('error', () => resolve(null)); req.write(reqData); req.end();
        });

        try {
            const parsed  = JSON.parse(resData);
            const content = JSON.parse(parsed.candidates[0].content.parts[0].text);
            const allIntents = [
                ...(content.buyer_channel_words || []),
                ...(content.buying_intent_words || []),
                ...(content.company_type_words  || []),
            ].slice(0, 4); // 最多 4 个，避免 query 过长
            const nativeStr = allIntents.map(i => `"${i}"`).join(' OR ');
            baseQuery = `"${content.translated_category}" (${nativeStr})`;
        } catch (e) { /* fallback to English below */ }
    }

    if (!baseQuery) {
        // 英语市场：多样化买家意图词（不只是 importer/wholesaler）
        baseQuery = `"${category}" ("importer" OR "wholesaler" OR "distributor" OR "buyer" OR "procurement" OR "sourcing")`;
    }

    fs.writeFileSync(outputFile, JSON.stringify({ baseQuery, tld, countryName, countryCode, category }, null, 2));
    console.log(`[step0] Orchestration written ??${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
