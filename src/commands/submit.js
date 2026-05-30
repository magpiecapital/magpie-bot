/**
 * /submit <mint|symbol> — user submits a token for collateral approval.
 *
 * Runs the full vetting pipeline (on-chain + market data) in ~2-3 seconds
 * and responds instantly with one of:
 *   - Auto-approved  → token goes live immediately
 *   - Auto-rejected  → user gets clear explanation
 *   - Borderline     → queued for admin review, user notified
 *
 * Rate-limited to 1 submission per user per 60 seconds.
 */
import { query } from "../db/pool.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { connection } from "../solana/connection.js";
import { InlineKeyboard } from "grammy";
import {
  checkSellable,
  auditTokenExtensions,
  checkHolderConcentration,
  checkImpersonation,
  rugcheckRisk,
  isSubmitterCoolingDown,
  recordSubmitterRejection,
} from "../services/token-screener.js";

const ADMIN_TG_ID = process.env.ADMIN_TELEGRAM_ID;

// Per-user cooldown (userId → timestamp)
const cooldowns = new Map();
const COOLDOWN_MS = 60_000;

// ── On-chain mint info ──────────────────────────────────────────────────────

async function getOnChainInfo(mintStr) {
  try {
    const mintPk = new PublicKey(mintStr);
    const info = await connection.getAccountInfo(mintPk);
    if (!info) return null;
    const data = info.data;
    if (data.length < 82) return null;
    return {
      decimals: data.readUInt8(44),
      hasMintAuthority: data.readUInt32LE(0) === 1,
      hasFreezeAuthority: data.readUInt32LE(46) === 1,
    };
  } catch {
    return null;
  }
}

// ── Market data ─────────────────────────────────────────────────────────────

async function fetchMarketData(mint) {
  const res = await fetch(
    `https://api.dexscreener.com/tokens/v1/solana/${mint}`,
  );
  if (!res.ok) return null;
  const pairs = await res.json();
  if (!Array.isArray(pairs) || pairs.length === 0) return null;

  // Pick the pair with the highest liquidity
  let best = null;
  for (const p of pairs) {
    const liq = p.liquidity?.usd ?? 0;
    if (!best || liq > (best.liquidity ?? 0)) {
      best = {
        symbol: p.baseToken?.symbol || "???",
        name: p.baseToken?.name || p.baseToken?.symbol || "Unknown",
        price: p.priceUsd ? parseFloat(p.priceUsd) : null,
        liquidity: liq,
        volume24h: p.volume?.h24 ?? 0,
        marketCap: p.marketCap ?? p.fdv ?? 0,
        pairCreatedAt: p.pairCreatedAt ?? null,
        imageUrl: p.info?.imageUrl ?? null,
      };
    }
  }
  return best;
}

// ── Resolve symbol to mint via DexScreener search ───────────────────────────

async function resolveSymbol(input) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(input)}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.pairs) return null;

    // Find best Solana match by liquidity
    let best = null;
    for (const p of data.pairs) {
      if (p.chainId !== "solana") continue;
      const liq = p.liquidity?.usd ?? 0;
      if (!best || liq > best.liq) {
        best = { mint: p.baseToken?.address, liq };
      }
    }
    return best?.mint ?? null;
  } catch {
    return null;
  }
}

// ── Thresholds (mirrors token-screener.js) ──────────────────────────────────

const AUTO_APPROVE = {
  minLiquidityUsd: 75_000,
  minAgeHours: 24,
  minVolume24h: 50_000,
  minMarketCap: 250_000,
};

// Calibrated for pump-style launches: 24h volume bar must be small because
// a 4h-old token hasn't had 24h to accumulate volume yet.
const MIN_CONSIDER = {
  minLiquidityUsd: 5_000,
  minAgeHours: 4,
  minVolume24h: 500,
};

// ── Command handler ─────────────────────────────────────────────────────────

export async function handleSubmit(ctx) {
  const text = ctx.message?.text || "";
  const input = text.replace(/^\/submit\s*/i, "").trim();

  if (!input) {
    return ctx.reply(
      "Usage: `/submit <mint address or symbol>`\n\nExample:\n`/submit BONK`\n`/submit DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`",
      { parse_mode: "Markdown" },
    );
  }

  // Rate limit
  const userId = ctx.from?.id;
  const lastSubmit = cooldowns.get(userId);
  if (lastSubmit && Date.now() - lastSubmit < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - lastSubmit)) / 1000);
    return ctx.reply(`Please wait ${wait}s before submitting another token.`);
  }
  cooldowns.set(userId, Date.now());

  await ctx.reply("Analyzing token...");

  // ── Resolve input to mint address ──
  let mint = input;
  const isAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input);
  if (!isAddress) {
    const resolved = await resolveSymbol(input);
    if (!resolved) {
      return ctx.reply(
        `Could not find a Solana token matching "${input}". Try submitting the full mint address instead.`,
      );
    }
    mint = resolved;
  }

  // ── Check if already supported ──
  const { rows: existing } = await query(
    `SELECT symbol, enabled FROM supported_mints WHERE mint = $1`,
    [mint],
  );
  if (existing.length > 0) {
    const e = existing[0];
    if (e.enabled) {
      return ctx.reply(`*${e.symbol}* is already supported as collateral.`, {
        parse_mode: "Markdown",
      });
    }
    return ctx.reply(
      `*${e.symbol}* was previously reviewed and is not currently accepted.`,
      { parse_mode: "Markdown" },
    );
  }

  // ── Check if already in review queue ──
  const { rows: queued } = await query(
    `SELECT symbol, status FROM token_screen_queue WHERE mint = $1`,
    [mint],
  );
  if (queued.length > 0) {
    const q = queued[0];
    if (q.status === "pending") {
      return ctx.reply(
        `*${q.symbol}* is already under review — typically approved within 1 hour. You'll be notified.`,
        { parse_mode: "Markdown" },
      );
    }
    if (q.status === "rejected") {
      return ctx.reply(
        `*${q.symbol}* was previously reviewed and rejected.`,
        { parse_mode: "Markdown" },
      );
    }
  }

  // ── On-chain + market data (parallel) ──
  const [onChain, market] = await Promise.all([
    getOnChainInfo(mint),
    fetchMarketData(mint),
  ]);

  if (!onChain) {
    return ctx.reply(
      "Could not read on-chain data for this mint. Make sure the address is a valid SPL token.",
    );
  }
  if (!market) {
    return ctx.reply(
      "No trading pairs found for this token on DexScreener. The token needs active trading history.",
    );
  }

  const ageHours = market.pairCreatedAt
    ? Math.floor((Date.now() - market.pairCreatedAt) / 3_600_000)
    : 0;

  // ── Safety checks ──
  // Size/age/volume failures = hard reject (truly garbage).
  // Authority flags = warning only — go to /reviewtokens for admin to decide.
  const fails = [];
  const warnings = [];

  if (onChain.hasMintAuthority) warnings.push("Mint authority is enabled — supply can be inflated");
  if (onChain.hasFreezeAuthority) warnings.push("Freeze authority is enabled — tokens can be frozen");
  if (market.liquidity < MIN_CONSIDER.minLiquidityUsd)
    fails.push(`Liquidity ($${Math.floor(market.liquidity).toLocaleString()}) below $${MIN_CONSIDER.minLiquidityUsd.toLocaleString()} minimum`);
  if (ageHours < MIN_CONSIDER.minAgeHours)
    fails.push(`Token is only ${ageHours}h old (minimum ${MIN_CONSIDER.minAgeHours}h)`);
  if (market.volume24h < MIN_CONSIDER.minVolume24h)
    fails.push(`24h volume ($${Math.floor(market.volume24h).toLocaleString()}) below $${MIN_CONSIDER.minVolume24h.toLocaleString()} minimum`);

  // Submitter cooldown: 3 rejections in 24h blocks further submissions.
  // Stops a single bad actor from brute-forcing the screener.
  const cooldown = await isSubmitterCoolingDown(userId);
  if (!cooldown.allowed) {
    return ctx.reply(
      `*Cooldown active* — ${cooldown.reason}. Try again later.`,
      { parse_mode: "Markdown" },
    );
  }

  // Impersonation guard: matching symbol/name to a canonical token but
  // different mint = block. Cheap in-memory check, runs first.
  const imp = checkImpersonation(mint, market.symbol, market.name);
  if (!imp.ok) {
    await recordSubmitterRejection(userId, mint, imp.reason);
    return ctx.reply(
      [
        `*${market.symbol}* — Rejected (impersonation)`,
        "",
        `Reason: \`${imp.reason}\``,
        "",
        "Use the canonical mint address instead.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  // Full scam-token audit. Runs sellability, extension audit, holder
  // concentration, and RugCheck in parallel. Reject on the first
  // failure with a specific reason.
  // /submit is a user-facing decision point — always run fresh audits,
  // never serve a cached verdict for this path.
  const [sell, ext, conc, rug] = await Promise.all([
    checkSellable(mint, onChain.decimals),
    auditTokenExtensions(mint, { fresh: true }),
    checkHolderConcentration(mint, { fresh: true }),
    rugcheckRisk(mint, { fresh: true }),
  ]);
  const scamReason =
    !sell.sellable ? `honeypot — ${sell.reason}`
    : !ext.safe ? `unsafe Token-2022 extension — ${ext.reason}`
    : !conc.ok ? `holder concentration — ${conc.reason}`
    : !rug.ok ? `${rug.reason}`
    : null;
  if (scamReason) {
    await recordSubmitterRejection(userId, mint, scamReason);
    return ctx.reply(
      [
        `*${market.symbol}* — Rejected (scam-token guard)`,
        "",
        `Reason: \`${scamReason}\``,
        "",
        "Magpie can't accept collateral that fails our safety audit.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  // Hard reject only on real size/age failures.
  if (fails.length > 0) {
    const lines = [
      `*${market.symbol}* — Not Approved`,
      "",
      `Liquidity: $${Math.floor(market.liquidity).toLocaleString()}`,
      `Volume 24h: $${Math.floor(market.volume24h).toLocaleString()}`,
      `Market Cap: $${Math.floor(market.marketCap).toLocaleString()}`,
      `Age: ${ageHours}h`,
      `Mint authority: ${onChain.hasMintAuthority ? "YES" : "no"}`,
      `Freeze authority: ${onChain.hasFreezeAuthority ? "YES" : "no"}`,
      "",
      "*Issues:*",
      ...fails.map((f) => `  • ${f}`),
      ...warnings.map((w) => `  • ${w}`),
      "",
      "This token does not meet our safety criteria for collateral.",
    ];
    return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  }

  // ── Auto-approve vs review ──
  // Auto-approve still requires authority revoked — warnings block this.
  const canAutoApprove =
    !onChain.hasMintAuthority &&
    !onChain.hasFreezeAuthority &&
    market.liquidity >= AUTO_APPROVE.minLiquidityUsd &&
    ageHours >= AUTO_APPROVE.minAgeHours &&
    market.volume24h >= AUTO_APPROVE.minVolume24h &&
    market.marketCap >= AUTO_APPROVE.minMarketCap;

  if (canAutoApprove) {
    // Insert into supported_mints immediately
    await query(
      `INSERT INTO supported_mints
         (mint, symbol, name, decimals, category, image_url, liquidity_usd,
          holder_count, market_cap_usd, has_mint_authority, has_freeze_authority,
          lp_burned, token_age_hours, auto_approved, screened_at, source, enabled)
       VALUES ($1,$2,$3,$4,'memecoin',$5,$6,0,$7,FALSE,FALSE,FALSE,$8,TRUE,NOW(),'user_submit',TRUE)
       ON CONFLICT (mint) DO UPDATE SET enabled = TRUE`,
      [
        mint,
        market.symbol.toUpperCase(),
        market.name,
        onChain.decimals,
        market.imageUrl,
        market.liquidity,
        market.marketCap,
        ageHours,
      ],
    );

    // Mark as seen so the background screener doesn't re-process
    await query(
      `INSERT INTO token_screen_seen (mint) VALUES ($1) ON CONFLICT DO NOTHING`,
      [mint],
    );

    const kb = new InlineKeyboard()
      .text("💰 Borrow", "start:borrow")
      .text("📋 Supported", "fallback:supported");

    const lines = [
      `*${market.symbol}* — Approved!`,
      "",
      `Liquidity: $${Math.floor(market.liquidity).toLocaleString()}`,
      `Volume 24h: $${Math.floor(market.volume24h).toLocaleString()}`,
      `Market Cap: $${Math.floor(market.marketCap).toLocaleString()}`,
      `Age: ${ageHours}h`,
      "",
      "This token is now live as collateral. You can borrow against it immediately.",
    ];

    await ctx.reply(lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: kb,
    });

    // Notify admin
    if (ADMIN_TG_ID) {
      try {
        await ctx.api.sendMessage(
          ADMIN_TG_ID,
          `*User-submitted token auto-approved*\n\n${market.symbol} — $${Math.floor(market.liquidity).toLocaleString()} liq, $${Math.floor(market.marketCap).toLocaleString()} mcap\nSubmitted by user ${userId}\n\`${mint}\``,
          { parse_mode: "Markdown" },
        );
      } catch { /* non-critical */ }
    }
  } else {
    // Borderline — queue for review
    await query(
      `INSERT INTO token_screen_queue
         (mint, symbol, name, decimals, category, image_url, liquidity_usd,
          volume_24h_usd, market_cap_usd, holder_count, has_mint_authority,
          has_freeze_authority, token_age_hours, safety_score, fail_reasons, status, submitted_by)
       VALUES ($1,$2,$3,$4,'memecoin',$5,$6,$7,$8,0,FALSE,FALSE,$9,70,$10,'pending',$11)
       ON CONFLICT (mint) DO UPDATE SET
         liquidity_usd = EXCLUDED.liquidity_usd,
         volume_24h_usd = EXCLUDED.volume_24h_usd,
         market_cap_usd = EXCLUDED.market_cap_usd,
         status = 'pending'`,
      [
        mint,
        market.symbol.toUpperCase(),
        market.name,
        onChain.decimals,
        market.imageUrl,
        market.liquidity,
        market.volume24h,
        market.marketCap,
        ageHours,
        ["Borderline — meets safety minimums but not auto-approve thresholds"],
        userId,
      ],
    );

    await query(
      `INSERT INTO token_screen_seen (mint) VALUES ($1) ON CONFLICT DO NOTHING`,
      [mint],
    );

    const lines = [
      `*${market.symbol}* — Under Review`,
      "",
      `Liquidity: $${Math.floor(market.liquidity).toLocaleString()}`,
      `Volume 24h: $${Math.floor(market.volume24h).toLocaleString()}`,
      `Market Cap: $${Math.floor(market.marketCap).toLocaleString()}`,
      `Age: ${ageHours}h`,
      "",
      "This token passed safety checks and is in the review queue. Tokens are typically approved within 1 hour — you'll be notified.",
    ];

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });

    // Notify admin with approve/reject buttons
    if (ADMIN_TG_ID) {
      try {
        const kb = new InlineKeyboard()
          .text("Approve", `screen:approve:${mint}`)
          .text("Reject", `screen:reject:${mint}`);

        await ctx.api.sendMessage(
          ADMIN_TG_ID,
          `*User submitted token for review*\n\n*${market.symbol}* — ${market.name}\nLiq: $${Math.floor(market.liquidity).toLocaleString()} | Vol: $${Math.floor(market.volume24h).toLocaleString()} | MCap: $${Math.floor(market.marketCap).toLocaleString()}\nAge: ${ageHours}h | Mint auth: no | Freeze auth: no\nSubmitted by user ${userId}\n\`${mint}\``,
          { parse_mode: "Markdown", reply_markup: kb },
        );
      } catch { /* non-critical */ }
    }
  }
}
