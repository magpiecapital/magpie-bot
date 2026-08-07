/**
 * Schema Contract Monitor — catches silent write failures caused by schema drift.
 *
 * WHY THIS EXISTS. On 2026-08-07 the collectible submission feature was found to
 * have been broken since the day it shipped: the site wrote columns the table
 * didn't have, every INSERT failed, and NOBODY KNEW. The write is wrapped in a
 * best-effort try/catch — which is the right call for the user, because a
 * storage problem shouldn't cost a collector their answer — but it means total
 * feature failure is completely invisible. It was found by chance.
 *
 * The root cause is structural, not a one-off: the SITE writes these tables and
 * the BOT owns their schema, and nothing verified the two agreed. Any future
 * column rename, dropped migration, or half-applied deploy reintroduces exactly
 * the same silent failure.
 *
 * So the contract is declared here explicitly. If a column the writer depends on
 * goes missing, the operator hears about it in minutes instead of never.
 *
 * This deliberately checks SHAPE, not data. It answers "can the write succeed?",
 * which is the question that was being silently answered "no".
 */
import { query } from "../db/pool.js";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 4x/day — schema drift is a deploy-time event
const ADMIN_TG_ID = process.env.ADMIN_TELEGRAM_ID;

/**
 * Columns each cross-boundary table MUST have for its writer to work.
 *
 * Keep this in step with the writer, not with the migration: the point is to
 * detect the two disagreeing. If you add a column to an INSERT, add it here.
 */
const CONTRACTS = {
  // Written by magpie-site /api/submit-collectible, schema owned by migration 097.
  collectible_submissions: [
    "wallet", "contact", "grader", "cert", "card", "card_set", "card_year",
    "grade", "auto_grade", "platform", "verdict", "tier", "checks",
    "next_steps", "gate_version", "status", "source", "ip_hash", "ua_hash",
    "flags", "created_at",
  ],
  // Written by the retention job, schema owned by migration 098.
  collectible_submission_daily: [
    "day", "verdict", "tier", "platform", "submissions", "wallets", "updated_at",
  ],
};

/** Indexes whose UNIQUENESS is load-bearing for correctness, either way. */
const INDEX_EXPECTATIONS = [
  {
    table: "collectible_submissions",
    index: "collectible_submissions_cert_idx",
    unique: false,
    why: "one row per attempt — a UNIQUE index here silently discards the duplicate-cert fraud signal",
  },
];

let lastAlertKey = null;

async function findDrift() {
  const problems = [];

  for (const [table, required] of Object.entries(CONTRACTS)) {
    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1`,
      [table],
    );

    if (!rows.length) {
      problems.push(`${table}: table is MISSING (migration not applied?)`);
      continue;
    }

    const present = new Set(rows.map((r) => r.column_name));
    const missing = required.filter((c) => !present.has(c));
    if (missing.length) problems.push(`${table}: missing column(s) ${missing.join(", ")}`);
  }

  for (const exp of INDEX_EXPECTATIONS) {
    const { rows } = await query(
      `SELECT ix.indisunique AS uniq
         FROM pg_index ix
         JOIN pg_class i  ON i.oid = ix.indexrelid
         JOIN pg_class t  ON t.oid = ix.indrelid
         JOIN pg_namespace ns ON ns.oid = t.relnamespace
        WHERE ns.nspname = current_schema() AND t.relname = $1 AND i.relname = $2`,
      [exp.table, exp.index],
    );
    if (!rows.length) {
      problems.push(`${exp.table}: index ${exp.index} is missing`);
    } else if (rows[0].uniq !== exp.unique) {
      problems.push(
        `${exp.table}: index ${exp.index} is ${rows[0].uniq ? "UNIQUE" : "non-unique"}, expected ` +
          `${exp.unique ? "UNIQUE" : "non-unique"} — ${exp.why}`,
      );
    }
  }

  return problems;
}

async function tick(bot) {
  let problems;
  try {
    problems = await findDrift();
  } catch (err) {
    // The DB being unreachable is db-health's job to report, not ours.
    console.warn("[schema-contract] check failed:", err.message?.slice(0, 160));
    return;
  }

  if (!problems.length) {
    if (lastAlertKey) {
      console.log("[schema-contract] drift resolved");
      if (bot && ADMIN_TG_ID) {
        try {
          await bot.api.sendMessage(ADMIN_TG_ID, "*Schema contract restored*\n\nAll declared columns and indexes are present again.", { parse_mode: "Markdown" });
        } catch { /* non-critical */ }
      }
      lastAlertKey = null;
    }
    return;
  }

  console.error("[schema-contract] DRIFT:", problems.join(" | "));

  // Alert on change, not on every tick — a persistent drift shouldn't spam.
  const key = problems.join("|");
  if (key === lastAlertKey) return;
  lastAlertKey = key;

  if (bot && ADMIN_TG_ID) {
    try {
      await bot.api.sendMessage(
        ADMIN_TG_ID,
        "*Schema contract broken*\n\n" +
          problems.map((p) => `• ${p}`).join("\n") +
          "\n\nWrites against this table are probably failing SILENTLY — the writer swallows DB errors so the user still gets a response. Check the latest migration actually applied.",
        { parse_mode: "Markdown" },
      );
    } catch { /* non-critical */ }
  }
}

export function startSchemaContractMonitor(bot, intervalMs = CHECK_INTERVAL_MS) {
  tick(bot);
  return setInterval(() => tick(bot), intervalMs);
}

/** Exported for the one-shot check script. */
export { findDrift };
