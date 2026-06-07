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

/**
 * Pip-as-coach for /me — surface the single most useful next move based
 * on the user's account state. Priority ordered: liquidations need
 * recovery > active loans need attention > new user needs first action
 * > healthy user gets a forward-looking nudge.
 */
function mePipCoachLine({
  activeLoans, solBalance, repaidCount, liquidatedCount,
  availableToBorrow, streak, bestStreak, referredCount,
}) {
  const lamports = (sol) => sol * 1e9;

  // Brand-new user (never borrowed)
  if (repaidCount === 0 && liquidatedCount === 0 && activeLoans === 0) {
    if (solBalance < lamports(0.01)) {
      return `Your wallet's empty. Send ~0.01 SOL for gas + your collateral tokens to get started — see /deposit for the address.`;
    }
    return `Ready when you are. Start small: /borrow → pick a token, pick a tier, get SOL in seconds. Your first clean repay = ~15 credit points.`;
  }

  // Active loans waiting on action
  if (activeLoans > 0) {
    if (streak >= 5) {
      return `${activeLoans} active. ${streak}-loan streak — keep it tight. Run /positions for live health on each.`;
    }
    return `${activeLoans} active loan${activeLoans === 1 ? "" : "s"} — /positions for live health on each.`;
  }

  // Just had a liquidation
  if (liquidatedCount > 0 && repaidCount === 0) {
    return `Liquidation behind you. Quickest credit recovery: open a small loan and repay it cleanly. One clean cycle ≈ +15 points.`;
  }
  if (liquidatedCount > repaidCount * 0.5) {
    return `Liquidation rate is heavy on the score. A few clean repays in a row will rebuild fast — start small, pay early.`;
  }

  // Active streak
  if (streak >= 3) {
    return `🔥 ${streak} on-time repays in a row. You're racking up credit. Available to borrow: ${(availableToBorrow/1e9).toFixed(2)} SOL if you want to extend the run.`;
  }

  // Healthy idle user
  if (repaidCount >= 1 && activeLoans === 0) {
    if (solBalance > lamports(0.5)) {
      return `${(solBalance/1e9).toFixed(2)} SOL idle. Consider /lend for ~80% of fees pro-rata, or /borrow if you have a bag to put to work.`;
    }
    return `Track record looks clean. /borrow when you're ready, or /refer to earn 5% of friends' loan fees lifetime.`;
  }

  // Default: healthy general
  if (referredCount === 0 && repaidCount > 0) {
    return `You've got the playbook down. /refer earns you 5% of every loan fee your friends pay, in SOL, lifetime.`;
  }
  return null;
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

  // Pip-as-coach: one warm line at the bottom that reads the account
  // and surfaces ONE clear next-best-action. Pure prose; no data the
  // user can't already see above.
  const coachLine = mePipCoachLine({
    activeLoans: activeRow.rows[0].n,
    solBalance: Number(sol),
    repaidCount: stats.repaid_count,
    liquidatedCount: stats.liquidated_count,
    availableToBorrow: Number(limits.availableToBorrow),
    streak: streak.current_streak,
    bestStreak: streak.best_streak,
    referredCount: refs.total,
  });
  if (coachLine) {
    lines.push("", `🦅 *Pip:* _${coachLine}_`);
  }

  const { InlineKeyboard } = await import("grammy");
  const kb = new InlineKeyboard()
    .text("🏠 Home", "start:home")
    .text("💰 Borrow", "start:borrow")
    .row()
    .text("📋 Wallet", "fallback:deposit")
    .text("🔐 Security", "me:security");

  await ctx.reply(lines.filter((l) => l != null).join("\n"), {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: kb,
  });
}

export function registerMeCallbacks(bot) {
  bot.callbackQuery("me:security", async (ctx) => {
    await ctx.answerCallbackQuery();
    // Lazy-import to avoid circular dependency with services that may
    // touch this module.
    const { handleSecurity } = await import("./security.js");
    await handleSecurity(ctx);
  });
}
