# 第三阶段部署步骤（待人工批准后执行）

本阶段未执行以下任何一步；以下为批准后的操作序列。

## 0. 前置

- Cloudflare 账号（免费计划即可）；wrangler 已登录（`npx wrangler login`，人工完成）
- GitHub 上已创建独立仓库并推本工程（用户自己 `git init && git remote add && git push`）

## 1. 生成部署期密钥（一次性，不入库）

```bash
VLESS_UUID=$(cat /proc/sys/kernel/random/uuid)
WS_PATH="/t-$(openssl rand -hex 8)"
SUB_TOKEN=$(openssl rand -hex 16)
echo "UUID=$VLESS_UUID WS=$WS_PATH SUB=$SUB_TOKEN"   # 私自保存
```

## 2. 配置 Secrets

```bash
npx wrangler secret put VLESS_UUID    # 粘贴 $VLESS_UUID
npx wrangler secret put WS_PATH       # 粘贴 $WS_PATH
npx wrangler secret put SUB_TOKEN     # 粘贴 $SUB_TOKEN
```

非敏感 vars 直接改 `wrangler.toml`：
`DATA_BASE_URL=https://raw.githubusercontent.com/<你>/cfip-regions/main/data`、
`WORKER_URL=https://<worker-name>.<account>.workers.dev`（部署后回填）。

## 3. 部署

```bash
npx wrangler deploy            # 产出 https://<name>.<account>.workers.dev
```

> Workers 免费计划：100,000 请求/天、10ms CPU/请求、无 KV 必需。
> 本 Worker 单请求 CPU 远低于 10ms（订阅路径 ~1ms 量级；代理路径 CPU 只做转发拼接）。

## 4. 验证（D 级）

```bash
curl -s https://<host>/                      # -> cfip-regions worker: OK
curl -s https://<host>/sub/<SUB_TOKEN> | base64 -d | head -3   # vless 链接
curl -s -o /dev/null -w "%{http_code}\n" https://<host>/sub/wrong  # 404
```

## 5. 启用 Actions 更新

推送到 GitHub 后 Settings → Actions 允许运行；`update.yml` 每小时跑，
数据文件自动更新并提交。首次运行后检查 `data/audit.json` 的地区分布。

## 6. NekoBox 导入（E 级）与真机测试（F 级）

订阅 URL：`https://<host>/sub/<SUB_TOKEN>`（或 `?region=us` 等）。
NekoBox → 订阅分组 → 新建 → 更新。测速确认连通，并访问
`https://cloudflare.com/cdn-cgi/trace` 确认 `warp=off` 且出口为 Cloudflare 出口 IP
（此时记录真实出口，补全审计中的第四概念）。

## 7. 可选：PROXY_IPS

仅当自持验证过的回退中继时 `wrangler secret put PROXY_IPS`（`host:port` 逗号分隔）。
默认不配置——未验证的反代不引入。
