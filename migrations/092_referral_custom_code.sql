-- migration 092: vanity referral codes.
--
-- The referral_codes table already stores `code TEXT UNIQUE` per user, so a
-- custom code is just an UPDATE of that column (with validation + uniqueness
-- enforced in app code). These columns add the metadata we need:
--   code_updated_at — powers the change cooldown (anti-squat churn)
--   is_custom       — did the user set a vanity code, or is it the auto one
ALTER TABLE referral_codes
  ADD COLUMN IF NOT EXISTS code_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT FALSE;
