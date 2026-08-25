-- The Hoard Phase 1 (SHADOW ONLY — no allocation changes): per-wallet holding
-- streaks derived from snapshot history. Rebuildable at any time by replay;
-- never a source of truth for payouts until HOARD_WEIGHTING_ENABLED ships
-- (Phase 3, operator-gated). Spec: github.com/magpiecapital/hoard SPEC v0.1.
CREATE TABLE IF NOT EXISTS hoard_streaks (
  wallet_address TEXT PRIMARY KEY,
  anchor_snapshot_id BIGINT NOT NULL,
  anchor_at TIMESTAMPTZ NOT NULL,
  last_balance NUMERIC NOT NULL,
  streak_days INTEGER NOT NULL DEFAULT 0,
  multiplier_bps INTEGER NOT NULL DEFAULT 10000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hoard_streaks_mult ON hoard_streaks (multiplier_bps);
