#!/usr/bin/env node
/**
 * Execute LP loyalty distribution from the lp_loyalty_rewards table.
 *
 * Sends single-tx per LP (no batching) since there are only ~37 LPs
 * and a single bad recipient shouldn't poison the rest. Skips rows
 * where reward_lamports < 1000 (sub-µSOL dust).
 *
 * Usage:
 *   SENDER_KEYPAIR=/path/to/lp-loyalty-sender.json \
 *   SOLANA_RPC_URL=https://… \
 *     node scripts/execute-lp-loyalty-distribution.js <distribution_id>            # dry-run (default)
 *     node scripts/execute-lp-loyalty-distribution.js <distribution_id> \
 *       --execute --confirm "I understand this is irreversible"                    # actually send
 */

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import pg from "pg";
import "dotenv/config";

const args = process.argv.slice(2);
const distId = args[0];
if (!distId || !/^\d+$/.test(distId)) {
  console.error("Usage: node scripts/execute-lp-loyalty-distribution.js <distribution_id> [--execute --confirm \"I understand this is irreversible\"]");
  process.exit(1);
}
const EXECUTE = args.includes("--execute");
const confirmFlagIdx = args.indexOf("--confirm");
const CONFIRM_STRING = confirmFlagIdx >= 0 ? args[confirmFlagIdx + 1] : null;
const REQUIRED_CONFIRM = "I understand this is irreversible";
if (EXECUTE && CONFIRM_STRING !== REQUIRED_CONFIRM) {
  console.error(`--execute requires --confirm "${REQUIRED_CONFIRM}" exactly. Aborting.`);
  process.exit(1);
}
const DRY_RUN = !EXECUTE;
// Heuristic: txn failure messages that indicate the recipient wallet is
// genuinely below rent-exempt — versus transient RPC / network failures.
// Used to gate which 'pending' rows get permanently marked unpayable.
const RENT_EXEMPT_REGEX = /rent[\s_-]*exempt|insufficient funds for rent|account requires.*lamports/i;

const keypairPath = process.env.SENDER_KEYPAIR;
if (!keypairPath) {
  console.error("SENDER_KEYPAIR env var not set");
  process.exit(1);
}

const senderRaw = JSON.parse(readFileSync(keypairPath, "utf8"));
const sender = Keypair.fromSecretKey(new Uint8Array(senderRaw));
console.log("LP loyalty sender:", sender.publicKey.toBase58());

const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpcUrl, "confirmed");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTER_TX_DELAY_MS = Math.max(0, Number(process.env.INTER_TX_DELAY_MS) || 600);
const MIN_PAYOUT_LAMPORTS = 1000n;

const { rows } = await pool.query(
  `SELECT wallet_address, reward_lamports::text AS lamports
     FROM lp_loyalty_rewards
    WHERE distribution_id = $1 AND status = 'pending'
    ORDER BY reward_lamports DESC`,
  [distId],
);

const work = rows
  .map((r) => ({ wallet: r.wallet_address, lamports: BigInt(r.lamports) }))
  .filter((w) => w.lamports >= MIN_PAYOUT_LAMPORTS);

const skippedDust = rows.length - work.length;
console.log(`LP recipients pending : ${rows.length}`);
console.log(`Skipped sub-µSOL dust : ${skippedDust}`);
console.log(`To pay                : ${work.length}`);
const total = work.reduce((a, w) => a + w.lamports, 0n);
console.log(`Total SOL to send     : ${(Number(total) / 1e9).toFixed(9)} SOL`);

const balance = await connection.getBalance(sender.publicKey);
console.log(`Sender balance        : ${(balance / 1e9).toFixed(6)} SOL`);
console.log(`Mode                  : ${DRY_RUN ? "DRY-RUN (no sends)" : "EXECUTE"}`);

if (DRY_RUN) {
  console.log("");
  console.log("Dry-run — no transactions sent. Re-run with:");
  console.log(`  --execute --confirm "${REQUIRED_CONFIRM}"`);
  await pool.end();
  process.exit(0);
}

let succeeded = 0;
let failed = 0;
const stillFailed = [];

for (let i = 0; i < work.length; i++) {
  const { wallet, lamports } = work[i];
  process.stdout.write(
    `  ${i + 1}/${work.length}  ${wallet.slice(0, 8)}…${wallet.slice(-4)}  ${(Number(lamports) / 1e9).toFixed(9)} SOL  `,
  );
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: new PublicKey(wallet),
      lamports: lamports,
    }),
  );
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [sender], {
      commitment: "confirmed",
    });
    await pool.query(
      `UPDATE lp_loyalty_rewards
          SET paid_tx_signature = $1, paid_at = NOW(), status = 'paid'
        WHERE distribution_id = $2 AND wallet_address = $3`,
      [sig, distId, wallet],
    );
    succeeded++;
    console.log(`✓ ${sig.slice(0, 16)}…`);
  } catch (err) {
    failed++;
    const reason = (err.message || String(err)).slice(0, 300);
    stillFailed.push({ wallet, lamports: lamports.toString(), reason });
    // Distinguish a true rent-exempt failure (permanent — wallet not initialized)
    // from a transient RPC / network error. Permanently marking a transient
    // failure as 'unpayable' would burn a recoverable allocation forever.
    const isRentExempt = RENT_EXEMPT_REGEX.test(reason);
    await pool.query(
      `UPDATE lp_loyalty_rewards
          SET status = $1, failure_reason = $2
        WHERE distribution_id = $3 AND wallet_address = $4`,
      [isRentExempt ? "unpayable_rent_exempt" : "failed", reason, distId, wallet],
    );
    console.log(`FAIL ${reason.slice(0, 70)}`);
  }
  if (i + 1 < work.length) await sleep(INTER_TX_DELAY_MS);
}

// Mark sub-dust pending rows (those that were never in the work loop because
// reward_lamports < MIN_PAYOUT_LAMPORTS) as unpayable. Rows that genuinely
// failed in the loop above have already been written with the correct status
// — either 'failed' (transient) or 'unpayable_rent_exempt' (permanent) — so
// they won't be touched by this final sweep.
const skippedRes = await pool.query(
  `UPDATE lp_loyalty_rewards
      SET status = 'unpayable_rent_exempt',
          failure_reason = COALESCE(failure_reason, 'sub_dust_below_min_payout')
    WHERE distribution_id = $1
      AND status = 'pending'
      AND reward_lamports < $2
    RETURNING wallet_address`,
  [distId, MIN_PAYOUT_LAMPORTS.toString()],
);

console.log("");
console.log("─── LP loyalty distribution complete ───");
console.log(`Succeeded                  : ${succeeded}`);
console.log(`Still failing              : ${failed}`);
console.log(`Marked unpayable (zero/dust): ${skippedRes.rowCount}`);
if (stillFailed.length > 0) {
  console.log("");
  console.log("Still-failing recipients:");
  for (const f of stillFailed) {
    console.log(`  ${f.wallet}  ${(Number(f.lamports) / 1e9).toFixed(9)} SOL`);
  }
}

await pool.end();
process.exit(0);
