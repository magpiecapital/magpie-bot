/**
 * /sitedisable [reason]  — operator: stop every site signed endpoint.
 * /siteenable            — operator: turn signed endpoints back on.
 * /sitestate             — operator: show current state.
 *
 * Use during incident response (bot compromise suspicion, unexpected
 * activity surge, planned maintenance). Different from per-user /lock:
 * affects all linked accounts at once.
 */
import { isAdmin } from "../services/admin.js";
import {
  getGlobalSiteState,
  setGlobalSiteDisabled,
} from "../services/site-global.js";

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("❌ Not authorized.");
    return false;
  }
  return true;
}

function fmtTime(t) {
  if (!t) return "?";
  return new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export async function handleSiteDisable(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const text = ctx.message?.text || "";
  const reason = text.split(/\s+/).slice(1).join(" ").trim() || null;

  await setGlobalSiteDisabled({
    disabled: true,
    reason,
    setBy: ctx.from?.username || String(ctx.from?.id),
  });

  await ctx.reply(
    [
      "🛑 *Site signed endpoints DISABLED globally.*",
      "",
      reason ? `Reason: ${reason}` : "(no reason given)",
      "",
      "Every signed endpoint will reject with 503 until you run /siteenable.",
      "Per-user /lock and TG commands are unaffected.",
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}

export async function handleSiteEnable(ctx) {
  if (!(await requireAdmin(ctx))) return;
  await setGlobalSiteDisabled({
    disabled: false,
    reason: null,
    setBy: ctx.from?.username || String(ctx.from?.id),
  });
  await ctx.reply("✅ Site signed endpoints re-enabled.");
}

export async function handleSiteState(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const s = await getGlobalSiteState();
  await ctx.reply(
    [
      `*Site state:* ${s.disabled ? "🛑 DISABLED" : "✅ enabled"}`,
      s.reason ? `Reason: ${s.reason}` : null,
      s.set_by ? `Last set by: ${s.set_by}` : null,
      s.set_at ? `Set at: ${fmtTime(s.set_at)}` : null,
    ].filter(Boolean).join("\n"),
    { parse_mode: "Markdown" },
  );
}
