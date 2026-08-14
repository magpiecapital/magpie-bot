/**
 * Auto-extend watcher — executes opt-in auto-extensions (strategy doc 18).
 *
 * Every POLL_INTERVAL_MS: find active loans due within the auto-extend
 * window whose borrower opted in (/autoextend), run each through the PURE
 * decision core (auto-extend-core.js — window, cap, health, balance,
 * cooldown), and execute `extend_loan` via the same executeExtendLoan path a
 * manual /extend uses (managed wallet signs, tier fee, referral accrual).
 *
 * Every execution, failure, and first-occurrence skip that a user would care
 * about lands in auto_extend_events with the rule version (decision-trail
 * mandate). Users are DM'd on success, on failure, and ONCE per
 * user-actionable skip reason (insufficient balance / underwater / cap).
 *
 * Kill switch: AUTOEXTEND_DISABLED=1 (same pattern as PIP_*_DISABLED).
 */
import { query } from "../db/pool.js";
import { withFailover } from "../solana/connection.js";
import { PublicKey } from "@solana/web3.js";
import {
  decideAutoExtend,
  extendFeeLamports,
  RULE_VERSION,
  WINDOW_CEILING_MS,
  WINDOW_FLOOR_MS,
} from "./auto-extend-core.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

// decision reasons that are user-actionable → recorded + DM'd once per loan
const RECORDED_SKIPS = new Set(["insufficient_balance", "underwater", "cap_reached"]);

const SKIP_DMS = {
  insufficient_balance:
    "⚠️ <b>Auto-extend skipped:</b> your wallet can't cover the extension fee. Top up SOL or repay before expiry — once overdue, the loan can no longer be extended.",
  underwater:
    "⚠️ <b>Auto-extend skipped:</b> your collateral is worth less than what you owe, so extending would only cost you fees. Repay before expiry to recover your collateral, or let the loan settle.",
  cap_reached:
    "⚠️ <b>Auto-extend limit reached</b> for this loan (2 automatic extensions). Repay or extend manually with /extend before expiry.",
};

// per-process cooldown tracker: loanId -> last attempt ms
const lastAttempt = new Map();

async function fetchCandidates() {
  const windowCeilingSec = Math.ceil(WINDOW_CEILING_MS / 1000) + 300; // small fetch margin
  const { rows } = await query(
    `SELECT l.*, u.telegram_id, w.public_key AS wallet_public_key
       FROM loans l
       JOIN users u ON u.id = l.user_id
       JOIN user_prefs p ON p.user_id = l.user_id AND p.auto_extend = TRUE
  LEFT JOIN wallets w ON w.user_id = l.user_id
      WHERE l.status = 'active'
        AND l.due_timestamp > now()
        AND l.due_timestamp < now() + make_interval(secs => $1)`,
    [windowCeilingSec],
  );
  return rows;
}

async function recordEvent({ loan, decision, reason, feeLamports, healthRatio, txSignature }) {
  // Skips dedup on (loan_id, reason); a returned row means "first time".
  const { rows } = await query(
    `INSERT INTO auto_extend_events
       (loan_id, user_id, decision, reason, fee_lamports, health_ratio, rule_version, tx_signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      loan.id,
      loan.user_id,
      decision,
      reason,
      feeLamports != null ? feeLamports.toString() : null,
      healthRatio,
      RULE_VERSION,
      txSignature ?? null,
    ],
  );
  return rows.length > 0;
}

async function dmUser(bot, telegramId, html) {
  // NEVER DM a negative telegram id — site-only sentinel rows overlap real
  // TG group ids ([[project_unwarned_liquidation_incident]]).
  if (!telegramId || Number(telegramId) < 0) return;
  try {
    await bot.api.sendMessage(telegramId, html, { parse_mode: "HTML" });
  } catch (err) {
    console.error(`[auto-extend] DM failed for tg ${telegramId}: ${err.message}`);
  }
}

async function processLoan(bot, loan, nowMs) {
  // Assemble decision inputs. Any input failure falls back to a value the
  // core treats conservatively (see core doc-block).
  const { getLiveOwedLamports } = await import("./loans.js");
  const owedLive = await getLiveOwedLamports(loan);
  const feeLamports = extendFeeLamports(Number(loan.ltv_percentage), owedLive);

  let walletBalanceLamports = 0n;
  if (loan.wallet_public_key) {
    try {
      const bal = await withFailover((conn) => conn.getBalance(new PublicKey(loan.wallet_public_key)));
      walletBalanceLamports = BigInt(bal);
    } catch (err) {
      console.error(`[auto-extend] balance fetch failed loan ${loan.id}: ${err.message}`);
    }
  }

  let healthRatio = null;
  try {
    const { rows: [mintRow] } = await query(
      `SELECT decimals FROM supported_mints WHERE mint = $1`,
      [loan.collateral_mint],
    );
    if (mintRow) {
      const { collateralValueLamports } = await import("./price.js");
      const valueLamports = await collateralValueLamports(
        loan.collateral_mint,
        loan.collateral_amount,
        Number(mintRow.decimals),
      );
      if (valueLamports != null && owedLive > 0n) {
        healthRatio = Number(valueLamports) / Number(owedLive);
      }
    }
  } catch (err) {
    // healthRatio stays null → core allows (extension protects the borrower)
    console.error(`[auto-extend] health calc failed loan ${loan.id}: ${err.message}`);
  }

  const decision = decideAutoExtend(
    {
      status: loan.status,
      dueMs: new Date(loan.due_timestamp).getTime(),
      optIn: true, // fetchCandidates JOINs user_prefs.auto_extend = TRUE

      autoExtendCount: Number(loan.auto_extend_count || 0),
      feeLamports,
      walletBalanceLamports,
      healthRatio,
      lastAttemptMs: lastAttempt.get(loan.id) ?? null,
    },
    nowMs,
  );

  if (decision.action === "skip") {
    if (RECORDED_SKIPS.has(decision.reason)) {
      const firstTime = await recordEvent({
        loan, decision: "skipped", reason: decision.reason, feeLamports, healthRatio,
      });
      if (firstTime && SKIP_DMS[decision.reason]) {
        await dmUser(bot, loan.telegram_id, SKIP_DMS[decision.reason]);
      }
    }
    return;
  }

  // Execute. Re-check the Q-02 window at the last possible moment.
  lastAttempt.set(loan.id, nowMs);
  if (new Date(loan.due_timestamp).getTime() - Date.now() <= WINDOW_FLOOR_MS) return;

  try {
    const { executeExtendLoan, recordExtendLoan } = await import("./loans.js");
    const result = await executeExtendLoan({ userId: loan.user_id, loanDbRow: loan });
    await recordExtendLoan(loan.id, loan.user_id);
    await query(`UPDATE loans SET auto_extend_count = auto_extend_count + 1 WHERE id = $1`, [loan.id]);
    await recordEvent({
      loan, decision: "extended", reason: `ok_${Number(loan.auto_extend_count || 0) + 1}`,
      feeLamports: result.feeLamports ?? feeLamports, healthRatio, txSignature: result.signature,
    });
    const fee = (Number(result.feeLamports ?? feeLamports) / 1e9).toFixed(4);
    await dmUser(
      bot,
      loan.telegram_id,
      `✅ <b>Loan auto-extended</b> by ${loan.duration_days} days (fee ${fee} SOL). You opted into /autoextend — toggle it there anytime. /positions for status.`,
    );
    console.log(`[auto-extend] extended loan ${loan.id} (fee ${fee} SOL)`);
  } catch (err) {
    console.error(`[auto-extend] extend FAILED loan ${loan.id}: ${err.message}`);
    await recordEvent({
      loan, decision: "failed", reason: (err.message || "unknown").slice(0, 120),
      feeLamports, healthRatio,
    });
    await dmUser(
      bot,
      loan.telegram_id,
      `⚠️ <b>Auto-extend failed</b> for your ${loan.symbol ?? ""} loan — please repay or /extend manually before expiry. Once overdue, extension is no longer possible.`,
    );
  }
}

export function startAutoExtendWatcher(bot) {
  if (process.env.AUTOEXTEND_DISABLED === "1") {
    console.log("[auto-extend] disabled via AUTOEXTEND_DISABLED=1");
    return;
  }
  async function cycle() {
    try {
      const candidates = await fetchCandidates();
      if (candidates.length === 0) return;
      const nowMs = Date.now();
      for (const loan of candidates) {
        try {
          await processLoan(bot, loan, nowMs);
        } catch (err) {
          console.error(`[auto-extend] loan ${loan.id} cycle error: ${err.message}`);
        }
      }
    } catch (err) {
      console.error("[auto-extend] cycle error:", err.message);
    }
  }
  setTimeout(cycle, 20_000);
  setInterval(cycle, POLL_INTERVAL_MS);
  console.log("[auto-extend] watcher started");
}
