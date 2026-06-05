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

  const { rows: [u] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [wallet],
  );
  if (!u) {
    return { status: 200, body: { linked: false, events: [] } };
  }
  const userId = u.user_id;

  // Pull each event type independently. Each query is O(few-hundred) at
  // worst given the table sizes, and the indexes on user_id make them
  // fast. We merge + sort in JS — simpler than a big SQL UNION.
  const [
    { rows: borrowsRows },
    { rows: closedRows },
    { rows: protectRows },
    { rows: withdrawRows },
    { rows: refRows },
    { rows: holderRows },
  ] = await Promise.all([
    query(
      `SELECT id, loan_id, collateral_mint, loan_amount_lamports::text AS amount,
              ltv_percentage, duration_days, start_timestamp, tx_signature
         FROM loans
        WHERE user_id = $1
        ORDER BY start_timestamp DESC
        LIMIT $2`,
      [userId, limit],
    ),
    query(
      `SELECT id, loan_id, collateral_mint,
              original_loan_amount_lamports::text AS amount,
              status, updated_at, tx_signature
         FROM loans
        WHERE user_id = $1 AND status IN ('repaid', 'liquidated')
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, limit],
    ),
    query(
      `SELECT id, loan_id, action_type, amount_lamports::text AS amount,
              health_before, health_after, signature, created_at
         FROM auto_protect_actions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
    ),
    query(
      `SELECT id, from_pubkey, to_pubkey, asset, raw_amount::text AS amount,
              decimals, tx_signature, status, created_at
         FROM site_withdrawals
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
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
    query(
      `SELECT mhr.id, mhr.reward_lamports::text AS amount, mhr.paid_tx_signature,
              mhr.paid_at, mhr.created_at
         FROM magpie_holder_rewards mhr
         JOIN wallets w ON w.public_key = mhr.wallet_address
        WHERE w.user_id = $1 AND mhr.status = 'paid'
        ORDER BY mhr.paid_at DESC NULLS LAST
        LIMIT $2`,
      [userId, limit],
    ),
  ]);

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
      at: r.paid_at || r.created_at,
      amount_lamports: r.amount,
      tx_signature: r.paid_tx_signature,
    });
  }

  // Time-sort descending, then trim to limit.
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return {
    status: 200,
    body: { linked: true, events: events.slice(0, limit) },
  };
}
