/**
 * Mark holder-reward rows that CANNOT be paid because the transfer would leave
 * the recipient's account below Solana's rent-exempt minimum.
 *
 * WHY THIS EXISTS (dist #9, 2026-08-13). The holder pool shrank to 0.3947 SOL
 * spread over 1,433 eligible holders — an average reward of 0.000275 SOL, about
 * a THIRD of the 0.00089088 SOL rent-exempt minimum. 94% of rewards are below
 * that minimum.
 *
 * A sub-minimum transfer is only impossible when the recipient's account is
 * empty; a funded wallet can receive any amount. But `retryAccruedPayouts()`
 * batches 10 transfers per transaction, and a transaction fails ATOMICALLY, so
 * ONE unpayable recipient kills the other nine. At 94% sub-minimum, nearly every
 * batch contained one and the payout stalled after 10 of 1,433.
 *
 * This is the same failure the runbook documents for the LP pool, where the fix
 * is to mark sub-rent rows `unpayable_rent_exempt` and pay the rest. `LP` has
 * used that status since dist #25; the holder table has no CHECK constraint, so
 * the same value applies cleanly.
 *
 * MOVES NO SOL. It only reclassifies rows so the guarded payout script can make
 * progress. Run `run-holder-payout.mjs` afterwards to pay the remainder.
 *
 * DRY RUN BY DEFAULT — pass --write to apply.
 *
 *   DIST_ID=9 railway run --service magpie-bot node mark-unpayable-rent-exempt.mjs
 *   DIST_ID=9 railway run --service magpie-bot node mark-unpayable-rent-exempt.mjs --write
 */
import { query } from "../../src/db/pool.js";
import { Connection, PublicKey } from "@solana/web3.js";

/** Rent-exempt minimum for a 0-data System account. */
const RENT_MIN = 890_880;

const WRITE = process.argv.includes("--write");
const DIST_ID = Number(process.env.DIST_ID);
if (!Number.isInteger(DIST_ID) || DIST_ID <= 0) {
  console.error("ABORT: set DIST_ID (e.g. DIST_ID=9)");
  process.exit(1);
}

const rpc =
  process.env.HELIUS_RPC_URL || process.env.RPC_URL || process.env.SOLANA_RPC_URL;
if (!rpc) {
  console.error("ABORT: no RPC configured — refusing to judge payability blind");
  process.exit(1);
}
const conn = new Connection(rpc, "confirmed");

const { rows } = await query(
  `SELECT wallet_address, reward_lamports
     FROM magpie_holder_rewards
    WHERE distribution_id = $1 AND status = 'accrued'`,
  [DIST_ID],
);
console.log(`dist ${DIST_ID}: ${rows.length} accrued row(s) to assess`);
if (rows.length === 0) process.exit(0);

const unpayable = [];
let payable = 0;
for (let i = 0; i < rows.length; i += 100) {
  const chunk = rows.slice(i, i + 100);
  let infos;
  try {
    infos = await conn.getMultipleAccountsInfo(chunk.map((r) => new PublicKey(r.wallet_address)));
  } catch (e) {
    // Never guess. An RPC failure must not cause a row to be written off.
    console.error(`ABORT: RPC failed mid-assessment (${e.message}). Nothing written.`);
    process.exit(1);
  }
  infos.forEach((info, j) => {
    const bal = info?.lamports ?? 0;
    const reward = Number(chunk[j].reward_lamports);
    // Payable iff the account ends at or above the rent-exempt minimum.
    if (bal + reward >= RENT_MIN) payable++;
    else unpayable.push({ wallet: chunk[j].wallet_address, reward, bal });
  });
}

const forfeited = unpayable.reduce((a, r) => a + r.reward, 0);
console.log(`  payable:   ${payable}`);
console.log(`  unpayable: ${unpayable.length}  (${(forfeited / 1e9).toFixed(6)} SOL)`);
console.log(
  `  NOTE: this SOL stays in CHCAM and is CARRIED FORWARD to the holder's next payout (migration 102) — the pool was already decremented at accrual, so it is never charged twice.`,
);

if (!WRITE) {
  console.log("\nDRY RUN — nothing written. Re-run with --write to apply.");
  process.exit(0);
}
if (unpayable.length === 0) {
  console.log("nothing to mark");
  process.exit(0);
}

// Mark in one statement, scoped to this distribution and to rows still accrued,
// so a concurrent payout that just succeeded cannot be clobbered.
const wallets = unpayable.map((r) => r.wallet);
const res = await query(
  `UPDATE magpie_holder_rewards
      SET status = 'unpayable_rent_exempt'
    WHERE distribution_id = $1
      AND status = 'accrued'
      AND wallet_address = ANY($2)`,
  [DIST_ID, wallets],
);
console.log(`✓ marked ${res.rowCount} row(s) unpayable_rent_exempt`);

// CARRY FORWARD (migration 102). Writing these off means the holder never
// receives them AND the same wallet fails again every cycle, because the amount
// is always too small. Accumulating instead means it eventually clears the rent
// floor — or their wallet gets funded, at which point any amount sends.
//
// The full reward_lamports carries, which already includes any balance carried
// in from previous cycles (capture folds carry into the reward), so this
// accumulates correctly rather than compounding.
const carried = await query(
  `INSERT INTO magpie_holder_carryforward (wallet_address, lamports, cycles)
   SELECT wallet_address, reward_lamports, 1
     FROM magpie_holder_rewards
    WHERE distribution_id = $1 AND status = 'unpayable_rent_exempt'
      AND wallet_address = ANY($2)
   ON CONFLICT (wallet_address) DO UPDATE
     SET lamports   = EXCLUDED.lamports,
         cycles     = magpie_holder_carryforward.cycles + 1,
         updated_at = NOW()`,
  [DIST_ID, wallets],
);
const { rows: owed } = await query(
  `SELECT COUNT(*)::int n, COALESCE(SUM(lamports),0)::text total FROM magpie_holder_carryforward WHERE lamports > 0`,
);
console.log(`✓ carried forward for ${carried.rowCount} wallet(s)`);
console.log(`  outstanding carry: ${owed[0].n} wallet(s), ${(Number(owed[0].total)/1e9).toFixed(9)} SOL — paid from CHCAM next cycle`);
console.log(`Next: DIST_ID=${DIST_ID} railway run --service magpie-bot node run-holder-payout.mjs`);
process.exit(0);
