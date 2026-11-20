/**
 * vless.mjs — VLESS protocol first-packet parser (clean-room implementation).
 *
 * Reference for the wire format: public VLESS protocol description
 * (https://www.v2fly.org/developer/protocols/vless.html).
 *
 * First packet layout (client -> server, command CMD=0x01/0x02 TCP/MUX, here only 0x01/0x02 accepted):
 *   [0]      version   (must be 0x00)
 *   [1..17]  16 bytes  UUID (raw, big-endian standard RFC-4122 layout)
 *   [17]     1 byte    additional-info length N
 *   [18..18+N-1]       additional info bytes (skipped; may carry flow id in XTLS)
 *   [18+N]   1 byte    command (0x01 TCP, 0x02 UDP, 0x03 MUX)
 *   [19+N..] 2 bytes   destination port, big-endian
 *   [21+N]   1 byte    address type: 0x01 IPv4, 0x02 domain, 0x03 IPv6
 *   ...                address (4 bytes / 1+lena bytes / 16 bytes)
 *   ...                remainder = initial payload to forward to destination
 */

export const VLESS_VERSION = 0x00;
export const CMD_TCP = 0x01;
export const CMD_UDP = 0x02;
export const CMD_MUX = 0x03;
export const ATYP_IPV4 = 0x01;
export const ATYP_DOMAIN = 0x02;
export const ATYP_IPV6 = 0x03;

export class VlessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VlessError';
    this.code = code; // machine-readable reason for logs/metrics
  }
}

/** Format 16 raw bytes into canonical lowercase UUID string. */
export function uuidToString(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
    throw new VlessError('UUID_FORMAT', 'uuid must be 16 bytes');
  }
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Parse a textual UUID into 16 raw bytes; throws on malformed input. */
export function uuidToBytes(text) {
  const m = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.exec(
    String(text || ''),
  );
  if (!m) throw new VlessError('UUID_FORMAT', 'malformed uuid text');
  const hex = m[0].replace(/-/g, '').toLowerCase();
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time-ish byte comparison (no early return on mismatch). */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Parse and authenticate the first WebSocket binary message.
 * Returns a plain descriptor object; throws VlessError on any violation.
 *
 * @param {ArrayBuffer|Uint8Array} data raw first packet
 * @param {string} expectedUuid canonical uuid string configured for this deployment
 */
export function parseFirstPacket(data, expectedUuid) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (buf.length < 25) {
    // absolute minimum: ver(1)+uuid(16)+optlen(1)+cmd(1)+port(2)+atyp(1)+ipv4(4) = 26
    // we allow 25 as a strict lower bound check; deeper checks below still apply
    throw new VlessError('TRUNCATED', 'packet shorter than minimum header');
  }
  if (buf[0] !== VLESS_VERSION) {
    throw new VlessError('BAD_VERSION', `unsupported protocol version 0x${buf[0].toString(16)}`);
  }

  const uuidBytes = buf.slice(1, 17);
  if (!bytesEqual(uuidBytes, uuidToBytes(expectedUuid))) {
    throw new VlessError('AUTH_FAIL', 'uuid mismatch');
  }

  const optLen = buf[17];
  const cmdIdx = 18 + optLen;
  if (cmdIdx >= buf.length) throw new VlessError('TRUNCATED', 'missing command byte');

  const command = buf[cmdIdx];
  if (command !== CMD_TCP && command !== CMD_UDP) {
    throw new VlessError('BAD_COMMAND', `unsupported command 0x${command.toString(16)}`);
  }

  if (cmdIdx + 2 >= buf.length) throw new VlessError('TRUNCATED', 'missing port bytes');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const port = dv.getUint16(cmdIdx + 1); // big-endian by default
  if (port === 0) throw new VlessError('BAD_PORT', 'port 0 is not a valid destination');

  const atypIdx = cmdIdx + 3;
  if (atypIdx >= buf.length) throw new VlessError('TRUNCATED', 'missing address type');
  const atyp = buf[atypIdx];
  let cursor = atypIdx + 1;
  let host;

  switch (atyp) {
    case ATYP_IPV4: {
      if (cursor + 4 > buf.length) throw new VlessError('TRUNCATED', 'truncated ipv4 address');
      host = buf.slice(cursor, cursor + 4).join('.');
      cursor += 4;
      break;
    }
    case ATYP_DOMAIN: {
      if (cursor >= buf.length) throw new VlessError('TRUNCATED', 'missing domain length');
      const len = buf[cursor];
      cursor += 1;
      if (len === 0) throw new VlessError('BAD_ADDRESS', 'empty domain');
      if (cursor + len > buf.length) throw new VlessError('TRUNCATED', 'truncated domain');
      host = new TextDecoder().decode(buf.slice(cursor, cursor + len));
      if (!/^[a-zA-Z0-9._-]+$/.test(host)) throw new VlessError('BAD_ADDRESS', 'illegal domain chars');
      cursor += len;
      break;
    }
    case ATYP_IPV6: {
      if (cursor + 16 > buf.length) throw new VlessError('TRUNCATED', 'truncated ipv6 address');
      const parts = [];
      const dv6 = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i < 8; i++) parts.push(dv6.getUint16(cursor + i * 2).toString(16));
      host = `[${parts.join(':')}]`;
      cursor += 16;
      break;
    }
    default:
      throw new VlessError('BAD_ADDRESS_TYPE', `unknown address type 0x${atyp.toString(16)}`);
  }

  const payload = buf.slice(cursor);
  return { command, port, host, atyp, payload, uuid: uuidToString(uuidBytes) };
}

/** Build the server's first reply frame: version + answer byte. 0x00 = success. */
export function buildReplyFrame(answer = 0x00) {
  return new Uint8Array([VLESS_VERSION, answer]);
}
