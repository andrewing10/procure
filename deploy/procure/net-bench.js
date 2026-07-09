#!/usr/bin/env node
/**
 * 本机 vs 外网依赖延迟诊断（对比 Render 慢时用）
 *
 * 用法（仓库根目录）:
 *   node deploy/procure/net-bench.js
 *   node deploy/procure/net-bench.js --proxy-only
 *   node deploy/procure/net-bench.js --no-proxy-fetch
 *
 * 测什么:
 *   A. 直连关键 API（Gemini / Serper / Supabase / Anthropic / OpenAI）
 *   B. BrightData 代理连通 + 经代理抓页
 *   C. 同站直连 vs 代理对比（Step3 慢通常出在 C）
 *
 * 解读:
 *   - A 都 <500ms、C 代理 >> 直连 → 瓶颈是 BrightData，不是机器内存
 *   - A 里 Gemini/Serper 就很慢 → 本机出口到这些云服务路径差
 *   - 代理 CONNECT 失败 → BRD_USER/PASS/端口问题
 */
'use strict';

require('../../load-env');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { performance } = require('perf_hooks');

const args = new Set(process.argv.slice(2));
const PROXY_ONLY = args.has('--proxy-only');
const NO_PROXY_FETCH = args.has('--no-proxy-fetch');

const BRD_PROXY = process.env.BRD_PROXY || 'http://brd.superproxy.io:33335';
const BRD_USER = (process.env.BRD_USER || '').trim();
const BRD_PASS = (process.env.BRD_PASS || '').trim();
const USE_PROXY = String(process.env.USE_PROXY || '').toLowerCase() === 'true';

function ms(n) {
  return `${Math.round(n)}ms`;
}

function requestOnce(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      resolve({ ok: false, status: 0, ms: 0, error: e.message });
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 500,
            status: res.statusCode,
            ms: performance.now() - t0,
            error: null,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, ms: performance.now() - t0, error: 'timeout' });
    });
    req.on('error', (e) => {
      resolve({ ok: false, status: 0, ms: performance.now() - t0, error: e.message });
    });
    if (body) req.write(body);
    req.end();
  });
}

function proxyFetch(targetUrl, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    if (!BRD_USER || !BRD_PASS) {
      resolve({ ok: false, status: 0, ms: 0, error: 'BRD_USER/BRD_PASS missing' });
      return;
    }
    const t0 = performance.now();
    let proxy;
    let target;
    try {
      proxy = new URL(BRD_PROXY);
      target = new URL(targetUrl);
    } catch (e) {
      resolve({ ok: false, status: 0, ms: 0, error: e.message });
      return;
    }
    const auth = Buffer.from(`${BRD_USER}:${BRD_PASS}`).toString('base64');
    const connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: {
        Host: `${target.hostname}:443`,
        'Proxy-Authorization': `Basic ${auth}`,
      },
      timeout: timeoutMs,
    });

    connectReq.on('connect', (res, socket) => {
      const connectMs = performance.now() - t0;
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({
          ok: false,
          status: res.statusCode,
          ms: connectMs,
          connectMs,
          error: `CONNECT ${res.statusCode}`,
        });
        return;
      }
      const tlsReq = https.request(
        {
          host: target.hostname,
          path: target.pathname + target.search,
          method: 'GET',
          socket,
          agent: false,
          headers: {
            Host: target.hostname,
            'User-Agent': 'procure-net-bench/1.0',
            Accept: 'text/html,*/*',
          },
          timeout: timeoutMs,
        },
        (tres) => {
          tres.resume();
          tres.on('end', () => {
            resolve({
              ok: tres.statusCode >= 200 && tres.statusCode < 500,
              status: tres.statusCode,
              ms: performance.now() - t0,
              connectMs,
              error: null,
            });
          });
        },
      );
      tlsReq.on('timeout', () => {
        tlsReq.destroy();
        resolve({
          ok: false,
          status: 0,
          ms: performance.now() - t0,
          connectMs,
          error: 'tls_timeout',
        });
      });
      tlsReq.on('error', (e) => {
        resolve({
          ok: false,
          status: 0,
          ms: performance.now() - t0,
          connectMs,
          error: e.message,
        });
      });
      tlsReq.end();
    });

    connectReq.on('timeout', () => {
      connectReq.destroy();
      resolve({ ok: false, status: 0, ms: performance.now() - t0, error: 'connect_timeout' });
    });
    connectReq.on('error', (e) => {
      resolve({ ok: false, status: 0, ms: performance.now() - t0, error: e.message });
    });
    connectReq.end();
  });
}

function row(name, r, extra = '') {
  const status = r.error ? `ERR(${r.error})` : `HTTP ${r.status}`;
  const flag = !r.ok ? ' SLOW/FAIL' : r.ms > 2000 ? ' SLOW' : r.ms > 800 ? ' meh' : ' ok';
  console.log(`  ${name.padEnd(28)} ${ms(r.ms).padStart(8)}  ${status}${extra}${flag}`);
}

async function benchDirectApis() {
  console.log('\n=== A. 直连 API（不经 BrightData）===');
  const geminiKey = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY || '';
  const serper = process.env.SERPER_API_KEY || '';
  const supabase = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anthropic = process.env.ANTHROPIC_API_KEY || '';
  const openai = process.env.OPENAI_API_KEY || '';

  if (geminiKey) {
    const r = await requestOnce(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiKey)}`,
      { timeoutMs: 20000 },
    );
    row('Gemini models list', r);
  } else {
    console.log('  Gemini                      SKIP (no GEMINI_KEY)');
  }

  if (serper) {
    const body = JSON.stringify({ q: 'singapore rice importer', num: 3 });
    const r = await requestOnce('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': serper,
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      timeoutMs: 20000,
    });
    row('Serper search', r);
  } else {
    console.log('  Serper                      SKIP');
  }

  if (supabase) {
    const r = await requestOnce(`${supabase}/rest/v1/`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || ''}`,
      },
      timeoutMs: 15000,
    });
    row('Supabase REST', r);
  }

  // TCP/TLS 握手级探测（不要求有效 key 也能看 RTT）
  row('Anthropic TLS', await requestOnce('https://api.anthropic.com/', { timeoutMs: 10000 }));
  row('OpenAI TLS', await requestOnce('https://api.openai.com/', { timeoutMs: 10000 }));
  if (!anthropic) console.log('    (ANTHROPIC_API_KEY 未设 — 上面只测连通)');
  if (!openai) console.log('    (OPENAI_API_KEY 未设 — 上面只测连通)');
}

async function benchProxy() {
  console.log('\n=== B. BrightData 代理 ===');
  console.log(`  USE_PROXY=${USE_PROXY}  BRD_PROXY=${BRD_PROXY}`);
  console.log(`  BRD_USER=${BRD_USER ? BRD_USER.slice(0, 8) + '…' : '(empty)'}  PASS=${BRD_PASS ? 'set' : 'MISSING'}`);

  const proxyHost = new URL(BRD_PROXY);
  const t0 = performance.now();
  const tcp = await new Promise((resolve) => {
    const s = require('net').connect(
      { host: proxyHost.hostname, port: Number(proxyHost.port || 80) },
      () => {
        const d = performance.now() - t0;
        s.end();
        resolve({ ok: true, ms: d, error: null });
      },
    );
    s.setTimeout(8000, () => {
      s.destroy();
      resolve({ ok: false, ms: performance.now() - t0, error: 'tcp_timeout' });
    });
    s.on('error', (e) => resolve({ ok: false, ms: performance.now() - t0, error: e.message }));
  });
  row('Proxy TCP connect', tcp);

  if (!BRD_USER || !BRD_PASS) {
    console.log('  SKIP proxy fetch — 填 BRD_USER/BRD_PASS 后再测');
    return;
  }

  const r = await proxyFetch('https://httpbin.org/ip', { timeoutMs: 25000 });
  row(
    'Proxy → httpbin/ip',
    r,
    r.connectMs != null ? `  (CONNECT ${ms(r.connectMs)})` : '',
  );
}

async function benchDirectVsProxy() {
  console.log('\n=== C. 同站：直连 vs 经代理（Step3 关键）===');
  const sites = [
    'https://www.google.com/generate_204',
    'https://www.makoto-ya.com.sg/',
    'https://www.jetro.go.jp/',
    'https://httpbin.org/delay/1',
  ];

  for (const site of sites) {
    console.log(`\n  target: ${site}`);
    const direct = await requestOnce(site, {
      headers: { 'User-Agent': 'procure-net-bench/1.0' },
      timeoutMs: 20000,
    });
    row('  direct', direct);

    if (!NO_PROXY_FETCH && BRD_USER && BRD_PASS) {
      const via = await proxyFetch(site, { timeoutMs: 30000 });
      row(
        '  via BrightData',
        via,
        via.connectMs != null ? `  (CONNECT ${ms(via.connectMs)})` : '',
      );
      if (direct.ok && via.ok) {
        const ratio = via.ms / Math.max(direct.ms, 1);
        console.log(
          `  → 代理/直连 = ${ratio.toFixed(1)}x` +
            (ratio > 3 ? '  ← 代理明显拖慢 Step3' : ratio > 1.5 ? '  ← 代理有开销' : '  ← 接近'),
        );
      }
    }
  }
}

async function main() {
  console.log('procure net-bench');
  console.log(`host time: ${new Date().toISOString()}`);
  console.log(`node: ${process.version}`);

  if (!PROXY_ONLY) await benchDirectApis();
  await benchProxy();
  if (!PROXY_ONLY) await benchDirectVsProxy();

  console.log('\n=== 结论怎么读 ===');
  console.log('1) A 全 ok 且 <800ms，C 里 via BrightData 是 direct 的 5–20x → 慢在代理，可试 USE_PROXY=false（SG 本机出口）');
  console.log('2) A 里 Gemini/Serper 就 >2s → 本机到云 API 路径差，和内存无关');
  console.log('3) B CONNECT 失败 → 检查 BRD_USER/PASS/端口（Render 同款凭证）');
  console.log('4) 对比：在仍开着的 Render shell 里跑同一脚本，看数字差多少');
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
