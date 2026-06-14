/**
 * $MAGPIE Holder Rewards.
 *
 * Economics: 70% of every loan fee accrues to a holder reward pool
 * (post-MGP-001). The remaining 30% splits across LPs / referrers /
 * protocol reserve. Weekly snapshots distribute the pool pro-rata
 * across all on-chain $MAGPIE holders, filtering out
 * system/DEX/CEX addresses.
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
// FALLBACK value used when governance_config.holder_reward_bps can't
// be read (DB unreachable, first boot before migration, etc). The
// live value is read at runtime via getHolderRewardBps() — which the
// governance autopilot flips to 7000 when MGP-001 ratifies.
// MGP-001 ratified — see governance_config.holder_reward_bps for the
// authoritative runtime value. This fallback is only read when the DB
// is unreachable; we keep it in sync with the ratified value so a
// DB-degraded window doesn't temporarily accrue at the old 10% rate.
export const HOLDER_REWARD_BPS_FALLBACK = 7_000; // 70% (MGP-001 ratified 2026-06-13)
// Backwards-compat alias for callers that previously imported the
// hardcoded const for DISPLAY. They'll see the pre-MGP-001 default
// until they migrate to the async getter. Eventually-consistent.
export const HOLDER_REWARD_BPS = HOLDER_REWARD_BPS_FALLBACK;

/**
 * Read the current holder-reward bps from governance_config, falling
 * back to the hardcoded default. Every accrual + every display call
 * should go through this so a passed MGP-001 (autopilot writes 7000
 * to governance_config.holder_reward_bps) takes effect everywhere
 * within the runtime-config cache TTL (default 60s).
 */
export async function getHolderRewardBps() {
  const { getRuntimeConfigBps } = await import("./runtime-config.js");
  return getRuntimeConfigBps("holder_reward_bps", HOLDER_REWARD_BPS_FALLBACK);
}
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

import { randomInt as _cryptoRandomInt } from "node:crypto";

function pickNextDistributionDelay() {
  // crypto.randomInt instead of Math.random for the snapshot timing.
  // Math.random is a Mersenne-Twister PRNG — predictable to anyone who
  // observes 624 consecutive outputs. The previous distribution time
  // is on-chain (it's a SOL transfer), so a sophisticated adversary
  // could fingerprint the PRNG state across distributions and then
  // predict the next snapshot ±0.0 ms, defeating the anti-dump random
  // window entirely (front-run the snapshot with a giant $MAGPIE buy,
  // claim the pro-rata reward, dump). crypto.randomInt is CSPRNG; no
  // amount of historical observation reveals the next output.
  const span = DIST_WINDOW_MAX_MS - DIST_WINDOW_MIN_MS;
  return DIST_WINDOW_MIN_MS + _cryptoRandomInt(span);
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
  // Fail closed if neither env var is set — never fall back to a CWD-
  // relative default path. See cosign-borrow.js for the same pattern.
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) {
    throw new Error(
      "[magpie-holder-rewards] LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set — refusing to fall back to a CWD-relative default",
    );
  }
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
  // Read the LIVE bps from governance_config (autopilot will flip
  // this from 10% to 70% the moment MGP-001 ratifies — accrual on
  // every subsequent fee event picks up the new rate without a
  // code deploy).
  const liveBps = await getHolderRewardBps();
  const reward = (fee * BigInt(Math.round(liveBps))) / 10_000n;
  if (reward <= 0n) return null;
  try {
    await query(
      `UPDATE magpie_holder_pool
          SET accrued_lamports = accrued_lamports + $1::numeric,
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
    next_run_snapshot_only: rows[0].next_run_snapshot_only === true,
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

  // 1. On-chain in-wallet balance (source of truth — DB doesn't
  //    track every wallet). Sum across ALL token accounts owned by
  //    this wallet for $MAGPIE, not just the ATA — some users hold
  //    via non-ATA accounts (legacy from before ATAs were standard,
  //    or multi-account positions). Matches the snapshot logic
  //    exactly.
  let heldRaw = 0n;
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
      heldRaw += data.readBigUInt64LE(64);
    }
    exists = accounts.value.length > 0;
  } catch {
    /* malformed wallet → return zero state */
  }

  // 1b. Collateralized $MAGPIE — active loans where the borrower's
  //     wallet matches AND collateral mint is $MAGPIE. The actual
  //     holder-rewards snapshot (snapshotMagpieHolders) credits this,
  //     so the live "EST NEXT PAYOUT" estimate must include it too —
  //     otherwise the user sees a smaller estimate than they'll
  //     actually receive. Same principle as governance voting weight:
  //     using the protocol doesn't reduce your share.
  let collateralizedRaw = 0n;
  try {
    const { rows } = await query(
      `SELECT COALESCE(SUM(collateral_amount::numeric), 0)::text AS total
         FROM loans
        WHERE collateral_mint = $1
          AND status = 'active'
          AND borrower_wallet = $2`,
      [MAGPIE_MINT.toBase58(), walletAddress],
    );
    collateralizedRaw = BigInt(rows[0]?.total ?? "0");
  } catch {
    /* if loans table unreachable, fall back to in-wallet only */
  }
  const balanceRaw = heldRaw + collateralizedRaw;
  if (collateralizedRaw > 0n) exists = true;

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
  //    otherwise from getEffectiveEligibleSupply() (circulating supply
  //    minus exempt-wallet holdings). Using effective-eligible instead
  //    of raw circulating gives holders an accurate pre-first-snapshot
  //    estimate that already accounts for operator-curated exemptions —
  //    so removing wallets from the pool actually shows up as larger
  //    slices for the remaining holders.
  //    We DO expose the estimate (size of slice) but NOT when the slice
  //    will be paid — that timing stays private to prevent dump-after-snapshot
  //    behavior.
  let estimatedNextPayout = 0n;
  let estimatedNextPayoutLive = 0n; // before adding planned-future
  try {
    const [poolState, lastSnap] = await Promise.all([
      getHolderPoolState(),
      query(
        `SELECT total_balance FROM magpie_holder_distributions
          ORDER BY snapshot_at DESC LIMIT 1`,
      ),
    ]);
    // The pool the user's slice is computed against. Two components:
    //   - accrued_lamports: real, already-collected fees sitting in
    //     the pool right now.
    //   - planned addition (HOLDER_REWARD_POOL_PLANNED_ADD_LAMPORTS):
    //     an operator-committed future top-up. When the operator
    //     plans to add ~10 SOL to the pool before the next
    //     distribution, setting this env to 10_000_000_000 lets the
    //     dashboard reflect that promise in the user's estimate.
    //     Default 0 — no promise, no inflated estimate.
    let planned = 0n;
    try {
      const raw = process.env.HOLDER_REWARD_POOL_PLANNED_ADD_LAMPORTS;
      if (raw) {
        const parsed = BigInt(raw);
        if (parsed >= 0n) planned = parsed;
      }
    } catch {
      /* invalid env value → 0 */
    }
    const effectivePool = poolState.accrued_lamports + planned;
    if (effectivePool > 0n && balanceRaw > 0n) {
      const totalBalance = lastSnap.rows[0]
        ? BigInt(lastSnap.rows[0].total_balance)
        : await getEffectiveEligibleSupply().catch(() => 0n);
      if (totalBalance > 0n) {
        estimatedNextPayout = (effectivePool * balanceRaw) / totalBalance;
        // Also surface the "live-pool-only" estimate so callers can
        // tell the user what they'd get RIGHT NOW vs after the planned
        // addition lands. If planned == 0, these are equal.
        estimatedNextPayoutLive = (poolState.accrued_lamports * balanceRaw) / totalBalance;
      }
    }
  } catch {
    /* best-effort estimate — fall through with 0 */
  }

  // Live bps for downstream display ("rewards earn at X% of every fee").
  const liveBps = await getHolderRewardBps();

  return {
    wallet: walletAddress,
    balance_raw: balanceRaw.toString(),
    held_raw: heldRaw.toString(),
    collateralized_raw: collateralizedRaw.toString(),
    has_balance: exists && balanceRaw > 0n,
    lifetime_lamports: BigInt(totals[0]?.lifetime ?? "0"),
    paid_lamports: BigInt(totals[0]?.paid ?? "0"),
    pending_lamports: BigInt(totals[0]?.pending ?? "0"),
    distributions_count: totals[0]?.distributions_count ?? 0,
    estimated_next_payout_lamports: estimatedNextPayout,
    estimated_next_payout_live_lamports: estimatedNextPayoutLive,
    holder_reward_bps_live: liveBps,
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

/**
 * Effective eligible supply for fallback estimate calculation.
 *
 * Used as the denominator in `estimated_next_payout` ONLY before the
 * first real snapshot exists. Once at least one distribution has run,
 * lastSnap.total_balance is preferred — that already excludes every
 * exempt wallet because it was computed from the post-filter byOwner
 * set in snapshotMagpieHolders().
 *
 * Subtracting exempt holdings here means the pre-first-snapshot
 * estimate reflects what eligible holders will ACTUALLY receive,
 * not a worst-case "if exempt wallets were eligible" lower bound.
 *
 * Cached for 5 minutes — 3-4 RPC calls per recompute and the answer
 * doesn't change often enough to recompute on every wallet query.
 */
let _eligibleSupplyCache = null;
let _eligibleSupplyCacheExpiresAt = 0;
const ELIGIBLE_SUPPLY_TTL_MS = 5 * 60 * 1000;

export async function getEffectiveEligibleSupply() {
  if (_eligibleSupplyCache !== null && Date.now() < _eligibleSupplyCacheExpiresAt) {
    return _eligibleSupplyCache;
  }
  const circulating = await getMagpieCirculatingSupply();
  // Merge hardcoded baseline with operator-curated exempt list.
  const exempt = new Set(EXCLUDED_WALLETS);
  try {
    const { rows } = await query(`SELECT wallet_address FROM airdrop_exempt_wallets`);
    for (const r of rows) exempt.add(r.wallet_address);
  } catch {
    // Fail open: if the exempt table is unreachable, fall back to
    // baseline only. The estimate is informational, not authoritative.
  }
  let exemptBalance = 0n;
  for (const w of exempt) {
    try {
      const accounts = await connection.getTokenAccountsByOwner(
        new PublicKey(w),
        { mint: MAGPIE_MINT, programId: MAGPIE_TOKEN_PROGRAM },
        { commitment: "confirmed" },
      );
      for (const a of accounts.value) {
        const data = a.account.data;
        if (data.length < 72) continue;
        exemptBalance += data.readBigUInt64LE(64);
      }
    } catch {
      // Wallet has no $MAGPIE ATA or RPC blip — counts as 0.
    }
  }
  _eligibleSupplyCache = circulating > exemptBalance ? circulating - exemptBalance : 0n;
  _eligibleSupplyCacheExpiresAt = Date.now() + ELIGIBLE_SUPPLY_TTL_MS;
  return _eligibleSupplyCache;
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
  // Merge the hardcoded baseline (burn/system/protocol) with the
  // operator-curated permanent exempt list from the DB. The DB rows
  // are managed via the private magpiecapital/magpie-airdrop repo's
  // scripts/exempt-wallet.js — addresses themselves stay private
  // (DB-only); only the table existence is public in this code.
  const exempt = new Set(EXCLUDED_WALLETS);
  try {
    const { rows: extraExempt } = await query(
      `SELECT wallet_address FROM airdrop_exempt_wallets`,
    );
    for (const r of extraExempt) exempt.add(r.wallet_address);
  } catch (err) {
    // Table doesn't exist yet (pre-migration) or DB blip — fall back
    // to hardcoded baseline only. Distribution still works; we just
    // don't filter operator extras this round.
    console.warn("[holder-rewards] exempt-list load failed (using baseline only):", err.message);
  }

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
    if (exempt.has(owner)) continue;

    const amount = data.readBigUInt64LE(64);
    if (amount < MIN_HOLDER_BALANCE_RAW) continue;

    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amount);
  }

  // ── Credit $MAGPIE tokens locked as loan collateral ──
  // When a user borrows against their $MAGPIE, the tokens move into
  // the lending program's collateralVault PDA. That PDA's owner is
  // the program, so the contract-exclusion sweep below would filter
  // those vaults out, silently punishing the exact users who are
  // MOST engaged with the protocol.
  //
  // Fix: read every active $MAGPIE-collateralized loan from the DB,
  // attribute the locked amount to the borrower's wallet, and merge
  // into byOwner BEFORE the PDA filter runs. This way the PDA sweep
  // still applies to every wallet (defensive — if a borrower_wallet
  // were ever a contract, the System-program check below would
  // exclude it), but real user wallets get fully credited for both
  // in-wallet AND in-collateral $MAGPIE.
  try {
    const { rows: collateralized } = await query(
      `SELECT borrower_wallet, collateral_amount
         FROM loans
        WHERE collateral_mint = $1
          AND status = 'active'
          AND borrower_wallet IS NOT NULL`,
      [MAGPIE_MINT.toBase58()],
    );
    let creditedCount = 0;
    for (const row of collateralized) {
      const owner = row.borrower_wallet;
      // Honor BOTH the hardcoded baseline AND the operator's DB-curated
      // exempt list. A wallet on either should never get an allocation
      // even when it holds collateralized $MAGPIE.
      if (!owner || exempt.has(owner)) continue;
      const locked = BigInt(String(row.collateral_amount || "0"));
      if (locked <= 0n) continue;
      byOwner.set(owner, (byOwner.get(owner) ?? 0n) + locked);
      creditedCount++;
    }
    if (creditedCount > 0) {
      console.log(
        `[holder-rewards] Crediting ${creditedCount} active $MAGPIE-collateralized loan(s) into the holder snapshot`,
      );
    }
  } catch (err) {
    // Don't fail the whole snapshot — log and continue with on-chain-only.
    console.error(
      "[holder-rewards] Failed to merge collateralized $MAGPIE into snapshot (continuing with on-chain only):",
      err.message,
    );
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
  // If the operator has armed a snapshot-only run, capture the holder set
  // and pro-rata allocations but defer the actual SOL transfers. The flag
  // resets to FALSE after this run; subsequent distributions auto-pay
  // again unless re-armed.
  const snapshotOnly = state.next_run_snapshot_only === true;
  // Auto-pay path needs a non-empty pool; snapshot-only path captures the
  // holder list regardless (allocations may be zero — operator can override
  // the amount at /distribute time and recompute pro-rata using the stored
  // balance_at_snapshot per row).
  if (!snapshotOnly && pool <= 0n) return null;

  // Don't run a distribution if the pool is too small — tx fees would
  // eat more than the rewards. Wait for it to build up over more weeks.
  if (pool < MIN_DISTRIBUTION_LAMPORTS) {
    console.log(
      `[holder-rewards] Pool ${Number(pool) / 1e9} SOL below minimum ${Number(MIN_DISTRIBUTION_LAMPORTS) / 1e9} — deferring distribution`,
    );
    return null;
  }

  // Pre-flight: lender must cover the entire pool + safety reserve.
  // Skipped in snapshot-only mode since no SOL moves during the snapshot.
  const lender = loadLenderKeypair();
  if (!snapshotOnly) {
    const lenderBalance = BigInt(await connection.getBalance(lender.publicKey));
    if (lenderBalance < pool + MIN_LENDER_RESERVE_LAMPORTS) {
      console.warn(
        `[holder-rewards] Distribution skipped: lender ${lenderBalance} < pool ${pool} + reserve ${MIN_LENDER_RESERVE_LAMPORTS}`,
      );
      return null;
    }
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
      // Snapshot-only mode: rows go to 'snapshot_pending' so the retry
      // loop ignores them. Operator flips them to 'accrued' via /distribute
      // when ready, at which point the retry loop pays them out.
      const initialStatus = snapshotOnly ? "snapshot_pending" : "accrued";
      const placeholders = inserts
        .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, '${initialStatus}')`)
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

    // Snapshot-only: don't decrement the pool, don't advance the cron,
    // don't set last_distribution_at — the SOL hasn't actually moved.
    // Just reset the snapshot-only flag so a future fire defaults back to
    // auto-pay behavior. Operator decides next steps via /distribute.
    if (snapshotOnly) {
      await client.query(
        `UPDATE magpie_holder_pool
            SET next_run_snapshot_only = FALSE,
                updated_at = NOW()
          WHERE id = 1`,
      );
    } else {
      // Normal path: atomically decrement the pool by what we ALLOCATED
      // — never overwrite to a fixed value. If a concurrent
      // accrueToHolderPool call slips in during this transaction, its
      // increment is preserved. Also reschedule the next run privately.
      const nextDelayMs = pickNextDistributionDelay();
      await client.query(
        `UPDATE magpie_holder_pool
            SET accrued_lamports = accrued_lamports - $1::numeric,
                last_distribution_at = NOW(),
                next_distribution_at = NOW() + ($2 || ' milliseconds')::interval,
                updated_at = NOW()
          WHERE id = 1`,
        [allocatedSum.toString(), Math.floor(nextDelayMs).toString()],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  // Snapshot-only: bail out before any SOL transfers. Return the
  // captured allocation summary so the caller can DM admin.
  if (snapshotOnly) {
    return {
      distribution_id: distributionId,
      pool_lamports: pool,
      holder_count: holders.length,
      eligible_count: rewardRows.length,
      total_balance: totalBalance,
      paid_count: 0,
      paid_lamports: 0n,
      allocated_lamports: allocatedSum,
      mode: "snapshot_only",
    };
  }

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
export function startHolderDistributor(bot) {
  console.log("[holder-rewards] Distributor starting (random 5-10d window, hidden timing)");

  async function adminPing(text) {
    if (!bot) return;
    try {
      const { notifyAdmin } = await import("./admin-notify.js");
      await notifyAdmin(bot, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.warn("[holder-rewards] admin notify failed (non-critical):", err.message);
    }
  }

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

      // 3. Snapshot — auto-pay unless operator armed snapshot-only mode.
      const result = await snapshotAndDistribute();
      if (result) {
        if (result.mode === "snapshot_only") {
          // Holder set captured, allocations computed, NO SOL moved.
          // Operator reviews + triggers payouts manually via /distribute.
          const allocSol = (Number(result.allocated_lamports) / 1e9).toFixed(6);
          const poolSol = (Number(result.pool_lamports) / 1e9).toFixed(6);
          console.log(
            `[holder-rewards] Snapshot-only captured: ${result.eligible_count} eligible holders, ${allocSol} SOL allocated (no payouts yet)`,
          );
          await adminPing(
            [
              "*$MAGPIE holder snapshot captured (snapshot-only mode)*",
              "",
              `Eligible holders: ${result.eligible_count} / ${result.holder_count}`,
              `Pool at snapshot: \`${poolSol} SOL\``,
              `Allocated (pro-rata): \`${allocSol} SOL\``,
              `Distribution ID: \`${result.distribution_id}\``,
              "",
              "_No SOL was sent. Rows are at `snapshot_pending`._",
              `_Trigger payouts with \`/distribute ${result.distribution_id}\` when you're ready._`,
            ].join("\n"),
          );
        } else {
          console.log(
            `[holder-rewards] Distributed: ${Number(result.paid_lamports) / 1e9} SOL paid ` +
              `(of ${Number(result.allocated_lamports) / 1e9} allocated) to ${result.paid_count}/${result.eligible_count} holders`,
          );
          const paidSol = (Number(result.paid_lamports) / 1e9).toFixed(6);
          const allocSol = (Number(result.allocated_lamports) / 1e9).toFixed(6);
          await adminPing(
            [
              "*$MAGPIE holder snapshot complete*",
              "",
              `Paid: \`${paidSol} SOL\` (of \`${allocSol}\` allocated)`,
              `Recipients paid: ${result.paid_count} / ${result.eligible_count} eligible`,
              `Distribution ID: \`${result.distribution_id}\``,
              "",
              "_Next snapshot scheduled internally (timing private)._",
            ].join("\n"),
          );
        }
      }
    } catch (err) {
      console.error("[holder-rewards] tick failed:", err.message);
      await adminPing(`⚠️ *Holder distribution failed*\n\n\`${err.message?.slice(0, 200)}\``);
    }
  }

  setTimeout(tick, 60 * 60 * 1000); // first check 1h after boot
  setInterval(tick, 6 * 60 * 60 * 1000); // then every 6h
}
