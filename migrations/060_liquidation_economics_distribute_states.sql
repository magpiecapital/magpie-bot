-- migration 060: add 'distributing' + 'distribute_error' to the
-- liquidation_economics.distribution_status CHECK constraint.
--
-- Phase 2 introduces a transient 'distributing' state (claimed by a
-- worker tick, mid-flight) and a 'distribute_error' state (worker
-- ran but a credit step failed). The original migration 059's CHECK
-- doesn't allow them, so this migration drops + recreates the
-- constraint with the expanded enum.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'liquidation_economics'
  ) THEN
    -- Drop the old check (idempotent on re-run; PostgreSQL <14 has no
    -- IF EXISTS for table constraints, so we use a DO block).
    BEGIN
      ALTER TABLE liquidation_economics
        DROP CONSTRAINT IF EXISTS liquidation_economics_distribution_status_check;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    ALTER TABLE liquidation_economics
      ADD CONSTRAINT liquidation_economics_distribution_status_check
      CHECK (distribution_status IN (
        'pending_sale',          -- awaiting operator sale
        'awaiting_distribution', -- sale done, splits computed, not credited yet
        'distributing',          -- Phase 2 worker mid-flight (transient)
        'distributed',           -- pool ledgers credited
        'distribute_error',      -- worker ran but a credit step failed; operator review
        'magpie_burn_pending',   -- $MAGPIE collateral awaiting operator burn
        'magpie_burned',         -- operator confirmed the burn landed
        'loss',                  -- sale proceeds < principal — no distribution
        'manual_skip'            -- operator opted out
      ));
  END IF;
END
$$;

COMMENT ON COLUMN liquidation_economics.distribution_status IS
  'Lifecycle: pending_sale -> awaiting_distribution -> distributing
   -> distributed (success) or distribute_error (partial credit;
   needs operator review). $MAGPIE collateral takes the parallel
   magpie_burn_pending -> magpie_burned path. loss = principal not
   recovered (no distribution). manual_skip = operator opt-out.';
