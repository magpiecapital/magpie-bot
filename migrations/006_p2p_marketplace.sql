-- ============================================================================
-- 006: Peer-to-Peer Lending Marketplace with Tranching
--
-- Two-sided marketplace: lenders deposit into risk tranches (senior/junior),
-- borrowers get matched with available liquidity at competitive rates.
-- ============================================================================

-- Lending pools created by lenders
CREATE TABLE IF NOT EXISTS lending_pools (
  id              BIGSERIAL PRIMARY KEY,
  owner_id        BIGINT NOT NULL REFERENCES users(id),
  name            TEXT,

  -- Tranche type
  tranche         TEXT NOT NULL DEFAULT 'senior',
    -- senior: lower yield, protected from first losses
    -- junior: higher yield, absorbs losses first
    -- mezzanine: middle risk/reward

  -- Pool parameters
  total_deposited_lamports  NUMERIC NOT NULL DEFAULT 0,
  available_lamports        NUMERIC NOT NULL DEFAULT 0,
  locked_lamports           NUMERIC NOT NULL DEFAULT 0,
  earned_yield_lamports     NUMERIC NOT NULL DEFAULT 0,

  -- Yield settings
  min_apy_bps       INT NOT NULL DEFAULT 500,   -- 5% minimum APY (in basis points)
  max_apy_bps       INT NOT NULL DEFAULT 3000,  -- 30% max APY

  -- Risk preferences
  min_credit_score  INT NOT NULL DEFAULT 300,
  accepted_mints    TEXT[] DEFAULT '{}',  -- empty = accept all supported
  max_ltv           INT NOT NULL DEFAULT 30,
  max_duration_days INT NOT NULL DEFAULT 7,

  -- State
  status            TEXT NOT NULL DEFAULT 'active',
    -- active, paused, closed
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pools_owner ON lending_pools(owner_id);
CREATE INDEX IF NOT EXISTS idx_pools_tranche ON lending_pools(tranche);
CREATE INDEX IF NOT EXISTS idx_pools_status ON lending_pools(status);

-- Deposits into lending pools
CREATE TABLE IF NOT EXISTS pool_deposits (
  id              BIGSERIAL PRIMARY KEY,
  pool_id         BIGINT NOT NULL REFERENCES lending_pools(id),
  user_id         BIGINT NOT NULL REFERENCES users(id),
  amount_lamports NUMERIC NOT NULL,
  tx_signature    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Withdrawals from lending pools
CREATE TABLE IF NOT EXISTS pool_withdrawals (
  id              BIGSERIAL PRIMARY KEY,
  pool_id         BIGINT NOT NULL REFERENCES lending_pools(id),
  user_id         BIGINT NOT NULL REFERENCES users(id),
  amount_lamports NUMERIC NOT NULL,
  yield_lamports  NUMERIC NOT NULL DEFAULT 0,
  tx_signature    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- P2P loan offers (borrower requests matched to pools)
CREATE TABLE IF NOT EXISTS p2p_loan_offers (
  id              BIGSERIAL PRIMARY KEY,
  borrower_id     BIGINT NOT NULL REFERENCES users(id),
  pool_id         BIGINT REFERENCES lending_pools(id),

  -- Loan terms
  collateral_mint TEXT NOT NULL,
  collateral_amount NUMERIC NOT NULL,
  requested_sol   NUMERIC NOT NULL,
  offered_apy_bps INT NOT NULL,
  duration_days   INT NOT NULL,
  ltv_percentage  INT NOT NULL,

  -- Credit check at time of offer
  borrower_credit_score INT,
  token_risk_score NUMERIC(5,2),

  -- Status
  status          TEXT NOT NULL DEFAULT 'pending',
    -- pending, matched, funded, active, repaid, liquidated, expired, cancelled
  matched_at      TIMESTAMPTZ,
  funded_at       TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,

  -- On-chain references
  loan_pda        TEXT,
  tx_signature    TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_offers_borrower ON p2p_loan_offers(borrower_id);
CREATE INDEX IF NOT EXISTS idx_offers_pool ON p2p_loan_offers(pool_id);
CREATE INDEX IF NOT EXISTS idx_offers_status ON p2p_loan_offers(status);

-- Yield distribution records
CREATE TABLE IF NOT EXISTS yield_distributions (
  id              BIGSERIAL PRIMARY KEY,
  pool_id         BIGINT NOT NULL REFERENCES lending_pools(id),
  loan_offer_id   BIGINT REFERENCES p2p_loan_offers(id),
  amount_lamports NUMERIC NOT NULL,
  source          TEXT NOT NULL,
    -- origination_fee, interest, liquidation_recovery
  distributed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Marketplace aggregate stats (materialized, refreshed periodically)
CREATE TABLE IF NOT EXISTS marketplace_stats (
  id                  SERIAL PRIMARY KEY,
  total_pools         INT NOT NULL DEFAULT 0,
  total_tvl_lamports  NUMERIC NOT NULL DEFAULT 0,
  total_loans_matched INT NOT NULL DEFAULT 0,
  avg_apy_bps         INT NOT NULL DEFAULT 0,
  senior_tvl_lamports NUMERIC NOT NULL DEFAULT 0,
  junior_tvl_lamports NUMERIC NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO marketplace_stats DEFAULT VALUES;
