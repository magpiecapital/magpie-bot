/**
 * RPC health watcher — catches the failure mode that has no error.
 *
 * 2026-08-12 INCIDENT. Helius sat FROZEN at slot 438741410 for roughly an hour
 * — up to ~35 minutes behind mainnet — while:
 *   - `getHealth` returned 200 "ok"
 *   - `getSlot` and `getLatestBlockhash` returned 200 with STALE values
 *   - `getAccountInfo` / `getBalance` / `getVersion` returned HTTP 500
 *
 * Two separate problems, and the second is the dangerous one:
 *
 *   1. The 500s never triggered failover, because 500 was missing from the
 *      retryable pattern. Fixed in connection.js (isRetryableRpcError).
 *
 *   2. The frozen-but-200 responses produce NO ERROR AT ALL, so failover can
 *      never fire on them by construction. The bot will happily make lending
 *      decisions on half-hour-old balances, loan states and prices. A silent
 *      wrong answer is far more dangerous than a loud failure, and the existing
 *      helius-usage-watcher cannot see it — credits were completely fine.
 *
 * This watcher probes out-of-band and flips the flag that withFailover reads,
 * so the hot path pays ZERO extra RPC calls.
 *
 * DESIGN RULES, in priority order:
 *   1. NEVER take the bot down. Every failure path here fails OPEN — if the
 *      watcher itself breaks, the primary is used exactly as before.
 *   2. Compare against an INDEPENDENT provider. "Is the primary behind?" is
 *      unanswerable by asking only the primary; that is precisely how this
 *      went unnoticed.
 *   3. Require confirmation before flipping. One slow poll is not an outage.
 */
import "dotenv/config";
import { Connection } from "@solana/web3.js";
import {
  connection,
  backupConnections,
  markPrimaryDegraded,
  markPrimaryHealthy,
  isPrimaryDegraded,
} from "../solana/connection.js";
import { notifyAdmin } from "./admin-notify.js";

const POLL_MS = Number(process.env.RPC_HEALTH_POLL_MS) || 60_000;
/** Solana produces ~1 slot/400ms, so 150 slots ≈ 60s. Well beyond normal jitter. */
const MAX_LAG_SLOTS = Number(process.env.RPC_MAX_LAG_SLOTS) || 150;
/** Consecutive bad polls before we act — one slow response is not an outage. */
const STRIKES_TO_DEGRADE = Number(process.env.RPC_DEGRADE_STRIKES) || 2;
/** Consecutive good polls before we trust it again. */
const STRIKES_TO_RECOVER = Number(process.env.RPC_RECOVER_STRIKES) || 3;

let badStreak = 0;
let goodStreak = 0;
let alerted = false;
let timer = null;

/** Reference connection: an independent provider, never the primary. */
function referenceConn() {
  if (backupConnections.length > 0) return backupConnections[0];
  return new Connection("https://api.mainnet-beta.solana.com", "confirmed");
}

/**
 * One probe. Returns a verdict; never throws.
 * @returns {Promise<{ok: boolean, reason: string, lag: number|null}>}
 */
export async function probeOnce() {
  let primarySlot = null;
  let refSlot = null;
  try {
    // Deliberately sequential-independent: a primary failure must not mask the
    // reference read, and vice versa.
    const [p, r] = await Promise.allSettled([
      connection.getSlot("confirmed"),
      referenceConn().getSlot("confirmed"),
    ]);
    if (p.status === "fulfilled") primarySlot = p.value;
    if (r.status === "fulfilled") refSlot = r.value;

    // Primary refusing outright is a clear fault (the 500 case).
    if (primarySlot === null) {
      return { ok: false, reason: "primary getSlot failed", lag: null };
    }
    // No reference means we cannot judge — fail OPEN, assume healthy.
    if (refSlot === null) {
      return { ok: true, reason: "no reference available (assuming healthy)", lag: null };
    }

    const lag = refSlot - primarySlot;
    if (lag > MAX_LAG_SLOTS) {
      return { ok: false, reason: `primary is ${lag} slots behind (~${Math.round((lag * 0.4) / 60)} min)`, lag };
    }
    return { ok: true, reason: "healthy", lag };
  } catch (err) {
    // Watcher bug or transient — fail OPEN.
    return { ok: true, reason: `probe error, assuming healthy: ${err?.message?.slice(0, 80)}`, lag: null };
  }
}

async function tick(bot) {
  const v = await probeOnce();

  if (!v.ok) {
    goodStreak = 0;
    badStreak++;
    if (badStreak >= STRIKES_TO_DEGRADE && !isPrimaryDegraded()) {
      markPrimaryDegraded(v.reason);
      console.error(`[rpc-health] PRIMARY DEGRADED — ${v.reason}. Routing to backup.`);
      if (!alerted) {
        alerted = true;
        await notifyAdmin(
          bot,
          "🔴 *RPC primary degraded*\n\n" +
            `${v.reason}\n\n` +
            "Traffic is now routed to the backup RPC automatically. " +
            "This is the silent failure mode — the endpoint can return HTTP 200 with stale data, " +
            "so nothing else would have caught it.",
          { parse_mode: "Markdown" },
        ).catch(() => {});
      }
    }
    return;
  }

  badStreak = 0;
  goodStreak++;
  if (isPrimaryDegraded() && goodStreak >= STRIKES_TO_RECOVER) {
    markPrimaryHealthy();
    console.log(`[rpc-health] primary recovered (lag ${v.lag} slots). Routing restored.`);
    if (alerted) {
      alerted = false;
      await notifyAdmin(bot, "🟢 *RPC primary recovered* — routing restored to the primary provider.", {
        parse_mode: "Markdown",
      }).catch(() => {});
    }
  }
}

/** Start the watcher. Safe to call once at boot; never throws. */
export function startRpcHealthWatcher(bot) {
  if (timer) return;
  if (backupConnections.length === 0) {
    console.warn("[rpc-health] no backup RPC configured — watcher will alert but cannot reroute");
  }
  timer = setInterval(() => { tick(bot).catch(() => {}); }, POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
  tick(bot).catch(() => {}); // probe once at boot rather than waiting a full interval
  console.log(`[rpc-health] watching primary RPC (poll ${POLL_MS}ms, max lag ${MAX_LAG_SLOTS} slots)`);
}

export function stopRpcHealthWatcher() {
  if (timer) { clearInterval(timer); timer = null; }
}
