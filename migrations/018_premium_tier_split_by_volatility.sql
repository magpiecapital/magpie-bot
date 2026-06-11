-- Premium-tier whitelist: two-tier split by realized volatility.
--
-- The 90-day vol pull (in-conversation analysis 2026-06-10) showed the
-- "tokenized stocks" basket is actually two very different risk shapes:
--
--   * Pure equities / ETFs (SPYx, QQQx, GLDx, big tech): mean 32.3%
--     annualized vol, mean max drawdown -13.1%, zero >10% single-day
--     moves across 9 names × 90 days. Behaves like equities.
--
--   * Crypto-adjacent equities (COINx, MSTRx, HOODx, CRCLx): mean 79.4%
--     annualized vol, mean max drawdown -33.3%, 16 single-day >10%
--     moves. Their fundamentals are crypto exposure; their volatility
--     reflects that. Memecoin-shaped risk inside an equity wrapper.
--
-- The original migration 017 lumped both buckets at the same caps. This
-- migration splits them: tier-aware max LTV + tighter aggregate caps
-- for the crypto-adjacent bucket.

ALTER TABLE premium_tier_whitelist
  ADD COLUMN IF NOT EXISTS tier         TEXT,
  ADD COLUMN IF NOT EXISTS max_ltv_bps  INTEGER;

-- Blue-chip tier — pure equities + index ETFs + GLD. ~32% annualized vol.
-- Max LTV 50% (5000 bps): ~3x the median name's max drawdown leaves a
-- comfortable safety margin. Aggregate cap 50 SOL per mint.
UPDATE premium_tier_whitelist
   SET tier = 'blue_chip',
       max_ltv_bps = 5000,
       max_open_lamports = 50000000000
 WHERE symbol IN ('SPYx', 'QQQx', 'GLDx', 'NVDAx', 'TSLAx',
                  'GOOGLx', 'MSFTx', 'METAx', 'AMZNx');

-- Crypto-adjacent tier — COINx, MSTRx, HOODx, CRCLx. ~79% annualized vol.
-- Max LTV 30% (3000 bps): vol is ~2.5x blue-chip; LTV haircut compensates.
-- Aggregate cap 15 SOL per mint (vs 25 SOL in migration 017 — tightened
-- because the realized vol justifies smaller per-mint concentration).
UPDATE premium_tier_whitelist
   SET tier = 'crypto_adjacent',
       max_ltv_bps = 3000,
       max_open_lamports = 15000000000
 WHERE symbol IN ('COINx', 'MSTRx', 'HOODx', 'CRCLx');

-- Make tier + max_ltv_bps mandatory going forward.
ALTER TABLE premium_tier_whitelist
  ALTER COLUMN tier        SET NOT NULL,
  ALTER COLUMN max_ltv_bps SET NOT NULL;

-- Sanity-check constraint: tier must be one of the known buckets.
ALTER TABLE premium_tier_whitelist
  DROP CONSTRAINT IF EXISTS premium_tier_whitelist_tier_check;
ALTER TABLE premium_tier_whitelist
  ADD CONSTRAINT premium_tier_whitelist_tier_check
  CHECK (tier IN ('blue_chip', 'crypto_adjacent'));

CREATE INDEX IF NOT EXISTS idx_premium_tier_whitelist_tier
  ON premium_tier_whitelist (tier, enabled);
