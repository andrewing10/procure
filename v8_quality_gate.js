/**
 * v8_quality_gate.js
 *
 * 与 zhimao/apps/web/lib/data-intel/quality.ts 完全镜像的质量计算模块。
 *
 * 规则双方必须保持一致：
 *   - V8 Step5 用此模块决定哪些线索上传给 zhimao Bulk API
 *   - zhimao Bulk API (route.ts) 调用 computeQualityGrade 决定写入 quality_grade
 *   - zhimao 搜索层 (.neq quality_grade unqualified) 决定哪些可以展示
 *
 * 三档质量：
 *   premium     — 高置信 L3 + 真实联系方式
 *   qualified   — 有真实联系方式，来源为 LLM 推断
 *   unqualified — 无联系方式 / 垃圾源头 / 乱码名称 → 不上传，不消耗配额
 *
 * ⚠️ 每次修改 zhimao/quality.ts 时必须同步更新此文件！
 */

// ── 垃圾域名黑名单（与 zhimao JUNK_DOMAIN_HOSTS 完全一致） ──────────────────
const JUNK_DOMAIN_HOSTS = new Set([
    'scribd.com', 'www.scribd.com',
    'reddit.com', 'www.reddit.com', 'old.reddit.com',
    'quora.com', 'www.quora.com',
    'alibaba.com', 'www.alibaba.com', 'm.alibaba.com',
    'aliexpress.com', 'www.aliexpress.com',
    '1688.com', 'www.1688.com',
    'taobao.com', 'www.taobao.com',
    'jd.com', 'www.jd.com',
    'pinduoduo.com',
    'linkedin.com', 'www.linkedin.com',
    'facebook.com', 'www.facebook.com', 'm.facebook.com',
    'twitter.com', 'www.twitter.com', 'x.com',
    'instagram.com', 'www.instagram.com',
    'youtube.com', 'www.youtube.com',
    'tiktok.com', 'www.tiktok.com',
    'pinterest.com', 'www.pinterest.com',
    'made-in-china.com', 'www.made-in-china.com',
    'globalsources.com', 'www.globalsources.com',
    'tradeindia.com', 'www.tradeindia.com',
    'tradekey.com', 'www.tradekey.com',
    'exportersindia.com', 'www.exportersindia.com',
    'ec21.com', 'www.ec21.com',
    'ecplaza.net', 'www.ecplaza.net',
    'kompass.com', 'www.kompass.com',
    'yellowpages.com', 'www.yellowpages.com',
    'yelp.com', 'www.yelp.com',
    'amazon.com', 'www.amazon.com', 'amazon.co.uk', 'amazon.de',
    'ebay.com', 'www.ebay.com',
    'etsy.com', 'www.etsy.com',
    'shopify.com', 'www.shopify.com',
    'importyeti.com', 'www.importyeti.com',
    'volza.com', 'www.volza.com',
    'panjiva.com', 'www.panjiva.com',
    'tradesparq.com',
    'dungedon.com',
    'bing.com', 'www.bing.com',
    'google.com', 'www.google.com',
    'yahoo.com', 'answers.yahoo.com',
    'wikipedia.org', 'en.wikipedia.org',
    'wikidata.org',
    // ── 新闻媒体（不是买家）─────────────────────────────────────────────────
    // 新加坡
    'zaobao.com.sg', 'www.zaobao.com.sg', 'zaobao.sg',
    'straitstimes.com', 'www.straitstimes.com',
    'channelnewsasia.com', 'www.channelnewsasia.com',
    'todayonline.com', 'www.todayonline.com',
    'businesstimes.com.sg', 'www.businesstimes.com.sg',
    'mothership.sg', 'www.mothership.sg',
    'stomp.straitstimes.com', 'stomp.com.sg',
    '8world.com', 'www.8world.com',
    'beritaharian.sg', 'www.beritaharian.sg',
    'tamilmurasu.com.sg', 'tnp.sg',
    // 马来西亚
    'thestar.com.my', 'www.thestar.com.my',
    'nst.com.my', 'www.nst.com.my',
    'malaymail.com', 'www.malaymail.com',
    'sinchew.com.my', 'www.sinchew.com.my',
    // 全球媒体
    'bbc.com', 'www.bbc.com', 'bbc.co.uk',
    'cnn.com', 'www.cnn.com',
    'reuters.com', 'www.reuters.com',
    'bloomberg.com', 'www.bloomberg.com',
    'ft.com', 'www.ft.com',
    'wsj.com', 'www.wsj.com',
    'theguardian.com', 'www.theguardian.com',
    'techcrunch.com', 'www.techcrunch.com',
    'forbes.com', 'www.forbes.com',
    'businessinsider.com', 'www.businessinsider.com',
    'nytimes.com', 'www.nytimes.com',
    'washingtonpost.com', 'www.washingtonpost.com',
]);

const JUNK_DOMAIN_PATTERNS = [
    /scribd\./i,
    /1688\.com/i,
    /wikip(e|é)dia/i,
    /fandom\.com/i,
    /blogspot\./i,
    /wordpress\.com/i,
    /medium\.com/i,
    /substack\.com/i,
];

const SOCIAL_DOMAIN_HOSTS = new Set([
    'facebook.com', 'www.facebook.com', 'm.facebook.com',
    'instagram.com', 'www.instagram.com',
    'linkedin.com', 'www.linkedin.com',
    'x.com', 'twitter.com', 'www.twitter.com',
    'youtube.com', 'www.youtube.com',
    'tiktok.com', 'www.tiktok.com',
    'pinterest.com', 'www.pinterest.com',
]);
const AGGREGATOR_DOMAIN_HOSTS = new Set([
    'yellowpages.com', 'www.yellowpages.com',
    'yelp.com', 'www.yelp.com',
    'kompass.com', 'www.kompass.com',
    'tradeindia.com', 'www.tradeindia.com',
    'tradekey.com', 'www.tradekey.com',
    'globalsources.com', 'www.globalsources.com',
    'made-in-china.com', 'www.made-in-china.com',
    'ec21.com', 'www.ec21.com',
    'ecplaza.net', 'www.ecplaza.net',
]);
const NEWS_TEXT_RE = /\b(news|press|journal|报道|新闻|专访|记者|通讯社)\b/i;
const SOCIAL_TEXT_RE = /\b(facebook|instagram|linkedin|x\.com|twitter|youtube|tiktok|social)\b/i;

// 国家识别（轻量版，避免引入重依赖）
const COUNTRY_HINTS = {
    US: ['united states', 'usa', 'america', '美国'],
    CN: ['china', 'prc', 'chinese', '中国'],
    SG: ['singapore', '新加坡'],
    MY: ['malaysia', '马来西亚'],
    TH: ['thailand', '泰国'],
    VN: ['vietnam', '越南'],
    ID: ['indonesia', '印尼', '印度尼西亚'],
    PH: ['philippines', '菲律宾'],
    JP: ['japan', '日本'],
    KR: ['south korea', 'korea', '韩国'],
    GB: ['united kingdom', 'uk', 'britain', '英国'],
    DE: ['germany', '德国'],
    FR: ['france', '法国'],
    IT: ['italy', '意大利'],
    ES: ['spain', '西班牙'],
    CA: ['canada', '加拿大'],
    AU: ['australia', '澳大利亚', '澳洲'],
    CH: ['switzerland', 'swiss', '瑞士'],
    BR: ['brazil', '巴西'],
    IN: ['india', '印度'],
    TR: ['turkey', '土耳其'],
    AE: ['uae', 'united arab emirates', '阿联酋'],
    SA: ['saudi arabia', '沙特'],
};
const CCTLD_TO_ISO = {
    us: 'US', cn: 'CN', sg: 'SG', my: 'MY', th: 'TH', vn: 'VN', id: 'ID', ph: 'PH',
    jp: 'JP', kr: 'KR', uk: 'GB', gb: 'GB', de: 'DE', fr: 'FR', it: 'IT', es: 'ES',
    ca: 'CA', au: 'AU', ch: 'CH', br: 'BR', in: 'IN', tr: 'TR', ae: 'AE', sa: 'SA',
};
const CALLING_CODE_TO_ISO = {
    '1': 'US', '86': 'CN', '65': 'SG', '60': 'MY', '66': 'TH', '84': 'VN', '62': 'ID',
    '63': 'PH', '81': 'JP', '82': 'KR', '44': 'GB', '49': 'DE', '33': 'FR', '39': 'IT',
    '34': 'ES', '61': 'AU', '41': 'CH', '55': 'BR', '91': 'IN', '90': 'TR', '971': 'AE', '966': 'SA',
};

// CJK + 地址关键字拦截（与 zhimao quality.ts 对齐）：V8 pipeline 可能把实际地址写入 domain 字段
const CJK_RANGE_RE = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
const ADDR_KEYWORD_RE = /[号街路道楼室层区市省镇村]/u;

/**
 * 域名是否为垃圾来源（与 zhimao quality.ts isJunkDomain 完全对齐）
 * 额外规则（相较旧版本补齐）：
 *   1. 含 CJK 字符 → 地址被误写入 domain 字段
 *   2. 含中文地址关键字（号/街/路/楼/室...）
 *   3. 超长 punycode 标签（xn-- 前缀且 >30 字符 = 被编码的中文地址）
 *   4. 无 TLD（不含点 = 不是域名）
 * @param {string|null|undefined} raw
 * @returns {boolean}
 */
function isJunkDomain(raw) {
    if (!raw || !raw.trim()) return false;
    // 快速拒绝：原始字符串含 CJK 字符（中文地址直接写入了 domain 字段）
    if (CJK_RANGE_RE.test(raw)) return true;
    // 快速拒绝：含常见中文地址关键字
    if (ADDR_KEYWORD_RE.test(raw)) return true;

    const domain = raw
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*/, '')
        .replace(/:\d+$/, '');
    if (JUNK_DOMAIN_HOSTS.has(domain)) return true;
    if (JUNK_DOMAIN_PATTERNS.some(p => p.test(domain))) return true;

    // 拒绝超长 punycode 标签（xn-- 且 >30 字符 = 被编码的非 ASCII 地址，如山东省青岛市...）
    const labels = domain.split('.');
    if (labels.some(l => l.startsWith('xn--') && l.length > 30)) return true;
    // 拒绝没有 TLD 的单标签字符串（不含点 = 不是域名）
    if (!domain.includes('.')) return true;

    return false;
}

function getHost(raw) {
    if (!raw || !raw.trim()) return '';
    try {
        const host = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.toLowerCase();
        return host.replace(/^www\./, '');
    } catch {
        return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
}

function inferEntityType({ domain, snippet, companyName }) {
    const host = getHost(domain);
    const text = `${snippet || ''} ${companyName || ''}`.toLowerCase();
    if (SOCIAL_DOMAIN_HOSTS.has(host) || SOCIAL_TEXT_RE.test(text)) return 'social';
    if (AGGREGATOR_DOMAIN_HOSTS.has(host)) return 'aggregator';
    if (NEWS_TEXT_RE.test(text)) return 'media';
    return 'company';
}

function extractPhoneCountry(phone) {
    if (!phone || typeof phone !== 'string') return null;
    const m = phone.trim().match(/^\+(\d{1,3})/);
    if (!m) return null;
    return CALLING_CODE_TO_ISO[m[1]] || null;
}

function inferIsoFromDomain(domain) {
    const host = getHost(domain);
    if (!host || !host.includes('.')) return null;
    const suffix = host.split('.').pop();
    if (!suffix) return null;
    return CCTLD_TO_ISO[suffix] || null;
}

function assessCountryMatchLevel({ targetCountry, text, domain, phone }) {
    const target = String(targetCountry || '').toUpperCase();
    if (!target || target.length !== 2) return 'medium';
    const hay = String(text || '').toLowerCase();
    let positive = 0;
    let negative = 0;

    const targetHints = COUNTRY_HINTS[target] || [];
    if (targetHints.some(h => hay.includes(h.toLowerCase()))) positive += 1;

    for (const [iso, hints] of Object.entries(COUNTRY_HINTS)) {
        if (iso === target) continue;
        if (hints.some(h => hay.includes(h.toLowerCase()))) {
            negative += 1;
            break;
        }
    }

    const domainIso = inferIsoFromDomain(domain);
    if (domainIso) {
        if (domainIso === target) positive += 1;
        else negative += 1;
    }
    const phoneIso = extractPhoneCountry(phone);
    if (phoneIso) {
        if (phoneIso === target) positive += 1;
        else negative += 1;
    }

    if (negative >= 2) return 'low';
    if (positive >= 2 && negative === 0) return 'high';
    return 'medium';
}

// ── 垃圾公司名过滤（与 zhimao JUNK_NAME_EXACT + JUNK_NAME_PATTERNS 完全一致） ─
const JUNK_NAME_EXACT = new Set([
    'n/a', 'na', 'unknown', 'none', 'null', 'test', 'demo', 'sample', 'example', '—', '-', 'company',
]);
const JUNK_NAME_PATTERNS = [
    /^\d+$/,                       // 全数字
    /^[^\w\u4e00-\u9fff]{1,}$/,   // 仅标点/符号
    /^\s*$/,                        // 空白
];

/**
 * 公司名是否为垃圾（与 zhimao isJunkName 完全对齐）
 * @param {string|null|undefined} name
 * @returns {boolean}
 */
function isJunkName(name) {
    if (!name || !name.trim()) return true;
    const n = name.trim();
    if (n.length < 3) return true;
    if (JUNK_NAME_EXACT.has(n.toLowerCase())) return true;
    if (JUNK_NAME_PATTERNS.some(p => p.test(n))) return true;
    return false;
}

/**
 * 计算质量档（与 zhimao computeQualityGrade 完全对齐）
 *
 * @param {{
 *   nameCanonical: string|null|undefined,
 *   domain: string|null|undefined,
 *   primaryEmail: string|null|undefined,
 *   primaryPhone: string|null|undefined,
 *   confidenceTier: string|null|undefined,
 *   hasProcurementItems: boolean|undefined,
 * }} params
 * @returns {'premium'|'qualified'|'unqualified'}
 */
function computeQualityGrade({ nameCanonical, domain, primaryEmail, primaryPhone, confidenceTier, hasProcurementItems }) {
    // 第一关：公司名质量
    if (isJunkName(nameCanonical)) return 'unqualified';

    // 第二关：联系方式是否真实可用
    const domainIsJunk = isJunkDomain(domain);
    const hasRealDomain = Boolean(domain && domain.trim()) && !domainIsJunk;
    const hasEmail = Boolean(primaryEmail && primaryEmail.trim() && primaryEmail.includes('@'));
    const hasPhone = Boolean(primaryPhone && primaryPhone.trim() && primaryPhone.replace(/\D/g, '').length >= 6);
    const hasContact = hasRealDomain || hasEmail || hasPhone;

    if (!hasContact) return 'unqualified';

    // 第三关：L3 推断置信度（有时不存在，跳过）
    if (confidenceTier !== undefined && confidenceTier !== null) {
        if (confidenceTier.toLowerCase() === 'low') return 'unqualified';
        if (hasProcurementItems === false) return 'unqualified';
    }

    // Premium：高置信 L3 + 真实域名或验证邮箱
    if (confidenceTier && confidenceTier.toLowerCase() === 'high' && (hasRealDomain || hasEmail)) return 'premium';

    // Qualified：有联系方式但未达到 premium
    return 'qualified';
}

// ── 已结业/停止营业检测 ─────────────────────────────────────────────────────
const CLOSED_BIZ_RE = /\b(permanently\s+clos|closed\s+down|ceased\s+operat|no\s+longer\s+operat|out\s+of\s+business|went\s+bankrupt|liquidat|already\s+clos|has\s+clos|have\s+clos|已结业|已停业|停止营业|结业清货|倒闭|停办|已停止营业|停业了|不再营业)\b/i;

/**
 * snippet/summary 是否含结业信号
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
function isClosedBusiness(text) {
    if (!text) return false;
    return CLOSED_BIZ_RE.test(text);
}

/**
 * V8 Step5 质量闸：
 * 返回 { qualified: bool, grade: 'premium'|'qualified'|'unqualified', reason?: string }
 *
 * 只有 grade !== 'unqualified' 的线索才上传给 zhimao Bulk API。
 * 这与 zhimao 搜索层 (.neq quality_grade unqualified) 完全对齐，
 * 避免"上传了但展示不了"的废配额问题。
 *
 * @param {object} lead - V8 enriched lead
 * @returns {{ qualified: boolean, grade: string, reason?: string }}
 */
function evaluateLead(lead) {
    if (!lead || !lead.company_name) return { qualified: false, grade: 'unqualified', reason: 'no_company_name' };

    const entityType = inferEntityType({
        domain: lead.domain,
        snippet: [lead.snippet, lead.intent_summary, lead.intent_summary_zh].filter(Boolean).join(' '),
        companyName: lead.company_name,
    });
    if (entityType !== 'company') {
        return { qualified: false, grade: 'unqualified', reason: `entity_type_${entityType}` };
    }

    // 拦截新闻媒体来源
    if (isJunkDomain(lead.domain) && lead.domain) {
        return { qualified: false, grade: 'unqualified', reason: 'junk_domain' };
    }

    // 拦截已结业商家（检查 snippet / summary）
    const snippetText = [
        lead.snippet,
        lead.profile_payload_json?.snippet,
        lead.intent_summary,
        lead.intent_summary_zh,
    ].filter(Boolean).join(' ');
    if (isClosedBusiness(snippetText)) {
        return { qualified: false, grade: 'unqualified', reason: 'closed_business' };
    }

    const countryMatch = assessCountryMatchLevel({
        targetCountry: lead.country,
        text: snippetText,
        domain: lead.domain,
        phone: lead.primary_phone,
    });
    if (countryMatch === 'low') {
        return { qualified: false, grade: 'unqualified', reason: 'country_mismatch' };
    }

    const ib = (lead.inference_breakdown && typeof lead.inference_breakdown === 'object')
        ? lead.inference_breakdown
        : null;

    const grade = computeQualityGrade({
        nameCanonical:        lead.company_name,
        domain:               lead.domain          || null,
        primaryEmail:         lead.primary_email   || null,
        primaryPhone:         lead.primary_phone   || null,
        confidenceTier:       ib ? (ib.confidence_tier || null) : undefined,
        hasProcurementItems:  ib ? (Array.isArray(ib.procurement_items) && ib.procurement_items.length >= 1) : undefined,
    });

    return { qualified: grade !== 'unqualified', grade };
}

module.exports = { isJunkDomain, isJunkName, computeQualityGrade, isClosedBusiness, evaluateLead };
