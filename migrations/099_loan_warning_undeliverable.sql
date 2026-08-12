-- 099 · Record when a loan-expiry warning could not be delivered.
--
-- `loan-watcher` only sets warned_24h_at / warned_6h_at after a DM actually
-- sends, which is correct — but it meant a permanently unreachable borrower
-- (blocked the bot, deleted the chat) was retried every 60s until the loan
-- expired, was never warned, and nothing ever escalated. Production logs show
-- `400: Bad Request: chat not found` against live loans.
--
-- These columns make that state explicit and queryable instead of silent:
-- "we tried, we cannot reach this borrower, and a human was told."
--
-- Nullable with no default and no backfill: existing rows are genuinely
-- unknown, and pretending otherwise would be worse than a NULL.

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS warn_undeliverable_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS warn_undeliverable_reason TEXT,
  ADD COLUMN IF NOT EXISTS warn_escalated_at         TIMESTAMPTZ;

COMMENT ON COLUMN loans.warn_undeliverable_at IS
  'First time an expiry warning was rejected by Telegram as permanently undeliverable (blocked/chat not found). NULL = never happened.';
COMMENT ON COLUMN loans.warn_undeliverable_reason IS
  'Verbatim Telegram rejection, truncated to 200 chars. Operator-facing.';
COMMENT ON COLUMN loans.warn_escalated_at IS
  'When the operator was alerted that this loan is near due with no delivered warning. Set by the backstop, and at most once per loan.';

-- Partial index: the backstop sweeps active loans near due; keeping it partial
-- keeps it tiny (active loans are a handful) rather than indexing all history.
CREATE INDEX IF NOT EXISTS idx_loans_active_due_unwarned
  ON loans (due_timestamp)
  WHERE status = 'active' AND warn_escalated_at IS NULL;
