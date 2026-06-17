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

  const sig = await program.methods
    .updatePrice(new BN(priceLamports), confidenceBps)
    .accounts({
      pool,
      priceFeed,
      authority: lender.publicKey,
    })
    .rpc({ commitment: "confirmed" });

  return { signature: sig, priceLamports, priceSol };
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
  // V4-specific tracking. Without separate timing, a legacy attest
  // would refresh `lastAttestAt` and the V4 pre-warm would think the
  // V4 feed is fresh too — leaving the V4 PDA stale.
  const lastAttestAtV4 = new Map();
  // Force a fresh on-chain attestation at least every MAX_GAP_MS so the
  // feed timestamp never crosses the contract's 120s staleness limit.
  const MAX_GAP_MS = 60_000;
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

    let initsThisTick = 0;
    for (const { mint, decimals, needsLegacyAttest } of tokens) {
      const priceSol = priceMap.get(mint);
      if (!priceSol) continue; // no Jupiter coverage — skip silently

      try {
        const priceLamports = Math.floor(priceSol * 1e9);
        const lastPrice = lastPrices.get(mint) || 0;
        const since = Date.now() - (lastAttestAt.get(mint) || 0);

        // Skip ONLY if drift is small AND we attested recently enough
        // to keep the on-chain feed fresh.
        const drift = lastPrice > 0 ? Math.abs(priceLamports - lastPrice) / lastPrice : 1;
        const driftSkip = drift < 0.005 && lastPrice > 0 && since < MAX_GAP_MS;

        // Legacy V1/V3 attest — only for mints that need it (active loan
        // or protected). Skip otherwise to save SOL on tx fees.
        if (needsLegacyAttest && !driftSkip) try {
          const result = await attestPrice(mint, decimals, priceSol);
          lastPrices.set(mint, priceLamports);
          lastAttestAt.set(mint, Date.now());
          console.log(`[PriceAttestor] ${mint.slice(0, 8)}... = ${result.priceSol.toFixed(9)} SOL (${priceLamports} lamports)`);
        } catch (attestErr) {
          // Feed PDA may not exist yet for newly-approved tokens —
          // auto-init it so the next tick succeeds. Drip-feed inits to
          // avoid hammering Helius.
          if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(attestErr.message)) {
            if (initsThisTick >= MAX_INITS_PER_TICK) {
              continue; // backfill the rest on subsequent ticks
            }
            const init = await initializePriceFeed(mint);
            if (init.alreadyExists) {
              throw attestErr; // not the issue we expected — rethrow
            }
            initsThisTick++;
            console.log(`[PriceAttestor] Auto-initialized feed for ${mint.slice(0, 8)}... (${initsThisTick}/${MAX_INITS_PER_TICK} this tick)`);
          } else {
            throw attestErr;
          }
        }

        // 2026-06-15: V4 pre-warm — runs for EVERY enabled mint (not
        // just active-loan ones). V4's price_feed PDA is distinct, V4
        // borrows hit a TWAP gate requiring 5 min of continuous price
        // history. Keeping every enabled mint's V4 feed fresh means
        // any V4 borrow can land instantly without a JIT warmup wait.
        //
        // Cost-aware: only writes when sample is > 60s old, mirroring
        // legacy MAX_GAP_MS. With ~50 enabled mints + 1 write/mint/min,
        // that's ~1.4 SOL/day at current priority fees — acceptable for
        // the UX win.
        try {
          const { PROGRAM_ID_V4 } = await import("../solana/program.js");
          if (PROGRAM_ID_V4) {
            const sinceV4 = Date.now() - (lastAttestAtV4.get(mint) || 0);
            if (sinceV4 >= MAX_GAP_MS_V4) {
              try {
                await attestPrice(mint, decimals, priceSol, PROGRAM_ID_V4);
                lastAttestAtV4.set(mint, Date.now());
              } catch (v4Err) {
                if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(v4Err.message || "")) {
                  if (initsThisTick < MAX_INITS_PER_TICK) {
                    await initializePriceFeed(mint, PROGRAM_ID_V4);
                    initsThisTick++;
                    console.log(`[PriceAttestor] Auto-initialized V4 feed for ${mint.slice(0, 8)}... (${initsThisTick}/${MAX_INITS_PER_TICK} this tick)`);
                  }
                } else {
                  console.warn(`[PriceAttestor] V4 attest failed for ${mint.slice(0, 8)}...: ${v4Err.message?.slice(0, 100)}`);
                }
              }
            }
          }
        } catch {
          // Swallow — V4 pre-warm is best-effort, never block the
          // primary V1/V3 attestation flow.
        }
      } catch (err) {
        console.error(`[PriceAttestor] Failed for ${mint.slice(0, 8)}...: ${err.message}`);
      }
    }
  }

  // Run immediately, then on interval
  tick();
  return setInterval(tick, intervalMs);
}
