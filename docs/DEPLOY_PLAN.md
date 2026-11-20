# 3B-2 部署执行方案（Runbook）— 待单独授权后执行

本文档是 3B-1 的交付物。**3B-2 未获授权前，以下任何步骤都不得执行。**
本方案不含任何真实密钥；所有占位符在执行时现场生成。

> **数据仓库方案已选定：方案 B（B-2A 报告）**——单一 Public 仓库 `cfip-regions`，
> 数据位于 `data/`，DATA_BASE_URL = `https://raw.githubusercontent.com/<用户名>/cfip-regions/main/data`，
> 无需 PAT。本地仓库已按方案 B 初始化并完成首次提交（见 PHASE3B2B_REPORT.md）；
> 剩余：用户创建 GitHub 仓库 → 推送 → 开启 Actions 写权限 → 回填 DATA_BASE_URL。

## 0. 部署前置检查单（全部勾选才可开始）

| # | 项 | 状态 |
|---|---|---|
| P1 | 人工已授权 3B-2（明确到"允许 wrangler deploy"） | ⬜ |
| P2 | GitHub 仓库 `cfip-regions` 已由用户创建（Public）且工程已推送（含 data/ 六地区 + audit.json + workflows） | ⬜ |
| P3 | `wrangler.toml` DATA_BASE_URL 已回填为 `https://raw.githubusercontent.com/<用户名>/cfip-regions/main/data` 并通过 T1–T8 复测 | ⬜ |
| P4 | `npx wrangler login` 已由人工完成（本工程不保存任何凭据） | ⬜ |
| P5 | 本地全量测试最后一次全绿（131 用例基线 + T7 地址冒烟 200） | ⬜ |

## 1. 密钥生成（现场一次性，不入库不外发）

```bash
VLESS_UUID=$(cat /proc/sys/kernel/random/uuid)          # 部署实例独立 UUID
WS_PATH="/t-$(openssl rand -hex 8)"                     # 固定 WS 路径（≥8 字符）
SUB_TOKEN=$(openssl rand -hex 16)                       # 订阅凭据（≥16 字符）
# 记录到本地密码管理器；禁止写入仓库、聊天、截图
```

## 2. Secrets 写入（Cloudflare 侧，非仓库）

```bash
npx wrangler secret put VLESS_UUID      # 交互粘贴
npx wrangler secret put WS_PATH
npx wrangler secret put SUB_TOKEN
# 可选：npx wrangler secret put PROXY_IPS   （仅自持且验证过的回退中继）
```

## 3. 部署

```bash
npx wrangler deploy
# 记录输出中的 https://cfip-regions.<account>.workers.dev
# 回填 wrangler.toml [vars] WORKER_URL（或 wrangler secret put WORKER_URL）
```

## 4. D 级验证矩阵（部署后立即执行）

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| D1 | 存活页 | `curl -s https://<host>/` | `cfip-regions worker: OK`，无任何密钥字样 |
| D2 | 错误订阅凭据 | `curl -s -o /dev/null -w "%{http_code}" https://<host>/sub/wrong` | 404 |
| D3 | 正确订阅 | `curl -s https://<host>/sub/<SUB_TOKEN> \| base64 -d \| head -2` | 纯 vless:// 行，地区名 CF-US-/CF-DE- |
| D4 | 地区过滤 | `?region=us` 仅 US；`?region=hk` 空（如实） | 同左 |
| D5 | WS 错误路径 | 升级请求打 `/wrong-path` | 403 |
| D6 | VLESS 隧道 | NekoBox 导入单条链接连 `tcpbin.com:4242` 类回声服务 | 收到回显 |
| D7 | 出口观测 | 隧道内访问 `https://www.cloudflare.com/cdn-cgi/trace` | 记录 `colo=`/`ip=`（补全出口真值） |
| D8 | 订阅客户端更新 | NekoBox 订阅分组更新 | 节点数与 D3 一致 |

任一失败 → 进入 §6 失败处理；D1–D8 全过 → 视为 D 级通过，进入 E 级（人工真机）。

## 5. 回滚方案

| 场景 | 动作 |
|---|---|
| 部署后功能异常 | `npx wrangler versions list` → `npx wrangler versions rollback`（保留最近 100 版） |
| Secrets 配置错误 | 重新 `wrangler secret put`（secret 更新即时生效，无需回滚代码） |
| 数据源异常（订阅空） | 检查 DATA_BASE_URL 是否指向 fork raw 且 data/ 已推送；数据文件由 Actions 每小时维护，源故障自动保底（RC=2 不触碰、全灭降 STALE） |
| 需要下线 | `npx wrangler delete`（删除部署，不影响 GitHub 仓库与数据） |
| 账号级应急 | Dashboard → Workers → cfip-regions → Settings → Disable（秒级停用入口流量） |

回滚验证：执行后重跑 D1–D5 确认状态恢复。

## 6. 失败处理（已知风险 → 处置）

| 症状 | 根因假设 | 处置 |
|---|---|---|
| 部署报 `Script startup exceeded CPU time limit` | 全局域过重（本项目 17.7KiB，可能性极低） | `npx wrangler check startup`；精简全局域 |
| WS 全部握手失败（D6） | **G-3**：动态 `import("cloudflare:sockets")` 在 workerd 行为不符预期 | 一行改静态导入 `import { connect } from 'cloudflare:sockets'`（session.mjs 顶部），重部署 |
| 隧道建立但二进制帧异常 | binaryType 相关（G-4 已钉死，剩余风险极低） | 收集 trace；必要时在 `binarytype.test.mjs` 基础上补 Blob 兼容分支 |
| 订阅 200 但空 | DATA_BASE_URL 指错 / fork 未推送 data/ | 核对 P2/P3；Actions 手动触发补数据 |
| 订阅含 STALE 为空属正常 | 探测层故障期（管线保底降级） | 等待恢复轮自动回升 OK；勿手工改数据文件 |
| Error 1027 | 免费计划日请求超 10 万 | 核对用量；订阅路径加缓存或降低更新频率 |
| Error 1102 | CPU 超限（重度长会话） | 属免费计划固有约束；观察是否持续，必要时限流 |

## 7. 明确不做（3B-2 授权边界）

- 不修改 cold-salad-8f76 或任何既有 Worker/域名/路由
- 不修改 GitHub Secrets（本项目不使用 Actions secrets）
- 不在仓库/文档/日志写入真实 UUID、SUB_TOKEN、WS_PATH
- 不把 C 级 Node 仿真结果表述为真实 Cloudflare 测试结果（D 级以 §4 为准）
