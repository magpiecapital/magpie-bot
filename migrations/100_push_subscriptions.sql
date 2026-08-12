-- 100 · Web-push subscriptions — a warning channel for borrowers with no Telegram.
--
-- WHY. Loan-expiry warnings go out by Telegram DM and nothing else. A borrower
-- who opened their loan on the website has an auto-bootstrapped account with a
-- synthetic NEGATIVE telegram_id and no real Telegram behind it, so every DM to
-- them fails `chat not found`. Measured over 90 days: of borrowers who reached
-- the 24h warning window, 68/71 Telegram users were warned versus 1/72
-- site-only users, and all nine borrowers liquidated with no warning at all
-- were site-only.
--
-- PRIVACY. Nothing here identifies a person. `endpoint` is a URL the browser's
-- push service issues — a capability, not an identity — and p256dh/auth are the
-- public halves of the message-encryption keypair. No email, no phone, no name.
-- That is why this channel was chosen over email.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The push service's URL for this browser. UNIQUE because re-subscribing the
  -- same browser must update the existing row, never accumulate duplicates that
  -- would deliver the same warning several times.
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,

  -- Wallet that signed the subscribe envelope. Kept for audit only; user_id is
  -- what delivery joins on.
  signer_wallet   TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,

  -- Consecutive delivery failures. A push service returning 404/410 means the
  -- subscription is permanently dead (browser uninstalled, permission revoked);
  -- those are revoked immediately rather than counted.
  failure_count   INT NOT NULL DEFAULT 0,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT
);

-- Delivery looks up live subscriptions for one user. Partial so the index stays
-- small as revoked rows accumulate.
CREATE INDEX IF NOT EXISTS push_subscriptions_user_live_idx
  ON push_subscriptions (user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE push_subscriptions IS
  'Web-push endpoints for loan-expiry warnings. Contains no PII: endpoint is a browser-issued capability URL, p256dh/auth are public encryption material.';
COMMENT ON COLUMN push_subscriptions.revoked_at IS
  'Set when the push service reports the subscription permanently gone (404/410) or the user unsubscribes. Never delivered to again.';
