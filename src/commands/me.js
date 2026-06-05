/**
 * /me — single-screen personal summary: wallet balance, reputation tier,
 * referral code, and lifetime stats.
 */
import { upsertUser } from "../services/users.js";
import { ensureWallet, listWallets } from "../services/wallet.js";
import { getSolBalance } from "../services/deposits.js";
import { tierFor, nextTierHint, getUserStats } from "../services/reputation.js";
import { getOrCreateCode, referralStats } from "../services/referrals.js";
import { getLoanLimits } from "../services/loan-limits.js";
import { getSiteLock } from "../services/site-lock.js";
import { query } from "../db/pool.js";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

function shortPubkey(pk) {
  return pk ? `${pk.slice(0, 6)}…${pk.slice(-4)}` : "?";
}

export async function handleMe(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  const [sol, stats, code, refs, activeRow, botInfo, limits, streakRow, wallets, siteLock] = await Promise.all([
    getSolBalance(publicKey),
    getUserStats(user.id),
    getOrCreateCode(user.id),
    referralStats(user.id),
    query(`SELECT COUNT(*)::int AS n FROM loans WHERE user_id = $1 AND status = 'active'`, [user.id]),
    ctx.api.getMe(),
    getLoanLimits(user.id),
    query(`SELECT current_streak, best_streak FROM users WHERE id = $1`, [user.id]),
    listWallets(user.id),
    getSiteLock(user.id),
  ]);
  const streak = streakRow.rows[0] || { current_streak: 0, best_streak: 0 };

  const tier = tierFor(stats);
  const hint = nextTierHint(stats);
  const shareLink = `https://t.me/${botInfo.username}?start=${code}`;

  const lines = [
    `👤 *${tgUser.username ? "@" + tgUser.username : "You"}*`,
    "",
    `Tier: ${tier.emoji} *${tier.label}*`,
  ];
  if (hint) {
    lines.push(`  ↳ ${hint.repaysNeeded} more repay(s) → ${hint.next.emoji} ${hint.next.label}`);
  }
  // Wallet section — single line if one wallet, full list if multiple.
  // Showing every wallet here means users see at a glance what's loaded
  // into their account without having to dig into /wallets.
  if (wallets.length <= 1) {
    lines.push(
      "",
      "*Wallet*",
      `\`${publicKey}\``,
      `Balance: ${fmtSol(sol)} SOL`,
      `Active loans: ${activeRow.rows[0].n}`,
      "",
    );
  } else {
    lines.push(
      "",
      `*Wallets* (${wallets.length} loaded · /wallets to switch)`,
    );
    for (const w of wallets) {
      const flag = w.isActive ? "✅" : "⚪️";
      const note = w.isActive ? " *(active)*" : "";
      lines.push(`${flag} *${w.label}*${note}  \`${shortPubkey(w.publicKey)}\``);
    }
    lines.push(
      `Active-wallet balance: ${fmtSol(sol)} SOL`,
      `Active loans: ${activeRow.rows[0].n}`,
      "",
    );
  }
  lines.push(
    "*Loan limits*",
    `Tier: *${limits.tier}*`,
    `Max per loan: ${fmtSol(limits.maxPerLoan)} SOL`,
    `Max outstanding: ${fmtSol(limits.maxOutstanding)} SOL`,
    `Available: ${fmtSol(limits.availableToBorrow)} SOL`,
    "",
    "*Lifetime stats*",
    `Loans repaid:      ${stats.repaid_count}`,
    `Loans liquidated:  ${stats.liquidated_count}`,
    `Total borrowed:    ${fmtSol(stats.total_borrowed_lamports)} SOL`,
    streak.current_streak > 0
      ? `On-time streak:   🔥 *${streak.current_streak}* (best: ${streak.best_streak})`
      : (streak.best_streak > 0 ? `Best streak:      ${streak.best_streak}` : null),
    "",
    "*Referrals*",
    `Code: \`${code}\``,
    `Share: ${shareLink}`,
    `Referred: ${refs.total}`,
  );

  if (siteLock.locked) {
    const until = siteLock.until.toISOString().slice(0, 16).replace("T", " ");
    lines.push(
      "",
      `🔒 *Site actions locked until ${until} UTC* — run \`/lock 0\` to clear.`,
    );
  }

  const { InlineKeyboard } = await import("grammy");
  const kb = new InlineKeyboard()
    .text("🏠 Home", "start:home")
    .text("💰 Borrow", "start:borrow")
    .text("📋 Wallet", "fallback:deposit");

  await ctx.reply(lines.filter((l) => l != null).join("\n"), {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: kb,
  });
}
