-- migration 045: engine_metrics_hourly — per-tick engine activity rollups.
--
-- engine_heartbeats answers "is the engine alive right now?" and is
-- a single-row (id=1) liveness signal. That doesn't tell the operator
-- "how busy was the engine this week", "how often did Jupiter fail",
-- or "how many fires were attempted vs succeeded".
--
-- This table is the historical view. Engine UPSERTs the row for the
-- current hour bucket on every tick, accumulating counters. /lc-perf
-- reads this for the "Engine activity (last 7d)" section.
--
-- Why hourly buckets (not per-tick rows): a 30s poll generates 2880
-- rows/day per service. That's 86k rows/month per service. Hourly
-- rollups are 24 rows/day = 720/month — three orders of magnitude
-- smaller storage for the same operator-facing question. Sub-hourly
-- granularity isn't useful for the kinds of questions /lc-perf
-- answers (success rate over a window, average activity per day).
--
-- Counters are CUMULATIVE within the hour: the engine reads the
-- existing row, adds its tick's delta, and UPSERTs back. RACE-FREE
-- via the same atomic UPSERT pattern engine_heartbeats uses — single
-- engine process per service today; if we ever scale horizontally,
-- switch to `INSERT … ON CONFLICT (hour, service) DO UPDATE SET col =
-- col + EXCLUDED.col` so two concurrent ticks accumulate safely.

CREATE TABLE IF NOT EXISTS engine_metrics_hourly (
  hour                     TIMESTAMPTZ NOT NULL,
  service                  TEXT        NOT NULL,
  ticks                    INTEGER     NOT NULL DEFAULT 0,
  jupiter_probes_ok        INTEGER     NOT NULL DEFAULT 0,
  jupiter_probes_failed    INTEGER     NOT NULL DEFAULT 0,
  armed_orders_evaluated   INTEGER     NOT NULL DEFAULT 0,
  fires_attempted          INTEGER     NOT NULL DEFAULT 0,
  fires_succeeded          INTEGER     NOT NULL DEFAULT 0,
  fires_failed             INTEGER     NOT NULL DEFAULT 0,
  fires_reverted           INTEGER     NOT NULL DEFAULT 0,
  errors                   INTEGER     NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hour, service)
);

-- Hot-path read pattern for /lc-perf:
--   SELECT ... FROM engine_metrics_hourly
--    WHERE service = 'limit_close_watcher' AND hour > NOW() - INTERVAL '...'
--    ORDER BY hour DESC
-- The PK covers (hour, service) but the operator's filter starts with
-- service. This index supports the desired access pattern.
CREATE INDEX IF NOT EXISTS engine_metrics_hourly_service_hour_idx
  ON engine_metrics_hourly(service, hour DESC);

COMMENT ON TABLE engine_metrics_hourly IS
  'Per-hour activity rollups for external engines (e.g.
   limit_close_watcher). Engine UPSERTs the current hour bucket each
   tick, accumulating counters. Read by /lc-perf for historical
   activity. Hourly granularity caps row count; sub-hourly noise
   isn''t useful at this surface.';
