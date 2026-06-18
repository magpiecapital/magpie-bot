-- Privileged-keypair signing audit log.
--
-- Every service that signs a tx with a protocol-privileged keypair
-- (LENDER_PRIVATE_KEY, ENGINE_AUTHORITY_V4_PRIVATE_KEY, etc.) writes a
-- row here BEFORE broadcast and updates it AFTER confirmation. The row
-- captures what the service expected to happen so a self-monitor probe
-- can later sum-of-expected vs actual-on-chain and crit-alert on drift.
--
-- If a tx ever lands on-chain WITHOUT a matching audit row, that's the
-- smoking gun for code injection or a leaked keypair — something signed
-- outside our code paths.
--
-- Shipped 2026-06-18 PM as part of the post-cosign-borrow-exploit
-- hardening pass. See
-- feedback_cosign_borrow_token_drain_exploit_2026_06_18.md.

CREATE TABLE IF NOT EXISTS privileged_sign_audit (
  id BIGSERIAL PRIMARY KEY,
  -- The bot-internal service that requested the sign
  service TEXT NOT NULL,
  -- The privileged keypair's public key (so a reader can scope to
  -- "all lender activity" or "all engine-authority activity")
  signer_pubkey TEXT NOT NULL,
  -- Pre-state snapshot of the accounts the service expected to touch.
  -- Keyed by pubkey string, value is { lamports, token?: { mint, amount } }.
  pre_balances JSONB,
  -- The service's declaration of which accounts may change and by how
  -- much. Format: [{ pubkey, max_lamports_decrease?, max_token_decrease? }]
  expected_deltas JSONB,
  -- Filled in after simulation/broadcast/confirmation.
  actual_deltas JSONB,
  -- After successful broadcast, the tx signature.
  tx_sig TEXT,
  -- Lifecycle:
  --   'pending'        — row created, sim not yet run
  --   'sim_passed'     — sim cleared, about to broadcast
  --   'sim_rejected'   — sim caught a balance-delta violation, refused to broadcast
  --   'broadcast'      — sent to network, awaiting confirmation
  --   'confirmed'      — confirmed on-chain
  --   'failed'         — broadcast or confirmation errored
  status TEXT NOT NULL DEFAULT 'pending',
  error_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  broadcast_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_privileged_sign_audit_service_created
  ON privileged_sign_audit (service, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_privileged_sign_audit_signer_created
  ON privileged_sign_audit (signer_pubkey, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_privileged_sign_audit_tx_sig
  ON privileged_sign_audit (tx_sig)
  WHERE tx_sig IS NOT NULL;
