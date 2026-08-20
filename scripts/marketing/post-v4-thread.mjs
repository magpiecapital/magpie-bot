#!/usr/bin/env node
/**
 * Post the V4 launch thread to @MagpieLoans: the only-protocol contrast,
 * the demo video, and LIVE on-chain numbers (computed at post time — never
 * hardcoded, per feedback_public_claims_must_be_computed_not_hardcoded).
 *
 * Usage:  railway run node scripts/marketing/post-v4-thread.mjs [--post]
 * Without --post: dry run (prints the thread, uploads nothing).
 */
import { uploadVideo, postTweetRich, xPosterConfigured } from "../../src/services/x-poster.js";

const POST = process.argv.includes("--post");
const VIDEO = process.env.HOME + "/magpie-site/public/media/how-it-works.mp4";

// ── live numbers (fail closed: no stats → no thread)
const res = await fetch("https://www.magpie.capital/api/v1/stats", { signal: AbortSignal.timeout(20_000) });
const stats = (await res.json())?.data;
if (!stats?.totalLoansOriginated) { console.error("ABORT: live stats unavailable"); process.exit(1); }

const repaidPct = ((stats.repaidLoans / (stats.repaidLoans + stats.liquidatedLoans)) * 100).toFixed(1);
const sol = Math.round(stats.totalSolLent).toLocaleString("en-US");
const loans = stats.totalLoansOriginated.toLocaleString("en-US");
const users = stats.totalUsers.toLocaleString("en-US");
const armed = stats.limitCloseEngine?.armedOrdersNow;

const t1 = `A normal loan locks your collateral away.

The market spikes — you just watch.

Not here. Magpie is the only Solana protocol where your collateral can still sell itself while the loan stays active.

60 seconds, sound on:`;

const t2 = `How it works:

→ Borrow SOL against memecoins, tokenized stocks, or collectibles
→ Arm a take-profit ladder or stop-loss on the collateral itself
→ Targets hit → slices sell in-vault → you never miss the candle

Fixed terms. No margin calls.`;

const t3 = `The receipts (on-chain, live):

• ${loans} loans originated
• ${repaidPct}% repaid
• ${sol} SOL lent to ${users} users${Number.isFinite(armed) ? `\n• ${armed} exit orders armed right now` : ""}

magpie.capital`;

console.log("── THREAD ──\n" + [t1, t2, t3].join("\n\n─────\n") + "\n────────────");
for (const [i, t] of [t1, t2, t3].entries()) {
  if (t.length > 280) { console.error(`ABORT: tweet ${i + 1} is ${t.length} chars`); process.exit(1); }
}
if (!POST) { console.log("\nDRY RUN — re-run with --post to publish."); process.exit(0); }
if (!xPosterConfigured()) { console.error("ABORT: X creds not configured"); process.exit(1); }

console.log("uploading video…");
const mediaId = await uploadVideo(VIDEO);
console.log("media_id:", mediaId);

const p1 = await postTweetRich({ text: t1, mediaIds: [mediaId] });
if (!p1.ok) { console.error("ABORT: tweet 1 failed", p1); process.exit(1); }
console.log("tweet 1:", `https://x.com/MagpieLoans/status/${p1.tweetId}`);
const p2 = await postTweetRich({ text: t2, replyToId: p1.tweetId });
console.log("tweet 2:", p2.ok ? p2.tweetId : p2);
const p3 = await postTweetRich({ text: t3, replyToId: p2.tweetId ?? p1.tweetId });
console.log("tweet 3:", p3.ok ? p3.tweetId : p3);
console.log("THREAD LIVE:", `https://x.com/MagpieLoans/status/${p1.tweetId}`);
