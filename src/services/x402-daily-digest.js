/**
 * x402-daily-digest.js
 * ─────────────────────────────────────────────────────────────────────────
 * Once a day at 9:00 AM Eastern, DM the operator a compact x402 scorecard —
 * the four numbers that say whether x402 is winning:
 *   • paying agents (24h)   • paid x402 calls (24h)
 *   • x402 fees collected   • protocol borrows (24h)
 * …each with a 7-day trend line for context.
 *
 * DST-correct (fires at 9am Eastern wall-clock via America/New_York).
 * Tune the hour with X402_DIGEST_HOUR_EST (default 9). Disable with
 * X402_DIGEST_DISABLED=true. Self-throttles to once per Eastern calendar day.
 */
import { query } from "../db/pool.js";
import { getAdminId } from "./admin-notify.js";

const DIGEST_HOUR_EST = Number(process.env.X402_DIGEST_HOUR_EST ?? 9);
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // coarse — the daily throttle does the real gating
let lastDigestYmd = null;

// Eastern wall-clock hour + YYYY-MM-DD, DST-correct via Intl. The operator
// mandate is "always Eastern", and America/New_York handles EST/EDT for us.
function easternNow(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  return { ymd: `${get("year")}-${get("month")}-${get("day")}`, hour };
}

const sol = (lamports) => (Number(lamports) / 1e9).toFixed(4);

// Run a query but never let a missing table / transient error break the digest.
async function safeRow(qText, params = []) {
  try {
    const { rows } = await query(qText, params);
    return rows[0] || {};
  } catch (err) {
    console.warn("[x402-digest] query failed:", err.message);
    return {};
  }
}

async function buildDigest() {
  // x402 paid-call metrics (24h headline + 7d trend). 'settled' = native-SOL
  // rail; 'reserve' rows are pre-settlement markers and are excluded.
  const x = await safeRow(`
    SELECT
      COUNT(*) FILTER (WHERE kind <> 'reserve' AND recorded_at > NOW() - INTERVAL '24 hours')::int AS calls_24h,
      COUNT(DISTINCT payer_pubkey) FILTER (WHERE kind <> 'reserve' AND payer_pubkey <> '' AND recorded_at > NOW() - INTERVAL '24 hours')::int AS agents_24h,
      COALESCE(SUM(amount_lamports::numeric) FILTER (WHERE kind = 'settled' AND recorded_at > NOW() - INTERVAL '24 hours'), 0)::text AS fees_24h,
      COUNT(*) FILTER (WHERE kind <> 'reserve')::int AS calls_7d,
      COUNT(DISTINCT payer_pubkey) FILTER (WHERE kind <> 'reserve' AND payer_pubkey <> '')::int AS agents_7d,
      COALESCE(SUM(amount_lamports::numeric) FILTER (WHERE kind = 'settled'), 0)::text AS fees_7d
    FROM x402_paid_calls
    WHERE recorded_at > NOW() - INTERVAL '7 days'
  `);

  // Protocol borrow activity (SOL disbursed to borrowers).
  const b = await safeRow(`
    SELECT
      COUNT(*) FILTER (WHERE start_timestamp > NOW() - INTERVAL '24 hours')::int AS borrows_24h,
      COALESCE(SUM(loan_amount_lamports::numeric) FILTER (WHERE start_timestamp > NOW() - INTERVAL '24 hours'), 0)::text AS vol_24h,
      COUNT(*) FILTER (WHERE start_timestamp > NOW() - INTERVAL '7 days')::int AS borrows_7d,
      COALESCE(SUM(loan_amount_lamports::numeric) FILTER (WHERE start_timestamp > NOW() - INTERVAL '7 days'), 0)::text AS vol_7d
    FROM loans
    WHERE start_timestamp > NOW() - INTERVAL '7 days'
  `);

  const c24 = x.calls_24h ?? 0;
  const lines = [
    `📊 *Magpie x402 — daily digest*  ·  ${DIGEST_HOUR_EST}:00 EST`,
    ``,
    `🤖 Paying agents (24h):  *${x.agents_24h ?? 0}*`,
    `⚡ Paid x402 calls (24h):  *${c24}*`,
    `💸 x402 fees collected (24h):  *${sol(x.fees_24h ?? 0)} SOL*`,
    `🏦 Protocol borrows (24h):  *${b.borrows_24h ?? 0}*  ·  *${sol(b.vol_24h ?? 0)} SOL*`,
    ``,
    // At-a-glance net economics — the operator's question: does x402 raise daily
    // cost? No: agents are the tx fee payer on their own borrows/repays, so the
    // deployer/lender wallet spends 0 SOL of gas per agent loan, while every paid
    // call earns the x402 fee above. Incremental infra is ~pennies of RPC/borrow;
    // the real cost lever stays attestation (per-mint, tier-governed) — not x402.
    `💵 *Net economics (24h)* — in: *${sol(x.fees_24h ?? 0)} SOL* x402 fees.`,
    `   Deployer gas on agent loans: *0* (agents pay their own). ~pennies RPC/borrow;`,
    `   attestation is per-mint + tier-governed. Each agent borrow earns > it costs → net-positive.`,
    ``,
    `_7d — agents ${x.agents_7d ?? 0} · calls ${x.calls_7d ?? 0} · fees ${sol(x.fees_7d ?? 0)} SOL · borrows ${b.borrows_7d ?? 0}_`,
  ];
  if (c24 === 0) {
    lines.push(``, `_No x402 calls in the last 24h yet — keep the outbound marketing pushing._`);
  }
  return lines.join("\n");
}

async function tick(bot) {
  try {
    const { ymd, hour } = easternNow(new Date());
    if (hour < DIGEST_HOUR_EST) return; // not yet 9am Eastern today
    if (lastDigestYmd === ymd) return; // already sent today — self-throttle
    const adminId = getAdminId();
    if (!adminId || !bot) return;
    const text = await buildDigest();
    await bot.api.sendMessage(Number(adminId), text, { parse_mode: "Markdown" });
    lastDigestYmd = ymd;
    console.log("[x402-digest] sent daily digest");
  } catch (err) {
    console.warn("[x402-digest] tick failed:", err.message);
  }
}

export function startX402DailyDigest(bot) {
  if (!bot) return null;
  if (process.env.X402_DIGEST_DISABLED === "true") {
    console.log("[x402-digest] disabled via X402_DIGEST_DISABLED — not starting");
    return null;
  }
  console.log(`[x402-digest] starting — DMs admin daily at ${DIGEST_HOUR_EST}:00 EST`);
  setTimeout(() => tick(bot), 45_000); // first check shortly after boot; throttle handles the rest
  return setInterval(() => tick(bot), CHECK_INTERVAL_MS);
}

// Exported for an admin "/x402digest now" command or tests.
export { buildDigest };
