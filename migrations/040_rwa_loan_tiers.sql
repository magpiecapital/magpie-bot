-- migration 040: differentiated loan tiers for RWA collateral
-- (tokenized stocks, ETFs, metals).
--
-- Until now every borrow — memecoin or stock — used the same hard-
-- coded LTV_TIERS in src/commands/borrow.js (and a few other callsites):
--
--   Express : 30% LTV · 2d  · 3.0% fee
--   Quick   : 25% LTV · 3d  · 2.0% fee
--   Standard: 20% LTV · 7d  · 1.5% fee
--
-- That's conservative for a token whose collateral can move 30% in
-- an hour. For SPYx / QQQx / NVDAx / TSLAx (Backpack xStocks) the
-- intraday vol is 1–3% and the holder profile is closer to traditional
-- investors than memecoin traders. The protocol can safely offer
-- significantly higher LTVs, longer terms, and a higher fee — leaving
-- value on the table both for the borrower (more SOL out per $1 of
-- collateral, longer to repay) and for the protocol (higher fee that
-- flows to 4JSSSaG3 via the existing 70-10-10-10 split).
--
-- Operator-proposed initial numbers (TUNE BEFORE MERGE if these don't
-- match what you want):
--
--   RWA Express : 50% LTV · 7d  · 2.5% fee
--   RWA Quick   : 60% LTV · 15d · 3.5% fee
--   RWA Standard: 70% LTV · 30d · 5.0% fee
--
-- Fee semantics: same as memecoin — origination fee is deducted up
-- front from the loan proceeds, accrued by recordLoan(), and routed
-- through the 70-10-10-10 split via accrueFromLoan +
-- accrueToHolderPool + accrueToLpLoyaltyPool. Protocol slice lands
-- in the 4JSSSaG3 wallet.
--
-- Safety guards that ride alongside the higher LTV:
--   * per-mint aggregate cap stays enforced via premium_tier_whitelist
--     (operator-set, 25–50 SOL per mint today)
--   * fee schedule is per-tier (option), NOT per-mint; the operator
--     can promote/demote individual mints by adjusting their
--     premium_tier_whitelist cap rather than per-mint LTV
--   * the resolver in src/services/loan-tier-resolver.js picks the
--     RWA set when category ∈ {stock, etf, metal}, falls back to the
--     memecoin set otherwise — so the existing memecoin path is
--     untouched
--
-- The on-chain V2 program does NOT enforce LTV on chain; the bot's
-- src/api/cosign-borrow.js computes loan_amount = collateral_value *
-- LTV / 100 and the program just accepts it as long as authority co-signs.
-- That means this migration alone is enough to ship higher LTVs — no
-- on-chain redeploy needed.

CREATE TABLE IF NOT EXISTS rwa_loan_tiers (
  option            INTEGER     PRIMARY KEY,
  ltv_pct           INTEGER     NOT NULL CHECK (ltv_pct > 0 AND ltv_pct <= 90),
  duration_days     INTEGER     NOT NULL CHECK (duration_days > 0 AND duration_days <= 90),
  fee_bps           INTEGER     NOT NULL CHECK (fee_bps >= 0 AND fee_bps <= 1000),
  label             TEXT        NOT NULL,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  notes             TEXT
);

INSERT INTO rwa_loan_tiers (option, ltv_pct, duration_days, fee_bps, label, notes)
VALUES
  (0, 50, 7,  250, 'RWA Express',  'short-term cash, conservative LTV buffer'),
  (1, 60, 15, 350, 'RWA Quick',    'NEW — 15-day term for tokenized stocks'),
  (2, 70, 30, 500, 'RWA Standard', 'NEW — 30-day term, premium fee, highest LTV for RWA-only')
ON CONFLICT (option) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_rwa_loan_tiers_enabled
  ON rwa_loan_tiers(enabled, option);

COMMENT ON TABLE rwa_loan_tiers IS
  'Loan tier schedule for RWA collateral (stock/etf/metal). Resolved
   via src/services/loan-tier-resolver.js based on supported_mints.category.
   Memecoin path keeps hardcoded LTV_TIERS unchanged. Operator-tunable
   per row — adjust ltv_pct / duration_days / fee_bps without code change.';
