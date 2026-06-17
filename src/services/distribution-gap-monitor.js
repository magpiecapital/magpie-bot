/**
 * Distribution-wallet gap monitor.
 *
 * Operator-mandated 2026-06-17
 * (feedback_distribution_wallet_must_be_auto_funded.md).
 *
 * THE PROBLEM
 * ───────────
 * The magpie-holder-rewards distributor checks at distribution time:
 *
 *     if (distributorBalance < pool + MIN_LENDER_RESERVE_LAMPORTS) {
 *       console.warn("Distribution skipped: distributor balance too low");
 *       return null;
 *     }
 *
 * That warning lands in Railway logs only. The operator has no
 * proactive signal that the next snapshot will silently skip. By the
 * time the user-visible failure mode shows (no distributions arrived),
 * trust is already eroded.
 *
 * WHAT THIS DOES
 * ──────────────
 * Every DIST_GAP_MONITOR_INTERVAL_MS (default 10 minutes):
 *   1. Read magpie_holder_pool.accrued_lamports + lp_loyalty_pool +
 *      protocol_reserve_pool. Sum = total notional owed.
 *   2. Read distribution wallet's on-chain SOL balance.
 *   3. Compute gap = (total_owed + reserve_floor) - distributor_balance.
 *   4. If gap > 0 (distributor underfunded):
 *      - log a Railway warning with full breakdown
 *      - DM operator (throttled 1/hour) with the exact deficit and
 *        sweeper status (last successful sweep time, any pending row)
 *      - level WARN if deficit < 1 SOL, ALERT if 1-5 SOL, P0 if >5 SOL
 *
 * The whole point: the operator finds out about a shortfall HOURS
 * before the snapshot fires, not after holders notice they didn't
 * receive distribution.
 *
 * Pause: DIST_GAP_MONITOR_DISABLED=true halts the watcher.
 *
 * Mandated by [[feedback_distribution_wallet_must_be_auto_funded]].
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";

const INTERVAL_MS = Number(
  process.env.DIST_GAP_MONITOR_INTERVAL_MS || 10 * 60 * 1000, // 10 min
);
const RPC_URL = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const DISTRIBUTION_WALLET_PUBKEY =
  process.env.REWARDS_DISTRIBUTOR_PUBKEY || "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac";
const SAFETY_RESERVE_LAMPORTS = 100_000_000n; // 0.1 SOL — matches MIN_LENDER_RESERVE_LAMPORTS in magpie-holder-rewards.js

const ALERT_THROTTLE_MS = 60 * 60 * 1000; // 1h per level
let _lastAlert = { warn: 0, alert: 0, p0: 0 };
let _timer = null;

export function startDistributionGapMonitor(bot) {
  if (_timer) return;
  if (/^(1|true|yes|on)$/i.test(process.env.DIST_GAP_MONITOR_DISABLED || "")) {
    console.log("[dist-gap] DISABLED via DIST_GAP_MONITOR_DISABLED env var");
    return;
  }
  // First run after 3 min so the boot storm settles.
  setTimeout(() => {
    runOnce(bot).catch((e) =>
      console.warn(`[dist-gap] first run failed: ${e.message?.slice(0, 160)}`),
    );
    _timer = setInterval(() => {
      runOnce(bot).catch((e) =>
        console.warn(`[dist-gap] tick failed: ${e.message?.slice(0, 160)}`),
      );
    }, INTERVAL_MS);
  }, 180_000);
  console.log(`[dist-gap] armed — first run in 3 min, then every ${INTERVAL_MS / 60_000} min`);
}

async function runOnce(bot) {
  // 1. Read DB notional totals.
  const { rows: holderRows } = await query(
    `SELECT COALESCE(accrued_lamports, 0)::numeric AS amt FROM magpie_holder_pool WHERE id = 1`,
  );
  const { rows: lpRows } = await query(
    `SELECT COALESCE(accrued_lamports, 0)::numeric AS amt FROM lp_loyalty_pool WHERE id = 1`,
  ).catch(() => ({ rows: [] }));
  const { rows: protocolRows } = await query(
    `SELECT COALESCE(accrued_lamports, 0)::numeric AS amt FROM protocol_reserve_pool WHERE id = 1`,
  ).catch(() => ({ rows: [] }));

  const holderOwed = BigInt(holderRows[0]?.amt || 0);
  const lpOwed = BigInt(lpRows[0]?.amt || 0);
  const protocolOwed = BigInt(protocolRows[0]?.amt || 0);
  const totalOwed = holderOwed + lpOwed + protocolOwed;

  // 2. Read distributor on-chain balance.
  const connection = new Connection(RPC_URL, "confirmed");
  const distBalance = BigInt(
    await connection.getBalance(new PublicKey(DISTRIBUTION_WALLET_PUBKEY), "confirmed"),
  );

  // 3. Compute the gap.
  const required = totalOwed + SAFETY_RESERVE_LAMPORTS;
  const gap = required > distBalance ? required - distBalance : 0n;

  if (gap === 0n) {
    // healthy — log occasionally so the operator can see the watcher is alive
    if (Math.random() < 0.05) {
      console.log(
        `[dist-gap] healthy — distributor ${(Number(distBalance) / 1e9).toFixed(4)} ≥ required ${(Number(required) / 1e9).toFixed(4)} SOL`,
      );
    }
    return;
  }

  // Categorize level.
  const ONE_SOL = 1_000_000_000n;
  const FIVE_SOL = 5_000_000_000n;
  const level = gap >= FIVE_SOL ? "p0" : gap >= ONE_SOL ? "alert" : "warn";

  // Throttle per level.
  const lastTs = _lastAlert[level] || 0;
  if (Date.now() - lastTs < ALERT_THROTTLE_MS) {
    console.log(`[dist-gap] ${level.toUpperCase()} gap=${(Number(gap) / 1e9).toFixed(4)} SOL — DM throttled`);
    return;
  }

  // Pull sweeper status for context.
  const { rows: sweepStatus } = await query(
    `SELECT
       (SELECT MAX(created_at) FROM fee_wallet_sweeps WHERE status = 'confirmed') AS last_confirmed_at,
       (SELECT COUNT(*) FROM fee_wallet_sweeps WHERE status = 'planned')::int AS planned_pending,
       (SELECT COUNT(*) FROM fee_wallet_sweeps WHERE status = 'failed' AND created_at > NOW() - INTERVAL '24 hour')::int AS recent_failures`,
  ).catch(() => ({ rows: [{}] }));
  const last = sweepStatus[0]?.last_confirmed_at;
  const lastSweepStr = last
    ? `${Math.round((Date.now() - new Date(last).getTime()) / 60_000)} min ago`
    : "NEVER";
  const planned = sweepStatus[0]?.planned_pending || 0;
  const failed = sweepStatus[0]?.recent_failures || 0;

  const emoji = { warn: "⚠️", alert: "🟠", p0: "🚨" }[level];
  const dmText =
    `${emoji} Distribution wallet GAP detected (${level.toUpperCase()})\n` +
    `\n` +
    `Owed: ${(Number(totalOwed) / 1e9).toFixed(4)} SOL\n` +
    `  - magpie_holder_pool: ${(Number(holderOwed) / 1e9).toFixed(4)} SOL\n` +
    `  - lp_loyalty_pool: ${(Number(lpOwed) / 1e9).toFixed(4)} SOL\n` +
    `  - protocol_reserve_pool: ${(Number(protocolOwed) / 1e9).toFixed(4)} SOL\n` +
    `Distributor on-chain: ${(Number(distBalance) / 1e9).toFixed(4)} SOL\n` +
    `Required (owed + 0.1 reserve): ${(Number(required) / 1e9).toFixed(4)} SOL\n` +
    `\n` +
    `*DEFICIT: ${(Number(gap) / 1e9).toFixed(4)} SOL*\n` +
    `\n` +
    `Sweeper status:\n` +
    `  - Last successful sweep: ${lastSweepStr}\n` +
    `  - Planned-but-unresolved: ${planned}\n` +
    `  - Failed (24h): ${failed}\n` +
    `\n` +
    (level === "p0"
      ? `*Next holder distribution will SKIP unless funded.*`
      : `Next distribution may be at risk if the sweeper can't close the gap before snapshot.`);

  try {
    await notifyAdmin(bot, dmText, { parse_mode: "Markdown" });
    _lastAlert[level] = Date.now();
  } catch {}

  console.warn(
    `[dist-gap] ${level.toUpperCase()} — gap=${(Number(gap) / 1e9).toFixed(4)} SOL ` +
      `(owed=${(Number(totalOwed) / 1e9).toFixed(4)}, distributor=${(Number(distBalance) / 1e9).toFixed(4)})`,
  );
}

export function stopDistributionGapMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
