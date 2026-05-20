/**
 * v8_lib_contact_enricher.js — 联系方式抓取 5 层管道（procure 仓 CJS 版）
 *
 * 镜像 zhimao 仓 `apps/web/lib/skills/{htmlFetcher,contactExtractor,contactLlmExtract}.ts`
 * 三个 lib 的核心逻辑，用于把 v8 step3 enrich 的命中率从 ~20% 拉到 ~80%+。
 *
 * 5 层链路（按顺序，命中即返回，全空才下沉）：
 *   ① 直连 fetch（Chrome UA + 8s）      — 抽 mailto:/tel:/wa.me + 反混淆 + 不带+本地号
 *   ② Bright Data 代理重试              — 403/429/5xx/超时时启用（USE_PROXY=true）
 *   ③ BFS 1 层 contact 子页             — 从 <a href> 发现 contact 内链 + 12 条常见路径兜底
 *   ④ Gemini Flash 视觉抽取             — 静态全空时调用，认 "采购经理 + 邮箱" 语义
 *   ⑤ Serper site:domain 搜索兜底       — 必须 @domain 同域邮箱才纳入（防第三方污染）
 *
 * 设计原则：
 *   - 失败安静返回 { emails: [], phones: [], whatsapps: [] }，不抛 step3 主流程
 *   - 单 URL 最长 8s，每层有自己的超时；5 层总 budget ~30s（per company）
 *   - LLM/Serper 仅在前几层全空时才调用，控本（命中率高的公司根本走不到 ④⑤）
 *
 * ⚠️ 修改后必须**同步**修改 zhimao 仓的三个 lib，否则 zhimao 这边的"手工解锁补全"
 * 与 worker 入库前的 enrich 会出现规则漂移，再次出现"明明 footer 有却抓不到"。
 */

'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');

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

// ─── ⑤：Serper 同域邮箱搜索兜底 ──────────────────────────────────────────
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
    any_blocked: false,
  };

  const rawDomain = String(lead.domain || '').trim();
  if (!rawDomain) {
    result.via = 'no_domain';
    return result;
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

  const accumulator = {
    emails: new Set(),
    phones: new Set(),
    whatsapps: new Set(),
  };

  // ── ① + ② 阶段：首页 ───────────────────────────────────────────────
  const homeUrl = `https://${host}/`;
  const homeRes = await fetchHtml(homeUrl, { timeoutMs: 8000 });
  result.fetch_log.push({ url: homeUrl, status: homeRes.status, via: homeRes.via });
  let discoveredLinks = [];
  if (homeRes.ok) {
    const got = extractContactsFromHtmlV2(homeRes.html, homeRes.finalUrl);
    for (const e of got.emails) accumulator.emails.add(e);
    for (const p of got.phones) accumulator.phones.add(p);
    for (const w of got.whatsapps) accumulator.whatsapps.add(w);
    discoveredLinks = got.contactLinks;
    if (accumulator.emails.size > 0 || accumulator.phones.size > 0) result.via = 'home';
  } else if (homeRes.via === 'blocked') {
    result.any_blocked = true;
  }

  // ── ③ 阶段：BFS contact 子页（即使首页已有也跑，能挖到更多角色邮箱） ─
  await bfsContactPages(host, discoveredLinks, accumulator, { timeoutMs: 7000 });
  if (result.via === 'none' && (accumulator.emails.size > 0 || accumulator.phones.size > 0)) {
    result.via = 'bfs';
  }

  // ── ④ 阶段：LLM 兜底（仅静态全空时调用，控本） ────────────────────
  if (accumulator.emails.size === 0 && accumulator.phones.size === 0 && homeRes.ok) {
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
    }
  }

  // ── ⑤ 阶段：Serper 同域名邮箱搜索（仍然全空时的最后一搏） ──────────
  if (accumulator.emails.size === 0 && accumulator.phones.size === 0) {
    const serper = await serperFallbackForDomain(host, lead.company_name);
    for (const e of serper.emails) accumulator.emails.add(e);
    if (accumulator.emails.size > 0) result.via = 'serper';
  }

  // 写回结果（按优先级：原 lead 已有的不覆盖；mailto/tel 类源在 extractContactsFromHtmlV2 已排序过）
  if (!result.primary_email && accumulator.emails.size > 0) {
    result.primary_email = [...accumulator.emails][0];
  }
  if (!result.primary_phone && accumulator.phones.size > 0) {
    result.primary_phone = [...accumulator.phones][0];
  }
  if (accumulator.whatsapps.size > 0) {
    result.primary_whatsapp = [...accumulator.whatsapps][0];
  }
  result.filled = Boolean(result.primary_email || result.primary_phone || result.primary_whatsapp);
  return result;
}

module.exports = {
  fetchHtml,
  extractContactsFromHtmlV2,
  bfsContactPages,
  llmExtractContactFromText,
  serperFallbackForDomain,
  enrichContactsForLead,
  htmlToVisibleText,
  // 内部工具（暴露用于测试）
  isLikelyValidEmail,
  isLikelyValidPhone,
  normalizePhone,
};
