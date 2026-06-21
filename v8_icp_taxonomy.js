/**
 * V8 procure worker — ICP 闸门业态归一化（catagent taxonomy 镜像）
 *
 * 数据源：v8_icp_data/*.json（由 zhimao 仓库的 scripts/sync-catagent-taxonomy.mjs 同步）
 * 与 zhimao 端 apps/web/lib/icp/categoryNormalize.ts 保持等价语义。
 *
 * 暴露：
 *   - normalizeCategoryToKey(rawText)
 *   - normalizeToIndustryKey(rawText)
 *   - getIndustryHint(rawText)  ← step1/step2 调用入口
 *   - PLACE_TYPE_BLACKLIST_BY_CATEGORY[categoryKey]
 *   - DEFAULT_PLACE_BLACKLIST
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'v8_icp_data');

function safeReadJson(file) {
  try {
    const full = path.join(DATA_DIR, file);
    if (!fs.existsSync(full)) return null;
    const raw = fs.readFileSync(full, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[v8_icp_taxonomy] failed to read ${file}: ${e.message}`);
    return null;
  }
}

const categoryAliasRaw  = safeReadJson('category_alias_entries.json');
const industryNameRaw   = safeReadJson('industry_name_to_industry_key.json');
const ruleIdRaw         = safeReadJson('rule_id_to_industry_key.json');

const CATEGORY_ALIAS_TO_KEY = {};
if (Array.isArray(categoryAliasRaw)) {
  for (const item of categoryAliasRaw) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const alias = String(item[0] || '');
    const key = String(item[1] || '');
    if (!alias || !key) continue;
    if (!(alias in CATEGORY_ALIAS_TO_KEY)) CATEGORY_ALIAS_TO_KEY[alias] = key;
  }
}

const INDUSTRY_NAME_TO_KEY = {};
if (industryNameRaw && Array.isArray(industryNameRaw.entries)) {
  for (const entry of industryNameRaw.entries) {
    const key = String(entry.industry_key || '').trim();
    if (!key) continue;
    if (entry.name_zh) {
      const k = String(entry.name_zh).trim();
      if (k && !(k in INDUSTRY_NAME_TO_KEY)) INDUSTRY_NAME_TO_KEY[k] = key;
    }
    if (entry.name_en) {
      const k = String(entry.name_en).trim().toLowerCase();
      if (k && !(k in INDUSTRY_NAME_TO_KEY)) INDUSTRY_NAME_TO_KEY[k] = key;
    }
  }
}

const INDUSTRY_KEY_85 = new Set();
if (ruleIdRaw && ruleIdRaw.mappings && typeof ruleIdRaw.mappings === 'object') {
  for (const v of Object.values(ruleIdRaw.mappings)) {
    if (typeof v === 'string' && v.trim()) INDUSTRY_KEY_85.add(v.trim());
  }
}

/** 与 zhimao categoryNormalize.ts 同步 */
const PLACE_TYPE_BLACKLIST_BY_CATEGORY = {
  food: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  garlic: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  ginger: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  seafood: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  fruit: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  vegetable: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  spice: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  grain: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  rice: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  beverage: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  dairy: ['bank','insurance_agency','lawyer','accounting','real_estate_agency','car_dealer'],
  pharma_medical: ['bank','insurance_agency','lawyer','accounting','car_dealer','travel_agency','restaurant'],
  pharma_health: ['bank','insurance_agency','lawyer','accounting','car_dealer','travel_agency','restaurant'],
  electronic_components: ['bank','insurance_agency','lawyer','accounting','real_estate_agency'],
  semiconductor: ['bank','insurance_agency','lawyer','accounting','real_estate_agency'],
  machinery_equipment: ['bank','insurance_agency','lawyer','accounting','real_estate_agency'],
  laser_photonics: ['bank','insurance_agency','lawyer','accounting','real_estate_agency'],
  laser_equipment: ['bank','insurance_agency','lawyer','accounting','real_estate_agency'],
  metal_steel_raw: ['bank','insurance_agency','lawyer','accounting'],
  chemical_plastic_raw: ['bank','insurance_agency','lawyer','accounting'],
  auto_parts_tire: ['bank','lawyer','accounting','restaurant','cafe'],
  new_energy: ['bank','insurance_agency','lawyer','accounting','restaurant'],
  battery_energy_storage: ['bank','insurance_agency','lawyer','accounting','restaurant'],
  photovoltaic_solar: ['bank','insurance_agency','lawyer','accounting','restaurant'],
};

const DEFAULT_PLACE_BLACKLIST = ['bank','lawyer','accounting','insurance_agency','real_estate_agency'];

/** 国家/地区前缀（中英文常见拼写），便于在归一化前剥离 */
const COUNTRY_PREFIX_RE = new RegExp(
  '^(?:' +
    '印尼|印度尼西亚|印度|越南|泰国|马来西亚|新加坡|菲律宾|缅甸|柬埔寨|老挝|韩国|日本|中国|美国|英国|德国|法国|意大利|西班牙|葡萄牙|荷兰|比利时|波兰|俄罗斯|加拿大|墨西哥|巴西|阿根廷|智利|秘鲁|哥伦比亚|沙特|阿联酋|土耳其|埃及|肯尼亚|尼日利亚|南非|澳大利亚|新西兰' +
    '|indonesia|india|vietnam|thailand|malaysia|singapore|philippines|myanmar|cambodia|laos|korea|japan|china|usa|us|uk|gb|germany|france|italy|spain|portugal|netherlands|belgium|poland|russia|canada|mexico|brazil|argentina|chile|peru|colombia|saudi|uae|turkey|egypt|kenya|nigeria|south africa|australia|new zealand' +
  ')\\s*[的,，]?\\s*',
  'i',
);

function sanitizeRaw(s) {
  if (!s || typeof s !== 'string') return '';
  let cleaned = s.replace(/^[\s【\[［\]]+/, '').replace(/[\s】\]］\[]+$/, '').trim();
  // 剥离一次国家前缀（仅头部一次，避免误伤"中国制造的中国大蒜"等极端串）
  cleaned = cleaned.replace(COUNTRY_PREFIX_RE, '').trim();
  return cleaned;
}

function normalizeCategoryToKey(raw) {
  const cleaned = sanitizeRaw(raw);
  if (!cleaned) return 'other';
  const direct = CATEGORY_ALIAS_TO_KEY[cleaned] || CATEGORY_ALIAS_TO_KEY[cleaned.toLowerCase()];
  if (direct) return direct;
  const segments = cleaned.split(/[；;、，,|]/);
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;
    const k = CATEGORY_ALIAS_TO_KEY[s] || CATEGORY_ALIAS_TO_KEY[s.toLowerCase()];
    if (k && k !== 'other') return k;
  }
  return cleaned.length <= 24 ? cleaned.toLowerCase() : 'other';
}

function normalizeToIndustryKey(raw) {
  const cleaned = sanitizeRaw(raw);
  if (!cleaned) return null;
  const direct = INDUSTRY_NAME_TO_KEY[cleaned] || INDUSTRY_NAME_TO_KEY[cleaned.toLowerCase()];
  if (direct) return direct;
  const segments = cleaned.split(/[；;、，,|\s]/);
  for (const seg of segments) {
    const s = seg.trim();
    if (!s || s.length < 2) continue;
    const k = INDUSTRY_NAME_TO_KEY[s] || INDUSTRY_NAME_TO_KEY[s.toLowerCase()];
    if (k) return k;
  }
  return null;
}

function isIndustryKey85(key) {
  if (!key) return false;
  return INDUSTRY_KEY_85.has(String(key).trim());
}

function getIndustryHint(rawText) {
  const raw = (rawText || '').trim();
  const categoryKey = normalizeCategoryToKey(raw);
  const industryKey = normalizeToIndustryKey(raw);
  const place_type_blacklist =
    PLACE_TYPE_BLACKLIST_BY_CATEGORY[categoryKey] || DEFAULT_PLACE_BLACKLIST;
  // hit 语义：业态字典命中（category_key 不是 other），或 industry_key 命中。
  // 用于上层判断"是否要把 hint 注入 LLM prompt"。
  const hit = (categoryKey && categoryKey !== 'other') || Boolean(industryKey);
  return {
    category_key: categoryKey,
    industry_key: industryKey,
    name_zh: raw,
    name_en: raw,
    place_type_blacklist,
    hit: Boolean(hit),
  };
}

function getTaxonomyStats() {
  return {
    category_aliases: Object.keys(CATEGORY_ALIAS_TO_KEY).length,
    industry_names: Object.keys(INDUSTRY_NAME_TO_KEY).length,
    industry_keys_85: INDUSTRY_KEY_85.size,
  };
}

module.exports = {
  normalizeCategoryToKey,
  normalizeToIndustryKey,
  isIndustryKey85,
  getIndustryHint,
  getTaxonomyStats,
  PLACE_TYPE_BLACKLIST_BY_CATEGORY,
  DEFAULT_PLACE_BLACKLIST,
  INDUSTRY_KEY_85,
};
