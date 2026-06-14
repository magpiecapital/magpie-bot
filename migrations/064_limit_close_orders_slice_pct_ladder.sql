-- migration 064: TP/SL multi-target arming + slice_pct scaffolding
--
-- Today (migration 047) enforces a UNIQUE per (loan_id, trigger_direction)
-- WHERE status='armed' — at most one armed TP + one armed SL per loan.
-- This forecloses the common strategy of arming MULTIPLE TPs at
-- different price targets (e.g. "TP at 1.5x AND a backup TP at 2x;
-- whichever hits first fires").
--
-- What this migration does:
--   1) Adds slice_pct INT NOT NULL DEFAULT 10000 (= 100% = full close).
--      Scaffolding for a future on-chain "partial close with swap"
--      instruction. Today's repay_loan + partial_repay don't release
--      fractional collateral, so slice_pct < 10000 cannot be honored
--      end-to-end on chain. The arm path (limit-close-arm-core.js)
--      keeps an env-gated refuse for slice < 10000 until the on-chain
--      capability lands. Schema is in place so we can flip it on
--      without a migration when the V4 program ships.
--
--   2) Drops migration 047's per-direction UNIQUE index — so users can
--      arm N TPs at different prices (and N SLs). The engine's
--      existing markFired() sibling-cancel logic handles the
--      first-trigger-wins semantic: when one leg fires (full close),
--      the loan is closed, and any remaining armed legs on the loan
--      auto-cancel with reason='sibling_order_fired'.
--
-- Why no sum trigger here:
--   A SUM(slice_pct) cap only makes sense when the engine actually
--   honors fractional fills. Until then, every leg is implicitly
--   slice=100% (full close on trigger), and a "sum cap" would just
--   re-impose the migration-047 UNIQUE in different syntax. When V4
--   lands and the operator enables ladder mode, a follow-up migration
--   will add the sum trigger so SUM(slice_pct) <= 10000 enforces a
--   coherent fractional plan.

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS slice_pct INT NOT NULL DEFAULT 10000;

ALTER TABLE limit_close_orders
  DROP CONSTRAINT IF EXISTS limit_close_orders_slice_pct_range;

ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_slice_pct_range
  CHECK (slice_pct > 0 AND slice_pct <= 10000);

-- Drop the per-direction UNIQUE so multi-target arming becomes possible.
-- Engine-side: first leg to fire closes the loan; sibling armed legs
-- cancel automatically via the existing markFired() flow. No engine
-- code change needed for this migration.
DROP INDEX IF EXISTS limit_close_orders_one_armed_per_direction_idx;

COMMENT ON COLUMN limit_close_orders.slice_pct IS
  'Fraction of loan collateral closed when this leg fires, in basis
   points (10000 = 100% = full close). Today the on-chain protocol
   only supports full close, so every armed leg implicitly uses 10000
   and a "ladder of fractional sells" is gated off in the arm path.
   Schema in place for when a future on-chain partial-close
   instruction lands.';
