// B4 瀑布可观测层 smoke 测试（RC-4）— 验证 funnel 计量 plumbing，免网络。
const assert = require('assert');
const {
  enrichContactsForLead,
  getEnricherWaterfallStats,
  resetEnricherWaterfallStats,
} = require('./v8_lib_contact_enricher');

(async () => {
  resetEnricherWaterfallStats();
  let s = getEnricherWaterfallStats();
  assert.strictEqual(s.leads, 0, 'reset 后 leads=0');
  assert.strictEqual(s.cost_units, 0, 'reset 后 cost=0');
  assert.strictEqual(s.fill_rate, null, 'reset 后 fill_rate=null');

  // no-domain：早返回，不触网，但计入一次 lead（fill_rate 应可计算）
  const r1 = await enrichContactsForLead({ company_name: 'X' });
  assert.strictEqual(r1.via, 'no_domain', 'no-domain → via=no_domain');
  assert.strictEqual(r1.filled, false, 'no-domain → 未填充');
  assert.ok(Array.isArray(r1.waterfall), 'result.waterfall 为数组');

  const r2 = await enrichContactsForLead({ domain: '   ' });
  assert.strictEqual(r2.via, 'no_domain', '空白 domain → no_domain');

  s = getEnricherWaterfallStats();
  assert.strictEqual(s.leads, 2, '累计 leads=2');
  assert.strictEqual(s.filled, 0, 'filled=0');
  assert.strictEqual(s.fill_rate, 0, 'fill_rate=0');
  assert.ok(s.layers && s.layers.home && s.layers.vision, '含各层结构');
  assert.ok(s.degraded && typeof s.degraded.serper_no_key === 'number', '含降级计数');

  console.log('== B4 waterfall metrics: ALL PASSED ==');
  console.log(JSON.stringify(getEnricherWaterfallStats(), null, 2));
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
