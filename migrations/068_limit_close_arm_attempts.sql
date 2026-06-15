-- 068_limit_close_arm_attempts.sql
--
-- Server-side audit log for every limit-close arm attempt (success
-- AND failure), regardless of source (site / tg / agent_x402).
--
-- Forcing function: operator's 2026-06-15 V4 SPCX ladder. The user
-- believed they armed a ladder, the SPCX strike was hit, no fire
-- happened. Investigation found ZERO rows in limit_close_orders for
-- their account across ALL loans, ever — every prior arm attempt
-- silently failed before reaching the INSERT statement.
--
-- Without an audit table, "did my arm even reach the server?" is
-- unanswerable. With it, every site/tg/agent arm attempt writes
-- one row with:
--   - WHO  (user_id, source, source_agent_pubkey)
--   - WHAT (loan, direction, target, slice, ladder_group_id)
--   - OUTCOME (success → order_id, failure → error_code + detail)
--
-- The notification-sender additionally fires a Telegram DM on every
-- failure, so the user gets ground-truth feedback in seconds.
--
-- READS this table:
--   - notification-sender (fail DM render)
--   - dashboard via /api/v1/site/limit-close (recent failures banner)
--   - operator /lc-perf admin command (future)

CREATE TABLE IF NOT EXISTS limit_close_arm_attempts (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL,

  -- Loan identification — keep BOTH the chain-side and the DB-side
  -- loan_id because some failure modes (e.g. loan_not_found_for_user)
  -- happen before we resolve the DB row, so loan_db_id can be NULL.
  loan_id_chain       TEXT NULL,
  loan_db_id          BIGINT NULL,

  -- Trigger
  direction           TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  target_kind         TEXT NULL,
  target_value_micro  NUMERIC(30, 0) NULL,
  slice_pct           INTEGER NULL,
  ladder_group_id     UUID NULL,

  -- Provenance — same enum as limit_close_orders.source
  source              TEXT NULL,
  source_agent_pubkey TEXT NULL,

  -- Outcome
  outcome             TEXT NOT NULL CHECK (outcome IN ('success', 'failed')),
  order_id            BIGINT NULL,  -- set when outcome = 'success'
  error_code          TEXT NULL,    -- set when outcome = 'failed'
  error_detail        TEXT NULL,    -- bounded; truncate caller-side to ~400 chars

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What recently happened on this loan / for this user" — the
-- dashboard banner reads (user_id, recent) to surface failed attempts
-- in the last hour.
CREATE INDEX IF NOT EXISTS idx_arm_attempts_user_recent
  ON limit_close_arm_attempts (user_id, created_at DESC);

-- Operator + watchers want to focus on failures, so add a partial
-- index for just the failed rows.
CREATE INDEX IF NOT EXISTS idx_arm_attempts_failures_recent
  ON limit_close_arm_attempts (created_at DESC)
  WHERE outcome = 'failed';
