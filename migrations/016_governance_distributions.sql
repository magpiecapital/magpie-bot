-- Per-wallet distribution allocations + on-chain send tracking.
-- Used by the dashboard to surface "your expected SOL" pre-execution
-- and "sent — view tx" post-execution.

CREATE TABLE IF NOT EXISTS governance_distributions (
  proposal_id              text        NOT NULL,
  wallet                   text        NOT NULL,
  weight_raw               numeric     NOT NULL,
  allocated_lamports       numeric     NOT NULL,
  tx_signature             text,
  sent_at                  timestamptz,
  status                   text        NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'failed'
  failure_reason           text,
  plan_hash                text        NOT NULL,
  snapshot_hash            text        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_governance_distributions_wallet
  ON governance_distributions(wallet);
CREATE INDEX IF NOT EXISTS idx_governance_distributions_status
  ON governance_distributions(proposal_id, status);
