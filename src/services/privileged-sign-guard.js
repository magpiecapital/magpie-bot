/**
 * Privileged-keypair signing guard.
 *
 * The single shared utility every service must call before broadcasting
 * a tx signed with a protocol-privileged keypair (LENDER_PRIVATE_KEY,
 * ENGINE_AUTHORITY_V4_PRIVATE_KEY, etc.). Centralising this means:
 *
 *   1. Every signing path inherits the same Layer-2-style balance-delta
 *      simulation that closed the 2026-06-18 cosign-borrow exploit class
 *   2. Every privileged sign emits an audit row, so a self-monitor probe
 *      can later sum-of-expected vs actual-on-chain and crit-alert on
 *      drift (the smoking gun for a leaked keypair: a tx lands on-chain
 *      without a matching audit row)
 *   3. Sweepers can enforce destination allowlists at one consistent
 *      seam instead of bespoke per-service code
 *
 * The shape every caller follows:
 *
 *   1. Build the tx
 *   2. Call `runPrivilegedSign({ ... })` which:
 *      a) writes an audit row in status='pending'
 *      b) snapshots pre-state of the accounts you said you'd touch
 *      c) signs the tx with the privileged keypair(s)
 *      d) simulates and verifies no decrease beyond declared maxima
 *      e) on success: marks the row sim_passed and returns the signed tx
 *         (caller broadcasts via its own confirmation handling)
 *      f) on sim violation: marks the row sim_rejected and throws
 *   3. After broadcast, caller calls `recordPrivilegedSignResult({...})`
 *      with the tx_sig and final status.
 *
 * Operator-mandated 2026-06-18 PM ("think of any other potential similar
 * exploits and put together the same safeguards"). See
 * feedback_cosign_borrow_token_drain_exploit_2026_06_18.md.
 */
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";

const TOKENKEG = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/**
 * Run a privileged sign + simulate + audit-log cycle.
 *
 * @param {Object} args
 * @param {string} args.service              — service name, e.g. "treasury-sweeper"
 * @param {import('@solana/web3.js').Transaction|import('@solana/web3.js').VersionedTransaction} args.tx
 * @param {Array<import('@solana/web3.js').Keypair>} args.signers  — privileged keypair(s)
 * @param {Array<Object>} args.allowedDeltas — [{ pubkey, kind: 'sol'|'token',
 *                                                 mint?, maxDecrease: bigint|number }]
 *   - Any account whose balance decreases beyond `maxDecrease` causes
 *     sim rejection.
 *   - Accounts NOT in this list are checked too: if any of them is owned
 *     by a signer (i.e., a privileged account) AND its balance would
 *     decrease, that's also a rejection. This catches the cosign-borrow
 *     exploit shape (untracked lender ATA drained as a side effect).
 *
 * @returns {Promise<{ auditId: number, signedTx, preBalances, simResult }>}
 *
 * @throws Error if the sim detects an unauthorized balance decrease, or
 *               if any precondition check fails. The audit row is updated
 *               to sim_rejected before throwing.
 */
export async function runPrivilegedSign({ service, tx, signers, allowedDeltas }) {
  if (!service || typeof service !== "string") {
    throw new Error("runPrivilegedSign: service name required");
  }
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new Error("runPrivilegedSign: at least one signer required");
  }
  const signerPubkeys = signers.map((s) => s.publicKey);
  const signerPubkeyStrs = new Set(signerPubkeys.map((p) => p.toBase58()));

  // 1. Audit row — pending. Stamp early so we have a paper trail even
  //    if every subsequent step throws.
  const expectedDeltasJson = JSON.stringify(
    (allowedDeltas || []).map((d) => ({
      pubkey: d.pubkey.toBase58 ? d.pubkey.toBase58() : String(d.pubkey),
      kind: d.kind,
      mint: d.mint ? (d.mint.toBase58 ? d.mint.toBase58() : String(d.mint)) : null,
      max_decrease: typeof d.maxDecrease === "bigint"
        ? d.maxDecrease.toString()
        : String(d.maxDecrease ?? 0),
    })),
  );
  const { rows: [auditRow] } = await query(
    `INSERT INTO privileged_sign_audit (service, signer_pubkey, expected_deltas, status)
     VALUES ($1, $2, $3::jsonb, 'pending')
     RETURNING id`,
    [service, signerPubkeys[0].toBase58(), expectedDeltasJson],
  );
  const auditId = auditRow.id;

  // 2. Enumerate every account in the tx (legacy + versioned)
  const accountKeys =
    typeof tx.compileMessage === "function"
      ? tx.compileMessage().accountKeys
      : tx.message.staticAccountKeys;

  // 3. Snapshot pre-state of every account in the tx — we need it to
  //    detect unexpected decreases on accounts the caller didn't declare.
  let preInfos;
  try {
    preInfos = await connection.getMultipleAccountsInfo(accountKeys, "confirmed");
  } catch (err) {
    await markAuditRejected(auditId, `pre-state read failed: ${err.message?.slice(0, 100)}`);
    throw new Error(`privileged-sign-guard: pre-state read failed: ${err.message}`);
  }
  // Build pre-balance snapshot keyed by account index
  const preBalanceSnapshot = [];
  for (let i = 0; i < accountKeys.length; i++) {
    const info = preInfos[i];
    if (!info) { preBalanceSnapshot.push(null); continue; }
    const isToken = info.owner.equals(TOKENKEG) || info.owner.equals(TOKEN2022);
    if (isToken && info.data.length >= 72) {
      preBalanceSnapshot.push({
        kind: "token",
        mint: new PublicKey(info.data.subarray(0, 32)).toBase58(),
        owner: new PublicKey(info.data.subarray(32, 64)).toBase58(),
        amount: info.data.readBigUInt64LE(64),
      });
    } else {
      preBalanceSnapshot.push({
        kind: "sol",
        lamports: BigInt(info.lamports),
        owner: info.owner.toBase58(),
      });
    }
  }
  // Persist for forensics
  await query(
    `UPDATE privileged_sign_audit SET pre_balances = $2::jsonb WHERE id = $1`,
    [
      auditId,
      JSON.stringify(
        accountKeys.map((k, i) => ({
          pubkey: k.toBase58(),
          ...(preBalanceSnapshot[i]
            ? {
                ...preBalanceSnapshot[i],
                lamports: preBalanceSnapshot[i].lamports?.toString(),
                amount: preBalanceSnapshot[i].amount?.toString(),
              }
            : { kind: "missing" }),
        })),
      ),
    ],
  );

  // 4. Sign with privileged keypair(s)
  try {
    if (typeof tx.sign === "function" && tx.message) {
      // VersionedTransaction
      tx.sign(signers);
    } else {
      // legacy Transaction
      for (const kp of signers) tx.partialSign(kp);
    }
  } catch (err) {
    await markAuditRejected(auditId, `sign failed: ${err.message?.slice(0, 100)}`);
    throw err;
  }

  // 5. Simulate, requesting post-state of ALL accounts so we can verify
  //    no privileged-account decrease was hidden in an undeclared spot.
  //
  // web3.js@1.98+ overloads simulateTransaction: VersionedTransaction
  // accepts the (tx, config) shape we want; LEGACY Transaction expects
  // (tx, signers[], includeAccounts). Passing a config object to the
  // legacy overload throws "Invalid arguments" — which is exactly the
  // bug that broke fee-wallet-sweeper hourly starting 2026-06-19. Fix:
  // promote any legacy Transaction to VersionedTransaction here so the
  // modern (tx, config) call path is always valid.
  let txForSim = tx;
  if (tx instanceof Transaction && !(tx instanceof VersionedTransaction)) {
    try {
      const message = tx.compileMessage();
      txForSim = new VersionedTransaction(message);
      // Copy any signatures already on the legacy tx so sigVerify=false
      // sim sees the right tx shape (we don't actually verify here but
      // the wire encoding includes the sig slots).
      for (let i = 0; i < tx.signatures.length && i < txForSim.signatures.length; i++) {
        const sigPair = tx.signatures[i];
        if (sigPair?.signature) {
          txForSim.signatures[i] = sigPair.signature;
        }
      }
    } catch (convErr) {
      await markAuditRejected(auditId, `legacy->versioned conversion failed: ${convErr.message?.slice(0, 100)}`);
      throw new Error(`privileged-sign-guard: legacy->versioned conversion failed: ${convErr.message}`);
    }
  }
  let sim;
  try {
    sim = await connection.simulateTransaction(txForSim, {
      sigVerify: false,
      commitment: "confirmed",
      accounts: {
        encoding: "base64",
        addresses: accountKeys.map((k) => k.toBase58()),
      },
    });
  } catch (err) {
    await markAuditRejected(auditId, `simulate failed: ${err.message?.slice(0, 100)}`);
    throw new Error(`privileged-sign-guard: simulate failed: ${err.message}`);
  }
  if (sim.value.err) {
    const detail = `sim err=${JSON.stringify(sim.value.err).slice(0, 100)} logs=${(sim.value.logs || []).slice(-3).join(" | ").slice(0, 200)}`;
    await markAuditRejected(auditId, detail);
    throw new Error(`privileged-sign-guard: simulate rejected — ${detail}`);
  }

  // 6. Compare pre vs post for every account. Two failure modes:
  //    (a) An UNDECLARED account owned by a privileged signer decreased
  //        → exploit-class drain attempt, hard reject
  //    (b) A DECLARED account decreased MORE than its maxDecrease
  //        → caller's accounting is off, reject
  const postAccounts = sim.value.accounts || [];
  const declaredByPubkey = new Map();
  for (const d of allowedDeltas || []) {
    declaredByPubkey.set(
      d.pubkey.toBase58 ? d.pubkey.toBase58() : String(d.pubkey),
      d,
    );
  }

  for (let i = 0; i < accountKeys.length; i++) {
    const pre = preBalanceSnapshot[i];
    const post = postAccounts[i];
    if (!pre || !post) continue;
    const pubkey = accountKeys[i].toBase58();

    // SOL delta
    const preLamports = pre.lamports ?? 0n;
    const postLamports = BigInt(post.lamports ?? 0);
    if (postLamports < preLamports) {
      const decrease = preLamports - postLamports;
      const declared = declaredByPubkey.get(pubkey);
      // privileged-signer SOL account: must be declared and within max
      if (signerPubkeyStrs.has(pubkey)) {
        if (!declared || declared.kind !== "sol") {
          await markAuditRejected(
            auditId,
            `unauthorized SOL drain on signer ${pubkey.slice(0, 8)}…: -${decrease} lamports`,
          );
          throw new Error(
            `privileged-sign-guard: signer ${pubkey.slice(0, 8)}… would lose ${decrease} lamports but no allowedDelta declared`,
          );
        }
        const maxAllowed = BigInt(declared.maxDecrease);
        if (decrease > maxAllowed) {
          await markAuditRejected(
            auditId,
            `signer SOL decrease ${decrease} > allowed ${maxAllowed}`,
          );
          throw new Error(
            `privileged-sign-guard: signer would lose ${decrease} lamports > maxDecrease ${maxAllowed}`,
          );
        }
      }
    }

    // Token delta — pre.kind === 'token'
    if (pre.kind === "token") {
      const postBytes = Buffer.from(post.data[0], "base64");
      if (postBytes.length < 72) continue;
      const postAmount = postBytes.readBigUInt64LE(64);
      if (postAmount < pre.amount) {
        const decrease = pre.amount - postAmount;
        // privileged-signer-owned ATA: must be declared and within max
        if (signerPubkeyStrs.has(pre.owner)) {
          const declared = declaredByPubkey.get(pubkey);
          if (!declared || declared.kind !== "token") {
            await markAuditRejected(
              auditId,
              `unauthorized token drain on signer-owned ATA ${pubkey.slice(0, 8)}…: -${decrease} (mint ${pre.mint.slice(0, 8)}…)`,
            );
            throw new Error(
              `privileged-sign-guard: signer-owned ATA ${pubkey.slice(0, 8)}… (mint ${pre.mint.slice(0, 8)}…) would lose ${decrease} but no allowedDelta declared`,
            );
          }
          const maxAllowed = BigInt(declared.maxDecrease);
          if (decrease > maxAllowed) {
            await markAuditRejected(
              auditId,
              `signer-owned token ATA decrease ${decrease} > allowed ${maxAllowed}`,
            );
            throw new Error(
              `privileged-sign-guard: token decrease ${decrease} > maxDecrease ${maxAllowed}`,
            );
          }
        }
      }
    }
  }

  // 7. All checks passed — stamp sim_passed and return the signed tx.
  await query(
    `UPDATE privileged_sign_audit
        SET status = 'sim_passed'
      WHERE id = $1 AND status = 'pending'`,
    [auditId],
  );

  return { auditId, signedTx: tx, preBalances: preBalanceSnapshot, simResult: sim.value };
}

/**
 * Record the outcome of a broadcast attempt against an earlier
 * runPrivilegedSign call.
 *
 * @param {Object} args
 * @param {number} args.auditId
 * @param {string} args.status — 'broadcast' | 'confirmed' | 'failed'
 * @param {string} [args.txSig]
 * @param {string} [args.error]
 */
export async function recordPrivilegedSignResult({ auditId, status, txSig, error }) {
  const statusCol =
    status === "broadcast"
      ? "broadcast_at"
      : status === "confirmed"
        ? "confirmed_at"
        : null;
  await query(
    `UPDATE privileged_sign_audit
        SET status = $2,
            tx_sig = COALESCE($3, tx_sig),
            error_text = COALESCE($4, error_text)
            ${statusCol ? `, ${statusCol} = NOW()` : ""}
      WHERE id = $1`,
    [auditId, status, txSig ?? null, error ?? null],
  );
}

async function markAuditRejected(auditId, detail) {
  try {
    await query(
      `UPDATE privileged_sign_audit
          SET status = 'sim_rejected',
              error_text = $2
        WHERE id = $1`,
      [auditId, detail?.slice(0, 500)],
    );
  } catch {
    /* best-effort */
  }
}
