/**
 * 从买家官网 / FB about / cheerio 已解析的 HTML 中抽取「公开社媒主页 URL」。
 *
 * - 仅抓「主页」类 URL（facebook.com/<slug>、instagram.com/<slug>、x.com/<slug>、
 *   linkedin.com/company/<slug>、youtube.com/{c,@}slug）；登录态评论/帖子页一律忽略。
 * - 输出统一为不含查询串的归一化 URL，便于 dedup。
 * - 严格白名单 host，避免误把 sharer / login / l.facebook.com 这类反爬中转链接当成主页。
 */

const ALLOWED_HOSTS = new Set([
  'facebook.com', 'm.facebook.com',
  'instagram.com',
  'linkedin.com',
  'youtube.com', 'm.youtube.com',
  'twitter.com', 'x.com',
]);

const BANNED_PATH_RES = [
  /^\/sharer/i,
  /^\/login/i,
  /^\/dialog/i,
  /^\/intent/i,
  /^\/share/i,
  /^\/help/i,
  /^\/policies?/i,
  /^\/groups\/.+\/(posts|permalink|members)/i,
];

const PROFILE_PATH_RES = [
  /^\/[^\/?#]+\/?$/i,
  /^\/company\/[^\/?#]+\/?$/i,
  /^\/in\/[^\/?#]+\/?$/i,
  /^\/c\/[^\/?#]+\/?$/i,
  /^\/@[^\/?#]+\/?$/i,
  /^\/groups\/[^\/?#]+\/?$/i,
];

function normalizeHost(rawHost) {
  let h = String(rawHost || '').toLowerCase().replace(/^www\./, '');
  if (h === 'www.facebook.com') h = 'facebook.com';
  return h;
}

function classifyPlatform(host) {
  if (host.endsWith('facebook.com')) return 'facebook';
  if (host.endsWith('instagram.com')) return 'instagram';
  if (host.endsWith('linkedin.com')) return 'linkedin';
  if (host.endsWith('youtube.com')) return 'youtube';
  if (host === 'x.com' || host.endsWith('twitter.com')) return 'x';
  return null;
}

/**
 * @param {string} url 候选 URL（可包含 query / hash / 协议缺失）
 * @returns {{ url: string, platform: string } | null}
 */
function tryNormalize(url) {
  if (!url || typeof url !== 'string') return null;
  let cleaned = url.trim();
  if (!cleaned) return null;
  if (!/^https?:\/\//i.test(cleaned)) cleaned = 'https://' + cleaned.replace(/^\/+/, '');
  let u;
  try { u = new URL(cleaned); } catch { return null; }
  const host = normalizeHost(u.hostname);
  if (!ALLOWED_HOSTS.has(host)) return null;
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (BANNED_PATH_RES.some((re) => re.test(path))) return null;
  if (!PROFILE_PATH_RES.some((re) => re.test(path))) return null;
  const platform = classifyPlatform(host);
  if (!platform) return null;
  // 归一化输出：协议 + host + path（去查询串、去尾斜杠）
  return { url: `https://${host}${path}`, platform };
}

/**
 * 从 cheerio 已解析对象 + 文本中抽取社媒主页 URL 数组。
 * @param {object|null} $ cheerio 实例（可选，提供时优先扫 a[href]）
 * @param {string} html 原始 HTML 文本（必传，作为兜底）
 * @returns {string[]} 去重后的 URL 数组（最多 8 个）
 */
function extractSocialUrls($, html) {
  const set = new Set();

  if ($ && typeof $ === 'function') {
    $('a[href]').each((_, el) => {
      try {
        const href = $(el).attr('href');
        const r = tryNormalize(href);
        if (r) set.add(r.url);
      } catch (_) {}
    });
  }

  if (typeof html === 'string' && html.length > 0) {
    const re = /(https?:\/\/(?:www\.)?(?:facebook|m\.facebook|instagram|linkedin|youtube|m\.youtube|twitter|x)\.com\/[A-Za-z0-9._@\/-]{1,64})/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const r = tryNormalize(m[1]);
      if (r) set.add(r.url);
      if (set.size > 32) break;
    }
  }

  return [...set].slice(0, 8);
}

/**
 * 从 lead.snippet / lead.title / lead.link 等纯文本字段抽取（Step1 时 HTML 未到手）。
 */
function extractSocialUrlsFromText(...texts) {
  const set = new Set();
  const re = /(https?:\/\/(?:www\.)?(?:facebook|m\.facebook|instagram|linkedin|youtube|m\.youtube|twitter|x)\.com\/[A-Za-z0-9._@\/-]{1,64})/gi;
  for (const t of texts) {
    if (!t || typeof t !== 'string') continue;
    let m;
    while ((m = re.exec(t)) !== null) {
      const r = tryNormalize(m[1]);
      if (r) set.add(r.url);
      if (set.size > 16) break;
    }
  }
  return [...set];
}

module.exports = { extractSocialUrls, extractSocialUrlsFromText, tryNormalize };
