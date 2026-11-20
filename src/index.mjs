/**
 * index.mjs — Cloudflare Workers entrypoint (ESM export default).
 *
 * Routing contract:
 *   GET  /                  -> 200 minimal status text (no secrets)
 *   GET  /sub/<SUB_TOKEN>   -> 200 base64 subscription (region filter via ?region=)
 *   anything else:
 *     - must be WS upgrade on exactly WS_PATH, else 403/404
 *
 * Fail-closed rules:
 *  - missing/invalid env secrets -> every request 500 before any processing;
 *  - wrong subscription token -> 404 (indistinguishable from nonexistent path);
 *  - WS on wrong path -> 403.
 */

import { resolveConfig, maskUuid, ConfigError } from './config.mjs';
import { parseFirstPacket, buildReplyFrame } from './vless.mjs';
import { runSession } from './session.mjs';
import { renderSubscription } from './sub.mjs';
import { collectNodes } from './data.mjs';

export default {
  async fetch(request, env, ctx) {
    let cfg;
    try {
      cfg = resolveConfig(env);
    } catch (e) {
      if (e instanceof ConfigError) {
        return new Response(`worker misconfigured: ${e.message}\n`, {
          status: 500,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      throw e;
    }

    const url = new URL(request.url);
    const log = (level, msg) =>
      console.log(JSON.stringify({ t: Date.now(), level, msg }));

    // --- subscription (credential carried in path; no other secret in response) ---
    if (url.pathname === cfg.subPath) {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      const regionParam = url.searchParams.get('region');
      const regions = regionParam
        ? regionParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        : null;
      try {
        const nodes = await collectNodes(cfg.dataBaseUrl, cfg.uuid, regions || ['hk','jp','sg','us','de','nl']);
        const body = renderSubscription(nodes, cfg, regions || undefined);
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'profile-update-interval': '1', // hours, hint for clients like NekoBox
          },
        });
      } catch (e) {
        log('error', `subscription build failed: ${e.message}`);
        return new Response(null, { status: 502 });
      }
    }

    // --- status page: never includes uuid/proxyips/links ---
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('cfip-regions worker: OK\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    // --- VLESS WebSocket tunnel on the fixed secret path ---
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 404 });
    }
    if (url.pathname !== cfg.wsPath) {
      return new Response(null, { status: 403 });
    }

    const pair = new WebSocketPair();
    // G-4 fix: pin binary frame delivery to ArrayBuffer BEFORE accept().
    // Runtime default flips to "blob" when websocket_standard_binary_type is
    // enabled (compat >= 2026-03-17); parseFirstPacket requires byte-addressable
    // data. Pinning here decouples correctness from the compatibility date.
    pair[1].binaryType = 'arraybuffer';
    pair[1].accept();

    const wsReady = new Promise((resolveReady) => {
      const onFirst = (ev) => {
        pair[1].removeEventListener('message', onFirst);
        resolveReady(ev);
      };
      pair[1].addEventListener('message', onFirst);
      pair[1].addEventListener('close', () => resolveReady(null));
      pair[1].addEventListener('error', () => resolveReady(null));
    });

    const session = ctx.waitUntil(
      (async () => {
        const first = await Promise.race([
          wsReady,
          new Promise((r) => setTimeout(() => r(null), 15000)), // first-packet deadline
        ]);
        if (!first || !first.data) {
          try { pair[1].close(4000, 'no vless first packet'); } catch { /* noop */ }
          return { ok: false, reason: 'NO_FIRST_PACKET' };
        }
        try {
          const parsed = parseFirstPacket(first.data, cfg.uuid);
          return await runSession(pair[1], {
            firstPacket: parsed,
            proxyIps: cfg.proxyIps,
            connectTimeoutMs: cfg.connectTimeoutMs,
            idleTimeoutMs: cfg.idleTimeoutMs,
            logger: log,
          });
        } catch (e) {
          log('warn', `vless handshake rejected: ${e.code || e.message}`);
          try {
            pair[1].send(buildReplyFrame(0x01));
            pair[1].close(4003, 'vless handshake failed');
          } catch { /* noop */ }
          return { ok: false, reason: e.code || 'HANDSHAKE_ERROR' };
        }
      })(),
    );

    return new Response(null, { status: 101, webSocket: pair[0] });
  },
};

// re-export for unit tests without wrangler
export { resolveConfig, maskUuid, parseFirstPacket, renderSubscription };
