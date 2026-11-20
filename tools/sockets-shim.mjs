/**
 * sockets-shim.mjs — local replacement for `cloudflare:sockets`.
 * Mapped in via module loader hook (tools/loader.mjs) so that src/session.mjs
 * can keep its real `import('cloudflare:sockets')` untouched.
 *
 * API parity with workerd: connect({hostname, port}) -> {opened, readable, writable, close}
 */
import net from 'node:net';
import { Readable, Writable } from 'node:stream';

export async function connect({ hostname, port }) {
  const sock = net.connect({ host: hostname, port });
  const opened = new Promise((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', (e) => reject(e));
  });
  // keep later socket errors non-fatal (session closes channels itself)
  sock.on('error', () => {});
  return {
    opened,
    readable: Readable.toWeb(sock),
    writable: Writable.toWeb(sock),
    close: () => new Promise((r) => sock.end(() => r())),
  };
}
