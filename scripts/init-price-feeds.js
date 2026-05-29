/**
 * One-shot: initialize price feed PDAs for a list of mints.
 *
 * The on-chain `request_and_fund_loan` instruction requires a PriceAttestation
 * PDA for each token used as collateral. This script creates that PDA
 * (one-time, ~0.001 SOL each) so the bot's price attestor can later update
 * prices on it.
 *
 * Usage:
 *   LENDER_KEYPAIR_PATH=lender-keypair-v2.json node scripts/init-price-feeds.js
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { initializePriceFeed } from "../src/services/price-attestor.js";
import "dotenv/config";

// Five popular memecoins to start — keep cost low while proving the flow.
// Add more later by editing this list and re-running (idempotent).
const TOKENS = [
  { symbol: "BONK",     mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { symbol: "WIF",      mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  { symbol: "FARTCOIN", mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump" },
  { symbol: "PENGU",    mint: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv" },
  { symbol: "POPCAT",   mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr" },
  { symbol: "CUM",      mint: "oqU4DdYCbdSf9j74vnEgvCn1YzNfYQEPWaC6pu6pump" },
];

async function main() {
  const conn = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
  const programId = new PublicKey(process.env.PROGRAM_ID || "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh");
  const lenderPubkey = new PublicKey(process.env.LENDER_PUBKEY || "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx");

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), lenderPubkey.toBuffer()],
    programId,
  );
  console.log("Program:", programId.toBase58());
  console.log("Pool:   ", pool.toBase58());
  console.log();

  for (const { symbol, mint } of TOKENS) {
    const mintPk = new PublicKey(mint);
    const [feed] = PublicKey.findProgramAddressSync(
      [Buffer.from("price"), mintPk.toBuffer(), pool.toBuffer()],
      programId,
    );
    const existing = await conn.getAccountInfo(feed);
    if (existing) {
      console.log(`✓ ${symbol.padEnd(10)} feed exists at ${feed.toBase58().slice(0, 12)}…`);
      continue;
    }
    try {
      const sig = await initializePriceFeed(mint);
      console.log(`✓ ${symbol.padEnd(10)} initialized: ${sig.slice(0, 16)}…`);
    } catch (err) {
      console.error(`✗ ${symbol.padEnd(10)} failed: ${err.message}`);
    }
  }

  const lender = new PublicKey(process.env.LENDER_PUBKEY || "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx");
  const bal = await conn.getBalance(lender);
  console.log();
  console.log(`Lender balance after: ${(bal / 1e9).toFixed(6)} SOL`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
