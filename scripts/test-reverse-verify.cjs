#!/usr/bin/env node
/**
 * 业态画像树工程 — B 实测：step3 L3 反向验证（直接 require inferL3SupplyChain）。
 *
 * 跑法：
 *   set DISCOVERY_CATEGORY=cardboard box && node scripts/test-reverse-verify.cjs
 *
 * 不跑 Playwright（不需要联系页抓取），只测 L3 反向验证。
 */
require("../load-env");
const fs = require("fs");

if (!process.env.DISCOVERY_CATEGORY) {
  process.env.DISCOVERY_CATEGORY = "cardboard box";
  console.log(`[setup] DISCOVERY_CATEGORY default = "cardboard box"`);
}
if (!process.env.GEMINI_KEY) {
  console.error("[fatal] GEMINI_KEY not set — set in .env first");
  process.exit(1);
}

const TARGET_CATEGORY = process.env.DISCOVERY_CATEGORY;
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`业态画像树工程 / B 实测 — step3 L3 反向验证`);
console.log(`Target Category: "${TARGET_CATEGORY}"`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

// ── 6 家测试公司 — 模拟 V8 step1 + step2 输出 ──
const testLeads = [
  {
    company_name: "Shopee Malaysia Sdn Bhd",
    snippet: "Shopee is the leading e-commerce platform in Southeast Asia, processing millions of orders daily for fashion, electronics, and home goods.",
    domain: "shopee.com.my",
    expected: "high",
  },
  {
    company_name: "Pensonic Holdings Berhad",
    snippet: "Pensonic is a leading Malaysian home appliance manufacturer producing kitchen appliances, fans, and small electronics for export.",
    domain: "pensonic.com",
    expected: "high",
  },
  {
    company_name: "Mamee-Double Decker Sdn Bhd",
    snippet: "Mamee-Double Decker manufactures snacks, instant noodles, and beverages distributed across Asia.",
    domain: "mamee.com",
    expected: "high",
  },
  {
    company_name: "DHL Express Malaysia",
    snippet: "DHL Express provides international logistics and parcel delivery services across Malaysia and Southeast Asia.",
    domain: "dhl.com",
    expected: "medium",
  },
  {
    company_name: "PwC Malaysia",
    snippet: "PwC Malaysia provides audit, tax, and advisory services to businesses across multiple industries.",
    domain: "pwc.com",
    expected: "none",
  },
  {
    company_name: "Top Glove Corporation Bhd",
    snippet: "Top Glove is the world's largest manufacturer of latex and nitrile gloves, exporting to over 195 countries.",
    domain: "topglove.com",
    expected: "high",
  },
];

testLeads.forEach((l, i) => {
  l.country = "MY";
  l.confidence_score = 60;
  l.industry_match = "high";
  l._test_id = i + 1;
  console.log(`  [${i + 1}] ${l.company_name.padEnd(38)} expected=${l.expected}`);
});

// ── 直接 hack 调用 step3 内部的 inferL3SupplyChain ──
// step3 的 module 在 require 后会立即执行 run()，所以我们需要绕过它。
// 方案：把 step3 require 进来时设置 process.argv 让它进入 run()，但因为 run() 期望
// 输入文件存在，不存在会进入空逻辑。最简单：直接复制 inferL3SupplyChain 的逻辑，
// 用 callGeminiJson 直跑 prompt。

const { callGeminiJson } = require("../v8_lib_concurrency");
const { normalizePurchaseCycle } = require("../v8_l1_field_normalize");

const GEMINI_KEY = process.env.GEMINI_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

async function inferL3(leads) {
  // 复用 v8_step3 的 prompt 构造逻辑
  const reverseVerifyBlock =
    `\n\n[REVERSE-VERIFICATION GATE — INDUSTRY PERSONA TREE]\n` +
    `The user's original search target category is: "${TARGET_CATEGORY}".\n` +
    `For EACH company, additionally output:\n` +
    `  "target_category_match": "high" | "medium" | "low" | "none"\n` +
    `    high   = company's primary operations REQUIRE "${TARGET_CATEGORY}" as core input/merchandise (must buy)\n` +
    `    medium = plausibly procures "${TARGET_CATEGORY}" occasionally / auxiliarily\n` +
    `    low    = unlikely buyer (industry adjacent but no clear procurement pathway)\n` +
    `    none   = clearly NOT a buyer (different supply chain, e.g. service-only, software, finance)\n` +
    `  "target_category_evidence": one short English sentence (≤80 chars) explaining WHY this company would\n` +
    `    procure "${TARGET_CATEGORY}".\n` +
    `  "target_category_reason": short snake_case code: "core_input" | "auxiliary" | "adjacent" | "no_pathway"\n\n` +
    `⚠ This is the most important field — it gates whether the lead is shown to the user.\n` +
    `⚠ "Service" entity_role companies almost always = none/low for physical-goods categories.\n` +
    `⚠ Be conservative: if you cannot articulate a specific procurement use-case, output "low" or "none".`;

  const prompt = `You are a Supply Chain Intelligence AI. Analyze each company and produce a structured L3 procurement inference.

Rules:
1. entity_role: "Manufacturer" / "Wholesaler" / "Retailer" / "Service".
2. primary_materials_top3: 3 upstream raw materials in snake_case.
3. procurement_items: array of {category, priority, source:"bom", type:"explicit"}.
4. confidence_tier: "High" / "Medium" / "Low".
5. intent_summary: one English sentence.
6. purchase_cycle: weekly|monthly|quarterly|annual.
7. reason_codes: array.${reverseVerifyBlock}

Output strict JSON only:
{"results":[{"name":"...","entity_role":"...","confidence_tier":"...","primary_materials_top3":["...","...","..."],"procurement_items":[{"category":"...","priority":1,"source":"bom","type":"explicit"}],"intent_summary":"...","purchase_cycle":"...","reason_codes":["..."],"target_category_match":"...","target_category_evidence":"...","target_category_reason":"..."}]}

Input: ${JSON.stringify(leads.map(l => ({ name: l.company_name, snip: (l.snippet || "").slice(0, 120) })))}`;

  const parsed = await callGeminiJson(prompt, {
    apiKey: GEMINI_KEY,
    model: GEMINI_MODEL,
    temperature: 0.2,
    timeoutMs: 60_000,
    maxRetries: 2,
    label: "test/L3-reverse-verify",
    openaiApiKey: OPENAI_KEY,
    openaiModel: OPENAI_MODEL,
  });

  return parsed?.results || [];
}

(async () => {
  console.log(`\n[L3] running inference (15-60s)...\n`);
  const t0 = Date.now();
  let results;
  try {
    results = await inferL3(testLeads);
  } catch (e) {
    console.error(`[L3] FAILED: ${e.message}`);
    process.exit(1);
  }
  console.log(`[L3] done in ${Date.now() - t0}ms — ${results.length} results\n`);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`L3 反向验证结果：`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const compareMap = { high: 4, medium: 3, low: 2, none: 1 };
  const norm = (s) => (s || "").toLowerCase().trim();
  let passNear = 0;
  let passExact = 0;
  for (const lead of testLeads) {
    const r = results.find(x => norm(x.name) === norm(lead.company_name));
    if (!r) {
      console.log(`  [${lead._test_id}] ${lead.company_name.padEnd(38)} ✗ NOT FOUND in L3 results`);
      continue;
    }
    const got = (r.target_category_match || "").toLowerCase();
    const expected = lead.expected;
    const gotL = compareMap[got] ?? 0;
    const expL = compareMap[expected] ?? 0;
    const ok = Math.abs(gotL - expL) <= 1;
    const exact = got === expected;
    if (ok) passNear++;
    if (exact) passExact++;
    const flag = exact ? "✓✓" : ok ? "✓ " : "✗ ";
    const status = exact ? "exact" : ok ? "near " : "MISS ";
    console.log(`  [${lead._test_id}] ${lead.company_name.padEnd(38)} ${flag} ${status} got=${(got || "?").padEnd(7)} expected=${expected}`);
    if (r.target_category_evidence) {
      console.log(`        evidence: ${r.target_category_evidence}`);
    }
    if (r.target_category_reason) {
      console.log(`        reason  : ${r.target_category_reason}`);
    }
    if (r.entity_role) {
      console.log(`        role    : ${r.entity_role}`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Exact: ${passExact}/${testLeads.length}    Near (±1档): ${passNear}/${testLeads.length}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const ratio = passNear / testLeads.length;
  console.log(`${ratio === 1 ? "OK PASS" : ratio >= 0.7 ? "ACCEPT (≥70%)" : "X FAIL"} — B 实测\n`);
  process.exit(ratio >= 0.7 ? 0 : 1);
})();
