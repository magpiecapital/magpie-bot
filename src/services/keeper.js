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
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import "dotenv/config";
import { connection } from "../solana/connection.js";
import {
  getReadOnlyProgram,
  getProgramForSigner,
  PROGRAM_ID,
  PROGRAM_ID_V2,
  PROGRAM_ID_V3,
  PROGRAM_ID_V4,
} from "../solana/program.js";
import { lendingPoolPda } from "../solana/pdas.js";
import { readFileSync } from "node:fs";
import bs58 from "bs58";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);
const POLL_MS = Number(process.env.KEEPER_POLL_MS) || 30_000;

/**
 * Load the keeper's signing keypair.
 *
 * Resolution order (first match wins):
 *   1. KEEPER_PRIVATE_KEY      — base58 secret key, env-var-only.
 *                                Preferred for Railway/container deploys
 *                                where you don't want a keypair file
 *                                living in the image.
 *   2. KEEPER_KEYPAIR_PATH     — JSON keypair file path.
 *
 * NOTE 2026-06-12 (security audit F-6): the legacy LENDER_KEYPAIR_PATH
 * fallback that used to live here was REMOVED. The keeper sharing the
 * lender's keypair is a least-privilege violation — the keeper only
 * needs to sign liquidations, but the lender keypair also gates
 * admin_withdraw, set_paused, set_keeper_reward, and price attestation.
 *
 * If neither KEEPER_PRIVATE_KEY nor KEEPER_KEYPAIR_PATH is set the
 * keeper now THROWS at startup. This is intentional — fail loud, not
 * silently falling back to a more powerful key. Operators running the
 * keeper must provision a dedicated keeper key (see runbook docs).
 *
 * The fallback escape hatch is gone on purpose; if you genuinely need to
 * temporarily run the keeper with the lender key, set KEEPER_PRIVATE_KEY
 * to the lender's base58 secret explicitly so the configuration is
 * VISIBLE in env, not implicit through a path-fallback.
 */
function loadKeeperKeypair() {
  const b58 = process.env.KEEPER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const kpPath = process.env.KEEPER_KEYPAIR_PATH;
  if (!kpPath) {
    throw new Error(
      "[keeper] KEEPER_PRIVATE_KEY or KEEPER_KEYPAIR_PATH must be set — refusing to fall back to LENDER_KEYPAIR_PATH (least-privilege rule, audit F-6 2026-06-12). Set KEEPER_PRIVATE_KEY (preferred) or KEEPER_KEYPAIR_PATH explicitly.",
    );
  }
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

  // V4-aware liquidation (2026-06-15): V4's liquidate_loan needs 4
  // extra accounts to distribute the mixed collateral (SPL + accumulated
  // SOL in sol_proceeds_vault). Without these, every V4 overdue loan
  // fails with AccountNotEnoughKeys and stays uncollected.
  const isV4 = PROGRAM_ID_V4 && program.programId.equals(PROGRAM_ID_V4);
  let v4ExtraAccounts = {};
  let preIxs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
  ];
  if (isV4) {
    const { NATIVE_MINT } = await import("@solana/spl-token");
    const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } =
      await import("@solana/spl-token");
    const [solProceedsVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol-proceeds"), loanPubkey.toBuffer()],
      program.programId,
    );
    // wSOL ATAs for keeper + authority. SOL pot bounty goes to keeper,
    // residual to authority.
    const keeperWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT, keeper.publicKey, false, TOKEN_PROGRAM_ID,
    );
    const authorityWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT, pool.authority, false, TOKEN_PROGRAM_ID,
    );
    // V4 Wave 5 C1 (2026-06-15): liquidate_loan now also needs
    // wsol_mint + system_program + rent because sol_proceeds_vault
    // is `init_if_needed` (so V4 loans whose auto-sell never fired
    // can still be liquidated — Anchor needs system_program to
    // allocate, rent to size it).
    v4ExtraAccounts = {
      solProceedsVault: solProceedsVaultPda,
      keeperLoanTokenAccount: keeperWsolAta,
      authorityLoanTokenAccount: authorityWsolAta,
      loanTokenProgram: TOKEN_PROGRAM_ID,
      wsolMint: NATIVE_MINT,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    };
    // Create the wSOL ATAs idempotently — keeper pays.
    preIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        keeper.publicKey, keeperWsolAta, keeper.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        keeper.publicKey, authorityWsolAta, pool.authority, NATIVE_MINT, TOKEN_PROGRAM_ID,
      ),
    );
  }

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
      ...v4ExtraAccounts,
    })
    .preInstructions(preIxs)
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

  // ── Multi-program scan (2026-06-13) ────────────────────────────
  // Original keeper instantiated ONE program object via
  // getProgramForSigner(keeper) which defaults to V1. Result: V2
  // (RWA pool) past-due loans were never liquidated. The 2026-06-13
  // V1/V2 audit found loan #325 stuck at 95h past due because of this.
  //
  // We now build one (program, pool) pair per configured lending program
  // and tick across all of them in parallel. Each tick re-fetches the
  // pool to pick up reward / pause / config changes. V2 is included if
  // PROGRAM_ID_V2 is configured; absent V2 the keeper still works on
  // V1-only deploys (local dev, fresh staging).
  const programConfigs = [
    {
      label: "V1 (memecoin)",
      programId: PROGRAM_ID,
      program: getProgramForSigner(keeper, PROGRAM_ID),
    },
  ];
  if (PROGRAM_ID_V2) {
    programConfigs.push({
      label: "V2 (RWA)",
      programId: PROGRAM_ID_V2,
      program: getProgramForSigner(keeper, PROGRAM_ID_V2),
    });
  }
  if (PROGRAM_ID_V3) {
    programConfigs.push({
      label: "V3",
      programId: PROGRAM_ID_V3,
      program: getProgramForSigner(keeper, PROGRAM_ID_V3),
    });
  }
  if (PROGRAM_ID_V4) {
    programConfigs.push({
      label: "V4",
      programId: PROGRAM_ID_V4,
      program: getProgramForSigner(keeper, PROGRAM_ID_V4),
    });
  }

  console.log("[keeper] Liquidation Scavenger starting...");
  console.log(`[keeper] Keeper wallet: ${keeper.publicKey.toBase58()}`);
  for (const cfg of programConfigs) {
    const [poolPda] = lendingPoolPda(LENDER_PUBKEY, cfg.programId);
    cfg.poolPda = poolPda;
    console.log(`[keeper] ${cfg.label} pool: ${poolPda.toBase58()}`);
  }
  console.log(`[keeper] Poll interval: ${POLL_MS}ms`);

  // Initial pool fetch per program — surfaces V2 misconfiguration at
  // boot rather than at first liquidation attempt.
  for (const cfg of programConfigs) {
    try {
      const poolData = await cfg.program.account.lendingPool.fetch(cfg.poolPda);
      console.log(`[keeper] ${cfg.label} keeper reward: ${poolData.keeperRewardBps} bps (${poolData.keeperRewardBps / 100}%)`);
    } catch (err) {
      // Don't crash the keeper if V2 pool isn't initialized yet — log
      // and mark the program disabled for this run. The next restart
      // after the pool is initialized picks it up.
      console.warn(`[keeper] ${cfg.label} pool fetch failed: ${err.message?.slice(0, 100)} — skipping this program for the duration of this process`);
      cfg.disabled = true;
    }
  }

  const tick = async () => {
    // Run all enabled program scans in parallel — they're independent
    // and a slow V2 RPC fetch shouldn't gate V1 liquidations.
    await Promise.all(programConfigs.map(async (cfg) => {
      if (cfg.disabled) return;
      try {
        const currentPool = await cfg.program.account.lendingPool.fetch(cfg.poolPda);
        const result = await scanAndLiquidate(cfg.program, keeper, currentPool);
        if (result.liquidated > 0) {
          console.log(
            `[keeper] ${cfg.label} scan: ${result.liquidated}/${result.scanned} loans liquidated`,
          );
        }
      } catch (err) {
        console.error(`[keeper] ${cfg.label} scan error: ${err.message}`);
      }
    }));
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
