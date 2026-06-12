-- migration 037: take-profit fee → accrual pipeline marker.
--
-- Until now the engine transferred the 1% take-profit execution fee
-- directly to PROTOCOL_FEE_DESTINATION as a single SOL transfer. That
-- bypassed the borrow-fee accrual pipeline (accrueFromLoan →
-- accrueToHolderPool → accrueToLpLoyaltyPool) which is what MGP-001
-- proposes to rebalance to 70/10/10/10.
--
-- Operator-stated rule (2026-06-12): the 1% TP fee must feed the SAME
-- distribution pipeline as borrow fees, so the MGP-001 split applies
-- uniformly. If MGP-001 passes, 70% of TP fees automatically route to
-- $MAGPIE holders without additional plumbing — because both fee types
-- now run through accrueToHolderPool, which reads holder_reward_bps
-- from governance_config.
--
-- This column is the idempotency marker. The accrual watcher scans for
-- fired/partial_fired orders with accrued_at IS NULL, accrues, then
-- stamps NOW. Re-runs are no-ops. Crash-safe.

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS accrued_at TIMESTAMPTZ;

COMMENT ON COLUMN limit_close_orders.accrued_at IS
  'When the order''s 1% protocol fee was accrued into the
   holder/LP/referral distribution pools. NULL = pending accrual.
   Stamped by limit-close-fee-accrual-watcher. Idempotent via this
   column (WHERE accrued_at IS NULL is the only filter).';

-- Partial index so the watcher scan is O(unaccrued) not O(all orders).
CREATE INDEX IF NOT EXISTS limit_close_orders_unaccrued_idx
  ON limit_close_orders(fired_at)
  WHERE accrued_at IS NULL AND status IN ('fired', 'partial_fired');
