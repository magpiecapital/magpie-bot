-- lp_positions: track per-pool LP shares instead of one row per wallet.
--
-- Why this exists: the original table was created before v2/v3 lending
-- programs were live, so it implicitly assumed a single pool. The
-- syncOnChainPositions service only iterates the v1 pool. Operator's
-- post-/fundpool deposits into v2 were invisible, and even v1 syncs
-- ran on a 6h cycle so the row was perpetually stale just after a
-- deposit.
--
-- Schema:
--   - Add `pool` (text) — the pool PDA the position is in.
--   - Add `program_id` (text) — which lending program (v1, v2, v3).
--   - Replace the wallet_address PRIMARY KEY with (wallet_address, pool).
--   - Backfill: every existing row gets pool = the live v1 pool PDA
--     and program_id = the v1 program id (the historical truth — every
--     position predating this migration was a v1 deposit).
--
-- Compatibility:
--   - Aggregate queries (SUM(shares) for TVL display) continue to work
--     unchanged — they just sum more rows.
--   - Per-wallet queries that previously got at most one row may now
--     get multiple. Callers that intended "this wallet's v1 LP" need
--     to filter by pool; callers that intended "this wallet's total
--     LP across all pools" should SUM. Code updates accompany this
--     migration.

ALTER TABLE lp_positions
  ADD COLUMN IF NOT EXISTS pool       TEXT,
  ADD COLUMN IF NOT EXISTS program_id TEXT;

-- Backfill existing rows with the live v1 pool PDA + program id.
-- These are operator-known constants (also stored in Railway env vars),
-- pinned here so the migration is idempotent and doesn't depend on
-- runtime config at apply time.
UPDATE lp_positions
   SET pool       = COALESCE(pool,       'EynWtuRMUKU3zHzfLv7Y5Qu6MWpwqG17X91QAuHSww9u'),
       program_id = COALESCE(program_id, '4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh')
 WHERE pool IS NULL OR program_id IS NULL;

ALTER TABLE lp_positions
  ALTER COLUMN pool       SET NOT NULL,
  ALTER COLUMN program_id SET NOT NULL;

-- Drop the old PK on wallet_address (it had to be unique before) and
-- replace with the composite (wallet_address, pool). Postgres won't
-- let us redefine an existing PK in-place — we drop the constraint
-- explicitly. The auto-generated PK name follows the
-- `<table>_pkey` convention.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'lp_positions'::regclass AND contype = 'p'
  ) THEN
    EXECUTE 'ALTER TABLE lp_positions DROP CONSTRAINT ' || (
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'lp_positions'::regclass AND contype = 'p'
       LIMIT 1
    );
  END IF;
END $$;

ALTER TABLE lp_positions
  ADD CONSTRAINT lp_positions_wallet_pool_pk PRIMARY KEY (wallet_address, pool);

CREATE INDEX IF NOT EXISTS lp_positions_pool_shares_idx
  ON lp_positions(pool, shares) WHERE shares > 0;
