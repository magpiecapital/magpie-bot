import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import "dotenv/config";
import { getPriceInSol, getPricesInSolBatch } from "./price.js";
import { getProgramForSigner } from "../solana/program.js";
import { connection } from "../solana/connection.js";
import { lendingPoolPda, priceFeedPda } from "../solana/pdas.js";
import { query } from "../db/pool.js";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);

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
  const kpPath = process.env.LENDER_KEYPAIR_PATH || path.resolve("lender-keypair.json");
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * Initialize a price feed PDA for a given mint. Idempotent — returns
 * { alreadyExists: true } if the PDA is already on chain.
 */
export async function initializePriceFeed(mintStr) {
  const lender = loadLenderKeypair();
  const program = getProgramForSigner(lender);
  const mintPk = new PublicKey(mintStr);
  const [pool] = lendingPoolPda(LENDER_PUBKEY);
  const [priceFeed] = priceFeedPda(mintPk, pool);

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
 */
export async function attestPrice(mintStr, decimals, priceSolOverride) {
  const lender = loadLenderKeypair();
  const program = getProgramForSigner(lender);
  const mintPk = new PublicKey(mintStr);
  const [pool] = lendingPoolPda(LENDER_PUBKEY);
  const [priceFeed] = priceFeedPda(mintPk, pool);

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
 * Mints we need to keep continuously fresh on-chain: those backing
 * any active loan (so the risk engine / health watcher / repay flow
 * can rely on a non-stale price). New /borrow calls do their own
 * just-in-time attestation before submitting the tx, so we don't
 * need to sweep every enabled mint here — only the ones with skin
 * in the game right now.
 */
async function fetchMintsToAttest() {
  const r = await query(
    `SELECT DISTINCT sm.mint, sm.decimals
       FROM supported_mints sm
       JOIN loans l ON l.collateral_mint = sm.mint
      WHERE sm.enabled = TRUE
        AND l.status = 'active'`,
  );
  return r.rows.map((row) => ({ mint: row.mint, decimals: row.decimals }));
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
  // Force a fresh on-chain attestation at least every MAX_GAP_MS so the
  // feed timestamp never crosses the contract's 120s staleness limit.
  const MAX_GAP_MS = 60_000;
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

    // Single batch Jupiter fetch for all enabled mints (1-2 calls instead of N).
    // On failure (rate limit, transient), skip the whole tick — next one retries.
    let priceMap;
    try {
      priceMap = await getPricesInSolBatch(tokens.map((t) => t.mint));
    } catch (err) {
      console.error(`[PriceAttestor] Batch price fetch failed (will retry next tick): ${err.message}`);
      return;
    }

    let initsThisTick = 0;
    for (const { mint, decimals } of tokens) {
      const priceSol = priceMap.get(mint);
      if (!priceSol) continue; // no Jupiter coverage — skip silently

      try {
        const priceLamports = Math.floor(priceSol * 1e9);
        const lastPrice = lastPrices.get(mint) || 0;
        const since = Date.now() - (lastAttestAt.get(mint) || 0);

        // Skip ONLY if drift is small AND we attested recently enough
        // to keep the on-chain feed fresh.
        const drift = lastPrice > 0 ? Math.abs(priceLamports - lastPrice) / lastPrice : 1;
        if (drift < 0.005 && lastPrice > 0 && since < MAX_GAP_MS) continue;

        try {
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
      } catch (err) {
        console.error(`[PriceAttestor] Failed for ${mint.slice(0, 8)}...: ${err.message}`);
      }
    }
  }

  // Run immediately, then on interval
  tick();
  return setInterval(tick, intervalMs);
}
