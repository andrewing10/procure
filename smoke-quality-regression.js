/**
 * Quality gate 回归烟测：验证 evaluateLead 12 类拒绝 reason + premium 升级。
 *
 * 历史：本文件早期写了 country_mismatch_should_drop 期望 reason='country_mismatch'，
 * 但 evaluateLead 从未给该路径设过 reason → 长期 fail 没人修。
 * 2026-05-20 一并修复：evaluateLead 重构为前置 8 道闸门 + REJECT_REASONS 枚举。
 *
 * 用法：node smoke-quality-regression.js
 */
const { evaluateLead, REJECT_REASONS } = require('./v8_quality_gate');

let pass = 0;
let fail = 0;
const failures = [];

function runCase(name, lead, expect) {
  const got = evaluateLead(lead);
  const errs = [];
  if (got.grade !== expect.grade) {
    errs.push(`grade expected=${expect.grade} got=${got.grade}`);
  }
  if (expect.reason && got.reason !== expect.reason) {
    errs.push(`reason expected=${expect.reason} got=${got.reason}`);
  }
  if (expect.qualified !== undefined && got.qualified !== expect.qualified) {
    errs.push(`qualified expected=${expect.qualified} got=${got.qualified}`);
  }
  if (errs.length === 0) {
    pass++;
    console.log(`PASS  ${name}:`, JSON.stringify(got));
  } else {
    fail++;
    failures.push({ name, got, errs });
    console.log(`FAIL  ${name}:`, JSON.stringify(got));
    for (const e of errs) console.log(`        ${e}`);
  }
}

// ─── A 公司名级 ────────────────────────────────────────────────────────
runCase('no_company_name',
  { company_name: '' },
  { grade: 'unqualified', reason: REJECT_REASONS.NO_COMPANY_NAME });

runCase('junk_name_too_short',
  { company_name: 'ab', domain: 'foo.com', primary_email: 'a@foo.com' },
  { grade: 'unqualified', reason: REJECT_REASONS.JUNK_NAME });

runCase('junk_name_unknown',
  { company_name: 'unknown', domain: 'foo.com', primary_email: 'a@foo.com' },
  { grade: 'unqualified', reason: REJECT_REASONS.JUNK_NAME });

// ─── B 业态级 ──────────────────────────────────────────────────────────
runCase('biz_blacklisted_restaurant',
  { company_name: 'Joe Restaurant Chain', domain: 'joerestaurant.com',
    primary_email: 'info@joerestaurant.com', country: 'US' },
  { grade: 'unqualified', reason: REJECT_REASONS.BIZ_TYPE_BLACKLISTED });

// ─── C 域名级 ──────────────────────────────────────────────────────────
runCase('junk_domain_wikipedia',
  { company_name: 'Some Random Co', domain: 'en.wikipedia.org/wiki/random',
    primary_email: 'x@wikipedia.org', country: 'US' },
  { grade: 'unqualified', reason: REJECT_REASONS.JUNK_DOMAIN });

// ─── D 实体类型级 ──────────────────────────────────────────────────────
runCase('entity_type_social',
  { company_name: 'Coffee Lovers', domain: 'instagram.com/coffeelovers',
    snippet: 'Instagram page for coffee lovers', country: 'CN',
    inference_breakdown: { confidence_tier: 'Medium', procurement_items: ['coffee bean'] } },
  { grade: 'unqualified', reason: REJECT_REASONS.ENTITY_TYPE_SOCIAL });

runCase('entity_type_aggregator',
  { company_name: 'BBB Listed Co', domain: 'foo.bbb.org',
    primary_email: 'x@foo.bbb.org', country: 'US',
    inference_breakdown: { confidence_tier: 'High', procurement_items: ['toy'] } },
  { grade: 'unqualified', reason: REJECT_REASONS.ENTITY_TYPE_AGGREGATOR });

// ─── E 已结业 ──────────────────────────────────────────────────────────
runCase('closed_business',
  { company_name: 'Defunct Trading Ltd', domain: 'defunct.com',
    primary_email: 'x@defunct.com',
    snippet: 'This company has permanently closed in 2024',
    country: 'US' },
  { grade: 'unqualified', reason: REJECT_REASONS.CLOSED_BUSINESS });

// ─── F 国家级（历史一直 fail，本次修复）─────────────────────────────────
runCase('country_mismatch',
  { company_name: 'ABC Imports', domain: 'abc.ch',
    primary_email: 'buy@abc.ch', primary_phone: '+41 22 123 4567',
    snippet: 'Swiss importer based in Zurich', country: 'MY',
    inference_breakdown: { confidence_tier: 'High', procurement_items: ['banana'] } },
  { grade: 'unqualified', reason: REJECT_REASONS.COUNTRY_MISMATCH });

// ─── G 联系方式级（根切关键 case：伪信号 + 0 contact）───────────────────
runCase('no_contact_with_phantom_signal',
  { company_name: 'PhantomBuyer Ltd', domain: null,
    primary_email: null, primary_phone: null,
    snippet: 'Hiring purchasing manager in Shenzhen', country: 'CN',
    intent_signal: 'PROCUREMENT_DECISION_MAKER',
    inference_breakdown: { confidence_tier: 'High', procurement_items: ['toy'] } },
  { grade: 'unqualified', reason: REJECT_REASONS.NO_CONTACT });

// ─── H L3 推断置信级 ──────────────────────────────────────────────────
runCase('confidence_low',
  { company_name: 'LowConf Co', domain: 'lowconf.com',
    primary_email: 'x@lowconf.com', country: 'US',
    inference_breakdown: { confidence_tier: 'low', procurement_items: ['banana'] } },
  { grade: 'unqualified', reason: REJECT_REASONS.CONFIDENCE_LOW });

runCase('no_procurement_items',
  { company_name: 'NoItems Co', domain: 'noitems.com',
    primary_email: 'x@noitems.com', country: 'US',
    inference_breakdown: { confidence_tier: 'Medium', procurement_items: [] } },
  { grade: 'unqualified', reason: REJECT_REASONS.NO_PROCUREMENT_ITEMS });

// ─── I 正向 case：premium / qualified 通过 ─────────────────────────────
runCase('valid_company_premium',
  { company_name: 'Shenzhen Fresh Fruits Import Ltd', domain: 'freshfruits.com.cn',
    primary_email: 'procurement@freshfruits.com.cn', primary_phone: '+86 755 12345678',
    snippet: 'Chinese importer and wholesaler', country: 'CN',
    inference_breakdown: { confidence_tier: 'High', procurement_items: ['banana', 'fruit'] } },
  { grade: 'premium', qualified: true });

runCase('valid_qualified_no_high_confidence',
  { company_name: 'Mid Trading Co', domain: 'midtrading.com',
    primary_email: 'sales@midtrading.com', country: 'US',
    inference_breakdown: { confidence_tier: 'Medium', procurement_items: ['shoe'] } },
  { grade: 'qualified', qualified: true });

console.log('');
console.log(`${pass}/${pass + fail} pass`);
if (fail > 0) {
  console.error('FAILURES:');
  for (const f of failures) {
    console.error(`  - ${f.name}: ${f.errs.join('; ')}`);
  }
  process.exit(1);
}
console.log('All smoke quality regression cases passed.');
