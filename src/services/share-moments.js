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
const SITE = "https://magpie.capital";
// Official X / Twitter handle. NOT the same as the Telegram bot's
// @magpie_capital_bot username. Single source of truth — keep all
// share copy using this constant so the handle never drifts.
export const X_HANDLE = "@MagpieLoans";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

// For TG share-card buttons in-bot we still send users to the bot
// (it's a Telegram-native flow). For external shares (Twitter), we
// route through the site so the link unfurls into a nice OG card,
// AND the site has a CTA back to the bot.
function refLink(referralCode) {
  return referralCode
    ? `https://t.me/magpie_capital_bot?start=${referralCode}`
    : "https://t.me/magpie_capital_bot";
}

// Site landing URL for borrow share. Renders branded OG card on
// Twitter/X + funnels visitors to the bot via the embedded CTA.
function borrowShareUrl(symbol, receiveSol, refCode, ltvPct, days) {
  const params = new URLSearchParams();
  if (refCode) params.set("ref", refCode);
  if (ltvPct != null) params.set("ltv", String(ltvPct));
  if (days != null) params.set("days", String(days));
  const qs = params.toString();
  const path = `/share/borrow/${encodeURIComponent(symbol)}/${encodeURIComponent(receiveSol)}`;
  return `${SITE}${path}${qs ? "?" + qs : ""}`;
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
  const receiveSol = fmtSol(receiveLamports);
  const text = [
    `Just unlocked ${receiveSol} SOL against my $${symbol} bag on ${X_HANDLE}`,
    "",
    `Why sell when you can borrow? ${ltvPct}% LTV · ${durationDays}d term`,
    "",
    `Your turn ↓`,
  ].join("\n");
  // Twitter shares use the site landing URL so the card unfurls nicely.
  // Telegram forwards use the bot URL (native flow).
  const siteUrl = borrowShareUrl(symbol, receiveSol, referralCode, ltvPct, durationDays);
  const botUrl = refLink(referralCode);
  return {
    text,
    twitterUrl: twitterIntent(text + " " + BRAND_HASHTAGS, siteUrl),
    telegramShareUrl: telegramShare(text, botUrl),
  };
}

/**
 * Share card for "just repaid" — emphasizes "kept my bag, paid $X fee".
 */
export function shareRepay({ symbol, originalLamports, repaidLamports, referralCode }) {
  const fee = Number(repaidLamports) - Number(originalLamports);
  const feeStr = fee > 0 ? `${(fee / 1e9).toFixed(4)} SOL` : "the fee";
  const text = [
    `Just closed out my $${symbol} loan on ${X_HANDLE}`,
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
    `🔥 ${streak} on-time repays in a row on ${X_HANDLE}`,
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
    `Just crossed ${totalSol.toFixed(1)} SOL lifetime borrowed on ${X_HANDLE}`,
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
