/**
 * /holders — $MAGPIE holder dashboard inside Telegram.
 *
 * Shows the user's on-chain $MAGPIE balance, their claimable holder
 * reward balance (paid out weekly), and lets them claim accrued SOL
 * directly to their custodial wallet.
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import {
  getHolderInfoByWallet,
  getHolderPoolState,
  claimHolderRewards,
  HOLDER_REWARD_BPS,
  MIN_HOLDER_CLAIM_LAMPORTS,
} from "../services/magpie-holder-rewards.js";

const MAGPIE_PUMP_URL = "https://pump.fun/coin/9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(6);
}

function fmtMagpie(rawAmount) {
  const n = Number(rawAmount) / 1e6;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

export async function handleHolders(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);
  const wallet = await ensureWallet(user.id);

  const [info, pool] = await Promise.all([
    getHolderInfoByWallet(wallet.publicKey),
    getHolderPoolState(),
  ]);

  const pct = (HOLDER_REWARD_BPS / 100).toFixed(0);
  const lines = [
    "💎 *$MAGPIE Holder Rewards*",
    "",
    `*${pct}% of every loan fee* accrues to $MAGPIE holders, distributed weekly. Held in your wallet — no staking needed.`,
    "",
    "*Your wallet:*",
    `\`${wallet.publicKey}\``,
    "",
    `Balance: *${fmtMagpie(info.balance_raw)} MAGPIE*`,
    "",
    "*Your rewards:*",
    `• Lifetime earned: \`${fmtSol(info.lifetime_lamports)} SOL\``,
    `• Already paid out: \`${fmtSol(info.paid_lamports)} SOL\``,
    `• Claimable now: \`${fmtSol(info.claimable_lamports)} SOL\``,
    `• Distributions received: ${info.distributions_count}`,
    "",
    "*Current pool (accruing):*",
    `\`${fmtSol(pool.accrued_lamports)} SOL\` waiting for next snapshot`,
  ];

  if (!info.has_balance) {
    lines.push("", "_You don't hold $MAGPIE yet — grab some to start earning your share of every loan fee._");
  } else if (info.claimable_lamports > 0n && info.claimable_lamports < MIN_HOLDER_CLAIM_LAMPORTS) {
    lines.push("", `_Minimum claim: ${fmtSol(MIN_HOLDER_CLAIM_LAMPORTS)} SOL — wait for more rewards to accumulate._`);
  }

  const kb = new InlineKeyboard();
  if (info.claimable_lamports >= MIN_HOLDER_CLAIM_LAMPORTS) {
    kb.text(`💸 Claim ${fmtSol(info.claimable_lamports)} SOL`, "holders:claim").row();
  }
  if (!info.has_balance) {
    kb.url("Buy $MAGPIE on pump.fun", MAGPIE_PUMP_URL).row();
  }
  kb.text("🏠 Home", "start:home");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
    disable_web_page_preview: true,
  });
}

export function registerHoldersCallbacks(bot) {
  bot.callbackQuery("holders:claim", async (ctx) => {
    await ctx.answerCallbackQuery();

    const user = await upsertUser(ctx.from.id, ctx.from.username);
    const wallet = await ensureWallet(user.id);

    await ctx.editMessageText("⏳ Sending your holder payout on-chain...");

    try {
      const result = await claimHolderRewards({ walletAddress: wallet.publicKey });
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
          "✅ *Holder payout sent*",
          "",
          `Paid: \`${fmtSol(result.paid_lamports)} SOL\``,
          `Distributions: ${result.row_count}`,
          "",
          `[View tx](https://solscan.io/tx/${result.signature})`,
        ].join("\n"),
        { parse_mode: "Markdown", disable_web_page_preview: true },
      );
    } catch (err) {
      console.error("[holders] claim failed:", err);
      await ctx.editMessageText(
        `Claim failed: ${err.message?.slice(0, 100) || "unknown error"}\n\nTry /holders again.`,
      );
    }
  });
}
