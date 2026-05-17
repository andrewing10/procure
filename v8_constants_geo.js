/**
 * 与 zhimao apps/web/lib/discovery/matrixDefaults.ts 同源的国家→主要城市字典。
 * Step1 在 matrix.cities 为空且 matrix.deep_search_all_cities=true 时按本表展开多城市扫描。
 * 改动时请同步 zhimao 端，避免「前端勾的城市，worker 收不到」的漂移。
 */
const MAJOR_CITIES = {
  US: ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix'],
  GB: ['London', 'Birmingham', 'Manchester', 'Leeds', 'Bristol'],
  DE: ['Berlin', 'Hamburg', 'Munich', 'Frankfurt', 'Cologne'],
  FR: ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Bordeaux'],
  JP: ['Tokyo', 'Osaka', 'Nagoya', 'Sapporo', 'Fukuoka'],
  KR: ['Seoul', 'Busan', 'Incheon', 'Daegu', 'Daejeon'],
  IN: ['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Hyderabad'],
  AU: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide'],
  CA: ['Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa'],
  BR: ['São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Curitiba', 'Porto Alegre'],
  MX: ['Mexico City', 'Guadalajara', 'Monterrey', 'Puebla', 'Tijuana'],
  AE: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah'],
  SA: ['Riyadh', 'Jeddah', 'Dammam', 'Mecca', 'Medina'],
  TH: ['Bangkok', 'Chiang Mai', 'Phuket', 'Pattaya', 'Khon Kaen'],
  MY: ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Ipoh', 'Kota Kinabalu'],
  SG: ['Singapore'],
  ID: ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Semarang'],
  VN: ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Can Tho'],
  PH: ['Manila', 'Cebu', 'Davao', 'Quezon City', 'Makati'],
  TR: ['Istanbul', 'Ankara', 'Izmir', 'Bursa', 'Adana'],
  PL: ['Warsaw', 'Krakow', 'Lodz', 'Wroclaw', 'Poznan'],
  ZA: ['Johannesburg', 'Cape Town', 'Durban', 'Pretoria', 'Port Elizabeth'],
  NG: ['Lagos', 'Abuja', 'Kano', 'Ibadan', 'Port Harcourt'],
  EG: ['Cairo', 'Alexandria', 'Giza', 'Shubra El-Kheima', 'Port Said'],
  AR: ['Buenos Aires', 'Córdoba', 'Rosario', 'Mendoza', 'La Plata'],
  CL: ['Santiago', 'Valparaíso', 'Concepción', 'Antofagasta', 'Viña del Mar'],
  CO: ['Bogotá', 'Medellín', 'Cali', 'Barranquilla', 'Cartagena'],
  PE: ['Lima', 'Arequipa', 'Trujillo', 'Chiclayo', 'Piura'],
};

/** 首波抓取矩阵支持的 6 个平台（Pillar 映射见 PLATFORM_PILLAR_MAP.md）。 */
const KNOWN_PLATFORMS = [
  'maps',
  'yellowpages',
  'facebook_public',
  'linkedin_snippet',
  'youtube_about',
  'x_public',
];

/**
 * 从 PILLAR0_PAYLOAD（worker 注入的 action_payload 整体）解析出 matrix。
 * 返回的形状与 zhimao sanitizeMatrix() 相同；任何字段缺失都给安全默认。
 */
function readMatrixFromEnv() {
  const raw = process.env.PILLAR0_PAYLOAD || '';
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !parsed.matrix || typeof parsed.matrix !== 'object') {
    return null;
  }
  const m = parsed.matrix;
  const cities = Array.isArray(m.cities)
    ? m.cities.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean).slice(0, 10)
    : [];
  const platforms = Array.isArray(m.platforms)
    ? m.platforms.map((p) => String(p || '').toLowerCase()).filter((p) => KNOWN_PLATFORMS.includes(p))
    : [];
  const deepAll = m.deep_search_all_cities !== false;
  const maxPages = Math.min(5, Math.max(1, parseInt(m.max_pages_per_pillar, 10) || 2));
  const includeSocial = m.include_social_profiles !== false;
  return { cities, platforms, deepAllCities: deepAll, maxPages, includeSocial };
}

/**
 * 给定国家码与 matrix，决定 Step1 maps 类 pillar 实际要扫描的城市列表。
 * - 用户显式 cities → 用之
 * - 否则若 deepAllCities → 取 MAJOR_CITIES（最多 5 个）
 * - 都没有 → 返回空数组（沿用国家级 query，保持向后兼容）
 */
function resolveCitiesForRun(cc, matrix) {
  if (!matrix) return [];
  if (matrix.cities && matrix.cities.length > 0) return matrix.cities.slice(0, 10);
  if (matrix.deepAllCities) {
    const arr = MAJOR_CITIES[String(cc || '').toUpperCase()];
    return Array.isArray(arr) ? arr.slice(0, 5) : [];
  }
  return [];
}

/**
 * platforms 是否启用某项。空 → 全启用（默认全部 6 个）。
 */
function isPlatformEnabled(matrix, platform) {
  if (!matrix || !Array.isArray(matrix.platforms) || matrix.platforms.length === 0) return true;
  return matrix.platforms.includes(platform);
}

module.exports = {
  MAJOR_CITIES,
  KNOWN_PLATFORMS,
  readMatrixFromEnv,
  resolveCitiesForRun,
  isPlatformEnabled,
};
