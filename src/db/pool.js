/**
 * Postgres connection with automatic failover to a secondary DB.
 *
 * Primary: DATABASE_URL (Railway Postgres).
 * Secondary: DATABASE_URL_SECONDARY (Neon cold standby).
 *
 * Queries try primary first; on connection-level errors fall through to
 * secondary. Mirrors the failover behavior the site already has so the
 * bot survives a Railway DB outage gracefully.
 */
import pg from "pg";
import "dotenv/config";

const useSSL = process.env.DB_SSL !== "false";

function createPool(connectionString) {
  if (!connectionString) return null;
  const p = new pg.Pool({
    connectionString,
    max: 10,
    ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  p.on("error", (err) => {
    console.error("[db] Pool error (will reconnect):", err.message);
  });
  return p;
}

export const pool = createPool(process.env.DATABASE_URL);
const secondaryPool = createPool(process.env.DATABASE_URL_SECONDARY);

const CONN_ERR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "57P01"]);

/**
 * Query with retry + failover. Tries primary, retries once on transient
 * connection errors, then falls through to secondary if configured.
 */
export async function query(text, params) {
  if (pool) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (CONN_ERR_CODES.has(err.code)) {
        console.warn("[db] Primary failed, retrying:", err.code);
        try {
          return await pool.query(text, params);
        } catch (err2) {
          if (CONN_ERR_CODES.has(err2.code) && secondaryPool) {
            console.warn("[db] Failing over to secondary DB");
            return secondaryPool.query(text, params);
          }
          throw err2;
        }
      }
      throw err;
    }
  }
  if (secondaryPool) {
    return secondaryPool.query(text, params);
  }
  throw new Error("No database connection available");
}

/**
 * One-shot schema patches run on bot startup. Each statement must be
 * idempotent — safe to re-run on every boot. Use sparingly; prefer
 * proper migration files for non-urgent changes.
 *
 * Currently applies:
 *   - Drops UNIQUE constraint on wallets.public_key so the same wallet
 *     can be imported under multiple Telegram accounts (common when
 *     users share a wallet across devices / accounts). This was the
 *     hidden cause of repeated "Failed to import wallet" errors.
 *   - Inserts/refreshes the official $MAGPIE token as an approved,
 *     protected collateral mint. protected=TRUE exempts it from the
 *     hourly token-health watcher's auto-disable logic. Liquidity/
 *     market-cap fields are refreshed by the screener/health sweeps.
 */
export async function applyStartupPatches() {
  const patches = [
    `ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_public_key_key`,

    // $MAGPIE — protocol token, always approved, exempt from auto-disqualification.
    // Decimals=6 verified on-chain. ON CONFLICT keeps the row idempotent across boots.
    `INSERT INTO supported_mints
       (mint, symbol, name, decimals, category, image_url,
        liquidity_usd, holder_count, market_cap_usd,
        has_mint_authority, has_freeze_authority, lp_burned,
        token_age_hours, auto_approved, screened_at, source,
        enabled, protected)
     VALUES ('9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump',
             'MAGPIE', 'Magpie', 6, 'memecoin', NULL,
             0, 0, 0,
             FALSE, FALSE, FALSE,
             0, FALSE, NOW(), 'protocol_token',
             TRUE, TRUE)
     ON CONFLICT (mint) DO UPDATE SET
       enabled = TRUE,
       protected = TRUE,
       source = 'protocol_token'`,

    // Make sure the screener doesn't re-process $MAGPIE through the audit pipeline.
    `INSERT INTO token_screen_seen (mint)
     VALUES ('9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump')
     ON CONFLICT DO NOTHING`,

    // Referral rewards ledger. One row per fee-bearing event (borrow, extend)
    // produced by a referred user. Sum of unpaid rows = claimable balance.
    `CREATE TABLE IF NOT EXISTS referral_earnings (
       id BIGSERIAL PRIMARY KEY,
       referrer_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       referee_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       loan_db_id BIGINT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
       event_type TEXT NOT NULL,
       fee_lamports NUMERIC(30,0) NOT NULL,
       reward_lamports NUMERIC(30,0) NOT NULL,
       reward_bps INT NOT NULL,
       status TEXT NOT NULL DEFAULT 'accrued',
       paid_tx_signature TEXT,
       paid_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       UNIQUE (loan_db_id, event_type)
     )`,
    `CREATE INDEX IF NOT EXISTS referral_earnings_referrer_status_idx
       ON referral_earnings(referrer_user_id, status)`,
    `CREATE INDEX IF NOT EXISTS referral_earnings_referee_idx
       ON referral_earnings(referee_user_id)`,

    // $MAGPIE holder rewards — accrual pool. Singleton row (id=1).
    `CREATE TABLE IF NOT EXISTS magpie_holder_pool (
       id INTEGER PRIMARY KEY,
       accrued_lamports NUMERIC(30,0) NOT NULL DEFAULT 0,
       last_distribution_at TIMESTAMPTZ,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `INSERT INTO magpie_holder_pool (id, accrued_lamports) VALUES (1, 0)
       ON CONFLICT (id) DO NOTHING`,

    // Each weekly snapshot+distribution becomes one row here.
    `CREATE TABLE IF NOT EXISTS magpie_holder_distributions (
       id BIGSERIAL PRIMARY KEY,
       snapshot_at TIMESTAMPTZ NOT NULL,
       pool_lamports NUMERIC(30,0) NOT NULL,
       total_balance NUMERIC(40,0) NOT NULL,
       holder_count INTEGER NOT NULL,
       eligible_count INTEGER NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,

    // Per-holder allocations from each distribution. Wallet is the
    // on-chain $MAGPIE holder address — does NOT need to be a bot user.
    `CREATE TABLE IF NOT EXISTS magpie_holder_rewards (
       id BIGSERIAL PRIMARY KEY,
       distribution_id BIGINT NOT NULL REFERENCES magpie_holder_distributions(id) ON DELETE CASCADE,
       wallet_address TEXT NOT NULL,
       balance_at_snapshot NUMERIC(40,0) NOT NULL,
       reward_lamports NUMERIC(30,0) NOT NULL,
       status TEXT NOT NULL DEFAULT 'accrued',
       paid_tx_signature TEXT,
       paid_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       UNIQUE (distribution_id, wallet_address)
     )`,
    `CREATE INDEX IF NOT EXISTS magpie_holder_rewards_wallet_status_idx
       ON magpie_holder_rewards(wallet_address, status)`,

    // Anti-dump: snapshot timing is randomized within a window and KEPT
    // PRIVATE. Storing the target as a column lets the cron compare cheaply
    // without leaking it publicly via the per-wallet APIs.
    `ALTER TABLE magpie_holder_pool
       ADD COLUMN IF NOT EXISTS next_distribution_at TIMESTAMPTZ`,

    // Pin the FIRST distribution to a specific moment chosen by the
    // operator. Only takes effect if no distribution has happened yet —
    // once the first snapshot fires, the random-window logic takes over
    // for subsequent runs. Idempotent across boots.
    //
    // The exact timestamp must remain operator-private: do not echo it
    // to logs that ship to public dashboards, do not surface it in any
    // API response, do not put it in commit messages that are user-facing.
    `UPDATE magpie_holder_pool
        SET next_distribution_at = '2026-06-08 17:00:00+00'::timestamptz,
            updated_at = NOW()
      WHERE id = 1
        AND last_distribution_at IS NULL`,

    // ─────── LP LOYALTY BONUS POOL ───────
    // 2% of every loan fee accrues to this pool, distributed pro-rata to
    // each LP's share-seconds (shares × time held). Long-term holders
    // earn meaningfully more than flippers on top of the base 80% LP
    // yield. Sourced from the protocol's 5% slice (drops to 3%); LPs
    // keep their full 80%.
    `CREATE TABLE IF NOT EXISTS lp_loyalty_pool (
       id INTEGER PRIMARY KEY,
       accrued_lamports NUMERIC(30,0) NOT NULL DEFAULT 0,
       last_distribution_at TIMESTAMPTZ,
       next_distribution_at TIMESTAMPTZ,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `INSERT INTO lp_loyalty_pool (id, accrued_lamports) VALUES (1, 0)
       ON CONFLICT (id) DO NOTHING`,

    // Per-LP tracking. weighted_deposit_at moves forward proportionally
    // when an LP adds shares (preserves time-weighted exposure correctly).
    // shares is the current on-chain position; updated on every sync.
    `CREATE TABLE IF NOT EXISTS lp_positions (
       wallet_address TEXT PRIMARY KEY,
       shares NUMERIC(40,0) NOT NULL DEFAULT 0,
       weighted_deposit_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS lp_positions_shares_idx ON lp_positions(shares)
       WHERE shares > 0`,

    // Snapshot + distribution ledger.
    `CREATE TABLE IF NOT EXISTS lp_loyalty_distributions (
       id BIGSERIAL PRIMARY KEY,
       snapshot_at TIMESTAMPTZ NOT NULL,
       pool_lamports NUMERIC(30,0) NOT NULL,
       total_weight NUMERIC(40,0) NOT NULL,
       eligible_count INTEGER NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS lp_loyalty_rewards (
       id BIGSERIAL PRIMARY KEY,
       distribution_id BIGINT NOT NULL REFERENCES lp_loyalty_distributions(id) ON DELETE CASCADE,
       wallet_address TEXT NOT NULL,
       shares_at_snapshot NUMERIC(40,0) NOT NULL,
       seconds_held NUMERIC(20,0) NOT NULL,
       weight NUMERIC(40,0) NOT NULL,
       reward_lamports NUMERIC(30,0) NOT NULL,
       status TEXT NOT NULL DEFAULT 'accrued',
       paid_tx_signature TEXT,
       paid_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       UNIQUE (distribution_id, wallet_address)
     )`,
    `CREATE INDEX IF NOT EXISTS lp_loyalty_rewards_wallet_idx
       ON lp_loyalty_rewards(wallet_address, status)`,

    // ─────── SUPPORT TICKETS ───────
    // Free-form user messages routed to admin. Bot answers most issues
    // deterministically inline (/support → loan/tx diagnostic); this
    // table only stores the messages that need a human reply.
    `CREATE TABLE IF NOT EXISTS support_tickets (
       id BIGSERIAL PRIMARY KEY,
       user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       message TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'open',
       admin_reply TEXT,
       admin_replied_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS support_tickets_status_idx
       ON support_tickets(status, created_at DESC)`,

    // Ticket lifecycle columns added 2026-06.
    // status states: 'open' (waiting on admin), 'awaiting_user' (admin replied,
    // ball in user's court), 'closed' (resolved by admin or user).
    `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`,
    `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS last_user_followup_at TIMESTAMPTZ`,
    `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS followup_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS last_alerted_tier INTEGER`,
    // Tracks whether the AI auto-resolver has taken a pass at this
    // ticket. Set after the AI generates + sends a follow-up reply.
    // Null = never auto-attempted. Used to avoid double-resolution
    // and to surface in /tickets.
    `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS auto_resolved_at TIMESTAMPTZ`,

    // Dormant-re-engagement tracking. The agent nudges users who
    // haven't borrowed yet but have approved collateral in their
    // wallet. Hard rate limit: at most 1 nudge per user every 30 days.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_dormant_nudge_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS dormant_nudges_sent INTEGER NOT NULL DEFAULT 0`,
    // Set TRUE if user opts out of proactive engagement DMs.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS proactive_dms_disabled BOOLEAN NOT NULL DEFAULT FALSE`,
    // Idle-SOL agent: tracks last "deposit your idle SOL to /earn" nudge.
    // Separate from dormant_nudge so we don't double-message users.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_idle_sol_nudge_at TIMESTAMPTZ`,
    // Win-back agent: tracks last "come back, you've repaid before" nudge.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_winback_nudge_at TIMESTAMPTZ`,
    // Migrate legacy 'responded' status to new 'awaiting_user' state.
    `UPDATE support_tickets SET status = 'awaiting_user'
        WHERE status = 'responded'`,

    // ─────── AUTO-PROTECT ───────
    // Opt-in anti-liquidation: when a loan's health crosses the danger
    // threshold, the bot auto-tops-up or auto-partial-repays to bring
    // it back into safe territory. Defaults to OFF (explicit opt-in).
    `ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS auto_protect BOOLEAN NOT NULL DEFAULT FALSE`,
    // Log every auto-protect action so users (and the team) can audit
    // exactly what was done on their behalf.
    `CREATE TABLE IF NOT EXISTS auto_protect_actions (
       id BIGSERIAL PRIMARY KEY,
       user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       loan_id BIGINT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
       action_type TEXT NOT NULL,
       amount_lamports NUMERIC(30,0),
       health_before NUMERIC(10,3),
       health_after NUMERIC(10,3),
       signature TEXT,
       error TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS auto_protect_actions_loan_idx
       ON auto_protect_actions(loan_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS auto_protect_actions_user_idx
       ON auto_protect_actions(user_id, created_at DESC)`,
    // Streak tracking — consecutive on-time repays. Updated on each
    // /repay tx. Used for milestones + future rate discounts.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS current_streak INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS best_streak INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_repay_was_on_time BOOLEAN`,

    // ─────── AI SUPPORT CONVERSATIONS ───────
    // Multi-turn chat history for the AI support agent. One row per user;
    // history accumulates within an active session and resets after the
    // TTL (30 min idle) so each "session" stays focused and cheap.
    `CREATE TABLE IF NOT EXISTS support_conversations (
       user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       messages JSONB NOT NULL DEFAULT '[]'::jsonb,
       turns INTEGER NOT NULL DEFAULT 0,
       total_input_tokens INTEGER NOT NULL DEFAULT 0,
       total_output_tokens INTEGER NOT NULL DEFAULT 0,
       started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       escalated_to_ticket_id BIGINT
     )`,
  ];
  for (const sql of patches) {
    try {
      await query(sql);
      console.log("[db] startup patch applied:", sql.slice(0, 80));
    } catch (err) {
      console.warn("[db] startup patch failed (continuing):", err.message);
    }
  }
}

/**
 * Probe the secondary DB directly. Used by the weekly health check to
 * verify the failover path actually works before we need it.
 */
export async function pingSecondary() {
  if (!secondaryPool) return { ok: false, configured: false };
  try {
    const start = Date.now();
    await secondaryPool.query("SELECT 1");
    return { ok: true, configured: true, latency_ms: Date.now() - start };
  } catch (err) {
    return { ok: false, configured: true, error: err.message };
  }
}
