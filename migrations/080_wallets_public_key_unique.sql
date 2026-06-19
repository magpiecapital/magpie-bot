-- 080_wallets_public_key_unique.sql
--
-- Permanent fix for the loan-misattribution bug class. Operator-mandated
-- 2026-06-19 PM after 4 active loans (867, 848, 873, 874) were attributed
-- to the wrong user_id because the wallets table had DUPLICATE rows for
-- the same public_key — one for the rightful TG-linked user, one for a
-- synthetic "site_xxxx" user created by the agent (Pip x402) endpoint.
-- The resolver picked whichever row pg returned first.
--
-- This migration:
--   1. Creates loan_user_attribution_audit (audit trail for repairs).
--   2. Adds a partial UNIQUE index on wallets.public_key — physically
--      prevents duplicates going forward.
--
-- The actual DE-DUPE of existing rows + RE-ATTRIBUTION of the 4 misattributed
-- loans happens in a separate one-off script (operator-authorized 2026-06-19).
-- That script must run BEFORE this migration's UNIQUE constraint will succeed
-- on creation (the constraint creation will fail if duplicates exist).
--
-- See [[feedback_never_misattribute_loans]].

-- Audit trail for every user_id re-attribution. INSERTED by the de-dupe
-- script + by the wallet-attr-sentinel auto-repair path.
CREATE TABLE IF NOT EXISTS loan_user_attribution_audit (
  id            BIGSERIAL PRIMARY KEY,
  loan_id       BIGINT NOT NULL REFERENCES loans(id),
  prev_user_id  BIGINT,
  new_user_id   BIGINT NOT NULL,
  reason        TEXT NOT NULL,
  repaired_by   TEXT,
  metadata      JSONB,
  repaired_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_attr_audit_loan_id
  ON loan_user_attribution_audit (loan_id);

CREATE INDEX IF NOT EXISTS idx_loan_attr_audit_repaired_at
  ON loan_user_attribution_audit (repaired_at DESC);

-- Partial UNIQUE index on wallets.public_key.
-- Partial (NOT NULL) so legacy NULL rows (if any) don't block the
-- creation. Once de-dupe is complete this becomes the structural
-- guarantee that the resolver never sees ambiguous rows.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wallets_public_key
  ON wallets (public_key)
  WHERE public_key IS NOT NULL;
