/**
 * DB-backed runtime config reader with TTL cache + hardcoded fallback.
 *
 * Why: several economic parameters (holder_reward_bps, lp_loyalty_reward_bps,
 * etc.) need to flip the moment a governance proposal ratifies — not
 * "when the operator next merges a PR to bump the const". The
 * governance autopilot already writes new values to `governance_config`;
 * this module is the runtime reader so every consumer picks up the new
 * value within `CACHE_TTL_MS` of the autopilot's UPDATE.
 *
 * Properties:
 *   - Per-key TTL cache (default 60s) to keep hot paths fast.
 *   - Fallback to a caller-supplied constant on DB miss or error.
 *     This is critical — runtime config MUST NOT take down the bot
 *     when the DB is unreachable.
 *   - Parses the JSONB column into a Number for bps-style integer
 *     fields. Callers that want raw JSON should use getRuntimeConfigRaw.
 *   - invalidateRuntimeConfig() lets the governance pipeline force a
 *     cache flush right after it writes new values, so the new value
 *     is visible without waiting for TTL expiry.
 */
import { query } from "../db/pool.js";

const CACHE_TTL_MS = Number(process.env.RUNTIME_CONFIG_CACHE_TTL_MS) || 60_000;

const cache = new Map(); // key → { value, expiresAt }

/**
 * Read a config key as a number (bps integer typical). Returns
 * fallback on DB error, missing key, or unparseable value.
 */
export async function getRuntimeConfigBps(key, fallback) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  try {
    const { rows } = await query(
      `SELECT config_value FROM governance_config WHERE config_key = $1`,
      [key],
    );
    if (rows.length === 0) {
      // Cache the fallback briefly so we don't slam the DB if the key
      // is genuinely unset.
      cache.set(key, { value: fallback, expiresAt: now + 5_000 });
      return fallback;
    }
    const raw = rows[0].config_value;
    // config_value is JSONB. Numbers come back as either a JS number
    // or a JSON-stringified number; handle both.
    let parsed;
    if (typeof raw === "number") parsed = raw;
    else if (typeof raw === "string") parsed = Number(raw);
    else if (raw === null || raw === undefined) parsed = NaN;
    else parsed = Number(raw); // last-ditch
    if (!Number.isFinite(parsed)) {
      cache.set(key, { value: fallback, expiresAt: now + 5_000 });
      return fallback;
    }
    cache.set(key, { value: parsed, expiresAt: now + CACHE_TTL_MS });
    return parsed;
  } catch (err) {
    console.warn(`[runtime-config] read failed for ${key}, using fallback:`, err.message);
    return fallback;
  }
}

/**
 * Flush the cache (specific key or all). The governance pipeline calls
 * this with the keys it just wrote so consumers see the new value
 * immediately rather than waiting up to CACHE_TTL_MS.
 */
export function invalidateRuntimeConfig(key = null) {
  if (key === null) cache.clear();
  else cache.delete(key);
}
