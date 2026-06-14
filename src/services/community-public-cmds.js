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

// $MAGPIE token constants — single source of truth for community-side
// references. The mint NEVER changes; if it ever did we'd be a
// different protocol. Keeping these literal so a corrupted import
// can't redirect users to a fake mint.
const MAGPIE_MINT = "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump";
const MAGPIE_PUMP_URL = `https://pump.fun/coin/${MAGPIE_MINT}`;
const MAGPIE_DEXSCREENER_URL = `https://dexscreener.com/solana/${MAGPIE_MINT}`;
const MAGPIE_BIRDEYE_URL = `https://birdeye.so/token/${MAGPIE_MINT}?chain=solana`;
const MAGPIE_SOLSCAN_URL = `https://solscan.io/token/${MAGPIE_MINT}`;
const MAGPIE_JUPITER_URL = `https://jup.ag/swap/SOL-${MAGPIE_MINT}`;
const X_URL = "https://x.com/MagpieLoans";

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

/**
 * Right-align a value column to a fixed total line width. Inside a
 * Telegram code block (which uses a monospace font), this produces a
 * clean two-column "label … value" layout that reads consistently on
 * mobile. Width of 36 cols was picked by hand to avoid wrap on iOS TG
 * at 14pt code-block size with the longest expected labels.
 */
// Mobile-first: iOS Telegram's monospace block fits ~26 chars before
// wrapping. 24 + 2-space padding = safe 26-char total.
const COL_WIDTH = 24;
function row(label, value) {
  const l = String(label);
  const v = String(value);
  const gap = Math.max(1, COL_WIDTH - l.length - v.length);
  return `  ${l}${" ".repeat(gap)}${v}`;
}
const RULE = "─".repeat(COL_WIDTH + 2);

function tsFooter() {
  const t = new Date().toISOString().replace("T", " ").slice(0, 16);
  return `_Updated ${t} UTC · verify on-chain at_ [solscan.io](https://solscan.io) _or_ [${SITE_STATS_URL.replace(/^https?:\/\//, "")}](${SITE_STATS_URL})`;
}

/* ─────────────────────────── /stats ─────────────────────────── */

async function fetchStats() {
  // IMPORTANT: lifetime cumulative borrowed = DB SUM(loan_amount_lamports)
  // across all loans. The on-chain pool.totalBorrowed is OUTSTANDING
  // (decrements on repay), so it's NOT the right field for the lifetime
  // headline — verified against the IDL docs which say "Total wSOL
  // currently lent out".
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
      // Headline number is total_borrowed_lifetime — sum across ALL loans
      // ever issued (active + repaid + liquidated). This is the protocol's
      // cumulative lending volume, the "229.2 SOL" headline figure.
      // active_lamports is the much smaller "currently out on loan" number.
      `SELECT
         COUNT(*) FILTER (WHERE status='active')::int     AS active,
         COUNT(*) FILTER (WHERE status='repaid')::int     AS repaid,
         COUNT(*) FILTER (WHERE status='liquidated')::int AS liquidated,
         COALESCE(SUM(loan_amount_lamports::numeric), 0)::text AS lifetime_lamports,
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
    const lifetimeSol = fmtSol(s.book.lifetime_lamports);

    // Mobile-tight tabular block: 24-char content column + 2-char left
    // padding = 26-char total, the safe cap before iOS TG mono-block
    // wraps. Every label/value pair sits on ONE line, value flush right.
    const codeLines = [
      RULE,
      `LOAN BOOK`,
      row("Currently out", `${fmtSol(s.book.active_lamports)} SOL`),
      row("Active loans", fmtInt(s.book.active)),
      row("Repaid", fmtInt(s.book.repaid)),
      row("Liquidated", fmtInt(s.book.liquidated)),
      ``,
      `LAST 24H`,
      row("New loans", fmtInt(s.loans24h.n)),
      row("Volume", `${fmtSol(s.loans24h.sol_lamports)} SOL`),
      row("New users", fmtInt(s.users.new_24h)),
      ``,
      `POOL`,
      row("LP deposited", `${fmtSol(s.pool.total_shares)} SOL`),
      ``,
      `COVERAGE`,
      row("Tokens", fmtInt(s.mints.n)),
      row("Users", fmtInt(s.users.total)),
    ];
    if (s.top.length > 0) {
      codeLines.push(``, `TOP COLLATERAL`);
      for (const t of s.top.slice(0, 3)) {
        const symbol = `$${(t.symbol || "?").slice(0, 10)}`;
        codeLines.push(row(symbol, `${fmtSol(t.active_sol_lamports)} SOL`));
      }
    }
    codeLines.push(RULE);

    // Headline OUTSIDE the code block — bold + big, not constrained by
    // mono pitch. This is the single most important number; gets visual
    // primacy as the first thing the eye lands on.
    const lines = [
      `📊 *Magpie — live protocol stats*`,
      ``,
      `🦅 *${lifetimeSol} SOL* lent out, lifetime`,
      `   _The protocol's full borrowing volume._`,
      ``,
      "```",
      ...codeLines,
      "```",
      tsFooter(),
    ];

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
  // Mobile-tight tabular layout — 4 columns, 26-char total. Matches
  // the /stats visual language so the comparison reads at a glance.
  const codeLines = [
    RULE,
    `TIER       LTV   DAYS   FEE`,
    `Express    30%   2      3.0%`,
    `Quick      25%   3      2.0%`,
    `Standard   20%   7      1.5%`,
    RULE,
  ];
  const text = [
    `🪙 *Magpie · loan tiers*`,
    ``,
    `Three tiers. Pick by speed/cost trade-off:`,
    ``,
    "```",
    ...codeLines,
    "```",
    ``,
    `*⚡ Express* — most SOL up-front, shortest leash. Pay more for speed.`,
    `*🚀 Quick* — middle of the road. Most users land here.`,
    `*🛡 Standard* — most breathing room, lowest fee, smallest SOL slice.`,
    ``,
    `*Why these numbers?* Higher LTV = more SOL relative to collateral but more liquidation risk if the token drops. Shorter terms reduce time-decay risk. Fees compensate LPs for the risk they take on.`,
    ``,
    `*Liquidation triggers* — health <1.1× *or* term expires without repayment.`,
    ``,
    `_Sub-1% lifetime liquidation rate by design — short terms + low LTV + a token-health watcher that pauses risky tokens before users get hurt. Run \`/liquidations\` for the live count._`,
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
    `*Loan fee* (charged once at borrow time):`,
    "```",
    RULE,
    `TIER         FEE`,
    `Express      3.0%`,
    `Quick        2.0%`,
    `Standard     1.5%`,
    RULE,
    "```",
    ``,
    `*Where every basis point goes:*`,
    "```",
    RULE,
    row("$MAGPIE holders", "70%"),
    row("LPs", "10%"),
    row("Referrers", "10%"),
    row("Protocol reserve", "10%"),
    RULE,
    "```",
    ``,
    `*Extend fee* — same % as the original tier, per extension.`,
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

/* ─────────────────────────── /ca ─────────────────────────── */

/**
 * Contract address shortcut — the most-requested command in any DeFi
 * TG. Returns the $MAGPIE mint as a copyable monospace string PLUS
 * one-tap links to every major Solana explorer/chart/swap surface so
 * users can verify and trade without leaving the chat.
 */
export async function handleCommunityCa(ctx) {
  const text = [
    `🪙 *$MAGPIE · contract address*`,
    ``,
    `\`${MAGPIE_MINT}\``,
    `_(tap to copy)_`,
    ``,
    `*Standard:* Token-2022 · 6 decimals`,
    `*Network:* Solana mainnet`,
    ``,
    `⚠️ This is the *only* official $MAGPIE mint. Always copy it from this group, the bot, or magpie.capital — never from a DM.`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 Chart (DEXScreener)", url: MAGPIE_DEXSCREENER_URL },
          { text: "🦅 Pump.fun", url: MAGPIE_PUMP_URL },
        ],
        [
          { text: "🔄 Buy on Jupiter", url: MAGPIE_JUPITER_URL },
          { text: "🔍 Solscan", url: MAGPIE_SOLSCAN_URL },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /magpie ─────────────────────────── */

export async function handleCommunityMagpie(ctx) {
  const text = [
    `✨ *$MAGPIE · the protocol token*`,
    ``,
    `*What it is*`,
    `$MAGPIE is the Magpie Capital token. Holders earn *70% of all protocol loan fees* pro-rata to their share of the supply.`,
    ``,
    `*Details*`,
    "```",
    row("Mint", MAGPIE_MINT.slice(0, 4) + "…" + MAGPIE_MINT.slice(-4)),
    row("Standard", "Token-2022"),
    row("Decimals", "6"),
    row("Network", "Solana mainnet"),
    "```",
    ``,
    `*Holder rewards*`,
    `• 70% of every loan fee goes to holders`,
    `• Distributed in SOL, randomized every 5–10 days`,
    `• Snapshot is on-chain — no claim, no signing, just hold`,
    `• Threshold + exact mechanics: /holders`,
    ``,
    `*Where to get it*`,
    `• Pump.fun (primary)`,
    `• Jupiter aggregator (any DEX)`,
    ``,
    `Full contract address: /ca`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 Chart", url: MAGPIE_DEXSCREENER_URL },
          { text: "🔄 Buy on Jupiter", url: MAGPIE_JUPITER_URL },
        ],
        [
          { text: "💎 Holder program", url: `${SITE_URL}/holders` },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /buy ─────────────────────────── */

export async function handleCommunityBuy(ctx) {
  const text = [
    `🛒 *How to buy $MAGPIE*`,
    ``,
    `*1. Pump.fun* (simplest, recommended)`,
    `Connect Phantom → swap SOL for $MAGPIE in one click.`,
    ``,
    `*2. Jupiter* (best price across all DEXes)`,
    `Aggregates every Solana DEX automatically. Pick this for larger size.`,
    ``,
    `*Always verify the mint before buying:*`,
    `\`${MAGPIE_MINT}\``,
    ``,
    `_Copy from this group or magpie.capital, never from a DM. Fake $MAGPIE tokens exist — this is the only real one._`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🦅 Pump.fun", url: MAGPIE_PUMP_URL },
          { text: "🔄 Jupiter", url: MAGPIE_JUPITER_URL },
        ],
        [
          { text: "📊 Chart first", url: MAGPIE_DEXSCREENER_URL },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /chart ─────────────────────────── */

export async function handleCommunityChart(ctx) {
  const text = [
    `📊 *$MAGPIE · charts*`,
    ``,
    `Pick the chart you prefer. All show the same on-chain data.`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "DEXScreener", url: MAGPIE_DEXSCREENER_URL },
          { text: "Birdeye", url: MAGPIE_BIRDEYE_URL },
        ],
        [
          { text: "Pump.fun", url: MAGPIE_PUMP_URL },
          { text: "Solscan", url: MAGPIE_SOLSCAN_URL },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /x  and  /twitter ─────────────────────────── */

export async function handleCommunityX(ctx) {
  const text = [
    `🐦 *Magpie on X*`,
    ``,
    `Follow [@MagpieLoans](${X_URL}) for protocol announcements, new approved tokens, and milestones.`,
    ``,
    `_This is the only official Magpie X account. Anything else with "Magpie" in the handle is impersonation._`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [[{ text: "🐦 Follow @MagpieLoans", url: X_URL }]],
    },
  });
}

/* ─────────────────────────── /holders ─────────────────────────── */

export async function handleCommunityHolders(ctx) {
  const text = [
    `💎 *$MAGPIE holder program*`,
    ``,
    `Hold $MAGPIE → earn *70% of all protocol loan fees* in SOL, pro-rata to your share of the supply.`,
    ``,
    `*How it works*`,
    `• Every loan fee feeds the holder pool (70% of the fee)`,
    `• Snapshot is on-chain — your balance counts as long as you hold`,
    `• Distributions in SOL, randomized cadence (every 5–10 days) to prevent gaming`,
    `• Auto-airdropped to your wallet — no claim transaction needed`,
    ``,
    `*Why randomized cadence?*`,
    `If we paid out on a fixed schedule, traders would buy 5 minutes before snapshot and dump after. Random timing means continuous holders win.`,
    ``,
    `Get your share: /buy or /ca`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💎 Full details", url: `${SITE_URL}/holders` },
          { text: "🔄 Buy $MAGPIE", url: MAGPIE_JUPITER_URL },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /refer ─────────────────────────── */

export async function handleCommunityRefer(ctx) {
  const text = [
    `🤝 *Magpie referral program*`,
    ``,
    `Refer a friend → earn *5% of every loan fee they ever pay*. Lifetime. Paid in SOL.`,
    ``,
    `*How it works*`,
    `• DM @magpie\\_capital\\_bot and run /refer`,
    `• You get a unique link — share it`,
    `• Anyone who starts the bot through your link is linked to you forever`,
    `• 5% of every fee they pay is airdropped to your wallet automatically`,
    ``,
    `*No cap, no claim, no signup* — just hold the wallet that originated the link.`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "🤝 Get your referral link", url: WALLET_BOT_URL }]],
    },
  });
}

/* ─────────────────────────── /docs ─────────────────────────── */

export async function handleCommunityDocs(ctx) {
  const text = [
    `📚 *Magpie · documentation*`,
    ``,
    `[magpie.capital/docs](${SITE_URL}/docs) — every feature explained, every flow walked through.`,
    ``,
    `Also useful:`,
    `• [Whitepaper](${SITE_URL}/whitepaper) — design + mechanics`,
    `• [Security](${SITE_URL}/security) — architecture + responsible disclosure`,
    `• [Changelog](${SITE_URL}/changelog) — what shipped recently`,
    `• [GitHub](https://github.com/magpiecapital) — source code, both repos public`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📚 Docs", url: `${SITE_URL}/docs` },
          { text: "📄 Whitepaper", url: `${SITE_URL}/whitepaper` },
        ],
        [
          { text: "🔒 Security", url: `${SITE_URL}/security` },
          { text: "📝 Changelog", url: `${SITE_URL}/changelog` },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /links ─────────────────────────── */

export async function handleCommunityLinks(ctx) {
  const text = [
    `🔗 *Magpie · all official links*`,
    ``,
    `Bookmark this URL and verify against it: [magpie.capital/links](${SITE_URL}/links)`,
    ``,
    `*The four official surfaces — only these:*`,
    `• Wallet bot — @magpie\\_capital\\_bot (private 1:1)`,
    `• Community — @magpietalk (this group)`,
    `• X — @MagpieLoans`,
    `• Site — magpie.capital`,
    ``,
    `_Anything else claiming to be Magpie is impersonation. We will never DM you first._`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [[{ text: "🔗 Open the linktree", url: `${SITE_URL}/links` }]],
    },
  });
}

/* ─────────────────────────── /website ─────────────────────────── */

export async function handleCommunityWebsite(ctx) {
  const text = [
    `🌐 *Magpie · official site*`,
    ``,
    `[magpie.capital](${SITE_URL})`,
    ``,
    `Dashboard, live stats, calculator, docs, the works. Same on-chain protocol as the bot — pick whichever surface fits the moment.`,
    ``,
    `_Only ever visit this exact URL. Lookalikes like magpie\\.capltal, magpie-capital\\.io, etc. are scams._`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: false, // we WANT the OG card preview here
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🌐 Open magpie.capital", url: SITE_URL },
          { text: "📊 Live stats", url: `${SITE_URL}/stats` },
        ],
        [
          { text: "🔗 All official links", url: `${SITE_URL}/links` },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /x402 ─────────────────────────── */

export async function handleCommunityX402(ctx) {
  const text = [
    `🤖 *magpie · x402 (agent-native API)*`,
    ``,
    `AI agents pay in SOL to query our on-chain lending protocol — credit scores, loan history, pool stats, borrow simulation.`,
    ``,
    `*No API keys. No accounts. No custody.* Agents sign x402 payment proofs from their own wallets.`,
    ``,
    `First paid lending API on Solana. Targets the agent-spending tailwind: as machine-to-machine commerce grows, this is a new consumer market for the Solana permissionless lending space.`,
    ``,
    `[magpie.capital/x402](${SITE_URL}/x402) · [GitHub](https://github.com/magpiecapital/magpie-x402)`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🌐 magpie.capital/x402", url: `${SITE_URL}/x402` },
          { text: "📦 GitHub", url: "https://github.com/magpiecapital/magpie-x402" },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /whitepaper ─────────────────────────── */

export async function handleCommunityWhitepaper(ctx) {
  const text = [
    `📄 *Magpie · whitepaper*`,
    ``,
    `Full design + mechanics: [magpie.capital/whitepaper](${SITE_URL}/whitepaper)`,
    ``,
    `Covers: the three-tier loan structure, fee economics, LP math, credit-score formula, liquidation engine, keeper network, and the design rationale for each choice.`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "📄 Read the whitepaper", url: `${SITE_URL}/whitepaper` }]],
    },
  });
}

/* ─────────────────────────── /audit ─────────────────────────── */

export async function handleCommunityAudit(ctx) {
  // Honest answer — there is no formal third-party audit yet.
  // Saying "audited" when we're not would be misrepresentation,
  // and the community will eventually find out. Instead: explain
  // what compensates for the missing audit + what's planned.
  const text = [
    `🔍 *Audit status — honest answer*`,
    ``,
    `Magpie has *not* yet undergone a formal third-party audit. The community deserves transparency on this rather than a misleading "audited" claim.`,
    ``,
    `*What compensates in the meantime*`,
    `• *Open source* — both repos are public (github.com/magpiecapital). Every line is readable and forkable.`,
    `• *Short loan terms* — 2–7 day max bounds the protocol's risk window vs. perpetual lending.`,
    `• *Low LTV (20–30%)* — conservative collateralization absorbs price swings.`,
    `• *Sub-1% lifetime liquidation rate* — the design has held in practice, not just in theory. Live count: /liquidations`,
    `• *No admin override* — there's no privileged key that can drain user collateral.`,
    `• *Bug bounty* — see /security to report findings.`,
    ``,
    `Treat Magpie as you would any unaudited protocol: deposit only what you can afford to lose, and verify everything on-chain.`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔒 Security page", url: `${SITE_URL}/security` },
          { text: "📂 Source code", url: "https://github.com/magpiecapital" },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /risk ─────────────────────────── */

export async function handleCommunityRisk(ctx) {
  const text = [
    `⚠️ *Magpie · what could go wrong*`,
    ``,
    `Real talk on the risks. Read before depositing serious size.`,
    ``,
    `*1. Liquidation risk* (borrower-side)`,
    `If your collateral token's price drops enough that health < 1.1×, the loan liquidates. You lose the collateral, keep the SOL. Mitigations: /topup to add more, /extend to buy time, Auto-Protect (in /security).`,
    ``,
    `*2. Token-volatility risk* (LP-side)`,
    `In a flash crash, a token can move faster than liquidators. The keeper network is designed for this, but in extreme markets LPs can see partial losses. Tier LTVs are set conservatively to bound this.`,
    ``,
    `*3. Smart-contract risk*`,
    `Magpie is *not yet formally audited* (see /audit). Source is open. A bug anywhere in the program could result in loss of funds.`,
    ``,
    `*4. Custodial risk*`,
    `Your Magpie wallet IS the bot wallet — that's what enables one-click co-signing. Keys are AES-256-GCM encrypted, but a compromise of the infrastructure would expose them. /export your private key and self-custody if you'd prefer that trade-off.`,
    ``,
    `*5. Oracle risk*`,
    `Token prices come from on-chain DEX oracles. Manipulated thin-liquidity pools can briefly skew prices. Token-health watcher pauses risky tokens proactively.`,
    ``,
    `*6. Operator risk*`,
    `The on-chain program runs autonomously, but the bot/site front-end depends on the team operating it. If front-end services were ever unavailable, loans + the protocol itself would keep running on-chain — but new UI features would pause. Self-custody (/export your key) protects you from this entirely.`,
    ``,
    `_Deposit only what you can afford to lose. Verify everything on-chain. We optimize for honesty over hype._`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

/* ─────────────────────────── /team ─────────────────────────── */

export async function handleCommunityTeam(ctx) {
  // Operator privacy: never reveal the operator's real name or
  // personal handles. Talk about the project's values instead.
  const text = [
    `👥 *Who's behind Magpie?*`,
    ``,
    `Magpie operates pseudonymously by design. Crypto has a long history of doxxed teams losing optionality the moment they're public — pseudonymity protects the project's ability to keep building without becoming a target.`,
    ``,
    `*What you CAN verify*`,
    `• Every line of code: github.com/magpiecapital`,
    `• Every transaction: on-chain at solscan.io / magpie.capital/stats`,
    `• Every fee taken: tracked in the protocol, allocated transparently (see /fees)`,
    `• Every protocol change: github commit history + /changelog`,
    ``,
    `*What the team is building toward*`,
    `Permissionless, on-chain, custodial-by-design lending that works in a Telegram chat. The thesis: most "DeFi" is too clunky for normal users. Magpie reduces "I want SOL against my bag" to a 30-second flow.`,
    ``,
    `*How to reach us*`,
    `• Public discussion: this group (@magpietalk)`,
    `• Private support: /support in the wallet bot`,
    `• Security disclosure: /security on the site`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📂 GitHub", url: "https://github.com/magpiecapital" },
          { text: "📊 On-chain stats", url: SITE_STATS_URL },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /support ─────────────────────────── */

export async function handleCommunitySupport(ctx) {
  // Community groups should NEVER be where personal support
  // happens. Always redirect to the private bot for anything
  // wallet/loan/account-specific.
  const text = [
    `🛟 *Need help with something?*`,
    ``,
    `For *anything personal* (your wallet, loans, balance, missing tx, account questions) — DM the bot and use \`/support\`:`,
    `→ [@magpie\\_capital\\_bot](${WALLET_BOT_URL})`,
    ``,
    `Pip can read your account context there and either solve it instantly or open a ticket for the team. _I can't see who's asking from this public group — that's why personal support has to happen in DM._`,
    ``,
    `*For general questions* (how does X work, what's the tier for Y) — just ask here with \`/ask <question>\`.`,
    ``,
    `*Found a security issue?* — see [/security](${SITE_URL}/security) for the responsible-disclosure process.`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🛟 Open the bot for /support", url: WALLET_BOT_URL },
          { text: "🔒 Security", url: `${SITE_URL}/security` },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /apy ─────────────────────────── */

async function fetchPoolYield() {
  // 30d annualized: (sum of LP-share-of-fees over last 30d) / (avg LP TVL) × (365/30)
  // We do this in one round-trip; both inputs are already on-chain
  // facts, just aggregated through the DB.
  const { rows: [r] } = await query(
    `WITH last30 AS (
       SELECT
         COALESCE(SUM(loan_amount_lamports::numeric) * 0.02, 0)::numeric AS approx_fees_to_lps_30d
       FROM loans
       WHERE created_at > NOW() - INTERVAL '30 days'
     )
     SELECT
       (SELECT COALESCE(SUM(shares::numeric), 0) FROM lp_positions WHERE shares > 0)::text AS tvl_lamports,
       (SELECT approx_fees_to_lps_30d::text FROM last30) AS lp_earnings_30d_lamports`,
  );
  const tvlSol = Number(r.tvl_lamports) / 1e9;
  const earn30d = Number(r.lp_earnings_30d_lamports) / 1e9;
  // Avoid divide-by-zero. If TVL is microscopic, just say "—".
  let apr = 0;
  if (tvlSol > 0.01) {
    apr = (earn30d / tvlSol) * (365 / 30) * 100;
  }
  return { tvlSol, earn30d, apr };
}

export async function handleCommunityApy(ctx) {
  try {
    const y = await fetchPoolYield();
    const aprStr = y.apr > 0 ? `${y.apr.toFixed(1)}%` : "—";
    const text = [
      `📈 *Magpie LP · current yield (rough estimate)*`,
      "```",
      RULE,
      row("30-DAY ROLLING APR (EST.)", aprStr),
      RULE,
      ``,
      row("LP pool TVL", `${y.tvlSol.toFixed(2)} SOL`),
      row("LP earnings (30d)", `${y.earn30d.toFixed(2)} SOL`),
      RULE,
      "```",
      ``,
      `_Rough estimate — assumes 80% of every loan fee (≈ 2% avg) flows to LPs, annualized over 30 days. Actual yield depends on borrow demand. Past performance ≠ future returns._`,
      ``,
      `Deposit at [magpie.capital/earn](${SITE_URL}/earn). See /lend for how it works.`,
    ].join("\n");
    await ctx.reply(text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🏦 Deposit SOL", url: `${SITE_URL}/earn` },
            { text: "📊 Live stats", url: SITE_STATS_URL },
          ],
        ],
      },
    });
  } catch (err) {
    console.warn("[community-apy] failed:", err.message);
    await ctx.reply(
      `⚠️ APR estimate briefly unavailable. Try again, or see live pool stats at ${SITE_STATS_URL}`,
      { disable_web_page_preview: true },
    );
  }
}

/* ─────────────────────────── /tvl ─────────────────────────── */

export async function handleCommunityTvl(ctx) {
  try {
    const { rows: [r] } = await query(
      `SELECT
         COALESCE((SELECT SUM(shares::numeric) FROM lp_positions WHERE shares > 0), 0)::text     AS lp_lamports,
         COALESCE((SELECT SUM(loan_amount_lamports::numeric) FROM loans WHERE status='active'), 0)::text AS active_lamports,
         COALESCE((SELECT SUM(loan_amount_lamports::numeric) FROM loans), 0)::text                      AS lifetime_lamports,
         (SELECT COUNT(*) FROM loans WHERE status='active')::int                                        AS active_loans`,
    );
    const lpSol = Number(r.lp_lamports) / 1e9;
    const activeSol = Number(r.active_lamports) / 1e9;
    const lifetimeSol = Number(r.lifetime_lamports) / 1e9;
    const text = [
      `🏦 *Magpie · pool TVL*`,
      "```",
      RULE,
      row("LP POOL DEPOSITED", `${lpSol.toFixed(2)} SOL`),
      RULE,
      ``,
      row("Currently out on loan", `${activeSol.toFixed(2)} SOL`),
      row("Active loans", r.active_loans),
      row("Lifetime borrowed", `${lifetimeSol.toFixed(2)} SOL`),
      RULE,
      "```",
      ``,
      `Verify live on-chain at [magpie.capital/stats](${SITE_STATS_URL}).`,
    ].join("\n");
    await ctx.reply(text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: "📊 Live stats", url: SITE_STATS_URL }]],
      },
    });
  } catch (err) {
    console.warn("[community-tvl] failed:", err.message);
    await ctx.reply(`⚠️ TVL briefly unavailable. Try again, or see ${SITE_STATS_URL}`, { disable_web_page_preview: true });
  }
}

/* ─────────────────────────── /liquidations ─────────────────────────── */

export async function handleCommunityLiquidations(ctx) {
  try {
    const { rows: [r] } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status='liquidated')::int AS liquidated,
         COUNT(*) FILTER (WHERE status='repaid')::int     AS repaid,
         COUNT(*) FILTER (WHERE status='active')::int     AS active,
         COUNT(*)::int                                    AS total`,
    );
    const liqRate = r.total > 0 ? ((r.liquidated / r.total) * 100).toFixed(2) : "0.00";
    const text = [
      `🛡 *Magpie · liquidation history*`,
      "```",
      RULE,
      row("LIQUIDATED LIFETIME", fmtInt(r.liquidated)),
      row("LIQUIDATION RATE", `${liqRate}%`),
      RULE,
      ``,
      row("Total loans ever issued", fmtInt(r.total)),
      row("Active right now", fmtInt(r.active)),
      row("Repaid successfully", fmtInt(r.repaid)),
      RULE,
      "```",
      ``,
      `*Why it stays this low*`,
      `• Short loan terms (2–7 days max)`,
      `• Conservative LTV tiers (20–30%)`,
      `• Token-health watcher pauses high-risk tokens proactively`,
      `• Keeper network triggers liquidation the moment health falls`,
      `• Auto-Protect (in /security) tops up users' collateral automatically`,
      ``,
      `_Every liquidation is on-chain. Verify the count yourself at [magpie.capital/stats](${SITE_STATS_URL})._`,
    ].join("\n");
    await ctx.reply(text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: "📊 Verify live", url: SITE_STATS_URL }]],
      },
    });
  } catch (err) {
    console.warn("[community-liquidations] failed:", err.message);
    await ctx.reply(`⚠️ Liquidation data briefly unavailable. Try again, or see ${SITE_STATS_URL}`, { disable_web_page_preview: true });
  }
}

/* ─────────────────────────── /phantom ─────────────────────────── */

export async function handleCommunityPhantom(ctx) {
  const text = [
    `🟣 *Phantom dApp — known issue*`,
    ``,
    `We're aware some users are seeing issues with the Magpie dApp inside Phantom's mobile browser. We're working closely with the Phantom team to resolve it and hope to have it sorted soon.`,
    ``,
    `*Workarounds in the meantime*`,
    `• Use the *Telegram wallet bot* — same protocol, same features, fully working: [@magpie\\_capital\\_bot](${WALLET_BOT_URL})`,
    `• Open magpie.capital in a regular browser (Safari, Chrome, Brave) and connect Phantom from there — usually works.`,
    ``,
    `_Updates will go out via [@MagpieLoans](${X_URL}) once it's resolved._`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📲 Use the TG bot instead", url: WALLET_BOT_URL },
          { text: "🌐 Try magpie.capital", url: SITE_URL },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /credit ─────────────────────────── */

export async function handleCommunityCredit(ctx) {
  const text = [
    `⭐ *Magpie · credit score*`,
    ``,
    `A 300–850 on-chain credit score, tracked by your wallet. Your repayment history shows up here over time.`,
    ``,
    `*What moves it*`,
    `  +  Repaying loans on time`,
    `  +  Closing loans early`,
    `  +  Long history of healthy positions`,
    `  −  Missing a deadline`,
    `  −  Getting liquidated`,
    ``,
    `*Why it matters*`,
    `Higher scores unlock better terms over time as the protocol grows. Today it's a public proof of repayment behavior — tomorrow it gates better tiers and reduced fees.`,
    ``,
    ``,
    `*Tier benefits (updated 2026-06-08)*`,
    `• 🥉 Bronze (300-499) → 5 SOL / 10 SOL outstanding (after on-time history)`,
    `• 🥈 Silver (500-649) → 5 SOL / 10 SOL outstanding`,
    `• 🥇 *Gold (650+)* → *50 SOL / 50 SOL outstanding* ← upgraded`,
    `• 💎 *Platinum (750+)* → *50 SOL / 50 SOL outstanding* ← highest tier`,
    ``,
    `*How to check yours*`,
    `• In the bot: \`/credit\` (DM @magpie\\_capital\\_bot)`,
    `• On the site: [magpie.capital/credit](${SITE_URL}/credit)`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⭐ See your score", url: WALLET_BOT_URL },
          { text: "📖 Read more", url: `${SITE_URL}/credit` },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /lend ─────────────────────────── */

export async function handleCommunityLend(ctx) {
  const text = [
    `🏦 *Lending into the Magpie pool*`,
    ``,
    `Deposit SOL → earn *80% of all protocol loan fees*, pro-rata to your share of the pool.`,
    ``,
    `*How it works*`,
    `• You deposit SOL → receive pool shares`,
    `• Borrowers pay fees on every loan (Express 3% / Quick 2% / Standard 1.5%)`,
    `• 80% of every fee flows back to the LP pool, distributed pro-rata`,
    `• Withdraw your share + earnings any time`,
    ``,
    `*The trade-off*`,
    `Your SOL backs the loan book. In a flash crash, liquidations might lag price moves — LPs can absorb losses in extreme markets. Short terms + low LTV + the keeper network are designed to keep this rare. Zero LP losses to date.`,
    ``,
    `*Get started*`,
    `[magpie.capital/earn](${SITE_URL}/earn) or \`/lend\` in the bot.`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🏦 Deposit", url: `${SITE_URL}/earn` },
          { text: "📊 Live LP stats", url: SITE_STATS_URL },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /keeper ─────────────────────────── */

export async function handleCommunityKeeper(ctx) {
  const text = [
    `⚡ *Magpie keeper network*`,
    ``,
    `The keeper network is the off-chain swarm that watches every loan in real time and triggers liquidation the moment a position drops below the health threshold.`,
    ``,
    `*Why it exists*`,
    `Solana's on-chain program can't poll prices itself — it needs an outside actor to call \`liquidate\` when conditions are met. Keepers run that watchdog loop.`,
    ``,
    `*Who can run a keeper?*`,
    `Anyone. The keeper that triggers a successful liquidation earns a small reward in SOL out of the liquidated collateral. Open-source code, permissionless to participate.`,
    ``,
    `*Why this matters for users*`,
    `Multiple independent keepers means no single point of failure. Even if the protocol's reference keeper goes offline, others step in. Liquidations stay timely → LPs and borrowers both protected.`,
    ``,
    `Full details: [magpie.capital/earn#keeper](${SITE_URL}/earn#keeper)`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "⚡ Keeper details", url: `${SITE_URL}/earn#keeper` }]],
    },
  });
}

/* ─────────────────────────── /wallet ─────────────────────────── */

export async function handleCommunityWallet(ctx) {
  const text = [
    `💼 *Your Magpie wallet*`,
    ``,
    `When you /start the bot in DM, Magpie creates a fresh Solana wallet just for you. This is YOUR wallet — and the key to one-click loans.`,
    ``,
    `*What's special about it*`,
    `Magpie's bot can co-sign transactions for you. That's why /borrow lands in seconds with no Phantom popup per step. The trade-off: the bot holds the encrypted private key.`,
    ``,
    `*How it's protected*`,
    `• Encrypted at rest with AES-256-GCM`,
    `• Per-user initialization vector`,
    `• Encryption key separate from the database`,
    `• You can \`/export\` the private key any time to self-custody`,
    ``,
    `*Want to use your existing wallet instead?*`,
    `\`/import\` lets you bring in a Solana wallet you already own. Same flows, same one-click experience.`,
    ``,
    `*Want to connect on the site?*`,
    `Phantom / Solflare / Backpack all work at [magpie.capital](${SITE_URL}). Site-side actions are signed per-transaction in your existing wallet — no co-signing.`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💼 Get your wallet", url: WALLET_BOT_URL },
          { text: "🌐 Connect on site", url: SITE_URL },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /faq ─────────────────────────── */

export async function handleCommunityFaq(ctx) {
  const text = [
    `❓ *Magpie · frequently asked*`,
    ``,
    `*"Is Magpie custodial?"*`,
    `Your Magpie wallet IS the bot wallet — that's what lets us co-sign repayments in one click. Encrypted at rest with AES-256-GCM, per-user IV. You can /export the private key any time and self-custody.`,
    ``,
    `*"What happens if my token's price tanks?"*`,
    `If health factor drops below 1.1× of LTV, the loan is liquidated and the collateral is sold to repay the SOL. /topup to add more collateral and avoid this. Auto-Protect (in /security) can do this automatically.`,
    ``,
    `*"Can I repay early?"*`,
    `Yes — zero penalty. You only pay the upfront tier fee (Express 3% / Quick 2% / Standard 1.5%).`,
    ``,
    `*"Why are the terms so short?"*`,
    `Short terms + low LTV are why our lifetime liquidation rate stays under 1% across 299+ loans. Memecoin volatility is high; long terms would mean way more liquidations. Live count: /liquidations`,
    ``,
    `*"Can I switch tiers mid-loan?"*`,
    `No — close the loan with /repay, then open a new one in the tier you want.`,
    ``,
    `*"What's $MAGPIE?"*`,
    `The protocol token. $MAGPIE holders earn 70% of all loan fees pro-rata. Distributions are randomized (every 5–10 days).`,
    ``,
    `*"How is this not a scam?"*`,
    `Everything is on-chain and verifiable. Pool TVL, every loan, every repayment, every liquidation — read it on solscan or magpie.capital/stats. Both repos are public on github.com/magpiecapital.`,
    ``,
    `*"Will Magpie ever DM me?"*`,
    `*Never.* We do not initiate DMs. Anyone DMing you claiming to be Magpie support is a scammer. Our only two TG accounts are @magpie\\_capital\\_bot (this private chat) and @magpietalk (this group).`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📚 Full docs", url: `${SITE_URL}/docs` },
          { text: "🔒 Security", url: `${SITE_URL}/security` },
        ],
      ],
    },
  });
}

/* ─────────────────────────── /scam ─────────────────────────── */

export async function handleCommunityScam(ctx) {
  const text = [
    `🚨 *Common Magpie-themed scams — know the patterns*`,
    ``,
    `*"Magpie Support" DMs you first*`,
    `→ Magpie never DMs anyone first. There is no support DM account. Block and report.`,
    ``,
    `*"Free $MAGPIE airdrop — claim here"*`,
    `→ No airdrop exists. Any "claim" page is a wallet-drainer. Don't click.`,
    ``,
    `*"Send 1 SOL to receive 10 SOL"*`,
    `→ Classic doubler scam. Magpie does not run promotions. Anyone offering this is stealing your SOL.`,
    ``,
    `*"@MagpieLoansSupport" / "@MagpieCapitalOfficial" etc.*`,
    `→ Only *@MagpieLoans* on X is real. Only *@magpie\\_capital\\_bot* and *@magpietalk* on TG are real. Anything else with "Magpie" in the name is impersonation.`,
    ``,
    `*"I'll help you recover your wallet — just share your seed phrase"*`,
    `→ Never. Anyone asking for your seed phrase is robbing you. There is no recovery service. Even Magpie cannot ask for it.`,
    ``,
    `*A "Magpie team member" DM asking you to test a new feature on a custom URL*`,
    `→ Real features ship inside @magpie\\_capital\\_bot or at magpie.capital. Custom URLs are phishing.`,
    ``,
    `*"Magpie is being hacked — withdraw immediately to this address"*`,
    `→ Panic-induce scam. Verify any incident at magpie.capital/security before acting. The protocol won't ever ask you to send SOL anywhere.`,
    ``,
    `_When in doubt: do nothing, ask in this group with /ask, and verify on-chain at solscan.io._`,
  ].join("\n");
  await ctx.reply(text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
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
  // Core utility
  stats: handleCommunityStats,
  tiers: handleCommunityTiers,
  fees: handleCommunityFees,
  how: handleCommunityHow,
  tokens: handleCommunityTokens,
  // Token
  ca: handleCommunityCa,
  contract: handleCommunityCa,         // alias — same thing, different muscle memory
  magpie: handleCommunityMagpie,
  buy: handleCommunityBuy,
  chart: handleCommunityChart,
  charts: handleCommunityChart,        // alias
  price: handleCommunityChart,         // alias — common ask, route to charts
  // Programs
  holders: handleCommunityHolders,
  refer: handleCommunityRefer,
  referral: handleCommunityRefer,      // alias
  // Protocol concepts
  credit: handleCommunityCredit,
  score: handleCommunityCredit,        // alias
  // LP / pool metrics
  apy: handleCommunityApy,
  apr: handleCommunityApy,             // alias — APR is technically what we compute
  yield: handleCommunityApy,           // alias
  tvl: handleCommunityTvl,
  pool: handleCommunityTvl,            // alias
  liquidations: handleCommunityLiquidations,
  liquidated: handleCommunityLiquidations, // alias
  liqs: handleCommunityLiquidations,   // alias (DeFi shorthand)
  // Known issues
  phantom: handleCommunityPhantom,
  dapp: handleCommunityPhantom,        // alias — same canned status
  lend: handleCommunityLend,
  earn: handleCommunityLend,           // alias — what /earn does on the site
  keeper: handleCommunityKeeper,
  keepers: handleCommunityKeeper,      // alias
  wallet: handleCommunityWallet,
  // Reference
  faq: handleCommunityFaq,
  scam: handleCommunityScam,
  scams: handleCommunityScam,          // alias
  website: handleCommunityWebsite,
  site: handleCommunityWebsite,        // alias
  x402: handleCommunityX402,
  agent: handleCommunityX402,          // alias — common ask format
  agents: handleCommunityX402,         // alias
  docs: handleCommunityDocs,
  whitepaper: handleCommunityWhitepaper,
  wp: handleCommunityWhitepaper,       // alias — common abbreviation
  links: handleCommunityLinks,
  x: handleCommunityX,
  twitter: handleCommunityX,           // alias
  // Transparency
  audit: handleCommunityAudit,
  risk: handleCommunityRisk,
  risks: handleCommunityRisk,          // alias
  team: handleCommunityTeam,
  about: handleCommunityTeam,          // alias — same content
  // Support handoff
  support: handleCommunitySupport,
  help: handleCommunitySupport,        // alias — common ask
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
