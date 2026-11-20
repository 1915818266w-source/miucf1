#!/usr/bin/env bash
# deploy_cf.sh — one-shot Cloudflare Workers deployment for cfip-regions.
#
# Prerequisites (checked, never bypassed):
#   1. wrangler authenticated (npx wrangler whoami) — user runs `npx wrangler login` themselves.
#   2. Secrets file /root/.secrets-cfip/secrets.env (0600, outside the repo) with
#      VLESS_UUID / WS_PATH / SUB_TOKEN — values are NEVER printed by this script.
#
# This script contains no secrets. It never echoes credential values.
# Usage: bash tools/deploy_cf.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SECRETS_FILE="${SECRETS_FILE:-/root/.secrets-cfip/secrets.env}"

echo "[1/6] wrangler auth check"
npx wrangler whoami >/dev/null 2>&1 || { echo "FAIL: wrangler 未登录 — 请先在终端运行 npx wrangler login"; exit 1; }
echo "  OK: 已认证"

echo "[2/6] secrets 文件检查"
[ -f "$SECRETS_FILE" ] || { echo "FAIL: 缺少 $SECRETS_FILE"; exit 1; }
[ "$(stat -c %a "$SECRETS_FILE")" = "600" ] || chmod 600 "$SECRETS_FILE"
# shellcheck disable=SC1090
. "$SECRETS_FILE"
for v in VLESS_UUID WS_PATH SUB_TOKEN; do
  [ -n "${!v:-}" ] || { echo "FAIL: secrets.env 缺少 $v"; exit 1; }
done
echo "  OK: 三项凭据存在（值不显示）"

echo "[3/6] 写入 Cloudflare Secrets（stdin 管道，不回显）"
printf '%s' "$VLESS_UUID"  | npx wrangler secret put VLESS_UUID >/dev/null
printf '%s' "$WS_PATH"     | npx wrangler secret put WS_PATH >/dev/null
printf '%s' "$SUB_TOKEN"   | npx wrangler secret put SUB_TOKEN >/dev/null
echo "  OK: VLESS_UUID / WS_PATH / SUB_TOKEN 已写入"

echo "[4/6] 部署 Worker"
npx wrangler deploy

echo "[5/6] 提取部署域名"
WORKER_URL=$(npx wrangler deploy --dry-run --outdir /tmp/cfip-dep-dry 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' | head -1 || true)
# 部署输出里包含域名；从 wrangler deploy 输出兜底提取
if [ -z "$WORKER_URL" ]; then
  WORKER_URL=$(npx wrangler deployments list 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' | head -1 || true)
fi
[ -n "$WORKER_URL" ] || { echo "FAIL: 未能确定 workers.dev 域名"; exit 1; }
echo "  部署域名: $WORKER_URL"

echo "[6/6] D 级冒烟验证"
sleep 3
code_root=$(curl -s -o /dev/null -w '%{http_code}' "$WORKER_URL/")
echo "  GET /            -> $code_root (期望 200)"
code_bad=$(curl -s -o /dev/null -w '%{http_code}' "$WORKER_URL/sub/wrong-token")
echo "  GET /sub/wrong   -> $code_bad (期望 404)"
sub_body=$(curl -s "$WORKER_URL/sub/$SUB_TOKEN")
decoded=$(printf '%s' "$sub_body" | base64 -d 2>/dev/null || true)
nodes=$(printf '%s' "$decoded" | grep -c '^vless://' || true)
echo "  GET /sub/<token> -> $nodes 个 vless 节点（非空=数据链路通）"
if [ "$code_root" = "200" ] && [ "$code_bad" = "404" ] && [ "$nodes" -ge 1 ]; then
  echo ""
  echo "D 级冒烟通过。NekoBox 订阅地址（请勿外传）:"
  echo "  $WORKER_URL/sub/$SUB_TOKEN"
else
  echo "  部分检查未通过——按 docs/DEPLOY_PLAN.md §6 排查"
  exit 1
fi
