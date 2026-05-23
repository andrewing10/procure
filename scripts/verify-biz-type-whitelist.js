/**
 * verify-biz-type-whitelist.js — 单元验证 CATEGORY_B2C_WHITELIST 动态豁免
 *
 * 用法：node scripts/verify-biz-type-whitelist.js
 *
 * 背景：旧 BIZ_ANTI_PATTERNS 一刀切把 bakery/restaurant/spa 等 B2C 业态拦死，
 *   但**面粉**类目下面包房恰恰是真买家、**化妆品原料**类目下美容沙龙是真买家、
 *   **酒店用品**类目下酒店是真买家。2026-05-23 升级按 category 动态豁免。
 *
 * 覆盖 4 组：
 *   Group A · 旧行为兼容（不传 category）— 一刀切 reject 不变
 *   Group B · 各 category 豁免对应业态 — 真买家放过
 *   Group C · 错配 category 不豁免 — flour 类目下美容沙龙仍 reject
 *   Group D · evaluateLead 端到端 — 透传 category 到 B 段
 */
'use strict';

const {
  isBizTypeBlacklisted,
  computeQualityGrade,
  evaluateLead,
  REJECT_REASONS,
} = require('../v8_quality_gate');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  ${JSON.stringify(extra)}` : ''}`); }
}

console.log('══ Group A · 旧行为兼容（不传 category 一刀切） ══');
{
  check('bakery + 无 category → 拦截',          isBizTypeBlacklisted('Acme Bakery Ltd') === true);
  check('restaurant + 无 category → 拦截',      isBizTypeBlacklisted('Joe Restaurant') === true);
  check('hotel + 无 category → 拦截',           isBizTypeBlacklisted('Grand Hotel') === true);
  check('spa + 无 category → 拦截',             isBizTypeBlacklisted('Wellness Spa Center') === true);
  check('mcdonald + 无 category → 拦截',        isBizTypeBlacklisted('McDonald\'s Sdn Bhd') === true);
  check('hospital + 无 category → 拦截',        isBizTypeBlacklisted('General Hospital') === true);
  check('普通公司名 + 无 category → 放过',       isBizTypeBlacklisted('Acme Trading Ltd') === false);
}

console.log('\n══ Group B · 各 category 豁免对应业态 ══');
{
  // 食材类
  check('flour 类目 + bakery → 放过（真买家）',          isBizTypeBlacklisted('Acme Bakery Ltd', 'flour') === false);
  check('面粉 类目 + bakery → 放过（中文 category）',    isBizTypeBlacklisted('Acme Bakery Ltd', '面粉') === false);
  check('seasoning 类目 + restaurant → 放过',           isBizTypeBlacklisted('Joe Restaurant', 'seasoning') === false);
  check('面粉 类目 + mcdonald → 放过（连锁餐饮真买家）', isBizTypeBlacklisted('McDonald\'s Sdn Bhd', '面粉') === false);
  check('flour 类目 + hotel → 放过（酒店厨房买面粉）',   isBizTypeBlacklisted('Grand Hotel', 'flour') === false);

  // 海鲜 / 肉类
  check('seafood 类目 + restaurant → 放过',             isBizTypeBlacklisted('Sushi Restaurant', 'seafood') === false);
  check('海鲜 类目 + hotel → 放过',                     isBizTypeBlacklisted('Grand Hotel', '海鲜') === false);
  check('beef 类目 + bistro → 放过',                    isBizTypeBlacklisted('Foodie Bistro', 'beef wholesale') === false);

  // 化妆品 / 美容用品
  check('cosmetic raw material 类目 + spa → 放过',      isBizTypeBlacklisted('Wellness Spa Center', 'cosmetic raw material') === false);
  check('化妆品 类目 + salon → 放过',                   isBizTypeBlacklisted('Hair Salon Pro', '化妆品原料') === false);
  check('skincare 类目 + beauty center → 放过',         isBizTypeBlacklisted('XYZ Beauty Center', 'skincare ingredient') === false);

  // 医疗
  check('medical device 类目 + hospital → 放过',        isBizTypeBlacklisted('General Hospital', 'medical device') === false);
  check('药品 类目 + clinic → 放过',                    isBizTypeBlacklisted('Family Clinic', '药品') === false);
  check('dental supply 类目 + dental clinic → 放过',    isBizTypeBlacklisted('Smile Dental', 'dental supply') === false);

  // 酒店用品
  check('hotel supply 类目 + hotel → 放过',             isBizTypeBlacklisted('Grand Hotel', 'hotel supply') === false);
  check('酒店用品 类目 + resort → 放过',                isBizTypeBlacklisted('Sea Resort', '酒店用品') === false);
  check('linen 类目 + motel → 放过',                    isBizTypeBlacklisted('Sunset Motel', 'linen amenity') === false);

  // 教学
  check('textbook 类目 + university → 放过',            isBizTypeBlacklisted('XYZ University', 'textbook') === false);
  check('教材 类目 + academy → 放过',                   isBizTypeBlacklisted('Music Academy', '教材') === false);

  // 健身
  check('gym equipment 类目 + gym → 放过',              isBizTypeBlacklisted('Fitness Center Pro', 'gym equipment') === false);

  // 办公用品
  check('stationery 类目 + law firm → 放过',            isBizTypeBlacklisted('Smith Law Firm', 'stationery') === false);
  check('toner 类目 + government → 放过',               isBizTypeBlacklisted('City Government', 'toner cartridge') === false);

  // 公益物资
  check('humanitarian aid 类目 + foundation → 放过',    isBizTypeBlacklisted('Hope Foundation', 'humanitarian aid') === false);
}

console.log('\n══ Group C · 错配 category 不豁免（仍 reject） ══');
{
  check('flour 类目 + spa（错配业态）→ 仍拦截',         isBizTypeBlacklisted('Wellness Spa', 'flour') === true);
  check('cosmetic 类目 + restaurant（错配）→ 仍拦截',   isBizTypeBlacklisted('Joe Restaurant', 'cosmetic') === true);
  check('medical 类目 + bakery（错配）→ 仍拦截',        isBizTypeBlacklisted('Acme Bakery', 'medical device') === true);
  check('cars 类目 + bakery（无关 category）→ 仍拦截',  isBizTypeBlacklisted('Acme Bakery', 'cars') === true);
  check('空 category → 等同旧行为',                     isBizTypeBlacklisted('Acme Bakery', '') === true);
  check('null category → 等同旧行为',                   isBizTypeBlacklisted('Acme Bakery', null) === true);
  check('undefined category → 等同旧行为',              isBizTypeBlacklisted('Acme Bakery', undefined) === true);
}

console.log('\n══ Group D · evaluateLead 端到端透传 category ══');
{
  const bakeryLead = {
    company_name: 'TDP Bakery Ltd',
    domain: 'tdpbakery.com',
    country: 'GB',
    primary_email: 'procurement@tdpbakery.com',
    inference_breakdown: { confidence_tier: 'high', procurement_items: ['flour', 'sugar'] },
    snippet: 'TDP Bakery Ltd produces artisan bread and pastries for retail in the UK.',
  };
  const r1 = evaluateLead(bakeryLead);
  check('bakery + 无 opts → reject(biz_type_blacklisted)（旧行为）',
    r1.qualified === false && r1.reason === REJECT_REASONS.BIZ_TYPE_BLACKLISTED, r1);

  const r2 = evaluateLead(bakeryLead, { category: 'flour' });
  check('bakery + category=flour → qualified（真买家放过）',
    r2.qualified === true, r2);

  const r3 = evaluateLead(bakeryLead, { category: '面粉' });
  check('bakery + category=面粉（中文）→ qualified',
    r3.qualified === true, r3);

  const spaLead = {
    company_name: 'Wellness Spa Center',
    domain: 'wellnessspa.com',
    country: 'GB',
    primary_email: 'purchasing@wellnessspa.com',
    inference_breakdown: { confidence_tier: 'high', procurement_items: ['essential oil', 'lotion'] },
    snippet: 'Premium spa center offering organic skincare treatments.',
  };
  const r4 = evaluateLead(spaLead, { category: 'cosmetic raw material' });
  check('spa + category=cosmetic raw material → qualified',
    r4.qualified === true, r4);

  const r5 = evaluateLead(spaLead, { category: 'flour' });
  check('spa + category=flour（错配）→ reject(biz_type_blacklisted)',
    r5.qualified === false && r5.reason === REJECT_REASONS.BIZ_TYPE_BLACKLISTED, r5);

  // 重要：连锁餐饮 + 食材类目放过（真买家：mcdonald 全球采购面粉量惊人）
  const mcdLead = {
    company_name: 'McDonald\'s UK Ltd',
    domain: 'mcdonalds.co.uk',
    country: 'GB',
    primary_email: 'procurement@mcdonalds.co.uk',
    inference_breakdown: { confidence_tier: 'high', procurement_items: ['flour', 'oil', 'beef'] },
    snippet: 'McDonald\'s UK supply chain procurement entity for European bakery & meat goods.',
  };
  const r6 = evaluateLead(mcdLead, { category: 'flour' });
  check('mcdonald + category=flour → qualified（连锁餐饮真买家）',
    r6.qualified === true, r6);

  const r7 = evaluateLead(mcdLead);
  check('mcdonald + 无 opts → reject（旧行为）',
    r7.qualified === false && r7.reason === REJECT_REASONS.BIZ_TYPE_BLACKLISTED, r7);
}

console.log('\n══ Group E · computeQualityGrade 透传 category ══');
{
  const g1 = computeQualityGrade({
    nameCanonical: 'TDP Bakery Ltd',
    domain: 'tdpbakery.com',
    primaryEmail: 'procurement@tdpbakery.com',
    primaryPhone: null,
    confidenceTier: 'high',
    hasProcurementItems: true,
    entityType: 'company',
    countryMatchLevel: 'high',
    bizDescription: 'TDP Bakery Ltd produces artisan bread',
    // 无 category — 旧行为
  });
  check('computeQualityGrade bakery + 无 category → unqualified',
    g1 === 'unqualified', { grade: g1 });

  const g2 = computeQualityGrade({
    nameCanonical: 'TDP Bakery Ltd',
    domain: 'tdpbakery.com',
    primaryEmail: 'procurement@tdpbakery.com',
    primaryPhone: null,
    confidenceTier: 'high',
    hasProcurementItems: true,
    entityType: 'company',
    countryMatchLevel: 'high',
    bizDescription: 'TDP Bakery Ltd produces artisan bread',
    category: 'flour',
  });
  check('computeQualityGrade bakery + category=flour → premium/qualified',
    g2 !== 'unqualified', { grade: g2 });
}

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail === 0 ? 0 : 1);
