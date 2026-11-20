/**
 * session.mjs — per-request WebSocket <-> TCP bridge.
 *
 * Every callable here receives its own state; nothing is stored at module scope,
 * so concurrent requests cannot pollute each other (fixes the shared-state defect
 * identified in the phase-1 review of the reference project).
 *
 * Resource handling:
 *  - TCP connect is wrapped in a timeout race;
 *  - both directions are closed when either side ends or errors;
 *  - all close paths are guarded so double-close is a no-op.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_IDLE_TIMEOUT_MS = 120000;

/** Race a promise against a timeout; rejects with VlessError('CONNECT_TIMEOUT'). */
function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Create and run one proxied session.
 * @param {WebSocket} clientSocket already-accepted server-side WebSocket
 * @param {object} opts
 * @param {object} opts.firstPacket parsed descriptor from vless.parseFirstPacket
 * @param {string[]} opts.proxyIps fallback proxyip candidates (host[:port])
 * @param {object} [opts.sockets] injected sockets API (for tests); defaults to cloudflare:sockets
 * @param {number} [opts.connectTimeoutMs]
 * @param {number} [opts.idleTimeoutMs]
 * @param {function} [opts.logger] optional (level, msg) sink
 */
export async function runSession(clientSocket, opts) {
  const {
    firstPacket,
    proxyIps = [],
    sockets = null,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    logger = () => {},
  } = opts;

  let tcp = null;
  let closed = false;

  const closeAll = async (reason) => {
    if (closed) return;
    closed = true;
    logger('debug', `session close: ${reason}`);
    try { await tcp?.close?.(); } catch { /* already closed */ }
    try { clientSocket.close?.(); } catch { /* already closed */ }
  };

  // direct dial first; on failure, iterate configured fallback proxyips.
  // NOTE: a ProxyIP is a *fallback relay* used only when direct egress fails;
  // it is never advertised as a node address in subscriptions.
  const targets = [{ host: firstPacket.host, port: firstPacket.port }];
  for (const pi of proxyIps) {
    const [h, p] = pi.split(':');
    targets.push({ host: h, port: Number(p || 443) });
  }

  let lastErr = null;
  for (const t of targets) {
    try {
      tcp = sockets
        ? await sockets.connect(t)
        : await dialCf(t);
      await withTimeout(tcp.opened, connectTimeoutMs, 'CONNECT_TIMEOUT');
      logger('debug', `dialed ${t.host}:${t.port}`);
      break;
    } catch (e) {
      lastErr = e;
      try { await tcp?.close?.(); } catch { /* noop */ }
      tcp = null;
    }
  }
  if (!tcp) {
    logger('warn', `all dials failed: ${lastErr?.code || lastErr?.message || 'unknown'}`);
    // VLESS reply frame with answer=0x01 signals failure; then release everything.
    try { clientSocket.send(new Uint8Array([0x00, 0x01])); } catch { /* noop */ }
    await closeAll('dial-failed');
    return { ok: false, reason: lastErr?.code || 'DIAL_FAILED' };
  }

  const writer = tcp.writable.getWriter();
  const reader = tcp.readable.getReader();

  if (firstPacket.payload?.length) {
    try {
      await writer.write(firstPacket.payload);
    } catch (e) {
      await closeAll(`initial-write-failed: ${e.message}`);
      return { ok: false, reason: 'INITIAL_WRITE_FAILED' };
    }
  }

  // success frame back to client
  clientSocket.send(new Uint8Array([0x00, 0x00]));

  let pendingWrite = Promise.resolve();

  return await new Promise((resolve) => {
    let upstreamDone = false;
    let downstreamClosed = false;

    const finish = (result) => {
      Promise.allSettled([pendingWrite]).finally(async () => {
        await closeAll(result.ok ? result.reason : `error:${result.reason}`);
        resolve(result);
      });
    };

    // client -> TCP pump (event driven, no module state)
    clientSocket.addEventListener('message', (event) => {
      pendingWrite = pendingWrite
        .then(() => writer.write(event.data))
        .catch((e) => {
          downstreamClosed = true;
          logger('warn', `client->tcp write error: ${e.message}`);
          finish({ ok: false, reason: 'WRITE_FAILED' });
        });
    });

    clientSocket.addEventListener('close', () => {
      downstreamClosed = true;
      finish({ ok: true, reason: 'client-closed' });
    });

    clientSocket.addEventListener('error', () => {
      downstreamClosed = true;
      finish({ ok: false, reason: 'client-error' });
    });

    // TCP -> client pump with idle timeout
    (async () => {
      let idleTimer = null;
      try {
        while (true) {
          const readPromise = reader.read();
          idleTimer = setTimeout(
            () => finish({ ok: false, reason: 'IDLE_TIMEOUT' }),
            idleTimeoutMs,
          );
          const { done, value } = await readPromise;
          clearTimeout(idleTimer);
          idleTimer = null;
          if (downstreamClosed) return finish({ ok: true, reason: 'client-closed-during-read' });
          if (value?.length) clientSocket.send(value);
          if (done) return finish({ ok: true, reason: 'upstream-eof' });
        }
      } catch (e) {
        if (idleTimer) clearTimeout(idleTimer);
        finish({ ok: false, reason: e.code || 'UPSTREAM_ERROR' });
      }
    })();
  });
}

/**
 * Dial via the real cloudflare:sockets API. Kept behind dynamic import so that
 * unit tests can inject a fake `sockets` object instead.
 */
async function dialCf({ host, port }) {
  const { connect } = await import('cloudflare:sockets');
  return connect({ hostname: host, port });
}
