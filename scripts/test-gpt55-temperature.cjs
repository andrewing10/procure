#!/usr/bin/env node
require("../load-env");
const https = require("https");

const KEY = process.env.OPENAI_API_KEY;

async function probe(label, body) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          const elapsed = Date.now() - t0;
          if (res.statusCode === 200) {
            const j = JSON.parse(body);
            console.log(`[OK ] ${label} ${elapsed}ms -> "${(j.choices?.[0]?.message?.content || "").slice(0, 30)}"`);
          } else {
            const reason = (body.match(/"message":\s*"([^"]+)"/) || [, body])[1];
            console.log(`[X  ] ${label} ${res.statusCode} ${reason.slice(0, 130)}`);
          }
          resolve();
        });
      }
    );
    req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  console.log("\n=== gpt-5.5 temperature parameter probe ===\n");

  for (const m of ["gpt-5.5", "gpt-5.4", "gpt-5"]) {
    await probe(`${m} max_completion_tokens=8 + temp=0.1`, {
      model: m,
      max_completion_tokens: 8,
      temperature: 0.1,
      messages: [{ role: "user", content: "ok" }],
    });
    await probe(`${m} max_completion_tokens=8 + temp=0.2`, {
      model: m,
      max_completion_tokens: 8,
      temperature: 0.2,
      messages: [{ role: "user", content: "ok" }],
    });
    await probe(`${m} max_completion_tokens=8 + temp=1  `, {
      model: m,
      max_completion_tokens: 8,
      temperature: 1,
      messages: [{ role: "user", content: "ok" }],
    });
    await probe(`${m} max_completion_tokens=8 + NO temp`, {
      model: m,
      max_completion_tokens: 8,
      messages: [{ role: "user", content: "ok" }],
    });
    console.log("");
  }
})();
