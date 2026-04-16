-- Users: one row per Telegram user
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Custodial wallets: one keypair per user, AES-256-GCM encrypted
CREATE TABLE IF NOT EXISTS wallets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT UNIQUE NOT NULL,
  encrypted_secret BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wallets_public_key_idx ON wallets(public_key);

-- Loans: mirrors the on-chain Loan PDA for fast queries
CREATE TABLE IF NOT EXISTS loans (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loan_id NUMERIC(20,0) UNIQUE NOT NULL, -- on-chain u64
  loan_pda TEXT UNIQUE NOT NULL,
  collateral_mint TEXT NOT NULL,
  collateral_amount NUMERIC(40,0) NOT NULL,
  loan_amount_lamports NUMERIC(20,0) NOT NULL, -- SOL amount borrower received
  original_loan_amount_lamports NUMERIC(20,0) NOT NULL, -- pre-fee, what must be repaid
  ltv_percentage SMALLINT NOT NULL,
  duration_days SMALLINT NOT NULL,
  start_timestamp TIMESTAMPTZ NOT NULL,
  due_timestamp TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','repaid','liquidated')),
  tx_signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS loans_user_id_idx ON loans(user_id);
CREATE INDEX IF NOT EXISTS loans_status_idx ON loans(status);
CREATE INDEX IF NOT EXISTS loans_due_timestamp_idx ON loans(due_timestamp) WHERE status = 'active';

-- Supported collateral mints (whitelist)
CREATE TABLE IF NOT EXISTS supported_mints (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT,
  decimals SMALLINT NOT NULL,
  min_liquidity_usd NUMERIC(20,2) DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed common memecoin mints
INSERT INTO supported_mints (mint, symbol, name, decimals) VALUES
  ('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK', 'Bonk', 5),
  ('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF', 'dogwifhat', 6),
  ('HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', 'PYTH', 'Pyth', 6)
ON CONFLICT (mint) DO NOTHING;
