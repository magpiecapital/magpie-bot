-- migration 051: loan_remediation_payouts
--
-- 2026-06-13: cosign-borrow.js hardcoded the memecoin LTV ladder for
-- every borrow, regardless of category. RWA borrows on
-- request_and_fund_loan were resolved against {0:30, 1:25, 2:20} —
-- the memecoin Express/Quick/Standard ladder — instead of the
-- rwa_loan_tiers ladder (50/60/70). 12 historical loans were
-- underpaid; total delta 23.23 SOL across 9 wallets.
--
-- This table is the immutable audit trail of every remediation
-- transfer the operator sends from the lender wallet to make those
-- users whole. The (loan_db_id, payout_kind) UNIQUE index makes the
-- payout idempotent — re-running the remediation script after a
-- network blip won't double-pay.

CREATE TABLE IF NOT EXISTS loan_remediation_payouts (
  id              BIGSERIAL PRIMARY KEY,
  loan_db_id      BIGINT      NOT NULL REFERENCES loans(id),
  payout_kind     TEXT        NOT NULL, -- 'rwa_ltv_misroute_2026_06_13'
  amount_lamports NUMERIC(30, 0) NOT NULL,
  recipient_wallet TEXT       NOT NULL,
  tx_signature    TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending', -- pending | sent | failed
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  UNIQUE (loan_db_id, payout_kind)
);

CREATE INDEX IF NOT EXISTS loan_remediation_payouts_status_idx
  ON loan_remediation_payouts(status);

COMMENT ON TABLE loan_remediation_payouts IS
  'Immutable audit log of every retroactive top-up the protocol sends
   to make borrowers whole when a code bug causes underpayment.
   Idempotent via UNIQUE(loan_db_id, payout_kind).';
