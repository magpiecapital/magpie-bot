-- migration 053: track RWA take-profit weekend-fire skips per hour.
--
-- Engine PR #18 (magpie-limitclose feat/rwa-tp-weekend-fire-skip)
-- added a fire-time gate: when a stock/etf/metal collateral order
-- with trigger_direction='above' (TP) hits its trigger DURING the
-- premium-tier weekend cutoff window, the engine skips firing this
-- tick and leaves the order armed for next-tick re-eval. The order
-- effectively waits for Monday RTH when Jupiter routes for the
-- underlying stock token thicken up again.
--
-- The skip count was only logged + accumulated in a per-tick metrics
-- accumulator. Without persisting it, /lc-perf can't show "how
-- many RWA TPs paused this weekend" across history — which is the
-- operator-facing answer to "is the weekend gate doing anything?".
--
-- This migration adds a column that the engine's writeMetricsRollup
-- now UPSERTs. Default 0 so older rows are sane; the rollup += new
-- column on conflict keeps the additive math correct.

ALTER TABLE engine_metrics_hourly
  ADD COLUMN IF NOT EXISTS rwa_tp_weekend_skipped integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN engine_metrics_hourly.rwa_tp_weekend_skipped IS
  'Count of RWA take-profit orders whose trigger hit during the
   premium-tier weekend cutoff window and were intentionally not
   fired this tick. Populated by the engine watcher when category
   is stock/etf/metal AND trigger_direction is above AND
   isInWeekendCutoff() is true. Order stays armed; next tick after
   the window closes re-evaluates and fires normally.';
