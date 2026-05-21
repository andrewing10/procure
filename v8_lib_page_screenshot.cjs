/**
 * v8_lib_page_screenshot.cjs — procure 仓视觉抽取截图能力（CJS）
 *
 * 镜像 zhimao 仓 `apps/web/lib/skills/pageScreenshot.ts`，给 v8_lib_contact_enricher.js
 * 的第 ⑤ 层 LLM 视觉抽取兜底使用：当静态 + 文本 LLM 全部空时，对目标域名首页跑截图
 * 喂给 Gemini Vision，认 contact 卡片 / 客服弹窗 / 二维码下方说明这种纯视觉布局。
 *
 * 设计原则（与 zhimao 一致）：
 *   - 多 provider HTTP REST fallback（不引 puppeteer/playwright，让 Render worker 冷启动稳）
 *   - capability_missing 时静默返回 null，由调用方决定是否标 skip
 *   - 30s 严格超时（视觉链路本身耗时高，截图不能再拖）
 *   - 默认 viewport 1280×800、单屏（不全页）、JPEG q=70（视觉识别足够）
 *
 * Provider 优先级：
 *   1. ScreenshotOne (SCREENSHOTONE_API_KEY) — 免费 100 次/月，简单 GET API
 *   2. Browserless (BROWSERLESS_API_TOKEN) — 付费按次，质量稳
 *
 * ⚠️ 修改后必须**同步**修改 zhimao 仓 `apps/web/lib/skills/pageScreenshot.ts`，
 * 否则 worker 这边的视觉兜底与用户解锁的视觉兜底会出现规则漂移。
 */

'use strict';

const fetch = require('node-fetch');

const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;
const DEFAULT_TIMEOUT_MS = 25_000;

// 单次截图最大字节数 — 控制喂给 vision LLM 的 base64 token 数。
// 4MB 是 Gemini multimodal 输入上限的安全阈值。
const MAX_BYTES = 4 * 1024 * 1024;

// ─── Provider 1: ScreenshotOne (https://screenshotone.com) ───────────────
const ScreenshotOneProvider = {
  name: 'screenshotone',
  isAvailable() {
    return !!String(process.env.SCREENSHOTONE_API_KEY || '').trim();
  },
  async capture(url, { timeoutMs }) {
    const key = String(process.env.SCREENSHOTONE_API_KEY).trim();
    // 关键参数（控本 + 反爬 + 命中率）：
    //   block_ads / block_chats → 屏蔽弹窗，避免遮挡 contact 区
    //   full_page=false → 单屏，4-5x 压缩 base64 体积
    //   cache=true & cache_ttl=86400 → 同 URL 24h 内不重复扣 quota
    //   timeout 服务端，与本地 timeoutMs 双保险
    const params = new URLSearchParams({
      access_key: key,
      url,
      full_page: 'false',
      format: 'jpg',
      image_quality: '70',
      block_ads: 'true',
      block_cookie_banners: 'true',
      block_chats: 'true',
      cache: 'true',
      cache_ttl: '86400',
      viewport_width: String(VIEWPORT_W),
      viewport_height: String(VIEWPORT_H),
      timeout: String(Math.floor(timeoutMs / 1000)),
    });
    const apiUrl = `https://api.screenshotone.com/take?${params.toString()}`;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(apiUrl, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
      return {
        base64: buf.toString('base64'),
        mime: res.headers.get('content-type') || 'image/jpeg',
        provider: 'screenshotone',
        bytes: buf.byteLength,
      };
    } catch {
      clearTimeout(tid);
      return null;
    }
  },
};

// ─── Provider 2: Browserless (https://browserless.io) ────────────────────
const BrowserlessProvider = {
  name: 'browserless',
  isAvailable() {
    return !!String(process.env.BROWSERLESS_API_TOKEN || '').trim();
  },
  async capture(url, { timeoutMs }) {
    const token = String(process.env.BROWSERLESS_API_TOKEN).trim();
    const apiUrl = `https://chrome.browserless.io/screenshot?token=${encodeURIComponent(token)}`;
    const body = {
      url,
      options: {
        type: 'jpeg',
        quality: 70,
        fullPage: false,
        omitBackground: false,
      },
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 },
      gotoOptions: { waitUntil: 'networkidle2', timeout: Math.max(15_000, timeoutMs - 5_000) },
    };
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      clearTimeout(tid);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
      return {
        base64: buf.toString('base64'),
        mime: res.headers.get('content-type') || 'image/jpeg',
        provider: 'browserless',
        bytes: buf.byteLength,
      };
    } catch {
      clearTimeout(tid);
      return null;
    }
  },
};

const PROVIDERS = [ScreenshotOneProvider, BrowserlessProvider];

function isAnyScreenshotProviderAvailable() {
  return PROVIDERS.some((p) => p.isAvailable());
}

function listAvailableScreenshotProviders() {
  return PROVIDERS.filter((p) => p.isAvailable()).map((p) => p.name);
}

/**
 * 按 provider 优先级跑 capture，第一个返回非 null 即用。
 * 全部失败 / capability_missing 时返回 null。
 */
async function capturePageScreenshot(url, opts = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  for (const provider of PROVIDERS) {
    if (!provider.isAvailable()) continue;
    try {
      const r = await provider.capture(url, { timeoutMs });
      if (r) return r;
    } catch {
      /* swallow per-provider err */
    }
  }
  return null;
}

module.exports = {
  capturePageScreenshot,
  isAnyScreenshotProviderAvailable,
  listAvailableScreenshotProviders,
};
