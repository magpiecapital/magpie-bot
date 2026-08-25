/**
 * Token Health Monitor — automated delisting of rugged or degraded tokens.
 *
 * Runs every 15 minutes alongside the token screener. For each enabled token
 * in supported_mints, checks current market data and flags/delists tokens that:
 *
 *   1. INSTANT DELIST (rug detected — still subject to circuit breaker):
 *      - Liquidity drops below $5K AND market cap below $50K (LP pulled)
 *      - Market cap drops below $10K
 *      - Mint authority appeared (wasn't there at approval)
 *
 *   2. WATCHLIST (degraded — 6 consecutive strikes → delist):
 *      - Liquidity drops below $25K
 *      - 24h volume below $5K
 *      - Market cap below $50K
 *      - Tokens with >$1M mcap are exempt (likely bad API data)
 *
 *   3. CIRCUIT BREAKER:
 *      - Max 3 delistings per cycle — if exceeded, abort and alert admin
 *      - Prevents mass-delist from bad DexScreener data
 *
 *   4. DATA VALIDATION:
 *      - If >50% of tokens return no market data, treat as API outage and skip
 *      - Instant delist requires BOTH low liquidity AND low mcap (not just one)
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
import { cachedJson } from "../lib/http-cache.js";
import { markCycle } from "../lib/heartbeat.js";

const POLL_INTERVAL_MS = Number(process.env.TOKEN_HEALTH_INTERVAL_MS) || 4 * 60 * 60 * 1000; // 4 hours
const ADMIN_TG_ID = process.env.ADMIN_TELEGRAM_ID;

// ── Thresholds ──────────────────────────────────────────────────────────────

// Instant delist — clear rug signals (BOTH conditions must be true)
const RUG_THRESHOLDS = {
  maxLiquidityUsd: 5_000,
  maxMarketCap: 50_000, // raised from $10K — must have BOTH low liq AND low mcap
};

// Market cap floor — below this is instant delist regardless of liquidity
const MCAP_FLOOR = 10_000;

// Liquidity floor — tokens below this no longer meet our entry criteria
// and can't realistically be liquidated. Instant delist, no strikes.
const LIQUIDITY_FLOOR = 10_000;

// 24h volume floor — a token with effectively no trading activity is
// dead collateral even if a stale pool still shows liquidity. Instant delist.
const VOLUME_FLOOR = 500;

// Watchlist — uses OR logic now: any ONE degraded metric earns a strike,
// not all three. Faster culling of tokens decaying in just one dimension
// (e.g. liquidity still ok but volume cratered, or vice versa).
const WATCHLIST_THRESHOLDS = {
  maxLiquidityUsd: 25_000,
  maxVolume24h: 5_000,
  maxMarketCap: 100_000,
};

// Strikes before watchlist → delist. At a 4h interval, 2 strikes = 8h of
// sustained degraded data. Down from 3 (12h) and 6 originally (24h).
const STRIKES_TO_DELIST = 2;

// Circuit breaker — max delistings per single cycle. Bumped up after
// tightening thresholds: first cycles will need to clear an accumulated
// backlog of decayed tokens, then settle into smaller per-cycle delists.
const MAX_DELISTS_PER_CYCLE = 25;

// If more than this fraction of tokens have no market data, treat as API outage
const API_OUTAGE_THRESHOLD = 0.5;

// ── Market data ─────────────────────────────────────────────────────────────

async function getMarketData(mints) {
  const result = new Map();
  const BATCH = 30;

  for (let i = 0; i < mints.length; i += BATCH) {
    const batch = mints.slice(i, i + BATCH);
    const pairs = await cachedJson(
      `https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`,
      { ttlMs: 30_000 },
    );
    if (!Array.isArray(pairs)) continue;

    for (const p of pairs) {
      const addr = p.baseToken?.address;
      if (!addr) continue;
      const liq = p.liquidity?.usd ?? 0;
      const existing = result.get(addr);
      if (existing && (existing.liquidity ?? 0) >= liq) continue;

      // Sanity floor on the stored market cap: a single mis-priced DexScreener
      // pair can report a TRILLIONS fdv (JUP showed $3.7T from a thin pool).
      // No real token is near $1T, so anything above that can only be bad
      // single-pair data — store 0 (unknown) rather than persist an absurd
      // figure that the /tokens detail page would render raw. The full
      // Jupiter cross-source correction lives site-side (TokensClient
      // robustMcap); this is the bot-side floor so the DB never holds a fake
      // trillions mcap. See feedback_token_display_must_cross_source_market_cap.
      const MAX_SANE_MCAP_USD = 1_000_000_000_000; // $1T
      const rawMcap = p.marketCap ?? p.fdv ?? 0;
      result.set(addr, {
        symbol: p.baseToken?.symbol || "???",
        liquidity: liq,
        volume24h: p.volume?.h24 ?? 0,
        marketCap: rawMcap > 0 && rawMcap <= MAX_SANE_MCAP_USD ? rawMcap : 0,
      });
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

// ── Re-check before ANY delist ──────────────────────────────────────────────
//
// 2026-08-25: DexScreener under per-IP rate limiting returns PARTIAL pair
// objects — missing marketCap/fdv/liquidity/volume fields coerce to 0, which
// is indistinguishable from a collapse. Seven healthy same-day promotions
// (HAMI, HOBBES, CHARLIE, MEMEFI, GOOSE, GUNICORN, PMV) were instantly
// delisted that way. Every delist decision now gets ONE targeted single-mint
// refetch after a breather; only a CONFIRMING fresh read may delist
// ([[feedback_watchdog_must_recheck_before_alarming]]). A null/failed
// re-read downgrades to the strike path — "can't see the token" is never
// proof it's dead.
async function recheckMarket(mint) {
  try {
    await new Promise((r) => setTimeout(r, 800));
    const fresh = await getMarketData([mint]);
    return fresh.get(mint) ?? null;
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
  // Get all enabled tokens (skip protected and RWA tokens — stocks/ETFs/metals
  // legitimately have mint/freeze authority from their issuer)
  const { rows: tokens } = await query(
    `SELECT mint, symbol, has_mint_authority, health_strikes, category
     FROM supported_mints
     WHERE enabled = TRUE AND (protected IS NOT TRUE)
       AND (category NOT IN ('stock','rwa','etf','metal') OR category IS NULL)`,
  );

  if (tokens.length === 0) return;

  const mints = tokens.map((t) => t.mint);
  const marketData = await getMarketData(mints);

  // ── API outage detection ──
  // If more than 50% of tokens have no data, DexScreener is likely down.
  // Do NOT increment strikes or delist anything — just log and bail.
  const missingCount = mints.filter((m) => !marketData.has(m)).length;
  const missingRatio = missingCount / mints.length;
  if (missingRatio > API_OUTAGE_THRESHOLD) {
    console.warn(
      `[token-health] API OUTAGE DETECTED — ${missingCount}/${mints.length} tokens (${(missingRatio * 100).toFixed(0)}%) returned no data. Skipping entire cycle.`,
    );
    if (bot && ADMIN_TG_ID) {
      try {
        await bot.api.sendMessage(
          ADMIN_TG_ID,
          `*Health Monitor: API outage detected*\n\n${missingCount}/${mints.length} tokens returned no market data from DexScreener.\n\nSkipping this cycle to prevent false delistings.`,
          { parse_mode: "Markdown" },
        );
      } catch { /* non-critical */ }
    }
    return;
  }

  const delisted = [];
  const watchlisted = [];
  const recovered = [];
  let delistCount = 0;

  for (const token of tokens) {
    const { mint, symbol } = token;
    const market = marketData.get(mint);
    const strikes = token.health_strikes || 0;

    // ── Circuit breaker ──
    // If we've already delisted MAX_DELISTS_PER_CYCLE tokens this cycle,
    // stop delisting and alert admin. Something is likely wrong with the data.
    if (delistCount >= MAX_DELISTS_PER_CYCLE) {
      if (delistCount === MAX_DELISTS_PER_CYCLE) {
        console.warn(`[token-health] CIRCUIT BREAKER — already delisted ${delistCount} tokens this cycle, halting further delistings`);
        if (bot && ADMIN_TG_ID) {
          try {
            await bot.api.sendMessage(
              ADMIN_TG_ID,
              `*Health Monitor: Circuit breaker tripped*\n\nAlready delisted ${delistCount} tokens this cycle (max ${MAX_DELISTS_PER_CYCLE}). Halting further delistings.\n\nDelisted so far: ${delisted.join(", ")}\n\nPlease review — this may indicate bad API data rather than actual rugs.`,
              { parse_mode: "Markdown" },
            );
          } catch { /* non-critical */ }
        }
        delistCount++; // increment past max so this alert only fires once
      }
      // Still update market data but don't delist or add strikes
      if (market) {
        await query(
          `UPDATE supported_mints
           SET liquidity_usd = $2, market_cap_usd = $3, screened_at = NOW()
           WHERE mint = $1`,
          [mint, market.liquidity, market.marketCap],
        );
      }
      continue;
    }

    // No market data found — token may be dead
    if (!market) {
      if (strikes >= STRIKES_TO_DELIST) {
        const fresh = await recheckMarket(mint);
        if (fresh) {
          // The token is visibly alive — the batch read was the problem.
          await query(
            `UPDATE supported_mints SET health_strikes = 0, liquidity_usd = $2, market_cap_usd = $3, screened_at = NOW() WHERE mint = $1`,
            [mint, fresh.liquidity, fresh.marketCap],
          );
          recovered.push(symbol);
          continue;
        }
        await delistToken(mint, symbol, "No trading data found (token appears dead — confirmed by targeted re-check)", bot);
        delisted.push(symbol);
        delistCount++;
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

    // Market cap completely cratered (below $10K floor).
    // marketCap === 0 means the FIELD WAS MISSING (partial pair data), not a
    // collapse — a real crater reads tiny-but-nonzero, and a genuinely dead
    // token gets caught by the liquidity/rug/volume checks on real data.
    if (market.marketCap > 0 && market.marketCap < MCAP_FLOOR) {
      const fresh = await recheckMarket(mint);
      const m2 = fresh ?? market;
      if (fresh && !(m2.marketCap > 0 && m2.marketCap < MCAP_FLOOR)) {
        // fresh read disagrees — data blip, not a collapse
        await query(
          `UPDATE supported_mints SET liquidity_usd = $2, market_cap_usd = $3, screened_at = NOW() WHERE mint = $1`,
          [mint, m2.liquidity, m2.marketCap],
        );
        continue;
      }
      await delistToken(
        mint, symbol,
        `Market cap collapsed to $${Math.floor(m2.marketCap).toLocaleString()} (floor: $${MCAP_FLOOR.toLocaleString()})`,
        bot,
      );
      delisted.push(symbol);
      delistCount++;
      continue;
    }

    // Liquidity pulled AND market cap low — both must be true to prevent
    // false positives from DexScreener returning incomplete pair data
    if (market.liquidity < RUG_THRESHOLDS.maxLiquidityUsd && market.marketCap < RUG_THRESHOLDS.maxMarketCap) {
      const freshRug = await recheckMarket(mint);
      if (freshRug && !(freshRug.liquidity < RUG_THRESHOLDS.maxLiquidityUsd && freshRug.marketCap < RUG_THRESHOLDS.maxMarketCap)) {
        await query(
          `UPDATE supported_mints SET liquidity_usd = $2, market_cap_usd = $3, screened_at = NOW() WHERE mint = $1`,
          [mint, freshRug.liquidity, freshRug.marketCap],
        );
        continue;
      }
      await delistToken(
        mint, symbol,
        `Rug detected — liquidity $${Math.floor(market.liquidity).toLocaleString()} AND mcap $${Math.floor(market.marketCap).toLocaleString()}`,
        bot,
      );
      delisted.push(symbol);
      delistCount++;
      continue;
    }

    // Liquidity dropped below the approval floor. Even if mcap looks fine
    // (could be inflated/wash-traded), liquidity below the floor means we
    // can't liquidate this collateral cleanly — no longer meets criteria.
    // Skip large-cap tokens (>$1M mcap) where low liquidity reading is
    // likely a DexScreener batch-API quirk, not real degradation.
    if (market.liquidity < LIQUIDITY_FLOOR && market.marketCap < 1_000_000) {
      const freshLiq = await recheckMarket(mint);
      if (freshLiq && !(freshLiq.liquidity < LIQUIDITY_FLOOR && freshLiq.marketCap < 1_000_000)) {
        await query(
          `UPDATE supported_mints SET liquidity_usd = $2, market_cap_usd = $3, screened_at = NOW() WHERE mint = $1`,
          [mint, freshLiq.liquidity, freshLiq.marketCap],
        );
        continue;
      }
      await delistToken(
        mint, symbol,
        `Liquidity below floor — $${Math.floor(market.liquidity).toLocaleString()} (min: $${LIQUIDITY_FLOOR.toLocaleString()})`,
        bot,
      );
      delisted.push(symbol);
      delistCount++;
      continue;
    }

    // 24h volume floor — a token with effectively no trading activity
    // can't serve as functional collateral even if stale liquidity remains.
    // Same large-cap escape hatch as above.
    if (market.volume24h < VOLUME_FLOOR && market.marketCap < 1_000_000) {
      const freshVol = await recheckMarket(mint);
      if (freshVol && !(freshVol.volume24h < VOLUME_FLOOR && freshVol.marketCap < 1_000_000)) {
        await query(
          `UPDATE supported_mints SET liquidity_usd = $2, market_cap_usd = $3, screened_at = NOW() WHERE mint = $1`,
          [mint, freshVol.liquidity, freshVol.marketCap],
        );
        continue;
      }
      await delistToken(
        mint, symbol,
        `Volume below floor — $${Math.floor(market.volume24h).toLocaleString()} 24h (min: $${VOLUME_FLOOR.toLocaleString()})`,
        bot,
      );
      delisted.push(symbol);
      delistCount++;
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
        delistCount++;
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
        // Final strike — but the reading that put us here may be a partial
        // pair object (this exact branch delisted 7 healthy same-day
        // promotions on 2026-08-25: strike 1 = "no data", strike 2 = a
        // volume-less partial row). Confirm with a targeted refetch; a
        // healthy fresh read clears the strikes instead.
        const freshDeg = await recheckMarket(mint);
        if (freshDeg) {
          const stillDegraded = !(freshDeg.marketCap > 1_000_000) && (
            freshDeg.liquidity < WATCHLIST_THRESHOLDS.maxLiquidityUsd ||
            freshDeg.volume24h < WATCHLIST_THRESHOLDS.maxVolume24h ||
            freshDeg.marketCap < WATCHLIST_THRESHOLDS.maxMarketCap
          );
          if (!stillDegraded) {
            await query(
              `UPDATE supported_mints SET health_strikes = 0, liquidity_usd = $2, market_cap_usd = $3, screened_at = NOW() WHERE mint = $1`,
              [mint, freshDeg.liquidity, freshDeg.marketCap],
            );
            recovered.push(symbol);
            continue;
          }
        }
        const reasons = [];
        if (market.liquidity < WATCHLIST_THRESHOLDS.maxLiquidityUsd)
          reasons.push(`liquidity $${Math.floor(market.liquidity).toLocaleString()}`);
        if (market.volume24h < WATCHLIST_THRESHOLDS.maxVolume24h)
          reasons.push(`volume $${Math.floor(market.volume24h).toLocaleString()}`);
        if (market.marketCap < WATCHLIST_THRESHOLDS.maxMarketCap)
          reasons.push(`mcap $${Math.floor(market.marketCap).toLocaleString()}`);

        await delistToken(
          mint, symbol,
          `Degraded for ${newStrikes} consecutive checks (${newStrikes * 15} min): ${reasons.join(", ")}`,
          bot,
        );
        delisted.push(symbol);
        delistCount++;
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
    let ok = true;
    try {
      await tick(bot);
    } catch (err) {
      ok = false;
      console.error("[token-health] cycle error:", err.message);
    } finally {
      running = false;
      markCycle("token-health", ok);
    }
  };

  run();
  return setInterval(run, POLL_INTERVAL_MS);
}
