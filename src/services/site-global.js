/**
 * Global site kill-switch.
 *
 * When the site_global_state.disabled flag is TRUE, every signed
 * endpoint rejects with 503. This is the operator's "stop everything"
 * lever for critical incidents — different surface from per-user
 * /lock, which only protects one account.
 *
 * Cache the state in-process to avoid hitting the DB on every signed
 * action. Refreshed every CACHE_TTL_MS, AND immediately when an admin
 * flips the flag (via invalidateGlobalSiteCache).
 */
import { query } from "../db/pool.js";

const CACHE_TTL_MS = 30_000;
let cache = { disabled: false, reason: null, set_by: null, set_at: null };
let cachedAt = 0;

async function refresh() {
  try {
    const { rows: [row] } = await query(
      `SELECT disabled, reason, set_by, set_at
         FROM site_global_state WHERE id = 1`,
    );
    if (row) {
      cache = {
        disabled: !!row.disabled,
        reason: row.reason,
        set_by: row.set_by,
        set_at: row.set_at,
      };
    }
    cachedAt = Date.now();
  } catch (err) {
    console.warn("[site-global] refresh failed:", err.message);
  }
}

export async function getGlobalSiteState() {
  if (Date.now() - cachedAt > CACHE_TTL_MS) {
    await refresh();
  }
  return cache;
}

export function invalidateGlobalSiteCache() {
  cachedAt = 0;
}

/**
 * Convenience for API handlers: return a 503 response shape if the
 * site is globally disabled. Caller short-circuits.
 */
export async function rejectIfSiteDisabled() {
  const state = await getGlobalSiteState();
  if (!state.disabled) return null;
  return {
    status: 503,
    body: {
      error: "Site signed actions are temporarily disabled",
      detail: state.reason
        ? `Reason: ${state.reason}. Try again later or run /support in Telegram.`
        : "Operator-initiated maintenance. Try again later or run /support in Telegram.",
    },
  };
}

export async function setGlobalSiteDisabled({ disabled, reason, setBy }) {
  await query(
    `UPDATE site_global_state SET disabled = $1, reason = $2, set_by = $3, set_at = NOW() WHERE id = 1`,
    [disabled, reason || null, setBy || null],
  );
  invalidateGlobalSiteCache();
}
