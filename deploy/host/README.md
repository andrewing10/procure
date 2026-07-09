# Phase 0 — 新加坡台式机主机基线

目标：把本机当成自建机房。长期入口为 **固定公网 IP + Nginx + Cloudflare 橙色云代理**。  
`procure` 是纯 worker，**不需要公网入站**；本目录配置主要服务 Phase 2+（Chatwoot / hub / fleet）。

## Vast.ai 共存（重要）

这台机若仍挂在 Vast / 算力出租，**不要按「干净家用机」乱改系统**：

| 不要做 | 原因 |
|--------|------|
| `ufw --force enable` 一刀切 | 可能切断 Vast 控制面、SSH、实例端口映射 |
| 卸/重装 NVIDIA 驱动、`nvidia-docker`、改 Docker daemon | 破坏租户 GPU 容器 |
| `apt remove` 旧 nvidia apt 源相关包「顺手清理」 | 日志里的 `trusted.gpg` 警告可忽略，勿为消警告乱动 |
| 占用 GPU / 改 CUDA 环境变量给 Playwright | procure **不需要 GPU**；GPU 留给 Vast |
| 改默认路由、网卡、公网 IP 绑定方式 | 固定 IP / Vast 入口可能失效 |
| 在系统全局装冲突的 Node/Docker 大版本升级 | 先确认 Vast 实例是否依赖现有 Docker |

**可以做：**

- 在用户目录或 `/opt/zhimao` 下 clone 跑 Node worker（CPU + 内存）
- 用 **pm2** 管 procure（不要用会抢 GPU 的容器运行时去跑它）
- 内存限额：`max_memory_restart`、下调 `STEP3_PAGE_CONCURRENCY`
- 防火墙：先 `sudo ufw status` / `sudo iptables -L -n`，看 Vast 已有规则；**有 Vast 在跑时默认不要启用我们的 `ufw-setup.sh`**
- NVIDIA apt `Key is stored in legacy trusted.gpg` 警告：**忽略即可**，与 procure 无关

Phase 1 建议路径：先只跑 procure worker，**不动 UFW / Nginx / Docker / 驱动**。等确认不再把整机租给 Vast，或已划清端口/网段后再做 Phase 0 防火墙与 Phase 2 反代。

## 建议 OS

- 优先：Ubuntu 22.04 / 24.04（你当前环境已有 Node 20 即可）
- 若台式机是 Windows：用 WSL2 Ubuntu + Docker Desktop，路径把 `/opt/zhimao` 换成 `~/zhimao` 即可

## 目录约定

```text
/opt/zhimao/
  procure/          # 本仓 clone；.env 权限 600
  chatwoot/         # Phase 2 Docker Compose（Vast 停租后再上）
  hub/              # Phase 3 zhimao-hub
  fleet/            # Phase 3 zhimao-fleet-api
  nginx/            # 站点 conf 片段（可选）
```

若无 root 写 `/opt`，用家目录：

```bash
mkdir -p ~/zhimao && cd ~/zhimao
# 后续文档里的 /opt/zhimao 换成 ~/zhimao
```

有 sudo 时：

```bash
sudo mkdir -p /opt/zhimao/{procure,chatwoot,hub,fleet,nginx}
sudo chown -R "$USER:$USER" /opt/zhimao
```

## 软件安装（Ubuntu）— 最小集（Vast 安全）

```bash
# Node 20 — 你已安装可跳过（勿重复折腾 nodesource）
node -v   # 期望 v20.x

# 仅用户级 pm2（不必动系统 Docker）
sudo npm i -g pm2

# git 一般已有
git --version
```

**暂缓（等 Vast 停租或确认无冲突后再装）：** Docker 重装、Nginx、certbot、`ufw-setup.sh`。

## 防火墙

有 Vast 时：**不要**直接跑 [`ufw-setup.sh`](ufw-setup.sh)。

先检查：

```bash
sudo ufw status verbose || true
sudo ss -tlnp | head -50
```

记下 Vast / SSH / 已映射端口。将来启用 UFW 时必须把这些端口一并 `allow`，且优先用 `SSH_ALLOW_CIDR` 限源。

无 Vast、本机自用后，才执行：

```bash
sudo SSH_ALLOW_CIDR=x.x.x.x/32 bash /path/to/procure/deploy/host/ufw-setup.sh
```

**禁止**把 Postgres / Valkey / Redis 端口映射到公网。

## Cloudflare + Nginx（Phase 2 起；Vast 停租后）

1. 域名 A 记录指向台式机固定公网 IP，代理状态：**已代理（橙色云）**
2. SSL/TLS 模式建议 **Full (strict)**
3. 源站 Nginx 示例见 [`nginx.conf.example`](nginx.conf.example)
4. 本机只放行 80/443；数据库仅 `127.0.0.1`

## 资源备忘（16GB + Vast）

| 阶段 | 大致占用 |
|------|----------|
| Vast 租户容器（若在跑） | **优先保证**，勿被 Playwright 挤爆 |
| 仅 procure（discovery×1–2 + enrichment×1） | 建议先 discovery×**1**，并发 4–6 |
| + Chatwoot 等 | 等 Vast 停或内存余量稳定 >6GB 再上 |

全量偏紧时优先降低 `STEP3_PAGE_CONCURRENCY` 与 discovery 实例数。

## 开机自启

```bash
pm2 startup
pm2 save
```

注意：`pm2 startup` 会写 systemd；确认不会与 Vast 的实例生命周期脚本冲突。若 Vast 会重装用户环境，把 clone 放在持久磁盘路径。
