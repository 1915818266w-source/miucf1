/**
 * data.mjs — fetch + validate region data from the pipeline-produced files.
 *
 * The Worker never invents region data. It reads the repository-published files
 * (DATA_BASE_URL pointing at raw.githubusercontent.com of the fork) and serves
 * only status=OK entries. On fetch failure it returns the last cached copy
 * (per-region) so a data-source outage does not empty the subscription.
 */

const cache = new Map(); // region -> { text, fetchedAt } ; in-isolate cache only

/**
 * Fetch one region's data text with caching.
 * @returns {Promise<{text: string, fetchedAt: string, cached: boolean} | null>}
 */
export async function getRegionData(baseUrl, region, { fetchImpl = fetch } = {}) {
  const cached = cache.get(region);
  try {
    const res = await fetchImpl(`${baseUrl}/${region.toUpperCase()}.txt`, {
      cf: { cacheTtl: 300 }, // short edge cache is fine for hourly data
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    cache.set(region, { text, fetchedAt: new Date().toISOString() });
    return { text, fetchedAt: new Date().toISOString(), cached: false };
  } catch (e) {
    if (cached) return { text: cached.text, fetchedAt: cached.fetchedAt, cached: true };
    return null;
  }
}

/** Collect nodes for the requested regions; regions with no data are skipped (never faked). */
export async function collectNodes(baseUrl, uuid, regions, deps = {}) {
  const out = [];
  for (const r of regions) {
    const d = await getRegionData(baseUrl, r, deps);
    if (!d) continue;
    // dynamic import keeps unit tests able to stub sub.mjs trivially if needed
    const { nodesFromData } = await import('./sub.mjs');
    out.push(...nodesFromData(d.text, uuid).map((n) => ({ ...n, region: r })));
  }
  return out;
}

/** Test helper: clear the module cache. */
export function _clearCache() {
  cache.clear();
}
