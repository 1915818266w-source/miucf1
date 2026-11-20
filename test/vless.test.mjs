/**
 * vless.test.mjs — protocol parser unit tests.
 * Covers the mandated cases: correct UUID, wrong UUID, IPv4, IPv6, domain,
 * illegal port, truncated first packet, early client disconnect (session level
 * disconnect is covered in session.test.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFirstPacket,
  uuidToBytes,
  uuidToString,
  buildReplyFrame,
  VlessError,
  ATYP_IPV4,
  ATYP_DOMAIN,
  ATYP_IPV6,
  CMD_TCP,
} from '../src/vless.mjs';

const UUID = 'a1b2c3d4-1111-2222-3333-444455556666';
const uuidRaw = uuidToBytes(UUID);

/** Assemble a first packet. */
function pack({ version = 0, uuid = uuidRaw, opt = [], cmd = CMD_TCP, port, atyp, addr, payload = [] }) {
  const bytes = [version, ...uuid, opt.length, ...opt, cmd, (port >> 8) & 0xff, port & 0xff, atyp, ...addr];
  return new Uint8Array([...bytes, ...payload]);
}

test('correct UUID + IPv4 + payload parses', () => {
  const pkt = pack({ port: 443, atyp: ATYP_IPV4, addr: [1, 2, 3, 4], payload: [0x16, 0x03, 0x01] });
  const r = parseFirstPacket(pkt, UUID);
  assert.equal(r.host, '1.2.3.4');
  assert.equal(r.port, 443);
  assert.equal(r.command, CMD_TCP);
  assert.deepEqual([...r.payload], [0x16, 0x03, 0x01]);
  assert.equal(r.uuid, UUID);
});

test('wrong UUID is rejected with AUTH_FAIL', () => {
  const pkt = pack({ port: 80, atyp: ATYP_IPV4, addr: [127, 0, 0, 1] });
  assert.throws(() => parseFirstPacket(pkt, 'ffffffff-1111-2222-3333-444455556666'), (e) => {
    assert.ok(e instanceof VlessError);
    assert.equal(e.code, 'AUTH_FAIL');
    return true;
  });
});

test('IPv6 target parses to bracketed compressed form', () => {
  // 2606:4700::1111
  const addr = [0x26, 0x06, 0x47, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11];
  const pkt = pack({ port: 80, atyp: ATYP_IPV6, addr });
  const r = parseFirstPacket(pkt, UUID);
  assert.equal(r.atyp, ATYP_IPV6);
  assert.equal(r.host, '[2606:4700:0:0:0:0:0:1111]');
});

test('domain target parses', () => {
  const name = 'example.com';
  const addr = [name.length, ...new TextEncoder().encode(name)];
  const pkt = pack({ port: 8443, atyp: ATYP_DOMAIN, addr });
  const r = parseFirstPacket(pkt, UUID);
  assert.equal(r.atyp, ATYP_DOMAIN);
  assert.equal(r.host, 'example.com');
  assert.equal(r.port, 8443);
});

test('illegal port 0 rejected', () => {
  const pkt = pack({ port: 0, atyp: ATYP_IPV4, addr: [1, 1, 1, 1] });
  assert.throws(() => parseFirstPacket(pkt, UUID), (e) => e.code === 'BAD_PORT');
});

test('port 65535 boundary accepted', () => {
  const pkt = pack({ port: 65535, atyp: ATYP_IPV4, addr: [1, 1, 1, 1] });
  const r = parseFirstPacket(pkt, UUID);
  assert.equal(r.port, 65535);
});

test('truncated packets rejected with TRUNCATED', () => {
  const good = pack({ port: 443, atyp: ATYP_IPV4, addr: [1, 2, 3, 4] });
  // progressively cut the tail
  for (const cut of [24, 20, 18, 10]) {
    assert.throws(() => parseFirstPacket(good.slice(0, cut), UUID), (e) => {
      return e.code === 'TRUNCATED' || e.code === 'BAD_COMMAND' || e.code === 'BAD_ADDRESS_TYPE';
    }, `cut=${cut}`);
  }
  // domain truncated mid-name
  const dom = pack({ port: 80, atyp: ATYP_DOMAIN, addr: [11, ...new TextEncoder().encode('example.com')] });
  assert.throws(() => parseFirstPacket(dom.slice(0, dom.length - 3), UUID), (e) => e.code === 'TRUNCATED');
});

test('bad version byte rejected', () => {
  const pkt = pack({ version: 1, port: 443, atyp: ATYP_IPV4, addr: [1, 2, 3, 4] });
  assert.throws(() => parseFirstPacket(pkt, UUID), (e) => e.code === 'BAD_VERSION');
});

test('unknown address type rejected', () => {
  const pkt = pack({ port: 443, atyp: 0x09, addr: [1, 2, 3, 4] });
  assert.throws(() => parseFirstPacket(pkt, UUID), (e) => e.code === 'BAD_ADDRESS_TYPE');
});

test('non-TCP/UDP command (MUX) rejected', () => {
  const pkt = pack({ cmd: 0x03, port: 443, atyp: ATYP_IPV4, addr: [1, 2, 3, 4] });
  assert.throws(() => parseFirstPacket(pkt, UUID), (e) => e.code === 'BAD_COMMAND');
});

test('uuid roundtrip and malformed text', () => {
  assert.equal(uuidToString(uuidRaw), UUID);
  assert.throws(() => uuidToBytes('not-a-uuid'), (e) => e.code === 'UUID_FORMAT');
});

test('reply frame shape', () => {
  assert.deepEqual([...buildReplyFrame(0x00)], [0x00, 0x00]);
  assert.deepEqual([...buildReplyFrame(0x01)], [0x00, 0x01]);
});
