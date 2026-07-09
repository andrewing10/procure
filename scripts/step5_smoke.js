/**
 * 本机验证：用 fixtures/step5_smoke_input.json 直写 Supabase L1 + graph_edges。
 * 用法：在项目根目录配置 .env 或 .env.local（推荐 local）中的 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY 后执行
 *   npm run smoke:step5
 */
require('../load-env');
const fs = require('fs');
const path = require('path');
const { createSupabaseClient } = require('../v8_supabase_client');
const { directIngestQualifiedLeads } = require('../v8_direct_l1_ingest');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'step5_smoke_input.json');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      '[smoke] 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY。请在仓库根目录创建 .env 或 .env.local（可参考 .env.example）并填写后再运行。',
    );
    process.exit(2);
  }

  const leads = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  console.log('[smoke] fixture:', fixturePath, 'leads:', leads.length);

  const supabase = createSupabaseClient(url, key);

  const result = await directIngestQualifiedLeads(supabase, leads, { discoveryJobId: null });
  console.log(
    '[smoke] result:',
    JSON.stringify(
      {
        ok: result.ok,
        resolvedLeads: result.resolvedLeads,
        edgesWritten: result.edgesWritten,
        errors: result.errors,
      },
      null,
      2,
    ),
  );

  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[smoke] fatal:', e);
  process.exit(1);
});
