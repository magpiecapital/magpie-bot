-- migration 044: limit_close_orders.staleness_nudged_at
--
-- Tracks whether the staleness-watcher has already DMed a user about a
-- given order. NULL = never nudged; timestamp = nudged at that time.
--
-- Why a column on the order instead of a separate dedup table: a
-- staleness nudge is bound to ONE order lifetime — when the order is
-- cancelled or fired, the nudge state goes with it. A separate table
-- would need cascade-delete logic on those status transitions. Inline
-- column is the simpler shape for the same uniqueness guarantee.
--
-- Watcher runs every 6 hours and only re-nudges orders whose
-- staleness_nudged_at is NULL (i.e., never nudged) OR older than 30
-- days (operator override: very-stale orders that the user ignored
-- the first nudge on get one more reminder before /lc-perf surfaces
-- them as dead weight).

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS staleness_nudged_at TIMESTAMPTZ;

-- Index supports the watcher's hot-path query:
-- WHERE status='armed' AND armed_at < threshold AND staleness_nudged_at IS NULL
-- Partial index keeps it tiny; fired/cancelled rows are excluded.
CREATE INDEX IF NOT EXISTS limit_close_orders_staleness_nudge_idx
  ON limit_close_orders(armed_at)
  WHERE status = 'armed' AND staleness_nudged_at IS NULL;
