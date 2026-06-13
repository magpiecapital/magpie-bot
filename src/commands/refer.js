/**
 * /refer — show the user's referral code, share link, lifetime earnings,
 * and a button to claim their accrued SOL payout.
 *
 * Economics: 5% of every loan fee from users they bring in. Sourced from
 * the protocol's share — LPs are unaffected. Paid out in SOL on demand.
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { getOrCreateCode } from "../services/referrals.js";
import {
  getReferralSummary,
  getReferralRewardBps,
  MIN_CLAIM_LAMPORTS,
} from "../services/referral-rewards.js";

const BOT_USERNAME = process.env.BOT_USERNAME || "magpie_capital_bot";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(6);
}

export async function handleRefer(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);
  const code = await getOrCreateCode(user.id);
  const [summary, liveBps] = await Promise.all([
    getReferralSummary(user.id),
    getReferralRewardBps(),
  ]);

  const shareLink = `https://t.me/${BOT_USERNAME}?start=${code}`;
  const pct = (liveBps / 100).toFixed(0);

  const lines = [
    "🎁 *Magpie Referral Program*",
    "",
    `Earn *${pct}% of every loan fee* from users you invite. Paid in SOL, lifetime — they take a loan, you earn.`,
    "",
    "*Your share link:*",
    `\`${shareLink}\``,
    "",
    "*Your code:* `" + code + "`",
    "",
    "*Stats:*",
    `• Invited: ${summary.referred_count} user${summary.referred_count === 1 ? "" : "s"}`,
    `• Of those, borrowed: ${summary.borrowed_count}`,
    `• Lifetime earned: \`${fmtSol(summary.lifetime_lamports)} SOL\``,
    `• Already paid out: \`${fmtSol(summary.paid_lamports)} SOL\``,
    `• *Claimable now:* \`${fmtSol(summary.claimable_lamports)} SOL\``,
  ];

  if (summary.claimable_lamports > 0n && summary.claimable_lamports < MIN_CLAIM_LAMPORTS) {
    lines.push("", `_Minimum to claim: ${fmtSol(MIN_CLAIM_LAMPORTS)} SOL — keep referring._`);
  }

  const shareText = encodeURIComponent(
    `🏦 I'm using Magpie to borrow SOL against my memecoin bags — instant, no liquidation surprises. Join me: ${shareLink}`,
  );

  const kb = new InlineKeyboard()
    .url("📲 Share on Telegram", `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${shareText}`)
    .row();

  if (summary.claimable_lamports >= MIN_CLAIM_LAMPORTS) {
    kb.text(`💸 Claim ${fmtSol(summary.claimable_lamports)} SOL`, "refer:claim").row();
  }

  kb.text("🏠 Home", "start:home");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
    disable_web_page_preview: true,
  });
}

export function registerReferCallbacks(bot) {
  bot.callbackQuery("refer:claim", async (ctx) => {
    await ctx.answerCallbackQuery();

    const user = await upsertUser(ctx.from.id, ctx.from.username);

    // Look up the user's custodial wallet address — that's where the SOL goes.
    const { ensureWallet } = await import("../services/wallet.js");
    const wallet = await ensureWallet(user.id);
    if (!wallet?.publicKey) {
      return ctx.reply(
        "You don't have a Magpie wallet yet. Run /start to create one, then try claiming again.",
      );
    }

    await ctx.editMessageText("⏳ Sending your referral payout on-chain...");

    try {
      const { claimReferralEarnings } = await import("../services/referral-rewards.js");
      const result = await claimReferralEarnings({
        userId: user.id,
        recipientPublicKey: wallet.publicKey,
      });

      if (!result.ok) {
        const msg =
          result.reason === "nothing_to_claim"
            ? "No claimable rewards right now."
            : result.reason === "below_minimum"
            ? `Below minimum claim (${fmtSol(result.minimum_lamports)} SOL). Current: ${fmtSol(result.accrued_lamports)} SOL.`
            : result.reason === "treasury_low"
            ? "Treasury is temporarily low. Try again in a few hours."
            : `Could not process claim (${result.reason}).`;
        return ctx.editMessageText(msg);
      }

      await ctx.editMessageText(
        [
          "✅ *Referral payout sent*",
          "",
          `Paid: \`${fmtSol(result.paid_lamports)} SOL\``,
          `Events: ${result.row_count}`,
          "",
          `[View tx](https://solscan.io/tx/${result.signature})`,
        ].join("\n"),
        { parse_mode: "Markdown", disable_web_page_preview: true },
      );
    } catch (err) {
      console.error("[refer] claim failed:", err);
      await ctx.editMessageText(
        `Claim failed: ${err.message?.slice(0, 100) || "unknown error"}\n\nTry /refer again.`,
      );
    }
  });
}
