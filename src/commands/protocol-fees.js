/**
 * /protocol-fees — admin-only visibility into accumulated TP fees +
 * sweep state.
 *
 * Shows:
 *   - Total accrued (sum of protocol_fee_lamports for orders with
 *     accrued_at set)
 *   - Total swept (sum of protocol_fee_sweeps.swept_lamports)
 *   - Pending sweep amount (accrued - swept)
 *   - Last sweep timestamp
 *   - Sweeper configuration state (enabled / disabled)
 *   - Manual sweep instruction if PROTOCOL_FEE_KEYPAIR isn't set
 *
 * Read-only. Just reports — never moves SOL. The auto-sweeper handles
 * actual transfers when configured.
 */
import { isAdmin } from "../services/admin.js";
import { auditProtocolFees } from "../services/protocol-fee-sweeper.js";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

export async function handleProtocolFees(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("Admin only.");
    return;
  }
  let audit;
  try {
    audit = await auditProtocolFees();
  } catch (err) {
    await ctx.reply(`Couldn't read protocol-fee state: ${err.message}`);
    return;
  }
  const sweeperEnabled = Boolean(process.env.PROTOCOL_FEE_KEYPAIR);
  const lastSweep = audit.last_sweep_at
    ? new Date(audit.last_sweep_at).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" })
    : "never";
  const lines = [
    "*Protocol Fees (TP execution cut)*",
    "",
    `Accrued total: \`${fmtSol(audit.accrued_lamports)} SOL\` across ${audit.accrued_orders_count} order(s)`,
    `Swept total:   \`${fmtSol(audit.swept_lamports)} SOL\``,
    `Pending sweep: \`${fmtSol(audit.pending_lamports)} SOL\``,
    `Last sweep:    ${lastSweep}`,
    "",
    sweeperEnabled
      ? "Auto-sweeper: *enabled* (PROTOCOL_FEE_KEYPAIR set). Sweeps hourly when pending >= 0.05 SOL, capped at 5 SOL per transfer."
      : "Auto-sweeper: *disabled* (PROTOCOL_FEE_KEYPAIR not set). Set the env to enable automatic sweep, or manually transfer the pending amount from the protocol wallet to the lender wallet so distributions include it.",
    "",
    "_TP fees flow: engine sends 1% to protocol wallet → sweeper consolidates into lender wallet → distributor pays out 70/10/10/10 per accrual ledger._",
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
