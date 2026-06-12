-- migration 034: support vigil — close the awaiting_user gap.
--
-- The AI auto-ticket-resolver auto-replies to stale tickets and flips
-- them to status='awaiting_user'. But if the user never confirms the
-- resolution, the ticket sits in awaiting_user forever — no follow-up,
-- no auto-close. Real measured impact: 8 tickets stuck in this state
-- for hours/days, including ones 40+ hours old.
--
-- Operator mandate: "No cases should go unanswered or unsolved."
--
-- The vigil's logic walks each awaiting_user ticket through tiered Pip
-- follow-up DMs and auto-closes after a final silence window. This
-- column tracks the LAST Pip-side follow-up DM (separate from the
-- user-side last_user_followup_at) so the watcher knows when to nudge
-- again vs when to stop.

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS last_pip_followup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pip_followup_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN support_tickets.last_pip_followup_at IS
  'When the support vigil last sent a follow-up DM (e.g. "did this resolve?").
   Distinct from last_user_followup_at which tracks USER-initiated replies.';

COMMENT ON COLUMN support_tickets.pip_followup_count IS
  'How many Pip follow-up DMs have been sent on this ticket. Capped at 2
   by the vigil (24h + 72h after AI reply); after that the ticket is
   auto-closed.';

CREATE INDEX IF NOT EXISTS support_tickets_awaiting_user_idx
  ON support_tickets(admin_replied_at)
  WHERE status = 'awaiting_user';
