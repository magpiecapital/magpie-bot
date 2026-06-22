-- Add attestation_tier to supported_mints.
--
-- Operator-mandated 2026-06-19 PM. Replaces the "EVERY MINT EVERY SAMPLE
-- ALWAYS" rule with a cost-conscious tiered model:
--
--   hot  → continuously attested (every tick). Premium UX, top revenue
--          drivers, popular borrow tokens. ~$80-100/mo per mint.
--   warm → attested only when there's active borrower interest (active
--          loan, armed exit, recent arm intent). Auto-promoted/demoted.
--          Near-zero cost when idle.
--   cold → never continuously attested. Cosign-borrow's JIT warmer
--          handles the first borrow (5-30s warmup). Long-tail tokens.
--          ~$0 baseline + ~$0.02 per first-borrow.
--
-- Phase 1 (this migration): pure additive. Default 'hot' for every
-- existing enabled mint → ZERO behavior change. The attestor loops
-- still attest every mint as before.
--
-- Phase 2 (future PR): update fetchMintsToAttest and refreshContinuousList
-- to filter by tier. Operator decides which mints stay 'hot' via the
-- /tier admin TG command. Each demotion incrementally reduces burn.
--
-- See [[feedback_tiered_attestation_cost_conscious]] for the architecture
-- decision and the supersession of the prior "every mint every sample
-- always" rule.

ALTER TABLE supported_mints
  ADD COLUMN IF NOT EXISTS attestation_tier TEXT NOT NULL DEFAULT 'hot'
    CHECK (attestation_tier IN ('hot', 'warm', 'cold'));

-- Index for fast tier filtering in attestor loops (Phase 2 will use this).
CREATE INDEX IF NOT EXISTS idx_supported_mints_tier_enabled
  ON supported_mints (attestation_tier, enabled)
  WHERE enabled = TRUE;

-- Audit trail of tier changes — who changed what when. Lets us see
-- whether burn-rate drops correlate with operator demotions.
CREATE TABLE IF NOT EXISTS supported_mints_tier_changes (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  from_tier TEXT,
  to_tier TEXT NOT NULL,
  changed_by TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_smtc_mint_created ON supported_mints_tier_changes (mint, created_at DESC);
