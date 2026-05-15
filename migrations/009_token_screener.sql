-- Token screener metadata
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'memecoin';
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS liquidity_usd NUMERIC(20,2) DEFAULT 0;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS holder_count INTEGER DEFAULT 0;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS market_cap_usd NUMERIC(20,2) DEFAULT 0;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS has_mint_authority BOOLEAN DEFAULT FALSE;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS has_freeze_authority BOOLEAN DEFAULT FALSE;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS lp_burned BOOLEAN DEFAULT FALSE;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS top10_holder_pct NUMERIC(5,2) DEFAULT 0;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS token_age_hours INTEGER DEFAULT 0;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS auto_approved BOOLEAN DEFAULT FALSE;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS screened_at TIMESTAMPTZ;
ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- Screening queue for tokens that need manual review
CREATE TABLE IF NOT EXISTS token_screen_queue (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT,
  decimals SMALLINT NOT NULL,
  category TEXT DEFAULT 'memecoin',
  image_url TEXT,
  liquidity_usd NUMERIC(20,2) DEFAULT 0,
  volume_24h_usd NUMERIC(20,2) DEFAULT 0,
  market_cap_usd NUMERIC(20,2) DEFAULT 0,
  holder_count INTEGER DEFAULT 0,
  has_mint_authority BOOLEAN DEFAULT FALSE,
  has_freeze_authority BOOLEAN DEFAULT FALSE,
  lp_burned BOOLEAN DEFAULT FALSE,
  top10_holder_pct NUMERIC(5,2) DEFAULT 0,
  token_age_hours INTEGER DEFAULT 0,
  safety_score INTEGER DEFAULT 0,
  fail_reasons TEXT[],
  status TEXT DEFAULT 'pending',  -- pending, approved, rejected
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Track mints we've already seen so we don't re-screen
CREATE TABLE IF NOT EXISTS token_screen_seen (
  mint TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
