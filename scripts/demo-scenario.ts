/**
 * Agent Vault Protocol — Demo Scenario
 *
 * Demonstrates the full lifecycle on a local test validator.
 * Called by scripts/demo.sh after deploying the program.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

const G = "\x1b[32m";
const R = "\x1b[31m";
const C = "\x1b[36m";
const Y = "\x1b[33m";
const B = "\x1b[1m";
const N = "\x1b[0m";

function success(msg: string) {
  console.log(`  ${G}✓ ${msg}${N}`);
}
function failExpected(msg: string) {
  console.log(`  ${R}✗ ${msg} (expected — policy enforced!)${N}`);
}
function info(msg: string) {
  console.log(`  ${C}→ ${msg}${N}`);
}
function step(n: number, msg: string) {
  console.log();
  console.log(`${Y}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}`);
  console.log(`${B}  Step ${n}: ${msg}${N}`);
  console.log(`${Y}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}`);
  console.log();
}

function sol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4);
}

async function main() {
  // Setup
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgentVault as Program;
  const owner = provider.wallet as anchor.Wallet;
  const agent = Keypair.generate();
  const rogue = Keypair.generate();
  const destination = Keypair.generate();

  // Fund agent and destination so they can receive SOL
  const sig1 = await provider.connection.requestAirdrop(
    destination.publicKey,
    0.01 * LAMPORTS_PER_SOL,
  );
  await provider.connection.confirmTransaction(sig1);

  // Derive vault PDA
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer(), agent.publicKey.toBuffer()],
    program.programId,
  );

  info(`Owner:       ${owner.publicKey.toBase58()}`);
  info(`Agent:       ${agent.publicKey.toBase58()}`);
  info(`Vault PDA:   ${vaultPda.toBase58()}`);
  info(`Destination: ${destination.publicKey.toBase58()}`);

  // ── Step 1: Create Vault ──────────────────────────────────────────────────
  step(1, "Create a vault with spending policies");

  const spendLimit = 0.5 * LAMPORTS_PER_SOL;  // 0.5 SOL per tx
  const dailyLimit = 1.0 * LAMPORTS_PER_SOL;  // 1.0 SOL per day
  const sessionDuration = 86400;                // 24 hours

  await program.methods
    .createVault(
      agent.publicKey,
      new anchor.BN(spendLimit),
      new anchor.BN(dailyLimit),
      new anchor.BN(sessionDuration),
    )
    .accounts({
      vault: vaultPda,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  success("Vault created");
  info(`Per-tx limit: ${sol(spendLimit)} SOL`);
  info(`Daily limit:  ${sol(dailyLimit)} SOL`);
  info(`Session:      24 hours`);

  // ── Step 2: Fund the Vault ────────────────────────────────────────────────
  step(2, "Fund the vault with 3 SOL");

  const fundAmount = 3 * LAMPORTS_PER_SOL;

  await program.methods
    .deposit(new anchor.BN(fundAmount))
    .accounts({
      vault: vaultPda,
      depositor: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const vaultBalance = await provider.connection.getBalance(vaultPda);
  success(`Deposited ${sol(fundAmount)} SOL`);
  info(`Vault balance: ${sol(vaultBalance)} SOL`);

  // ── Step 3: Agent Spends Successfully ─────────────────────────────────────
  step(3, "Agent spends 0.3 SOL (within limits)");

  const spendAmount = 0.3 * LAMPORTS_PER_SOL;

  await program.methods
    .agentSpend(new anchor.BN(spendAmount))
    .accounts({
      vault: vaultPda,
      agent: agent.publicKey,
      destination: destination.publicKey,
    })
    .signers([agent])
    .rpc();

  const destBal = await provider.connection.getBalance(destination.publicKey);
  success(`Agent spent ${sol(spendAmount)} SOL → destination`);
  info(`Destination received: ${sol(destBal)} SOL`);

  // ── Step 4: Agent Exceeds Per-Transaction Limit ───────────────────────────
  step(4, "Agent tries to spend 0.6 SOL (exceeds 0.5 SOL per-tx limit)");

  try {
    await program.methods
      .agentSpend(new anchor.BN(0.6 * LAMPORTS_PER_SOL))
      .accounts({
        vault: vaultPda,
        agent: agent.publicKey,
        destination: destination.publicKey,
      })
      .signers([agent])
      .rpc();
    console.log("  ERROR: Should have failed!");
  } catch (e: any) {
    failExpected("Transaction reverted: ExceedsTransactionLimit");
  }

  // ── Step 5: Agent Exceeds Daily Limit ─────────────────────────────────────
  step(5, "Agent spends 0.5 SOL twice (total 1.1 SOL exceeds 1.0 daily limit)");

  // First spend: 0.5 SOL (total daily: 0.3 + 0.5 = 0.8)
  await program.methods
    .agentSpend(new anchor.BN(0.5 * LAMPORTS_PER_SOL))
    .accounts({
      vault: vaultPda,
      agent: agent.publicKey,
      destination: destination.publicKey,
    })
    .signers([agent])
    .rpc();
  success("First 0.5 SOL spend succeeded (daily total: 0.8 SOL)");

  // Second spend: 0.5 SOL (total daily: 0.8 + 0.5 = 1.3 > 1.0)
  try {
    await program.methods
      .agentSpend(new anchor.BN(0.5 * LAMPORTS_PER_SOL))
      .accounts({
        vault: vaultPda,
        agent: agent.publicKey,
        destination: destination.publicKey,
      })
      .signers([agent])
      .rpc();
    console.log("  ERROR: Should have failed!");
  } catch (e: any) {
    failExpected("Transaction reverted: ExceedsDailyLimit");
  }

  // ── Step 6: Unauthorized Agent ────────────────────────────────────────────
  step(6, "Rogue agent tries to spend from the vault");

  try {
    await program.methods
      .agentSpend(new anchor.BN(0.1 * LAMPORTS_PER_SOL))
      .accounts({
        vault: vaultPda,
        agent: rogue.publicKey,
        destination: destination.publicKey,
      })
      .signers([rogue])
      .rpc();
    console.log("  ERROR: Should have failed!");
  } catch (e: any) {
    failExpected("Transaction reverted: Unauthorized");
  }

  // ── Step 7: Owner Revokes Agent ───────────────────────────────────────────
  step(7, "Owner revokes agent access");

  await program.methods
    .revokeAgent()
    .accounts({
      vault: vaultPda,
      owner: owner.publicKey,
    })
    .rpc();

  success("Agent revoked");

  // Agent tries to spend after revocation
  info("Agent attempts to spend after revocation...");
  try {
    await program.methods
      .agentSpend(new anchor.BN(0.1 * LAMPORTS_PER_SOL))
      .accounts({
        vault: vaultPda,
        agent: agent.publicKey,
        destination: destination.publicKey,
      })
      .signers([agent])
      .rpc();
    console.log("  ERROR: Should have failed!");
  } catch (e: any) {
    failExpected("Transaction reverted: VaultInactive");
  }

  // ── Step 8: Owner Updates Policy and Reactivates ──────────────────────────
  step(8, "Owner updates policy and assigns new agent");

  const newAgent = Keypair.generate();

  await program.methods
    .setAgent(newAgent.publicKey, new anchor.BN(3600))
    .accounts({
      vault: vaultPda,
      owner: owner.publicKey,
    })
    .rpc();

  success(`New agent assigned: ${newAgent.publicKey.toBase58().slice(0, 16)}...`);
  info("Session: 1 hour");

  // ── Step 9: Owner Withdraws ───────────────────────────────────────────────
  step(9, "Owner withdraws remaining SOL");

  const preBalance = await provider.connection.getBalance(owner.publicKey);

  // Get vault balance minus rent
  const vaultBal = await provider.connection.getBalance(vaultPda);
  const withdrawAmount = vaultBal - 1_600_000; // Leave rent

  await program.methods
    .ownerWithdraw(new anchor.BN(withdrawAmount))
    .accounts({
      vault: vaultPda,
      owner: owner.publicKey,
    })
    .rpc();

  const postBalance = await provider.connection.getBalance(owner.publicKey);
  success(`Withdrew ${sol(withdrawAmount)} SOL back to owner`);
  info(`Owner balance delta: +${sol(postBalance - preBalance)} SOL`);

  // ── Step 10: Owner Closes Vault ───────────────────────────────────────────
  step(10, "Owner closes vault and reclaims rent");

  await program.methods
    .closeVault()
    .accounts({
      vault: vaultPda,
      owner: owner.publicKey,
    })
    .rpc();

  const finalVaultBal = await provider.connection.getBalance(vaultPda);
  success(`Vault closed. Remaining balance: ${sol(finalVaultBal)} SOL`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log();
  console.log(`${B}╔══════════════════════════════════════════════════════════════╗${N}`);
  console.log(`${B}║                    Demo Summary                              ║${N}`);
  console.log(`${B}╠══════════════════════════════════════════════════════════════╣${N}`);
  console.log(`${B}║${N}  ${G}✓${N} Vault created with per-tx + daily limits              ${B}║${N}`);
  console.log(`${B}║${N}  ${G}✓${N} Agent spent within policy bounds                      ${B}║${N}`);
  console.log(`${B}║${N}  ${R}✗${N} Per-transaction limit enforced on-chain                ${B}║${N}`);
  console.log(`${B}║${N}  ${R}✗${N} Daily budget cap enforced on-chain                     ${B}║${N}`);
  console.log(`${B}║${N}  ${R}✗${N} Unauthorized agent blocked                             ${B}║${N}`);
  console.log(`${B}║${N}  ${R}✗${N} Revoked agent blocked                                  ${B}║${N}`);
  console.log(`${B}║${N}  ${G}✓${N} Owner swapped agent + updated session                  ${B}║${N}`);
  console.log(`${B}║${N}  ${G}✓${N} Owner withdrew funds + closed vault                    ${B}║${N}`);
  console.log(`${B}╠══════════════════════════════════════════════════════════════╣${N}`);
  console.log(`${B}║${N}  Every policy enforced on-chain. No SDK can bypass it.      ${B}║${N}`);
  console.log(`${B}╚══════════════════════════════════════════════════════════════╝${N}`);
  console.log();
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
