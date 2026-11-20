# 第二阶段交付报告 — cfip-regions

工程目录：`<workspace>/cfip-regions/`
参考审查（只读、零改动）：`<workspace>/review/CloudflareIP/`
版权立场：参考项目无 LICENSE，本工程为 clean-room 独立实现，未复制其任何代码；`worker.js`/`index.html`/`py/*.py` 均为独立重写。授权阻塞项：无。

---

## 1. 项目架构图

```
GitHub 仓库（fork）
├── pipeline/update_data.py        每小时取 cloudflare.com/ips-v4 → TLS trace 探测
│     └→ colo 验证（HKG/NRT…/FRA/AMS…）→ data/{HK,JP,SG,US,DE,NL}.txt + audit.json
│        （UNKNOWN 不发布；源故障保留旧数据；::error 显式失败）
├── .github/workflows/update.yml   cron 0 * * * *，concurrency 锁，[skip ci] 提交
├── .github/workflows/ci.yml       A 级静态检查 + B 级单测 + 管线自测
│
Cloudflare Workers（免费计划，workers.dev）
├── src/index.mjs    路由：/ 状态页｜/sub/<token> 订阅｜WS_PATH 隧道（其余 403/404）
├── src/config.mjs   fail-closed：VLESS_UUID/WS_PATH/SUB_TOKEN 缺失即 500
├── src/vless.mjs    首包解析：版本/UUID/命令/端口/IPv4/域名/IPv6 + 校验错误码
├── src/session.mjs 每请求局部状态：直连→ProxyIP 回退；连接/空闲超时；幂等关闭
├── src/sub.mjs      订阅：纯 base64(vless://)；region 过滤；仅 status=OK
└── src/data.mjs     拉取 data/*.txt（5min 边缘缓存 + 失败回退上次数据）
│
NekoBox（Android）
└── 订阅 URL https://<host>/sub/<SUB_TOKEN>[?region=hk,jp,…] → base64 解码导入
```

## 2. 六地区数据来源及完整性

| 地区 | 文件 | 真值依据 | 验证条目（本机首轮） | 状态 |
|---|---|---|---|---|
| HK | data/HK.txt | colo=HKG | **0** | **缺失，未伪造** |
| JP | data/JP.txt | colo=NRT/KIX/FUK | 0 | 缺失，未伪造 |
| SG | data/SG.txt | colo=SIN | 0 | 缺失，未伪造 |
| US | data/US.txt | colo=美洲码（EWR 实证） | 26 | ✅ |
| DE | data/DE.txt | colo=FRA（实证） | 133 | ✅ |
| NL | data/NL.txt | colo=AMS | 0（手工探测确认 108.162.198.x→AMS 可见） | 待 Actions 视点补充 |

缺失原因：本机拨号视点的 anycast 落点仅 FRA/AMS/EWR（探测 400+ IP 实测分布）。GitHub Actions runner 视点不同，每小时更新可能补齐；**HK 若始终无 HKG 观测则永远如实留空**。

## 3. 自动更新机制（docs/PIPELINE.md 详版）

- 触发：`cron 0 * * * *` + 手动（probe_limit 可调）；`concurrency` 组取消并行写；提交 `[skip ci]` 防递归。
- 语义：源失败 RC=2 → 保留全部旧数据并 `::error`；全地区零命中 RC=1 → 数据不覆盖 + `::warning`；空地区写 `EMPTY — NOT fabricated`。
- 审计：每行 `address|region|source|first_seen|last_checked|status`；`audit.json` 记录 colo 证据、stats、UNKNOWN 样本、四概念（接入 colo / worker_runloc=not_applicable / role=candidate_entry / exit_ip=not_observed）。

## 4. Worker 安全设计（docs/SECURITY.md 详版）

对照第一阶段缺陷逐项修复：独立 UUID（fail closed）、订阅凭据 404 不可枚举、固定 WS 路径 403、ProxyIP 请求局部化、超时与幂等释放、无公开默认凭据、日志 maskUuid、ProxyIP 仅作回退不出现在节点链接。

## 5. NekoBox 订阅格式示例（docs/NEKOBOX.md 详版）

```
vless://<uuid>@103.31.4.1:443?encryption=none&security=tls&sni=<host>
        &fp=random&type=ws&host=<host>&path=%2F<WS_PATH>#CF-US-103.31.4.1
```
标准 base64 订阅体；六地区命名 `CF-XX-`；支持 `?region=` 过滤；仅 OK 节点；空地区返回空订阅。

## 6. 自动化测试结果（docs/TESTING.md 详版）

| 级别 | 状态 | 证据 |
|---|---|---|
| A 静态检查 | ✅ | node --check 6/6；wrangler deploy --dry-run bundle 成功 |
| B 单元测试 | ✅ 27/27 | 含任务书 8 项必测全部覆盖 |
| C 本地模拟 | ✅ 7/7 | Node 运行时仿真（workerd 在本机 proot 不可用，原因已记录：tcmalloc 1GB 对齐 mmap 失败）；e2e 含完整 VLESS→TCP 回环 |
| D 实际部署 | ⛔ 未执行 | 阶段边界禁止，待批准 |
| E 真机导入 | ⛔ 未执行 | 待 D |
| F 真机代理 | ⛔ 未执行 | 待 E |

## 7. 尚未解决/待第三阶段问题清单

1. HK/JP/SG（可能含 NL）数据缺失：需不同网络视点（Actions runner 或 APAC VPS 探针）观测到对应 colo；不伪造。
2. `workerd` 本机不可用：C 级用 Node 仿真替代；标准 Linux 上可用 `tools/run_c_level.sh` 复跑官方 workerd 版。
3. anycast 语义限制：节点标签=入口 colo 已验证，非出口地区；出口真值待 F 级观测。
4. ProxyIP 未配置默认值：未验证的第三方反代不引入（原项目默认反代属未验证依赖）。
5. `region` 参数未知值 → 空订阅（符合"不虚构"，客户端无感）。
6. Workers 免费计划限制已知：100k req/天、10ms CPU/请求；本设计远低于限值，无需 KV/Cron（GitHub Actions 已覆盖更新，Worker 加 Cron 属重复实现）。

## 8. 后续部署步骤

见 docs/DEPLOY.md：生成密钥 → `wrangler secret put` 三项 → `wrangler deploy` → curl 验证（D 级）→ 启用 Actions → NekoBox 导入（E）→ 真机代理验证并回填出口观测（F）。

## 9. 交付文件清单

```
cfip-regions/
├── src/{index,vless,config,session,sub,data}.mjs
├── test/{vless,session,config-sub}.test.mjs（27 例）+ e2e_local.mjs（7 例）
├── tools/{run_c_level.sh, run_c_level_shim.mjs, loader.mjs, sockets-shim.mjs, worker-shims.mjs}
├── pipeline/{update_data.py, sources.json, sources_fixture.txt}
├── data/{HK,JP,SG,US,DE,NL}.txt + audit.json（真实探测产物）
├── .github/workflows/{update,ci}.yml
├── docs/{SECURITY,PIPELINE,NEKOBOX,TESTING,DEPLOY}.md
├── wrangler.toml（零密钥）+ .dev.vars（gitignore，测试值）
├── README.md + LICENSE(MIT) + 本报告
```

## 10. 阶段边界遵守声明

- review/ 目录零改动（只读克隆）；
- 未登录、未部署、未触碰任何 Cloudflare 账号/Worker/域名；
- 未验证功能一律未标记为已实现；测试分级如实（A/B/C 过，D/E/F 未执行）；
- 本阶段止于报告，等待人工验收后再进入第三阶段。
