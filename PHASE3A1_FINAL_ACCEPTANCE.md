# 第三阶段 A.1 最终验收报告

工程：`/root/workspace/cfip-regions/` ｜ 本阶段性质：**只读核查 + 测试统计核对 + 报告整理**
核查时间：2026-11-20 12:14–12:30 ｜ 零代码/配置/密钥/数据文件修改（一处测试 fixture 幂等重写已如实披露，见 §6.3）

---

## 1. 测试统计核对

### 1.1 全部套件逐项明细（本阶段全部真实复跑）

| # | 套件 | 类型 | 用例数 | 通过 | 失败 | 证据形式 |
|---|---|---|---|---|---|---|
| 1 | node --check（6 模块） | 静态语法检查 | 6 | 6 | 0 | `syntax OK: 6/6` |
| 2 | wrangler dry-run | 打包校验 | 1 | 1 | 0 | `Total Upload: 17.65 KiB` |
| 3 | B 级单元测试 | 断言用例 | 28 | 28 | 0 | node --test 输出 |
| 4 | C 级本地仿真 e2e | 断言用例 | 7 | 7 | 0 | `C-level: 7/7 passed` |
| 5 | 安全探测（sec-probe） | 断言用例 | 29 | 29 | 0 | `sec-probe: 29/29 passed` |
| 6 | 订阅校验（sub-validate） | 断言用例 | 12 | 12 | 0 | `sub-validate: 12/12 passed` |
| 7 | 数据抽检（trace 复验） | 断言用例 | 8 | 8 | 0 | EWR×4、FRA×4 |
| 8 | 管线离线自测 | 端到端运行 | 1 | 1 | 0 | `RC=0` |
| 9 | 管线回归（新增） | 断言用例 | 45 | 45 | 0 | `pipeline regression: 45/45 passed` |

### 1.2 129 与 90 的差异解释（口径问题，非数字错误）

- **129 = 45+28+7+29+12+8**：全部**断言型测试用例**合计（表 #3–#7、#9）。
- **90 = 6+28+7+29+12+8**：3A1 报告 G 节标题"原有测试重新运行结果"的口径——即**既有套件重跑**：含 6 项 `node --check` 语法检查（非断言用例），**不含**新增的 45 项管线回归套件（该套件在同表中被单列标注为"新增"）。
- 差值 39 = 45（新套件，未计入 90）− 6（语法检查，计入 90 但非用例）。
- **结论**：两个数字均真实，差异纯系统计口径（"既有套件重跑" vs "全部断言用例"）。3A1 报告 G 节把两种口径混排在同一表格内并只标注其一，表述不严谨，本报告予以更正。最终统一口径如下。

### 1.3 统一统计口径（最终）

```
执行记录总数        = 6(语法检查) + 1(dry-run) + 129(断言用例) + 1(自测运行) = 137
断言型用例总数      = 129
  ├─ 独立语义测试点 = 116
  └─ 分层重复覆盖   = 13（6 组，明细见 1.4；属跨层防御性回归，非冗余）
失败数量            = 0
最终通过数量        = 129/129（+ 6 语法检查 + 1 dry-run + 1 自测运行 全通过）
被删除/合并的测试   = 0（无任何测试记录被删改以凑数）
```

### 1.4 重叠测试明细（用例名逐一列出）

| 组 | 语义点 | 成员用例（所属套件） | 重复成员数 |
|---|---|---|---|
| 1 | 错误订阅凭据→404 | e2e「GET /sub/<wrong> 404」↔ sec「bypass wrong」 | 1 |
| 2 | 空地区不伪造 | e2e「region filter us/nl」(nl 子断言) ↔ sub-validate「region=hk empty」「region=jp,sg,nl empty」↔ sec「region=US uppercase -> empty」「region=xx unknown -> empty」 | 4 |
| 3 | 错误 UUID 拒绝 | B「wrong UUID is rejected with AUTH_FAIL」↔ e2e「WS bad UUID rejected」↔ sec「WS with query params still enforces UUID」 | 2 |
| 4 | 并发会话隔离 | B「concurrent sessions do not share state」↔ sec「3 concurrent sessions: no cross-pollution」 | 1 |
| 5 | 订阅 base64 严格性 | B「subscription renders strict base64 of vless links only」↔ sub-validate「base64 strict charset」「base64 no whitespace/newline」「base64 round-trip stable」「btoa-spec parity」 | 4 |
| 6 | 状态页零泄密 | e2e「GET / 200 without secrets」↔ sec「no secret leak on public pages」 | 1 |

重复成员合计 **13**；独立语义测试点 **116**。
说明：重复均为**单元层 / HTTP 层 / 全栈层**对同一不变量的分层验证（防单层回归），保留为有意设计。
**互补组（不计重复）**：STALE 不发布——pipeline「total failure: data file carries STALE lines」（Python 生产侧）↔ B「STALE rows are retained in data files but never published」（JS 消费侧），分别验证管线写出与订阅排除两端。

## 2. G-1 核对（audit rows 类型错误）

### 2.1 修复前后关键代码差异

归因副本 `/tmp/g1_old_update_data.py`（仅回退缺陷行的最小复现件）与现文件 diff：

```diff
210c210
<     for r in prev_rows.get("rows", []):        # ← 遍历 dict 得到键字符串 → r.get 崩溃
---
>     for r in prev_rows_flat(prev_rows):        # ← 按真实结构（dict-of-lists）展平遍历
```

配套新增 `prev_rows_flat()`（pipeline/update_data.py:176-192）。修复前后完整差异还包括：merge_rows 签名 docstring（G-2 策略说明）、STALE 降级分支（:250-267）、write_outputs 状态写出（:306-326）、main() argv 参数化 + 空源判定 + 故障告警（:355-407）——均属本次授权的 G-1/G-2 修复范围，无超范围改动。

### 2.2 prev_rows_flat() 结构兼容实测（本阶段复跑）

```
dict结构 -> 3 行（garbage 被跳过）: ['1.1.1.1', '2.2.2.2', '3.3.3.3']   ← 当前结构，畸形条目跳过
list结构 -> ['9.9.9.9']                                                 ← 历史扁平结构兼容
rows缺失 -> []
rows=None -> []
prev非dict -> []
prev全空 -> []
```
六种输入全部安全返回列表，无异常抛出、无 try/except 掩盖（展平逻辑为显式 isinstance 分支）。

### 2.3 audit 文件格式核对

对比修复前产物（data/audit.json，mtime 09:09）与修复后产物（/tmp/cfip-live-data2/audit.json）：

- **顶层键**：前 `['meta','rows','stats','unknown_sample']` ＝ 后（完全一致）
- **行字段**：前 10 字段（ip/region/colo/source/first_seen/last_checked/status/role/worker_runloc/exit_ip）＝ 后（完全一致）
- **附加变化（如实披露）**：`stats` 新增 `probe_outage`、`stale_kept`；`meta` 新增 `probe_outage`、`stale_count` ——为 G-2 STALE 记账所需，属授权修复的组成部分；行 schema 与顶层结构未变。下游 Worker 只读 txt 数据文件、不读 audit.json，无消费兼容风险。**格式变更 = 仅增量字段，已获授权范围内，无未授权变更。**

### 2.4 第二轮真实运行日志及 kept_previous=159 证据

本次验收新鲜复跑（2026-11-20T04:21:14Z，真实网络，目录 /tmp/cfip-live-data2 含 159 条历史行）：

```
[2026-11-20T04:21:14Z] audit written: {"probed": 160, "reachable_colo": 159,
  "region_matched": 159, "evicted_previous": 0, "kept_previous": 159,
  "probe_outage": false, "stale_kept": 0}
```
`kept_previous=159`：全部历史条目在第二轮被重新探测并全数保留。10 连轮回归测试（rcs=[0×10]）进一步证明重复运行稳定。

## 3. G-2 核对（全量探测失败保底）

### 3.1 三种故障路径（代码位置 + 实测）

| 路径 | 代码位置 | 实测结果 |
|---|---|---|
| ① 数据源故障 | main() :370（读取/解析异常）、:373-375（**新增**零网段判定） | RC=2 + `::error`；「audit untouched」「data files untouched」PASS；空源 → `::error:: source returned zero networks; keeping previous data untouched` |
| ② 全量探测失败 | merge_rows :250-267 STALE 分支 | RC=1 + `::error:: probe-layer outage...`；历史行全保留且降级 STALE |
| ③ 部分探测失败 | merge_rows :296-299 正常合并淘汰分支 | 死行淘汰（.2 消失）、健座行保留 OK（.1）、新行加入（.3）；`evicted_previous==1`、`probe_outage=False` |

### 3.2 全量失败 → STALE 降级（实测日志）

```
PASS total failure: previous rows kept  — [{...'status': 'STALE', 'last_checked': '2026-11-19T08:00:00Z'}, {...同}]
PASS total failure: data file carries STALE lines  —
  ['198.51.100.1|us|seed|2026-11-18T00:00:00Z|2026-11-19T08:00:00Z|STALE',
   '198.51.100.2|us|seed|2026-11-18T00:00:00Z|2026-11-19T08:00:00Z|STALE']
PASS total failure: no eviction  — evicted_previous==0
```

### 3.3 last_checked 不被伪造刷新

- 降级路径（:258-262）仅改 `status="STALE"`，**不触碰 `last_checked`**。
- 多轮故障实测（3 轮）：时间戳恒为 `'2026-11-19T08:00:00Z'`（种子值，未刷新）——「multi-failure: all rows STALE with frozen last_checked」PASS。
- 恢复轮刷新值 `2026-11-20T04:22:03Z` 为**当轮真实探测时刻**（probe 成功后才重建行），非伪值。

### 3.4 STALE 不进入订阅输出

- 代码：src/sub.mjs:21 `export const PUBLISHED_STATUS = 'OK'`；:74 `if (status !== PUBLISHED_STATUS) return null`（唯一节点准入闸门）。
- 实测：B 级「STALE rows are retained in data files but never published」PASS——混合 OK/STALE 数据生成的订阅体仅含 2 条 OK 地址，5.6.7.8/9.9.9.9（STALE）均不在输出中。
- 数据文件头（:313）明示 `publish rule: subscriptions may only include status=OK rows`。

### 3.5 恢复流程

```
PASS recovery: rc back to 0  — rc1=1 rc2=0        ← 故障轮 1（响亮失败）→ 恢复轮 0
PASS recovery: status promoted OK
PASS recovery: last_checked refreshed  — 2026-11-20T04:22:03Z
PASS multi-failure: recovery rc==0  — rc=0        ← 3 轮故障后恢复
PASS multi-failure: both rows OK with fresh timestamps
```

### 3.6 未把 STALE 重新解释为 OK

status 赋值路径全量 grep：仅 :258（故障降级 →STALE）与 :284（**本轮探测成功后**重建 →OK/UNKNOWN，由真实 colo 驱动）。不存在任何 STALE→OK 的直接转换或时间戳伪造路径；STALE 行重新变为 OK 的唯一途径是下一轮真实探测成功。

## 4. 部署前置条件核对（无部署授权，仅清单化）

| 项 | 位置 | 内容/用途 | 完成状态 | 风险 | 验收方法 |
|---|---|---|---|---|---|
| DATA_BASE_URL 占位符 | wrangler.toml:17（生产值）；src/config.mjs:56（读取）；.dev.vars:5 与 tools/run_c_level.sh:21（**本地测试地址** 127.0.0.1:8931，gitignored）；docs/DEPLOY.md:28（说明） | Worker 订阅数据源：HTTP GET `${base}/{HK,JP,SG,US,DE,NL}.txt`，行格式 `address\|region\|source\|first_seen\|last_checked\|status` | ⬜ 未完成（占位符 `YOUR_USERNAME` 在位） | 不替换则订阅恒空（fail-closed 返回空体，不会报错伪装） | 部署前替换为 fork 实际 raw 地址 → curl 验证 `/sub/<token>` 返回非空 base64 |
| G-4 binaryType 一行修复 | src/index.mjs（`pair[1].accept()` 之前加 `pair[1].binaryType='arraybuffer'`；本阶段**未改**） | 解除对 compat date <2026-03-17 的隐式依赖（`websocket_standard_binary_type` 旗标） | ⬜ 未实施（当前配置 2024-11-01 下**无风险**） | 仅当未来升级 compat date ≥2026-03-17 时触发 Blob→TRUNCATED 全拒（fail-closed） | D 级 wrangler dev / 部署后真机 WS 握手成功即验证 |
| G-3 动态 import 实测 | src/session.mjs `dialCf` 内 `await import("cloudflare:sockets")`（bundle 已确认保留该形态） | 真实 workerd / 线上环境验证动态导入内建模块可用性 | ⬜ 未完成（本机 proot 无法运行 workerd；Node 仿真不作兼容性证明） | 若 D 级失败 → 一行改静态导入 | D 级部署后真实 VLESS→TCP 回环测试 |

本阶段未编造任何正式 URL、未登录 Cloudflare、未部署、未写入真实密钥。

## 5. 尚未完成的事项

1. **G-4 修复未实施**（超 3A.1 授权范围；已给最小方案，建议随 3B 批准执行）。
2. **G-3**：动态 import 的真实 workerd 验证待 D 级。
3. **HK/JP/SG/NL 数据仍为 EMPTY**（探测视点未见对应 colo；不伪造，待 Actions 视点补充）。
4. **测试 fixture 幂等重写**（新发现，见 §6.3）：管线回归套件每次运行重写 `pipeline/test_ranges_fixture.txt`（内容字节不变）——建议 3B 将 fixture 写入改到临时目录（test_update_data.py:126 一处）。
5. **E/F 级**（NekoBox 真机导入、真机代理）待 D 级部署后执行。
6. wrangler v3→v4 升级评估未做（v3.114 仍受支持，非阻断）。

## 6.3 补充披露：本阶段唯一文件系统接触

- `pipeline/test_ranges_fixture.txt` mtime 变化：由管线回归套件每次运行的 `write_fixture_ranges()` 幂等重写；**SHA256 与 3A1 报告记录完全一致**（`8cbb55f6…15e12`），内容零变化。已计入上述待办 #4。
- 工程其余全部文件（含 data/ 六地区文件与 audit.json，mtime 09:09）本阶段零触碰。

## 7. 是否建议进入第三阶段 B

**建议：可以进入 3B（部署阶段），前置条件三项不变。**

| 判定条件（3A 报告 H 节） | 状态 |
|---|---|
| 无公开默认 UUID | ✅（探测实证 fail-closed + 零泄密） |
| 无未授权订阅泄漏 | ✅（29 项安全探测 + 12 项订阅校验） |
| 无跨请求状态污染 | ✅（并发隔离分层验证） |
| 部署配置完整 | ✅（dry-run 通过；DATA_BASE_URL 占位符列为部署时必办项） |
| 本地测试全部通过 | ✅（129/129 用例 + 8 项静态/运行记录，统计口径已校正） |
| 无开放中继缺陷 | ✅（UUID 鉴权后转发 + 凭据私有） |
| 免费计划风险明确 | ✅（3A 报告 F 节，本阶段无变化） |

前置清单（3B 批准后执行，均已有明确方案）：① 替换 DATA_BASE_URL；② G-4 一行修复；③ G-3 留 D 级实测；④（可选）fixture 临时目录化。

本报告为纯核查产物，未执行任何部署。等待人工验收。
