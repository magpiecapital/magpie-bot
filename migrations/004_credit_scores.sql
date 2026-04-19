-- ============================================================================
-- 004: On-chain Credit Score Protocol
--
-- Tracks granular loan events, computes weighted credit scores (300-850),
-- and stores snapshots for composable querying by external protocols.
-- ============================================================================

-- Individual loan events that feed into score calculation
CREATE TABLE IF NOT EXISTS credit_events (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  loan_id       BIGINT REFERENCES loans(id),
  event_type    TEXT NOT NULL,
    -- repay_ontime, repay_early, repay_late, partial_repay, extend,
    -- topup, liquidated, borrow, collateral_diversity
  score_delta   INT NOT NULL DEFAULT 0,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_events_user ON credit_events(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_events_type ON credit_events(event_type);

-- Materialized credit scores — recomputed after each credit event
CREATE TABLE IF NOT EXISTS credit_scores (
  user_id             BIGINT PRIMARY KEY REFERENCES users(id),
  score               INT NOT NULL DEFAULT 300 CHECK (score >= 300 AND score <= 850),
  tier                TEXT NOT NULL DEFAULT 'bronze',
    -- bronze (300-499), silver (500-649), gold (650-749), platinum (750-850)

  -- Factor breakdown (0-100 each, weighted in application)
  f_repayment_history NUMERIC(5,2) NOT NULL DEFAULT 0,
  f_loan_volume       NUMERIC(5,2) NOT NULL DEFAULT 0,
  f_account_age       NUMERIC(5,2) NOT NULL DEFAULT 0,
  f_collateral_diversity NUMERIC(5,2) NOT NULL DEFAULT 0,
  f_liquidation_ratio NUMERIC(5,2) NOT NULL DEFAULT 0,
  f_protocol_engagement NUMERIC(5,2) NOT NULL DEFAULT 0,

  -- Tier benefits (computed from score)
  max_ltv             NUMERIC(5,2) NOT NULL DEFAULT 30,
  fee_rate            NUMERIC(5,4) NOT NULL DEFAULT 0.015,
  max_duration_days   INT NOT NULL DEFAULT 7,

  -- Tracking
  loans_scored        INT NOT NULL DEFAULT 0,
  last_event_id       BIGINT REFERENCES credit_events(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Historical score snapshots for trend analysis & composable reads
CREATE TABLE IF NOT EXISTS credit_score_history (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  score       INT NOT NULL,
  tier        TEXT NOT NULL,
  event_id    BIGINT REFERENCES credit_events(id),
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_history_user ON credit_score_history(user_id);

-- API keys for external protocol integrations
CREATE TABLE IF NOT EXISTS credit_api_keys (
  id              BIGSERIAL PRIMARY KEY,
  protocol_name   TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL UNIQUE,  -- SHA-256 of the key (never store plaintext)
  permissions     TEXT[] NOT NULL DEFAULT '{read_score}',
  rate_limit_rpm  INT NOT NULL DEFAULT 60,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
