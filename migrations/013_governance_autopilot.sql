-- Governance Autopilot — schema for the autonomous post-vote pipeline.
--
-- Tables:
--   governance_autopilot_state     — single-row kill-switch + last-run telemetry
--   governance_proposal_state      — runtime tally + outcome per proposal
--   governance_pipeline_log        — append-only audit trail
--   governance_announcements       — idempotency for per-proposal broadcasts
--   governance_config              — DB-backed config values that autopilot can update
--
-- Proposal definitions (title, implementation_plan, announcement_template,
-- quorum, threshold) live in code under src/governance/registry.js as the
-- versioned source of truth. The state tables below hold ONLY the runtime
-- state (closed_at, outcome, tally) so the autopilot can act idempotently
-- and the audit trail survives across deploys.

-- ── Kill switch ────────────────────────────────────────────────
-- Single-row state. Operator toggles via /gov-pause and /gov-resume admin
-- commands. Pipeline checks .enabled before every state-mutating action;
-- if false, halts at the next safe pre-mutation boundary and exits clean.
CREATE TABLE IF NOT EXISTS governance_autopilot_state (
  id                       smallint    PRIMARY KEY DEFAULT 1,
  enabled                  boolean     NOT NULL DEFAULT true,
  paused_by                text,       -- operator wallet pubkey or username that paused
  paused_at                timestamptz,
  paused_reason            text,
  last_run_at              timestamptz,
  last_run_status          text,       -- 'ok' | 'no_work' | 'halted' | 'error'
  last_run_detail          jsonb,
  CONSTRAINT singleton_row CHECK (id = 1)
);

INSERT INTO governance_autopilot_state (id, enabled)
VALUES (1, true)
ON CONFLICT (id) DO NOTHING;

-- ── Runtime state per proposal ─────────────────────────────────
-- Holds the autopilot's view of each proposal: when it was processed,
-- the final outcome, the full tally as jsonb (for audit reconstruction),
-- and any anomaly flags that caused a halt instead of execute.
CREATE TABLE IF NOT EXISTS governance_proposal_state (
  proposal_id              text        PRIMARY KEY,
  closed_at                timestamptz,
  outcome                  text,       -- 'passed' | 'failed' | 'anomaly_held' | 'pipeline_error'
  tally_json               jsonb,      -- {yes_weight, no_weight, participation_pct, threshold_pct, ...}
  anomaly_flags            text[],     -- empty array when clean; non-empty halts execution
  implementation_status    text,       -- 'not_required' | 'pending' | 'in_progress' | 'verified' | 'verification_failed'
  implementation_summary   jsonb,      -- per-action results
  announcement_status      text,       -- 'not_required' | 'pending_verification' | 'sent' | 'send_failed'
  pipeline_completed_at    timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_governance_proposal_state_outcome
  ON governance_proposal_state(outcome);

-- ── Append-only audit log ──────────────────────────────────────
-- Every meaningful step the pipeline takes writes a row here, with
-- input + output + duration. Append-only by convention — application
-- code never UPDATEs or DELETEs from this table. Use a partial unique
-- index on (proposal_id, step_name, run_id) to prevent duplicate inserts
-- from retries within the same run.
CREATE TABLE IF NOT EXISTS governance_pipeline_log (
  id                       bigserial   PRIMARY KEY,
  proposal_id              text        NOT NULL,
  run_id                   uuid        NOT NULL,    -- groups all rows from one pipeline run
  step_name                text        NOT NULL,    -- 'tally' | 'verify' | 'anomaly' | 'persist' | 'implement' | 'audit' | 'announce' | 'notify'
  status                   text        NOT NULL,    -- 'started' | 'ok' | 'failed' | 'halted' | 'skipped'
  detail                   jsonb,                   -- step-specific input/output payload
  error_message            text,
  duration_ms              integer,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_governance_pipeline_log_proposal
  ON governance_pipeline_log(proposal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_pipeline_log_run
  ON governance_pipeline_log(run_id);

-- ── Idempotency for community broadcasts ───────────────────────
-- The announcement step inserts here BEFORE sending; the unique constraint
-- guarantees one announcement per (proposal_id, outcome). Even with crash
-- recovery + retries, a duplicate broadcast cannot happen.
CREATE TABLE IF NOT EXISTS governance_announcements (
  proposal_id              text        NOT NULL,
  outcome                  text        NOT NULL,
  chat_id                  text        NOT NULL,
  message_id               bigint,                  -- telegram message id, filled after successful send
  rendered_text_sha256     text        NOT NULL,    -- hash of the rendered template — proves the EXACT message sent
  send_status              text        NOT NULL,    -- 'pending' | 'sent' | 'failed'
  sent_at                  timestamptz,
  error_message            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, outcome, chat_id)
);

-- ── DB-backed config that the autopilot can update on a passed vote ─
-- For DB-config-level changes, the autopilot updates rows here.
-- Code reads these values at runtime via a small accessor module.
-- Code-level constants (BPS values that live in JS files) are handled
-- via auto-PR (separate path); this table covers "soft" config that
-- doesn't require a code deploy.
CREATE TABLE IF NOT EXISTS governance_config (
  config_key               text        PRIMARY KEY,
  config_value             jsonb       NOT NULL,
  set_by_proposal_id       text,        -- null for genesis values, proposal_id for autopilot updates
  set_at                   timestamptz NOT NULL DEFAULT now(),
  previous_value           jsonb,       -- captured at set time for rollback / audit
  description              text
);

-- Genesis config — values that match CURRENT economics (pre-MGP-002).
-- A passed MGP-002 vote would UPDATE these rows; before any update,
-- previous_value gets captured atomically for rollback.
INSERT INTO governance_config (config_key, config_value, description) VALUES
  ('protocol_fee_bps_v1',        '2000'::jsonb,  'On-chain protocol fee bps for v1/v2 LendingPool (read-only — actual change requires program-level update)'),
  ('holder_reward_bps',          '1000'::jsonb,  'Bot-tracked holder pool accrual bps. Code reads from here; default matches HOLDER_REWARD_BPS constant.'),
  ('lp_loyalty_reward_bps',       '200'::jsonb,  'Bot-tracked LP loyalty accrual bps.'),
  ('referral_reward_bps',         '500'::jsonb,  'Bot-tracked referral accrual bps.'),
  ('whale_cap_bps_distribution', '200'::jsonb,   '2% cap on any single wallet in a distribution.'),
  ('whale_cap_bps_voting',        '200'::jsonb,  '2% cap on any single wallet in a governance vote.'),
  ('floor_lamports_distribution', '5000'::jsonb, 'Below this, skip the allocation as dust.'),
  ('autopilot_min_quorum_pct',    '10'::jsonb,   'Minimum participation as % of eligible weight to ratify a proposal.'),
  ('autopilot_min_threshold_pct', '66.6'::jsonb, 'Minimum yes share of cast votes to pass.'),
  ('engagement_multiplier_enabled', 'false'::jsonb, 'Whether to apply the §7 engagement multiplier on holder distributions.')
ON CONFLICT (config_key) DO NOTHING;
