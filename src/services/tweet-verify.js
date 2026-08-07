/**
 * tweet-verify.js — "Tweet your loan" share-to-earn.
 * ─────────────────────────────────────────────────────────────────────────
 * Two responsibilities, shared by the TG bot AND the site:
 *   1. buildLoanTweet() / loanTweetIntentUrl() — the CANONICAL pre-filled tweet
 *      (their collateral ticker + $MAGPIE + the brand line + link). One source of
 *      truth so every surface flexes the exact same clean copy.
 *   2. verifyTweet() — proves a pasted tweet URL is a real, PUBLIC tweet that
 *      actually mentions @MagpieLoans and $MAGPIE, so points are only ever awarded
 *      for a real post (verify-to-earn, not award-on-click — un-farmable, and
 *      idempotent per loan at the points-ledger layer).
 *
 * Verification uses Twitter/X's public oEmbed endpoint (no API key, no auth):
 * publish.twitter.com/oembed returns the tweet's rendered HTML for PUBLIC tweets
 * only (404/error for private/deleted), and that HTML contains the tweet text —
 * enough to confirm the required mentions without paying for the X API.
 */

const HANDLE = "MagpieLoans"; // x.com/MagpieLoans
const SITE = "magpie.capital";
const BRAND_LINE = "Collateral that can still sell itself.";

/** Sanitize a collateral symbol for safe interpolation into tweet text. */
function safeTicker(sym) {
  const s = String(sym || "TOKEN").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return s || "TOKEN";
}

/**
 * The canonical loan tweet. `armedAutoSell` swaps in the V4 auto-sell flex line
 * ONLY when the borrower actually armed an exit — never over-promise (auto-sell
 * is V4-only, no guaranteed fills).
 */
export function buildLoanTweet({ collateralSymbol, armedAutoSell = false }) {
  const t = safeTicker(collateralSymbol);
  if (armedAutoSell) {
    return (
      `Borrowed SOL against my $${t} on @${HANDLE} 🐦‍⬛ and set it to auto-sell itself at my target while the loan runs. Bag stays mine.\n\n` +
      `${BRAND_LINE} $MAGPIE\n→ ${SITE}`
    );
  }
  return (
    `Borrowed SOL against my $${t} on @${HANDLE} 🐦‍⬛ — kept my bag, no forced sale, instant liquidity.\n\n` +
    `${BRAND_LINE} $MAGPIE\n→ ${SITE}`
  );
}

/** X "compose tweet" intent URL with the canonical copy pre-filled. */
export function loanTweetIntentUrl(opts) {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(buildLoanTweet(opts))}`;
}

const TWEET_URL_RE =
  /^https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status\/(\d{10,25})(?:[/?#].*)?$/i;

/**
 * Verify a pasted tweet URL is a real, PUBLIC tweet that mentions @MagpieLoans
 * AND $MAGPIE. Returns { ok, reason?, tweetId?, authorHandle? }. Fail-closed:
 * any ambiguity → not verified (so we never award points for an unverifiable post).
 */
export async function verifyTweet(url) {
  const raw = String(url || "").trim();
  const m = raw.match(TWEET_URL_RE);
  if (!m) {
    return { ok: false, reason: "That isn't a tweet link. Paste the full URL of your post (twitter.com/… or x.com/…/status/…)." };
  }
  const authorHandle = m[1];
  const tweetId = m[2];

  let data;
  try {
    const r = await fetch(
      `https://publish.twitter.com/oembed?omit_script=true&hide_thread=true&dnt=true&url=${encodeURIComponent(raw)}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
    );
    if (r.status === 404) {
      return { ok: false, reason: "Couldn't find that tweet — make sure it's public (not protected/deleted) and try again." };
    }
    if (!r.ok) {
      return { ok: false, reason: "Couldn't verify the tweet right now — give it a minute and try again." };
    }
    data = await r.json();
  } catch {
    return { ok: false, reason: "Couldn't reach X to verify the tweet — try again in a moment." };
  }

  const html = String(data?.html ?? "");
  // Strip tags + decode the couple of entities that appear in tweet text.
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
  const lower = text.toLowerCase();

  if (!lower.includes(`@${HANDLE.toLowerCase()}`) && !lower.includes(HANDLE.toLowerCase())) {
    return { ok: false, reason: `The tweet has to mention @${HANDLE}. Use the pre-filled tweet from the Share button.` };
  }
  if (!/\$magpie\b/i.test(text) && !lower.includes("$magpie")) {
    return { ok: false, reason: "The tweet has to include $MAGPIE. Use the pre-filled tweet from the Share button." };
  }
  return { ok: true, tweetId, authorHandle };
}
