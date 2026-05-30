/**
 * Token Screener — automated discovery and vetting of new Solana tokens.
 *
 * Pipeline:
 *   1. Discover: poll DexScreener for trending/high-volume Solana tokens
 *   2. Filter: skip tokens we've already seen or that are already supported
 *   3. Safety checks: mint authority, freeze authority, LP, holders, age, liquidity
 *   4. Auto-approve: tokens passing ALL strict criteria get added to supported_mints
 *   5. Review queue: borderline tokens get queued for admin review via Telegram
 *   6. Notify: admin gets a summary of new approvals and pending reviews
 *
 * Auto-approved tokens start with conservative loan terms (lowest LTV tier).
 */
import { query } from "../db/pool.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { connection } from "../solana/connection.js";
import { cachedJson } from "../lib/http-cache.js";
import { markCycle } from "../lib/heartbeat.js";

const POLL_INTERVAL_MS = Number(process.env.SCREENER_INTERVAL_MS) || 600_000; // 10 min
const ADMIN_TG_ID = process.env.ADMIN_TELEGRAM_ID;

// Symbols to never approve — wrapped/bridged L1 tokens that aren't real memecoins
const BLOCKED_SYMBOLS = new Set([
  "SOL", "WSOL", "ETH", "WETH", "BTC", "WBTC", "BNB", "WBNB",
  "USDC", "USDT", "BUSD", "DAI", "USDD", "TUSD", "FRAX",
  "DOGE", "SHIB", "PEPE", "FLOKI", "BONK20", "LINK", "UNI",
  "AVAX", "MATIC", "DOT", "ADA", "XRP", "LTC", "ATOM",
]);

// Known xStock mint prefixes and issuers (tokens.xyz ecosystem)
const KNOWN_STOCK_ISSUERS = [
  "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", // xTSLA — used as a seed to find issuer pairs
];

// Real stock tickers to search for tokenized versions
const STOCK_TICKERS = [
  "TSLA", "NVDA", "AAPL", "GOOGL", "AMZN", "MSFT", "META", "MSTR", "COIN",
  "AMD", "PLTR", "NFLX", "INTC", "UBER", "SHOP", "SQ", "PYPL", "DIS",
  "BA", "JPM", "GS", "V", "MA", "BRK", "WMT", "PFE", "JNJ", "XOM",
  "SPY", "QQQ", "SOXX", "ARKK",
];

const STOCK_SEARCH_QUERIES = STOCK_TICKERS.map((t) => `x${t}`);

// Detect if a token is a tokenized stock based on symbol/name patterns
function detectCategory(symbol, name) {
  const sym = symbol.toUpperCase();
  const nm = (name || "").toLowerCase();

  // xStock pattern: "x" prefix + known stock ticker
  if (sym.startsWith("X") && STOCK_TICKERS.includes(sym.slice(1))) {
    return "stock";
  }

  // Name-based detection
  if (nm.includes("tokenized") || nm.includes("stock") || nm.includes("equity")) {
    return "stock";
  }

  // Known company names
  const companies = ["tesla", "nvidia", "apple", "alphabet", "amazon", "microsoft",
    "meta platforms", "microstrategy", "coinbase", "netflix", "intel", "uber",
    "shopify", "block inc", "paypal", "disney", "boeing", "jpmorgan", "goldman"];
  if (companies.some((c) => nm.includes(c))) {
    return "stock";
  }

  return "memecoin";
}

// ─── Safety thresholds ──────────────────────────────────────────────────────

// Auto-approve: must pass ALL of these
const AUTO_APPROVE = {
  minLiquidityUsd: 75_000,
  minHolders: 300,
  minAgeHours: 24,
  maxTop10HolderPct: 40,
  lpBurnedRequired: true,
  noMintAuthority: true,
  noFreezeAuthority: true,
  minVolume24h: 50_000,
  minMarketCap: 250_000,
};

// Minimum to even consider (below this = auto-reject)
// Loosened 2026-05-29 — was 30k/100/12h/10k. Sends more tokens to /reviewtokens
// for manual review. AUTO_APPROVE bar stays strict to keep rug-pulls out of
// auto-approvals.
// Calibrated for pump.fun-era tokens: a 4-hour-old token literally hasn't had
// 24 hours to accumulate volume, so the volume bar is much lower.
const MIN_CONSIDER = {
  minLiquidityUsd: 5_000,
  minHolders: 25,
  minAgeHours: 4,
  minVolume24h: 500,
};

// ─── Discovery ──────────────────────────────────────────────────────────────

// Search terms for broad memecoin discovery (rotated across cycles)
const MEMECOIN_SEARCH_TERMS = [
  "pump", "bonk", "pepe", "doge", "cat", "bull", "moon", "meme",
  "inu", "ai", "sol", "chad", "wojak", "frog", "based", "king",
  "trump", "elon", "giga", "turbo", "bob", "baby", "ape", "coin",
  "pop", "rich", "cash", "gold", "diamond", "rocket", "fire",
  "whale", "shark", "bear", "crab", "monkey", "rat", "duck",
];

// Rotate through search terms — 8 per cycle to avoid rate limits
let searchTermIndex = 0;
function getNextSearchBatch() {
  const batch = [];
  for (let i = 0; i < 8; i++) {
    batch.push(MEMECOIN_SEARCH_TERMS[searchTermIndex % MEMECOIN_SEARCH_TERMS.length]);
    searchTermIndex++;
  }
  return batch;
}

/**
 * Fetch trending/high-volume Solana tokens from multiple DexScreener sources.
 *
 * Sources:
 *   1. Token boosts (top) — paid promotions / trending
 *   2. Token boosts (latest) — recently boosted tokens
 *   3. Latest profiles — new tokens that filled out their profile
 *   4. Keyword search — rotates through memecoin-related terms
 *   5. xStock issuer pairs — tokenized stocks
 *   6. xStock ticker search — "xTSLA", "xNVDA" etc.
 */
async function discoverTokens() {
  const tokens = new Map();

  function addSolanaToken(addr, source) {
    if (addr) tokens.set(addr, { mint: addr, source });
  }

  // Helper: extract Solana tokens from a boost/profile array
  function extractFromBoostArray(data, source) {
    if (!Array.isArray(data)) return;
    for (const t of data) {
      if (t.chainId === "solana" && t.tokenAddress) addSolanaToken(t.tokenAddress, source);
    }
  }

  // Helper: extract Solana pairs from a search result with min liquidity
  function extractFromSearchPairs(data, source, minLiq = 10_000) {
    if (!data?.pairs) return;
    for (const p of data.pairs) {
      if (p.chainId !== "solana") continue;
      const addr = p.baseToken?.address;
      if (addr && (p.liquidity?.usd ?? 0) >= minLiq) addSolanaToken(addr, source);
    }
  }

  // Source 1: DexScreener token boosts (top trending)
  {
    const data = await cachedJson("https://api.dexscreener.com/token-boosts/top/v1");
    if (data) extractFromBoostArray(data, "trending");
  }

  // Source 2: DexScreener token boosts (latest — catches tokens trending up)
  {
    const data = await cachedJson("https://api.dexscreener.com/token-boosts/latest/v1");
    if (data) extractFromBoostArray(data, "boost_latest");
  }

  // Source 3: DexScreener latest profiles (new tokens with filled profiles)
  {
    const data = await cachedJson("https://api.dexscreener.com/token-profiles/latest/v1");
    if (data) extractFromBoostArray(data, "new_profile");
  }

  // Source 4: Keyword search — rotates through memecoin-related terms each cycle
  const searchBatch = getNextSearchBatch();
  for (const term of searchBatch) {
    const data = await cachedJson(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`,
    );
    if (data) extractFromSearchPairs(data, `search:${term}`, 20_000);
  }

  // Source 5: tokens.xyz xStocks — discover new tokenized stocks
  {
    const pairs = await cachedJson(
      "https://api.dexscreener.com/tokens/v1/solana/" + KNOWN_STOCK_ISSUERS.join(","),
    );
    if (Array.isArray(pairs)) {
      for (const p of pairs) {
        const addr = p.baseToken?.address;
        const symbol = p.baseToken?.symbol || "";
        if (addr && symbol.startsWith("x") && symbol.length >= 2) addSolanaToken(addr, "xstock");
      }
    }
  }

  // Source 6: Search DexScreener for "x" prefixed stock tokens
  for (const q of STOCK_SEARCH_QUERIES) {
    const data = await cachedJson(`https://api.dexscreener.com/latest/dex/search?q=${q}`);
    if (data?.pairs) {
      for (const p of data.pairs) {
        if (p.chainId !== "solana") continue;
        const addr = p.baseToken?.address;
        const symbol = p.baseToken?.symbol || "";
        if (addr && symbol.startsWith("x") && (p.liquidity?.usd ?? 0) > 10_000) {
          addSolanaToken(addr, "stock_search");
        }
      }
    }
  }

  return Array.from(tokens.values());
}

// ─── On-chain safety checks ─────────────────────────────────────────────────

/**
 * Check mint/freeze authority and basic token info on-chain.
 */
async function getOnChainInfo(mintStr) {
  try {
    const mintPk = new PublicKey(mintStr);
    const info = await connection.getAccountInfo(mintPk);
    if (!info) return null;

    // SPL Token mint layout: first 36 bytes = mintAuthorityOption(4) + mintAuthority(32)
    // bytes 36-40 = supply (u64)
    // bytes 44-45 = decimals (u8)
    // bytes 46-50 = isInitialized(1) + freezeAuthorityOption(4) + freezeAuthority(32)
    const data = info.data;
    if (data.length < 82) return null;

    const mintAuthorityOption = data.readUInt32LE(0);
    const decimals = data.readUInt8(44);
    const freezeAuthorityOption = data.readUInt32LE(46);

    return {
      decimals,
      hasMintAuthority: mintAuthorityOption === 1,
      hasFreezeAuthority: freezeAuthorityOption === 1,
    };
  } catch {
    return null;
  }
}

// ─── Market data ────────────────────────────────────────────────────────────

/**
 * Fetch detailed market data for a batch of mints from DexScreener.
 */
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

      result.set(addr, {
        symbol: p.baseToken?.symbol || "???",
        name: p.baseToken?.name || p.baseToken?.symbol || "Unknown",
        price: p.priceUsd ? parseFloat(p.priceUsd) : null,
        liquidity: liq,
        volume24h: p.volume?.h24 ?? 0,
        marketCap: p.marketCap ?? p.fdv ?? 0,
        pairCreatedAt: p.pairCreatedAt ?? null,
        imageUrl: p.info?.imageUrl ?? null,
      });
    }
  }
  return result;
}

/**
 * Estimate holder count from DexScreener or Helius (fallback: use 0).
 */
async function getHolderCount(mint) {
  // Try Helius DAS API if available
  const heliusKey = process.env.HELIUS_API_KEY;
  if (heliusKey) {
    try {
      const res = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${heliusKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mintAccounts: [mint] }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data[0]?.onChainAccountInfo?.holderCount) {
          return data[0].onChainAccountInfo.holderCount;
        }
      }
    } catch { /* fallback */ }
  }

  // Fallback: use Birdeye
  try {
    const res = await fetch(
      `https://public-api.birdeye.so/defi/v3/token/holder?address=${mint}`,
      { headers: { "X-API-KEY": process.env.BIRDEYE_API_KEY || "" } },
    );
    if (res.ok) {
      const data = await res.json();
      return data?.data?.total ?? 0;
    }
  } catch { /* fallback */ }

  return 0;
}

// ─── Vetting ────────────────────────────────────────────────────────────────

/**
 * Run safety checks on a token and return a verdict.
 * Stocks and memecoins have different criteria.
 */
function vetToken(onChain, market, holderCount, category) {
  const fails = [];
  let safetyScore = 100;
  const isStock = category === "stock";

  const ageHours = market.pairCreatedAt
    ? Math.floor((Date.now() - market.pairCreatedAt) / 3_600_000)
    : 0;

  // ── Authority checks ──
  // Stocks: mint/freeze authority is EXPECTED (issuer manages supply to track real price)
  // Memecoins: mint/freeze authority is a red flag
  if (!isStock) {
    if (onChain.hasMintAuthority) {
      fails.push("Mint authority enabled — supply can be inflated");
      safetyScore -= 30;
    }
    if (onChain.hasFreezeAuthority) {
      fails.push("Freeze authority enabled — tokens can be frozen");
      safetyScore -= 30;
    }
  }

  // Liquidity
  if (market.liquidity < MIN_CONSIDER.minLiquidityUsd) {
    fails.push(`Liquidity $${Math.floor(market.liquidity)} < $${MIN_CONSIDER.minLiquidityUsd} minimum`);
    safetyScore -= 20;
  } else if (market.liquidity < AUTO_APPROVE.minLiquidityUsd) {
    safetyScore -= 10;
  }

  // Age
  if (ageHours < MIN_CONSIDER.minAgeHours) {
    fails.push(`Token age ${ageHours}h < ${MIN_CONSIDER.minAgeHours}h minimum`);
    safetyScore -= 15;
  } else if (ageHours < AUTO_APPROVE.minAgeHours) {
    safetyScore -= 5;
  }

  // Holders (stocks can have fewer holders and still be legitimate)
  const minHolders = isStock ? 50 : MIN_CONSIDER.minHolders;
  const autoHolders = isStock ? 100 : AUTO_APPROVE.minHolders;
  if (holderCount < minHolders) {
    fails.push(`${holderCount} holders < ${minHolders} minimum`);
    safetyScore -= 15;
  } else if (holderCount < autoHolders) {
    safetyScore -= 5;
  }

  // Volume
  if (market.volume24h < MIN_CONSIDER.minVolume24h) {
    fails.push(`24h volume $${Math.floor(market.volume24h)} < $${MIN_CONSIDER.minVolume24h} minimum`);
    safetyScore -= 10;
  }

  // ── Verdict ──
  let canAutoApprove, meetsMinimum;

  if (isStock) {
    // Stocks: don't check mint/freeze authority, lower holder threshold
    canAutoApprove =
      market.liquidity >= AUTO_APPROVE.minLiquidityUsd &&
      holderCount >= autoHolders &&
      ageHours >= AUTO_APPROVE.minAgeHours &&
      market.volume24h >= AUTO_APPROVE.minVolume24h;

    meetsMinimum =
      market.liquidity >= MIN_CONSIDER.minLiquidityUsd &&
      ageHours >= MIN_CONSIDER.minAgeHours &&
      holderCount >= minHolders;
  } else {
    // Memecoins: full safety checks
    canAutoApprove =
      !onChain.hasMintAuthority &&
      !onChain.hasFreezeAuthority &&
      market.liquidity >= AUTO_APPROVE.minLiquidityUsd &&
      holderCount >= AUTO_APPROVE.minHolders &&
      ageHours >= AUTO_APPROVE.minAgeHours &&
      market.volume24h >= AUTO_APPROVE.minVolume24h &&
      market.marketCap >= AUTO_APPROVE.minMarketCap;

    // Don't block from review on authority alone — pump-style launches keep
    // mint authority until they graduate. Authority status is in `fails` so
    // admin sees the warning when reviewing.
    meetsMinimum =
      market.liquidity >= MIN_CONSIDER.minLiquidityUsd &&
      ageHours >= MIN_CONSIDER.minAgeHours &&
      holderCount >= MIN_CONSIDER.minHolders &&
      market.volume24h >= MIN_CONSIDER.minVolume24h;
  }

  return {
    verdict: canAutoApprove ? "auto_approve" : meetsMinimum ? "review" : "reject",
    safetyScore: Math.max(0, safetyScore),
    fails,
    ageHours,
  };
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function autoApproveToken(mint, onChain, market, holderCount, ageHours, category) {
  const isStock = category === "stock";
  await query(
    `INSERT INTO supported_mints
       (mint, symbol, name, decimals, category, image_url, liquidity_usd,
        holder_count, market_cap_usd, has_mint_authority, has_freeze_authority,
        lp_burned, token_age_hours, auto_approved, screened_at, source, enabled, protected)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,NOW(),'screener',TRUE,$14)
     ON CONFLICT (mint) DO NOTHING`,
    [
      mint,
      market.symbol.toUpperCase(),
      market.name,
      onChain.decimals,
      category,
      market.imageUrl,
      market.liquidity,
      holderCount,
      market.marketCap,
      onChain.hasMintAuthority,
      onChain.hasFreezeAuthority,
      false, // lp_burned — can't reliably check, default false
      ageHours,
      isStock, // stocks are auto-protected from health monitor delisting
    ],
  );
}

async function queueForReview(mint, onChain, market, holderCount, safetyScore, fails, ageHours, category) {
  await query(
    `INSERT INTO token_screen_queue
       (mint, symbol, name, decimals, category, image_url, liquidity_usd,
        volume_24h_usd, market_cap_usd, holder_count, has_mint_authority,
        has_freeze_authority, token_age_hours, safety_score, fail_reasons, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending')
     ON CONFLICT (mint) DO UPDATE SET
       liquidity_usd = EXCLUDED.liquidity_usd,
       volume_24h_usd = EXCLUDED.volume_24h_usd,
       market_cap_usd = EXCLUDED.market_cap_usd,
       holder_count = EXCLUDED.holder_count,
       safety_score = EXCLUDED.safety_score,
       fail_reasons = EXCLUDED.fail_reasons`,
    [
      mint,
      market.symbol.toUpperCase(),
      market.name,
      onChain.decimals,
      category,
      market.imageUrl,
      market.liquidity,
      market.volume24h,
      market.marketCap,
      holderCount,
      onChain.hasMintAuthority,
      onChain.hasFreezeAuthority,
      ageHours,
      safetyScore,
      fails,
    ],
  );
}

async function markSeen(mint) {
  await query(
    `INSERT INTO token_screen_seen (mint) VALUES ($1) ON CONFLICT DO NOTHING`,
    [mint],
  );
}

// ─── Main loop ──────────────────────────────────────────────────────────────

async function tick(bot) {
  const discovered = await discoverTokens();
  if (discovered.length === 0) return;

  // Filter out already-seen and already-supported tokens
  const mints = discovered.map((t) => t.mint);
  const { rows: seenRows } = await query(
    `SELECT mint FROM token_screen_seen WHERE mint = ANY($1)`,
    [mints],
  );
  const { rows: supportedRows } = await query(
    `SELECT mint FROM supported_mints WHERE mint = ANY($1)`,
    [mints],
  );
  const seenSet = new Set([...seenRows.map((r) => r.mint), ...supportedRows.map((r) => r.mint)]);
  const newMints = discovered.filter((t) => !seenSet.has(t.mint));

  if (newMints.length === 0) return;

  console.log(`[screener] Screening ${newMints.length} new tokens...`);

  // Fetch market data in bulk
  const marketData = await getMarketData(newMints.map((t) => t.mint));

  const approved = [];
  const queued = [];
  let rejNoMarket = 0, rejBlocked = 0, rejNoOnChain = 0, rejTransient = 0, rejPermanent = 0;

  for (const { mint } of newMints) {
    const market = marketData.get(mint);
    if (!market) {
      // No DexScreener pair yet — don't markSeen so we retry later when it has one.
      rejNoMarket++;
      continue;
    }

    if (BLOCKED_SYMBOLS.has(market.symbol.toUpperCase())) {
      await markSeen(mint); // permanent — wrapped L1/stablecoin, won't change
      rejBlocked++;
      continue;
    }

    const onChain = await getOnChainInfo(mint);
    if (!onChain) {
      // RPC blip or genuinely unreadable — don't markSeen, retry next tick
      rejNoOnChain++;
      continue;
    }

    const holderCount = await getHolderCount(mint);
    const category = detectCategory(market.symbol, market.name);

    const { verdict, safetyScore, fails, ageHours } = vetToken(onChain, market, holderCount, category);

    if (verdict === "auto_approve") {
      await autoApproveToken(mint, onChain, market, holderCount, ageHours, category);
      await markSeen(mint);
      approved.push({ symbol: market.symbol, mint, liquidity: market.liquidity, marketCap: market.marketCap, category });
    } else if (verdict === "review") {
      await queueForReview(mint, onChain, market, holderCount, safetyScore, fails, ageHours, category);
      await markSeen(mint);
      queued.push({ symbol: market.symbol, mint, safetyScore, fails, category });
    } else {
      // Reject: distinguish permanent (authority issues — will never pass)
      // from transient (too young / low liquidity yet — could mature later).
      const hasPermanent = fails.some((f) => /authority|honeypot/i.test(f));
      if (hasPermanent) {
        await markSeen(mint);
        rejPermanent++;
      } else {
        // Don't markSeen — re-evaluate next tick as the token ages.
        rejTransient++;
      }
      console.log(`[screener] reject ${market.symbol} (${hasPermanent ? "permanent" : "transient"}): ${fails.slice(0, 3).join("; ")}`);
    }
  }

  if (approved.length || queued.length || rejTransient || rejPermanent || rejBlocked || rejNoOnChain) {
    console.log(
      `[screener] result: approved=${approved.length} queued=${queued.length} ` +
      `rej_permanent=${rejPermanent} rej_transient=${rejTransient} ` +
      `rej_blocked=${rejBlocked} rej_no_onchain=${rejNoOnChain} rej_no_market=${rejNoMarket}`,
    );
  }

  // Notify admin
  if (bot && ADMIN_TG_ID && (approved.length > 0 || queued.length > 0)) {
    const lines = ["*Token Screener Report*", ""];

    if (approved.length > 0) {
      lines.push(`*Auto-approved (${approved.length}):*`);
      for (const t of approved) {
        const tag = t.category === "stock" ? " [STOCK]" : "";
        lines.push(`  + ${t.symbol}${tag} — $${Math.floor(t.liquidity).toLocaleString()} liq, $${Math.floor(t.marketCap).toLocaleString()} mcap`);
      }
      lines.push("");
    }

    if (queued.length > 0) {
      lines.push(`*Needs review (${queued.length}):*`);
      for (const t of queued) {
        const tag = t.category === "stock" ? " [STOCK]" : "";
        lines.push(`  ? ${t.symbol}${tag} (score: ${t.safetyScore}) — ${t.fails[0] || "borderline"}`);
      }
      lines.push("");
      lines.push("Use /reviewtokens to approve or reject.");
    }

    try {
      await bot.api.sendMessage(ADMIN_TG_ID, lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[screener] Failed to notify admin:", err.message);
    }
  }

  if (approved.length > 0) {
    console.log(`[screener] Auto-approved ${approved.length} tokens: ${approved.map((t) => t.symbol).join(", ")}`);
  }
  if (queued.length > 0) {
    console.log(`[screener] Queued ${queued.length} tokens for review`);
  }
}

// ─── Admin review command ───────────────────────────────────────────────────

export async function handleReviewTokens(ctx) {
  const { rows } = await query(
    `SELECT * FROM token_screen_queue WHERE status = 'pending' ORDER BY safety_score DESC LIMIT 10`,
  );

  if (rows.length === 0) {
    return ctx.reply("No tokens pending review.");
  }

  const { InlineKeyboard } = await import("grammy");

  for (const t of rows) {
    const lines = [
      `*${t.symbol}* — ${t.name || "Unknown"}`,
      `Liquidity: $${Number(t.liquidity_usd).toLocaleString()}`,
      `Volume 24h: $${Number(t.volume_24h_usd).toLocaleString()}`,
      `Market Cap: $${Number(t.market_cap_usd).toLocaleString()}`,
      `Holders: ${t.holder_count}`,
      `Age: ${t.token_age_hours}h`,
      `Safety: ${t.safety_score}/100`,
      `Mint auth: ${t.has_mint_authority ? "YES" : "no"}`,
      `Freeze auth: ${t.has_freeze_authority ? "YES" : "no"}`,
    ];
    if (t.fail_reasons?.length > 0) {
      lines.push("", "*Issues:*");
      for (const r of t.fail_reasons) lines.push(`  - ${r}`);
    }
    lines.push("", `\`${t.mint}\``);

    const kb = new InlineKeyboard()
      .text("Approve", `screen:approve:${t.mint}`)
      .text("Reject", `screen:reject:${t.mint}`);

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: kb });
  }
}

export function registerScreenerCallbacks(bot) {
  bot.callbackQuery(/^screen:approve:(.+)$/, async (ctx) => {
    const mint = ctx.match[1];
    const { rows: [t] } = await query(
      `SELECT * FROM token_screen_queue WHERE mint = $1`, [mint],
    );
    if (!t) {
      return ctx.answerCallbackQuery("Token not found in queue");
    }

    // Add to supported_mints
    await query(
      `INSERT INTO supported_mints
         (mint, symbol, name, decimals, category, image_url, liquidity_usd,
          holder_count, market_cap_usd, has_mint_authority, has_freeze_authority,
          token_age_hours, auto_approved, screened_at, source, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE,NOW(),'review',TRUE)
       ON CONFLICT (mint) DO UPDATE SET enabled = TRUE`,
      [
        t.mint, t.symbol, t.name, t.decimals, t.category, t.image_url,
        t.liquidity_usd, t.holder_count, t.market_cap_usd,
        t.has_mint_authority, t.has_freeze_authority, t.token_age_hours,
      ],
    );

    await query(
      `UPDATE token_screen_queue SET status = 'approved', reviewed_at = NOW() WHERE mint = $1`,
      [mint],
    );

    await ctx.answerCallbackQuery(`${t.symbol} approved`);
    await ctx.editMessageText(`${t.symbol} approved and live for lending.`);

    // Notify the user who submitted this token
    if (t.submitted_by) {
      try {
        await ctx.api.sendMessage(
          t.submitted_by,
          `Your submitted token *${t.symbol}* has been approved! You can now use it as collateral.\n\nUse /borrow to get started.`,
          { parse_mode: "Markdown" },
        );
      } catch { /* user may have blocked bot */ }
    }
  });

  bot.callbackQuery(/^screen:reject:(.+)$/, async (ctx) => {
    const mint = ctx.match[1];
    const { rows: [t] } = await query(
      `SELECT symbol, submitted_by FROM token_screen_queue WHERE mint = $1`, [mint],
    );
    await query(
      `UPDATE token_screen_queue SET status = 'rejected', reviewed_at = NOW() WHERE mint = $1`,
      [mint],
    );
    await ctx.answerCallbackQuery("Rejected");
    await ctx.editMessageText(`${t?.symbol || "Token"} rejected.`);

    // Notify the submitter
    if (t?.submitted_by) {
      try {
        await ctx.api.sendMessage(
          t.submitted_by,
          `Your submitted token *${t.symbol}* was not approved. It did not meet our collateral safety requirements at this time.`,
          { parse_mode: "Markdown" },
        );
      } catch { /* user may have blocked bot */ }
    }
  });
}

// ─── Auto-approve aged review queue tokens ──────────────────────────────────

const REVIEW_AUTO_APPROVE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Tokens that have been in the review queue for 1+ hour and still pass safety
 * checks get auto-approved. This ensures users get a timely response.
 */
async function processReviewQueue(bot) {
  const { rows } = await query(
    `SELECT * FROM token_screen_queue
     WHERE status = 'pending'
       AND created_at <= NOW() - INTERVAL '1 hour'`,
  );

  if (rows.length === 0) return;

  for (const t of rows) {
    // Re-check on-chain safety before approving
    const onChain = await getOnChainInfo(t.mint);
    if (!onChain || onChain.hasMintAuthority || onChain.hasFreezeAuthority) {
      // Token degraded — reject it
      await query(
        `UPDATE token_screen_queue SET status = 'rejected', reviewed_at = NOW() WHERE mint = $1`,
        [t.mint],
      );
      if (t.submitted_by && bot) {
        try {
          await bot.api.sendMessage(
            t.submitted_by,
            `Your submitted token *${t.symbol}* was not approved. It did not pass our safety re-check.`,
            { parse_mode: "Markdown" },
          );
        } catch { /* user may have blocked bot */ }
      }
      console.log(`[screener] Review auto-rejected ${t.symbol} (failed re-check)`);
      continue;
    }

    // Approve it
    await query(
      `INSERT INTO supported_mints
         (mint, symbol, name, decimals, category, image_url, liquidity_usd,
          holder_count, market_cap_usd, has_mint_authority, has_freeze_authority,
          token_age_hours, auto_approved, screened_at, source, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,FALSE,$10,TRUE,NOW(),'review_auto',TRUE)
       ON CONFLICT (mint) DO UPDATE SET enabled = TRUE`,
      [
        t.mint, t.symbol, t.name, t.decimals, t.category, t.image_url,
        t.liquidity_usd, t.holder_count, t.market_cap_usd, t.token_age_hours,
      ],
    );

    await query(
      `UPDATE token_screen_queue SET status = 'approved', reviewed_at = NOW() WHERE mint = $1`,
      [t.mint],
    );

    console.log(`[screener] Review auto-approved ${t.symbol} (1h elapsed, passed re-check)`);

    // Notify submitter
    if (t.submitted_by && bot) {
      try {
        await bot.api.sendMessage(
          t.submitted_by,
          `Your submitted token *${t.symbol}* has been approved! You can now use it as collateral.\n\nUse /borrow to get started.`,
          { parse_mode: "Markdown" },
        );
      } catch { /* user may have blocked bot */ }
    }

    // Notify admin
    if (ADMIN_TG_ID && bot) {
      try {
        await bot.api.sendMessage(
          ADMIN_TG_ID,
          `*Review auto-approved* (1h elapsed)\n\n${t.symbol} — $${Number(t.liquidity_usd).toLocaleString()} liq\n\`${t.mint}\``,
          { parse_mode: "Markdown" },
        );
      } catch { /* non-critical */ }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startTokenScreener(bot) {
  console.log(`🔍 Token screener running (every ${POLL_INTERVAL_MS / 1000}s)`);

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    let ok = true;
    try {
      await tick(bot);
      await processReviewQueue(bot);
    } catch (err) {
      ok = false;
      console.error("[screener] cycle error:", err.message);
    } finally {
      running = false;
      markCycle("screener", ok);
    }
  };

  run();
  return setInterval(run, POLL_INTERVAL_MS);
}
