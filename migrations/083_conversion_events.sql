-- 083_conversion_events.sql
--
-- Conversion telemetry: one row per attempt at the four loan-conversion
-- paths (borrow / arm / fire / repay). Powers /conv-stats, the
-- self-monitor success-rate probe, and any future site/Pip surface.
--
-- Why a DB table instead of in-process counters:
--   - Survives bot restarts (Railway redeploys, OOM kills, etc).
--   - Lets /conv-stats answer 24h / 7d windows without keeping
--     all events in memory.
--   - Lets self-monitor share state with the engine (engine writes
--     fire-path rows; bot writes borrow/arm/repay; one table, one
--     query).
--   - Audit trail: if a conversion failed, we can trace WHICH user,
--     mint, version, and class months later.
--
-- Idempotent (IF NOT EXISTS everywhere) so re-running the migration
-- never throws. Forward-only — no drop.
CREATE TABLE IF NOT EXISTS conversion_events (
  id              BIGSERIAL PRIMARY KEY,
  path            TEXT NOT NULL CHECK (path IN ('borrow', 'arm', 'fire', 'repay')),
  outcome         TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  failure_class   TEXT,                     -- one of the classifier classes when outcome='failure'
  mint            TEXT,                     -- collateral mint
  program_id      TEXT,                     -- V1/V3/V4 program id
  wallet          TEXT,                     -- borrower wallet
  user_id         BIGINT,                   -- telegram user id when known (null for site/API)
  surface         TEXT,                     -- 'tg', 'site', 'pip', 'agent', 'engine'
  latency_ms      INT,                      -- end-to-end latency for the attempt
  detail          JSONB,                    -- arbitrary structured detail for forensics
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-path time-series queries.
CREATE INDEX IF NOT EXISTS conversion_events_path_at_idx
  ON conversion_events (path, created_at DESC);

-- Per-mint time-series — drives /conv-stats per-mint breakdown.
CREATE INDEX IF NOT EXISTS conversion_events_mint_at_idx
  ON conversion_events (mint, created_at DESC)
  WHERE mint IS NOT NULL;

-- Failure-class queries (rare but useful when investigating a spike).
CREATE INDEX IF NOT EXISTS conversion_events_failure_class_at_idx
  ON conversion_events (failure_class, created_at DESC)
  WHERE failure_class IS NOT NULL;

-- Per-version queries — let probe identify V3-vs-V4 conversion gaps.
CREATE INDEX IF NOT EXISTS conversion_events_program_at_idx
  ON conversion_events (program_id, created_at DESC)
  WHERE program_id IS NOT NULL;
