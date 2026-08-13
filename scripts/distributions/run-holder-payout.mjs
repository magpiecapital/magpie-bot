// GUARDED holder-rewards payout for a captured distribution (snapshot_pending → paid).
// Safe to re-run: retryAccruedPayouts() is idempotent (only pays 'accrued' rows).
//
// SECURITY GUARDS (all must pass before any SOL moves):
//   1. Force the distributor key = the CHCAM MGP-001 sender (never the LENDER fallback).
//   2. Assert the resolved signer pubkey === CHCAM, else ABORT.
//   3. Assert NO 'accrued' rows exist outside the target distribution, else ABORT
//      (prevents accidentally paying a stale/foreign batch).
//
// Usage (operator, harness blocks the send so run via `!`):
//   ! cd ~/bagbank-bot && DIST_ID=5 railway run --service magpie-bot node run-holder-payout.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const CHCAM = "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac";
const DIST_ID = Number(process.env.DIST_ID);
if (!Number.isInteger(DIST_ID) || DIST_ID <= 0) {
  console.error("ABORT: set DIST_ID env to the target distribution id (e.g. DIST_ID=5)");
  process.exit(1);
}

// ── Guard 1: load the CHCAM key and force it as the distributor (BEFORE importing services,
// so getRewardsDistributorKeypair() caches the CHCAM key, not the LENDER fallback). ──
const keyPath = path.join(os.homedir(), ".magpie-private", "distribution-keypairs", "MGP-001-sender.json");
if (!fs.existsSync(keyPath)) {
  console.error("ABORT: CHCAM distributor key not found at", keyPath);
  process.exit(1);
}
const bs58 = (await import("bs58")).default;
const secretBytes = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")));
process.env.REWARDS_DISTRIBUTOR_PRIVATE_KEY = bs58.encode(secretBytes);

const { getRewardsDistributorKeypair } = await import("../../src/services/distributor-keypair.js");
const distributor = getRewardsDistributorKeypair();
const signer = distributor.publicKey.toBase58();

// ── Guard 2: signer MUST be CHCAM ──
if (signer !== CHCAM) {
  console.error(`ABORT: distributor signer ${signer} !== CHCAM ${CHCAM}. Refusing to pay from the wrong wallet.`);
  process.exit(1);
}
console.log("✓ distributor signer verified:", signer, "(CHCAM)");

const { query, pool: dbPool } = await import("../../src/db/pool.js");

// ── Guard 3: no 'accrued' rows may exist outside DIST_ID ──
const stray = await query(
  "SELECT COUNT(*)::int n FROM magpie_holder_rewards WHERE status = 'accrued' AND distribution_id <> $1",
  [DIST_ID],
);
if (stray.rows[0].n > 0) {
  console.error(`ABORT: ${stray.rows[0].n} 'accrued' row(s) exist outside dist ${DIST_ID}. Resolve them first.`);
  process.exit(1);
}

// Target-distribution pending rows
const pend = await query(
  "SELECT COUNT(*)::int n, COALESCE(SUM(reward_lamports),0)::text s FROM magpie_holder_rewards WHERE status = 'snapshot_pending' AND distribution_id = $1",
  [DIST_ID],
);
const pendCount = pend.rows[0].n;
const pendSum = BigInt(pend.rows[0].s);
if (pendCount === 0 || pendSum <= 0n) {
  // Idempotent re-run: nothing pending, maybe already flipped/paid — fall through to retry sweep.
  console.log(`No snapshot_pending rows for dist ${DIST_ID} (already flipped? continuing to retry sweep).`);
} else {
  console.log(`dist ${DIST_ID}: ${pendCount} pending rows, ${(Number(pendSum) / 1e9).toFixed(6)} SOL`);

  // ── Flip snapshot_pending → accrued + decrement pool (atomic), mirroring the
  // normal auto-pay path (relative decrement preserves concurrent accruals). ──
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    // Lock the pending rows under the transaction (no aggregate — Postgres
    // rejects FOR UPDATE + SUM), then sum in JS to avoid TOCTOU.
    const { rows: lockedRows } = await client.query(
      "SELECT reward_lamports FROM magpie_holder_rewards WHERE status = 'snapshot_pending' AND distribution_id = $1 FOR UPDATE",
      [DIST_ID],
    );
    const flipSum = lockedRows.reduce((acc, r) => acc + BigInt(r.reward_lamports), 0n);
    const live = { n: lockedRows.length, s: flipSum.toString() };
    await client.query(
      "UPDATE magpie_holder_rewards SET status = 'accrued' WHERE status = 'snapshot_pending' AND distribution_id = $1",
      [DIST_ID],
    );
    await client.query(
      `UPDATE magpie_holder_pool
          SET accrued_lamports = accrued_lamports - $1::numeric,
              last_distribution_at = NOW(),
              next_distribution_at = NOW() + interval '30 days',
              updated_at = NOW()
        WHERE id = 1`,
      [flipSum.toString()],
    );
    await client.query("COMMIT");
    console.log(`✓ flipped ${live.n} rows to 'accrued', pool decremented by ${(Number(flipSum) / 1e9).toFixed(6)} SOL`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    console.error("ABORT: flip/decrement failed:", err.message);
    process.exit(1);
  }
  client.release();
}

/**
 * Mark rows Solana physically cannot pay: the transfer would leave an EMPTY
 * recipient account below the rent-exempt minimum. Returns how many were
 * marked. Never guesses — an RPC failure marks nothing.
 */
const RENT_MIN = 890_880;
let triedRentHeal = false;
async function markUnpayableRentExempt(distId) {
  const rpc = process.env.HELIUS_RPC_URL || process.env.RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpc) { console.error("  (no RPC configured — cannot assess payability; marking nothing)"); return 0; }
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const conn = new Connection(rpc, "confirmed");
  const { rows } = await query(
    `SELECT wallet_address, reward_lamports FROM magpie_holder_rewards
      WHERE distribution_id = $1 AND status = 'accrued' AND reward_lamports < ${RENT_MIN}`,
    [distId],
  );
  if (rows.length === 0) return 0;
  const unpayable = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    let infos;
    try {
      infos = await conn.getMultipleAccountsInfo(chunk.map((r) => new PublicKey(r.wallet_address)));
    } catch (e) {
      console.error(`  (RPC failed mid-assessment: ${e.message} — marking nothing)`);
      return 0;
    }
    infos.forEach((info, j) => {
      const bal = info?.lamports ?? 0;
      if (bal + Number(chunk[j].reward_lamports) < RENT_MIN) unpayable.push(chunk[j].wallet_address);
    });
  }
  if (unpayable.length === 0) return 0;
  const res = await query(
    `UPDATE magpie_holder_rewards SET status = 'unpayable_rent_exempt'
      WHERE distribution_id = $1 AND status = 'accrued' AND wallet_address = ANY($2)`,
    [distId, unpayable],
  );
  return res.rowCount;
}

// ── Pay: loop retryAccruedPayouts() until drained (LIMIT 200/call). ──
const { retryAccruedPayouts } = await import("../../src/services/magpie-holder-rewards.js");
let totalPaid = 0;
for (let iter = 1; iter <= 30; iter++) {
  const r = await retryAccruedPayouts();
  totalPaid += r.paid || 0;
  console.log(`[iter ${iter}] retried=${r.retried} paid=${r.paid}${r.skipped ? ` skipped=${r.skipped}` : ""} (cumulative paid=${totalPaid})`);
  if (r.skipped) { console.error("STOP: distributor balance too low — top up CHCAM and re-run."); break; }
  if (!r.retried || r.retried === 0) break;      // nothing left
  if (r.paid === 0) {
    // ── Rent-exempt self-heal (added after dist #9, 2026-08-13) ──────────
    // Solana refuses a transfer that would leave an account below the
    // rent-exempt minimum (~0.00089 SOL). Payouts batch 10 per transaction and
    // a transaction fails ATOMICALLY, so ONE unpayable recipient kills the
    // other nine. Once the pool shrank below that floor, 94% of dist #9's
    // rewards were sub-minimum and the run stalled at 10 of 1433 — it took a
    // manual side-script to unblock, mid-distribution.
    //
    // Only EMPTY accounts are actually blocked; a funded wallet accepts any
    // amount. So on a fully-failed pass, check the remaining rows on-chain,
    // mark the genuinely-unpayable ones, and continue paying the rest. Rows
    // are marked (not deleted) so the outcome stays auditable and reversible.
    if (!triedRentHeal) {
      triedRentHeal = true;
      console.error("A full pass failed — checking whether rent-exempt recipients are blocking the batches…");
      const healed = await markUnpayableRentExempt(DIST_ID);
      if (healed > 0) {
        console.error(`Marked ${healed} row(s) unpayable_rent_exempt (empty accounts below the rent minimum). Continuing.`);
        continue;
      }
      console.error("No rent-blocked rows found — the failure is something else.");
    }
    console.error("STOP: a batch failed with 0 paid this pass — inspect logs.");
    break;
  }
}

// Final tally
const done = await query(
  "SELECT status, COUNT(*)::int n, COALESCE(SUM(reward_lamports),0)::text s FROM magpie_holder_rewards WHERE distribution_id = $1 GROUP BY status ORDER BY status",
  [DIST_ID],
);
console.log(`\n── dist ${DIST_ID} final status ──`);
for (const row of done.rows) {
  console.log(`  ${row.status}: ${row.n} rows, ${(Number(row.s) / 1e9).toFixed(6)} SOL`);
}
console.log(`\nTotal paid this run: ${totalPaid} rows.`);
process.exit(0);
