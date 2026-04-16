/**
 * Backend configuration.
 *
 * The liquidation service signs on-chain instructions as the `lender` — i.e.
 * the same pubkey that initialized the lending pool. The keypair can be
 * provided either as a base58 secret key (LENDER_PRIVATE_KEY) or as a path
 * to a solana-cli keypair JSON (LENDER_KEYPAIR_PATH).
 */
import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required in .env`);
  return v;
}

export const config = {
  rpcEndpoint: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  network: process.env.SOLANA_NETWORK || "devnet",

  lenderPrivateKey: process.env.LENDER_PRIVATE_KEY, // base58 (optional)
  lenderKeypairPath: process.env.LENDER_KEYPAIR_PATH, // JSON path (optional)
  lenderWallet: new PublicKey(required("LENDER_PUBKEY")),

  programId: new PublicKey(required("PROGRAM_ID")),

  // Ratio of (current collateral value in lamports) / (original loan amount in
  // lamports) below which a loan becomes liquidatable for price drop. 1.1 = 10%
  // buffer above the outstanding loan.
  liquidationThreshold: parseFloat(process.env.LIQUIDATION_THRESHOLD) || 1.1,

  // How often (seconds) to poll all active loans.
  priceCheckInterval: parseInt(process.env.PRICE_CHECK_INTERVAL, 10) || 30,
};

if (!config.lenderPrivateKey && !config.lenderKeypairPath) {
  throw new Error("Either LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set");
}

console.log("✅ Backend config loaded");
console.log(`   Network:              ${config.network}`);
console.log(`   Program ID:           ${config.programId.toBase58()}`);
console.log(`   Lender:               ${config.lenderWallet.toBase58()}`);
console.log(`   Liquidation threshold: ${config.liquidationThreshold}x`);
console.log(`   Check interval:       ${config.priceCheckInterval}s`);
