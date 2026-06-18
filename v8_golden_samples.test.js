/**
 * v8_golden_samples.test.js — 品类黄金样例回归测试（P6 数据精准）
 *
 * 作用：
 *   - 锁定「某品类 + 某方向」下，质量门的期望评级行为
 *   - 每次修改 v8_quality_gate.js 后必须跑此文件确认没有回归
 *   - 新增品类时，先补样例，再改规则（TDD）
 *
 * 运行：node v8_golden_samples.test.js
 *   全部 PASS → exit 0；任意 FAIL → exit 1（可接入 CI）
 *
 * 注：此文件不依赖任何 npm 包，纯 Node.js 内置。
 */

const { evaluateLead, evaluateLeadSupplier, isNegativeKeywordHit } = require('./v8_quality_gate');
const { preFilterRawLeads } = require('./v8_lib_concurrency');
const { inferDiscoveredVia } = require('./v8_direct_l1_ingest');
const { ALL_PLATFORMS, SUPPLIER_PLATFORMS } = require('./v8_constants_geo');

// ─────────────────────────────────────────────────────────────────────────────
// 最简测试框架
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function expect(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✅  ${label}: ${actual}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}: expected "${expected}", got "${actual}"`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：构造最小有效 lead
// ─────────────────────────────────────────────────────────────────────────────

function mkLead(overrides) {
  return {
    company_name: 'Test Corp',
    domain: 'testcorp.com',
    primary_email: 'info@testcorp.com',
    primary_phone: '',
    country: 'US',
    city: '',
    snippet: '',
    description: '',
    discovered_via: 'organic',
    inference_breakdown: { confidence_tier: 'high', procurement_items: ['product'] },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 1 买家黄金样例（find_buyers 方向）
// ─────────────────────────────────────────────────────────────────────────────

section('1. 床垫 (mattress) — 买家方向');

// mkLead 默认含 confidence_tier=high + procurement_items=['product'] → 自动升 premium
expect(
  '家具批发商（高置信L3+联系方式）→ premium',
  evaluateLead(mkLead({ company_name: 'Furniture Wholesale Group', domain: 'fwg.com', primary_email: 'buy@fwg.com' }), { category: 'mattress' }).grade,
  'premium',
);

expect(
  '制造商自报身份 → unqualified（卖方伪装）',
  evaluateLead(mkLead({ company_name: 'Mattress Manufacturer Ltd', snippet: 'we manufacture and export mattresses globally' }), { category: 'mattress' }).grade,
  'unqualified',
);

expect(
  '媒体网站 → unqualified',
  evaluateLead(mkLead({ company_name: 'Reuters', domain: 'reuters.com', snippet: 'news article about mattress market' }), { category: 'mattress' }).qualified,
  false,
);

expect(
  '无联系方式 → unqualified',
  evaluateLead(mkLead({ domain: '', primary_email: '', primary_phone: '' }), { category: 'mattress' }).qualified,
  false,
);

section('2. 海鲜 (seafood) — 买家方向（食品/B2C 白名单）');

// seafood 在 CATEGORY_B2C_WHITELIST 的食材组，餐厅是真买家
expect(
  '超市连锁 → qualified（CATEGORY_B2C_WHITELIST）',
  evaluateLead(mkLead({ company_name: 'FreshMart Supermarkets', domain: 'freshmart.com', primary_email: 'buy@freshmart.com', snippet: 'leading supermarket chain' }), { category: 'seafood' }).qualified,
  true,
);

expect(
  '餐厅 + seafood → qualified（CATEGORY_B2C_WHITELIST）',
  evaluateLead(mkLead({ company_name: 'Dragon Palace Restaurant', domain: 'dragon-palace.com', primary_email: 'chef@dragon-palace.com', snippet: 'seafood restaurant and catering' }), { category: 'seafood' }).qualified,
  true,
);

section('3. 锂电池 (lithium battery) — 买家方向');

expect(
  '电动车厂 → qualified',
  evaluateLead(mkLead({ company_name: 'EV Motor Co', domain: 'evmotor.de', primary_email: 'procurement@evmotor.de', snippet: 'electric vehicle manufacturer' }), { category: 'lithium battery' }).qualified,
  true,
);

expect(
  '律师事务所 → unqualified',
  evaluateLead(mkLead({ company_name: 'Smith & Jones Law Firm', domain: 'smithjones.com', primary_email: 'contact@smithjones.com', snippet: 'corporate law services' }), { category: 'lithium battery' }).qualified,
  false,
);

// ─────────────────────────────────────────────────────────────────────────────
// § 2 供应商黄金样例（find_suppliers 方向）
// ─────────────────────────────────────────────────────────────────────────────

section('4. 服装 (apparel) — 供应商方向');

expect(
  '服装工厂 → premium（供应商正向信号）',
  evaluateLeadSupplier(mkLead({ company_name: 'Hanoi Textile Factory', domain: 'hanoitextile.vn', primary_email: 'export@hanoitextile.vn', snippet: 'garment manufacturer and exporter' }), 'apparel', []).grade,
  'premium',
);

// 垃圾域名（known JUNK_DOMAIN_HOSTS）→ unqualified（供应商模式下也排除）
expect(
  '垃圾聚合站域名 globalsources.com → unqualified',
  evaluateLeadSupplier(mkLead({ company_name: 'Global Sources', domain: 'globalsources.com', primary_email: 'info@globalsources.com', snippet: 'find apparel suppliers online' }), 'apparel', []).qualified,
  false,
);

expect(
  '出口商 → premium',
  evaluateLeadSupplier(mkLead({ company_name: 'Bangladesh Garments Exporter', domain: 'bdgarments.com', primary_email: 'sales@bdgarments.com', snippet: 'leading exporter of ready-made garments' }), 'apparel', []).grade,
  'premium',
);

section('5. 家具 (furniture) — 供应商方向 + 负向词');

const furnitureNegatives = ['wholesaler', 'importer', 'distributor'];

expect(
  '家具制造商 → premium（无负向词命中）',
  evaluateLeadSupplier(mkLead({ company_name: 'Guangzhou Furniture Factory', domain: 'gzfurniture.com', primary_email: 'factory@gzfurniture.com', snippet: 'OEM furniture manufacturer' }), 'furniture', furnitureNegatives).grade,
  'premium',
);

// 负向关键词命中 → isNegativeKeywordHit=true → evaluateLeadSupplier 直接返回 unqualified
expect(
  '家具批发商 公司名含负向词 wholesaler → isNegativeKeywordHit=true',
  isNegativeKeywordHit('US Furniture Wholesaler Inc', 'furniture wholesale distributor', furnitureNegatives),
  true,
);

// 用 isNegativeKeywordHit 直接验证（独立于 evaluateLeadSupplier 内部复杂度）
expect(
  '家具制造商 公司名不含负向词 → isNegativeKeywordHit=false',
  isNegativeKeywordHit('Guangzhou Furniture Factory', 'OEM furniture manufacturer', furnitureNegatives),
  false,
);

// ─────────────────────────────────────────────────────────────────────────────
// § 3 负向关键词工具函数
// ─────────────────────────────────────────────────────────────────────────────

section('6. isNegativeKeywordHit');

expect(
  '空列表 → false',
  isNegativeKeywordHit('Foo Corp', 'exports garlic', []),
  false,
);

expect(
  '命中公司名 → true',
  isNegativeKeywordHit('Tax Advisory Services', 'financial consultants', ['tax', 'advisory']),
  true,
);

expect(
  '命中 snippet → true',
  isNegativeKeywordHit('ABC Corp', 'we provide insurance services', ['insurance']),
  true,
);

expect(
  '未命中 → false',
  isNegativeKeywordHit('Fresh Foods Ltd', 'food importer', ['real estate', 'law firm']),
  false,
);

// ─────────────────────────────────────────────────────────────────────────────
// § 4 P6b 供应商全管线：采集预过滤 / discovered_via / 平台白名单
// ─────────────────────────────────────────────────────────────────────────────

section('7. preFilterRawLeads — 供应商模式放行（P6b）');

const cnSupplierItem = [{
  title: 'Guangzhou Apparel Manufacturer',
  snippet: 'China based garment manufacturer and exporter, OEM supplier',
  link: 'https://gzapparel.com',
}];

expect(
  '买家模式：中国制造商/出口商 → 丢弃 (cn_supplier)',
  preFilterRawLeads(cnSupplierItem, { supplierMode: false }).kept.length,
  0,
);

expect(
  '供应商模式：中国制造商/出口商 → 保留 (目标)',
  preFilterRawLeads(cnSupplierItem, { supplierMode: true }).kept.length,
  1,
);

const platformItem = [{
  title: 'Apparel Supplier on Made-in-China',
  snippet: 'verified apparel supplier listing',
  link: 'https://www.made-in-china.com/showroom/abc',
}];

expect(
  '供应商模式：带 link 的目录站结果 → 保留（不按 PLATFORM_HOSTS 丢）',
  preFilterRawLeads(platformItem, { supplierMode: true }).kept.length,
  1,
);

section('8. inferDiscoveredVia — 供应商 pillar 标签（P6b）');

expect('Pillar S MadeInChina → made_in_china', inferDiscoveredVia({ pillar: 'Pillar S MadeInChina' }), 'made_in_china');
expect('Pillar S GlobalSources → global_sources', inferDiscoveredVia({ pillar: 'Pillar S GlobalSources' }), 'global_sources');
expect('Pillar S ThomasNet → thomasnet', inferDiscoveredVia({ pillar: 'Pillar S ThomasNet' }), 'thomasnet');
expect('Pillar S Alibaba → alibaba_intl', inferDiscoveredVia({ pillar: 'Pillar S Alibaba' }), 'alibaba_intl');
expect('Pillar S Factory → supplier_direct', inferDiscoveredVia({ pillar: 'Pillar S Factory' }), 'supplier_direct');
expect('买家 maps pillar 不受影响 → maps', inferDiscoveredVia({ pillar: 'Pillar 1 LBS Maps' }), 'maps');

section('9. 平台白名单双仓同步（P6b）');

expect('SUPPLIER_PLATFORMS 含 made_in_china', SUPPLIER_PLATFORMS.includes('made_in_china'), true);
expect('ALL_PLATFORMS 含买家平台 maps', ALL_PLATFORMS.includes('maps'), true);
expect('ALL_PLATFORMS 含供应商平台 thomasnet', ALL_PLATFORMS.includes('thomasnet'), true);

// ─────────────────────────────────────────────────────────────────────────────
// 结果汇总
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n══ 结果：${passed} PASSED, ${failed} FAILED ══`);
if (failed > 0) {
  console.error(`回归失败！请检查 v8_quality_gate.js 改动。`);
  process.exit(1);
} else {
  console.log('全部黄金样例通过 ✅');
  process.exit(0);
}
