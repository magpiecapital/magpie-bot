-- migration 046: engine_canary_runs — periodic end-to-end engine validation.
--
-- Why this exists
-- The engine's boot-time preflight validates dependencies once. The
-- per-tick Jupiter probe validates the price oracle. But there's no
-- ongoing validation that the FULL fire path (price reads + Jupiter
-- quote sizing + cross-source agreement + borrower-balance math +
-- SL-solvency floor + program reachability) actually works end-to-
-- end against current market conditions.
--
-- This table receives one row per canary run. Engine writes; bot
-- watcher reads. Without it the operator only finds out the engine
-- is broken when a real fire fails — exactly the "find out from a
-- user" pattern the operator banned.
--
-- Each row captures the OUTCOME of one synthetic fire-path run:
-- which checks passed/failed, computed numbers, total duration. No
-- on-chain action is taken — this is pure read-side simulation.
--
-- Bot's canary-watcher polls this table and DMs the operator if
-- consecutive runs fail. Distinct from engine_heartbeats (liveness)
-- and engine_metrics_hourly (activity rollups) — canary is the
-- "would a fire succeed RIGHT NOW" signal.

CREATE TABLE IF NOT EXISTS engine_canary_runs (
  id                BIGSERIAL    PRIMARY KEY,
  run_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  service           TEXT         NOT NULL,
  overall_ok        BOOLEAN      NOT NULL,
  duration_ms       INTEGER      NOT NULL,
  -- Per-check results: name → { ok, detail, ms? }. JSONB so the
  -- check set can grow without schema changes.
  checks            JSONB        NOT NULL,
  -- Convenience top-level columns for the most-watched signals so
  -- the bot watcher can index them without JSON ops on every read.
  jupiter_ok        BOOLEAN,
  dexscreener_ok    BOOLEAN,
  cross_source_ok   BOOLEAN,
  program_ok        BOOLEAN,
  template_loan_id  BIGINT,
  notes             TEXT
);

-- Hot read pattern: latest run per service for the bot watcher.
CREATE INDEX IF NOT EXISTS engine_canary_runs_service_run_at_idx
  ON engine_canary_runs(service, run_at DESC);

COMMENT ON TABLE engine_canary_runs IS
  'Periodic end-to-end engine validation results. Engine writes
   one row per canary tick (default every hour). Bot reads to alert
   on consecutive failures. Distinct from engine_heartbeats
   (liveness) and engine_metrics_hourly (activity).';
