/**
 * Liquidation distribution watcher (Phase 2).
 *
 * Picks up liquidation_economics rows that are in 'awaiting_distribution'
 * state (a sale tx has been detected, net profit computed, splits
 * pre-recorded) and credits the rewards pool ledgers with the
 * pre-computed share amounts. Marks the row 'distributed' on success.
 *
 * What this service does NOT do
 * ─────────────────────────────
 *   - Move any SOL on-chain. The actual SOL stays in the lender
 *     wallet (which IS the distributor wallet). The accrual is to
 *     DB ledgers — magpie_holder_pool / lp_loyalty_pool /
 *     protocol_reserve_pool / referral_earnings. The existing
 *     distributor services (magpie-holder-rewards, lp-loyalty,
 *     referral-payouts) read those ledgers at snapshot time and do
 *     the on-chain transfers.
 *   - Run the snapshot itself. That stays on its existing 5–10 day
 *     random cadence.
 *   - Burn $MAGPIE. Rows with collateral_mint = MAGPIE_MINT are in
 *     'magpie_burn_pending' state, not 'awaiting_distribution', so
 *     the watcher never touches them. Operator burns those manually.
 *
 * Referrer fallback
 * ─────────────────
 * The pre-computed splits in liquidation_economics were filled at
 * watcher-detection time without knowing the borrower's referrer.
 * Here we look up users.referred_by and:
 *   - if a referrer exists: credit the referrer slice as a row in
 *     referral_earnings (status='accrued', event_type='default_profit')
 *   - if no referrer: roll the referrer slice into the holder credit
 *     (so holders effectively get 80% of net profit)
 *
 * Either way the protocol-reserve and LP-loyalty slices are credited
 * the same as the per-row pre-computation.
 *
 * Idempotency
 * ───────────
 *   - The watcher only picks up rows whose distribution_status =
 *     'awaiting_distribution'. The status update at the end of a
 *     successful credit moves the row to 'distributed', so the next
 *     tick won't pick it up again.
 *   - The UPDATE on the status uses
 *     `WHERE distribution_status = 'awaiting_distribution'` so a
 *     concurrent tick that beat us to it will match zero rows and
 *     we'll skip the credit.
 *   - The protocol-reserve credit's event_type='default_profit' plus
 *     the (loan_db_id, event_type) UNIQUE prevents double-bumping
 *     the reserve counter even if a row somehow gets credited twice.
 *   - referral_earnings has its own ON CONFLICT (loan_db_id, event_type)
 *     DO NOTHING; we use 'default_profit' there too.
 *   - The holder + LP-loyalty pool credits are NOT individually
 *     idempotent at the pool-counter level, so we lean entirely on the
 *     row-status transition to gate them. The status transition is the
 *     ONLY gate; everything else is best-effort behind it.
 *
 * Configuration
 * ─────────────
 *   LIQUIDATION_DISTRIBUTION_DISABLED=1 — kill switch
 *   LIQUIDATION_DISTRIBUTION_TICK_MS    — default 90_000 (1.5 min)
 */
import { query } from "../db/pool.js";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { connection, withFailover } from "../solana/connection.js";
import { assertAllowedDestination } from "./privileged-destinations.js";
import {
  runPrivilegedSign,
  recordPrivilegedSignResult,
} from "./privileged-sign-guard.js";
import { withLenderSpendLock } from "./lender-spend-lock.js";
import { availableLenderNative } from "./lender-reserve.js";

const TICK_MS = Number(process.env.LIQUIDATION_DISTRIBUTION_TICK_MS) || 90_000;
const FIRST_TICK_DELAY_MS = 180_000; // wait 3 min after boot so other services init
const DISABLED = /^(1|true|yes|on)$/i.test(process.env.LIQUIDATION_DISTRIBUTION_DISABLED || "");

const DEFAULT_PROFIT_EVENT_TYPE = "default_profit";

// Optional: pubkey of the rewards distributor wallet. When set, the
// watcher moves the net profit lamports from the lender wallet to this
// wallet immediately after crediting the DB ledgers, so the snapshot
// distributors (which now sign with REWARDS_DISTRIBUTOR_PRIVATE_KEY)
// have the SOL on hand at payout time. When unset, the watcher stays
// DB-ledger-only and the SOL stays in the lender wallet (legacy
// behaviour).
const REWARDS_DISTRIBUTOR_PUBKEY = process.env.REWARDS_DISTRIBUTOR_PUBKEY
  ? new PublicKey(process.env.REWARDS_DISTRIBUTOR_PUBKEY)
  : null;

let _lenderKeypair = null;
function getLenderKeypairForTransfer() {
  if (_lenderKeypair) return _lenderKeypair;
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (!b58) return null;
  try {
    _lenderKeypair = Keypair.fromSecretKey(bs58.decode(b58));
    return _lenderKeypair;
  } catch (err) {
    console.error("[liq-distribute] LENDER_PRIVATE_KEY decode failed:", err.message);
    return null;
  }
}

let _running = false;
let _ticking = false;

/**
 * Look up the borrower's user_id from the wallets table, then their
 * referrer (users.referred_by). Returns null if either lookup misses.
 */
async function lookupReferrerForBorrower(borrowerWallet) {
  const { rows } = await query(
    `SELECT u.id AS user_id, u.referred_by
       FROM wallets w
       JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1
      LIMIT 1`,
    [borrowerWallet],
  );
  if (!rows[0]) return { userId: null, referrerUserId: null };
  return {
    userId: rows[0].user_id,
    referrerUserId: rows[0].referred_by ?? null,
  };
}

// Per-tx fee headroom on top of the transfer amount. The canonical
// 5-SOL lender gas reserve is enforced by availableLenderNative()
// (lender-reserve.js) — this service NEVER uses its own local reserve
// floor. See finding: the old 0.01-SOL local floor was replaced by the
// shared reserve accounting so this path can't starve loan-origination gas.
const TX_FEE_HEADROOM = 10_000n;

/**
 * Distribute one liquidation_economics row.
 *
 * SAFETY ORDER (2026-06-14):
 *   1. Resolve referrer + compute final shares.
 *   2. If on-chain transfer is enabled (REWARDS_DISTRIBUTOR_PUBKEY set),
 *      pre-flight the lender's SOL balance. If insufficient, leave the
 *      row at 'awaiting_distribution' (DON'T claim) so the next tick
 *      can retry. This makes the credits + transfer atomic-on-failure:
 *      either both happen or neither does.
 *   3. Claim the row by flipping to 'distributing'.
 *   4. Credit the four pool ledgers.
 *   5. Move (holder + LP + referrer) lamports on-chain to the
 *      distributor wallet (if enabled).
 *   6. Flip row to 'distributed' on success, 'distribute_error' on
 *      partial failure for operator review.
 *
 * Returns { ok: boolean, reason?: string } — never throws to caller.
 */
async function distributeOne(row) {
  const refLookup = await lookupReferrerForBorrower(row.borrower_wallet).catch(() => ({
    userId: null, referrerUserId: null,
  }));

  // Compute final shares first so the pre-flight check sees the same
  // amounts the credits + transfer will use. Referrer rollover happens
  // here before any claim or credit.
  let holderShare = BigInt(row.holder_share_lamports || "0");
  const lpShare = BigInt(row.lp_loyalty_share_lamports || "0");
  let refShare = BigInt(row.referrer_share_lamports || "0");
  const reserveShare = BigInt(row.protocol_reserve_share_lamports || "0");
  const hasReferrer = refLookup.referrerUserId != null;
  if (!hasReferrer && refShare > 0n) {
    holderShare = holderShare + refShare;
    refShare = 0n;
  }
  const transferAmount = holderShare + lpShare + refShare;

  // Pre-flight lender balance check (only when on-chain move is
  // enabled). Size against availableLenderNative() — the CANONICAL
  // shared accounting that subtracts the 5-SOL gas reserve AND every
  // unconfirmed in-flight lender spend, and fails CLOSED (0) if the read
  // is uncertain. If the lender can't safely cover the transfer + fee,
  // leave the row at 'awaiting_distribution' so the next tick can retry —
  // no claim, no credits, no SOL motion. This is the gate that makes the
  // rest of distributeOne atomic-on-failure. The authoritative check is
  // re-run inside the shared lock right before signing.
  if (REWARDS_DISTRIBUTOR_PUBKEY && transferAmount > 0n) {
    const avail = await availableLenderNative(connection);
    if (avail < transferAmount + TX_FEE_HEADROOM) {
      console.warn(
        `[liq-distribute] loan ${row.loan_id} skipped — lender available ` +
        `${(Number(avail) / 1e9).toFixed(4)} SOL < required ` +
        `${(Number(transferAmount + TX_FEE_HEADROOM) / 1e9).toFixed(4)} SOL ` +
        `(canonical 5-SOL reserve applied). Will retry next tick.`,
      );
      return { ok: false, reason: "lender_balance_too_low" };
    }
  }

  // Claim the row by flipping status. If a concurrent tick beat us to
  // it, we get zero rows back and bail.
  const claim = await query(
    `UPDATE liquidation_economics
        SET distribution_status = 'distributing',
            updated_at = NOW(),
            referrer_user_id = $2
      WHERE id = $1
        AND distribution_status = 'awaiting_distribution'
      RETURNING id`,
    [row.id, refLookup.referrerUserId],
  );
  if (claim.rowCount === 0) {
    return { ok: false, reason: "claim_lost_race" };
  }

  const errors = [];

  // SAFETY ORDER: on-chain transfer FIRST (most likely to fail —
  // network blip, RPC timeout, etc.). Only after the SOL physically
  // moves do we credit the DB ledgers. This way:
  //
  //   - Transfer fails → no ledger credits land. Row flips back to
  //     'awaiting_distribution' so the next tick retries cleanly.
  //     Lender wallet untouched, distributor wallet untouched.
  //   - Transfer succeeds → SOL is in CHCAM. Ledger credits then
  //     reflect that. DB writes are very reliable; partial credit
  //     failures degrade to 'distribute_error' for operator review
  //     and the SOL stays in CHCAM (still recoverable).
  //
  // Without REWARDS_DISTRIBUTOR_PUBKEY set, the on-chain path is
  // skipped and the watcher behaves DB-ledger-only as before.
  let transferSig = null;
  if (REWARDS_DISTRIBUTOR_PUBKEY && transferAmount > 0n) {
    const lender = getLenderKeypairForTransfer();
    if (!lender) {
      errors.push("on_chain_transfer: LENDER_PRIVATE_KEY missing");
    } else {
      // DESTINATION ALLOWLIST — an env flip of REWARDS_DISTRIBUTOR_PUBKEY can
      // only ever send to the pre-approved CHCAM rewards wallet. Fail fast
      // before building/locking.
      let destOk = true;
      try {
        assertAllowedDestination("liquidation-distribution-watcher", REWARDS_DISTRIBUTOR_PUBKEY);
      } catch (err) {
        destOk = false;
        errors.push(`on_chain_transfer: ${err.message?.slice(0, 80)}`);
      }
      if (destOk) {
        // ONE shared lender-spend lock across EVERY 4JSS-signing service so at
        // most one lender-spending tx is ever in flight and the canonical
        // 5-SOL gas reserve holds ACROSS writers, not just per-tick.
        const locked = await withLenderSpendLock(async () => {
          // Re-check available lender native INSIDE the lock (accounts for any
          // sibling service's just-landed spend). Fails CLOSED (0n) on an
          // uncertain read, so we never draw toward the gas reserve.
          const avail = await availableLenderNative(connection);
          if (avail < transferAmount + TX_FEE_HEADROOM) {
            return { ok: false, reason: "lender_balance_too_low" };
          }

          const { blockhash, lastValidBlockHeight } = await withFailover((c) =>
            c.getLatestBlockhash("confirmed"),
          );
          const tx = new Transaction({
            feePayer: lender.publicKey,
            blockhash,
            lastValidBlockHeight,
          }).add(
            SystemProgram.transfer({
              fromPubkey: lender.publicKey,
              toPubkey: REWARDS_DISTRIBUTOR_PUBKEY,
              // BigInt precision: SOL amounts here are bounded by the
              // sale_proceeds of a single liquidation (max ~10s of SOL
              // realistically), comfortably under 2^53. Number() is safe.
              lamports: Number(transferAmount),
            }),
          );

          // GUARDED SIGN — pre-flight balance-delta simulation + audit row.
          // Rejects any tx that decreases the lender balance beyond the
          // declared transfer amount (+ fee headroom).
          let guard;
          try {
            guard = await runPrivilegedSign({
              service: "liquidation-distribution-watcher",
              tx,
              signers: [lender],
              allowedDeltas: [
                {
                  pubkey: lender.publicKey,
                  kind: "sol",
                  maxDecrease: transferAmount + TX_FEE_HEADROOM + 5_000n,
                },
              ],
            });
          } catch (err) {
            return { ok: false, reason: `sim_reject: ${err.message?.slice(0, 80)}` };
          }

          let sig;
          try {
            sig = await withFailover((c) =>
              c.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
              }),
            );
          } catch (err) {
            await recordPrivilegedSignResult({
              auditId: guard.auditId,
              status: "failed",
              error: err.message?.slice(0, 200),
            });
            return { ok: false, reason: `send: ${err.message?.slice(0, 80)}` };
          }
          await recordPrivilegedSignResult({ auditId: guard.auditId, status: "broadcast", txSig: sig });

          // Confirm. On a confirm-timeout, do ONE history-aware status check
          // BEFORE declaring failure — a timed-out tx may have actually
          // landed. Only revert (retryable) when non-inclusion is unproven,
          // so we never double-pay a landed transfer on the next tick.
          try {
            await withFailover((c) =>
              c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"),
            );
          } catch (err) {
            let landed = false;
            try {
              const r = await withFailover((c) =>
                c.getSignatureStatuses([sig], { searchTransactionHistory: true }),
              );
              const st = r?.value?.[0];
              landed = !!(st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"));
            } catch { /* status unknown */ }
            if (!landed) {
              await recordPrivilegedSignResult({
                auditId: guard.auditId,
                status: "broadcast",
                txSig: sig,
                error: `confirm-timeout: ${err.message?.slice(0, 120)}`,
              });
              return { ok: false, reason: `confirm-timeout: ${err.message?.slice(0, 80)}` };
            }
          }
          await recordPrivilegedSignResult({ auditId: guard.auditId, status: "confirmed", txSig: sig });
          return { ok: true, sig };
        });

        if (locked.skipped) {
          errors.push(`on_chain_transfer: ${locked.reason}`);
        } else if (!locked.result.ok) {
          errors.push(`on_chain_transfer: ${locked.result.reason}`);
        } else {
          transferSig = locked.result.sig;
          console.log(
            `[liq-distribute] loan ${row.loan_id} on-chain move: ` +
            `${(Number(transferAmount) / 1e9).toFixed(4)} SOL → ` +
            `${REWARDS_DISTRIBUTOR_PUBKEY.toBase58().slice(0, 8)}…  sig=${transferSig.slice(0, 24)}…`,
          );
        }
      }
    }
  }

  // If the on-chain transfer failed, revert the claim so the next
  // tick gets to retry cleanly. No ledger credits have happened yet.
  if (errors.length > 0) {
    await query(
      `UPDATE liquidation_economics
          SET distribution_status = 'awaiting_distribution',
              updated_at = NOW()
        WHERE id = $1 AND distribution_status = 'distributing'`,
      [row.id],
    );
    console.warn(`[liq-distribute] loan ${row.loan_id} reverted to awaiting_distribution — errors=${errors.join("; ")}`);
    return { ok: false, reason: errors.join("; ") };
  }

  // SOL is in CHCAM (or on-chain path was skipped). Credit the four
  // pool ledgers now. Partial failures here are unlikely (DB writes
  // very reliable) but if any occur, mark distribute_error so the
  // operator can manually reconcile.
  // All three pool credits now route through pool_credit_events
  // (ledger-gated, UNIQUE per source). Repeat calls with the same
  // (sourceType, sourceId) are no-ops at the DB level. The recovery_credits
  // and liquidation_economics rows are the canonical sourceId.
  const liqSourceType = "liquidation_default_profit";
  const liqSourceId = `liq_econ_${row.id}`;
  try {
    const { creditHolderPoolDirect } = await import("./magpie-holder-rewards.js");
    if (holderShare > 0n) {
      await creditHolderPoolDirect({
        sourceType: liqSourceType,
        sourceId: liqSourceId,
        lamports: holderShare,
        metadata: { loan_id: row.loan_id, collateral_symbol: row.collateral_symbol },
      });
    }
  } catch (err) {
    errors.push(`holder: ${err.message?.slice(0, 80)}`);
  }
  try {
    const { creditLpLoyaltyPoolDirect } = await import("./lp-loyalty.js");
    if (lpShare > 0n) {
      await creditLpLoyaltyPoolDirect({
        sourceType: liqSourceType,
        sourceId: liqSourceId,
        lamports: lpShare,
        metadata: { loan_id: row.loan_id },
      });
    }
  } catch (err) {
    errors.push(`lp: ${err.message?.slice(0, 80)}`);
  }
  try {
    const { creditProtocolReserveDirect } = await import("./protocol-reserve.js");
    if (reserveShare > 0n) {
      await creditProtocolReserveDirect({
        sourceType: liqSourceType,
        sourceId: liqSourceId,
        lamports: reserveShare,
        metadata: { loan_id: row.loan_id, event_type: DEFAULT_PROFIT_EVENT_TYPE },
      });
    }
  } catch (err) {
    errors.push(`reserve: ${err.message?.slice(0, 80)}`);
  }
  if (hasReferrer && refShare > 0n) {
    try {
      await query(
        `INSERT INTO referral_earnings
           (referrer_user_id, referee_user_id, loan_db_id, event_type,
            fee_lamports, reward_lamports, reward_bps, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'accrued')
         ON CONFLICT (loan_db_id, event_type) DO NOTHING`,
        [
          refLookup.referrerUserId,
          refLookup.userId,
          row.loan_id,
          DEFAULT_PROFIT_EVENT_TYPE,
          row.net_profit_lamports?.toString() || "0",
          refShare.toString(),
          1000,
        ],
      );
    } catch (err) {
      errors.push(`referral: ${err.message?.slice(0, 80)}`);
    }
  }

  // Final status flip
  const finalStatus = errors.length === 0 ? "distributed" : "distribute_error";
  await query(
    `UPDATE liquidation_economics
        SET distribution_status = $1,
            updated_at = NOW()
      WHERE id = $2`,
    [finalStatus, row.id],
  );

  if (errors.length > 0) {
    console.warn(`[liq-distribute] loan ${row.loan_id}: partial credit, errors=${errors.join("; ")}`);
    return { ok: false, reason: errors.join("; ") };
  }

  const totalCredited = holderShare + lpShare + refShare + reserveShare;
  console.log(
    `[liq-distribute] loan ${row.loan_id} ${row.collateral_symbol || row.collateral_mint.slice(0, 8)}: ` +
      `credited ${(Number(totalCredited) / 1e9).toFixed(4)} SOL ` +
      `(H ${(Number(holderShare) / 1e9).toFixed(4)} / ` +
      `L ${(Number(lpShare) / 1e9).toFixed(4)} / ` +
      `R ${(Number(refShare) / 1e9).toFixed(4)}${hasReferrer ? "" : " rolled"} / ` +
      `P ${(Number(reserveShare) / 1e9).toFixed(4)})`,
  );
  return { ok: true };
}

/**
 * Distribute a recovery_credits row. Out-of-band SOL the operator (or a
 * future buyback / contribution flow) deposited directly to the rewards
 * distributor wallet. No on-chain transfer needed — the SOL is already
 * there. Same 80/10/10 split as profitable defaults: holder + LP-loyalty
 * + protocol-reserve. No referrer dimension (these aren't loans).
 *
 * Operator-mandated 2026-06-18 PM as part of the exploit-into-positive
 * spin: 4 SOL deposited goes into the holder + LP + protocol-reserve
 * pools the same way a profitable default would.
 */
async function distributeRecoveryCredit(row) {
  const amount = BigInt(row.amount_lamports);
  if (amount <= 0n) {
    await query(
      `UPDATE recovery_credits SET distribution_status = 'distributed', distributed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [row.id],
    );
    return { ok: true, reason: "zero_amount_skip" };
  }
  // Same 80/10/10 split as profitable defaults with no-referrer fallback.
  // Holder gets default 70% + the rolled 10% referrer share = 80%.
  const HOLDER_BPS = 8_000n;
  const LP_BPS = 1_000n;
  const RESERVE_BPS = 1_000n;
  const TOTAL_BPS = 10_000n;
  const holderShare = (amount * HOLDER_BPS) / TOTAL_BPS;
  const lpShare = (amount * LP_BPS) / TOTAL_BPS;
  const reserveShare = amount - holderShare - lpShare; // sweep rounding

  // Race-safe claim.
  const claim = await query(
    `UPDATE recovery_credits
        SET distribution_status = 'distributing', updated_at = NOW()
      WHERE id = $1 AND distribution_status = 'awaiting_distribution'
      RETURNING id`,
    [row.id],
  );
  if (claim.rowCount === 0) {
    return { ok: false, reason: "claim_lost_race" };
  }

  // Per-pool credits now go through pool_credit_events with
  // UNIQUE(source_type, source_id, pool_kind), so retries are no-ops at
  // the DB level. We still mark the row 'distributed' on first claim
  // (forward-only state) for fast catalog reads.
  const recSourceType = `recovery_${row.kind}`;
  const recSourceId = `recovery_credit_${row.id}`;
  const errors = [];
  try {
    const { creditHolderPoolDirect } = await import("./magpie-holder-rewards.js");
    if (holderShare > 0n) {
      await creditHolderPoolDirect({
        sourceType: recSourceType,
        sourceId: recSourceId,
        lamports: holderShare,
        metadata: { recovery_credit_id: row.id },
      });
    }
  } catch (err) {
    errors.push(`holder: ${err.message?.slice(0, 80)}`);
  }
  try {
    const { creditLpLoyaltyPoolDirect } = await import("./lp-loyalty.js");
    if (lpShare > 0n) {
      await creditLpLoyaltyPoolDirect({
        sourceType: recSourceType,
        sourceId: recSourceId,
        lamports: lpShare,
        metadata: { recovery_credit_id: row.id },
      });
    }
  } catch (err) {
    errors.push(`lp: ${err.message?.slice(0, 80)}`);
  }
  try {
    const { creditProtocolReserveDirect } = await import("./protocol-reserve.js");
    if (reserveShare > 0n) {
      await creditProtocolReserveDirect({
        sourceType: recSourceType,
        sourceId: recSourceId,
        lamports: reserveShare,
        metadata: { recovery_credit_id: row.id },
      });
    }
  } catch (err) {
    errors.push(`reserve: ${err.message?.slice(0, 80)}`);
  }

  await query(
    `UPDATE recovery_credits
        SET distribution_status = 'distributed',
            holder_share_lamports = $2,
            lp_loyalty_share_lamports = $3,
            protocol_reserve_share_lamports = $4,
            distributed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [
      row.id,
      holderShare.toString(),
      lpShare.toString(),
      reserveShare.toString(),
    ],
  );
  if (errors.length > 0) {
    console.error(
      `[liq-distribute] CRIT recovery_credit #${row.id} marked DISTRIBUTED with partial-credit failures (no retry — pool ledgers are not idempotent, retrying would double-credit): ${errors.join("; ")}. Manual operator patch required for failed slices.`,
    );
    return { ok: false, reason: errors.join("; ") };
  }
  console.log(
    `[liq-distribute] recovery_credit #${row.id} (${row.kind}) distributed ${(Number(amount) / 1e9).toFixed(4)} SOL ` +
      `(H ${(Number(holderShare) / 1e9).toFixed(4)} / L ${(Number(lpShare) / 1e9).toFixed(4)} / P ${(Number(reserveShare) / 1e9).toFixed(4)})`,
  );
  return { ok: true };
}

async function tick() {
  if (_ticking) return;
  if (DISABLED) return;
  _ticking = true;
  try {
    // Pass 1 — liquidation_economics
    const { rows } = await query(
      `SELECT id, loan_id, collateral_mint, collateral_symbol,
              borrower_wallet, net_profit_lamports::text AS net_profit_lamports,
              holder_share_lamports::text AS holder_share_lamports,
              lp_loyalty_share_lamports::text AS lp_loyalty_share_lamports,
              referrer_share_lamports::text AS referrer_share_lamports,
              protocol_reserve_share_lamports::text AS protocol_reserve_share_lamports
         FROM liquidation_economics
        WHERE distribution_status = 'awaiting_distribution'
        ORDER BY sale_detected_at ASC NULLS FIRST
        LIMIT 25`,
    );
    let succeeded = 0;
    let failed = 0;
    for (const row of rows) {
      const r = await distributeOne(row).catch((err) => ({
        ok: false,
        reason: `unexpected: ${err.message?.slice(0, 80)}`,
      }));
      if (r.ok) succeeded++; else failed++;
    }
    if (rows.length > 0) {
      console.log(`[liq-distribute] tick liq: distributed=${succeeded} failed=${failed}`);
    }

    // Pass 2 — recovery_credits (operator contributions, exploit recoveries, etc.)
    try {
      const { rows: rcRows } = await query(
        `SELECT id, kind, amount_lamports::text AS amount_lamports
           FROM recovery_credits
          WHERE distribution_status = 'awaiting_distribution'
          ORDER BY created_at ASC
          LIMIT 25`,
      );
      let rcOk = 0;
      let rcFail = 0;
      for (const row of rcRows) {
        const r = await distributeRecoveryCredit(row).catch((err) => ({
          ok: false,
          reason: `unexpected: ${err.message?.slice(0, 80)}`,
        }));
        if (r.ok) rcOk++; else rcFail++;
      }
      if (rcRows.length > 0) {
        console.log(`[liq-distribute] tick recovery: distributed=${rcOk} failed=${rcFail}`);
      }
    } catch (err) {
      // recovery_credits table may not exist yet on a fresh deploy
      // before migration 078 applies — skip gracefully.
      if (!/relation .* does not exist/i.test(err.message || "")) {
        console.warn(`[liq-distribute] recovery_credits pass failed: ${err.message?.slice(0, 160)}`);
      }
    }
  } catch (err) {
    console.warn(`[liq-distribute] tick failed: ${err.message?.slice(0, 200)}`);
  } finally {
    _ticking = false;
  }
}

export function startLiquidationDistributionWatcher() {
  if (_running) return;
  if (DISABLED) {
    console.log("[liq-distribute] disabled via LIQUIDATION_DISTRIBUTION_DISABLED");
    return;
  }
  _running = true;
  console.log(`[liq-distribute] watcher starting — tick every ${Math.round(TICK_MS / 1000)}s`);
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, FIRST_TICK_DELAY_MS).unref?.();
}
