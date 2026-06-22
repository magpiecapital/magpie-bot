-- Layer 5 of the 2026-06-18 cosign-borrow exploit defense.
-- Auto-sweep seized liquidation collateral to SOL via Jupiter so the
-- lender wallet doesn't hold drain-bait tokens for hours.
--
-- Columns track auto-sweep attempt state so we don't infinite-retry a
-- bad route and so the operator can diagnose failures. The actual
-- sale_tx_sig + sale_proceeds_lamports + sale_detected_at columns
-- already exist (used by the manual-sale + sale-detector pathway);
-- the sweeper writes those on success the same way.

ALTER TABLE liquidation_economics
  ADD COLUMN IF NOT EXISTS auto_sweep_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_sweep_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_sweep_last_error TEXT;

-- Eligible rows = pending_sale, older than the warmup delay, attempts < cap.
-- Index covers the sweeper's poll query so it stays cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_liquidation_economics_auto_sweep_pending
  ON liquidation_economics (created_at)
  WHERE distribution_status = 'pending_sale';
