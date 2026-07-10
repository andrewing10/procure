'use strict';
const { hardNoiseReason, rejectHardNoiseLeads, splitEnrichTopN } = require('../v8_lib_enrich_cap');
const { offCategoryReason } = require('../v8_lib_category_relevance');

const noiseStructural = [
  { company_name: 'Top Manufacturing Companies in Singapore - Jun 2026 Rankings' },
  { company_name: '20 Questions with Zermatt Neo - Content Creator Interviews' },
  { company_name: 'AmCham Singapore Membership Directory - List of Companies' },
  { company_name: 'Good Veg Wholesaler', primary_email: 'xxx@organisation.com' },
];

const noiseOffForCabbage = [
  { company_name: 'Private Label OEM/ODM Skincare Manufacturer in Singapore' },
  { company_name: 'Pharmaceutical Contract Manufacturing Company | APD Singapore' },
  { company_name: 'The Car Enthusiast Pte Ltd' },
];

const keepCabbage = [
  { company_name: 'Yuan Sang Pte Ltd', domain: 'yuansang.com.sg', pillar: 'Pillar 1 LBS', industry_match: 'medium' },
  { company_name: 'Z.N.TRADING (SINGAPORE) PTE LTD', domain: 'zntrading.sg', pillar: 'Pillar 2 Direct', industry_match: 'high' },
  { company_name: 'Kirei Japanese Food Supply Pte Ltd', domain: 'kireifood.com.sg', phone: '+65', pillar: 'Pillar 1 LBS' },
  { company_name: 'Cabbage Wholesale Fresh Produce', domain: 'veg.sg', snippet: 'import cabbage and leafy vegetables' },
];

const keepWhenSkincare = [
  { company_name: 'Private Label OEM/ODM Skincare Manufacturer in Singapore', domain: 'dermalab.sg' },
];

let failed = 0;

console.log('--- structural noise (any category) ---');
for (const n of noiseStructural) {
  const why = hardNoiseReason(n, '白菜');
  const ok = !!why;
  console.log(`${ok ? 'DROP' : 'FAIL-KEEP'}  ${n.company_name.slice(0, 48)} → ${why || 'null'}`);
  if (!ok) failed += 1;
}

console.log('\n--- off-category when user=白菜 ---');
for (const n of noiseOffForCabbage) {
  const why = hardNoiseReason(n, '白菜');
  const ok = why === 'off_category';
  console.log(`${ok ? 'DROP' : 'FAIL'}  ${n.company_name.slice(0, 48)} → ${why || 'null'}`);
  if (!ok) failed += 1;
}

console.log('\n--- keep when user=白菜 ---');
for (const k of keepCabbage) {
  const why = hardNoiseReason(k, '白菜');
  const ok = !why;
  console.log(`${ok ? 'KEEP' : 'FAIL-DROP'}  ${k.company_name.slice(0, 48)} → ${why || 'ok'}`);
  if (!ok) failed += 1;
}

console.log('\n--- skincare OEM kept when user=护肤 ---');
for (const k of keepWhenSkincare) {
  const why = hardNoiseReason(k, '护肤');
  const ok = !why;
  console.log(`${ok ? 'KEEP' : 'FAIL-DROP'}  ${k.company_name.slice(0, 48)} → ${why || 'ok'}`);
  if (!ok) failed += 1;
}

console.log('\n--- car kept when user=汽车配件 ---');
{
  const car = { company_name: 'The Car Enthusiast Pte Ltd' };
  const why = hardNoiseReason(car, '汽车配件');
  const ok = !why;
  console.log(`${ok ? 'KEEP' : 'FAIL-DROP'}  car under 汽车配件 → ${why || 'ok'}`);
  if (!ok) failed += 1;
}

console.log('\n--- offCategoryReason unit ---');
{
  const a = offCategoryReason('The Car Enthusiast Pte Ltd', '白菜');
  const b = offCategoryReason('Skincare Manufacturer OEM', '护肤');
  const c = offCategoryReason('Cabbage importer wholesale', '白菜');
  console.log(`car vs 白菜 → ${a} (want off_category)`);
  console.log(`skincare vs 护肤 → ${b} (want null)`);
  console.log(`cabbage text vs 白菜 → ${c} (want null)`);
  if (a !== 'off_category') failed += 1;
  if (b != null) failed += 1;
  if (c != null) failed += 1;
}

const allCabbage = [...noiseStructural, ...noiseOffForCabbage, ...keepCabbage];
const { top, hardRejected } = splitEnrichTopN(allCabbage, 30, '白菜');
console.log(`\nsplitEnrichTopN(白菜): top=${top.length} hardRejected=${hardRejected}`);
if (top.some((t) => /Rankings|Interview|AmCham|Skincare|Pharmaceutical|Car Enthusiast/i.test(t.company_name))) {
  console.error('FAIL: noise leaked into top for 白菜');
  failed += 1;
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall passed');
