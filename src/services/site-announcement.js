/**
 * Site-wide announcement banner.
 *
 * Soft non-blocking notice the operator can post to the dashboard:
 * "Scheduled maintenance Sat 10am UTC", "Auto-Protect distribution
 * pending", etc. Different from /sitedisable (which is hard-halt).
 *
 * Cached in-process; invalidated on every set/clear so the dashboard
 * sees changes quickly. The optional expires_at lets the operator
 * post a self-expiring banner without remembering to clear it.
 */
import { query } from "../db/pool.js";

const CACHE_TTL_MS = 30_000;
const VALID_SEVERITIES = new Set(["info", "warning", "critical"]);

let cache = { message: null, severity: "info", set_by: null, set_at: null, expires_at: null };
let cachedAt = 0;

async function refresh() {
  try {
    const { rows: [row] } = await query(
      `SELECT message, severity, set_by, set_at, expires_at
         FROM site_announcement WHERE id = 1`,
    );
    if (row) cache = row;
    cachedAt = Date.now();
  } catch (err) {
    console.warn("[site-announcement] refresh failed:", err.message);
  }
}

export function invalidateAnnouncementCache() {
  cachedAt = 0;
}

export async function getAnnouncement() {
  if (Date.now() - cachedAt > CACHE_TTL_MS) {
    await refresh();
  }
  // Auto-hide expired announcements without requiring a DB write.
  if (cache.expires_at && new Date(cache.expires_at) <= new Date()) {
    return { message: null, severity: "info", set_by: null, set_at: null, expires_at: null };
  }
  return cache;
}

export async function setAnnouncement({ message, severity, setBy, expiresAt }) {
  const sev = VALID_SEVERITIES.has(severity) ? severity : "info";
  await query(
    `UPDATE site_announcement
       SET message = $1, severity = $2, set_by = $3, set_at = NOW(), expires_at = $4
       WHERE id = 1`,
    [message || null, sev, setBy || null, expiresAt || null],
  );
  invalidateAnnouncementCache();
}

export async function clearAnnouncement({ setBy } = {}) {
  await query(
    `UPDATE site_announcement
       SET message = NULL, severity = 'info', set_by = $1, set_at = NOW(), expires_at = NULL
       WHERE id = 1`,
    [setBy || null],
  );
  invalidateAnnouncementCache();
}
