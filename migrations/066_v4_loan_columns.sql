-- migration 066: V4 loan column extensions (in-vault auto-sell state)
--
-- V4's on-chain Loan account extends V3's layout with three new fields
-- (current_collateral_amount, sol_proceeds_amount, auto_sells_fired).
-- These mirror the on-chain state into the bot's `loans` table so the
-- repay flow, /positions display, and /lc-perf engine telemetry can
-- show the post-auto-sell mix accurately without a round-trip to the
-- chain on every read.
--
-- Backward compat:
--   - All three columns DEFAULT to a sane V3-equivalent value (current
--     equals collateral at borrow time, sol_proceeds = 0, fires = 0)
--   - Existing V1/V2/V3 loan rows are NOT migrated (they don't have V4
--     semantics — they should keep showing as pure SPL collateral).
--     A WHERE clause in the bot read paths gates on program_id = V4 so
--     these columns are only consulted for V4 loans.
--   - The migration is safe to re-apply (uses ADD COLUMN IF NOT EXISTS).
--
-- Operator note (2026-06-15): this migration ships ahead of V4 mainnet
-- deploy so the DB is ready the moment V4 starts issuing loans. Until a
-- V4 loan is recorded, no code path reads these columns.

-- Remaining SPL collateral in the loan vault. Decreases each time
-- convert_collateral_slice fires. Equals collateral_amount at borrow
-- time on V4; equals collateral_amount permanently on V1/V2/V3 (no
-- auto-sell drain).
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS current_collateral_amount NUMERIC;

-- SOL accumulated from convert_collateral_slice fires (lamports, net
-- of the 1% protocol fee). The user receives this at repay time
-- alongside any remaining SPL.
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS sol_proceeds_amount NUMERIC NOT NULL DEFAULT 0;

-- Diagnostic counter — number of convert_collateral_slice calls. Used
-- by /lc-perf to show auto-sell density per loan.
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS auto_sells_fired SMALLINT NOT NULL DEFAULT 0;

-- Backfill current_collateral_amount to match collateral_amount on
-- existing rows. For V1/V2/V3 loans this stays equal forever (no
-- auto-sell ever drains SPL on these programs). For V4 loans the
-- value diverges as convert_collateral_slice fires.
UPDATE loans
   SET current_collateral_amount = collateral_amount
 WHERE current_collateral_amount IS NULL;

-- Indices for the queries that actually filter on these columns:
-- /lc-perf totals SOL proceeds by date range; /positions filters loans
-- where any auto-sell has fired so the mixed-collateral display kicks
-- in only when relevant.
CREATE INDEX IF NOT EXISTS loans_auto_sells_fired_idx
  ON loans (auto_sells_fired)
  WHERE auto_sells_fired > 0;
</content>
</invoke>