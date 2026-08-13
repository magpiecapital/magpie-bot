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

/**
 * Robust send-and-confirm for an ALREADY-fully-signed raw transaction whose
 * signers we do NOT hold (e.g. cosign-borrow: user-signed + lender-cosigned).
 *
 * WHY (2026-07-31): cosign-borrow submitted the fully-signed borrow with a bare
 * `sendAndConfirmRawTransaction`, which SENDS ONCE and then blocks on the
 * blockhash's expiry (~60-90s) via `confirmTransaction`. Under congestion the tx
 * is dropped and never re-broadcast, so the user sits on "Landing your
 * transaction…" for a minute and then it fails. This helper re-broadcasts the
 * SAME raw tx every couple seconds (a Solana tx pays its fee once, so resending
 * is free) and polls `getSignatureStatuses(searchTransactionHistory)` to
 * confirmation — the same rebroadcast pattern the protocol's own txs use, but
 * WITHOUT re-signing (we can't; the user's key is client-side).
 *
 * SAFETY (no duplicate loans): we only give up once the tx can NEVER land —
 * confirmed, on-chain error, or the blockhash is no longer valid
 * (`isBlockhashValid` = false) — so a retryable error we return can't produce a
 * second loan on the same blockhash.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {Buffer|Uint8Array} raw  serialized, fully-signed tx
 * @param {object} [opts]
 * @param {string} [opts.blockhash]  the tx's recentBlockhash — gates the safe give-up
 * @param {"processed"|"confirmed"|"finalized"} [opts.commitment]  default "confirmed"
 * @param {number} [opts.rebroadcastIntervalMs]  default 2000
 * @param {number} [opts.hardTimeoutMs]  absolute cap (> blockhash validity), default 95000
 * @returns {Promise<string>} confirmed signature
 * @throws Error — an on-chain failure carries `.logs`/`.txErr` for classification;
 *   a give-up carries `.expiredTimeout = true` (safe to retry: the tx is dead).
 */
export async function sendSignedRawWithRebroadcast(connection, raw, opts = {}) {
  const {
    blockhash,
    commitment = "confirmed",
    rebroadcastIntervalMs = 2_000,
    hardTimeoutMs = 95_000,
  } = opts;

  const isConfirmed = (level) =>
    level === "finalized" ||
    (commitment === "confirmed" && (level === "confirmed" || level === "finalized")) ||
    (commitment === "processed" && !!level);

  // Initial send WITH preflight so an immediate program error (e.g. a price /
  // TWAP revert) throws right here with logs — preserving the exact
  // classification the old sendAndConfirmRawTransaction path relied on.
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: commitment,
    maxRetries: 5,
  });

  const deadline = Date.now() + hardTimeoutMs;
  let lastRebroadcast = Date.now();

  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const st = value?.[0];
    if (st) {
      if (st.err) {
        let logs = [];
        try {
          const t = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          logs = t?.meta?.logMessages || [];
        } catch { /* best-effort log fetch for classification */ }
        const e = new Error(`transaction failed on-chain: ${JSON.stringify(st.err)}`);
        e.txErr = st.err;
        e.logs = logs;
        throw e;
      }
      if (isConfirmed(st.confirmationStatus)) return signature;
    }

    // Safe give-up: stop only once this blockhash can no longer land the tx,
    // so returning a retryable error can never cause a duplicate loan.
    if (blockhash) {
      try {
        const v = await connection.isBlockhashValid(blockhash, { commitment });
        if (v && v.value === false) break;
      } catch { /* RPC lacks isBlockhashValid — fall through to hard timeout */ }
    }

    if (Date.now() - lastRebroadcast >= rebroadcastIntervalMs) {
      try {
        await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });
      } catch { /* transient send error — keep polling */ }
      lastRebroadcast = Date.now();
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  // Final status check to avoid the race where it landed just as we gave up.
  try {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const st = value?.[0];
    if (st && !st.err && isConfirmed(st.confirmationStatus)) return signature;
  } catch { /* ignore */ }

  const e = new Error(`not confirmed before blockhash expiry (sig ${signature})`);
  e.expiredTimeout = true;
  throw e;
}
