# NekoBox 订阅格式

## 订阅地址（部署后）

```
https://<worker-name>.<account>.workers.dev/sub/<SUB_TOKEN>            # 全部地区
https://<worker-name>.<account>.workers.dev/sub/<SUB_TOKEN>?region=us # 单地区
https://.../sub/<SUB_TOKEN>?region=hk,jp                              # 多地区
```

## 输出格式

标准 Base64（RFC 4648）编码的 `vless://` 分享链接，每行一条，无任何说明文字：

```
vless://<uuid>@103.31.4.1:443?encryption=none&security=tls&sni=<worker-host>
        &fp=random&type=ws&host=<worker-host>&path=%2F<WS_PATH>#CF-US-103.31.4.1
```

参数完整性：`security=tls`、`sni`、`type=ws`、`host`、`path`、`fp=random`、
`encryption=none`——sing-box（NekoBox 内核）VLESS over WS 所需字段齐备。
地区命名规则 `CF-<大写地区>-<入口IP>`。

## 保证

- 只有 `status=OK`（colo 验证过）的条目才会出现在订阅中；无数据地区输出空订阅，
  绝不生成假节点。
- 空地区筛选（如 `?region=nl` 当前）返回空 body——NekoBox 会显示 0 节点，
  这是"如实缺失"而非故障。
- `profile-update-interval: 1`（小时）提示客户端自动更新。

## NekoBox 导入步骤（D 级部署后）

1. NekoBox → 订阅分组 → 新建 → 粘贴订阅 URL → 保存并更新。
2. 或手动：链接 → 从剪贴板导入（单条 vless://）。

## 与 Workers 免费计划的关系

订阅内容是静态字符串拼接 + 一次 raw.githubusercontent fetch（5 分钟边缘缓存），
每客户端每小时 1-2 次请求；免费计划 100k req/天 完全够用，不需要 KV/R2。
