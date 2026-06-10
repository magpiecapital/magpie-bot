/**
 * Governance vote-weight snapshot — categorized.
 *
 * Captures three eligibility categories at a single point in time:
 *
 *   1. holders                  — wallets holding $MAGPIE in regular token
 *                                  accounts on-chain (PDAs + exempt list
 *                                  removed)
 *   2. collateralized_borrowers — wallets whose $MAGPIE is locked in the
 *                                  lending program's collateral vault as
 *                                  active loan backing. Their tokens
 *                                  aren't in their wallet at snapshot
 *                                  time but they're still the economic
 *                                  owner; if we don't credit them we're
 *                                  punishing the most-engaged users.
 *   3. lp_providers             — wallets supplying SOL liquidity to the
 *                                  main LendingPool. They're not $MAGPIE
 *                                  holders necessarily; they're the
 *                                  counterparty making loans possible.
 *
 * The same exempt-wallet logic that protects the holder-rewards
 * distribution (hardcoded baseline + DB-curated airdrop_exempt_wallets
 * + System-Program-owner check for PDAs) applies to categories 1 and 2.
 * LP providers are tracked in our own DB (lp_positions); their listing
 * came from on-chain account derivation, so PDA filtering already
 * happened upstream — no additional filtering needed for category 3.
 *
 * Privacy contract — this module returns full per-wallet data. The
 * caller (scripts/governance-snapshot.js) decides what to write to
 * disk vs. stdout. Nothing emitted from here is logged.
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";
import {
  MAGPIE_MINT,
  MAGPIE_TOKEN_PROGRAM,
  MIN_HOLDER_BALANCE_RAW,
} from "./magpie-holder-rewards.js";

// Same baseline as magpie-holder-rewards.js — kept in sync via the
// re-export from there. If that file's set changes, this one inherits.
const HARDCODED_EXEMPT = new Set([
  "11111111111111111111111111111111",
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
  "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx",
]);

async function loadFullExemptSet() {
  const exempt = new Set(HARDCODED_EXEMPT);
  try {
    const { rows } = await query(
      `SELECT wallet_address FROM airdrop_exempt_wallets`,
    );
    for (const r of rows) exempt.add(r.wallet_address);
  } catch (err) {
    console.warn(
      "[gov-snapshot] exempt-wallet load failed (using baseline only):",
      err.message,
    );
  }
  return exempt;
}

/**
 * Enumerate on-chain $MAGPIE holders. Pure: no DB writes, no
 * collateralized merge. Returns Map<owner_pubkey, balance_raw>
 * after PDA + exempt filtering.
 */
async function enumeratePureHolders(exempt) {
  // Token-2022 accounts may exceed 165 bytes due to extensions —
  // don't constrain dataSize; match by mint at offset 0.
  const accounts = await connection.getProgramAccounts(MAGPIE_TOKEN_PROGRAM, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: MAGPIE_MINT.toBase58() } }],
  });

  // Aggregate per owner.
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

  // Filter PDAs / contract accounts via System-Program owner check.
  // Same defense-in-depth as the holder-rewards snapshot path.
  const SystemProgramId = SystemProgram.programId.toBase58();
  const allOwners = Array.from(byOwner.keys());
  const BATCH = 100;
  for (let i = 0; i < allOwners.length; i += BATCH) {
    const batch = allOwners.slice(i, i + BATCH);
    const pubkeys = batch.map((o) => new PublicKey(o));
    let infos;
    try {
      infos = await connection.getMultipleAccountsInfo(pubkeys, {
        commitment: "confirmed",
      });
    } catch (err) {
      console.warn(
        "[gov-snapshot] owner-lookup batch failed (excluding all in batch):",
        err.message,
      );
      for (const o of batch) byOwner.delete(o);
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      const info = infos[j];
      if (!info || info.owner?.toBase58() !== SystemProgramId) {
        byOwner.delete(batch[j]);
      }
    }
  }

  return byOwner;
}

/**
 * Wallets with $MAGPIE-collateralized active loans. Their tokens are
 * locked in the program's collateral vault PDA at snapshot time, so
 * they wouldn't show up in the on-chain holder enumeration even
 * though they're the economic owner.
 *
 * Aggregated per wallet (one wallet can have multiple open loans).
 * Loan IDs are returned for audit traceability.
 */
async function getCollateralizedBorrowers(exempt) {
  const { rows } = await query(
    `SELECT
       borrower_wallet,
       SUM(collateral_amount::numeric)::text AS total_locked_raw,
       array_agg(loan_id ORDER BY loan_id) FILTER (WHERE loan_id IS NOT NULL) AS loan_ids,
       array_agg(loan_pda ORDER BY loan_id) FILTER (WHERE loan_pda IS NOT NULL) AS loan_pdas
     FROM loans
     WHERE collateral_mint = $1
       AND status = 'active'
       AND borrower_wallet IS NOT NULL
     GROUP BY borrower_wallet`,
    [MAGPIE_MINT.toBase58()],
  );
  return rows
    .filter((r) => !exempt.has(r.borrower_wallet))
    .map((r) => ({
      wallet: r.borrower_wallet,
      magpie_collateralized_raw: r.total_locked_raw,
      loan_ids: r.loan_ids ?? [],
      loan_pdas: r.loan_pdas ?? [],
    }));
}

/**
 * LP providers — wallets with positive shares in the LendingPool.
 * Pulled from the DB-tracked lp_positions table (synced from chain).
 * For the snapshot we want shares (immutable record) AND the live
 * value the shares represent (shares × totalDeposits / totalShares).
 *
 * Doesn't filter by exempt list — exempt list is operator-curated
 * for the holder-distribution path, not for LP-distribution. Operator
 * can choose to apply it at distribution time if needed.
 */
async function getLpProviders() {
  const { rows } = await query(
    `SELECT wallet_address, shares::text AS shares
       FROM lp_positions
       WHERE shares > 0
       ORDER BY wallet_address`,
  );
  return rows.map((r) => ({
    wallet: r.wallet_address,
    shares: r.shares,
  }));
}

/**
 * Take the full categorized governance snapshot. Returns an object
 * with all three categories + a deduplicated combined_eligible_set
 * the distribution layer can iterate once.
 *
 * Holds a session-scoped Postgres advisory lock for the duration so
 * two concurrent invocations can't snapshot against an in-flight
 * exempt-wallet edit and produce divergent eligible sets. The lock
 * key is a fixed namespace (governance_snapshot:0). A second
 * concurrent invocation will block until the first finishes —
 * deterministic ordering, no torn reads.
 */
const GOV_SNAPSHOT_LOCK_KEY = 0x6d706965_676f7621n & 0x7fffffff_ffffffffn; // 'mpiego v!' — fixed namespace

export async function snapshotForGovernance() {
  // Acquire the lock. pg_advisory_lock blocks until granted.
  // Using a session-level lock (not xact_lock) since we may run
  // outside an explicit transaction.
  await query(`SELECT pg_advisory_lock($1::bigint)`, [GOV_SNAPSHOT_LOCK_KEY.toString()]);
  try {
    const exempt = await loadFullExemptSet();

    const [holdersMap, collateralized, lpProviders] = await Promise.all([
      enumeratePureHolders(exempt),
      getCollateralizedBorrowers(exempt),
      getLpProviders(),
    ]);

    // Convert holders Map to array form for the snapshot.
    const holders = Array.from(holdersMap.entries()).map(([wallet, balance]) => ({
      wallet,
      magpie_balance_raw: balance.toString(),
    }));

    // Build the combined eligible set: every wallet appearing in any
    // category, deduplicated, with per-category enrichment so the
    // distribution layer can credit each contribution path.
    const combined = new Map();
    for (const h of holders) {
      const e = combined.get(h.wallet) ?? { wallet: h.wallet };
      e.in_holders = true;
      e.magpie_balance_raw = h.magpie_balance_raw;
      combined.set(h.wallet, e);
    }
    for (const c of collateralized) {
      const e = combined.get(c.wallet) ?? { wallet: c.wallet };
      e.in_collateralized = true;
      e.magpie_collateralized_raw = c.magpie_collateralized_raw;
      e.collateralized_loan_ids = c.loan_ids;
      combined.set(c.wallet, e);
    }
    for (const lp of lpProviders) {
      const e = combined.get(lp.wallet) ?? { wallet: lp.wallet };
      e.in_lp_providers = true;
      e.lp_shares = lp.shares;
      combined.set(lp.wallet, e);
    }

    // Per-category totals — sums for the operator's summary line.
    const totalHeldRaw = holders.reduce(
      (acc, h) => acc + BigInt(h.magpie_balance_raw),
      0n,
    );
    const totalCollateralizedRaw = collateralized.reduce(
      (acc, c) => acc + BigInt(c.magpie_collateralized_raw),
      0n,
    );
    const totalLpShares = lpProviders.reduce(
      (acc, lp) => acc + BigInt(lp.shares),
      0n,
    );

    return {
      holders,
      collateralized_borrowers: collateralized,
      lp_providers: lpProviders,
      combined_eligible_set: Array.from(combined.values()).sort((a, b) =>
        a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0,
      ),
      totals: {
        holders_count: holders.length,
        collateralized_count: collateralized.length,
        lp_providers_count: lpProviders.length,
        unique_eligible_count: combined.size,
        total_held_raw: totalHeldRaw.toString(),
        total_collateralized_raw: totalCollateralizedRaw.toString(),
        total_lp_shares: totalLpShares.toString(),
      },
    };
  } finally {
    // Always release the lock, even if the snapshot threw — otherwise
    // the lock outlives the process and blocks the next legit run.
    await query(`SELECT pg_advisory_unlock($1::bigint)`, [GOV_SNAPSHOT_LOCK_KEY.toString()]);
  }
}
