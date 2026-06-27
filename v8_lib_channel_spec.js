/**
 * v8_lib_channel_spec.js — 买家可达渠道「开放探测」单源（procure CJS 侧）。
 *
 * ⚠️ 双仓镜像：与 zhimao 仓 `apps/web/lib/skills/channelSpec.ts` 的 detectChannels
 *    规则必须一致。任一边修改后同步另一仓。
 *
 * 设计：渠道是开放集合 channels[]，每条 { type, value, source, confidence }。
 * email/phone/whatsapp 仍由 v8_lib_contact_enricher 的成熟逻辑产出，本模块负责
 * "除此之外"的所有渠道（Telegram/微信/LINE/Instagram/LinkedIn/X/FB/YouTube/
 *  TikTok/Skype/Viber/Kakao/Zalo/官网外链 …）。
 */

'use strict';

const CHANNEL_TYPES = [
  'email', 'phone', 'whatsapp', 'telegram', 'wechat', 'line', 'kakao', 'zalo', 'viber',
  'skype', 'signal', 'messenger', 'instagram', 'linkedin', 'twitter', 'facebook',
  'youtube', 'tiktok', 'website', 'contact_form',
];

const SOCIAL_HOSTS = new Set([
  'wa.me', 'api.whatsapp.com', 'whatsapp.com', 't.me', 'telegram.me', 'telegram.org',
  'line.me', 'lin.ee', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'facebook.com', 'fb.com', 'fb.me', 'm.facebook.com', 'messenger.com', 'youtube.com',
  'youtu.be', 'tiktok.com', 'skype.com', 'join.skype.com', 'weixin.qq.com', 'kakao.com',
  'open.kakao.com', 'zalo.me', 'viber.com', 'signal.me',
]);

const RESERVED_SEGMENTS = new Set([
  'i', 'home', 'search', 'explore', 'intent', 'share', 'sharer', 'sharer.php', 'plugins',
  'dialog', 'tr', 'p', 'reel', 'reels', 'stories', 'hashtag', 'about', 'watch', 'events',
  'groups', 'pages', 'login', 'signup', 'messages',
]);

function cleanUrl(u) {
  const base = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '');
  return base.length <= 300 ? base : base.slice(0, 300);
}

function firstSeg(pathname) {
  return (pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
}

function classifyLink(rawHref, baseHost) {
  const href = String(rawHref || '').trim();
  if (!href) return null;

  const schemeMatch = href.match(/^([a-z][a-z0-9+.\-]*):/i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    if (scheme === 'skype') {
      const id = href.replace(/^skype:/i, '').split('?')[0].trim();
      if (id) return { type: 'skype', value: id.slice(0, 120), source: 'scheme', confidence: 0.7 };
    }
    if (scheme === 'viber') {
      const m = href.match(/number=(\+?\d[\d]{5,15})/i);
      if (m) return { type: 'viber', value: m[1], source: 'scheme', confidence: 0.7 };
      return { type: 'viber', value: href.slice(0, 120), source: 'scheme', confidence: 0.5 };
    }
    if (scheme === 'weixin') {
      const id = href.replace(/^weixin:\/\/?/i, '').split('?')[0].trim();
      return { type: 'wechat', value: (id || href).slice(0, 120), source: 'scheme', confidence: 0.6 };
    }
    if (scheme === 'line') return { type: 'line', value: href.slice(0, 200), source: 'scheme', confidence: 0.7 };
    if (scheme === 'tg') return { type: 'telegram', value: href.slice(0, 200), source: 'scheme', confidence: 0.7 };
    return null;
  }

  let u;
  try {
    u = new URL(href, baseHost ? `https://${baseHost}` : 'https://_placeholder.invalid');
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const seg = firstSeg(u.pathname);

  if (host === 't.me' || host === 'telegram.me') {
    if (!seg || seg === 's' || seg === 'joinchat' || seg.startsWith('+')) return null;
    return { type: 'telegram', value: cleanUrl(u), source: 'href', confidence: 0.85 };
  }
  if (host === 'line.me' || host === 'lin.ee') {
    return { type: 'line', value: cleanUrl(u), source: 'href', confidence: 0.8 };
  }
  if (host === 'instagram.com') {
    if (!seg || RESERVED_SEGMENTS.has(seg)) return null;
    return { type: 'instagram', value: cleanUrl(u), source: 'href', confidence: 0.75 };
  }
  if (host === 'linkedin.com') {
    if (seg === 'in' || seg === 'company' || seg === 'pub') {
      return { type: 'linkedin', value: cleanUrl(u), source: 'href', confidence: 0.85 };
    }
    return null;
  }
  if (host === 'twitter.com' || host === 'x.com') {
    if (!seg || RESERVED_SEGMENTS.has(seg) || !/^[a-z0-9_]{1,15}$/i.test(seg)) return null;
    return { type: 'twitter', value: cleanUrl(u), source: 'href', confidence: 0.7 };
  }
  if (host === 'facebook.com' || host === 'fb.com' || host === 'fb.me' || host === 'm.facebook.com') {
    if (!seg || RESERVED_SEGMENTS.has(seg)) return null;
    return { type: 'facebook', value: cleanUrl(u), source: 'href', confidence: 0.7 };
  }
  if (host === 'messenger.com' || host === 'm.me') {
    return { type: 'messenger', value: cleanUrl(u), source: 'href', confidence: 0.7 };
  }
  if (host === 'youtube.com' || host === 'youtu.be') {
    if (u.pathname.startsWith('/@') || seg === 'channel' || seg === 'c' || seg === 'user') {
      return { type: 'youtube', value: cleanUrl(u), source: 'href', confidence: 0.7 };
    }
    return null;
  }
  if (host === 'tiktok.com') {
    if (u.pathname.startsWith('/@')) return { type: 'tiktok', value: cleanUrl(u), source: 'href', confidence: 0.7 };
    return null;
  }
  if (host === 'join.skype.com' || host === 'skype.com') {
    return { type: 'skype', value: cleanUrl(u), source: 'href', confidence: 0.65 };
  }
  if (host === 'weixin.qq.com') {
    return { type: 'wechat', value: cleanUrl(u), source: 'href', confidence: 0.55 };
  }
  if (host === 'kakao.com' || host === 'open.kakao.com') {
    return { type: 'kakao', value: cleanUrl(u), source: 'href', confidence: 0.7 };
  }
  if (host === 'zalo.me') return { type: 'zalo', value: cleanUrl(u), source: 'href', confidence: 0.7 };
  if (host === 'signal.me') return { type: 'signal', value: cleanUrl(u), source: 'href', confidence: 0.7 };

  if (host === 'wa.me' || host === 'api.whatsapp.com' || host === 'whatsapp.com') return null;

  if (baseHost) {
    const bHost = baseHost.replace(/^www\./, '').toLowerCase();
    const baseIsSocial = SOCIAL_HOSTS.has(bHost);
    if (baseIsSocial && !SOCIAL_HOSTS.has(host) && host !== bHost && host !== '_placeholder.invalid') {
      return { type: 'website', value: cleanUrl(u), source: 'href', confidence: 0.6 };
    }
  }
  return null;
}

function detectTextHandles(text) {
  const out = [];
  const t = String(text || '').slice(0, 200000);
  const wechatRe = /(?:微信号?|wechat|微信\s*id|wx)\s*[:：]?\s*([A-Za-z][A-Za-z0-9_\-]{5,29})/gi;
  let m;
  while ((m = wechatRe.exec(t)) !== null) {
    const id = (m[1] || '').trim();
    if (id) out.push({ type: 'wechat', value: id, source: 'text', confidence: 0.55 });
  }
  const lineRe = /line\s*(?:id)?\s*[:：]\s*([A-Za-z0-9_.\-]{3,30})/gi;
  while ((m = lineRe.exec(t)) !== null) {
    const id = (m[1] || '').trim();
    if (id) out.push({ type: 'line', value: id, source: 'text', confidence: 0.5 });
  }
  return out;
}

/**
 * 从一份 HTML 抽出"除 email/phone/whatsapp 之外"的开放渠道集合。
 * @returns {Array<{type:string,value:string,source:string,confidence:number}>}
 */
function detectChannels(html, baseUrl = '', limitPerType = 4) {
  if (!html || html.length < 10) return [];
  let baseHost = null;
  try {
    baseHost = baseUrl ? new URL(baseUrl).hostname : null;
  } catch {
    baseHost = null;
  }

  const found = [];
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const c = classifyLink(m[1] || '', baseHost);
    if (c) found.push(c);
  }
  const bareRe = /https?:\/\/(?:t\.me|telegram\.me|lin\.ee|line\.me|instagram\.com|linkedin\.com|x\.com|twitter\.com|facebook\.com|youtube\.com|tiktok\.com)\/[^\s"'<>)]+/gi;
  while ((m = bareRe.exec(html)) !== null) {
    const c = classifyLink(m[0], baseHost);
    if (c) found.push(c);
  }
  const stripped = html.replace(/<[^>]+>/g, ' ');
  for (const c of detectTextHandles(stripped)) found.push(c);

  const seen = new Set();
  const perType = new Map();
  const result = [];
  for (const c of found.sort((a, b) => b.confidence - a.confidence)) {
    const key = `${c.type}::${c.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    const n = perType.get(c.type) || 0;
    if (n >= limitPerType) continue;
    seen.add(key);
    perType.set(c.type, n + 1);
    result.push(c);
  }
  return result;
}

/**
 * classifyUrl — 对单个已知 URL（如 L1.social_profile_urls 里的一条）做渠道归类。
 * 是 classifyLink 的对外别名（baseHost 可选；不传则按绝对 URL 解析）。
 * @returns {{type:string,value:string,source:string,confidence:number}|null}
 */
function classifyUrl(rawUrl, baseHost) {
  return classifyLink(rawUrl, baseHost || null);
}

/**
 * buildContactChannels — 从一条 lead/L1 行的现有字段「合成」开放渠道集合。
 * 不抓网页，仅把已有的 email/phone/whatsapp + social_profile_urls + 上游 enricher
 * 产出的 channels 统一成 [{type,value,source,confidence}] 并去重（同 type::value 取高分）。
 *
 * @param {object} input
 * @param {string|null} [input.email]
 * @param {string|null} [input.phone]
 * @param {string|null} [input.whatsapp]
 * @param {string[]}    [input.socialUrls]   L1.social_profile_urls
 * @param {Array}       [input.extraChannels] enricher 产出的 channels[]
 * @returns {Array<{type:string,value:string,source:string,confidence:number}>}
 */
function buildContactChannels(input = {}) {
  const out = [];
  const push = (type, value, source, confidence) => {
    const v = String(value == null ? '' : value).trim();
    if (!v) return;
    out.push({ type, value: v.slice(0, 300), source, confidence });
  };

  push('email', input.email, 'l1_field', 0.9);
  push('phone', input.phone, 'l1_field', 0.85);
  if (input.whatsapp) {
    const digits = String(input.whatsapp).replace(/[^\d+]/g, '');
    push('whatsapp', digits || input.whatsapp, 'l1_field', 0.85);
  }

  for (const u of Array.isArray(input.socialUrls) ? input.socialUrls : []) {
    const c = classifyLink(String(u || ''), null);
    if (c) out.push(c);
  }

  for (const c of Array.isArray(input.extraChannels) ? input.extraChannels : []) {
    if (c && c.type && c.value != null) {
      const v = String(c.value).trim();
      if (!v) continue;
      out.push({
        type: String(c.type),
        value: v.slice(0, 300),
        source: c.source || 'enricher',
        confidence: typeof c.confidence === 'number' ? c.confidence : 0.6,
      });
    }
  }

  const best = new Map();
  for (const c of out) {
    const key = `${c.type}::${String(c.value).toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || c.confidence > prev.confidence) best.set(key, c);
  }
  return [...best.values()];
}

module.exports = { CHANNEL_TYPES, SOCIAL_HOSTS, detectChannels, classifyUrl, buildContactChannels };
