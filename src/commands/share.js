/**
 * /share — generate a share-ready summary of the user's Magpie activity
 * that they can fire off to Twitter/X or other Telegram chats in one tap.
 *
 * Defaults to their most recent repay (the "kept my bag" flex). Falls
 * back to active loan if no recent repay. Falls back to a generic
 * "I'm a magpie" share if they have no loan history.
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";
import { getOrCreateCode } from "../services/referrals.js";
import {
  shareBorrow,
  shareRepay,
  shareStreak,
  shareVolume,
  X_HANDLE,
} from "../services/share-moments.js";

export async function handleShare(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);
  const code = await getOrCreateCode(user.id);

  // Pull a few candidate share sources, pick the most flex-worthy
  const [lastRepay, activeLoan, streak] = await Promise.all([
    query(
      `SELECT l.loan_id, l.loan_amount_lamports, l.original_loan_amount_lamports,
              sm.symbol
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       WHERE l.user_id = $1 AND l.status = 'repaid'
       ORDER BY l.updated_at DESC LIMIT 1`,
      [user.id],
    ),
    query(
      `SELECT l.loan_id, l.loan_amount_lamports, l.ltv_percentage, l.duration_days,
              sm.symbol
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
       WHERE l.user_id = $1 AND l.status = 'active'
       ORDER BY l.start_timestamp DESC LIMIT 1`,
      [user.id],
    ),
    query(`SELECT current_streak FROM users WHERE id = $1`, [user.id]),
  ]);

  const currentStreak = streak.rows[0]?.current_streak ?? 0;

  let card;
  let label;
  if (lastRepay.rows[0]) {
    const r = lastRepay.rows[0];
    card = shareRepay({
      symbol: r.symbol ?? "TOKEN",
      originalLamports: r.loan_amount_lamports,
      repaidLamports: r.loan_amount_lamports, // simplification — actual repay = principal+fee
      referralCode: code,
    });
    label = `📤 Share your last repay (${r.symbol})`;
  } else if (activeLoan.rows[0]) {
    const l = activeLoan.rows[0];
    card = shareBorrow({
      symbol: l.symbol ?? "TOKEN",
      receiveLamports: l.loan_amount_lamports,
      ltvPct: l.ltv_percentage,
      durationDays: l.duration_days,
      referralCode: code,
    });
    label = `📤 Share your active loan (${l.symbol})`;
  } else {
    // Generic "I'm a magpie" — works even for non-borrowers
    card = {
      text: [
        `Just joined ${X_HANDLE} — Solana memecoin lending.`,
        "",
        "Borrow SOL against your bags. Don't sell. Build credit.",
        "",
        "Magpies collect shiny things ↓",
      ].join("\n"),
      twitterUrl: `https://twitter.com/intent/tweet?text=${encodeURIComponent(`Just joined ${X_HANDLE} — Solana memecoin lending. Borrow SOL against your bags. Don't sell. Build credit. #Solana #MAGPIE`)}&url=${encodeURIComponent(`https://t.me/magpie_capital_bot?start=${code}`)}`,
      telegramShareUrl: `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/magpie_capital_bot?start=${code}`)}&text=${encodeURIComponent("Just joined Magpie — borrow SOL against your memecoin bags without selling.")}`,
    };
    label = "📤 Share Magpie";
  }

  // Bonus: if they have a streak >=5, offer the streak-flex variant
  const streakOption = currentStreak >= 5 ? shareStreak({ streak: currentStreak, referralCode: code }) : null;

  const kb = new InlineKeyboard()
    .url("𝕏 Share on Twitter", card.twitterUrl)
    .row()
    .url("📨 Forward in Telegram", card.telegramShareUrl);

  if (streakOption) {
    kb.row().url(`🔥 Flex ${currentStreak}-streak on 𝕏`, streakOption.twitterUrl);
  }

  const preview = [
    "*Share card preview:*",
    "",
    "```",
    card.text,
    "```",
    "",
    "_Sharing gives you credit for anyone who joins via your link. 10% of their lifetime fees ↑ to you._",
  ].join("\n");

  await ctx.reply(preview, {
    parse_mode: "Markdown",
    reply_markup: kb,
    disable_web_page_preview: true,
  });
}
