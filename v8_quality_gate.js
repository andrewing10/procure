/**
 * v8_quality_gate.js
 *
 * 与 zhimao/apps/web/lib/data-intel/quality.ts 完全镜像的质量计算模块。
 *
 * 规则双方必须保持一致：
 *   - V8 Step5 用此模块决定哪些线索写入 data_intel_l1_companies（直写模式）
 *   - zhimao 搜索层 (.neq quality_grade unqualified) 决定哪些可以展示
 *
 * 三档质量：
 *   premium     — 高置信 L3 + 真实联系方式（或采购信号 >= 2）
 *   qualified   — 有真实联系方式，来源为 LLM 推断
 *   unqualified — 无联系方式 / 垃圾源头 / 乱码名称 / 业态黑名单 → 不写入，不消耗配额
 *
 * ⚠️ 每次修改 zhimao/quality.ts 时必须同步更新此文件！
 * C3 同步：bizDescription、procurementSignalCount、BIZ_ANTI_PATTERNS、entityType、countryMatchLevel
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
    // 公司目录/评级聚合站：实测 vaneerden.bbb.org 这种被误判 premium
    'bbb.org', 'www.bbb.org',
    'globalimporter.net', 'www.globalimporter.net', 'free.globalimporter.net',
    'thomasnet.com', 'www.thomasnet.com',
    'manta.com', 'www.manta.com',
    'dnb.com', 'www.dnb.com',
    'crunchbase.com', 'www.crunchbase.com',
]);

/**
 * 域名是否为聚合/目录站（公司不在此站持有真实主页，仅被列表收录）。
 * Premium 判定时要求公司有真实主域名，不能仅凭出现在聚合站。
 */
function isAggregatorDomain(raw) {
    if (!raw || !raw.trim()) return false;
    const host = getHost(raw);
    if (!host) return false;
    if (AGGREGATOR_DOMAIN_HOSTS.has(host)) return true;
    // 子域兜底：xxx.bbb.org / free.globalimporter.net 等
    for (const agg of AGGREGATOR_DOMAIN_HOSTS) {
        if (host === agg || host.endsWith('.' + agg)) return true;
    }
    return false;
}
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

// ── 业态黑名单（C3 同步：解决餐厅/医院/政府机关误进 L1 问题） ────────────────
const BIZ_ANTI_PATTERNS = [
    /\b(mcdonald|kfc|starbucks|subway|burger.king|pizza.hut|domino|wendy|taco.bell)\b/i,
    /\b(restaurant|cafe|coffee\s+shop|fast[_\s]food|food.chain|bistro|bakery|eatery|diner)\b/i,
    /\b(hotel|motel|hostel|inn\b|resort|lodge|accommodation)\b/i,
    /\b(hospital|clinic|dental|medical.center|pharmacy|dispensary|healthcare.provider)\b/i,
    /\b(primary.school|secondary.school|university|college|academy\b|kindergarten|tuition)\b/i,
    /\b(bank\b|insurance\s+company|financial\s+service|accounting\s+firm|law\s+firm)\b/i,
    /\b(government|municipality|ministry|prefecture|public\s+sector|city.council|town.hall)\b/i,
    /\b(charity|ngo\b|nonprofit|non-profit|foundation\b)\b/i,
    /\b(salon|barbershop|spa\b|beauty.center|nail.studio|massage.parlor|gym\b|fitness.center)\b/i,
];

/**
 * 判断公司名/描述是否属于"非采购买家"业态（与 zhimao isBizTypeBlacklisted C3 完全对齐）
 * @param {string|null|undefined} nameOrDesc
 * @returns {boolean}
 */
function isBizTypeBlacklisted(nameOrDesc) {
    if (!nameOrDesc || !nameOrDesc.trim()) return false;
    for (const re of BIZ_ANTI_PATTERNS) {
        if (re.test(nameOrDesc)) return true;
    }
    return false;
}

/**
 * 计算质量档（与 zhimao computeQualityGrade 完全对齐，含 C3 升级）
 *
 * @param {{
 *   nameCanonical: string|null|undefined,
 *   domain: string|null|undefined,
 *   primaryEmail: string|null|undefined,
 *   primaryPhone: string|null|undefined,
 *   confidenceTier: string|null|undefined,
 *   hasProcurementItems: boolean|undefined,
 *   entityType: string|null|undefined,
 *   countryMatchLevel: string|null|undefined,
 *   bizDescription: string|null|undefined,
 *   procurementSignalCount: number,
 * }} params
 * @returns {'premium'|'qualified'|'unqualified'}
 */
function computeQualityGrade({
    nameCanonical,
    domain,
    primaryEmail,
    primaryPhone,
    confidenceTier,
    hasProcurementItems,
    entityType,
    countryMatchLevel,
    bizDescription,
    procurementSignalCount = 0,
}) {
    // 第一关：公司名质量
    if (isJunkName(nameCanonical)) return 'unqualified';
    if (entityType && entityType !== 'company') return 'unqualified';
    if (countryMatchLevel === 'low') return 'unqualified';

    // C3 第一关补充：业态黑名单（餐厅/医院/政府等不可能是采购买家）
    if (isBizTypeBlacklisted(bizDescription != null ? bizDescription : nameCanonical)) return 'unqualified';

    // 第二关：联系方式是否真实可用
    const domainIsJunk = isJunkDomain(domain);
    const hasRealDomain = Boolean(domain && domain.trim()) && !domainIsJunk;
    const hasEmail = Boolean(primaryEmail && primaryEmail.trim() && primaryEmail.includes('@'));
    const hasPhone = Boolean(primaryPhone && primaryPhone.trim() && primaryPhone.replace(/\D/g, '').length >= 6);
    const hasContact = hasRealDomain || hasEmail || hasPhone;

    // C3：有采购信号时放宽联系方式要求（信号证明了商业存在）
    if (!hasContact && procurementSignalCount <= 0) return 'unqualified';

    // 第三关：L3 推断置信度（有时不存在，跳过）
    if (confidenceTier !== undefined && confidenceTier !== null) {
        if (confidenceTier.toLowerCase() === 'low') return 'unqualified';
        if (hasProcurementItems === false) return 'unqualified';
    }

    // Premium 升级要求：必须有公司主域名（非聚合/目录站如 bbb.org / globalimporter.net）。
    // 实测 vaneerden 域名是 bbb.org（评级聚合站）被误判 premium——聚合站只能证明公司
    // 出现在目录里，不能证明它是高质量买家主体。
    const hasOwnedDomain = hasRealDomain && !isAggregatorDomain(domain);

    // C3 Premium 升级：有采购信号 + 公司主域名 → premium（进口证据/招聘信号 = 确定性买家）
    if (procurementSignalCount >= 2 && hasOwnedDomain) return 'premium';

    // Premium：高置信 L3 + 公司主域名或验证邮箱
    if (confidenceTier && confidenceTier.toLowerCase() === 'high' && (hasOwnedDomain || hasEmail)) return 'premium';

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
/**
 * 从 V8 lead 推断采购信号数量（与 zhimao C3 procurementSignalCount 语义对齐）：
 *   BOL_SIGNAL / CUSTOMS_SIGNAL / PROCUREMENT_DECISION_MAKER / IMPORT_RECORD：各计 1
 *   tax_verified：+1
 *   verified_source_id（已验证来源）：+1
 * @param {object} lead
 * @returns {number}
 */
function inferProcurementSignalCount(lead) {
    let count = 0;
    const sig = String(lead.intent_signal || '').toUpperCase();
    if (sig === 'BOL_SIGNAL' || sig === 'CUSTOMS_SIGNAL' || sig === 'IMPORT_RECORD') count += 1;
    if (sig === 'PROCUREMENT_DECISION_MAKER') count += 1;
    if (lead.tax_verified) count += 1;
    if (lead.verified_source_id) count += 1;
    // 来自 inference_breakdown 的 reason_codes
    const ib = lead.inference_breakdown;
    if (ib && Array.isArray(ib.reason_codes)) {
        const codes = ib.reason_codes.map(c => String(c).toUpperCase());
        if (codes.some(c => c.includes('IMPORT') || c.includes('BOL') || c.includes('CUSTOMS'))) count += 1;
    }
    return Math.min(count, 5);
}

function evaluateLead(lead) {
    if (!lead || !lead.company_name) return { qualified: false, grade: 'unqualified', reason: 'no_company_name' };

    const snippetText = [
        lead.snippet,
        lead.profile_payload_json?.snippet,
        lead.intent_summary,
        lead.intent_summary_zh,
    ].filter(Boolean).join(' ');

    const entityType = inferEntityType({
        domain: lead.domain,
        snippet: snippetText,
        companyName: lead.company_name,
    });

    // 拦截新闻媒体来源
    if (isJunkDomain(lead.domain) && lead.domain) {
        return { qualified: false, grade: 'unqualified', reason: 'junk_domain' };
    }

    // 拦截已结业商家（检查 snippet / summary）
    if (isClosedBusiness(snippetText)) {
        return { qualified: false, grade: 'unqualified', reason: 'closed_business' };
    }

    const countryMatch = assessCountryMatchLevel({
        targetCountry: lead.country,
        text: snippetText,
        domain: lead.domain,
        phone: lead.primary_phone,
    });

    const ib = (lead.inference_breakdown && typeof lead.inference_breakdown === 'object')
        ? lead.inference_breakdown
        : null;

    const procurementSignalCount = inferProcurementSignalCount(lead);

    const grade = computeQualityGrade({
        nameCanonical:           lead.company_name,
        domain:                  lead.domain          || null,
        primaryEmail:            lead.primary_email   || null,
        primaryPhone:            lead.primary_phone   || null,
        confidenceTier:          ib ? (ib.confidence_tier || null) : undefined,
        hasProcurementItems:     ib ? (Array.isArray(ib.procurement_items) && ib.procurement_items.length >= 1) : undefined,
        entityType:              entityType,
        countryMatchLevel:       countryMatch,
        bizDescription:          lead.company_name,
        procurementSignalCount:  procurementSignalCount,
    });

    return { qualified: grade !== 'unqualified', grade };
}

module.exports = {
    isJunkDomain,
    isAggregatorDomain,
    isJunkName,
    isBizTypeBlacklisted,
    computeQualityGrade,
    isClosedBusiness,
    inferProcurementSignalCount,
    evaluateLead,
};
