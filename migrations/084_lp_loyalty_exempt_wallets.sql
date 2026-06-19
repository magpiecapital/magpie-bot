-- 084_lp_loyalty_exempt_wallets.sql
--
-- LP loyalty exemption list. Wallets in this table are excluded from
-- LP loyalty snapshots so they never receive a payout share even when
-- their lp_positions row has positive shares × seconds weight.
--
-- Created 2026-06-19 to exempt the operator's lender wallet
-- (4JSSSaG3...zPAx) which holds the largest LP position by formula
-- but is operator's own money. Paying it would be operator-to-operator
-- round-tripping that obscures the real third-party LP payouts.
--
-- Mirrors the airdrop_exempt_wallets pattern used by $MAGPIE holder
-- rewards.
--
-- See [[feedback_lender_wallet_exempt_from_lp_loyalty]] for the rule
-- and economic rationale.
CREATE TABLE IF NOT EXISTS lp_loyalty_exempt_wallets (
  wallet_address TEXT PRIMARY KEY,
  reason         TEXT,
  added_by       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the lender wallet exemption.
INSERT INTO lp_loyalty_exempt_wallets (wallet_address, reason, added_by)
VALUES (
  '4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx',
  'operator lender wallet — funds protocol LP, paying it would be operator-to-operator round-trip',
  'migration 084 / operator-mandated 2026-06-19'
) ON CONFLICT (wallet_address) DO NOTHING;
