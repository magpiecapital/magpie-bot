-- migration 058: neon_quota_history — hourly Neon usage probe samples.
--
-- Why this table exists
-- ─────────────────────
-- 2026-06-14 outage: Neon's compute-hours quota was exhausted with
-- ZERO advance warning. Every DB query started returning XX000
-- "exceeded the compute time quota", bot crash-looped for ~30 min.
-- See [[project_magpie_outage_2026_06_14_neon_quota]].
--
-- The fix is to hit Neon's HTTP API on a 1-hour tick, record
-- compute-hours-used + storage-bytes-used + the plan's allowed
-- ceilings, and alert the operator when usage crosses 70% of either
-- so we get a 24h+ heads-up before the cliff. Per-hour rows let the
-- operator (and /lc-perf) chart trend velocity — "we're at 65% and
-- climbed 8pp in the last 6h" is a different conversation than
-- "we're at 65% and have been flat for a week."
--
-- Storage shape
-- ─────────────
-- One row per hour bucket, primary keyed by `hour` so the watcher's
-- UPSERT is race-free if two probes ever land in the same hour.
-- All allowance / used fields are nullable — Neon's API returns
-- different shapes between plans (Free vs Scale vs Business), and a
-- missing field should record "we asked but didn't get this" rather
-- than crash the probe.

CREATE TABLE IF NOT EXISTS neon_quota_history (
  hour                          TIMESTAMPTZ NOT NULL PRIMARY KEY,

  -- Compute hours (Neon's primary plan limit on Free/Launch/Scale).
  -- compute_hours_used is the current monthly consumption value at the
  -- moment we probed. compute_hours_allowed is the plan's monthly
  -- ceiling (NULL on Business pay-as-you-go).
  compute_hours_used            NUMERIC(12, 4),
  compute_hours_allowed         NUMERIC(12, 4),
  compute_pct                   NUMERIC(6, 2),

  -- Storage in bytes (Neon's secondary limit). data_transfer_used /
  -- data_transfer_allowed are also captured when the API exposes them.
  storage_bytes_used            BIGINT,
  storage_bytes_allowed         BIGINT,
  storage_pct                   NUMERIC(6, 2),

  data_transfer_bytes_used      BIGINT,
  data_transfer_bytes_allowed   BIGINT,

  -- The plan slug as Neon reports it ("free", "launch", "scale",
  -- "business"). Stored alongside the snapshot so the operator can
  -- see when a plan upgrade actually took effect.
  plan                          TEXT,

  -- True if THIS sample crossed >= 70% on either compute or storage
  -- AND the previous sample was below. Used to make sure we only
  -- alert on the rising edge, not every hour while sitting at 75%.
  alerted                       BOOLEAN NOT NULL DEFAULT FALSE,

  -- Raw JSON returned from the Neon API for the probe, sans secrets.
  -- Lets us re-derive fields later if we change our minds about which
  -- subset to store. Capped at 10 KB so a future verbose Neon
  -- response can't bloat the table.
  raw_response                  JSONB,

  probed_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS neon_quota_history_hour_desc_idx
  ON neon_quota_history(hour DESC);

COMMENT ON TABLE neon_quota_history IS
  'Hourly Neon API usage samples — compute hours + storage. Watcher
   alerts operator when usage crosses 70% so we never hit the
   quota-exceeded cliff again (2026-06-14 outage). Rising-edge
   alert pattern (one DM per crossing, not one per hour at 75%+).';
