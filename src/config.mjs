/**
 * config.mjs — deployment configuration resolution.
 *
 * Security requirements implemented here:
 *  - no public default UUID: if UUID secret is missing, the worker must fail closed;
 *  - WebSocket path is fixed and secret-derived; requests on other paths are rejected;
 *  - subscription path carries its own credential token.
 *
 * Values come from Cloudflare Workers environment bindings (vars / secrets).
 * Nothing here is hard-coded to any individual; fresh deployments generate fresh secrets.
 */

export const REGIONS = /** @type {const} */ (['hk', 'jp', 'sg', 'us', 'de', 'nl']);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireString(env, key, { min = 1 } = {}) {
  const v = env?.[key];
  if (typeof v !== 'string' || v.trim().length < min) {
    throw new ConfigError(`missing or empty required env binding: ${key}`);
  }
  return v.trim();
}

/**
 * Build runtime config from the env object passed to `fetch`.
 * Throws (fail closed) when mandatory secrets are absent.
 */
export function resolveConfig(env) {
  const uuid = requireString(env, 'VLESS_UUID');
  // structural validation without importing protocol module (keeps this file standalone)
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid)
  ) {
    throw new ConfigError('VLESS_UUID is not a valid canonical UUID');
  }

  const wsPath = requireString(env, 'WS_PATH', { min: 8 });
  if (!wsPath.startsWith('/') || wsPath.endsWith('/') || wsPath.includes('?')) {
    throw new ConfigError('WS_PATH must look like /<secret-segment>');
  }

  const subToken = requireString(env, 'SUB_TOKEN', { min: 16 });
  const subPath = `/sub/${subToken}`;

  // optional: comma-separated allowlist of proxyip hostnames for fallback dialing
  const proxyIps = typeof env.PROXY_IPS === 'string' && env.PROXY_IPS.trim()
    ? env.PROXY_IPS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const dataBaseUrl = requireString(env, 'DATA_BASE_URL').replace(/\/+$/, '');

  const connectTimeoutMs = Number(env.CONNECT_TIMEOUT_MS || 10000);
  const idleTimeoutMs = Number(env.IDLE_TIMEOUT_MS || 120000);

  return {
    uuid,
    wsPath,
    subPath,
    subToken,
    proxyIps,
    dataBaseUrl,
    connectTimeoutMs,
    idleTimeoutMs,
    workerUrl: typeof env.WORKER_URL === 'string' ? env.WORKER_URL.replace(/\/+$/, '') : '',
  };
}

/** Mask a uuid for safe logs: keep first segment only. */
export function maskUuid(uuid) {
  return `${String(uuid).split('-')[0]}-****`;
}
