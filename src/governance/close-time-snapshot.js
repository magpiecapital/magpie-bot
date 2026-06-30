/**
 * Close-time snapshot — capture voter balances at proposal close so
 * tally weights reflect WHO CURRENTLY HOLDS $MAGPIE, not who held it
 * at proposal activation.
 *
 * Why this exists
 * ───────────────
 * The original snapshot-at-activation model meant anyone who SOLD
 * their $MAGPIE during the voting window could still vote (their
 * snapshot weight was locked in at activation). And anyone who
 * BOUGHT during the window couldn't (they weren't in the snapshot).
 *
 * Operator-stated goal 2026-06-13: "We want to make sure that we are
 * rewarding the current holders." Close-time snapshot delivers
 * exactly that: voter weight = $MAGPIE balance at vote close.
 * Sellers' votes silently zero-out at tally; buyers can vote during
 * the window and have their weight count.
 *
 * What this module does NOT do
 * ────────────────────────────
 * Live-balance voting (re-evaluating weight every second) would
 * open vote-duplication attacks (vote, send to alt, alt votes too,
 * repeat — same single-block flashloan pattern attackers use on
 * AMM-token DAOs). Close-time snapshot is the inclusive-AND-secure
 * compromise that addresses the operator's concern without the
 * double-voting hole.
 *
 * How it works at close
 * ─────────────────────
 *   1. Pull every distinct voter_pubkey from governance_votes for
 *      the closing proposal.
 *   2. For each voter, fetch their current $MAGPIE token-account
 *      balance via Helius / Solana RPC. Parallelism bounded to avoid
 *      rate-limit storms.
 *   3. Pull the mint's circulating supply at close (for the
 *      participation denominator).
 *   4. UPSERT rows into governance_snapshot_weights with
 *      snapshot_id = '<proposal_id>_close'. Pipeline tally already
 *      reads from this table — no tally-side change required.
 *
 * Excluded-wallet rules
 * ─────────────────────
 * Tokens still locked as collateral against an active loan COUNT
 * toward the borrower's vote weight (operator rule from the
 * activation snapshot — the borrower is the beneficial owner).
 * Tokens held by the lender wallet, treasury, and Streamflow
 * contracts do NOT count — they're protocol-controlled, not holder
 * votes.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import crypto from "node:crypto";
import { query } from "../db/pool.js";

const MAGPIE_MINT = process.env.MAGPIE_TOKEN_MINT || "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump";
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
// Bounded parallelism for the per-voter balance fetches. Helius
// free tier rate-limits at ~10 RPS sustained; 8 leaves headroom.
const BALANCE_FETCH_CONCURRENCY = Number(process.env.GOV_BALANCE_FETCH_CONCURRENCY) || 8;
// Wallets whose balances should NOT count as voter weight. Operator-
// configurable via env so we don't redeploy when treasury moves.
const PROTOCOL_EXCLUDED_WALLETS = (process.env.GOV_EXCLUDED_WALLETS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Fetch a single wallet's $MAGPIE balance. Returns BigInt lamports
 * (raw, NOT decimal-adjusted). Returns 0n if the ATA doesn't exist
 * or has zero balance — those are voters who legitimately don't
 * hold any tokens at close.
 */
async function fetchMagpieBalance(connection, walletStr, mintPk, tokenProgram) {
  try {
    const owner = new PublicKey(walletStr);
    // tokenProgram MUST match the mint's owning program. $MAGPIE is Token-2022;
    // deriving/reading the CLASSIC SPL ATA returns 0 for a Token-2022 holder,
    // which silently zeroed every voter's wallet-held weight (3-wallet bug).
    const ata = await getAssociatedTokenAddress(mintPk, owner, false, tokenProgram);
    const acct = await getAccount(connection, ata, "confirmed", tokenProgram);
    return BigInt(acct.amount.toString());
  } catch {
    // ATA not initialized = wallet currently holds zero tokens.
    // Not an error — just a voter with no current weight.
    return 0n;
  }
}

/**
 * Run the close-time snapshot for a proposal. Returns the
 * snapshot_id that pipeline.tally can pass into its existing flow.
 *
 * Idempotent: re-running for the same proposal upserts the same
 * snapshot_id row. Safe to call from the autopilot pipeline more
 * than once if the first attempt fails partway.
 */
export async function takeCloseTimeSnapshot({ proposalId, totalCirculatingRaw = null }) {
  if (!/^MGP-\d{3}$/.test(proposalId)) {
    throw new Error(`invalid proposal_id: ${proposalId}`);
  }
  const snapshotId = `${proposalId}_close`;
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const mintPk = new PublicKey(MAGPIE_MINT);

  // Detect the mint's owning token program ONCE (classic SPL vs Token-2022) so
  // every balance read uses the correct ATA. $MAGPIE is Token-2022
  // (TokenzQdB…); reading classic-SPL ATAs zeroed all wallet-held weight.
  const mintInfo = await connection.getAccountInfo(mintPk, "confirmed");
  const tokenProgram =
    mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  // 1. Distinct voters from governance_votes for this proposal.
  const { rows: voterRows } = await query(
    `SELECT DISTINCT voter_pubkey FROM governance_votes WHERE proposal_id = $1`,
    [proposalId],
  );
  const voters = voterRows.map((r) => r.voter_pubkey);
  if (voters.length === 0) {
    console.warn(`[close-snapshot] no voters found for ${proposalId} — taking empty snapshot`);
  }

  // 2. Fetch each voter's $MAGPIE balance at close with bounded
  //    parallelism. The connection layer + RPC are the bottleneck;
  //    we keep concurrency capped so a popular proposal with 500+
  //    voters doesn't melt the rate limit.
  const balances = new Map(); // wallet -> BigInt
  for (let i = 0; i < voters.length; i += BALANCE_FETCH_CONCURRENCY) {
    const chunk = voters.slice(i, i + BALANCE_FETCH_CONCURRENCY);
    const results = await Promise.all(chunk.map(async (w) => {
      // Exclude protocol-controlled wallets from the voter set entirely.
      // Their votes don't count even if they happened to be submitted.
      if (PROTOCOL_EXCLUDED_WALLETS.includes(w)) return [w, 0n];
      const bal = await fetchMagpieBalance(connection, w, mintPk, tokenProgram);
      return [w, bal];
    }));
    for (const [w, bal] of results) balances.set(w, bal);
  }

  // Also include collateral-locked weight per the operator's rule
  // (the borrower is the beneficial owner of locked collateral). We
  // pull this from the loans table — any active loan with
  // collateral_mint = $MAGPIE adds collateral_amount to the
  // borrower's weight.
  const { rows: collatRows } = await query(
    `SELECT borrower_wallet, COALESCE(SUM(collateral_amount), 0)::text AS locked_raw
       FROM loans
      WHERE collateral_mint = $1 AND status = 'active'
        AND borrower_wallet = ANY($2::text[])
      GROUP BY borrower_wallet`,
    [MAGPIE_MINT, voters],
  );
  const collateralized = new Map();
  for (const r of collatRows) collateralized.set(r.borrower_wallet, BigInt(r.locked_raw));

  // 3. Total eligible weight (denominator for participation_pct).
  // Caller can pass it in (preferred — they already know the
  // circulating supply for this calc). Otherwise we fall back to
  // (sum of voter balances + sum of locked collateral) which gives
  // the wrong denominator if many holders DIDN'T vote — but ensures
  // we always have a non-zero value.
  let totalEligible = totalCirculatingRaw != null ? BigInt(totalCirculatingRaw) : null;
  if (totalEligible == null) {
    totalEligible = 0n;
    for (const w of balances.values()) totalEligible += w;
    for (const w of collateralized.values()) totalEligible += w;
    if (totalEligible === 0n) {
      // Avoid div-by-zero at tally time. 1 lamport keeps the math
      // sound while clearly representing "we couldn't determine the
      // pool size" — operator should see participation collapse to
      // negligible and investigate.
      totalEligible = 1n;
    }
  }

  // 4. Persist snapshot. Use a deterministic hash over (proposalId,
  //    sorted-voters, totalEligible, locked-sums) so a re-run with
  //    identical inputs produces the same hash — useful for auditability.
  const hashSource = JSON.stringify({
    proposalId,
    voters: [...balances.keys()].sort(),
    balances: [...balances.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([w, b]) => [w, b.toString()]),
    collateralized: [...collateralized.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([w, b]) => [w, b.toString()]),
    totalEligible: totalEligible.toString(),
  });
  const hash = crypto.createHash("sha256").update(hashSource).digest("hex");

  await query("BEGIN");
  try {
    await query(
      `INSERT INTO governance_snapshots
         (snapshot_id, proposal_id, taken_at_utc, hash_sha256, scope_version,
          totals, total_eligible_weight, unique_eligible_count)
       VALUES ($1, $2, NOW(), $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (snapshot_id) DO UPDATE
         SET taken_at_utc = NOW(),
             hash_sha256 = EXCLUDED.hash_sha256,
             scope_version = EXCLUDED.scope_version,
             totals = EXCLUDED.totals,
             total_eligible_weight = EXCLUDED.total_eligible_weight,
             unique_eligible_count = EXCLUDED.unique_eligible_count`,
      [
        snapshotId,
        proposalId,
        hash,
        "close-time-v1",
        JSON.stringify({
          voters_total: balances.size,
          voters_with_balance: [...balances.values()].filter((b) => b > 0n).length,
          collateralized_voters: collateralized.size,
        }),
        totalEligible.toString(),
        balances.size,
      ],
    );
    // Clear any prior weight rows for this snapshot_id then re-insert.
    await query(`DELETE FROM governance_snapshot_weights WHERE snapshot_id = $1`, [snapshotId]);
    for (const [wallet, held] of balances) {
      const locked = collateralized.get(wallet) ?? 0n;
      // Skip wallets with both zero held AND zero locked — they
      // shouldn't be in the eligible set (matches the activation-
      // snapshot's wallet_not_in_snapshot_or_zero_balance gate).
      if (held === 0n && locked === 0n) continue;
      await query(
        `INSERT INTO governance_snapshot_weights
           (snapshot_id, wallet, held_raw, collateralized_raw, lp_shares)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (snapshot_id, wallet) DO UPDATE
           SET held_raw = EXCLUDED.held_raw,
               collateralized_raw = EXCLUDED.collateralized_raw`,
        [snapshotId, wallet, held.toString(), locked.toString()],
      );
    }
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK");
    throw err;
  }

  return {
    snapshotId,
    voterCount: balances.size,
    votersWithBalance: [...balances.values()].filter((b) => b > 0n).length,
    totalEligibleRaw: totalEligible.toString(),
    hashSha256: hash,
  };
}
