-- migration 038: protocol fee sweep audit log.
--
-- The protocol-fee-sweeper service transfers accumulated take-profit
-- execution fees from the protocol wallet (5hsZBr…) into the lender
-- wallet (4JSSSaG3…) so the existing distributor includes them in the
-- 70-10-10-10 split that MGP-001 governs.
--
-- One row per sweep. Idempotency comes from comparing the sum of TP
-- fees recorded in limit_close_orders (accrued_at NOT NULL) MINUS the
-- sum of swept amounts here. The sweeper transfers exactly the
-- difference, so a re-run after a successful sweep sees delta=0 and
-- skips.
--
-- This is operator-internal state — never exposed publicly.

CREATE TABLE IF NOT EXISTS protocol_fee_sweeps (
  id                   BIGSERIAL PRIMARY KEY,
  swept_lamports       NUMERIC NOT NULL CHECK (swept_lamports > 0),
  source_pubkey        TEXT NOT NULL,
  destination_pubkey   TEXT NOT NULL,
  signature            TEXT NOT NULL,
  -- Range of TP fee accruals this sweep covers, for audit traceability.
  accrual_floor_id     BIGINT,
  accrual_ceiling_id   BIGINT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS protocol_fee_sweeps_created_idx
  ON protocol_fee_sweeps (created_at DESC);

COMMENT ON TABLE protocol_fee_sweeps IS
  'Audit log for the protocol-fee-sweeper (src/services/protocol-fee-sweeper.js).
   One row per successful SOL transfer from the protocol wallet to the
   lender wallet to consolidate TP fees for distribution. Best-effort
   insert; the on-chain transfer is the source of truth.';
