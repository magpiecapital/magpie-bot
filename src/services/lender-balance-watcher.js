/**
 * Lender wallet balance monitor — proactive overnight alerts.
 *
 * The lender wallet funds three things:
 *   1. Protocol operations (price attestations, ATA rents)
 *   2. Referral payouts (5% of fees → referrers on claim)
 *   3. Holder reward distributions ($MAGPIE holders, LP loyalty)
 *
 * If it drains overnight without warning, holder/referral payouts
 * start silently failing and the next snapshot is skipped. This
 * watcher DMs the admin BEFORE that happens so they can /fundpool
 * or top up.
 *
 * Anti-spam: once we've alerted at a given threshold, don't re-alert
 * until balance recovers above the next-higher threshold (or 12h passes).
 */
import { PublicKey } from "@solana/web3.js";
import { connection } from "../solana/connection.js";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);
const ADMIN_TG_ID = process.env.ADMIN_TG_ID ? Number(process.env.ADMIN_TG_ID) : null;
const POLL_INTERVAL_MS = Number(process.env.LENDER_WATCH_MS) || 30 * 60 * 1000; // 30 min

// Tiered thresholds — alert once per tier crossing.
const THRESHOLDS = [
  { lamports: 1_500_000_000n, level: "🟡 LOW",      action: "Top up within 24h" },
  { lamports: 1_000_000_000n, level: "🟠 CRITICAL", action: "Top up ASAP — payouts will start failing" },
  { lamports:   500_000_000n, level: "🔴 EMERGENCY", action: "Payouts ARE failing. /fundpool from your treasury NOW" },
];

let lastAlertedAt = 0;
let lastAlertedTier = null;

async function tick(bot) {
  if (!ADMIN_TG_ID || !bot) return;

  let lamports;
  try {
    lamports = BigInt(await connection.getBalance(LENDER_PUBKEY));
  } catch (err) {
    console.warn("[lender-watch] balance fetch failed:", err.message);
    return;
  }

  // Find the most severe threshold that's been crossed
  const crossed = THRESHOLDS.find((t) => lamports < t.lamports);
  if (!crossed) {
    // Healthy — clear previous alert state so a future drop re-alerts
    lastAlertedTier = null;
    return;
  }

  // Same-tier dedupe: don't re-spam unless 12h passed OR severity escalated
  const now = Date.now();
  const sinceLast = now - lastAlertedAt;
  const tierEscalated = lastAlertedTier && THRESHOLDS.indexOf(crossed) > THRESHOLDS.indexOf(lastAlertedTier);
  const enoughTimeElapsed = sinceLast > 12 * 60 * 60 * 1000;
  if (lastAlertedTier === crossed && !tierEscalated && !enoughTimeElapsed) return;

  const sol = (Number(lamports) / 1e9).toFixed(4);
  try {
    await bot.api.sendMessage(
      ADMIN_TG_ID,
      [
        `${crossed.level} *Lender wallet balance alert*`,
        "",
        `Current: \`${sol} SOL\``,
        `Wallet: \`${LENDER_PUBKEY.toBase58()}\``,
        "",
        `Action: ${crossed.action}`,
        "",
        "Lender wallet funds: ops (tx fees, ATA rent) + referral claims + holder/LP-loyalty payouts.",
        "",
        `Top up via wallet → \`${LENDER_PUBKEY.toBase58()}\` then \`/fundpool <amount>\` to redeposit into the lending pool if needed.`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
    lastAlertedAt = now;
    lastAlertedTier = crossed;
    console.log(`[lender-watch] Admin alerted: ${crossed.level} at ${sol} SOL`);
  } catch (err) {
    console.warn("[lender-watch] admin alert failed:", err.message);
  }
}

export function startLenderBalanceWatcher(bot) {
  console.log(`[lender-watch] Starting (interval=${POLL_INTERVAL_MS}ms)`);
  // First check 2 min after boot
  setTimeout(() => tick(bot), 2 * 60 * 1000);
  return setInterval(() => tick(bot), POLL_INTERVAL_MS);
}
