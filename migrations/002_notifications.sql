-- Track last-seen balances per (user, mint) so we can detect new deposits.
-- SOL uses the sentinel mint 'SOL'. Raw amounts are stored as-is (with decimals).
CREATE TABLE IF NOT EXISTS wallet_balances (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mint TEXT NOT NULL,
  raw_amount NUMERIC(40,0) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, mint)
);

-- Flag columns so we don't warn the same user multiple times about the same loan.
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS warned_24h_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS liquidated_notified_at TIMESTAMPTZ;
