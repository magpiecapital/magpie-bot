/**
 * Extend-loan fee-wallet watcher.
 *
 * Mitigates the v1 Anchor program finding documented in
 * SECURITY-AUDIT-ANCHOR-2026-06-09.md Finding 1:
 *   extend_loan's fee_wallet_token_account constraint only checks the
 *   mint, not the owner. A borrower calling the program directly
 *   (bypassing the bot) can supply their own ATA as fee_wallet, and
 *   the protocol's fee cut gets refunded to them.
 *
 * This watcher cannot prevent the on-chain behavior (cannot redeploy
 * v1), but it can:
 *
 *   1. Detect every extend_loan tx within ~30s of confirmation.
 *   2. Compare the fee_wallet_token_account supplied against the
 *      expected lender ATA derived from LENDER_PUBKEY.
 *   3. On mismatch, log to extend_loan_exploit_attempts table AND
 *      flag the borrower for a credit-score penalty (-25 on
 *      repayment factor + -50 indirect = same magnitude as a
 *      manual liquidation flag).
 *   4. Optionally ban the borrower if the operator sets
 *      EXPLOIT_BAN_ENABLED=true.
 *
 * Run as a background service via the bot's startup orchestrator
 * (src/index.js startup sequence — same pattern as
 * price-snapshotter, loan-health monitor, etc).
 *
 * The on-chain root fix lands when v3 redeploys with the
 * fee_wallet.owner constraint folded in (see V3-DEPLOY-READINESS-
 * 2026-06-09.md Change 3). This watcher remains useful through
 * the v3 transition so v1 extend flows stay covered.
 */
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { connection } from "../solana/connection.js";
import { PROGRAM_ID } from "../solana/program.js";
import { query } from "../db/pool.js";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const POLL_INTERVAL_MS = 30_000;
const EXPLOIT_BAN_ENABLED = process.env.EXPLOIT_BAN_ENABLED === "true";

// Anchor discriminator for extend_loan = first 8 bytes of
// sha256("global:extend_loan"). Computed once at module load via
// the IDL (same source the bot uses to construct calls), then
// memoized.
let _extendLoanDiscriminator = null;
async function extendLoanDiscriminator() {
  if (_extendLoanDiscriminator) return _extendLoanDiscriminator;
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update("global:extend_loan").digest();
  _extendLoanDiscriminator = hash.subarray(0, 8);
  return _extendLoanDiscriminator;
}

// Account index within ExtendLoan struct (matches programs/magpie-
// lending/src/lib.rs ExtendLoan accounts):
//   0: pool
//   1: loan_token_vault
//   2: loan
//   3: borrower_loan_token_account
//   4: fee_wallet_token_account   ← what we check
//   5: borrower (signer)
//   6: loan_token_program
const FEE_WALLET_ACCOUNT_INDEX = 4;
const LOAN_ACCOUNT_INDEX = 2;
const BORROWER_ACCOUNT_INDEX = 5;

/**
 * Schema init — append-only audit log of every extend_loan
 * inspected, plus per-mismatch detail rows.
 */
export async function initWatcherSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS extend_loan_audit (
      signature             TEXT PRIMARY KEY,
      slot                  BIGINT NOT NULL,
      block_time            TIMESTAMPTZ,
      loan_pda              TEXT NOT NULL,
      borrower              TEXT NOT NULL,
      fee_wallet_supplied   TEXT NOT NULL,
      fee_wallet_expected   TEXT NOT NULL,
      is_mismatch           BOOLEAN NOT NULL,
      observed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS extend_loan_audit_borrower_idx
      ON extend_loan_audit (borrower)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS extend_loan_audit_mismatch_idx
      ON extend_loan_audit (is_mismatch) WHERE is_mismatch = TRUE
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS extend_loan_exploit_attempts (
      signature             TEXT PRIMARY KEY REFERENCES extend_loan_audit(signature),
      borrower              TEXT NOT NULL,
      loan_pda              TEXT NOT NULL,
      fee_wallet_supplied   TEXT NOT NULL,
      action_taken          TEXT NOT NULL,
      detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

let _expectedFeeAtaCache = null;
async function expectedFeeAta() {
  if (_expectedFeeAtaCache) return _expectedFeeAtaCache;
  const ata = await getAssociatedTokenAddress(WSOL_MINT, LENDER_PUBKEY, false);
  _expectedFeeAtaCache = ata.toBase58();
  return _expectedFeeAtaCache;
}

/**
 * Walk back through recent program signatures, find any not yet
 * audited, inspect them. Returns the count of new audits + new
 * mismatches.
 */
export async function pollOnce({ batchSize = 50 } = {}) {
  const disc = await extendLoanDiscriminator();
  const expected = await expectedFeeAta();

  let beforeSig = null;
  const auditedThisPass = [];

  // Walk back from newest. We stop when we hit a signature that's
  // already in extend_loan_audit OR after we've fetched up to
  // batchSize candidates. This keeps memory bounded even on a
  // first-run backfill.
  for (let pageGuard = 0; pageGuard < 4; pageGuard++) {
    const sigs = await connection.getSignaturesForAddress(
      PROGRAM_ID,
      { limit: batchSize, before: beforeSig || undefined },
      "confirmed",
    );
    if (!sigs.length) break;

    // Skip signatures we've already audited.
    const candidateSigs = sigs.map((s) => s.signature);
    const { rows: seenRows } = await query(
      `SELECT signature FROM extend_loan_audit
        WHERE signature = ANY($1::text[])`,
      [candidateSigs],
    );
    const seen = new Set(seenRows.map((r) => r.signature));

    let hitSeen = false;
    for (const sig of sigs) {
      if (seen.has(sig.signature)) {
        hitSeen = true;
        continue;
      }
      try {
        const result = await inspectExtendLoanTx(sig, { disc, expected });
        if (result) auditedThisPass.push(result);
      } catch (e) {
        console.warn("[extend-loan-watcher] inspect error:", sig.signature, e.message);
      }
    }

    // If we hit any already-seen signature, we've caught up.
    if (hitSeen) break;
    beforeSig = sigs[sigs.length - 1].signature;
  }

  const newMismatches = auditedThisPass.filter((a) => a.is_mismatch).length;
  return {
    new_audits: auditedThisPass.length,
    new_mismatches: newMismatches,
  };
}

/**
 * Fetch a transaction, check if any instruction targets the
 * lending program with the extend_loan discriminator. If yes,
 * extract fee_wallet_token_account and audit.
 *
 * Returns the audit row created (or null if the tx didn't contain
 * an extend_loan call to our program).
 */
async function inspectExtendLoanTx(sig, { disc, expected }) {
  const tx = await connection.getTransaction(sig.signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx || tx.meta?.err) return null;

  const allKeys = tx.transaction.message.staticAccountKeys
    ? tx.transaction.message.staticAccountKeys
    : tx.transaction.message.accountKeys;
  const programKeys = allKeys.map((k) => (typeof k === "string" ? k : k.toBase58()));

  // Walk every instruction in the message looking for one whose
  // programId is our v1 lending program AND whose data starts with
  // the extend_loan discriminator.
  const instructions = tx.transaction.message.compiledInstructions
    ? tx.transaction.message.compiledInstructions
    : tx.transaction.message.instructions;

  for (const ix of instructions) {
    const programIdIndex = ix.programIdIndex;
    if (programKeys[programIdIndex] !== PROGRAM_ID.toBase58()) continue;

    // Data may be base58 or Buffer depending on connection version.
    let data;
    if (Buffer.isBuffer(ix.data)) data = ix.data;
    else if (typeof ix.data === "string") {
      const bs58 = (await import("bs58")).default;
      data = Buffer.from(bs58.decode(ix.data));
    } else if (ix.data instanceof Uint8Array) {
      data = Buffer.from(ix.data);
    } else continue;

    if (data.length < 8) continue;
    if (!data.subarray(0, 8).equals(disc)) continue;

    // Found an extend_loan instruction. Extract account indices.
    const accountIdxList = ix.accounts || ix.accountKeyIndexes;
    if (!accountIdxList || accountIdxList.length <= BORROWER_ACCOUNT_INDEX) continue;

    const feeWalletSupplied = programKeys[accountIdxList[FEE_WALLET_ACCOUNT_INDEX]];
    const loanPda = programKeys[accountIdxList[LOAN_ACCOUNT_INDEX]];
    const borrower = programKeys[accountIdxList[BORROWER_ACCOUNT_INDEX]];
    const isMismatch = feeWalletSupplied !== expected;

    // INSERT … ON CONFLICT DO NOTHING — re-running the watcher is
    // idempotent even if two instances briefly overlap.
    await query(
      `INSERT INTO extend_loan_audit
         (signature, slot, block_time, loan_pda, borrower,
          fee_wallet_supplied, fee_wallet_expected, is_mismatch)
       VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8)
       ON CONFLICT (signature) DO NOTHING`,
      [
        sig.signature,
        sig.slot,
        sig.blockTime || null,
        loanPda,
        borrower,
        feeWalletSupplied,
        expected,
        isMismatch,
      ],
    );

    if (isMismatch) {
      await handleMismatch({
        signature: sig.signature,
        borrower,
        loanPda,
        feeWalletSupplied,
      });
    }

    return {
      signature: sig.signature,
      borrower,
      loan_pda: loanPda,
      fee_wallet_supplied: feeWalletSupplied,
      is_mismatch: isMismatch,
    };
  }

  return null;
}

/**
 * When we catch a mismatch:
 *   1. Insert into extend_loan_exploit_attempts (deterministic
 *      action log).
 *   2. Apply a credit-score penalty to the borrower's wallet.
 *   3. Optionally add to the ban registry (gated by env).
 *   4. Log loudly.
 */
async function handleMismatch({ signature, borrower, loanPda, feeWalletSupplied }) {
  const actions = [];

  // Credit-score penalty — same shape as the manual-liquidation
  // penalty in src/services/credit-score.js. Applied to the
  // wallet pubkey (not the user_id since this is an on-chain
  // detection independent of TG identity).
  try {
    await query(
      `INSERT INTO credit_score_events
         (wallet, event_type, impact, source, source_ref)
       VALUES ($1, 'extend_fee_evasion', -50, 'extend-loan-watcher', $2)
       ON CONFLICT DO NOTHING`,
      [borrower, signature],
    );
    actions.push("credit_score_penalty:-50");
  } catch (e) {
    actions.push(`credit_score_penalty_failed:${e.message.slice(0, 60)}`);
  }

  // Optional ban — opt-in via env.
  if (EXPLOIT_BAN_ENABLED) {
    try {
      await query(
        `INSERT INTO ban_registry (wallet, reason, added_by, added_at)
         VALUES ($1, $2, 'extend-loan-watcher', NOW())
         ON CONFLICT (wallet) DO NOTHING`,
        [borrower, `extend_loan_fee_evasion:${signature}`],
      );
      actions.push("banned");
    } catch (e) {
      actions.push(`ban_failed:${e.message.slice(0, 60)}`);
    }
  }

  await query(
    `INSERT INTO extend_loan_exploit_attempts
       (signature, borrower, loan_pda, fee_wallet_supplied, action_taken)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (signature) DO NOTHING`,
    [signature, borrower, loanPda, feeWalletSupplied, actions.join(",")],
  );

  console.warn(
    `[extend-loan-watcher] FEE EVASION DETECTED · sig=${signature} ` +
      `borrower=${borrower} fee_wallet=${feeWalletSupplied} actions=${actions.join(",")}`,
  );
}

/**
 * Background loop. Started by the bot at boot. Restarts itself on
 * error with backoff so a transient RPC blip doesn't take the
 * watcher down permanently.
 */
let _running = false;
let _stopRequested = false;
export async function startExtendLoanWatcher() {
  if (_running) return;
  _running = true;
  await initWatcherSchema();
  console.log("[extend-loan-watcher] starting; lender ATA expected =", await expectedFeeAta());
  let backoffMs = POLL_INTERVAL_MS;
  while (!_stopRequested) {
    const t0 = Date.now();
    try {
      const r = await pollOnce();
      if (r.new_mismatches > 0 || r.new_audits > 5) {
        console.log(
          `[extend-loan-watcher] poll: ${r.new_audits} new audits, ${r.new_mismatches} new mismatches`,
        );
      }
      backoffMs = POLL_INTERVAL_MS;
    } catch (e) {
      console.warn(`[extend-loan-watcher] poll failed: ${e.message}`);
      backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
    }
    const sleep = Math.max(1_000, backoffMs - (Date.now() - t0));
    await new Promise((res) => setTimeout(res, sleep));
  }
  _running = false;
}

export function stopExtendLoanWatcher() {
  _stopRequested = true;
}
