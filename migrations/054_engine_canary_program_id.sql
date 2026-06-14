-- migration 054: tag engine_canary_runs rows with the program the
-- template loan belonged to.
--
-- Engine canary picks a recent loan as the canary template and exercises
-- the fire-path read surface (Jupiter quote, cross-source agreement,
-- borrower wallet load, Solana program reachable). Before this change it
-- picked the SINGLE most-recent loan regardless of program — so a quiet
-- V2 (RWA) pool stretch meant the canary never exercised V2's fire path,
-- and a V2 outage would go undetected.
--
-- Engine PR (paired with this migration) picks ONE template per pool per
-- tick: one V1, one V2. Two rows per cycle when both pools have eligible
-- templates. Operator can drill into per-pool health via /lc-perf.
--
-- Nullable: pre-PR rows have NULL — engine treats NULL as legacy V1 for
-- back-compat with the historical canary.

ALTER TABLE engine_canary_runs
  ADD COLUMN IF NOT EXISTS program_id text;

CREATE INDEX IF NOT EXISTS engine_canary_runs_program_id_run_at_idx
  ON engine_canary_runs(program_id, run_at DESC)
  WHERE program_id IS NOT NULL;

COMMENT ON COLUMN engine_canary_runs.program_id IS
  'Solana program the canary template loan belonged to. V1 (memecoin)
   or V2 (RWA). NULL = pre-2026-06-13 canary (treated as legacy V1).
   Operator-facing /lc-perf will eventually split health by program
   so a V2-pool degradation surfaces independently of V1.';
