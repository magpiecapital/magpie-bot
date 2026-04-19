import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import BN from "bn.js";

// Load IDL type — Anchor workspace resolves this from target/idl
const AgentVault = anchor.workspace.AgentVault as Program<any>;

describe("Token Vault Protocol (SPL)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = AgentVault;
  const owner = provider.wallet;

  // Agent keypair — separate from the owner
  const agent = Keypair.generate();

  // An unauthorized imposter
  const imposter = Keypair.generate();

  // Mint authority (owner controls it for testing)
  const mintAuthority = Keypair.generate();

  // Token mint (6 decimals, like USDC)
  let mint: PublicKey;
  const DECIMALS = 6;
  const ONE_TOKEN = 1_000_000; // 10^6 smallest units = 1 token

  // Token accounts
  let ownerTokenAccount: PublicKey;
  let destinationKeypair: Keypair;
  let destinationTokenAccount: PublicKey;
  let imposterTokenAccount: PublicKey;

  // Token vault PDA and its ATA
  let tokenVaultPda: PublicKey;
  let tokenVaultBump: number;
  let vaultTokenAccount: PublicKey;

  // Policy parameters
  const SPEND_LIMIT = new BN(500 * ONE_TOKEN);    // 500 tokens per tx
  const DAILY_LIMIT = new BN(2000 * ONE_TOKEN);   // 2,000 tokens per day
  const SESSION_DURATION = new BN(3600);           // 1 hour
  const DEPOSIT_AMOUNT = new BN(5000 * ONE_TOKEN); // 5,000 tokens

  before(async () => {
    // Airdrop SOL to the owner for transaction fees and rent
    const sig = await provider.connection.requestAirdrop(
      owner.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    // Fund the mint authority
    const sig2 = await provider.connection.requestAirdrop(
      mintAuthority.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig2, "confirmed");

    // Fund the imposter so they can sign transactions
    const sig3 = await provider.connection.requestAirdrop(
      imposter.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig3, "confirmed");

    // Create SPL token mint (6 decimals, like USDC)
    mint = await createMint(
      provider.connection,
      (owner as any).payer,       // fee payer
      mintAuthority.publicKey,     // mint authority
      null,                        // no freeze authority
      DECIMALS,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    // Create owner's token account and mint tokens into it
    ownerTokenAccount = await createAccount(
      provider.connection,
      (owner as any).payer,
      mint,
      owner.publicKey,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      (owner as any).payer,
      mint,
      ownerTokenAccount,
      mintAuthority,
      10_000 * ONE_TOKEN, // mint 10,000 tokens to owner
      [],
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    // Create destination keypair and token account
    destinationKeypair = Keypair.generate();
    const sig4 = await provider.connection.requestAirdrop(
      destinationKeypair.publicKey,
      0.1 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig4, "confirmed");

    destinationTokenAccount = await createAccount(
      provider.connection,
      (owner as any).payer,
      mint,
      destinationKeypair.publicKey,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    // Create imposter token account
    imposterTokenAccount = await createAccount(
      provider.connection,
      (owner as any).payer,
      mint,
      imposter.publicKey,
      undefined,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID
    );

    // Derive token vault PDA
    [tokenVaultPda, tokenVaultBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("token_vault"),
        owner.publicKey.toBuffer(),
        agent.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      program.programId
    );

    // Derive the vault's associated token account
    vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      tokenVaultPda,
      true, // allowOwnerOffCurve — PDA is not on the ed25519 curve
      TOKEN_PROGRAM_ID
    );
  });

  // ─── 1. Create Token Vault ──────────────────────────────────────────────────

  describe("create_token_vault", () => {
    it("1. creates a token vault with correct state", async () => {
      await program.methods
        .createTokenVault(
          agent.publicKey,
          SPEND_LIMIT,
          DAILY_LIMIT,
          SESSION_DURATION
        )
        .accounts({
          tokenVault: tokenVaultPda,
          vaultTokenAccount: vaultTokenAccount,
          mint: mint,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        })
        .rpc();

      const tv = await program.account.tokenVault.fetch(tokenVaultPda);

      assert.ok(tv.owner.equals(owner.publicKey), "owner mismatch");
      assert.ok(tv.agent.equals(agent.publicKey), "agent mismatch");
      assert.ok(tv.mint.equals(mint), "mint mismatch");
      assert.ok(tv.tokenAccount.equals(vaultTokenAccount), "token_account mismatch");
      assert.ok(tv.spendLimit.eq(SPEND_LIMIT), "spend_limit mismatch");
      assert.ok(tv.dailyLimit.eq(DAILY_LIMIT), "daily_limit mismatch");
      assert.ok(tv.spentToday.eqn(0), "spent_today should be 0");
      assert.ok(tv.isActive === true, "vault should be active");
      assert.ok(tv.totalSpent.eqn(0), "total_spent should be 0");
      assert.ok(tv.totalReceived.eqn(0), "total_received should be 0");
      assert.ok(tv.txCount.eqn(0), "tx_count should be 0");
      assert.ok(tv.sessionExpiry.gtn(0), "session_expiry should be set");
      assert.equal(tv.bump, tokenVaultBump, "bump mismatch");
    });

    it("rejects spend_limit of 0", async () => {
      const badAgent = Keypair.generate();
      const [badPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("token_vault"),
          owner.publicKey.toBuffer(),
          badAgent.publicKey.toBuffer(),
          mint.toBuffer(),
        ],
        program.programId
      );
      const badVaultAta = getAssociatedTokenAddressSync(
        mint, badPda, true, TOKEN_PROGRAM_ID
      );

      try {
        await program.methods
          .createTokenVault(
            badAgent.publicKey,
            new BN(0),
            DAILY_LIMIT,
            SESSION_DURATION
          )
          .accounts({
            tokenVault: badPda,
            vaultTokenAccount: badVaultAta,
            mint: mint,
            owner: owner.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidSpendLimit");
      }
    });

    it("rejects daily_limit < spend_limit", async () => {
      const badAgent = Keypair.generate();
      const [badPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("token_vault"),
          owner.publicKey.toBuffer(),
          badAgent.publicKey.toBuffer(),
          mint.toBuffer(),
        ],
        program.programId
      );
      const badVaultAta = getAssociatedTokenAddressSync(
        mint, badPda, true, TOKEN_PROGRAM_ID
      );

      try {
        await program.methods
          .createTokenVault(
            badAgent.publicKey,
            new BN(1_000_000),
            new BN(500_000), // less than spend_limit
            SESSION_DURATION
          )
          .accounts({
            tokenVault: badPda,
            vaultTokenAccount: badVaultAta,
            mint: mint,
            owner: owner.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("DailyLimitBelowSpendLimit");
      }
    });
  });

  // ─── 2. Deposit Tokens ──────────────────────────────────────────────────────

  describe("deposit_token", () => {
    it("2. deposits SPL tokens into the vault", async () => {
      const vaultBefore = await getAccount(provider.connection, vaultTokenAccount);

      await program.methods
        .depositToken(DEPOSIT_AMOUNT)
        .accounts({
          tokenVault: tokenVaultPda,
          vaultTokenAccount: vaultTokenAccount,
          depositorTokenAccount: ownerTokenAccount,
          mint: mint,
          depositor: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed", skipPreflight: true });

      // Wait for confirmation
      await new Promise((r) => setTimeout(r, 500));
      const vaultAfter = await getAccount(provider.connection, vaultTokenAccount, "confirmed", TOKEN_PROGRAM_ID);

      assert.equal(
        Number(vaultAfter.amount - vaultBefore.amount),
        DEPOSIT_AMOUNT.toNumber(),
        "vault token balance should increase by deposit amount"
      );

      const tv = await program.account.tokenVault.fetch(tokenVaultPda);
      assert.ok(
        tv.totalReceived.eq(DEPOSIT_AMOUNT),
        "total_received should equal deposit"
      );
    });

    it("rejects zero deposit", async () => {
      try {
        await program.methods
          .depositToken(new BN(0))
          .accounts({
            tokenVault: tokenVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            depositorTokenAccount: ownerTokenAccount,
            mint: mint,
            depositor: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });
  });

  // ─── 3. Agent Spend Token — within limits ──────────────────────────────────

  describe("agent_spend_token", () => {
    const spendAmount = new BN(100 * ONE_TOKEN); // 100 tokens, well within limits

    it("3. agent spends tokens within limits — succeeds", async () => {
      const destBefore = await getAccount(
        provider.connection,
        destinationTokenAccount,
        "confirmed",
        TOKEN_PROGRAM_ID
      );

      await program.methods
        .agentSpendToken(spendAmount)
        .accounts({
          tokenVault: tokenVaultPda,
          vaultTokenAccount: vaultTokenAccount,
          destinationTokenAccount: destinationTokenAccount,
          mint: mint,
          agent: agent.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc({ commitment: "confirmed", skipPreflight: true });

      await new Promise((r) => setTimeout(r, 500));
      const destAfter = await getAccount(
        provider.connection,
        destinationTokenAccount,
        "confirmed",
        TOKEN_PROGRAM_ID
      );

      assert.equal(
        Number(destAfter.amount - destBefore.amount),
        spendAmount.toNumber(),
        "destination should receive the spend amount"
      );

      const tv = await program.account.tokenVault.fetch(tokenVaultPda);
      assert.ok(tv.spentToday.eq(spendAmount), "spent_today should update");
      assert.ok(tv.totalSpent.eq(spendAmount), "total_spent should update");
      assert.ok(tv.txCount.eqn(1), "tx_count should be 1");
    });

    // ─── 4. Exceeds per-tx limit ───────────────────────────────────────────────

    it("4. agent exceeds per-transaction limit — fails", async () => {
      const overLimit = SPEND_LIMIT.add(new BN(1)); // 1 unit over

      try {
        await program.methods
          .agentSpendToken(overLimit)
          .accounts({
            tokenVault: tokenVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            destinationTokenAccount: destinationTokenAccount,
            mint: mint,
            agent: agent.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agent])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ExceedsTransactionLimit");
      }
    });

    // ─── 5. Exceeds daily limit ────────────────────────────────────────────────

    it("5. agent exceeds daily limit — fails", async () => {
      // Current spent_today = 100 tokens. Daily limit = 2000 tokens.
      // Spend 500 tokens (max per tx) three times to get to 1600 tokens total.
      for (let i = 0; i < 3; i++) {
        await program.methods
          .agentSpendToken(SPEND_LIMIT)
          .accounts({
            tokenVault: tokenVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            destinationTokenAccount: destinationTokenAccount,
            mint: mint,
            agent: agent.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agent])
          .rpc({ commitment: "confirmed", skipPreflight: true });
        await new Promise((r) => setTimeout(r, 400));
      }

      // Now spent_today = 100 + 1500 = 1600 tokens. Spending 500 more = 2100 > daily 2000.
      try {
        await program.methods
          .agentSpendToken(SPEND_LIMIT) // 500 tokens would push to 2100
          .accounts({
            tokenVault: tokenVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            destinationTokenAccount: destinationTokenAccount,
            mint: mint,
            agent: agent.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agent])
          .rpc({ commitment: "confirmed" });
        assert.fail("should have thrown");
      } catch (err: any) {
        const code = err.error?.errorCode?.code || err.message;
        expect(code).to.equal("ExceedsDailyLimit");
      }
    });

    // ─── 6. Unauthorized agent ─────────────────────────────────────────────────

    it("6. unauthorized agent tries to spend — fails", async () => {
      try {
        await program.methods
          .agentSpendToken(new BN(1000))
          .accounts({
            tokenVault: tokenVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            destinationTokenAccount: imposterTokenAccount,
            mint: mint,
            agent: imposter.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        const code = err.error?.errorCode?.code;
        assert.ok(
          code === "Unauthorized" || code === "ConstraintHasOne",
          `expected Unauthorized or ConstraintHasOne, got ${code}`
        );
      }
    });
  });

  // ─── 7. Update Token Policy ──────────────────────────────────────────────────

  describe("update_token_policy", () => {
    const newSpendLimit = new BN(1000 * ONE_TOKEN);
    const newDailyLimit = new BN(5000 * ONE_TOKEN);

    it("7. owner updates token policy successfully", async () => {
      await program.methods
        .updateTokenPolicy(newSpendLimit, newDailyLimit)
        .accounts({
          tokenVault: tokenVaultPda,
          owner: owner.publicKey,
        })
        .rpc();

      const tv = await program.account.tokenVault.fetch(tokenVaultPda);
      assert.ok(tv.spendLimit.eq(newSpendLimit), "spend_limit should update");
      assert.ok(tv.dailyLimit.eq(newDailyLimit), "daily_limit should update");
    });

    it("rejects non-owner updating token policy", async () => {
      try {
        await program.methods
          .updateTokenPolicy(new BN(100), new BN(200))
          .accounts({
            tokenVault: tokenVaultPda,
            owner: imposter.publicKey,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        const code = err.error?.errorCode?.code;
        assert.ok(
          code === "Unauthorized" || code === "ConstraintHasOne",
          `expected Unauthorized or ConstraintHasOne, got ${code}`
        );
      }
    });

    it("rejects invalid token policy (daily < spend)", async () => {
      try {
        await program.methods
          .updateTokenPolicy(new BN(1_000_000), new BN(500_000))
          .accounts({
            tokenVault: tokenVaultPda,
            owner: owner.publicKey,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("DailyLimitBelowSpendLimit");
      }
    });
  });

  // ─── 8. Extend Token Session ────────────────────────────────────────────────

  describe("extend_token_session", () => {
    it("8. owner extends token session successfully", async () => {
      const tvBefore = await program.account.tokenVault.fetch(tokenVaultPda);
      const oldExpiry = tvBefore.sessionExpiry;

      await program.methods
        .extendTokenSession(new BN(7200)) // extend by 2 hours
        .accounts({
          tokenVault: tokenVaultPda,
          owner: owner.publicKey,
        })
        .rpc();

      const tvAfter = await program.account.tokenVault.fetch(tokenVaultPda);
      assert.ok(
        tvAfter.sessionExpiry.gt(oldExpiry),
        "session_expiry should increase"
      );
      assert.ok(tvAfter.isActive === true, "vault should be active after extend");
    });

    it("rejects non-owner extending token session", async () => {
      try {
        await program.methods
          .extendTokenSession(new BN(3600))
          .accounts({
            tokenVault: tokenVaultPda,
            owner: imposter.publicKey,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        const code = err.error?.errorCode?.code;
        assert.ok(
          code === "Unauthorized" || code === "ConstraintHasOne",
          `expected Unauthorized or ConstraintHasOne, got ${code}`
        );
      }
    });

    it("rejects zero session duration", async () => {
      try {
        await program.methods
          .extendTokenSession(new BN(0))
          .accounts({
            tokenVault: tokenVaultPda,
            owner: owner.publicKey,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidSessionDuration");
      }
    });
  });

  // ─── 9. Revoke Token Agent ──────────────────────────────────────────────────

  describe("revoke_token_agent", () => {
    it("9. owner revokes token agent successfully", async () => {
      await program.methods
        .revokeTokenAgent()
        .accounts({
          tokenVault: tokenVaultPda,
          owner: owner.publicKey,
        })
        .rpc();

      const tv = await program.account.tokenVault.fetch(tokenVaultPda);
      assert.ok(tv.isActive === false, "vault should be inactive after revoke");
    });

    it("agent cannot spend after token revoke", async () => {
      try {
        await program.methods
          .agentSpendToken(new BN(1000))
          .accounts({
            tokenVault: tokenVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            destinationTokenAccount: destinationTokenAccount,
            mint: mint,
            agent: agent.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([agent])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("VaultInactive");
      }
    });

    // Reactivate for subsequent tests
    after(async () => {
      await program.methods
        .extendTokenSession(new BN(3600))
        .accounts({
          tokenVault: tokenVaultPda,
          owner: owner.publicKey,
        })
        .rpc();
    });
  });

  // ─── 10. Owner Withdraw Tokens ──────────────────────────────────────────────

  describe("owner_withdraw_token", () => {
    it("10. owner withdraws tokens successfully", async () => {
      const ownerBefore = await getAccount(
        provider.connection,
        ownerTokenAccount,
        "confirmed",
        TOKEN_PROGRAM_ID
      );

      const withdrawAmount = new BN(500 * ONE_TOKEN);

      await program.methods
        .ownerWithdrawToken(withdrawAmount)
        .accounts({
          tokenVault: tokenVaultPda,
          vaultTokenAccount: vaultTokenAccount,
          ownerTokenAccount: ownerTokenAccount,
          mint: mint,
          owner: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed", skipPreflight: true });

      await new Promise((r) => setTimeout(r, 500));
      const ownerAfter = await getAccount(
        provider.connection,
        ownerTokenAccount,
        "confirmed",
        TOKEN_PROGRAM_ID
      );

      assert.equal(
        Number(ownerAfter.amount - ownerBefore.amount),
        withdrawAmount.toNumber(),
        "owner token balance should increase by withdrawal amount"
      );
    });

    it("rejects withdrawal exceeding vault balance", async () => {
      const hugeAmount = new BN(100_000 * ONE_TOKEN);

      try {
        await program.methods
          .ownerWithdrawToken(hugeAmount)
          .accounts({
            tokenVault: tokenVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            ownerTokenAccount: ownerTokenAccount,
            mint: mint,
            owner: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InsufficientFunds");
      }
    });

    it("rejects zero withdrawal", async () => {
      try {
        await program.methods
          .ownerWithdrawToken(new BN(0))
          .accounts({
            tokenVault: tokenVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            ownerTokenAccount: ownerTokenAccount,
            mint: mint,
            owner: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });

    it("rejects non-owner withdrawal", async () => {
      try {
        await program.methods
          .ownerWithdrawToken(new BN(1000))
          .accounts({
            tokenVault: tokenVaultPda,
            vaultTokenAccount: vaultTokenAccount,
            ownerTokenAccount: imposterTokenAccount,
            mint: mint,
            owner: imposter.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        const code = err.error?.errorCode?.code;
        assert.ok(
          code === "Unauthorized" || code === "ConstraintHasOne",
          `expected Unauthorized or ConstraintHasOne, got ${code}`
        );
      }
    });
  });

  // ─── 11. Close Token Vault ──────────────────────────────────────────────────

  describe("close_token_vault", () => {
    it("11. owner closes token vault — drains remaining tokens and reclaims rent", async () => {
      // Check vault has tokens remaining
      const vaultAtaBefore = await getAccount(
        provider.connection,
        vaultTokenAccount,
        "confirmed",
        TOKEN_PROGRAM_ID
      );
      const remainingTokens = Number(vaultAtaBefore.amount);
      assert.ok(remainingTokens > 0, "vault should have remaining tokens before close");

      const ownerBefore = await getAccount(
        provider.connection,
        ownerTokenAccount,
        "confirmed",
        TOKEN_PROGRAM_ID
      );
      const ownerSolBefore = await provider.connection.getBalance(owner.publicKey);

      await program.methods
        .closeTokenVault()
        .accounts({
          tokenVault: tokenVaultPda,
          vaultTokenAccount: vaultTokenAccount,
          ownerTokenAccount: ownerTokenAccount,
          mint: mint,
          owner: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      // Owner should receive the remaining tokens
      const ownerAfter = await getAccount(
        provider.connection,
        ownerTokenAccount,
        "confirmed",
        TOKEN_PROGRAM_ID
      );
      assert.equal(
        Number(ownerAfter.amount - ownerBefore.amount),
        remainingTokens,
        "owner should receive all remaining tokens"
      );

      // Owner should receive rent back (SOL balance increases minus tx fee)
      const ownerSolAfter = await provider.connection.getBalance(owner.publicKey);
      assert.ok(
        ownerSolAfter > ownerSolBefore,
        "owner should receive rent back from closed accounts"
      );

      // Token vault account should no longer exist
      const vaultAccount = await provider.connection.getAccountInfo(tokenVaultPda);
      assert.ok(vaultAccount === null, "token vault account should be closed");

      // Vault ATA should no longer exist
      const ataAccount = await provider.connection.getAccountInfo(vaultTokenAccount);
      assert.ok(ataAccount === null, "vault ATA should be closed");
    });

    it("rejects non-owner closing token vault", async () => {
      // Create a fresh token vault to test this
      const closeAgent = Keypair.generate();
      const [closePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("token_vault"),
          owner.publicKey.toBuffer(),
          closeAgent.publicKey.toBuffer(),
          mint.toBuffer(),
        ],
        program.programId
      );
      const closeVaultAta = getAssociatedTokenAddressSync(
        mint, closePda, true, TOKEN_PROGRAM_ID
      );

      await program.methods
        .createTokenVault(
          closeAgent.publicKey,
          SPEND_LIMIT,
          DAILY_LIMIT,
          SESSION_DURATION
        )
        .accounts({
          tokenVault: closePda,
          vaultTokenAccount: closeVaultAta,
          mint: mint,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        })
        .rpc();

      try {
        await program.methods
          .closeTokenVault()
          .accounts({
            tokenVault: closePda,
            vaultTokenAccount: closeVaultAta,
            ownerTokenAccount: imposterTokenAccount,
            mint: mint,
            owner: imposter.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        const code = err.error?.errorCode?.code;
        assert.ok(
          code === "Unauthorized" || code === "ConstraintHasOne",
          `expected Unauthorized or ConstraintHasOne, got ${code}`
        );
      }

      // Clean up: close the vault properly
      await program.methods
        .closeTokenVault()
        .accounts({
          tokenVault: closePda,
          vaultTokenAccount: closeVaultAta,
          ownerTokenAccount: ownerTokenAccount,
          mint: mint,
          owner: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    });
  });

  // ─── Bonus: Insufficient funds enforcement ──────────────────────────────────

  describe("insufficient funds enforcement (token)", () => {
    const fundsAgent = Keypair.generate();
    let fundsVaultPda: PublicKey;
    let fundsVaultAta: PublicKey;

    before(async () => {
      [fundsVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("token_vault"),
          owner.publicKey.toBuffer(),
          fundsAgent.publicKey.toBuffer(),
          mint.toBuffer(),
        ],
        program.programId
      );
      fundsVaultAta = getAssociatedTokenAddressSync(
        mint, fundsVaultPda, true, TOKEN_PROGRAM_ID
      );

      // Create vault with high limits but deposit almost nothing
      await program.methods
        .createTokenVault(
          fundsAgent.publicKey,
          new BN(10_000 * ONE_TOKEN),
          new BN(100_000 * ONE_TOKEN),
          new BN(0) // no session expiry
        )
        .accounts({
          tokenVault: fundsVaultPda,
          vaultTokenAccount: fundsVaultAta,
          mint: mint,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        })
        .rpc();

      // Deposit a tiny amount
      await program.methods
        .depositToken(new BN(10)) // 0.00001 tokens
        .accounts({
          tokenVault: fundsVaultPda,
          vaultTokenAccount: fundsVaultAta,
          depositorTokenAccount: ownerTokenAccount,
          mint: mint,
          depositor: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    });

    it("agent spend fails when vault has insufficient token balance", async () => {
      try {
        await program.methods
          .agentSpendToken(new BN(1000 * ONE_TOKEN))
          .accounts({
            tokenVault: fundsVaultPda,
            vaultTokenAccount: fundsVaultAta,
            destinationTokenAccount: destinationTokenAccount,
            mint: mint,
            agent: fundsAgent.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([fundsAgent])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InsufficientFunds");
      }
    });

    after(async () => {
      // Clean up
      await program.methods
        .closeTokenVault()
        .accounts({
          tokenVault: fundsVaultPda,
          vaultTokenAccount: fundsVaultAta,
          ownerTokenAccount: ownerTokenAccount,
          mint: mint,
          owner: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    });
  });
});
