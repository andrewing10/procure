/**
 * verify-incremental-blacklist.js — 单元验证 PR-DEDUP-CACHE L2-2 增量补抓黑名单
 *
 * 用法：node scripts/verify-incremental-blacklist.js
 *
 * 背景（2026-05-28）：
 *   zhimao submit route 在 action_type='incremental_search' 时通过 PILLAR0_PAYLOAD 注入：
 *     - incremental_mode: true
 *     - incremental_parent_job_id: <uuid>
 *     - incremental_blacklist_company_ids: string[]  // 来自 parent job 的 leads
 *   v8_lib_pillar0.readIncrementalBlacklist 解析；
 *   v8_direct_l1_ingest.directIngestQualifiedLeads 据此跳过黑名单 company_id 的
 *   discovery_job_leads 映射写入（L1 公司主表仍然 upsert，不丢字段更新）。
 *
 * 覆盖：
 *   Group A · readIncrementalBlacklist 解析逻辑（5 case）
 *   Group B · directIngestQualifiedLeads 增量跳过行为（mock supabase，6 case）
 */
'use strict';

const { readIncrementalBlacklist } = require('../v8_lib_pillar0');
const { directIngestQualifiedLeads } = require('../v8_direct_l1_ingest');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  ${JSON.stringify(extra)}` : ''}`); }
}

console.log('══ Group A · readIncrementalBlacklist 解析 ══');
{
  const r1 = readIncrementalBlacklist(null);
  check('payload=null → enabled=false', r1.enabled === false);
  check('payload=null → blacklistSet 空 Set', r1.blacklistSet instanceof Set && r1.blacklistSet.size === 0);

  const r2 = readIncrementalBlacklist({ incremental_mode: false });
  check('incremental_mode=false → enabled=false', r2.enabled === false);

  const r3 = readIncrementalBlacklist({
    incremental_mode: true,
    incremental_parent_job_id: 'abc-123',
    incremental_blacklist_company_ids: ['c1', 'c2', '', '  c3  ', null, undefined, 'c4'],
  });
  check('incremental_mode=true → enabled=true', r3.enabled === true);
  check('parentJobId 透传',                     r3.parentJobId === 'abc-123');
  check('blacklist size=4 (空/null 过滤掉)',    r3.blacklistSet.size === 4);
  check('blacklist 包含 c1',                    r3.blacklistSet.has('c1'));
  check('blacklist 包含 trim 后的 c3',          r3.blacklistSet.has('c3'));

  const r4 = readIncrementalBlacklist({ incremental_mode: true });
  check('incremental_mode=true 但 ids 缺失 → enabled=true blacklist 空',
    r4.enabled === true && r4.blacklistSet.size === 0);
}

console.log('\n══ Group B · directIngestQualifiedLeads 增量跳过 ══');
{
  // 构造一个最小 mock supabase client
  //   - data_intel_l1_companies.upsert：永远 ok，回包含 company_id 的 inserted 行
  //   - data_intel_graph_edges.insert：永远 ok
  //   - data_intel_l1_companies.select：fallback 路径
  //   - discovery_job_leads 由 upsertJobLeadMapping 内部调用——我们 mock 它的入口
  //
  // 但 upsertJobLeadMapping 是从 v8_zhimao_contract 引入的，不在我们 mock 控制之内。
  // 简单做法：mock supabase.from('discovery_job_leads').upsert 拦截，并计数被写入的 company_id。
  const writtenJobLeads = [];
  const COMPANIES = [
    { name_canonical: 'company a', country: 'MY', company_id: 'company-a-id' },
    { name_canonical: 'company b', country: 'MY', company_id: 'company-b-id' },
    { name_canonical: 'company c', country: 'MY', company_id: 'company-c-id' },
  ];

  function makeSupabaseMock() {
    return {
      from(table) {
        if (table === 'data_intel_l1_companies') {
          return {
            upsert(_payload, _opts) {
              return {
                select(_cols) {
                  return Promise.resolve({ data: COMPANIES, error: null });
                },
              };
            },
            select(_cols) {
              return {
                eq() { return this; },
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        }
        if (table === 'discovery_job_leads') {
          return {
            upsert(row, _opts) {
              writtenJobLeads.push(row);
              return {
                select() {
                  return Promise.resolve({ data: [row], error: null });
                },
              };
            },
          };
        }
        if (table === 'data_intel_graph_edges') {
          return {
            insert(_rows) {
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        return null;
      },
    };
  }

  const leads = [
    {
      company_name: 'Company A',
      name_canonical: 'company a',
      country: 'MY',
      domain: 'a.com',
      _quality_grade: 'qualified',
    },
    {
      company_name: 'Company B',
      name_canonical: 'company b',
      country: 'MY',
      domain: 'b.com',
      _quality_grade: 'qualified',
    },
    {
      company_name: 'Company C',
      name_canonical: 'company c',
      country: 'MY',
      domain: 'c.com',
      _quality_grade: 'qualified',
    },
  ];

  (async () => {
    // Case 1：非增量模式 → 3 条全部写映射
    writtenJobLeads.length = 0;
    let supabase = makeSupabaseMock();
    let result = await directIngestQualifiedLeads(supabase, leads, {
      discoveryJobId: 'job-1',
      incrementalMode: false,
      incrementalBlacklistSet: new Set(['company-a-id', 'company-b-id']),
    });
    check('Case 1 · 非增量模式 → 写 3 条映射',  writtenJobLeads.length === 3);
    check('Case 1 · incrementalSkipped=0',     (result.incrementalSkipped || 0) === 0);

    // Case 2：增量模式 + a/b 在 blacklist → 只写 c
    writtenJobLeads.length = 0;
    supabase = makeSupabaseMock();
    result = await directIngestQualifiedLeads(supabase, leads, {
      discoveryJobId: 'job-2',
      incrementalMode: true,
      incrementalBlacklistSet: new Set(['company-a-id', 'company-b-id']),
    });
    check('Case 2 · 增量模式 → 仅写 1 条映射 (c)',  writtenJobLeads.length === 1);
    check('Case 2 · incrementalSkipped=2',           result.incrementalSkipped === 2);
    check('Case 2 · 写入的是 company-c-id',          writtenJobLeads[0]?.company_id === 'company-c-id');

    // Case 3：增量模式 + 全在 blacklist → 不写映射
    writtenJobLeads.length = 0;
    supabase = makeSupabaseMock();
    result = await directIngestQualifiedLeads(supabase, leads, {
      discoveryJobId: 'job-3',
      incrementalMode: true,
      incrementalBlacklistSet: new Set(['company-a-id', 'company-b-id', 'company-c-id']),
    });
    check('Case 3 · 全部黑名单 → 0 条映射',  writtenJobLeads.length === 0);
    check('Case 3 · incrementalSkipped=3',  result.incrementalSkipped === 3);

    // Case 4：增量模式 + blacklist 为空 → 写 3 条
    writtenJobLeads.length = 0;
    supabase = makeSupabaseMock();
    result = await directIngestQualifiedLeads(supabase, leads, {
      discoveryJobId: 'job-4',
      incrementalMode: true,
      incrementalBlacklistSet: new Set(),
    });
    check('Case 4 · 增量模式 + 空黑名单 → 写 3 条',  writtenJobLeads.length === 3);
    check('Case 4 · incrementalSkipped=0',          (result.incrementalSkipped || 0) === 0);

    console.log(`\n══ 总计 ══  PASS=${pass}  FAIL=${fail}`);
    process.exit(fail > 0 ? 1 : 0);
  })().catch((err) => {
    console.error('runner error:', err);
    process.exit(2);
  });
}
