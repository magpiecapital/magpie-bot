// GUARDED LP-loyalty payout: capture → batched pay → straggler sweep → rent-exempt finish.
// Mirrors run-holder-payout.mjs security guards. Idempotent-ish: safe to re-run (only touches
// 'accrued' rows; already-paid rows are untouched; sub-rent rows become 'unpayable_rent_exempt').
//
// GUARDS (all must pass before any SOL moves):
//   1. Force distributor key = CHCAM MGP-001 sender (never the LENDER fallback).
//   2. Assert resolved signer pubkey === CHCAM, else ABORT.
//
// Usage: ! cd ~/bagbank-bot && railway run --service magpie-bot node run-lp-payout.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

const CHCAM = "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac";

// ── Guard 1: load CHCAM key and force it as the distributor BEFORE importing services ──
const keyPath = path.join(os.homedir(), ".magpie-private", "distribution-keypairs", "MGP-001-sender.json");
if (!fs.existsSync(keyPath)) { console.error("ABORT: CHCAM key not found at", keyPath); process.exit(1); }
const bs58 = (await import("bs58")).default;
const secretBytes = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")));
process.env.REWARDS_DISTRIBUTOR_PRIVATE_KEY = bs58.encode(secretBytes);

const { getRewardsDistributorKeypair } = await import("../../src/services/distributor-keypair.js");
const distributor = getRewardsDistributorKeypair();
const signer = distributor.publicKey.toBase58();
// ── Guard 2: signer MUST be CHCAM ──
if (signer !== CHCAM) { console.error(`ABORT: signer ${signer} !== CHCAM. Refusing to pay from wrong wallet.`); process.exit(1); }
console.log("✓ distributor signer verified:", signer, "(CHCAM)");

const { query } = await import("../../src/db/pool.js");
const lp = await import("../../src/services/lp-loyalty.js");
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");

// Pool state before
const st0 = await lp.getLpLoyaltyPoolState();
console.log(`LP pool accrued before: ${(Number(st0.accrued_lamports) / 1e9).toFixed(6)} SOL`);

// ── Capture + first-pass batched payout ──
const res = await lp.snapshotAndDistributeLpLoyalty();
if (res) {
  console.log(`captured dist ${res.distribution_id}: ${res.eligible_count} eligible, allocated ${(Number(res.allocated_lamports)/1e9).toFixed(6)} SOL, first-pass paid ${res.paid_count}`);
} else {
  console.log("snapshotAndDistributeLpLoyalty returned null (pool below min / no eligible / already captured) — sweeping any accrued stragglers.");
}

// ── Sweep accrued stragglers in batches ──
for (let iter = 1; iter <= 30; iter++) {
  const r = await lp.retryAccruedLpLoyaltyPayouts();
  console.log(`[retry ${iter}] retried=${r.retried} paid=${r.paid}${r.skipped ? ` skipped=${r.skipped}` : ""}`);
  if (r.skipped) { console.error("STOP: CHCAM balance too low — top up and re-run."); break; }
  if (!r.retried) break;
  if (r.paid === 0) break; // remaining are batch-blocked (likely rent-exempt) → handle below
}

// ── Rent-exempt finish: pay remaining 'accrued' ONE-per-tx; mark truly-unpayable ones ──
const rentMin = await conn.getMinimumBalanceForRentExemption(0);
const { rows: rem } = await query("SELECT id, wallet_address, reward_lamports FROM lp_loyalty_rewards WHERE status = 'accrued' ORDER BY id ASC");
console.log(`\n${rem.length} straggler(s) remaining → per-tx finish (rent-exempt min ${(rentMin/1e9).toFixed(6)} SOL)`);
let finished = 0, unpayable = 0;
for (const r of rem) {
  const reward = BigInt(r.reward_lamports);
  let recipBal;
  try { recipBal = BigInt(await conn.getBalance(new PublicKey(r.wallet_address))); } catch { recipBal = 0n; }
  // If the recipient is empty AND the reward can't lift it to rent-exempt, it's unpayable (SOL stays in CHCAM).
  if (recipBal === 0n && reward < BigInt(rentMin)) {
    await query("UPDATE lp_loyalty_rewards SET status = 'unpayable_rent_exempt' WHERE id = $1", [r.id]);
    unpayable++;
    continue;
  }
  try {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: distributor.publicKey, toPubkey: new PublicKey(r.wallet_address), lamports: reward }));
    const sig = await sendAndConfirmTransaction(conn, tx, [distributor], { commitment: "confirmed" });
    await query("UPDATE lp_loyalty_rewards SET status = 'paid', paid_at = NOW(), paid_tx_signature = $2 WHERE id = $1", [r.id, sig]);
    finished++;
  } catch (err) {
    // Single-tx still failed with a fundable reward → likely rent-exempt on an empty account; mark unpayable.
    if (recipBal === 0n) { await query("UPDATE lp_loyalty_rewards SET status = 'unpayable_rent_exempt' WHERE id = $1", [r.id]); unpayable++; }
    else console.error(`  row ${r.id} (${r.wallet_address.slice(0,6)}…) failed:`, err.message.slice(0, 80));
  }
}
console.log(`per-tx finish: ${finished} paid, ${unpayable} marked unpayable_rent_exempt`);

// ── Final tally for the newest LP distribution ──
const { rows: last } = await query("SELECT id FROM lp_loyalty_distributions ORDER BY id DESC LIMIT 1");
const distId = last[0]?.id;
const { rows: tally } = await query("SELECT status, COUNT(*)::int n, COALESCE(SUM(reward_lamports),0)::text s FROM lp_loyalty_rewards WHERE distribution_id = $1 GROUP BY status ORDER BY status", [distId]);
console.log(`\n── LP dist ${distId} final status ──`);
for (const row of tally) console.log(`  ${row.status}: ${row.n} rows, ${(Number(row.s) / 1e9).toFixed(6)} SOL`);
process.exit(0);
