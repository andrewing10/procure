/**
 * v8_lib_email_quality.js — B2B 买家邮箱质量裁判（procure 单源 · zhimao 镜像）
 *
 * 背景：2026-05-22 GB·flour v8_ultimate 跑批暴露 18 条"非买家邮箱"被 5 层 enricher
 *   抓回来当做"contact_hit"，质量门放过，最终用户在 zhimao 解锁付分却联系不上。典型：
 *     · support@bebee.com / support@rocketreach.co               (招聘 / 数据库平台)
 *     · info@seafoodsource.com / info@perishablepundit.com       (行业新闻媒体)
 *     · market.intelligence@spglobal.com / chairman@sec.gov      (政府 / 评级机构)
 *     · uktradeinfo@hmrc.gov.uk                                  (英国海关总局)
 *     · foodeditor@aroq.com / info@newsbywire.com                (新闻发布平台)
 *     · jane.doe@tdpbakery.com / email@address.com               (placeholder)
 *
 * 现有 quality_gate.evaluateLead 只查 lead.domain 是否 aggregator/social/media；
 * 不查 lead.primary_email 的 host —— 漏点就在这里。
 *
 * 本模块提供 isBuyerEmail / filterBuyerEmails，两仓共用（procure CJS · zhimao TS 镜像）。
 *
 * 双仓镜像约定（见 AGENTS.md "NON_BUYER_EMAIL_HOSTS 双仓镜像"段）：
 *   · 改 procure 这个文件 → 同步改 apps/web/lib/skills/emailQuality.ts
 *   · 任何新增 host / placeholder / 主域抽取规则两仓都要镜像
 */

/* ── 非买家邮箱 host 黑名单（subdomain 也算命中） ───────────────────────── */
// 分组维护，方便后续按"误报来源"分类回溯。
const NON_BUYER_EMAIL_HOSTS = new Set([
  // 招聘平台 / 数据库平台
  "bebee.com",
  "rocketreach.co",
  "zoominfo.com",
  "apollo.io",
  "leadiq.com",
  "lusha.com",
  "culinaryagents.com",
  "indeed.com",
  "glassdoor.com",
  "monster.com",
  // 行业新闻 / 媒体 / 杂志
  "seafoodsource.com",
  "perishablepundit.com",
  "newsbywire.com",
  "rfmaonline.com",
  "aroq.com",                  // food editor mailbox 出自 just-food / aroq 集团
  "metispartners.com",
  "expanamarkets.com",
  "foodbev.com",
  "foodprocessing.com",
  "fooddive.com",
  // 政府 / 监管 / 评级机构
  "sec.gov",
  "hmrc.gov.uk",
  "spglobal.com",
  "moodys.com",
  "fitchratings.com",
  "ftc.gov",
  // 营销 / 网站建设服务商（5 层 BFS 跑到"业务联系"页面会误抓）
  "interodigital.com",
  "marketinggenie.io",
  "spa-terminus.co.uk",        // 物业管理 — Fresh Pasta Company 案例
  "jandmgroup.co.uk",          // 多元集团 — 抢占 SEO
  // 目录站 / 黄页（已在 lead.domain 黑名单，但邮箱也要堵）
  "kalidirectory.com",
  "alamy.com",                 // 图库站
  "bbb.org",
  "yellowpages.com",
  "yelp.com",
  // 通用图片 / 文档平台
  "scribd.com",
  "issuu.com",
  "slideshare.net",
]);

/* ── 免费邮箱代管 host（个人 B2B 买家很可能用这个，给 warn 但不 reject） ── */
const FREE_EMAIL_HOSTS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "163.com",
  "126.com",
  "qq.com",
  "sina.com",
  "foxmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
]);

/* ── placeholder / 测试邮箱 pattern（命中即 reject） ─────────────────────── */
const PLACEHOLDER_LOCAL_PARTS = new Set([
  // 通用占位
  "test", "example", "demo", "sample", "dummy", "noreply", "no-reply", "donotreply",
  "do-not-reply", "donotresponse",
  // placeholder 假名（西方网页常见）
  "jane.doe", "john.doe", "john.smith", "jane.smith",
  "first.last", "firstname.lastname",
  // 极简虚假
  "email", "user", "name", "your", "yourname", "you", "me", "myname",
  "admin", "root", "test123", "abc",
]);
const PLACEHOLDER_FULL_EMAILS = new Set([
  "email@address.com",
  "test@test.com",
  "your@email.com",
  "name@email.com",
  "user@example.com",
  "example@example.com",
  "info@info.com",
  "contact@contact.com",
]);
// 邮箱整体 pattern（局部含 example/your/placeholder 等）
const PLACEHOLDER_REGEX_LIST = [
  /\bexample\b/i,
  /\byour-?(?:name|email)\b/i,
  /\bplace.?holder\b/i,
  /\b(first|last).?(?:name|n)\b/i,
];

/* ── press / PR / 投资者关系 / 协会专属邮箱（warn 级；非完全 reject） ──────
 * 2026-05-26 双仓同步（zhimao apps/web/lib/skills/emailQuality.ts）：
 *   新增 membership / secretary / secretariat / exec.director — 协会特征前缀，
 *   配合 v8_quality_gate.js ASSOC_EMAIL_LOCAL_RE 做 MED 协会辅助判定。
 * ─────────────────────────────────────────────────────────────────────────── */
const PR_INVESTOR_PREFIXES = new Set([
  "press", "media", "investor", "investorrelations", "investor-relations",
  "ir", "pressroom", "newsroom", "communications", "publicaffairs",
  "chairman", "ceo", "ceopanel", "sustainability", "esg", "csr",
  "compliance", "audit", "regulatory", "legal",
  // 协会特征前缀（2026-05-26 新增）
  "membership", "secretary", "secretariat", "exec.director", "exec-director",
]);

/* ────────────────────────────────────────────────────────────────────────── */

/** 提取邮箱 host（小写、去除别名 +tag）。invalid 返回 ""。 */
function extractEmailHost(email) {
  if (typeof email !== "string") return "";
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return "";
  return trimmed.slice(at + 1).replace(/[>"'`].*$/g, "").trim();
}

/** 提取邮箱 local-part（小写）。invalid 返回 ""。 */
function extractEmailLocal(email) {
  if (typeof email !== "string") return "";
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return "";
  return trimmed.slice(0, at).replace(/^[<"'`]+/, "").trim();
}

/** 从 host 提取主域（example.co.uk → example.co.uk；sub.example.com → example.com）。
 *  极简两段规则，不查 PSL；够 B2B 场景用。 */
function extractRegisteredDomain(host) {
  if (!host) return "";
  const cleaned = host.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9.\-]/g, "");
  const parts = cleaned.split(".").filter(Boolean);
  if (parts.length <= 2) return cleaned;
  // 二级公共后缀（覆盖最常见 100+ 案例）
  const COMMON_SECOND_LEVEL = new Set([
    "co.uk", "co.jp", "co.kr", "co.nz", "co.za", "co.in",
    "com.au", "com.cn", "com.hk", "com.tw", "com.sg", "com.my", "com.br", "com.mx", "com.tr", "com.ar",
    "net.au", "net.cn", "net.uk",
    "org.uk", "org.au", "org.cn",
    "gov.uk", "gov.cn", "gov.au",
    "ac.uk", "ac.jp",
    "edu.au", "edu.cn",
  ]);
  const tail2 = parts.slice(-2).join(".");
  if (COMMON_SECOND_LEVEL.has(tail2) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

/** 是否命中非买家 host 黑名单（含 subdomain）。 */
function isNonBuyerEmailHost(host) {
  if (!host) return false;
  const reg = extractRegisteredDomain(host);
  if (NON_BUYER_EMAIL_HOSTS.has(host)) return true;
  if (NON_BUYER_EMAIL_HOSTS.has(reg)) return true;
  return false;
}

/** 是否免费邮箱代管。 */
function isFreeEmailHost(host) {
  if (!host) return false;
  return FREE_EMAIL_HOSTS.has(host) || FREE_EMAIL_HOSTS.has(extractRegisteredDomain(host));
}

/** 是否 placeholder / 假名邮箱。 */
function isPlaceholderEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) return false;
  const lower = email.trim().toLowerCase();
  if (PLACEHOLDER_FULL_EMAILS.has(lower)) return true;
  const local = extractEmailLocal(email);
  if (PLACEHOLDER_LOCAL_PARTS.has(local)) return true;
  for (const re of PLACEHOLDER_REGEX_LIST) {
    if (re.test(lower)) return true;
  }
  return false;
}

/** 是否 PR / Investor / 监管类邮箱（warn 级；不直接 reject）。 */
function isPrOrInvestorEmail(email) {
  if (typeof email !== "string") return false;
  const local = extractEmailLocal(email);
  if (!local) return false;
  // 简单 prefix 匹配（press@…、investor.relations@…、chairman@…）
  const head = local.split(/[.\-_]/)[0];
  if (PR_INVESTOR_PREFIXES.has(head)) return true;
  if (PR_INVESTOR_PREFIXES.has(local)) return true;
  return false;
}

/**
 * 核心裁判：判断 email 是否可作为"B2B 买家可触达邮箱"。
 *
 * @param {string} email
 * @param {string} [expectedDomain] — 该 lead 的官网/品牌主域，提供时会做 brand-match 校验
 * @returns {{ ok: boolean, reason: string, severity: 'reject'|'warn', host: string }}
 *   ok=true 时表示通过（severity 仍可能是 warn）；ok=false 表示应拦截。
 *   reason 枚举：
 *     · invalid_format            — 格式不合法
 *     · placeholder_email         — 命中 placeholder / 假名
 *     · aggregator_email          — 命中 NON_BUYER_EMAIL_HOSTS
 *     · brand_mismatch            — expectedDomain 给定但 host 不匹配且非免费邮箱
 *     · pr_or_investor_only       — PR/IR/合规类 (warn)
 *     · free_email_no_verify      — 免费邮箱无 brand-match (warn)
 *     · ok                        — 通过
 */
function isBuyerEmail(email, expectedDomain) {
  if (typeof email !== "string" || !email.trim()) {
    return { ok: false, reason: "invalid_format", severity: "reject", host: "" };
  }
  const host = extractEmailHost(email);
  if (!host || !host.includes(".")) {
    return { ok: false, reason: "invalid_format", severity: "reject", host };
  }
  if (isPlaceholderEmail(email)) {
    return { ok: false, reason: "placeholder_email", severity: "reject", host };
  }
  if (isNonBuyerEmailHost(host)) {
    return { ok: false, reason: "aggregator_email", severity: "reject", host };
  }
  const expectedReg = expectedDomain ? extractRegisteredDomain(String(expectedDomain).toLowerCase().replace(/^https?:\/\//, "").split("/")[0]) : "";
  const emailReg = extractRegisteredDomain(host);
  const isFree = isFreeEmailHost(host);

  if (expectedReg) {
    if (emailReg === expectedReg) {
      // 同主域 — brand match ✓；再看 PR/IR
      if (isPrOrInvestorEmail(email)) {
        return { ok: true, reason: "pr_or_investor_only", severity: "warn", host };
      }
      return { ok: true, reason: "ok", severity: "reject", host };
    }
    // host 与 expectedDomain 不匹配：
    //   - 免费邮箱（@gmail 等）→ warn 但允许（很多小买家用 gmail）
    //   - 其他第三方域名 → reject (brand_mismatch)
    if (isFree) {
      return { ok: true, reason: "free_email_no_verify", severity: "warn", host };
    }
    return { ok: false, reason: "brand_mismatch", severity: "reject", host };
  }

  // expectedDomain 没提供：放宽到 placeholder/aggregator 拦截即可
  if (isPrOrInvestorEmail(email)) {
    return { ok: true, reason: "pr_or_investor_only", severity: "warn", host };
  }
  if (isFree) {
    return { ok: true, reason: "free_email_no_verify", severity: "warn", host };
  }
  return { ok: true, reason: "ok", severity: "reject", host };
}

/**
 * 批量过滤：从一组 raw emails 中保留合格 buyer emails，按通过 → warn → 全 reject 的顺序排序。
 * @param {string[]} emails
 * @param {string} [expectedDomain]
 * @returns {{ accepted: string[], rejected: Array<{ email: string, reason: string }>, warnings: Array<{ email: string, reason: string }> }}
 */
function filterBuyerEmails(emails, expectedDomain) {
  const accepted = [];
  const warnings = [];
  const rejected = [];
  const seen = new Set();
  if (!Array.isArray(emails)) return { accepted, rejected, warnings };
  for (const raw of emails) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const verdict = isBuyerEmail(normalized, expectedDomain);
    if (!verdict.ok) {
      rejected.push({ email: normalized, reason: verdict.reason });
      continue;
    }
    if (verdict.severity === "warn") {
      warnings.push({ email: normalized, reason: verdict.reason });
    }
    accepted.push(normalized);
  }
  return { accepted, rejected, warnings };
}

module.exports = {
  NON_BUYER_EMAIL_HOSTS,
  FREE_EMAIL_HOSTS,
  PLACEHOLDER_LOCAL_PARTS,
  PLACEHOLDER_FULL_EMAILS,
  PR_INVESTOR_PREFIXES,
  extractEmailHost,
  extractEmailLocal,
  extractRegisteredDomain,
  isNonBuyerEmailHost,
  isFreeEmailHost,
  isPlaceholderEmail,
  isPrOrInvestorEmail,
  isBuyerEmail,
  filterBuyerEmails,
};
