-- migration 065: TP/SL ladder re-borrow orchestration columns + sum-cap trigger
--
-- This migration adds the storage shape the engine needs to deliver a
-- TRUE partial-sell ladder via the re-borrow orchestration approach.
--
-- Why re-borrow:
--   V1/V3 partial_repay only reduces debt; it does NOT release
--   fractional collateral. So a "sell 70% at 16M MC, 10% at 17M, 10%
--   at 18M, 10% at 19M" ladder cannot be done in a single on-chain
--   step. The engine instead does, per leg fire:
--     1. repay_loan in full → all collateral to borrower ATA
--     2. swap (slice_pct / 10000) × original_collateral_amount via
--        Jupiter → SOL → send to borrower (less 1% protocol fee)
--     3. re-borrow with the REMAINING collateral as the new loan, at
--        the same tier as the original. NEW loan_id is assigned.
--     4. MIGRATE sibling armed orders (same ladder_group_id) to the
--        new loan_id so the ladder continues seamlessly.
--   If remaining collateral falls below MIN_LOAN_LAMPORTS (1 SOL
--   value), skip the re-borrow and cancel sibling armed orders with
--   reason='ladder_complete' — the user's collateral has fully sold
--   out across the ladder.
--
-- Pool coverage:
--   The engine re-borrows against the same program_id (V1, V2, or V3)
--   the original loan used. engine_program_id stays stamped on each
--   armed order so cross-pool fires are still structurally impossible.
--
-- Columns added:
--
--   ladder_group_id UUID
--     NULL for single-leg full-close orders (slice_pct=10000). Non-NULL
--     and shared across all legs of a ladder. The engine uses it to
--     find sibling armed orders that need migration after a leg fires.
--
--   original_collateral_amount NUMERIC
--     Snapshot of loan.collateral_amount taken at arm time. Used so
--     slice_pct semantics stay absolute across multiple re-borrows.
--     "10%" always means "10% of the original collateral" — never
--     drifts as the loan size shrinks per leg.
--
--   migrated_from_loan_id BIGINT
--     Set when an order survives a leg fire and is migrated to the
--     newly-opened loan's id. Audit trail so /lc-perf and ops can
--     reconstruct ladder lifecycle.
--
-- Sum-cap trigger:
--   Enforces SUM(slice_pct) <= 10000 across (loan_id, trigger_direction)
--   armed orders. Previously dropped in migration 064 because it was
--   meaningless without the engine actually honoring slice<100%; re-
--   added here now that the engine's re-borrow path makes it meaningful.

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS ladder_group_id UUID,
  ADD COLUMN IF NOT EXISTS original_collateral_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS migrated_from_loan_id BIGINT;

-- Index for sibling-migration lookup on leg fire. We always query by
-- ladder_group_id WHERE status='armed', so a partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS limit_close_orders_ladder_group_armed_idx
  ON limit_close_orders(ladder_group_id, status)
  WHERE ladder_group_id IS NOT NULL AND status = 'armed';

-- Sum-cap trigger (the version dropped in 064).
CREATE OR REPLACE FUNCTION limit_close_orders_validate_slice_sum()
RETURNS TRIGGER AS $$
DECLARE
  total_pct INT;
  effective_direction TEXT;
BEGIN
  -- Only enforce on rows in 'armed' state. Fired / cancelled / expired
  -- legs have already consumed (or released) their slice budget.
  IF NEW.status IS DISTINCT FROM 'armed' THEN
    RETURN NEW;
  END IF;

  effective_direction := COALESCE(NEW.trigger_direction, 'above');

  SELECT COALESCE(SUM(slice_pct), 0)
    INTO total_pct
    FROM limit_close_orders
   WHERE loan_id = NEW.loan_id
     AND COALESCE(trigger_direction, 'above') = effective_direction
     AND status = 'armed'
     AND id IS DISTINCT FROM NEW.id;   -- exclude self on UPDATE

  IF total_pct + NEW.slice_pct > 10000 THEN
    RAISE EXCEPTION
      'TP/SL ladder exceeds 100%%: existing armed legs sum to % bps (loan_id=%, direction=%); incoming leg of % bps would push to %.',
      total_pct, NEW.loan_id, effective_direction, NEW.slice_pct, total_pct + NEW.slice_pct
    USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS limit_close_orders_slice_sum_check ON limit_close_orders;

CREATE TRIGGER limit_close_orders_slice_sum_check
  BEFORE INSERT OR UPDATE OF status, slice_pct, trigger_direction, loan_id
  ON limit_close_orders
  FOR EACH ROW
  EXECUTE FUNCTION limit_close_orders_validate_slice_sum();

COMMENT ON COLUMN limit_close_orders.ladder_group_id IS
  'Groups legs of the same ladder (e.g. 70/10/10/10 split). The engine
   uses this to migrate sibling armed orders to the new loan_id after
   a leg fires + re-borrows on remaining collateral. NULL for legacy
   single-leg orders.';
COMMENT ON COLUMN limit_close_orders.original_collateral_amount IS
  'Snapshot of loan.collateral_amount at arm time, in mint native
   units (raw). Used so slice_pct semantics stay absolute across
   re-borrows — "10%" always means 10% of the ORIGINAL collateral.';
COMMENT ON COLUMN limit_close_orders.migrated_from_loan_id IS
  'When the engine re-borrows after a leg fires, sibling armed orders
   are UPDATEd to point at the new loan_id. This column preserves the
   chain so /lc-perf and ops can trace the ladder lifecycle.';
