import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";
import BN from "bn.js";

// Load IDL type — Anchor workspace resolves this from target/idl
const AgentVault = anchor.workspace.AgentVault as Program<any>;

describe("Agent Vault Protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = AgentVault;
  const owner = provider.wallet;

  // Agent keypair — separate from the owner
  const agent = Keypair.generate();

  // A second agent for set_agent tests
  const agent2 = Keypair.generate();

  // An unauthorized imposter
  const imposter = Keypair.generate();

  // Destination for agent_spend
  const destination = Keypair.generate();

  // Policy parameters
  const SPEND_LIMIT = new BN(0.5 * LAMPORTS_PER_SOL);   // 0.5 SOL per tx
  const DAILY_LIMIT = new BN(2 * LAMPORTS_PER_SOL);      // 2 SOL per day
  const SESSION_DURATION = new BN(3600);                  // 1 hour
  const DEPOSIT_AMOUNT = new BN(5 * LAMPORTS_PER_SOL);   // 5 SOL

  let vaultPda: PublicKey;
  let vaultBump: number;

  // Derive PDA once
  before(async () => {
    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        agent.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Airdrop SOL to the owner (provider wallet) for test transactions
    const sig = await provider.connection.requestAirdrop(
      owner.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    // Fund the destination account so it exists for lamport transfers
    const sig2 = await provider.connection.requestAirdrop(
      destination.publicKey,
      0.01 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig2, "confirmed");

    // Fund the imposter so they can sign transactions
    const sig3 = await provider.connection.requestAirdrop(
      imposter.publicKey,
      1 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig3, "confirmed");
  });

  // ─── 1. Create Vault ─────────────────────────────────────────────────────────

  describe("create_vault", () => {
    it("1. creates a vault with correct state", async () => {
      const tx = await program.methods
        .createVault(
          agent.publicKey,
          SPEND_LIMIT,
          DAILY_LIMIT,
          SESSION_DURATION
        )
        .accounts({
          vault: vaultPda,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);

      assert.ok(vault.owner.equals(owner.publicKey), "owner mismatch");
      assert.ok(vault.agent.equals(agent.publicKey), "agent mismatch");
      assert.ok(vault.spendLimit.eq(SPEND_LIMIT), "spend_limit mismatch");
      assert.ok(vault.dailyLimit.eq(DAILY_LIMIT), "daily_limit mismatch");
      assert.ok(vault.spentToday.eqn(0), "spent_today should be 0");
      assert.ok(vault.isActive === true, "vault should be active");
      assert.ok(vault.totalSpent.eqn(0), "total_spent should be 0");
      assert.ok(vault.totalReceived.eqn(0), "total_received should be 0");
      assert.ok(vault.txCount.eqn(0), "tx_count should be 0");
      assert.ok(vault.sessionExpiry.gtn(0), "session_expiry should be set");
      assert.equal(vault.bump, vaultBump, "bump mismatch");
    });

    it("rejects spend_limit of 0", async () => {
      const badAgent = Keypair.generate();
      const [badPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          badAgent.publicKey.toBuffer(),
        ],
        program.programId
      );

      try {
        await program.methods
          .createVault(
            badAgent.publicKey,
            new BN(0),
            DAILY_LIMIT,
            SESSION_DURATION
          )
          .accounts({
            vault: badPda,
            owner: owner.publicKey,
            systemProgram: SystemProgram.programId,
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
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          badAgent.publicKey.toBuffer(),
        ],
        program.programId
      );

      try {
        await program.methods
          .createVault(
            badAgent.publicKey,
            new BN(1_000_000),
            new BN(500_000), // less than spend_limit
            SESSION_DURATION
          )
          .accounts({
            vault: badPda,
            owner: owner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("DailyLimitBelowSpendLimit");
      }
    });
  });

  // ─── 2. Deposit ───────────────────────────────────────────────────────────────

  describe("deposit", () => {
    it("2. deposits SOL into the vault", async () => {
      const balanceBefore = await provider.connection.getBalance(vaultPda);

      await program.methods
        .deposit(DEPOSIT_AMOUNT)
        .accounts({
          vault: vaultPda,
          depositor: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const balanceAfter = await provider.connection.getBalance(vaultPda);
      assert.ok(
        balanceAfter - balanceBefore === DEPOSIT_AMOUNT.toNumber(),
        "vault balance should increase by deposit amount"
      );

      const vault = await program.account.vault.fetch(vaultPda);
      assert.ok(
        vault.totalReceived.eq(DEPOSIT_AMOUNT),
        "total_received should equal deposit"
      );
    });

    it("rejects zero deposit", async () => {
      try {
        await program.methods
          .deposit(new BN(0))
          .accounts({
            vault: vaultPda,
            depositor: owner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });
  });

  // ─── 3. Agent Spend — within limits ───────────────────────────────────────────

  describe("agent_spend", () => {
    const spendAmount = new BN(0.1 * LAMPORTS_PER_SOL); // well within limits

    it("3. agent spends within limits — succeeds", async () => {
      const destBefore = await provider.connection.getBalance(
        destination.publicKey
      );

      await program.methods
        .agentSpend(spendAmount)
        .accounts({
          vault: vaultPda,
          agent: agent.publicKey,
          destination: destination.publicKey,
        })
        .signers([agent])
        .rpc();

      const destAfter = await provider.connection.getBalance(
        destination.publicKey
      );
      assert.equal(
        destAfter - destBefore,
        spendAmount.toNumber(),
        "destination should receive the spend amount"
      );

      const vault = await program.account.vault.fetch(vaultPda);
      assert.ok(vault.spentToday.eq(spendAmount), "spent_today should update");
      assert.ok(vault.totalSpent.eq(spendAmount), "total_spent should update");
      assert.ok(vault.txCount.eqn(1), "tx_count should be 1");
    });

    // ─── 4. Exceeds per-tx limit ────────────────────────────────────────────────

    it("4. agent exceeds per-transaction limit — fails", async () => {
      const overLimit = SPEND_LIMIT.add(new BN(1)); // 1 lamport over

      try {
        await program.methods
          .agentSpend(overLimit)
          .accounts({
            vault: vaultPda,
            agent: agent.publicKey,
            destination: destination.publicKey,
          })
          .signers([agent])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ExceedsTransactionLimit");
      }
    });

    // ─── 5. Exceeds daily limit ─────────────────────────────────────────────────

    it("5. agent exceeds daily limit — fails", async () => {
      // Spend up to the daily limit first (current spent_today = 0.1 SOL)
      // Daily limit = 2 SOL. We need to spend enough to hit the boundary.
      // Spend 0.5 SOL (max per tx) three times to get to 1.6 SOL total
      for (let i = 0; i < 3; i++) {
        await program.methods
          .agentSpend(SPEND_LIMIT)
          .accounts({
            vault: vaultPda,
            agent: agent.publicKey,
            destination: destination.publicKey,
          })
          .signers([agent])
          .rpc();
      }

      // Now spent_today = 0.1 + 1.5 = 1.6 SOL. Spending 0.5 SOL more = 2.1 SOL > daily 2 SOL
      try {
        await program.methods
          .agentSpend(SPEND_LIMIT) // 0.5 SOL would push to 2.1 SOL
          .accounts({
            vault: vaultPda,
            agent: agent.publicKey,
            destination: destination.publicKey,
          })
          .signers([agent])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ExceedsDailyLimit");
      }
    });

    // ─── 6. Unauthorized agent ──────────────────────────────────────────────────

    it("6. unauthorized agent tries to spend — fails", async () => {
      try {
        await program.methods
          .agentSpend(new BN(1000))
          .accounts({
            vault: vaultPda,
            agent: imposter.publicKey,
            destination: destination.publicKey,
          })
          .signers([imposter])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        // has_one constraint triggers Unauthorized or an AnchorError for constraint violation
        const code = err.error?.errorCode?.code;
        assert.ok(
          code === "Unauthorized" || code === "ConstraintHasOne",
          `expected Unauthorized or ConstraintHasOne, got ${code}`
        );
      }
    });
  });

  // ─── 7. Spend after session expired ───────────────────────────────────────────

  describe("session expiry enforcement", () => {
    // We need a separate vault with a very short session for this test.
    // Since we cannot warp time in devnet, we create a vault with session_duration=1
    // and wait/sleep briefly. On localnet with bankrun or time-warp this would be
    // deterministic; here we use a 1-second session and a small delay.

    const shortAgent = Keypair.generate();
    let shortVaultPda: PublicKey;

    before(async () => {
      [shortVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          shortAgent.publicKey.toBuffer(),
        ],
        program.programId
      );

      await program.methods
        .createVault(
          shortAgent.publicKey,
          SPEND_LIMIT,
          DAILY_LIMIT,
          new BN(1) // 1-second session
        )
        .accounts({
          vault: shortVaultPda,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Deposit into the short-session vault
      await program.methods
        .deposit(new BN(1 * LAMPORTS_PER_SOL))
        .accounts({
          vault: shortVaultPda,
          depositor: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Wait for session to expire
      await new Promise((resolve) => setTimeout(resolve, 3000));
    });

    it("7. spend after session expired — fails", async () => {
      try {
        await program.methods
          .agentSpend(new BN(1000))
          .accounts({
            vault: shortVaultPda,
            agent: shortAgent.publicKey,
            destination: destination.publicKey,
          })
          .signers([shortAgent])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("SessionExpired");
      }
    });
  });

  // ─── 8. Spend after revocation ────────────────────────────────────────────────

  describe("revocation enforcement", () => {
    const revokeAgent = Keypair.generate();
    let revokeVaultPda: PublicKey;

    before(async () => {
      [revokeVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          revokeAgent.publicKey.toBuffer(),
        ],
        program.programId
      );

      await program.methods
        .createVault(
          revokeAgent.publicKey,
          SPEND_LIMIT,
          DAILY_LIMIT,
          new BN(0) // no session expiry
        )
        .accounts({
          vault: revokeVaultPda,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .deposit(new BN(1 * LAMPORTS_PER_SOL))
        .accounts({
          vault: revokeVaultPda,
          depositor: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Revoke
      await program.methods
        .revokeAgent()
        .accounts({
          vault: revokeVaultPda,
          owner: owner.publicKey,
        })
        .rpc();
    });

    it("8. spend after revocation — fails", async () => {
      try {
        await program.methods
          .agentSpend(new BN(1000))
          .accounts({
            vault: revokeVaultPda,
            agent: revokeAgent.publicKey,
            destination: destination.publicKey,
          })
          .signers([revokeAgent])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("VaultInactive");
      }
    });
  });

  // ─── 9. Owner updates policy ──────────────────────────────────────────────────

  describe("update_policy", () => {
    const newSpendLimit = new BN(1 * LAMPORTS_PER_SOL);
    const newDailyLimit = new BN(5 * LAMPORTS_PER_SOL);

    it("9. owner updates policy successfully", async () => {
      await program.methods
        .updatePolicy(newSpendLimit, newDailyLimit)
        .accounts({
          vault: vaultPda,
          owner: owner.publicKey,
        })
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assert.ok(vault.spendLimit.eq(newSpendLimit), "spend_limit should update");
      assert.ok(vault.dailyLimit.eq(newDailyLimit), "daily_limit should update");
    });

    it("rejects non-owner updating policy", async () => {
      try {
        await program.methods
          .updatePolicy(new BN(100), new BN(200))
          .accounts({
            vault: vaultPda,
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

    it("rejects invalid policy (daily < spend)", async () => {
      try {
        await program.methods
          .updatePolicy(new BN(1_000_000), new BN(500_000))
          .accounts({
            vault: vaultPda,
            owner: owner.publicKey,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("DailyLimitBelowSpendLimit");
      }
    });
  });

  // ─── 10. Owner extends session ────────────────────────────────────────────────

  describe("extend_session", () => {
    it("10. owner extends session successfully", async () => {
      const vaultBefore = await program.account.vault.fetch(vaultPda);
      const oldExpiry = vaultBefore.sessionExpiry;

      await program.methods
        .extendSession(new BN(7200)) // extend by 2 hours
        .accounts({
          vault: vaultPda,
          owner: owner.publicKey,
        })
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      assert.ok(
        vaultAfter.sessionExpiry.gt(oldExpiry),
        "session_expiry should increase"
      );
      assert.ok(vaultAfter.isActive === true, "vault should be active after extend");
    });

    it("rejects non-owner extending session", async () => {
      try {
        await program.methods
          .extendSession(new BN(3600))
          .accounts({
            vault: vaultPda,
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

    it("rejects zero/negative session duration", async () => {
      try {
        await program.methods
          .extendSession(new BN(0))
          .accounts({
            vault: vaultPda,
            owner: owner.publicKey,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidSessionDuration");
      }
    });
  });

  // ─── 11. Owner revokes agent ──────────────────────────────────────────────────

  describe("revoke_agent", () => {
    // Use the main vault. After this, we will re-activate with set_agent.
    it("11. owner revokes agent successfully", async () => {
      await program.methods
        .revokeAgent()
        .accounts({
          vault: vaultPda,
          owner: owner.publicKey,
        })
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assert.ok(vault.isActive === false, "vault should be inactive after revoke");
    });

    it("agent cannot spend after revoke on main vault", async () => {
      try {
        await program.methods
          .agentSpend(new BN(1000))
          .accounts({
            vault: vaultPda,
            agent: agent.publicKey,
            destination: destination.publicKey,
          })
          .signers([agent])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("VaultInactive");
      }
    });
  });

  // ─── 12. Owner sets new agent ─────────────────────────────────────────────────

  describe("set_agent", () => {
    it("12. owner sets a new agent successfully", async () => {
      await program.methods
        .setAgent(agent2.publicKey, new BN(7200))
        .accounts({
          vault: vaultPda,
          owner: owner.publicKey,
        })
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      assert.ok(vault.agent.equals(agent2.publicKey), "agent should be updated");
      assert.ok(vault.isActive === true, "vault should be reactivated");
      assert.ok(vault.spentToday.eqn(0), "spent_today should reset");
      assert.ok(vault.sessionExpiry.gtn(0), "session_expiry should be set");
    });

    it("old agent can no longer spend", async () => {
      try {
        await program.methods
          .agentSpend(new BN(1000))
          .accounts({
            vault: vaultPda,
            agent: agent.publicKey,
            destination: destination.publicKey,
          })
          .signers([agent])
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

    it("rejects non-owner setting agent", async () => {
      try {
        await program.methods
          .setAgent(Keypair.generate().publicKey, new BN(3600))
          .accounts({
            vault: vaultPda,
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
  });

  // ─── 13. Owner withdraws ─────────────────────────────────────────────────────

  describe("owner_withdraw", () => {
    it("13. owner withdraws SOL successfully", async () => {
      const ownerBefore = await provider.connection.getBalance(owner.publicKey);
      const withdrawAmount = new BN(0.5 * LAMPORTS_PER_SOL);

      await program.methods
        .ownerWithdraw(withdrawAmount)
        .accounts({
          vault: vaultPda,
          owner: owner.publicKey,
        })
        .rpc();

      const ownerAfter = await provider.connection.getBalance(owner.publicKey);
      // Owner receives withdrawAmount minus tx fee
      assert.ok(
        ownerAfter > ownerBefore,
        "owner balance should increase after withdrawal"
      );
    });

    it("rejects withdrawal exceeding available balance", async () => {
      const hugeAmount = new BN(100 * LAMPORTS_PER_SOL);

      try {
        await program.methods
          .ownerWithdraw(hugeAmount)
          .accounts({
            vault: vaultPda,
            owner: owner.publicKey,
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
          .ownerWithdraw(new BN(0))
          .accounts({
            vault: vaultPda,
            owner: owner.publicKey,
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
          .ownerWithdraw(new BN(1000))
          .accounts({
            vault: vaultPda,
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
  });

  // ─── 14. Owner closes vault ───────────────────────────────────────────────────

  describe("close_vault", () => {
    it("14. owner closes vault and reclaims all rent", async () => {
      const ownerBefore = await provider.connection.getBalance(owner.publicKey);

      await program.methods
        .closeVault()
        .accounts({
          vault: vaultPda,
          owner: owner.publicKey,
        })
        .rpc();

      const ownerAfter = await provider.connection.getBalance(owner.publicKey);
      assert.ok(
        ownerAfter > ownerBefore,
        "owner should receive rent + remaining lamports"
      );

      // Vault account should no longer exist
      const vaultAccount = await provider.connection.getAccountInfo(vaultPda);
      assert.ok(vaultAccount === null, "vault account should be closed");
    });

    it("rejects non-owner closing vault", async () => {
      // Create a fresh vault to test this
      const closeAgent = Keypair.generate();
      const [closePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          closeAgent.publicKey.toBuffer(),
        ],
        program.programId
      );

      await program.methods
        .createVault(
          closeAgent.publicKey,
          SPEND_LIMIT,
          DAILY_LIMIT,
          SESSION_DURATION
        )
        .accounts({
          vault: closePda,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      try {
        await program.methods
          .closeVault()
          .accounts({
            vault: closePda,
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

      // Clean up: close the vault properly
      await program.methods
        .closeVault()
        .accounts({
          vault: closePda,
          owner: owner.publicKey,
        })
        .rpc();
    });
  });

  // ─── Bonus: Insufficient funds ────────────────────────────────────────────────

  describe("insufficient funds enforcement", () => {
    const fundsAgent = Keypair.generate();
    let fundsVaultPda: PublicKey;

    before(async () => {
      [fundsVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          fundsAgent.publicKey.toBuffer(),
        ],
        program.programId
      );

      // Create vault with high limits but deposit almost nothing
      await program.methods
        .createVault(
          fundsAgent.publicKey,
          new BN(10 * LAMPORTS_PER_SOL),
          new BN(100 * LAMPORTS_PER_SOL),
          new BN(0) // no session expiry
        )
        .accounts({
          vault: fundsVaultPda,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Deposit a tiny amount — vault only has rent + tiny deposit
      await program.methods
        .deposit(new BN(10_000))
        .accounts({
          vault: fundsVaultPda,
          depositor: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("agent spend fails when vault has insufficient balance above rent", async () => {
      // Try to spend more than the non-rent balance
      try {
        await program.methods
          .agentSpend(new BN(1 * LAMPORTS_PER_SOL))
          .accounts({
            vault: fundsVaultPda,
            agent: fundsAgent.publicKey,
            destination: destination.publicKey,
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
        .closeVault()
        .accounts({
          vault: fundsVaultPda,
          owner: owner.publicKey,
        })
        .rpc();
    });
  });
});
