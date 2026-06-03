/**
 * LP Loyalty Bonus Pool.
 *
 * Mechanic:
 *   - 2% of every loan fee accrues to the lp_loyalty_pool (source: the
 *     protocol's 5% slice — LPs keep their full 80% base yield).
 *   - Each LP's "weight" at snapshot time = current shares × seconds
 *     since their weighted_deposit_at (the time-weighted average of
 *     their deposit moments).
 *   - Pool is distributed pro-rata to weight.
 *   - Net effect: an LP who held 100 shares for 7 days earns ~7x more
 *     loyalty than someone who held 100 shares for 1 day. Pure
 *     flippers (held minutes) earn near-zero from this stream.
 *
 * Architecture mirrors src/services/magpie-holder-rewards.js so the
 * distribution + retry + payout patterns are the same battle-tested code.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { connection } from "../solana/connection.js";
import { getReadOnlyProgram } from "../solana/program.js";
import { lendingPoolPda } from "../solana/pdas.js";
import { query } from "../db/pool.js";

export const LP_LOYALTY_REWARD_BPS = 200; // 2% of every loan fee
export const MIN_LP_LOYALTY_CLAIM_LAMPORTS = 5_000_000n; // 0.005 SOL
export const MIN_LP_DISTRIBUTION_LAMPORTS = 10_000_000n; // 0.01 SOL (don't run dust distributions)
export const MIN_LENDER_RESERVE_LAMPORTS = 100_000_000n; // 0.1 SOL ops floor
export const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);

// Random window between distributions (matches $MAGPIE holder cadence).
const DIST_WINDOW_MIN_MS = 5 * 24 * 60 * 60 * 1000;
const DIST_WINDOW_MAX_MS = 10 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 10; // Transfer ixs per tx

function pickNextDistributionDelay() {
  return DIST_WINDOW_MIN_MS + Math.random() * (DIST_WINDOW_MAX_MS - DIST_WINDOW_MIN_MS);
}

function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) return Keypair.fromSecretKey(bs58.decode(b58));
  const kpPath = process.env.LENDER_KEYPAIR_PATH || path.resolve("lender-keypair.json");
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * Hook called on every loan fee event. Accrues 2% of the fee to the
 * loyalty pool. Idempotent NOT guaranteed — caller must ensure they
 * call once per fee event (recordLoan + executeExtendLoan handle this).
 */
export async function accrueToLpLoyaltyPool(feeLamports) {
  const fee = BigInt(feeLamports);
  if (fee <= 0n) return null;
  const reward = (fee * BigInt(LP_LOYALTY_REWARD_BPS)) / 10_000n;
  if (reward <= 0n) return null;
  try {
    await query(
      `UPDATE lp_loyalty_pool
          SET accrued_lamports = (accrued_lamports::numeric + $1::numeric)::text,
              updated_at = NOW()
        WHERE id = 1`,
      [reward.toString()],
    );
    return reward;
  } catch (err) {
    console.error("[lp-loyalty] accrual failed:", err.message);
    return null;
  }
}

/**
 * Read current accrued pool size + scheduling state. Operator-private —
 * never expose next_distribution_at via public APIs (same anti-dump
 * pattern as $MAGPIE holders).
 */
export async function getLpLoyaltyPoolState() {
  try {
    const r = await query(`SELECT * FROM lp_loyalty_pool WHERE id = 1`);
    if (r.rows.length === 0) {
      return { accrued_lamports: 0n, last_distribution_at: null, next_distribution_at: null };
    }
    return {
      accrued_lamports: BigInt(r.rows[0].accrued_lamports ?? "0"),
      last_distribution_at: r.rows[0].last_distribution_at ?? null,
      next_distribution_at: r.rows[0].next_distribution_at ?? null,
    };
  } catch {
    return { accrued_lamports: 0n, last_distribution_at: null, next_distribution_at: null };
  }
}

/**
 * Sync on-chain depositor positions into the lp_positions DB table.
 *
 * For each on-chain DepositorPosition:
 *   - If new: insert with first_seen_at = NOW(), weighted_deposit_at = NOW()
 *   - If shares increased (new deposit): advance weighted_deposit_at
 *     proportionally toward NOW(). Formula:
 *
 *       new_weighted_time = (old_shares × old_time + added × NOW) / new_shares
 *
 *     This time-weights the deposit moment correctly. A user who added 50%
 *     more shares right before snapshot won't get full credit for the new
 *     half — their effective deposit time moves halfway toward now.
 *   - If shares decreased (withdrew): keep weighted_deposit_at as-is
 *     (they're reducing their position, not resetting their loyalty clock).
 *   - If shares == 0: clear the row (fully exited).
 *
 * Called on every distribution tick (every 6h) so the DB stays in sync
 * without needing real-time event subscriptions.
 */
export async function syncOnChainPositions() {
  const program = getReadOnlyProgram();
  const [poolPda] = lendingPoolPda(LENDER_PUBKEY);

  // Enumerate all depositor positions
  const positions = await program.account.depositorPosition.all([
    { memcmp: { offset: 8, bytes: poolPda.toBase58() } }, // pool field is right after discriminator
  ]);

  const onChainByOwner = new Map();
  for (const p of positions) {
    const owner = p.account.owner.toBase58();
    const shares = BigInt(p.account.shares.toString());
    if (shares > 0n) onChainByOwner.set(owner, shares);
  }

  // Pull current DB state
  const { rows: dbRows } = await query(`SELECT * FROM lp_positions WHERE shares > 0`);
  const dbByOwner = new Map(
    dbRows.map((r) => [r.wallet_address, { shares: BigInt(r.shares), weightedAt: r.weighted_deposit_at }]),
  );

  // Reconcile
  for (const [owner, onChainShares] of onChainByOwner) {
    const dbEntry = dbByOwner.get(owner);
    if (!dbEntry) {
      // New position
      await query(
        `INSERT INTO lp_positions (wallet_address, shares, weighted_deposit_at, first_seen_at, last_synced_at)
         VALUES ($1, $2, NOW(), NOW(), NOW())
         ON CONFLICT (wallet_address) DO UPDATE SET
           shares = EXCLUDED.shares,
           weighted_deposit_at = NOW(),
           first_seen_at = lp_positions.first_seen_at,
           last_synced_at = NOW()`,
        [owner, onChainShares.toString()],
      );
    } else if (onChainShares > dbEntry.shares) {
      // Net deposit — advance weighted_deposit_at proportionally
      // new_time = (old_shares × old_time + added × NOW) / new_shares
      const added = onChainShares - dbEntry.shares;
      await query(
        `UPDATE lp_positions
            SET shares = $2,
                weighted_deposit_at = TO_TIMESTAMP(
                  ( $3::numeric * EXTRACT(EPOCH FROM weighted_deposit_at)
                  + $4::numeric * EXTRACT(EPOCH FROM NOW()) )
                  / $5::numeric
                ),
                last_synced_at = NOW()
          WHERE wallet_address = $1`,
        [owner, onChainShares.toString(), dbEntry.shares.toString(), added.toString(), onChainShares.toString()],
      );
    } else if (onChainShares < dbEntry.shares) {
      // Net withdraw — keep weighted_deposit_at, just reduce shares
      await query(
        `UPDATE lp_positions
            SET shares = $2,
                last_synced_at = NOW()
          WHERE wallet_address = $1`,
        [owner, onChainShares.toString()],
      );
    } else {
      // No change — just touch last_synced_at
      await query(
        `UPDATE lp_positions SET last_synced_at = NOW() WHERE wallet_address = $1`,
        [owner],
      );
    }
  }

  // Mark fully-exited positions (in DB but not on-chain)
  for (const owner of dbByOwner.keys()) {
    if (!onChainByOwner.has(owner)) {
      await query(
        `UPDATE lp_positions SET shares = 0, last_synced_at = NOW() WHERE wallet_address = $1`,
        [owner],
      );
    }
  }

  return { tracked: onChainByOwner.size, db_rows_seen: dbByOwner.size };
}

/**
 * Snapshot + auto-pay. Computes each LP's weight = shares × seconds
 * since their weighted_deposit_at. Distributes pool pro-rata.
 *
 * Returns null if nothing to distribute, otherwise stats about the run.
 */
export async function snapshotAndDistributeLpLoyalty() {
  const state = await getLpLoyaltyPoolState();
  const pool = state.accrued_lamports;
  if (pool <= 0n) return null;
  if (pool < MIN_LP_DISTRIBUTION_LAMPORTS) {
    console.log(
      `[lp-loyalty] Pool ${Number(pool) / 1e9} SOL below minimum — deferring.`,
    );
    return null;
  }

  // Sync from chain so positions are current
  await syncOnChainPositions();

  // Pre-flight lender balance
  const lender = loadLenderKeypair();
  const lenderBalance = BigInt(await connection.getBalance(lender.publicKey));
  if (lenderBalance < pool + MIN_LENDER_RESERVE_LAMPORTS) {
    console.warn(`[lp-loyalty] Skipped: lender balance too low for pool ${pool}`);
    return null;
  }

  // Pull eligible LPs
  const { rows } = await query(
    `SELECT wallet_address, shares::text AS shares,
            EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at))::bigint AS seconds_held
       FROM lp_positions
      WHERE shares > 0`,
  );
  if (rows.length === 0) return null;

  // Compute weights
  let totalWeight = 0n;
  const items = [];
  for (const r of rows) {
    const shares = BigInt(r.shares);
    const seconds = BigInt(r.seconds_held ?? 0);
    if (seconds <= 0n) continue; // brand-new deposits get no loyalty this round
    const weight = shares * seconds;
    if (weight <= 0n) continue;
    items.push({ wallet: r.wallet_address, shares, seconds, weight });
    totalWeight += weight;
  }
  if (totalWeight === 0n || items.length === 0) return null;

  // Phase 1: insert distribution row + reward rows (transactional)
  const { pool: dbPool } = await import("../db/pool.js");
  let distId;
  let rewardRows = [];
  let allocatedSum = 0n;
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [d] } = await client.query(
      `INSERT INTO lp_loyalty_distributions (snapshot_at, pool_lamports, total_weight, eligible_count)
       VALUES (NOW(), $1, $2, $3)
       RETURNING id`,
      [pool.toString(), totalWeight.toString(), items.length],
    );
    distId = d.id;

    const inserts = [];
    for (const it of items) {
      const reward = (pool * it.weight) / totalWeight;
      if (reward <= 0n) continue;
      inserts.push([distId, it.wallet, it.shares.toString(), it.seconds.toString(), it.weight.toString(), reward.toString()]);
      allocatedSum += reward;
    }

    if (inserts.length > 0) {
      const ph = inserts
        .map((_, i) => `($${i*6+1}, $${i*6+2}, $${i*6+3}, $${i*6+4}, $${i*6+5}, $${i*6+6}, 'accrued')`)
        .join(", ");
      await client.query(
        `INSERT INTO lp_loyalty_rewards
           (distribution_id, wallet_address, shares_at_snapshot, seconds_held, weight, reward_lamports, status)
         VALUES ${ph}`,
        inserts.flat(),
      );
      const { rows: r } = await client.query(
        `SELECT id, wallet_address, reward_lamports FROM lp_loyalty_rewards WHERE distribution_id = $1`,
        [distId],
      );
      rewardRows = r;
    }

    // Atomic decrement of pool + advance next distribution target
    const nextDelay = pickNextDistributionDelay();
    await client.query(
      `UPDATE lp_loyalty_pool
          SET accrued_lamports = (accrued_lamports::numeric - $1::numeric)::text,
              last_distribution_at = NOW(),
              next_distribution_at = NOW() + ($2 || ' milliseconds')::interval,
              updated_at = NOW()
        WHERE id = 1`,
      [allocatedSum.toString(), Math.floor(nextDelay).toString()],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  // Phase 2: batched SOL transfers
  let paidCount = 0;
  let paidLamports = 0n;
  for (let i = 0; i < rewardRows.length; i += BATCH_SIZE) {
    const batch = rewardRows.slice(i, i + BATCH_SIZE);
    const tx = new Transaction();
    for (const r of batch) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: lender.publicKey,
          toPubkey: new PublicKey(r.wallet_address),
          lamports: BigInt(r.reward_lamports),
        }),
      );
    }
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [lender], { commitment: "confirmed" });
      await query(
        `UPDATE lp_loyalty_rewards
            SET status = 'paid', paid_at = NOW(), paid_tx_signature = $2
          WHERE id = ANY($1::bigint[])`,
        [batch.map((r) => r.id), sig],
      );
      paidCount += batch.length;
      paidLamports += batch.reduce((acc, r) => acc + BigInt(r.reward_lamports), 0n);
    } catch (err) {
      console.error("[lp-loyalty] batch payout failed:", err.message);
    }
  }

  return {
    distribution_id: distId,
    pool_lamports: pool,
    eligible_count: rewardRows.length,
    total_weight: totalWeight,
    allocated_lamports: allocatedSum,
    paid_count: paidCount,
    paid_lamports: paidLamports,
  };
}

/**
 * Retry any 'accrued' rewards from prior failed batches.
 */
export async function retryAccruedLpLoyaltyPayouts() {
  const { rows } = await query(
    `SELECT id, wallet_address, reward_lamports
       FROM lp_loyalty_rewards
      WHERE status = 'accrued'
      ORDER BY created_at ASC
      LIMIT 200`,
  );
  if (rows.length === 0) return { retried: 0, paid: 0 };

  const lender = loadLenderKeypair();
  const total = rows.reduce((s, r) => s + BigInt(r.reward_lamports), 0n);
  const bal = BigInt(await connection.getBalance(lender.publicKey));
  if (bal < total + MIN_LENDER_RESERVE_LAMPORTS) return { retried: 0, paid: 0, skipped: rows.length };

  let paid = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const tx = new Transaction();
    for (const r of batch) {
      tx.add(SystemProgram.transfer({
        fromPubkey: lender.publicKey,
        toPubkey: new PublicKey(r.wallet_address),
        lamports: BigInt(r.reward_lamports),
      }));
    }
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [lender], { commitment: "confirmed" });
      await query(
        `UPDATE lp_loyalty_rewards SET status = 'paid', paid_at = NOW(), paid_tx_signature = $2 WHERE id = ANY($1::bigint[])`,
        [batch.map((r) => r.id), sig],
      );
      paid += batch.length;
    } catch (err) {
      console.error("[lp-loyalty] retry batch failed:", err.message);
    }
  }
  return { retried: rows.length, paid };
}

/**
 * Per-wallet loyalty stats — exposed via /api/v1/lp-loyalty?wallet=
 * for the dashboard LP card.
 */
export async function getLpLoyaltyByWallet(walletAddress) {
  if (!walletAddress) return null;

  const [pos, totals] = await Promise.all([
    query(
      `SELECT shares::text AS shares,
              EXTRACT(EPOCH FROM (NOW() - weighted_deposit_at))::bigint AS seconds_held,
              first_seen_at, weighted_deposit_at
         FROM lp_positions WHERE wallet_address = $1`,
      [walletAddress],
    ),
    query(
      `SELECT
         COALESCE(SUM(reward_lamports)::numeric, 0)::text AS lifetime,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN reward_lamports ELSE 0 END)::numeric, 0)::text AS paid,
         COUNT(*) FILTER (WHERE status = 'paid')::int AS distributions_received
       FROM lp_loyalty_rewards WHERE wallet_address = $1`,
      [walletAddress],
    ),
  ]);

  const shares = BigInt(pos.rows[0]?.shares ?? "0");
  const secondsHeld = Number(pos.rows[0]?.seconds_held ?? 0);

  return {
    wallet: walletAddress,
    has_position: shares > 0n,
    shares: shares.toString(),
    seconds_held: secondsHeld,
    days_held: secondsHeld / 86400,
    weighted_deposit_at: pos.rows[0]?.weighted_deposit_at ?? null,
    first_seen_at: pos.rows[0]?.first_seen_at ?? null,
    lifetime_lamports: BigInt(totals.rows[0]?.lifetime ?? "0"),
    paid_lamports: BigInt(totals.rows[0]?.paid ?? "0"),
    distributions_received: totals.rows[0]?.distributions_received ?? 0,
  };
}

/**
 * Background scheduler. Same pattern as $MAGPIE holder distributor.
 */
export function startLpLoyaltyDistributor() {
  console.log("[lp-loyalty] Distributor starting (random 5-10d window, internal-only timing)");

  async function tick() {
    try {
      // 1. Always sync on-chain → DB so the position table stays current
      await syncOnChainPositions().catch((err) =>
        console.error("[lp-loyalty] position sync failed:", err.message),
      );

      // 2. Retry leftover payouts
      const retry = await retryAccruedLpLoyaltyPayouts();
      if (retry.paid > 0) {
        console.log(`[lp-loyalty] Retried payouts: ${retry.paid}/${retry.retried}`);
      }

      // 3. Maybe distribute
      const state = await getLpLoyaltyPoolState();
      if (state.accrued_lamports <= 0n) return;

      if (!state.next_distribution_at && !state.last_distribution_at) {
        const delay = pickNextDistributionDelay();
        await query(
          `UPDATE lp_loyalty_pool
              SET next_distribution_at = NOW() + ($1 || ' milliseconds')::interval,
                  updated_at = NOW()
            WHERE id = 1`,
          [Math.floor(delay).toString()],
        );
        console.log(`[lp-loyalty] First distribution scheduled in ~${Math.round(delay/86400000)}d (internal)`);
        return;
      }

      if (state.next_distribution_at && new Date(state.next_distribution_at) > new Date()) return;

      const result = await snapshotAndDistributeLpLoyalty();
      if (result) {
        console.log(
          `[lp-loyalty] Distributed: ${Number(result.paid_lamports)/1e9} SOL paid ` +
          `(${Number(result.allocated_lamports)/1e9} allocated) to ${result.paid_count}/${result.eligible_count} LPs`,
        );
      }
    } catch (err) {
      console.error("[lp-loyalty] tick failed:", err.message);
    }
  }

  setTimeout(tick, 90 * 60 * 1000); // first tick 90min after boot (let other services settle)
  setInterval(tick, 6 * 60 * 60 * 1000); // every 6h
}
