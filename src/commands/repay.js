import { InlineKeyboard } from "grammy";
import { PublicKey } from "@solana/web3.js";
import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";
import { executeRepay, markLoanRepaid, getLiveOwedLamports, checkLoanOwnership } from "../services/loans.js";
import { scopeLoansToActiveWallet } from "../services/wallet-scoped-loans.js";
import { ensureWallet } from "../services/wallet.js";
import { connection } from "../solana/connection.js";
import { incrementRepaid } from "../services/reputation.js";
import { translateTxError, errorActionKeyboard, renderWalletMismatchMessage } from "../services/tx-error-translator.js";

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

  // Scope to the user's CURRENTLY ACTIVE wallet — multi-wallet users
  // were seeing every loan across every wallet and (a) being confused
  // about which were theirs to sign for, (b) hitting InvalidAccountData
  // signing errors when they picked a loan from a non-active wallet.
  const { filtered: scopedRows, otherWalletCount } =
    await scopeLoansToActiveWallet(user.id, rows);

  if (scopedRows.length === 0) {
    return ctx.reply(
      `📭 No active loans on your *current* wallet.\n\n` +
      (otherWalletCount > 0
        ? `You have *${otherWalletCount}* loan${otherWalletCount === 1 ? "" : "s"} on other linked wallets. Use /wallets to switch, then /repay.`
        : `Nothing to repay anywhere on this account.`),
      { parse_mode: "Markdown" },
    );
  }

  // Read live on-chain amount for each scoped loan in parallel
  const liveAmounts = await Promise.all(scopedRows.map(getLiveOwedLamports));

  const kb = new InlineKeyboard();
  scopedRows.forEach((loan, i) => {
    kb.text(
      `#${loan.loan_id} · ${loan.symbol ?? "?"} · ${fmtSol(liveAmounts[i])} SOL`,
      `repay:loan:${loan.id}`,
    ).row();
  });
  kb.text("✕ Cancel", "repay:cancel");

  const header = `*Pick a loan to repay:*` +
    (otherWalletCount > 0
      ? `\n_Showing loans on your active wallet. ${otherWalletCount} more on other linked wallets — switch with /wallets to see them._`
      : "");
  await ctx.reply(header, {
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
    // Ack the callback IMMEDIATELY so the loading spinner stops and
    // the user gets visual feedback within ~50ms. Without this, the
    // button can spin indefinitely if any pre-flight (DB lookup, RPC
    // balance check, etc.) takes long under load — e.g., when Jupiter
    // is rate-limiting and our PriceAttestor falls back per-mint. We
    // wrap in .catch() because if grammy already answered for any
    // reason, a re-answer throws and we don't want that to abort the
    // rest of the handler.
    await ctx.answerCallbackQuery().catch(() => {});

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
      // We already ack'd above, so use editMessageText (replaces the
      // notification body) instead of the popup-style answerCallbackQuery
      // text we used to surface here.
      await ctx.editMessageText("❌ Loan not found or already closed.").catch(() => {});
      return;
    }

    // Capture the live owed amount so the success message reflects what
    // was actually paid (not whatever stale value happens to be in the DB).
    const owedNow = await getLiveOwedLamports(loan);

    // ── Preflight: wallet ownership check ──
    // Loans have an on-chain has_one = borrower constraint. If the user
    // ran /import and switched wallets after borrowing, the tx will fail
    // with ConstraintHasOne. Catch it BEFORE building the tx so they get
    // a clear explanation instead of a cryptic Anchor error.
    const ownership = await checkLoanOwnership(user.id, loan);
    if (!ownership.ok && ownership.reason === "wallet_mismatch") {
      await ctx.editMessageText(
        renderWalletMismatchMessage(ownership, "repay"),
        { parse_mode: "Markdown" },
      );
      return;
    }

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
        // Add 0.001 SOL safety margin to the deposit amount we
        // recommend, so users who follow the instruction exactly
        // don't end up still ~1k lamports short.
        const recommendedSend = short + 1_000_000n;
        await ctx.editMessageText(
          [
            "⚠️ *Your wallet doesn't have enough SOL*",
            "",
            "Repaying a loan needs the *loan amount + Solana network fees*. Here's the math:",
            "",
            `Loan #${loan.loan_id} · ${loan.symbol ?? "?"}`,
            `Loan owed:      \`${fmtSol(owedNow)} SOL\``,
            `Network fees:   \`~0.003 SOL\` _(Solana charges for every tx)_`,
            `*Need total:*   \`${fmtSol(needed)} SOL\``,
            "",
            `Your wallet:    \`${fmtSol(balanceLamports)} SOL\``,
            `*You're short:* *\`${fmtSol(short)} SOL\`*`,
            "",
            "*Three ways to fix this:*",
            `1. *Send ~\`${fmtSol(recommendedSend)} SOL\`* to your Magpie wallet, then retry /repay`,
            "   (tap *Deposit* below for your address)",
            "2. */partialrepay* — pay only what you can, reduce liquidation risk",
            "3. */topup* — add more collateral instead of paying SOL",
            "4. */extend* — push the due date out for a small fee",
            "",
            "_Not sure what to do? Tap *Ask the agent* — they'll walk you through it._",
          ].join("\n"),
          {
            parse_mode: "Markdown",
            reply_markup: errorActionKeyboard({ flow: "repay", errorKind: "insufficient_sol" }),
          },
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
      // Detect what kind of error so the "Ask the agent" button hands
      // over precise context (insufficient_sol vs blockhash_expired etc.)
      const raw = (err?.message || "").toString();
      const logs = Array.isArray(err?.logs) ? err.logs.join("\n") : "";
      const blob = raw + "\n" + logs;
      const kind =
        /insufficient lamports|custom program error: 0x1/i.test(blob) ? "insufficient_sol"
        : /BlockhashNotFound|blockhash not found/i.test(blob) ? "blockhash_expired"
        : /fetch failed|ECONNRESET|ETIMEDOUT/i.test(raw) ? "rpc_blip"
        : /Signature verification|missing signer/i.test(blob) ? "signature_failed"
        : /AccountAlreadyInUse|AccountNotInitialized/i.test(blob) ? "state_mismatch"
        : /AnchorError/i.test(blob) ? "anchor_error"
        : "tx_error";
      await ctx.editMessageText(friendly, {
        parse_mode: "Markdown",
        reply_markup: errorActionKeyboard({ flow: "repay", errorKind: kind }),
      });
    }
  });
}
