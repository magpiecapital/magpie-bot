/**
 * /tx <signature> — quick tx status lookup.
 *
 * Fetches the parsed tx from RPC and tells the user:
 *   - Status (success / failed / not yet confirmed)
 *   - Slot + block time
 *   - Fee paid
 *   - Whether it touches Magpie programs (borrow / repay / vault / etc.)
 *   - Solscan link
 *
 * Useful for "I sent X but don't see it" support questions without
 * requiring a full /support ticket.
 */
import { connection } from "../solana/connection.js";

const MAGPIE_PROGRAMS = new Set([
  process.env.PROGRAM_ID || "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh",
  process.env.PROGRAM_ID_V2,
  "7tapneCmNwRVEtdeZks4649Q2rf8W1t9tshMN9yHX99P",   // magpie-lending
  "BBYtty9sqWjHzTuoXSNfDCpNtLn6ZjfSfhYEoY6MFP2E",   // magpie-credit-oracle
].filter(Boolean));

function isValidSig(sig) {
  if (typeof sig !== "string") return false;
  // Solana tx signatures are 64–88 base58 chars.
  if (sig.length < 64 || sig.length > 88) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(sig);
}

export async function handleTxLookup(ctx) {
  const arg = (ctx.message?.text || "").split(/\s+/)[1];
  if (!arg) {
    return ctx.reply(
      "Usage: `/tx <signature>`\n\nPaste any Solana tx signature and I'll tell you its status.",
      { parse_mode: "Markdown" },
    );
  }
  if (!isValidSig(arg)) {
    return ctx.reply("That doesn't look like a valid Solana tx signature.");
  }

  let parsed;
  try {
    parsed = await connection.getParsedTransaction(arg, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    return ctx.reply(`❌ RPC error: ${err.message?.slice(0, 100)}`);
  }
  if (!parsed) {
    return ctx.reply(
      `❓ Couldn't find that tx. Either it hasn't confirmed yet, RPC doesn't have it cached, or the signature is wrong.\n\n[Check Solscan](https://solscan.io/tx/${arg})`,
      { parse_mode: "Markdown", disable_web_page_preview: true },
    );
  }

  const meta = parsed.meta;
  const status = meta?.err == null ? "✅ Success" : "❌ Failed";
  const errStr = meta?.err ? JSON.stringify(meta.err).slice(0, 80) : null;
  const fee = meta?.fee ?? 0;
  const slot = parsed.slot;
  const blockTime = parsed.blockTime;
  const when = blockTime ? new Date(blockTime * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "?";

  const programIds = new Set();
  for (const ix of parsed.transaction.message.instructions || []) {
    const pid = ix.programId?.toBase58 ? ix.programId.toBase58() : ix.programId;
    if (pid) programIds.add(pid);
  }
  const magpieTouched = [...programIds].filter((p) => MAGPIE_PROGRAMS.has(p));

  const lines = [
    `🔍 *Tx \`${arg.slice(0, 8)}…${arg.slice(-6)}\`*`,
    "",
    `Status: ${status}`,
    errStr ? `Error:  ${errStr}` : null,
    `Slot:   ${slot}`,
    `When:   ${when}`,
    `Fee:    ${(fee / 1e9).toFixed(6)} SOL`,
    "",
  ];
  if (magpieTouched.length > 0) {
    lines.push(`Touches Magpie program${magpieTouched.length === 1 ? "" : "s"}: ${magpieTouched.length}`);
  } else {
    lines.push("_Not a Magpie protocol tx — purely external._");
  }
  lines.push("", `[View on Solscan](https://solscan.io/tx/${arg})`);

  await ctx.reply(lines.filter((l) => l != null).join("\n"), {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}
