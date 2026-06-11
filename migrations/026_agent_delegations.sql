-- agent_delegations — per-(user, agent) grants for x402-mediated actions.
--
-- A TG user runs /agent-authorize once to grant a specific agent pubkey
-- a bounded right to perform an action (initially: arm limit-close
-- orders) on the user's behalf. The x402 endpoint validates incoming
-- agent requests against this table BEFORE writing any state.
--
-- Bounds, not blanket trust. Every delegation row carries explicit
-- caps the agent cannot exceed:
--   max_per_order_lamports — single-order notional ceiling
--   max_active_orders     — how many orders the agent can have armed
--                           concurrently for this user
--   max_slippage_bps      — slippage cap for any order the agent arms
--   expires_at            — auto-revoke after this time
--
-- The user can revoke at any time via /agent-revoke. Revocation is
-- soft (status='revoked') so we keep an audit trail. The engine and
-- the x402 endpoint MUST treat any status != 'active' as "no grant".

CREATE TABLE IF NOT EXISTS agent_delegations (
  id                       SERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL REFERENCES users(id),
  user_wallet              TEXT NOT NULL,           -- borrower wallet the grant applies to
  agent_pubkey             TEXT NOT NULL,           -- the agent's Solana pubkey (proven via x402 payment)
  action                   TEXT NOT NULL
                           CHECK (action IN ('limit_close')),

  -- Constraints the agent cannot exceed
  max_per_order_lamports   NUMERIC(20,0) NOT NULL DEFAULT 10000000000,  -- 10 SOL
  max_active_orders        INTEGER NOT NULL DEFAULT 5,
  max_slippage_bps         INTEGER NOT NULL DEFAULT 500
                           CHECK (max_slippage_bps >= 10 AND max_slippage_bps <= 1000),

  -- Lifecycle
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','revoked','expired')),
  granted_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ,  -- nullable = no expiration
  revoked_at               TIMESTAMPTZ,
  revoked_by               TEXT,         -- 'user' | 'operator' | 'system'

  -- Audit
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active delegation per (user_wallet, agent, action) tuple. A
-- second /agent-authorize with the same tuple updates the existing
-- row instead of stacking. UNIQUE partial index enforces this at
-- the storage layer.
CREATE UNIQUE INDEX IF NOT EXISTS agent_delegations_one_active_idx
  ON agent_delegations(user_wallet, agent_pubkey, action) WHERE status = 'active';

-- Hot-path lookup for the x402 endpoint: given (user_wallet, agent,
-- action), is there an active grant?
CREATE INDEX IF NOT EXISTS agent_delegations_lookup_idx
  ON agent_delegations(user_wallet, agent_pubkey, action, status);

CREATE INDEX IF NOT EXISTS agent_delegations_user_idx
  ON agent_delegations(user_id, status);

-- updated_at touch trigger
CREATE OR REPLACE FUNCTION agent_delegations_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_delegations_updated_at ON agent_delegations;
CREATE TRIGGER trg_agent_delegations_updated_at
  BEFORE UPDATE ON agent_delegations
  FOR EACH ROW EXECUTE FUNCTION agent_delegations_touch_updated_at();
