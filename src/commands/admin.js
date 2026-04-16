import {
  isAdmin,
  pauseBorrowing,
  resumeBorrowing,
  isBorrowingPaused,
} from "../services/admin.js";
import { query } from "../db/pool.js";

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("❌ Not authorized.");
    return false;
  }
  return true;
}

export async function handlePause(ctx) {
  if (!(await requireAdmin(ctx))) return;
  pauseBorrowing();
  await ctx.reply("⏸ Borrowing paused. Existing loans unaffected.");
}

export async function handleResume(ctx) {
  if (!(await requireAdmin(ctx))) return;
  resumeBorrowing();
  await ctx.reply("▶️ Borrowing resumed.");
}

export async function handleAdminStatus(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM loans WHERE status = 'active') AS active,
       (SELECT COUNT(*) FROM loans WHERE status = 'liquidated') AS liquidated`,
  );
  const r = rows[0];
  const lines = [
    "🛠 *Admin*",
    "",
    `Borrowing: ${isBorrowingPaused() ? "⏸ PAUSED" : "▶️ open"}`,
    `Users:        ${r.users}`,
    `Active loans: ${r.active}`,
    `Liquidated:   ${r.liquidated}`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

export async function handleEnableMint(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const parts = ctx.message.text.split(/\s+/);
  // /enablemint <mint> <symbol> <decimals> [name]
  if (parts.length < 4) {
    return ctx.reply("Usage: `/enablemint <mint> <symbol> <decimals> [name]`", {
      parse_mode: "Markdown",
    });
  }
  const [, mint, symbol, decimalsStr, ...nameParts] = parts;
  const decimals = Number(decimalsStr);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return ctx.reply("❌ Invalid decimals.");
  }
  const name = nameParts.join(" ") || null;
  await query(
    `INSERT INTO supported_mints (mint, symbol, name, decimals, enabled)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (mint) DO UPDATE
       SET symbol = EXCLUDED.symbol,
           name = COALESCE(EXCLUDED.name, supported_mints.name),
           decimals = EXCLUDED.decimals,
           enabled = TRUE`,
    [mint, symbol.toUpperCase(), name, decimals],
  );
  await ctx.reply(`✅ ${symbol.toUpperCase()} enabled.`);
}

export async function handleDisableMint(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const arg = ctx.message.text.split(/\s+/)[1];
  if (!arg) return ctx.reply("Usage: `/disablemint <symbol or mint>`", { parse_mode: "Markdown" });
  const { rowCount } = await query(
    `UPDATE supported_mints SET enabled = FALSE
     WHERE UPPER(symbol) = UPPER($1) OR mint = $1`,
    [arg],
  );
  await ctx.reply(rowCount > 0 ? `✅ ${arg} disabled.` : `❌ ${arg} not found.`);
}
