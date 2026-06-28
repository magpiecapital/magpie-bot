-- 090 — V4 chunked-selling (deterministic crash recovery, review HIGH-1).
--
-- Persist a mid-flight chunk's tx lastValidBlockHeight so the engine can decide
-- DETERMINISTICALLY when a not-found breadcrumb tx can never land — only clears
-- + retries the chunk once the chain's confirmed block height passes this value.
-- Wall-clock expiry is unsafe (slow slots stretch a blockhash's 150-slot life),
-- which could clear a late-confirming tx and re-fire it = double-sell. NULL
-- except while a V4 chunk is in flight (set at the pre-send claim, cleared on
-- record/expiry).
ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS twap_chunk_valid_until_height NUMERIC;
