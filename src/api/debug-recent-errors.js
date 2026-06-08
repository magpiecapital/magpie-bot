/**
 * GET /api/v1/debug/recent-errors?limit=50
 *
 * Returns the last N console.error / console.warn entries from the
 * bot's in-memory ring buffer. No PII — these are internal error
 * messages and warning lines.
 *
 * Public on purpose: lets the operator inspect failures from anywhere
 * without Railway access. The ring buffer is cleared on every
 * restart, so this is for live debugging only — not a long-term log.
 */
import { getRecentErrors } from "../lib/error-ring.js";

export async function handleDebugRecentErrors(req, url) {
  if (req.method !== "GET") return { status: 405, body: { error: "GET only" } };
  const limit = Number(url.searchParams.get("limit")) || 50;
  return {
    status: 200,
    body: {
      ok: true,
      count: 0, // filled below
      entries: getRecentErrors(limit),
    },
  };
}
