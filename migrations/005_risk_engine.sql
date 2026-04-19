-- ============================================================================
-- 005: AI Risk Engine
--
-- Stores token risk profiles, historical snapshots, and dynamic LTV overrides.
-- The risk engine continuously scores tokens on volatility, liquidity depth,
-- holder concentration, volume patterns, and rug-pull signals.
-- ============================================================================

-- Per-token risk profile (refreshed by risk engine on interval)
CREATE TABLE IF NOT EXISTS token_risk_profiles (
  mint                TEXT PRIMARY KEY,
  symbol              TEXT,

  -- Risk scores (0-100, higher = riskier)
  risk_score          NUMERIC(5,2) NOT NULL DEFAULT 50,
  volatility_score    NUMERIC(5,2) NOT NULL DEFAULT 50,
  liquidity_score     NUMERIC(5,2) NOT NULL DEFAULT 50,
  concentration_score NUMERIC(5,2) NOT NULL DEFAULT 50,
  volume_score        NUMERIC(5,2) NOT NULL DEFAULT 50,
  rug_pull_score      NUMERIC(5,2) NOT NULL DEFAULT 50,

  -- Raw metrics backing the scores
  volatility_24h      NUMERIC(10,4),   -- std deviation of hourly returns
  volatility_7d       NUMERIC(10,4),
  liquidity_usd       NUMERIC(20,2),
  liquidity_ratio     NUMERIC(10,6),   -- liquidity / market_cap
  top10_holder_pct    NUMERIC(5,2),    -- % held by top 10 wallets
  volume_24h_usd      NUMERIC(20,2),
  volume_consistency  NUMERIC(5,2),    -- coefficient of variation (7d hourly)
  market_cap_usd      NUMERIC(20,2),
  holder_count        INT,

  -- Rug-pull detection signals
  dev_wallet_pct      NUMERIC(5,2),    -- dev team holding %
  locked_liquidity    BOOLEAN DEFAULT false,
  contract_renounced  BOOLEAN DEFAULT false,
  mint_authority_disabled BOOLEAN DEFAULT false,

  -- Dynamic LTV adjustment based on risk
  ltv_modifier        NUMERIC(5,2) NOT NULL DEFAULT 0,  -- +/- percentage points
  max_allowed_ltv     NUMERIC(5,2) NOT NULL DEFAULT 30,

  -- Flags
  flagged             BOOLEAN NOT NULL DEFAULT false,
  flag_reason         TEXT,

  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Historical risk snapshots for trend analysis
CREATE TABLE IF NOT EXISTS token_risk_history (
  id              BIGSERIAL PRIMARY KEY,
  mint            TEXT NOT NULL,
  risk_score      NUMERIC(5,2) NOT NULL,
  volatility_24h  NUMERIC(10,4),
  liquidity_usd   NUMERIC(20,2),
  volume_24h_usd  NUMERIC(20,2),
  market_cap_usd  NUMERIC(20,2),
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_risk_history_mint ON token_risk_history(mint);
CREATE INDEX IF NOT EXISTS idx_risk_history_time ON token_risk_history(snapshot_at);

-- Predictive liquidation signals
CREATE TABLE IF NOT EXISTS liquidation_signals (
  id              BIGSERIAL PRIMARY KEY,
  loan_id         BIGINT NOT NULL REFERENCES loans(id),
  user_id         BIGINT NOT NULL REFERENCES users(id),
  signal_type     TEXT NOT NULL,
    -- price_decline, volatility_spike, liquidity_drain, rug_detected, expiry_risk
  severity        TEXT NOT NULL DEFAULT 'medium',
    -- low, medium, high, critical
  health_ratio    NUMERIC(8,4),
  predicted_health NUMERIC(8,4),     -- where we think it will be in 1h
  metadata        JSONB DEFAULT '{}',
  acted_on        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_liq_signals_loan ON liquidation_signals(loan_id);
CREATE INDEX IF NOT EXISTS idx_liq_signals_severity ON liquidation_signals(severity);
