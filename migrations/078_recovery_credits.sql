-- Protocol recovery / contribution events.
--
-- Some events bring SOL into the rewards-distributor wallet OUTSIDE the
-- normal "liquidation → sale → distribute" pipeline. The first instance:
-- the 2026-06-18 cosign-borrow Token-2022 exploit recovery. The operator
-- manually deposited 4 SOL to the rewards distributor (CHCAMWtn…) and
-- wants it counted in the "profitable defaults" totals + flow through the
-- same 80/10/10 (holder / LP-loyalty / protocol-reserve) split.
--
-- Rather than pollute liquidation_economics with synthetic NULL-loan_id
-- rows, this table exists for these out-of-band credit events. The
-- distribution-watcher picks up rows with distribution_status =
-- 'awaiting_distribution' and credits the pool ledgers the same way it
-- does for liquidation_economics rows. The /stats query UNIONs both
-- tables for the public "profitable defaults" headline.
--
-- Future kinds: 'protocol_contribution', 'goodwill', 'audit_bounty',
-- whatever editorial bucket fits.

CREATE TABLE IF NOT EXISTS recovery_credits (
  id BIGSERIAL PRIMARY KEY,
  -- 'exploit_recovery' | 'protocol_contribution' | ...
  kind TEXT NOT NULL,
  -- Human-readable for /stats + audit-trail surfaces.
  description TEXT NOT NULL,
  -- On-chain deposit tx signature if known. UNIQUE so the migration is
  -- idempotent and a re-run can't double-credit.
  source_tx_sig TEXT UNIQUE,
  -- The credit amount (SOL deposited that flows to users).
  amount_lamports BIGINT NOT NULL CHECK (amount_lamports > 0),
  -- Split fields — filled in by the distribution-watcher after the
  -- 80/10/10 split is applied. Same shape as liquidation_economics.
  holder_share_lamports BIGINT,
  lp_loyalty_share_lamports BIGINT,
  protocol_reserve_share_lamports BIGINT,
  distribution_status TEXT NOT NULL DEFAULT 'awaiting_distribution'
    CHECK (distribution_status IN ('awaiting_distribution', 'distributing', 'distributed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  distributed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recovery_credits_distribution_status
  ON recovery_credits (distribution_status, created_at);

-- Seed the 2026-06-18 cosign-borrow exploit recovery row.
-- 4 SOL deposited by the operator to CHCAMWtn… (rewards distributor)
-- as goodwill restitution after the Token-2022 drain ($528 loss).
-- ON CONFLICT prevents double-insert if the migration ever re-runs.
INSERT INTO recovery_credits (
  kind, description, source_tx_sig, amount_lamports
) VALUES (
  'exploit_recovery',
  'Operator-funded recovery after the 2026-06-18 cosign-borrow Token-2022 drain exploit. 4 SOL deposited to the rewards distributor wallet (CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac) and credited to the holder / LP-loyalty / protocol-reserve pools via the same 80/10/10 split that profitable defaults use.',
  'OPERATOR_DEPOSIT_2026_06_18_EXPLOIT_RECOVERY_4_SOL',
  4000000000
)
ON CONFLICT (source_tx_sig) DO NOTHING;
