/**
 * verify-email-quality.js — 单元验证 v8_lib_email_quality.js
 *
 * 用法：node scripts/verify-email-quality.js
 *
 * 覆盖：
 *   - isBuyerEmail / filterBuyerEmails 11 个核心 case
 *   - 真实日志（2026-05-22 GB·flour）里 18 个非买家邮箱全部应 reject
 *   - quality_gate.evaluateLead 复查 4 个 case：placeholder/aggregator/brand_mismatch/同域过
 */
'use strict';

const {
  isBuyerEmail,
  filterBuyerEmails,
  extractRegisteredDomain,
} = require('../v8_lib_email_quality');
const { evaluateLead, REJECT_REASONS } = require('../v8_quality_gate');

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  ${JSON.stringify(extra)}` : ''}`); }
}

console.log('══ Group 1 · isBuyerEmail 单元 ══');
{
  const v1 = isBuyerEmail('john.tan@orizigroup.com', 'orizigroup.com');
  check('同主域 → ok', v1.ok && v1.reason === 'ok', v1);

  const v2 = isBuyerEmail('press@orizigroup.com', 'orizigroup.com');
  check('PR 邮箱 → ok+warn(pr_or_investor_only)', v2.ok && v2.reason === 'pr_or_investor_only', v2);

  const v3 = isBuyerEmail('procurement@gmail.com', 'orizigroup.com');
  check('Gmail 不同域 → ok+warn(free_email_no_verify)', v3.ok && v3.reason === 'free_email_no_verify', v3);

  const v4 = isBuyerEmail('chairman@sec.gov', 'orizigroup.com');
  check('SEC 政府 → reject(aggregator_email)', !v4.ok && v4.reason === 'aggregator_email', v4);

  const v5 = isBuyerEmail('support@bebee.com', 'orizigroup.com');
  check('bebee 招聘平台 → reject(aggregator_email)', !v5.ok && v5.reason === 'aggregator_email', v5);

  const v6 = isBuyerEmail('jane.doe@tdpbakery.com', 'tdpbakery.com');
  check('jane.doe placeholder → reject(placeholder_email)', !v6.ok && v6.reason === 'placeholder_email', v6);

  const v7 = isBuyerEmail('email@address.com', 'tdpbakery.com');
  check('email@address.com → reject(placeholder_email)', !v7.ok && v7.reason === 'placeholder_email', v7);

  const v8 = isBuyerEmail('procurement@otherrandom.com', 'orizigroup.com');
  check('第三方域名 → reject(brand_mismatch)', !v8.ok && v8.reason === 'brand_mismatch', v8);

  const v9 = isBuyerEmail('jamie@something.com', null);
  check('expectedDomain 缺失 → ok(放宽)', v9.ok, v9);

  const v10 = isBuyerEmail('not-an-email', 'foo.com');
  check('非法格式 → reject(invalid_format)', !v10.ok && v10.reason === 'invalid_format', v10);

  const v11 = isBuyerEmail('john@subsidiary.orizigroup.com', 'orizigroup.com');
  check('子域同主域 → ok', v11.ok && v11.reason === 'ok', v11);
}

console.log('\n══ Group 2 · 真实日志 18 个非买家邮箱全部应被 reject ══');
{
  const LOG_REJECT_CASES = [
    // 招聘 / 数据库
    { e: 'support@bebee.com',                        d: 'tdpbakery.com',        why: 'bebee 招聘' },
    { e: 'support@rocketreach.co',                   d: 'freshpastacompany.com',why: 'rocketreach 数据库' },
    // 媒体 / 新闻
    { e: 'info@seafoodsource.com',                   d: 'kentfrozenfoods.com',  why: 'seafoodsource 行业媒体' },
    { e: 'info@perishablepundit.com',                d: 'reynoldsfresh.com',    why: 'perishablepundit 杂志' },
    { e: 'info@newsbywire.com',                      d: 'hillbiscuits.com',     why: 'newsbywire 新闻发布' },
    { e: 'info@rfmaonline.com',                      d: 'kasonind.com',         why: 'rfma 行业协会' },
    { e: 'foodeditor@aroq.com',                      d: 'absuk.com',            why: 'aroq just-food 编辑' },
    // 政府 / 监管
    { e: 'chairman@sec.gov',                         d: 'brakes.co.uk',         why: 'sec.gov 监管' },
    { e: 'uktradeinfo@hmrc.gov.uk',                  d: 'freshpastacompany.com',why: 'hmrc 海关' },
    { e: 'market.intelligence@spglobal.com',         d: 'unitedbiscuits.co.uk', why: 'spglobal 评级' },
    // 营销 / 网站建设 / 第三方误抓
    { e: 'jamie.chadwick@expanamarkets.com',         d: 'sysco.com',            why: 'expanamarkets 咨询' },
    { e: 'sunny@interodigital.com',                  d: 'chefmod.com',          why: 'interodigital 网站建设' },
    { e: 'dev@marketinggenie.io',                    d: 'breadmanbaking.com',   why: 'marketinggenie 营销' },
    { e: 'admin@spa-terminus.co.uk',                 d: 'freshpastacompany.com',why: 'spa-terminus 物业' },
    { e: 'andrew@jandmgroup.co.uk',                  d: 'freshpastacompany.com',why: 'jandmgroup 多元集团' },
    { e: 'info@culinaryagents.com',                  d: 'jvrestaurants.com',    why: 'culinaryagents 招聘' },
    { e: 'contact@kalidirectory.com',                d: 'monacorestaurant.com', why: 'kalidirectory 目录' },
    // placeholder
    { e: 'jane.doe@tdpbakery.com',                   d: 'tdpbakery.com',        why: 'jane.doe placeholder' },
    { e: 'email@address.com',                        d: 'goldmedalbakery.com',  why: 'email@address.com' },
  ];
  for (const c of LOG_REJECT_CASES) {
    const v = isBuyerEmail(c.e, c.d);
    check(`日志真实 reject · ${c.why} · ${c.e}`, !v.ok, v);
  }
}

console.log('\n══ Group 3 · filterBuyerEmails 批量 ══');
{
  const out = filterBuyerEmails([
    'john@orizigroup.com',             // ok
    'press@orizigroup.com',            // warn (pr)
    'support@bebee.com',               // reject
    'jane.doe@orizigroup.com',         // reject (placeholder)
    'procurement@gmail.com',           // warn (free)
    'chairman@sec.gov',                // reject
    'JOHN@orizigroup.com',             // dedup
  ], 'orizigroup.com');
  check('accepted=3 (john/press warn/gmail warn)', out.accepted.length === 3, { accepted: out.accepted });
  check('rejected=3 (bebee + jane.doe + sec)',   out.rejected.length === 3, { rejected: out.rejected });
  check('warnings=2 (press + gmail)',            out.warnings.length === 2, { warnings: out.warnings });
}

console.log('\n══ Group 4 · extractRegisteredDomain ══');
{
  check('a.b.example.com → example.com',   extractRegisteredDomain('a.b.example.com') === 'example.com');
  check('example.co.uk → example.co.uk',   extractRegisteredDomain('example.co.uk') === 'example.co.uk');
  check('foo.example.co.uk → example.co.uk', extractRegisteredDomain('foo.example.co.uk') === 'example.co.uk');
  check('example.com → example.com',       extractRegisteredDomain('example.com') === 'example.com');
}

console.log('\n══ Group 5 · evaluateLead G 段复查 ══');
{
  // 注意：构造能通过 A-F 段的 lead — 避开 BIZ_ANTI_PATTERNS（bakery/restaurant/hotel/...）
  //   原 case 用 "TDP Bakery" 会被 B 段毙在 biz_type_blacklisted（bakery 触发 B2C 业态黑名单）。
  //   这是 procure 另一个边界 case（面粉真买家就是面包房，但 bakery 在黑名单），与本次根切无关。
  const baseLead = {
    company_name: 'TDP Foods Trading Ltd',
    domain: 'tdpfoods.com',
    country: 'GB',
    inference_breakdown: { confidence_tier: 'high', procurement_items: ['flour', 'sugar'] },
    snippet: 'TDP Foods Trading Ltd is a UK B2B food ingredients distributor.',
  };

  const r1 = evaluateLead({ ...baseLead, primary_email: 'john@tdpfoods.com' });
  check('同域邮箱 → qualified/premium', r1.qualified === true && r1.grade !== 'unqualified', r1);

  // 注意：G 段语义 — hasRealDomain 也算 hasContact 救活；要孤立验 email reason 路径
  // 必须把 domain 也置 null/junk，否则即使 email 被毙 lead 仍可通过 (domain 投递)。
  const r2 = evaluateLead({ ...baseLead, domain: null, primary_email: 'jane.doe@tdpfoods.com', primary_phone: null });
  check('placeholder + 无 domain + 无 phone → unqualified(placeholder_email)',
    r2.qualified === false && r2.reason === REJECT_REASONS.PLACEHOLDER_EMAIL, r2);

  const r3 = evaluateLead({ ...baseLead, domain: null, primary_email: 'support@bebee.com', primary_phone: null });
  check('aggregator + 无 domain + 无 phone → unqualified(aggregator_email)',
    r3.qualified === false && r3.reason === REJECT_REASONS.AGGREGATOR_EMAIL, r3);

  // brand_mismatch 在 evaluateLead 的现实路径几乎不可达：
  //   · lead.domain 有效 → hasRealDomain=true 救活 lead（合理：B2B 有官网就能投递）；
  //   · lead.domain 缺失 → 调 isBuyerEmail 时 expectedDomain=null，brand_mismatch 判定本身就被跳过。
  // 真正的 EMAIL_BRAND_MISMATCH reason 在 enricher 收口（v8_lib_contact_enricher ⑦ 段）+
  // zhimao 前端 email_quality.rejected 透出上生效。
  // 这里改测一条"invalid_format 邮箱 + 无 domain + 无 phone → NO_CONTACT"路径，验证 G 段整体收敛。
  const r4 = evaluateLead({ ...baseLead, domain: null, primary_email: 'not-an-email-at-all', primary_phone: null });
  check('invalid_format + 无 domain + 无 phone → unqualified(no_contact)',
    r4.qualified === false && r4.reason === REJECT_REASONS.NO_CONTACT, r4);

  const r5 = evaluateLead({ ...baseLead, primary_email: 'support@bebee.com', primary_phone: '+44 1234 567890' });
  check('aggregator + 有 phone → qualified（phone 救活）',
    r5.qualified === true, r5);
}

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail === 0 ? 0 : 1);
