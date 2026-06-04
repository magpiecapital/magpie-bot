#!/usr/bin/env node
/**
 * Wallet drain script — moves all SOL + SPL tokens from a recovered
 * wallet to a destination wallet. Use this AFTER recover-wallet-key.js
 * has surfaced the original private key.
 *
 * Usage:
 *   node scripts/drain-wallet.js <source_private_key_base58> <destination_pubkey> [--execute]
 *
 * Without --execute it runs in DRY-RUN mode: shows exactly what would
 * move, but doesn't submit any tx. ALWAYS dry-run first.
 *
 * What it moves:
 *   • Every SPL token (TokenkegQfe... and Token-2022) with non-zero balance
 *     → transferred to the destination's associated token account
 *     → source ATA closed to reclaim rent (extra SOL back to source)
 *   • All SOL minus a small reserve (kept for paying fees on the drain tx)
 *
 * What it does NOT do:
 *   • Touch any loan PDAs. If the user has an active loan, their collateral
 *     is locked in the program — that needs /repay separately AFTER we
 *     restore the wallet to their account via /import.
 *   • Transfer NFTs (would need extra logic; skip for now)
 *
 * Safety:
 *   • Dry-run by default
 *   • Verifies source key matches a real funded wallet before doing anything
 *   • Shows full transaction plan before executing
 *   • Each token transfer is its own tx (failure on one doesn't affect others)
 *   • Reserves 0.005 SOL on source for tx fees
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  LAMPORTS_PER_SOL, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";

const sourceKeyB58 = process.argv[2];
const destPubkeyStr = process.argv[3];
const execute = process.argv.includes("--execute");

if (!sourceKeyB58 || !destPubkeyStr) {
  console.error("Usage: node scripts/drain-wallet.js <source_private_key_base58> <destination_pubkey> [--execute]");
  console.error("\nWithout --execute it runs in DRY-RUN mode.");
  process.exit(1);
}

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const SOL_RESERVE_LAMPORTS = 5_000_000; // 0.005 SOL kept on source for fees
const PRIORITY_FEE_MICROLAMPORTS = 100_000;

function fmtSol(lamports) {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6);
}

async function main() {
  console.log(`\n═══════════ Wallet Drain ═══════════\n`);
  console.log(`Mode: ${execute ? "🟢 EXECUTE (will broadcast tx)" : "🟡 DRY RUN (no tx broadcast)"}`);
  console.log(`RPC: ${RPC_URL}\n`);

  // Load source keypair
  let source;
  try {
    const decoded = bs58.decode(sourceKeyB58);
    source = Keypair.fromSecretKey(decoded);
  } catch (err) {
    console.error(`Invalid source private key: ${err.message}`);
    process.exit(1);
  }
  console.log(`Source wallet:      ${source.publicKey.toBase58()}`);

  // Validate destination
  let destination;
  try {
    destination = new PublicKey(destPubkeyStr);
  } catch (err) {
    console.error(`Invalid destination pubkey: ${err.message}`);
    process.exit(1);
  }
  console.log(`Destination wallet: ${destination.toBase58()}\n`);

  const connection = new Connection(RPC_URL, "confirmed");

  // Inventory source wallet
  console.log("─ Inventorying source wallet ─");
  const solBalance = await connection.getBalance(source.publicKey);
  console.log(`  SOL:    ${fmtSol(solBalance)} SOL`);

  // Pull both legacy and Token-2022 token accounts
  const [tk, t22] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(source.publicKey, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(source.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const allTokenAccts = [
    ...tk.value.map((a) => ({ ...a, programId: TOKEN_PROGRAM_ID })),
    ...t22.value.map((a) => ({ ...a, programId: TOKEN_2022_PROGRAM_ID })),
  ];

  const tokens = allTokenAccts
    .map((a) => {
      const info = a.account.data.parsed.info;
      const amt = info.tokenAmount;
      return {
        mint: info.mint,
        decimals: amt.decimals,
        rawAmount: BigInt(amt.amount),
        uiAmount: amt.uiAmountString,
        programId: a.programId,
      };
    })
    .filter((t) => t.rawAmount > 0n);

  console.log(`  Tokens: ${tokens.length} mint(s) with non-zero balance`);
  for (const t of tokens) {
    console.log(`    • ${t.uiAmount} of ${t.mint}`);
  }
  console.log();

  if (solBalance <= SOL_RESERVE_LAMPORTS && tokens.length === 0) {
    console.log("Nothing to drain. Source wallet has no transferable balance.");
    process.exit(0);
  }

  // ── Token transfers ──
  // Move each token (skipping the ones with zero amount).
  // Each in its own tx so a single failure doesn't poison the batch.
  console.log("─ Plan ─");
  for (const t of tokens) {
    console.log(`  TX: transfer ${t.uiAmount} of ${t.mint} → destination`);
  }
  const solToSend = Math.max(0, solBalance - SOL_RESERVE_LAMPORTS);
  if (solToSend > 0) {
    console.log(`  TX: transfer ${fmtSol(solToSend)} SOL → destination (keeps ${fmtSol(SOL_RESERVE_LAMPORTS)} reserve for fees)`);
  }
  console.log();

  if (!execute) {
    console.log("🟡 DRY RUN — no tx submitted. To execute for real, rerun with --execute appended.\n");
    process.exit(0);
  }

  console.log("🟢 EXECUTING. Press Ctrl+C in next 3 seconds to abort.");
  await new Promise((r) => setTimeout(r, 3000));
  console.log("\n─ Submitting transactions ─");

  // ── 1. Token transfers (one tx each for safety) ──
  for (const t of tokens) {
    const mint = new PublicKey(t.mint);
    const sourceAta = getAssociatedTokenAddressSync(mint, source.publicKey, false, t.programId);
    const destAta = getAssociatedTokenAddressSync(mint, destination, false, t.programId);

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      // idempotent ATA create — fee paid by source (the keypair we're draining)
      createAssociatedTokenAccountIdempotentInstruction(
        source.publicKey, destAta, destination, mint, t.programId,
      ),
      createTransferCheckedInstruction(
        sourceAta, mint, destAta, source.publicKey, t.rawAmount, t.decimals, [], t.programId,
      ),
      // Close source ATA — reclaims rent (extra SOL recovered)
      createCloseAccountInstruction(
        sourceAta, source.publicKey, source.publicKey, [], t.programId,
      ),
    );
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = source.publicKey;
    tx.sign(source);
    try {
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      console.log(`  ✓ token ${t.mint.slice(0, 8)}... transferred: https://solscan.io/tx/${sig}`);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight }, "confirmed");
    } catch (err) {
      console.error(`  ✗ token ${t.mint.slice(0, 8)}... failed: ${err.message?.slice(0, 200)}`);
    }
  }

  // ── 2. SOL sweep (do LAST so we benefit from any ATA close rent recovery above) ──
  const solBalanceAfter = await connection.getBalance(source.publicKey);
  const finalSend = Math.max(0, solBalanceAfter - SOL_RESERVE_LAMPORTS);
  if (finalSend > 0) {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      SystemProgram.transfer({
        fromPubkey: source.publicKey,
        toPubkey: destination,
        lamports: finalSend,
      }),
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = source.publicKey;
    tx.sign(source);
    try {
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      console.log(`  ✓ SOL ${fmtSol(finalSend)} transferred: https://solscan.io/tx/${sig}`);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    } catch (err) {
      console.error(`  ✗ SOL transfer failed: ${err.message?.slice(0, 200)}`);
    }
  }

  console.log("\n─ Final state ─");
  console.log(`  Source remaining: ${fmtSol(await connection.getBalance(source.publicKey))} SOL`);
  console.log(`  Destination now:  ${fmtSol(await connection.getBalance(destination))} SOL\n`);
  console.log("Done.\n");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
