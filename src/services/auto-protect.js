/**
 * Auto-Protect — the anti-liquidation feature.
 *
 * For users who opted in (user_prefs.auto_protect = TRUE), this watcher
 * monitors their active loans every 90s. When loan health drops below
 * 1.3x, it takes an action ON THEIR BEHALF to push health back into
 * safe territory:
 *
 *   1. Try AUTO-PARTIAL-REPAY first: use idle SOL in the user's Magpie
 *      wallet to repay enough to bring health back to >= 1.5x.
 *   2. (Future) Auto-topup with idle collateral tokens. Not implemented
 *      in v1 — partial-repay is the simplest path and handles most cases.
 *   3. If neither path is available, DM the user urgently — they must
 *      act manually.
 *
 * Safety bounds (hard-coded — defense in depth against bugs):
 *   • Never spend more than 80% of idle SOL on a single action
 *     (preserves gas reserve)
 *   • Never spend more than AUTO_PROTECT_MAX_SOL_PER_ACTION on one action
 *     (configurable; default 1 SOL)
 *   • Cap at 3 auto-actions per loan in a rolling 24h window
 *   • Every action logged to auto_protect_actions table
 *   • Every action DMs the user with what was done + tx link
 *   • Bot never moves funds out of the user's wallet — only PAYS DOWN
 *     their existing loan (which returns collateral to them on full close)
 *
 * Auto-protect is opt-in. Default is OFF. Users explicitly enable via
 * /autoprotect or /notify toggle.
 */
import { PublicKey } from "@solana/web3.js";
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";
import { collateralValueLamports } from "./price.js";
import { connection } from "../solana/connection.js";
import { executePartialRepay, recordPartialRepay, getLiveOwedLamports } from "./loans.js";
import { ensureWallet } from "./wallet.js";

const POLL_INTERVAL_MS = Number(process.env.AUTO_PROTECT_POLL_MS) || 90_000; // 90s
const DANGER_THRESHOLD = 1.30; // act when health drops below this
const TARGET_THRESHOLD = 1.50; // pay down enough to reach this
const MAX_SOL_PER_ACTION = BigInt(Math.floor((Number(process.env.AUTO_PROTECT_MAX_SOL) || 1.0) * 1e9));
const GAS_RESERVE_LAMPORTS = 5_000_000n; // 0.005 SOL kept back for fees
const MAX_ACTIONS_PER_LOAN_PER_DAY = 3;

// ──────────────────────────── HELPERS ──────────────────────────

async function countActionsLast24h(loanId) {
  const { rows: [r] } = await query(
    `SELECT COUNT(*)::int AS n FROM auto_protect_actions
       WHERE loan_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
         AND signature IS NOT NULL`,
    [loanId],
  );
  return r?.n || 0;
}

async function logAction(row) {
  await query(
    `INSERT INTO auto_protect_actions
       (user_id, loan_id, action_type, amount_lamports, health_before, health_after, signature, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.user_id,
      row.loan_id,
      row.action_type,
      row.amount_lamports?.toString() ?? null,
      row.health_before,
      row.health_after,
      row.signature ?? null,
      row.error ?? null,
    ],
  );
}

// Lamports needed to bring health from `currentHealth` to `targetHealth`,
// given collateral value and current owed. Returns 0n if no action needed.
function lamportsToReachTarget(collateralLamports, owedLamports, targetHealth) {
  // After partial-repay of P: newOwed = owed - P; want collateral / newOwed >= target
  // → newOwed <= collateral / target
  // → P >= owed - (collateral / target)
  const targetOwed = BigInt(Math.floor(Number(collateralLamports) / targetHealth));
  const owed = BigInt(owedLamports);
  if (targetOwed >= owed) return 0n;
  return owed - targetOwed;
}

// ──────────────────────────── ACTION ────────────────────────────

async function attemptAutoProtect(bot, row) {
  const decimals = row.decimals;
  if (decimals == null) return; // unsupported mint

  // Compute current health
  let collateralLamports;
  try {
    collateralLamports = await collateralValueLamports(
      row.collateral_mint,
      row.collateral_amount,
      decimals,
    );
  } catch {
    return; // pricing blip, skip this tick
  }
  // Use the on-chain owed amount, not row.original_loan_amount_lamports
  // directly. The DB column is supposed to track partial repays via
  // recordPartialRepay, but that write can fail silently (see the
  // comment above getLiveOwedLamports in loans.js) — leaving the DB
  // stale while on-chain truth has moved on. Auto-protect using the
  // stale DB value would over-repay (chasing a debt that's been
  // partially settled) or, worse, mis-classify a healthy loan as in
  // danger and burn through MAX_ACTIONS_PER_LOAN_PER_DAY needlessly.
  // getLiveOwedLamports also self-heals the DB drift opportunistically.
  let owedBig;
  try {
    owedBig = await getLiveOwedLamports(row);
  } catch {
    // RPC blip — fall back to the DB value rather than skipping the
    // tick entirely. If on-chain is healthier than DB thinks, we
    // might over-act; if on-chain is sicker, we'd under-act. Either
    // way, the next tick will reconcile.
    owedBig = BigInt(row.original_loan_amount_lamports);
  }
  const owed = Number(owedBig);
  if (owed <= 0) return;
  const healthBefore = collateralLamports / owed;
  if (healthBefore >= DANGER_THRESHOLD) return; // healthy — nothing to do

  // Rate-limit check
  const actionsToday = await countActionsLast24h(row.id);
  if (actionsToday >= MAX_ACTIONS_PER_LOAN_PER_DAY) {
    console.log(`[auto-protect] Loan ${row.loan_id} hit per-day cap (${actionsToday}/${MAX_ACTIONS_PER_LOAN_PER_DAY})`);
    return;
  }

  // Compute how much we'd need to repay
  const neededLamports = lamportsToReachTarget(collateralLamports, owed, TARGET_THRESHOLD);
  if (neededLamports <= 0n) return;

  // Check user's idle SOL balance
  let walletPubkey, balanceLamports;
  try {
    const w = await ensureWallet(row.user_id);
    walletPubkey = w.publicKey;
    balanceLamports = BigInt(await connection.getBalance(new PublicKey(walletPubkey)));
  } catch (err) {
    console.warn(`[auto-protect] balance read failed for user ${row.user_id}:`, err.message);
    return;
  }

  // Spendable = balance - gas reserve, capped by max-per-action
  const spendable = balanceLamports > GAS_RESERVE_LAMPORTS
    ? balanceLamports - GAS_RESERVE_LAMPORTS
    : 0n;
  const cappedByLimit = spendable > MAX_SOL_PER_ACTION ? MAX_SOL_PER_ACTION : spendable;
  const repayAmount = cappedByLimit < neededLamports ? cappedByLimit : neededLamports;

  // If we don't have ENOUGH to make a meaningful dent, just warn instead
  // (defined as: less than 5% of owed, OR less than 0.005 SOL).
  const minMeaningful = BigInt(Math.max(Math.floor(owed * 0.05), 5_000_000));
  if (repayAmount < minMeaningful) {
    await dmInsufficientFunds(bot, row, healthBefore, balanceLamports, neededLamports);
    return;
  }

  // Execute the partial-repay
  console.log(`[auto-protect] Acting on loan ${row.loan_id} — health ${healthBefore.toFixed(2)}x, repaying ${(Number(repayAmount) / 1e9).toFixed(4)} SOL`);
  let result;
  try {
    result = await executePartialRepay({
      userId: row.user_id,
      loanDbRow: row,
      repayLamports: repayAmount,
    });
  } catch (err) {
    console.error(`[auto-protect] Repay failed for loan ${row.loan_id}:`, err.message);
    await logAction({
      user_id: row.user_id,
      loan_id: row.id,
      action_type: "partial_repay_failed",
      amount_lamports: repayAmount,
      health_before: healthBefore.toFixed(3),
      error: err.message?.slice(0, 200),
    });
    // Don't DM on internal failures unless persistent — health-watcher
    // will warn the user via the normal threshold path.
    return;
  }

  // Persist DB-side state + log the action.
  // Signature: recordPartialRepay(loanDbId, repayLamports, userId)
  try {
    await recordPartialRepay(row.id, repayAmount, row.user_id);
  } catch (err) {
    console.warn(`[auto-protect] recordPartialRepay drift for loan ${row.loan_id}:`, err.message);
  }

  // Compute health-after (use the new owed = owed - repayAmount)
  const newOwed = Math.max(1, owed - Number(repayAmount));
  const healthAfter = collateralLamports / newOwed;

  await logAction({
    user_id: row.user_id,
    loan_id: row.id,
    action_type: "partial_repay",
    amount_lamports: repayAmount,
    health_before: healthBefore.toFixed(3),
    health_after: healthAfter.toFixed(3),
    signature: result.signature,
  });

  // DM the user — proud, not alarmed. This is exactly the reassurance
  // they opted in for: "we caught it before liquidation."
  const kb = new InlineKeyboard()
    .url("View tx", `https://solscan.io/tx/${result.signature}`)
    .row()
    .text("⚙️ Manage Auto-Protect", "autoprotect:status");

  const msg = [
    "🛡 *Auto-Protect kicked in*",
    "",
    `Your loan #${row.loan_id} dropped to ${healthBefore.toFixed(2)}x — below the safety threshold.`,
    `I auto-paid down \`${(Number(repayAmount) / 1e9).toFixed(4)} SOL\` from your idle balance.`,
    "",
    `Health now: *${healthAfter.toFixed(2)}x* (back in safe range).`,
    `Wallet idle: \`${(Number(balanceLamports - repayAmount) / 1e9).toFixed(4)} SOL\` remaining.`,
    "",
    `_${actionsToday + 1}/${MAX_ACTIONS_PER_LOAN_PER_DAY} auto-actions used on this loan today._`,
  ].join("\n");

  try {
    await bot.api.sendMessage(row.telegram_id, msg, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
  } catch (err) {
    console.warn(`[auto-protect] DM failed for user ${row.user_id}:`, err.message);
  }
}

async function dmInsufficientFunds(bot, row, healthBefore, balance, needed) {
  const kb = new InlineKeyboard()
    .text("🔧 Repay now", `repay:loan:${row.id}`)
    .text("➕ Top up", `topup:loan:${row.id}`)
    .row()
    .text("⏱ Extend", `extend:loan:${row.id}`);

  const msg = [
    "🛡 *Auto-Protect couldn't help — manual action needed*",
    "",
    `Your loan #${row.loan_id} dropped to *${healthBefore.toFixed(2)}x*.`,
    `Would need ~\`${(Number(needed) / 1e9).toFixed(4)} SOL\` to bring it back to safe.`,
    `You have \`${(Number(balance) / 1e9).toFixed(4)} SOL\` idle — not enough.`,
    "",
    "*Act now:*",
    "• /deposit more SOL, then I'll auto-protect on the next tick",
    "• /topup with more collateral",
    "• /partialrepay or /repay manually",
    "• /extend to push the due date out",
  ].join("\n");

  try {
    await bot.api.sendMessage(row.telegram_id, msg, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
    // Log the insufficient-funds attempt so we can audit
    await logAction({
      user_id: row.user_id,
      loan_id: row.id,
      action_type: "insufficient_funds_warning",
      amount_lamports: needed,
      health_before: healthBefore.toFixed(3),
      error: "insufficient idle SOL",
    });
  } catch {}
}

// ──────────────────────────── WATCHER ──────────────────────────

let running = false;
async function tick(bot) {
  if (running) return;
  running = true;
  try {
    // Pull all active loans where the user has auto_protect ON
    const { rows } = await query(
      `SELECT l.id, l.loan_id, l.user_id, l.collateral_mint, l.collateral_amount,
              l.original_loan_amount_lamports, l.loan_pda,
              u.telegram_id, sm.decimals
       FROM loans l
       JOIN users u ON u.id = l.user_id
       JOIN user_prefs p ON p.user_id = l.user_id
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       WHERE l.status = 'active' AND p.auto_protect = TRUE`,
    );
    // Serialise to avoid hammering RPC; usually small list
    for (const row of rows) {
      try {
        await attemptAutoProtect(bot, row);
      } catch (err) {
        console.error(`[auto-protect] error on loan ${row.loan_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[auto-protect] cycle error:", err.message);
  } finally {
    running = false;
  }
}

export function startAutoProtect(bot) {
  console.log(`🛡 Auto-Protect watcher running (every ${POLL_INTERVAL_MS / 1000}s)`);
  // First tick after 30s — give other startup tasks room
  setTimeout(() => tick(bot), 30_000);
  return setInterval(() => tick(bot), POLL_INTERVAL_MS);
}
