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

const DEBUG_TOKEN = process.env.DEBUG_ERRORS_TOKEN || "";

export async function handleDebugRecentErrors(req, url) {
  if (req.method !== "GET") return { status: 405, body: { error: "GET only" } };

  // Auth: requires DEBUG_ERRORS_TOKEN (set on Railway, known only to
  // the operator). Without this, anyone could curl recent errors and
  // harvest wallet pubkeys, loan PDAs, internal state, and error
  // contexts that leak operational signal. Fail-closed: if the env
  // var isn't set, the endpoint refuses all requests.
  if (!DEBUG_TOKEN) {
    return { status: 503, body: { error: "Debug endpoint not configured" } };
  }
  const presented = (req.headers["x-debug-token"] || req.headers["authorization"] || "")
    .toString()
    .replace(/^Bearer\s+/i, "");
  if (presented !== DEBUG_TOKEN) {
    // Same generic 401 the API-key path uses — don't leak that the
    // endpoint exists or that it's checking a different header.
    return { status: 401, body: { error: "Invalid or missing API key" } };
  }

  const limit = Number(url.searchParams.get("limit")) || 50;
  return {
    status: 200,
    body: {
      ok: true,
      count: 0,
      entries: getRecentErrors(limit),
    },
  };
}
