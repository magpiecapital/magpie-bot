/**
 * Scope a list of DB loans to ONLY those opened by the user's currently-
 * active wallet.
 *
 * Why: a Magpie user can have multiple wallets linked (one custodial +
 * any imported ones). All of those share user_id, so naive
 * `WHERE user_id = $1` queries pull EVERY loan across EVERY wallet.
 * That makes /repay, /topup, /extend, /partialrepay, /reborrow show
 * loans that aren't actually signable by the current Phantom — which
 * is confusing UX (user picks a loan, signature fails with
 * InvalidAccountData because borrower mismatch).
 *
 * How: the loan PDA is derived from `borrower_pubkey + loan_id +
 * program_id`. Given a loan row from the DB, we re-derive what the
 * PDA would be IF the active wallet were the borrower. If that
 * matches the stored loan_pda, it's the active wallet's loan.
 * Otherwise it belongs to another linked wallet.
 *
 * Local-only computation: no on-chain RPC needed. Fast.
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { loanPda } from "../solana/pdas.js";
import { PROGRAM_ID } from "../solana/program.js";

/** Get the currently-active wallet pubkey for a user, or null. */
export async function getActiveWalletPubkey(userId) {
  const { rows } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1 AND is_active = TRUE LIMIT 1`,
    [userId],
  );
  return rows[0]?.public_key ?? null;
}

/** Get all linked wallets for a user (for "switch wallet" messaging). */
export async function getLinkedWallets(userId) {
  const { rows } = await query(
    `SELECT public_key, label, is_active FROM wallets WHERE user_id = $1 ORDER BY is_active DESC, created_at ASC`,
    [userId],
  );
  return rows;
}

/** Filter a DB-loan rowset down to those that match the active wallet's
 *  borrower-derived PDA. Loans without a usable loan_id / loan_pda
 *  pass through (defensive — never DROP a loan just because we
 *  couldn't derive a PDA). */
export function filterLoansForWallet(rows, walletPubkeyStr) {
  if (!walletPubkeyStr || !rows?.length) return rows ?? [];
  let activePk;
  try { activePk = new PublicKey(walletPubkeyStr); }
  catch { return rows; }

  return rows.filter((loan) => {
    try {
      if (!loan.loan_id || !loan.loan_pda) return true; // can't verify → don't drop
      let programId;
      try { programId = loan.program_id ? new PublicKey(loan.program_id) : PROGRAM_ID; }
      catch { programId = PROGRAM_ID; }
      const [derived] = loanPda(activePk, String(loan.loan_id), programId);
      return derived.toBase58() === loan.loan_pda;
    } catch {
      return true; // derivation failed; don't drop on uncertainty
    }
  });
}

/**
 * One-shot helper for command handlers: fetch active wallet, filter
 * the loans, and return the picture the UI needs to render.
 *
 * Returns:
 *   { activeWallet, filtered, otherWalletCount }
 *
 *   activeWallet:      pubkey string or null
 *   filtered:          loans the active wallet can actually sign for
 *   otherWalletCount:  loans that exist for this user but belong to
 *                      other linked wallets (useful for the "switch
 *                      wallets to see those" hint)
 */
export async function scopeLoansToActiveWallet(userId, rows) {
  const activeWallet = await getActiveWalletPubkey(userId);
  if (!activeWallet) return { activeWallet: null, filtered: rows ?? [], otherWalletCount: 0 };
  const filtered = filterLoansForWallet(rows, activeWallet);
  const otherWalletCount = (rows?.length ?? 0) - filtered.length;
  return { activeWallet, filtered, otherWalletCount };
}
