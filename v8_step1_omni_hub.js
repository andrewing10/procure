require('dotenv').config();
const fs    = require('fs');
const https = require('https');

// ── P0 垃圾域名黑名单（与 zhimao lib/data-intel/quality.ts 保持一致） ─────────
const JUNK_DOMAIN_HOSTS = new Set([
  'scribd.com','www.scribd.com',
  'reddit.com','www.reddit.com','old.reddit.com',
  'quora.com','www.quora.com',
  'alibaba.com','www.alibaba.com','m.alibaba.com',
  'aliexpress.com','www.aliexpress.com',
  '1688.com','www.1688.com',
  'taobao.com','www.taobao.com',
  'jd.com','www.jd.com',
  'pinduoduo.com',
  'linkedin.com','www.linkedin.com',
  'facebook.com','www.facebook.com','m.facebook.com',
  'twitter.com','www.twitter.com','x.com',
  'instagram.com','www.instagram.com',
  'youtube.com','www.youtube.com',
  'tiktok.com','www.tiktok.com',
  'pinterest.com','www.pinterest.com',
  'made-in-china.com','www.made-in-china.com',
  'globalsources.com','www.globalsources.com',
  'tradeindia.com','www.tradeindia.com',
  'tradekey.com','www.tradekey.com',
  'exportersindia.com','www.exportersindia.com',
  'ec21.com','www.ec21.com',
  'ecplaza.net','www.ecplaza.net',
  'kompass.com','www.kompass.com',
  'yellowpages.com','www.yellowpages.com',
  'yelp.com','www.yelp.com',
  'amazon.com','www.amazon.com',
  'ebay.com','www.ebay.com',
  'etsy.com','www.etsy.com',
  'importyeti.com','www.importyeti.com',   // 聚合站点：内容有价值但 URL 是垃圾 → 见 Pillar 3 修复说明
  'volza.com','www.volza.com',
  'panjiva.com','www.panjiva.com',
  'tradesparq.com',
  'bing.com','www.bing.com',
  'google.com','www.google.com',
  'wikipedia.org','en.wikipedia.org',
  'wikidata.org',
]);
const JUNK_DOMAIN_PATTERNS = [
  /scribd\./i, /1688\.com/i, /wikip/i, /fandom\.com/i,
  /blogspot\./i, /wordpress\.com/i, /medium\.com/i,
  /substack\.com/i,
];

function isJunkLead(lead) {
  if (!lead || !lead.link) return false;
  try {
    const domain = lead.link.trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/\/.*/, '').replace(/:\d+$/, '');
    if (JUNK_DOMAIN_HOSTS.has(domain)) return true;
    if (JUNK_DOMAIN_PATTERNS.some(p => p.test(domain))) return true;
  } catch(_) {}
  return false;
}

const [inputFile, outputFile, countryCode] = process.argv.slice(2);

const API_KEY = process.env.SERPER_API_KEY;
if (!API_KEY) { console.error('[step1] SERPER_API_KEY env var is required'); process.exit(1); }

// ─── Serper helpers ────────────────────────────────────────────────────────
function serperPost(path, body) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'google.serper.dev', path, method: 'POST',
      headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, r => {
      let data = ''; r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.write(payload); req.end();
  });
}

function fetchPlaces(query, gl) {
  return serperPost('/places', { q: query, gl }).then(r => r.places || []);
}

function searchOrganic(query, gl, num = 20) {
  return serperPost('/search', { q: query, gl, num }).then(r => r.organic || []);
}

// ─── Lead builders ─────────────────────────────────────────────────────────
function fromOrganic(results, pillar, intent_signal) {
  return results.map(o => ({
    title: o.title, link: o.link, snippet: o.snippet,
    pillar, ...(intent_signal ? { intent_signal } : {}),
  }));
}

// ─── 主函数：全 Pillar 并行执行 ────────────────────────────────────────────
// 性能：原来 ~10 次 Serper 调用串行 ≈ 30-60s，现在全并行 ≈ 1-3s（取最慢一路）
async function run() {
  const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const { baseQuery, countryName, category, tld } = data;
  const cc   = countryCode || '';
  const year = new Date().getFullYear();

  // ── Pillar 定义（每个 Pillar 都是一个 Promise，全部同时启动） ──────────────
  //
  // 核心选题原则（采购数据专家视角）：
  //   真正的买家信号强度：进口记录 > 招聘采购岗 > 业务类型(进口商/批发商) > 主动询盘 > 公司自述
  //   所有 query 必须返回"公司官网"URL，而非聚合站/社交媒体（会被垃圾过滤器清除）

  const pillarPromises = {

    // ── P0: 种子库激活（高质量已验证买家） ──────────────────────────────────
    p0_seed: Promise.resolve().then(() => {
      try {
        if (!fs.existsSync('zhimao_seed_intelligence.json')) return [];
        const seeds = JSON.parse(fs.readFileSync('zhimao_seed_intelligence.json', 'utf8'));
        return seeds
          .filter(s =>
            s.country?.toLowerCase() === cc.toLowerCase() &&
            s.category?.toLowerCase().includes(category.toLowerCase())
          )
          .map(s => ({ title: s.company_name, link: s.domain, snippet: 'Seed DB Verified Buyer', pillar: 'Pillar 0 Seed' }));
      } catch { return []; }
    }),

    // ── P1: Google Maps/Places（最可靠买家信号：业务类型注册为进口商/批发商） ─
    // 返回真实公司网站，命中率最高
    p1_maps_dist: fetchPlaces(`${category} wholesaler OR distributor OR importer in ${countryName}`, cc)
      .then(ps => ps
        .filter(p => p.website || p.phoneNumber)
        .map(p => ({ title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber, pillar: 'Pillar 1 LBS', intent_signal: 'MAP_VERIFIED_BUYER' }))
      ),

    p1_maps_trading: fetchPlaces(`${category} trading company OR import export in ${countryName}`, cc)
      .then(ps => ps
        .filter(p => p.website || p.phoneNumber)
        .map(p => ({ title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber, pillar: 'Pillar 1 LBS', intent_signal: 'TRADING_COMPANY' }))
      ),

    // ── P2: 公司官网直接搜索（在目标国TLD下找自述为进口商/批发商的公司） ─────
    // 关键：用 site:.vn 等TLD直接找公司网站，不找聚合站
    p2_direct_importer: searchOrganic(
      `"${category}" (importer OR wholesaler OR distributor) ${tld} -site:alibaba.com -site:made-in-china.com`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 2 Direct', 'SELF_DECLARED_IMPORTER')),

    p2_sourcing_intent: searchOrganic(
      `"${category}" ("we import" OR "we source" OR "our suppliers" OR "looking for supplier" OR "wanted suppliers") ${tld}`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 2 Direct', 'ACTIVE_SOURCING')),

    // ── P3: 采购招聘信号（最可靠的买家信号之一：招采购经理 = 一定在采购）  ────
    // 修复说明：原 site:importyeti.com/volza.com 搜索结果的 URL 都在垃圾名单里
    // 会被 isJunkLead 全部过滤掉（100% Serper 配额浪费）。
    // 改为：搜索目标国公司的采购招聘页面，这类页面在公司官网上，URL 有效。
    p3_jobs_procurement: searchOrganic(
      `"${category}" ("procurement manager" OR "import manager" OR "sourcing manager" OR "purchasing manager") job ${tld}`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 3 Jobs', 'PROCUREMENT_HIRING')),

    p3_jobs_buyer: searchOrganic(
      `"${category}" ("buyer" OR "import buyer" OR "commercial buyer") job hiring ${countryName} -site:linkedin.com -site:glassdoor.com`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 3 Jobs', 'BUYER_HIRING')),

    // ── P4: 主动询盘意图（RFQ / 供应商征集 — 最明确的买家自我标识） ──────────
    p4_rfq: searchOrganic(
      `"${category}" (RFQ OR "request for quotation" OR "request for proposal" OR "tender" OR "供应商征集") ${tld}`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 4 Intent', 'RFQ_POSTED')),

    p4_sourcing_post: searchOrganic(
      `"${category}" ("looking for manufacturers" OR "need factory" OR "sourcing from China" OR "procurement notice") ${countryName}`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 4 Intent', 'SOURCING_POST')),

    // ── P5: 政府采购/招标（机构采购商，预算确定，信号最强） ─────────────────
    p5_tenders: searchOrganic(
      `"${category}" (tender OR RFP OR "request for proposal" OR procurement) (${tld} OR site:.gov.${cc})`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 5 Tenders', 'GOV_PROCUREMENT')),

    // ── P6: 行业协会与进口商目录（结构化来源） ─────────────────────────────
    // 修复说明：原来搜 "exhibitor list"（展商名录）找到的是卖家不是买家。
    // 改为：搜买家参观/注册信息，或进口商协会会员名录
    p6_buyer_assoc: searchOrganic(
      `"${category}" importers association OR buyers club OR "member directory" ${countryName}`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 6 Association', 'ASSOCIATION_MEMBER')),

    p6_trade_show_buyer: searchOrganic(
      `"${category}" ("buyer visitor" OR "visitor registration" OR "trade visitors" OR "buying mission") ${year} ${countryName}`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 6 Association', 'TRADE_SHOW_BUYER')),

    // ── P7: 海关/贸易信号（真实进口行为，数据最权威） ───────────────────────
    // 修复说明：原来 site:importyeti.com 等结果 URL 在垃圾名单被全过滤。
    // 新策略：搜"含海关关键词的公司页面"（返回公司官网，而不是聚合站）
    p7_customs_direct: searchOrganic(
      `"${category}" ("import" OR "importer of record" OR "customs entry" OR "HS code" OR "HTS") ${tld} company`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 7 Customs', 'CUSTOMS_SIGNAL')),

    p7_bol_signal: searchOrganic(
      `"${category}" ("bill of lading" OR "海运提单" OR "شحنة" OR "connaissement") importer "${countryName}"`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 7 Customs', 'BOL_SIGNAL')),

    // ── P8: 电商买家信号（B2B电商平台上的买家侧入口） ────────────────────────
    p8_b2b_buyer: searchOrganic(
      `"${category}" buyer OR "trade buyer" OR "retail buyer" ${countryName} -site:alibaba.com -site:made-in-china.com -site:globalsources.com`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 8 B2B', 'B2B_BUYER')),

    p8_ecommerce_import: searchOrganic(
      `"${category}" ("private label" OR "OEM buyer" OR "contract manufacturing") ${countryName}`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 8 B2B', 'PRIVATE_LABEL')),
  };

  // ── 全并行执行（等最慢的那一路） ──────────────────────────────────────────
  console.log(`[step1] Launching ${Object.keys(pillarPromises).length} pillars in parallel for "${category}" in ${countryName}...`);
  const startedAt = Date.now();

  const results = await Promise.allSettled(Object.values(pillarPromises));
  const labels  = Object.keys(pillarPromises);

  const allLeads = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      console.log(`[step1] ${labels[i]}: ${r.value.length} signals`);
      allLeads.push(...r.value);
    } else if (r.status === 'rejected') {
      console.warn(`[step1] ${labels[i]} failed (non-fatal): ${r.reason?.message || r.reason}`);
    }
  });

  // 注入时间戳
  const nowIso = new Date().toISOString();
  allLeads.forEach(l => { l.source_timestamp = l.source_timestamp || nowIso; });

  // P0 出口过滤：丢弃垃圾域名
  const beforeFilter = allLeads.length;
  const filteredLeads = allLeads.filter(l => !isJunkLead(l));
  const junkCount = beforeFilter - filteredLeads.length;

  // Pillar 分布统计（帮助运营判断哪些渠道质量好）
  const pillarStats = {};
  filteredLeads.forEach(l => { pillarStats[l.pillar] = (pillarStats[l.pillar] || 0) + 1; });

  console.log(`[step1] Done in ${Date.now() - startedAt}ms. Total=${filteredLeads.length} (junk_filtered=${junkCount})`);
  console.log(`[step1] Pillar distribution:`, JSON.stringify(pillarStats, null, 2));

  fs.writeFileSync(outputFile, JSON.stringify(filteredLeads, null, 2));
}

run().catch(e => { console.error('[step1] fatal:', e); process.exit(1); });
