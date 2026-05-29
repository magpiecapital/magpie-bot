/**
 * In-memory heartbeat tracker for periodic services.
 *
 * Each service calls `markCycle(name)` after a successful cycle.
 * The /api/v1/health endpoint reads `getHeartbeats()` and decides if
 * the bot is healthy based on staleness thresholds.
 *
 * Reset on process restart — that's intentional. A fresh process is
 * "healthy until proven stale" and gets each service's max interval
 * to log its first cycle before the threshold trips.
 */

const startedAt = Date.now();
const lastCycle = new Map(); // name -> { ts, ok }

export function markCycle(name, ok = true) {
  lastCycle.set(name, { ts: Date.now(), ok });
}

export function getHeartbeats() {
  const now = Date.now();
  const entries = {};
  for (const [name, { ts, ok }] of lastCycle.entries()) {
    entries[name] = {
      lastCycleAt: new Date(ts).toISOString(),
      ageMs: now - ts,
      ok,
    };
  }
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: now - startedAt,
    services: entries,
  };
}

export function getStartedAt() {
  return startedAt;
}
