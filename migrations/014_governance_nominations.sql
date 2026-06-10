-- User-driven governance nominations.
--
-- Anyone can submit a nomination ("I think Magpie should..."), other
-- users can signal interest via upvotes, the operator reviews the
-- top-N popular ones periodically and decides whether to promote
-- them into formal MGP-XXX proposals.
--
-- This is the SOFT layer before the autopilot pipeline kicks in:
-- nominations → operator review → proposal → vote → autopilot.

CREATE TABLE IF NOT EXISTS governance_nominations (
  id                       bigserial   PRIMARY KEY,
  nomination_text          text        NOT NULL,
  nominator_tg_id          text        NOT NULL,
  nominator_username       text,
  nominator_wallet         text,                    -- optional — populated if nominator has linked a wallet
  status                   text        NOT NULL DEFAULT 'pending',
                                                    -- 'pending'     — awaiting operator review
                                                    -- 'queued'      — operator marked it for future proposal
                                                    -- 'promoted'    — became MGP-XXX (see promoted_to_proposal_id)
                                                    -- 'rejected'    — operator declined; status_reason explains
                                                    -- 'withdrawn'   — nominator withdrew
                                                    -- 'duplicate'   — operator marked as dupe of another nomination
  status_reason            text,
  promoted_to_proposal_id  text,                    -- e.g. 'MGP-005' when status=promoted
  duplicate_of_id          bigint,                  -- references another nomination_id when status=duplicate
  upvote_count             integer     NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  reviewed_by              text,                    -- operator TG id who acted on it
  reviewed_at              timestamptz,
  CONSTRAINT nomination_text_len CHECK (char_length(nomination_text) BETWEEN 20 AND 1000)
);

CREATE INDEX IF NOT EXISTS idx_governance_nominations_status
  ON governance_nominations(status, upvote_count DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_nominations_nominator
  ON governance_nominations(nominator_tg_id);

-- Per-user upvotes — one user, one upvote per nomination, idempotent
CREATE TABLE IF NOT EXISTS governance_nomination_upvotes (
  nomination_id            bigint      NOT NULL REFERENCES governance_nominations(id) ON DELETE CASCADE,
  upvoter_tg_id            text        NOT NULL,
  upvoter_wallet           text,                    -- captured for voting-weight reporting (NOT counted as on-chain vote)
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (nomination_id, upvoter_tg_id)
);

CREATE INDEX IF NOT EXISTS idx_governance_nomination_upvotes_nom
  ON governance_nomination_upvotes(nomination_id);

-- Per-user rate limit ledger. Prevents nomination flooding.
CREATE TABLE IF NOT EXISTS governance_nomination_rate (
  nominator_tg_id          text        PRIMARY KEY,
  nominations_today        integer     NOT NULL DEFAULT 0,
  day_bucket               date        NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Trigger to auto-bump upvote_count when an upvote is inserted (atomic, no race)
CREATE OR REPLACE FUNCTION bump_nomination_upvotes() RETURNS TRIGGER AS $$
BEGIN
  UPDATE governance_nominations
     SET upvote_count = upvote_count + 1,
         updated_at = NOW()
   WHERE id = NEW.nomination_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_nomination_upvotes_trg ON governance_nomination_upvotes;
CREATE TRIGGER bump_nomination_upvotes_trg
  AFTER INSERT ON governance_nomination_upvotes
  FOR EACH ROW
  EXECUTE FUNCTION bump_nomination_upvotes();

-- Reverse trigger for DELETE (allow un-upvote, decrement count)
CREATE OR REPLACE FUNCTION drop_nomination_upvotes() RETURNS TRIGGER AS $$
BEGIN
  UPDATE governance_nominations
     SET upvote_count = GREATEST(0, upvote_count - 1),
         updated_at = NOW()
   WHERE id = OLD.nomination_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS drop_nomination_upvotes_trg ON governance_nomination_upvotes;
CREATE TRIGGER drop_nomination_upvotes_trg
  AFTER DELETE ON governance_nomination_upvotes
  FOR EACH ROW
  EXECUTE FUNCTION drop_nomination_upvotes();
