/**
 * config-sub.test.mjs — configuration fail-closed and subscription format tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig, REGIONS, maskUuid, ConfigError } from '../src/config.mjs';
import { renderSubscription, nodesFromData, parseDataLine } from '../src/sub.mjs';

const GOOD_ENV = {
  VLESS_UUID: 'a1b2c3d4-1111-2222-3333-444455556666',
  WS_PATH: '/tls-tunnel-x7k9',
  SUB_TOKEN: 's3cr3t-token-abc123',
  DATA_BASE_URL: 'https://example.com/data/',
  WORKER_URL: 'https://my-worker.test.workers.dev',
  PROXY_IPS: 'fallback1.example:2053, fallback2.example',
};

const baseCfg = resolveConfig(GOOD_ENV);

test('resolveConfig accepts a complete env', () => {
  assert.equal(baseCfg.wsPath, '/tls-tunnel-x7k9');
  assert.equal(baseCfg.subPath, '/sub/s3cr3t-token-abc123');
  assert.deepEqual(baseCfg.proxyIps, ['fallback1.example:2053', 'fallback2.example']);
  assert.equal(baseCfg.dataBaseUrl, 'https://example.com/data');
});

test('fail closed: missing UUID / bad UUID / short WS path / weak SUB_TOKEN', () => {
  const cases = [
    ['VLESS_UUID', undefined],
    ['VLESS_UUID', 'not-a-uuid'],
    ['WS_PATH', '/x'], // too short (<8 incl slash => min 8 chars)
    ['SUB_TOKEN', 'short'],
    ['DATA_BASE_URL', undefined],
  ];
  for (const [key, val] of cases) {
    const env = { ...GOOD_ENV, [key]: val };
    assert.throws(() => resolveConfig(env), ConfigError, `key=${key}`);
  }
});

test('maskUuid never leaks full value', () => {
  const m = maskUuid(GOOD_ENV.VLESS_UUID);
  assert.ok(!m.includes('6666'));
  assert.match(m, /^a1b2c3d4-/);
});

const NODE_TEXT = [
  '# region data (generated; header lines are ignored)',
  'meta_updated=2026-11-20T01:00:00Z',
  '1.2.3.4|jp|probe|2026-11-19|2026-11-20|OK',
  '5.6.7.8|de|probe|2026-11-19|2026-11-20|OK',
  '9.9.9.9|jp|probe|2026-11-19|2026-11-20|STALE',
  'bad-line-no-pipes',
  '2606:4700::1|us|probe|2026-11-19|2026-11-20|OK', // ipv6 not accepted as node address (workers.dev client compat: ipv4 only for now)
].join('\n');

test('parseDataLine keeps only OK + known region + ipv4', () => {
  const ok = parseDataLine('1.2.3.4|jp|probe|2026-11-19|2026-11-20|OK', 'u');
  assert.ok(ok);
  assert.equal(ok.region, 'jp');
  assert.equal(parseDataLine('9.9.9.9|jp|s|d|d|STALE', 'u'), null);
  assert.equal(parseDataLine('bad-line-no-pipes', 'u'), null);
  assert.equal(parseDataLine('2606:4700::1|us|s|d|d|OK', 'u'), null);
});

test('nodesFromData drops invalid lines silently but keeps audit trail fields', () => {
  const nodes = nodesFromData(NODE_TEXT, 'u');
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes.map((n) => n.address), ['1.2.3.4', '5.6.7.8']);
  assert.equal(nodes[0].lastChecked, '2026-11-20');
});

test('subscription renders strict base64 of vless links only', () => {
  const uuid = baseCfg.uuid;
  const nodes = nodesFromData(NODE_TEXT, uuid);
  const b64 = renderSubscription(nodes, baseCfg);
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  const lines = decoded.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.match(l, /^vless:\/\/a1b2c3d4-1111-2222-3333-444455556666@/);
    assert.match(l, /security=tls/);
    assert.match(l, /type=ws/);
    assert.match(l, /path=%2Ftls-tunnel-x7k9/);
    assert.match(l, /#CF-(JP|DE)-/);
  }
  // no prose anywhere
  assert.ok(!decoded.includes('部署成功'));
  assert.ok(!decoded.includes('UUID:'));
});

test('region filter returns only requested regions', () => {
  const uuid = baseCfg.uuid;
  const nodes = nodesFromData(NODE_TEXT, uuid);
  const onlyDe = Buffer.from(renderSubscription(nodes, baseCfg, ['de']), 'base64').toString('utf8');
  assert.match(onlyDe, /5\.6\.7\.8/);
  assert.ok(!onlyDe.includes('1.2.3.4'));
  // unknown region requested -> empty subscription (no fabrication)
  const none = Buffer.from(renderSubscription(nodes, baseCfg, ['hk']), 'base64').toString('utf8');
  assert.equal(none.trim(), '');
});

test('STALE rows are retained in data files but never published (G-2 policy)', () => {
  const uuid = baseCfg.uuid;
  const mixed = [
    '1.2.3.4|us|probe|2026-11-18|2026-11-20|OK',
    '5.6.7.8|us|probe|2026-11-18|2026-11-19|STALE',   // outage round: unverified
    '9.9.9.9|de|probe|2026-11-18|2026-11-19|STALE',
    '7.7.7.7|de|probe|2026-11-18|2026-11-20|OK',
  ].join('\n');
  const nodes = nodesFromData(mixed, uuid);
  // only the two OK rows survive; STALE rows are dropped even though present
  assert.deepEqual(nodes.map((n) => n.address), ['1.2.3.4', '7.7.7.7']);
  const sub = Buffer.from(renderSubscription(nodes, baseCfg), 'base64').toString('utf8');
  assert.ok(!sub.includes('5.6.7.8') && !sub.includes('9.9.9.9'));
  assert.ok(sub.includes('1.2.3.4') && sub.includes('7.7.7.7'));
});

test('REGIONS is exactly the six mandated regions', () => {
  assert.deepEqual([...REGIONS], ['hk', 'jp', 'sg', 'us', 'de', 'nl']);
});
