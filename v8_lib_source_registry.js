/**
 * v8_lib_source_registry.js — Source Adapter 注册表（procure CJS 版，B7-3b，2026-06-19）
 *
 * 设计单源（zhimao）：docs/zhimao-eco/智猫生态_获客数据抓取链路_统一质量内核重构设计单源_v1.md §6.1
 * 与 zhimao apps/web/lib/search/sourceAdapter.ts 同口径双仓镜像 —— 任何一边改语义需同步另一边。
 *
 * 纯逻辑、无副作用、无网络。把分散的抓取源（step1 各平台 / contact enricher 五层）收敛到统一契约背后，
 * 由注册表按「期望单位成本 = cost / 命中率」升序瀑布编排：便宜/高命中优先，昂贵层（视觉/LLM）兜底。
 *
 * Adapter 契约：
 *   { id, method, costPerCall, isAvailable():bool, async fetch(query, opts): hits[] | null }
 *   fetch 三态：null=硬失败  []=零结果  非空=命中（与 searchProvider zero_results/failed 一致）。
 */

const HITRATE_PRIOR = 0.5;
const HITRATE_FLOOR = 0.05;
const DEFAULT_CACHE_TTL_MS = 30 * 60_000;

class SourceAdapterRegistry {
  constructor(opts = {}) {
    this.adapters = new Map();
    this.stats = new Map();
    this.cache = new Map();
    this.cacheTtlMs = opts.cacheTtlMs != null ? opts.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
    this.totalCost = 0;
  }

  register(adapter) {
    this.adapters.set(adapter.id, adapter);
    if (!this.stats.has(adapter.id)) this.stats.set(adapter.id, { attempts: 0, hits: 0 });
    return this;
  }

  has(id) {
    return this.adapters.has(id);
  }

  size() {
    return this.adapters.size;
  }

  _hitRate(id) {
    const s = this.stats.get(id);
    if (!s || s.attempts === 0) return HITRATE_PRIOR;
    return Math.max(s.hits / s.attempts, HITRATE_FLOOR);
  }

  _expectedCostPerHit(a) {
    if (a.costPerCall <= 0) return 0;
    return a.costPerCall / this._hitRate(a.id);
  }

  orderedAdapters() {
    return [...this.adapters.values()].sort(
      (a, b) => this._expectedCostPerHit(a) - this._expectedCostPerHit(b),
    );
  }

  _recordAttempt(id, hit) {
    const s = this.stats.get(id) || { attempts: 0, hits: 0 };
    s.attempts += 1;
    if (hit) s.hits += 1;
    this.stats.set(id, s);
  }

  _cacheGet(key) {
    if (this.cacheTtlMs <= 0) return null;
    const c = this.cache.get(key);
    if (!c) return null;
    if (Date.now() - c.ts > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return c.adapterId;
  }

  _cacheSet(key, adapterId) {
    if (this.cacheTtlMs <= 0) return;
    this.cache.set(key, { adapterId, ts: Date.now() });
  }

  /**
   * 瀑布检索：期望单位成本升序逐个尝试，run-if-empty 短路，受单条成本预算约束，per-key 动作缓存优先。
   * @returns {Promise<{ok,adapterId,hits,cost,tried,zeroResults,cacheHit,reason?}>}
   */
  async search(query, opts = {}) {
    const budget = opts.costBudget != null ? opts.costBudget : Number.POSITIVE_INFINITY;
    const cacheKey = opts.cacheKey != null ? opts.cacheKey : query;
    const tried = [];
    let spent = 0;
    let zeroResults = false;
    let cacheHit = false;

    const ordered = this.orderedAdapters();
    const cachedId = this._cacheGet(cacheKey);
    const candidates =
      cachedId && this.adapters.has(cachedId)
        ? [this.adapters.get(cachedId), ...ordered.filter((a) => a.id !== cachedId)]
        : ordered;

    for (const adapter of candidates) {
      if (!adapter.isAvailable()) continue;
      if (spent + adapter.costPerCall > budget) continue;
      const isFromCache = adapter.id === cachedId;

      tried.push(adapter.id);
      let hits;
      try {
        hits = await adapter.fetch(query, opts);
      } catch {
        hits = null;
      }
      spent += adapter.costPerCall;
      this.totalCost += adapter.costPerCall;

      if (hits === null) {
        this._recordAttempt(adapter.id, false);
        continue;
      }
      if (hits.length > 0) {
        this._recordAttempt(adapter.id, true);
        this._cacheSet(cacheKey, adapter.id);
        return { ok: true, adapterId: adapter.id, hits, cost: spent, tried, zeroResults: false, cacheHit: isFromCache };
      }
      this._recordAttempt(adapter.id, false);
      zeroResults = true;
      if (isFromCache) cacheHit = true;
    }

    if (zeroResults) {
      return { ok: true, adapterId: null, hits: [], cost: spent, tried, zeroResults: true, cacheHit, reason: 'zero_results' };
    }
    return {
      ok: false,
      adapterId: null,
      hits: [],
      cost: spent,
      tried,
      zeroResults: false,
      cacheHit,
      reason: tried.length === 0 ? 'no_available_adapter' : `all_adapters_failed:${tried.join(',')}`,
    };
  }

  getStats() {
    const adapters = this.orderedAdapters().map((a) => {
      const s = this.stats.get(a.id) || { attempts: 0, hits: 0 };
      return {
        id: a.id,
        method: a.method,
        cost_per_call: a.costPerCall,
        available: a.isAvailable(),
        attempts: s.attempts,
        hits: s.hits,
        hit_rate: s.attempts > 0 ? +(s.hits / s.attempts).toFixed(3) : null,
        expected_cost_per_hit: +this._expectedCostPerHit(a).toFixed(3),
      };
    });
    return { total_cost: this.totalCost, adapters };
  }

  resetStats() {
    this.stats.clear();
    for (const id of this.adapters.keys()) this.stats.set(id, { attempts: 0, hits: 0 });
    this.cache.clear();
    this.totalCost = 0;
  }
}

module.exports = { SourceAdapterRegistry };
