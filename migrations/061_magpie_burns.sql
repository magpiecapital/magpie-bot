-- migration 061: magpie_burns — protocol-level ledger of $MAGPIE burned.
--
-- WHY THIS EXISTS
-- ───────────────
-- Per the 2026-06-14 defaulted-loan policy, when a $MAGPIE-collateralized
-- loan defaults, the seized $MAGPIE is burned by the operator (not sold
-- and redistributed like other tokens). The protocol commits to publish
-- a running total of $MAGPIE burned across all paths so holders can see
-- the supply contraction. This ledger is the single source of truth
-- for that figure.
--
-- Sources of burns:
--   - 'manual'              — operator burns conducted outside default flows.
--                             Includes the 2,000,000 dev-wallet baseline burn.
--   - 'liquidation_default' — $MAGPIE seized as collateral on a defaulted
--                             loan, then burned. Linked back to the loans row.
--   - 'buyback'             — future protocol-funded buyback-and-burn.
--
-- IDEMPOTENCY
-- ───────────
--   - burn_tx_sig UNIQUE on on-chain entries (operator can re-run a
--     confirmation command safely)
--   - The seed row uses a WHERE NOT EXISTS guard keyed on the notes
--     prefix, so re-running the migration is a no-op.

CREATE TABLE IF NOT EXISTS magpie_burns (
  id              BIGSERIAL PRIMARY KEY,
  -- Raw $MAGPIE units (Token-2022, 6 decimals — 1 token = 1_000_000 raw).
  amount_raw      NUMERIC(40, 0) NOT NULL CHECK (amount_raw > 0),
  source          TEXT NOT NULL CHECK (source IN ('manual', 'liquidation_default', 'buyback')),
  -- Only set for 'liquidation_default' rows.
  related_loan_id BIGINT REFERENCES loans(id),
  -- On-chain burn signature. NULL allowed for pre-ledger baseline rows
  -- where the tx_sig wasn't captured at the time.
  burn_tx_sig     TEXT UNIQUE,
  notes           TEXT,
  burned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS magpie_burns_source_idx ON magpie_burns(source);
CREATE INDEX IF NOT EXISTS magpie_burns_burned_at_idx ON magpie_burns(burned_at DESC);
CREATE INDEX IF NOT EXISTS magpie_burns_loan_idx ON magpie_burns(related_loan_id)
  WHERE related_loan_id IS NOT NULL;

-- Seed the 2,000,000 $MAGPIE dev-wallet baseline burn that the operator
-- conducted manually before this ledger existed. 2_000_000 tokens * 10^6
-- (6 decimals) = 2,000,000,000,000 raw units.
INSERT INTO magpie_burns (amount_raw, source, burn_tx_sig, notes, burned_at)
SELECT
  2000000000000,
  'manual',
  NULL,
  'Pre-ledger dev-wallet baseline burn — 2,000,000 $MAGPIE confirmed by operator on 2026-06-14.',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM magpie_burns
  WHERE source = 'manual'
    AND notes LIKE 'Pre-ledger dev-wallet baseline burn%'
);

COMMENT ON TABLE magpie_burns IS
  'Per-burn ledger of $MAGPIE supply contractions. Sums into the public
   "total $MAGPIE burned" counter shown on /stats (TG + site).
   Defaulted-loan $MAGPIE collateral is burned by the operator and
   recorded here via /burn-confirm; the dev-wallet baseline (2M) is
   seeded by this migration. Single source of truth — every burn
   surface reads from this table.';
