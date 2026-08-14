-- 103 · Opt-in auto-extend (strategy doc 18, phase 2).
--
-- WHY. Real borrowers ask "what if I just forget?" — and the Sec3 Q-02
-- hardening (queued 2026-08-14) makes the deadline final: an overdue loan can
-- no longer be extended at all. For borrowers who explicitly opt in, the bot
-- auto-executes extend_loan inside a strictly PRE-due window (T-2h..T-30m)
-- when the loan is still open, the managed wallet can cover the fee, the loan
-- is not underwater, and the consecutive-auto-extend cap is not exhausted.
--
-- Decisions (operator delegated 2026-08-14): explicit opt-in only (never
-- default-on for money movement) · cap 2 consecutive auto-extends · skip if
-- collateral value < 110% of owed · TG-managed wallets only at launch.

-- Explicit opt-in. Lives in user_prefs like auto_protect, toggled via
-- /autoextend. DEFAULT FALSE deliberately differs from auto_protect's ON:
-- auto-protect only moves the user's funds to SAVE them from liquidation;
-- auto-extend CHARGES a fee — spending is never default-on.
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS auto_extend BOOLEAN NOT NULL DEFAULT FALSE;

-- Consecutive auto-extends consumed on this loan (manual extends don't count;
-- a repay closes the loan so the counter naturally dies with it).
ALTER TABLE loans ADD COLUMN IF NOT EXISTS auto_extend_count INTEGER NOT NULL DEFAULT 0;

-- Decision trail — every auto-extend EXECUTION, FAILURE, and first occurrence
-- of each skip reason per loan. Captures the why + rule version so any
-- outcome can be reconstructed later (protocol-data-as-asset mandate).
CREATE TABLE IF NOT EXISTS auto_extend_events (
  id            BIGSERIAL PRIMARY KEY,
  loan_id       BIGINT NOT NULL,
  user_id       BIGINT NOT NULL,
  decision      TEXT   NOT NULL,          -- 'extended' | 'failed' | 'skipped'
  reason        TEXT   NOT NULL,          -- e.g. 'ok', 'underwater', 'insufficient_balance', 'cap_reached'
  fee_lamports  BIGINT,
  health_ratio  NUMERIC,                  -- collateral value / owed at decision time (NULL = price unavailable)
  rule_version  TEXT   NOT NULL,
  tx_signature  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Repeated poll-cycle SKIPS collapse into their first occurrence instead of
-- flooding the table. Partial: 'extended'/'failed' rows are real events and a
-- loan can legitimately have two of each (cap = 2), so only skips dedup.
CREATE UNIQUE INDEX IF NOT EXISTS auto_extend_events_skip_dedup
  ON auto_extend_events (loan_id, reason) WHERE decision = 'skipped';

CREATE INDEX IF NOT EXISTS auto_extend_events_user_idx
  ON auto_extend_events (user_id, created_at);
