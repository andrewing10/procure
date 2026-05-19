require('dotenv').config();
const fs    = require('fs');
const https = require('https');

const [inputFile, outputFile, countryCode, ...catArgs] = process.argv.slice(2);
const category = catArgs.join(' ') || 'Industrial';

const GEMINI_KEY   = process.env.GEMINI_KEY    || '';
// Step0 仅做语言翻译和意图词生成，是简单任务 → 用 Flash-Lite（快 5-10x，省 10x 费用）
const GEMINI_MODEL = process.env.GEMINI_FAST_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const OPENAI_KEY   = process.env.OPENAI_API_KEY  || '';
// 翻译是简单任务，用快速低成本模型兜底
const OPENAI_MODEL = process.env.OPENAI_FAST_MODEL || 'gpt-4.1-mini';
// 无 Gemini 时，若 OpenAI 也未配置才退出；否则直接走 OpenAI 路径
if (!GEMINI_KEY && !OPENAI_KEY) {
    console.error('[step0] GEMINI_KEY or OPENAI_API_KEY is required');
    process.exit(1);
}
if (!GEMINI_KEY) {
    console.warn('[step0] GEMINI_KEY not set — will use OpenAI only for translation.');
}

// 国家名称映射（与 zhimao apps/web/lib/search/v8DiscoveryCountrySupport.ts 同步）
const COUNTRY_NAMES = {
  // 亚洲
  vn: 'Vietnam', th: 'Thailand', id: 'Indonesia', my: 'Malaysia', sg: 'Singapore',
  ph: 'Philippines', mm: 'Myanmar', kh: 'Cambodia', bd: 'Bangladesh', pk: 'Pakistan',
  in: 'India', lk: 'Sri Lanka', np: 'Nepal', jp: 'Japan', kr: 'South Korea', tw: 'Taiwan',
  cn: 'China', hk: 'Hong Kong', mo: 'Macau', ru: 'Russia',
  // 中东
  ae: 'UAE', sa: 'Saudi Arabia', qa: 'Qatar', kw: 'Kuwait', bh: 'Bahrain', om: 'Oman',
  tr: 'Turkey', il: 'Israel', jo: 'Jordan', eg: 'Egypt',
  // 美洲
  us: 'United States', mx: 'Mexico', br: 'Brazil', co: 'Colombia', cl: 'Chile',
  pe: 'Peru', ar: 'Argentina', ca: 'Canada',
  // 欧洲
  de: 'Germany', gb: 'United Kingdom', fr: 'France', it: 'Italy', es: 'Spain',
  nl: 'Netherlands', pl: 'Poland', se: 'Sweden', no: 'Norway', dk: 'Denmark',
  pt: 'Portugal', ie: 'Ireland', ch: 'Switzerland', at: 'Austria', be: 'Belgium',
  fi: 'Finland', cz: 'Czech Republic', hu: 'Hungary', ro: 'Romania', bg: 'Bulgaria',
  sk: 'Slovakia', hr: 'Croatia', si: 'Slovenia', ee: 'Estonia', lv: 'Latvia', lt: 'Lithuania',
  lu: 'Luxembourg', is: 'Iceland', mt: 'Malta', cy: 'Cyprus',
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
  cn: 'Simplified Chinese', hk: 'Traditional Chinese', mo: 'Traditional Chinese', ru: 'Russian',
  ae: 'Arabic', sa: 'Arabic', qa: 'Arabic', kw: 'Arabic', bh: 'Arabic', om: 'Arabic',
  tr: 'Turkish', il: 'Hebrew', jo: 'Arabic', eg: 'Arabic',
  us: 'English', ca: 'English', gb: 'English', au: 'English', nz: 'English', sg: 'English',
  mx: 'Spanish', co: 'Spanish', cl: 'Spanish', pe: 'Spanish', ar: 'Spanish',
  br: 'Portuguese',
  de: 'German', fr: 'French', it: 'Italian', es: 'Spanish', nl: 'Dutch',
  pl: 'Polish', se: 'Swedish', no: 'Norwegian', dk: 'Danish',
  pt: 'Portuguese', ie: 'English', ch: 'German', at: 'German', be: 'Dutch',
  fi: 'Finnish', cz: 'Czech', hu: 'Hungarian', ro: 'Romanian', bg: 'Bulgarian',
  sk: 'Slovak', hr: 'Croatian', si: 'Slovenian', ee: 'Estonian', lv: 'Latvian', lt: 'Lithuanian',
  lu: 'French', is: 'Icelandic', mt: 'English', cy: 'Greek',
  ng: 'English', za: 'English', ke: 'English', gh: 'English', et: 'Amharic',
};

async function run() {
    const cc = String(countryCode || '').trim().slice(0, 2).toLowerCase() || 'us';
    const isoUpper = cc.toUpperCase();
    const targetLang  = LANGUAGE_MAP[cc]  || 'English';
    const countryName = COUNTRY_NAMES[cc] || isoUpper;
    const tld         = `site:.${cc} OR site:.com.${cc}`;

    /**
     * 品类词净化：去掉"买家/buyer"类后缀和"...buyers in X"型语境词，
     * 让 V8 搜索基于真实产品名而非营销短语。
     * 原词保留在 category 里用于 DB 记录；搜索全程用 categoryClean。
     *
     * 例：
     *   "居銮红酒买家"        → "居銮红酒"
     *   "LED lighting buyers in Singapore" → "LED lighting"
     *   "护肝片买家"          → "护肝片"
     *   "mattress buyer"      → "mattress"
     */
    const categoryClean = category
      // 英文：去掉 "buyers in/from/at Country" 型末尾修饰语
      .replace(/\s+buyers?\s+(?:in|from|at|within|across|for)\s+.+$/i, '')
      // 中文：去掉"买家/进口商/购买者/采购商/采购方"后缀
      .replace(/[\s]*(买家|进口商|购买者|采购商|采购方|采购代理)\s*$/i, '')
      // 英文：去掉末尾 " buyer/buyers/importer/importers/purchaser" 词
      .replace(/[\s]+(buyer|buyers|importer|importers|purchaser|purchasers)\s*$/i, '')
      .trim() || category;

    if (categoryClean !== category) {
        console.log(`[step0] category cleaned: "${category}" → "${categoryClean}"`);
    }

    // ── Pillar 0：读取产业链扩展结果（由 zhimao interpret→expand-query 生成） ──
    let pillar0Keywords = [];
    let pillar0Personas = [];
    let pillar0BooleanQueries = [];
    try {
        const raw = process.env.PILLAR0_PAYLOAD;
        if (raw && raw.trim().startsWith('{')) {
            const p0 = JSON.parse(raw);
            if (Array.isArray(p0.expanded_keywords) && p0.expanded_keywords.length > 0) {
                pillar0Keywords = p0.expanded_keywords.slice(0, 20); // 最多 20 个扩展词
            }
            if (Array.isArray(p0.buyer_personas) && p0.buyer_personas.length > 0) {
                pillar0Personas = p0.buyer_personas
                    .map((p) => p.industry_en || p.industry_zh || p.industry || p.name)
                    .filter(Boolean)
                    .slice(0, 8);
            }
            if (Array.isArray(p0.boolean_queries) && p0.boolean_queries.length > 0) {
                pillar0BooleanQueries = p0.boolean_queries.slice(0, 3);
            }
            if (pillar0Keywords.length > 0 || pillar0Personas.length > 0) {
                console.log(`[step0] Pillar 0 payload loaded: ${pillar0Keywords.length} keywords, ${pillar0Personas.length} personas`);
            }
        }
    } catch (e) {
        console.warn('[step0] PILLAR0_PAYLOAD parse failed, continuing without expansion:', e.message);
    }

    let baseQuery = '';

    // 判断净化后的品类是否已是纯英文（无中文/日文/韩文/阿拉伯文等 Unicode 区段），
    // 若是则跳过 LLM 翻译直接用英文模板——避免 LLM 误改导致 exit(1) + 节省费用。
    const hasNonLatin = /[\u0080-\uFFFF]/.test(categoryClean);
    const isAlreadyEnglish = !hasNonLatin;

    if (targetLang !== 'English' && !isAlreadyEnglish) {
        // 生成 3 类买家意图词：进口/批发渠道词 + 采购行为词 + 本地行业身份词
        // 使用净化后的 categoryClean 而非原始 category，避免"买家/buyers in X"干扰翻译
        const prompt = `You are a B2B procurement data expert.
Translate the industrial category "${categoryClean}" to ${targetLang} and provide buyer intent keywords.
Return ONLY valid JSON with this exact structure:
{
  "translated_category": "...",
  "buyer_channel_words": ["importer equivalent", "wholesaler equivalent"],
  "buying_intent_words": ["looking for supplier equivalent", "sourcing equivalent"],
  "company_type_words": ["trading company equivalent", "distributor equivalent"]
}`;
        const reqData  = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } });

        // ── 优先 Gemini Flash-Lite，失败后回退 OpenAI ───────────────────────
        let content = null;
        if (GEMINI_KEY) {
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
                if (resData) {
                    const parsed  = JSON.parse(resData);
                    content = JSON.parse(parsed.candidates[0].content.parts[0].text);
                }
            } catch (_) { content = null; }
        }

        // OpenAI 兜底
        if (!content && OPENAI_KEY) {
            try {
                const oaBody = JSON.stringify({
                    model: OPENAI_MODEL, temperature: 0.1,
                    response_format: { type: 'json_object' },
                    messages: [
                        { role: 'system', content: 'You are a B2B procurement data expert. Always respond with valid JSON.' },
                        { role: 'user', content: prompt },
                    ],
                });
                const oaRes = await new Promise(resolve => {
                    const req = https.request({
                        hostname: 'api.openai.com', path: '/v1/chat/completions',
                        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
                    }, res => {
                        let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body));
                    });
                    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
                    req.on('error', () => resolve(null)); req.write(oaBody); req.end();
                });
                if (oaRes) {
                    const parsed = JSON.parse(oaRes);
                    content = JSON.parse(parsed.choices[0].message.content);
                    console.log(`[step0] OpenAI fallback succeeded for translation`);
                }
            } catch (_) { content = null; }
        }

        if (content) {
            const allIntents = [
                ...(content.buyer_channel_words || []),
                ...(content.buying_intent_words || []),
                ...(content.company_type_words  || []),
            ].slice(0, 4); // 最多 4 个，避免 query 过长
            const nativeStr = allIntents.map(i => `"${i}"`).join(' OR ');
            baseQuery = `"${content.translated_category}" (${nativeStr})`;
        }
    }

    if (!baseQuery) {
        // 英语市场 或 品类词已是英文：多样化买家意图词（不只是 importer/wholesaler）
        // 使用净化后的 categoryClean 避免把"buyers in Singapore"再套进 query
        if (isAlreadyEnglish && targetLang !== 'English') {
            console.log(`[step0] category already English, skipping LLM translation for ${targetLang} market`);
        }
        baseQuery = `"${categoryClean}" ("importer" OR "wholesaler" OR "distributor" OR "buyer" OR "procurement" OR "sourcing")`;
    }

    // ── Pillar 0 注入：将产业链扩展词追加到搜索策略 ──────────────────────────
    // 例：搜"电池"时扩展为"drone manufacturer OR e-bike assembler OR energy storage brand"
    // 这让 V8 矩阵能直接找到下游真实买家，而不是搜原始品类词
    if (pillar0Personas.length > 0 || pillar0Keywords.length > 0) {
        // 优先用买家画像（industry_en）构建精准意图查询
        const intentTerms = [
            ...pillar0Personas.slice(0, 5).map(p => `"${p}"`),
            ...pillar0Keywords.slice(0, 8).map(k => `"${k}"`),
        ];
        if (intentTerms.length > 0) {
            const intentClause = intentTerms.join(' OR ');
            // 组合成：(原始品类 OR 扩展下游买家词) AND 采购意图词
            baseQuery = `(${intentClause}) AND ("importer" OR "buyer" OR "procurement" OR "sourcing" OR "supplier")`;
            console.log(`[step0] Pillar 0 enhanced query: ${baseQuery.slice(0, 120)}...`);
        }
    }

    // 写出 step0 结果（含 Pillar 0 扩展词，供 step1+ 使用）
    fs.writeFileSync(outputFile, JSON.stringify({
        baseQuery,
        tld,
        countryName,
        countryCode: isoUpper,
        category,        // 保留原始品类词供 DB 记录展示
        categoryClean,   // 净化后的搜索品类词，step1 用于构建 query
        // 传递 Pillar 0 原始数据给后续步骤备用
        pillar0Keywords: pillar0Keywords.length > 0 ? pillar0Keywords : undefined,
        pillar0BooleanQueries: pillar0BooleanQueries.length > 0 ? pillar0BooleanQueries : undefined,
    }, null, 2));
    console.log(`[step0] Orchestration written → ${outputFile}`);
}

run().catch(e => { console.error(e); process.exit(1); });
