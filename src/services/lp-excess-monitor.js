/**
 * LP-excess monitor.
 *
 * Reads each program's pool account + loan_token_vault balance and
 * computes the on-chain "excess" — the gap between vault_balance and
 * pool.total_deposits. This excess is the 4% spread that accumulates
 * from imperfect LP yield accounting + dust + misroutes. It's
 * admin-withdrawable per the on-chain guard ("admin_withdraw refused:
 * would drain share-backed LP deposits. Only excess is
 * admin-withdrawable.").
 *
 * Operator-facing PHASE 1 of LP-excess sweeper (task #332): pure
 * telemetry. DM operator the per-pool excess so they have visibility
 * into how much SOL is admin-withdrawable to CHCAM, without any
 * on-chain action. Phase 2 (separate ship, operator-approved) will
 * add the actual admin_withdraw broadcast.
 *
 * Why telemetry-first:
 *   - Standing rule: NEVER make changes that affect existing collateral
 *     or pool state without per-action operator green light.
 *   - admin_withdraw is a privileged instruction; the off-chain math
 *     must be proven correct against several days of on-chain reality
 *     before we ever broadcast.
 *   - Operator hates being surprised. Daily DM with the per-pool numbers
 *     means they always know what's there.
 *
 * Cadence: every LP_EXCESS_MONITOR_MS (default 6h). Reports total
 * excess across V1 + V3 + V4. Throttled to once per LP_EXCESS_DM_COOLDOWN_MS
 * (default 24h) per kind to avoid noise.
 *
 * Kill switch: LP_EXCESS_MONITOR_DISABLED=true halts the loop.
 */
import { PublicKey } from "@solana/web3.js";
import { withFailover } from "../solana/connection.js";
import {
  PROGRAM_ID,
  PROGRAM_ID_V3,
  PROGRAM_ID_V4,
  getReadOnlyProgram,
} from "../solana/program.js";
import { lendingPoolPda, loanTokenVaultPda } from "../solana/pdas.js";
import { notifyAdmin } from "./admin-notify.js";

const TICK_MS = Number(process.env.LP_EXCESS_MONITOR_MS) || 6 * 60 * 60 * 1000;
const DM_COOLDOWN_MS = Number(process.env.LP_EXCESS_DM_COOLDOWN_MS) || 24 * 60 * 60 * 1000;
const DM_MIN_EXCESS_LAMPORTS = BigInt(
  process.env.LP_EXCESS_DM_MIN_LAMPORTS || "100000000", // 0.1 SOL — don't DM for dust
);

let _timer = null;
let _lastDmAt = 0;

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

function isDisabled() {
  return /^(1|true|yes|on)$/i.test(process.env.LP_EXCESS_MONITOR_DISABLED || "");
}

/**
 * Compute excess for ONE program's pool. Returns
 *   { ok: true, programLabel, poolPk, vaultPk, totalDeposits, vaultBalance, excess }
 * or { ok: false, programLabel, error }.
 */
async function readPoolExcess(programLabel, programId) {
  try {
    if (!process.env.LENDER_PUBKEY) {
      return { ok: false, programLabel, error: "LENDER_PUBKEY unset" };
    }
    const lender = new PublicKey(process.env.LENDER_PUBKEY);
    const [poolPk] = lendingPoolPda(lender, programId);
    const [vaultPk] = loanTokenVaultPda(poolPk, programId);

    const program = getReadOnlyProgram(programId);
    // Anchor will deserialize totalDeposits per the program's IDL.
    const poolAccount = await withFailover(async () => program.account.lendingPool.fetch(poolPk));
    const totalDeposits = BigInt(poolAccount.totalDeposits.toString());

    // The loan_token_vault is a wSOL token account. We read it as a token
    // account so the amount field is the wSOL balance — same units as
    // pool.total_deposits (lamports / 1 wSOL = 1 SOL = 1e9 lamports).
    const vaultInfo = await withFailover((conn) => conn.getTokenAccountBalance(vaultPk));
    const vaultBalance = BigInt(vaultInfo.value.amount);

    const excess = vaultBalance - totalDeposits;
    return { ok: true, programLabel, poolPk: poolPk.toBase58(), vaultPk: vaultPk.toBase58(), totalDeposits, vaultBalance, excess };
  } catch (err) {
    return { ok: false, programLabel, error: err?.message?.slice(0, 200) || "unknown" };
  }
}

/**
 * Single tick — read each program, build a report, DM operator when
 * total excess clears the floor AND cooldown has elapsed.
 */
async function tick(bot) {
  if (isDisabled()) return;
  const programs = [
    { label: "V1", id: PROGRAM_ID },
    PROGRAM_ID_V3 && { label: "V3", id: PROGRAM_ID_V3 },
    PROGRAM_ID_V4 && { label: "V4", id: PROGRAM_ID_V4 },
  ].filter(Boolean);

  const results = await Promise.all(programs.map((p) => readPoolExcess(p.label, p.id)));
  const okResults = results.filter((r) => r.ok);
  const errResults = results.filter((r) => !r.ok);

  if (okResults.length === 0) {
    // All probes failed — log + DM once per cooldown.
    if (Date.now() - _lastDmAt < DM_COOLDOWN_MS) return;
    _lastDmAt = Date.now();
    await notifyAdmin(bot,
      `[lp-excess-monitor] all reads failed: ${errResults.map((e) => `${e.programLabel}=${e.error}`).join(" | ")}`,
    );
    return;
  }

  const totalExcess = okResults.reduce((acc, r) => acc + (r.excess > 0n ? r.excess : 0n), 0n);
  if (totalExcess < DM_MIN_EXCESS_LAMPORTS) return;
  if (Date.now() - _lastDmAt < DM_COOLDOWN_MS) return;
  _lastDmAt = Date.now();

  const lines = [
    `[lp-excess-monitor] Total admin-withdrawable across pools: *${fmtSol(totalExcess)} SOL*`,
    "",
    "Per-pool breakdown:",
  ];
  for (const r of okResults) {
    if (r.excess > 0n) {
      lines.push(`  ${r.programLabel}: ${fmtSol(r.excess)} SOL excess (vault ${fmtSol(r.vaultBalance)} − deposits ${fmtSol(r.totalDeposits)})`);
    } else {
      lines.push(`  ${r.programLabel}: 0 excess (vault matches deposits)`);
    }
  }
  for (const e of errResults) {
    lines.push(`  ${e.programLabel}: READ FAILED — ${e.error}`);
  }
  lines.push("");
  lines.push("This SOL is sitting on-chain and admin_withdrawable to CHCAM whenever you flip the auto-sweeper on (LP_EXCESS_AUTO_SWEEP_ENABLED, not yet wired). For now, this DM is informational only — no tx broadcast.");
  await notifyAdmin(bot, lines.join("\n"));
}

/**
 * Public read for on-demand checks (e.g. an admin command). Same shape
 * as the auto-tick but never DMs and always returns the data.
 */
export async function readAllPoolExcess() {
  const programs = [
    { label: "V1", id: PROGRAM_ID },
    PROGRAM_ID_V3 && { label: "V3", id: PROGRAM_ID_V3 },
    PROGRAM_ID_V4 && { label: "V4", id: PROGRAM_ID_V4 },
  ].filter(Boolean);
  return Promise.all(programs.map((p) => readPoolExcess(p.label, p.id)));
}

export function startLpExcessMonitor(bot) {
  if (_timer) return;
  if (isDisabled()) {
    console.log("[lp-excess-monitor] LP_EXCESS_MONITOR_DISABLED — not started");
    return;
  }
  console.log(`[lp-excess-monitor] armed — every ${Math.round(TICK_MS / 3_600_000)}h`);
  // Stagger first run by 5 min so the bot has time to boot.
  setTimeout(() => {
    tick(bot).catch((e) => console.warn("[lp-excess-monitor] first tick threw:", e.message));
    _timer = setInterval(() => {
      tick(bot).catch((e) => console.warn("[lp-excess-monitor] tick threw:", e.message));
    }, TICK_MS);
  }, 5 * 60_000);
}

export function stopLpExcessMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
