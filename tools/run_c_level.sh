#!/usr/bin/env bash
# run_c_level.sh — C-level local simulation harness.
# Starts: data HTTP server (8931) + wrangler dev (8787) with TEST-ONLY secrets,
# runs test/e2e_local.mjs, then cleans up. No Cloudflare account, no deploy.
set -u
cd "$(dirname "$0")/.."

PORT_DATA=8931
PORT_DEV=8787

# --- generate throwaway test credentials (never real, never committed) ---
if [ ! -f .dev.vars ]; then
  TEST_UUID="$(cat /proc/sys/kernel/random/uuid | tr 'A-Z' 'a-z')"
  TEST_WS="/t-$(openssl rand -hex 8 2>/dev/null || head -c16 /dev/urandom | xxd -p)"
  TEST_SUB="$(openssl rand -hex 16 2>/dev/null || head -c32 /dev/urandom | xxd -p)"
  cat > .dev.vars <<EOF
VLESS_UUID=${TEST_UUID}
WS_PATH=${TEST_WS}
SUB_TOKEN=${TEST_SUB}
WORKER_URL=http://127.0.0.1:${PORT_DEV}
DATA_BASE_URL=http://127.0.0.1:${PORT_DATA}
PROXY_IPS=
EOF
  echo "generated test-only .dev.vars (uuid=${TEST_UUID:0:8}-…)"
fi

# --- data server ---
python3 -m http.server "$PORT_DATA" --bind 127.0.0.1 --directory "$(pwd)/data" \
  > /tmp/cfip-data-server.log 2>&1 &
DATA_PID=$!
echo "data server pid=$DATA_PID"

# --- wrangler dev (local mode, no account) ---
npx wrangler dev --port "$PORT_DEV" --ip 127.0.0.1 > /tmp/cfip-wrangler-dev.log 2>&1 &
DEV_PID=$!
echo "wrangler dev pid=$DEV_PID"

cleanup() {
  kill "$DEV_PID" "$DATA_PID" 2>/dev/null || true
  pkill -f "wrangler dev --port $PORT_DEV" 2>/dev/null || true
  pkill -f "workerd" 2>/dev/null || true
}
trap cleanup EXIT

# --- readiness wait ---
for i in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT_DATA}/audit.json"; then break; fi
  sleep 0.5
done
for i in $(seq 1 90); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT_DEV}/"; then
    echo "wrangler dev ready after ${i}s"; break
  fi
  sleep 1
done

# --- run C-level tests ---
node test/e2e_local.mjs
RC=$?

echo "---- wrangler tail log (last 20) ----"
tail -20 /tmp/cfip-wrangler-dev.log || true
exit $RC
