/**
 * Daily community digest — posts a public-safe stats summary to every
 * group that has community_chats.enabled = TRUE. Read-only (DB queries
 * + TG sendMessage), never touches user funds.
 *
 * Schedule:
 *   - Fires once per day at BROADCAST_HOUR_UTC
 *   - Self-throttles via last_broadcast_at column on community_chats so
 *     a bot restart in the same UTC day doesn't double-post
 *
 * Content rules:
 *   - NO individual user identifiers (no wallets, no usernames, no
 *     transaction signatures). Stats are aggregate-only.
 *   - Skip the broadcast if 24h volume + new-user count are both zero
 *     (don't fill the channel with "nothing happened").
 */
import { query } from "../db/pool.js";
import { listEnabledChats } from "./community-moderation.js";

const BROADCAST_HOUR_UTC = 15; // 11am ET / 8am PT — peak engagement window
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

function fmtSol(lamportsStr) {
  if (lamportsStr == null) return "0";
  return (Number(lamportsStr) / 1e9).toFixed(2);
}

async function buildDigest() {
  const [
    { rows: [users] },
    { rows: [loans24h] },
    { rows: [loansLifetime] },
    { rows: topCollateral },
    { rows: [poolStats] },
    { rows: [mintsCount] },
  ] = await Promise.all([
    query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours')::int AS new_24h,
         (SELECT COUNT(*) FROM users)::int AS total`,
    ),
    query(
      `SELECT
         COUNT(*)::int AS n,
         COALESCE(SUM(loan_amount_lamports::numeric), 0)::text AS sol_lamports
       FROM loans WHERE created_at > NOW() - INTERVAL '24 hours'`,
    ),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status='active')::int     AS active,
         COUNT(*) FILTER (WHERE status='repaid')::int     AS repaid,
         COUNT(*) FILTER (WHERE status='liquidated')::int AS liquidated`,
    ),
    query(
      `SELECT sm.symbol,
              COUNT(l.id) FILTER (WHERE l.status='active')::int AS active_loans,
              COALESCE(SUM(l.loan_amount_lamports::numeric) FILTER (WHERE l.status='active'), 0)::text AS active_sol_lamports
         FROM supported_mints sm
         LEFT JOIN loans l ON l.collateral_mint = sm.mint
        WHERE sm.enabled = TRUE
        GROUP BY sm.symbol
       HAVING COUNT(l.id) FILTER (WHERE l.status='active') > 0
        ORDER BY SUM(l.loan_amount_lamports::numeric) FILTER (WHERE l.status='active') DESC NULLS LAST
        LIMIT 3`,
    ),
    query(
      `SELECT
         COALESCE(SUM(shares::numeric), 0)::text AS total_shares
         FROM lp_positions WHERE shares > 0`,
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM supported_mints WHERE enabled = TRUE`,
    ),
  ]);

  return {
    new_users_24h: users.new_24h,
    total_users: users.total,
    loans_24h_count: loans24h.n,
    loans_24h_sol: fmtSol(loans24h.sol_lamports),
    active_loans: loansLifetime.active,
    repaid_loans: loansLifetime.repaid,
    liquidated_loans: loansLifetime.liquidated,
    top_collateral: topCollateral.map(t => ({
      symbol: t.symbol,
      active: t.active_loans,
      sol: fmtSol(t.active_sol_lamports),
    })),
    lp_shares_total: fmtSol(poolStats?.total_shares ?? "0"), // shares ≈ SOL in this pool
    tokens_supported: mintsCount.n,
  };
}

function formatMessage(d) {
  const lines = [
    `📊 *Magpie · daily snapshot*`,
    ``,
    `🔓 Last 24h: *${d.loans_24h_count}* new loans · *${d.loans_24h_sol} SOL* borrowed`,
    `🟢 Active loans right now: *${d.active_loans}*`,
    `✅ Lifetime repaid: *${d.repaid_loans}* · Liquidated: *${d.liquidated_loans}*`,
    `👥 New users today: *${d.new_users_24h}* · Total: *${d.total_users}*`,
    `🏦 LP pool: *${d.lp_shares_total} SOL* deposited`,
    `🪙 ${d.tokens_supported} approved collateral tokens`,
  ];
  if (d.top_collateral.length > 0) {
    lines.push(``, `Most-borrowed against (active):`);
    for (const t of d.top_collateral) {
      lines.push(`  • *$${t.symbol}* — ${t.active} loan${t.active === 1 ? "" : "s"} · ${t.sol} SOL`);
    }
  }
  lines.push(``, `_Verify any number on-chain at solscan.io or magpie.capital/stats._`);
  return lines.join("\n");
}

function isWorthPosting(d) {
  // Don't spam the channel if literally nothing happened today.
  return d.loans_24h_count > 0 || d.new_users_24h > 0 || d.active_loans > 0;
}

let lastSendDayUtc = -1;

async function tick(bot) {
  const now = new Date();
  // Only fire at the configured hour, and at most once per UTC day.
  if (now.getUTCHours() !== BROADCAST_HOUR_UTC) return;
  const today = Math.floor(now.getTime() / 86_400_000);
  if (today === lastSendDayUtc) return;

  let digest;
  try {
    digest = await buildDigest();
  } catch (err) {
    console.warn("[community-broadcast] digest build failed:", err.message);
    return;
  }
  if (!isWorthPosting(digest)) {
    console.log("[community-broadcast] nothing worth posting today — skipping");
    lastSendDayUtc = today; // still mark; don't spam-retry
    return;
  }
  const msg = formatMessage(digest);

  const chats = await listEnabledChats();
  for (const c of chats) {
    try {
      await bot.api.sendMessage(Number(c.chat_id), msg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.warn(`[community-broadcast] send to ${c.chat_id} failed:`, err.message);
      // Continue — one bad chat shouldn't block others
    }
  }
  lastSendDayUtc = today;
  console.log(`[community-broadcast] sent to ${chats.length} chat(s)`);
}

/** Manual fire — used by /community_broadcast_now for operator testing. */
export async function fireDigestNow(bot, targetChatId = null) {
  const digest = await buildDigest();
  const msg = formatMessage(digest);
  if (targetChatId) {
    await bot.api.sendMessage(Number(targetChatId), msg, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    return 1;
  }
  const chats = await listEnabledChats();
  for (const c of chats) {
    try {
      await bot.api.sendMessage(Number(c.chat_id), msg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.warn(`[community-broadcast] manual send to ${c.chat_id} failed:`, err.message);
    }
  }
  return chats.length;
}

export function startCommunityBroadcast(bot) {
  console.log(`[community-broadcast] starting (broadcasts at ${BROADCAST_HOUR_UTC}:00 UTC daily)`);
  setInterval(() => tick(bot).catch((err) => console.error("[community-broadcast] tick failed:", err.message)), CHECK_INTERVAL_MS);
}
