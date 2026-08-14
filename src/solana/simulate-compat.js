/**
 * simulateTransaction overload compatibility.
 *
 * web3.js overloads `Connection.simulateTransaction`:
 *   - VersionedTransaction  → (tx, config)  — the modern form we want
 *   - legacy Transaction    → (tx, signers?, includeAccounts?)
 *
 * Passing a config OBJECT with a LEGACY Transaction makes web3.js throw
 * `Invalid arguments` client-side — the request never reaches an RPC.
 *
 * This bug has now bitten THREE times:
 *   - fee-wallet-sweeper, hourly, starting 2026-06-19 (fixed in
 *     privileged-sign-guard.js with an inline legacy→versioned promotion)
 *   - cosign-borrow's lender-drain guard: every legacy-tx site borrow was
 *     rejected with "simulateTransaction failed: Invalid arguments"
 *     (surfaced 2026-08-14 by the fixed conversion metric — 4 real
 *     borrowers turned away, 0 successes)
 *   - agent-repay's pre-flight sim: same throw, but its fail-open catch
 *     meant the guard silently never ran
 *
 * Fix, shared: promote any legacy Transaction to a VersionedTransaction so
 * the (tx, config) call path is always valid. Signatures are copied so the
 * wire shape stays right (sims run sigVerify:false, so validity is moot).
 *
 * The tx must have `feePayer` and `recentBlockhash` set (true for both a
 * wire-parsed tx and a locally built one about to be simulated) —
 * `compileMessage()` throws otherwise.
 */
import { Transaction, VersionedTransaction } from "@solana/web3.js";

export function toVersionedForSim(tx) {
  if (!(tx instanceof Transaction)) return tx; // already versioned (or a message)
  const message = tx.compileMessage();
  const versioned = new VersionedTransaction(message);
  for (let i = 0; i < tx.signatures.length && i < versioned.signatures.length; i++) {
    const sigPair = tx.signatures[i];
    if (sigPair?.signature) {
      versioned.signatures[i] = sigPair.signature;
    }
  }
  return versioned;
}
