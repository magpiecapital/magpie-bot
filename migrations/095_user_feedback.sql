-- migration 095: captured user feedback / DM replies.
--
-- When a user DMs the bot a plain conversational message that matches no command
-- — feedback, a question, or a reply to a winback/outreach DM — the fallback
-- handler now stores it here (in addition to forwarding it to the operator) so
-- replies are durable, searchable, and aggregatable instead of scrolling past in
-- a DM. Powers the operator-only /feedback command.
CREATE TABLE IF NOT EXISTS user_feedback (
  id                BIGSERIAL PRIMARY KEY,
  telegram_id       BIGINT,
  telegram_username TEXT,
  message           TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_feedback_recent_idx ON user_feedback (created_at DESC);
