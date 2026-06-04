/**
 * $MAGPIE Holder Rewards.
 *
 * Economics: 30% of every loan fee accrues to a holder reward pool.
 * Sourced from the protocol's 20% fee slice — LPs are unaffected (still
 * earn full 60%). Weekly snapshots distribute the pool pro-rata across
 * all on-chain $MAGPIE holders, filtering out system/DEX/CEX addresses.
 *
 * Holders claim their earned SOL via /claimholder (or the dashboard).
 *
 * Why off-chain: pro-rata distribution to N holders weekly is fundamentally
 * a batch operation. Doing it on-chain per loan would cost more in tx fees
 * than the rewards themselves. Off-chain ledger + on-chain payout is the
 * sustainable pattern (same as referrals).
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";

export const MAGPIE_MINT = new PublicKey(
  "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump",
);
// $MAGPIE is a Token-2022 mint (pump.fun graduated tokens commonly are).
// Verified: mint owner = TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.
// All ATA derivations and program-account scans for $MAGPIE must use
// TOKEN_2022_PROGRAM_ID, NOT TOKEN_PROGRAM_ID.
export const MAGPIE_TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID;
// 30% of every loan fee. Bumped from 1000 (10%) to reward $MAGPIE holders
// more aggressively. NOTE: the on-chain LendingPool.protocol_fee_bps must
// also be updated from 2000 to 4000 for the protocol to be fully solvent
// at this rate; until that program upgrade lands, the lender wallet
// absorbs the difference (~3% of every loan fee) as a temporary subsidy.
export const HOLDER_REWARD_BPS = 3_000;
export const MIN_HOLDER_CLAIM_LAMPORTS = 5_000_000n; // 0.005 SOL
export const MIN_HOLDER_BALANCE_RAW = 1n; // require at least 1 raw unit ($MAGPIE has 6 decimals → 0.000001)
export const MIN_LENDER_RESERVE_LAMPORTS = 100_000_000n; // 0.1 SOL safety floor
// Don't run a distribution until the pool is at least this large.
// Avoids spending more in tx fees than the rewards themselves.
export const MIN_DISTRIBUTION_LAMPORTS = 10_000_000n; // 0.01 SOL

// Anti-dump window: snapshots fire at a random moment within this range,
// measured from the previous distribution. Internal-only — never exposed
// via public APIs. The exact next-snapshot time is also kept private.
const DIST_WINDOW_MIN_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const DIST_WINDOW_MAX_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

function pickNextDistributionDelay() {
  return DIST_WINDOW_MIN_MS + Math.random() * (DIST_WINDOW_MAX_MS - DIST_WINDOW_MIN_MS);
}

/**
 * Wallets that should NEVER receive holder rewards even if they show up
 * holding $MAGPIE. Pump.fun bonding curve, well-known DEX pools, CEX
 * deposits, and known burn addresses. Add new ones here as discovered.
 */
const EXCLUDED_WALLETS = new Set([
  // Burn / system
  "11111111111111111111111111111111",
  // Pump.fun bonding curve mint authority — will be a major holder pre-grad
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
  // Lender / protocol wallet
  "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx",
]);

// NOTE on filtering pools/contracts:
// We do NOT use a hardcoded list of DEX program IDs as the primary filter
// — the SPL "owner" field stored in token accounts is a PDA derived from
// the pool, never the program ID itself. So a hardcoded program-ID list
// never matched anything.
// Instead, snapshotMagpieHolders() looks up each holder's account-owner
// program and excludes anything not owned by System Program (i.e. anything
// that isn't a real wallet). This catches PumpSwap, Raydium, Orca,
// Meteora, vaults, Token-2022 protocol accounts, etc. — all in one check.

function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) return Keypair.fromSecretKey(bs58.decode(b58));
  const kpPath = process.env.LENDER_KEYPAIR_PATH || path.resolve("lender-keypair.json");
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * Add 30% of a loan fee to the holder reward pool. Idempotent NOT
 * guaranteed — caller must ensure they call once per fee event. Safe
 * to call from inside the loan-recording try/catch (errors don't
 * propagate up to the user-facing flow).
 */
export async function accrueToHolderPool(feeLamports) {
  const fee = BigInt(feeLamports);
  if (fee <= 0n) return null;
  const reward = (fee * BigInt(HOLDER_REWARD_BPS)) / 10_000n;
  if (reward <= 0n) return null;
  try {
    await query(
      `UPDATE magpie_holder_pool
          SET accrued_lamports = (accrued_lamports::numeric + $1::numeric)::text,
              updated_at = NOW()
        WHERE id = 1`,
      [reward.toString()],
    );
    return reward;
  } catch (err) {
    console.error("[holder-rewards] accrual failed:", err.message);
    return null;
  }
}

/**
 * Get current accrued pool size + internal scheduling state.
 *
 * NOTE: next_distribution_at and last_distribution_at are INTERNAL-ONLY.
 * They must never be exposed in public API responses or UIs — the whole
 * point of the random window is to prevent mercenary holders from
 * timing their entry/exit around predictable distribution events.
 */
export async function getHolderPoolState() {
  // Defensive: SELECT * survives schema patches that may not have applied
  // yet on first boot of a new deploy. Then pick out the columns we care
  // about with optional chaining.
  let rows;
  try {
    const r = await query(`SELECT * FROM magpie_holder_pool WHERE id = 1`);
    rows = r.rows;
  } catch {
    rows = [];
  }
  if (rows.length === 0) {
    return { accrued_lamports: 0n, last_distribution_at: null, next_distribution_at: null };
  }
  return {
    accrued_lamports: BigInt(rows[0].accrued_lamports ?? "0"),
    last_distribution_at: rows[0].last_distribution_at ?? null,
    next_distribution_at: rows[0].next_distribution_at ?? null,
  };
}

/**
 * Look up an on-chain wallet's $MAGPIE holdings and reward history.
 * Used by the site dashboard widget + /holders bot command.
 *
 * Includes an ESTIMATED next payout based on the user's current
 * balance share vs the last snapshot's eligible total. For the
 * first distribution (no history yet), uses circulating supply.
 */
export async function getHolderInfoByWallet(walletAddress) {
  if (!walletAddress) return null;

  // 1. On-chain balance (source of truth — DB doesn't track every wallet).
  //    Sum across ALL token accounts owned by this wallet for $MAGPIE,
  //    not just the ATA — some users hold via non-ATA accounts (legacy
  //    from before ATAs were standard, or multi-account positions).
  //    Matches the snapshot logic exactly.
  let balanceRaw = 0n;
  let exists = false;
  try {
    const accounts = await connection.getTokenAccountsByOwner(
      new PublicKey(walletAddress),
      { mint: MAGPIE_MINT, programId: MAGPIE_TOKEN_PROGRAM },
      { commitment: "confirmed" },
    );
    for (const a of accounts.value) {
      const data = a.account.data;
      if (data.length < 72) continue;
      balanceRaw += data.readBigUInt64LE(64);
    }
    exists = accounts.value.length > 0;
  } catch {
    /* malformed wallet → return zero state */
  }

  // 2. Reward history (lifetime received + per-distribution count)
  const { rows: totals } = await query(
    `SELECT
       COALESCE(SUM(reward_lamports)::numeric, 0)::text AS lifetime,
       COALESCE(SUM(CASE WHEN status = 'paid' THEN reward_lamports ELSE 0 END)::numeric, 0)::text AS paid,
       COALESCE(SUM(CASE WHEN status = 'accrued' THEN reward_lamports ELSE 0 END)::numeric, 0)::text AS pending,
       COUNT(*)::int AS distributions_count
     FROM magpie_holder_rewards
     WHERE wallet_address = $1`,
    [walletAddress],
  );

  // 3. Estimated next payout — pool × (this wallet's balance / total eligible).
  //    "Total eligible" comes from the last snapshot if we have one,
  //    otherwise from on-chain circulating supply.
  //    We DO expose the estimate (size of slice) but NOT when the slice
  //    will be paid — that timing stays private to prevent dump-after-snapshot
  //    behavior.
  let estimatedNextPayout = 0n;
  try {
    const [poolState, lastSnap] = await Promise.all([
      getHolderPoolState(),
      query(
        `SELECT total_balance FROM magpie_holder_distributions
          ORDER BY snapshot_at DESC LIMIT 1`,
      ),
    ]);
    const pool = poolState.accrued_lamports;
    if (pool > 0n && balanceRaw > 0n) {
      const totalBalance = lastSnap.rows[0]
        ? BigInt(lastSnap.rows[0].total_balance)
        : await getMagpieCirculatingSupply().catch(() => 0n);
      if (totalBalance > 0n) {
        estimatedNextPayout = (pool * balanceRaw) / totalBalance;
      }
    }
  } catch {
    /* best-effort estimate — fall through with 0 */
  }

  return {
    wallet: walletAddress,
    balance_raw: balanceRaw.toString(),
    has_balance: exists && balanceRaw > 0n,
    lifetime_lamports: BigInt(totals[0]?.lifetime ?? "0"),
    paid_lamports: BigInt(totals[0]?.paid ?? "0"),
    pending_lamports: BigInt(totals[0]?.pending ?? "0"),
    distributions_count: totals[0]?.distributions_count ?? 0,
    estimated_next_payout_lamports: estimatedNextPayout,
  };
}

/**
 * Fetch the on-chain circulating supply of $MAGPIE. Used as a fallback
 * "total eligible" denominator for the very first distribution's estimate.
 */
async function getMagpieCirculatingSupply() {
  const info = await connection.getTokenSupply(MAGPIE_MINT);
  return BigInt(info?.value?.amount ?? "0");
}

function getMagpieAtaForOwner(owner) {
  // $MAGPIE is Token-2022 — must use that program for ATA derivation
  // (the ATA address differs from the legacy-Token derivation).
  return getAssociatedTokenAddressSync(MAGPIE_MINT, owner, false, MAGPIE_TOKEN_PROGRAM);
}

/**
 * Enumerate all on-chain holders of $MAGPIE by scanning Token program
 * accounts. Filters by mint and minimum balance. Returns
 * { owner_pubkey, balance_raw } pairs. Expensive RPC call — only run on
 * snapshot, not on every borrow.
 *
 * Excludes:
 *   - Token accounts owned by known DEX programs (pool liquidity, not holders)
 *   - Explicit excluded wallets (protocol, burn, bonding curve)
 *   - Empty balances
 */
export async function snapshotMagpieHolders() {
  // Token-2022 accounts can be longer than 165 bytes when the mint has
  // extensions enabled, so we DON'T constrain dataSize — just match by
  // mint at offset 0 (same as legacy Token layout for the first 64 bytes).
  const accounts = await connection.getProgramAccounts(MAGPIE_TOKEN_PROGRAM, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: MAGPIE_MINT.toBase58() } }],
  });

  // Aggregate balances per owner — one wallet can have multiple token
  // accounts for the same mint, so sum across them.
  const byOwner = new Map();
  for (const a of accounts) {
    const data = a.account.data;
    if (data.length < 72) continue;
    const ownerBytes = data.subarray(32, 64);
    const owner = new PublicKey(ownerBytes).toBase58();
    if (EXCLUDED_WALLETS.has(owner)) continue;

    const amount = data.readBigUInt64LE(64);
    if (amount < MIN_HOLDER_BALANCE_RAW) continue;

    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amount);
  }

  // Critical: filter out PDAs / smart-contract accounts (pools, vaults,
  // bonding curves). Real Solana wallets are owned by System Program; any
  // other owner-program means the account is a contract or PDA — these
  // would otherwise siphon ~14% of every distribution to non-holders
  // (e.g. PumpSwap AMM, Token-2022 protocol accounts, etc).
  //
  // Batch fetch (100 per call) keeps RPC cost minimal even with thousands
  // of holders.
  const SystemProgramId = SystemProgram.programId.toBase58();
  const allOwners = Array.from(byOwner.keys());
  const BATCH = 100;
  for (let i = 0; i < allOwners.length; i += BATCH) {
    const batch = allOwners.slice(i, i + BATCH);
    const pubkeys = batch.map((o) => new PublicKey(o));
    let infos;
    try {
      infos = await connection.getMultipleAccountsInfo(pubkeys, { commitment: "confirmed" });
    } catch (err) {
      console.error("[holder-rewards] account-owner lookup failed (keeping conservatively, excluding all in batch):", err.message);
      // Conservative: if we can't verify, exclude rather than risk paying to PDAs.
      for (const o of batch) byOwner.delete(o);
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      const info = infos[j];
      // No account info → owner doesn't exist (could be a PDA never funded);
      // OR owner is a contract — exclude to be safe.
      if (!info || info.owner?.toBase58() !== SystemProgramId) {
        byOwner.delete(batch[j]);
      }
    }
  }

  return Array.from(byOwner.entries()).map(([owner, balance]) => ({
    owner,
    balance_raw: balance,
  }));
}

/**
 * Take a snapshot, allocate the current pool pro-rata across eligible
 * holders, and AUTO-PAY each holder in SOL. No claim step required —
 * SOL hits holders' wallets during the distribution itself.
 *
 * Flow:
 *   1. Pre-flight: verify lender has enough SOL to cover pool + reserve.
 *      If not, skip and try again next cycle.
 *   2. Enumerate on-chain holders + compute pro-rata shares.
 *   3. Insert distribution row + per-holder reward rows (status 'accrued').
 *   4. Send SOL in batches of 10 transfers per tx. On each successful tx,
 *      flip those rows to 'paid' with the tx signature. Failed batches
 *      stay 'accrued' for retry on the next cycle.
 *   5. Reset pool to remainder (untouched if all transfers succeeded).
 *
 * Returns { distribution_id, pool_lamports, holder_count, eligible_count,
 *           total_balance, paid_count, paid_lamports } or null.
 */
const BATCH_SIZE = 10; // SystemProgram.transfer ixs per tx (well under Solana tx limit)

export async function snapshotAndDistribute() {
  const state = await getHolderPoolState();
  const pool = state.accrued_lamports;
  if (pool <= 0n) return null;

  // Don't run a distribution if the pool is too small — tx fees would
  // eat more than the rewards. Wait for it to build up over more weeks.
  if (pool < MIN_DISTRIBUTION_LAMPORTS) {
    console.log(
      `[holder-rewards] Pool ${Number(pool) / 1e9} SOL below minimum ${Number(MIN_DISTRIBUTION_LAMPORTS) / 1e9} — deferring distribution`,
    );
    return null;
  }

  // Pre-flight: lender must cover the entire pool + safety reserve
  const lender = loadLenderKeypair();
  const lenderBalance = BigInt(await connection.getBalance(lender.publicKey));
  if (lenderBalance < pool + MIN_LENDER_RESERVE_LAMPORTS) {
    console.warn(
      `[holder-rewards] Distribution skipped: lender ${lenderBalance} < pool ${pool} + reserve ${MIN_LENDER_RESERVE_LAMPORTS}`,
    );
    return null;
  }

  const holders = await snapshotMagpieHolders();
  if (holders.length === 0) return null;

  const totalBalance = holders.reduce((sum, h) => sum + h.balance_raw, 0n);
  if (totalBalance <= 0n) return null;

  const { pool: dbPool } = await import("../db/pool.js");

  // Phase 1: write distribution + reward rows (transactional, no SOL movement yet)
  let distributionId;
  let rewardRows = [];
  let allocatedSum = 0n;
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [distRow] } = await client.query(
      `INSERT INTO magpie_holder_distributions
         (snapshot_at, pool_lamports, total_balance, holder_count, eligible_count)
       VALUES (NOW(), $1, $2, $3, $4)
       RETURNING id`,
      [pool.toString(), totalBalance.toString(), holders.length, holders.length],
    );
    distributionId = distRow.id;

    const inserts = [];
    for (const h of holders) {
      const reward = (pool * h.balance_raw) / totalBalance;
      if (reward <= 0n) continue;
      inserts.push([distributionId, h.owner, h.balance_raw.toString(), reward.toString()]);
      allocatedSum += reward;
    }

    if (inserts.length > 0) {
      const placeholders = inserts
        .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, 'accrued')`)
        .join(", ");
      await client.query(
        `INSERT INTO magpie_holder_rewards
           (distribution_id, wallet_address, balance_at_snapshot, reward_lamports, status)
         VALUES ${placeholders}
         RETURNING id, wallet_address, reward_lamports`,
        inserts.flat(),
      );

      // Fetch them back with IDs for the payout phase
      const { rows } = await client.query(
        `SELECT id, wallet_address, reward_lamports FROM magpie_holder_rewards
          WHERE distribution_id = $1`,
        [distributionId],
      );
      rewardRows = rows;
    }

    // Atomically decrement the pool by what we ALLOCATED — never overwrite
    // to a fixed value. If a concurrent accrueToHolderPool call slips in
    // during this transaction, its increment is preserved.
    // Also set the next snapshot time to a random moment 5-10 days from
    // now — internal only, never exposed via any public API.
    const nextDelayMs = pickNextDistributionDelay();
    await client.query(
      `UPDATE magpie_holder_pool
          SET accrued_lamports = (accrued_lamports::numeric - $1::numeric)::text,
              last_distribution_at = NOW(),
              next_distribution_at = NOW() + ($2 || ' milliseconds')::interval,
              updated_at = NOW()
        WHERE id = 1`,
      [allocatedSum.toString(), Math.floor(nextDelayMs).toString()],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  // Phase 2: send SOL in batches, mark rows paid as each batch confirms
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
      const sig = await sendAndConfirmTransaction(connection, tx, [lender], {
        commitment: "confirmed",
      });
      await query(
        `UPDATE magpie_holder_rewards
            SET status = 'paid', paid_at = NOW(), paid_tx_signature = $2
          WHERE id = ANY($1::bigint[])`,
        [batch.map((r) => r.id), sig],
      );
      paidCount += batch.length;
      paidLamports += batch.reduce((acc, r) => acc + BigInt(r.reward_lamports), 0n);
    } catch (err) {
      console.error(
        `[holder-rewards] Batch payout failed (rows remain 'accrued' for retry):`,
        err.message,
      );
      // Leave 'accrued' — a manual /payaccrued admin command or next cycle can clean up.
    }
  }

  return {
    distribution_id: distributionId,
    pool_lamports: pool,
    holder_count: holders.length,
    eligible_count: rewardRows.length,
    total_balance: totalBalance,
    allocated_lamports: allocatedSum,
    paid_count: paidCount,
    paid_lamports: paidLamports,
  };
}

/**
 * Retry any 'accrued' rewards (left over from a previous distribution
 * where the payout tx failed mid-batch). Same batched-transfer pattern.
 * Safe to call repeatedly. Called from the distributor cron.
 */
export async function retryAccruedPayouts() {
  const { rows } = await query(
    `SELECT id, wallet_address, reward_lamports
       FROM magpie_holder_rewards
      WHERE status = 'accrued'
      ORDER BY created_at ASC
      LIMIT 200`,
  );
  if (rows.length === 0) return { retried: 0, paid: 0 };

  const lender = loadLenderKeypair();
  const totalNeeded = rows.reduce((acc, r) => acc + BigInt(r.reward_lamports), 0n);
  const lenderBalance = BigInt(await connection.getBalance(lender.publicKey));
  if (lenderBalance < totalNeeded + MIN_LENDER_RESERVE_LAMPORTS) {
    console.warn("[holder-rewards] Retry skipped: lender too low");
    return { retried: 0, paid: 0, skipped: rows.length };
  }

  let paid = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
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
      const sig = await sendAndConfirmTransaction(connection, tx, [lender], {
        commitment: "confirmed",
      });
      await query(
        `UPDATE magpie_holder_rewards
            SET status = 'paid', paid_at = NOW(), paid_tx_signature = $2
          WHERE id = ANY($1::bigint[])`,
        [batch.map((r) => r.id), sig],
      );
      paid += batch.length;
    } catch (err) {
      console.error("[holder-rewards] retry batch failed:", err.message);
    }
  }
  return { retried: rows.length, paid };
}

/**
 * Atomically pay out all claimable rewards for one wallet.
 * Mirrors claimReferralEarnings — locked rows, single tx, status flip.
 */
export async function claimHolderRewards({ walletAddress }) {
  if (!walletAddress) throw new Error("No wallet");
  const recipient = new PublicKey(walletAddress);

  const { pool: dbPool } = await import("../db/pool.js");
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, reward_lamports
         FROM magpie_holder_rewards
        WHERE wallet_address = $1 AND status = 'accrued'
        FOR UPDATE SKIP LOCKED`,
      [walletAddress],
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "nothing_to_claim" };
    }

    const total = rows.reduce((acc, r) => acc + BigInt(r.reward_lamports), 0n);
    if (total < MIN_HOLDER_CLAIM_LAMPORTS) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "below_minimum",
        accrued_lamports: total,
        minimum_lamports: MIN_HOLDER_CLAIM_LAMPORTS,
      };
    }

    const lender = loadLenderKeypair();
    const lenderBalance = BigInt(await connection.getBalance(lender.publicKey));
    if (lenderBalance < total + MIN_LENDER_RESERVE_LAMPORTS) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "treasury_low",
        treasury_lamports: lenderBalance,
        required_lamports: total,
      };
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: lender.publicKey,
        toPubkey: recipient,
        lamports: total,
      }),
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [lender], {
      commitment: "confirmed",
    });

    await client.query(
      `UPDATE magpie_holder_rewards
          SET status = 'paid', paid_at = NOW(), paid_tx_signature = $2
        WHERE id = ANY($1::bigint[])`,
      [rows.map((r) => r.id), signature],
    );

    await client.query("COMMIT");
    return { ok: true, signature, paid_lamports: total, row_count: rows.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Background scheduler: every 6h, retry any leftover unpaid rewards and
 * check whether the (randomized, internal-only) next-distribution moment
 * has arrived. If so, snapshot + auto-pay.
 *
 * Snapshot timing is INTENTIONALLY UNPREDICTABLE — randomized between
 * 5-10 days after each distribution. This stops mercenary holders from
 * timing a buy-just-before / dump-just-after pattern.
 */
export function startHolderDistributor() {
  console.log("[holder-rewards] Distributor starting (random 5-10d window, hidden timing)");

  async function tick() {
    try {
      // 1. Clean up payouts that failed mid-batch last cycle.
      const retry = await retryAccruedPayouts();
      if (retry.paid > 0) {
        console.log(`[holder-rewards] Retried payouts: ${retry.paid} paid (of ${retry.retried})`);
      }

      // 2. Check if a new distribution is due.
      const state = await getHolderPoolState();
      if (state.accrued_lamports <= 0n) return; // nothing to do yet

      // First-ever run: pick a random target and store it (no distribution today).
      if (!state.next_distribution_at && !state.last_distribution_at) {
        const delay = pickNextDistributionDelay();
        await query(
          `UPDATE magpie_holder_pool
              SET next_distribution_at = NOW() + ($1 || ' milliseconds')::interval,
                  updated_at = NOW()
            WHERE id = 1`,
          [Math.floor(delay).toString()],
        );
        console.log(
          `[holder-rewards] First distribution scheduled in ~${Math.round(delay / 86_400_000)}d (internal only)`,
        );
        return;
      }

      // If next time hasn't arrived, wait.
      if (state.next_distribution_at && new Date(state.next_distribution_at) > new Date()) {
        return;
      }

      // 3. Snapshot + auto-pay.
      const result = await snapshotAndDistribute();
      if (result) {
        console.log(
          `[holder-rewards] Distributed: ${Number(result.paid_lamports) / 1e9} SOL paid ` +
            `(of ${Number(result.allocated_lamports) / 1e9} allocated) to ${result.paid_count}/${result.eligible_count} holders`,
        );
      }
    } catch (err) {
      console.error("[holder-rewards] tick failed:", err.message);
    }
  }

  setTimeout(tick, 60 * 60 * 1000); // first check 1h after boot
  setInterval(tick, 6 * 60 * 60 * 1000); // then every 6h
}
