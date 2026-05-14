require('dotenv').config();
const fs    = require('fs');
const https = require('https');

// ── 垃圾域名判断统一从 v8_quality_gate 引入，与 zhimao 主系统保持单源同步 ────
// 不再在此文件维护独立黑名单，避免两处列表漂移浪费 Serper 配额
const { isJunkDomain } = require('./v8_quality_gate');

function isJunkLead(lead) {
  if (!lead || !lead.link) return false;
  try {
    return isJunkDomain(lead.link);
  } catch(_) {}
  return false;
}

const [inputFile, outputFile, countryCode] = process.argv.slice(2);

const API_KEY = process.env.SERPER_API_KEY;
if (!API_KEY) { console.error('[step1] SERPER_API_KEY env var is required'); process.exit(1); }

// ── Deep Paging：由 Cron 传入的第几次扫描，转换为 Serper 搜索页码 ────────────
// sweep 1 → page 1（结果 1-20）
// sweep 2 → page 2（结果 21-40）
// sweep 5 → page 5（结果 81-100，长尾冰山数据）
// 让同一个 [category × country] 网格每次 cron 运行都挖到新数据
const SWEEP_COUNT  = Math.max(1, parseInt(process.env.SWEEP_COUNT || '1', 10));
const SEARCH_PAGE  = SWEEP_COUNT; // 1-based Serper page

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

function searchOrganic(query, gl, num = 20, page = SEARCH_PAGE) {
  // page=1 时不传（Serper 默认），page≥2 时传入实现真正的深水区翻页
  const body = page > 1
    ? { q: query, gl, num, page }
    : { q: query, gl, num };
  return serperPost('/search', body).then(r => r.organic || []);
}

// ─── Lead builders ─────────────────────────────────────────────────────────
function fromOrganic(results, pillar, intent_signal) {
  return results.map(o => ({
    title: o.title, link: o.link, snippet: o.snippet,
    pillar, ...(intent_signal ? { intent_signal } : {}),
  }));
}

// ─── 区域专属数据源注册表（单源加载，避免每次 run() 重读文件）──────────────
let _verifiedSourceRegistry = null;
function getVerifiedSources() {
  if (_verifiedSourceRegistry) return _verifiedSourceRegistry;
  const regPath = 'zhimao_verified_source_registry.json';
  try {
    if (fs.existsSync(regPath)) {
      _verifiedSourceRegistry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    }
  } catch (_) { _verifiedSourceRegistry = { sources: {} }; }
  return _verifiedSourceRegistry || { sources: {} };
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
    // 返回真实公司网站，命中率最高。
    // 深分页策略：Places 不支持 page 参数，改用 query 轮换（SEARCH_PAGE 奇偶 / 不同身份词）
    // 避免每次 cron 重复拉取相同 20 条结果。
    p1_maps_dist: (() => {
      // sweep 偶数：换成 "supplier procurement" 等买家特征词，避免每轮相同 20 条
      const q = SEARCH_PAGE % 2 === 0
        ? `${category} procurement manager OR buyer OR purchasing ${countryName}`
        : `${category} wholesaler OR distributor OR importer in ${countryName}`;
      return fetchPlaces(q, cc).then(ps => ps
        .filter(p => p.website || p.phoneNumber)
        .map(p => ({ title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber, pillar: 'Pillar 1 LBS', intent_signal: 'MAP_VERIFIED_BUYER' }))
      );
    })(),

    p1_maps_trading: (() => {
      const q = SEARCH_PAGE % 2 === 0
        ? `${category} import export agent OR sourcing company ${countryName}`
        : `${category} trading company OR import export in ${countryName}`;
      return fetchPlaces(q, cc).then(ps => ps
        .filter(p => p.website || p.phoneNumber)
        .map(p => ({ title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber, pillar: 'Pillar 1 LBS', intent_signal: 'TRADING_COMPANY' }))
      );
    })(),

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

    // ── P10: 区域专属高壁垒数据源定向搜索 ─────────────────────────────────────
    // 核心护城河：这些来源不是 Google 烂大街结果，而是各国本土商业数据库、
    // 海关系统、政府工商注册表、行业协会名录。
    // 命中这些来源的公司，经过交叉验证后置信度可比普通 Serper 搜索高 15-40 点。
    p10_verified_sources: Promise.resolve().then(() => {
      const registry = getVerifiedSources();
      const allSourceGroups = Object.values(registry.sources || {});
      const allSources = allSourceGroups.flat();

      // 只取覆盖当前国家的来源，最多选 4 个（避免 Serper 配额超限）
      const applicableSources = allSources
        .filter(src => Array.isArray(src.countries) && src.countries.includes(cc))
        .sort((a, b) => (b.source_confidence_boost || 0) - (a.source_confidence_boost || 0))
        .slice(0, 4);

      if (applicableSources.length === 0) return [];

      // 对每个适用的来源并发发起定向搜索
      return Promise.all(
        applicableSources.map(src => {
          // 把 search_strategy 模板里的 ${category} 替换为实际品类
          const q = (src.search_strategy || `site:${src.domain} "${category}"`)
            .replace(/\$\{category\}/g, category)
            .replace(/\$\{countryName\}/g, countryName);

          return searchOrganic(q, cc, 20).then(r =>
            r.map(o => ({
              ...o,
              pillar:                  'Pillar 10 VerifiedSource',
              intent_signal:           src.intent_signals?.[0] || 'VERIFIED_SOURCE',
              verified_source_id:      src.id,
              verified_source_domain:  src.domain,
              verified_source_boost:   src.source_confidence_boost || 0,
            }))
          ).catch(() => []);
        })
      ).then(arrs => arrs.flat());
    }),

    // ── P11: LinkedIn 采购决策人 X 光透视 ────────────────────────────────────
    // 设计逻辑：LinkedIn URL 在垃圾名单里会被域名过滤器过滤，所以不能直接用 LinkedIn URL。
    // 改为：搜 LinkedIn 职位页/公司页，仅从 snippet 中提取【公司名+采购头衔】信号
    // 由 Step2 LLM 的 extractCompanyFromSnippet 负责从 snippet 里抽公司名。
    // 最终 lead.domain 不是 linkedin.com，而是 Step2 推断出的空域名（待 Step3 补全）。
    p11_linkedin_decision: searchOrganic(
      `site:linkedin.com/in "${category}" ("Procurement Director" OR "Category Manager" OR "Sourcing Manager" OR "Import Manager" OR "Head of Purchasing") ${countryName}`,
      cc, 20
    ).then(r => r.map(o => ({
      title:         o.title,
      link:          null,           // 不传 linkedin URL，避免被垃圾过滤器清除
      snippet:       o.snippet,      // snippet 里有公司名和职位，供 Step2 LLM 提取
      pillar:        'Pillar 11 LinkedIn',
      intent_signal: 'PROCUREMENT_DECISION_MAKER',
      source_url:    o.link,         // 保留原始 URL 供溯源，但不作为公司 domain
    }))),

    // ── P9: Lookalike 裂变（种子反哺闭环核心）────────────────────────────────
    // 设计逻辑：
    //   Pillar0 把种子激活为 lead → Step5 把高置信 lead 写回 seed JSON
    //   → 下轮 Pillar9 用新种子搜"它的竞品是谁/同行是谁" → 找到同生态位买家
    // 这形成了一个"越用越深，自动扩网"的闭环。
    p9_lookalike: Promise.resolve().then(() => {
      const SEED_PATH = 'zhimao_seed_intelligence.json';
      try {
        if (!fs.existsSync(SEED_PATH)) return [];
        const seeds = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
        // 只取本国 + 本品类相关的种子，随机挑最多 3 个做 Lookalike 查询（避免 Serper 超额）
        const relevant = seeds.filter(s =>
          s.country?.toLowerCase() === cc.toLowerCase() &&
          (!s.category || s.category.toLowerCase().includes(category.toLowerCase().split(' ')[0]))
        ).slice(0, 3);
        if (relevant.length === 0) return [];

        // 对每个种子并发搜它的竞品和同类公司
        return Promise.all(
          relevant.map(seed =>
            searchOrganic(
              `"${category}" companies like "${seed.company_name}" OR competitors "${seed.company_name}" ${countryName} importer wholesaler`,
              cc, 20
            ).then(r => r.map(o => ({
              ...o, pillar: 'Pillar 9 Lookalike',
              intent_signal: 'LOOKALIKE', seed_company: seed.company_name,
            })))
          )
        ).then(arrs => arrs.flat());
      } catch { return []; }
    }),
  };

  // ── 全并行执行（等最慢的那一路） ──────────────────────────────────────────
  const depthLabel = SEARCH_PAGE === 1 ? '浅层(p1)' : `深水区(p${SEARCH_PAGE} ≈ 第${(SEARCH_PAGE-1)*20+1}-${SEARCH_PAGE*20}条)`;
  console.log(`[step1] Launching ${Object.keys(pillarPromises).length} pillars in parallel for "${category}" in ${countryName} [${depthLabel}]...`);
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
