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
 * Connect-out a client for a transactional sequence (BEGIN…COMMIT).
 * Use for atomic multi-row writes where partial state is unacceptable
 * — e.g. armOrderBatch's all-or-nothing N-leg insert
 * (feedback_one_signature_for_n_legs_always.md). Always release the
 * client in a finally block.
 *
 * Pins to the primary pool — we intentionally do NOT fail over to the
 * secondary on connection-class errors here, because if a transaction
 * is on a different DB than the rest of the request's writes the user
 * would see "phantom" partial state. Better to surface a hard fail
 * and let the caller decide.
 */
export async function getClient() {
  if (!pool) {
    throw new Error("No primary database connection available for transactional client");
  }
  return await pool.connect();
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

    // ── MULTI-WALLET SUPPORT ──
    // Previously, /import REPLACED the user's Magpie-generated wallet's
    // encrypted_secret with the imported wallet's secret. That destroyed
    // the original key permanently and locked users out of any loans
    // opened on the original wallet. This migration lifts the
    // one-wallet-per-user constraint and adds active-wallet tracking
    // so users can hold N wallets and toggle between them.
    `ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_user_id_key`,
    `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS label TEXT`,
    `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'custodial'`,
    `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`,
    // Mark every existing wallet as active (they're the only one per user
    // right now, so this is correct). New /import calls will deactivate
    // siblings and activate the new wallet atomically.
    `UPDATE wallets SET is_active = TRUE WHERE is_active IS NULL`,
    // Partial unique index — at most one active wallet per user.
    // This is the integrity constraint that makes the active-wallet
    // model unambiguous.
    `CREATE UNIQUE INDEX IF NOT EXISTS wallets_one_active_per_user_idx
       ON wallets (user_id) WHERE is_active = TRUE`,
    `CREATE INDEX IF NOT EXISTS wallets_user_id_lookup_idx ON wallets (user_id)`,

    // ── WALLET SNAPSHOTS (APPEND-ONLY AUDIT LOG) ──
    // Critical safety net: every time a wallet's encrypted_secret is set
    // (on create OR import), we append a row here. This table is NEVER
    // updated or deleted from — it's an immutable history of every key
    // we've ever generated or imported.
    //
    // If the live `wallets` row ever gets corrupted or overwritten
    // somehow, we can recover the original encrypted_secret by looking
    // it up here by public_key.
    //
    // Background neon-sync service mirrors this table to Neon so we
    // have an off-Railway copy as well.
    `CREATE TABLE IF NOT EXISTS wallet_snapshots (
       id BIGSERIAL PRIMARY KEY,
       wallet_id BIGINT,
       user_id BIGINT NOT NULL,
       public_key TEXT NOT NULL,
       encrypted_secret BYTEA NOT NULL,
       nonce BYTEA NOT NULL,
       auth_tag BYTEA NOT NULL,
       source TEXT NOT NULL DEFAULT 'unknown',
       trigger TEXT NOT NULL DEFAULT 'unknown',
       snapshotted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS wallet_snapshots_pubkey_idx ON wallet_snapshots (public_key)`,
    `CREATE INDEX IF NOT EXISTS wallet_snapshots_user_id_idx ON wallet_snapshots (user_id)`,

    // Backfill snapshots for existing wallets so we have a history
    // starting from now. Future creates/imports will snapshot via the
    // DB trigger below.
    `INSERT INTO wallet_snapshots
        (wallet_id, user_id, public_key, encrypted_secret, nonce, auth_tag, source, trigger)
      SELECT id, user_id, public_key, encrypted_secret, nonce, auth_tag,
             COALESCE(source, 'custodial'), 'startup_backfill'
        FROM wallets
       WHERE NOT EXISTS (
         SELECT 1 FROM wallet_snapshots ws WHERE ws.public_key = wallets.public_key
       )`,

    // ── DB-LEVEL AUTO-SNAPSHOT TRIGGER ──
    // Belt-and-suspenders on top of the app-level safety. Even if a
    // future code path bypasses the application's snapshot logic — a
    // raw psql session, a forgotten migration script, a dev tool, a
    // brand new code path that just writes to `wallets` directly — the
    // database itself guarantees a snapshot row gets written.
    //
    // Fires on INSERT and on UPDATE where encrypted_secret actually
    // changes. UPDATEs that only flip is_active / label / etc. don't
    // snapshot (no key material changes). On a destructive UPDATE
    // we snapshot BOTH the OLD and NEW values so the original key
    // material survives even the overwrite itself.
    `CREATE OR REPLACE FUNCTION wallet_auto_snapshot() RETURNS TRIGGER AS $$
     BEGIN
       IF TG_OP = 'INSERT' THEN
         INSERT INTO wallet_snapshots (
           wallet_id, user_id, public_key, encrypted_secret, nonce, auth_tag,
           source, trigger
         ) VALUES (
           NEW.id, NEW.user_id, NEW.public_key,
           NEW.encrypted_secret, NEW.nonce, NEW.auth_tag,
           COALESCE(NEW.source, 'unknown'),
           CASE COALESCE(NEW.source, 'unknown')
             WHEN 'custodial' THEN 'create'
             WHEN 'imported'  THEN 'import'
             ELSE 'insert'
           END
         );
       ELSIF TG_OP = 'UPDATE'
             AND NEW.encrypted_secret IS DISTINCT FROM OLD.encrypted_secret THEN
         -- Capture the OLD value first — this is the one at risk of being
         -- lost. Then capture the NEW value.
         INSERT INTO wallet_snapshots (
           wallet_id, user_id, public_key, encrypted_secret, nonce, auth_tag,
           source, trigger
         ) VALUES (
           OLD.id, OLD.user_id, OLD.public_key,
           OLD.encrypted_secret, OLD.nonce, OLD.auth_tag,
           COALESCE(OLD.source, 'unknown'), 'pre_update'
         );
         INSERT INTO wallet_snapshots (
           wallet_id, user_id, public_key, encrypted_secret, nonce, auth_tag,
           source, trigger
         ) VALUES (
           NEW.id, NEW.user_id, NEW.public_key,
           NEW.encrypted_secret, NEW.nonce, NEW.auth_tag,
           COALESCE(NEW.source, 'unknown'), 'post_update'
         );
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS wallets_auto_snapshot ON wallets`,
    `CREATE TRIGGER wallets_auto_snapshot
       AFTER INSERT OR UPDATE ON wallets
       FOR EACH ROW EXECUTE FUNCTION wallet_auto_snapshot()`,

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

    // When TRUE, the next time next_distribution_at fires the cron does a
    // SNAPSHOT-ONLY pass: it captures the holder set + pro-rata allocations
    // into rows with status='snapshot_pending', but skips the actual SOL
    // transfers. Operator reviews the captured snapshot and triggers
    // payouts manually via /distribute <id> when ready. Flag resets to
    // FALSE after the snapshot-only pass runs so subsequent distributions
    // resume normal auto-pay behavior.
    `ALTER TABLE magpie_holder_pool
       ADD COLUMN IF NOT EXISTS next_run_snapshot_only BOOLEAN NOT NULL DEFAULT FALSE`,

    // The first-snapshot pin lives in Railway env var (operator-private)
    // so it doesn't leak in this public repo. Applied separately by the
    // operator with a one-off SQL update; future schedule changes go
    // the same way. After the first snapshot fires, the random-window
    // logic takes over for subsequent runs.

    // ─────── AIRDROP / HOLDER-REWARDS EXEMPT LIST ───────
    // Operator-curated list of wallets that should NEVER receive holder
    // rewards or future airdrops. Schema is public (this repo); contents
    // are operator-private (live only in production DB and the private
    // magpiecapital/magpie-airdrop repo's management scripts). The
    // snapshot path reads this at distribution time and merges with the
    // hardcoded burn/system/protocol baseline in
    // services/magpie-holder-rewards.js.
    `CREATE TABLE IF NOT EXISTS airdrop_exempt_wallets (
       wallet_address TEXT PRIMARY KEY,
       reason         TEXT,
       added_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,

    // ─────── LP LOYALTY POOL ───────
    // Post-MGP-001 (ratified 2026-06-13): 10% of every loan fee accrues
    // to this pool — it IS the LP yield stream (the prior "base 80%
    // share-price growth" model was eliminated when voters chose to
    // reweight more aggressively toward $MAGPIE holders). Distributed
    // pro-rata to each LP's share-seconds (shares × time held). Long-
    // term LPs earn meaningfully more than flippers.
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

    // ─────── ACCOUNT LINK CODES ───────
    // Bridges a wallet (connected on the site) to a TG user account.
    // Flow: site requests a code, user pastes '/link <code>' in TG bot,
    // the bot adds the wallet to that user's wallets table. After
    // linking, the same Magpie account is reachable from both surfaces.
    // Codes expire after 15 min if not claimed.
    `CREATE TABLE IF NOT EXISTS account_link_codes (
       code TEXT PRIMARY KEY,
       wallet_pubkey TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
       claimed_at TIMESTAMPTZ,
       claimed_by_user_id BIGINT
     )`,
    `CREATE INDEX IF NOT EXISTS account_link_codes_wallet_idx
       ON account_link_codes(wallet_pubkey)`,
    `CREATE INDEX IF NOT EXISTS account_link_codes_unclaimed_idx
       ON account_link_codes(claimed_at)
       WHERE claimed_at IS NULL`,
    // Per-message nonce store for site-initiated actions (e.g. withdraw).
    // Each signed message includes a random nonce; we insert it here and
    // reject on duplicate-key, which makes replay attempts structurally
    // impossible regardless of clock skew.
    `CREATE TABLE IF NOT EXISTS used_nonces (
       nonce TEXT PRIMARY KEY,
       purpose TEXT NOT NULL,
       signer_pubkey TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS used_nonces_created_idx
       ON used_nonces(created_at)`,
    // Audit log of every site-initiated withdraw. Separate from generic
    // tx logs so it's easy to alert / spot-check / rate-limit.
    `CREATE TABLE IF NOT EXISTS site_withdrawals (
       id BIGSERIAL PRIMARY KEY,
       user_id BIGINT NOT NULL,
       signer_pubkey TEXT NOT NULL,
       from_pubkey TEXT NOT NULL,
       to_pubkey TEXT NOT NULL,
       asset TEXT NOT NULL,
       raw_amount NUMERIC NOT NULL,
       decimals INT NOT NULL,
       tx_signature TEXT,
       status TEXT NOT NULL DEFAULT 'submitted',
       error_text TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS site_withdrawals_user_idx
       ON site_withdrawals(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS site_withdrawals_signer_idx
       ON site_withdrawals(signer_pubkey, created_at DESC)`,
    // Kill-switch: while site_locked_until > NOW(), signed API actions
    // for this user are rejected. Pairs with the /lock TG command for
    // suspected-compromise recovery. The user sets it from TG (different
    // auth surface) so a stolen Phantom seed can't suppress the lock.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS site_locked_until TIMESTAMPTZ`,
    // GLOBAL site kill-switch. While disabled=true here, EVERY signed
    // site endpoint rejects with 503 — operator override for incidents
    // (e.g. suspected compromise of the bot server, sudden surge of
    // suspicious activity, planned maintenance).
    `CREATE TABLE IF NOT EXISTS site_global_state (
       id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
       disabled BOOLEAN NOT NULL DEFAULT FALSE,
       reason TEXT,
       set_by TEXT,
       set_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `INSERT INTO site_global_state(id, disabled) VALUES (1, FALSE)
       ON CONFLICT (id) DO NOTHING`,
    // Site-wide announcement banner. Operator-posted soft-announce.
    // Doesn't halt anything (use /sitedisable for that) — just shows
    // a non-blocking banner on the dashboard. NULL when no active
    // announcement.
    `CREATE TABLE IF NOT EXISTS site_announcement (
       id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
       message TEXT,
       severity TEXT NOT NULL DEFAULT 'info',
       set_by TEXT,
       set_at TIMESTAMPTZ,
       expires_at TIMESTAMPTZ
     )`,
    `INSERT INTO site_announcement(id, message, severity)
       VALUES (1, NULL, 'info') ON CONFLICT (id) DO NOTHING`,
    // Audit log of every lock/unlock action — both user-initiated
    // (/lock) and operator-initiated (/adminlock). Lets ops trace
    // suspicious patterns and users see their own lock history.
    `CREATE TABLE IF NOT EXISTS site_lock_events (
       id BIGSERIAL PRIMARY KEY,
       user_id BIGINT NOT NULL,
       action TEXT NOT NULL,
       hours INTEGER,
       set_by TEXT NOT NULL,
       reason TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS site_lock_events_user_idx
       ON site_lock_events(user_id, created_at DESC)`,
    // Operator notepad — persistent admin notes across deploys.
    // Useful for "remember to do X", incident notes, etc.
    `CREATE TABLE IF NOT EXISTS admin_notes (
       id BIGSERIAL PRIMARY KEY,
       note TEXT NOT NULL,
       set_by TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS admin_notes_created_idx
       ON admin_notes(created_at DESC)`,
    // Pip (site AI chat) per-user usage tracking. We don't want one
    // user burning through Anthropic credits all day. Each row tracks
    // a 24h window of message counts + an off-topic streak that triggers
    // a polite "let's stay on-topic" redirect after 3 off-topic posts.
    `CREATE TABLE IF NOT EXISTS ai_chat_usage (
       user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       messages_24h INTEGER NOT NULL DEFAULT 0,
       window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       offtopic_streak INTEGER NOT NULL DEFAULT 0,
       cooldown_until TIMESTAMPTZ,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    // 2026-06-06: Auto-Protect default flipped from opt-in to opt-out.
    // Backfill existing users who never explicitly disabled it (i.e.,
    // their current auto_protect is the old default of false AND they
    // have no record of toggling it off). Conservative: only flip rows
    // where auto_protect is FALSE — never touch a user who already
    // chose either direction.
    //
    // Idempotent: re-running this UPDATE only affects users who are
    // still on the old default. Once a user toggles either direction,
    // their row stays as-is forever.
    //
    // Migration-event log so we can identify "this was the backfill,
    // not the user's choice" if they later ask.
    `CREATE TABLE IF NOT EXISTS prefs_migrations (
       id BIGSERIAL PRIMARY KEY,
       name TEXT NOT NULL UNIQUE,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       rows_affected INTEGER
     )`,
    `DO $$
     DECLARE n INT;
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM prefs_migrations WHERE name = 'auto_protect_default_on_2026_06_06'
       ) THEN
         UPDATE user_prefs SET auto_protect = TRUE WHERE auto_protect = FALSE;
         GET DIAGNOSTICS n = ROW_COUNT;
         INSERT INTO prefs_migrations(name, rows_affected) VALUES ('auto_protect_default_on_2026_06_06', n);
         RAISE NOTICE 'Backfilled auto_protect=TRUE on % rows', n;
       END IF;
     END $$`,

    // ── PUMP ALERT OPT-OUT (2026-06-06) ─────────────────────────
    // Separates pump-celebration alerts ("Your bag is pumping!") from
    // health/risk alerts. Users who want risk warnings but find pump
    // confetti annoying can mute just this with /notify or a one-tap
    // button on the alert itself.
    `ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS notify_pump BOOLEAN NOT NULL DEFAULT TRUE`,

    // ── COMMUNITY MODERATION ────────────────────────────────────
    // Tracks which TG groups have the moderation bot active. Operator
    // enables per-chat via /community_enable. Quarantine + member
    // state is keyed by (chat_id, user_id).
    `CREATE TABLE IF NOT EXISTS community_chats (
       chat_id BIGINT PRIMARY KEY,
       title TEXT,
       enabled BOOLEAN NOT NULL DEFAULT TRUE,
       enabled_by_user_id BIGINT,
       enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS community_members (
       chat_id BIGINT NOT NULL,
       user_id BIGINT NOT NULL,
       joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       quarantine_until TIMESTAMPTZ,
       captcha_passed_at TIMESTAMPTZ,
       last_message_at TIMESTAMPTZ,
       warned_count INT NOT NULL DEFAULT 0,
       PRIMARY KEY (chat_id, user_id)
     )`,
    `CREATE INDEX IF NOT EXISTS community_members_quarantine_idx
       ON community_members(chat_id, quarantine_until)
       WHERE quarantine_until IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS community_mod_actions (
       id BIGSERIAL PRIMARY KEY,
       chat_id BIGINT NOT NULL,
       user_id BIGINT NOT NULL,
       action TEXT NOT NULL,
       reason TEXT,
       payload TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS community_mod_actions_chat_idx
       ON community_mod_actions(chat_id, created_at DESC)`,
    // Per-rule cooldown for operator anomaly DMs so a single incident
    // doesn't page the operator every 2-min watcher tick.
    `CREATE TABLE IF NOT EXISTS community_anomaly_alerts (
       id BIGSERIAL PRIMARY KEY,
       chat_id BIGINT NOT NULL,
       rule_key TEXT NOT NULL,
       n_actions INT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS community_anomaly_alerts_lookup_idx
       ON community_anomaly_alerts(chat_id, rule_key, created_at DESC)`,
    // Pending public questions that the sweeper considers picking up if
    // they go unanswered. We record candidate questions on arrival, mark
    // them answered when a reply arrives, and mark them picked-up when
    // Pip auto-answers. The sweep selects WHERE both timestamps are NULL
    // AND created_at < NOW() - 10min.
    `CREATE TABLE IF NOT EXISTS community_pending_questions (
       chat_id BIGINT NOT NULL,
       message_id BIGINT NOT NULL,
       sender_id BIGINT NOT NULL,
       text TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       answered_in_chat_at TIMESTAMPTZ,
       pip_picked_up_at TIMESTAMPTZ,
       PRIMARY KEY (chat_id, message_id)
     )`,
    `CREATE INDEX IF NOT EXISTS community_pending_questions_sweep_idx
       ON community_pending_questions (chat_id, created_at)
       WHERE pip_picked_up_at IS NULL AND answered_in_chat_at IS NULL`,
    // Snapshot of which milestones we've already announced so the
    // milestone-poller doesn't re-announce the same one after a restart.
    `CREATE TABLE IF NOT EXISTS community_milestones_seen (
       chat_id BIGINT NOT NULL,
       milestone_key TEXT NOT NULL,
       posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       PRIMARY KEY (chat_id, milestone_key)
     )`,
    // Per-user / per-wallet bans for the borrow flow. Banned users
    // can still /start the bot, view stats, etc. — but every borrow
    // path consults isUserBanned + isAnyWalletBanned and refuses to
    // open new loans. Idempotent inserts on the operator side; rows
    // are explicitly tracked with banned_at + banned_by + reason for
    // auditability.
    `CREATE TABLE IF NOT EXISTS banned_users (
       user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       telegram_id BIGINT,
       banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       banned_by TEXT,
       reason TEXT,
       notes TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS banned_users_tgid_idx
       ON banned_users(telegram_id) WHERE telegram_id IS NOT NULL`,
    // Wallet-level bans — catches the case where a banned user
    // imports their wallet into a new account, or where the same
    // wallet is shared between accounts. The pre-borrow check
    // consults this for the ACTIVE wallet on every loan attempt.
    `CREATE TABLE IF NOT EXISTS banned_wallets (
       wallet_pubkey TEXT PRIMARY KEY,
       banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       banned_by TEXT,
       reason TEXT,
       related_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
       notes TEXT
     )`,
    // Tweet IDs we've already cross-posted to the community group.
    // Prevents both the auto-poller and the manual /crosspost from
    // posting the same tweet twice. tweet_id is X's numeric ID stored
    // as text (Solana also stores u64 as text — same reason).
    `CREATE TABLE IF NOT EXISTS community_x_seen (
       tweet_id TEXT PRIMARY KEY,
       source TEXT NOT NULL,
       posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    // Rolling price + liquidity snapshots per mint. The borrow flow
    // compares the live spot price against a trailing N-minute average
    // (off-chain TWAP) to detect price-impact attacks where a thin
    // pool gets pumped right before a loan open. The snapshot loop
    // also captures pool liquidity so we can detect rug-pull patterns
    // post-borrow without depending on DexScreener at the critical
    // moment. Pruned older than 24h to keep the table small.
    `CREATE TABLE IF NOT EXISTS mint_price_snapshots (
       mint TEXT NOT NULL,
       snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       price_usd DOUBLE PRECISION,
       liquidity_usd DOUBLE PRECISION,
       PRIMARY KEY (mint, snapshot_at)
     )`,
    `CREATE INDEX IF NOT EXISTS mint_price_snapshots_recent_idx
       ON mint_price_snapshots(mint, snapshot_at DESC)`,
    // Funding-graph: when we auto-ban a wallet, we trace its recent
    // SOL inflows on-chain and ban the funding sources too (excluding
    // known CEXes / common deposit addresses). This table is just an
    // audit log of what we found — actual bans go into banned_wallets.
    `CREATE TABLE IF NOT EXISTS funding_traces (
       id BIGSERIAL PRIMARY KEY,
       traced_wallet TEXT NOT NULL,
       funder_wallet TEXT NOT NULL,
       lamports_received NUMERIC(20,0) NOT NULL,
       tx_signature TEXT,
       block_time TIMESTAMPTZ,
       traced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       action TEXT NOT NULL CHECK (action IN ('banned','skipped_cex','skipped_already_banned','dry_run'))
     )`,
    `CREATE INDEX IF NOT EXISTS funding_traces_traced_wallet_idx
       ON funding_traces(traced_wallet, traced_at DESC)`,
    // Suspended-loan flag — when exploit-detector auto-bans a borrower
    // who has an active loan, we mark that loan suspended. The repay
    // and extension flows refuse to interact with a suspended loan
    // (we never want to help the attacker buy back the collateral or
    // delay liquidation), and the loan-watcher prioritizes it for
    // immediate liquidation the moment dueTimestamp passes.
    `ALTER TABLE loans ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE loans ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`,
    `ALTER TABLE loans ADD COLUMN IF NOT EXISTS suspended_reason TEXT`,
    // The wallet that actually signed this borrow. Populated going forward
    // at recordLoan time. Older rows have NULL — the activity feed
    // falls back to a temporal heuristic for those (pick the wallet
    // owned by the user that existed at loan-open time).
    `ALTER TABLE loans ADD COLUMN IF NOT EXISTS borrower_wallet TEXT`,
    `CREATE INDEX IF NOT EXISTS loans_borrower_wallet_idx ON loans(borrower_wallet) WHERE borrower_wallet IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS loans_suspended_idx ON loans(suspended) WHERE suspended = TRUE`,
    // Conditional borrow intents — "limit orders for borrows". Agent
    // posts an intent specifying collateral + tier + a trigger
    // condition. Background watcher fires the borrow tx when the
    // condition matches. Agent then signs + submits.
    //
    // First permissionless lending protocol on Solana with this. The
    // wedge for agent-native finance: an agent doesn't need to be
    // online to capture an opportunity — just to sign + submit when
    // the conditions hit.
    //
    // Condition shapes (condition_type / condition_params):
    //   'price_above'   { mint, usd }       — token price rises ABOVE
    //   'price_below'   { mint, usd }       — token price drops BELOW
    //   'time_after'    { unix }            — wall-clock trigger
    //   'pool_liq_above'{ usd }             — protocol pool TVL grows
    //
    // Status lifecycle:
    //   pending  → conditions not met yet
    //   matched  → conditions met, server built the tx, awaiting agent sign
    //   executed → agent confirmed on-chain submission, intent done
    //   expired  → intent's expires_at passed without match
    //   cancelled → agent explicitly cancelled
    `CREATE TABLE IF NOT EXISTS borrow_intents (
       id BIGSERIAL PRIMARY KEY,
       intent_id TEXT UNIQUE NOT NULL,
       borrower_wallet TEXT NOT NULL,
       collateral_mint TEXT NOT NULL,
       collateral_amount NUMERIC(40,0) NOT NULL,
       tier SMALLINT NOT NULL CHECK (tier IN (0, 1, 2)),
       condition_type TEXT NOT NULL,
       condition_params JSONB NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending', 'matched', 'executed', 'expired', 'cancelled')),
       partial_signed_tx_b64 TEXT,
       summary JSONB,
       executed_tx TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       expires_at TIMESTAMPTZ NOT NULL,
       matched_at TIMESTAMPTZ,
       executed_at TIMESTAMPTZ,
       last_checked_at TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS borrow_intents_pending_idx
       ON borrow_intents(status, last_checked_at) WHERE status = 'pending'`,
    `CREATE INDEX IF NOT EXISTS borrow_intents_wallet_idx
       ON borrow_intents(borrower_wallet, created_at DESC)`,
    // Webhook delivery — optional per-intent push notification when
    // status flips to 'matched'. Lets agents stop polling. The watcher
    // POSTs an HMAC-signed payload to webhook_url. webhook_secret is
    // server-generated if the caller doesn't supply one; agents store
    // it and use it to verify the signature on receive.
    `ALTER TABLE borrow_intents ADD COLUMN IF NOT EXISTS webhook_url TEXT`,
    `ALTER TABLE borrow_intents ADD COLUMN IF NOT EXISTS webhook_secret TEXT`,
    `ALTER TABLE borrow_intents ADD COLUMN IF NOT EXISTS webhook_delivered_at TIMESTAMPTZ`,
    `ALTER TABLE borrow_intents ADD COLUMN IF NOT EXISTS webhook_attempts INT NOT NULL DEFAULT 0`,
    `ALTER TABLE borrow_intents ADD COLUMN IF NOT EXISTS webhook_last_error TEXT`,
    // Index for retry pass: find matched-but-undelivered intents that
    // are due for another delivery attempt.
    `CREATE INDEX IF NOT EXISTS borrow_intents_webhook_retry_idx
       ON borrow_intents(matched_at, webhook_attempts)
       WHERE webhook_url IS NOT NULL AND webhook_delivered_at IS NULL AND status = 'matched'`,
    // Paid x402 call log. The x402 service fires-and-forgets a row to
    // this table after every successful payment verification. Lets us
    // surface live revenue + adoption metrics without re-deriving the
    // data by walking SOL transactions on-chain.
    //
    // (path, ts) index supports the 24h-aggregate read pattern; the
    // (payer_pubkey) index supports unique-paying-wallets counts.
    `CREATE TABLE IF NOT EXISTS x402_paid_calls (
       id BIGSERIAL PRIMARY KEY,
       endpoint_path TEXT NOT NULL,
       method TEXT NOT NULL,
       amount_lamports NUMERIC(20,0) NOT NULL,
       payer_pubkey TEXT NOT NULL,
       tx_signature TEXT UNIQUE NOT NULL,
       nonce TEXT,
       recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS x402_paid_calls_recent_idx
       ON x402_paid_calls(recorded_at DESC)`,
    `CREATE INDEX IF NOT EXISTS x402_paid_calls_endpoint_idx
       ON x402_paid_calls(endpoint_path, recorded_at DESC)`,
    `CREATE INDEX IF NOT EXISTS x402_paid_calls_payer_idx
       ON x402_paid_calls(payer_pubkey)`,
    // Borrow-exempt wallet allowlist. Operator-controlled. Bypasses the
    // wallet/account profile gates in preBorrowAntiExploitCheck (imported-
    // wallet cooldown, new-account cap). All systemic gates (TWAP, pool
    // floor, per-token cap, rapid-fire, bans) still apply.
    // Union'd with the BORROW_EXEMPT_WALLETS env var so emergency env-
    // configured exemptions keep working alongside DB-managed ones.
    `CREATE TABLE IF NOT EXISTS borrow_exempt_wallets (
       wallet_pubkey TEXT PRIMARY KEY,
       added_by TEXT,
       added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       reason TEXT
     )`,
    // Per-token open-loan cap override. NULL = use protocol default
    // (BORROW_PER_TOKEN_OPEN_CAP_SOL, currently 10 SOL). 0 = unlimited
    // (no cap). Positive value = override in lamports.
    //
    // Set after operator confirms a token is deep enough to take more
    // exposure (high market cap, deep pool, established history).
    // $MAGPIE auto-defaults to unlimited (it's our protocol token —
    // there's no upside in arbitrarily capping borrows against it).
    `ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS max_open_lamports NUMERIC(20,0)`,

    // 2026-06-19 PM — Tiered attestation (mirrors migrations/085_supported_mints_attestation_tier.sql).
    // Inlined here because this codebase doesn't have an automatic
    // migration runner — the migrations/ folder is applied manually.
    // Putting the schema change in pool.js's init list makes it
    // self-healing on boot.
    //
    // attestation_tier: hot (always attested) / warm (active-loan-only) /
    //   cold (JIT only at cosign-borrow).
    // Default 'hot' preserves prior behavior for every existing mint.
    // See [[feedback_tiered_attestation_cost_conscious]].
    `ALTER TABLE supported_mints
       ADD COLUMN IF NOT EXISTS attestation_tier TEXT NOT NULL DEFAULT 'hot'
       CHECK (attestation_tier IN ('hot', 'warm', 'cold'))`,
    `CREATE INDEX IF NOT EXISTS idx_supported_mints_tier_enabled
       ON supported_mints (attestation_tier, enabled)
       WHERE enabled = TRUE`,
    `CREATE TABLE IF NOT EXISTS supported_mints_tier_changes (
       id BIGSERIAL PRIMARY KEY,
       mint TEXT NOT NULL,
       from_tier TEXT,
       to_tier TEXT NOT NULL,
       changed_by TEXT,
       reason TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_smtc_mint_created
       ON supported_mints_tier_changes (mint, created_at DESC)`,

    // $MU — Micron Technology tokenized stock (Backpack Securities / Trek Labs,
    // Token-2022), operator-trusted MANUAL approval (full authorization
    // 2026-06-22). category='stock' so it (a) shows in the site's Tokenized
    // Stocks column, (b) routes to V3 (no-exit) + V4 (with-exit) per
    // chooseProgramId RWA routing, (c) is force-kept hot+protected by the
    // stocks-rwa-protection-sentinel. Mirrors the $MAGPIE permanent-seed
    // pattern so it can NEVER be auto-disabled and its V3/V4 price_feed PDAs
    // are always pre-warmed (boot + 30-min attestor walks every enabled mint;
    // hot tier keeps the 8-sample TWAP window filled — required for the V3/V4
    // TWAP gate on low-liquidity xStocks). decimals=6 + Token-2022 owner +
    // name "Micron Technology" verified on-chain; Jupiter prices it (~$1.95M
    // liquidity) so the attestor can fill the TWAP window. ON CONFLICT
    // re-asserts symbol/name/category/enabled/protected/hot on EVERY boot, so
    // no health watcher / screener can ever take it off or mis-categorize it.
    // Placed after the attestation_tier column patch above so the column exists.
    `INSERT INTO supported_mints
       (mint, symbol, name, decimals, category, image_url,
        liquidity_usd, holder_count, market_cap_usd,
        has_mint_authority, has_freeze_authority, lp_burned,
        token_age_hours, auto_approved, screened_at, source,
        enabled, protected, attestation_tier)
     VALUES ('MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1',
             'MU', 'Micron Technology', 6, 'stock', NULL,
             0, 0, 0,
             TRUE, TRUE, FALSE,
             0, FALSE, NOW(), 'operator_trusted',
             TRUE, TRUE, 'hot')
     ON CONFLICT (mint) DO UPDATE SET
       symbol = 'MU',
       name = 'Micron Technology',
       category = 'stock',
       decimals = 6,
       enabled = TRUE,
       protected = TRUE,
       attestation_tier = 'hot',
       source = 'operator_trusted'`,

    // Keep the screener from ever re-processing $MU through the audit
    // pipeline (which could otherwise flag/disable an operator-trusted mint).
    `INSERT INTO token_screen_seen (mint)
     VALUES ('MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1')
     ON CONFLICT DO NOTHING`,

    // 2026-06-17 — Fee-wallet auto-sweeper audit ledger
    // (feedback_distribution_wallet_must_be_auto_funded.md).
    // Records every move of accrued fees from fee_wallet (lender pubkey's
    // wSOL ATA) → distribution wallet (CHCAMWtn). 'planned' rows are
    // the idempotency anchor: written BEFORE tx broadcast so a crash
    // mid-flight leaves a reconcilable audit trail. 'confirmed' rows
    // include the on-chain tx_signature.
    `CREATE TABLE IF NOT EXISTS fee_wallet_sweeps (
       id              BIGSERIAL PRIMARY KEY,
       source_pubkey   TEXT NOT NULL,
       dest_pubkey     TEXT NOT NULL,
       amount_lamports NUMERIC(30,0) NOT NULL,
       status          TEXT NOT NULL CHECK (status IN ('planned','confirmed','failed','reconciled')),
       tx_signature    TEXT,
       reason          TEXT,
       err             TEXT,
       created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS fee_wallet_sweeps_status_idx ON fee_wallet_sweeps(status) WHERE status = 'planned'`,
    `CREATE INDEX IF NOT EXISTS fee_wallet_sweeps_created_idx ON fee_wallet_sweeps(created_at DESC)`,

    // 2026-06-17 — Pending-arm queue (architectural fix for the race
    // class that bit operator 3 times on loan 820, 826, 830). When
    // armOrderBatch's 30s polling window expires without finding the
    // loan, we store the signed envelope here and a background
    // watcher retries every 10s while the envelope is fresh (5 min).
    // User never has to re-sign. Schema captures the minimum to
    // replay: parsed legs, intent_ids, source, and the envelope
    // metadata for audit. The envelope IS valuable (replay-attack
    // surface within 5min) — operator-only DB access + auto-purge
    // post-expiry keep the blast radius bounded.
    // See feedback_loan_830_full_postmortem_and_defenses.md.
    `CREATE TABLE IF NOT EXISTS pending_arms (
       id                   BIGSERIAL PRIMARY KEY,
       user_id              INT NOT NULL,
       signer_pubkey        TEXT NOT NULL,
       wallet               TEXT NOT NULL,
       loan_id_chain        TEXT NOT NULL,
       legs                 JSONB NOT NULL,
       intent_ids           BIGINT[],
       source               TEXT NOT NULL,
       arm_note_prefix      TEXT,
       envelope_issued_at   TIMESTAMPTZ NOT NULL,
       status               TEXT NOT NULL CHECK (status IN ('pending','armed','expired','failed')),
       retry_count          INT NOT NULL DEFAULT 0,
       last_retry_at        TIMESTAMPTZ,
       last_retry_error     TEXT,
       order_ids            BIGINT[],
       created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS pending_arms_pending_idx ON pending_arms(status, envelope_issued_at) WHERE status = 'pending'`,
    `CREATE INDEX IF NOT EXISTS pending_arms_wallet_idx ON pending_arms(wallet, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS pending_arms_loan_id_idx ON pending_arms(loan_id_chain) WHERE status IN ('pending', 'armed')`,

    // ─────────── UNIFIED DISTRIBUTION ACCOUNTING (2026-06-18) ───────────
    // Operator-mandated 2026-06-18: every SOL distribution Magpie makes
    // to stakeholders — holder rewards, governance ratifications, LP
    // loyalty, yield, loan remediation — gets one row here. This is the
    // canonical investor-facing roll-up sitting OVER the per-kind detail
    // tables (which remain the source of truth for per-wallet payouts).
    //
    // Why a new table instead of extending magpie_holder_distributions:
    // that table has a 6-field schema tightly coupled to holder-reward
    // mechanics. A unified table needs to cover governance (weight-based
    // denominator), LP-loyalty (share-seconds), yield (LP pro-rata), etc.
    // Cleaner to ship a new layer than to retrofit.
    //
    // The per-kind tables stay as the source of truth for per-wallet
    // detail (governance_distributions, lp_loyalty_rewards,
    // magpie_holder_rewards, etc.). This table is the joinable summary.
    //
    // See feedback_unified_distribution_accounting.md.
    `CREATE TABLE IF NOT EXISTS distribution_events (
       id                              BIGSERIAL PRIMARY KEY,
       kind                            TEXT NOT NULL CHECK (kind IN (
                                         'holder_reward','governance','lp_loyalty','yield','loan_remediation'
                                       )),
       external_ref                    TEXT NOT NULL,
       snapshot_at                     TIMESTAMPTZ NOT NULL,
       paid_first_at                   TIMESTAMPTZ,
       paid_last_at                    TIMESTAMPTZ,
       pool_lamports                   NUMERIC(30,0),
       distributed_lamports            NUMERIC(30,0) NOT NULL DEFAULT 0,
       unpaid_lamports                 NUMERIC(30,0) NOT NULL DEFAULT 0,
       eligible_wallet_count           INTEGER       NOT NULL DEFAULT 0,
       paid_wallet_count               INTEGER       NOT NULL DEFAULT 0,
       unpayable_wallet_count          INTEGER       NOT NULL DEFAULT 0,
       denominator_kind                TEXT,
       denominator_value               NUMERIC(40,0),
       min_payout_lamports             NUMERIC(30,0),
       max_payout_lamports             NUMERIC(30,0),
       median_payout_lamports          NUMERIC(30,0),
       source_borrow_fees_lamports     NUMERIC(30,0) NOT NULL DEFAULT 0,
       source_liquidation_lamports     NUMERIC(30,0) NOT NULL DEFAULT 0,
       source_other_lamports           NUMERIC(30,0) NOT NULL DEFAULT 0,
       plan_hash                       TEXT,
       snapshot_hash                   TEXT,
       sample_tx_signatures            TEXT[],
       notes                           TEXT,
       status                          TEXT NOT NULL DEFAULT 'planned'
                                         CHECK (status IN ('planned','partial','complete','verified')),
       metadata                        JSONB,
       created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       UNIQUE (kind, external_ref)
     )`,
    `CREATE INDEX IF NOT EXISTS distribution_events_kind_at_idx
       ON distribution_events(kind, snapshot_at DESC)`,
    `CREATE INDEX IF NOT EXISTS distribution_events_at_idx
       ON distribution_events(snapshot_at DESC)`,
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
