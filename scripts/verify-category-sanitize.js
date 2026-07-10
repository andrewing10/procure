'use strict';
const { sanitizeDiscoveryCategory } = require('../v8_lib_category_sanitize');

const cases = [
  ['新加坡有没有电视机', '电视机'],
  ['新加坡 白菜', '白菜'],
  ['新加坡 草莓', '草莓'],
  ['SG 白菜', '白菜'],
  ['Singapore cabbage', 'cabbage'],
  ['有没有日本大米', '日本大米'],
  ['日本大米', '日本大米'],
  ['LED lighting buyers in Singapore', 'LED lighting'],
  ['居銮红酒买家', '居銮红酒'],
  ['SG · · 有没有 土豆 · ·', '土豆'],
];

let failed = 0;
for (const [input, expect] of cases) {
  const got = sanitizeDiscoveryCategory(input);
  const ok = got === expect;
  console.log(`${ok ? 'OK' : 'FAIL'}  "${input}" → "${got}"${ok ? '' : ` (want "${expect}")`}`);
  if (!ok) failed += 1;
}
if (failed) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log('\nall passed');
