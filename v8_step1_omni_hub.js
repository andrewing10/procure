require('./load-env');
const fs    = require('fs');
const https = require('https');

// ── 垃圾域名判断统一从 v8_quality_gate 引入，与 zhimao 主系统保持单源同步 ────
// 不再在此文件维护独立黑名单，避免两处列表漂移浪费 Serper 配额
const { isJunkDomain } = require('./v8_quality_gate');
const {
  readMatrixFromEnv,
  resolveCitiesForRun,
  isPlatformEnabled,
  readIndustryHintFromEnv,
  getIndustryAnchor,
} = require('./v8_constants_geo');
const { extractSocialUrlsFromText } = require('./v8_lib_social_extract');
const { getIndustryHint, DEFAULT_PLACE_BLACKLIST } = require('./v8_icp_taxonomy');

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

const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// ── Deep Paging：由 Cron 传入的第几次扫描，转换为 Serper 搜索页码 ────────────
// sweep 1 → page 1（结果 1-20）
// sweep 2 → page 2（结果 21-40）
// sweep 5 → page 5（结果 81-100，长尾冰山数据）
// 让同一个 [category × country] 网格每次 cron 运行都挖到新数据
const SWEEP_COUNT  = Math.max(1, parseInt(process.env.SWEEP_COUNT || '1', 10));
const SEARCH_PAGE  = SWEEP_COUNT; // 1-based Serper page

function loadReweightControls() {
  const raw = process.env.DISCOVERY_REWEIGHT_JSON || '[]';
  let items = [];
  try { items = JSON.parse(raw); } catch { items = []; }

  const sum = (kind) => (Array.isArray(items) ? items
    .filter(x => String(x?.source_kind || '').toLowerCase() === kind)
    .reduce((acc, x) => acc + Number(x?.weight_delta || 0), 0) : 0);

  const geo      = sum('geo');
  const entity   = sum('entity');
  const contact  = sum('contact');
  const generic  = sum('generic');
  const staleness = sum('staleness');

  // 硬禁用检查（channel_disabled=true 时直接 disable）
  const isHardDisabled = (kind) => Array.isArray(items) && items
    .filter(x => String(x?.source_kind || '').toLowerCase() === kind)
    .some(x => x?.channel_disabled === true);

  // 合并多行域名黑名单（V8 step2 直接过滤 host）
  const domainBlacklist = Array.isArray(items)
    ? [...new Set(items.flatMap(x => Array.isArray(x?.domain_blacklist) ? x.domain_blacklist : []))]
    : [];

  // 合并关键词抑制列表（V8 step0 查询翻译时排除这些词）
  const keywordSuppress = Array.isArray(items)
    ? [...new Set(items.flatMap(x => Array.isArray(x?.keyword_suppress) ? x.keyword_suppress : []))]
    : [];

  // 计算各渠道权重分（0-1），用于动态调整抓取优先级
  // 基准 1.0，负向信号降低，正向信号提升，硬禁用强制 0
  const channelWeight = (kind, base = 1.0) => {
    if (isHardDisabled(kind)) return 0;
    const delta = sum(kind);
    // 线性映射：delta=-0.3 → weight=0.1, delta=0 → 1.0, delta=+0.15 → 1.5
    return Math.max(0, Math.min(2.0, base + delta * 3));
  };

  return {
    // 原有布尔控制（向后兼容）
    geo, entity, contact, generic,
    disableLinkedin:  isHardDisabled('entity') || entity <= -0.05,
    disableLookalike: isHardDisabled('generic') || generic <= -0.08,
    enforceGeo:       isHardDisabled('geo') || geo <= -0.05,
    // 新增：渠道权重（0=禁用, 1=正常, >1=加权）
    weights: {
      geo:       channelWeight('geo'),
      entity:    channelWeight('entity'),
      contact:   channelWeight('contact'),
      generic:   channelWeight('generic'),
      staleness: channelWeight('staleness'),
    },
    // 新增：时效性加强（数据陈旧投诉时，强制加年份过滤）
    enforceRecency: isHardDisabled('staleness') || staleness <= -0.06,
    // 新增：域名黑名单（直接传给 step2）
    domainBlacklist,
    // 新增：关键词抑制（传给 step0 翻译器）
    keywordSuppress,
    // 调试用：原始策略行数
    _policyCount: Array.isArray(items) ? items.length : 0,
  };
}

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

// ─── Google Places API（原生，优先于 Serper /places）──────────────────────
// Text Search → Place Details（补电话+官网），最多 20 条，并发限 5 个 Details
// 失败静默降级：返回 [] 触发 Serper /places 兜底
function httpsGet(url) {
  return new Promise(resolve => {
    https.get(url, r => {
      let data = ''; r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    }).on('error', () => resolve({}));
  });
}

async function fetchGooglePlacesNative(query, gl) {
  if (!GMAPS_KEY) return null; // 无 key，触发 Serper 兜底

  const tsUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json`
    + `?query=${encodeURIComponent(query)}`
    + `&region=${gl.toLowerCase()}`
    + `&key=${GMAPS_KEY}`;
  const tsRes = await httpsGet(tsUrl).catch(() => ({}));
  if (tsRes.status !== 'OK' || !Array.isArray(tsRes.results) || tsRes.results.length === 0) return null;

  const raw = tsRes.results.slice(0, 20);
  const detailFields = 'name,formatted_address,formatted_phone_number,website,business_status,rating,user_ratings_total';

  // 并发最多 5 个 Place Details（保持在 Google QPS 内）
  const pLimit = 5;
  const enriched = [];
  for (let i = 0; i < raw.length; i += pLimit) {
    const batch = raw.slice(i, i + pLimit);
    const details = await Promise.all(batch.map(async p => {
      if (!p.place_id) return p;
      const dtUrl = `https://maps.googleapis.com/maps/api/place/details/json`
        + `?place_id=${encodeURIComponent(p.place_id)}`
        + `&fields=${detailFields}`
        + `&key=${GMAPS_KEY}`;
      const dt = await httpsGet(dtUrl).catch(() => ({}));
      if (dt.status === 'OK' && dt.result) return { ...p, ...dt.result };
      return p;
    }));
    enriched.push(...details);
  }
  return enriched;
}

/**
 * Batch A.4：根据 industry_hint.place_type_blacklist 把 Google Places 的 types 过滤掉。
 * Native API 才有 types 字段；Serper /places 没有 → 走 Native 时才生效。
 */
function filterByPlaceTypeBlacklist(placesRaw, blacklist) {
  if (!Array.isArray(placesRaw) || placesRaw.length === 0) return placesRaw;
  if (!Array.isArray(blacklist) || blacklist.length === 0) return placesRaw;
  const blk = new Set(blacklist.map((s) => String(s || '').toLowerCase()));
  return placesRaw.filter((p) => {
    const types = Array.isArray(p.types) ? p.types : [];
    if (types.length === 0) return true; // 无 types 时不过滤（避免误杀 Serper 兜底）
    for (const t of types) {
      if (blk.has(String(t || '').toLowerCase())) return false;
    }
    return true;
  });
}

// P1 Pillar 专用：先走 Google Places 原生，失败回 Serper /places
async function fetchPlacesWithFallback(query, gl, placeTypeBlacklist) {
  const native = await fetchGooglePlacesNative(query, gl).catch(() => null);
  if (native && native.length > 0) {
    const filtered = filterByPlaceTypeBlacklist(native, placeTypeBlacklist || []);
    return filtered.map(p => ({
      title:       p.name || '',
      website:     p.website || '',
      phoneNumber: p.formatted_phone_number || '',
      address:     p.formatted_address || p.vicinity || '',
      rating:      p.rating,
      business_status: p.business_status,
      // 买家抓取矩阵（Batch 3）：新增 maps_url / place_id 直透到 lead，
      // Step5 → buildL1Row 据此写 data_intel_l1_companies.maps_url / place_id 列
      place_id:    p.place_id || null,
      maps_url:    p.place_id ? `https://www.google.com/maps/place/?q=place_id:${p.place_id}` : null,
      _source: 'google_places_native',
    }));
  }
  // Serper 兜底（无 place_id；maps_url 留空给前端按需生成）
  return fetchPlaces(query, gl).then(arr => arr.map((p) => ({ ...p, place_id: p.place_id || null, maps_url: p.maps_url || null })));
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
  const controls = loadReweightControls();
  console.log('[step1] reweight controls:', JSON.stringify(controls));

  // ── 买家抓取矩阵（Batch 3）：解析 PILLAR0_PAYLOAD.matrix ──────────────────
  // matrix.cities       → maps 类 pillar 多城市循环（空=按国家级 query 兼容老路径）
  // matrix.platforms    → 6 平台 pillar 启停白名单（空=全开）
  // matrix.deepAllCities→ true 时 cities 空 + 国家有主要城市表 → 自动展开 5 城
  const matrix = readMatrixFromEnv();
  const mapsCities = resolveCitiesForRun(cc, matrix);
  if (matrix) {
    console.log(`[step1] matrix: cities=[${(matrix.cities || []).join('|')}] effective=[${mapsCities.join('|')}] platforms=[${(matrix.platforms || []).join('|')}] deepAll=${matrix.deepAllCities}`);
  }

  // ── Batch A.4：ICP 业态 hint（zhimao submit 注入；缺失则从 category 兜底）─
  // 用于：Google Places types 黑名单过滤 + 写到 lead.industry_hint 透传到 step2 prompt
  let industryHint = readIndustryHintFromEnv();
  if (!industryHint) {
    try { industryHint = getIndustryHint(category); }
    catch (_) { industryHint = null; }
  }
  const placeTypeBlacklist = (industryHint && industryHint.place_type_blacklist)
    ? industryHint.place_type_blacklist
    : DEFAULT_PLACE_BLACKLIST;
  if (industryHint) {
    console.log(
      `[step1] industry_hint: category_key=${industryHint.category_key} ` +
      `industry_key=${industryHint.industry_key || '-'} ` +
      `blacklist=[${placeTypeBlacklist.slice(0, 4).join(',')}…] hit=${industryHint.hit}`,
    );
  }

  // ── Batch D.1：业态 anchor 词（map_retrieval_segments 派生）──────────────────
  // 命中字典（industry_key/category_key/segment_id）时，step1 的 P1/P3/P11/P_*
  // pillar 把"trading company / procurement manager"这种泛词替换为业态精准 anchor，
  // 显著提升 industry_match=high 比例（验收金标线：基线 ~30% → ≥70%）。
  // 不命中时 anchor=null，pillar 退化为旧泛词路径，保持向后兼容。
  // 查询顺序：industry_key → category_key → 原始品类（容忍用户传中文）
  let industryAnchor = null;
  try {
    const tries = [];
    if (industryHint) {
      if (industryHint.industry_key) tries.push(industryHint.industry_key);
      if (industryHint.category_key && industryHint.category_key !== 'other') tries.push(industryHint.category_key);
    }
    tries.push(category);
    for (const k of tries) {
      const a = getIndustryAnchor(k);
      if (a) { industryAnchor = a; break; }
    }
  } catch (_) {
    industryAnchor = null;
  }
  if (industryAnchor) {
    console.log(
      `[step1] industry_anchor segment=${industryAnchor.segment_id} ` +
      `en=[${industryAnchor.en.slice(0, 3).join(',')}…] zh=[${industryAnchor.zh.slice(0, 3).join(',')}…]`,
    );
  }
  // 取主 anchor（首选 EN，作为 P1 maps / P3 jobs / P11 LinkedIn 的核心 query 词）
  const anchorPrimary = industryAnchor && industryAnchor.en[0] ? industryAnchor.en[0] : '';
  const anchorAlt     = industryAnchor && industryAnchor.en[1] ? industryAnchor.en[1] : '';
  const anchorAll     = industryAnchor ? [...industryAnchor.en, ...industryAnchor.zh].slice(0, 6) : [];

  // ── Pillar 定义（每个 Pillar 都是一个 Promise，全部同时启动） ──────────────
  //
  // 核心选题原则（采购数据专家视角）：
  //   真正的买家信号强度：进口记录 > 招聘采购岗 > 业务类型(进口商/批发商) > 主动询盘 > 公司自述
  //   所有 query 必须返回"公司官网"URL，而非聚合站/社交媒体（会被垃圾过滤器清除）

  const pillarPromises = {

    // ── P0: 种子库激活（高质量已验证买家 + DB pending seeds） ─────────────────
    // 1) 本地 zhimao_seed_intelligence.json：经营级别一致性的离线种子
    // 2) Supabase discovery_seeds：业务员主动喂入的 FB 小组 / 公司主页 URL（Batch 4）
    //    pending 种子按 (country_iso, category) 匹配后转为 lead；procure 在 Step5 后由
    //    finalize 路径将 status 标记为 consumed（避免 Step1 内重复跑 query 而 mark 过早）。
    p0_seed: (async () => {
      const out = [];
      try {
        if (fs.existsSync('zhimao_seed_intelligence.json')) {
          const seeds = JSON.parse(fs.readFileSync('zhimao_seed_intelligence.json', 'utf8'));
          for (const s of seeds) {
            if (s.country?.toLowerCase() === cc.toLowerCase() &&
                s.category?.toLowerCase().includes(category.toLowerCase())) {
              out.push({ title: s.company_name, link: s.domain, snippet: 'Seed DB Verified Buyer', pillar: 'Pillar 0 Seed' });
            }
          }
        }
      } catch (_) { /* local seed missing is fine */ }

      // 仅当 worker 已注入 SUPABASE 凭证时拉取 DB pending 种子
      const supaUrl = process.env.SUPABASE_URL || '';
      const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
      if (supaUrl && supaKey) {
        try {
          const { createClient } = require('@supabase/supabase-js');
          const supa = createClient(supaUrl, supaKey, { auth: { persistSession: false } });
          let q = supa.from('discovery_seeds').select('id,url,seed_type,country_iso,category').eq('status', 'pending');
          if (cc) q = q.or(`country_iso.is.null,country_iso.eq.${cc.toUpperCase()}`);
          const { data: pending, error } = await q.limit(50);
          if (!error && Array.isArray(pending)) {
            const catLower = category.toLowerCase();
            for (const s of pending) {
              const sc = String(s.category || '').toLowerCase();
              if (sc && !sc.includes(catLower)) continue; // 与本任务品类不相关则跳过（保留 pending）
              out.push({
                title: s.url,
                link: s.url,
                snippet: `User-supplied seed (${s.seed_type})`,
                pillar: 'Pillar 0 Seed',
                intent_signal: 'USER_SEED',
                _seed_id: s.id,
              });
            }
            // 标记 consumed：worker 再次启动同条件任务时不会重复入队
            const consumeIds = pending
              .filter((s) => {
                const sc = String(s.category || '').toLowerCase();
                return !sc || sc.includes(category.toLowerCase());
              })
              .map((s) => s.id);
            if (consumeIds.length > 0) {
              await supa.from('discovery_seeds')
                .update({ status: 'consumed', consumed_at: new Date().toISOString(), job_id: process.env.DISCOVERY_JOB_ID || null })
                .in('id', consumeIds);
              console.log(`[step1] p0_seed: consumed ${consumeIds.length} discovery_seeds rows for ${cc}/${category}`);
            }
          }
        } catch (e) {
          console.warn('[step1] p0_seed: supabase fetch failed (non-fatal):', e?.message || e);
        }
      }
      return out;
    })(),

    // ── P1: Google Maps/Places（最可靠买家信号：业务类型注册为进口商/批发商） ─
    // 返回真实公司网站，命中率最高。
    // 深分页策略：Places 不支持 page 参数，改用 query 轮换（SEARCH_PAGE 奇偶 / 不同身份词）
    // 避免每次 cron 重复拉取相同 20 条结果。
    // 买家抓取矩阵（Batch 3）：mapsCities 非空时多城市循环并合并去重（按 place_id）。
    p1_maps_dist: (async () => {
      const buildQ = (city) => {
        // Batch D.1：命中 anchor 时把"procurement manager OR buyer"换成业态精准 anchor，
        // 例：anchor='wholesale cosmetics' → 直接用，避免泛词把金融/咨询拉回结果集。
        const anchorTerm = anchorPrimary
          ? (SEARCH_PAGE % 2 === 0 ? anchorPrimary : (anchorAlt || anchorPrimary))
          : (SEARCH_PAGE % 2 === 0
              ? 'procurement manager OR buyer OR purchasing'
              : 'wholesaler OR distributor OR importer');
        return city ? `${category} ${anchorTerm} "${city}" ${countryName}` : `${category} ${anchorTerm} ${countryName}`;
      };
      const queries = mapsCities.length > 0
        ? mapsCities.map((city) => ({ city, q: buildQ(city) }))
        : [{ city: null, q: buildQ(null) }];
      const arrs = await Promise.all(queries.map(({ city, q }) =>
        fetchPlacesWithFallback(q, cc, placeTypeBlacklist).then((ps) => ps.map((p) => ({ ...p, _city: city })))
      ));
      const seen = new Set();
      return arrs.flat()
        .filter((p) => p.website || p.phoneNumber)
        .filter((p) => {
          const k = (p.place_id || p.website || `${p.title}|${p.address}`).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k); return true;
        })
        .map((p) => ({
          title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber,
          pillar: 'Pillar 1 LBS', intent_signal: 'MAP_VERIFIED_BUYER',
          _gmaps_source: p._source || 'serper_places',
          _city: p._city || null, maps_url: p.maps_url || null, place_id: p.place_id || null,
        }));
    })(),

    p1_maps_trading: (async () => {
      const buildQ = (city) => {
        // Batch D.1：anchor 命中时把"trading company OR import export"换成业态词；
        // 同行抓取"印尼大蒜"案例的核心病灶就是这段把所有印尼商号拉回来。
        const anchorTerm = anchorPrimary
          ? `(${anchorPrimary}${anchorAlt ? ` OR ${anchorAlt}` : ''})`
          : (SEARCH_PAGE % 2 === 0
              ? 'import export agent OR sourcing company'
              : 'trading company OR import export');
        return city ? `${category} ${anchorTerm} "${city}" ${countryName}` : `${category} ${anchorTerm} in ${countryName}`;
      };
      const queries = mapsCities.length > 0
        ? mapsCities.map((city) => ({ city, q: buildQ(city) }))
        : [{ city: null, q: buildQ(null) }];
      const arrs = await Promise.all(queries.map(({ city, q }) =>
        fetchPlacesWithFallback(q, cc, placeTypeBlacklist).then((ps) => ps.map((p) => ({ ...p, _city: city })))
      ));
      const seen = new Set();
      return arrs.flat()
        .filter((p) => p.website || p.phoneNumber)
        .filter((p) => {
          const k = (p.place_id || p.website || `${p.title}|${p.address}`).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k); return true;
        })
        .map((p) => ({
          title: p.title, link: p.website, snippet: p.address, phone: p.phoneNumber,
          pillar: 'Pillar 1 LBS', intent_signal: 'TRADING_COMPANY',
          _gmaps_source: p._source || 'serper_places',
          _city: p._city || null, maps_url: p.maps_url || null, place_id: p.place_id || null,
        }));
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
      // Batch D.1：把 anchor 词加进 query，避免"procurement manager"拉到金融/IT 招聘
      anchorPrimary
        ? `"${anchorPrimary}" "procurement manager" OR "category manager" OR "buyer" job ${tld}`
        : `"${category}" ("procurement manager" OR "import manager" OR "sourcing manager" OR "purchasing manager") job ${tld}`,
      cc
    ).then(r => fromOrganic(r, 'Pillar 3 Jobs', 'PROCUREMENT_HIRING')),

    p3_jobs_buyer: searchOrganic(
      anchorPrimary
        ? `"${anchorPrimary}" buyer job hiring ${countryName} -site:linkedin.com -site:glassdoor.com`
        : `"${category}" ("buyer" OR "import buyer" OR "commercial buyer") job hiring ${countryName} -site:linkedin.com -site:glassdoor.com`,
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
      // Batch D.1：LinkedIn 决策人查询用 anchor 替代品类原文，让 LinkedIn 的语义匹配
      // 落到具体行业（"wholesale cosmetics" 比 "护肝片" 更易命中决策人 profile）
      anchorPrimary
        ? `site:linkedin.com/in "${anchorPrimary}" ("Procurement Director" OR "Category Manager" OR "Sourcing Manager" OR "Head of Purchasing") ${countryName}`
        : `site:linkedin.com/in "${category}" ("Procurement Director" OR "Category Manager" OR "Sourcing Manager" OR "Import Manager" OR "Head of Purchasing") ${countryName}`,
      cc, 20
    ).then(r => r.map(o => ({
      title:         o.title,
      link:          null,           // 不传 linkedin URL，避免被垃圾过滤器清除
      snippet:       o.snippet,      // snippet 里有公司名和职位，供 Step2 LLM 提取
      pillar:        'Pillar 11 LinkedIn',
      intent_signal: 'PROCUREMENT_DECISION_MAKER',
      source_url:    o.link,         // 保留原始 URL 供溯源，但不作为公司 domain
    }))),

    // ── 买家抓取矩阵 P_Y / P_FB / P_YT / P_X（Batch 3 新增） ─────────────────
    // 4 个平台 pillar 通过 site: 限定走公开 snippet，绝不登录态抓取；
    // matrix.platforms 为空时全开，含枚举值时仅启用对应平台。
    p_yellowpages: (async () => {
      const cityClause = mapsCities.length > 0 ? ` ("${mapsCities.slice(0, 3).join('" OR "')}")` : '';
      // Batch D.1：anchor 命中时把品类原文换成业态短语，避免黄页站把无关行业拉进来
      const subject = anchorPrimary ? `"${anchorPrimary}"` : `"${category}"`;
      const q = `(site:yellowpages.com OR site:yelp.com OR site:europages.com OR site:kompass.com) ${subject} ${countryName}${cityClause}`;
      const r = await searchOrganic(q, cc, 20);
      return r.map((o) => ({
        title: o.title, link: o.link, snippet: o.snippet,
        pillar: 'Pillar Yellow', intent_signal: 'YP_LISTING',
      }));
    })(),

    p_facebook_public: (async () => {
      const cityClause = mapsCities.length > 0 ? ` ("${mapsCities.slice(0, 3).join('" OR "')}")` : '';
      const subject = anchorPrimary ? `"${anchorPrimary}"` : `"${category}"`;
      const q = `site:facebook.com ${subject} (buyer OR distributor OR importer OR wholesale) ${countryName}${cityClause}`;
      const r = await searchOrganic(q, cc, 20);
      return r.map((o) => ({
        title: o.title, link: null, snippet: o.snippet,
        pillar: 'Pillar FB Public', intent_signal: 'FB_PUBLIC_PROFILE',
        source_url: o.link,
        // 公开主页 URL 直接挂到 lead.social_profile_urls，Step5 写入 L1 列
        social_profile_urls: extractSocialUrlsFromText(o.link, o.snippet),
      }));
    })(),

    p_youtube_about: (async () => {
      const subject = anchorPrimary ? `"${anchorPrimary}"` : `"${category}"`;
      const q = `site:youtube.com (inurl:about OR inurl:c OR inurl:@) ${subject} (company OR brand OR official) ${countryName}`;
      const r = await searchOrganic(q, cc, 20);
      return r.map((o) => ({
        title: o.title, link: null, snippet: o.snippet,
        pillar: 'Pillar YT About', intent_signal: 'YT_ABOUT',
        source_url: o.link,
        social_profile_urls: extractSocialUrlsFromText(o.link, o.snippet),
      }));
    })(),

    p_x_public: (async () => {
      const subject = anchorPrimary ? `"${anchorPrimary}"` : `"${category}"`;
      const q = `(site:x.com OR site:twitter.com) ${subject} (buyer OR import OR procurement) ${countryName}`;
      const r = await searchOrganic(q, cc, 20);
      return r.map((o) => ({
        title: o.title, link: null, snippet: o.snippet,
        pillar: 'Pillar X Public', intent_signal: 'X_PUBLIC',
        source_url: o.link,
        social_profile_urls: extractSocialUrlsFromText(o.link, o.snippet),
      }));
    })(),

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

  if (controls.disableLinkedin) {
    delete pillarPromises.p11_linkedin_decision;
    console.log('[step1] LinkedIn pillar DISABLED by reweight policy (entity delta=' + controls.entity.toFixed(3) + ')');
  }
  if (controls.disableLookalike) {
    delete pillarPromises.p9_lookalike;
    console.log('[step1] Lookalike pillar DISABLED by reweight policy (generic delta=' + controls.generic.toFixed(3) + ')');
  }

  // 买家抓取矩阵：6 平台白名单启停（matrix.platforms 为空 → 全开）
  if (matrix && Array.isArray(matrix.platforms) && matrix.platforms.length > 0) {
    if (!isPlatformEnabled(matrix, 'maps')) {
      delete pillarPromises.p1_maps_dist;
      delete pillarPromises.p1_maps_trading;
    }
    if (!isPlatformEnabled(matrix, 'yellowpages'))      delete pillarPromises.p_yellowpages;
    if (!isPlatformEnabled(matrix, 'facebook_public'))  delete pillarPromises.p_facebook_public;
    if (!isPlatformEnabled(matrix, 'linkedin_snippet')) delete pillarPromises.p11_linkedin_decision;
    if (!isPlatformEnabled(matrix, 'youtube_about'))    delete pillarPromises.p_youtube_about;
    if (!isPlatformEnabled(matrix, 'x_public'))         delete pillarPromises.p_x_public;
    console.log(`[step1] matrix.platforms whitelist applied: kept=${Object.keys(pillarPromises).filter(k => /^(p1_maps|p_|p11_)/.test(k)).join('|')}`);
  }

  // ── 全并行执行（等最慢的那一路） ──────────────────────────────────────────
  const depthLabel = SEARCH_PAGE === 1 ? '浅层(p1)' : `深水区(p${SEARCH_PAGE} ≈ 第${(SEARCH_PAGE-1)*20+1}-${SEARCH_PAGE*20}条)`;
  console.log(`[step1] Launching ${Object.keys(pillarPromises).length} pillars in parallel for "${category}" in ${countryName} [${depthLabel}]...`);
  if (controls._policyCount > 0) {
    console.log(`[step1] Active policies: ${controls._policyCount}, weights:`, JSON.stringify(controls.weights));
  }
  if (controls.domainBlacklist.length > 0) {
    console.log(`[step1] Domain blacklist (${controls.domainBlacklist.length}): ${controls.domainBlacklist.slice(0, 5).join(', ')}...`);
  }
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

  // P0 出口过滤：丢弃垃圾域名 + 策略域名黑名单 + 地理过滤
  const beforeFilter = allLeads.length;
  // 构建策略域名黑名单 Set（O(1) 查找）
  const blacklistSet = new Set(controls.domainBlacklist.map(d => d.toLowerCase()));

  let filteredLeads = allLeads.filter(l => {
    if (isJunkLead(l)) return false;
    // 策略域名黑名单过滤
    if (blacklistSet.size > 0 && l.link) {
      try {
        const host = new URL(l.link).hostname.toLowerCase().replace(/^www\./, '');
        if (blacklistSet.has(host)) return false;
      } catch { /* ignore */ }
    }
    return true;
  });

  if (controls.enforceGeo) {
    const countryHint = String(countryName || '').toLowerCase();
    const beforeGeo = filteredLeads.length;
    filteredLeads = filteredLeads.filter((l) => {
      const combined = `${l.title || ''} ${l.snippet || ''} ${l.link || ''}`.toLowerCase();
      return combined.includes(countryHint) || combined.includes(`.${cc.toLowerCase()}`);
    });
    console.log(`[step1] Geo filter (enforced): ${beforeGeo} → ${filteredLeads.length} (removed ${beforeGeo - filteredLeads.length} geo-mismatched)`);
  }

  // 时效性过滤：数据陈旧投诉时，过滤掉明显旧数据（标题/摘要中含 3 年前年份）
  if (controls.enforceRecency) {
    const currentYear = new Date().getFullYear();
    const staleYearRe = new RegExp(`\\b(${currentYear - 3}|${currentYear - 4}|${currentYear - 5})\\b`);
    const beforeRecency = filteredLeads.length;
    filteredLeads = filteredLeads.filter(l => {
      const combined = `${l.title || ''} ${l.snippet || ''}`;
      return !staleYearRe.test(combined);
    });
    if (beforeRecency > filteredLeads.length) {
      console.log(`[step1] Recency filter (enforced): removed ${beforeRecency - filteredLeads.length} stale results`);
    }
  }

  const junkCount = beforeFilter - filteredLeads.length;

  // Pillar 分布统计（帮助运营判断哪些渠道质量好）
  const pillarStats = {};
  filteredLeads.forEach(l => { pillarStats[l.pillar] = (pillarStats[l.pillar] || 0) + 1; });

  console.log(`[step1] Done in ${Date.now() - startedAt}ms. Total=${filteredLeads.length} (junk_filtered=${junkCount})`);
  console.log(`[step1] Pillar distribution:`, JSON.stringify(pillarStats, null, 2));

  fs.writeFileSync(outputFile, JSON.stringify(filteredLeads, null, 2));
}

run().catch(e => { console.error('[step1] fatal:', e); process.exit(1); });
