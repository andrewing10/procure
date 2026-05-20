const fs = require('fs');
const { execSync } = require('child_process');

console.log(`\n==================================================================`);
console.log(`[V8 ULTIMATE OMNI-MATRIX] FULL PHYSICAL ASSERTION ENGINE`);
console.log(`==================================================================\n`);

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error("Usage: node zhimao_v8_ultimate_master.js <country_code> <category>");
    process.exit(1);
}

const countryCode = args[0];
const category = args.slice(1).join(' ');
const sessionId = `v8_ultimate_${countryCode}_${Date.now()}`;
fs.mkdirSync(sessionId, { recursive: true });

function runAssertedStep(stepName, scriptFile, inputFiles, outputFile, extraArgs = "") {
    console.log(`\n>>> [STEP: ${stepName}] <<<`);

    const inputs = Array.isArray(inputFiles) ? inputFiles : [inputFiles];
    inputs.forEach(inf => {
        if (inf && !fs.existsSync(inf)) {
            console.error(`[HALT] Required input '${inf}' missing.`);
            process.exit(1);
        }
    });

    const inputArg = inputs.join(',');
    const cmd = `node ${scriptFile} "${inputArg}" "${outputFile}" ${extraArgs}`;
    console.log(`-> Executing: ${cmd}`);

    try {
        execSync(cmd, { stdio: 'inherit' });
    } catch (e) {
        console.error(`[HALT] Script crashed: ${scriptFile}. Error: ${e.message}`);
        // 写入 job-scoped 崩溃文件，供 v8_discovery_worker.js 在 markFailed 时读取
        const jobId = process.env.DISCOVERY_JOB_ID || 'unknown';
        try {
            fs.writeFileSync(
                `crash_${jobId}.json`,
                JSON.stringify({ step: stepName, script: scriptFile, error: String(e.message || '').slice(0, 300) })
            );
        } catch (_) { /* ignore crash-file write failure */ }
        process.exit(1);
    }

    if (!fs.existsSync(outputFile)) {
        console.error(`[HALT] Physical output missing: ${outputFile}.`);
        process.exit(1);
    }

    const outputData = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    const count = Array.isArray(outputData)
        ? outputData.length
        : (outputData.organic         ? outputData.organic.length
            : (outputData.data        ? outputData.data.length
                : (outputData.dorks   ? outputData.dorks.length
                    : (outputData.baseQuery    ? 1
                        : (outputData.db_injected != null ? outputData.db_injected
                            : (outputData.status === 'success' ? 1 : 0))))));

    if (count === 0 && !stepName.includes("Bridge")) {
        // exit(2) = "graceful stop, no data" — 与 exit(0)=完全成功 / exit(1)=崩溃 语义区分
        // discovery_worker 和 cron_worker 读取此 exit code：
        //   0 → 全量写入成功
        //   1 → 脚本崩溃 / 配置错误
        //   2 → 流水线正常但本轮该网格无新数据（不计为失败，但不应标记 job 为 done）
        console.warn(`[PIPELINE STOP] Step "${stepName}" returned 0 results — graceful stop (exit 2).`);
        process.exit(2);
    }

    console.log(`[ASSERTION PASSED] ${outputFile} validated with ${count} records.`);
    return outputData;
}

const fileBus = {
    t0_orchestration: `${sessionId}/00_orchestration.json`,
    t1_raw_pool:      `${sessionId}/01_raw_pool.json`,
    t2_intake:        `${sessionId}/02_intake.json`,
    t3_enriched:      `${sessionId}/03_enriched_scored.json`,
    t4_deduped:       `${sessionId}/04_deduped.json`,
    t5_final:         `${sessionId}/05_final_routing.json`,
};

/**
 * 热读 action_payload.negative_keywords 并合并到 CONVO_CONTROLS。
 * 在 step1 完成后调用，让 step2/step5 的 keywordSuppress 能感知运行期注入的排除词。
 * Supabase 不可用时静默降级（不阻断 pipeline）。
 */
async function refreshLiveNegativeKeywords() {
    const jobId = process.env.DISCOVERY_JOB_ID;
    const url   = process.env.SUPABASE_URL;
    const key   = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!jobId || !url || !key) return;

    try {
        const res = await fetch(
            `${url}/rest/v1/discovery_jobs?id=eq.${encodeURIComponent(jobId)}&select=action_payload`,
            { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } }
        );
        if (!res.ok) return;
        const rows = await res.json();
        const ap = rows?.[0]?.action_payload;
        if (!ap || typeof ap !== 'object') return;

        const liveKw = Array.isArray(ap.negative_keywords)
            ? ap.negative_keywords.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
            : [];
        if (liveKw.length === 0) return;

        // 合并到现有 CONVO_CONTROLS
        let controls = {};
        try {
            const raw = process.env.CONVO_CONTROLS;
            if (raw) controls = JSON.parse(raw);
        } catch { /* ignore */ }

        const existingKw = Array.isArray(controls.keywordSuppress) ? controls.keywordSuppress : [];
        const merged = [...new Set([...existingKw, ...liveKw])];
        controls.keywordSuppress = merged;
        process.env.CONVO_CONTROLS = JSON.stringify(controls);

        console.log(`[master] live negative_keywords refreshed: [${merged.join(', ')}] — will apply from step2 onwards`);
    } catch (e) {
        console.warn(`[master] refreshLiveNegativeKeywords failed (non-fatal):`, e?.message || e);
    }
}

// PHASE 0: Geo-Drill & Bilingual Dorks
runAssertedStep("0. Geo-Orchestrator & Translator", "v8_step0_ultimate_translator.js", [], fileBus.t0_orchestration, `"${countryCode}" "${category}"`);

// PHASE 1: Multi-Pillar Omni-Collection
runAssertedStep("1. Omni-Pillar Collection (6+1 Hub)", "v8_step1_omni_hub.js", fileBus.t0_orchestration, fileBus.t1_raw_pool, `"${countryCode}"`);

// ── 热读排除词（step1 结束后，step2 开始前）──────────────────────────────────
// 用户在 step1 运行期间通过前端注入的 negative_keywords 会写入 action_payload；
// 此处从 DB 同步最新词表到 CONVO_CONTROLS，让 step2 preFilterRawLeads 能感知。
(async () => { try { await refreshLiveNegativeKeywords(); } catch (_) {} })();

// PHASE 2: LLM Anti-Hallucination & CN-Filter Intake
runAssertedStep("2. Strict Entity Intake", "v8_step2_intake.js", fileBus.t1_raw_pool, fileBus.t2_intake);

// PHASE 3: L3 Supply-Chain Inference + Contact Extraction
// Gemini infers entity_role, BOM (primary_materials_top3), procurement_items, confidence_tier,
// intent_summary — stored as inference_breakdown (L1 column via Step5 Supabase ingest).
runAssertedStep("3. L3 Supply-Chain Inference & Contact Extraction", "v8_step3_ultimate_enrichment.js", fileBus.t2_intake, fileBus.t3_enriched);

// PHASE 3.5 (Optional): 税号/工商注册反向验证（置信度加权，加分不减分）
// 由 TAX_VERIFY_ENABLED=true 环境变量激活；默认关闭，不影响主流水线稳定性
const fileBus_t3v_verified = `${sessionId}/03b_tax_verified.json`;
if (process.env.TAX_VERIFY_ENABLED === 'true') {
    runAssertedStep(
        "3.5 Tax Registry Cross-Verify (Bridge)",
        "v8_tax_verifier.js",
        fileBus.t3_enriched,
        fileBus_t3v_verified
    );
    fileBus.t3_enriched = fileBus_t3v_verified; // 后续步骤读取已加权文件
}

// PHASE 4: Global Dedupe & Schema Normalization
runAssertedStep("4. Global Dedupe", "v8_step4_dedupe.js", fileBus.t3_enriched, fileBus.t4_deduped, `"${countryCode}"`);

// PHASE 5: Routing Gateway → Supabase L1 + graph edges
runAssertedStep("5. Routing & Persistence Gateway", "v8_step5_routing_gateway.js", fileBus.t4_deduped, fileBus.t5_final);

console.log(`\n[V8 PIPELINE COMPLETE] Session: ${sessionId}`);
