-- 102 · Carry forward rewards that Solana physically could not deliver.
--
-- WHY. Solana refuses a transfer that would leave an account below the
-- rent-exempt minimum (~0.00089088 SOL). In distribution #9 (2026-08-13) the
-- holder pool had shrunk to 0.3947 SOL across 1,433 holders — an average reward
-- of 0.000275 SOL, about a third of that floor — and 319 holders with empty
-- wallets could not be paid at all. Their 0.004773 SOL was written off and
-- stayed in CHCAM.
--
-- Writing it off means those holders never receive it, and the same wallets
-- fail again every cycle: the amount is always too small, so it is always
-- forfeited. This table breaks that loop by accumulating what they were owed
-- until it is large enough to actually send (or until their wallet is funded,
-- at which point any amount goes through).
--
-- IMPORTANT — this is NOT part of the pool. The pool was already decremented
-- when these rewards were first allocated, and the SOL is already sitting in
-- CHCAM. A carried balance is therefore paid FROM that existing balance and
-- must never be added to `allocatedSum` when the next distribution decrements
-- the pool, or the pool would be double-charged.
--
-- Only the 319 genuinely-undeliverable rows carry. Holders below the rent floor
-- whose wallets are funded are paid normally and never touch this table —
-- measured: 1,028 of the 1,347 sub-rent holders in dist #9 were paid fine.

CREATE TABLE IF NOT EXISTS magpie_holder_carryforward (
  wallet_address   TEXT PRIMARY KEY,

  -- Undeliverable rewards accumulated so far. Added on top of the wallet's
  -- pro-rata share at the next capture, and reset to 0 once actually paid.
  lamports         BIGINT NOT NULL DEFAULT 0 CHECK (lamports >= 0),

  -- Diagnostics: how long this holder has been waiting, and across how many
  -- distributions. If cycles climbs without the balance ever clearing, the
  -- floor is beating the accrual rate and the policy needs revisiting.
  cycles           INT NOT NULL DEFAULT 0,
  first_carried_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The capture path loads every non-zero carry in one read.
CREATE INDEX IF NOT EXISTS magpie_holder_carryforward_nonzero_idx
  ON magpie_holder_carryforward (wallet_address)
  WHERE lamports > 0;

COMMENT ON TABLE magpie_holder_carryforward IS
  'Rewards that could not be delivered because the transfer would leave the recipient below the rent-exempt minimum. Accumulates until payable. NOT part of magpie_holder_pool — the pool was already decremented and this SOL already sits in CHCAM.';
COMMENT ON COLUMN magpie_holder_carryforward.lamports IS
  'Owed to this wallet from prior undeliverable payouts. Added to their next allocation; zeroed once paid.';
