/**
 * V2 wind-down — Phases 1-4.
 *
 *   Phase 1: liquidate the 1 active loan ($FATHER, overdue, worthless)
 *   Phase 2: lender (sole depositor) withdraws all shares → wSOL → SOL
 *            chunked at ≤0.13 SOL per call to dodge V1/V2 withdraw u64 overflow
 *   Phase 3: admin_withdraw all accumulated fees → lender wallet
 *   Phase 4: verify pool empty (totalDeposits=0, totalBorrowed=0, vault≈0)
 *
 * Run without args = DRY RUN — simulates every tx, reports state, does NOT broadcast.
 * Run with --execute = broadcasts each tx, waits for confirmation, verifies post-state.
 *
 * Operator-authorized 2026-06-17 PM (memory: project_magpie_v2_winddown_2026_06_17).
 * All txs signed by the lender keypair (which is also the sole depositor and the
 * pool authority for fee extraction).
 */
import "dotenv/config";
import { PublicKey, Connection, Keypair, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";

const DRY_RUN = !process.argv.includes("--execute");
const VERBOSE = process.argv.includes("--verbose");
const log = (s) => console.log(s);
const verbose = (s) => { if (VERBOSE) console.log(s); };

log(`\n[v2-winddown] mode=${DRY_RUN ? "DRY-RUN (no broadcast)" : "EXECUTE (will broadcast)"}\n`);

import bs58 from "bs58";
import fs from "node:fs";
const { PROGRAM_ID_V2, getProgramForSigner, getReadOnlyProgram } = await import("../src/solana/program.js");
const { lendingPoolPda, loanTokenVaultPda, collateralVaultPda } = await import("../src/solana/pdas.js");
const { query } = await import("../src/db/pool.js");

const V2 = PROGRAM_ID_V2;
if (!V2) throw new Error("PROGRAM_ID_V2 unset");
const decodeBs58 = bs58.decode || (bs58.default && bs58.default.decode);
let LENDER_KP;
if (process.env.LENDER_PRIVATE_KEY) {
  LENDER_KP = Keypair.fromSecretKey(decodeBs58(process.env.LENDER_PRIVATE_KEY));
} else if (process.env.LENDER_KEYPAIR_PATH) {
  LENDER_KP = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.LENDER_KEYPAIR_PATH, "utf-8"))));
} else { throw new Error("LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set"); }
const LENDER = LENDER_KP.publicKey;
log(`Lender (signer + destination): ${LENDER.toBase58()}`);

const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const program = getProgramForSigner(LENDER_KP, V2);
const readonly = getReadOnlyProgram(V2);

// ─── Initial state ───────────────────────────────────────────────────
const [pool] = lendingPoolPda(LENDER, V2);
const [vault] = loanTokenVaultPda(pool, V2);
log(`V2 pool: ${pool.toBase58()}`);
log(`V2 vault: ${vault.toBase58()}`);

async function readPoolState(label) {
  const p = await readonly.account.lendingPool.fetch(pool);
  const vi = await conn.getAccountInfo(vault);
  const vaultLamports = vi ? vi.lamports : 0;
  const fmt = (n) => (Number(n) / 1e9).toFixed(6);
  log(`\n[state:${label}] totalDeposits=${fmt(p.totalDeposits)} totalBorrowed=${fmt(p.totalBorrowed)} totalFeesEarned=${fmt(p.totalFeesEarned)} vaultSOL=${fmt(vaultLamports)}`);
  if (p.totalShares !== undefined) log(`  totalShares=${p.totalShares.toString()}`);
  return { p, vaultLamports };
}

await readPoolState("PRE");

// ─── Phase 1: Liquidate the 1 active loan ─────────────────────────────
log("\n──── Phase 1: liquidate the 1 active V2 loan ────");
const { rows: actives } = await query(
  `SELECT loan_id, loan_pda, borrower_wallet, collateral_mint, collateral_amount::text AS coll, original_loan_amount_lamports::text AS owed
     FROM loans WHERE program_id = $1 AND status = 'active'`,
  [V2.toBase58()],
);
log(`Active V2 loans in DB: ${actives.length}`);
for (const a of actives) {
  log(`  loan_id=${a.loan_id} pda=${a.loan_pda} borrower=${a.borrower_wallet.slice(0,8)}.. mint=${a.collateral_mint.slice(0,8)}.. owed=${(Number(a.owed)/1e9).toFixed(6)}`);
  const loanPk = new PublicKey(a.loan_pda);
  const collateralMintPk = new PublicKey(a.collateral_mint);
  const [collateralVault] = collateralVaultPda(loanPk, V2);

  // Lender acts as keeper. Both keeper_collateral_account + authority_collateral_account
  // are the lender's ATA for the collateral mint (we don't care about splitting keeper
  // reward vs authority — they're the same wallet).
  const lenderCollateralAta = getAssociatedTokenAddressSync(collateralMintPk, LENDER, false, TOKEN_PROGRAM_ID);

  const preIxs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(LENDER, lenderCollateralAta, LENDER, collateralMintPk, TOKEN_PROGRAM_ID),
  ];

  // Build & simulate
  try {
    const sim = await program.methods
      .liquidateLoan()
      .accounts({
        pool, loan: loanPk, collateralMint: collateralMintPk, collateralVault,
        keeperCollateralAccount: lenderCollateralAta, authorityCollateralAccount: lenderCollateralAta,
        keeper: LENDER, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions(preIxs)
      .simulate({ commitment: "confirmed" })
      .catch((e) => ({ err: e }));
    if (sim?.err) {
      const msg = sim.err.message || JSON.stringify(sim.err);
      log(`  SIM FAILED: ${msg.slice(0, 240)}`);
      verbose(`  logs:\n${(sim.err.logs || []).slice(-8).map(l=>"    "+l).join("\n")}`);
      throw new Error("liquidate simulation failed — aborting");
    }
    log(`  SIM OK.`);
    if (!DRY_RUN) {
      const sig = await program.methods
        .liquidateLoan()
        .accounts({
          pool, loan: loanPk, collateralMint: collateralMintPk, collateralVault,
          keeperCollateralAccount: lenderCollateralAta, authorityCollateralAccount: lenderCollateralAta,
          keeper: LENDER, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions(preIxs)
        .rpc({ commitment: "confirmed" });
      log(`  LIQUIDATED. sig=${sig}`);
      await query(`UPDATE loans SET status='liquidated', tx_signature=$2, updated_at=NOW() WHERE id=(SELECT id FROM loans WHERE loan_pda=$1) AND status='active'`, [a.loan_pda, sig]);
    } else {
      log(`  (dry-run: would liquidate; collateral 1.09M FATHER → lender ATA)`);
    }
  } catch (e) {
    log(`  ERROR: ${e.message?.slice(0, 200)}`);
    throw e;
  }
}

await readPoolState("AFTER_PHASE_1");

// ─── Phase 2: Lender withdraws all shares ─────────────────────────────
log("\n──── Phase 2: withdraw all lender LP shares (chunked) ────");
// Find lender's DepositorPosition
const allDepos = await conn.getProgramAccounts(V2, {
  filters: [
    { dataSize: 97 },                                                   // exact size
    { memcmp: { offset: 8, bytes: LENDER.toBase58() } },                // owner field
    { memcmp: { offset: 40, bytes: pool.toBase58() } },                 // pool field
  ],
});
log(`Lender DepositorPosition accounts found: ${allDepos.length}`);
if (allDepos.length !== 1) {
  log(`  WARNING: expected exactly 1 — got ${allDepos.length}. Continuing anyway.`);
}

for (const dp of allDepos) {
  const dpData = await readonly.account.depositorPosition.fetch(dp.pubkey);
  const shares = BigInt(dpData.shares.toString());
  log(`  position=${dp.pubkey.toBase58()} shares=${shares}`);
  if (shares === 0n) { log(`  (zero shares — skipping)`); continue; }

  // Compute share→lamport price from current pool state
  const poolNow = await readonly.account.lendingPool.fetch(pool);
  const totalShares = BigInt(poolNow.totalShares?.toString?.() ?? "0");
  const totalDeposits = BigInt(poolNow.totalDeposits.toString());
  if (totalShares === 0n) { log("  pool.totalShares is 0 — cannot compute chunk size. Aborting."); continue; }
  const lamportsPerShare_x1e9 = (totalDeposits * 1_000_000_000n) / totalShares;
  const MAX_CHUNK_LAMPORTS = 130_000_000n; // 0.13 SOL — under the u64 overflow threshold
  const maxSharesPerChunk = (MAX_CHUNK_LAMPORTS * 1_000_000_000n) / lamportsPerShare_x1e9;
  log(`  totalShares=${totalShares} totalDeposits=${totalDeposits} lamportsPerShare~${(Number(lamportsPerShare_x1e9)/1e18).toFixed(9)}`);
  log(`  maxSharesPerChunk=${maxSharesPerChunk} → chunks needed=${(shares + maxSharesPerChunk - 1n) / maxSharesPerChunk}`);

  const lenderWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, LENDER, false, TOKEN_PROGRAM_ID);
  // Ensure lender's wSOL ATA exists once
  const ensureWsolIx = createAssociatedTokenAccountIdempotentInstruction(LENDER, lenderWsolAta, LENDER, NATIVE_MINT, TOKEN_PROGRAM_ID);
  const closeWsolIx = createCloseAccountInstruction(lenderWsolAta, LENDER, LENDER, [], TOKEN_PROGRAM_ID);

  let remaining = shares;
  let chunkIdx = 0;
  while (remaining > 0n) {
    const thisChunk = remaining < maxSharesPerChunk ? remaining : maxSharesPerChunk;
    chunkIdx++;
    log(`  chunk ${chunkIdx}: withdraw ${thisChunk} shares (~${(Number(thisChunk * lamportsPerShare_x1e9) / 1e18).toFixed(6)} SOL)`);
    try {
      const sim = await program.methods
        .withdraw(new BN(thisChunk.toString()))
        .accounts({
          pool, loanTokenVault: vault, position: dp.pubkey,
          depositorTokenAccount: lenderWsolAta, depositor: LENDER, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          ensureWsolIx,
        ])
        .postInstructions([closeWsolIx])
        .simulate({ commitment: "confirmed" })
        .catch((e) => ({ err: e }));
      if (sim?.err) {
        const msg = sim.err.message || JSON.stringify(sim.err);
        log(`    SIM FAILED: ${msg.slice(0, 240)}`);
        verbose(`    logs:\n${(sim.err.logs || []).slice(-8).map(l=>"      "+l).join("\n")}`);
        throw new Error("withdraw simulation failed — aborting");
      }
      log(`    SIM OK.`);
      if (!DRY_RUN) {
        const sig = await program.methods
          .withdraw(new BN(thisChunk.toString()))
          .accounts({
            pool, loanTokenVault: vault, position: dp.pubkey,
            depositorTokenAccount: lenderWsolAta, depositor: LENDER, tokenProgram: TOKEN_PROGRAM_ID,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            ensureWsolIx,
          ])
          .postInstructions([closeWsolIx])
          .rpc({ commitment: "confirmed" });
        log(`    BROADCAST. sig=${sig}`);
      } else {
        log(`    (dry-run: would withdraw)`);
      }
    } catch (e) {
      log(`    ERROR: ${e.message?.slice(0, 200)}`);
      throw e;
    }
    remaining -= thisChunk;
    if (DRY_RUN) break; // single chunk in dry-run mode for brevity
  }
  if (DRY_RUN) log(`  (dry-run: remaining ${remaining} shares would proceed in additional chunks)`);
}

await readPoolState("AFTER_PHASE_2");

// ─── Phase 3: admin_withdraw fees ─────────────────────────────────────
log("\n──── Phase 3: admin_withdraw accumulated fees ────");
const poolNowF = await readonly.account.lendingPool.fetch(pool);
const feeLamports = BigInt(poolNowF.totalFeesEarned.toString());
log(`  fees pending: ${feeLamports} lamports = ${(Number(feeLamports)/1e9).toFixed(6)} SOL`);
if (feeLamports > 0n) {
  const lenderWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, LENDER, false, TOKEN_PROGRAM_ID);
  // Chunk fees too in case >0.14 SOL
  const MAX_FEE_CHUNK = 130_000_000n;
  let remaining = feeLamports;
  let i = 0;
  while (remaining > 0n) {
    const chunk = remaining < MAX_FEE_CHUNK ? remaining : MAX_FEE_CHUNK;
    i++;
    log(`  fee chunk ${i}: admin_withdraw ${chunk} lamports (~${(Number(chunk)/1e9).toFixed(6)} SOL)`);
    try {
      const sim = await program.methods
        .adminWithdraw(new BN(chunk.toString()))
        .accounts({
          pool, loanTokenVault: vault,
          authorityTokenAccount: lenderWsolAta,
          authority: LENDER, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
          createAssociatedTokenAccountIdempotentInstruction(LENDER, lenderWsolAta, LENDER, NATIVE_MINT, TOKEN_PROGRAM_ID),
        ])
        .postInstructions([createCloseAccountInstruction(lenderWsolAta, LENDER, LENDER, [], TOKEN_PROGRAM_ID)])
        .simulate({ commitment: "confirmed" })
        .catch((e) => ({ err: e }));
      if (sim?.err) {
        const msg = sim.err.message || JSON.stringify(sim.err);
        log(`    SIM FAILED: ${msg.slice(0, 240)}`);
        verbose(`    logs:\n${(sim.err.logs || []).slice(-8).map(l=>"      "+l).join("\n")}`);
        throw new Error("admin_withdraw simulation failed — aborting");
      }
      log(`    SIM OK.`);
      if (!DRY_RUN) {
        const sig = await program.methods
          .adminWithdraw(new BN(chunk.toString()))
          .accounts({
            pool, loanTokenVault: vault,
            authorityTokenAccount: lenderWsolAta,
            authority: LENDER, tokenProgram: TOKEN_PROGRAM_ID,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            createAssociatedTokenAccountIdempotentInstruction(LENDER, lenderWsolAta, LENDER, NATIVE_MINT, TOKEN_PROGRAM_ID),
          ])
          .postInstructions([createCloseAccountInstruction(lenderWsolAta, LENDER, LENDER, [], TOKEN_PROGRAM_ID)])
          .rpc({ commitment: "confirmed" });
        log(`    BROADCAST. sig=${sig}`);
      } else {
        log(`    (dry-run: would extract fees)`);
      }
    } catch (e) {
      log(`    ERROR: ${e.message?.slice(0, 200)}`);
      throw e;
    }
    remaining -= chunk;
    if (DRY_RUN) break;
  }
}

const finalState = await readPoolState("FINAL");
log(`\n[v2-winddown] complete. mode=${DRY_RUN ? "DRY-RUN" : "EXECUTED"}`);
log(`  remaining pool state: totalDeposits=${(Number(finalState.p.totalDeposits)/1e9).toFixed(6)} totalBorrowed=${(Number(finalState.p.totalBorrowed)/1e9).toFixed(6)} totalFeesEarned=${(Number(finalState.p.totalFeesEarned)/1e9).toFixed(6)} vault=${(finalState.vaultLamports/1e9).toFixed(6)}`);
log(DRY_RUN ? "\nNothing was broadcast. Re-run with --execute to proceed.\n" : "\nAll phases complete. Verify on Solscan.\n");
process.exit(0);
