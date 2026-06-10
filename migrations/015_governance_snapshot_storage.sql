-- Persist governance snapshots in DB so the bot (running on Railway / any
-- ephemeral filesystem) can query per-wallet voting weight without needing
-- access to the snapshot author's local disk.
--
-- The snapshot JSON file remains the operator-private master record on
-- disk (mode 0600); the DB stores a normalized, queryable mirror.

CREATE TABLE IF NOT EXISTS governance_snapshots (
  snapshot_id              text        PRIMARY KEY,
  proposal_id              text,
  taken_at_utc             timestamptz NOT NULL,
  hash_sha256              text        NOT NULL,
  scope_version            text        NOT NULL,
  totals                   jsonb       NOT NULL,
  total_eligible_weight    numeric     NOT NULL,  -- sum of held + collateralized across the eligible set
  unique_eligible_count    integer     NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- Per-wallet weights — O(1) lookup by (snapshot_id, wallet).
CREATE TABLE IF NOT EXISTS governance_snapshot_weights (
  snapshot_id              text        NOT NULL REFERENCES governance_snapshots(snapshot_id) ON DELETE CASCADE,
  wallet                   text        NOT NULL,
  held_raw                 numeric     NOT NULL DEFAULT 0,
  collateralized_raw       numeric     NOT NULL DEFAULT 0,
  lp_shares                numeric     NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_governance_snapshot_weights_wallet
  ON governance_snapshot_weights(wallet);
