#!/usr/bin/env bash
# 一键安装依赖并校验（在仓库根目录执行）
# 用法: bash deploy/procure/bootstrap.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  if [[ -f deploy/procure/.env.host.example ]]; then
    cp deploy/procure/.env.host.example .env
    chmod 600 .env
    echo "已创建 .env — 请填入 Render 密钥后再启动"
  else
    echo "缺少 .env 与 .env.host.example" >&2
    exit 1
  fi
fi

npm ci
npx playwright install --with-deps chromium
mkdir -p logs

npm run test:quality-smoke

echo ""
echo "下一步:"
echo "  1. 编辑 $ROOT/.env 填入密钥"
echo "  2. pm2 start deploy/procure/ecosystem.config.cjs"
echo "  3. 确认 claim 正常后，Suspend Render 上的 discovery/enrichment workers"
echo "  详见 deploy/procure/README.md"
