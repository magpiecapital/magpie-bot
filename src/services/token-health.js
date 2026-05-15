/**
 * Token Health Monitor — automated delisting of rugged or degraded tokens.
 *
 * Runs every 15 minutes alongside the token screener. For each enabled token
 * in supported_mints, checks current market data and flags/delists tokens that:
 *
 *   1. INSTANT DELIST (rug detected):
 *      - Liquidity drops below $5K (LP pulled)
 *      - Market cap drops below $10K
 *      - Mint authority appeared (wasn't there at approval)
 *      - No trading pairs found on DexScreener (token dead)
 *
 *   2. WATCHLIST (degraded — 2 consecutive strikes → delist):
 *      - Liquidity drops below $25K
 *      - 24h volume below $5K
 *      - Market cap below $50K
 *
 * When a token is delisted:
 *   - supported_mints.enabled = FALSE (no new loans)
 *   - Admin is notified
 *   - Users with active loans against the token are warned
 *   - Existing loans remain valid (users can still repay/reclaim)
 */
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { PublicKey } from "@solana/web3.js";

const POLL_INTERVAL_MS = Number(process.env.TOKEN_HEALTH_INTERVAL_MS) || 900_000; // 15 min
const ADMIN_TG_ID = process.env.ADMIN_TELEGRAM_ID;

// ── Thresholds ──────────────────────────────────────────────────────────────

// Instant delist — clear rug signals
const RUG_THRESHOLDS = {
  maxLiquidityUsd: 5_000,
  maxMarketCap: 10_000,
};

// Watchlist — degraded but not dead yet
const WATCHLIST_THRESHOLDS = {
  maxLiquidityUsd: 25_000,
  maxVolume24h: 5_000,
  maxMarketCap: 50_000,
};

// Strikes before watchlist → delist (6 strikes × 15 min = 90 min of degraded data)
const STRIKES_TO_DELIST = 6;

// ── Market data ─────────────────────────────────────────────────────────────

async function getMarketData(mints) {
  const result = new Map();
  const BATCH = 30;

  for (let i = 0; i < mints.length; i += BATCH) {
    const batch = mints.slice(i, i + BATCH);
    try {
      const res = await fetch(
        `https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`,
      );
      if (!res.ok) continue;
      const pairs = await res.json();
      if (!Array.isArray(pairs)) continue;

      for (const p of pairs) {
        const addr = p.baseToken?.address;
        if (!addr) continue;
        const liq = p.liquidity?.usd ?? 0;
        const existing = result.get(addr);
        if (existing && (existing.liquidity ?? 0) >= liq) continue;

        result.set(addr, {
          symbol: p.baseToken?.symbol || "???",
          liquidity: liq,
          volume24h: p.volume?.h24 ?? 0,
          marketCap: p.marketCap ?? p.fdv ?? 0,
        });
      }
    } catch (err) {
      console.error("[token-health] market data error:", err.message);
    }
  }
  return result;
}

// ── On-chain mint authority check ───────────────────────────────────────────

async function checkMintAuthority(mintStr) {
  try {
    const info = await connection.getAccountInfo(new PublicKey(mintStr));
    if (!info || info.data.length < 82) return null;
    return { hasMintAuthority: info.data.readUInt32LE(0) === 1 };
  } catch {
    return null;
  }
}

// ── Delist a token ──────────────────────────────────────────────────────────

async function delistToken(mint, symbol, reason, bot) {
  await query(
    `UPDATE supported_mints SET enabled = FALSE WHERE mint = $1`,
    [mint],
  );

  console.log(`[token-health] DELISTED ${symbol}: ${reason}`);

  // Notify admin
  if (bot && ADMIN_TG_ID) {
    try {
      await bot.api.sendMessage(
        ADMIN_TG_ID,
        `*Token Delisted*\n\n*${symbol}* has been automatically removed.\nReason: ${reason}\n\n\`${mint}\`\n\nExisting loans are unaffected — users can still repay.`,
        { parse_mode: "Markdown" },
      );
    } catch { /* non-critical */ }
  }

  // Warn users with active loans
  if (bot) {
    try {
      const { rows: affectedLoans } = await query(
        `SELECT l.id, u.telegram_id
         FROM loans l
         JOIN users u ON u.id = l.user_id
         WHERE l.collateral_mint = $1 AND l.status = 'active'`,
        [mint],
      );

      for (const loan of affectedLoans) {
        try {
          await bot.api.sendMessage(
            loan.telegram_id,
            `*Warning: ${symbol} has been delisted*\n\nThis token no longer meets our safety criteria and has been removed from supported collateral.\n\nYour existing loan is still active — you can /repay at any time to reclaim your tokens. No new loans can be taken against ${symbol}.`,
            { parse_mode: "Markdown" },
          );
        } catch { /* user may have blocked bot */ }
      }

      if (affectedLoans.length > 0) {
        console.log(`[token-health] Warned ${affectedLoans.length} users with active ${symbol} loans`);
      }
    } catch (err) {
      console.error("[token-health] Error notifying users:", err.message);
    }
  }
}

// ── Main tick ───────────────────────────────────────────────────────────────

async function tick(bot) {
  // Get all enabled tokens (skip protected and stock tokens — stocks legitimately have mint/freeze authority)
  const { rows: tokens } = await query(
    `SELECT mint, symbol, has_mint_authority, health_strikes, category
     FROM supported_mints
     WHERE enabled = TRUE AND (protected IS NOT TRUE) AND (category IS DISTINCT FROM 'stock')`,
  );

  if (tokens.length === 0) return;

  const mints = tokens.map((t) => t.mint);
  const marketData = await getMarketData(mints);

  const delisted = [];
  const watchlisted = [];
  const recovered = [];

  for (const token of tokens) {
    const { mint, symbol } = token;
    const market = marketData.get(mint);
    const strikes = token.health_strikes || 0;

    // No market data found — token may be dead
    if (!market) {
      // Check if it's truly gone or just a DexScreener hiccup
      if (strikes >= STRIKES_TO_DELIST) {
        await delistToken(mint, symbol, "No trading data found (token appears dead)", bot);
        delisted.push(symbol);
      } else {
        await query(
          `UPDATE supported_mints SET health_strikes = COALESCE(health_strikes, 0) + 1 WHERE mint = $1`,
          [mint],
        );
        watchlisted.push({ symbol, reason: "no market data" });
      }
      continue;
    }

    // ── Instant delist checks ──

    // Liquidity pulled
    if (market.liquidity < RUG_THRESHOLDS.maxLiquidityUsd) {
      await delistToken(
        mint, symbol,
        `Liquidity collapsed to $${Math.floor(market.liquidity).toLocaleString()} (threshold: $${RUG_THRESHOLDS.maxLiquidityUsd.toLocaleString()})`,
        bot,
      );
      delisted.push(symbol);
      continue;
    }

    // Market cap cratered
    if (market.marketCap < RUG_THRESHOLDS.maxMarketCap) {
      await delistToken(
        mint, symbol,
        `Market cap collapsed to $${Math.floor(market.marketCap).toLocaleString()} (threshold: $${RUG_THRESHOLDS.maxMarketCap.toLocaleString()})`,
        bot,
      );
      delisted.push(symbol);
      continue;
    }

    // Mint authority appeared after approval (supply rug)
    if (!token.has_mint_authority) {
      const onChain = await checkMintAuthority(mint);
      if (onChain?.hasMintAuthority) {
        await delistToken(
          mint, symbol,
          "Mint authority was enabled after approval — supply can now be inflated",
          bot,
        );
        delisted.push(symbol);
        continue;
      }
    }

    // ── Watchlist checks ──
    // Skip watchlist for tokens with >$1M mcap — low liquidity reading is likely
    // a DexScreener data issue (batch API sometimes returns only one pair)
    const highMcap = market.marketCap > 1_000_000;
    const degraded = !highMcap && (
      market.liquidity < WATCHLIST_THRESHOLDS.maxLiquidityUsd ||
      market.volume24h < WATCHLIST_THRESHOLDS.maxVolume24h ||
      market.marketCap < WATCHLIST_THRESHOLDS.maxMarketCap
    );

    if (degraded) {
      const newStrikes = strikes + 1;
      if (newStrikes >= STRIKES_TO_DELIST) {
        const reasons = [];
        if (market.liquidity < WATCHLIST_THRESHOLDS.maxLiquidityUsd)
          reasons.push(`liquidity $${Math.floor(market.liquidity).toLocaleString()}`);
        if (market.volume24h < WATCHLIST_THRESHOLDS.maxVolume24h)
          reasons.push(`volume $${Math.floor(market.volume24h).toLocaleString()}`);
        if (market.marketCap < WATCHLIST_THRESHOLDS.maxMarketCap)
          reasons.push(`mcap $${Math.floor(market.marketCap).toLocaleString()}`);

        await delistToken(
          mint, symbol,
          `Degraded for ${newStrikes} consecutive checks: ${reasons.join(", ")}`,
          bot,
        );
        delisted.push(symbol);
      } else {
        await query(
          `UPDATE supported_mints SET health_strikes = $2 WHERE mint = $1`,
          [mint, newStrikes],
        );
        watchlisted.push({ symbol, strikes: newStrikes });
      }
    } else if (strikes > 0) {
      // Token recovered — reset strikes
      await query(
        `UPDATE supported_mints SET health_strikes = 0 WHERE mint = $1`,
        [mint],
      );
      recovered.push(symbol);
    }

    // Update stored market data
    await query(
      `UPDATE supported_mints
       SET liquidity_usd = $2, market_cap_usd = $3, screened_at = NOW()
       WHERE mint = $1`,
      [mint, market.liquidity, market.marketCap],
    );
  }

  // Log summary
  if (delisted.length > 0) {
    console.log(`[token-health] Delisted: ${delisted.join(", ")}`);
  }
  if (watchlisted.length > 0) {
    console.log(`[token-health] Watchlist: ${watchlisted.map((w) => `${w.symbol} (${w.strikes || w.reason})`).join(", ")}`);
  }
  if (recovered.length > 0) {
    console.log(`[token-health] Recovered: ${recovered.join(", ")}`);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function startTokenHealth(bot) {
  console.log(`🩺 Token health monitor running (every ${POLL_INTERVAL_MS / 1000}s)`);

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(bot);
    } catch (err) {
      console.error("[token-health] cycle error:", err.message);
    } finally {
      running = false;
    }
  };

  run();
  return setInterval(run, POLL_INTERVAL_MS);
}
