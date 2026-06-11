-- Protect canonical_rwa_mints itself from drift.
--
-- Migration 020 made supported_mints check against canonical_rwa_mints
-- on every insert/update — but the pin table itself was unprotected.
-- A compromise of the DB write path (SQL injection, leaked Railway DB
-- creds, malicious migration) could:
--   1. UPDATE canonical_rwa_mints SET mint = '<attacker_mint>' WHERE symbol = 'SPYx';
--   2. Insert a fake SPYx row in supported_mints pointing at the new mint —
--      which would now PASS the canonical check.
--   3. TRUNCATE canonical_rwa_mints entirely, removing all pins, then
--      insert arbitrary stock-categorized mints.
--
-- This migration locks the pin table down to APPEND-ONLY semantics:
--   - INSERT allowed (operator can pin new tickers).
--   - DELETE allowed (operator can remove a wrong pin, then re-pin).
--   - UPDATE blocked outright. There is no legitimate UPDATE — if a
--     pin is wrong, the correct fix is DELETE + INSERT, which leaves
--     an audit trail in the deleted row's surrounding logs.
--   - TRUNCATE blocked outright. Same reasoning — no legitimate use.
--
-- Operator can still recover from any state by dropping the trigger
-- in psql (which requires Railway shell access) — defense, not lockout.

CREATE OR REPLACE FUNCTION canonical_rwa_mints_block_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Hard refusal. No exceptions in the trigger itself — recovery is
  -- via DROP TRIGGER in psql, which requires direct DB access and
  -- therefore leaves an operator-visible footprint.
  RAISE EXCEPTION 'canonical_rwa_mints is APPEND-ONLY — UPDATE is blocked. Use DELETE + INSERT to fix a wrong pin.'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_canonical_rwa_mints_no_update ON canonical_rwa_mints;
CREATE TRIGGER trg_canonical_rwa_mints_no_update
  BEFORE UPDATE ON canonical_rwa_mints
  FOR EACH ROW EXECUTE FUNCTION canonical_rwa_mints_block_update();

CREATE OR REPLACE FUNCTION canonical_rwa_mints_block_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'canonical_rwa_mints TRUNCATE is blocked. Drop pins individually with DELETE.'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_canonical_rwa_mints_no_truncate ON canonical_rwa_mints;
CREATE TRIGGER trg_canonical_rwa_mints_no_truncate
  BEFORE TRUNCATE ON canonical_rwa_mints
  FOR EACH STATEMENT EXECUTE FUNCTION canonical_rwa_mints_block_truncate();
