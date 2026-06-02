/**
 * $MAGPIE Holder Rewards.
 *
 * Economics: 10% of every loan fee accrues to a holder reward pool.
 * Sourced from the protocol's 20% fee slice — LPs are unaffected (still
 * earn full 80%). Weekly snapshots distribute the pool pro-rata across
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
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";

export const MAGPIE_MINT = new PublicKey(
  "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump",
);
export const HOLDER_REWARD_BPS = 1_000; // 10% of every loan fee
export const MIN_HOLDER_CLAIM_LAMPORTS = 5_000_000n; // 0.005 SOL
export const MIN_HOLDER_BALANCE_RAW = 1n; // require at least 1 raw unit ($MAGPIE has 6 decimals → 0.000001)
export const MIN_LENDER_RESERVE_LAMPORTS = 100_000_000n; // 0.1 SOL safety floor
// $MAGPIE token account size is the standard SPL token account size.
const TOKEN_ACCOUNT_SIZE = 165;

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

/**
 * Owner programs whose token accounts are NEVER eligible. We filter at the
 * owner-program level rather than account address — catches every Raydium
 * pool without needing to track each pubkey.
 */
const EXCLUDED_OWNER_PROGRAMS = new Set([
  // Raydium AMM v4
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  // Orca whirlpool
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  // Meteora DLMM
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  // Pump.fun program (bonding curve token accounts)
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
]);

function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) return Keypair.fromSecretKey(bs58.decode(b58));
  const kpPath = process.env.LENDER_KEYPAIR_PATH || path.resolve("lender-keypair.json");
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * Add 10% of a loan fee to the holder reward pool. Idempotent NOT
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
 * Get current accrued pool size (lamports earmarked for the next
 * distribution).
 */
export async function getHolderPoolState() {
  const { rows } = await query(
    `SELECT accrued_lamports, last_distribution_at FROM magpie_holder_pool WHERE id = 1`,
  );
  if (rows.length === 0) {
    return { accrued_lamports: 0n, last_distribution_at: null };
  }
  return {
    accrued_lamports: BigInt(rows[0].accrued_lamports),
    last_distribution_at: rows[0].last_distribution_at,
  };
}

/**
 * Look up an on-chain wallet's $MAGPIE holdings and any unclaimed
 * reward balance. Used by the site dashboard widget.
 */
export async function getHolderInfoByWallet(walletAddress) {
  if (!walletAddress) return null;

  // 1. On-chain balance (the source of truth — DB doesn't track every wallet)
  let balanceRaw = 0n;
  let exists = false;
  try {
    const ataPubkey = getMagpieAtaForOwner(new PublicKey(walletAddress));
    const info = await connection.getTokenAccountBalance(ataPubkey).catch(() => null);
    if (info?.value) {
      balanceRaw = BigInt(info.value.amount ?? "0");
      exists = true;
    }
  } catch {
    /* malformed wallet → return zero state */
  }

  // 2. Accrued + paid reward totals from the distributions ledger
  const { rows: totals } = await query(
    `SELECT
       COALESCE(SUM(reward_lamports)::numeric, 0)::text AS lifetime,
       COALESCE(SUM(CASE WHEN status = 'paid' THEN reward_lamports ELSE 0 END)::numeric, 0)::text AS paid,
       COALESCE(SUM(CASE WHEN status = 'accrued' THEN reward_lamports ELSE 0 END)::numeric, 0)::text AS claimable,
       COUNT(*)::int AS distributions_count
     FROM magpie_holder_rewards
     WHERE wallet_address = $1`,
    [walletAddress],
  );

  return {
    wallet: walletAddress,
    balance_raw: balanceRaw.toString(),
    has_balance: exists && balanceRaw > 0n,
    lifetime_lamports: BigInt(totals[0]?.lifetime ?? "0"),
    paid_lamports: BigInt(totals[0]?.paid ?? "0"),
    claimable_lamports: BigInt(totals[0]?.claimable ?? "0"),
    distributions_count: totals[0]?.distributions_count ?? 0,
  };
}

function getMagpieAtaForOwner(owner) {
  return getAssociatedTokenAddressSync(MAGPIE_MINT, owner, false, TOKEN_PROGRAM_ID);
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
  const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: TOKEN_ACCOUNT_SIZE },
      // bytes 0-32 of a token account = mint
      { memcmp: { offset: 0, bytes: MAGPIE_MINT.toBase58() } },
    ],
  });

  // Aggregate balances per owner — a single wallet can have multiple token
  // accounts for the same mint, so sum across them.
  const byOwner = new Map();
  for (const a of accounts) {
    const data = a.account.data;
    // Token account layout:
    //   0..32  mint
    //   32..64 owner
    //   64..72 amount (u64 LE)
    const ownerBytes = data.subarray(32, 64);
    const owner = new PublicKey(ownerBytes).toBase58();
    if (EXCLUDED_WALLETS.has(owner)) continue;

    // Reject if the OWNER pubkey is a known DEX program (token account is a pool, not a real holder)
    if (EXCLUDED_OWNER_PROGRAMS.has(owner)) continue;

    const amount = data.readBigUInt64LE(64);
    if (amount < MIN_HOLDER_BALANCE_RAW) continue;

    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amount);
  }

  return Array.from(byOwner.entries()).map(([owner, balance]) => ({
    owner,
    balance_raw: balance,
  }));
}

/**
 * Take a snapshot, allocate the current pool pro-rata across eligible
 * holders, mark rewards 'accrued' (claimable), and reset the pool.
 *
 * Returns { distribution_id, pool_lamports, holder_count, eligible_count, total_balance }
 * or null if there was nothing to distribute.
 */
export async function snapshotAndDistribute() {
  const state = await getHolderPoolState();
  const pool = state.accrued_lamports;
  if (pool <= 0n) return null;

  const holders = await snapshotMagpieHolders();
  if (holders.length === 0) return null;

  // Sum eligible balance
  const totalBalance = holders.reduce((sum, h) => sum + h.balance_raw, 0n);
  if (totalBalance <= 0n) return null;

  const { pool: dbPool } = await import("../db/pool.js");
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    // 1. Create distribution row
    const { rows: [distRow] } = await client.query(
      `INSERT INTO magpie_holder_distributions
         (snapshot_at, pool_lamports, total_balance, holder_count, eligible_count)
       VALUES (NOW(), $1, $2, $3, $4)
       RETURNING id`,
      [pool.toString(), totalBalance.toString(), holders.length, holders.length],
    );
    const distributionId = distRow.id;

    // 2. Pro-rata allocations — skip rewards below 1 lamport
    let allocatedSum = 0n;
    const rows = [];
    for (const h of holders) {
      const reward = (pool * h.balance_raw) / totalBalance;
      if (reward <= 0n) continue;
      rows.push([distributionId, h.owner, h.balance_raw.toString(), reward.toString()]);
      allocatedSum += reward;
    }

    // Bulk insert
    if (rows.length > 0) {
      const placeholders = rows
        .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, 'accrued')`)
        .join(", ");
      const flat = rows.flat();
      await client.query(
        `INSERT INTO magpie_holder_rewards
           (distribution_id, wallet_address, balance_at_snapshot, reward_lamports, status)
         VALUES ${placeholders}`,
        flat,
      );
    }

    // 3. Reset the pool. Leave dust (pool - allocatedSum) for the next round.
    const remainder = pool - allocatedSum;
    await client.query(
      `UPDATE magpie_holder_pool
          SET accrued_lamports = $1,
              last_distribution_at = NOW(),
              updated_at = NOW()
        WHERE id = 1`,
      [remainder.toString()],
    );

    await client.query("COMMIT");

    return {
      distribution_id: distributionId,
      pool_lamports: pool,
      holder_count: holders.length,
      eligible_count: rows.length,
      total_balance: totalBalance,
      allocated_lamports: allocatedSum,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
 * Background scheduler: run a distribution every 7 days (configurable).
 * Skips if nothing has accrued or last run was too recent.
 */
export function startHolderDistributor(intervalMs = 7 * 24 * 60 * 60 * 1000) {
  console.log(`[holder-rewards] Distributor starting (interval=${intervalMs}ms)`);

  async function tick() {
    try {
      const state = await getHolderPoolState();
      if (state.last_distribution_at) {
        const since = Date.now() - new Date(state.last_distribution_at).getTime();
        if (since < intervalMs) return; // too soon
      }
      if (state.accrued_lamports <= 0n) return; // nothing to do
      const result = await snapshotAndDistribute();
      if (result) {
        console.log(
          `[holder-rewards] Distributed ${Number(result.allocated_lamports) / 1e9} SOL ` +
            `across ${result.eligible_count} holders (snapshot=${result.holder_count})`,
        );
      }
    } catch (err) {
      console.error("[holder-rewards] tick failed:", err.message);
    }
  }

  // Run once on startup (with a small delay) so the first distribution happens
  // the first time the bot boots after the pool starts accruing.
  setTimeout(tick, 60 * 60 * 1000); // 1h after boot
  // Then every 6h check whether a 7d distribution is due.
  setInterval(tick, 6 * 60 * 60 * 1000);
}
