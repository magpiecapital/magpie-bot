-- migration 057: trailing stop support on limit_close_orders.
--
-- "Trailing stop" is the standard trading primitive — the stop-loss
-- trigger isn't a fixed price, it's a percentage distance below a
-- moving "peak" price. As price climbs, the peak rises and the
-- effective trigger rises with it; if price retraces by more than
-- the trailing distance from the peak, the order fires. Classic
-- "let profits run, cap drawdowns" tool.
--
-- Trailing applies ONLY to stop-loss orders (trigger_direction =
-- 'below'). Take-profit is always a fixed target — its whole point
-- is "fire when price hits this level," which is incompatible with
-- a trailing semantic. arm-core enforces this; the column-level
-- constraint here is a hard backstop.
--
-- Two columns:
--   trailing_distance_bps  : non-null when this is a trailing SL.
--                            Distance from peak below which the
--                            order fires. 1000 = 10%, 500 = 5%, etc.
--                            Bounded 50..5000 bps (0.5%..50%) — at
--                            the tighter end, normal price noise
--                            would fire the order immediately; at
--                            the looser end you might as well use
--                            a fixed SL. arm-core enforces.
--   peak_price_micros      : highest price observed since the
--                            order was armed. Initialized at arm
--                            time to the current cross-sourced
--                            price (so the first tick doesn't reset
--                            to whatever volatility put us at).
--                            Updated each watcher tick where the
--                            current price exceeds the stored peak.
--
-- Effective trigger formula at each watcher tick:
--   effective_trigger_micros = peak_price_micros × (10000 - trailing_distance_bps) / 10000
-- Fire when current_price_micros <= effective_trigger_micros.
--
-- Migration is non-destructive: existing orders stay non-trailing
-- (both columns NULL). The watcher path checks
-- trailing_distance_bps IS NOT NULL before applying trailing logic,
-- so every existing armed SL keeps its fixed-trigger behavior.

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS trailing_distance_bps SMALLINT,
  ADD COLUMN IF NOT EXISTS peak_price_micros NUMERIC(40, 0);

-- Sanity ranges. NULL is allowed (means "not trailing"); when set,
-- bps must be in the operator-tuned range.
ALTER TABLE limit_close_orders
  DROP CONSTRAINT IF EXISTS limit_close_orders_trailing_distance_range_check;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_trailing_distance_range_check
  CHECK (
    trailing_distance_bps IS NULL
    OR (trailing_distance_bps >= 50 AND trailing_distance_bps <= 5000)
  );

-- Trailing only makes sense for stop-loss. Take-profit's whole
-- point is firing at a fixed target, which is incompatible with
-- the trailing semantic.
ALTER TABLE limit_close_orders
  DROP CONSTRAINT IF EXISTS limit_close_orders_trailing_direction_check;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_trailing_direction_check
  CHECK (
    trailing_distance_bps IS NULL
    OR COALESCE(trigger_direction, 'above') = 'below'
  );

-- Peak must be NULL exactly when trailing is NULL; if trailing
-- is set, the watcher seeds peak at arm time, so post-arm rows
-- always have it.
ALTER TABLE limit_close_orders
  DROP CONSTRAINT IF EXISTS limit_close_orders_trailing_peak_paired_check;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_trailing_peak_paired_check
  CHECK (
    (trailing_distance_bps IS NULL AND peak_price_micros IS NULL)
    OR (trailing_distance_bps IS NOT NULL AND peak_price_micros IS NOT NULL)
  );

COMMENT ON COLUMN limit_close_orders.trailing_distance_bps IS
  'Trailing stop distance in basis points (50-5000). NULL = fixed-trigger SL.
   Effective trigger = peak_price_micros * (10000 - trailing_distance_bps) / 10000.
   Trailing applies only to trigger_direction=below (stop-loss).';

COMMENT ON COLUMN limit_close_orders.peak_price_micros IS
  'Highest price observed since arm, in trigger_kind units (price_usd or mc_usd).
   Updated by the watcher when current > peak. NULL when not trailing.';

-- Hot-path filter for the watcher: armed trailing orders only,
-- ordered by armed_at so older trailing orders evaluate first.
CREATE INDEX IF NOT EXISTS limit_close_orders_armed_trailing_idx
  ON limit_close_orders(armed_at DESC)
  WHERE status = 'armed' AND trailing_distance_bps IS NOT NULL;
