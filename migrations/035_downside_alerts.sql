-- migration 035: downside watcher dedupe state.
--
-- Symmetric to upside_alerts (mig 033) — the downside watcher walks each
-- active loan whose collateral has DEPRECIATED since loan-open. At
-- crossing tiers (-20% / -35% / -50%) it sends ONE Pip DM with concrete
-- derisk options.
--
-- Why a separate table from upside_alerts:
--   - Different semantics (upside = lock in gains; downside = avoid loss)
--   - Different user pref (a user might want one not the other)
--   - Different tier set; clean separation makes audit + reasoning easier
--
-- Per-loan-per-tier dedupe via UNIQUE(loan_id, tier_bucket). A loan
-- can cross + uncross a tier and we'll only alert ONCE per crossing
-- per tier.

CREATE TABLE IF NOT EXISTS downside_alerts (
  id            BIGSERIAL PRIMARY KEY,
  loan_id       BIGINT      NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  tier_bucket   INTEGER     NOT NULL,
  depreciation_pct NUMERIC(10,2) NOT NULL,
  collateral_value_usd_at_alert NUMERIC(20,2),
  borrow_value_usd_at_loan      NUMERIC(20,2),
  notification_id BIGINT REFERENCES pending_notifications(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (loan_id, tier_bucket)
);

CREATE INDEX IF NOT EXISTS downside_alerts_loan_idx ON downside_alerts(loan_id);
CREATE INDEX IF NOT EXISTS downside_alerts_created_idx ON downside_alerts(created_at DESC);

COMMENT ON TABLE downside_alerts IS
  'Dedupe ledger for the downside watcher (src/services/downside-watcher.js).
   One row per (loan, tier) so each depreciation tier nudges Pip at most
   once per crossing. Operator-internal — never exposed publicly.';

-- Borrowers can opt out separately from upside alerts. Default ON;
-- max 3 DMs per loan lifetime means worst case is genuinely valuable.
ALTER TABLE user_prefs
  ADD COLUMN IF NOT EXISTS notify_downside_alerts BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN user_prefs.notify_downside_alerts IS
  'Opt-out flag for proactive downside DMs from Pip. Default TRUE; pairs
   with notify_upside_alerts. Users toggle via /notify.';
