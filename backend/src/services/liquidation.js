/**
 * Liquidation service.
 *
 * Flow per flagged loan:
 *   1. Read the loan account to discover the collateral mint + token program.
 *   2. Ensure the lender has an ATA for that mint (idempotent create).
 *   3. Call `liquidate_loan` on the program — collateral is transferred to the
 *      lender's ATA, the loan is marked Liquidated, the pool's counter bumps.
 *   4. Swap the received collateral → SOL via Jupiter (auto-unwraps wSOL).
 */
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { lendingPoolPda, collateralVaultPda } from "../utils/anchor-client.js";
import { swapTokenToSol } from "../utils/jupiter-swap.js";

async function getMintTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export class LiquidationService {
  constructor(program, connection, lenderKeypair) {
    this.program = program;
    this.connection = connection;
    this.lenderKeypair = lenderKeypair;
  }

  async liquidateLoan(flaggedLoan) {
    console.log(`\n💰 Liquidating loan#${flaggedLoan.loanId} (${flaggedLoan.reason})`);

    const loanPda = new PublicKey(flaggedLoan.loanAddress);
    const loan = await this.program.account.loan.fetch(loanPda);
    const collateralMint = loan.collateralMint;

    const tokenProgram = await getMintTokenProgram(this.connection, collateralMint);
    const lenderAta = getAssociatedTokenAddressSync(
      collateralMint,
      this.lenderKeypair.publicKey,
      false,
      tokenProgram,
    );

    // Ensure the lender's ATA exists — the program's liquidate_loan expects it
    // as a pre-existing account.
    const ataInfo = await this.connection.getAccountInfo(lenderAta);
    if (!ataInfo) {
      console.log(`   Creating lender ATA ${lenderAta.toBase58()}`);
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
        createAssociatedTokenAccountIdempotentInstruction(
          this.lenderKeypair.publicKey,
          lenderAta,
          this.lenderKeypair.publicKey,
          collateralMint,
          tokenProgram,
        ),
      );
      await sendAndConfirmTransaction(this.connection, tx, [this.lenderKeypair]);
    }

    const pool = lendingPoolPda(this.program.programId);
    const vault = collateralVaultPda(this.program.programId, loanPda);

    try {
      const sig = await this.program.methods
        .liquidateLoan()
        .accounts({
          loan: loanPda,
          collateralVault: vault,
          lendingPool: pool,
          collateralMint,
          lenderCollateralAccount: lenderAta,
          lender: this.lenderKeypair.publicKey,
          collateralTokenProgram: tokenProgram,
        })
        .rpc({ commitment: "confirmed" });

      console.log(`✅ Liquidation tx: ${sig}`);

      // Swap the collateral we just received → SOL.
      const rawAmount = loan.collateralAmount.toString();
      const swap = await swapTokenToSol(
        this.connection,
        this.lenderKeypair,
        collateralMint,
        rawAmount,
      );

      return { success: true, liquidationTx: sig, swap };
    } catch (err) {
      console.error(`❌ Liquidation failed:`, err.message);
      if (err.logs) console.error("   logs:", err.logs);
      return { success: false, error: err.message };
    }
  }

  async getStats() {
    const pool = lendingPoolPda(this.program.programId);
    try {
      const data = await this.program.account.lendingPool.fetch(pool);
      return {
        totalLoansIssued: data.totalLoansIssued.toString(),
        totalLiquidations: data.totalLiquidations.toString(),
      };
    } catch {
      return null;
    }
  }
}
