import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadKeypair } from "../src/services/wallet.js";
import { executeBorrow } from "../src/services/loans.js";
import { query } from "../src/db/pool.js";

const WALLET = "88QXeYcETGUyAYkqE3ewyB1cauEXHY5XuXyh2EBvX6vM";
const BP_MINT = "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy";

const { rows } = await query(
  `SELECT user_id FROM wallets WHERE public_key = $1 AND is_active = TRUE`,
  [WALLET],
);
const userId = rows[0]?.user_id;
console.log("userId:", userId);

// Simulate by patching .rpc to .simulate
import * as anchor from "@coral-xyz/anchor";
const { PublicKey: PK } = await import("@solana/web3.js");

// Try the actual borrow (DON'T commit if it fails — just see what error surfaces)
// Use a tiny amount: 1 BP token = 1_000_000_000 raw with 9 decimals.
// $BP price = 0.006790656 SOL → 1 BP collateral value = ~6.79M lamports
try {
  const r = await executeBorrow({
    userId,
    collateralMint: BP_MINT,
    collateralAmountRaw: "1000000000", // 1 BP
    collateralValueLamports: "6790656", // matches latest attestation
    loanOption: 0, // first tier
    hasExitArming: true, // V4 path
  });
  console.log("BORROW SUCCEEDED:", JSON.stringify(r, null, 2));
  console.log("WARNING: this was a REAL borrow not a sim.");
} catch (err) {
  console.log("\n========== BORROW FAILED ==========\n");
  console.log("err.message:", err.message);
  console.log("\nerr.logs:");
  if (err.logs) console.log(err.logs.join("\n"));
  console.log("\nerr.stack:");
  console.log(err.stack);
}
process.exit(0);
