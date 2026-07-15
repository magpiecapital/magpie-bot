/**
 * Robust send-and-confirm for legacy Transactions, with a dynamic priority
 * fee and a fresh-blockhash rebroadcast loop.
 *
 * WHY (2026-07-15): a single `sendAndConfirmTransaction` sets one blockhash and
 * waits ~30s; under congestion the tx is dropped and the blockhash expires,
 * surfacing as `TransactionExpiredTimeoutError` and a failed user action
 * (e.g. a stuck withdraw). This helper instead:
 *   1. prepends a DYNAMIC, capped priority fee (see priority-fee.js),
 *   2. re-broadcasts the SAME signed tx every few seconds (a Solana tx pays
 *      its fee only once, on confirm — resending costs nothing extra), and
 *   3. when a blockhash finally expires, re-signs with a fresh one and keeps
 *      going until an overall deadline.
 *
 * Only for wallets whose key we hold (protocol wallets + custodial user
 * wallets) — it re-signs. Do NOT use for externally-signed txs
 * (cosign-borrow's broadcast keeps its own path). VersionedTransactions
 * (e.g. Jupiter swaps) are out of scope — their fee is set by their builder.
 */
import { connection as defaultConnection } from "./connection.js";
import { priorityFeeInstructions } from "./priority-fee.js";

const hasComputeBudgetIx = (tx) =>
  tx.instructions.some((ix) =>
    ix.programId?.toBase58?.() === "ComputeBudget111111111111111111111111111111",
  );

/**
 * @param {import("@solana/web3.js").Transaction} tx  legacy Transaction (instructions only; blockhash/feePayer set here)
 * @param {import("@solana/web3.js").Keypair[]} signers  all required signers (we re-sign on each rebroadcast round)
 * @param {object} [opts]
 * @param {import("@solana/web3.js").Connection} [opts.connection]
 * @param {number} [opts.cuLimit]  compute-unit limit for the fee ix
 * @param {import("@solana/web3.js").PublicKey} [opts.feePayer]  defaults to signers[0]
 * @param {string} [opts.label]
 * @param {"processed"|"confirmed"|"finalized"} [opts.commitment]
 * @param {number} [opts.timeoutMs]  overall deadline (default 90s)
 * @param {number} [opts.rebroadcastIntervalMs]  resend cadence (default 2s)
 * @param {boolean} [opts.addPriorityFee]  inject a dynamic fee unless the tx already has one (default true)
 * @returns {Promise<string>} confirmed signature
 */
export async function sendWithPriorityAndConfirm(tx, signers, opts = {}) {
  const {
    connection = defaultConnection,
    cuLimit,
    feePayer,
    label = "tx",
    commitment = "confirmed",
    timeoutMs = 90_000,
    rebroadcastIntervalMs = 2_000,
    addPriorityFee = true,
  } = opts;

  if (!signers?.length) throw new Error(`[tx-send] ${label}: no signers`);

  if (addPriorityFee && !hasComputeBudgetIx(tx)) {
    const feeIxs = await priorityFeeInstructions(cuLimit, { label });
    tx.instructions = [...feeIxs, ...tx.instructions];
  }
  tx.feePayer = feePayer || signers[0].publicKey;

  const deadline = Date.now() + timeoutMs;
  let lastSig = null;
  let round = 0;

  while (Date.now() < deadline) {
    round += 1;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.signatures = [];
    tx.sign(...signers);
    const raw = tx.serialize();

    lastSig = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: commitment,
      maxRetries: 5,
    });

    const result = await confirmWithRebroadcast(connection, {
      signature: lastSig,
      raw,
      lastValidBlockHeight,
      commitment,
      rebroadcastIntervalMs,
      deadline,
    });

    if (result === "confirmed") {
      console.log(`[tx-send] ${label}: confirmed ${lastSig} (round ${round})`);
      return lastSig;
    }
    if (result === "failed") {
      throw new Error(`[tx-send] ${label}: transaction failed on-chain (${lastSig})`);
    }
    // "expired" → loop: fresh blockhash + re-sign + resend.
    console.warn(`[tx-send] ${label}: blockhash expired (round ${round}), re-signing with a fresh one`);
  }

  throw new Error(`[tx-send] ${label}: not confirmed within ${timeoutMs}ms (last sig ${lastSig})`);
}

/**
 * Poll a signature to confirmation while periodically re-broadcasting the same
 * raw tx. Returns "confirmed" | "failed" | "expired".
 */
async function confirmWithRebroadcast(connection, o) {
  const { signature, raw, lastValidBlockHeight, commitment, rebroadcastIntervalMs, deadline } = o;
  let lastRebroadcast = Date.now();

  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value?.[0];
    if (st) {
      if (st.err) return "failed";
      const level = st.confirmationStatus;
      if (
        level === "finalized" ||
        (commitment === "confirmed" && (level === "confirmed" || level === "finalized")) ||
        (commitment === "processed" && level)
      ) {
        return "confirmed";
      }
    }

    // Blockhash expired? (chain advanced past the tx's validity window)
    const height = await connection.getBlockHeight(commitment);
    if (height > lastValidBlockHeight) return "expired";

    // Periodic rebroadcast of the same signed tx (free — fee is paid once).
    if (Date.now() - lastRebroadcast >= rebroadcastIntervalMs) {
      try {
        await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });
      } catch {
        /* transient send error — keep polling */
      }
      lastRebroadcast = Date.now();
    }

    await new Promise((r) => setTimeout(r, 1_000));
  }
  return "expired";
}
