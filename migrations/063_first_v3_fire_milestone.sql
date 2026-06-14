-- migration 063: seed first_v3_fire milestone flag
--
-- Pairs with src/services/limit-close-first-v3-fire-watcher.js.
-- The watcher polls every 5 min for the OLDEST successful V3 fire and
-- DMs the operator a one-shot celebration. It also alerts on V3 fire
-- failures so the operator hears about a broken executeRepayLoanV3
-- path BEFORE a real user does.
--
-- V3 went live for RWA + memecoin dual-tier on 2026-06-13. Arm flow
-- correctly stamps engine_program_id=V3 on V3-loan orders. The fill
-- path lives in the external magpie-limitclose engine — this
-- watcher is the bot-side proof the engine's V3 path is working
-- end-to-end on real chain state.

INSERT INTO engine_milestone_flags (milestone_key, notes)
VALUES (
  'first_v3_fire',
  'First successful limit-close fire on the V3 lending program (RWA or memecoin) — celebrated once.'
)
ON CONFLICT (milestone_key) DO NOTHING;

INSERT INTO engine_milestone_flags (milestone_key, notes)
VALUES (
  'first_v3_fire_failure',
  'First observed V3 limit-close fire failure — operator alerted with full row details so the engine path can be debugged before more orders pile up.'
)
ON CONFLICT (milestone_key) DO NOTHING;
