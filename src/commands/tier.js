/**
 * /tier <symbol> <hot|warm|cold>
 * /tier                          — list current tier assignments
 *
 * Admin-only. Manages the attestation tier of a supported mint. The
 * tier controls how aggressively the bot keeps the mint's price feed
 * warm.
 *
 *   hot  → continuously attested every tick. Premium UX, top revenue
 *          drivers. ~$80-100/mo per mint in tx fees.
 *   warm → attested only when there's active borrower interest (active
 *          loan, armed exit, recent arm intent). Auto-cycles between
 *          warm and idle. Near-zero cost when no one's using it.
 *   cold → never continuously attested. Cosign-borrow's JIT warmer
 *          handles the first borrow (5-30s warmup). Long-tail tokens.
 *          ~$0 baseline + ~$0.02 per first-borrow.
 *
 * Operator-mandated 2026-06-19 PM (cost-conscious tiered model). The
 * prior "EVERY MINT EVERY SAMPLE ALWAYS" rule was supersized by this
 * tiered model after burn rate hit ~$11k/mo. See
 * [[feedback_tiered_attestation_cost_conscious]].
 *
 * Phase 1 (this command): sets the tier value in DB. ALL mints default
 * to 'hot' so behavior is unchanged. Phase 2 will update the attestor
 * loops to filter by tier — each demotion will take effect immediately.
 *
 * Usage:
 *   /tier              — show all enabled mints and their tier
 *   /tier SPCX hot     — promote SPCX to hot tier
 *   /tier PUMP cold    — demote PUMP to cold tier
 */
import { query } from "../db/pool.js";
import { isAdmin } from "../services/admin.js";

const VALID_TIERS = new Set(["hot", "warm", "cold"]);

export async function handleTier(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    return ctx.reply("Admin only.");
  }

  const text = (ctx.message?.text || "").trim();
  const parts = text.split(/\s+/).slice(1); // strip "/tier"

  if (parts.length === 0) {
    return await listTiers(ctx);
  }

  if (parts.length !== 2) {
    return ctx.reply(
      "Usage:\n" +
        "  `/tier` — list current tier assignments\n" +
        "  `/tier <symbol> <hot|warm|cold>` — set a mint's tier",
      { parse_mode: "Markdown" },
    );
  }

  const [symbolArg, tierArg] = parts;
  const symbol = symbolArg.replace(/^\$/, "").toUpperCase();
  const newTier = tierArg.toLowerCase();

  if (!VALID_TIERS.has(newTier)) {
    return ctx.reply(
      `Invalid tier: \`${tierArg}\`. Allowed: hot, warm, cold`,
      { parse_mode: "Markdown" },
    );
  }

  // Find the mint by symbol — exact, case-insensitive
  const { rows } = await query(
    `SELECT mint, symbol, category, attestation_tier
       FROM supported_mints
      WHERE UPPER(symbol) = $1 AND enabled = TRUE`,
    [symbol],
  );

  if (rows.length === 0) {
    return ctx.reply(
      `No enabled supported_mints row matched symbol \`${symbol}\`. ` +
        `Note: some symbols have multiple mints (memecoin + xStock).`,
      { parse_mode: "Markdown" },
    );
  }

  if (rows.length > 1) {
    const choices = rows
      .map(
        (r, i) =>
          `${i + 1}. \`${r.mint.slice(0, 12)}...\` (${r.category}) — currently ${r.attestation_tier}`,
      )
      .join("\n");
    return ctx.reply(
      `Multiple mints matched symbol \`${symbol}\`:\n${choices}\n\n` +
        `Pass the mint directly with /tier-mint <full-mint> <tier> to disambiguate.`,
      { parse_mode: "Markdown" },
    );
  }

  const row = rows[0];
  const fromTier = row.attestation_tier;

  if (fromTier === newTier) {
    return ctx.reply(
      `\`${symbol}\` is already on tier \`${newTier}\`. No change.`,
      { parse_mode: "Markdown" },
    );
  }

  // Safety check: demoting a mint with active borrower activity is
  // potentially risky. The Phase 2 SQL auto-includes any mint with
  // borrower activity (regardless of tier), but the operator should
  // still know they're demoting a mint that's currently in use.
  if (newTier === "cold" || newTier === "warm") {
    const { rows: activity } = await query(
      `SELECT
         (SELECT COUNT(*) FROM loans WHERE collateral_mint = $1 AND status = 'active') AS active_loans,
         (SELECT COUNT(*) FROM limit_close_orders lc
            JOIN loans l ON l.id = lc.loan_id
           WHERE l.collateral_mint = $1
             AND lc.status IN ('armed', 'firing', 'twap_in_progress', 'firing_started')
         ) AS armed_orders`,
      [row.mint],
    );
    const al = Number(activity[0]?.active_loans || 0);
    const ao = Number(activity[0]?.armed_orders || 0);
    if (al > 0 || ao > 0) {
      // Don't refuse — just warn. The SQL auto-includes anyway.
      // (Bot side: the attestor loops include any mint with activity
      //  regardless of tier setting, so this is safe even if demoted.)
      // But the operator should KNOW so they can make an informed call.
      // ... continue and log the warning in the response below.
      row._activity_warning = `⚠ ${al} active loan(s) + ${ao} armed order(s) on this mint. ` +
        `Continuous attestation will still happen automatically for them — ` +
        `the tier change only affects mints with NO borrower activity. Safe to proceed.`;
    }
  }

  // Atomic update + audit trail
  const changedBy =
    ctx.from?.username || ctx.from?.id?.toString() || "unknown";
  await query("BEGIN");
  try {
    await query(
      `UPDATE supported_mints SET attestation_tier = $1 WHERE mint = $2`,
      [newTier, row.mint],
    );
    await query(
      `INSERT INTO supported_mints_tier_changes
         (mint, from_tier, to_tier, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.mint, fromTier, newTier, changedBy, "tg /tier command"],
    );
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK").catch(() => {});
    throw err;
  }

  const warning = row._activity_warning ? `\n\n${row._activity_warning}` : "";
  return ctx.reply(
    `✓ \`${symbol}\` (${row.category}): ${fromTier} → **${newTier}**\n` +
      `mint: \`${row.mint.slice(0, 12)}...\`\n` +
      `Audit row inserted. Takes effect next attestor tick.${warning}`,
    { parse_mode: "Markdown" },
  );
}

async function listTiers(ctx) {
  const { rows } = await query(
    `SELECT symbol, category, attestation_tier,
            COUNT(*) OVER (PARTITION BY attestation_tier) AS tier_count
       FROM supported_mints
      WHERE enabled = TRUE
      ORDER BY
        CASE attestation_tier
          WHEN 'hot' THEN 1
          WHEN 'warm' THEN 2
          WHEN 'cold' THEN 3
        END,
        symbol`,
  );

  if (rows.length === 0) {
    return ctx.reply("No enabled mints found.");
  }

  // Group + summarize
  const byTier = { hot: [], warm: [], cold: [] };
  for (const r of rows) {
    byTier[r.attestation_tier]?.push(`${r.symbol} (${r.category})`);
  }

  const lines = [
    `*Attestation tier summary*`,
    ``,
    `🔥 *hot* (always attested, ~$80/mo each): ${byTier.hot.length}`,
    byTier.hot.length > 0
      ? byTier.hot.slice(0, 30).join(", ") +
        (byTier.hot.length > 30 ? `, ... +${byTier.hot.length - 30} more` : "")
      : "_(none)_",
    ``,
    `🌤 *warm* (active-loan only, ~$0 idle): ${byTier.warm.length}`,
    byTier.warm.length > 0
      ? byTier.warm.slice(0, 20).join(", ") +
        (byTier.warm.length > 20 ? `, ... +${byTier.warm.length - 20} more` : "")
      : "_(none)_",
    ``,
    `❄️ *cold* (JIT only, ~$0 baseline): ${byTier.cold.length}`,
    byTier.cold.length > 0
      ? byTier.cold.slice(0, 20).join(", ") +
        (byTier.cold.length > 20 ? `, ... +${byTier.cold.length - 20} more` : "")
      : "_(none)_",
    ``,
    `Total: ${rows.length} enabled mints`,
    ``,
    `Set with: \`/tier <symbol> <hot|warm|cold>\``,
  ];

  return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
