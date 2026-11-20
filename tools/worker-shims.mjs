/**
 * worker-shims.mjs — minimal Workers-runtime API emulation for Node.
 *
 * Only what src/index.mjs actually touches:
 *  - WebSocketPair() -> [client, server] in-memory pair (per-call, no shared state)
 *  - Response allowing status 101 + webSocket property (undici forbids 101)
 *
 * Deliberately per-instance state: every call returns fresh sockets, so the
 * "no module-level shared state" property of the worker is preserved here too.
 */

class ShimHeaders {
  constructor(init = {}) {
    this.map = new Map();
    if (init && typeof init.forEach === 'function') {
      init.forEach((v, k) => this.map.set(String(k).toLowerCase(), String(v)));
    } else if (typeof init === 'object') {
      for (const [k, v] of Object.entries(init)) this.map.set(String(k).toLowerCase(), String(v));
    }
  }
  get(k) { return this.map.get(String(k).toLowerCase()) ?? null; }
  has(k) { return this.map.has(String(k).toLowerCase()); }
  set(k, v) { this.map.set(String(k).toLowerCase(), String(v)); }
  *entries() { yield* this.map.entries(); }
  *[Symbol.iterator]() { yield* this.map.entries(); }
}

class ShimResponse {
  constructor(body, init = {}) {
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new ShimHeaders(init.headers || {});
    this.webSocket = init.webSocket ?? null;
    this._body = body;
  }
  async text() {
    if (this._body == null) return '';
    if (typeof this._body === 'string') return this._body;
    return new TextDecoder().decode(this._body);
  }
}

class ShimWebSocket {
  constructor() {
    this._other = null;
    this._listeners = Object.create(null);
    this._closed = false;
    this.accepted = false;
  }
  accept() {
    this.accepted = true;
    // test hook: let harnesses assert post-accept state (e.g. G-4 binaryType pin)
    globalThis.__shimLastAccepted = this;
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (l) this._listeners[type] = l.filter((f) => f !== fn);
  }
  send(data) {
    if (this._closed || !this._other || this._other._closed) return;
    const payload = data;
    queueMicrotask(() => {
      if (!this._closed && !this._other._closed) this._other._emit('message', { data: payload });
    });
  }
  close(code = 1000) {
    if (this._closed) return;
    this._closed = true;
    this._emit('close', { code });
    if (this._other && !this._other._closed) {
      this._other._closed = true;
      this._other._emit('close', { code });
    }
  }
  _emit(type, ev) {
    for (const fn of this._listeners[type] || []) {
      try { fn(ev); } catch (e) { console.error('shim ws listener error', e); }
    }
  }
}

function WebSocketPair() {
  const client = new ShimWebSocket();
  const server = new ShimWebSocket();
  client._other = server;
  server._other = client;
  return [client, server]; // index 0 = client side (returned to platform), 1 = server side (worker)
}

export function installShims() {
  globalThis.Response = ShimResponse;
  globalThis.WebSocketPair = WebSocketPair;
}
