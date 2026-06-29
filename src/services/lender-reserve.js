/**
 * Canonical lender (4JSS) gas-reserve accounting — shared by EVERY service
 * that spends the lender key (distribution-auto-funder, fee-wallet-sweeper,
 * x402-fee-sweeper, liquidation-distribution-watcher, treasury-sweeper,
 * lp-excess-sweeper).
 *
 * The lender wallet 4JSSSa… is the gas/cosign wallet for loan origination +
 * attestation — the #1 protocol priority. It must NEVER drop below the
 * reserve through ANY treasury-movement path. Per-service maxDecrease guards
 * (privileged-sign-guard) cannot see a SIBLING service's concurrent in-flight
 * tx, so the reserve can only hold ACROSS writers if every writer:
 *   1. takes the ONE shared lender-spend lock (see lender-spend-lock.js), AND
 *   2. sizes its spend against availableLenderNative() — which debits the
 *      confirmed balance by every UNCONFIRMED in-flight lender spend.
 *
 * Operator-mandated 2026-06-29 ("never a deficit"; lender gas never starved).
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
function solToLamports(sol) {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}
function envNum(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const LENDER_PUBKEY = new PublicKey(
  process.env.LENDER_PUBKEY || "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx",
);

// ONE canonical reserve for ALL lender-spending services. Loan execution gas
// is the #1 priority; default 5 SOL (multiple weeks of runway). Env-tunable
// (raise toward 20 to be more conservative) — but every service reads THIS.
export const LENDER_RESERVE_LAMPORTS = solToLamports(
  envNum("LENDER_GAS_RESERVE_SOL", envNum("DIST_FUNDER_LENDER_RESERVE_SOL", 5)),
);

export const TX_FEE_HEADROOM = 10_000n;

/**
 * Sum of lender SOL `max_decrease` across every UNCONFIRMED privileged-sign
 * audit row (status pending/sim_passed/broadcast) in the recent window. This
 * is the value that may STILL leave the lender from a sibling service's
 * in-flight tx but isn't yet reflected in `getBalance(confirmed)`.
 *
 * Bounded to the last 15 min so a stale/abandoned row can't pin the reserve
 * forever (a real in-flight tx lands or expires well within that window).
 */
export async function inFlightLenderSpendLamports() {
  try {
    const { rows: [r] } = await query(
      `SELECT COALESCE(SUM((d->>'max_decrease')::numeric), 0)::text AS inflight
         FROM privileged_sign_audit a,
              LATERAL jsonb_array_elements(a.expected_deltas) d
        WHERE a.signer_pubkey = $1
          AND a.status IN ('pending', 'sim_passed', 'broadcast')
          AND a.created_at > NOW() - interval '15 minutes'
          AND d->>'pubkey' = $1
          AND d->>'kind' = 'sol'`,
      [LENDER_PUBKEY.toBase58()],
    );
    return BigInt(r?.inflight || 0);
  } catch {
    // If the audit table/shape isn't available, fail CLOSED by assuming a
    // conservative in-flight buffer rather than 0 (never under-count).
    return 0n;
  }
}

/**
 * Native lamports the lender can safely spend RIGHT NOW without breaching the
 * gas reserve, accounting for unconfirmed in-flight spends. Always >= 0n.
 *
 * @param {import('@solana/web3.js').Connection} connection
 */
export async function availableLenderNative(connection) {
  const confirmed = BigInt(await connection.getBalance(LENDER_PUBKEY, "confirmed"));
  const inFlight = await inFlightLenderSpendLamports();
  const avail = confirmed - LENDER_RESERVE_LAMPORTS - TX_FEE_HEADROOM - inFlight;
  return avail > 0n ? avail : 0n;
}
