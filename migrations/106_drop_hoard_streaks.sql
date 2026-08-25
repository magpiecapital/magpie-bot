-- Operator directive 2026-08-25: The Hoard stays DESIGN-ONLY — no
-- implementation in the protocol yet. Removes the Phase-1 shadow table
-- (derived state only; nothing referenced it for payouts).
DROP TABLE IF EXISTS hoard_streaks;
