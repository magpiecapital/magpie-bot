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

    // Hard reject if the mint authority is on the operator-curated
    // deny-list. This catches RWA-shaped tokens we explicitly DO NOT
    // want to onboard even if the rest of their shape passes —
    // currently used to block PreStocks-class issuers whose underlying
    // SPVs are repudiated by the underlying companies (see comment
    // on RWA_DENIED_ISSUER_AUTHORITIES below for context).
    if (authStr && RWA_DENIED_ISSUER_AUTHORITIES.has(authStr)) {
      return {
        ok: false,
        error: `RWA_UNVERIFIED_SPV: issuer ${authStr.slice(0, 8)}… is on the operator deny-list (likely PreStocks-class unverified SPV)`,
      };
    }

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

    // Comprehensive Token-2022 extension audit. A scam can copy the
    // xStock shape but the authority addresses would be different.
    const audit = await auditRwaExtensions(m);
    if (!audit.safe) {
      return { ok: false, error: `extension_audit_failed: ${audit.reason}`, audit };
    }

    return { ok: true, issuer, paused, decimals: m.decimals, mintAuthority: authStr, audit };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── RWA Token-2022 extension audit ──────────────────────────────────────
//
// A scammer can structure a malicious token to LOOK like a Backed xStock
// (same extensions, same on-chain shape) but with the authority addresses
// pointing at their own wallet. Defense: allowlist the specific authority
// addresses real Backed xStocks use. The scammer doesn't have Backed's
// private keys; they can't fake the authorities.
//
// Env-driven allowlists (comma-separated, set in Railway):
//   RWA_FREEZE_AUTHORITIES         — JDq14BW... for Backed xStocks
//   RWA_PERMANENT_DELEGATES        — 5aMNNLQ... for Backed compliance
//   RWA_TRANSFER_HOOK_PROGRAMS     — System program (placeholder)
//   RWA_TRANSFER_HOOK_AUTHORITIES  — 5aMNNLQ... for Backed compliance
//   RWA_TRANSFER_FEE_AUTHORITIES   — typically empty (Backed charges 0)
//   RWA_MAX_TRANSFER_FEE_BPS       — hard cap, default 0
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// Parse + validate a comma-separated env var of base58 pubkeys.
// Invalid entries throw at module load — better to crash the bot at
// startup than to silently drop a misconfigured allowlist entry and
// have the screener reject a legitimate Backed xStock with the
// confusing reason "freeze_authority_not_trusted".
function _parseAllowlist(envName, raw) {
  const seen = new Set();
  for (const piece of (raw || "").split(",")) {
    const s = piece.trim();
    if (!s) continue;
    try {
      // Round-trip through PublicKey to validate base58 + 32-byte length.
      const pk = new PublicKey(s);
      seen.add(pk.toBase58());
    } catch (err) {
      throw new Error(
        `[rwa-screener] ${envName} contains an invalid base58 pubkey: "${s.slice(0, 12)}…". Fix the env var or unset it.`,
      );
    }
  }
  return seen;
}
const RWA_FREEZE_AUTHORITIES = _parseAllowlist("RWA_FREEZE_AUTHORITIES", process.env.RWA_FREEZE_AUTHORITIES);
const RWA_PERMANENT_DELEGATES = _parseAllowlist("RWA_PERMANENT_DELEGATES", process.env.RWA_PERMANENT_DELEGATES);
const RWA_TRANSFER_HOOK_PROGRAMS = new Set([
  SYSTEM_PROGRAM_ID,
  ..._parseAllowlist("RWA_TRANSFER_HOOK_PROGRAMS", process.env.RWA_TRANSFER_HOOK_PROGRAMS),
]);
const RWA_TRANSFER_HOOK_AUTHORITIES = _parseAllowlist("RWA_TRANSFER_HOOK_AUTHORITIES", process.env.RWA_TRANSFER_HOOK_AUTHORITIES);
const RWA_TRANSFER_FEE_AUTHORITIES = _parseAllowlist("RWA_TRANSFER_FEE_AUTHORITIES", process.env.RWA_TRANSFER_FEE_AUTHORITIES);

// Issuer deny-list. Mint authorities here are HARD-REJECTED by the RWA
// audit regardless of whether the rest of the token shape passes.
//
// Use for issuers whose token economics are structurally broken even
// when the on-chain shape looks correct. The current motivating case
// (post 2026-06-11 RWA research):
//
//   PreStocks (https://prestocks.com) — issues pre-IPO equity tokens
//   like ANTHRP, OPENAI, SPACEX, etc. May 13 2026: Anthropic AND
//   OpenAI publicly stated unauthorized SPV transfers may be invalid
//   and confer no shareholder rights. Tokens dropped 39%/34% in 7
//   days. Pricing decoupled from underlying (ANTHRP traded at 2.5x
//   the issuer-stated NAV). Operator's own legal text says tokens
//   "confer no ownership, voting, dividend, information, or other
//   legal rights." Closer to a memecoin than to a backed RWA.
//
// Env format: comma-separated base58 pubkeys (same as the allowlists).
// PreStocks mint authority should be added here as it's discovered
// on-chain — we don't pre-seed because the deny-list is operator-
// curated and the on-chain authority isn't reliably documented.
//
// Even without specific entries, the screener's primary defense
// already handles this case: a token whose mint authority is NOT in
// KNOWN_ISSUERS gets rejected as "unknown issuer". This list is
// defense-in-depth — an explicit deny gives a clean log signal and
// catches cases where someone manually tries to enable a PreStocks
// mint via /enablemint.
const RWA_DENIED_ISSUER_AUTHORITIES = _parseAllowlist(
  "RWA_DENIED_ISSUER_AUTHORITIES",
  process.env.RWA_DENIED_ISSUER_AUTHORITIES,
);

// Transfer-fee cap with sanity ceiling. Backed Finance charges 0, so 0
// is the strict-by-default value. Operator can raise it via env if a
// future issuer charges a small fee, but we hard-cap the env-supplied
// value at 100 bps (1%) — any value higher is almost certainly a typo
// (a scammer can encode up to 10000 bps = 100%, which would seize the
// borrower's entire RWA collateral on every move).
const RWA_MAX_TRANSFER_FEE_BPS_HARD_CAP = 100;
const _envFee = Number(process.env.RWA_MAX_TRANSFER_FEE_BPS || 0);
if (!Number.isFinite(_envFee) || _envFee < 0 || _envFee > RWA_MAX_TRANSFER_FEE_BPS_HARD_CAP) {
  throw new Error(
    `[rwa-screener] RWA_MAX_TRANSFER_FEE_BPS=${process.env.RWA_MAX_TRANSFER_FEE_BPS} is out of allowed range [0, ${RWA_MAX_TRANSFER_FEE_BPS_HARD_CAP}]. Unset or fix.`,
  );
}
const RWA_MAX_TRANSFER_FEE_BPS = _envFee;

// One-time startup warning if any allowlist is empty. Empty == fail
// closed (the audit correctly rejects every mint with that extension
// set), but operators should know the screener is effectively
// disabled for that extension class. This logs ONCE at module load,
// not per-tick, so it stays out of the way after acknowledgement.
{
  const empties = [];
  if (RWA_FREEZE_AUTHORITIES.size === 0) empties.push("RWA_FREEZE_AUTHORITIES");
  if (RWA_PERMANENT_DELEGATES.size === 0) empties.push("RWA_PERMANENT_DELEGATES");
  if (empties.length > 0) {
    console.warn(
      `[rwa-screener] WARNING: ${empties.join(", ")} env var(s) are empty. Every Backed xStock has both a freeze authority and a permanent delegate set — empty allowlists will fail-close every candidate. Configure the env vars in Railway to enable auto-approval.`,
    );
  }
}

async function auditRwaExtensions(mint) {
  const spl = await import("@solana/spl-token");
  const {
    ExtensionType: ET,
    getTransferFeeConfig, getTransferHook, getPermanentDelegate,
    getMintCloseAuthority, getInterestBearingMintConfigState, getDefaultAccountState,
  } = spl;
  const isSet = (pk) => pk && !pk.equals(PublicKey.default);
  const b58 = (pk) => (pk ? pk.toBase58() : null);

  // Freeze authority is REQUIRED on Backed xStocks (compliance pause).
  // Must be in the trusted allowlist — random freeze authority can
  // freeze the bot's collateral vault after the loan is accepted.
  if (isSet(mint.freezeAuthority)) {
    const addr = b58(mint.freezeAuthority);
    if (!RWA_FREEZE_AUTHORITIES.has(addr)) {
      const hint = RWA_FREEZE_AUTHORITIES.size === 0
        ? " (RWA_FREEZE_AUTHORITIES env unset — set it to enable RWA auto-approval)"
        : "";
      return { safe: false, reason: `freeze_authority_not_trusted: ${addr.slice(0, 8)}…${hint}` };
    }
  }

  const extTypes = mint.tlvData?.length ? getExtensionTypes(mint.tlvData) : [];

  // NonTransferable: can't move at all → can't liquidate.
  if (ET.NonTransferable !== undefined && extTypes.includes(ET.NonTransferable)) {
    return { safe: false, reason: "NonTransferable extension present" };
  }

  // PermanentDelegate: a fixed address can move anyone's tokens at any
  // time. Backed uses their compliance authority — must match allowlist.
  const delegate = getPermanentDelegate(mint);
  if (delegate && isSet(delegate.delegate)) {
    const addr = b58(delegate.delegate);
    if (!RWA_PERMANENT_DELEGATES.has(addr)) {
      return { safe: false, reason: `permanent_delegate_not_trusted: ${addr.slice(0, 8)}…` };
    }
  }

  // TransferHook: a program runs on every transfer and can reject. Backed
  // uses System Program as placeholder (no hook). Scam could point at a
  // malicious program that blocks bot withdrawals.
  const hook = getTransferHook(mint);
  if (hook) {
    if (isSet(hook.programId)) {
      const prog = b58(hook.programId);
      if (!RWA_TRANSFER_HOOK_PROGRAMS.has(prog)) {
        return { safe: false, reason: `transfer_hook_program_not_trusted: ${prog.slice(0, 8)}…` };
      }
    }
    if (isSet(hook.authority)) {
      const auth = b58(hook.authority);
      if (!RWA_TRANSFER_HOOK_AUTHORITIES.has(auth)) {
        return { safe: false, reason: `transfer_hook_authority_not_trusted: ${auth.slice(0, 8)}…` };
      }
    }
  }

  // TransferFee: Backed charges 0. Hard cap via env (default 0 = strict).
  const fee = getTransferFeeConfig(mint);
  if (fee) {
    const newerBps = fee.newerTransferFee?.transferFeeBasisPoints ?? 0;
    const olderBps = fee.olderTransferFee?.transferFeeBasisPoints ?? 0;
    const maxBps = Math.max(newerBps, olderBps);
    if (maxBps > RWA_MAX_TRANSFER_FEE_BPS) {
      return { safe: false, reason: `transfer_fee_too_high: ${(maxBps / 100).toFixed(2)}% > ${RWA_MAX_TRANSFER_FEE_BPS / 100}%` };
    }
    if (isSet(fee.transferFeeConfigAuthority)) {
      const addr = b58(fee.transferFeeConfigAuthority);
      if (!RWA_TRANSFER_FEE_AUTHORITIES.has(addr)) {
        return { safe: false, reason: `transfer_fee_authority_not_trusted: ${addr.slice(0, 8)}…` };
      }
    }
  }

  // MintCloseAuthority: holder can close the mint, stranding all accounts.
  const close = getMintCloseAuthority?.(mint);
  if (close && isSet(close.closeAuthority)) {
    return { safe: false, reason: "mint_close_authority_set" };
  }

  // InterestBearing: rate authority can change interest rate at any time.
  const interest = getInterestBearingMintConfigState?.(mint);
  if (interest && isSet(interest.rateAuthority)) {
    return { safe: false, reason: "interest_bearing_rate_authority_set" };
  }

  // DefaultAccountState: state 2 = Frozen → every new account is frozen.
  const def = getDefaultAccountState?.(mint);
  if (def?.state === 2) {
    return { safe: false, reason: "default_account_state_frozen" };
  }

  return { safe: true };
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
