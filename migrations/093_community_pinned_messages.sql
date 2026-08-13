-- migration 093: community pinned messages.
--
-- Pip must stay in lockstep with the operator's public announcements. When the
-- operator pins a post in the community group (e.g. "we chose Sec3"), Pip should
-- treat it as CURRENT authoritative state — not give a stale answer. This table
-- captures pinned messages (from pin events + boot-time getChat seeding); Pip
-- injects the recent ones into its answer context.
CREATE TABLE IF NOT EXISTS community_pinned_messages (
  chat_id     BIGINT NOT NULL,
  message_id  BIGINT NOT NULL,
  text        TEXT,
  pinned_by   TEXT,
  pinned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS community_pinned_recent_idx
  ON community_pinned_messages (chat_id, pinned_at DESC);
