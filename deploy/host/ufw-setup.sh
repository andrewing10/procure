#!/usr/bin/env bash
# Phase 0 / Phase 2 主机防火墙备忘脚本（Ubuntu UFW）
# 用法: sudo bash deploy/host/ufw-setup.sh
# 可选环境变量:
#   SSH_ALLOW_CIDR=x.x.x.x/32   仅允许该源访问 22；未设置则允许任意源的 22（不推荐长期）
#   I_UNDERSTAND_VAST=1         若机器仍挂 Vast，必须显式设置，否则拒绝执行
#
# 警告: Vast.ai 共存时不要跑本脚本 — 可能切断控制面/端口映射。
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 或 sudo 运行" >&2
  exit 1
fi

if [[ "${I_UNDERSTAND_VAST:-}" != "1" ]]; then
  echo "拒绝执行: 未设置 I_UNDERSTAND_VAST=1。" >&2
  echo "若本机仍挂 Vast.ai，启用 UFW 可能锁死 SSH/租户端口。" >&2
  echo "确认无 Vast 或已手工放行所需端口后:" >&2
  echo "  sudo I_UNDERSTAND_VAST=1 SSH_ALLOW_CIDR=x.x.x.x/32 bash $0" >&2
  exit 2
fi

ufw default deny incoming
ufw default allow outgoing

if [[ -n "${SSH_ALLOW_CIDR:-}" ]]; then
  ufw allow from "${SSH_ALLOW_CIDR}" to any port 22 proto tcp comment 'ssh-limited'
else
  echo "警告: 未设置 SSH_ALLOW_CIDR，将允许任意源 SSH。建议改用 Tailscale 或限源。" >&2
  ufw allow 22/tcp comment 'ssh'
fi

ufw allow 80/tcp comment 'http-cf'
ufw allow 443/tcp comment 'https-cf'

# 明确拒绝常见数据库/缓存误暴露（即使某进程 bind 0.0.0.0）
ufw deny 5432/tcp comment 'block-postgres-public'
ufw deny 6379/tcp comment 'block-redis-public'
ufw deny 3000/tcp comment 'block-app-direct'

ufw --force enable
ufw status verbose
echo "完成。Postgres/Redis/应用端口应只监听 127.0.0.1，由 Nginx 反代。"
