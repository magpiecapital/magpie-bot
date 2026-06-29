-- Distribution-wallet auto-funder audit ledger
--
-- Root cause this table supports (2026-06-28): borrow-fee revenue lands as
-- native SOL in the lender wallet (4JSSSa…), but the only native-SOL mover
-- (treasury-sweeper) is paused AND targets cold storage — so there was NO
-- automated route keeping the rewards-distribution wallet (CHCAM…) funded.
-- The operator had to hand-carry ~6 SOL/week. The distribution-auto-funder
-- closes that gap demand-driven: it tops the distribution wallet up to
-- (total owed across pools + reserve) by moving EXACTLY the gap from the
-- lender wallet's fee revenue, never overshooting and never draining the
-- operational reserve.
--
-- Every tick writes one row here regardless of outcome — investor-grade
-- "where did the money go and when" trail. This is the demand-driven
-- counterpart to treasury_sweeps (which moves true excess to cold storage).
--
-- Outcomes (one FUNDING-outcome row per tick; unwrap activity adds separate
-- unwrap_* rows with funded=0, so SUM(funded_lamports) is always exact):
--   success                — top-up tx confirmed on-chain (funded = amount moved)
--   broadcast_timeout      — broadcast ok but confirm timed out and status unknown;
--                            funded = 0. The next tick's gap (read from the live
--                            on-chain balance) self-corrects — no re-send risk.
--   skip_no_gap            — distribution wallet already >= payableOwed + reserve
--   skip_disabled          — DIST_FUNDER_DISABLED set / no lender key configured
--   skip_locked            — another tick held the advisory lock
--   skip_lender_low        — lender below operational reserve; cannot fully fund
--   skip_owed_implausible  — payableOwed above the sanity ceiling; NO movement + alert
--   sim_reject             — guard/allowlist/key-check rejected the tx; never broadcast
--   send_error             — RPC sendRawTransaction failed
--   unwrap_ok / unwrap_error — distribution-wallet wSOL → native unwrap activity

CREATE TABLE IF NOT EXISTS distribution_funding_events (
  id                        BIGSERIAL PRIMARY KEY,
  initiated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome                   TEXT        NOT NULL,
  -- notional owed across the three reward pools at decision time
  owed_lamports             NUMERIC     NOT NULL DEFAULT 0,
  holder_owed_lamports      NUMERIC     NOT NULL DEFAULT 0,
  lp_owed_lamports          NUMERIC     NOT NULL DEFAULT 0,
  protocol_owed_lamports    NUMERIC     NOT NULL DEFAULT 0,
  -- on-chain balances read this tick
  dist_native_before        NUMERIC     NOT NULL DEFAULT 0,
  dist_wsol_before          NUMERIC     NOT NULL DEFAULT 0,
  lender_native_before      NUMERIC     NOT NULL DEFAULT 0,
  -- the gap and the action taken
  reserve_lamports          NUMERIC     NOT NULL DEFAULT 0,
  gap_lamports              NUMERIC     NOT NULL DEFAULT 0,
  funded_lamports           NUMERIC     NOT NULL DEFAULT 0,
  destination_pubkey        TEXT        NOT NULL,
  tx_signature              TEXT,
  error_message             TEXT,
  confirmed_at              TIMESTAMPTZ,
  notes                     TEXT
);

CREATE INDEX IF NOT EXISTS idx_dist_funding_initiated_at
  ON distribution_funding_events (initiated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dist_funding_outcome_initiated
  ON distribution_funding_events (outcome, initiated_at DESC);
