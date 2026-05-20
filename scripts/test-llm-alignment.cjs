#!/usr/bin/env node
/**
 * V8 矩阵 LLM 对齐 / 三家级联 端到端实测
 *
 * 验收：
 *   1. callGeminiJson 默认配置正常加载 GEMINI/CLAUDE/OPENAI key
 *   2. Gemini 正常 → 三家均走通
 *   3. Gemini 给假 key → 自动降级 Claude
 *   4. Gemini + Claude 都假 key → 自动降级 OpenAI
 */
require("../load-env");
const { callGeminiJson } = require("../v8_lib_concurrency");

const REAL_GEMINI = process.env.GEMINI_KEY;
const REAL_CLAUDE = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const REAL_OPENAI = process.env.OPENAI_API_KEY;

console.log(`\n=== V8 矩阵 LLM 三家级联实测 ===`);
console.log(`GEMINI_KEY:        ${REAL_GEMINI ? REAL_GEMINI.slice(0, 15) + "..." : "<not set>"}`);
console.log(`ANTHROPIC_API_KEY: ${REAL_CLAUDE ? REAL_CLAUDE.slice(0, 15) + "..." : "<not set>"}`);
console.log(`OPENAI_API_KEY:    ${REAL_OPENAI ? REAL_OPENAI.slice(0, 15) + "..." : "<not set>"}`);
console.log(`GEMINI_MODEL:      ${process.env.GEMINI_MODEL || "default"}`);
console.log(`ANTHROPIC_MODEL:   ${process.env.ANTHROPIC_MODEL || "default"}`);
console.log(`OPENAI_MODEL:      ${process.env.OPENAI_MODEL || "default"}\n`);

const PROMPT = `Return strict JSON: {"ok": true, "echo": "alignment"}`;

async function probe(label, opts) {
  const t0 = Date.now();
  try {
    const r = await callGeminiJson(PROMPT, opts);
    const elapsed = Date.now() - t0;
    console.log(`[${label}] OK in ${elapsed}ms -> ${JSON.stringify(r).slice(0, 60)}`);
    return r;
  } catch (e) {
    const elapsed = Date.now() - t0;
    console.log(`[${label}] FAIL in ${elapsed}ms: ${e.message.slice(0, 100)}`);
    return null;
  }
}

(async () => {
  // Scenario 1: 三家全真（应该 Gemini 直接成功）
  console.log("--- Scenario 1: 三家 key 全真 → 期望 Gemini 直接成功 ---");
  await probe("scenario-1/all-real", {
    apiKey: REAL_GEMINI,
    model: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
    timeoutMs: 30_000,
    maxRetries: 1,
    label: "alignment-1",
    claudeApiKey: REAL_CLAUDE,
    openaiApiKey: REAL_OPENAI,
  });

  // Scenario 2: Gemini 假 key → 期望 Claude 兜底成功
  console.log("\n--- Scenario 2: Gemini 假 key → 期望 Claude 兜底成功 ---");
  await probe("scenario-2/gemini-fake", {
    apiKey: "AIzaFAKE_KEY_FORCE_FALLBACK",
    model: "gemini-3-flash-preview",
    timeoutMs: 30_000,
    maxRetries: 1,
    label: "alignment-2",
    claudeApiKey: REAL_CLAUDE,
    openaiApiKey: REAL_OPENAI,
  });

  // Scenario 3: Gemini + Claude 都假 → 期望 OpenAI 兜底成功
  console.log("\n--- Scenario 3: Gemini + Claude 都假 → 期望 OpenAI 兜底成功 ---");
  await probe("scenario-3/openai-only", {
    apiKey: "AIzaFAKE_KEY_FORCE_FALLBACK",
    model: "gemini-3-flash-preview",
    timeoutMs: 30_000,
    maxRetries: 1,
    label: "alignment-3",
    claudeApiKey: "sk-ant-FAKE_KEY_FORCE_OPENAI",
    openaiApiKey: REAL_OPENAI,
    openaiModel: process.env.OPENAI_MODEL || "gpt-5.5",
  });

  console.log("\n=== 实测完毕 ===\n");
})();
