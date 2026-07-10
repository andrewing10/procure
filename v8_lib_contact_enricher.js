/**
 * v8_lib_contact_enricher.js — 联系方式抓取 6 层管道（procure 仓 CJS 版）
 *
 * 镜像 zhimao 仓 `apps/web/lib/skills/{htmlFetcher,contactExtractor,contactLlmExtract,pageScreenshot}.ts`
 * 四个 lib 的核心逻辑，用于把 v8 step3 enrich 的命中率从 ~20% 拉到 ~85%+。
 *
 * 6 层链路（按顺序，命中即返回，全空才下沉；2026-05-21 ADV-2 加 ⑤ 视觉抽取）：
 *   ① 直连 fetch（Chrome UA + 8s）           — 抽 mailto:/tel:/wa.me + 反混淆 + 不带+本地号
 *   ② Bright Data 代理重试                   — 403/429/5xx/超时时启用（USE_PROXY=true）
 *   ③ BFS 1 层 contact 子页                  — 从 <a href> 发现 contact 内链 + 12 条常见路径兜底
 *   ④ Gemini Flash 文本视觉抽取（visible_text）— 静态全空时调用，认 "采购经理 + 邮箱" 语义
 *   ⑤ Gemini Vision 截图抽取（PROD-3 / ADV-2）— SCREENSHOTONE_API_KEY 截图 → multimodal 抽 contact
 *   ⑥ Serper site:domain 搜索兜底            — 必须 @domain 同域邮箱才纳入（防第三方污染）
 *
 * 设计原则：
 *   - 失败安静返回 { emails: [], phones: [], whatsapps: [] }，不抛 step3 主流程
 *   - 单 URL 最长 8s，每层有自己的超时；6 层总 budget ~60s（per company）
 *   - LLM/Vision/Serper 仅在前几层全空时才调用，控本（命中率高的公司根本走不到 ④⑤⑥）
 *   - ⑤ Vision 层 capability_missing（无 SCREENSHOTONE_API_KEY）时静默 skip，不影响主流程
 *
 * ⚠️ 修改后必须**同步**修改 zhimao 仓 `apps/web/lib/skills/*.ts`，否则 zhimao 这边的
 * "手工解锁补全" 与 worker 入库前的 enrich 会出现规则漂移，再次出现 "明明 footer 有却抓不到"。
 */

'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');

// 2026-05-23 双仓镜像：B2B 买家邮箱质量裁判（NON_BUYER_HOSTS / placeholder / brand-match）
//   见 AGENTS.md "NON_BUYER_EMAIL_HOSTS 双仓镜像" + zhimao apps/web/lib/skills/emailQuality.ts
const { filterBuyerEmails, isBuyerEmail } = require('./v8_lib_email_quality');
// 开放渠道探测（双仓镜像 apps/web/lib/skills/channelSpec.ts）：email/phone/whatsapp 之外的渠道
const { detectChannels, classifyUrl } = require('./v8_lib_channel_spec');

// email/phone/whatsapp 的 source → 渠道置信度。
const CONTACT_SOURCE_CONFIDENCE = {
  mailto_link: 0.95,
  tel_link: 0.95,
  whatsapp_link: 0.9,
  plain_regex: 0.5,
  deobfuscated: 0.55,
};

// ─── 常量 ───────────────────────────────────────────────────────────────
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': CHROME_UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

const COMMON_CONTACT_PATHS = [
  '/contact',
  '/contact/',
  '/contact-us',
  '/contact-us/',
  '/contact.html',
  '/about',
  '/about-us',
  '/get-in-touch',
  '/reach-us',
  '/inquiry',
  '/zh/contact',
  '/en/contact',
];

const EMAIL_BLOCKLIST = [
  'example',
  'yourdomain',
  '@domain.',
  '@email.',
  'noreply',
  'no-reply',
  'donotreply',
  'sentry.io',
  'wixpress.com',
];

const FREE_EMAIL_HINT = new Set([
  'gmail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'outlook.com',
  'qq.com',
  '163.com',
]);

// ─── 工具：代理 agent 构造（一次性，复用） ──────────────────────────────
let _proxyAgent = null;
function getProxyAgent() {
  if (_proxyAgent !== null) return _proxyAgent; // 包含 false 表示已查过且无配置
  const useProxy = String(process.env.USE_PROXY || '').toLowerCase() === 'true';
  if (!useProxy) {
    _proxyAgent = false;
    return false;
  }
  const user = (process.env.BRD_USER || '').trim();
  const pass = (process.env.BRD_PASS || '').trim();
  const proxy = (process.env.BRD_PROXY || '').trim();
  if (!user || !pass || !proxy) {
    _proxyAgent = false;
    return false;
  }
  try {
    const url = proxy.includes('://') ? proxy : `http://${proxy}`;
    const u = new URL(url);
    const proxyUrl = `${u.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${u.host}`;
    _proxyAgent = new HttpsProxyAgent(proxyUrl);
    return _proxyAgent;
  } catch (e) {
    _proxyAgent = false;
    return false;
  }
}

// ─── ① + ②：fetchHtml（直连 + 代理 fallback） ─────────────────────────────
async function fetchHtmlOnce(url, opts) {
  const { timeoutMs, agent } = opts;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
      ...(agent ? { agent } : {}),
    });
    clearTimeout(tid);
    const html = await res.text();
    return { status: res.status, html, finalUrl: res.url || url };
  } catch (e) {
    clearTimeout(tid);
    const aborted = e && (e.name === 'AbortError' || e.type === 'aborted');
    return { status: 0, html: '', finalUrl: url, reason: aborted ? 'timeout' : 'network' };
  }
}

function isBlocked(status) {
  return status === 403 || status === 429 || status === 451;
}

function isRetriable(status, reason) {
  return isBlocked(status) || (status >= 500 && status < 600) || reason === 'timeout' || reason === 'network';
}

/**
 * 直连 + 代理 fallback；返回 { ok, html, status, via, finalUrl }
 */
async function fetchHtml(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 8000;
  const allowProxy = opts.allowProxy !== false;

  // 直连
  const direct = await fetchHtmlOnce(url, { timeoutMs });
  if (direct.status >= 200 && direct.status < 300 && direct.html.length > 0) {
    return { ok: true, html: direct.html, status: direct.status, via: 'direct', finalUrl: direct.finalUrl };
  }

  // 代理 fallback
  if (allowProxy && isRetriable(direct.status, direct.reason)) {
    const agent = getProxyAgent();
    if (agent) {
      const proxied = await fetchHtmlOnce(url, { timeoutMs: timeoutMs + 2000, agent });
      if (proxied.status >= 200 && proxied.status < 300 && proxied.html.length > 0) {
        return { ok: true, html: proxied.html, status: proxied.status, via: 'proxy', finalUrl: proxied.finalUrl };
      }
      return { ok: false, html: '', status: proxied.status, via: 'blocked', finalUrl: proxied.finalUrl };
    }
  }

  return { ok: false, html: '', status: direct.status, via: direct.status === 0 ? 'blocked' : 'direct', finalUrl: direct.finalUrl };
}

// ─── 联系方式抽取（升级版，cheerio + 反混淆 + 不带+本地号） ──────────────
function isLikelyValidEmail(e) {
  const low = (e || '').toLowerCase();
  if (!low || low.length > 80) return false;
  if (EMAIL_BLOCKLIST.some((b) => low.includes(b))) return false;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff2?)$/i.test(low)) return false;
  return true;
}

function normalizePhone(raw) {
  if (!raw) return '';
  const cleaned = String(raw).replace(/[\s\-().]/g, '').trim();
  return cleaned.replace(/^[^\d+]+|[^\d]+$/g, '');
}

function isLikelyValidPhone(p) {
  if (!p) return false;
  const n = String(p).replace(/\D/g, '');
  if (n.length < 7 || n.length > 15) return false;
  if (/^(\d)\1{6,}$/.test(n)) return false;
  return true;
}

/**
 * 反混淆邮箱：[at] / (at) / [dot] / <span>name</span>@<span>domain</span> 等
 * 把混淆变体先还原为标准格式，再走 plain 正则。
 */
function deobfuscateEmails(html) {
  let s = String(html || '');
  s = s.replace(/<\/?(?:span|wbr|em|b|strong|i)[^>]*>/gi, '');
  s = s.replace(/\s*[\[({{]\s*(?:at|@)\s*[\])}}]\s*/gi, '@');
  s = s.replace(/\s*[\[({{]\s*dot\s*[\])}}]\s*/gi, '.');
  s = s.replace(/\s*艾特\s*/g, '@').replace(/\s*点\s*/g, '.');
  return extractPlainEmails(s);
}

function extractPlainEmails(text) {
  const out = new Set();
  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[0].toLowerCase());
  return [...out];
}

function extractPlainPhones(text) {
  const out = new Set();
  // 国际带 +
  const intlRe = /\+\d[\d\s\-().]{6,18}\d/g;
  let m;
  while ((m = intlRe.exec(text)) !== null) {
    const n = normalizePhone(m[0]);
    if (isLikelyValidPhone(n)) out.add(n);
  }
  // 本地：0 开头 + 2-4 位区号 + 7-9 位号码（马来/泰国/印尼/中国本地号）
  const localRe = /\(?\b0\d{1,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,5}\b/g;
  while ((m = localRe.exec(text)) !== null) {
    const n = normalizePhone(m[0]);
    if (isLikelyValidPhone(n) && !out.has(n) && !out.has(`+${n.slice(1)}`)) {
      out.add(n);
    }
  }
  return [...out];
}

/**
 * 升级版 HTML 抽取（替代 step3 旧 extractFromHTML，cheerio + DOM 优先 + 反混淆 + contact 内链发现）
 * @returns { emails: string[], phones: string[], whatsapps: string[], contactLinks: string[] }
 */
function extractContactsFromHtmlV2(html, baseUrl) {
  const out = { emails: [], phones: [], whatsapps: [], contactLinks: [] };
  if (!html || html.length < 30) return out;

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return out;
  }

  const emailMap = new Map(); // value -> { value, source }
  const phoneMap = new Map();
  const whatsappMap = new Map();

  // ── mailto: 显式链接（最高可信） ────────────────────────────────────
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const em = href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (em.includes('@') && isLikelyValidEmail(em) && !emailMap.has(em)) {
      emailMap.set(em, { value: em, source: 'mailto_link' });
    }
  });

  // ── tel: 显式链接 ──────────────────────────────────────────────────
  $('a[href^="tel:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const p = normalizePhone(href.replace(/^tel:/i, ''));
    if (isLikelyValidPhone(p) && !phoneMap.has(p)) {
      phoneMap.set(p, { value: p, source: 'tel_link' });
    }
  });

  // ── wa.me / api.whatsapp.com 链接 ──────────────────────────────────
  const waRe = /https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send)\/?\?*(?:phone=)?(\+?\d[\d\s\-]{6,15})/gi;
  let waMatch;
  while ((waMatch = waRe.exec(html)) !== null) {
    const w = normalizePhone(waMatch[1]);
    if (isLikelyValidPhone(w) && !whatsappMap.has(w)) {
      whatsappMap.set(w, { value: w, source: 'whatsapp_link' });
    }
  }

  // ── 反混淆 + 纯文本正则（兜底） ────────────────────────────────────
  for (const e of deobfuscateEmails(html)) {
    if (isLikelyValidEmail(e) && !emailMap.has(e)) {
      emailMap.set(e, { value: e, source: 'deobfuscated' });
    }
  }
  for (const e of extractPlainEmails(html)) {
    if (isLikelyValidEmail(e) && !emailMap.has(e)) {
      emailMap.set(e, { value: e, source: 'plain_regex' });
    }
  }
  const bodyText = $('body').text();
  for (const p of extractPlainPhones(bodyText)) {
    if (isLikelyValidPhone(p) && !phoneMap.has(p)) {
      phoneMap.set(p, { value: p, source: 'plain_regex' });
    }
  }

  // ── contact 内链发现（用于 BFS 1 层） ────────────────────────────────
  const keywordRe =
    /(contact|get[\s\-]?in[\s\-]?touch|reach[\s\-]?us|inquiry|enquiry|联系|联络|聯絡|お問い合わせ|문의|kontakt|contacto|contato)/i;
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    base = null;
  }
  const linkSet = new Set();
  if (base) {
    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      const linkText = $(el).text().trim();
      if (!keywordRe.test(href) && !keywordRe.test(linkText)) return;
      try {
        const abs = new URL(href, base).toString();
        if (new URL(abs).hostname !== base.hostname) return;
        const clean = abs.split('#')[0];
        linkSet.add(clean);
      } catch {
        /* ignore bad href */
      }
    });
  }

  // 排序：mailto > deobf > plain；自由邮箱排后面
  const SOURCE_PRIORITY = { mailto_link: 100, tel_link: 100, whatsapp_link: 90, plain_regex: 50, deobfuscated: 30 };
  out.emails = [...emailMap.values()]
    .sort((a, b) => {
      const aFree = FREE_EMAIL_HINT.has((a.value.split('@')[1] || '').toLowerCase()) ? 1 : 0;
      const bFree = FREE_EMAIL_HINT.has((b.value.split('@')[1] || '').toLowerCase()) ? 1 : 0;
      if (aFree !== bFree) return aFree - bFree;
      return SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
    })
    .slice(0, 8)
    .map((x) => x.value);
  out.phones = [...phoneMap.values()]
    .sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source])
    .slice(0, 8)
    .map((x) => x.value);
  out.whatsapps = [...whatsappMap.values()].slice(0, 8).map((x) => x.value);
  out.contactLinks = [...linkSet].slice(0, 6);

  // ── 开放渠道集合（不写死字段）：email/phone/whatsapp 映射 + detectChannels + 联系表单 ──
  const channelSeen = new Set();
  const channels = [];
  const pushChannel = (c) => {
    const key = `${c.type}::${String(c.value).toLowerCase()}`;
    if (channelSeen.has(key)) return;
    channelSeen.add(key);
    channels.push(c);
  };
  for (const e of emailMap.values()) pushChannel({ type: 'email', value: e.value, source: e.source === 'mailto_link' ? 'href' : 'regex', confidence: CONTACT_SOURCE_CONFIDENCE[e.source] || 0.5 });
  for (const p of phoneMap.values()) pushChannel({ type: 'phone', value: p.value, source: p.source === 'tel_link' ? 'href' : 'regex', confidence: CONTACT_SOURCE_CONFIDENCE[p.source] || 0.5 });
  for (const w of whatsappMap.values()) pushChannel({ type: 'whatsapp', value: w.value, source: 'href', confidence: CONTACT_SOURCE_CONFIDENCE[w.source] || 0.9 });
  for (const c of detectChannels(html, baseUrl, 4)) pushChannel(c);
  for (const link of out.contactLinks.slice(0, 4)) pushChannel({ type: 'contact_form', value: link, source: 'href', confidence: 0.5 });
  out.channels = channels;

  return out;
}

// ─── ③：BFS 1 层 contact 子页 + 常见路径兜底 ─────────────────────────────
async function bfsContactPages(domain, discoveredLinks, accumulator, opts = {}) {
  const fallbackUrls = COMMON_CONTACT_PATHS.map((p) => `https://${domain}${p}`);
  const candidates = [...new Set([...(discoveredLinks || []), ...fallbackUrls])].slice(0, 6);

  for (const url of candidates) {
    // 早停：累计 ≥3 邮箱 + ≥1 电话即停（省时间）
    if (accumulator.emails.size >= 3 && accumulator.phones.size >= 1) break;
    const r = await fetchHtml(url, { timeoutMs: opts.timeoutMs || 7000 });
    if (!r.ok) continue;
    const got = extractContactsFromHtmlV2(r.html, r.finalUrl);
    for (const e of got.emails) accumulator.emails.add(e);
    for (const p of got.phones) accumulator.phones.add(p);
    for (const w of got.whatsapps) accumulator.whatsapps.add(w);
    if (accumulator.channels instanceof Map) {
      for (const c of got.channels || []) {
        const key = `${c.type}::${String(c.value).toLowerCase()}`;
        if (!accumulator.channels.has(key)) accumulator.channels.set(key, c);
      }
    }
  }
}

// ─── ④：Gemini Flash 视觉抽取（静态全空兜底） ────────────────────────────
function htmlToVisibleText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

async function llmExtractContactFromText(args) {
  const apiKey = (process.env.GEMINI_KEY || '').trim();
  if (!apiKey) return { ok: false, persons: [], reason: 'no_gemini_key' };

  const text = (args.visibleText || '').trim();
  if (!text || text.length < 80) return { ok: false, persons: [], reason: 'text_too_short' };

  const model = process.env.GEMINI_FAST_MODEL || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const prompt = `你是 B2B 跨境采购情报系统的联系人抽取助手。
给你一段公司官网的可见文本（visible text），请抽出"可直接用于采购对接"的联系方式。

抽取规则：
1. 优先角色明确的联系人：采购经理 / Purchasing Manager / Supply Chain Manager / Sourcing Director / Sales Manager / 销售经理；
2. 邮箱要求：必须是公司自己域名（非 gmail/yahoo/hotmail），优先 john.doe@... 类带姓名格式；
3. 电话：保留任意格式（+86-... / 03-7710 5555 / (021) 1234 5678 都可），输出原文；
4. 不要编造任何邮箱/电话/姓名 — 文本里没有就留 null；
5. 一次最多输出 5 个 person；
6. confidence: 角色+姓名+邮箱三者齐全=0.9；只有邮箱+角色=0.7；只有 info@ 通用邮=0.4。

严格输出 JSON：{ persons: [ { email, phone, whatsapp, name, role, confidence } ] }
没抽到任何 → 返回 { persons: [] }

company_name: ${args.companyName || 'unknown'}
domain: ${args.domain || 'unknown'}
visible_text:
${text.slice(0, 6000)}`;

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1200,
          responseMimeType: 'application/json',
        },
      }),
    });
    clearTimeout(tid);
    if (!res.ok) return { ok: false, persons: [], reason: `gemini_http_${res.status}` };
    const j = await res.json();
    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!raw) return { ok: false, persons: [], reason: 'gemini_empty_response' };
    let parsed;
    try {
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return { ok: false, persons: [], reason: 'llm_invalid_json' };
    }
    if (!parsed || !Array.isArray(parsed.persons)) {
      return { ok: false, persons: [], reason: 'no_persons_field' };
    }
    const persons = [];
    for (const p of parsed.persons.slice(0, 5)) {
      if (!p || typeof p !== 'object') continue;
      const email = typeof p.email === 'string' ? p.email.trim().toLowerCase() : null;
      const phone = typeof p.phone === 'string' ? p.phone.trim() : null;
      const whatsapp = typeof p.whatsapp === 'string' ? p.whatsapp.trim() : null;
      if (!email && !phone && !whatsapp) continue;
      persons.push({
        email,
        phone,
        whatsapp,
        name: typeof p.name === 'string' ? p.name.trim() : null,
        role: typeof p.role === 'string' ? p.role.trim() : null,
        confidence: typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
      });
    }
    return { ok: persons.length > 0, persons };
  } catch (e) {
    return { ok: false, persons: [], reason: 'gemini_exception' };
  }
}

// ─── ⑤：Gemini Vision 截图抽取兜底（ADV-2，2026-05-21 落地） ─────────────
/**
 * 给一张截图（base64 + mime）喂给 Gemini Vision，认 "采购经理 + 邮箱 + 二维码 + 客服小窗"
 * 这种纯视觉布局，把 contact 实体抽出来。
 *
 * 镜像 zhimao 仓 `apps/web/lib/skills/contactLlmExtract.ts` 的 llmExtractContactFromImage。
 * 接口与 llmExtractContactFromText 对齐，方便同一个 enrich 主链调用。
 */
async function llmExtractContactFromImage(args) {
  const apiKey = (process.env.GEMINI_KEY || '').trim();
  if (!apiKey) return { ok: false, persons: [], reason: 'no_gemini_key' };

  const { imageBase64, imageMime, companyName, domain } = args || {};
  if (!imageBase64 || !imageMime) {
    return { ok: false, persons: [], reason: 'no_image' };
  }
  if (typeof imageBase64 !== 'string' || imageBase64.length < 200) {
    return { ok: false, persons: [], reason: 'image_too_small' };
  }

  const model = process.env.GEMINI_FAST_MODEL || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const prompt = `You are a B2B contact extraction assistant for cross-border procurement.
Given a screenshot of a company website (homepage / contact / about page), extract structured CONTACT information.

What to extract from the IMAGE:
1. Person + role pairs (priority): "Purchasing Manager / Procurement Director / Sourcing Lead / Sales Manager + email/phone".
2. Department contacts: "sales@... / info@... / contact@..." (lower priority but still useful).
3. WhatsApp number (often shown as a green icon + number, or a QR code with caption).
4. Phone numbers (international with +, or local without + such as 03-7710 5555).
5. If a contact card / customer-service popup / QR-code caption is visible, prioritize text from there.

Rules:
- DO NOT fabricate any email/phone/name. Leave field as null if not visible in the image.
- Free-mail (gmail/yahoo/hotmail) is OK only if no business-domain email is visible.
- confidence: role+name+email all present = 0.9; email+role only = 0.7; generic info@ only = 0.4.
- Output up to 5 persons.

Strict JSON output:
{ persons: [ { email, phone, whatsapp, name, role, confidence } ] }
If nothing visible: { persons: [] }

company_name: ${companyName || 'unknown'}
domain: ${domain || 'unknown'}`;

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 22_000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: imageMime, data: imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1200,
          responseMimeType: 'application/json',
        },
      }),
    });
    clearTimeout(tid);
    if (!res.ok) return { ok: false, persons: [], reason: `gemini_vision_http_${res.status}` };
    const j = await res.json();
    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!raw) return { ok: false, persons: [], reason: 'gemini_vision_empty_response' };
    let parsed;
    try {
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return { ok: false, persons: [], reason: 'vision_invalid_json' };
    }
    if (!parsed || !Array.isArray(parsed.persons)) {
      return { ok: false, persons: [], reason: 'no_persons_field' };
    }
    const persons = [];
    for (const p of parsed.persons.slice(0, 5)) {
      if (!p || typeof p !== 'object') continue;
      const email = typeof p.email === 'string' ? p.email.trim().toLowerCase() : null;
      const phone = typeof p.phone === 'string' ? p.phone.trim() : null;
      const whatsapp = typeof p.whatsapp === 'string' ? p.whatsapp.trim() : null;
      if (!email && !phone && !whatsapp) continue;
      persons.push({
        email,
        phone,
        whatsapp,
        name: typeof p.name === 'string' ? p.name.trim() : null,
        role: typeof p.role === 'string' ? p.role.trim() : null,
        confidence: typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
      });
    }
    return { ok: persons.length > 0, persons };
  } catch {
    return { ok: false, persons: [], reason: 'gemini_vision_exception' };
  }
}

// ─── ⑥：Serper 同域邮箱搜索兜底 ──────────────────────────────────────────
async function serperFallbackForDomain(domain, companyName) {
  const apiKey = (process.env.SERPER_API_KEY || '').trim();
  if (!apiKey || !domain) return { emails: [], phones: [] };
  const queries = [
    companyName
      ? `"${companyName}" purchasing manager OR procurement OR sourcing email`
      : `site:${domain} email contact`,
    `"@${domain}" purchasing OR sales OR contact`,
  ];
  const allEmails = new Set();
  for (const q of queries) {
    if (allEmails.size >= 3) break;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 6000);
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ q, num: 6 }),
      });
      clearTimeout(tid);
      if (!r.ok) continue;
      const j = await r.json();
      const organic = Array.isArray(j.organic) ? j.organic : [];
      for (const hit of organic) {
        const blob = `${hit.title || ''} ${hit.snippet || ''}`;
        for (const e of extractPlainEmails(blob)) {
          const host = (e.split('@')[1] || '').toLowerCase();
          if (host === domain || host.endsWith(`.${domain}`)) {
            if (isLikelyValidEmail(e)) allEmails.add(e);
          }
        }
      }
    } catch {
      /* swallow */
    }
  }
  return { emails: [...allEmails], phones: [] };
}

// ─── B4 瀑布式可观测层（RC-4，2026-06-19，设计单源 §4A.1 / §B4）──────────────
// 现有管线已是「成本递增 + run-if-empty 短路」的瀑布（static→bfs→llm→vision→serper）。
// 这里补 per-source 命中率/成本计量 funnel + 缺 key 降级告警，让"信息薄/0 结果"可观测、可告警。
//
// 每层成本单位（相对）：免费抓取=0；文本 LLM=1；Serper=1；视觉截图+多模态=5（最贵）。
const WATERFALL_LAYER_COST = { home: 0, bfs: 0, llm_text: 1, vision: 5, serper: 1 };

// B6-route：单条成本预算上限（成本单位）。昂贵层（视觉=5）在累计成本将超预算时跳过，
// 控住「每条 lead 抓取成本」。默认已调为 2（业主授权直接落地）：批量 worker 默认砍掉视觉层
// （最贵+最慢，22s 截图超时，命中靠后），用静态/BFS/文本 LLM/Serper 换广度与吞吐。
//   · 静态(0)+BFS(0)+文本LLM(1)+Serper(1) 仍在预算内，正常运行；视觉(5)被预算闸门跳过。
//   · 需要为高价值小批量重新启用视觉：设 CONTACT_ENRICH_COST_BUDGET=7（容纳完整瀑布）。
const CONTACT_ENRICH_COST_BUDGET = Number(process.env.CONTACT_ENRICH_COST_BUDGET || 2);

// 进程级滚动聚合：worker 每批结束读 getEnricherWaterfallStats() 打点 / 告警。
const _waterfallAgg = {
  leads: 0,
  filled: 0,
  cost_units: 0,
  // 每层：attempted=进入该层的次数；hit=该层贡献了新联系方式的次数
  layers: {
    home:   { attempted: 0, hit: 0 },
    bfs:    { attempted: 0, hit: 0 },
    llm_text:{ attempted: 0, hit: 0 },
    vision: { attempted: 0, hit: 0 },
    serper: { attempted: 0, hit: 0 },
  },
  // 降级告警：某层因缺 key / capability 缺失而被迫跳过的次数
  degraded: { llm_text_no_key: 0, vision_no_capability: 0, serper_no_key: 0 },
};

function _recordLayer(result, layer, attempted, hitContacts, reason) {
  const cost = attempted ? (WATERFALL_LAYER_COST[layer] || 0) : 0;
  result.waterfall.push({ layer, attempted, hit: hitContacts > 0, contacts: hitContacts, cost, reason: reason || null });
  result._cost_units += cost;
  if (_waterfallAgg.layers[layer]) {
    if (attempted) _waterfallAgg.layers[layer].attempted += 1;
    if (hitContacts > 0) _waterfallAgg.layers[layer].hit += 1;
  }
}

/** worker 读取：每层 attempted/hit/命中率 + 总成本 + 降级计数；用于打点与「命中率塌陷」告警。 */
function getEnricherWaterfallStats() {
  const layers = {};
  for (const [k, v] of Object.entries(_waterfallAgg.layers)) {
    layers[k] = { ...v, hit_rate: v.attempted > 0 ? +(v.hit / v.attempted).toFixed(3) : null };
  }
  return {
    leads: _waterfallAgg.leads,
    filled: _waterfallAgg.filled,
    fill_rate: _waterfallAgg.leads > 0 ? +(_waterfallAgg.filled / _waterfallAgg.leads).toFixed(3) : null,
    cost_units: _waterfallAgg.cost_units,
    avg_cost_per_lead: _waterfallAgg.leads > 0 ? +(_waterfallAgg.cost_units / _waterfallAgg.leads).toFixed(2) : null,
    layers,
    degraded: { ..._waterfallAgg.degraded },
  };
}

/** 测试 / 批次边界用：清零进程级聚合。 */
function resetEnricherWaterfallStats() {
  _waterfallAgg.leads = 0;
  _waterfallAgg.filled = 0;
  _waterfallAgg.cost_units = 0;
  for (const k of Object.keys(_waterfallAgg.layers)) _waterfallAgg.layers[k] = { attempted: 0, hit: 0 };
  _waterfallAgg.degraded = { llm_text_no_key: 0, vision_no_capability: 0, serper_no_key: 0 };
}

// ─── B2：社媒主页深抽取（无官网域名的私域线索） ───────────────────────────
/** 一次最多抓取几个主页，控成本/时延。 */
const PROFILE_FETCH_CAP = Math.min(Math.max(Number(process.env.PROFILE_FETCH_CAP || 3), 1), 6);

/** 从 lead 收集候选社媒/主页 URL（去重、http(s)、截断）。 */
function collectProfileUrls(lead) {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    const s = String(u == null ? '' : u).trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s.slice(0, 500));
  };
  if (Array.isArray(lead.social_profile_urls)) for (const u of lead.social_profile_urls) push(u);
  push(lead.profile_url);
  push(lead.source_url);
  return out.slice(0, PROFILE_FETCH_CAP);
}

/**
 * 抓取若干社媒/主页，抽取 email/phone/whatsapp + 开放渠道并并入 accumulator。
 * 主页 URL 本身也会作为一条渠道（classifyUrl）；社媒主页里链出的官网会被识别为 website 渠道。
 */
async function enrichFromProfileUrls(profileUrls, lead, result, accumulator) {
  const addChannel = (c) => {
    if (!c || !c.type || !c.value) return;
    const key = `${c.type}::${String(c.value).toLowerCase()}`;
    if (!accumulator.channels.has(key)) accumulator.channels.set(key, c);
  };
  const before = accumulator.emails.size + accumulator.phones.size + accumulator.whatsapps.size;
  for (const url of profileUrls) {
    const selfChan = classifyUrl(url, null);
    if (selfChan) addChannel(selfChan);
    const res = await fetchHtml(url, { timeoutMs: 9000 });
    result.fetch_log.push({ url, status: res.status, via: res.via });
    if (!res.ok) {
      if (res.via === 'blocked') result.any_blocked = true;
      continue;
    }
    const got = extractContactsFromHtmlV2(res.html, res.finalUrl || url);
    for (const e of got.emails) accumulator.emails.add(e);
    for (const p of got.phones) accumulator.phones.add(p);
    for (const w of got.whatsapps) accumulator.whatsapps.add(w);
    for (const c of got.channels || []) addChannel(c);
  }
  const hit = accumulator.emails.size + accumulator.phones.size + accumulator.whatsapps.size - before;
  _recordLayer(result, 'profile', true, hit, null);
}

/**
 * 收口：邮箱质量门 + primary_* 回填 + 开放渠道集合最终对齐（与 email 质量门一致）。
 * 抽取自 enrichContactsForLead 尾段，供 domain 路径与 no-domain profile 路径共用。
 */
function finalizeEnrich(result, accumulator, host) {
  const addChannel = (c) => {
    if (!c || !c.type || !c.value) return;
    const key = `${c.type}::${String(c.value).toLowerCase()}`;
    if (!accumulator.channels.has(key)) accumulator.channels.set(key, c);
  };

  if (accumulator.emails.size > 0) {
    const verdict = filterBuyerEmails([...accumulator.emails], host);
    accumulator.emails = new Set(verdict.accepted);
    result.email_filter = {
      total_collected: verdict.accepted.length + verdict.rejected.length + verdict.warnings.length,
      accepted: verdict.accepted.length,
      warnings: verdict.warnings,
      rejected: verdict.rejected,
    };
    if (verdict.rejected.length > 0) {
      result.fetch_log.push({
        url: `email_quality_gate`,
        status: 200,
        via: 'filter',
        dropped: verdict.rejected.map((r) => `${r.email}=${r.reason}`),
      });
    }
  }

  if (!result.primary_email && accumulator.emails.size > 0) {
    result.primary_email = [...accumulator.emails][0];
  }
  if (result.primary_email) {
    const v = isBuyerEmail(result.primary_email, host);
    if (!v.ok) {
      result.fetch_log.push({
        url: `email_quality_gate`,
        status: 200,
        via: 'filter',
        cleared_primary: { email: result.primary_email, reason: v.reason },
      });
      result.primary_email = null;
    }
  }
  if (!result.primary_phone && accumulator.phones.size > 0) {
    result.primary_phone = [...accumulator.phones][0];
  }
  if (accumulator.whatsapps.size > 0) {
    result.primary_whatsapp = [...accumulator.whatsapps][0];
  }

  const keptEmails = new Set([...accumulator.emails].map((e) => String(e).toLowerCase()));
  for (const [key, c] of [...accumulator.channels.entries()]) {
    if (c.type === 'email' && !keptEmails.has(String(c.value).toLowerCase())) {
      accumulator.channels.delete(key);
    }
  }
  for (const e of accumulator.emails) addChannel({ type: 'email', value: e, source: 'regex', confidence: 0.6 });
  for (const p of accumulator.phones) addChannel({ type: 'phone', value: p, source: 'regex', confidence: 0.6 });
  for (const w of accumulator.whatsapps) addChannel({ type: 'whatsapp', value: w, source: 'href', confidence: 0.85 });
  result.channels = [...accumulator.channels.values()];

  result.filled = Boolean(result.primary_email || result.primary_phone || result.primary_whatsapp);
  _waterfallAgg.cost_units += result._cost_units;
  if (result.filled) _waterfallAgg.filled += 1;
  return result;
}

// ─── 主入口：enrichContactsForLead ───────────────────────────────────────
/**
 * 给一个 lead 做联系方式兜底补全。
 * 仅在 step3 主链（GMaps + Playwright）跑完仍然 primary_email/primary_phone 都空时调用。
 *
 * @param {{ domain?: string, company_name?: string, primary_email?: string|null, primary_phone?: string|null }} lead
 * @returns {Promise<{
 *   filled: boolean,
 *   primary_email: string|null,
 *   primary_phone: string|null,
 *   primary_whatsapp: string|null,
 *   via: 'home'|'bfs'|'llm'|'serper'|'none',
 *   fetch_log: Array,
 *   llm_persons: Array,
 *   any_blocked: boolean,
 * }>}
 */
async function enrichContactsForLead(lead) {
  const result = {
    filled: false,
    primary_email: lead.primary_email || null,
    primary_phone: lead.primary_phone || null,
    primary_whatsapp: null,
    via: 'none',
    fetch_log: [],
    llm_persons: [],
    // 开放渠道集合（不写死字段）：email/phone/whatsapp 之外的所有可达渠道
    channels: [],
    any_blocked: false,
    // B4 瀑布可观测：每层 attempted/hit/cost；_cost_units 累计本 lead 成本
    waterfall: [],
    _cost_units: 0,
  };
  _waterfallAgg.leads += 1;

  const accumulator = {
    emails: new Set(),
    phones: new Set(),
    whatsapps: new Set(),
    channels: new Map(), // key `${type}::${value}` -> {type,value,source,confidence}
  };
  const accSize = () => accumulator.emails.size + accumulator.phones.size + accumulator.whatsapps.size;
  const addChannel = (c) => {
    if (!c || !c.type || !c.value) return;
    const key = `${c.type}::${String(c.value).toLowerCase()}`;
    if (!accumulator.channels.has(key)) accumulator.channels.set(key, c);
  };

  const rawDomain = String(lead.domain || '').trim();
  if (!rawDomain) {
    // B2：无官网域名 → 若有社媒/主页 URL，走主页深抽取路径；否则 no_domain。
    const profileUrls = collectProfileUrls(lead);
    if (profileUrls.length === 0) {
      result.via = 'no_domain';
      return result;
    }
    await enrichFromProfileUrls(profileUrls, lead, result, accumulator);
    // host：优先用主页里链出的官网域名做邮箱品牌门，否则留空（质量门自动放宽）。
    let profHost = '';
    for (const c of accumulator.channels.values()) {
      if (c.type === 'website') {
        try { profHost = new URL(c.value).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
        break;
      }
    }
    if (result.via === 'none') result.via = 'profile';
    return finalizeEnrich(result, accumulator, profHost);
  }

  // 归一域名为 hostname（去掉 https:// / 路径 / www. 前缀均可）
  let host;
  try {
    host = new URL(rawDomain.includes('://') ? rawDomain : `https://${rawDomain}`).hostname;
  } catch {
    result.via = 'invalid_domain';
    return result;
  }
  if (!host) {
    result.via = 'invalid_domain';
    return result;
  }
  host = host.replace(/^www\./, '');

  // ── ① + ② 阶段：首页 ───────────────────────────────────────────────
  const homeUrl = `https://${host}/`;
  const homeRes = await fetchHtml(homeUrl, { timeoutMs: 8000 });
  result.fetch_log.push({ url: homeUrl, status: homeRes.status, via: homeRes.via });
  let discoveredLinks = [];
  let beforeHome = accSize();
  if (homeRes.ok) {
    const got = extractContactsFromHtmlV2(homeRes.html, homeRes.finalUrl);
    for (const e of got.emails) accumulator.emails.add(e);
    for (const p of got.phones) accumulator.phones.add(p);
    for (const w of got.whatsapps) accumulator.whatsapps.add(w);
    for (const c of got.channels || []) addChannel(c);
    discoveredLinks = got.contactLinks;
    if (accumulator.emails.size > 0 || accumulator.phones.size > 0) result.via = 'home';
  } else if (homeRes.via === 'blocked') {
    result.any_blocked = true;
  }
  _recordLayer(result, 'home', true, accSize() - beforeHome, homeRes.ok ? null : homeRes.via);

  // ── ③ 阶段：BFS contact 子页（即使首页已有也跑，能挖到更多角色邮箱） ─
  const beforeBfs = accSize();
  await bfsContactPages(host, discoveredLinks, accumulator, { timeoutMs: 7000 });
  _recordLayer(result, 'bfs', true, accSize() - beforeBfs, null);
  if (result.via === 'none' && (accumulator.emails.size > 0 || accumulator.phones.size > 0)) {
    result.via = 'bfs';
  }

  // ── ④ 阶段：LLM 兜底（仅静态全空时调用，控本） ────────────────────
  if (accumulator.emails.size === 0 && accumulator.phones.size === 0 && homeRes.ok) {
    const beforeLlm = accSize();
    const visibleText = htmlToVisibleText(homeRes.html);
    const llm = await llmExtractContactFromText({
      visibleText,
      companyName: lead.company_name || null,
      domain: host,
    });
    if (llm.ok) {
      result.llm_persons = llm.persons;
      for (const p of llm.persons) {
        if (p.email && isLikelyValidEmail(p.email)) accumulator.emails.add(p.email);
        if (p.phone) {
          const np = normalizePhone(p.phone);
          if (isLikelyValidPhone(np)) accumulator.phones.add(np);
        }
        if (p.whatsapp) {
          const nw = normalizePhone(p.whatsapp);
          if (isLikelyValidPhone(nw)) accumulator.whatsapps.add(nw);
        }
      }
      if (accumulator.emails.size > 0 || accumulator.phones.size > 0) result.via = 'llm';
    } else if (llm.reason === 'no_gemini_key') {
      // 降级告警：未配 Gemini key → 文本 LLM 层名存实亡，命中率会塌陷
      _waterfallAgg.degraded.llm_text_no_key += 1;
    }
    _recordLayer(result, 'llm_text', true, accSize() - beforeLlm, llm.ok ? null : (llm.reason || 'llm_miss'));
  }

  // ── ⑤ 阶段：Vision 截图抽取兜底（ADV-2，仅当文本 LLM 也空 + 截图能力可用） ─
  // capability_missing（无 SCREENSHOTONE_API_KEY）静默跳过，保留 ⑥ Serper 兜底机会
  if (accumulator.emails.size === 0 && accumulator.phones.size === 0) {
    const beforeVision = accSize();
    // B6-route 单条成本预算：视觉层最贵（5u），将超预算则跳过，避免单条 lead 成本失控。
    if (result._cost_units + WATERFALL_LAYER_COST.vision > CONTACT_ENRICH_COST_BUDGET) {
      result.fetch_log.push({ url: homeUrl, status: 0, via: 'vision_cost_budget_skip' });
      _recordLayer(result, 'vision', false, 0, 'cost_budget_exceeded');
    } else {
    let pageScreenshot;
    try {
      // 延迟 require，避免 Render worker 启动时 v8_lib_page_screenshot 找不到也阻塞主流程
      pageScreenshot = require('./v8_lib_page_screenshot.cjs');
    } catch {
      pageScreenshot = null;
    }
    if (pageScreenshot && pageScreenshot.isAnyScreenshotProviderAvailable()) {
      try {
        const shot = await pageScreenshot.capturePageScreenshot(homeUrl, { timeoutMs: 22_000 });
        if (shot) {
          const vis = await llmExtractContactFromImage({
            imageBase64: shot.base64,
            imageMime: shot.mime,
            companyName: lead.company_name || null,
            domain: host,
          });
          result.fetch_log.push({
            url: homeUrl,
            status: 200,
            via: `vision_${shot.provider}`,
            vision: { ok: vis.ok, persons: vis.persons.length, reason: vis.reason || null },
          });
          if (vis.ok && vis.persons.length > 0) {
            // 与 ④ 文本 LLM 合并到同一字段：result.llm_persons
            // 这样下游 step3 / 写库逻辑不需要区分文本 vs 视觉来源
            result.llm_persons = (result.llm_persons || []).concat(
              vis.persons.map((p) => ({ ...p, _via: 'vision' })),
            );
            for (const p of vis.persons) {
              if (p.email && isLikelyValidEmail(p.email)) accumulator.emails.add(p.email);
              if (p.phone) {
                const np = normalizePhone(p.phone);
                if (isLikelyValidPhone(np)) accumulator.phones.add(np);
              }
              if (p.whatsapp) {
                const nw = normalizePhone(p.whatsapp);
                if (isLikelyValidPhone(nw)) accumulator.whatsapps.add(nw);
              }
            }
            if (accumulator.emails.size > 0 || accumulator.phones.size > 0) {
              result.via = 'vision';
            }
          }
        } else {
          result.fetch_log.push({ url: homeUrl, status: 0, via: 'vision_screenshot_fail' });
        }
      } catch {
        result.fetch_log.push({ url: homeUrl, status: 0, via: 'vision_exception' });
      }
      _recordLayer(result, 'vision', true, accSize() - beforeVision, null);
    } else {
      result.fetch_log.push({ url: homeUrl, status: 0, via: 'vision_capability_missing' });
      _waterfallAgg.degraded.vision_no_capability += 1;
      _recordLayer(result, 'vision', false, 0, 'capability_missing');
    }
    } // end cost-budget else (B6-route)
  }

  // ── ⑥ 阶段：Serper 同域名邮箱搜索（仍然全空时的最后一搏） ──────────
  if (accumulator.emails.size === 0 && accumulator.phones.size === 0) {
    const beforeSerper = accSize();
    const serperKeyMissing = !(process.env.SERPER_API_KEY || '').trim();
    const serper = await serperFallbackForDomain(host, lead.company_name);
    for (const e of serper.emails) accumulator.emails.add(e);
    if (accumulator.emails.size > 0) result.via = 'serper';
    if (serperKeyMissing) _waterfallAgg.degraded.serper_no_key += 1;
    _recordLayer(result, 'serper', true, accSize() - beforeSerper, serperKeyMissing ? 'no_serper_key' : null);
  }

  // ── ⑦ 收口：B2B 买家邮箱质量裁判 + primary_* 回填 + 开放渠道对齐 ──────────
  // 5 层 BFS / Serper / LLM 可能抓回 support@bebee.com / chairman@sec.gov /
  // jane.doe@... 这种 placeholder/aggregator/政府/媒体邮箱 — finalizeEnrich 内
  // 用 filterBuyerEmails 二次过滤；全 reject 时 primary_email 置 null。
  // （收口逻辑抽到 finalizeEnrich，与 B2 no-domain 主页路径共用单源。）
  return finalizeEnrich(result, accumulator, host);
}

module.exports = {
  fetchHtml,
  extractContactsFromHtmlV2,
  bfsContactPages,
  llmExtractContactFromText,
  llmExtractContactFromImage,
  serperFallbackForDomain,
  enrichContactsForLead,
  // B2：社媒主页深抽取（导出供单测）
  collectProfileUrls,
  enrichFromProfileUrls,
  finalizeEnrich,
  getEnricherWaterfallStats,
  resetEnricherWaterfallStats,
  htmlToVisibleText,
  // 内部工具（暴露用于测试）
  isLikelyValidEmail,
  isLikelyValidPhone,
  normalizePhone,
};
