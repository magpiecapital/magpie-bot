/**
 * points-api.js — GET /api/v1/points?wallet=<pubkey>
 * Returns a user's lifetime points total + per-category breakdown + recent
 * point events, resolved wallet→user via the canonical resolver (same as
 * activity-api). Body ALWAYS includes `ok: true` so the dashboard's gate works
 * (the legacy /api/v1/activity omitting `ok` is exactly why points read 0).
 * Read-only; public (added to PUBLIC_ROUTES) like /api/v1/activity.
 */
import { query } from "../db/pool.js";

function isValidPubkey(s) {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

export async function handlePoints(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!isValidPubkey(wallet)) {
    return { status: 400, body: { ok: false, error: "Invalid wallet pubkey" } };
  }

  const { resolveWalletOwner } = await import("../services/wallet-owner-resolver.js");
  const userId = await resolveWalletOwner(wallet);
  if (!userId) {
    // Not linked yet — a real, honest zero (no user behind this wallet).
    return { status: 200, body: { ok: true, linked: false, total_points: 0, by_category: [], recent: [] } };
  }

  const [bal, byCat, recent] = await Promise.all([
    query(`SELECT total_points FROM user_points_balance WHERE user_id = $1`, [userId]),
    query(
      `SELECT category, SUM(points)::bigint AS points
         FROM points_events WHERE user_id = $1 GROUP BY category ORDER BY points DESC`,
      [userId],
    ),
    query(
      `SELECT source_type, category, points, created_at AS at, metadata
         FROM points_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [userId],
    ),
  ]);

  // Fast read from the counter; fall back to a live SUM if the counter row is
  // missing (e.g. mid-backfill) so the number is never falsely 0.
  let total = bal.rows[0]?.total_points;
  if (total == null) {
    const s = await query(`SELECT COALESCE(SUM(points), 0)::bigint AS t FROM points_events WHERE user_id = $1`, [userId]);
    total = s.rows[0]?.t ?? 0;
  }

  return {
    status: 200,
    body: {
      ok: true,
      linked: true,
      user_id: Number(userId),
      total_points: Number(total),
      by_category: byCat.rows.map((r) => ({ category: r.category, points: Number(r.points) })),
      recent: recent.rows.map((r) => ({
        source_type: r.source_type,
        category: r.category,
        points: Number(r.points),
        at: r.at,
        metadata: r.metadata,
      })),
    },
  };
}
