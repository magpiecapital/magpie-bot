-- migration 031: widen slippage CHECK constraints to match PR #77 defaults.
--
-- PR #77 (feat/fill-guarantee-defaults) raised the application-side
-- validation limits:
--   - MAX_INITIAL_SLIPPAGE_BPS: 1000 -> 2500
--   - DEFAULT_HARD_CAP_BPS:     1000 -> 5000
--
-- The DB CHECK constraints from migrations 025 + 027 still pin all three
-- slippage columns at 1000 bps max, so any new INSERT with the new
-- derived caps (e.g. cap=2500 on a default-slip arm) violates the CHECK
-- and the INSERT rolls back. Result: arming silently broken in prod.
--
-- This migration relaxes the CHECKs to match the new application limits.
-- The application is STILL the source of truth on the upper bound — the
-- CHECK just stops being a regression source.
--
-- The bounds line up with arm-core's constants intentionally:
--   slippage_bps         <= 2500  (matches MAX_INITIAL_SLIPPAGE_BPS)
--   initial_slippage_bps <= 2500  (same — frozen copy of the initial)
--   max_slippage_bps_cap <= 5000  (matches DEFAULT_HARD_CAP_BPS)
--
-- Lower bound of 10 bps preserved — it's a "did the caller mean to send
-- a value at all" sanity floor, not a UX preference.

-- 1. slippage_bps — the current working slippage; escalates up to the cap.
ALTER TABLE limit_close_orders DROP CONSTRAINT IF EXISTS limit_close_orders_slippage_bps_check;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_slippage_bps_check
  CHECK (slippage_bps >= 10 AND slippage_bps <= 5000);

-- 2. initial_slippage_bps — frozen copy of what the order was armed with.
-- Same upper bound as slippage_bps because the engine never writes a value
-- here that isn't a valid past slippage_bps.
ALTER TABLE limit_close_orders DROP CONSTRAINT IF EXISTS limit_close_orders_initial_slippage_in_range;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_initial_slippage_in_range
  CHECK (
    initial_slippage_bps IS NULL OR
    (initial_slippage_bps >= 10 AND initial_slippage_bps <= 2500)
  );

-- 3. max_slippage_bps_cap — the borrower's stated ceiling. Highest of the
-- three because the cap can be derived as slip * 8 (PR #77).
ALTER TABLE limit_close_orders DROP CONSTRAINT IF EXISTS limit_close_orders_max_slippage_cap_in_range;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_max_slippage_cap_in_range
  CHECK (
    max_slippage_bps_cap IS NULL OR
    (max_slippage_bps_cap >= 10 AND max_slippage_bps_cap <= 5000)
  );
