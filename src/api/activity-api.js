/**
 * GET /api/v1/activity?wallet=<linked-pubkey>
 *
 * Returns a unified time-sorted activity stream for the user owning the
 * given wallet. Synthesizes events from the tables we already maintain
 * — no separate event-log table needed.
 *
 * Categories surfaced:
 *   - borrow            (loans created)
 *   - repaid            (loans paid in full)
 *   - liquidated        (loans liquidated)
 *   - auto_protect      (auto-protect watcher actions)
 *   - site_withdraw     (site-initiated custodial withdraws)
 *   - referral_paid     (referral rewards paid out)
 *   - holder_reward_paid ($MAGPIE holder rewards paid out)
 *
 * Wallet-keyed read, no auth gate at the HTTP layer — same risk
 * envelope as /api/v1/loans (the data is the user's own activity).
 */
import { query } from "../db/pool.js";

function isValidPubkey(s) {
  return typeof s === "string" && s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export async function handleActivity(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!isValidPubkey(wallet)) {
    return { status: 400, body: { error: "Invalid wallet pubkey" } };
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get("limit") || `${DEFAULT_LIMIT}`, 10)));

  const { resolveWalletOwner } = await import("../services/wallet-owner-resolver.js");
  const resolvedUserId = await resolveWalletOwner(wallet);
  if (!resolvedUserId) {
    return { status: 200, body: { ok: true, linked: false, events: [], total_points: 0 } };
  }
  const userId = resolvedUserId;

  // Pull each event type independently. Each query is O(few-hundred) at
  // worst given the table sizes, and the indexes on user_id make them
  // fast. We merge + sort in JS — simpler than a big SQL UNION.
  const [
    { rows: borrowsRowsRaw },
    { rows: closedRowsRaw },
    { rows: protectRowsRaw },
    { rows: withdrawRows },
    { rows: refRows },
    { rows: holderRows },
    { rows: lockRows },
    { rows: creditEventRows },
    { rows: [pointsAgg] },
  ] = await Promise.all([
    // Add loan_pda + program_id so we can scope to THIS WALLET via PDA-
    // derivation. Multi-wallet users were seeing borrows from ALL their
    // linked wallets in this stream.
    query(
      `SELECT id, loan_id, loan_pda, program_id, collateral_mint, loan_amount_lamports::text AS amount,
              ltv_percentage, duration_days, start_timestamp, tx_signature
         FROM loans
        WHERE user_id = $1
        ORDER BY start_timestamp DESC
        LIMIT $2`,
      [userId, limit],
    ),
    query(
      `SELECT id, loan_id, loan_pda, program_id, collateral_mint,
              original_loan_amount_lamports::text AS amount,
              status, updated_at, tx_signature
         FROM loans
        WHERE user_id = $1 AND status IN ('repaid', 'liquidated')
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, limit],
    ),
    // auto_protect_actions doesn't have wallet info — join with loans
    // so we can filter the same way (by loan's borrower wallet).
    //
    // Activity feed is TRANSACTIONAL ONLY — operator-mandated 2026-06-17
    // (feedback_activity_feed_transactional_only.md). Advisories like
    // 'insufficient_funds_warning' / 'partial_repay_failed' clutter the
    // feed and look like errors to users. Filter to tx-backed action_types
    // here (signature IS NOT NULL guarantees a real on-chain action).
    // Advisory rows stay in DB for admin debugging via /lc-perf etc.
    query(
      `SELECT ap.id, ap.loan_id, ap.action_type, ap.amount_lamports::text AS amount,
              ap.health_before, ap.health_after, ap.signature, ap.created_at,
              l.loan_pda, l.program_id, l.loan_id AS chain_loan_id
         FROM auto_protect_actions ap
         JOIN loans l ON l.id = ap.loan_id
        WHERE ap.user_id = $1
          AND ap.signature IS NOT NULL
          AND ap.action_type NOT IN ('insufficient_funds_warning', 'partial_repay_failed')
        ORDER BY ap.created_at DESC
        LIMIT $2`,
      [userId, limit],
    ),
    // Site withdraws have an explicit from_pubkey — filter directly to
    // the requesting wallet without any PDA derivation.
    query(
      `SELECT id, from_pubkey, to_pubkey, asset, raw_amount::text AS amount,
              decimals, tx_signature, status, created_at
         FROM site_withdrawals
        WHERE user_id = $1 AND from_pubkey = $3
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit, wallet],
    ),
    query(
      `SELECT id, reward_lamports::text AS amount, paid_tx_signature, paid_at, created_at
         FROM referral_earnings
        WHERE referrer_user_id = $1 AND status = 'paid'
        ORDER BY paid_at DESC NULLS LAST
        LIMIT $2`,
      [userId, limit],
    ),
    // Holder rewards are keyed on wallet_address, not user_id — fan out
    // over every wallet this user owns.
    //
    // UNION across two sources:
    //   - magpie_holder_rewards: the legacy auto-trigger distribution path
    //     (currently unused — disabled per MGP-001 cutover, all rows deleted).
    //     Left in the UNION so any future re-enable of that path surfaces
    //     correctly without an API change.
    //   - governance_distributions: the MGP-XXX governance-flow distributions.
    //     'sent' status means tx_signature has been confirmed on-chain.
    query(
      `(SELECT mhr.id::text AS id, mhr.reward_lamports::text AS amount,
               mhr.paid_tx_signature AS tx_signature,
               mhr.paid_at AS at_time, mhr.created_at
          FROM magpie_holder_rewards mhr
          JOIN wallets w ON w.public_key = mhr.wallet_address
         WHERE w.user_id = $1 AND mhr.status = 'paid')
       UNION ALL
       (SELECT gd.proposal_id || ':' || gd.wallet AS id,
               gd.allocated_lamports::text AS amount,
               gd.tx_signature,
               gd.sent_at AS at_time,
               gd.created_at
          FROM governance_distributions gd
          JOIN wallets w ON w.public_key = gd.wallet
         WHERE w.user_id = $1 AND gd.status = 'sent' AND gd.tx_signature IS NOT NULL)
       ORDER BY at_time DESC NULLS LAST
       LIMIT $2`,
      [userId, limit],
    ),
    query(
      `SELECT id, action, hours, set_by, created_at
         FROM site_lock_events
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
    ),
    // Credit events — sum of score_delta is what the dashboard renders
    // as "points". Without this join, every event in the response had
    // score_delta undefined and the dashboard's reduce returned 0
    // even when credit_events.score_delta totalled positive.
    query(
      `SELECT id, loan_id, event_type, score_delta, created_at
         FROM credit_events
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
    ),
    // Total points across the user's entire history — a single SUM is
    // cheaper than asking the dashboard to reconstruct from per-event
    // deltas, and it correctly counts events older than the `limit`.
    query(
      `SELECT COALESCE(SUM(score_delta), 0)::int AS total_points
         FROM credit_events
        WHERE user_id = $1`,
      [userId],
    ),
  ]);

  // ── Wallet-scope the loan-derived events ──────────────────────
  // borrows/repays/liquidations come from `loans` table (user-scoped).
  // auto_protect comes from auto_protect_actions joined with loans.
  // Filter all three down to events whose underlying loan was
  // actually opened by THIS WALLET.
  //
  // Referrals / holder rewards / lock events remain user-scoped
  // (intentional — credit & rewards consolidate across linked wallets;
  // locks affect the whole account).
  const { filterLoansForWallet } = await import("../services/wallet-scoped-loans.js");
  const borrowsRows = filterLoansForWallet(borrowsRowsRaw, wallet);
  const closedRows  = filterLoansForWallet(closedRowsRaw, wallet);

  // For auto-protect: build a set of THIS WALLET's loan db-ids first,
  // then keep only auto_protect actions on those loans.
  const allLoanRows = [...borrowsRowsRaw, ...closedRowsRaw];
  const walletLoanIds = new Set(
    filterLoansForWallet(allLoanRows, wallet).map((r) => String(r.id)),
  );
  const protectRows = protectRowsRaw.filter((r) => walletLoanIds.has(String(r.loan_id)));

  // Build a quick lookup of credit_events by loan_db_id so we can attach
  // score_delta to the matching activity event. credit_events.loan_id
  // is the DB primary key (loans.id), not the on-chain loan_id.
  // Group by (loan_id, event_type) so a single loan with multiple
  // credit-affecting events (e.g. borrow + repay_early) gets each one
  // attached to the right activity row.
  const creditByLoanAndType = new Map();
  for (const ce of creditEventRows) {
    const key = `${ce.loan_id}:${ce.event_type}`;
    if (!creditByLoanAndType.has(key)) creditByLoanAndType.set(key, ce.score_delta);
  }
  // Map activity-event kind → the credit_events.event_type names that
  // produce score for it. Multiple credit events can affect one
  // activity event (e.g. a repaid loan has BOTH "repay_early" and the
  // implicit "borrow" delta from earlier). For "borrow" the
  // credit_event is recorded with the loan_id at borrow time.
  function deltaForLoanEvent(loanDbId, kind) {
    if (loanDbId == null) return null;
    if (kind === "borrow") {
      return creditByLoanAndType.get(`${loanDbId}:borrow`) ?? null;
    }
    if (kind === "repaid") {
      // Could be repay_ontime, repay_early, or repay_late.
      return (
        creditByLoanAndType.get(`${loanDbId}:repay_early`) ??
        creditByLoanAndType.get(`${loanDbId}:repay_ontime`) ??
        creditByLoanAndType.get(`${loanDbId}:repay_late`) ??
        null
      );
    }
    if (kind === "liquidated") {
      return creditByLoanAndType.get(`${loanDbId}:liquidated`) ?? null;
    }
    if (kind === "auto_protect") {
      // auto_protect actions don't map 1:1 to credit events; closest
      // is `partial_repay` which we record on the underlying loan.
      return creditByLoanAndType.get(`${loanDbId}:partial_repay`) ?? null;
    }
    return null;
  }

  const events = [];
  for (const r of borrowsRows) {
    events.push({
      kind: "borrow",
      at: r.start_timestamp,
      loan_id: r.loan_id?.toString?.() ?? null,
      collateral_mint: r.collateral_mint,
      amount_lamports: r.amount,
      ltv_percentage: r.ltv_percentage,
      duration_days: r.duration_days,
      tx_signature: r.tx_signature,
      score_delta: deltaForLoanEvent(r.id, "borrow"),
    });
  }
  for (const r of closedRows) {
    events.push({
      kind: r.status, // "repaid" | "liquidated"
      at: r.updated_at,
      loan_id: r.loan_id?.toString?.() ?? null,
      collateral_mint: r.collateral_mint,
      amount_lamports: r.amount,
      tx_signature: r.tx_signature,
      score_delta: deltaForLoanEvent(r.id, r.status),
    });
  }
  for (const r of protectRows) {
    events.push({
      kind: "auto_protect",
      at: r.created_at,
      loan_id: r.loan_id?.toString?.() ?? null,
      action_type: r.action_type,
      amount_lamports: r.amount,
      health_before: r.health_before,
      health_after: r.health_after,
      tx_signature: r.signature,
      score_delta: deltaForLoanEvent(r.loan_id, "auto_protect"),
    });
  }
  for (const r of withdrawRows) {
    events.push({
      kind: "site_withdraw",
      at: r.created_at,
      from: r.from_pubkey,
      to: r.to_pubkey,
      asset: r.asset,
      raw_amount: r.amount,
      decimals: r.decimals,
      tx_signature: r.tx_signature,
      status: r.status,
    });
  }
  for (const r of refRows) {
    events.push({
      kind: "referral_paid",
      at: r.paid_at || r.created_at,
      amount_lamports: r.amount,
      tx_signature: r.paid_tx_signature,
    });
  }
  for (const r of holderRows) {
    events.push({
      kind: "holder_reward_paid",
      at: r.at_time || r.created_at,
      amount_lamports: r.amount,
      tx_signature: r.tx_signature,
    });
  }
  for (const r of lockRows) {
    events.push({
      kind: r.action === "set" ? "lock_set" : "lock_cleared",
      at: r.created_at,
      hours: r.hours ?? null,
      set_by: r.set_by,
    });
  }

  // Time-sort descending, then trim to limit.
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return {
    status: 200,
    body: {
      // The dashboard gates its state update on `d.ok`; without this field the
      // points counter (and anything else reading this response) silently stays
      // at 0. (The points NUMBER now comes from /api/v1/points, but keep this
      // honest so the activity feed + any legacy consumer work.)
      ok: true,
      linked: true,
      events: events.slice(0, limit),
      // Total credit points across the user's entire history. Surfaced
      // here (not derived from `events`) because the activity feed is
      // limit-paged but points are cumulative — the dashboard needs the
      // honest lifetime total even when only the last 30 events render.
      total_points: pointsAgg?.total_points ?? 0,
    },
  };
}
