-- HARD CONSTRAINT: pump.fun memecoin mints can never be classified as
-- stock / etf / metal in supported_mints, and can never be added to
-- premium_tier_whitelist.
--
-- Operator surfaced 2026-06-10 that '$FATHER' (HVFJvVHY8muTRGhD5BZ6p2TZ5TozSWyTcs9CDJo3pump)
-- was sitting in supported_mints with category='stock' at one point.
-- Same pattern for '白毛股神' and 'ITLG'. Migration 017 reclassified them
-- after the fact; this migration makes the rule structural so no future
-- code path — auto-classifier bug, manual SQL, a future onboarding
-- script — can re-create the same situation.
--
-- Why this is safe / no false positives:
--   - Real Backed Finance xStocks use the Token-2022 standard and have
--     mint addresses starting with 'Xs...' (verified for all 18 RWA
--     tokens currently in supported_mints). None end in 'pump'.
--   - pump.fun is exclusively a memecoin launchpad. Their token mints
--     are minted by a pump.fun program and the suffix 'pump' is the
--     reliable canonical signature.
--   - No legitimate stock/etf/metal mint has ever ended in 'pump'.

ALTER TABLE supported_mints
  DROP CONSTRAINT IF EXISTS supported_mints_no_pump_as_rwa;
ALTER TABLE supported_mints
  ADD CONSTRAINT supported_mints_no_pump_as_rwa
  CHECK (
    NOT (mint LIKE '%pump' AND category IN ('stock', 'etf', 'metal'))
  );

ALTER TABLE premium_tier_whitelist
  DROP CONSTRAINT IF EXISTS premium_tier_whitelist_no_pump_mints;
ALTER TABLE premium_tier_whitelist
  ADD CONSTRAINT premium_tier_whitelist_no_pump_mints
  CHECK (NOT (mint LIKE '%pump'));
