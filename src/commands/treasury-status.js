/**
 * /treasury-status — admin command. Reports live state of the
 * treasury sweeper: env config, current balances on the lender wallet
 * + treasury vault, last 10 sweep audit rows.
 *
 * Read-only. Safe to run any time.
 */
import { isAdmin } from "../services/admin.js";
import { getTreasurySweeperStatus } from "../services/treasury-sweeper.js";

function fmtSol(n) {
  if (n == null) return "—";
  return Number(n).toFixed(4);
}

function fmtAge(ms) {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export async function handleTreasuryStatus(ctx) {
  if (!isAdmin(ctx.from?.id)) return ctx.reply("Not authorized.");

  await ctx.reply("Reading treasury state…");

  let s;
  try {
    s = await getTreasurySweeperStatus();
  } catch (err) {
    return ctx.reply(`Failed to read status: ${err.message?.slice(0, 200)}`);
  }

  const lines = [
    `*Treasury sweeper status*`,
    "",
    `Disabled:           ${s.disabled ? "*YES* — kill switch active" : "no"}`,
    `Interval:           ${s.interval_min} min`,
    `Operational reserve: ${s.reserve_sol} SOL`,
    `Min sweep size:      ${s.min_sol} SOL`,
    `Consecutive fails:   ${s.consecutive_failures}`,
    "",
    `*Balances*`,
    `Lender wallet:   ${fmtSol(s.lender_balance_sol)} SOL  (\`${s.lender_pubkey.slice(0, 8)}…\`)`,
    `Treasury vault:  ${fmtSol(s.treasury_balance_sol)} SOL  (\`${s.treasury_vault_pubkey.slice(0, 8)}…\`)`,
    "",
    `*Recent sweep activity*`,
  ];

  if (!s.recent || s.recent.length === 0) {
    lines.push("_No sweep activity recorded yet._");
  } else {
    for (const r of s.recent) {
      const ageMs = Date.now() - new Date(r.initiated_at).getTime();
      const sweptSol = Number(r.swept || 0) / 1e9;
      const tag = {
        success: "✓",
        skip_below_min: "·",
        skip_disabled: "·",
        skip_locked: "·",
        sim_reject: "✗",
        send_error: "✗",
      }[r.outcome] || "?";
      const detail =
        r.outcome === "success"
          ? `${sweptSol.toFixed(4)} SOL → \`${(r.tx_signature || "").slice(0, 10)}…\``
          : r.error_message
            ? `_${r.error_message.slice(0, 100)}_`
            : r.notes
              ? `_${r.notes.slice(0, 100)}_`
              : "";
      lines.push(`${tag} ${fmtAge(ageMs).padEnd(10)} ${r.outcome.padEnd(15)} ${detail}`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
