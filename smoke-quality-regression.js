/**
 * P2 回归烟测：验证国家硬闸 / 主体硬闸 / 质量门核心行为
 * 用法：node smoke-quality-regression.js
 */
const { evaluateLead } = require('./v8_quality_gate');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCase(name, lead, expect) {
  const got = evaluateLead(lead);
  assert(got.grade === expect.grade, `[${name}] grade expected=${expect.grade} got=${got.grade}`);
  if (expect.reason) {
    assert(got.reason === expect.reason, `[${name}] reason expected=${expect.reason} got=${got.reason}`);
  }
  console.log(`[PASS] ${name}:`, got);
}

runCase(
  'country_mismatch_should_drop',
  {
    company_name: 'ABC Imports',
    domain: 'abc.ch',
    primary_email: 'buy@abc.ch',
    primary_phone: '+41 22 123 4567',
    snippet: 'Swiss importer based in Zurich',
    intent_summary: 'Swiss importer',
    country: 'MY',
    inference_breakdown: { confidence_tier: 'High', procurement_items: ['banana'] },
  },
  { grade: 'unqualified', reason: 'country_mismatch' },
);

runCase(
  'social_entity_should_drop',
  {
    company_name: 'Coffee Lovers',
    domain: 'instagram.com/coffeelovers',
    primary_email: '',
    primary_phone: '',
    snippet: 'Instagram page for coffee lovers',
    country: 'CN',
    inference_breakdown: { confidence_tier: 'Medium', procurement_items: ['coffee bean'] },
  },
  { grade: 'unqualified', reason: 'entity_type_social' },
);

runCase(
  'valid_company_should_pass',
  {
    company_name: 'Shenzhen Fresh Fruits Import Ltd',
    domain: 'freshfruits.com.cn',
    primary_email: 'procurement@freshfruits.com.cn',
    primary_phone: '+86 755 12345678',
    snippet: 'Chinese importer and wholesaler',
    country: 'CN',
    inference_breakdown: { confidence_tier: 'High', procurement_items: ['banana', 'fruit'] },
  },
  { grade: 'premium' },
);

console.log('All smoke quality regression cases passed.');
