# cfip-regions — 六地区 Cloudflare VLESS 节点系统（独立实现）

独立工程。基于公开协议规范（VLESS wire format、Cloudflare 官方文档）从零实现，
**未复制** `gslege/CloudflareIP` 的任何源码（该项目无 LICENSE）。

## 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| Worker | `src/` | VLESS + WS + TCP 代理，fail-closed 配置，固定 WS 路径 |
| 数据管线 | `pipeline/` | 六地区候选 IP 获取 + colo 验证 + 审计 |
| 地区数据 | `data/` | `HK/JP/SG/US/DE/NL.txt` + `audit.json`（不伪造，UNKNOWN 不发布） |
| 自动更新 | `.github/workflows/update.yml` | 每小时，并发锁，失败显式报错，保底不回退 |
| CI | `.github/workflows/ci.yml` | 单测 + 管线自测 + wrangler dry-run |
| 测试 | `test/` | B 级单测 27 例；C 级 e2e 7 例（`tools/run_c_level_shim.mjs`） |

## 快速命令

```bash
npm install
npm test                              # B 级：node --test
node tools/run_c_level_shim.mjs       # C 级：本地运行时仿真（无需 Cloudflare 账号）
npx wrangler deploy --dry-run --outdir /tmp/w  # A 级：打包校验（不部署）
python3 pipeline/update_data.py --probe-limit 200   # 手动跑数据管线
```

## 安全模型（详见 docs/SECURITY.md）

- 无公开默认 UUID：`VLESS_UUID` 缺失即 500 拒绝服务（fail closed）
- WS 只接受 `WS_PATH` 固定路径，其余 403；订阅凭据在路径中，错误 token 与不存在路径同返回 404
- ProxyIP 为请求局部变量，无模块级共享状态
- 仓库零真实密钥（`.dev.vars` 已 gitignore，值均为一次性测试值）

## 测试状态（诚实分级）

| 级别 | 内容 | 状态 |
|---|---|---|
| A | 静态检查 + wrangler dry-run | ✅ |
| B | 单元测试 27/27 | ✅ |
| C | 本地运行时仿真 e2e 7/7（Node shim；本机 proot 跑不了 workerd，详见 docs/TESTING.md） | ✅ |
| D | Cloudflare 实际部署 | ⛔ 阶段边界禁止，待批准 |
| E | NekoBox 真机导入 | ⛔ 待 D |
| F | 真机代理连通 | ⛔ 待 E |

## License

MIT（见 LICENSE）。本项目为 clean-room 独立实现。
