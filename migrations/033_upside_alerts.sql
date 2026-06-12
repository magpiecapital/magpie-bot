-- migration 033: proactive upside watcher state.
--
-- The upside watcher runs every 15 minutes against ACTIVE loans whose
-- collateral has materially appreciated since the loan was opened.
-- When the appreciation crosses a tier threshold (+40% / +100% / +200%),
-- the watcher emits a one-time DM to the borrower from Pip suggesting
-- they arm a take-profit. The upside_alerts row tracks WHICH tier
-- already DM'd on this loan, so we never double-send.
--
-- Why per-loan-per-tier (not per-loan): a token can drop back below a
-- tier and re-cross it; we want to nudge at most ONCE per crossing,
-- but a NEW higher tier (e.g. went from +40% past +100%) gets its own
-- DM because the value being captured is materially larger.
--
-- Privacy: this is operator-internal state. Per-loan dedupe key is the
-- (loan_id, tier_bucket) pair, both already operator-known.

CREATE TABLE IF NOT EXISTS upside_alerts (
  id            BIGSERIAL PRIMARY KEY,
  loan_id       BIGINT      NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  tier_bucket   INTEGER     NOT NULL,
  appreciation_pct  NUMERIC(10,2) NOT NULL,
  collateral_value_usd_at_alert NUMERIC(20,2),
  borrow_value_usd_at_loan      NUMERIC(20,2),
  notification_id  BIGINT REFERENCES pending_notifications(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (loan_id, tier_bucket)
);

CREATE INDEX IF NOT EXISTS upside_alerts_loan_idx ON upside_alerts(loan_id);
CREATE INDEX IF NOT EXISTS upside_alerts_created_idx ON upside_alerts(created_at DESC);

COMMENT ON TABLE upside_alerts IS
  'Dedupe ledger for the upside watcher (src/services/upside-watcher.js).
   One row per (loan, tier) so each appreciation tier nudges Pip at most
   once. Operator-internal — never exposed in any user-facing API.';

-- user_prefs flag — borrowers can opt OUT of upside alerts. Opt-IN by
-- default because the alert is genuinely valuable and our notification
-- discipline (one DM per loan per tier, max 3 per loan lifetime) means
-- the worst case is 3 DMs per loan if all three tiers fire — and only
-- when their book actually moons.
ALTER TABLE user_prefs
  ADD COLUMN IF NOT EXISTS notify_upside_alerts BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN user_prefs.notify_upside_alerts IS
  'Opt-out flag for the proactive upside-take-profit DMs. Default TRUE.
   Users toggle via /upsidealerts on|off (TG) or the dashboard toggle.';
