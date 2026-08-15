/**
 * GET /api/v1/collectibles/tokenized[?slug=<catalog-slug>]
 *
 * Live counts of partner-vaulted tokenized collectibles, grouped by public
 * catalog slug and platform, fed by the inventory indexer's ongoing sweeps
 * (collectible-inventory-indexer.js). No slug → the full per-slug summary.
 * Public, cache-friendly: the site's asset pages render "N tokenized on
 * <platform> right now" from this.
 */
import { query } from "../db/pool.js";

let _cache = { at: 0, body: null };
const TTL_MS = 5 * 60 * 1000;

export async function handleTokenizedInventory(url) {
  const slug = url.searchParams.get("slug");
  if (!_cache.body || Date.now() - _cache.at > TTL_MS) {
    const { rows } = await query(
      `SELECT catalog_slug, platform, COUNT(*)::int AS count, MAX(last_seen_at) AS last_seen
         FROM collectible_tokenized_inventory
        WHERE catalog_slug IS NOT NULL
        GROUP BY catalog_slug, platform`,
    ).catch(() => ({ rows: [] }));
    const bySlug = {};
    for (const r of rows) {
      (bySlug[r.catalog_slug] ??= []).push({
        platform: r.platform,
        count: r.count,
        last_seen: r.last_seen,
      });
    }
    _cache = { at: Date.now(), body: bySlug };
  }
  if (slug) {
    return { ok: true, slug, platforms: _cache.body[slug] ?? [] };
  }
  return { ok: true, inventory: _cache.body };
}
