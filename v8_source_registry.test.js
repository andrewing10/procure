// B7-3b：procure Source Adapter 注册表单测（与 zhimao sourceAdapter.spec.ts 同口径双仓镜像）。
const assert = require('assert');
const { SourceAdapterRegistry } = require('./v8_lib_source_registry');

function mock(id, cost, result, available) {
  const a = {
    id, method: 'search', costPerCall: cost, calls: 0,
    isAvailable: () => available !== false,
    async fetch() { a.calls += 1; return result(); },
  };
  return a;
}
const HIT = (link) => [{ link, title: link }];

(async () => {
  // 1. 免费源优先
  let reg = new SourceAdapterRegistry({ cacheTtlMs: 0 });
  reg.register(mock('paid', 5, () => HIT('paid')));
  reg.register(mock('free', 0, () => HIT('free')));
  assert.deepEqual(reg.orderedAdapters().map((a) => a.id), ['free', 'paid']);

  // 2. run-if-empty 短路
  reg = new SourceAdapterRegistry({ cacheTtlMs: 0 });
  const cheap = mock('cheap', 1, () => HIT('cheap'));
  const exp = mock('exp', 5, () => HIT('exp'));
  reg.register(cheap); reg.register(exp);
  let r = await reg.search('q');
  assert.equal(r.adapterId, 'cheap');
  assert.equal(exp.calls, 0, '命中后不调昂贵源');

  // 3. 全零结果 → ok + zeroResults
  reg = new SourceAdapterRegistry({ cacheTtlMs: 0 });
  reg.register(mock('a', 1, () => []));
  reg.register(mock('b', 1, () => []));
  r = await reg.search('q');
  assert.equal(r.ok, true); assert.equal(r.zeroResults, true);

  // 4. 全硬失败 → ok=false
  reg = new SourceAdapterRegistry({ cacheTtlMs: 0 });
  reg.register(mock('a', 1, () => null));
  r = await reg.search('q');
  assert.equal(r.ok, false);
  assert.ok(/all_adapters_failed/.test(r.reason));

  // 5. 成本预算闸门
  reg = new SourceAdapterRegistry({ cacheTtlMs: 0 });
  reg.register(mock('free', 0, () => []));
  const vision = mock('vision', 5, () => HIT('vision'));
  reg.register(vision);
  r = await reg.search('q', { costBudget: 2 });
  assert.equal(vision.calls, 0, 'cost=5 超预算 2 被跳过');

  // 6. 不可用源跳过
  reg = new SourceAdapterRegistry({ cacheTtlMs: 0 });
  const down = mock('down', 0, () => HIT('down'), false);
  reg.register(down);
  reg.register(mock('up', 1, () => HIT('up')));
  r = await reg.search('q');
  assert.equal(down.calls, 0); assert.equal(r.adapterId, 'up');

  // 7. per-key 动作缓存
  reg = new SourceAdapterRegistry({ cacheTtlMs: 60_000 });
  reg.register(mock('free', 0, () => []));
  reg.register(mock('winner', 1, () => HIT('winner')));
  const r1 = await reg.search('q', { cacheKey: 'host:acme.com' });
  assert.equal(r1.adapterId, 'winner'); assert.equal(r1.cacheHit, false);
  const r2 = await reg.search('q', { cacheKey: 'host:acme.com' });
  assert.equal(r2.adapterId, 'winner'); assert.equal(r2.cacheHit, true);

  console.log('== B7-3b procure source registry: ALL PASSED ==');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
