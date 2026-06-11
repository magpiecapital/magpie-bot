/**
 * RWA Screener — discover and maintain tokenized real-world assets (Stocks,
 * ETFs, Metals) as eligible collateral.
 *
 * Discovery sources:
 *   1. DexScreener search "xStock" → all Backed Finance tokenized equities
 *      and ETFs. The naming convention is universal and authoritative —
 *      only Backed mints tokens named "<TICKER>x" with "xStock" in the name.
 *   2. DexScreener search "VNX" → gold and other VNX-issued tokens (VNXAU).
 *
 * For each candidate mint:
 *   - Fetch on-chain mint state (Token-2022 verification, mint authority
 *     match against known issuer pubkeys for extra safety, paused state
 *     via PausableConfig extension if present).
 *   - Apply RWA-specific thresholds: liquidity >= $100k, vol24h >= $5k.
 *   - Classify into category (stock/etf/metal) by symbol pattern.
 *
 * Actions per tick:
 *   - NEW candidate meeting thresholds → enable in supported_mints, DM admin.
 *   - EXISTING enabled RWA failing thresholds 3+ ticks in a row → disable,
 *     DM admin. (3-tick hysteresis avoids single-blip false positives.)
 *   - EXISTING enabled RWA whose mint is paused on-chain → disable
 *     immediately + DM admin.
 *   - No change → silent.
 *
 * Runs every 4 hours by default — RWAs change slowly (Backed adds maybe one
 * token per month), and we don't want to thrash the DexScreener API.
 */
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getExtensionTypes,
  ExtensionType,
  getPausableConfig,
} from "@solana/spl-token";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";

const POLL_INTERVAL_MS = Number(process.env.RWA_SCREENER_INTERVAL_MS) || 4 * 60 * 60 * 1000; // 4h

// RWA-specific approval thresholds. Different from memecoin thresholds —
// these are blue-chip-style assets, so we expect deeper liquidity but
// don't expect the same volume as a hot memecoin.
const APPROVE_LIQUIDITY_USD = 100_000;
const APPROVE_VOLUME_24H_USD = 5_000;

// To DISABLE an already-enabled RWA we require sustained degradation —
// not a single 5-minute blip from DexScreener.
const DISABLE_LIQUIDITY_USD = 50_000;   // half the approve floor
const DISABLE_VOLUME_24H_USD = 1_000;
const DISABLE_CONSECUTIVE_TICKS = 3;

// Known trustworthy issuer mint-authority pubkeys. New candidates whose
// mint_authority matches one of these are auto-trusted (we still apply
// liquidity thresholds). Candidates with a different authority go through
// the manual review queue rather than auto-approving.
const KNOWN_ISSUERS = new Map([
  ["7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj", "Backed Finance"],
  // Add others (VNX Gold, etc.) here as discovered.
]);

// Hysteresis state — survives between ticks within a single process lifetime.
// On bot restart we reset, which means a 1-3 hour delay before an actually-
// bad token gets disabled. Acceptable for slow-moving RWAs.
const consecutiveBadTicks = new Map();

// ─── Discovery ───────────────────────────────────────────────────────────

/**
 * Pull all Backed Finance xStocks from DexScreener via search.
 * Returns deduped list of { mint, symbol, name, liquidity, volume24h, priceUsd }.
 */
async function discoverRwaCandidates() {
  const queries = ["xStock"]; // Add "VNX" or other issuer-keyword searches later
  const seen = new Map(); // mint → best pair (highest liquidity)
  for (const q of queries) {
    let json;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        console.warn(`[rwa-screener] DexScreener search "${q}" returned ${r.status}`);
        continue;
      }
      json = await r.json();
    } catch (err) {
      console.warn(`[rwa-screener] DexScreener search "${q}" failed: ${err.message}`);
      continue;
    }
    const pairs = (json.pairs || []).filter((p) => p.chainId === "solana");
    for (const p of pairs) {
      const mint = p.baseToken?.address;
      if (!mint) continue;
      const liq = p.liquidity?.usd ?? 0;
      const existing = seen.get(mint);
      // Keep the highest-liquidity pair per mint (DexScreener can show
      // multiple pools per token).
      if (!existing || liq > existing.liquidity) {
        seen.set(mint, {
          mint,
          symbol: p.baseToken.symbol,
          name: p.baseToken.name,
          liquidity: liq,
          volume24h: p.volume?.h24 ?? 0,
          priceUsd: parseFloat(p.priceUsd) || 0,
        });
      }
    }
  }
  return Array.from(seen.values());
}

// ─── On-chain verification ───────────────────────────────────────────────

/**
 * Verify a candidate mint:
 *   - is Token-2022 (RWAs always are — sanity check)
 *   - mint_authority matches a known trusted issuer (auto-approve gate)
 *   - paused state (auto-disable gate)
 * Returns { ok, issuer, paused, decimals, error }
 */
async function verifyMintOnChain(mintStr) {
  try {
    const mintPk = new PublicKey(mintStr);
    const info = await connection.getAccountInfo(mintPk);
    if (!info) return { ok: false, error: "mint account not found" };
    if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return { ok: false, error: "not Token-2022 (RWAs must be Token-2022)" };
    }
    const m = await getMint(connection, mintPk, "confirmed", TOKEN_2022_PROGRAM_ID);
    const authStr = m.mintAuthority?.toBase58() ?? null;
    const issuer = authStr ? KNOWN_ISSUERS.get(authStr) ?? null : null;

    // Pausable: read pause state if extension present
    let paused = false;
    try {
      const exts = getExtensionTypes(m.tlvData);
      if (exts.includes(ExtensionType.PausableConfig)) {
        const cfg = getPausableConfig(m);
        paused = !!cfg?.paused;
      }
    } catch {
      // Library version difference — ignore, treat as not-paused
    }
    return { ok: true, issuer, paused, decimals: m.decimals, mintAuthority: authStr };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Classification ──────────────────────────────────────────────────────

/**
 * Heuristic category from symbol/name:
 *   SPYx, QQQx, IWMx, VOOx, etc. → etf
 *   VNXAU, PAXG, XAUT → metal
 *   everything else with xStock pattern → stock
 */
const ETF_TICKERS = new Set(["SPY", "QQQ", "IWM", "VOO", "VTI", "DIA", "EFA", "EEM", "TQQQ", "SOXL"]);
const METAL_SYMBOLS = new Set(["VNXAU", "PAXG", "XAUT", "VNXAG"]);

function classify(symbol, name, mint = null) {
  // Hard rule: pump.fun mints can NEVER classify as stock/etf/metal.
  // Real Backed xStocks use Xs... mints; pump.fun memecoins end in
  // 'pump'. The DB CHECK constraint (migration 019) is the backstop;
  // this rejects in code so the rest of the rwa-screener never tries
  // to insert a pump.fun mint into supported_mints with an RWA category.
  if (typeof mint === "string" && mint.endsWith("pump")) {
    return "memecoin";
  }
  const sym = (symbol || "").toUpperCase();
  if (METAL_SYMBOLS.has(sym)) return "metal";
  // Backed Finance ETFs follow <TICKER>x. Strip the trailing x and match.
  if (sym.endsWith("X")) {
    const stripped = sym.slice(0, -1);
    if (ETF_TICKERS.has(stripped)) return "etf";
  }
  return "stock";
}

// ─── Decision engine ─────────────────────────────────────────────────────

async function decideForCandidate(candidate, dbRow) {
  const onChain = await verifyMintOnChain(candidate.mint);
  if (!onChain.ok) {
    return { action: "skip", reason: `on-chain check failed: ${onChain.error}` };
  }
  if (!onChain.issuer) {
    return { action: "skip", reason: "unknown issuer (mint authority not in trusted list)" };
  }

  // Paused on-chain — immediate disable if currently enabled
  if (onChain.paused) {
    if (dbRow?.enabled) {
      return { action: "disable", reason: "ISSUER PAUSED MINT on-chain (PausableConfig)" };
    }
    return { action: "skip", reason: "issuer-paused, currently disabled" };
  }

  const category = classify(candidate.symbol, candidate.name, candidate.mint);
  const meetsApprove = candidate.liquidity >= APPROVE_LIQUIDITY_USD
    && candidate.volume24h >= APPROVE_VOLUME_24H_USD;
  const failsDisable = candidate.liquidity < DISABLE_LIQUIDITY_USD
    || candidate.volume24h < DISABLE_VOLUME_24H_USD;

  if (!dbRow) {
    // NEW candidate
    if (meetsApprove) {
      return {
        action: "add",
        category,
        decimals: onChain.decimals,
        reason: `liq $${Math.round(candidate.liquidity).toLocaleString()}, vol $${Math.round(candidate.volume24h).toLocaleString()}, issuer=${onChain.issuer}`,
      };
    }
    return { action: "skip", reason: `below approve thresholds (liq $${Math.round(candidate.liquidity).toLocaleString()})` };
  }

  // EXISTING — track health
  if (failsDisable && dbRow.enabled) {
    const bad = (consecutiveBadTicks.get(candidate.mint) ?? 0) + 1;
    consecutiveBadTicks.set(candidate.mint, bad);
    if (bad >= DISABLE_CONSECUTIVE_TICKS) {
      consecutiveBadTicks.delete(candidate.mint);
      return {
        action: "disable",
        reason: `liquidity/volume below disable threshold for ${bad} consecutive ticks (liq $${Math.round(candidate.liquidity).toLocaleString()}, vol $${Math.round(candidate.volume24h).toLocaleString()})`,
      };
    }
    return { action: "warn", reason: `degraded ${bad}/${DISABLE_CONSECUTIVE_TICKS}` };
  }

  // Healthy — clear any prior bad streak
  consecutiveBadTicks.delete(candidate.mint);
  return { action: "noop" };
}

// ─── DB actions ──────────────────────────────────────────────────────────

async function addMint(mint, symbol, name, decimals, category, candidate) {
  await query(
    `INSERT INTO supported_mints
       (mint, symbol, name, decimals, category, liquidity_usd, market_cap_usd,
        holder_count, has_mint_authority, has_freeze_authority, lp_burned,
        token_age_hours, auto_approved, screened_at, source, enabled, protected)
     VALUES ($1,$2,$3,$4,$5,$6,0,
             0, TRUE, TRUE, FALSE,
             999, FALSE, NOW(), 'rwa_screener', TRUE, FALSE)
     ON CONFLICT (mint) DO UPDATE SET
       enabled = TRUE,
       liquidity_usd = EXCLUDED.liquidity_usd,
       screened_at = NOW()`,
    [mint, symbol, name, decimals, category, candidate.liquidity],
  );
}

async function disableMint(mint, reason) {
  await query(
    `UPDATE supported_mints SET enabled = FALSE WHERE mint = $1`,
    [mint],
  );
  await query(
    `INSERT INTO supported_mint_events (mint, event_type, reason, created_at)
     VALUES ($1, 'rwa_auto_disabled', $2, NOW())
     ON CONFLICT DO NOTHING`,
    [mint, reason],
  ).catch(() => {}); // events table optional
}

// ─── Main tick ───────────────────────────────────────────────────────────

async function tick(bot) {
  console.log("[rwa-screener] cycle start");
  let candidates;
  try {
    candidates = await discoverRwaCandidates();
  } catch (err) {
    console.error(`[rwa-screener] discovery failed: ${err.message}`);
    return;
  }
  console.log(`[rwa-screener] discovered ${candidates.length} RWA candidates from DexScreener`);

  // Fetch current state from DB
  const { rows: dbRows } = await query(
    `SELECT mint, symbol, category, enabled FROM supported_mints
      WHERE category IN ('stock','etf','metal')
         OR mint = ANY($1::text[])`,
    [candidates.map((c) => c.mint)],
  );
  const dbByMint = new Map(dbRows.map((r) => [r.mint, r]));

  const adds = [];
  const disables = [];
  const warnings = [];

  for (const c of candidates) {
    const decision = await decideForCandidate(c, dbByMint.get(c.mint));
    if (decision.action === "add") {
      await addMint(c.mint, c.symbol, c.name, decision.decimals, decision.category, c);
      adds.push({ symbol: c.symbol, category: decision.category, reason: decision.reason });
      console.log(`[rwa-screener] + added ${c.symbol} [${decision.category}] — ${decision.reason}`);
    } else if (decision.action === "disable") {
      await disableMint(c.mint, decision.reason);
      disables.push({ symbol: c.symbol, reason: decision.reason });
      console.log(`[rwa-screener] - disabled ${c.symbol} — ${decision.reason}`);
    } else if (decision.action === "warn") {
      warnings.push({ symbol: c.symbol, reason: decision.reason });
    } else if (decision.action === "skip") {
      // Verbose only
      // console.log(`[rwa-screener] . skip ${c.symbol} — ${decision.reason}`);
    }
  }

  // Self-healing pass: DexScreener's "xStock" search ranks by some metric,
  // so a token whose pool shrinks can drop off the index even though it
  // still exists. Direct-probe every enabled RWA the search missed, then
  // run them through the same decision engine. Catches the PLTRx case
  // (liq collapsed $103k → $22k, fell off the search, was invisible to
  // the screener's primary discovery path).
  const candidateMints = new Set(candidates.map((c) => c.mint));
  for (const row of dbRows) {
    if (!row.enabled) continue;
    if (candidateMints.has(row.mint)) continue;
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${row.mint}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) {
        warnings.push({ symbol: row.symbol, reason: `direct probe HTTP ${r.status}` });
        continue;
      }
      const json = await r.json();
      const pairs = Array.isArray(json) ? json : (json.pairs || []);
      if (pairs.length === 0) {
        warnings.push({ symbol: row.symbol, reason: "no DexScreener pairs found — pool fully pulled?" });
        continue;
      }
      const top = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      const probed = {
        mint: row.mint,
        symbol: top.baseToken?.symbol || row.symbol,
        name: top.baseToken?.name || row.symbol,
        liquidity: top.liquidity?.usd || 0,
        volume24h: top.volume?.h24 || 0,
        priceUsd: parseFloat(top.priceUsd) || 0,
      };
      const decision = await decideForCandidate(probed, row);
      if (decision.action === "disable") {
        await disableMint(row.mint, decision.reason);
        disables.push({ symbol: row.symbol, reason: decision.reason + " (via direct probe)" });
        console.log(`[rwa-screener] - disabled ${row.symbol} (direct probe) — ${decision.reason}`);
      } else if (decision.action === "warn") {
        warnings.push({ symbol: row.symbol, reason: decision.reason + " (direct probe)" });
      }
    } catch (err) {
      warnings.push({ symbol: row.symbol, reason: `direct probe failed: ${err.message}` });
    }
  }

  // Admin notification — only if something actionable happened
  if (bot && (adds.length || disables.length || warnings.length)) {
    const lines = ["*RWA Screener Report*", ""];
    if (adds.length) {
      lines.push(`*✓ Auto-approved (${adds.length}):*`);
      for (const a of adds) lines.push(`  + ${a.symbol} [${a.category}] — ${a.reason}`);
      lines.push("");
    }
    if (disables.length) {
      lines.push(`*✗ Auto-disabled (${disables.length}):*`);
      for (const d of disables) lines.push(`  - ${d.symbol} — ${d.reason}`);
      lines.push("");
    }
    if (warnings.length) {
      lines.push(`*⚠ Warnings (${warnings.length}):*`);
      for (const w of warnings) lines.push(`  ? ${w.symbol} — ${w.reason}`);
    }
    try {
      await notifyAdmin(bot, lines.join("\n"));
    } catch (err) {
      console.error(`[rwa-screener] admin notify failed: ${err.message}`);
    }
  }
  console.log(`[rwa-screener] cycle done: +${adds.length} added, -${disables.length} disabled, ${warnings.length} warnings`);
}

export function startRwaScreener(bot, intervalMs = POLL_INTERVAL_MS) {
  console.log(`[rwa-screener] starting, interval=${(intervalMs / 1000 / 60).toFixed(0)}m`);
  // Run immediately then on interval
  tick(bot).catch((err) => console.error(`[rwa-screener] tick error: ${err.message}`));
  return setInterval(() => {
    tick(bot).catch((err) => console.error(`[rwa-screener] tick error: ${err.message}`));
  }, intervalMs);
}

// Exposed for one-off CLI / manual invocation
export { tick as runRwaScreenerOnce };
