require('dotenv').config();
const fs    = require('fs');
const https = require('https');
const { execSync } = require('child_process');

const TAXONOMY_PATH = 'zhimao_global_taxonomy.json';
const STATE_PATH    = 'zhimao_matrix_state_v8.json';

const GEMINI_KEY        = process.env.GEMINI_KEY        || '';
const GEMINI_FAST_MODEL = process.env.GEMINI_FAST_MODEL || 'gemini-3.1-flash-lite';
const OPENAI_KEY        = process.env.OPENAI_API_KEY    || '';
const SPARSE_THRESHOLD  = 5; // 子品类少于此值时触发自动扩充

// ── Gemini/OpenAI 快速调用（用 Flash-Lite，无需引入 lib_concurrency 的重依赖）─
async function callLLMJson(prompt) {
    // 优先 Gemini Flash-Lite
    if (GEMINI_KEY) {
        try {
            const body = JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
            });
            const result = await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: 'generativelanguage.googleapis.com',
                    path: `/v1beta/models/${GEMINI_FAST_MODEL}:generateContent?key=${GEMINI_KEY}`,
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                }, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => resolve(d));
                });
                req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
                req.on('error', reject);
                req.write(body); req.end();
            });
            const parsed = JSON.parse(result);
            return JSON.parse(parsed.candidates[0].content.parts[0].text);
        } catch (e) {
            console.warn(`[cron] Gemini failed: ${e.message} — trying OpenAI fallback`);
        }
    }
    // OpenAI 兜底
    if (OPENAI_KEY) {
        const body = JSON.stringify({
            model: process.env.OPENAI_FAST_MODEL || 'gpt-4.1-mini',
            temperature: 0.2, response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: 'You are a B2B trade data expert. Always respond with valid JSON.' },
                { role: 'user', content: prompt },
            ],
        });
        const result = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.openai.com', path: '/v1/chat/completions',
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
            }, res => {
                let d = ''; res.on('data', c => d += c);
                res.on('end', () => resolve(d));
            });
            req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')); });
            req.on('error', reject);
            req.write(body); req.end();
        });
        const parsed = JSON.parse(result);
        return JSON.parse(parsed.choices[0].message.content);
    }
    throw new Error('No LLM API available for expandSparseIndustries');
}

// ── expandSparseIndustries ────────────────────────────────────────────────────
// 品类裂变核心：扫描 taxonomy，子品类数量 < SPARSE_THRESHOLD 时调用 LLM 生成新细分词
// 写回 zhimao_global_taxonomy.json，触发后续 knowledge_builder 补全经济模型
async function expandSparseIndustries(taxonomy) {
    let changed = false;
    for (const [industryName, industryData] of Object.entries(taxonomy.industries)) {
        const subs = Array.isArray(industryData.subcategories) ? industryData.subcategories : [];
        if (subs.length >= SPARSE_THRESHOLD) continue;

        console.log(`[cron] expandSparseIndustries: "${industryName}" only has ${subs.length} subcategories → generating more...`);
        const prompt = `You are a B2B trade expert. For the industry "${industryName}", list 8 specific product subcategories that overseas buyers actively import from China. These should be concrete, searchable product names (e.g. "LED Strip Lights", "Pasta Machine"). Return JSON: {"subcategories": ["...", "...", ...]}`;
        try {
            const result = await callLLMJson(prompt);
            const newSubs = Array.isArray(result.subcategories) ? result.subcategories : [];
            if (newSubs.length > 0) {
                // 合并，保留已有的，追加新增的（去重）
                const existingSet = new Set(subs.map(s => s.toLowerCase()));
                const merged = [...subs];
                for (const s of newSubs) {
                    if (!existingSet.has(s.toLowerCase())) merged.push(s);
                }
                taxonomy.industries[industryName].subcategories = merged;
                console.log(`[cron] "${industryName}": ${subs.length} → ${merged.length} subcategories (+${merged.length - subs.length} new)`);
                changed = true;
            }
        } catch (e) {
            console.warn(`[cron] expandSparseIndustries failed for "${industryName}": ${e.message}`);
        }
    }
    return changed;
}

// Core strategic target countries for the Matrix
const TARGET_COUNTRIES = ['mx', 'ae', 'vn', 'id', 'th', 'my', 'sa', 'br', 'co', 'de', 'us', 'sg'];

async function run() {
    console.log(`\n======================================================`);
    console.log(`[V8 CRON WORKER] DISPATCHING NEXT MATRIX TASK`);
    console.log(`======================================================`);

    if (!fs.existsSync(TAXONOMY_PATH)) {
        console.error('Taxonomy missing! Cannot proceed.');
        return;
    }
    let taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));

    // ── expandSparseIndustries：品类自动裂变 ──────────────────────────────────
    // 每次 cron 运行前检查：若有大类子品类 < 5，先扩充再派发任务
    // 扩充后同步触发 knowledge_builder 补全经济模型
    if (GEMINI_KEY || OPENAI_KEY) {
        try {
            const taxonomyChanged = await expandSparseIndustries(taxonomy);
            if (taxonomyChanged) {
                // 写回 taxonomy
                fs.writeFileSync(TAXONOMY_PATH, JSON.stringify(taxonomy, null, 2));
                console.log(`[cron] taxonomy updated. Triggering knowledge_builder to fill gaps...`);
                // 自动触发 knowledge_builder（异步，不阻塞 cron 主流程）
                try {
                    execSync('node v8_knowledge_builder.js', { stdio: 'inherit', timeout: 180_000 });
                    console.log(`[cron] knowledge_builder completed.`);
                } catch (e) {
                    console.warn(`[cron] knowledge_builder failed (non-fatal): ${e.message}`);
                }
                // 重新读入 taxonomy（knowledge_builder 可能也更新了它）
                taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
            }
        } catch (e) {
            console.warn(`[cron] expandSparseIndustries error (non-fatal): ${e.message}`);
        }
    } else {
        console.warn('[cron] No LLM key — expandSparseIndustries skipped.');
    }

    let state = {};
    if (fs.existsSync(STATE_PATH)) {
        state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }

    const pendingTasks = [];
    for (const [industryName, industryData] of Object.entries(taxonomy.industries)) {
        const targets = typeof industryData.subcategories === 'string'
            ? industryData.subcategories.split(' ').filter(Boolean)
            : (Array.isArray(industryData.subcategories) && industryData.subcategories.length > 0
                ? industryData.subcategories
                : [industryName]);

        targets.forEach(category => {
            TARGET_COUNTRIES.forEach(country => {
                const taskKey = `${category}|${country}`;
                const lastSwept = state[taskKey] ? new Date(state[taskKey].last_swept).getTime() : 0;
                pendingTasks.push({ category, country, lastSwept, taskKey });
            });
        });
    }

    // Sort by least recently swept (0 = never swept)
    pendingTasks.sort((a, b) => a.lastSwept - b.lastSwept);

    if (pendingTasks.length === 0) {
        console.log('[V8 Cron Worker] No tasks generated.');
        return;
    }

    const nextTask = pendingTasks[0];
    console.log(`>>> Selected Task: [${nextTask.category}] in [${nextTask.country}] <<<`);
    console.log(`Last swept: ${nextTask.lastSwept === 0 ? 'Never' : new Date(nextTask.lastSwept).toISOString()}`);

    const currentSweepCount = (state[nextTask.taskKey]?.sweep_count || 0) + 1;

    // ── SWEEP_COUNT → Step1 Deep Paging ──────────────────────────────────────
    // 第 N 次跑同一网格时，告知 Step1 从第 N 页开始抓（每页 20 条）。
    // 例：第1次刮 p1-20，第2次刮 p21-40，第5次刮 p81-100（长尾冰山）
    const taskEnv = { ...process.env, SWEEP_COUNT: String(currentSweepCount) };

    try {
        execSync(`node zhimao_v8_ultimate_master.js ${nextTask.country} "${nextTask.category}"`, {
            stdio: 'inherit',
            env: taskEnv,
        });

        // Commit state only after successful completion
        state[nextTask.taskKey] = {
            last_swept:  new Date().toISOString(),
            sweep_count: currentSweepCount,
        };
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        console.log(`\n[V8 Cron Worker] Task completed. sweep_count=${currentSweepCount} (search page=${currentSweepCount})`);
    } catch (e) {
        console.error(`\n[V8 Cron Worker] Task failed: ${e.message}`);
    }
}

run().catch(e => { console.error('[cron] fatal:', e); process.exit(1); });
