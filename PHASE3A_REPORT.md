# 第三阶段 A 报告 — 部署前安全复核（只读审查）

审查对象：`/root/workspace/cfip-regions/`（第二阶段产物，本阶段零改动）
执行时间：2026-11-20；审查方式：只读代码审阅 + 官方文档核对 + 本地测试（临时文件均在 /tmp）
**本阶段未修改任何源代码/配置，未登录 Cloudflare，未触碰 cold-salad-8f76 或任何线上服务，未生成真实密钥（探测用凭据为内存内一次性随机值，未落盘）。**

测试汇总：A 级 6/6 模块 + dry-run ✅｜B 级 27/27 ✅｜C 级 7/7 ✅｜安全探测 29/29 ✅｜订阅校验 12/12 ✅｜数据抽检 8/8 ✅｜更新保底测试：**发现 1 个关键缺陷** ❌

---

## A. 部署配置检查结果

| 项 | 结论 | 证据 |
|---|---|---|
| wrangler.toml | ✅ 合规：`name=cfip-regions`、`main=src/index.mjs`、无 routes/zone（纯 workers.dev）、零密钥（vars 仅 3 个非敏感项） | wrangler.toml |
| compatibility_date | ✅ `2024-11-01` 合法且**必要**：`binaryType` 默认值在 ≥2026-03-17 变为 Blob（`websocket_standard_binary_type`），本工程首包解析依赖 ArrayBuffer 语义——compat date 必须保持 < 2026-03-17 或显式设置 `binaryType='arraybuffer'`（官方 WebSockets 文档） | wrangler.toml:5；docs/WebSockets#binary-messages |
| package.json | ✅ 零运行时依赖；devDeps：wrangler ^3.99.0（实装 3.114.17）、workers-types、ws（仅测试） | package.json |
| 入口/构建 | ✅ ESM 默认导出 `fetch`；无构建步骤；`wrangler deploy` 即可；dry-run bundle 17.55 KiB（限 64 MiB）远超余量 | dry-run 输出 |
| Secrets 契约 | ✅ `VLESS_UUID`/`WS_PATH`/`SUB_TOKEN` 三项 Secret + 可选 `PROXY_IPS`/`WORKER_URL`；与 `src/config.mjs` 读取完全一致 | config.mjs:35-47 |
| 部署前必办 | ⚠️ `DATA_BASE_URL` 仍为 `YOUR_USERNAME` 占位符——**部署前必须改为 fork 实际 raw 地址**（不改则订阅恒为空） | wrangler.toml [vars] |
| 版本观察 | ℹ️ wrangler v4 已发布（3.114 仍受支持）；升级与否留待 3B 决策 | `npx wrangler --version` |

## B. Worker 安全检查结果（探测 29/29 通过）

| 检查项 | 结论 | 证据 |
|---|---|---|
| UUID 缺失拒绝 | ✅ fail-closed：缺 `VLESS_UUID` → 全部请求 500（含订阅） | config.mjs:25-40；index.mjs:30；探测 PASS（`missing VLESS_UUID -> 500`） |
| 错误 UUID 无法建立连接 | ✅ AUTH_FAIL → 失败帧 `[00,01]` + close 4003 | vless.mjs:69；C 级 e2e `WS bad UUID rejected` |
| 订阅鉴权 | ✅ 401/404 语义正确：错 token 与不存在路径同为 404，防枚举 | index.mjs:42；探测 17 项绕过全 404 |
| 绕过专项（编码/遍历/大小写/参数/方法） | ✅ 百分号编码 token（%2B/%2b）→ 404；`..`/`%2e%2e`/双斜杠/矩阵参数/空字节/大小写/尾斜杠全 404；POST→405；`?x=1` 附加查询不削弱路径鉴权 | /tmp/p3a_sec_probe.mjs 29 项日志 |
| 状态页泄漏 | ✅ `/`、404、403 页面零 UUID/token/ProxyIP（关键词扫描） | 探测 `no secret leak on public pages` |
| WS 固定路径 | ✅ 非 WS_PATH 升级一律 403；非升级请求 404 | index.mjs:75-78；e2e `WS wrong path 403` |
| 任意转发滥用 | ✅ 转发仅在 UUID 鉴权后；UUID 为部署期随机 Secret；无公开默认值。残余风险：UUID 持有者可转发任意目标（VLESS 代理本质）——凭据保护靠保密+轮换 | session.mjs 回退拨号链 |
| 跨请求污染 | ✅ 3 个并发会话（alpha/beta/gamma）回环 payload 零串扰；src 仅 data.mjs:10 有模块级 Map（只读数据缓存，无凭据/会话状态） | 探测 `no cross-pollution`；grep 扫描 |
| 超时/泄漏/异常关闭 | ✅ 首包 15s 截止、连接 10s、空闲 120s、幂等 closeAll；B 级 4 项超时测试通过 | session.mjs:19-46；B 级 CONNECT_TIMEOUT/IDLE_TIMEOUT |

## C. Cloudflare 兼容性检查结果

✅ **已核实兼容**（对照官方文档，2026-11-19 版）：
- `cloudflare:sockets`：API 形态（`connect`/`opened`/`readable`/`writable`/`close`）与官方 TCP sockets 文档逐项一致；socket 在 handler 内创建（符合"不得全局域创建"）；每会话 1 socket < 6 并发连接限。
- `WebSocketPair`：`pair[1].accept()` + `Response(101, pair[0])` 与官方示例一致；close 事件手动应答（compat <2026-04-07 的 prior behavior，closeAll 覆盖）；close code 4000/4003 属私有合法段。
- 流/`ReadableStream`/`WritableStream`/`Promise` 链：标准 Web API；src **零 Node 专有 API**（grep 扫描仅注释命中）。

⚠️ **两项需 D 级实测确认**（本机 proot 无法运行 workerd，已如实标注，Node 仿真不作为兼容性证明）：
1. **动态 import**：bundle 保留 `await import("cloudflare:sockets")`（/tmp/p3a-bundle/index.js）。workerd 将 `cloudflare:` 作为内建 scheme 解析，静态/动态导入预期等价，但官方示例均为静态导入——若 D 级失败，改为静态导入即可（一行，3B 批准后执行）。
2. **生产环境首包 binaryType**：依赖 compat date 2024-11-01 的 ArrayBuffer 默认值（见 A 节）。

ℹ️ **平台固有行为（非缺陷，需知晓）**：官方文档明确——出站 TCP **禁连 Cloudflare IP 段**（直连 CF 托管站点会失败，这正是 PROXY_IPS 回退的设计场景，当前未配置则此类目标不可达）；禁回环自身（TCP Loop detected）；禁端口 25；运行时例行更新时存量 WS 连接最长 20 分钟排水期后断开（客户端需自动重连，NekoBox 默认具备）。

## D. 数据更新机制检查结果

✅ 正确部分：源获取失败 → RC=2 + `::error` 注释 + **数据文件零改动**（保底测试场景 A 实测）；EMPTY 地区不产出任何节点（12/12 订阅校验）；UNKNOWN 零行入库（grep 全 0）；Actions 无 secrets 引用、`permissions: contents: write` 最小化、`[skip ci]` 防递归、concurrency 组防并发提交。

❌ **关键缺陷 G-1（本轮实测发现）**：`pipeline/update_data.py` **第二轮运行必崩**——`write_outputs` 写出的 `audit.json` 中 `rows` 是 dict（region→list），而 `merge_rows` 在 `update_data.py:185` 按扁平列表遍历 → `AttributeError: 'str' object has no attribute 'get'`。实测复现：对已有 audit 的目录跑第二轮即抛错（日志见本节附录）。影响：**GitHub Actions 每小时更新自第二轮起全部失败**（红叉，非静默）；数据文件因崩溃发生于写入之前而保持不变（意外保底），但数据将永久停留在第一轮。

❌ **次生缺陷 G-2（代码审读确认，G-1 修复后可达）**：`merge_rows` 的淘汰分支（update_data.py:224）在**探测层全灭**（如 runner 网络故障）时会淘汰全部旧条目——与"探测失败不回退"的设计承诺不符，需改为"全灭视为源故障、保留旧数据"。

⚠️ 小项：`cancel-in-progress: true` 下，若旧 run 在 commit 与 push 之间被取消，该小时更新丢失（下小时恢复）；`cf.cacheTtl` 对非 CF 源（raw.githubusercontent）无效（无害）。

## E. NekoBox 订阅兼容性检查结果（12/12 通过）

✅ 标准 Base64（RFC 4648 字符集、无空白、round-trip 稳定、与 `btoa` 输出逐字节一致）；纯 `vless://` 链接 159 条（US 26 + DE 133），零说明文字；参数集精确为 `encryption/security/sni/fp/type/host/path`（无 NekoBox 不识别参数，无 `ed=` 早期数据）；`sni===host===worker 域名`、`path` 为 WS_PATH 精确编码、端口 443；命名 `CF-US-*/CF-DE-*` 与数据文件一一对应；`region=hk/jp/sg/nl` 返回空（不伪造）；错凭据 404。样本：
```
vless://<uuid>@103.31.4.1:443?encryption=none&security=tls&sni=<host>&fp=random&type=ws&host=<host>&path=%2F<t>#CF-US-103.31.4.1
```
数据有效性：US/DE 各抽 4 条 trace 复验，colo 全部匹配（EWR×4、FRA×4）。⚠️ 如前阶段声明：格式通过≠真机导入成功，E/F 级留待部署后。

## F. 免费计划限制与风险说明（官方 limits 文档，2026-11-19 版）

| 限制 | 免费计划 | 对本项目的影响 |
|---|---|---|
| 请求 | 100,000/天（超限 Error 1027） | 订阅+握手请求计数；**隧道内流量不计请求**——不可把请求数等同可用代理流量 |
| CPU | 10ms/请求（平均 Worker 2.2ms） | **关键约束**：WS 会话全程计入同一请求的 CPU——重度长会话（大流量持续拷贝）可能触发 Error 1102；个人浏览量级安全 |
| 时长 | HTTP 无硬限；waitUntil 响应后 +30s；运行时更新排水 ≤20min | 长连接会话可维持，但更新时被断，靠客户端重连 |
| 并发连接 | 6/请求（等待响应头阶段） | 每会话 1 socket；订阅 6 个 fetch 为串行——均在限内 |
| 内存 | 128MB/isolate | 转发流式处理，无大缓冲 |
| 子请求 | 50/次 | 订阅最多 6 fetch；会话 1 connect |
| 其他 | Worker 64MiB（实 17.55KiB）、启动 1s、变量 64 个×5KB、日志 256KB/请求 | 全部远低于限值 |

风险声明：① workers.dev 免费域可用性由 Cloudflare 政策决定；② ToS 层面：Cloudflare 2023 年自助服务协议已取消对 Workers 的 CDN 2.8 条款限制，但账号层面滥用判定（如大规模公开中继）仍可能导致封号——本工程 UUID 私有 + 不公开订阅正是为控制该风险；③ 出站禁连 CF IP 段导致 CF 托管站点需 PROXY_IPS 回退（未配置时该类目标不可达，如实声明非缺陷）。

## G. 未解决问题清单

| # | 级别 | 问题 | 位置 | 3B 修复方案（需批准） |
|---|---|---|---|---|
| G-1 | 🔴 关键 | 管线第二轮必崩，Actions 更新链自第二轮起失效 | update_data.py:185（merge_rows 遍历 dict） | `for region_rows in prev.get("rows", {}).values(): for r in region_rows:` |
| G-2 | 🟠 高 | 探测全灭时旧条目被淘汰，违背保底承诺 | update_data.py:224 | 全部探测失败 → 视为源故障：保留旧数据 + `::error` |
| G-3 | 🟡 中 | `import("cloudflare:sockets")` 动态导入需 D 级实测 | session.mjs dialCf | 若失败改静态导入（一行） |
| G-4 | 🟡 中 | `binaryType` ArrayBuffer 语义钉死在 compat date <2026-03-17 | wrangler.toml:5 | 显式 `pair[1].binaryType='arraybuffer'`，解除日期耦合 |
| G-5 | 🟢 低 | `DATA_BASE_URL` 占位符待改；`cancel-in-progress` 小时丢失窗口；region 参数大小写敏感（fail-closed，非缺陷） | wrangler.toml / update.yml | 部署清单项 |
| G-6 | ℹ️ 记录 | HK/JP/SG/NL 仍为 0 条（视点未见对应 colo），保持 EMPTY 不伪造 | data/*.txt | Actions 视点每小时自动补充 |

## H. 是否允许进入第三阶段 B

**有条件放行**：安全面全部达标（无公开默认 UUID、无未授权订阅泄漏、无跨请求污染、无开放中继缺陷、本地测试 68/68 通过、配置完整、免费计划风险已明确）。

但 **G-1 必须在部署/启用 Actions 之前修复**（否则上线后第二次更新即失败）；G-2、G-4 建议同批修复；G-3 留作 D 级验证点。修复属于代码变更，按阶段纪律需人工批准后于第三阶段 B 执行——本阶段不做。

### 附录：关键测试日志
- 崩溃复现（G-1）：`python3 pipeline/update_data.py --data-dir /tmp/cfip-live-data2`（已有 audit）→ `AttributeError: 'str' object has no attribute 'get'` @ update_data.py:185
- 场景 A（源缺失）：RC=2，`::error:: cannot fetch Cloudflare official ranges...`，数据文件未动
- 安全探测：29/29（含 17 项绕过矩阵、%2B/%2b 编码、3 并发会话隔离）
- 订阅校验：12/12；数据抽检：US 4/4 EWR、DE 4/4 FRA
