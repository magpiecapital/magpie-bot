-- migration 056: realign rwa_loan_tiers to V2 program's actual on-chain LTVs.
--
-- CRITICAL BUG FIX. The rwa_loan_tiers seeded by migration 040 advertised
-- 50%/60%/70% LTVs for RWA borrows, with the load-bearing claim:
--
--   "The on-chain V2 program does NOT enforce LTV on chain; the bot's
--    src/api/cosign-borrow.js computes loan_amount = collateral_value *
--    LTV / 100 and the program just accepts it as long as authority co-signs."
--
-- That claim is WRONG. The V2 program (6wSpKAGuiRf3nYHj9raVwmoTPbG5MswBzTy6aMXZHBe)
-- IDL explicitly documents the Loan struct's ltv_bps field as:
--   "LTV in basis points (2000, 2500, or 3000)"
-- i.e. V2 hardcodes 20%/25%/30% LTV options identically to V1. The dashboard
-- was displaying "RWA Standard 70% LTV → 1.83 SOL" while Phantom prompted
-- 0.536 SOL because V2 actually computes 20% × value × (1 - 1.5% fee). This
-- mismatch eroded operator trust badly — users sign expecting one amount and
-- get a much smaller one.
--
-- Forensic math (2026-06-13 operator-reported SPCX borrow):
--   - Wallet HCvMUHZRq8VLZADzKqJh8wuWmiSwqsLuhqcUiBs7uM1G
--   - Holds 1.140423 SPCX @ $165.97/token = $189.28 = 2.75 SOL value
--   - Dashboard advertised RWA Standard 70% LTV → 1.83 SOL receive
--   - Phantom prompt showed 0.536 SOL receive
--   - 0.536 ≈ 20% × 2.75 × (1 - 1.5%) — EXACTLY matches V1/V2 Standard 20% LTV
--   - All three tier options similarly matched 30%/25%/20% with 3%/2%/1.5% fee
--
-- Operator-stated rule [[feedback_onchain_program_changes]]: never redeploy
-- the live V2 program at the same program ID. Higher-LTV RWA tiers therefore
-- require a NEW program (V3) deployment, which is a separate, careful
-- decision. Until V3 ships, the displayed tiers MUST match what V2 actually
-- delivers — better to be honest about lower LTVs than to silently underpay
-- the borrower.
--
-- Realigned values (match V2 on-chain ladder exactly):
--
--   Option | LTV  | Days | Fee  | Label
--   -------+------+------+------+----------------
--     0    | 30%  | 2d   | 3.0% | RWA Express
--     1    | 25%  | 3d   | 2.0% | RWA Quick
--     2    | 20%  | 7d   | 1.5% | RWA Standard
--
-- These match MEMECOIN_TIERS exactly because V2 happens to share V1's tier
-- ladder. We keep the rwa_loan_tiers table + category-aware resolver in
-- place so a future V3 deployment can re-tune these per category without
-- another code change.

UPDATE rwa_loan_tiers
   SET ltv_pct       = 30,
       duration_days = 2,
       fee_bps       = 300,
       notes         = 'Realigned 2026-06-13 to match V2 on-chain. Pre-fix: 50% LTV / 7d / 2.5% fee — not what V2 delivered.'
 WHERE option = 0;

UPDATE rwa_loan_tiers
   SET ltv_pct       = 25,
       duration_days = 3,
       fee_bps       = 200,
       notes         = 'Realigned 2026-06-13 to match V2 on-chain. Pre-fix: 60% LTV / 15d / 3.5% fee — not what V2 delivered.'
 WHERE option = 1;

UPDATE rwa_loan_tiers
   SET ltv_pct       = 20,
       duration_days = 7,
       fee_bps       = 150,
       notes         = 'Realigned 2026-06-13 to match V2 on-chain. Pre-fix: 70% LTV / 30d / 5.0% fee — not what V2 delivered.'
 WHERE option = 2;

COMMENT ON TABLE rwa_loan_tiers IS
  'Loan tier schedule for RWA collateral (stock/etf/metal). Resolved
   via src/services/loan-tier-resolver.js based on supported_mints.category.
   Numbers MUST match the on-chain V2 program at all times — V2''s tier
   ladder is hardcoded, so this table is purely a display / quoting
   surface. Mismatch = user signs for one amount and gets another.
   Future V3 deployment with truly higher RWA LTVs can repopulate this
   table; until then, RWA borrows deliver the same tiers as memecoin.';
