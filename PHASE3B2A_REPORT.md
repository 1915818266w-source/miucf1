# 第三阶段 B-2A 报告 — 正式数据仓库准备与 DATA_BASE_URL 配置方案

工程：`<workspace>/cfip-regions/` ｜ 性质：只读调查 + 方案设计 + 文档（零代码修改、零远程操作）
本阶段未创建任何 GitHub 仓库、未登录任何账号、未写入任何真实密钥。

---

## 一、DATA_BASE_URL 调查

### 1.1 九处引用逐一定位与分类

| # | 位置 | 内容 | 分类 | 部署时动作 |
|---|---|---|---|---|
| 1 | wrangler.toml:17 | `DATA_BASE_URL = "https://raw.githubusercontent.com/YOUR_USERNAME/cfip-regions/main/data"` | **生产占位符（唯一需替换处）** | 替换为真实 raw 地址 |
| 2 | wrangler.toml:15 | 注释说明"must point at YOUR fork's raw URL" | 注释 | 随 #1 保留 |
| 3 | src/config.mjs:56 | `requireString(env,'DATA_BASE_URL')` 去尾斜杠 | 消费代码（非占位符） | 不动；缺失即 fail-closed 500 |
| 4 | src/data.mjs:5 | 文档注释 | 注释 | 不动 |
| 5 | test/config-sub.test.mjs:14 | `https://example.com/data/` | 单测 fixture（合成地址） | 不动 |
| 6 | test/config-sub.test.mjs:34 | 缺失该变量 → ConfigError 用例 | 单测 | 不动 |
| 7 | tools/run_c_level.sh:21 | `http://127.0.0.1:${PORT_DATA}` | 本地测试 harness | 不动（永不进生产） |
| 8 | docs/DEPLOY.md:28 | 部署文档示例 | 文档 | 随方案更新（本报告替代） |
| 9 | .dev.vars:5 | `http://127.0.0.1:8931` | 本地测试值（gitignored） | 不动 |

**结论：真正需要在部署前替换的只有 1 处（wrangler.toml:17）。** 其余为消费代码、注释、测试合成地址与本地测试值，均不得也不会用于生产。

### 1.2 调用链追踪（完整路径）

```
wrangler.toml [vars] DATA_BASE_URL
  → Workers env.DATA_BASE_URL
  → src/config.mjs:56 resolveConfig() 校验非空 + 去尾斜杠（缺失→ConfigError→全请求 500）
  → src/index.mjs:49 collectNodes(cfg.dataBaseUrl, uuid, regions)
  → src/data.mjs:18 fetch(`${baseUrl}/${region.toUpperCase()}.txt`, {cf:{cacheTtl:300}})
  → sub.mjs:74 仅 status=OK 行进入节点（STALE 永不发布）
  → sub.mjs renderSubscription → base64 订阅体
```

### 1.3 每个地区需要的数据文件

六个地区各一个文件，**全部必需**（缺文件 → 该地区订阅为空，如实缺失）：
`HK.txt`、`JP.txt`、`SG.txt`、`US.txt`、`DE.txt`、`NL.txt`（大写命名，由 data.mjs:18 大写化拼接）。
可选附带 `audit.json`（审计元数据，Worker 不读取，供人工核查）。

### 1.4 文件内容格式（契约，已由管线产出并经 C 级 159 节点实证）

```
# 开头为注释头（meta_updated / source / 格式说明 / colo 真值 / 发布规则）
<address>|<region>|<source>|<first_seen>|<last_checked>|<status>
示例行：
103.31.4.1|us|colo-probe|2026-11-20T01:07:20Z|2026-11-20T01:07:20Z|OK
```
- `address`：IPv4；`region`：hk/jp/sg/us/de/nl 小写；`status`：`OK`（本轮 colo 验证）或 `STALE`（探测故障期保留的历史行，**永不标记为 OK、永不发布**——闸门 sub.mjs:21,74）
- UNKNOWN 行不写入文件（管线 write_outputs 保证）

### 1.5 Worker 实际请求的完整 URL 规则

```
GET {DATA_BASE_URL}/{HK|JP|SG|US|DE|NL}.txt        （无认证头；依赖仓库公开可读）
```
**示例（明确标注为示例，非真实地址）**：
`https://raw.githubusercontent.com/<你的GitHub用户名>/cfip-regions/main/data/US.txt`
缓存：Workers 边缘 `cacheTtl=300` 秒 + raw.githubusercontent 自身 CDN 缓存 → 数据陈旧最坏约 10 分钟，与每小时更新匹配。

### 1.6 GitHub Actions 自动更新需求：确认存在且必需

`.github/workflows/update.yml`：`cron 0 * * * *` 每小时 + 手动触发；`permissions: contents: write`（:12-13）；`concurrency: cfip-regions-update` 防并发（:15-16）；提交信息 `[skip ci]` 防递归；RC=2 源故障不触碰数据、全灭降 STALE、`::error` 显式失败（3A.1 修复后 45/45 回归覆盖）。**没有它数据将永久停留在首跑状态——自动更新为必需项。**

### 1.7 权限区分

| 主体 | 需要的权限 | 说明 |
|---|---|---|
| Worker（读） | **无任何 GitHub 凭据** | raw.githubusercontent 公开仓库免认证读取；数据文件仅含 Cloudflare IP 与元数据，公开无敏感泄露 |
| GitHub Actions（写数据） | 默认 `GITHUB_TOKEN` + `contents: write` | 同仓库内提交；需仓库 Settings → Actions → General → Workflow permissions 允许写（见 4.2），workflow 级已显式声明 |
| 跨仓库写（仅方案 A 变体） | 细粒度 PAT（Contents: Read and write，仅限数据仓库） | **推荐方案设计已规避**——不需要 PAT |

## 二、数据仓库设计

### 方案 B（推荐）：单一仓库 `cfip-regions`，数据位于 `data/`

```
cfip-regions/                      ← 用户创建的唯一 GitHub 仓库（Public）
├── src/                           Worker 源码（现状不变）
├── pipeline/                      update_data.py + test_update_data.py + sources.json
├── data/                          ★ 数据区（六地区 + audit.json）
│   ├── HK.txt JP.txt SG.txt US.txt DE.txt NL.txt
│   └── audit.json
├── .github/workflows/update.yml   每小时更新并提交 data/（已建成）
├── .github/workflows/ci.yml       测试（已建成）
└── wrangler.toml                  DATA_BASE_URL → .../cfip-regions/main/data
```

- DATA_BASE_URL = `https://raw.githubusercontent.com/<用户名>/cfip-regions/main/data`
- 与 CloudflareIP 原仓库零关系（独立实现，无任何其代码/文件）
- **无需 PAT**（GITHUB_TOKEN 同仓库写）；仓库需 Public（Worker 免认证读取；代码与数据均无密钥，公开安全——已由 30 项安全探测与占位符审计证实）
- 满足"只存放本工程生成的地区数据和必要元数据"：data/ 目录即数据区；仓库其余为代码（公开无敏感项）

### 方案 A（备选）：专用纯数据仓库 `cfip-regions-data`

```
cfip-regions-data/                 ← 额外创建的 Public 仓库（仅数据+管线+更新工作流）
├── data/{HK,JP,SG,US,DE,NL}.txt + audit.json
├── pipeline/update_data.py + sources.json     ← 每轮运行时从代码仓库拉取（见下）
└── .github/workflows/update.yml  每小时提交 data/
```

- DATA_BASE_URL = `https://raw.githubusercontent.com/<用户名>/cfip-regions-data/main/data`
- 数据提交与代码提交完全隔离；**代码仓库可设 Private**（若其 update.yml/ci.yml 不再需要跑数据链路）
- 防管线漂移设计：数据仓库 update.yml 运行时 `actions/checkout` 直接拉取公开代码仓库的 `pipeline/`（Public 仓库跨仓库 checkout **无需 PAT**），保证始终用最新管线
- 代价：两个仓库、两次推送、工作流拆分；仅当用户要求"代码私有/数据物理隔离"时选择

**推荐：方案 B**（组件最少、零跨仓库凭据、工作流已建成并测过 131/131）。两方案Worker 侧代码零改动——仅 wrangler.toml 一行地址不同。

## 三、数据更新机制确认

1. **生成者**：数据仓库内的 `update.yml`（每小时）调用 `pipeline/update_data.py`。
2. **提交方式**：脚本写 `data/*.txt` + `audit.json` → `git add data/` → 有变更才 commit（`update region data <UTC时间> [skip ci]`）→ push；无变更输出 "No data changes"。
3. **Worker 获取**：每次订阅请求经 5 分钟边缘缓存拉取 raw 文件，实时解析，仅 OK 行发布。
4. **源不可用保底**：RC=2 数据零触碰（实测字节级不变）；全量探测失败 → 历史行降 STALE 保留（last_checked 冻结原验证时间），不淘汰不新增。
5. **对现有订阅的影响（如实）**：源故障 → 订阅完全不变；全灭期 → STALE 不发布，订阅可能短暂变空（客户端已导入节点仍在）——宁空勿假的既定代价；部分失败 → 仅失效节点消失。任何故障都不会把 STALE/未验证数据发布为 OK。
6. **缓存/版本/回滚**：Worker 边缘缓存 300s（无需 KV/版本号服务）；数据回滚 = 数据仓库 git revert / 任意历史版本 checkout；代码回滚 = `wrangler versions rollback`（100 版保留）。故障历史在 audit.json + git 历史双留痕。

## 四、用户手动操作指南（方案 B；方案 A 差异见括注）

### 4.1 创建仓库（网页路径）

1. 登录 GitHub → 右上角 **「+」→「New repository」**（或直达 `https://github.com/new`）
2. 字段填写：
   - **Repository name**：`cfip-regions`（方案 A 另建 `cfip-regions-data`）
   - **Description**：可选，如 "Six-region Cloudflare VLESS node data & worker"
   - **Public / Private**：**必须选 Public**——Worker 经 raw.githubusercontent 免认证读取数据；代码与数据文件经审计不含任何密钥（占位符 9 处核查 + .dev.vars 已 gitignore）。Private 的 raw URL 需要令牌认证，Worker 无法也不应内嵌 GitHub 凭据
   - **Initialize this repository with**：勾选 `Add a README`（其余 Add .gitignore / license 不勾，LICENSE 文件随推送带入）
   - 默认分支保持 **main**（GitHub 默认即 main）
3. 点击 **「Create repository」**

### 4.2 开启 Actions 写权限（数据自动提交必需）

仓库页 → **「Settings」→ 左栏「Actions」→「General」→ 拉到「Workflow permissions」**→ 选 **「Read and write permissions」**→ Save。
（update.yml 已有 workflow 级 `permissions: contents: write` 声明；此项确保仓库默认策略不拦截。方案 A 的数据仓库同样需要。）

### 4.3 推送工程内容

```bash
cd <workspace>/cfip-regions
git init -b main && git add -A && git commit -m "cfip-regions: worker + pipeline + region data"
git remote add origin https://github.com/<你的用户名>/cfip-regions.git
git push -u origin main        # 推送时按提示完成 GitHub 认证（人工操作）
```
推送前确认 `.gitignore` 生效（node_modules/.wrangler/.dev.vars 不入库——已配置）。
（方案 A：再把 data/ + pipeline/ + update.yml 单独推送一份到 cfip-regions-data，代码仓库 workflows 中的路径按需微调。）

### 4.4 启用并验证 Actions

仓库页 → **「Actions」标签 → 若有 Enable 提示点击启用** → 左侧选「Update region data」→ **「Run workflow」**手动触发一次 → 观察运行结果与 `data/` 新提交（::error/::warning 会直接显示在运行日志中，无静默失败）。

### 4.5 PAT 需求

- **方案 B：不需要任何 PAT**（GITHUB_TOKEN 自动提供，权限由 4.2 开启）。
- 仅方案 A 的跨仓库 checkout 若代码仓库设为 Private 时，才需要细粒度 PAT：Settings → Developer settings → Fine-grained tokens → 仅勾选所需仓库 + `Contents: Read`；**本报告推荐配置下（双仓库 Public）PAT 需求为零**。绝不把任何 Token 写入本工程文件。

## 五、替换配置后需重跑的测试清单（3B-2 执行时）

| 步骤 | 内容 | 对应基线 |
|---|---|---|
| T1 | `node --check` 全部 src（地址替换不触代码，防误改） | 6/6 |
| T2 | `wrangler deploy --dry-run` 确认 vars 回显真实地址、bundle 不变 | Total Upload ≈17.69KiB |
| T3 | B 级全量 `node --test`（config fail-closed 用例覆盖地址缺失/非法场景） | 29/29 |
| T4 | C 级本地仿真 e2e（本地数据服务路径未变，验证无回归） | 7/7 |
| T5 | 安全探测 + 订阅校验（地址替换后订阅契约不变） | 30/30、12/12 |
| T6 | 管线回归 + 离线自测（数据文件本身不动，确认管线稳定） | 45/45、RC=0 |
| T7 | 真实地址连通冒烟：`curl -s -o /dev/null -w "%{http_code}" <真实raw地址>/US.txt` | 200 |
| T8 | 全量合计基线复核 | **131/131** |

## 六、停止声明

本阶段为纯方案交付：未创建仓库、未推送、未登录 GitHub/Cloudflare、未修改任何工程文件（本报告为唯一新增文档）、未执行部署。DATA_BASE_URL 的唯一生产占位符（wrangler.toml:17）保持原样等待 3B-2 真实地址回填。
