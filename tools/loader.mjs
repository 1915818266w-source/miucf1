/**
 * loader.mjs — module resolve hook: map `cloudflare:sockets` to the local shim.
 * Lets the unmodified worker source run under plain Node for C-level tests.
 */
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:sockets') {
    return {
      shortCircuit: true,
      url: new URL('./sockets-shim.mjs', import.meta.url).href,
      format: 'module',
    };
  }
  return next(specifier, context);
}
