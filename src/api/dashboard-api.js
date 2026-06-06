/**
 * GET /api/v1/dashboard?wallet=<linked-pubkey>
 *
 * Consolidates everything the site dashboard needs to render the
 * linked-user surface in one round-trip. Replaces (or supplements) the
 * fan-out of 10+ individual fetches widgets do on mount.
 *
 * Returns:
 *   linked, telegram_username, active_custodial_wallet
 *   prefs (notify + auto-protect toggles)
 *   site_lock { locked, until }
 *   wallets[]  — pubkey + source + is_active (no labels, no secrets)
 *   tickets_open_count + tickets_awaiting_count
 *   recent_activity[] — last 10 events from the unified feed
 *   earnings { referral / holder / lp lifetime + pending }
 *   global_site { disabled, announcement }
 *
 * Read-only, no auth gate at the HTTP layer (same risk envelope as
 * /api/v1/loans + the existing wallet-keyed endpoints). The widgets
 * that need fresh per-action data (e.g. CustodialWithdraw, support
 * details) keep using their dedicated signed endpoints.
 */
import { query } from "../db/pool.js";
import { getGlobalSiteState } from "../services/site-global.js";
import { getAnnouncement } from "../services/site-announcement.js";

function isValidPubkey(s) {
  return typeof s === "string" && s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

export async function handleDashboardAggregate(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!isValidPubkey(wallet)) {
    return { status: 400, body: { error: "Invalid wallet pubkey" } };
  }

  const { rows: [linked] } = await query(
    `SELECT u.id, u.telegram_username
       FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1 LIMIT 1`,
    [wallet],
  );

  // Always include global site state — non-linked users still see
  // banners.
  const [globalState, announcement] = await Promise.all([
    getGlobalSiteState(),
    getAnnouncement(),
  ]);
  const global_site = {
    disabled: globalState.disabled,
    reason: globalState.reason,
    announcement: announcement.message
      ? { message: announcement.message, severity: announcement.severity, expires_at: announcement.expires_at }
      : null,
  };

  if (!linked) {
    return {
      status: 200,
      body: { linked: false, global_site },
    };
  }
  const userId = linked.id;

  const [
    { rows: prefsRow },
    { rows: [lockRow] },
    { rows: walletsRows },
    { rows: [ticketCounts] },
    { rows: activeRows },
    { rows: closedRows },
    { rows: withdrawRows },
    { rows: refRows },
    { rows: holderRows },
    { rows: lpRows },
    { rows: [activeCustodial] },
  ] = await Promise.all([
    query(
      `SELECT notify_deposits, notify_loan_warnings, notify_liquidations,
              notify_health, auto_repay, auto_protect
         FROM user_prefs WHERE user_id = $1`,
      [userId],
    ),
    query(
      `SELECT site_locked_until FROM users WHERE id = $1`,
      [userId],
    ),
    query(
      `SELECT id, public_key, source, is_active, created_at
         FROM wallets WHERE user_id = $1 ORDER BY is_active DESC, created_at ASC`,
      [userId],
    ),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'open')::int AS open,
         COUNT(*) FILTER (WHERE status = 'awaiting_user')::int AS awaiting
         FROM support_tickets WHERE user_id = $1`,
      [userId],
    ),
    query(
      `SELECT id, loan_id, collateral_mint, loan_amount_lamports::text AS amount,
              ltv_percentage, duration_days, start_timestamp, tx_signature
         FROM loans WHERE user_id = $1
        ORDER BY start_timestamp DESC LIMIT 5`,
      [userId],
    ),
    query(
      `SELECT id, loan_id, status, original_loan_amount_lamports::text AS amount,
              updated_at, tx_signature
         FROM loans WHERE user_id = $1 AND status IN ('repaid', 'liquidated')
        ORDER BY updated_at DESC LIMIT 5`,
      [userId],
    ),
    query(
      `SELECT asset, raw_amount::text AS amount, decimals, to_pubkey,
              status, tx_signature, created_at
         FROM site_withdrawals WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 5`,
      [userId],
    ),
    query(
      `SELECT
         COALESCE(SUM(reward_lamports::numeric), 0)::text AS lifetime,
         COALESCE(SUM(CASE WHEN status='paid' THEN reward_lamports::numeric ELSE 0 END), 0)::text AS paid,
         COALESCE(SUM(CASE WHEN status='accrued' THEN reward_lamports::numeric ELSE 0 END), 0)::text AS pending
         FROM referral_earnings WHERE referrer_user_id = $1`,
      [userId],
    ),
    query(
      `SELECT
         COALESCE(SUM(reward_lamports::numeric), 0)::text AS lifetime,
         COALESCE(SUM(CASE WHEN status='paid' THEN reward_lamports::numeric ELSE 0 END), 0)::text AS paid,
         COALESCE(SUM(CASE WHEN status='accrued' THEN reward_lamports::numeric ELSE 0 END), 0)::text AS pending
         FROM magpie_holder_rewards mhr
         JOIN wallets w ON w.public_key = mhr.wallet_address
        WHERE w.user_id = $1`,
      [userId],
    ),
    query(
      `SELECT
         COALESCE(SUM(reward_lamports::numeric), 0)::text AS lifetime,
         COALESCE(SUM(CASE WHEN status='paid' THEN reward_lamports::numeric ELSE 0 END), 0)::text AS paid,
         COALESCE(SUM(CASE WHEN status='accrued' THEN reward_lamports::numeric ELSE 0 END), 0)::text AS pending
         FROM lp_loyalty_rewards llr
         JOIN wallets w ON w.public_key = llr.wallet_address
        WHERE w.user_id = $1`,
      [userId],
    ),
    query(
      `SELECT public_key FROM wallets
         WHERE user_id = $1 AND is_active = TRUE LIMIT 1`,
      [userId],
    ),
  ]);

  const prefs = prefsRow[0] || {};
  const lockUntil = lockRow?.site_locked_until ? new Date(lockRow.site_locked_until) : null;
  const lockActive = lockUntil && lockUntil.getTime() > Date.now();

  // Merge recent activity rows into a single sorted list.
  const events = [];
  for (const r of activeRows) {
    events.push({
      kind: "borrow",
      at: r.start_timestamp,
      loan_id: r.loan_id?.toString?.() ?? null,
      amount_lamports: r.amount,
      tx_signature: r.tx_signature,
    });
  }
  for (const r of closedRows) {
    events.push({
      kind: r.status,
      at: r.updated_at,
      loan_id: r.loan_id?.toString?.() ?? null,
      amount_lamports: r.amount,
      tx_signature: r.tx_signature,
    });
  }
  for (const r of withdrawRows) {
    events.push({
      kind: "site_withdraw",
      at: r.created_at,
      asset: r.asset,
      raw_amount: r.amount,
      decimals: r.decimals,
      to: r.to_pubkey,
      status: r.status,
      tx_signature: r.tx_signature,
    });
  }
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return {
    status: 200,
    body: {
      linked: true,
      telegram_username: linked.telegram_username ? `@${linked.telegram_username}` : null,
      active_custodial_wallet: activeCustodial?.public_key ?? null,
      prefs: {
        auto_protect: !!prefs.auto_protect,
        auto_repay: !!prefs.auto_repay,
        notify_deposits: !!prefs.notify_deposits,
        notify_loan_warnings: !!prefs.notify_loan_warnings,
        notify_liquidations: !!prefs.notify_liquidations,
        notify_health: !!prefs.notify_health,
      },
      site_lock: {
        locked: !!lockActive,
        until: lockActive ? lockUntil.toISOString() : null,
      },
      wallets: walletsRows.map((w) => ({
        id: w.id,
        public_key: w.public_key,
        source: w.source,
        is_active: w.is_active,
        managed: w.source !== "site-link",
        created_at: w.created_at,
      })),
      tickets: {
        open: ticketCounts?.open ?? 0,
        awaiting_user: ticketCounts?.awaiting ?? 0,
      },
      recent_activity: events.slice(0, 10),
      earnings: {
        referral: refRows[0],
        holder: holderRows[0],
        lp: lpRows[0],
      },
      global_site,
    },
  };
}
