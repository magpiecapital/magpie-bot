import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import "dotenv/config";
import { getPriceInSol } from "./price.js";
import { getProgramForSigner } from "../solana/program.js";
import { lendingPoolPda, priceFeedPda } from "../solana/pdas.js";

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
 * Initialize a price feed PDA for a given mint.
 * Call once per token you want to support for lending.
 */
export async function initializePriceFeed(mintStr) {
  const lender = loadLenderKeypair();
  const program = getProgramForSigner(lender);
  const mintPk = new PublicKey(mintStr);
  const [pool] = lendingPoolPda(LENDER_PUBKEY);
  const [priceFeed] = priceFeedPda(mintPk, pool);

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
 * Fetches current price from Jupiter, writes to the PDA.
 */
export async function attestPrice(mintStr, decimals) {
  const lender = loadLenderKeypair();
  const program = getProgramForSigner(lender);
  const mintPk = new PublicKey(mintStr);
  const [pool] = lendingPoolPda(LENDER_PUBKEY);
  const [priceFeed] = priceFeedPda(mintPk, pool);

  // Get price from Jupiter (price = SOL per 1 token)
  const priceSol = await getPriceInSol(mintStr);
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
 * Start a periodic price attestor loop for a list of mints.
 * Updates prices on-chain every `intervalMs` milliseconds.
 *
 * @param {Array<{mint: string, decimals: number}>} tokens
 * @param {number} intervalMs - default 30 seconds
 */
export function startPriceAttestor(tokens, intervalMs = 30_000) {
  console.log(`[PriceAttestor] Starting for ${tokens.length} tokens, interval=${intervalMs}ms`);

  const lastPrices = new Map();
  const lastAttestAt = new Map();
  // Force a fresh on-chain attestation at least every MAX_GAP_MS so the
  // feed timestamp never crosses the contract's 120s staleness limit.
  const MAX_GAP_MS = 60_000;

  async function tick() {
    for (const { mint, decimals } of tokens) {
      try {
        const priceSol = await getPriceInSol(mint);
        const priceLamports = Math.floor(priceSol * 1e9);
        const lastPrice = lastPrices.get(mint) || 0;
        const since = Date.now() - (lastAttestAt.get(mint) || 0);

        // Skip ONLY if drift is small AND we attested recently enough
        // to keep the on-chain feed fresh.
        const drift = lastPrice > 0 ? Math.abs(priceLamports - lastPrice) / lastPrice : 1;
        if (drift < 0.005 && lastPrice > 0 && since < MAX_GAP_MS) continue;

        const result = await attestPrice(mint, decimals);
        lastPrices.set(mint, priceLamports);
        lastAttestAt.set(mint, Date.now());
        console.log(`[PriceAttestor] ${mint.slice(0, 8)}... = ${result.priceSol.toFixed(9)} SOL (${priceLamports} lamports)`);
      } catch (err) {
        console.error(`[PriceAttestor] Failed for ${mint.slice(0, 8)}...: ${err.message}`);
      }
    }
  }

  // Run immediately, then on interval
  tick();
  return setInterval(tick, intervalMs);
}
