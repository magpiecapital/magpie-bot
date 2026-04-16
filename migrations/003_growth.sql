-- Per-user preferences: which notifications to send, whether to auto-repay.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_deposits BOOLEAN NOT NULL DEFAULT TRUE,
  notify_loan_warnings BOOLEAN NOT NULL DEFAULT TRUE,
  notify_liquidations BOOLEAN NOT NULL DEFAULT TRUE,
  notify_health BOOLEAN NOT NULL DEFAULT TRUE,
  auto_repay BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lifetime reputation counters. Used to compute the user's tier
-- (NEW / SILVER / GOLD / PLATINUM).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS repaid_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS liquidated_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_borrowed_lamports NUMERIC(30,0) NOT NULL DEFAULT 0;

-- Referral system.
CREATE TABLE IF NOT EXISTS referral_codes (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referred_by BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ;

-- Track the lowest health-ratio bucket already alerted on, so we don't spam
-- the same warning every poll. Nullable = no alerts sent yet.
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS last_health_alert NUMERIC(4,2);
