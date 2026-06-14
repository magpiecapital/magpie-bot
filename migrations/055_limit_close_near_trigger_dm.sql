-- migration 055: near-trigger DM tracking on limit_close_orders.
--
-- Pairs with src/services/limit-close-near-trigger-watcher.js. The
-- watcher sweeps armed orders every 5 min, computes distance to
-- trigger, and DMs the user a one-time heads-up when current price
-- is within NEAR_TRIGGER_PCT (default 10%) of the trigger.
--
-- One-time gate: `near_trigger_dm_sent_at IS NULL`. Set BEFORE
-- enqueueing the DM so a duplicate watcher tick on a slow cycle
-- can't double-send. Reset to NULL whenever the user modifies the
-- trigger via /modify (TG), site modify, or x402 agent — a fresh
-- trigger deserves a fresh nudge if the new value lands in the near
-- band.
--
-- Why this is separate from staleness_nudged_at: staleness is "you
-- forgot you set this, want to clean up?" — once per 30 days, gentle.
-- Near-trigger is "this is about to fire, glance and adjust if
-- needed" — once per arm, time-sensitive. Different cadences, different
-- audiences (staleness targets long-armed forgotten orders; near-
-- trigger targets active orders with imminent action).

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS near_trigger_dm_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN limit_close_orders.near_trigger_dm_sent_at IS
  'When the bot sent the one-time near-trigger DM for this order
   (within ~10% of firing). NULL = never sent for this arm. Reset to
   NULL on modify so a re-tuned trigger gets a fresh nudge.
   See src/services/limit-close-near-trigger-watcher.js.';

-- Hot-path read pattern for the watcher:
--   WHERE status = 'armed'
--     AND near_trigger_dm_sent_at IS NULL
--     AND trigger_kind IN ('price_usd', 'mc_usd')
-- Partial index covers the unsent set tightly without overhead on
-- the much-larger fired/cancelled subset.
CREATE INDEX IF NOT EXISTS limit_close_orders_unsent_near_trigger_idx
  ON limit_close_orders(armed_at DESC)
  WHERE status = 'armed' AND near_trigger_dm_sent_at IS NULL;
