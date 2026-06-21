#!/usr/bin/env node
/**
 * 隔离测 v8_lib_concurrency.js OpenAI 兜底分支
 * 直接 force fallback：用假 GEMINI key + 假 CLAUDE key + 真 OPENAI key
 */
require("../load-env");
const { callGeminiJson } = require("../v8_lib_concurrency");

const REAL_OPENAI = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

console.log(`OPENAI_KEY: ${REAL_OPENAI ? REAL_OPENAI.slice(0, 15) + "..." : "<NONE>"}`);
console.log(`OPENAI_MODEL: ${OPENAI_MODEL}\n`);

(async () => {
  const t0 = Date.now();
  try {
    const r = await callGeminiJson(
      'Return strict JSON: {"ok": true, "echo": "openai-only"}',
      {
        apiKey: "AIzaFAKE",
        model: "gemini-3-flash-preview",
        timeoutMs: 30_000,
        maxRetries: 1,
        label: "openai-isolated",
        claudeApiKey: "sk-ant-FAKE",
        openaiApiKey: REAL_OPENAI,
        openaiModel: OPENAI_MODEL,
      }
    );
    console.log(`OK in ${Date.now() - t0}ms ->`, JSON.stringify(r));
  } catch (e) {
    console.log(`FAIL in ${Date.now() - t0}ms`);
    console.log(`Full error: ${e.message}`);
  }
})();
