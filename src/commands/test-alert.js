/**
 * /testalert — let the user fire a fake security alert at themselves
 * so they can verify they'd actually receive one if a real signed
 * action fires.
 *
 * Useful right after setup ("am I going to get notified?") and for
 * users whose TG notifications got muted by accident. The DM uses the
 * exact same template as a real withdraw alert, just clearly marked
 * as a test and pointing at /security for the real picture.
 */
import { upsertUser } from "../services/users.js";

export async function handleTestAlert(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  await upsertUser(tgUser.id, tgUser.username);

  await ctx.reply(
    [
      "🧪 *Test security alert*",
      "",
      "If you got this message, you're all set — Magpie can reach you for security DMs.",
      "",
      "Real alerts fire automatically when a signed site action runs on your account (withdraw, set-active, etc). They include inline 🔒 *Lock* buttons so you can freeze the site with one tap.",
      "",
      "Run /security to see your full account safety view, or /lock 24 if you ever suspect compromise.",
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}
