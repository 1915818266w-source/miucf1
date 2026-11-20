/**
 * binarytype.test.mjs — G-4 regression: the worker MUST pin the server-side
 * WebSocket binaryType to 'arraybuffer' BEFORE accept(), so binary frames stay
 * byte-addressable regardless of the websocket_standard_binary_type compat flag
 * (which flips the runtime default to "blob" on compat >= 2026-03-17).
 *
 * Runs worker.fetch directly in-process with the local shims (tools/), so the
 * shim test hook (__shimLastAccepted) is observable here — unlike the e2e
 * child process, which cannot see the harness's globals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installShims } from '../tools/worker-shims.mjs';
installShims();

const worker = (await import('../src/index.mjs')).default;

const env = {
  VLESS_UUID: 'a1b2c3d4-1111-2222-3333-444455556666',
  WS_PATH: '/t-g4regression01',
  SUB_TOKEN: '0123456789abcdef0123456789abcdef',
  DATA_BASE_URL: 'http://127.0.0.1:9', // unreachable; not needed for the WS route
  PROXY_IPS: '',
};
const ctx = { waitUntil: (p) => { p.catch(() => {}); } };

test('G-4: WS route pins server-side binaryType to arraybuffer before accept', async () => {
  const req = new Request(`http://localhost${env.WS_PATH}`, {
    method: 'GET',
    headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
  });
  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 101, 'WS route must return 101');
  assert.ok(res.webSocket, '101 response must carry the client-side socket');
  assert.equal(
    globalThis.__shimLastAccepted?.binaryType,
    'arraybuffer',
    'server-side socket binaryType must be pinned to arraybuffer',
  );
  // close the client side so the worker's first-packet race settles promptly
  res.webSocket.close();
});
