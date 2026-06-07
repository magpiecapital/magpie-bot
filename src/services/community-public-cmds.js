/**
 * Public utility commands for the community group — all templated or
 * DB-driven, ZERO Anthropic cost. These exist so the most common
 * questions ("what tiers? what fees? how does this work?") never need
 * to touch the LLM, which keeps Pip snappy and credits intact.
 *
 * Design rules:
 *   - Markdown formatting is strict — only well-tested markup so
 *     parsing never silently fails in TG. Where the content includes
 *     raw user-controllable strings (we never echo any here, but the
 *     pattern applies) we'd escape with escapeMd().
 *   - Every output ends with the same "verify on-chain" trust line so
 *     numbers are auditable.
 *   - Use mono for addresses / mints; bold for key numbers; one emoji
 *     per section, no more.
 *   - "last updated" footer on data-driven commands so users trust the
 *     freshness.
 *   - Inline keyboards offer obvious follow-ups (open site, view stats
 *     page) so the experience feels like an app, not a CLI.
 */
import { query } from "../db/pool.js";

const SITE_STATS_URL = "https://www.magpie.capital/stats";
const SITE_URL = "https://www.magpie.capital";
const WALLET_BOT_URL = "https://t.me/magpie_capital_bot";

/* ─────────────────────────── HELPERS ─────────────────────────── */

function fmtSol(lamports) {
  if (lamports == null) return "—";
  const n = Number(lamports) / 1e9;
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("en-US");
}

function tsFooter() {
  const t = new Date().toISOString().replace("T", " ").slice(0, 16);
  return `_Updated ${t} UTC · verify on-chain at_ [solscan.io](https://solscan.io) _or_ [${SITE_STATS_URL.replace(/^https?:\/\//, "")}](${SITE_STATS_URL})`;
}

/* ─────────────────────────── /stats ─────────────────────────── */

async function fetchStats() {
  const [
    { rows: [users] },
    { rows: [loans24h] },
    { rows: [book] },
    { rows: top },
    { rows: [pool] },
    { rows: [mints] },
  ] = await Promise.all([
    query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours')::int AS new_24h,
         (SELECT COUNT(*) FROM users)::int AS total`,
    ),
    query(
      `SELECT
         COUNT(*)::int                                       AS n,
         COALESCE(SUM(loan_amount_lamports::numeric), 0)::text AS sol_lamports
       FROM loans WHERE created_at > NOW() - INTERVAL '24 hours'`,
    ),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status='active')::int     AS active,
         COUNT(*) FILTER (WHERE status='repaid')::int     AS repaid,
         COUNT(*) FILTER (WHERE status='liquidated')::int AS liquidated,
         COALESCE(SUM(loan_amount_lamports::numeric)
                  FILTER (WHERE status='active'), 0)::text AS active_lamports`,
    ),
    query(
      `SELECT sm.symbol,
              COUNT(l.id) FILTER (WHERE l.status='active')::int AS active_loans,
              COALESCE(SUM(l.loan_amount_lamports::numeric)
                       FILTER (WHERE l.status='active'), 0)::text AS active_sol_lamports
         FROM supported_mints sm
         LEFT JOIN loans l ON l.collateral_mint = sm.mint
        WHERE sm.enabled = TRUE
        GROUP BY sm.symbol
       HAVING COUNT(l.id) FILTER (WHERE l.status='active') > 0
        ORDER BY SUM(l.loan_amount_lamports::numeric)
                 FILTER (WHERE l.status='active') DESC NULLS LAST
        LIMIT 5`,
    ),
    query(
      `SELECT COALESCE(SUM(shares::numeric), 0)::text AS total_shares
         FROM lp_positions WHERE shares > 0`,
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM supported_mints WHERE enabled = TRUE`,
    ),
  ]);
  return {
    users,
    loans24h,
    book,
    top,
    pool,
    mints,
  };
}

export async function handleCommunityStats(ctx) {
  try {
    const s = await fetchStats();
    const lines = [
      `📊 *Magpie · live protocol stats*`,
      ``,
      `*Last 24 hours*`,
      `  • New loans: *${fmtInt(s.loans24h.n)}* · *${fmtSol(s.loans24h.sol_lamports)} SOL* borrowed`,
      `  • New users: *${fmtInt(s.users.new_24h)}*`,
      ``,
      `*Lending book*`,
      `  • Active loans: *${fmtInt(s.book.active)}* · *${fmtSol(s.book.active_lamports)} SOL* out`,
      `  • Lifetime repaid: *${fmtInt(s.book.repaid)}*`,
      `  • Lifetime liquidated: *${fmtInt(s.book.liquidated)}*`,
      ``,
      `*LP pool*`,
      `  • Total deposited: *${fmtSol(s.pool.total_shares)} SOL*`,
      ``,
      `*Coverage*`,
      `  • Approved collateral tokens: *${fmtInt(s.mints.n)}*`,
      `  • Total users: *${fmtInt(s.users.total)}*`,
    ];
    if (s.top.length > 0) {
      lines.push(``, `*Most-borrowed against (active)*`);
      for (const t of s.top) {
        lines.push(`  • *$${escapeMd(t.symbol)}* — ${fmtInt(t.active_loans)} loan${t.active_loans === 1 ? "" : "s"} · ${fmtSol(t.active_sol_lamports)} SOL`);
      }
    }
    lines.push(``, tsFooter());

    await ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🌐 Open stats page", url: SITE_STATS_URL },
            { text: "💰 Borrow", url: WALLET_BOT_URL },
          ],
        ],
      },
    });
  } catch (err) {
    console.warn("[community-stats] failed:", err.message);
    await ctx.reply(
      `⚠️ Stats briefly unavailable. Try again in a sec, or open ${SITE_STATS_URL}`,
      { disable_web_page_preview: true },
    );
  }
}

/* ─────────────────────────── /tiers ─────────────────────────── */

export async function handleCommunityTiers(ctx) {
  const text = [
    `🪙 *Magpie · loan tiers*`,
    ``,
    `Three tiers. Pick by speed/cost trade-off:`,
    ``,
    `*⚡ Express* — 30% LTV · 2-day term · 3% fee`,
    `  _Most SOL up-front, shortest leash. Pay more for speed._`,
    ``,
    `*🚀 Quick* — 25% LTV · 3-day term · 2% fee`,
    `  _Middle of the road. Most users land here._`,
    ``,
    `*🛡 Standard* — 20% LTV · 7-day term · 1.5% fee`,
    `  _Most breathing room, lowest fee, smallest SOL slice._`,
    ``,
    `*Why these numbers?* Higher LTV = more SOL relative to your collateral, but more risk of liquidation if the token drops. Shorter terms reduce time-decay risk. Fees compensate the LP pool for the risk they take on.`,
    ``,
    `*Liquidation triggers*`,
    `  • Health factor drops below 1.1× (token price falls)`,
    `  • Or term expires without repayment`,
    ``,
    `Zero liquidations to date — by design (short terms + low LTV + a token-health watcher that pauses risky tokens before they liquidate users).`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💰 Borrow now", url: WALLET_BOT_URL },
          { text: "🌐 Calculator", url: `${SITE_URL}/calculate` },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /fees ─────────────────────────── */

export async function handleCommunityFees(ctx) {
  const text = [
    `💸 *Magpie · fee breakdown*`,
    ``,
    `*Loan fee* (charged once, at borrow time)`,
    `  • Express tier:  3.0%`,
    `  • Quick tier:    2.0%`,
    `  • Standard tier: 1.5%`,
    ``,
    `*Extend fee* (per extension)`,
    `  • Same %s as the original tier`,
    ``,
    `*Where the fee goes*`,
    `  • 80% → LPs (the people who deposit SOL into the pool)`,
    `  • 10% → $MAGPIE holders (pro-rata)`,
    `  • 5%  → Referrers (lifetime, paid in SOL)`,
    `  • 2%  → LP loyalty pool (long-term LPs get a bonus)`,
    `  • 3%  → Protocol (covers infra, RPC, dev)`,
    ``,
    `*What is NOT a fee*`,
    `  • Repaying early — zero penalty`,
    `  • Topping up collateral — zero fee`,
    `  • Switching tiers — not allowed mid-loan; close + re-open`,
    ``,
    `_All flows are on-chain. Verify any number at magpie.capital/stats._`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

/* ─────────────────────────── /how ─────────────────────────── */

export async function handleCommunityHow(ctx) {
  const text = [
    `🦅 *How Magpie works*`,
    ``,
    `1. *Pick a token* from the approved list (see /tokens).`,
    `2. *Send it* to your Magpie wallet (DM @magpie\\_capital\\_bot, tap /deposit).`,
    `3. *Pick a tier* — Express (30% / 2d / 3%), Quick (25% / 3d / 2%), or Standard (20% / 7d / 1.5%).`,
    `4. *Get SOL instantly* — credited to your wallet in seconds.`,
    `5. *Repay before the deadline* and reclaim your tokens. Miss it → liquidation.`,
    ``,
    `*Examples*`,
    `  • Deposit 10,000 BUTTCOIN @ $0.0001 = $1 of collateral`,
    `  • Take Quick tier (25% LTV) → ~$0.25 worth of SOL`,
    `  • Fee: 2% of $0.25 = $0.005 (paid in SOL)`,
    `  • Repay $0.25 in SOL within 3 days → get your 10,000 BUTTCOIN back`,
    ``,
    `*Why this is different from regular DeFi*`,
    `  • Permissionless: no KYC, no signup`,
    `  • Custodial-by-design: your Magpie wallet IS the bot wallet, so we can co-sign repayments instantly`,
    `  • Risk-managed: short terms + low LTV + auto-pause on risky tokens`,
    `  • Credit score: a 300-850 number that rewards repayment behavior with better rates over time`,
    ``,
    `*Two surfaces*`,
    `  • Wallet bot — @magpie\\_capital\\_bot (private 1:1)`,
    `  • This community — @magpietalk (public discussion)`,
    `  • Nothing else. Anyone claiming to be Magpie elsewhere is a scammer.`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💰 Try it", url: WALLET_BOT_URL },
          { text: "🌐 magpie.capital", url: SITE_URL },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /tokens ─────────────────────────── */

export async function handleCommunityTokens(ctx) {
  try {
    const { rows: tokens } = await query(
      `SELECT symbol, name, category
         FROM supported_mints
        WHERE enabled = TRUE
        ORDER BY category NULLS LAST, symbol ASC`,
    );
    if (tokens.length === 0) {
      await ctx.reply(`No tokens currently approved as collateral.`);
      return;
    }
    // Group by category for readability
    const groups = new Map();
    for (const t of tokens) {
      const cat = t.category || "misc";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(t);
    }

    const lines = [
      `🪙 *Magpie · approved collateral* (${tokens.length} tokens)`,
      ``,
    ];
    const labelMap = {
      memecoin: "Memecoins",
      stable: "Stables",
      stock: "Tokenized stocks",
      bluechip: "Blue chips",
      misc: "Other",
    };
    for (const [cat, list] of groups) {
      lines.push(`*${labelMap[cat] || cat}*`);
      // Show up to 30 per category so we don't blow past TG's 4096-char cap
      for (const t of list.slice(0, 30)) {
        lines.push(`  • *$${escapeMd(t.symbol)}*${t.name ? ` — ${escapeMd(t.name)}` : ""}`);
      }
      if (list.length > 30) {
        lines.push(`  _+ ${list.length - 30} more in this category_`);
      }
      lines.push(``);
    }
    lines.push(`Full list with live prices and tier limits at ${SITE_URL}/tokens`);

    await ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: "🌐 Open token list", url: `${SITE_URL}/tokens` }]],
      },
    });
  } catch (err) {
    console.warn("[community-tokens] failed:", err.message);
    await ctx.reply(
      `⚠️ Token list briefly unavailable. Try again, or see ${SITE_URL}/tokens`,
      { disable_web_page_preview: true },
    );
  }
}

/* ─────────────────────────── ROUTER ─────────────────────────── */

/**
 * Parse a community-group message for a public-utility command and run
 * the matching handler. Returns true if we handled it (caller should
 * short-circuit any further moderation / LLM logic).
 *
 * We accept the bare command (`/stats`) and the bot-suffixed form
 * (`/stats@magpie_capital_bot`) so it works whether or not Telegram
 * appends the suffix in groups (it does when multiple bots are present).
 */
const COMMUNITY_CMD_HANDLERS = {
  stats: handleCommunityStats,
  tiers: handleCommunityTiers,
  fees: handleCommunityFees,
  how: handleCommunityHow,
  tokens: handleCommunityTokens,
};

export async function maybeHandlePublicCommand(ctx, msg) {
  const text = (msg?.text || "").trim();
  if (!text.startsWith("/")) return false;
  const m = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const fn = COMMUNITY_CMD_HANDLERS[cmd];
  if (!fn) return false;
  try {
    await fn(ctx);
  } catch (err) {
    console.warn(`[community-public-cmds] /${cmd} failed:`, err.message);
  }
  return true;
}

/* ─────────────────────────── UTILS ─────────────────────────── */

/**
 * Escape Telegram Markdown (legacy mode — the one used in this repo).
 * Used for any value that originates from a user / DB row that could
 * contain unbalanced *_`[] characters. Static strings don't need this.
 */
function escapeMd(s) {
  if (s == null) return "";
  return String(s).replace(/([_*`\[\]()])/g, "\\$1");
}
