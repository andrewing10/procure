/**
 * 品类词净化 — 与 zhimao apps/web/lib/discovery/categorySanitize.ts 同步，并扩展口语查询清洗。
 *
 * 目标：把用户口语搜词压成可搜的产品/品类名词，避免整句进 Serper / L3 reverse。
 *
 * 例：
 *   "新加坡有没有电视机"     → "电视机"
 *   "新加坡 白菜" / "SG 白菜" → "白菜"
 *   "· · 有没有日本大米 · ·" → "日本大米"  （「日本」是品类一部分，不剥）
 *   "居銮红酒买家"           → "居銮红酒"
 *   "LED lighting buyers in Singapore" → "LED lighting"
 *   "SG · · 有没有 土豆 · ·" → "土豆"
 */
'use strict';

/** 搜索国前缀（只剥「搜索目标国」，不剥品类里的产地国名如「日本大米」） */
const GEO_NAME =
  '新加坡|韩国|中国|美国|英国|德国|法国|澳洲|澳大利亚|马来西亚|泰国|越南|印尼|印度尼西亚|菲律宾|印度|台湾|香港|澳门|' +
  'Singapore|Korea|China|USA|United\\s+States|UK|United\\s+Kingdom|Germany|France|Australia|Malaysia|Thailand|Vietnam|Indonesia|Philippines|India|Taiwan|Hong\\s+Kong';

/** 「日本」仅在「有没有」口语意图时与国家一起剥；单独「日本大米」保留 */
const GEO_NAME_WITH_JP = `${GEO_NAME}|日本|Japan`;

const GEO_ISO = 'SG|US|UK|JP|CN|MY|TH|VN|ID|IN|KR|TW|HK|DE|FR|AU|PH';

const COLLOQUIAL =
  '有没有|有冇|有木有|哪里有|哪儿有|求购|想买|帮我找|帮我搜|搜索|查询|请问|我想找|我要找|谁有|谁卖|谁进口';

/** 装饰性间隔符 */
const DECORATION_RE = /[·•‧∙⋅．。…]+/g;

function sanitizeDiscoveryCategory(category) {
  let raw = String(category || '').trim();
  if (!raw) return raw;

  raw = raw.replace(DECORATION_RE, ' ').replace(/\s+/g, ' ').trim();

  let cleaned = raw
    .replace(/\s+buyers?\s+(?:in|from|at|within|across|for)\s+.+$/i, '')
    .replace(/[\s]*(买家|进口商|购买者|采购商|采购方|采购代理|批发商|经销商)\s*$/i, '')
    .replace(/[\s]+(buyer|buyers|importer|importers|purchaser|purchasers|wholesaler|distributor)s?\s*$/i, '')
    .trim();

  // 1) 「新加坡有没有X」/「SG 有没有 X」：国家+意图一起剥（含日本，因口语「日本有没有X」）
  const geoIntent = new RegExp(
    `^(?:${GEO_NAME_WITH_JP}|${GEO_ISO})\\s*(?:${COLLOQUIAL})\\s*`,
    'i',
  );
  cleaned = cleaned.replace(geoIntent, '').trim();

  // 2) 仅口语意图前缀：「有没有日本大米」→「日本大米」
  const intentOnly = new RegExp(`^(?:${COLLOQUIAL})\\s*`, 'i');
  cleaned = cleaned.replace(intentOnly, '').trim();

  // 3) 「新加坡 白菜」/「SG 白菜」/「Singapore cabbage」：搜索国 + 空白 + 品类
  //    不剥「日本大米」（无空白、或日本是产地品类的一部分且无搜索国空白结构时保留）
  //    仅当国家后有空白且后面还有实质品类词时剥离。
  const geoSpaceProduct = new RegExp(
    `^(?:${GEO_NAME}|${GEO_ISO})\\s+(?=\\S)`,
    'i',
  );
  const afterGeo = cleaned.replace(geoSpaceProduct, '').trim();
  // 剥完后仍有内容才采用（避免「新加坡」单独被掏空）
  if (afterGeo && afterGeo.length >= 1 && afterGeo !== cleaned) {
    cleaned = afterGeo;
  }

  // 4) 残留句首 ISO 国家码 + 中文产品：「SG 土豆」已在 3 覆盖；兜底无空白的「SG土豆」
  cleaned = cleaned.replace(new RegExp(`^(?:${GEO_ISO})(?=[\\u4e00-\\u9fff])`, 'i'), '').trim();

  // 5) 英文尾缀 in Singapore
  cleaned = cleaned
    .replace(/\s+in\s+(Singapore|Japan|Korea|China|USA|United\s+States|Malaysia|Thailand|Vietnam|Indonesia|India|Taiwan)\s*$/i, '')
    .trim();

  if (!cleaned || cleaned.length < 1) return raw;
  return cleaned;
}

module.exports = { sanitizeDiscoveryCategory };
