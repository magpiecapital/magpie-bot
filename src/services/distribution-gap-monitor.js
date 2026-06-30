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
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { query } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";
import { withFailover } from "../solana/connection.js";
import { readPayableOwed } from "./distribution-owed.js";
import { kickDistributionFunder } from "./distribution-auto-funder.js";
import { availableLenderNative } from "./lender-reserve.js";

const INTERVAL_MS = Number(
  process.env.DIST_GAP_MONITOR_INTERVAL_MS || 10 * 60 * 1000, // 10 min
);
const RPC_URL = process.env.SOLANA_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const DISTRIBUTION_WALLET_PUBKEY =
  process.env.REWARDS_DISTRIBUTOR_PUBKEY || "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac";
const SAFETY_RESERVE_LAMPORTS = 100_000_000n; // 0.1 SOL — matches MIN_LENDER_RESERVE_LAMPORTS in magpie-holder-rewards.js

// Operator-mandated 2026-06-19: P0 alerts must NEVER throttle. Operator's
// rule is the gap should never persist long enough to be throttled — if it
// ever does, DM every tick until closed. WARN/ALERT keep their 1h throttle
// to avoid spam in the small-gap accrual band.
// [[feedback_distribution_wallet_must_be_auto_funded]]
const ALERT_THROTTLE_MS = 60 * 60 * 1000; // 1h for warn/alert levels
const P0_THROTTLE_MS = 0;                  // P0: every tick, no throttle
let _lastAlert = { warn: 0, alert: 0, p0: 0 };
let _lastP0DeficitLamports = 0n;
let _timer = null;

// PERSISTENCE GATE — the hardening. A gap on a SINGLE reading is almost always
// transient: fees just accrued as wSOL, or the funder simply hasn't run since
// the last accrual. Alarming on that trains the operator to hand-fund phantoms.
// So on EVERY gap reading we first KICK the funder (self-heal — it in-tick
// unwraps lender wSOL + tops CHCAM up), and only DM the operator once the gap
// PERSISTS across this many consecutive readings (i.e. the funder demonstrably
// could NOT close it → a real, durable shortfall worth a human). Env-tunable.
const PERSIST_TICKS = Math.max(1, Number(process.env.DIST_GAP_PERSIST_TICKS || 2));
let _consecutiveGapTicks = 0;

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
  // 1. PAYABLE owed via the ONE canonical helper (holder + LP third-party-NET;
  //    protocol reserve excluded) — the SAME source the funder + /stats use, so
  //    the monitored gap matches the displayed + funded numbers exactly.
  const { holderOwed, lpOwed, protocolOwed, payableOwed } = await readPayableOwed();
  const totalOwed = payableOwed;

  // 2. Read distributor on-chain balances via failover. Surface wSOL too: with
  //    the native-only-sink design CHCAM shouldn't hold wSOL, but if any is
  //    present it's spendable-after-unwrap, so it should not read as a native
  //    P0 deficit.
  const connection = new Connection(RPC_URL, "confirmed");
  const distPk = new PublicKey(DISTRIBUTION_WALLET_PUBKEY);
  const distBalance = BigInt(await withFailover((c) => c.getBalance(distPk, "confirmed")));
  let distWsol = 0n;
  try {
    const ata = await getAssociatedTokenAddress(NATIVE_MINT, distPk, false, TOKEN_PROGRAM_ID);
    const acct = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    distWsol = acct.amount;
  } catch { /* no wSOL ATA */ }

  // 3. Compute the gap against spendable native + any wSOL (unwrappable).
  const required = totalOwed + SAFETY_RESERVE_LAMPORTS;
  const distSpendable = distBalance + distWsol;
  const gap = required > distSpendable ? required - distSpendable : 0n;

  if (gap === 0n) {
    // healthy — reset the persistence counter and log occasionally so the
    // operator can see the watcher is alive.
    if (_consecutiveGapTicks > 0) {
      console.log(`[dist-gap] gap CLEARED after ${_consecutiveGapTicks} tick(s) — back to healthy`);
    }
    _consecutiveGapTicks = 0;
    if (Math.random() < 0.05) {
      console.log(
        `[dist-gap] healthy — distributor ${(Number(distBalance) / 1e9).toFixed(4)} ≥ required ${(Number(required) / 1e9).toFixed(4)} SOL`,
      );
    }
    return;
  }

  // A GAP EXISTS. STEP 1 — SELF-HEAL FIRST: kick the auto-funder immediately
  // (it in-tick unwraps any lender wSOL + funds CHCAM). A transient gap closes
  // here and is NEVER alarmed. This is what makes the gap monitor a healer, not
  // just a smoke detector.
  kickDistributionFunder(bot, "gap-monitor");
  _consecutiveGapTicks += 1;

  // STEP 2 — PERSISTENCE GATE: only escalate to the operator once the gap has
  // survived PERSIST_TICKS consecutive readings, i.e. the funder kick could NOT
  // close it. A single transient reading never pages anyone.
  if (_consecutiveGapTicks < PERSIST_TICKS) {
    console.log(
      `[dist-gap] gap=${(Number(gap) / 1e9).toFixed(4)} SOL seen (${_consecutiveGapTicks}/${PERSIST_TICKS}) — ` +
        `kicked funder to self-heal; deferring alarm until persistent`,
    );
    return;
  }

  // Categorize level.
  const ONE_SOL = 1_000_000_000n;
  const FIVE_SOL = 5_000_000_000n;
  const level = gap >= FIVE_SOL ? "p0" : gap >= ONE_SOL ? "alert" : "warn";

  // STEP 3 — THE RIGHT ACTION: a PERSISTENT gap means the funder couldn't close
  // it. WHY it couldn't determines what the operator should do, so read the
  // lender's available native and classify:
  //   • lender CAN cover  → the funder/sweeper is stuck (disabled, key, RPC),
  //     NOT a money problem. Action: investigate the funder. Do NOT hand-fund.
  //   • lender CANNOT cover → protocol fee revenue is genuinely below the
  //     accrued obligation right now. Action: investigate accrual/over-credit.
  //     Still do NOT hand-fund (the auto-funder catches up on the next inflow).
  let lenderAvail = null;
  try { lenderAvail = await availableLenderNative(connection); } catch { /* unknown */ }
  const lenderCanCover = lenderAvail != null && lenderAvail >= gap;
  const actionLine = lenderCanCover
    ? `→ The lender CAN cover this (${(Number(lenderAvail) / 1e9).toFixed(4)} SOL available) — so the FUNDER is stuck, not your wallet. ` +
      `Check DIST_FUNDER_DISABLED, the lender key, and recent distribution_funding_events. *Do NOT hand-fund.*`
    : `→ The lender CANNOT cover this${lenderAvail != null ? ` (only ${(Number(lenderAvail) / 1e9).toFixed(4)} SOL available)` : ""} — ` +
      `real fee revenue is below the accrued obligation right now. *Do NOT add personal funds*; investigate accrual/over-credit. The funder tops up on the next inflow.`;

  // Throttle per level (persistence already gated the first alarm). P0 keeps
  // its no-throttle behavior so a genuine, persistent P0 pages every tick until
  // closed (operator mandate 2026-06-19).
  const lastTs = _lastAlert[level] || 0;
  const throttleMs = level === "p0" ? P0_THROTTLE_MS : ALERT_THROTTLE_MS;
  if (Date.now() - lastTs < throttleMs) {
    console.log(`[dist-gap] ${level.toUpperCase()} gap=${(Number(gap) / 1e9).toFixed(4)} SOL (persistent ${_consecutiveGapTicks}) — DM throttled`);
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
    `${emoji} Distribution wallet PERSISTENT gap (${level.toUpperCase()})\n` +
    `\n` +
    `Survived ${_consecutiveGapTicks} consecutive checks (~${Math.round((_consecutiveGapTicks * INTERVAL_MS) / 60_000)} min) ` +
    `despite an auto-funder kick each time — so this is NOT a transient lag.\n` +
    `\n` +
    `Payable owed (holder+LP): ${(Number(totalOwed) / 1e9).toFixed(4)} SOL\n` +
    `  - magpie_holder_pool: ${(Number(holderOwed) / 1e9).toFixed(4)} SOL\n` +
    `  - lp_loyalty_pool: ${(Number(lpOwed) / 1e9).toFixed(4)} SOL\n` +
    `  - protocol_reserve_pool: ${(Number(protocolOwed) / 1e9).toFixed(4)} SOL (excluded — no auto-payout)\n` +
    `Distributor on-chain: ${(Number(distBalance) / 1e9).toFixed(4)} SOL native` +
    (distWsol > 0n ? ` + ${(Number(distWsol) / 1e9).toFixed(4)} wSOL (unwrappable, counted as spendable)` : "") + `\n` +
    `Required (owed + 0.1 reserve): ${(Number(required) / 1e9).toFixed(4)} SOL\n` +
    `\n` +
    `*DEFICIT: ${(Number(gap) / 1e9).toFixed(4)} SOL*\n` +
    `\n` +
    `${actionLine}\n` +
    `\n` +
    `Sweeper status:\n` +
    `  - Last successful sweep: ${lastSweepStr}\n` +
    `  - Planned-but-unresolved: ${planned}\n` +
    `  - Failed (24h): ${failed}\n` +
    `\n` +
    (level === "p0"
      ? `*Next holder distribution will SKIP unless this clears.*`
      : `Next distribution may be at risk if this doesn't clear before snapshot.`);

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
