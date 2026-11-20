# 第三阶段 B-1 报告 — 部署准备与配置核验

工程：`<workspace>/cfip-regions/` ｜ 执行时间：2026-11-20 12:29–12:50
授权边界执行情况：✅ 仅部署准备；**未登录 Cloudflare、未创建/部署/删除 Worker、未写入任何真实 Secrets、未触碰 cold-salad-8f76、未公开任何敏感配置**。

全量测试统计：**断言用例 131/131 通过**（B 29 + 管线回归 45 + C 7 + 安全探测 30 + 订阅校验 12 + 抽检 8）+ node --check 6/6 + dry-run 通过 + 离线自测 RC=0。

---

## 1. 文件变更清单及 SHA256

| 文件 | 变更 | SHA256 |
|---|---|---|
| src/index.mjs | 修改：G-4 修复（accept 前钉死 binaryType） | `e8e2cb92201fec5d151b1610a6c559f6a658eabb682eb62ead58b875f68e73ae` |
| test/binarytype.test.mjs | **新增**：G-4 回归测试 | `c9f1cfe693b4d292b6438ab665188f8d0104d4b5f3bb73aa9a8f050ece1d69bc` |
| tools/worker-shims.mjs | 修改：accept() 增加测试钩子 `__shimLastAccepted`（仅测试基建） | `b4278aa158deb8da17967ceaacf892e01f22b07cf0ed9b922945f31994e03981` |
| pipeline/test_update_data.py | 修改：fixture 临时目录化（`fresh_dir()` 写入临时目录 + `run_pipeline` 默认取 `default_ranges(data_dir)`） | `b8a78db6226b9d6c8e843a8ca0ffd97cb0905301ca516dd511ea1a835e45aba4` |
| pipeline/test_ranges_fixture.txt | **删除**：随临时目录化移除（3A.1 记录 SHA `8cbb55f658a9cc79414ef30f9d770aab2e0def721040dd73939b15d6ecd15e12`） | — |
| docs/DEPLOY_PLAN.md | **新增**：3B-2 执行手册（步骤/验证矩阵/失败处理/回滚） | `4f9305ac4b0453a962c550799f6f636c3fc57732ab529e2d4cdc543be152d85a` |
| test/e2e_local.mjs | 净零变更（G-4 断言先加后因进程边界迁出，grep "G-4"=0） | — |

未触碰：data/（mtime 仍 09:09）、wrangler.toml、src/ 其余模块、review/ 参考仓库、一切线上资源。

## 2. DATA_BASE_URL 核验结果

**占位符全量清单**（grep 实证）：生产占位符 `wrangler.toml:17`（`YOUR_USERNAME`）；运行时读取 `src/config.mjs:56`；访问拼装 `src/data.mjs:17`（`${base}/${REGION}.txt`，大写）；本地测试地址 `.dev.vars:5`、`tools/run_c_level.sh:21`（127.0.0.1:8931，gitignored）；单测 fixture `test/config-sub.test.mjs:14`；文档 `docs/DEPLOY.md:28`。

- **真实数据源地址**：尚不存在——本工程未推送 GitHub，fork 未创建。**不编造**，占位符保留；3B-2 执行时由人工提供 fork 地址并回填（前置检查单 P2/P3）。
- **访问通道实测**（公开第三方仓库，仅验证通道）：`raw.githubusercontent.com` 返回 HTTP 200 + `text/plain; charset=utf-8` ✅（该仓库行格式为 `IP#标签`，与本工程管道格式不同，**不作为本工程数据源**）。
- **本工程格式兼容性实证**：真实 data 文件（US 26 + DE 133 行，管道格式）经本地 HTTP 通道被 Worker `data.mjs→sub.mjs` 全量解析为 159 节点（C 级 e2e `nodes=159 regions=US,DE`）✅。
- 结论：地址未定（前置条件），访问方式与格式契约已验证，占位符不被当真实源运行（缺失/错误时 fail-closed 空订阅）。

## 3. G-4 修复与测试结果

**修复**（src/index.mjs:81-88，官方文档要求 assign before accept）：

```diff
     const pair = new WebSocketPair();
+    // G-4 fix: pin binary frame delivery to ArrayBuffer BEFORE accept(). ...
+    pair[1].binaryType = 'arraybuffer';
     pair[1].accept();
```

**回归测试**（新增 test/binarytype.test.mjs，B 级套件 28→29）：
- 正向：worker.fetch WS 路由 → 101 + `__shimLastAccepted.binaryType === 'arraybuffer'` ✅
- **负向验证**（真实执行）：临时回退修复行 → 测试 FAIL（`✖ G-4: ...`）；恢复后 PASS——测试确实捕获目标缺陷，非恒真断言。
- sec-probe 同进程断言（+1 → 30）：`WS server socket binaryType pinned (G-4) — got arraybuffer` ✅
- 过程说明：首版断言放在 e2e 子进程内因 shim 全局跨进程不可见而 FAIL（如实记录），已迁至同进程的 B 级与 sec-probe，e2e_local 净零变更。

## 4. Fixture 临时目录化结果

- `fresh_dir()` 现将 TEST-NET fixture 写入临时工作区（`d/ranges.txt`），`run_pipeline` 默认随之取临时路径；项目内 `pipeline/test_ranges_fixture.txt` 已删除。
- 实证：45/45 回归全过后，`find -newermt "12:29"` 仅命中 4 个本阶段有意修改的文件——**测试对项目树零写入**。

## 5. 全量测试统计（最终）

| 套件 | 结果 |
|---|---|
| node --check（6 模块） | 6/6 |
| wrangler dry-run | ✅ `Total Upload: 17.69 KiB / gzip 5.64 KiB`（bundle 内含 `binaryType = "arraybuffer"` 与 1 处 `import("cloudflare:sockets")`） |
| B 级单元测试 | **29/29**（含新 G-4 回归） |
| 管线回归 | 45/45 |
| C 级本地仿真 e2e | 7/7 |
| 安全探测 | **30/30**（含新 G-4 断言） |
| 订阅校验 | 12/12 |
| 数据抽检 | 8/8（EWR×4、FRA×4） |
| 管线离线自测 | RC=0 |
| **断言用例合计** | **131/131，0 失败** |

## 6. Wrangler 部署配置核验结果

| 项 | 核验 | 结论 |
|---|---|---|
| 入口/main | `src/index.mjs`（ESM default fetch） | ✅ |
| compatibility_date | `2024-11-01`（保持；G-4 已解除 binaryType 日期耦合） | ✅ |
| workers.dev | 无 routes/zone 配置 → 默认 workers.dev 域名 | ✅ 符合目标 |
| Vars | DATA_BASE_URL（占位符，部署时回填）、CONNECT/IDLE_TIMEOUT | ✅ |
| Secrets 契约 | VLESS_UUID/WS_PATH/SUB_TOKEN + 可选 PROXY_IPS/WORKER_URL，与 config.mjs 一致 | ✅ |
| 依赖 | 运行时零依赖；wrangler 3.114.17、ws 8.23.0（仅 dev） | ✅ |
| Bundle | 17.69 KiB（限 64 MiB）、内含 G-4 修复与动态 import（G-3 留 D 级） | ✅ |
| 订阅路由/鉴权/UUID | 30 项安全探测 + 12 项订阅校验全绿（本阶段复跑） | ✅ |
| STALE 语义 | PUBLISHED_STATUS='OK' 契约保持；管线 45 项含 STALE 用例全绿 | ✅ 未将 STALE 发布为 OK |

## 7. Cloudflare 部署步骤 / 验证方案 / 失败处理 / 回滚方案

完整交付于 **docs/DEPLOY_PLAN.md**（新增）：0 前置检查单（P1–P5）→ 1 密钥现场生成 → 2 Secrets 写入 → 3 `wrangler deploy` → 4 D 级验证矩阵 D1–D8（存活/凭据/订阅/过滤/WS 路径/隧道回环/出口观测/客户端订阅更新）→ 5 回滚（versions rollback / secret 重写 / wrangler delete / Dashboard Disable）→ 6 失败处理表（G-3 动态导入、1027/1102、STALE 空订阅等六类症状→处置）→ 7 授权边界。

## 8. 尚未解决的问题

1. **G-3**：动态 `import("cloudflare:sockets")` 需 D 级实测（失败则一行改静态导入，预案在 DEPLOY_PLAN §6）。
2. **DATA_BASE_URL**：真实地址待 fork 创建后回填（P2/P3）。
3. **HK/JP/SG/NL** 仍 EMPTY（视点未观测到对应 colo，不伪造）。
4. **E/F 级**：NekoBox 真机导入与真实代理连通待 D 级通过后执行。
5. wrangler v4 升级评估（非阻断）。
6. 本机 proot 无法运行 workerd：C 级为 Node 仿真，**不得表述为真实 Cloudflare 环境测试**（声明保留）。

## 9. 结论

3B-1 全部授权项完成：G-4 修复+负向验证闭环、fixture 零污染化、DATA_BASE_URL 核验（不编造、占位符保留）、配置核验通过、131/131 测试全绿、3B-2 执行手册（含回滚与失败处理）交付。
**按停止条件，本阶段到此停止。3B-2（真实部署）未获单独授权，未执行任何 wrangler deploy / Secrets 写入 / 线上操作。等待人工验收。**
