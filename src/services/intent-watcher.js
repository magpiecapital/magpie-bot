/**
 * Conditional borrow watcher.
 *
 * Background loop: every WATCHER_INTERVAL_MS, scan pending intents and
 * fire any whose trigger has matched. Firing means:
 *
 *   1. Re-run the FULL borrow gauntlet (ban → valuation → anti-exploit)
 *      with fresh prices. An intent posted before a ban does NOT bypass
 *      the ban.
 *   2. Build the unsigned tx with a fresh blockhash.
 *   3. Update the intent row: status='matched', store partial_signed_tx_b64
 *      + summary, set matched_at = NOW().
 *
 * The agent polls GET /api/v1/agent/intent?id=... and pulls the tx as
 * soon as it's ready. The agent always retains final-signature authority
 * — this watcher never signs or submits anything.
 *
 * Safety:
 *   - Mints are re-checked at match time. If supported_mints.enabled
 *     flipped to false since the intent was created, the intent fails.
 *   - If the borrow gauntlet rejects (e.g. price moved past gate, pool
 *     liquidity floor hit, per-token cap), the intent stays pending and
 *     the watcher tries again next tick — UNLESS the rejection is the
 *     condition itself going stale (price flipped back below threshold
 *     between match-detection and gauntlet), in which case the intent
 *     stays pending naturally.
 *   - Expired intents are swept to status='expired'.
 *   - Heartbeat published so the /health route can verify the watcher
 *     is running.
 *
 * Single-instance safety: this service uses a Postgres advisory lock to
 * ensure only one process runs the watcher at a time, even across
 * multiple bot replicas. Without this, two replicas could both flip an
 * intent to 'matched' and double-build the tx (creating two loan PDAs).
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { lendingPoolPda } from "../solana/pdas.js";
import { PROGRAM_ID } from "../solana/program.js";
import { getPriceInUsdCrossSourced } from "./price.js";
import { buildBorrowTx, findOrCreateAgentUser } from "../api/agent.js";
import { markCycle } from "../lib/heartbeat.js";

const WATCHER_INTERVAL_MS = Number(process.env.INTENT_WATCHER_INTERVAL_MS) || 30_000;
const HEARTBEAT_NAME = "intent-watcher";
const ADVISORY_LOCK_KEY = 0x4d_61_67_70_69_65; // 'Magpie' as int — arbitrary unique key

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);

let _running = false;
let _lockHeld = false;

/**
 * Try to acquire the Postgres session advisory lock. Returns true on
 * success, false if another process already holds it.
 */
async function acquireAdvisoryLock() {
  const { rows } = await query(
    `SELECT pg_try_advisory_lock($1) AS got`,
    [ADVISORY_LOCK_KEY],
  );
  return rows[0]?.got === true;
}

/**
 * Evaluate a single condition against the live world. Returns true if
 * the condition is met right now. Throws on unrecoverable error (e.g.
 * price feed failure that should stop processing this intent but not
 * crash the watcher).
 */
async function evaluateCondition(condType, params) {
  switch (condType) {
    case "price_above": {
      const usd = await getPriceInUsdCrossSourced(params.mint);
      return usd > params.usd;
    }
    case "price_below": {
      const usd = await getPriceInUsdCrossSourced(params.mint);
      return usd < params.usd;
    }
    case "time_after": {
      const now = Math.floor(Date.now() / 1000);
      return now >= params.unix;
    }
    case "pool_liq_above": {
      // Read the live pool's lamports balance. The vault address is
      // derived deterministically, so this is just a getBalance call.
      const { loanTokenVaultPda } = await import("../solana/pdas.js");
      const [lendingPool] = lendingPoolPda(LENDER_PUBKEY, PROGRAM_ID);
      const [vault] = loanTokenVaultPda(lendingPool, PROGRAM_ID);
      const lamports = await connection.getBalance(vault);
      // Crude SOL→USD via Jupiter: SOL price is in the cross-sourced
      // feed under SO111... but evaluating pool_liq_above precisely
      // needs SOL/USD. Use Jupiter directly for SOL price.
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const solUsd = await getPriceInUsdCrossSourced(SOL_MINT);
      const tvlUsd = (lamports / 1e9) * solUsd;
      return tvlUsd > params.usd;
    }
    default:
      throw new Error(`unknown condition_type: ${condType}`);
  }
}

/**
 * Fire a single intent — re-run the gauntlet, build the tx, flip the
 * row to 'matched'. Catches errors per-intent so one bad intent doesn't
 * block the others.
 */
async function fireIntent(intent) {
  const borrowerPk = new PublicKey(intent.borrower_wallet);
  const collateralMintPk = new PublicKey(intent.collateral_mint);

  // Re-fetch mint metadata at match time. Token may have been disabled
  // since the intent was created.
  const { rows: mintRows } = await query(
    `SELECT mint, decimals, category, enabled, symbol FROM supported_mints WHERE mint = $1`,
    [intent.collateral_mint],
  );
  if (!mintRows[0] || !mintRows[0].enabled) {
    await query(
      `UPDATE borrow_intents SET status = 'expired', last_checked_at = NOW()
         WHERE intent_id = $1 AND status = 'pending'`,
      [intent.intent_id],
    );
    console.warn(`[intent-watcher] ${intent.intent_id} mint disabled → expired`);
    return;
  }

  const userId = await findOrCreateAgentUser(intent.borrower_wallet);

  const built = await buildBorrowTx({
    borrowerPk,
    collateralMintPk,
    collateralAmountRaw: String(intent.collateral_amount),
    tier: Number(intent.tier),
    userId,
    mintRow: mintRows[0],
  });

  if (built.blocked) {
    // Gate refused. Don't terminate the intent — conditions could
    // shift (price recovers, pool floor lifts). Just mark checked.
    await query(
      `UPDATE borrow_intents SET last_checked_at = NOW()
         WHERE intent_id = $1`,
      [intent.intent_id],
    );
    console.warn(
      `[intent-watcher] ${intent.intent_id} gauntlet blocked: ${built.body?.reason || built.body?.error}`,
    );
    return;
  }

  const tierCfg = built.tierCfg;
  const collateralValueSol = Number(built.collateralValLamports) / 1e9;
  const summary = {
    program_id: built.programId.toBase58(),
    loan_id: built.loanIdStr,
    loan_pda: built.loanAccountStr,
    collateral_mint: intent.collateral_mint,
    collateral_symbol: mintRows[0].symbol,
    collateral_amount_raw: String(intent.collateral_amount),
    collateral_value_sol: collateralValueSol,
    principal_sol: built.principalLamports / 1e9,
    fee_sol: built.feeLamports / 1e9,
    ltv_pct: tierCfg.ltv,
    duration_days: tierCfg.days,
    due_unix: Math.floor(Date.now() / 1000) + tierCfg.days * 86400,
  };

  // Atomic update: only flip pending → matched. If something else
  // already flipped it (cancellation race), skip.
  const { rows: updated } = await query(
    `UPDATE borrow_intents SET
       status = 'matched',
       partial_signed_tx_b64 = $1,
       summary = $2,
       matched_at = NOW(),
       last_checked_at = NOW()
       WHERE intent_id = $3 AND status = 'pending'
       RETURNING intent_id`,
    [built.txB64, JSON.stringify(summary), intent.intent_id],
  );
  if (updated[0]) {
    console.log(`[intent-watcher] ${intent.intent_id} MATCHED → tx built (${built.principalLamports / 1e9} SOL)`);
  }
}

/**
 * One tick of the watcher. Expires stale intents, evaluates conditions
 * on pending ones, fires matches.
 */
async function tick() {
  // Expire anything past its TTL.
  const { rowCount: nExpired } = await query(
    `UPDATE borrow_intents SET status = 'expired'
       WHERE status = 'pending' AND expires_at < NOW()`,
  );
  if (nExpired > 0) {
    console.log(`[intent-watcher] expired ${nExpired} stale intents`);
  }

  // Pull pending intents. Limit to 100 per tick to bound work per cycle.
  const { rows: pending } = await query(
    `SELECT intent_id, borrower_wallet, collateral_mint, collateral_amount,
            tier, condition_type, condition_params
       FROM borrow_intents
       WHERE status = 'pending'
       ORDER BY COALESCE(last_checked_at, created_at) ASC
       LIMIT 100`,
  );

  for (const intent of pending) {
    try {
      const matched = await evaluateCondition(intent.condition_type, intent.condition_params);
      if (matched) {
        await fireIntent(intent);
      } else {
        await query(
          `UPDATE borrow_intents SET last_checked_at = NOW() WHERE intent_id = $1`,
          [intent.intent_id],
        );
      }
    } catch (err) {
      console.error(`[intent-watcher] ${intent.intent_id} eval failed: ${err.message}`);
      // Don't terminate the intent — a price feed hiccup is recoverable.
      await query(
        `UPDATE borrow_intents SET last_checked_at = NOW() WHERE intent_id = $1`,
        [intent.intent_id],
      );
    }
  }
}

export async function startIntentWatcher() {
  if (_running) {
    console.warn("[intent-watcher] already running");
    return;
  }
  _running = true;

  // Attempt to acquire the cross-process lock once at startup. If we
  // can't get it (another replica holds it), we still loop and
  // re-attempt acquisition each cycle — replicas swap leadership when
  // the holder dies.
  _lockHeld = await acquireAdvisoryLock();
  if (!_lockHeld) {
    console.log("[intent-watcher] another instance holds the advisory lock; standby mode");
  } else {
    console.log(`[intent-watcher] active; tick every ${WATCHER_INTERVAL_MS}ms`);
  }

  while (_running) {
    try {
      if (!_lockHeld) {
        _lockHeld = await acquireAdvisoryLock();
        if (_lockHeld) {
          console.log("[intent-watcher] acquired advisory lock; now active");
        }
      }
      if (_lockHeld) {
        await tick();
      }
      markCycle(HEARTBEAT_NAME, true);
    } catch (err) {
      console.error("[intent-watcher] tick failed:", err.message);
      markCycle(HEARTBEAT_NAME, false);
    }
    await new Promise((r) => setTimeout(r, WATCHER_INTERVAL_MS));
  }
}

export function stopIntentWatcher() {
  _running = false;
}
