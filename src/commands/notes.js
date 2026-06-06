/**
 * Operator notepad. Persists across deploys + restarts.
 *
 *   /note <text>         — append a note
 *   /notes               — show the last 20 notes
 *   /notedel <id>        — delete a note by id
 *
 * Useful for "remember to backfill X tomorrow", incident write-ups,
 * todo lists, etc. Plain DB-backed text, no parsing.
 */
import { isAdmin } from "../services/admin.js";
import { query } from "../db/pool.js";

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("❌ Not authorized.");
    return false;
  }
  return true;
}

function ageStr(date) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

export async function handleNote(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const text = (ctx.message?.text || "").split(/\s+/).slice(1).join(" ").trim();
  if (!text) {
    return ctx.reply("Usage: `/note <text>`", { parse_mode: "Markdown" });
  }
  const setBy = ctx.from?.username ? `@${ctx.from.username}` : `#${ctx.from?.id}`;
  const { rows: [row] } = await query(
    `INSERT INTO admin_notes(note, set_by) VALUES ($1, $2) RETURNING id`,
    [text, setBy],
  );
  await ctx.reply(`📝 Note #${row.id} saved.`);
}

export async function handleNotes(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const { rows } = await query(
    `SELECT id, note, set_by, created_at
       FROM admin_notes
      ORDER BY created_at DESC
      LIMIT 20`,
  );
  if (rows.length === 0) {
    return ctx.reply("📭 No notes yet. Add one: `/note <text>`", { parse_mode: "Markdown" });
  }
  const lines = ["📝 *Recent notes*", ""];
  for (const r of rows) {
    lines.push(`*#${r.id}* (${ageStr(r.created_at)}, ${r.set_by || "?"})`);
    lines.push(`  ${r.note}`);
  }
  lines.push("", "_Use `/notedel <id>` to delete._");
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

export async function handleNoteDel(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const arg = (ctx.message?.text || "").split(/\s+/)[1];
  const id = Number(arg);
  if (!Number.isFinite(id) || id <= 0) {
    return ctx.reply("Usage: `/notedel <id>`", { parse_mode: "Markdown" });
  }
  const { rowCount } = await query(`DELETE FROM admin_notes WHERE id = $1`, [id]);
  if (rowCount === 0) {
    return ctx.reply(`Note #${id} not found.`);
  }
  await ctx.reply(`🗑 Note #${id} deleted.`);
}
