-- 082_lp_excess_sweeps.sql
--
-- Audit ledger for the LP-excess auto-sweeper. Each sweep tx writes a
-- row BEFORE broadcast (status='planned'), then updates on confirm
-- (status='confirmed' + tx_signature) or fail (status='failed' +
-- error_text).
--
-- Idempotency anchor: each tick aborts if any prior row is still in
-- 'planned' state for the same pool — we don't double-spend an
-- in-flight sweep just because the bot restarted.
--
-- Phase 2 of feedback_distribution_wallet_must_be_auto_funded (task #332).

CREATE TABLE IF NOT EXISTS lp_excess_sweeps (
  id                      BIGSERIAL PRIMARY KEY,
  program_label           TEXT NOT NULL,            -- 'V1' | 'V3' | 'V4'
  pool_pubkey             TEXT NOT NULL,
  vault_pubkey            TEXT NOT NULL,
  observed_total_deposits TEXT NOT NULL,            -- lamports at observation
  observed_vault_balance  TEXT NOT NULL,            -- lamports at observation
  observed_excess         TEXT NOT NULL,            -- lamports = vault - deposits
  swept_lamports          TEXT NOT NULL,            -- what we asked admin_withdraw to take
  destination_pubkey      TEXT NOT NULL,            -- CHCAM at the time
  tx_signature            TEXT,                     -- null until confirmed
  status                  TEXT NOT NULL DEFAULT 'planned',  -- planned | confirmed | failed
  error_text              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lp_excess_sweeps_status_pool
  ON lp_excess_sweeps (status, program_label);

CREATE INDEX IF NOT EXISTS idx_lp_excess_sweeps_created_at
  ON lp_excess_sweeps (created_at DESC);
