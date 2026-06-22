/**
 * LP Loyalty Bonus Pool.
 *
 * Mechanic (post-MGP-001 ratified 2026-06-13):
 *   - 10% of every loan fee accrues to the lp_loyalty_pool. This IS
 *     the LP yield stream — there is no separate "base 80% share"
 *     anymore. The fee split is now 70% holders / 10% LP loyalty /
 *     10% referrer / 10% protocol reserve, with 0% retained in the
 *     lending pool itself.
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
import { getReadOnlyProgram, PROGRAM_ID, PROGRAM_ID_V2, PROGRAM_ID_V3 } from "../solana/program.js";
import { lendingPoolPda } from "../solana/pdas.js";
import { query } from "../db/pool.js";
import { getRewardsDistributorKeypair } from "./distributor-keypair.js";
import { getRuntimeConfigBps } from "./runtime-config.js";

// Fallback used when governance_config.lp_loyalty_reward_bps can't be
// read (DB outage or unset key). MGP-001 ratified the live value to
// 1000 (10%); the runtime reader takes precedence over this constant.
// Kept exported (= fallback) so legacy importers still resolve.
export const LP_LOYALTY_REWARD_BPS_FALLBACK = 1_000; // 10%
export const LP_LOYALTY_REWARD_BPS = LP_LOYALTY_REWARD_BPS_FALLBACK;

/**
 * Read the LIVE lp-loyalty reward bps from governance_config. Mirrors
 * getHolderRewardBps in magpie-holder-rewards.js. Any governance vote
 * that changes lp_loyalty_reward_bps takes effect everywhere within
 * runtime-config's TTL with no code change.
 */
export async function getLpLoyaltyRewardBps() {
  return getRuntimeConfigBps("lp_loyalty_reward_bps", LP_LOYALTY_REWARD_BPS_FALLBACK);
}
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
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) {
    throw new Error("LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set — refusing the CWD-relative fallback. Set the env var.");
  }
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * Hook called on every loan fee event. Accrues the loyalty bps share
 * via the pool_credit_events ledger (UNIQUE per source). Repeat calls
 * with the same (sourceType, sourceId) are no-ops.
 *
 * REQUIRED: sourceType + sourceId. See
 * feedback_pool_credits_must_be_idempotent_at_db_level.md.
 */
export async function accrueToLpLoyaltyPool(feeLamports, { sourceType, sourceId } = {}) {
  const fee = BigInt(feeLamports);
  if (fee <= 0n) return null;
  if (!sourceType || sourceId === undefined || sourceId === null) {
    console.error(`[lp-loyalty] CRIT accrueToLpLoyaltyPool called WITHOUT sourceType/sourceId — refusing. fee=${fee}`);
    return null;
  }
  const liveBps = await getLpLoyaltyRewardBps();
  const reward = (fee * BigInt(liveBps)) / 10_000n;
  if (reward <= 0n) return null;
  return await creditLpLoyaltyPoolDirect({
    sourceType,
    sourceId,
    lamports: reward,
    metadata: { fee_lamports: fee.toString(), bps: liveBps },
  });
}

/**
 * Credit a pre-computed lamport amount directly to the LP loyalty
 * pool. Idempotency enforced by pool_credit_events.UNIQUE(source_type,
 * source_id, pool_kind='lp_loyalty'). Repeat calls are no-ops.
 *
 * REQUIRED: sourceType + sourceId.
 */
export async function creditLpLoyaltyPoolDirect({ sourceType, sourceId, lamports, metadata } = {}) {
  const amt = BigInt(lamports || 0);
  if (amt <= 0n) return null;
  if (!sourceType || sourceId === undefined || sourceId === null) {
    console.error(`[lp-loyalty] CRIT ledger-gated credit called WITHOUT sourceType/sourceId — refusing. amt=${amt}`);
    return null;
  }
  try {
    const { rows } = await query(
      `WITH ins AS (
         INSERT INTO pool_credit_events (source_type, source_id, pool_kind, lamports, metadata)
         VALUES ($1, $2, 'lp_loyalty', $3::numeric, $4::jsonb)
         ON CONFLICT (source_type, source_id, pool_kind) DO NOTHING
         RETURNING id
       )
       UPDATE lp_loyalty_pool
          SET accrued_lamports = accrued_lamports + $3::numeric,
              updated_at = NOW()
        WHERE id = 1 AND EXISTS (SELECT 1 FROM ins)
        RETURNING accrued_lamports::text AS new_total`,
      [sourceType, String(sourceId), amt.toString(), metadata ? JSON.stringify(metadata) : null],
    );
    return rows.length > 0 ? amt : null;
  } catch (err) {
    console.error("[lp-loyalty] direct credit failed:", err.message);
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
 * Sync on-chain depositor positions into the lp_positions DB table
 * for one specific pool / program. Internal helper — callers below
 * use this to iterate across all live programs.
 *
 * For each on-chain DepositorPosition:
 *   - If new: insert with first_seen_at = NOW(), weighted_deposit_at = NOW()
 *   - If shares increased (new deposit): advance weighted_deposit_at
 *     proportionally toward NOW(). Formula:
 *       new_weighted_time = (old_shares × old_time + added × NOW) / new_shares
 *   - If shares decreased (withdrew): keep weighted_deposit_at as-is.
 *   - If shares == 0: clear the row (fully exited).
 */
async function syncPositionsForPool(programId) {
  const program = getReadOnlyProgram(programId);
  const [poolPda] = lendingPoolPda(LENDER_PUBKEY, programId);
  const poolStr = poolPda.toBase58();
  const programStr = programId.toBase58();

  // Enumerate all depositor positions for THIS pool.
  // Layout: [discriminator(8)] [owner pubkey(32)] [pool pubkey(32)] ...
  // `pool` lives at offset 40.
  const positions = await program.account.depositorPosition.all([
    { memcmp: { offset: 40, bytes: poolStr } },
  ]);

  const onChainByOwner = new Map();
  for (const p of positions) {
    const owner = p.account.owner.toBase58();
    const shares = BigInt(p.account.shares.toString());
    if (shares > 0n) onChainByOwner.set(owner, shares);
  }

  // Pull current DB state for THIS pool.
  const { rows: dbRows } = await query(
    `SELECT wallet_address, shares::text AS shares, weighted_deposit_at
       FROM lp_positions WHERE pool = $1 AND shares > 0`,
    [poolStr],
  );
  const dbByOwner = new Map(
    dbRows.map((r) => [r.wallet_address, { shares: BigInt(r.shares), weightedAt: r.weighted_deposit_at }]),
  );

  for (const [owner, onChainShares] of onChainByOwner) {
    const dbEntry = dbByOwner.get(owner);
    if (!dbEntry) {
      await query(
        `INSERT INTO lp_positions
           (wallet_address, pool, program_id, shares, weighted_deposit_at, first_seen_at, last_synced_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
         ON CONFLICT (wallet_address, pool) DO UPDATE SET
           shares = EXCLUDED.shares,
           weighted_deposit_at = NOW(),
           first_seen_at = lp_positions.first_seen_at,
           last_synced_at = NOW()`,
        [owner, poolStr, programStr, onChainShares.toString()],
      );
    } else if (onChainShares > dbEntry.shares) {
      const added = onChainShares - dbEntry.shares;
      await query(
        `UPDATE lp_positions
            SET shares = $3,
                weighted_deposit_at = TO_TIMESTAMP(
                  ( $4::numeric * EXTRACT(EPOCH FROM weighted_deposit_at)
                  + $5::numeric * EXTRACT(EPOCH FROM NOW()) )
                  / $6::numeric
                ),
                last_synced_at = NOW()
          WHERE wallet_address = $1 AND pool = $2`,
        [owner, poolStr, onChainShares.toString(), dbEntry.shares.toString(), added.toString(), onChainShares.toString()],
      );
    } else if (onChainShares < dbEntry.shares) {
      await query(
        `UPDATE lp_positions
            SET shares = $3, last_synced_at = NOW()
          WHERE wallet_address = $1 AND pool = $2`,
        [owner, poolStr, onChainShares.toString()],
      );
    } else {
      await query(
        `UPDATE lp_positions SET last_synced_at = NOW()
          WHERE wallet_address = $1 AND pool = $2`,
        [owner, poolStr],
      );
    }
  }

  // Mark fully-exited positions (in DB but not on-chain), pool-scoped.
  for (const owner of dbByOwner.keys()) {
    if (!onChainByOwner.has(owner)) {
      await query(
        `UPDATE lp_positions SET shares = 0, last_synced_at = NOW()
          WHERE wallet_address = $1 AND pool = $2`,
        [owner, poolStr],
      );
    }
  }

  return { pool: poolStr, tracked: onChainByOwner.size, db_rows_seen: dbByOwner.size };
}

/**
 * Sync every live lending program's positions into lp_positions.
 * Called on every distribution tick (every 6h) so the DB stays in sync
 * across v1 / v2 / v3 without needing real-time event subscriptions.
 *
 * Programs that aren't configured (env unset locally) are silently
 * skipped — production has all of them set on Railway.
 */
export async function syncOnChainPositions() {
  const programs = [PROGRAM_ID, PROGRAM_ID_V2, PROGRAM_ID_V3].filter(Boolean);
  const results = [];
  for (const pid of programs) {
    try {
      results.push(await syncPositionsForPool(pid));
    } catch (err) {
      console.warn(`[lp-loyalty] sync failed for program ${pid.toBase58().slice(0, 8)}:`, err.message);
    }
  }
  const total_tracked = results.reduce((s, r) => s + r.tracked, 0);
  const total_db_rows = results.reduce((s, r) => s + r.db_rows_seen, 0);
  return { tracked: total_tracked, db_rows_seen: total_db_rows, pools: results };
}

/**
 * Fast single-wallet sync. Reads the wallet's Position PDA on each
 * known program and updates the corresponding lp_positions row. Used
 * by /fundpool right after a deposit lands so the DB reflects the new
 * shares immediately instead of waiting for the next 6h tick.
 */
export async function syncPositionsForWallet(walletPubkey) {
  const { PublicKey } = await import("@solana/web3.js");
  const ownerPk = walletPubkey instanceof PublicKey ? walletPubkey : new PublicKey(walletPubkey);
  const programs = [PROGRAM_ID, PROGRAM_ID_V2, PROGRAM_ID_V3].filter(Boolean);
  const updates = [];
  for (const pid of programs) {
    try {
      const program = getReadOnlyProgram(pid);
      const [poolPda] = lendingPoolPda(LENDER_PUBKEY, pid);
      const [posPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), poolPda.toBuffer(), ownerPk.toBuffer()],
        pid,
      );
      let shares = 0n;
      try {
        const posAcc = await program.account.depositorPosition.fetch(posPda);
        shares = BigInt(posAcc.shares.toString());
      } catch {
        // Position doesn't exist on this program for this wallet — that's
        // fine, this wallet just isn't an LP in this pool. shares stays 0.
      }
      const poolStr = poolPda.toBase58();
      const programStr = pid.toBase58();
      if (shares > 0n) {
        // UPSERT with weighted-time correctness. We can't run the exact
        // same time-weighting formula without knowing the previous DB
        // shares; instead we fetch them and branch by direction.
        const { rows: [existing] } = await query(
          `SELECT shares::text AS shares
             FROM lp_positions WHERE wallet_address = $1 AND pool = $2`,
          [ownerPk.toBase58(), poolStr],
        );
        if (!existing) {
          await query(
            `INSERT INTO lp_positions
               (wallet_address, pool, program_id, shares, weighted_deposit_at, first_seen_at, last_synced_at)
             VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())`,
            [ownerPk.toBase58(), poolStr, programStr, shares.toString()],
          );
        } else {
          const oldShares = BigInt(existing.shares);
          if (shares > oldShares) {
            const added = shares - oldShares;
            await query(
              `UPDATE lp_positions
                  SET shares = $3,
                      weighted_deposit_at = TO_TIMESTAMP(
                        ( $4::numeric * EXTRACT(EPOCH FROM weighted_deposit_at)
                        + $5::numeric * EXTRACT(EPOCH FROM NOW()) )
                        / $6::numeric
                      ),
                      last_synced_at = NOW()
                WHERE wallet_address = $1 AND pool = $2`,
              [ownerPk.toBase58(), poolStr, shares.toString(), oldShares.toString(), added.toString(), shares.toString()],
            );
          } else {
            await query(
              `UPDATE lp_positions
                  SET shares = $3, last_synced_at = NOW()
                WHERE wallet_address = $1 AND pool = $2`,
              [ownerPk.toBase58(), poolStr, shares.toString()],
            );
          }
        }
        updates.push({ pool: poolStr, shares: shares.toString() });
      } else {
        // Zero or missing on-chain — mark any DB row to 0.
        await query(
          `UPDATE lp_positions SET shares = 0, last_synced_at = NOW()
            WHERE wallet_address = $1 AND pool = $2`,
          [ownerPk.toBase58(), poolStr],
        );
      }
    } catch (err) {
      console.warn(`[lp-loyalty] syncPositionsForWallet failed on ${pid.toBase58().slice(0, 8)}:`, err.message);
    }
  }
  return updates;
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

  // Pre-flight distributor balance (REWARDS_DISTRIBUTOR_PRIVATE_KEY,
  // with backward-compat fallback to LENDER_PRIVATE_KEY).
  const distributor = getRewardsDistributorKeypair();
  const distributorBalance = BigInt(await connection.getBalance(distributor.publicKey));
  if (distributorBalance < pool + MIN_LENDER_RESERVE_LAMPORTS) {
    console.warn(`[lp-loyalty] Skipped: distributor balance too low for pool ${pool}`);
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

  // Operator-curated exempt list (migration 084). The operator's
  // lender wallet is excluded permanently so the auto-cron doesn't
  // pay 95% of every cycle back to the wallet that funded LP in the
  // first place — that would be a wasteful operator-to-operator
  // round-trip. See [[feedback_lender_wallet_exempt_from_lp_loyalty]].
  // Empty table = no exemptions, behavior identical to pre-migration.
  let exempt = new Set();
  try {
    const { rows: exemptRows } = await query(
      `SELECT wallet_address FROM lp_loyalty_exempt_wallets`,
    );
    exempt = new Set(exemptRows.map((r) => r.wallet_address));
    if (exempt.size > 0) {
      console.log(`[lp-loyalty] honoring ${exempt.size} exempt wallet(s)`);
    }
  } catch (err) {
    // Table missing (pre-migration deploy) — fall back to no exemptions.
    console.warn("[lp-loyalty] lp_loyalty_exempt_wallets read failed (using empty exemption set):", err.message);
  }

  // Compute weights
  let totalWeight = 0n;
  const items = [];
  for (const r of rows) {
    if (exempt.has(r.wallet_address)) continue;
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
          SET accrued_lamports = accrued_lamports - $1::numeric,
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
          fromPubkey: distributor.publicKey,
          toPubkey: new PublicKey(r.wallet_address),
          lamports: BigInt(r.reward_lamports),
        }),
      );
    }
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [distributor], { commitment: "confirmed" });
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

  const distributor = getRewardsDistributorKeypair();
  const total = rows.reduce((s, r) => s + BigInt(r.reward_lamports), 0n);
  const bal = BigInt(await connection.getBalance(distributor.publicKey));
  if (bal < total + MIN_LENDER_RESERVE_LAMPORTS) return { retried: 0, paid: 0, skipped: rows.length };

  let paid = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const tx = new Transaction();
    for (const r of batch) {
      tx.add(SystemProgram.transfer({
        fromPubkey: distributor.publicKey,
        toPubkey: new PublicKey(r.wallet_address),
        lamports: BigInt(r.reward_lamports),
      }));
    }
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [distributor], { commitment: "confirmed" });
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
