# 测试分级与结果

## 分级定义（与任务书对齐）

| 级别 | 定义 | 执行环境 |
|---|---|---|
| A | 静态代码检查 | `node --check` 全部 src；`wrangler deploy --dry-run` 打包校验 |
| B | 本地单元测试 | `node --test "test/*.test.mjs"` |
| C | Worker 本地模拟环境 | 本机 Node 运行时仿真（见下） |
| D | Cloudflare 实际部署 | wrangler deploy 到 workers.dev |
| E | NekoBox 真机导入 | Android 手机导入订阅 |
| F | NekoBox 真机代理 | 真实流量经节点出去 |

## 当前结果

- **A：通过**。`node --check` 6/6 模块；`wrangler deploy --dry-run` 成功产出 bundle（绑定 vars 校验通过）。
- **B：通过 27/27**。覆盖任务书 8 项必测：正确 UUID、错误 UUID（AUTH_FAIL）、IPv4、IPv6（含压缩形式）、域名、端口 0（BAD_PORT）、截断包（TRUNCATED 多刀位）、客户端提前断开（session 测试）；另含并发隔离、回退拨号、连接超时、空闲超时、fail-closed 配置、订阅纯净性等。
- **C：通过 7/7**。`GET /` 无泄密、错误 token 404、正确 token 标准 base64 订阅（159 节点，仅 US/DE——其余地区如实为空）、region 过滤（us=26，nl 空订阅）、错误 WS 路径 403、坏 UUID 拒绝、**完整 VLESS 握手→TCP 回环→echo 返回**。
- **D/E/F：未执行**。阶段边界禁止部署与账号操作；标记为待批准后第三阶段。

## C 级执行方式（诚实声明）

首选 `wrangler dev`（workerd 官方本地模拟）。本机为 Android proot Ubuntu，
workerd 启动即失败：`tcmalloc MmapAligned() failed … size=1073741824`
（内核限制 1GB 对齐带 tag 的 mmap；日志 `/tmp/cfip-wrangler-dev.log`）。

因此 C 级实际执行的是**等效本地运行时仿真**：`tools/run_c_level_shim.mjs`
- module loader hook 把 `cloudflare:sockets` 映射到 `node:net`（真 TCP）
- shim `WebSocketPair`（每请求新对，无共享状态）与 `Response(101, webSocket)`
- 真实 HTTP 数据服务（:8931）+ `ws` 库服务端（:8787）+ Node 原生 WebSocket 客户端
- **Worker 源码零改动**，测的就是 `src/index.mjs` 本体

局限：仿真不是 workerd 本体；V8 isolate 行为、边缘 TLS、`connect()` 的真实
出口语义以 D 级为准。`tools/run_c_level.sh`（workerd 版 harness）保留，
在任何标准 Linux 上可直接跑同一套 e2e 断言。

## 重复执行

```bash
node tools/run_c_level_shim.mjs   # 本机（proot 亦可）
bash tools/run_c_level.sh         # 标准 Linux（workerd 可用时）
npm test                          # B 级
```
