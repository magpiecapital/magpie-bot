-- migration 049: protocol_reserve_pool
--
-- MGP-001 ratified a 10% protocol reserve share of every loan fee
-- (protocol_reserve_bps = 1000 in governance_config). Before this
-- migration, there was no consumer for that key — fees passed through
-- to the operator wallet without being earmarked as "reserve".
--
-- The reserve pool is the protocol-owned counter-cyclical buffer: covers
-- bad-debt events, funds emergency oracle/program fixes, backstops the
-- lender wallet during volatility windows. It is NOT auto-distributed;
-- spend happens via operator action and is governance-visible.
--
-- Schema mirrors lp_loyalty_pool (single row, accrued_lamports counter).
-- Spend events get their own log table later if needed.

CREATE TABLE IF NOT EXISTS protocol_reserve_pool (
  id                INT PRIMARY KEY DEFAULT 1,
  accrued_lamports  NUMERIC(30, 0) NOT NULL DEFAULT 0,
  spent_lamports    NUMERIC(30, 0) NOT NULL DEFAULT 0,
  last_accrual_at   TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT singleton CHECK (id = 1)
);

INSERT INTO protocol_reserve_pool (id, accrued_lamports, spent_lamports)
VALUES (1, 0, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS protocol_reserve_events (
  id              BIGSERIAL PRIMARY KEY,
  loan_db_id      BIGINT,
  event_type      TEXT NOT NULL, -- 'borrow', 'extend', 'limit_close'
  fee_lamports    NUMERIC(30, 0) NOT NULL,
  reward_lamports NUMERIC(30, 0) NOT NULL,
  reward_bps      INT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (loan_db_id, event_type)
);

CREATE INDEX IF NOT EXISTS protocol_reserve_events_loan_idx
  ON protocol_reserve_events(loan_db_id);

COMMENT ON TABLE protocol_reserve_pool IS
  'Protocol-owned counter-cyclical reserve. Receives 10% of every loan
   fee per MGP-001 (governance_config.protocol_reserve_bps). Spend is
   manual + governance-visible — not auto-distributed.';
