/**
 * Share Moments — turn every successful Magpie action into a viral
 * marketing channel.
 *
 * Generates well-formatted share text + share-intent URLs (Twitter/X +
 * Telegram forward) that users can fire in one tap. Each share carries
 * a referral link so the sharer gets credit for any new user that joins.
 *
 * Three share contexts:
 *   - "borrow"  — just took a loan ("unlocked X SOL without selling")
 *   - "repay"   — just closed a loan ("kept my bag, paid $Y fee")
 *   - "streak"  — hit an on-time milestone
 *
 * Returns: { text, twitterUrl, telegramShareUrl }
 */

const BRAND_HASHTAGS = "#Solana #MAGPIE";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

function refLink(referralCode) {
  return referralCode
    ? `https://t.me/magpie_capital_bot?start=${referralCode}`
    : "https://t.me/magpie_capital_bot";
}

function twitterIntent(text, url) {
  // Note: t.co will auto-shorten the URL when posted
  const params = new URLSearchParams({ text, url });
  return `https://twitter.com/intent/tweet?${params.toString()}`;
}

function telegramShare(text, url) {
  const params = new URLSearchParams({ url, text });
  return `https://t.me/share/url?${params.toString()}`;
}

/**
 * Share card for "just borrowed".
 */
export function shareBorrow({ symbol, receiveLamports, ltvPct, durationDays, referralCode }) {
  const text = [
    `Just unlocked ${fmtSol(receiveLamports)} SOL against my $${symbol} bag on @magpie_capital`,
    "",
    `Why sell when you can borrow? ${ltvPct}% LTV · ${durationDays}d term`,
    "",
    `Your turn ↓`,
  ].join("\n");
  const url = refLink(referralCode);
  return {
    text,
    twitterUrl: twitterIntent(text + " " + BRAND_HASHTAGS, url),
    telegramShareUrl: telegramShare(text, url),
  };
}

/**
 * Share card for "just repaid" — emphasizes "kept my bag, paid $X fee".
 */
export function shareRepay({ symbol, originalLamports, repaidLamports, referralCode }) {
  const fee = Number(repaidLamports) - Number(originalLamports);
  const feeStr = fee > 0 ? `${(fee / 1e9).toFixed(4)} SOL` : "the fee";
  const text = [
    `Just closed out my $${symbol} loan on @magpie_capital`,
    "",
    `Borrowed ${fmtSol(originalLamports)} SOL · repaid for ${feeStr} fee · kept the full bag.`,
    "",
    `Liquidity without selling. Try it ↓`,
  ].join("\n");
  const url = refLink(referralCode);
  return {
    text,
    twitterUrl: twitterIntent(text + " " + BRAND_HASHTAGS, url),
    telegramShareUrl: telegramShare(text, url),
  };
}

/**
 * Share card for "hit a streak milestone".
 */
export function shareStreak({ streak, referralCode }) {
  const text = [
    `🔥 ${streak} on-time repays in a row on @magpie_capital`,
    "",
    `Building real on-chain credit. Liquidity without selling memecoins.`,
    "",
    `Join the magpies ↓`,
  ].join("\n");
  const url = refLink(referralCode);
  return {
    text,
    twitterUrl: twitterIntent(text + " " + BRAND_HASHTAGS, url),
    telegramShareUrl: telegramShare(text, url),
  };
}

/**
 * Share card for "lifetime borrowed milestone".
 */
export function shareVolume({ totalSol, referralCode }) {
  const text = [
    `Just crossed ${totalSol.toFixed(1)} SOL lifetime borrowed on @magpie_capital`,
    "",
    `Memecoin bags as collateral. Never had to sell.`,
    "",
    `Magpie collects shiny things ↓`,
  ].join("\n");
  const url = refLink(referralCode);
  return {
    text,
    twitterUrl: twitterIntent(text + " " + BRAND_HASHTAGS, url),
    telegramShareUrl: telegramShare(text, url),
  };
}

/**
 * Milestone tier detection — given a number, returns whether it's a
 * milestone worth celebrating (5/10/25/50/100 for streaks; 1/5/10/25/50
 * SOL for volume). Returns null if not a milestone.
 */
export function streakMilestone(streak) {
  const tiers = [5, 10, 25, 50, 100, 250];
  return tiers.includes(streak) ? streak : null;
}

export function volumeMilestone(lifetimeSol) {
  // Granular at low end, coarse at high end
  const tiers = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
  // Match if we just crossed one (i.e., previousSol < tier <= lifetimeSol)
  // Caller is responsible for passing in the previous total; this just
  // returns the highest tier currently met.
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (lifetimeSol >= tiers[i]) return tiers[i];
  }
  return null;
}
