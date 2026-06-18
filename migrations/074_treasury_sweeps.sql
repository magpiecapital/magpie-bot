-- Treasury sweep audit ledger
--
-- Every periodic sweep of fees off the lender wallet (4JSSSa…) toward the
-- treasury vault (6foLvbG…) is recorded here regardless of outcome:
-- success, skip (balance below reserve floor), simulate-rejected, send
-- error. The ledger is the investor-grade audit trail for "where did the
-- protocol's fees go and when."
--
-- Outcomes:
--   success       — tx confirmed on-chain
--   skip_below_min — net sweep amount below TREASURY_SWEEP_MIN_SOL; no tx sent
--   skip_disabled — TREASURY_SWEEP_DISABLED env var is set
--   skip_locked   — another sweeper instance was running; advisory lock skip
--   sim_reject    — preflight simulate returned err; tx never broadcast
--   send_error    — RPC sendRawTransaction or confirmation timed out / failed

CREATE TABLE IF NOT EXISTS treasury_sweeps (
  id                  BIGSERIAL PRIMARY KEY,
  initiated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome             TEXT        NOT NULL,
  lender_balance_lamports_before BIGINT NOT NULL,
  reserve_lamports    BIGINT      NOT NULL,
  swept_lamports      BIGINT      NOT NULL DEFAULT 0,
  destination_pubkey  TEXT        NOT NULL,
  tx_signature        TEXT,
  error_message       TEXT,
  confirmed_at        TIMESTAMPTZ,
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_treasury_sweeps_initiated_at
  ON treasury_sweeps (initiated_at DESC);

CREATE INDEX IF NOT EXISTS idx_treasury_sweeps_outcome_initiated
  ON treasury_sweeps (outcome, initiated_at DESC);
