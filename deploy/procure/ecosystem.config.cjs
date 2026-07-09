/**
 * pm2 ecosystem — Singapore desktop (Phase 1 procure)
 *
 * 相对 Render（discovery×3 + enrichment×2）下调实例，适配 16GB：
 *   discovery × 2，enrichment × 1
 *
 * Vast.ai 仍在跑时: 把 discovery instances 改为 1，或见 README「保守启动」。
 * 勿给本进程分配 GPU；勿在启用 UFW 前未确认 Vast 端口。
 *
 * 用法（在仓库根目录）:
 *   cp deploy/procure/.env.host.example .env
 *   # 填入密钥后:
 *   pm2 start deploy/procure/ecosystem.config.cjs
 *   pm2 save
 *
 * 扩容: 改 instances 或 pm2 scale procure-discovery 3
 * 环境: 由各入口 load-env.js / dotenv 读仓库根 .env 与 .env.local
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

module.exports = {
  apps: [
    {
      name: 'procure-discovery',
      cwd: ROOT,
      script: 'v8_discovery_worker.js',
      instances: 2,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '30s',
      max_memory_restart: '1800M',
      kill_timeout: 15_000,
      env: {
        NODE_ENV: 'production',
      },
      // pm2 注入 NODE_APP_INSTANCE=0,1,…；与 RENDER_INSTANCE_ID 拼成唯一 claimed_by
      instance_var: 'NODE_APP_INSTANCE',
      merge_logs: true,
      time: true,
      out_file: path.join(ROOT, 'logs/discovery-out.log'),
      error_file: path.join(ROOT, 'logs/discovery-error.log'),
    },
    {
      name: 'procure-enrichment',
      cwd: ROOT,
      script: 'v8_discovery_enrichment_worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '30s',
      max_memory_restart: '2200M',
      kill_timeout: 30_000,
      env: {
        NODE_ENV: 'production',
        ENRICH_WORKER_DEDICATED: '1',
      },
      instance_var: 'NODE_APP_INSTANCE',
      merge_logs: true,
      time: true,
      out_file: path.join(ROOT, 'logs/enrichment-out.log'),
      error_file: path.join(ROOT, 'logs/enrichment-error.log'),
    },
  ],
};
