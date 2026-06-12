-- migration 039: bidirectional limit-close (take-profit + stop-loss).
--
-- Before now every limit_close_orders row fired when current_price >=
-- trigger_value (the take-profit semantic). Operator mandate:
--   "completes the bidirectional proactive risk story"
--   "make sure we are charging a 1% fee that goes back to the protocol
--    not only on gains but for stop losses too"
--
-- Stop-loss fires when current_price <= trigger_value — locks in
-- whatever value the user has left BEFORE a liquidation forces them
-- out at the edge. The 1% protocol fee comes off proceeds regardless
-- of direction (already direction-agnostic in the engine).
--
-- Implementation:
--   - 'above' = take-profit (existing behavior; default for back-compat
--     so every pre-migration row is treated as take-profit)
--   - 'below' = stop-loss (new)
--
-- Engine's isTriggerHit reads this column and swaps >= for <= when
-- direction='below'. Safety floor in safety.js bypasses the
-- "proceeds_below_safety_floor" check for direction='below' since a
-- stop-loss is exactly the case where the user WANTS out even with
-- low net.
--
-- arm-core validates that trigger_value sits on the correct side of
-- current price at arm time to prevent an immediate-fire arm. The
-- engine re-checks at fire time as defense in depth.

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS trigger_direction TEXT NOT NULL DEFAULT 'above';

ALTER TABLE limit_close_orders DROP CONSTRAINT IF EXISTS limit_close_orders_trigger_direction_check;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_trigger_direction_check
  CHECK (trigger_direction IN ('above', 'below'));

COMMENT ON COLUMN limit_close_orders.trigger_direction IS
  'Direction the trigger fires from. ''above'' (default, take-profit):
   fires when current_price >= trigger_value. ''below'' (stop-loss):
   fires when current_price <= trigger_value. arm-core validates the
   trigger_value sits on the correct side of current price at arm time.
   1% protocol fee applies in BOTH directions — operator rule 2026-06-12.';
