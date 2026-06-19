import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import "dotenv/config";
import { getPriceInSol, getPricesInSolBatch } from "./price.js";
import { getProgramForSigner, chooseProgramIdForCategory } from "../solana/program.js";
import { connection } from "../solana/connection.js";
import { lendingPoolPda, priceFeedPda } from "../solana/pdas.js";
import { query } from "../db/pool.js";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);

// Cached mint→category lookup so we don't query the DB on every attest tick.
// Category never changes after a mint is enabled (we never re-categorize live
// mints), so a process-lifetime cache is safe. Invalidated on bot restart.
const categoryCache = new Map();
async function resolveCategory(mintStr) {
  const cached = categoryCache.get(mintStr);
  if (cached !== undefined) return cached;
  const { rows } = await query(
    `SELECT category FROM supported_mints WHERE mint = $1`,
    [mintStr],
  );
  const category = rows[0]?.category ?? "memecoin";
  categoryCache.set(mintStr, category);
  return category;
}

/**
 * Load the lender keypair. Prefers LENDER_PRIVATE_KEY env var (base58) for
 * production (Railway/Docker have no keypair file on disk), falls back to
 * LENDER_KEYPAIR_PATH file for local dev.
 */
function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) {
    throw new Error("LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set — refusing the CWD-relative fallback. Set the env var.");
  }
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * Read the on-chain price account and return its age in seconds (or
 * null if the account doesn't exist / can't be parsed).
 *
 * V1 + V2 layout (PriceAttestation account):
 *   8     discriminator
 *   32    mint
 *   32    pool
 *   32    authority
 *   8     price_lamports (u64)
 *   8     timestamp (i64)    ← offset 112
 *   2     confidence_bps (u16)
 *   1     bump
 *
 * V3 layout (PriceHistory account — TWAP circular buffer of 32 samples):
 *   8     discriminator
 *   32    mint
 *   32    pool
 *   32    authority
 *   1     head_index (u8)    ← offset 104, next-write slot index
 *   1     count (u8)         ← offset 105, samples populated so far
 *   6     _padding
 *   32×16 samples            ← offset 112, each PriceSample is
 *                                price_lamports:u64 + timestamp:i64
 *   1     bump
 *
 * Latest sample lives at `(head_index - 1 + 32) % 32` when count > 0
 * (head_index is the NEXT-write index). We read its timestamp directly.
 *
 * Reading V3 bytes with the V1/V2 offset returns garbage that gets
 * interpreted as a wildly out-of-range i64 — observed -685M seconds
 * on the wire — which would cause this function to declare the feed
 * "fresh" even when V3's on-chain freshness window has expired.
 */
export async function getPriceFeedAgeSeconds(mintStr, programIdOverride = null) {
  try {
    const mintPk = new PublicKey(mintStr);
    const category = await resolveCategory(mintStr);
    const programId = programIdOverride || chooseProgramIdForCategory(category);
    const [pool] = lendingPoolPda(LENDER_PUBKEY, programId);
    const [priceFeed] = priceFeedPda(mintPk, pool, programId);
    const info = await connection.getAccountInfo(priceFeed);
    if (!info) return null;
    const { PROGRAM_ID_V3, PROGRAM_ID_V4 } = await import("../solana/program.js");
    const isV3 = PROGRAM_ID_V3 && programId.equals(PROGRAM_ID_V3);
    const isV4 = PROGRAM_ID_V4 && programId.equals(PROGRAM_ID_V4);
    let ts;
    if (isV3 || isV4) {
      // PriceHistory layout — minimum is disc+mint+pool+authority+
      // head+count+padding = 104, plus at least one 16-byte sample.
      if (info.data.length < 120) return null;
      const headIndex = info.data.readUInt8(104);
      const count = info.data.readUInt8(105);
      if (count === 0) return null; // no samples written yet
      const latestIndex = (headIndex - 1 + 32) % 32;
      const samplesOffset = 112;
      const sampleStride = 16; // price_lamports(8) + timestamp(8)
      const sampleStart = samplesOffset + latestIndex * sampleStride;
      // timestamp lives 8 bytes into each sample (after price_lamports)
      ts = info.data.readBigInt64LE(sampleStart + 8);
    } else {
      if (info.data.length < 120) return null;
      ts = info.data.readBigInt64LE(112);
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    return Number(now - ts);
  } catch {
    return null;
  }
}

/**
 * Read the V4/V3 PriceHistory PDA and return how many samples sit within
 * `windowSec` of `now`, plus diagnostic counters.
 *
 * Background: the V4 program's TWAP check requires
 *   MIN_SAMPLES_FOR_TWAP=8 within MIN_HISTORY_SECONDS=300
 * so a borrow that lands while the window is still warming hits
 * `TwapInsufficientHistory` (Anchor error 6016 / 0x1780). Cosign-borrow
 * uses this function to know if it needs to JIT-warm the feed BEFORE
 * returning the cosigned tx to the user — see ensureV4TwapReady below.
 *
 * Returns null if the PDA doesn't exist OR isn't a PriceHistory layout
 * (so callers can distinguish "needs init" from "needs warming").
 *
 * Layout reference (from priceFeedAgeSeconds above):
 *   offset 104 → head_index (u8) — next-write slot
 *   offset 105 → count (u8) — total samples ever written (0–32)
 *   offset 112 → samples[32] × 16 bytes (price u64 + timestamp i64)
 *
 * IMPORTANT: `count` is the cumulative population, not the in-window
 * population. Once the buffer fills (count=32) every fresh tick rolls
 * the head and overwrites the oldest sample. So we ALWAYS iterate every
 * populated slot and count by timestamp rather than trusting `count`.
 */
export async function getV4TwapSampleCount(mintStr, windowSec = 300, programIdOverride = null) {
  try {
    const { PROGRAM_ID_V3, PROGRAM_ID_V4 } = await import("../solana/program.js");
    // Default to V4 for backward compatibility, but accept V3 too — both
    // use the price_v3 PriceHistory layout with the same TWAP semantics.
    const programId = programIdOverride || PROGRAM_ID_V4 || PROGRAM_ID_V3;
    if (!programId) return null;
    const mintPk = new PublicKey(mintStr);
    const [pool] = lendingPoolPda(LENDER_PUBKEY, programId);
    const [priceFeed] = priceFeedPda(mintPk, pool, programId);
    const info = await connection.getAccountInfo(priceFeed);
    if (!info || info.data.length < 120) return null;
    const totalCount = info.data.readUInt8(105);
    const SAMPLES_OFFSET = 112;
    const STRIDE = 16; // price(8) + timestamp(8)
    const SLOTS = 32;
    const slotsPopulated = Math.min(totalCount, SLOTS);
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - windowSec;
    let inWindow = 0;
    let newestTs = -Infinity;
    let oldestInWindowTs = Infinity;
    for (let i = 0; i < slotsPopulated; i++) {
      const tsStart = SAMPLES_OFFSET + i * STRIDE + 8;
      const ts = Number(info.data.readBigInt64LE(tsStart));
      if (ts > newestTs) newestTs = ts;
      if (ts >= cutoff) {
        inWindow++;
        if (ts < oldestInWindowTs) oldestInWindowTs = ts;
      }
    }
    return {
      inWindow,
      totalCount,
      slotsPopulated,
      newestTs: newestTs === -Infinity ? null : newestTs,
      oldestInWindowTs: oldestInWindowTs === Infinity ? null : oldestInWindowTs,
      windowSec,
    };
  } catch (err) {
    console.warn(`[getV4TwapSampleCount] ${mintStr.slice(0, 8)}: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

/**
 * Synchronously warm the V4 PriceHistory PDA so a borrow lands without
 * hitting `TwapInsufficientHistory`. Returns:
 *   { ok: true,  inWindow, waitedMs, attests }   on success
 *   { ok: false, inWindow, waitedMs, attests, reason } on timeout/error
 *
 * The caller (cosign-borrow.js, commands/borrow.js) MUST treat
 * `ok === false` as a soft 503 — return a clean "feed warming, retry in
 * N seconds" message to the user, NEVER let the chain reject.
 *
 * Operator-mandated 2026-06-18 PM after the
 * `only_0_samples_in_window_need_8` borrow failure. See
 * [[feedback_twap_insufficient_history_never_again]].
 *
 * Defaults are conservative — 45s max wait + 4s spacing → up to 11 attest
 * attempts which is more than the 8 we need even if 2-3 confirmations lag.
 * For non-V4 callers this is a no-op (returns ok:true immediately).
 */
export async function ensureV4TwapReady(mintStr, decimals, opts = {}) {
  // Safety margin above the on-chain MIN_SAMPLES_FOR_TWAP=8 — sample can
  // age out between the moment we measure and the moment the cosigned
  // tx lands on-chain. Targeting 10 gives 2 samples of headroom.
  const REQUIRED_IN_WINDOW = Number(opts.requiredInWindow ?? 10);
  const WINDOW_SEC = 300;
  // 90s budget, 1.5s spacing — comfortably fits 10 samples even from a
  // cold-start PDA that needs init first. Previous 45s/4s budget was too
  // tight: init took ~1s, then 8 attests × 4s = 32s, plus ~2s/attest
  // confirmation latency pushed us past the deadline. Operator hit this
  // on SPCX 2026-06-18 PM after three earlier fixes.
  const MAX_WAIT_MS = Number(opts.maxWaitMs ?? process.env.V4_TWAP_WARM_MAX_MS ?? 90_000);
  const SPACING_MS = Number(opts.spacingMs ?? process.env.V4_TWAP_WARM_SPACING_MS ?? 1_500);
  const START = Date.now();
  let attests = 0;
  let lastErr = null;

  const { PROGRAM_ID_V3, PROGRAM_ID_V4 } = await import("../solana/program.js");
  // Generalized to V3 + V4 (operator hit TwapInsufficientHistory on an
  // SPCX V3 borrow 2026-06-18 PM — the V4-only JIT warmer didn't catch
  // it). Both programs use the price_v3 PriceHistory layout. Caller can
  // pin a specific program via opts.programIdOverride; otherwise we
  // prefer the program the caller specified via opts.programIdOverride,
  // falling back to V4 then V3. See
  // [[feedback_twap_insufficient_history_never_again]].
  const programId =
    opts.programIdOverride || PROGRAM_ID_V4 || PROGRAM_ID_V3;
  if (!programId) {
    return { ok: true, inWindow: null, waitedMs: 0, attests: 0, reason: "no_program_configured" };
  }

  while (Date.now() - START < MAX_WAIT_MS) {
    let status = await getV4TwapSampleCount(mintStr, WINDOW_SEC, programId);
    if (status === null) {
      // Feed PDA not initialized yet. Init then continue — the next
      // iteration will see the empty PriceHistory and start filling it.
      try {
        await initializePriceFeed(mintStr, programId);
      } catch (e) {
        lastErr = `init failed: ${e.message?.slice(0, 100)}`;
        // Don't hard-fail — maybe a race with the background attestor
        // initialized it; sleep + retry.
      }
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (status.inWindow >= REQUIRED_IN_WINDOW) {
      return {
        ok: true,
        inWindow: status.inWindow,
        waitedMs: Date.now() - START,
        attests,
        programId: programId.toBase58().slice(0, 8),
      };
    }
    // Need more samples — fire one attest and wait briefly so the
    // tx finalizes (confirmed) before the next iteration measures.
    try {
      await attestPrice(mintStr, decimals, undefined, programId);
      attests++;
    } catch (e) {
      lastErr = e.message?.slice(0, 100);
      // If this fails because the feed PDA wasn't actually initialized,
      // re-init and try again. AccountNotInitialized → 3012/0xbc4.
      if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(lastErr)) {
        try {
          await initializePriceFeed(mintStr, programId);
        } catch (e2) {
          lastErr = `init-then-attest failed: ${e2.message?.slice(0, 80)}`;
        }
      }
    }
    await new Promise((r) => setTimeout(r, SPACING_MS));
  }

  // Timed out — return current state so caller can surface a good message.
  const final = await getV4TwapSampleCount(mintStr, WINDOW_SEC, programId);
  return {
    ok: false,
    inWindow: final?.inWindow ?? 0,
    waitedMs: Date.now() - START,
    attests,
    reason: lastErr || "timeout",
  };
}

/**
 * Initialize a price feed PDA for a given mint. Idempotent — returns
 * { alreadyExists: true } if the PDA is already on chain.
 *
 * `programIdOverride` (optional, 2026-06-15): bypass category routing
 * and initialize a price feed against a specific program ID. Required
 * for V4 — exit-armed borrows land on V4 regardless of category, so
 * the V4 price_feed PDA must be initialized in PARALLEL with the
 * category default. Without this V4 borrows fail with "Account state
 * mismatch" at on-chain price validation.
 */
export async function initializePriceFeed(mintStr, programIdOverride = null) {
  const category = await resolveCategory(mintStr);
  const programId = programIdOverride || chooseProgramIdForCategory(category);
  const lender = loadLenderKeypair();
  const program = getProgramForSigner(lender, programId);
  const mintPk = new PublicKey(mintStr);
  const [pool] = lendingPoolPda(LENDER_PUBKEY, programId);
  const [priceFeed] = priceFeedPda(mintPk, pool, programId);

  const existing = await connection.getAccountInfo(priceFeed);
  if (existing) {
    return { alreadyExists: true, priceFeed: priceFeed.toBase58() };
  }

  const sig = await program.methods
    .initializePriceFeed()
    .accounts({
      pool,
      mint: mintPk,
      priceFeed,
      authority: lender.publicKey,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .rpc({ commitment: "confirmed" });

  console.log(`Price feed initialized for ${mintStr}: ${sig}`);
  return { signature: sig, priceFeed: priceFeed.toBase58() };
}

/**
 * Update the on-chain price attestation for a given mint.
 * If `priceSolOverride` is provided, uses it; otherwise fetches from Jupiter.
 * Callers attesting many tokens at once should batch-fetch via
 * getPricesInSolBatch and pass the per-mint price to avoid rate limits.
 *
 * `programIdOverride` (optional, 2026-06-15): bypass category routing
 * and attest against a specific program. Needed for V4 — see
 * initializePriceFeed for the rationale.
 */
export async function attestPrice(mintStr, decimals, priceSolOverride, programIdOverride = null) {
  const category = await resolveCategory(mintStr);
  const programId = programIdOverride || chooseProgramIdForCategory(category);
  const lender = loadLenderKeypair();
  const program = getProgramForSigner(lender, programId);
  const mintPk = new PublicKey(mintStr);
  const [pool] = lendingPoolPda(LENDER_PUBKEY, programId);
  const [priceFeed] = priceFeedPda(mintPk, pool, programId);

  const priceSol = priceSolOverride ?? (await getPriceInSol(mintStr));
  // Convert to lamports per 1 full token (10^decimals raw units)
  const priceLamports = Math.floor(priceSol * 1e9);

  if (priceLamports <= 0) {
    throw new Error(`Invalid price for ${mintStr}: ${priceSol} SOL`);
  }

  // Confidence: use 200 bps (2%) as default since Jupiter doesn't provide confidence
  const confidenceBps = 200;

  // Retry-on-429 with exponential backoff. Helius rate-limits aggressively
  // under high concurrency (~25% of attests 429'd at 18-way parallelism
  // 2026-06-18 PM). Retry catches transient 429s without losing the
  // attestation. Blockhash-expired errors also retry — likely caused by
  // RPC queue lag.
  const RETRY_DELAYS_MS = [500, 1500, 3000];
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const sig = await program.methods
        .updatePrice(new BN(priceLamports), confidenceBps)
        .accounts({
          pool,
          priceFeed,
          authority: lender.publicKey,
        })
        .rpc({ commitment: "confirmed" });
      return { signature: sig, priceLamports, priceSol };
    } catch (err) {
      lastErr = err;
      const msg = err.message || "";
      const retriable =
        /429|Too Many Requests|rate.?limit/i.test(msg) ||
        /blockhash.*not.*found|block.*expired|TransactionExpiredBlockheightExceeded/i.test(msg);
      if (!retriable || attempt >= RETRY_DELAYS_MS.length) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}

/**
 * Mints we need to keep continuously fresh on-chain:
 *   1. Those backing any active loan (risk engine / health watcher / repay
 *      flow rely on a non-stale price).
 *   2. Protected mints (protocol's own tokens like $MAGPIE) — keeping these
 *      always-fresh means /borrow against them is instant with no JIT delay.
 *
 * Everything else relies on /borrow's just-in-time attestation, which
 * keeps RPC cost in check.
 */
async function fetchMintsToAttest() {
  // 2026-06-15: V4 pre-warm requirement.
  //
  // The legacy attestor only kept feeds fresh for mints backing active
  // loans + protected mints — everything else relied on JIT attest at
  // borrow time. That model works for V1/V3 (single sample sufficient
  // at borrow time) but BREAKS V4: V4's TWAP gate needs 8 samples
  // accumulated over 5 minutes before the first borrow can land.
  //
  // For V4 to feel instant on ANY enabled mint, we keep the V4 feed
  // continuously warm for every enabled mint. The legacy V1/V3 attest
  // still gates on active-loan/protected — we don't want to burn
  // attestation SOL on mints that won't be borrowed.
  //
  // Returns: { mint, decimals, needsLegacyAttest }
  //   - needsLegacyAttest=true → write V1/V3 (category default) feed
  //   - all rows → write V4 feed (caller iterates V4 inside its own
  //                              gate based on PROGRAM_ID_V4 presence)
  const r = await query(
    `SELECT sm.mint, sm.decimals,
            (sm.protected = TRUE OR EXISTS(
              SELECT 1 FROM loans l
               WHERE l.collateral_mint = sm.mint
                 AND l.status = 'active'
            )) AS needs_legacy_attest
       FROM supported_mints sm
      WHERE sm.enabled = TRUE`,
  );
  return r.rows.map((row) => ({
    mint: row.mint,
    decimals: row.decimals,
    needsLegacyAttest: row.needs_legacy_attest,
  }));
}

/**
 * Start a periodic price attestor loop. The token list is refreshed from
 * the DB on every tick, so newly-approved tokens get attested automatically
 * without a bot restart.
 *
 * @param {number} intervalMs - default 30 seconds
 */
export function startPriceAttestor(intervalMs = 30_000) {
  console.log(`[PriceAttestor] Starting (DB-driven), interval=${intervalMs}ms`);

  const lastPrices = new Map();
  const lastAttestAt = new Map();
  // V3 + V4 each have their own PriceHistory PDA with the price_v3
  // layout + TWAP gate, so each needs independent last-attest tracking
  // to ensure neither gets starved. Without these, the legacy attest
  // would refresh `lastAttestAt` and the V3/V4 pre-warms would think
  // their feeds were fresh too — leaving the V3/V4 PDAs stale.
  const lastAttestAtV3 = new Map();
  const lastAttestAtV4 = new Map();
  // Force a fresh on-chain attestation at least every MAX_GAP_MS so the
  // feed timestamp never crosses the contract's 120s staleness limit AND
  // so the V3 on-chain TWAP fills its 8-samples-in-5-minutes window even
  // for low-volatility tokens (xStocks, BTC). Previous value (60s) plus
  // the drift-skip (drift < 0.5%) meant stable RWA prices were attested
  // only every 90-120s, leaving the TWAP window with 2-3 samples instead
  // of 8 — which surfaced as PriceImpactPumpDetected the moment any spot
  // movement landed against the stale TWAP. Operator hit this on SPCX
  // 2026-06-17 PM. Diagnostic: scripts/diagnose-spcx-twap-lag.mjs
  const MAX_GAP_MS = 30_000;
  // V4 needs a TIGHTER cadence than V1/V3 because the on-chain TWAP rule
  // requires 8 samples within a rolling 5-minute window. At 60s pushes a
  // 5-minute window only contains ~5 samples — so every freshly-enabled
  // V4 token hits TwapInsufficientHistory on its first borrow (operator
  // hit this on $BP 2026-06-17 PM, see feedback_tg_borrow_must_be_reliable).
  // 35s pushes land 8+ samples in any 5-min window → TWAP ready ~5 min
  // after a token first gets attested. Configurable so a future tightening
  // of the on-chain rule (or a desire to widen for SOL spend) is one env
  // bump away.
  const MAX_GAP_MS_V4 = Number(process.env.V4_ATTEST_MAX_GAP_MS) || 35_000;
  // Cap on-chain inits per tick — drip-feed backfill of missing feeds to
  // avoid bursting Helius RPC and triggering 429 rate limits.
  const MAX_INITS_PER_TICK = 5;

  async function tick() {
    let tokens;
    try {
      tokens = await fetchMintsToAttest();
    } catch (err) {
      console.error(`[PriceAttestor] Failed to load active-loan mints: ${err.message}`);
      return;
    }
    if (tokens.length === 0) return; // idle — nothing to keep fresh

    // Single batch Jupiter fetch for all enabled mints (1-2 calls
    // instead of N). On failure (rate limit, transient), fall back to
    // per-mint fetches via getPriceInSol — which itself has Jupiter
    // retry + DexScreener fallback baked in. Slower but resilient:
    // we'd rather attest a few prices per tick than zero. Zero
    // attestations stalls every on-chain borrow with StalePriceAttestation
    // after 2 minutes.
    let priceMap;
    try {
      priceMap = await getPricesInSolBatch(tokens.map((t) => t.mint));
    } catch (err) {
      console.error(`[PriceAttestor] Batch fetch failed (${err.message}) — falling back to per-mint`);
      priceMap = new Map();
      for (const t of tokens) {
        try {
          const p = await getPriceInSol(t.mint);
          if (p) priceMap.set(t.mint, p);
        } catch (perMintErr) {
          // Skip silently — this individual mint will retry next tick
        }
      }
      if (priceMap.size === 0) {
        console.error("[PriceAttestor] No prices recovered from any source — will retry next tick");
        return;
      }
      console.warn(`[PriceAttestor] Per-mint fallback recovered ${priceMap.size}/${tokens.length} prices`);
    }

    // Per-mint backfill for mints the batch didn't cover. Jupiter's
    // batch endpoint can silently omit Token-2022 / xStock mints that
    // require Dex-first routing (e.g., SPCX). The per-mint getPriceInSol
    // has DexScreener + Pyth fallbacks baked in, so it covers what the
    // batch misses. Without this, stocks went 11+ hours without
    // attestation while the bot happily ticked through every other mint
    // (operator hit it on SPCX V3+V4 borrow 2026-06-18 PM).
    const missing = tokens.filter((t) => !priceMap.has(t.mint));
    if (missing.length > 0) {
      for (const t of missing) {
        try {
          const p = await getPriceInSol(t.mint);
          if (p) priceMap.set(t.mint, p);
        } catch {
          // skip silently — this mint will retry next tick
        }
      }
      const recovered = missing.filter((t) => priceMap.has(t.mint)).length;
      if (recovered > 0) {
        console.log(`[PriceAttestor] per-mint backfill recovered ${recovered}/${missing.length} mints not covered by Jupiter batch`);
      }
    }

    // Build a flat task queue of every (mint × target-program) attest
    // that needs to fire this tick. Sequential per-mint loops over
    // ~200 enabled mints × 2 programs took 2-3 minutes — longer than
    // the tick interval itself, so most tokens fell behind threshold.
    // Operator hit it 2026-06-18 PM: 8 of 9 sampled tokens were below
    // the 8-samples-in-300s gate at the same moment.
    //
    // Worker-pool fix: build the queue first (with all gate checks),
    // then process with bounded concurrency. Per-worker error handling
    // mirrors the prior sequential logic so init fallback + drift skip
    // still apply.
    const { PROGRAM_ID_V3: V3PID_LIVE, PROGRAM_ID_V4: V4PID_LIVE } = await import("../solana/program.js");
    const v3v4Targets = [
      V4PID_LIVE ? { id: V4PID_LIVE, label: "V4", lastMap: lastAttestAtV4 } : null,
      V3PID_LIVE ? { id: V3PID_LIVE, label: "V3", lastMap: lastAttestAtV3 } : null,
    ].filter(Boolean);

    const queue = [];
    for (const { mint, decimals, needsLegacyAttest } of tokens) {
      const priceSol = priceMap.get(mint);
      if (!priceSol) continue;
      const priceLamports = Math.floor(priceSol * 1e9);
      const lastPrice = lastPrices.get(mint) || 0;
      const since = Date.now() - (lastAttestAt.get(mint) || 0);
      const drift = lastPrice > 0 ? Math.abs(priceLamports - lastPrice) / lastPrice : 1;
      const driftSkip = drift < 0.005 && lastPrice > 0 && since < MAX_GAP_MS;

      if (needsLegacyAttest && !driftSkip) {
        queue.push({ kind: "legacy", mint, decimals, priceSol, priceLamports });
      }
      for (const target of v3v4Targets) {
        const sinceLast = Date.now() - (target.lastMap.get(mint) || 0);
        if (sinceLast < MAX_GAP_MS_V4) continue;
        queue.push({ kind: "twap", mint, decimals, priceSol, target });
      }
    }

    if (queue.length === 0) return;

    const CONCURRENCY = Number(process.env.PRICE_ATTESTOR_CONCURRENCY) || 12;
    let initsThisTick = 0;
    let attempted = 0, succeeded = 0, initialized = 0, failed = 0;
    let cursor = 0;
    async function attestWorker() {
      while (cursor < queue.length) {
        const task = queue[cursor++];
        attempted++;
        try {
          if (task.kind === "legacy") {
            try {
              const result = await attestPrice(task.mint, task.decimals, task.priceSol);
              lastPrices.set(task.mint, task.priceLamports);
              lastAttestAt.set(task.mint, Date.now());
              succeeded++;
            } catch (attestErr) {
              if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(attestErr.message || "")) {
                if (initsThisTick < MAX_INITS_PER_TICK) {
                  initsThisTick++; // claim slot before async to avoid race
                  const init = await initializePriceFeed(task.mint);
                  if (!init.alreadyExists) {
                    initialized++;
                    console.log(`[PriceAttestor] Auto-initialized feed for ${task.mint.slice(0, 8)} (${initsThisTick}/${MAX_INITS_PER_TICK} this tick)`);
                  }
                }
              } else {
                failed++;
                console.warn(`[PriceAttestor] legacy attest failed for ${task.mint.slice(0, 8)}: ${attestErr.message?.slice(0, 100)}`);
              }
            }
          } else {
            // twap (V3 or V4)
            try {
              await attestPrice(task.mint, task.decimals, task.priceSol, task.target.id);
              task.target.lastMap.set(task.mint, Date.now());
              succeeded++;
            } catch (twapErr) {
              if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(twapErr.message || "")) {
                if (initsThisTick < MAX_INITS_PER_TICK) {
                  initsThisTick++;
                  await initializePriceFeed(task.mint, task.target.id);
                  initialized++;
                  console.log(`[PriceAttestor] Auto-initialized ${task.target.label} feed for ${task.mint.slice(0, 8)} (${initsThisTick}/${MAX_INITS_PER_TICK} this tick)`);
                }
              } else {
                failed++;
                console.warn(`[PriceAttestor] ${task.target.label} attest failed for ${task.mint.slice(0, 8)}: ${twapErr.message?.slice(0, 100)}`);
              }
            }
          }
        } catch (err) {
          failed++;
          console.error(`[PriceAttestor] worker exception for ${task.mint?.slice(0, 8)}: ${err.message?.slice(0, 120)}`);
        }
      }
    }
    const startedAt = Date.now();
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => attestWorker()));
    const elapsedMs = Date.now() - startedAt;
    if (succeeded > 0 || failed > 0 || initialized > 0) {
      console.log(`[PriceAttestor] tick: queue=${queue.length} attempted=${attempted} ok=${succeeded} init=${initialized} fail=${failed} elapsed=${elapsedMs}ms concurrency=${CONCURRENCY}`);
    }
  }

  // Startup pre-warm pass — initialize V3 + V4 PriceHistory PDAs for
  // every enabled mint in parallel, IMMEDIATELY, bypassing the per-tick
  // init cap. Operator-mandated 2026-06-18 PM after SPCX V3 borrow
  // failed because its V3 PDA had never been initialized — the regular
  // tick's drip-feed (MAX_INITS_PER_TICK=5) would've taken many ticks
  // to get to SPCX. This eager init means the FIRST tick already finds
  // initialized PDAs and just attests them, instead of having to
  // bootstrap from scratch.
  //
  // Bounded concurrency = 4 so we don't burst the RPC.
  (async function startupPrewarm() {
    try {
      const { PROGRAM_ID_V3, PROGRAM_ID_V4 } = await import("../solana/program.js");
      const programs = [
        PROGRAM_ID_V4 ? { id: PROGRAM_ID_V4, label: "V4" } : null,
        PROGRAM_ID_V3 ? { id: PROGRAM_ID_V3, label: "V3" } : null,
      ].filter(Boolean);
      if (programs.length === 0) return;
      const tokens = await fetchMintsToAttest();
      console.log(
        `[PriceAttestor] startup pre-warm: ${tokens.length} mint(s) × ${programs.length} program(s) — initializing missing PriceHistory PDAs in parallel (4-wide)`,
      );
      const queue = [];
      for (const t of tokens) {
        for (const prog of programs) {
          queue.push({ mint: t.mint, decimals: t.decimals, prog });
        }
      }
      let initialized = 0;
      let alreadyExisted = 0;
      let errored = 0;
      const CONCURRENCY = 4;
      let idx = 0;
      async function worker() {
        while (idx < queue.length) {
          const task = queue[idx++];
          try {
            const result = await initializePriceFeed(task.mint, task.prog.id);
            if (result.alreadyExists) alreadyExisted++;
            else { initialized++;
              console.log(`[PriceAttestor] startup init ${task.prog.label} for ${task.mint.slice(0, 8)}... sig=${result.signature?.slice(0, 16) || "(skip)"}`);
            }
          } catch (err) {
            errored++;
            console.warn(`[PriceAttestor] startup init ${task.prog.label} for ${task.mint.slice(0, 8)} failed: ${err.message?.slice(0, 100)}`);
          }
        }
      }
      const workers = Array.from({ length: CONCURRENCY }, () => worker());
      await Promise.all(workers);
      console.log(
        `[PriceAttestor] startup pre-warm DONE — initialized=${initialized}, alreadyExisted=${alreadyExisted}, errored=${errored}`,
      );
    } catch (err) {
      console.warn(`[PriceAttestor] startup pre-warm threw: ${err.message?.slice(0, 200)}`);
    }
  })();

  // Run immediately, then on interval
  tick();
  return setInterval(tick, intervalMs);
}
