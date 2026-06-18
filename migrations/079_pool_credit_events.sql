-- 079_pool_credit_events.sql
--
-- Ledger-gated pool credits + forward-only distribution state machines.
--
-- Operator-mandated 2026-06-18 PM after the holder-pool over-credit P0,
-- where distributeRecoveryCredit's caller-side idempotency was the only
-- defense and a sibling-throw bug bypassed it. Pool credits MUST be
-- idempotent at the DB level — every credit goes through this ledger
-- with UNIQUE (source_type, source_id, pool_kind).
--
-- See [[feedback_pool_credits_must_be_idempotent_at_db_level]].

CREATE TABLE IF NOT EXISTS pool_credit_events (
  id          BIGSERIAL PRIMARY KEY,
  source_type TEXT       NOT NULL,
  source_id   TEXT       NOT NULL,
  pool_kind   TEXT       NOT NULL CHECK (pool_kind IN ('holder', 'lp_loyalty', 'protocol_reserve')),
  lamports    NUMERIC(20,0) NOT NULL CHECK (lamports > 0),
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_type, source_id, pool_kind)
);

CREATE INDEX IF NOT EXISTS idx_pool_credit_events_created_at
  ON pool_credit_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pool_credit_events_pool_kind_created
  ON pool_credit_events (pool_kind, created_at DESC);

-- Forward-only state machine on recovery_credits. Once a row is
-- 'distributed', no UPDATE may revert it. The pre-fix bug was exactly
-- this regression: caller code reverted 'distributing' -> 'awaiting_distribution'
-- on a partial pool credit failure, and the watcher reclaimed it next tick.
CREATE OR REPLACE FUNCTION recovery_credits_forward_only_status()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.distribution_status = 'distributed' AND NEW.distribution_status <> 'distributed' THEN
    RAISE EXCEPTION 'recovery_credits.distribution_status is forward-only: cannot regress from distributed to % (row id=%)',
      NEW.distribution_status, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recovery_credits_forward_only ON recovery_credits;
CREATE TRIGGER trg_recovery_credits_forward_only
  BEFORE UPDATE ON recovery_credits
  FOR EACH ROW
  EXECUTE FUNCTION recovery_credits_forward_only_status();

-- Same forward-only rule for liquidation_economics. Belt-and-suspenders:
-- the watcher's claim already gates against re-processing, but this
-- closes the class architecturally.
CREATE OR REPLACE FUNCTION liquidation_economics_forward_only_status()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.distribution_status = 'distributed' AND NEW.distribution_status <> 'distributed' THEN
    RAISE EXCEPTION 'liquidation_economics.distribution_status is forward-only: cannot regress from distributed to % (row id=%)',
      NEW.distribution_status, OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_liquidation_economics_forward_only ON liquidation_economics;
CREATE TRIGGER trg_liquidation_economics_forward_only
  BEFORE UPDATE ON liquidation_economics
  FOR EACH ROW
  EXECUTE FUNCTION liquidation_economics_forward_only_status();
