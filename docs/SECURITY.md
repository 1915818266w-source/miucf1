# Worker 安全设计说明

对照第一阶段审查发现的问题，逐项给出本工程的处置与代码位置。

## 1. 独立 UUID / 禁止公开默认 UUID

- `src/config.mjs`：`VLESS_UUID` 缺失或格式非法 → `ConfigError` → `src/index.mjs` 对所有请求返回 500（fail closed）。
- 仓库中不存在任何"默认 UUID"或示例真实凭据；`README`/`docs` 只写生成方法（`uuidgen`）。
- 对照原项目缺陷：默认 UUID `04c8…902` 公开于代码、README、生成器页面。

## 2. 订阅独立凭据 + 不泄漏

- 订阅路径 = `/sub/<SUB_TOKEN>`（`config.mjs`，token 最短 16 字符）。
- 错误 token → 404，与"路径不存在"不可区分（不暴露"存在但无权"的信息差）。
- `/` 状态页输出固定文本 `cfip-regions worker: OK`，不含 UUID / ProxyIP / 节点链接。
- 订阅体本身是 base64(vless 链接)——链接里含 UUID 是协议必需（客户端要连），但**只有持有 SUB_TOKEN 才能拿到**；凭据保护靠 token。
- 对照原项目缺陷：`/sub` 无鉴权回显 UUID+域名+反代 IP+成品链接。

## 3. 固定 WebSocket 路径 + 校验

- 只接受 `WS_PATH` 精确匹配的升级请求，其余 403（`src/index.mjs`）。
- `WS_PATH` 为部署期 secret，长度 ≥8，路径含 `?` 直接拒绝（防参数注入）。
- 对照原项目缺陷：任意路径均可建隧道，扫描器全开。

## 4. 无模块级共享状态

- `src/session.mjs` 全部状态在 `runSession` 闭包内；`src/data.mjs` 的模块级 Map 仅为按 region 键控的**只读数据缓存**（不含 ProxyIP/会话状态）。
- ProxyIP 候选列表来自 `resolveConfig`（每次请求重新解析 env），回退拨号在会话局部循环内进行。
- C 级测试 `concurrent sessions do not share state` 验证了并发隔离。
- 对照原项目缺陷：模块级 `反代IP` 被请求路径参数反复改写，跨请求污染。

## 5. 超时 / 异常 / 资源释放

- 首包截止 15s（无首包 → close 4000）；TCP `connect` 超时 `CONNECT_TIMEOUT_MS`（默认 10s）；上游读空闲超时 `IDLE_TIMEOUT_MS`（默认 120s）。
- 任一方向结束/出错 → `closeAll()`：幂等关 TCP + WS，双 close 防护。
- 会话 Promise 经 `ctx.waitUntil` 托管，异常均被捕获并结构化打日志（不含敏感值）。
- 握手失败发送 `[0x00, 0x01]` 失败帧再 close 4003（客户端可感知原因）。

## 6. 不做无鉴权开放中继

- 任意目标转发仅发生在 UUID 校验通过之后；UUID 是部署期随机值，未公开。
- 与原项目"公开默认 UUID + 任意转发 = 开放中继"的形态有本质区别。
- 额外摩擦：错误 UUID/坏包立即断开并记录 `AUTH_FAIL`。

## 7. 密钥不入库

- `wrangler.toml` 仅含非敏感 vars；敏感值全部走 `wrangler secret put`。
- `.dev.vars`（本地测试值）在 `.gitignore`；`tools/run_c_level.sh` 每次生成随机测试值。
- 日志端 `maskUuid()`（B 级测试验证）确保任何日志只出现 UUID 前段。

## 8. ProxyIP 语义（不误当节点地址）

- `PROXY_IPS` 仅作为**直连失败后的回退拨号目标**（`session.mjs` 回退循环），绝不出现在订阅链接中。
- 数据文件中候选地址的角色字段固定 `candidate_entry`（入口 IP），`exit_ip` 标记 `not_observed_by_pipeline`——四概念（接入机房 / Worker 运行位置 / ProxyIP 上游 / 出口 IP）在 `data/audit.json` 中分开记录。
