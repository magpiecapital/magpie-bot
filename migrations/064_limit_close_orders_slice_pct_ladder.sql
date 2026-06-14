-- migration 064: TP/SL ladder — slice_pct + sum-cap trigger
--
-- Today: migration 047 enforces UNIQUE (loan_id, trigger_direction)
-- on armed orders. That caps each loan at ONE armed TP + ONE armed
-- SL — fine for the basic "set it and forget it" user, but it
-- forecloses the strategy of selling portions at multiple price
-- targets (e.g. "take 25% off at 1.5x, another 25% at 1.8x, the
-- rest at 2.2x").
--
-- This migration:
--   1) Adds slice_pct (basis-points fraction of collateral closed
--      when the leg fires). DEFAULT 10000 (= 100%) so every legacy
--      armed order remains a single full-close leg.
--   2) Drops the per-direction UNIQUE index from migration 047.
--   3) Replaces it with a BEFORE INSERT/UPDATE trigger that enforces
--      SUM(slice_pct) <= 10000 across the (loan_id, trigger_direction)
--      armed-order set. Users can now arm 1-N legs per direction so
--      long as the cumulative slice never exceeds 100%.
--
-- Engine-side semantics (paired magpie-limitclose change, separate
-- PR):
--   - When a leg with slice_pct < 10000 fires, the engine calls
--     partial_repay sized to its slice. The remaining armed legs on
--     the same loan stay armed (they're still wanted).
--   - When the cumulative fired slice for the loan reaches 10000
--     (across however many legs), the loan is fully closed and any
--     remaining armed legs are auto-cancelled with
--     reason='ladder_complete'.
--   - Opposite-direction armed orders (e.g. a SL when a TP just
--     fired its full 100% slice) are still auto-cancelled with
--     reason='sibling_order_fired', same as today.
--
-- This bot-side migration ships the storage + validation. Until the
-- engine PR lands, slice_pct < 10000 is rejected at the arm path so
-- users don't arm a ladder that can't be honored end-to-end. See
-- src/services/limit-close-arm-core.js for the env-gated rollout.

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS slice_pct INT NOT NULL DEFAULT 10000;

ALTER TABLE limit_close_orders
  DROP CONSTRAINT IF EXISTS limit_close_orders_slice_pct_range;

ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_slice_pct_range
  CHECK (slice_pct > 0 AND slice_pct <= 10000);

DROP INDEX IF EXISTS limit_close_orders_one_armed_per_direction_idx;

CREATE OR REPLACE FUNCTION limit_close_orders_validate_slice_sum()
RETURNS TRIGGER AS $$
DECLARE
  total_pct INT;
  effective_direction TEXT;
BEGIN
  -- Only enforce on rows transitioning into 'armed'. Cancellations
  -- and fires aren't subject to the sum cap (a fired leg has already
  -- consumed its slice; a cancelled leg releases its slice back to
  -- the available budget).
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
    USING ERRCODE = '23514';   -- check_violation
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS limit_close_orders_slice_sum_check
  ON limit_close_orders;

CREATE TRIGGER limit_close_orders_slice_sum_check
  BEFORE INSERT OR UPDATE OF status, slice_pct, trigger_direction, loan_id
  ON limit_close_orders
  FOR EACH ROW
  EXECUTE FUNCTION limit_close_orders_validate_slice_sum();

COMMENT ON COLUMN limit_close_orders.slice_pct IS
  'Fraction of loan collateral closed when this leg fires, in basis
   points (10000 = 100% = full close). SUM(slice_pct) across armed
   legs per (loan_id, trigger_direction) is capped at 10000 by the
   slice_sum_check trigger. Legacy rows default to 10000 = single
   full-close leg, matching pre-ladder behavior.';
