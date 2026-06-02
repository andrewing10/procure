/**
 * 与 zhimao apps/web/lib/discovery/matrixDefaults.ts 同源的国家→主要城市字典。
 * Step1 在 matrix.cities 为空且 matrix.deep_search_all_cities=true 时按本表展开多城市扫描。
 * 改动时请同步 zhimao 端，避免「前端勾的城市，worker 收不到」的漂移。
 */
const MAJOR_CITIES = {
  US: ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix'],
  GB: ['London', 'Birmingham', 'Manchester', 'Leeds', 'Bristol'],
  DE: ['Berlin', 'Hamburg', 'Munich', 'Frankfurt', 'Cologne'],
  FR: ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Bordeaux'],
  JP: ['Tokyo', 'Osaka', 'Nagoya', 'Sapporo', 'Fukuoka'],
  KR: ['Seoul', 'Busan', 'Incheon', 'Daegu', 'Daejeon'],
  IN: ['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Hyderabad'],
  AU: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide'],
  CA: ['Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa'],
  BR: ['São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Curitiba', 'Porto Alegre'],
  MX: ['Mexico City', 'Guadalajara', 'Monterrey', 'Puebla', 'Tijuana'],
  AE: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah'],
  SA: ['Riyadh', 'Jeddah', 'Dammam', 'Mecca', 'Medina'],
  TH: ['Bangkok', 'Chiang Mai', 'Phuket', 'Pattaya', 'Khon Kaen'],
  MY: ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Ipoh', 'Kota Kinabalu'],
  SG: ['Singapore'],
  ID: ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Semarang'],
  VN: ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Can Tho'],
  PH: ['Manila', 'Cebu', 'Davao', 'Quezon City', 'Makati'],
  TR: ['Istanbul', 'Ankara', 'Izmir', 'Bursa', 'Adana'],
  PL: ['Warsaw', 'Krakow', 'Lodz', 'Wroclaw', 'Poznan'],
  ZA: ['Johannesburg', 'Cape Town', 'Durban', 'Pretoria', 'Port Elizabeth'],
  NG: ['Lagos', 'Abuja', 'Kano', 'Ibadan', 'Port Harcourt'],
  EG: ['Cairo', 'Alexandria', 'Giza', 'Shubra El-Kheima', 'Port Said'],
  AR: ['Buenos Aires', 'Córdoba', 'Rosario', 'Mendoza', 'La Plata'],
  CL: ['Santiago', 'Valparaíso', 'Concepción', 'Antofagasta', 'Viña del Mar'],
  CO: ['Bogotá', 'Medellín', 'Cali', 'Barranquilla', 'Cartagena'],
  PE: ['Lima', 'Arequipa', 'Trujillo', 'Chiclayo', 'Piura'],
  CN: ['Shanghai', 'Guangzhou', 'Shenzhen', 'Beijing', 'Chengdu'],
  TW: ['Taipei', 'Kaohsiung', 'Taichung', 'Tainan', 'Hsinchu'],
  HK: ['Hong Kong'],
  MO: ['Macau'],
};

/** 抓取矩阵支持的平台（Pillar 映射见 zhimao 仓 PLATFORM_PILLAR_MAP.md）。
 *
 * 2026-05-26 加 telegram_public（Telegram 融入数据通道 · 批次 T-A 双仓同步）：
 *   - 与 zhimao apps/web/lib/discovery/matrixDefaults.ts KNOWN_PLATFORMS 严格一致；
 *   - 任一仓单独加 = 前端能选但 worker 跑空（假按钮）；
 *   - pillar 实现见 v8_step1_omni_hub.js p_telegram_public；
 *   - discovered_via 映射见 v8_direct_l1_ingest.js inferDiscoveredVia。
 */
const KNOWN_PLATFORMS = [
  'maps',
  'yellowpages',
  'facebook_public',
  'linkedin_snippet',
  'youtube_about',
  'x_public',
  'telegram_public',
];

/**
 * 从 PILLAR0_PAYLOAD（worker 注入的 action_payload 整体）解析出 matrix。
 * 返回的形状与 zhimao sanitizeMatrix() 相同；任何字段缺失都给安全默认。
 */
function readMatrixFromEnv() {
  const raw = process.env.PILLAR0_PAYLOAD || '';
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !parsed.matrix || typeof parsed.matrix !== 'object') {
    return null;
  }
  const m = parsed.matrix;
  const cities = Array.isArray(m.cities)
    ? m.cities.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean).slice(0, 10)
    : [];
  const platforms = Array.isArray(m.platforms)
    ? m.platforms.map((p) => String(p || '').toLowerCase()).filter((p) => KNOWN_PLATFORMS.includes(p))
    : [];
  const deepAll = m.deep_search_all_cities !== false;
  const maxPages = Math.min(5, Math.max(1, parseInt(m.max_pages_per_pillar, 10) || 2));
  const includeSocial = m.include_social_profiles !== false;
  return { cities, platforms, deepAllCities: deepAll, maxPages, includeSocial };
}

/**
 * 给定国家码与 matrix，决定 Step1 maps 类 pillar 实际要扫描的城市列表。
 * - 用户显式 cities → 用之
 * - 否则若 deepAllCities → 取 MAJOR_CITIES（最多 5 个）
 * - 都没有 → 返回空数组（沿用国家级 query，保持向后兼容）
 */
function resolveCitiesForRun(cc, matrix) {
  if (!matrix) return [];
  if (matrix.cities && matrix.cities.length > 0) return matrix.cities.slice(0, 10);
  if (matrix.deepAllCities) {
    const arr = MAJOR_CITIES[String(cc || '').toUpperCase()];
    return Array.isArray(arr) ? arr.slice(0, 5) : [];
  }
  return [];
}

/**
 * platforms 是否启用某项。空 → 全启用（默认全部 6 个）。
 */
function isPlatformEnabled(matrix, platform) {
  if (!matrix || !Array.isArray(matrix.platforms) || matrix.platforms.length === 0) return true;
  return matrix.platforms.includes(platform);
}

/**
 * Batch A.4：从 PILLAR0_PAYLOAD 透传的 industry_hint（zhimao submit 注入）。
 * 形状与 zhimao apps/web/lib/icp/categoryNormalize.ts 的 IndustryHint 一致：
 *   { category_key, industry_key, name_zh, name_en, place_type_blacklist[], hit }
 * 没有则返回 null（worker 端会用 v8_icp_taxonomy.getIndustryHint(category) 兜底）。
 */
function readIndustryHintFromEnv() {
  const raw = process.env.PILLAR0_PAYLOAD || '';
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const h = parsed.industry_hint;
  if (!h || typeof h !== 'object') return null;
  const blacklist = Array.isArray(h.place_type_blacklist)
    ? h.place_type_blacklist.filter((s) => typeof s === 'string' && s).slice(0, 20)
    : [];
  return {
    category_key: typeof h.category_key === 'string' ? h.category_key : 'other',
    industry_key: typeof h.industry_key === 'string' ? h.industry_key : null,
    name_zh: typeof h.name_zh === 'string' ? h.name_zh : '',
    name_en: typeof h.name_en === 'string' ? h.name_en : '',
    place_type_blacklist: blacklist,
    hit: Boolean(h.hit),
  };
}

/**
 * Batch D.1：行业 anchor 词字典（segment_id → keywords + keywords_zh + mapTypes）。
 * 来源 catagent/config/data-intel/{category_to_map_segment,map_retrieval_segments}.json
 * 经 sync-catagent-taxonomy 镜像到 procure/v8_icp_data。
 *
 * 用法：getIndustryAnchor('garlic') → {
 *   en: ["garlic", "wholesale garlic", "garlic importer", "produce wholesaler", ...],
 *   zh: ["大蒜", "大蒜批发", "大蒜进口商", "农产品批发", ...],
 *   mapTypes: ["restaurant","food","store"],   // Google Places types 偏好
 *   segment_id: "food_processing",
 * }
 *
 * 落地优先级：
 *   1. 直接把 raw category 当 category_key 查 category_to_map_segment（如 "food_processing"）
 *   2. 命中后取 map_retrieval_segments[segment].keywords/keywords_zh/mapTypes
 *   3. 未命中时返回空 anchor（step1 退化为旧"trading company"等泛词）
 */
const fs = require('fs');
const path = require('path');
let _ANCHOR_CACHE = null;
function loadAnchorData() {
  if (_ANCHOR_CACHE) return _ANCHOR_CACHE;
  const dataDir = path.join(__dirname, 'v8_icp_data');
  const empty = { categoryToSegment: {}, segmentById: {} };
  try {
    const c2s = JSON.parse(fs.readFileSync(path.join(dataDir, 'category_to_map_segment.json'), 'utf8'));
    const segs = JSON.parse(fs.readFileSync(path.join(dataDir, 'map_retrieval_segments.json'), 'utf8'));
    const categoryToSegment =
      c2s && typeof c2s === 'object' && c2s.category_to_segment && typeof c2s.category_to_segment === 'object'
        ? c2s.category_to_segment
        : {};
    const segmentList = Array.isArray(segs && segs.segments) ? segs.segments : [];
    const segmentById = {};
    for (const seg of segmentList) {
      if (seg && typeof seg.segment_id === 'string') segmentById[seg.segment_id] = seg;
    }
    _ANCHOR_CACHE = { categoryToSegment, segmentById };
    return _ANCHOR_CACHE;
  } catch (e) {
    console.warn('[v8_constants_geo] anchor data load failed:', e.message);
    _ANCHOR_CACHE = empty;
    return empty;
  }
}

// Batch D.1 兜底：catagent 的 category_to_map_segment.json 只覆盖 industry_key
// （85 行业层级），但 zhimao submit 端传过来的多是 category_key（如 garlic / coffee /
// pharma_health）。这里补一张 procure 自己的 category_key→segment_id 兜底，
// 与 catagent ontology 的语义保持一致，但允许独立维护以避免上游 schema 变动。
const CATEGORY_KEY_TO_SEGMENT_FALLBACK = {
  // 食品 / 农产品 → food_processing 或 agriculture_agri
  garlic: 'food_processing', ginger: 'food_processing', chili: 'food_processing',
  rice: 'food_processing', flour: 'food_processing', vegetable: 'food_processing',
  fruit: 'food_processing', spice: 'food_processing', grain: 'food_processing',
  coffee: 'food_processing', tea: 'food_processing', edible_oil: 'food_processing',
  dairy_source: 'food_processing', formula: 'food_processing', baby_food: 'food_processing',
  frozen_food: 'food_processing', seafood: 'food_processing', dairy: 'food_processing',
  beverage: 'food_processing', vegetable_meat_flour_raw: 'food_processing',
  // 农业生产前端
  agri_primary_processing: 'agriculture_agri',
  agriculture_seed_feed: 'agriculture_agri',
  // 餐饮 / 商超供应链
  catering: 'catering_food_service', catering_group: 'catering_food_service',
  display_shelving: 'wholesale_distribution',
  commercial_refrigeration: 'cold_chain_logistics',
  cold_chain: 'cold_chain_logistics',
  // 美妆 / 个护
  cosmetics: 'cosmetics_beauty', daily_chemicals: 'cosmetics_beauty',
  // 医药
  pharma_health: 'medical_devices', pharma_medical: 'medical_devices',
  // 电子 / 半导体 / 光电 / 新能源
  electronic_components: 'electronics_components',
  semiconductor: 'electronics_components',
  computer: 'electronics_components',
  laser_photonics: 'electronics_components',
  laser_equipment: 'electronics_components',
  optical_components: 'electronics_components',
  optical_intelligent_equipment: 'electronics_components',
  fiber_optic_components: 'electronics_components',
  battery_energy_storage: 'solar_photovoltaic',
  photovoltaic_solar: 'solar_photovoltaic',
  // 机械 / 高端装备 / 汽车
  machinery_equipment: 'manufacturing_plant',
  high_end_equipment: 'manufacturing_plant',
  auto_parts_tire: 'manufacturing_plant',
  // 建材 / 金属 / 化工
  construction: 'construction_materials',
  building_materials: 'construction_materials',
  cement_steel: 'construction_materials',
  metal_steel_raw: 'construction_materials',
  metal_raw: 'construction_materials',
  chemical_plastic_raw: 'chemical_processing',
  chemical_raw_material: 'chemical_processing',
  // 物流仓储
  logistics: 'logistics_warehousing',
  packaging: 'logistics_warehousing',
};

function getIndustryAnchor(categoryOrKey) {
  const raw = String(categoryOrKey || '').trim();
  if (!raw) return null;
  const { categoryToSegment, segmentById } = loadAnchorData();
  // 先按 key 精确匹，再按全小写匹，最后用兜底表
  const segId =
    categoryToSegment[raw] ||
    categoryToSegment[raw.toLowerCase()] ||
    CATEGORY_KEY_TO_SEGMENT_FALLBACK[raw] ||
    CATEGORY_KEY_TO_SEGMENT_FALLBACK[raw.toLowerCase()] ||
    null;
  if (!segId || !segmentById[segId]) return null;
  const seg = segmentById[segId];
  const en = Array.isArray(seg.keywords)
    ? seg.keywords.filter((s) => typeof s === 'string' && s).slice(0, 8)
    : [];
  const zh = Array.isArray(seg.keywords_zh)
    ? seg.keywords_zh.filter((s) => typeof s === 'string' && s).slice(0, 8)
    : [];
  const mapTypes = Array.isArray(seg.mapTypes)
    ? seg.mapTypes.filter((s) => typeof s === 'string' && s).slice(0, 4)
    : [];
  return { segment_id: segId, name_zh: seg.name_zh || '', name_en: seg.name_en || '', en, zh, mapTypes };
}

/**
 * Batch B.2：从 PILLAR0_PAYLOAD 读取 conversational AI 回流写入的 negative_keywords
 * 与 icp_overrides。zhimao 端通过 /negative-keywords 与 /tighten-icp 路由把它们写到
 * discovery_jobs.action_payload，worker 在 reweight/deep_search 时应用：
 *  - negativeKeywords  → step1 keywordSuppress 兜底，过滤标题命中负面词的结果
 *  - icpOverrides      → step1 query 注入 anchor 词；step2 LLM extraction 强化扣题
 */
function readConvoControlsFromEnv() {
  const raw = process.env.PILLAR0_PAYLOAD || '';
  if (!raw) return { negativeKeywords: [], icpOverrides: [] };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { negativeKeywords: [], icpOverrides: [] }; }
  if (!parsed || typeof parsed !== 'object') return { negativeKeywords: [], icpOverrides: [] };
  const negativeKeywords = Array.isArray(parsed.negative_keywords)
    ? parsed.negative_keywords
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim().slice(0, 24))
        .slice(0, 16)
    : [];
  const icpOverrides = Array.isArray(parsed.icp_overrides)
    ? parsed.icp_overrides
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim().slice(0, 32))
        .slice(0, 6)
    : [];
  return { negativeKeywords, icpOverrides };
}

module.exports = {
  MAJOR_CITIES,
  KNOWN_PLATFORMS,
  readMatrixFromEnv,
  resolveCitiesForRun,
  isPlatformEnabled,
  readIndustryHintFromEnv,
  readConvoControlsFromEnv,
  getIndustryAnchor,
};
