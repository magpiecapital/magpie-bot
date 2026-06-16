-- migration 071: arm_intents — server-side ledger of user exit-arm intent
--
-- Operator-mandated 2026-06-16 PM (feedback_every_arm_envelope_must_
-- reach_server.md). The CLIENT-SIDE auto-arm chain (preBorrowExits
-- state → useEffect → Phantom signMessage → fetch /arm) was too
-- fragile as the only record of user intent. Loan 800 PUMP V4 was
-- routed to V4 (proving the picker DID set exit intent) but NO
-- arm_attempts row exists — the chain silently failed between
-- borrow-confirmed and signMessage. Server had no idea.
--
-- This table is the FIRST record. When the user clicks any exit
-- option site-wide, the site POSTs a lightweight intent beacon BEFORE
-- Phantom is invoked. The beacon needs no signature — it's intent,
-- not authoritative state. Then the standard signed arm flow runs;
-- on success, the intent's status flips to 'armed' with order_id
-- stamped. On failure (or silent dropout), the intent remains
-- 'pending' and the dashboard surfaces a recovery banner with
-- one-click retry.

CREATE TABLE IF NOT EXISTS arm_intents (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id),       -- nullable until wallet→user link resolves
  wallet TEXT NOT NULL,
  loan_id_chain TEXT NOT NULL,               -- on-chain loan_id matched against loans.loan_id::text
  direction TEXT NOT NULL CHECK (direction IN ('above','below')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('multiplier','price_usd','mc_usd','price_sol','trailing')),
  -- For 'multiplier': raw multiplier * 1e6 (so 2x = 2000000)
  -- For 'price_usd' / 'mc_usd' / 'price_sol': micros as elsewhere
  -- For 'trailing': trailing distance in bps (stored as the value)
  target_value_micro NUMERIC,
  slice_pct_bps INT,                         -- nullable; 10000 = full close
  source TEXT NOT NULL CHECK (source IN ('site','tg','agent_x402','post_borrow_picker')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','armed','cancelled','failed')),
  order_id BIGINT REFERENCES limit_close_orders(id) ON DELETE SET NULL,
  error_code TEXT,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  armed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dashboard look-up: "what intents does this wallet have pending on
-- this loan?" The recovery banner reads this to know whether to
-- render the "Your auto-sell didn't finish — retry" surface.
CREATE INDEX IF NOT EXISTS arm_intents_wallet_loan_pending_idx
  ON arm_intents (wallet, loan_id_chain)
  WHERE status = 'pending';

-- Reconciliation cron: "what intents are still pending after N
-- minutes?" The bot's watchdog scans this and DMs the user.
CREATE INDEX IF NOT EXISTS arm_intents_pending_age_idx
  ON arm_intents (created_at)
  WHERE status = 'pending';

COMMENT ON TABLE arm_intents IS
  'Server-side ledger of user exit-arm intent, recorded at click time before any Phantom signing. Source of truth for "the user asked for an exit"; the limit_close_orders table is source of truth for "the user has an armed order." Dashboard reconciles intent vs orders to surface silent-failure gaps. Operator rule feedback_every_arm_envelope_must_reach_server.md.';
