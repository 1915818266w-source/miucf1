/**
 * session.test.mjs — per-session bridge tests with a fake sockets API.
 * Covers: successful pump, client early disconnect, dial failure fallback to
 * proxyip list, connect timeout, and module-state isolation across sessions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runSession } from '../src/session.mjs';
import { parseFirstPacket, uuidToBytes, CMD_TCP, ATYP_IPV4 } from '../src/vless.mjs';

const UUID = 'a1b2c3d4-1111-2222-3333-444455556666';

/** Minimal fake WebSocket with addEventListener semantics (matches real WS API). */
function fakeWS() {
  const ws = new EventEmitter();
  ws.messages = [];
  ws.closed = false;
  ws.send = (d) => ws.messages.push(d);
  ws.close = () => { ws.closed = true; };
  ws.addEventListener = (type, fn) => ws.on(type, fn);
  ws.removeEventListener = (type, fn) => ws.off(type, fn);
  return ws;
}

function readableFrom(chunks) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
    }),
  };
}

function fullTcp({ opened = Promise.resolve(), chunks = [] } = {}) {
  return {
    opened,
    readable: readableFrom(chunks),
    writable: { getWriter: () => ({ write: async () => {}, close: async () => {} }) },
    close: async () => {},
  };
}

function makeSockets(dials) {
  // dials: array of either {throw:true} or {chunks:[...]} in call order
  let i = 0;
  return {
    connect: async ({ hostname, port }) => {
      const spec = dials[Math.min(i++, dials.length - 1)];
      if (spec?.throw) throw new Error('refused');
      return fullTcp({ chunks: spec?.chunks || [], opened: spec?.opened || Promise.resolve() });
    },
    calls: () => i,
  };
}

function firstPacket(port = 443, addr = [1, 2, 3, 4]) {
  const bytes = [
    0, ...uuidToBytes(UUID), 0, CMD_TCP, (port >> 8) & 0xff, port & 0xff, ATYP_IPV4, ...addr,
  ];
  return parseFirstPacket(new Uint8Array(bytes), UUID);
}

test('successful session pumps upstream data and closes cleanly', async () => {
  const ws = fakeWS();
  const sockets = makeSockets([{ chunks: [new Uint8Array([1, 2, 3])] }]);
  const result = await runSession(ws, { firstPacket: firstPacket(), sockets, proxyIps: [] });
  assert.equal(result.ok, true);
  // success frame + one data chunk
  assert.deepEqual([...ws.messages[0]], [0x00, 0x00]);
  assert.deepEqual([...ws.messages[1]], [1, 2, 3]);
  assert.equal(ws.closed, true);
});

test('client early disconnect ends session without error', async () => {
  const ws = fakeWS();
  const sockets = makeSockets([{ chunks: [] }]);
  const p = runSession(ws, { firstPacket: firstPacket(), sockets, proxyIps: [] });
  // simulate client closing immediately after handshake frame
  await Promise.resolve();
  ws.emit('close');
  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(ws.closed, true);
});

test('dial failure falls back to proxyIP list', async () => {
  const ws = fakeWS();
  const sockets = makeSockets([{ throw: true }, { chunks: [] }]);
  const result = await runSession(ws, {
    firstPacket: firstPacket(),
    sockets,
    proxyIps: ['fallback.example:2053'],
  });
  assert.equal(result.ok, true);
  assert.equal(sockets.calls(), 2);
});

test('all dials failing reports DIAL_FAILED and closes ws', async () => {
  const ws = fakeWS();
  const sockets = makeSockets([{ throw: true }, { throw: true }]);
  const result = await runSession(ws, {
    firstPacket: firstPacket(),
    sockets,
    proxyIps: ['fallback.example'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'DIAL_FAILED');
  assert.equal(ws.closed, true);
  // failure reply frame present
  assert.deepEqual([...ws.messages[0]], [0x00, 0x01]);
});

test('connect timeout surfaces CONNECT_TIMEOUT', async () => {
  const ws = fakeWS();
  const sockets = {
    connect: async () => fullTcp({ opened: new Promise(() => {}) }), // never opens
  };
  const result = await runSession(ws, {
    firstPacket: firstPacket(),
    sockets,
    connectTimeoutMs: 30,
    idleTimeoutMs: 5000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CONNECT_TIMEOUT');
});

test('concurrent sessions do not share state', async () => {
  const wsA = fakeWS();
  const wsB = fakeWS();
  const socketsA = makeSockets([{ chunks: [new Uint8Array([0xaa])] }]);
  const socketsB = makeSockets([{ chunks: [new Uint8Array([0xbb])] }]);
  const [ra, rb] = await Promise.all([
    runSession(wsA, { firstPacket: firstPacket(443, [10, 0, 0, 1]), sockets: socketsA }),
    runSession(wsB, { firstPacket: firstPacket(80, [10, 0, 0, 2]), sockets: socketsB }),
  ]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.deepEqual([...wsA.messages[1]], [0xaa]);
  assert.deepEqual([...wsB.messages[1]], [0xbb]);
});

test('idle timeout terminates stalled upstream', async () => {
  const ws = fakeWS();
  const sockets = {
    connect: async () => ({
      opened: Promise.resolve(),
      readable: { getReader: () => ({ read: () => new Promise(() => {}) }) },
      writable: { getWriter: () => ({ write: async () => {}, close: async () => {} }) },
      close: async () => {},
    }),
  };
  const result = await runSession(ws, {
    firstPacket: firstPacket(),
    sockets,
    connectTimeoutMs: 100,
    idleTimeoutMs: 30,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'IDLE_TIMEOUT');
});
