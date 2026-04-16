/**
 * Auto-repay: when a user with auto_repay enabled receives SOL and their
 * balance covers the soonest-due active loan's payoff (with a safety buffer
 * for tx fees + ATA rent), submit the repay automatically.
 *
 * Safeguards:
 *  - In-memory `processing` Set prevents concurrent attempts on the same loan
 *    (the watcher runs every 20s; a repay takes longer than that sometimes).
 *  - Only triggered when we actually detect a fresh deposit — passive polling
 *    alone won't fire this.
 *  - Budgets ~0.003 SOL for fees+rent so we don't drain the user's wallet.
 */
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { PublicKey } from "@solana/web3.js";
import { executeRepay, markLoanRepaid } from "./loans.js";
import { incrementRepaid } from "./reputation.js";
import { getPrefs } from "./prefs.js";

const FEE_BUFFER_LAMPORTS = 3_000_000; // ~0.003 SOL
const processing = new Set();

export async function maybeAutoRepay(bot, { userId, telegramId, publicKey }) {
  const prefs = await getPrefs(userId);
  if (!prefs.auto_repay) return;

  const { rows: loans } = await query(
    `SELECT l.*, sm.symbol
     FROM loans l LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE l.user_id = $1 AND l.status = 'active'
     ORDER BY l.due_timestamp ASC
     LIMIT 1`,
    [userId],
  );
  const loan = loans[0];
  if (!loan) return;
  if (processing.has(loan.id)) return;

  const owed = BigInt(loan.original_loan_amount_lamports);
  const balanceLamports = BigInt(
    await connection.getBalance(new PublicKey(publicKey)),
  );
  if (balanceLamports < owed + BigInt(FEE_BUFFER_LAMPORTS)) return;

  processing.add(loan.id);
  try {
    console.log(`[auto-repay] attempting loan#${loan.loan_id} for user ${userId}`);
    const result = await executeRepay({ userId, loanDbRow: loan });
    await markLoanRepaid(loan.id, result.signature);
    await incrementRepaid(userId);

    if (telegramId) {
      await bot.api
        .sendMessage(
          telegramId,
          [
            "🤖 *Auto-repay complete*",
            "",
            `Loan #${loan.loan_id} (${loan.symbol ?? "?"}) repaid.`,
            `Collateral returned to your wallet.`,
            "",
            `[View tx](https://solscan.io/tx/${result.signature})`,
          ].join("\n"),
          { parse_mode: "Markdown", disable_web_page_preview: true },
        )
        .catch((e) => console.error(`[auto-repay] DM failed: ${e.message}`));
    }
  } catch (err) {
    console.error(`[auto-repay] failed loan ${loan.loan_id}: ${err.message}`);
    if (telegramId) {
      await bot.api
        .sendMessage(
          telegramId,
          `⚠️ Auto-repay for loan #${loan.loan_id} failed: ${err.message}\n\nUse /repay to try manually.`,
        )
        .catch(() => {});
    }
  } finally {
    processing.delete(loan.id);
  }
}
