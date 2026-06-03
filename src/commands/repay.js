import { InlineKeyboard } from "grammy";
import { PublicKey } from "@solana/web3.js";
import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";
import { executeRepay, markLoanRepaid, getLiveOwedLamports } from "../services/loans.js";
import { ensureWallet } from "../services/wallet.js";
import { connection } from "../solana/connection.js";
import { incrementRepaid } from "../services/reputation.js";
import { translateTxError } from "../services/tx-error-translator.js";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

// Tx fees + ATA rent reserve. Conservative: ~5k lamports/sig × a few sigs,
// plus 0.002 SOL for any ATA creation that might be needed during repay.
const REPAY_GAS_BUFFER_LAMPORTS = 3_000_000n; // 0.003 SOL

export async function handleRepay(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows } = await query(
    `SELECT l.*, sm.symbol
     FROM loans l
     LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
     WHERE l.user_id = $1 AND l.status = 'active'
     ORDER BY l.due_timestamp ASC`,
    [user.id],
  );

  if (rows.length === 0) {
    return ctx.reply("📭 No active loans to repay.");
  }

  // Read live on-chain amount for each loan in parallel
  const liveAmounts = await Promise.all(rows.map(getLiveOwedLamports));

  const kb = new InlineKeyboard();
  rows.forEach((loan, i) => {
    kb.text(
      `#${loan.loan_id} · ${loan.symbol ?? "?"} · ${fmtSol(liveAmounts[i])} SOL`,
      `repay:loan:${loan.id}`,
    ).row();
  });
  kb.text("✕ Cancel", "repay:cancel");

  await ctx.reply("*Pick a loan to repay:*", {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
}

export function registerRepayCallbacks(bot) {
  bot.callbackQuery(/^repay:cancel$/, async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Repay cancelled.");
  });

  bot.callbackQuery(/^repay:loan:(\d+)$/, async (ctx) => {
    const loanDbId = Number(ctx.match[1]);
    const user = await upsertUser(ctx.from.id, ctx.from.username);

    const { rows } = await query(
      `SELECT l.*, sm.symbol
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       WHERE l.id = $1 AND l.user_id = $2 AND l.status = 'active'`,
      [loanDbId, user.id],
    );
    const loan = rows[0];
    if (!loan) {
      await ctx.answerCallbackQuery("Loan not found or already closed");
      return;
    }

    await ctx.answerCallbackQuery();

    // Capture the live owed amount so the success message reflects what
    // was actually paid (not whatever stale value happens to be in the DB).
    const owedNow = await getLiveOwedLamports(loan);

    // ── Preflight: do they have enough SOL to actually repay? ──
    // Without this check the user gets a cryptic Solana simulation error
    // ("Transfer: insufficient lamports X, need Y") instead of a clear,
    // actionable message. Check BEFORE we even build the tx.
    try {
      const { publicKey } = await ensureWallet(user.id);
      const balanceLamports = BigInt(await connection.getBalance(new PublicKey(publicKey)));
      const needed = owedNow + REPAY_GAS_BUFFER_LAMPORTS;
      if (balanceLamports < needed) {
        const short = needed - balanceLamports;
        await ctx.editMessageText(
          [
            "⚠️ *Not enough SOL to repay*",
            "",
            `Loan #${loan.loan_id} · ${loan.symbol ?? "?"}`,
            `Owed: \`${fmtSol(owedNow)} SOL\` (plus ~0.003 SOL for fees)`,
            `Your wallet: \`${fmtSol(balanceLamports)} SOL\``,
            `Short by: *\`${fmtSol(short)} SOL\`*`,
            "",
            "*What to do:*",
            `• Send at least \`${fmtSol(short)} SOL\` to your Magpie wallet, then retry /repay`,
            "• Your deposit address: /deposit",
            "",
            "_Other options:_",
            "• /partialrepay — pay only part of the loan to reduce risk",
            "• /topup — add more collateral instead of paying down",
            "• /extend — push the due date out for a fee",
          ].join("\n"),
          { parse_mode: "Markdown" },
        );
        return;
      }
    } catch (err) {
      // Balance check itself failed (RPC blip) — log and continue to the
      // tx attempt rather than blocking the user.
      console.warn("[repay] preflight balance check failed:", err.message);
    }

    await ctx.editMessageText("⏳ Submitting repayment on-chain...");

    try {
      const result = await executeRepay({ userId: user.id, loanDbRow: loan });
      await markLoanRepaid(loan.id, result.signature);
      await incrementRepaid(user.id);

      // Build share + milestone celebration
      let shareKb;
      let milestoneLine = "";
      try {
        const { getOrCreateCode } = await import("../services/referrals.js");
        const { shareRepay, shareStreak, streakMilestone } = await import("../services/share-moments.js");
        const code = await getOrCreateCode(user.id);

        // Read the freshly-updated streak
        const { rows: [streakRow] } = await query(
          `SELECT current_streak, best_streak FROM users WHERE id = $1`,
          [user.id],
        );
        const streak = streakRow?.current_streak || 0;
        const milestone = streakMilestone(streak);

        const repayCard = shareRepay({
          symbol: loan.symbol ?? "TOKEN",
          originalLamports: loan.loan_amount_lamports,
          repaidLamports: owedNow,
          referralCode: code,
        });

        if (milestone) {
          // Hit a milestone — celebrate + offer streak-specific share
          milestoneLine = `\n🔥 *${streak} on-time repays in a row — milestone unlocked!*\n`;
          const streakCard = shareStreak({ streak, referralCode: code });
          shareKb = new InlineKeyboard()
            .url(`𝕏 Flex ${streak}-streak`, streakCard.twitterUrl)
            .row()
            .url("𝕏 Share repay", repayCard.twitterUrl)
            .url("📨 Tell a friend", repayCard.telegramShareUrl);
        } else if (streak > 0) {
          milestoneLine = `\n🔥 _On-time streak: ${streak}_\n`;
          shareKb = new InlineKeyboard()
            .url("𝕏 Share to Twitter", repayCard.twitterUrl)
            .url("📨 Tell a friend", repayCard.telegramShareUrl);
        } else {
          shareKb = new InlineKeyboard()
            .url("𝕏 Share to Twitter", repayCard.twitterUrl)
            .url("📨 Tell a friend", repayCard.telegramShareUrl);
        }
      } catch { /* non-critical */ }

      await ctx.editMessageText(
        [
          "✅ *Loan repaid*",
          "",
          `Loan #${loan.loan_id} · ${loan.symbol ?? "?"}`,
          `Repaid: ${fmtSol(owedNow)} SOL`,
          "Collateral returned to your wallet.",
          milestoneLine,
          `[View tx](https://solscan.io/tx/${result.signature})`,
        ].filter(Boolean).join("\n"),
        { parse_mode: "Markdown", disable_web_page_preview: true, reply_markup: shareKb },
      );
    } catch (err) {
      console.error("Repay failed:", err);
      const friendly = translateTxError(err, { flow: "repay", owedLamports: owedNow });
      await ctx.editMessageText(friendly, { parse_mode: "Markdown" });
    }
  });
}
