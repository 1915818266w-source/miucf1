/**
 * sub.mjs — subscription rendering.
 *
 * Output contract:
 *  - standard Base64 (RFC 4648) of newline-separated vless:// share links;
 *  - no prose, no branding, no comments: NekoBox parses every line;
 *  - only nodes built from the region data files (validated upstream) are emitted;
 *  - region filter via /sub/<token>?region=hk,jp  (comma separated, default all six).
 */

import { REGIONS } from './config.mjs';

/**
 * Row statuses produced by pipeline/update_data.py:
 *  - OK    : verified (trace colo) in the latest successful round -> publishable
 *  - STALE : retained from the last successful round after a probe-layer outage;
 *            last_checked still holds the ORIGINAL verification time. STALE rows
 *            stay in the data files for audit/retention but are NEVER published
 *            as fresh nodes (fail-closed: no unverified data in subscriptions).
 */
export const PUBLISHED_STATUS = 'OK';

/**
 * Build one vless share link.
 * @param {object} n node descriptor { address, port, region }
 * @param {object} c resolved config (uuid, wsPath, workerUrl)
 */
export function buildVlessLink(n, c) {
  const host = c.workerUrl ? new URL(c.workerUrl).hostname : 'WORKER_HOST_PLACEHOLDER';
  const tag = `CF-${n.region.toUpperCase()}-${n.address}`;
  const params = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: host,
    fp: 'random',
    type: 'ws',
    host,
    path: `${c.wsPath}`,
  });
  return `vless://${n.uuid}@${n.address}:${n.port ?? 443}?${params.toString()}#${encodeURIComponent(tag)}`;
}

/**
 * Render subscription body.
 * @param {object[]} nodes validated node descriptors
 * @param {object} c resolved config
 * @param {string[]} [regions] optional filter subset of REGIONS
 * @returns {string} base64 payload
 */
export function renderSubscription(nodes, c, regions) {
  const wanted = Array.isArray(regions) && regions.length
    ? REGIONS.filter((r) => regions.includes(r))
    : [...REGIONS];
  const links = nodes
    .filter((n) => wanted.includes(n.region) && n.uuid === c.uuid)
    .map((n) => buildVlessLink(n, c));
  const body = links.join('\n');
  // btoa for the ASCII-safe share links; chunk-free standard base64
  return btoa(body);
}

/**
 * Parse a region data file line into a node descriptor.
 * Line format (ours, pipeline-produced):
 *   address|region|source|first_seen|last_checked|status
 * Only status=OK lines may become nodes.
 */
export function parseDataLine(line, uuid) {
  const parts = line.split('|');
  if (parts.length !== 6) return null;
  const [address, region, source, firstSeen, lastChecked, status] = parts.map((p) => p.trim());
  // Explicit stale policy: only rows verified in the latest successful round may
  // become nodes. STALE (and anything else) is dropped here — never published.
  if (status !== PUBLISHED_STATUS) return null;
  if (!REGIONS.includes(region)) return null;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return null;
  return { uuid, address, port: 443, region, source, firstSeen, lastChecked, status };
}

/** Convert raw data-file text into validated nodes. Invalid lines are dropped, not guessed. */
export function nodesFromData(text, uuid) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => parseDataLine(l, uuid))
    .filter(Boolean);
}
