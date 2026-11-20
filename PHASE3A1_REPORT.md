# 第三阶段 A.1 报告 — 数据流水线缺陷修复与重新验收

工程：`/root/workspace/cfip-regions/`
范围执行：仅数据流水线修复 + 测试 + 报告；**未部署、未登录 Cloudflare、未触碰 cold-salad-8f76、未写入真实密钥、未修改参考仓库**。

测试总览：管线回归 **45/45**（新增）｜既有套件全量重跑 **90 项全通过**（明细见 G 节）

---

## A. G-1 修复前后代码对比

**数据结构追踪**（rows 的完整生命周期）：

| 环节 | 位置 | 结构 |
|---|---|---|
| 生成 | `merge_rows` 返回 `{"rows": {region: [row,…]}}` | **dict** |
| 写入 | `write_outputs` → `audit["rows"] = merged["rows"]` | dict（不变） |
| 读取 | `load_previous` 原样读回 | dict |
| 消费 | `merge_rows` 旧代码 `for r in prev_rows.get("rows", [])` | **按列表遍历 → 遍历出的是 dict 的键（字符串）→ `r.get` 崩溃** |

即：**audit 数据结构本身正确且保持不变**，缺陷仅在消费侧遍历方式。修复不是 try/except 掩盖，而是按真实结构遍历：

```diff
--- 修复前（update_data.py 旧 :184）
-    for r in prev_rows.get("rows", []):
-        ip = r.get("ip", "")
+    for r in prev_rows_flat(prev_rows):
+        ip = r.get("ip", "")
```

新增 `prev_rows_flat()`（update_data.py:176-192）：接受**当前 dict 布局**与**历史扁平 list**两种结构、跳过畸形条目——audit 文件结构零变更，无需迁移（兼容性由测试 `rows dict structure` 用例锁定）。

**前后实测日志**（同一数据目录 `/tmp/g1-repro`，159 条历史行）：

```
修复前（旧逻辑副本 /tmp/g1_old_update_data.py）:
  File "/tmp/g1_old_update_data.py", line 211, in merge_rows
      ip = r.get("ip", "")
  AttributeError: 'str' object has no attribute 'get'

修复后（第二轮真实网络运行）:
  audit written: {"probed": 160, "reachable_colo": 159, "region_matched": 159,
                  "evicted_previous": 0, "kept_previous": 159, "probe_outage": false, "stale_kept": 0}
  RC=0   ← 旧 159 条全数保留并复验通过
```

## B. G-2 数据保底机制及订阅发布策略

**故障三分类**（判定 → 动作 → 退出码）：

| 分类 | 判定 | 动作 | RC |
|---|---|---|---|
| 数据源故障 | 源不可读**或返回 0 网段**（新增空源判定） | 数据零触碰 + `::error` | 2 |
| 探测层故障 | 本轮**全部**探测失败且存在历史行 | 历史行降级 `STALE`，`last_checked` 冻结为**原验证时间**，不淘汰不新增 | 1 |
| 候选真实失效 | 部分成功时个别历史行失败 | 仅淘汰该行（正常合并） | 0/1 |

**订阅发布策略（fail-closed）**：数据文件保留 STALE 行（透明可审计）；**订阅只发布 status=OK**——`src/sub.mjs` 新增显式契约 `PUBLISHED_STATUS='OK'`（含 STALE 语义文档），STALE 行在 `parseDataLine` 处被显式丢弃。探测中断期间订阅可能变空：这是"不把未验证数据当新鲜节点"的直接代价，如实声明。

**STALE 数据样例**（total failure 测试输出）：
```
198.51.100.1|us|seed|2026-11-18T00:00:00Z|2026-11-19T08:00:00Z|STALE
```
（`last_checked=2026-11-19T08:00:00Z` 为原验证时间，未被本轮覆盖）

**恢复流程（实测）**：探测恢复 → STALE 行重新探测 → 回升 `OK` + 刷新 `last_checked` + 数据文件同步；多轮故障（3 轮实测）期间 STALE 持续保留且时间戳恒定。

**行为变更说明**：旧版 `write_outputs` 在某地区行被清空时会"保留旧文件"（可能发布已淘汰的 OK 行）；新版改为如实写 `EMPTY` 标记——源故障（RC=2）路径本就不进入写入，故保底语义不受影响，反而消除了"淘汰后仍发布死节点"的隐患。

## C. G-4 原始问题、影响和处理结果

**原始描述**（PHASE3A_REPORT.md 问题清单）：
> G-4｜🟡 中｜`binaryType` ArrayBuffer 语义钉死在 compat date <2026-03-17｜wrangler.toml:5｜显式 `pair[1].binaryType='arraybuffer'`，解除日期耦合

另见 3A 报告 C 节"生产环境首包 binaryType 依赖 compat date 2024-11-01 的 ArrayBuffer 默认值"及 H 节"G-4 建议同批修复"。

**代码位置核查**（本阶段全工程 grep）：`src/` 中**无任何** binaryType 赋值；仅 `test/e2e_local.mjs:153,176`（客户端测试侧）与 `src/vless.mjs:68`（注释）出现相关字样。依赖链：worker 首包解析 → `event.data` 需为 ArrayBuffer/Uint8Array → `parseFirstPacket` 包装 `new Uint8Array(data)`。

**是否部署阻断**：**否**。`compatibility_date = 2024-11-01` < 2026-03-17，运行时默认 `binaryType='arraybuffer'`（官方 WebSockets 文档：`websocket_standard_binary_type` 自 2026-03-17 才默认启用 Blob）。当前配置下功能正确。仅在**有人擅自升级 compat date ≥2026-03-17** 时才会触发（届时 Blob 帧 → 空 Uint8Array → TRUNCATED → 全部连接被拒，故障模式为 fail-closed 而非静默错乱）。

**处理结果**：**本阶段未修改**（超出授权范围——本阶段仅授权数据流水线）。最小修复方案（1 行，建议随 3B 批准执行）：

```js
// src/index.mjs — pair[1].accept() 之前
pair[1].binaryType = 'arraybuffer';   // 解除对 compat date 的隐式耦合
```

## D. DATA_BASE_URL 占位符清单

| 位置 | 值 | 用途/性质 |
|---|---|---|
| wrangler.toml:17 | `https://raw.githubusercontent.com/YOUR_USERNAME/cfip-regions/main/data` | **生产占位符**。部署前置条件：替换为 fork 实际 raw 地址，否则订阅恒空（worker 读不到数据 → fail-closed 返回空，不报错伪装） |
| src/config.mjs:56 | env 读取 | 必填校验（缺失→500 fail-closed），去尾斜杠 |
| src/data.mjs:5,17 | 拼接 `${base}/${REGION}.txt` | 访问方式：HTTP GET；格式：text/plain，行格式 `address\|region\|source\|first_seen\|last_checked\|status`，`#` 为注释头 |
| .dev.vars:5 | `http://127.0.0.1:8931` | **本地测试地址**（gitignored，测试值，永不部署） |
| tools/run_c_level.sh:21 | `http://127.0.0.1:${PORT_DATA}` | 本地测试 harness（数据静态服务） |
| test/config-sub.test.mjs:14 | `https://example.com/data/` | 单测 fixture |
| docs/DEPLOY.md:28 | `<你>` 占位 | 部署文档前置条件说明 |

正式地址未确定 → **保留为明确部署前置条件，不编造**；本地测试地址与正式地址已区分；CI/Actions 无运行时引用。

## E. binaryType 兼容性分析

1. **使用位置**：worker 侧**零显式设置**（依赖运行时默认值）；测试侧 `test/e2e_local.mjs:153,176` 客户端显式 `arraybuffer`；`tools/worker-shims.mjs` 仿真对直接转发（无类型转换）。
2. **ArrayBuffer 依赖**：是——`src/vless.mjs:70` `data instanceof Uint8Array ? data : new Uint8Array(data)` 假定 `event.data` 为 ArrayBuffer（compat <2026-03-17 的运行时默认）。
3. **Blob 情形**：若默认变为 Blob，`new Uint8Array(blob)` 得到 **0 长度数组** → `TRUNCATED` 错误 → close 4003，所有连接被拒——fail-closed 拒绝（无静默数据错乱），服务全断。
4. **compat date 行为核实**（官方文档，3A 已抓取）：`websocket_standard_binary_type` 兼容旗标在 **compat ≥2026-03-17** 默认启用（Blob）；当前 `2024-11-01` → ArrayBuffer。附带发现：`web_socket_auto_reply_to_close` 在 ≥2026-04-07 默认启用——同为保持旧 compat date 的理由。
5. **兼容方案**：不盲目追新日期（遵循要求）。方案 A（推荐，1 行）：显式 `binaryType='arraybuffer'` 解耦日期；方案 B：`parseFirstPacket` 异步兼容 `data instanceof Blob ? await data.arrayBuffer()`（改解析函数签名，影响面大）。**均未实施**。
6. **真实环境测试状态保留**：workerd/Cloudflare 真机验证仍为 **未完成（D/E/F 级待批）**——Node 仿真不构成兼容性证明（3A 立场不变）。

## F. 新增测试用例及真实运行结果

**JS 单测 +1**（test/config-sub.test.mjs）：
- `STALE rows are retained in data files but never published (G-2 policy)`：混合 OK/STALE 数据 → 节点仅含 2 条 OK、订阅体无 STALE 地址。✅（B 级套件 28/28 内）

**管线回归套件 45 项**（pipeline/test_update_data.py，确定性：probe_colo 打桩、TEST-NET fixture、随机种子固定；`python3 pipeline/test_update_data.py`）——关键日志摘录：

| 场景 | 结果 | 关键证据 |
|---|---|---|
| 首轮运行 | ✅ | `US.txt: ['198.51.100.1\|us\|colo-probe\|…\|OK']`；audit rows=dict，键=六地区 |
| 第二轮（G-1 核心） | ✅ | `rc1=0 rc2=0`；`kept_previous=2`；新增候选入列 |
| 连续 10 轮 | ✅ | `rcs=[0,0,0,0,0,0,0,0,0,0]` 无异常 |
| audit 空文件/缺失/损坏 | ✅ | 均按首轮处理；损坏时 `previous audit unreadable` 告警 + 正常完成 |
| rows 结构断言 | ✅ | 每 region 值为 list，行字段齐全（锁死 dict 结构防再退化） |
| **部分探测失败** | ✅ | 死行 `.2` 淘汰、健座行保留、新行 `.3` 加入；`evicted_previous==1`；`probe_outage=False` |
| **全部探测失败** | ✅ | `rc=1`+`::error`；2 行保留且 `status=STALE`；**`last_checked` 保持 2026-11-19T08:00:00Z 不变**；数据文件含 STALE 行；零淘汰 |
| 源不可用 | ✅ | `rc=2`；audit 与数据文件字节级不变 |
| 源返回空 | ✅ | `rc=2` + `::error:: source returned zero networks; keeping previous data untouched` |
| 历史文件损坏 | ✅ | 成功轮后 `US.txt` 被重写修复（healed） |
| 下一轮恢复 | ✅ | STALE→OK，`last_checked` 刷新为当轮时间，文件同步 OK |
| 多次失败后恢复 | ✅ | 3 轮故障：全部 STALE 且时间戳冻结（`('198.51.100.1','STALE','2026-11-19T08:00:00Z')`×3 轮一致）；第 4 轮恢复 → 双行 OK + 新时间戳 |

**失败场景验证**（要求项）：G-1 旧逻辑副本在 `/tmp/g1-repro`（159 条真实历史行）复现 `AttributeError`（见 A 节日志）；全套件经真实执行（非静态检查）。

## G. 原有测试重新运行结果（90 项全过）

| 套件 | 结果 | 备注 |
|---|---|---|
| node --check | 6/6 | 全部 src 模块语法 |
| wrangler dry-run | ✅ | `Total Upload: 17.65 KiB / gzip 5.62 KiB` |
| B 级单元测试 | **28/28** | 原 27 + 新增 STALE 1 |
| C 级本地仿真 e2e | 7/7 | 含 VLESS→TCP 回环；`nodes=159 regions=US,DE` |
| 安全探测 | 29/29 | 绕过矩阵/并发隔离/泄漏扫描 |
| 订阅校验 | 12/12 | base64/字段一致性/空地区不伪造 |
| 数据抽检 | 8/8 | US×4=EWR、DE×4=FRA 全匹配 |
| 管线离线自测 | RC=0 | fixture 真网络探测 |
| 管线回归（新增） | 45/45 | 本阶段新增 |

**勘误**：3A 报告"本地测试 68/68"为汇总笔误——按 3A 当时的套件明细（6+27+7+29+12+8）正确合计为 **89**；本阶段重跑后为 **90**（新增 1 项 JS 测试）。

## H. 修改文件清单及 SHA256

| 文件 | 性质 | SHA256 |
|---|---|---|
| pipeline/update_data.py | 修改（G-1+G-2） | `babd1f59…ea28f`（全值见下） |
| pipeline/test_update_data.py | 新增（回归套件） | `b3ad9119…3d3e2e` |
| pipeline/test_ranges_fixture.txt | 新增（TEST-NET fixture） | `8cbb55f6…15e12` |
| src/sub.mjs | 修改（显式 STALE 契约，行为不变） | `8643299a…9bd5` |
| test/config-sub.test.mjs | 修改（+1 用例） | `c4d4bc55…85702` |
| .github/workflows/ci.yml | 修改（+pipeline-regression job） | `c4e0824d…c1f` |

```
babd1f5981d49cd817908e69d9fd59240aceebb2c2272e918dbb876516aea28f  pipeline/update_data.py
b3ad9119be9289320ffb774673d511cce093daa2c2a6813fbc574800156d3e2e  pipeline/test_update_data.py
8cbb55f658a9cc79414ef30f9d770aab2e0def721040dd73939b15d6ecd15e12  pipeline/test_ranges_fixture.txt
8643299aec3c0b81f39a9d0d8fdbfd123157358f83981ed9b0e90a6d66c39bd5  src/sub.mjs
c4d4bc554f01b8e9b61300a0ce3cf937529287c9a9ecb70b74a7e08a8c485702  test/config-sub.test.mjs
c4e0824d0c3259fba8600591612d12b303f6160bd523002b8bbcd1ffdca2bc1f  .github/workflows/ci.yml
```

未触碰：`src/` 其余模块、`wrangler.toml`、`data/`（mtime 仍为 09:09，早于本阶段）、`review/` 参考仓库、任何线上服务。

## I. 是否具备进入第三阶段 B 的条件

**具备，建议放行**：
- ✅ G-1 修复并经真实网络第二轮验证 + 10 轮回归（部署后 Actions 持续更新链恢复可用）
- ✅ G-2 三分类保底 + STALE 显式契约 + 恢复流程实测
- ✅ 全部既有测试重跑通过（90 项），无回归
- ✅ 无新引入的密钥/部署动作

**3B 前置清单**（不属本阶段）：① 替换 `DATA_BASE_URL` 占位符（fork raw 地址）；② G-4 一行修复（`pair[1].binaryType='arraybuffer'`）建议随部署批准一并执行；③ G-3（动态 import cloudflare:sockets）留 D 级实测。未获批准前不部署。

**结论：修复完成，回归全绿，等待人工验收。**
