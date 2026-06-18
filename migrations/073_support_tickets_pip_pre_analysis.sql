-- Pip pre-analysis on every support ticket
--
-- 2026-06-18 PM: ticket #60 sat in 'open' status for 12h+ because its
-- escalation reason was `bug_report`, which the immediate auto-resolver
-- skipped. The actual issue was a Pip wording misread, not a real bug —
-- a second-pass with admin-context tools would have caught it in seconds.
--
-- Per operator directive (feedback_pip_must_proactively_resolve_every_ticket):
-- Pip must take an active pass on EVERY ticket the moment it opens,
-- including the categories where we don't auto-DM the user. The output
-- is stored on the ticket so the operator sees Pip's read of the situation
-- in /tickets <N> and can /reply in seconds.
--
-- pip_pre_analysis     — Pip's admin-facing read on the ticket (4-section
--                        structure: what asked / current state / root
--                        cause / recommended action). Up to 4000 chars.
-- pip_pre_analyzed_at  — when pre-analysis last ran. Refreshed on
--                        aging-tier alerts so the operator sees current
--                        state, not stale.

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS pip_pre_analysis TEXT,
  ADD COLUMN IF NOT EXISTS pip_pre_analyzed_at TIMESTAMPTZ;
