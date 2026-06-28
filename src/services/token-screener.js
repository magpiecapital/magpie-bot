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

// Categories that represent tokenized real-world assets (RWA). Curated
// manually (Backed Finance xStocks, gold-backed tokens, ETFs) — not run
// through the memecoin screener since authority/age/holder heuristics
// don't apply. Keep this list in sync with supported_mints.category values.
const RWA_CATEGORIES = new Set(["stock", "etf", "metal"]);
const isRwa = (c) => RWA_CATEGORIES.has(c);

// Symbols to never approve — wrapped/bridged L1 tokens that aren't real memecoins
const BLOCKED_SYMBOLS = new Set([
  "SOL", "WSOL", "ETH", "WETH", "BTC", "WBTC", "BNB", "WBNB",
  "USDC", "USDT", "BUSD", "DAI", "USDD", "TUSD", "FRAX",
  "DOGE", "SHIB", "PEPE", "FLOKI", "BONK20", "LINK", "UNI",
  "AVAX", "MATIC", "DOT", "ADA", "XRP", "LTC", "ATOM",
]);

// Impersonation guard: tokens that try to pass as well-known mints. Any
// submission with a matching symbol OR name (case-insensitive) but a
// DIFFERENT mint address gets rejected. Add canonical mints as we
// onboard them so the screener catches "Fake BONK", "USDC2", "Real WIF",
// unicode lookalikes, etc.
// Expanded 2026-06-12 (audit F-3): catches symbol/name impersonation
// of top-50 Solana tokens by mcap. An attacker minting a fake "JLP" or
// "Real WIF" on a different mint address can't slip past name/symbol
// matchers and end up enabled as collateral. Add entries as new
// well-known mints emerge — operator quarterly review per F-3 follow-up.
//
// IMPORTANT: never store an entry for a token whose canonical mint
// could legitimately have a duplicate (e.g. mint authority still
// active and re-issuing). The map enforces 1:1; ambiguous tokens stay
// out so checkImpersonation doesn't false-reject.
const CANONICAL_MINTS = new Map([
  // Memecoins (highest impersonation risk — symbols are short + meme-y)
  ["BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
  ["WIF", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"],
  ["PENGU", "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv"],
  ["POPCAT", "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"],
  ["FARTCOIN", "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"],
  ["CUM", "oqU4DdYCbdSf9j74vnEgvCn1YzNfYQEPWaC6pu6pump"],
  ["MEW", "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5"],
  ["MOTHER", "3S8qX1MsMqRbiwKg2cQyx7nis1oHMgaCuc9c4VfvVdPN"],
  ["GIGA", "63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9"],
  ["MANEKI", "25hAyBQfoDhfWx9ay6rarbgvWGwDdNqcHsXS3jQ3mTDJ"],
  ["MOODENG", "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY"],
  ["GOAT", "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump"],
  ["RETARDIO", "6ogzHhzdrQr9Pgv6hZ2MNze7UrzBMAFyBBWUYp1Fhitx"],
  ["MICHI", "5mbK36SZ7J19An8jFochhQS4of8g6BwUjbeCSxBSoWdp"],
  ["BILLY", "3B5wuUrMEi5yATD7on46hKfej3pfmd7t1RKgrsN3pump"],

  // Stables
  ["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  ["USDT", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"],
  ["PYUSD", "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"],
  ["USDS", "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA"],

  // DeFi (Solana DEXs + lending)
  ["JUP", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"],
  ["JLP", "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"],
  ["RAY", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"],
  ["ORCA", "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE"],
  ["DRIFT", "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7"],
  ["KMNO", "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS"],

  // Oracles + Infrastructure
  ["PYTH", "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3"],
  ["JTO", "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL"],
  ["W", "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ"],
  ["TNSR", "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6"],

  // Liquid Staking Tokens (often impersonated — yield-bearing)
  ["MSOL", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"],
  ["JITOSOL", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"],
  ["BSOL", "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"],
  ["INF", "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm"],

  // SOL itself — guard against "wrapped SOL impersonator"
  ["SOL", "So11111111111111111111111111111111111111112"],
]);

// Normalize a string for comparison: lowercase, strip whitespace, remove
// common visual-confusable unicode (e.g. cyrillic 'а' for latin 'a').
function normalizeName(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[а]/g, "a") // cyrillic 'а' → 'a'
    .replace(/[о]/g, "o") // cyrillic 'о' → 'o'
    .replace(/[е]/g, "e") // cyrillic 'е' → 'e'
    .replace(/[р]/g, "p") // cyrillic 'р' → 'p'
    .replace(/[с]/g, "c") // cyrillic 'с' → 'c'
    .replace(/[х]/g, "x") // cyrillic 'х' → 'x'
    .replace(/[у]/g, "y"); // cyrillic 'у' → 'y'
}

/**
 * Reject tokens trying to impersonate a well-known mint. Triggers if the
 * submission's symbol or name matches a canonical one but the mint differs.
 *
 * Hits get logged to stderr with a SECURITY tag so an operator can see
 * the pattern (an attacker probing the screener generates a trail). The
 * screener's existing per-tick alerting wrapper will batch these for the
 * daily ops digest.
 */
export function checkImpersonation(mint, symbol, name) {
  const symUp = (symbol || "").toUpperCase().trim();
  if (CANONICAL_MINTS.has(symUp)) {
    const canonical = CANONICAL_MINTS.get(symUp);
    if (canonical !== mint) {
      const reason = `symbol "${symUp}" impersonates canonical mint ${canonical.slice(0, 8)}…`;
      console.warn(`[SECURITY][impersonation] reject ${String(mint).slice(0,8)}…: ${reason} (symbol="${symbol}", name="${name}")`);
      return { ok: false, reason };
    }
  }
  const nameNorm = normalizeName(name);
  for (const [canonSym, canonMint] of CANONICAL_MINTS) {
    if (nameNorm === canonSym.toLowerCase() && mint !== canonMint) {
      const reason = `name "${name}" matches canonical "${canonSym}" but mint differs`;
      console.warn(`[SECURITY][impersonation] reject ${String(mint).slice(0,8)}…: ${reason} (canonical=${canonMint.slice(0,8)}…)`);
      return { ok: false, reason };
    }
  }
  return { ok: true };
}

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

/**
 * RWA ISSUER ALLOWLIST — tokens whose mint authority is one of these
 * pubkeys can be classified as tokenized stocks / metals / ETFs.
 * Anything else stays a memecoin regardless of symbol/name patterns.
 *
 * Why: 2026-06-07 — $FATHER (Nvidia CEO memecoin) was classified as
 * "stock" because its name contained "nvidia". RWA path skips authority
 * checks, has lower liquidity/holder bars, and routes to a separate
 * pool with different risk parameters. A memecoin landing in the RWA
 * pool defeats every memecoin defense we have.
 *
 * Fix: name/symbol patterns are NECESSARY but not SUFFICIENT. The mint
 * authority must positively match a known RWA issuer. Tokens with NO
 * mint authority (a hallmark of memecoins after graduation) can never
 * be RWA — RWAs require an issuer to manage supply.
 *
 * Add issuers here as we onboard them — empty by default means NO
 * automatic RWA classification, only operator-set categories survive.
 */
const RWA_ISSUER_AUTHORITIES = new Set([
  // Backed Finance xStock issuers (mainnet). Source: backedfi.com docs.
  ...(process.env.RWA_ISSUER_AUTHORITIES?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
]);

/**
 * Detect if a token is a tokenized real-world asset.
 *
 * Two-gate model:
 *   1. Symbol/name pattern indicates RWA intent (stock ticker prefix,
 *      explicit "tokenized" wording, or company name match).
 *   2. Mint authority is in RWA_ISSUER_AUTHORITIES (positive ID).
 *
 * Both must hold. A memecoin that mentions "Tesla" or "Nvidia" but
 * isn't actually minted by an RWA issuer stays a memecoin and gets
 * the strict memecoin vetting path.
 *
 * Tokens with no mint authority CANNOT be RWA — RWAs require an
 * issuer to manage supply. (Graduated memecoins commonly have no
 * mint authority; previously this was a green flag they were stable,
 * but here it's a strong DISQUALIFIER for RWA classification.)
 *
 * onChain may be null (pre-on-chain-fetch); pass null to get the
 * naive pattern verdict for /reviewtokens display purposes — but
 * the screener pipeline ALWAYS passes onChain so this only affects
 * cosmetic preview.
 */
function detectCategory(symbol, name, onChain = null) {
  const sym = (symbol || "").toUpperCase();
  const nm = (name || "").toLowerCase();

  // Hard rule: pump.fun memecoin mints can NEVER be classified as
  // stock/etf/metal regardless of name or mint authority. Real Backed
  // xStocks use the Token-2022 standard with mint addresses starting
  // with 'Xs...'. pump.fun mints always end in 'pump' and are
  // exclusively memecoins. Without this guard, a memecoin named
  // "FATHER of Nvidia" could pass the name-pattern gate. The DB-side
  // CHECK constraint added in migration 019 catches it as a backstop;
  // this rejects earlier so the rest of the pipeline never sees a
  // pump.fun mint with stock intent.
  const mint = onChain?.mint ?? null;
  if (typeof mint === "string" && mint.endsWith("pump")) {
    return "memecoin";
  }

  // Gate 1: does the name/symbol SUGGEST RWA?
  const patternSuggestsStock =
    (sym.startsWith("X") && STOCK_TICKERS.includes(sym.slice(1))) ||
    /\btokenized\b|\bequity\b/.test(nm) ||
    // Whole-word match for "stock" so "stockton" doesn't trip — and we
    // require it to appear in a phrase like "X stock" or "stock token",
    // not arbitrary mentions.
    /\b(?:stock\s+token|tokenized\s+stock|stock\s+\([a-z]+\))\b/.test(nm) ||
    [
      "tesla", "nvidia", "apple", "alphabet", "amazon", "microsoft",
      "meta platforms", "microstrategy", "coinbase", "netflix", "intel",
      "uber", "shopify", "block inc", "paypal", "disney", "boeing",
      "jpmorgan", "goldman",
    ].some((c) => {
      // Whole-word match — "nvidia" in "Father of Nvidia" → matches the
      // pattern but Gate 2 (issuer allowlist) will reject if no mint
      // authority or unknown issuer.
      return new RegExp(`\\b${c.replace(/\s+/g, "\\s+")}\\b`).test(nm);
    });

  if (!patternSuggestsStock) return "memecoin";

  // Gate 2: positive issuer identification. A real RWA must have a
  // mint authority (issuer manages supply) AND that authority must be
  // on our allowlist.
  if (!onChain) {
    // No on-chain info available (preview-only call) — provisional
    // verdict matches old behavior, but the actual pipeline ALWAYS
    // passes onChain so the strict gate applies in production.
    return "stock";
  }
  if (!onChain.hasMintAuthority || !onChain.mintAuthority) {
    // No mint authority = cannot be a real RWA. Memecoin.
    return "memecoin";
  }
  if (!RWA_ISSUER_AUTHORITIES.has(onChain.mintAuthority)) {
    // Mint authority not on our allowlist = unknown issuer = memecoin.
    return "memecoin";
  }

  return "stock";
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
  minMarketCap: 100_000,
};

// Minimum to even consider (below this = auto-reject)
// Loosened 2026-05-29 — was 30k/100/12h/10k. Sends more tokens to /reviewtokens
// for manual review. AUTO_APPROVE bar stays strict to keep rug-pulls out of
// auto-approvals.
// Calibrated for pump.fun-era tokens: a 4-hour-old token literally hasn't had
// 24 hours to accumulate volume, so the volume bar is much lower.
//
// Tightened 2026-06-07 after the $FATHER oracle-manipulation attack: $FATHER
// was approved with $8.5k liquidity (above the previous $5k floor). At that
// thinness, a small wallet can move price ~10% with a 20-SOL buy, which is
// exactly how the attacker pumped the collateral before borrowing. The new
// $25k floor makes the math much worse for the attacker — they'd have to
// risk far more capital on a doomed pump.
const MIN_CONSIDER = {
  minLiquidityUsd: Number(process.env.SCREENER_MIN_LIQUIDITY_USD) || 25_000,
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

  // Source 6: pump.fun graduates — tokens that completed the bonding curve
  // and migrated to Raydium with locked LP. These have stronger baseline
  // safety than pre-graduation pump tokens but still go through our full
  // scam audit before approval (we never skip the audit just because the
  // launchpad has standardized contracts).
  {
    const urls = [
      "https://frontend-api-v3.pump.fun/coins?limit=50&sort=market_cap&order=DESC&complete=true&includeNsfw=false",
      "https://frontend-api-v3.pump.fun/coins?limit=50&sort=last_trade_timestamp&order=DESC&complete=true&includeNsfw=false",
    ];
    for (const url of urls) {
      const data = await cachedJson(url);
      if (Array.isArray(data)) {
        for (const t of data) {
          if (t?.mint) addSolanaToken(t.mint, "pumpfun_graduate");
        }
      }
    }
  }

  // Source 7: letsbonk.fun / Bonk launchpad graduates. The API surface is
  // less stable than pump.fun's; we hit their public coin list and fall
  // through silently if the endpoint shape shifts.
  {
    const urls = [
      "https://api.letsbonk.fun/coins?sort=market_cap&order=desc&limit=50&complete=true",
      "https://api.letsbonk.fun/v1/coins?sort=market_cap_desc&limit=50",
    ];
    for (const url of urls) {
      const data = await cachedJson(url);
      const list = Array.isArray(data) ? data : Array.isArray(data?.coins) ? data.coins : Array.isArray(data?.data) ? data.data : null;
      if (list) {
        for (const t of list) {
          const addr = t?.mint || t?.address || t?.token_address;
          if (addr) addSolanaToken(addr, "letsbonk_graduate");
        }
      }
    }
  }

  // Source 8: Search DexScreener for "x" prefixed stock tokens
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

    // Read the actual authority pubkeys when set — needed for RWA issuer
    // verification (only tokens minted by a known RWA issuer should be
    // classified as 'stock'/'etf'/'metal').
    let mintAuthority = null;
    let freezeAuthority = null;
    try {
      if (mintAuthorityOption === 1) {
        mintAuthority = new PublicKey(data.subarray(4, 36)).toBase58();
      }
      if (freezeAuthorityOption === 1) {
        freezeAuthority = new PublicKey(data.subarray(50, 82)).toBase58();
      }
    } catch {
      // bad pubkey bytes — leave nulls; safer to not classify than to misclassify
    }

    return {
      decimals,
      hasMintAuthority: mintAuthorityOption === 1,
      hasFreezeAuthority: freezeAuthorityOption === 1,
      mintAuthority,
      freezeAuthority,
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
 * Estimate holder count. Tries in order:
 *   1. Helius token-metadata endpoint using the key embedded in SOLANA_RPC_URL
 *      (so we don't need a separate HELIUS_API_KEY env var).
 *   2. Birdeye public API (only useful if BIRDEYE_API_KEY is set).
 *   3. Returns -1 ("unknown") rather than 0 so the screener doesn't treat
 *      a lookup failure as "this token has zero holders". The vetting
 *      function checks for -1 and skips the holder gate when so.
 */
async function getHolderCount(mint) {
  // Extract api-key from SOLANA_RPC_URL — saves needing a separate env var.
  // SOLANA_RPC_URL looks like: https://mainnet.helius-rpc.com/?api-key=<key>
  const rpcUrl = process.env.SOLANA_RPC_URL || "";
  const heliusKey =
    process.env.HELIUS_API_KEY ||
    rpcUrl.match(/[?&]api-key=([a-f0-9-]+)/i)?.[1] ||
    null;

  if (heliusKey) {
    try {
      const res = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${heliusKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mintAccounts: [mint] }),
      });
      if (res.ok) {
        const data = await res.json();
        const count = data[0]?.onChainAccountInfo?.holderCount;
        if (typeof count === "number") return count;
      }
    } catch { /* fallback */ }
  }

  // Fallback: Birdeye (only works with key).
  if (process.env.BIRDEYE_API_KEY) {
    try {
      const res = await fetch(
        `https://public-api.birdeye.so/defi/v3/token/holder?address=${mint}`,
        { headers: { "X-API-KEY": process.env.BIRDEYE_API_KEY } },
      );
      if (res.ok) {
        const data = await res.json();
        if (typeof data?.data?.total === "number") return data.data.total;
      }
    } catch { /* fallback */ }
  }

  // Unknown — caller treats this as "skip the holder gate" rather than
  // blocking on a lookup failure.
  return -1;
}

// ─── Audit-result caches (in-memory, per process) ─────────────────────────
// Token-2022 extensions / holder concentration / rugcheck data change very
// slowly. Cache audit results so repeated tick passes don't re-hit RPC for
// the same mint. Cache lifetime ~30 min — long enough to slash Helius
// burn, short enough that authority flips still get caught (and the
// hourly token-health watcher independently re-audits every approved mint).
const _extensionCache = new Map(); // mint -> { result, expiresAt }
const _concentrationCache = new Map();
const _rugcheckCache = new Map();
const AUDIT_CACHE_MS = 30 * 60 * 1000;

function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { map.delete(key); return null; }
  return entry.result;
}
function cachePut(map, key, result) {
  map.set(key, { result, expiresAt: Date.now() + AUDIT_CACHE_MS });
}

// ─── Token-2022 extension audit ─────────────────────────────────────────────

/**
 * Inspect a Token-2022 mint's extensions for ones that let an issuer block,
 * pause, freeze, drain, or tax transfers after we've already approved the
 * token. Returns { safe: true } for legacy tokens or Token-2022 tokens with
 * benign extensions only; otherwise { safe: false, reason }.
 *
 * Catches the modern "approve it, then activate trap later" attack that
 * the legacy mint/freeze-authority check is blind to.
 */
export async function auditTokenExtensions(mintStr, { fresh = false } = {}) {
  if (!fresh) {
    const cached = cacheGet(_extensionCache, mintStr);
    if (cached) return cached;
  }
  const result = await _auditTokenExtensionsUncached(mintStr);
  cachePut(_extensionCache, mintStr, result);
  return result;
}

async function _auditTokenExtensionsUncached(mintStr) {
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const spl = await import("@solana/spl-token");
    const {
      TOKEN_2022_PROGRAM_ID, ExtensionType,
      getMint, getTransferFeeConfig, getTransferHook, getPermanentDelegate,
      getMintCloseAuthority, getInterestBearingMintConfigState, getDefaultAccountState,
      getExtensionTypes,
    } = spl;
    const { connection } = await import("../solana/connection.js");

    const mintPk = new PublicKey(mintStr);
    const info = await connection.getAccountInfo(mintPk);
    if (!info) return { safe: false, reason: "mint account not found" };

    // Legacy SPL Token mints can't have extensions; they're already audited
    // via has_mint_authority / has_freeze_authority. Belt-and-suspenders:
    // also reject legacy tokens whose freeze_authority is set, since that
    // authority can freeze accounts at any time.
    if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const legacy = await getMint(connection, mintPk).catch(() => null);
      if (legacy?.freezeAuthority && !legacy.freezeAuthority.equals(PublicKey.default)) {
        return { safe: false, reason: "Freeze authority active — can freeze tokens later" };
      }
      if (legacy?.mintAuthority && !legacy.mintAuthority.equals(PublicKey.default)) {
        return { safe: false, reason: "Mint authority active — supply can be inflated later" };
      }
      return { safe: true };
    }

    const mint = await getMint(connection, mintPk, "confirmed", TOKEN_2022_PROGRAM_ID);
    const isSet = (pk) => pk && !pk.equals(PublicKey.default);

    // Same legacy fields exist on Token-2022 mints — must also be renounced.
    if (isSet(mint.freezeAuthority)) {
      return { safe: false, reason: "Freeze authority active — can freeze tokens later" };
    }
    if (isSet(mint.mintAuthority)) {
      return { safe: false, reason: "Mint authority active — supply can be inflated later" };
    }

    // NonTransferable extension: tokens can never be moved at all. Reject outright.
    const extTypes = mint.tlvData?.length ? getExtensionTypes(mint.tlvData) : [];
    if (ExtensionType?.NonTransferable !== undefined && extTypes.includes(ExtensionType.NonTransferable)) {
      return { safe: false, reason: "NonTransferable extension — token literally cannot be sold" };
    }

    // PermanentDelegate: a fixed address can move anyone's tokens at any time.
    const delegate = getPermanentDelegate(mint);
    if (delegate && isSet(delegate.delegate)) {
      return { safe: false, reason: `PermanentDelegate set (${delegate.delegate.toBase58().slice(0, 8)}…)` };
    }

    // TransferHook: external program runs on every transfer and can reject.
    // BOTH a configured program AND a set authority are red flags — authority
    // means the hook can be ADDED later even if currently null.
    const hook = getTransferHook(mint);
    if (hook) {
      if (isSet(hook.programId)) {
        return { safe: false, reason: `TransferHook program set (${hook.programId.toBase58().slice(0, 8)}…)` };
      }
      if (isSet(hook.authority)) {
        return { safe: false, reason: "TransferHook authority active — hook can be added later" };
      }
    }

    // TransferFee: rejection on EITHER a high current fee OR an active
    // authority (which could raise the fee post-approval).
    const fee = getTransferFeeConfig(mint);
    if (fee) {
      const newerBps = fee.newerTransferFee?.transferFeeBasisPoints ?? 0;
      const olderBps = fee.olderTransferFee?.transferFeeBasisPoints ?? 0;
      const maxBps = Math.max(newerBps, olderBps);
      if (maxBps > 500) {
        return { safe: false, reason: `TransferFee ${(maxBps / 100).toFixed(2)}% exceeds 5% limit` };
      }
      if (isSet(fee.transferFeeConfigAuthority)) {
        return { safe: false, reason: "TransferFee authority active — fee can be raised later" };
      }
    }

    // MintCloseAuthority: a holder of this authority can close the mint,
    // stranding every account holding the token. Reject if active.
    const mintClose = getMintCloseAuthority?.(mint);
    if (mintClose && isSet(mintClose.closeAuthority)) {
      return { safe: false, reason: "MintCloseAuthority active — mint can be closed and tokens stranded" };
    }

    // InterestBearingConfig: the rate authority can change the interest
    // rate at any time (positive or negative, no cap). Reject if active.
    const interest = getInterestBearingMintConfigState?.(mint);
    if (interest && isSet(interest.rateAuthority)) {
      return { safe: false, reason: "InterestBearing rate authority active — rate can be changed" };
    }

    // DefaultAccountState: if this extension exists and the freeze_authority
    // is renounced (we already check that above), the state can't be changed.
    // But if the state is currently set to Frozen, every new account starts frozen.
    const defaultState = getDefaultAccountState?.(mint);
    if (defaultState?.state === 2 /* Frozen */) {
      return { safe: false, reason: "DefaultAccountState=Frozen — new accounts created frozen" };
    }

    // PausableConfig (newer extension): if exists with an active authority,
    // every transfer can be paused on demand. Reject. Extension may not be
    // exported in older spl-token; check by ExtensionType enum if available.
    const PAUSABLE = ExtensionType?.PausableConfig;
    if (PAUSABLE !== undefined && extTypes.includes(PAUSABLE)) {
      return { safe: false, reason: "PausableConfig extension present — transfers can be paused" };
    }

    return { safe: true };
  } catch (err) {
    // Conservative: if we can't audit, reject (rather than silently approve
    // a potentially-malicious extension we couldn't read).
    return { safe: false, reason: `extension audit failed: ${err.message}` };
  }
}

// ─── Holder concentration ───────────────────────────────────────────────────

/**
 * Reject tokens where the top 10 holders control >40% of supply — this is
 * the classic dev-dump risk: a tiny group of wallets can crash the price
 * right after we accept the token as collateral.
 *
 * Skips tokens whose top holders are clearly pool addresses (DEX LPs are
 * expected to hold significant supply). For now we treat any holder with
 * an unusually large balance as suspect; future iteration could whitelist
 * known LP programs.
 */
export async function checkHolderConcentration(mintStr, opts = {}) {
  const cacheKey = `${mintStr}::${opts.maxTop10Pct ?? 40}::${opts.maxTop20Pct ?? 60}`;
  if (!opts.fresh) {
    const cached = cacheGet(_concentrationCache, cacheKey);
    if (cached) return cached;
  }
  const result = await _checkHolderConcentrationUncached(mintStr, opts);
  cachePut(_concentrationCache, cacheKey, result);
  return result;
}

async function _checkHolderConcentrationUncached(mintStr, opts = {}) {
  const maxTop10Pct = opts.maxTop10Pct ?? 40;
  const maxTop20Pct = opts.maxTop20Pct ?? 60;
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { connection } = await import("../solana/connection.js");

    const mintPk = new PublicKey(mintStr);
    const [largest, supplyInfo] = await Promise.all([
      connection.getTokenLargestAccounts(mintPk, "confirmed"),
      connection.getTokenSupply(mintPk, "confirmed"),
    ]);
    const total = BigInt(supplyInfo.value.amount);
    if (total === 0n) return { ok: false, reason: "zero supply" };

    // Solana returns up to 20 largest accounts; check both top-10 and
    // top-20 (=full set) so a scammer can't just split 90% across 11
    // wallets to dodge the top-10 limit.
    const top10 = largest.value.slice(0, 10);
    const top20 = largest.value.slice(0, 20);
    const sum10 = top10.reduce((acc, a) => acc + BigInt(a.amount), 0n);
    const sum20 = top20.reduce((acc, a) => acc + BigInt(a.amount), 0n);
    const pct10 = Number((sum10 * 10000n) / total) / 100;
    const pct20 = Number((sum20 * 10000n) / total) / 100;

    if (pct10 > maxTop10Pct) {
      return { ok: false, reason: `top-10 holders own ${pct10.toFixed(1)}% (max ${maxTop10Pct}%)` };
    }
    if (pct20 > maxTop20Pct) {
      return { ok: false, reason: `top-20 holders own ${pct20.toFixed(1)}% (max ${maxTop20Pct}%)` };
    }
    return { ok: true, topTenPct: pct10, topTwentyPct: pct20 };
  } catch (err) {
    // Don't block on transient RPC errors — log and let downstream checks
    // (sellability) be the safety net.
    console.warn(`[screener] holder check failed for ${mintStr}: ${err.message}`);
    return { ok: true, skipped: true, reason: err.message };
  }
}

// ─── External risk aggregator (RugCheck) ───────────────────────────────────

/**
 * Cross-check the token against rugcheck.xyz's aggregated risk feed. They
 * report LP burn/lock status, mutable metadata, top holder concentration,
 * and a composite risk score we'd otherwise have to compute ourselves.
 *
 * Treats RugCheck failures as "skip" rather than "reject" so a third-party
 * outage doesn't block legitimate submissions. The other audit gates remain.
 */
export async function rugcheckRisk(mintStr, { fresh = false } = {}) {
  if (!fresh) {
    const cached = cacheGet(_rugcheckCache, mintStr);
    if (cached) return cached;
  }
  const result = await _rugcheckRiskUncached(mintStr);
  cachePut(_rugcheckCache, mintStr, result);
  return result;
}

async function _rugcheckRiskUncached(mintStr) {
  try {
    const res = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${mintStr}/report/summary`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return { ok: true, skipped: true, reason: `rugcheck ${res.status}` };
    const data = await res.json();

    // Hard rejection conditions on RugCheck's structured signals:
    //  - LP not burned/locked (the highest-leverage post-approval rug)
    //  - Composite risk score in the "danger" band (>=300 on their scale)
    //  - Mutable metadata authority still set
    const risks = Array.isArray(data?.risks) ? data.risks : [];
    const fatal = risks.find((r) =>
      /lp.*not.*burned|lp.*not.*locked|mutable.*meta|honeypot|freeze|mint.*authority/i.test(`${r?.name} ${r?.description}`),
    );
    if (fatal) {
      return { ok: false, reason: `rugcheck: ${fatal.name}` };
    }
    if (typeof data?.score === "number" && data.score >= 5000) {
      return { ok: false, reason: `rugcheck risk score ${data.score} (danger band)` };
    }
    return { ok: true };
  } catch (err) {
    // Network/parse error — log and skip rather than block. Our own audits
    // (sellability, extensions, holder concentration) still apply.
    console.warn(`[screener] rugcheck unreachable for ${mintStr}: ${err.message}`);
    return { ok: true, skipped: true, reason: err.message };
  }
}

// ─── Submitter cooldown ─────────────────────────────────────────────────────

const REJECTION_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Track recent submission rejections per submitter so a single user can't
 * brute-force submit dozens of variants of a scam token. After 3 rejections
 * within 24h, block any further submission from that submitter.
 *
 * Stored in submitter_cooldowns table (created on first record).
 */
export async function isSubmitterCoolingDown(submitterTgId) {
  if (!submitterTgId) return { allowed: true };
  await query(
    `CREATE TABLE IF NOT EXISTS submitter_rejections (
       submitter_tg_id BIGINT NOT NULL,
       mint TEXT NOT NULL,
       reason TEXT,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       PRIMARY KEY (submitter_tg_id, mint)
     )`,
  );
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM submitter_rejections
      WHERE submitter_tg_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [submitterTgId],
  );
  if (rows[0].n >= 3) {
    return { allowed: false, reason: `3 rejections in 24h — cooldown active` };
  }
  return { allowed: true };
}

export async function recordSubmitterRejection(submitterTgId, mint, reason) {
  if (!submitterTgId) return;
  try {
    await query(
      `INSERT INTO submitter_rejections (submitter_tg_id, mint, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (submitter_tg_id, mint) DO UPDATE SET reason = EXCLUDED.reason, created_at = NOW()`,
      [submitterTgId, mint, reason],
    );
  } catch (err) {
    console.warn(`[screener] recordSubmitterRejection failed: ${err.message}`);
  }
}

// ─── Honeypot test ──────────────────────────────────────────────────────────

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_QUOTE_API = process.env.JUPITER_QUOTE_API || "https://lite-api.jup.ag/swap/v1/quote";

/**
 * Verify the token is sellable by asking Jupiter to quote a tiny <token> → SOL
 * swap. If Jupiter can't route the trade (transfer hook blocks, frozen mint,
 * 100% transfer fee, default-frozen accounts, no DEX liquidity), the token is
 * effectively a honeypot and must be rejected.
 *
 * Returns { sellable: true } on success, or { sellable: false, reason } on
 * any failure. Catches the classic "approve it, dump on us, can't liquidate"
 * attack that pure threshold checks miss.
 */
export async function checkSellable(mint, decimals) {
  // Quote a sell of 1 whole token (10^decimals raw units). Small enough to
  // not require huge depth; large enough that fee/precision rounding doesn't
  // zero it out.
  const amount = Math.pow(10, Math.max(0, decimals ?? 6));
  const url = `${JUP_QUOTE_API}?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${amount}&slippageBps=500&onlyDirectRoutes=false`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      // Jupiter explicitly fails when the token cannot be routed.
      return { sellable: false, reason: `Jupiter quote ${res.status}` };
    }
    const data = await res.json();
    if (!data?.outAmount || data.outAmount === "0") {
      return { sellable: false, reason: "Jupiter returned no sell route" };
    }
    return { sellable: true };
  } catch (err) {
    // Network errors don't necessarily mean honeypot, but we err on the
    // side of caution and require a successful sellability check before
    // approving anything.
    return { sellable: false, reason: `quote check failed: ${err.message}` };
  }
}

// ─── Vetting ────────────────────────────────────────────────────────────────

/**
 * Run safety checks on a token and return a verdict.
 * Stocks and memecoins have different criteria.
 */
function vetToken(onChain, market, holderCount, category) {
  const fails = [];
  let safetyScore = 100;
  const rwa = isRwa(category);

  const ageHours = market.pairCreatedAt
    ? Math.floor((Date.now() - market.pairCreatedAt) / 3_600_000)
    : 0;

  // ── Authority checks ──
  // RWAs (stocks/ETFs/metals): mint/freeze authority is EXPECTED — the
  // issuer (Backed Finance, VNX, etc.) manages supply to track the
  // underlying real-world price. Memecoins: those are red flags.
  if (!rwa) {
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

  // Holders (stocks can have fewer holders and still be legitimate).
  // holderCount == -1 means "unknown" (lookup failed) — skip the gate
  // rather than incorrectly treating a failed lookup as zero holders.
  const minHolders = rwa ? 50 : MIN_CONSIDER.minHolders;
  const autoHolders = rwa ? 100 : AUTO_APPROVE.minHolders;
  const holdersKnown = holderCount >= 0;
  if (holdersKnown && holderCount < minHolders) {
    fails.push(`${holderCount} holders < ${minHolders} minimum`);
    safetyScore -= 15;
  } else if (holdersKnown && holderCount < autoHolders) {
    safetyScore -= 5;
  }

  // Volume
  if (market.volume24h < MIN_CONSIDER.minVolume24h) {
    fails.push(`24h volume $${Math.floor(market.volume24h)} < $${MIN_CONSIDER.minVolume24h} minimum`);
    safetyScore -= 10;
  }

  // ── Verdict ──
  let canAutoApprove, meetsMinimum;

  // When holder count is unknown (-1), it's not a fail signal — treat
  // those gates as "pass" so other criteria (liquidity, age, volume,
  // authority audit) make the decision.
  const holderOk = (threshold) => !holdersKnown || holderCount >= threshold;

  if (rwa) {
    // Stocks: don't check mint/freeze authority, lower holder threshold
    canAutoApprove =
      market.liquidity >= AUTO_APPROVE.minLiquidityUsd &&
      holderOk(autoHolders) &&
      ageHours >= AUTO_APPROVE.minAgeHours &&
      market.volume24h >= AUTO_APPROVE.minVolume24h;

    meetsMinimum =
      market.liquidity >= MIN_CONSIDER.minLiquidityUsd &&
      ageHours >= MIN_CONSIDER.minAgeHours &&
      holderOk(minHolders);
  } else {
    // Memecoins: full safety checks.
    //
    // Tightened 2026-06-07: memecoins MUST have a successful holder
    // lookup (holdersKnown === true) to auto-approve. Previously a
    // failed lookup short-circuited holderOk to "pass", which is how
    // $FATHER auto-approved with no holder data. RWA path keeps the
    // permissive behavior because their holder distribution is managed
    // by the issuer and a failed lookup is non-diagnostic.
    canAutoApprove =
      !onChain.hasMintAuthority &&
      !onChain.hasFreezeAuthority &&
      market.liquidity >= AUTO_APPROVE.minLiquidityUsd &&
      holdersKnown &&
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
      holderOk(MIN_CONSIDER.minHolders) &&
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
  const rwa = isRwa(category);
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
      rwa, // RWAs are auto-protected from health monitor delisting
    ],
  );
  // WARM-ON-ENABLE (operator 2026-06-28): the screener auto-approve path
  // previously did NOT kick feed-init/attestation (only the user /submit path
  // did) — so a screener-approved token wasn't V4-borrow-ready for ~90-200s.
  // Now it warms immediately: feed-init (no AccountNotInitialized) + on-demand
  // attestation so the V4 TWAP window fills in ~24s. Best-effort.
  try {
    const { warmMintForBorrow } = await import("./v4-feed-readiness.js");
    await warmMintForBorrow(mint, "screener_auto_approve");
  } catch (e) {
    console.warn(`[screener] warm-on-enable ${mint} failed (sweeps backstop): ${e.message?.slice(0, 100)}`);
  }
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
    // detectCategory NOW requires onChain for the strict issuer-allowlist
    // gate (post-$FATHER fix). A memecoin whose name happens to mention
    // a tickered company can no longer slip into the RWA path.
    const category = detectCategory(market.symbol, market.name, onChain);

    const { verdict, safetyScore, fails, ageHours } = vetToken(onChain, market, holderCount, category);

    // Scam-token guard: before promoting to approved OR review, run the
    // full audit suite. Order: impersonation (cheap, in-memory) →
    // sellability/extensions/concentration (parallel) → rugcheck (slow
    // external). Skips RWAs since they route through their issuer.
    if (!isRwa(category) && (verdict === "auto_approve" || verdict === "review")) {
      const imp = checkImpersonation(mint, market.symbol, market.name);
      if (!imp.ok) {
        await markSeen(mint);
        console.log(`[screener] reject ${market.symbol} (impersonation — ${imp.reason})`);
        continue;
      }
      const [sell, ext, conc, rug] = await Promise.all([
        checkSellable(mint, onChain.decimals),
        auditTokenExtensions(mint),
        checkHolderConcentration(mint),
        rugcheckRisk(mint),
      ]);
      const scamReason =
        !sell.sellable ? `honeypot — ${sell.reason}`
        : !ext.safe ? `unsafe extension — ${ext.reason}`
        : !conc.ok ? `concentration — ${conc.reason}`
        : !rug.ok ? `${rug.reason}`
        : null;
      if (scamReason) {
        await markSeen(mint);
        console.log(`[screener] reject ${market.symbol} (${scamReason})`);
        continue;
      }
    }

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
        const tag = isRwa(t.category) ? ` [${t.category.toUpperCase()}]` : "";
        lines.push(`  + ${t.symbol}${tag} — $${Math.floor(t.liquidity).toLocaleString()} liq, $${Math.floor(t.marketCap).toLocaleString()} mcap`);
      }
      lines.push("");
    }

    if (queued.length > 0) {
      lines.push(`*Needs review (${queued.length}):*`);
      for (const t of queued) {
        const tag = isRwa(t.category) ? ` [${t.category.toUpperCase()}]` : "";
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
    `SELECT * FROM token_screen_queue WHERE status = 'pending' ORDER BY safety_score DESC LIMIT 25`,
  );

  if (rows.length === 0) {
    return ctx.reply("No tokens pending review. The screener auto-approves anything that aged 30 min in the queue without degrading.");
  }

  // Summary header so admin sees scale before scrolling
  const { rows: [totals] } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'approved' AND reviewed_at > NOW() - INTERVAL '24 hours')::int AS approved24h,
       COUNT(*) FILTER (WHERE status = 'rejected' AND reviewed_at > NOW() - INTERVAL '24 hours')::int AS rejected24h
     FROM token_screen_queue`,
  );
  await ctx.reply(
    `📋 *Review queue*\n\nPending: *${totals.pending}* · Approved (24h): *${totals.approved24h}* · Rejected (24h): *${totals.rejected24h}*\n\nShowing top ${rows.length} by safety score.`,
    { parse_mode: "Markdown" },
  );

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

    // Full scam audit re-check at approval time. Token state may have
    // changed between submission and admin review.
    if (!isRwa(t.category)) {
      const imp = checkImpersonation(t.mint, t.symbol, t.name);
      if (!imp.ok) {
        await ctx.answerCallbackQuery(`Blocked: ${imp.reason.slice(0, 40)}`);
        await ctx.editMessageText(`${t.symbol} blocked: impersonation — ${imp.reason}.`);
        await query(`UPDATE token_screen_queue SET status='rejected', reviewed_at=NOW() WHERE mint=$1`, [mint]);
        return;
      }
      // Admin approval is a real-money decision — bypass the audit cache
      // so token state we surface is current, not minutes-stale.
      const [sell, ext, conc, rug] = await Promise.all([
        checkSellable(t.mint, t.decimals),
        auditTokenExtensions(t.mint, { fresh: true }),
        checkHolderConcentration(t.mint, { fresh: true }),
        rugcheckRisk(t.mint, { fresh: true }),
      ]);
      const scamReason =
        !sell.sellable ? `honeypot — ${sell.reason}`
        : !ext.safe ? `unsafe extension — ${ext.reason}`
        : !conc.ok ? `concentration — ${conc.reason}`
        : !rug.ok ? `${rug.reason}`
        : null;
      if (scamReason) {
        await ctx.answerCallbackQuery(`Blocked: ${scamReason.slice(0, 40)}`);
        await ctx.editMessageText(`${t.symbol} blocked: ${scamReason}.`);
        await query(
          `UPDATE token_screen_queue SET status = 'rejected', reviewed_at = NOW() WHERE mint = $1`,
          [mint],
        );
        return;
      }
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
    // WARM-ON-ENABLE (operator 2026-06-28): manual approve → V4-borrow-ready now.
    try {
      const { warmMintForBorrow } = await import("./v4-feed-readiness.js");
      await warmMintForBorrow(t.mint, "review_approve");
    } catch (e) { console.warn(`[screener] warm-on-enable ${t.mint} failed: ${e.message?.slice(0, 100)}`); }

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

// ─── Re-vet aged review queue tokens (NO LONGER AUTO-APPROVES) ──────────────

const REVIEW_AUTO_APPROVE_MS = 30 * 60 * 1000; // 30 min (retained for compat)

/**
 * 2026-06-07 — ROOT-CAUSE FIX FOR THE $FATHER APPROVAL:
 *
 * This function previously auto-promoted any token from review→approved
 * after 1h if it still passed the SCAM re-checks (no honeypot, no
 * unsafe extensions, etc.). It did NOT re-evaluate the ORIGINAL
 * deficiency signals (low liquidity, unknown holder count, etc.)
 * that caused the token to be queued for review in the first place.
 *
 * $FATHER's path was exactly this: queued at $8.5k liquidity with a
 * failed holder lookup → sat in the queue 1h → no scam signals on
 * re-check → AUTO-APPROVED with source='review_auto' → became borrowable
 * collateral → got pumped and exploited.
 *
 * Fix: aged queue entries are now RE-VETTED against the full vetToken
 * criteria including the AUTO_APPROVE bar. Only tokens that meet
 * the auto-approve bar after the 1h aging window get promoted. Anything
 * still in "review" verdict stays in the queue — operator must
 * approve manually via /reviewtokens. Anything in "reject" verdict
 * gets removed.
 *
 * Tokens that fall into manual-review-only territory stay there
 * permanently until the operator decides. That is the entire point.
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

    // Full scam audit re-check before promoting a 1h-aged review entry.
    if (!isRwa(t.category)) {
      const imp = checkImpersonation(t.mint, t.symbol, t.name);
      let scamReason = imp.ok ? null : `impersonation — ${imp.reason}`;
      if (!scamReason) {
        // 30-min auto-approve is also a real-money promotion — bypass
        // cache so we re-audit fresh state rather than trust cached.
        const [sell, ext, conc, rug] = await Promise.all([
          checkSellable(t.mint, onChain.decimals),
          auditTokenExtensions(t.mint, { fresh: true }),
          checkHolderConcentration(t.mint, { fresh: true }),
          rugcheckRisk(t.mint, { fresh: true }),
        ]);
        scamReason =
          !sell.sellable ? `honeypot — ${sell.reason}`
          : !ext.safe ? `unsafe extension — ${ext.reason}`
          : !conc.ok ? `concentration — ${conc.reason}`
          : !rug.ok ? `${rug.reason}`
          : null;
      }
      if (scamReason) {
        await query(
          `UPDATE token_screen_queue SET status = 'rejected', reviewed_at = NOW() WHERE mint = $1`,
          [t.mint],
        );
        if (t.submitted_by && bot) {
          try {
            await bot.api.sendMessage(
              t.submitted_by,
              `Your submitted token *${t.symbol}* was not approved (${scamReason}).`,
              { parse_mode: "Markdown" },
            );
          } catch { /* user may have blocked bot */ }
        }
        console.log(`[screener] Review auto-rejected ${t.symbol} (${scamReason})`);
        continue;
      }
    }

    // Re-vet using the FULL screening criteria (including AUTO_APPROVE).
    // Only tokens that hit the auto-approve bar get promoted from the
    // review queue. Anything still in "review" verdict stays queued for
    // manual approval. This is the post-$FATHER fix — never auto-promote
    // tokens that didn't meet the original bar.
    let liveMarket;
    try {
      const marketMap = await getMarketData([t.mint]);
      liveMarket = marketMap.get(t.mint);
    } catch (err) {
      console.warn(`[screener] review re-vet market fetch failed for ${t.symbol}: ${err.message}`);
      continue; // leave in queue; try again next tick
    }
    if (!liveMarket) continue;

    const liveHolderCount = await getHolderCount(t.mint);
    const { verdict: liveVerdict, fails: liveFails } = vetToken(
      onChain,
      liveMarket,
      liveHolderCount,
      t.category,
    );

    if (liveVerdict !== "auto_approve") {
      // Still doesn't meet the auto-approve bar — leave queued for
      // manual operator review. Update the queue row with the freshest
      // observations so /reviewtokens shows current state.
      await query(
        `UPDATE token_screen_queue
            SET liquidity_usd = $2,
                volume_24h_usd = $3,
                market_cap_usd = $4,
                holder_count = $5,
                fail_reasons = $6
          WHERE mint = $1`,
        [
          t.mint,
          liveMarket.liquidity,
          liveMarket.volume24h,
          liveMarket.marketCap,
          liveHolderCount,
          liveFails,
        ],
      );
      console.log(
        `[screener] Review-queue token ${t.symbol} aged but still not auto-approvable ` +
        `(${liveVerdict}) — leaving for manual review. Live: liq=$${Math.floor(liveMarket.liquidity)}, ` +
        `holders=${liveHolderCount}, vol24=$${Math.floor(liveMarket.volume24h)}`,
      );
      continue;
    }

    // Token now meets the FULL auto-approve bar — promote it.
    await query(
      `INSERT INTO supported_mints
         (mint, symbol, name, decimals, category, image_url, liquidity_usd,
          holder_count, market_cap_usd, has_mint_authority, has_freeze_authority,
          token_age_hours, auto_approved, screened_at, source, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,FALSE,$10,TRUE,NOW(),'review_auto',TRUE)
       ON CONFLICT (mint) DO UPDATE SET enabled = TRUE`,
      [
        t.mint, t.symbol, t.name, t.decimals, t.category, t.image_url,
        liveMarket.liquidity, liveHolderCount, liveMarket.marketCap, t.token_age_hours,
      ],
    );
    // WARM-ON-ENABLE (operator 2026-06-28): queue-promote → V4-borrow-ready now.
    try {
      const { warmMintForBorrow } = await import("./v4-feed-readiness.js");
      await warmMintForBorrow(t.mint, "review_auto_promote");
    } catch (e) { console.warn(`[screener] warm-on-enable ${t.mint} failed: ${e.message?.slice(0, 100)}`); }

    await query(
      `UPDATE token_screen_queue SET status = 'approved', reviewed_at = NOW() WHERE mint = $1`,
      [t.mint],
    );

    console.log(`[screener] Review auto-approved ${t.symbol} (matured to full auto-approve bar)`);

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
