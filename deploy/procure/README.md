# procure → 新加坡台式机（Phase 1）

Worker 迁本机，**数据仍写云端 Supabase**。不需要 Nginx / 公网入站。

对照 Render：[`render.yaml`](../../render.yaml) 中 `zhimao-v8-discovery-worker`（×3）+ `zhimao-v8-enrichment-worker`（×2）。

## Vast.ai 共存

机器若仍在 Vast 上出租：

1. **不要**跑 `deploy/host/ufw-setup.sh`、不要动 NVIDIA/Docker
2. procure 只用 **CPU + RAM**；不要 `CUDA_VISIBLE_DEVICES` 指给 Node
3. 实例数先 **discovery×1 + enrichment×1**（比默认 ecosystem 的 ×2 更保守）
4. 先看空闲内存再启动：`free -h`；建议可用内存 ≥6GB 再开 Playwright
5. NVIDIA apt 的 `trusted.gpg` 警告可忽略

有 Vast 时启动方式见下方「保守启动」。

## 1. 主机准备

见 [`../host/README.md`](../host/README.md)。至少需要 Node 20 + pm2。

```bash
# 有 /opt 权限：
sudo mkdir -p /opt/zhimao && sudo chown "$USER:$USER" /opt/zhimao
cd /opt/zhimao
git clone <本仓 URL> procure
cd procure

# 或无 sudo：
mkdir -p ~/zhimao && cd ~/zhimao
git clone <本仓 URL> procure && cd procure
```

## 2. 环境变量

```bash
cp deploy/procure/.env.host.example .env
chmod 600 .env
# 从 Render Dashboard 把密钥填进 .env
```

密钥来源：Render → 对应 worker → Environment。`sync: false` 的项必须手工复制。

常用调参：`ENRICH_TOP_N=30`（Step2 后只对最好的 N 条跑 Step3；溢出轻量入库、低分排后展示；`<=0` 关闭）。

## 3. 依赖

```bash
npm ci
npx playwright install chromium
mkdir -p logs
```

### Playwright 系统库（Step3 必需）

只装浏览器二进制不够。缺库时 Step3 会报：
`error while loading shared libraries: libasound.so.2`

在服务器执行（**只装 Chromium 依赖，勿动 nvidia 源**）：

```bash
# 优先：Playwright 官方依赖（推荐）
sudo npx playwright install-deps chromium

# 若上面太重 / 失败，最小补丁：
# Ubuntu 22.04:
sudo apt-get install -y libasound2
# Ubuntu 24.04:
# sudo apt-get install -y libasound2t64

# 验证能启动：
node -e "const {chromium}=require('playwright'); chromium.launch({headless:true}).then(b=>{console.log('browser ok'); return b.close()})"
```

装完后 `pm2 restart all`，再在平台重提任务（或等队列重试）。

## 4. 冒烟（启动前）

```bash
npm run test:quality-smoke
free -h
```

## 5. 用 pm2 启动

### 默认（无 Vast / 内存宽裕）

```bash
pm2 start deploy/procure/ecosystem.config.cjs
pm2 status
pm2 logs procure-discovery --lines 100
```

### 保守启动（Vast 仍在跑时推荐）

```bash
# 只起 1 个 discovery + 1 个 enrichment，并限制并发
export STEP3_PAGE_CONCURRENCY=4
pm2 start v8_discovery_worker.js --name procure-discovery -i 1 \
  --max-memory-restart 1500M --time
pm2 start v8_discovery_enrichment_worker.js --name procure-enrichment -i 1 \
  --max-memory-restart 1800M --time
pm2 save
```

或改 [`ecosystem.config.cjs`](ecosystem.config.cjs) 里 `procure-discovery` 的 `instances: 1` 后再 `pm2 start`。

开机自启：

```bash
pm2 startup
pm2 save
```

## 6. 切换（避免双跑抢单）

1. **本机已稳定跑通至少 1 个完整 job**
2. Render：**Suspend** discovery / enrichment workers（先停勿删）
3. 本机单独承担队列，观察 ≥24h
4. 再删除 Render 服务；保留 env 备份一周

回滚：Render Resume，本机 `pm2 stop all`。

## 7. 运维常用

```bash
pm2 restart procure-discovery
pm2 scale procure-discovery 2    # 确认 free -h 有余量再加
pm2 monit
tail -f logs/discovery-out.log
```

## 8. 成功标准

- discovery / enrichment 稳定 ≥24h，无 OOM，**Vast 租户未因内存被杀**
- Supabase 任务与 L1 写入正常
- Render procure worker 已停

## 网络慢？对比 Render

本机内存再大也救不了 **BrightData 代理 RTT**。在服务器跑：

```bash
cd ~/zhimao/procure
# 先 scp 本文件，或 git pull 后：
node deploy/procure/net-bench.js
```

看输出里 **C. 同站：直连 vs 经代理**。若 `via BrightData` 是 `direct` 的数倍，瓶颈就是代理。  
可临时 `USE_PROXY=false` 后 `pm2 restart all` 跑一单对比（SG 出口对本地站通常更快）。

详见脚本头注释。

## 文件

| 文件 | 作用 |
|------|------|
| [`ecosystem.config.cjs`](ecosystem.config.cjs) | pm2 进程定义 |
| [`.env.host.example`](.env.host.example) | 本机 env 模板 |
| [`bootstrap.sh`](bootstrap.sh) | 依赖安装 |
| [`net-bench.js`](net-bench.js) | 直连 vs BrightData 延迟诊断 |
| [`../host/`](../host/) | UFW / Nginx（Vast 停租后再用） |
