/**
 * Liquidation Scavenger — Permissionless Keeper Bot
 *
 * Monitors all active loans and automatically liquidates overdue ones,
 * earning a keeper bounty (keeper_reward_bps of seized collateral).
 *
 * Can be run as a standalone process or imported as a service:
 *   node src/services/keeper.js          # standalone
 *   import { startKeeper } from './keeper.js'  # service
 *
 * Env vars:
 *   KEEPER_KEYPAIR_PATH  — path to the keeper's Solana keypair JSON
 *   LENDER_PUBKEY        — pool authority pubkey
 *   SOLANA_RPC_URL       — RPC endpoint
 *   KEEPER_POLL_MS       — polling interval (default 30000)
 */

import {
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import "dotenv/config";
import { connection } from "../solana/connection.js";
import { getReadOnlyProgram, getProgramForSigner } from "../solana/program.js";
import { lendingPoolPda } from "../solana/pdas.js";
import { readFileSync } from "node:fs";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);
const POLL_MS = Number(process.env.KEEPER_POLL_MS) || 30_000;

/** Load the keeper's signing keypair */
function loadKeeperKeypair() {
  const kpPath = process.env.KEEPER_KEYPAIR_PATH || process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) throw new Error("KEEPER_KEYPAIR_PATH not set");
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(kpPath, "utf8"))),
  );
}

/**
 * Fetch all active loans from the program.
 * Uses getProgramAccounts with a memcmp filter on the status byte.
 */
async function fetchActiveLoans(program) {
  // Loan status is at a known offset in the account data.
  // Active = 0 (first variant of the enum).
  // We use the program's account decoder for cleaner access.
  const allLoans = await program.account.loan.all();
  return allLoans.filter(
    (l) => JSON.stringify(l.account.status) === JSON.stringify({ active: {} }),
  );
}

/**
 * Attempt to liquidate a single overdue loan.
 * Returns { success, txSig?, error? }
 */
async function liquidateLoan(program, keeper, loan, pool) {
  const loanPubkey = loan.publicKey;
  const loanData = loan.account;

  const [collateralVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral-vault"), loanPubkey.toBuffer()],
    program.programId,
  );

  // Detect whether collateral mint uses Token-2022 or classic Token program.
  const mintInfo = await connection.getAccountInfo(loanData.collateralMint);
  const collateralTokenProgram = mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  // Get or create the keeper's ATA for this collateral mint
  const keeperCollateralAta = await getOrCreateAssociatedTokenAccount(
    connection,
    keeper,
    loanData.collateralMint,
    keeper.publicKey,
    false,
    "confirmed",
    undefined,
    collateralTokenProgram,
  );

  // Get or create the authority's ATA for this collateral mint
  const authorityCollateralAta = await getOrCreateAssociatedTokenAccount(
    connection,
    keeper, // keeper pays for ATA creation if needed
    loanData.collateralMint,
    pool.authority,
    false,
    "confirmed",
    undefined,
    collateralTokenProgram,
  );

  const tx = await program.methods
    .liquidateLoan()
    .accounts({
      pool: loanData.pool,
      loan: loanPubkey,
      collateralMint: loanData.collateralMint,
      collateralVault: collateralVaultPda,
      keeperCollateralAccount: keeperCollateralAta.address,
      authorityCollateralAccount: authorityCollateralAta.address,
      keeper: keeper.publicKey,
      tokenProgram: collateralTokenProgram,
    })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ])
    .rpc({ commitment: "confirmed" });

  return { success: true, txSig: tx };
}

/**
 * Single scan: check all active loans and liquidate overdue ones.
 */
async function scanAndLiquidate(program, keeper, poolData) {
  const activeLoans = await fetchActiveLoans(program);
  const now = Math.floor(Date.now() / 1000);

  const overdueLoans = activeLoans.filter(
    (l) => now > l.account.dueTimestamp.toNumber(),
  );

  if (overdueLoans.length === 0) {
    return { scanned: activeLoans.length, liquidated: 0 };
  }

  console.log(
    `[keeper] Found ${overdueLoans.length} overdue loan(s) out of ${activeLoans.length} active`,
  );

  let liquidated = 0;
  for (const loan of overdueLoans) {
    const loanData = loan.account;
    const keeperReward = Math.floor(
      (loanData.collateralAmount.toNumber() * poolData.keeperRewardBps) / 10_000,
    );

    console.log(
      `[keeper] Liquidating loan ${loan.publicKey.toBase58().slice(0, 8)}... ` +
        `(collateral: ${loanData.collateralAmount.toNumber()}, ` +
        `reward: ${keeperReward}, ` +
        `borrower: ${loanData.borrower.toBase58().slice(0, 8)}...)`,
    );

    try {
      const result = await liquidateLoan(program, keeper, loan, poolData);
      console.log(`[keeper] Liquidated! tx: ${result.txSig}`);
      liquidated++;
    } catch (err) {
      console.error(
        `[keeper] Failed to liquidate ${loan.publicKey.toBase58().slice(0, 8)}: ${err.message}`,
      );
    }
  }

  return { scanned: activeLoans.length, liquidated };
}

/**
 * Start the keeper loop.
 */
export async function startKeeper() {
  const keeper = loadKeeperKeypair();
  const program = getProgramForSigner(keeper);
  const [poolPda] = lendingPoolPda(LENDER_PUBKEY);

  console.log("[keeper] Liquidation Scavenger starting...");
  console.log(`[keeper] Keeper wallet: ${keeper.publicKey.toBase58()}`);
  console.log(`[keeper] Pool: ${poolPda.toBase58()}`);
  console.log(`[keeper] Poll interval: ${POLL_MS}ms`);

  // Initial pool fetch
  const poolData = await program.account.lendingPool.fetch(poolPda);
  console.log(`[keeper] Keeper reward: ${poolData.keeperRewardBps} bps (${poolData.keeperRewardBps / 100}%)`);

  const tick = async () => {
    try {
      // Re-fetch pool each tick in case reward changed
      const currentPool = await program.account.lendingPool.fetch(poolPda);
      const result = await scanAndLiquidate(program, keeper, currentPool);

      if (result.liquidated > 0) {
        console.log(
          `[keeper] Scan complete: ${result.liquidated}/${result.scanned} loans liquidated`,
        );
      }
    } catch (err) {
      console.error(`[keeper] Scan error: ${err.message}`);
    }
  };

  // Run immediately, then on interval
  await tick();
  setInterval(tick, POLL_MS);
}

// Run standalone
if (process.argv[1]?.includes("keeper")) {
  startKeeper().catch((err) => {
    console.error("[keeper] Fatal:", err);
    process.exit(1);
  });
}
