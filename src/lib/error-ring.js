/**
 * In-memory ring buffer of recent error/warn console output.
 *
 * Intercepts console.error and console.warn so the last N entries can
 * be served via GET /api/v1/debug/recent-errors. Lets the operator (or
 * Claude, during remote debugging) inspect what's been failing without
 * needing Railway log access.
 *
 * Safety: the buffer is in-memory only (cleared on restart), bounded to
 * RING_SIZE entries, and each entry is truncated to MAX_LEN chars.
 * Originals are preserved so Railway still receives the full output.
 */
const RING_SIZE = 200;
const MAX_LEN = 2000;

const ring = [];
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);

function record(level, args) {
  try {
    const text = args
      .map((a) => (typeof a === "string" ? a : (() => {
        try { return JSON.stringify(a, Object.getOwnPropertyNames(a ?? {})); }
        catch { return String(a); }
      })()))
      .join(" ")
      .slice(0, MAX_LEN);
    ring.push({ ts: new Date().toISOString(), level, text });
    while (ring.length > RING_SIZE) ring.shift();
  } catch {
    /* never throw from a logger wrapper */
  }
}

console.error = (...args) => { record("error", args); origError(...args); };
console.warn = (...args) => { record("warn", args); origWarn(...args); };

export function getRecentErrors(limit = 50) {
  return ring.slice(-Math.max(1, Math.min(limit, RING_SIZE)));
}
