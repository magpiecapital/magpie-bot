import "dotenv/config";
import { PublicKey, Connection } from "@solana/web3.js";
const { query } = await import("../src/db/pool.js");

const V2 = new PublicKey(process.env.PROGRAM_ID_V2);
const LENDER = new PublicKey(process.env.LENDER_PUBKEY);
const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

// Derive V2 pool PDA + read its state
const { lendingPoolPda, loanTokenVaultPda } = await import("../src/solana/pdas.js");
const { getReadOnlyProgram } = await import("../src/solana/program.js");

const [pool] = lendingPoolPda(LENDER, V2);
const [vault] = loanTokenVaultPda(pool, V2);
console.log("V2 pool PDA:", pool.toBase58());
console.log("V2 loan_token_vault PDA:", vault.toBase58());

const program = getReadOnlyProgram(V2);
const poolData = await program.account.lendingPool.fetch(pool).catch(e => ({ _err: e.message }));
console.log("\nV2 pool on-chain state:");
if (poolData._err) console.log("  ERR:", poolData._err.slice(0, 200));
else {
  console.log("  totalDeposits:", (Number(poolData.totalDeposits) / 1e9).toFixed(6), "SOL");
  console.log("  totalBorrowed:", (Number(poolData.totalBorrowed) / 1e9).toFixed(6), "SOL");
  console.log("  totalFeesEarned:", (Number(poolData.totalFeesEarned) / 1e9).toFixed(6), "SOL");
  console.log("  paused:", poolData.paused);
  console.log("  share supply:", poolData.shareSupply?.toString?.() || "n/a");
}

// Read vault SOL balance
const vaultInfo = await conn.getAccountInfo(vault);
console.log("\nV2 vault account SOL:", vaultInfo ? (vaultInfo.lamports / 1e9).toFixed(6) : "MISSING");

// Get LP positions count via getProgramAccounts (DepositorPosition discriminator)
const positions = await conn.getProgramAccounts(V2, {
  filters: [{ dataSize: 137 }], // typical anchor DepositorPosition size — adjust if needed
}).catch(e => ({ _err: e.message }));
if (positions._err) console.log("\nV2 program accounts probe failed:", positions._err.slice(0, 200));
else console.log("\nV2 candidate DepositorPosition accounts:", positions.length);

// Lookup the active loan's mint symbol + current price
const { rows: [active] } = await query(
  `SELECT l.collateral_mint, l.collateral_amount::text AS coll, l.borrower_wallet, sm.symbol, sm.decimals, sm.enabled
     FROM loans l LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
    WHERE l.program_id = $1 AND l.status = 'active'`,
  [process.env.PROGRAM_ID_V2],
);
if (active) {
  console.log("\nV2 single active loan:");
  console.log("  symbol:", active.symbol || "(unknown)");
  console.log("  mint:", active.collateral_mint);
  console.log("  collateral amount raw:", active.coll, "decimals:", active.decimals);
  console.log("  borrower:", active.borrower_wallet);
  console.log("  enabled:", active.enabled);
}
process.exit(0);
