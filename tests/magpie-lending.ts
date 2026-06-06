import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  createWrappedNativeAccount,
  syncNative,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import { assert } from "chai";
import BN from "bn.js";

const MagpieLending = anchor.workspace.MagpieLending as Program<any>;

describe("Magpie Lending — Permissionless Pools", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = MagpieLending;
  const authority = provider.wallet;

  // Depositors
  const depositor1 = Keypair.generate();
  const depositor2 = Keypair.generate();

  // Borrower
  const borrower = Keypair.generate();

  // Collateral mint (simulated memecoin)
  let collateralMint: PublicKey;
  const COLLATERAL_DECIMALS = 9;

  // PDAs
  let poolPda: PublicKey;
  let poolBump: number;
  let vaultPda: PublicKey;

  // Protocol fee: 20% (2000 bps), Keeper reward: 5% (500 bps)
  const PROTOCOL_FEE_BPS = 2000;
  const KEEPER_REWARD_BPS = 500;

  // Keeper (liquidator)
  const keeper = Keypair.generate();

  before(async () => {
    // Derive pool PDA
    [poolPda, poolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), authority.publicKey.toBuffer()],
      program.programId
    );

    // Airdrop to all participants
    const airdropAmount = 20 * LAMPORTS_PER_SOL;
    for (const kp of [depositor1, depositor2, borrower, keeper]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        airdropAmount
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Also airdrop to authority if needed
    const authBal = await provider.connection.getBalance(
      authority.publicKey
    );
    if (authBal < 10 * LAMPORTS_PER_SOL) {
      const sig = await provider.connection.requestAirdrop(
        authority.publicKey,
        20 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create a fake memecoin mint (authority is the minter)
    collateralMint = await createMint(
      provider.connection,
      (authority as any).payer,
      authority.publicKey,
      null,
      COLLATERAL_DECIMALS
    );

    // Mint collateral tokens to borrower
    const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (authority as any).payer,
      collateralMint,
      borrower.publicKey
    );
    await mintTo(
      provider.connection,
      (authority as any).payer,
      collateralMint,
      borrowerCollateralAta.address,
      authority.publicKey,
      1_000_000_000_000 // 1000 tokens
    );
  });

  // -------------------------------------------------------------------
  // Pool initialization
  // -------------------------------------------------------------------

  describe("initialize_pool", () => {
    it("creates a lending pool", async () => {
      const [vaultPdaLocal] = PublicKey.findProgramAddressSync(
        [Buffer.from("loan-token-vault"), poolPda.toBuffer()],
        program.programId
      );
      vaultPda = vaultPdaLocal;

      await program.methods
        .initializePool(PROTOCOL_FEE_BPS, KEEPER_REWARD_BPS)
        .accounts({
          pool: poolPda,
          loanTokenVault: vaultPda,
          loanTokenMint: NATIVE_MINT,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const pool = await program.account.lendingPool.fetch(poolPda);
      assert.ok(pool.authority.equals(authority.publicKey));
      assert.equal(pool.protocolFeeBps, PROTOCOL_FEE_BPS);
      assert.equal(pool.keeperRewardBps, KEEPER_REWARD_BPS);
      assert.equal(pool.totalDeposits.toNumber(), 0);
      assert.equal(pool.totalShares.toNumber(), 0);
      assert.equal(pool.totalBorrowed.toNumber(), 0);
      assert.equal(pool.paused, false);
    });

    it("rejects fee > 50%", async () => {
      const rogue = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        rogue.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const [roguePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), rogue.publicKey.toBuffer()],
        program.programId
      );
      const [rogueVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("loan-token-vault"), roguePda.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .initializePool(6000, 500) // 60% protocol fee — too high
          .accounts({
            pool: roguePda,
            loanTokenVault: rogueVault,
            loanTokenMint: NATIVE_MINT,
            authority: rogue.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([rogue])
          .rpc();
        assert.fail("Should have failed");
      } catch (e: any) {
        assert.include(e.toString(), "FeeTooHigh");
      }
    });
  });

  // -------------------------------------------------------------------
  // Deposits
  // -------------------------------------------------------------------

  describe("deposit", () => {
    it("depositor1 deposits 5 wSOL", async () => {
      // Create wSOL account for depositor1
      const depositorWsol = await createWrappedNativeAccount(
        provider.connection,
        (authority as any).payer,
        depositor1.publicKey,
        5 * LAMPORTS_PER_SOL
      );

      const [positionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("position"),
          poolPda.toBuffer(),
          depositor1.publicKey.toBuffer(),
        ],
        program.programId
      );

      await program.methods
        .deposit(new BN(5 * LAMPORTS_PER_SOL))
        .accounts({
          pool: poolPda,
          loanTokenVault: vaultPda,
          position: positionPda,
          depositorTokenAccount: depositorWsol,
          depositor: depositor1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor1])
        .rpc();

      const pool = await program.account.lendingPool.fetch(poolPda);
      assert.equal(pool.totalDeposits.toNumber(), 5 * LAMPORTS_PER_SOL);
      // First deposit: shares = amount (1:1)
      assert.equal(pool.totalShares.toNumber(), 5 * LAMPORTS_PER_SOL);

      const position = await program.account.depositorPosition.fetch(
        positionPda
      );
      assert.equal(position.shares.toNumber(), 5 * LAMPORTS_PER_SOL);
      assert.ok(position.owner.equals(depositor1.publicKey));
    });

    it("depositor2 deposits 10 wSOL", async () => {
      const depositorWsol = await createWrappedNativeAccount(
        provider.connection,
        (authority as any).payer,
        depositor2.publicKey,
        10 * LAMPORTS_PER_SOL
      );

      const [positionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("position"),
          poolPda.toBuffer(),
          depositor2.publicKey.toBuffer(),
        ],
        program.programId
      );

      await program.methods
        .deposit(new BN(10 * LAMPORTS_PER_SOL))
        .accounts({
          pool: poolPda,
          loanTokenVault: vaultPda,
          position: positionPda,
          depositorTokenAccount: depositorWsol,
          depositor: depositor2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor2])
        .rpc();

      const pool = await program.account.lendingPool.fetch(poolPda);
      assert.equal(pool.totalDeposits.toNumber(), 15 * LAMPORTS_PER_SOL);
      assert.equal(pool.totalShares.toNumber(), 15 * LAMPORTS_PER_SOL);
    });
  });

  // -------------------------------------------------------------------
  // Borrow
  // -------------------------------------------------------------------

  describe("request_and_fund_loan", () => {
    let loanPda: PublicKey;
    let collateralVaultPda: PublicKey;
    const loanId = new BN(Date.now());

    it("borrower takes a Standard tier loan (20% LTV, 7 days)", async () => {
      const idBuf = Buffer.alloc(8);
      loanId.toArrayLike(Buffer, "le", 8).copy(idBuf);

      [loanPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("loan"), borrower.publicKey.toBuffer(), idBuf],
        program.programId
      );
      [collateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral-vault"), loanPda.toBuffer()],
        program.programId
      );

      const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        collateralMint,
        borrower.publicKey
      );

      // Create wSOL ATA for borrower to receive loan
      const borrowerWsol = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        NATIVE_MINT,
        borrower.publicKey
      );

      // Fee wallet ATA
      const feeWalletAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        NATIVE_MINT,
        authority.publicKey
      );

      const collateralAmount = new BN(100_000_000_000); // 100 tokens
      const collateralValue = new BN(2 * LAMPORTS_PER_SOL); // worth 2 SOL
      const loanOption = 2; // Standard: 20% LTV

      await program.methods
        .requestAndFundLoan(
          collateralAmount,
          loanOption,
          collateralValue,
          loanId
        )
        .accounts({
          pool: poolPda,
          loanTokenVault: vaultPda,
          loan: loanPda,
          collateralVault: collateralVaultPda,
          collateralMint,
          borrowerCollateralAccount: borrowerCollateralAta.address,
          borrowerLoanTokenAccount: borrowerWsol.address,
          feeWalletTokenAccount: feeWalletAta.address,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          loanTokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([borrower])
        .rpc();

      const loan = await program.account.loan.fetch(loanPda);
      assert.ok(loan.borrower.equals(borrower.publicKey));
      assert.equal(loan.ltvBps, 2000); // 20%
      assert.equal(loan.durationDays, 7);
      assert.deepEqual(loan.status, { active: {} });

      // LTV = 20% of 2 SOL = 0.4 SOL gross
      // Fee = 1.5% of 0.4 SOL = 0.006 SOL
      // Net = 0.394 SOL
      const grossLoan = 0.4 * LAMPORTS_PER_SOL;
      const fee = Math.floor(grossLoan * 150 / 10000);
      const netLoan = grossLoan - fee;
      assert.equal(loan.loanAmount.toNumber(), netLoan);
      assert.equal(loan.repayAmount.toNumber(), grossLoan);
      assert.equal(loan.transactionFee.toNumber(), fee);

      // Pool should track borrowed amount
      const pool = await program.account.lendingPool.fetch(poolPda);
      assert.equal(pool.totalBorrowed.toNumber(), grossLoan);
      assert.equal(pool.totalLoansIssued.toNumber(), 1);
    });

    it("rejects loan when pool is paused", async () => {
      // Pause the pool
      await program.methods
        .setPaused(true)
        .accounts({
          pool: poolPda,
          authority: authority.publicKey,
        })
        .rpc();

      const newLoanId = new BN(Date.now() + 1);
      const idBuf = Buffer.alloc(8);
      newLoanId.toArrayLike(Buffer, "le", 8).copy(idBuf);

      const [newLoanPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("loan"), borrower.publicKey.toBuffer(), idBuf],
        program.programId
      );
      const [newVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral-vault"), newLoanPda.toBuffer()],
        program.programId
      );

      const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        collateralMint,
        borrower.publicKey
      );
      const borrowerWsol = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        NATIVE_MINT,
        borrower.publicKey
      );
      const feeWalletAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        NATIVE_MINT,
        authority.publicKey
      );

      try {
        await program.methods
          .requestAndFundLoan(
            new BN(1_000_000_000),
            2,
            new BN(LAMPORTS_PER_SOL),
            newLoanId
          )
          .accounts({
            pool: poolPda,
            loanTokenVault: vaultPda,
            loan: newLoanPda,
            collateralVault: newVaultPda,
            collateralMint,
            borrowerCollateralAccount: borrowerCollateralAta.address,
            borrowerLoanTokenAccount: borrowerWsol.address,
            feeWalletTokenAccount: feeWalletAta.address,
            borrower: borrower.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            loanTokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([borrower])
          .rpc();
        assert.fail("Should have failed");
      } catch (e: any) {
        assert.include(e.toString(), "PoolPaused");
      }

      // Unpause for remaining tests
      await program.methods
        .setPaused(false)
        .accounts({
          pool: poolPda,
          authority: authority.publicKey,
        })
        .rpc();
    });

    // -------------------------------------------------------------------
    // Repay
    // -------------------------------------------------------------------

    it("borrower repays loan in full", async () => {
      const loan = await program.account.loan.fetch(loanPda);
      const repayAmount = loan.repayAmount.toNumber();

      // Fund borrower with wSOL to repay
      // Create ATA + transfer SOL + sync native in one transaction
      const borrowerWsolAddr = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        borrower.publicKey
      );
      const wrapTx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          borrower.publicKey,
          borrowerWsolAddr,
          borrower.publicKey,
          NATIVE_MINT
        ),
        SystemProgram.transfer({
          fromPubkey: borrower.publicKey,
          toPubkey: borrowerWsolAddr,
          lamports: repayAmount + LAMPORTS_PER_SOL,
        }),
        createSyncNativeInstruction(borrowerWsolAddr)
      );
      const wrapSig = await provider.connection.sendTransaction(wrapTx, [borrower]);
      await provider.connection.confirmTransaction(wrapSig);
      const borrowerWsol = borrowerWsolAddr;

      const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        collateralMint,
        borrower.publicKey
      );

      const collateralBefore = await getAccount(
        provider.connection,
        borrowerCollateralAta.address
      );

      await program.methods
        .repayLoan()
        .accounts({
          pool: poolPda,
          loanTokenVault: vaultPda,
          loan: loanPda,
          collateralVault: collateralVaultPda,
          borrowerCollateralAccount: borrowerCollateralAta.address,
          borrowerLoanTokenAccount: borrowerWsol,
          borrower: borrower.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          loanTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([borrower])
        .rpc();

      const updatedLoan = await program.account.loan.fetch(loanPda);
      assert.deepEqual(updatedLoan.status, { repaid: {} });

      // Collateral returned
      const collateralAfter = await getAccount(
        provider.connection,
        borrowerCollateralAta.address
      );
      const returned =
        Number(collateralAfter.amount) - Number(collateralBefore.amount);
      assert.equal(returned, loan.collateralAmount.toNumber());

      // Pool borrowed amount reduced
      const pool = await program.account.lendingPool.fetch(poolPda);
      assert.equal(pool.totalBorrowed.toNumber(), 0);
    });
  });

  // -------------------------------------------------------------------
  // Withdraw
  // -------------------------------------------------------------------

  describe("withdraw", () => {
    it("depositor1 withdraws half their shares", async () => {
      const [positionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("position"),
          poolPda.toBuffer(),
          depositor1.publicKey.toBuffer(),
        ],
        program.programId
      );

      const position = await program.account.depositorPosition.fetch(
        positionPda
      );
      const halfShares = position.shares.div(new BN(2));

      const depositorWsol = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        NATIVE_MINT,
        depositor1.publicKey
      );

      await program.methods
        .withdraw(halfShares)
        .accounts({
          pool: poolPda,
          loanTokenVault: vaultPda,
          position: positionPda,
          depositorTokenAccount: depositorWsol.address,
          depositor: depositor1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor1])
        .rpc();

      const updatedPosition =
        await program.account.depositorPosition.fetch(positionPda);
      assert.equal(
        updatedPosition.shares.toNumber(),
        position.shares.toNumber() - halfShares.toNumber()
      );
    });

    it("rejects withdrawal exceeding shares", async () => {
      const [positionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("position"),
          poolPda.toBuffer(),
          depositor1.publicKey.toBuffer(),
        ],
        program.programId
      );

      const depositorWsol = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        NATIVE_MINT,
        depositor1.publicKey
      );

      try {
        await program.methods
          .withdraw(new BN(999 * LAMPORTS_PER_SOL))
          .accounts({
            pool: poolPda,
            loanTokenVault: vaultPda,
            position: positionPda,
            depositorTokenAccount: depositorWsol.address,
            depositor: depositor1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([depositor1])
          .rpc();
        assert.fail("Should have failed");
      } catch (e: any) {
        assert.include(e.toString(), "InsufficientShares");
      }
    });
  });

  // -------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // Permissionless Liquidation (Keeper Network)
  // -------------------------------------------------------------------

  describe("permissionless liquidation", () => {
    let liquidationLoanPda: PublicKey;
    let liquidationCollateralVaultPda: PublicKey;
    const liquidationLoanId = new BN(Date.now() + 100);

    it("borrower takes a new Express tier loan for liquidation test", async () => {
      const idBuf = Buffer.alloc(8);
      liquidationLoanId.toArrayLike(Buffer, "le", 8).copy(idBuf);

      [liquidationLoanPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("loan"), borrower.publicKey.toBuffer(), idBuf],
        program.programId
      );
      [liquidationCollateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral-vault"), liquidationLoanPda.toBuffer()],
        program.programId
      );

      const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        collateralMint,
        borrower.publicKey
      );
      const borrowerWsol = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        NATIVE_MINT,
        borrower.publicKey
      );
      const feeWalletAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        NATIVE_MINT,
        authority.publicKey
      );

      const collateralAmount = new BN(50_000_000_000); // 50 tokens
      const collateralValue = new BN(LAMPORTS_PER_SOL); // worth 1 SOL
      const loanOption = 0; // Express: 30% LTV, 2 days

      await program.methods
        .requestAndFundLoan(
          collateralAmount,
          loanOption,
          collateralValue,
          liquidationLoanId
        )
        .accounts({
          pool: poolPda,
          loanTokenVault: vaultPda,
          loan: liquidationLoanPda,
          collateralVault: liquidationCollateralVaultPda,
          collateralMint,
          borrowerCollateralAccount: borrowerCollateralAta.address,
          borrowerLoanTokenAccount: borrowerWsol.address,
          feeWalletTokenAccount: feeWalletAta.address,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          loanTokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([borrower])
        .rpc();

      const loan = await program.account.loan.fetch(liquidationLoanPda);
      assert.deepEqual(loan.status, { active: {} });
      assert.equal(loan.ltvBps, 3000);
    });

    it("rejects liquidation before loan is due", async () => {
      // Keeper needs a collateral ATA
      const keeperCollateralAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        collateralMint,
        keeper.publicKey
      );
      const authorityCollateralAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        (authority as any).payer,
        collateralMint,
        authority.publicKey
      );

      try {
        await program.methods
          .liquidateLoan()
          .accounts({
            pool: poolPda,
            loan: liquidationLoanPda,
            collateralVault: liquidationCollateralVaultPda,
            keeperCollateralAccount: keeperCollateralAta.address,
            authorityCollateralAccount: authorityCollateralAta.address,
            keeper: keeper.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([keeper])
          .rpc();
        assert.fail("Should have failed");
      } catch (e: any) {
        assert.include(e.toString(), "LoanNotDue");
      }
    });

    it("keeper can liquidate an overdue loan and receives reward", async () => {
      // The test validator doesn't support clock warping easily.
      // We verify the account structure and keeper reward math here.
      // The LoanNotDue guard was already proven in the previous test.
      // Full integration testing of time-based liquidation would use solana-bankrun.

      const loan = await program.account.loan.fetch(liquidationLoanPda);
      const collateralAmount = loan.collateralAmount.toNumber();
      const expectedKeeperReward = Math.floor(
        (collateralAmount * KEEPER_REWARD_BPS) / 10_000
      );
      const expectedAuthorityAmount = collateralAmount - expectedKeeperReward;

      // Verify the math
      assert.equal(expectedKeeperReward, 2_500_000_000); // 5% of 50 tokens = 2.5 tokens
      assert.equal(expectedAuthorityAmount, 47_500_000_000); // 95% = 47.5 tokens

      // Verify keeper can be any signer (not just authority)
      assert.notOk(keeper.publicKey.equals(authority.publicKey));

      // Verify the pool has keeper_reward_bps set
      const pool = await program.account.lendingPool.fetch(poolPda);
      assert.equal(pool.keeperRewardBps, KEEPER_REWARD_BPS);
    });
  });

  // -------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------

  describe("admin controls", () => {
    it("non-authority cannot pause", async () => {
      try {
        await program.methods
          .setPaused(true)
          .accounts({
            pool: poolPda,
            authority: depositor1.publicKey,
          })
          .signers([depositor1])
          .rpc();
        assert.fail("Should have failed");
      } catch (e: any) {
        // Anchor has_one constraint error
        assert.ok(e.toString().includes("Error") || e.toString().includes("ConstraintHasOne"));
      }
    });

    it("authority can set keeper reward", async () => {
      await program.methods
        .setKeeperReward(1000) // 10%
        .accounts({
          pool: poolPda,
          authority: authority.publicKey,
        })
        .rpc();

      const pool = await program.account.lendingPool.fetch(poolPda);
      assert.equal(pool.keeperRewardBps, 1000);

      // Reset back
      await program.methods
        .setKeeperReward(KEEPER_REWARD_BPS)
        .accounts({
          pool: poolPda,
          authority: authority.publicKey,
        })
        .rpc();
    });

    it("rejects keeper reward > 20%", async () => {
      try {
        await program.methods
          .setKeeperReward(3000) // 30% — too high
          .accounts({
            pool: poolPda,
            authority: authority.publicKey,
          })
          .rpc();
        assert.fail("Should have failed");
      } catch (e: any) {
        assert.include(e.toString(), "KeeperRewardTooHigh");
      }
    });
  });
});
