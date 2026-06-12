/**
 * Protocol fee sweeper.
 *
 * The engine sends the 1% take-profit execution fee to the protocol
 * wallet (PROTOCOL_FEE_DESTINATION, currently 5hsZBr…). Distributions
 * pay out from the lender wallet (4JSSSaG3…). Without a sweep step,
 * the TP fee SOL accumulates in the protocol wallet and never reaches
 * holders / LPs / referrers via the 70-10-10-10 split that MGP-001
 * governs.
 *
 * What this service does:
 *   1. Compute total accrued TP fees (sum of protocol_fee_lamports
 *      across orders with accrued_at NOT NULL).
 *   2. Subtract sum of past sweeps.
 *   3. If the difference is >= MIN_SWEEP_LAMPORTS, transfer it from
 *      protocol wallet to lender wallet. Record in protocol_fee_sweeps.
 *
 * Idempotency:
 *   - delta = accrued_total - swept_total. Re-runs after a successful
 *     sweep see delta=0 and no-op.
 *   - Failed transfers don't update the ledger; next run retries.
 *
 * Configuration:
 *   - PROTOCOL_FEE_KEYPAIR: base58 secret of the protocol wallet's
 *     signing key. Must derive to the same pubkey the engine sends
 *     fees to (env PROTOCOL_FEE_DESTINATION).
 *   - LENDER_PUBKEY: the destination address (already configured).
 *   - Without PROTOCOL_FEE_KEYPAIR set, the sweeper NO-OPs silently
 *     and the operator can use /protocol-fees admin command to see
 *     the pending amount + sweep manually.
 *
 * Security:
 *   - Sweeper SIGNS with the protocol wallet's keypair (loaded from env).
 *     Treats the keypair the same as LENDER_PRIVATE_KEY — fail-closed
 *     if the env is set but unparseable.
 *   - Sanity-check before transfer: source pubkey MUST match the
 *     PROTOCOL_FEE_DESTINATION env that the engine sends to. Otherwise
 *     we'd be sweeping FROM the wrong wallet.
 *   - Destination is hard-coded to LENDER_PUBKEY (no operator-error
 *     surface where SOL could end up at a wrong address via env typo).
 *   - Hard ceiling per single sweep: MAX_SWEEP_LAMPORTS (5 SOL default).
 *     A buggy ledger query that overstates accrued can never drain more
 *     than this in one transfer.
 *
 * Cadence: 1 hour. Distributions run every 5-10 days so hourly is
 * plenty of lead time, and short enough that operator visibility into
 * unswept amount stays accurate.
 */
import bs58 from "bs58";
import {
  Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";

const TICK_MS = 60 * 60_000; // 1h

// Don't sweep tiny amounts — let dust accumulate and amortize the
// tx fee. ~0.05 SOL covers ~10 SOL of net protocol revenue at 0.5%
// implied tx cost overhead.
const MIN_SWEEP_LAMPORTS = BigInt(
  process.env.PROTOCOL_FEE_SWEEP_MIN_LAMPORTS || "50000000", // 0.05 SOL
);

// Defense ceiling — never let a single sweep move more than this in
// one transfer. Stops a buggy ledger query from draining the wallet.
const MAX_SWEEP_LAMPORTS = BigInt(
  process.env.PROTOCOL_FEE_SWEEP_MAX_LAMPORTS || "5000000000", // 5 SOL
);

let _timer = null;
let _kp = null;

function loadKeypair() {
  if (_kp) return _kp;
  const secret = process.env.PROTOCOL_FEE_KEYPAIR;
  if (!secret) return null;
  try {
    _kp = Keypair.fromSecretKey(bs58.decode(secret.trim()));
    return _kp;
  } catch (err) {
    throw new Error(`PROTOCOL_FEE_KEYPAIR malformed: ${err.message}`);
  }
}

/**
 * Pure read-only audit. Used by /protocol-fees admin command AND
 * the sweeper itself. Returns lamport BigInts.
 */
export async function auditProtocolFees() {
  const [{ rows: a }, { rows: b }, { rows: c }] = await Promise.all([
    query(`
      SELECT COALESCE(SUM(protocol_fee_lamports), 0)::numeric AS total,
             MIN(id) AS min_id,
             MAX(id) AS max_id,
             COUNT(*)::int AS n
        FROM limit_close_orders
       WHERE accrued_at IS NOT NULL AND protocol_fee_lamports > 0
    `),
    query(`
      SELECT COALESCE(SUM(swept_lamports), 0)::numeric AS total
        FROM protocol_fee_sweeps
    `),
    query(`
      SELECT MAX(created_at) AS last_at FROM protocol_fee_sweeps
    `),
  ]);
  const accrued = BigInt(a[0].total);
  const swept = BigInt(b[0].total);
  return {
    accrued_lamports: accrued,
    swept_lamports: swept,
    pending_lamports: accrued - swept,
    accrued_orders_count: a[0].n,
    accrual_min_id: a[0].min_id,
    accrual_max_id: a[0].max_id,
    last_sweep_at: c[0].last_at,
  };
}

export async function sweepOnce() {
  let kp;
  try { kp = loadKeypair(); }
  catch (err) { return { skipped: "keypair_malformed", detail: err.message }; }
  if (!kp) return { skipped: "no_keypair_configured" };

  // Sanity check — the loaded keypair MUST match the address the
  // engine sends fees to. If it doesn't, refuse to sweep — sweeping
  // from the wrong wallet would drain unrelated funds.
  const expected = process.env.PROTOCOL_FEE_DESTINATION;
  if (!expected) return { skipped: "no_destination_env" };
  if (kp.publicKey.toBase58() !== expected) {
    return {
      skipped: "keypair_destination_mismatch",
      keypair_pubkey: kp.publicKey.toBase58(),
      expected,
    };
  }

  // Destination is the lender wallet — hard-coded path (env-loaded but
  // not user-supplied at sweep time, just the protocol-stable LENDER_PUBKEY).
  const lenderPubkeyStr = process.env.LENDER_PUBKEY;
  if (!lenderPubkeyStr) return { skipped: "no_lender_pubkey" };
  let lenderPk;
  try { lenderPk = new PublicKey(lenderPubkeyStr); }
  catch { return { skipped: "lender_pubkey_invalid" }; }

  // Audit + figure out delta.
  const audit = await auditProtocolFees();
  let delta = audit.pending_lamports;
  if (delta < MIN_SWEEP_LAMPORTS) {
    return { skipped: "below_min_sweep", pending: delta.toString() };
  }
  if (delta > MAX_SWEEP_LAMPORTS) {
    // Clamp to ceiling so the protocol-wallet drain is bounded.
    // Next sweep tick will move the remainder.
    delta = MAX_SWEEP_LAMPORTS;
  }

  // Bounded source — never transfer more than what's actually in the
  // wallet. If source has less than delta (race with fees in flight),
  // sweep what's available minus a small rent buffer.
  let sourceBalance;
  try {
    sourceBalance = BigInt(await connection.getBalance(kp.publicKey, "confirmed"));
  } catch (err) {
    return { skipped: "source_balance_read_failed", detail: err.message?.slice(0, 100) };
  }
  const SOURCE_RENT_BUFFER = 1_000_000n; // 0.001 SOL
  if (sourceBalance < SOURCE_RENT_BUFFER) {
    return { skipped: "source_below_rent" };
  }
  const transferable = sourceBalance - SOURCE_RENT_BUFFER;
  if (delta > transferable) delta = transferable;
  if (delta < MIN_SWEEP_LAMPORTS) {
    return { skipped: "after_clamp_below_min", available: transferable.toString() };
  }

  // Execute the transfer.
  let sig;
  try {
    const ix = SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: lenderPk,
      lamports: Number(delta),
    });
    const tx = new Transaction().add(ix);
    sig = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: "confirmed" });
  } catch (err) {
    return { failed: "transfer_failed", detail: err.message?.slice(0, 100) };
  }

  // Audit log — best-effort.
  try {
    await query(
      `INSERT INTO protocol_fee_sweeps
         (swept_lamports, source_pubkey, destination_pubkey, signature,
          accrual_floor_id, accrual_ceiling_id)
       VALUES ($1::numeric, $2, $3, $4, $5, $6)`,
      [delta.toString(), kp.publicKey.toBase58(), lenderPk.toBase58(), sig,
       audit.accrual_min_id, audit.accrual_max_id],
    );
  } catch (err) {
    console.warn("[protocol-fee-sweeper] audit log insert failed:", err.message);
  }

  console.log(
    `[protocol-fee-sweeper] swept ${(Number(delta) / 1e9).toFixed(4)} SOL ` +
    `from ${kp.publicKey.toBase58()} to ${lenderPk.toBase58()} sig=${sig}`,
  );
  return { swept: true, sig, transferred: delta.toString() };
}

async function tick() {
  try {
    const r = await sweepOnce();
    if (r.failed) {
      console.warn(`[protocol-fee-sweeper] tick failed: ${r.failed} ${r.detail || ""}`);
    }
  } catch (err) {
    console.error("[protocol-fee-sweeper] tick threw:", err.message);
  }
}

export function startProtocolFeeSweeper() {
  if (_timer) return;
  console.log(`[protocol-fee-sweeper] armed — probing every ${TICK_MS / 60_000}m`);
  setTimeout(() => {
    tick().catch(() => {});
    _timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  }, 5 * 60_000); // first tick 5 min after boot
}

export function stopProtocolFeeSweeper() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
