#!/usr/bin/env node
/**
 * Withdraw SOL from a Magpie lending pool (V1/V3/V4) from the lender/depositor
 * keypair, CHUNKED to dodge the on-chain u64 overflow in `withdraw`
 * (`shares * deposited_amount` overflows u64 for large amounts → MathOverflow
 * 6004). Each tx batches up to K sub-withdrawals (accounts are shared so many
 * fit), each sized so chunk_shares * deposited_amount < U64_MAX/2. The position
 * shrinks as we withdraw, so chunks grow and it converges fast. wSOL is
 * accumulated per-tx then unwrapped to native SOL by a single close.
 *
 * SAFETY: run with --dry-run first (simulates tx#1 + projects the plan, moves
 * nothing). Only run --execute once the dry-run shows sim err: null.
 *
 * Usage:
 *   LENDER_PRIVATE_KEY=<bs58> | LENDER_KEYPAIR_PATH=<file> \
 *   SOLANA_RPC_URL=<...> [WITHDRAW_IXS_PER_TX=10] \
 *   node scripts/withdraw-from-pool.mjs <v1|v3|v4|v41> <sol_amount> --dry-run|--execute
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import {
  Connection, Keypair, PublicKey, ComputeBudgetProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import anchor from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program, Wallet } = anchor;

const version = (process.argv[2] || "").toLowerCase();
const amountSol = parseFloat(process.argv[3]);
const dryRun = process.argv.includes("--dry-run");
const execute = process.argv.includes("--execute");
const K = Math.max(1, Number(process.env.WITHDRAW_IXS_PER_TX || 10));

const MAP = {
  v1: { idl: "./src/solana/idl/magpie_lending.json", pid: process.env.PROGRAM_ID || "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh" },
  v3: { idl: "./src/solana/idl/magpie-v3.json", pid: process.env.PROGRAM_ID_V3 || "B8AwYzFmc3ZB5EWWVtJcJhJtEmKL78W5i3kZrL1uMCmP" },
  v4: { idl: "./src/solana/idl/magpie-v4.json", pid: process.env.PROGRAM_ID_V4 || "HA1hgvskN1goEsb33rNHFBcDXBaYyLyyqfGwGMgTUwNo" },
  v41: { idl: "./src/solana/idl/magpie-v4-1.json", pid: process.env.PROGRAM_ID_V4_1 || "FsGXFtStgdRVqHQgik879CFpxM23oBt63URCYEWcxj4z" },
};
if (!MAP[version] || !amountSol || amountSol <= 0) {
  console.error("Usage: node scripts/withdraw-from-pool.mjs <v1|v3|v4|v41> <sol_amount> --dry-run|--execute");
  process.exit(1);
}
if (!dryRun && !execute) { console.error("Specify --dry-run (simulate) or --execute (real withdrawal)."); process.exit(1); }

const { idl: idlPath, pid } = MAP[version];
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
function loadLender() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) { const decode = bs58.decode || (bs58.default && bs58.default.decode); return Keypair.fromSecretKey(decode(b58)); }
  const path = process.env.LENDER_KEYPAIR_PATH || "./lender-keypair.json";
  if (!existsSync(path)) { console.error(`No LENDER_PRIVATE_KEY env and no keypair file at ${path}`); process.exit(1); }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
const lender = loadLender();
const connection = new Connection(RPC, "confirmed");
const idl = JSON.parse(readFileSync(idlPath, "utf8")); idl.address = pid;
const programId = new PublicKey(pid);
const program = new Program(idl, new AnchorProvider(connection, new Wallet(lender), { commitment: "confirmed" }));

const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool"), lender.publicKey.toBuffer()], programId);
const [loanTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("loan-token-vault"), pool.toBuffer()], programId);
const [position] = PublicKey.findProgramAddressSync([Buffer.from("position"), pool.toBuffer(), lender.publicKey.toBuffer()], programId);
const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, lender.publicKey);

const U64_MAX = 18_446_744_073_709_551_615n;
const SAFE = U64_MAX / 2n; // 50% headroom under the overflow ceiling

const p0 = await program.account.lendingPool.fetch(pool);
const td = BigInt(p0.totalDeposits.toString());
const ts = BigInt(p0.totalShares.toString());
const pos0 = await program.account.depositorPosition.fetch(position);
const myShares = BigInt(pos0.shares.toString());
const dep0 = BigInt((pos0.depositedAmount ?? pos0.deposited_amount).toString());
const vps = ts > 0n ? Number(td) / Number(ts) : 1;
const targetLamports = BigInt(Math.floor(amountSol * 1e9));
let targetShares = ts > 0n ? (targetLamports * ts) / td : targetLamports;
if (targetShares > myShares) targetShares = myShares;

console.log(`Withdraw ${version.toUpperCase()}${dryRun ? " [DRY RUN]" : ""}:`);
console.log(`  depositor:   ${lender.publicKey.toBase58()}`);
console.log(`  program:     ${pid}`);
console.log(`  pool:        ${pool.toBase58()}`);
console.log(`  your shares: ${(Number(myShares) / 1e9).toFixed(4)}  value/share ${vps.toFixed(6)}`);
console.log(`  target:      ${amountSol} SOL  => burn ~${(Number(targetShares) / 1e9).toFixed(4)} shares  (K=${K} ix/tx)`);

const cuUnits = Math.min(1_400_000, 120_000 + K * 100_000);
async function withdrawIx(shares) {
  return program.methods.withdraw(new BN(shares.toString())).accounts({
    pool, loanTokenVault, position, depositorTokenAccount: wsolAta, depositor: lender.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction();
}
async function buildTx(chunks) {
  const priorityMicroLamports = Number(process.env.WITHDRAW_PRIORITY_MICROLAMPORTS ?? 250_000);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }), // priority fee so txs land in congestion
    createAssociatedTokenAccountIdempotentInstruction(lender.publicKey, wsolAta, lender.publicKey, NATIVE_MINT),
  ];
  for (const c of chunks) ixs.push(await withdrawIx(c));
  ixs.push(createCloseAccountInstruction(wsolAta, lender.publicKey, lender.publicKey));
  const tx = new Transaction().add(...ixs);
  tx.feePayer = lender.publicKey;
  return tx;
}
function planChunks(depNow, remaining) {
  const maxChunk = depNow > 0n ? SAFE / depNow : remaining;
  const chunks = []; let rem = remaining;
  for (let i = 0; i < K && rem > 0n; i++) { const c = maxChunk < rem ? maxChunk : rem; if (c <= 0n) break; chunks.push(c); rem -= c; }
  return chunks;
}

if (dryRun) {
  let depLocal = dep0, remaining = targetShares, txNo = 0, firstErr = null;
  while (remaining > 0n && txNo < 300) {
    const chunks = planChunks(depLocal, remaining);
    if (!chunks.length) break;
    const sum = chunks.reduce((a, b) => a + b, 0n);
    txNo++;
    if (txNo === 1) {
      const tx = await buildTx(chunks);
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sim = await connection.simulateTransaction(tx);
      firstErr = sim.value.err;
      console.log(`  tx#1: ${chunks.length} chunks ~${(Number(sum) / 1e9 * vps).toFixed(3)} SOL, sim err: ${JSON.stringify(sim.value.err)}`);
      if (sim.value.err) { console.log((sim.value.logs || []).slice(-8).join("\n")); process.exit(1); }
    }
    remaining -= sum; depLocal -= sum;
  }
  console.log(`\n[DRY RUN OK] ~${amountSol} SOL withdrawable across ~${txNo} transaction(s). Re-run with --execute.`);
  process.exit(firstErr ? 1 : 0);
}

// ── EXECUTE ──
let remaining = targetShares, txNo = 0; const sigs = [];
while (remaining > 0n) {
  const pos = await program.account.depositorPosition.fetch(position);
  const dep = BigInt((pos.depositedAmount ?? pos.deposited_amount).toString());
  const posShares = BigInt(pos.shares.toString());
  if (posShares === 0n || dep === 0n) break;
  const rem = remaining < posShares ? remaining : posShares;
  const chunks = planChunks(dep, rem);
  if (!chunks.length) break;
  const sum = chunks.reduce((a, b) => a + b, 0n);
  txNo++;
  const tx = await buildTx(chunks);
  const sig = await sendAndConfirmTransaction(connection, tx, [lender], { commitment: "confirmed", maxRetries: 3 });
  sigs.push(sig);
  console.log(`  tx#${txNo}: ${chunks.length} chunks ~${(Number(sum) / 1e9 * vps).toFixed(3)} SOL  ✓ ${sig.slice(0, 20)}…`);
  remaining -= sum;
  if (txNo > 80) { console.error("safety stop: >80 txs"); break; }
}
const pEnd = await program.account.lendingPool.fetch(pool);
console.log(`\nDone — ${txNo} tx(s). ${version.toUpperCase()} pool now: ${(Number(pEnd.totalDeposits) / 1e9).toFixed(3)} SOL`);
if (sigs.length) console.log(`  last tx: https://solscan.io/tx/${sigs[sigs.length - 1]}`);
process.exit(0);
