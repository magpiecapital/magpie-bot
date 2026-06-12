-- migration 030: engine SOL topup tracking
--
-- The limit-close engine now front-funds the borrower's custodial wallet
-- with a small SOL reserve at fire time when the wallet is below
-- ENGINE_MIN_USER_SOL_LAMPORTS. The front-funding comes from the operator
-- topup wallet (env ENGINE_TOPUP_KEYPAIR — typically the same operator
-- wallet that holds PROTOCOL_FEE_DESTINATION). At settlement the engine
-- transfers that exact amount back from the user's wallet to the topup
-- source, so the protocol is made whole.
--
-- Without this column the topup is opaque: we couldn't reconcile, couldn't
-- show users why their net was smaller than expected, and couldn't alert
-- on a topup that never got reclaimed.
--
-- Why on limit_close_orders (not on the user/wallet row): each fire is its
-- own discrete event. A user with three TPs that each get topped up has
-- three distinct topups to reconcile. The per-order column also keeps the
-- topup auditable from the order id alone.
--
-- Why BIGINT: lamports. A reasonable topup is ~30M (0.03 SOL); BIGINT
-- gives us 9.2 quintillion lamports of headroom.

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS engine_topup_lamports BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS engine_topup_repaid_at TIMESTAMPTZ;

COMMENT ON COLUMN limit_close_orders.engine_topup_lamports IS
  'Lamports the engine transferred from the operator topup wallet to the
   borrower wallet at fire time to cover tx fees. Reclaimed from proceeds
   at settlement. 0 = no topup needed.';

COMMENT ON COLUMN limit_close_orders.engine_topup_repaid_at IS
  'When the engine repaid the topup back to the operator wallet after
   the swap settled. NULL while a topup is outstanding.';
