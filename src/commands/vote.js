/**
 * /vote and /votingpower — surface active governance proposals to TG users
 * and report their voting weight for each.
 */

import { InlineKeyboard } from "grammy";
import { ensureWallet } from "../services/wallet.js";
import { upsertUser } from "../services/users.js";
import { getProposal, listProposalIds } from "../governance/registry.js";
import { getVotingPower } from "../governance/voting-power.js";

const SITE_URL = process.env.MAGPIE_SITE_URL || "https://magpie.capital";

function activeProposals() {
  const now = new Date();
  return listProposalIds()
    .map(getProposal)
    .filter((p) => {
      if (!p?.voting_started_at_iso || !p?.voting_ends_at_iso) return false;
      const start = new Date(p.voting_started_at_iso);
      const end = new Date(p.voting_ends_at_iso);
      return now >= start && now <= end;
    });
}

function fmtMagpie(rawStr) {
  const v = Number(rawStr) / 1e6;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtCloses(iso) {
  const end = new Date(iso);
  const now = new Date();
  const ms = end.getTime() - now.getTime();
  if (ms < 0) return "closed";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  if (d > 0) return `closes in ${d}d ${h}h`;
  return `closes in ${h}h`;
}

export async function handleVote(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const active = activeProposals();
  if (active.length === 0) {
    return ctx.reply(
      "No active governance proposals right now.\n\n" +
        `When a proposal is open you'll see it here and at ${SITE_URL}/governance.`,
    );
  }

  const lines = ["🗳️ *Active Governance Proposals*", ""];
  for (const p of active) {
    lines.push(`*${p.id}* — ${p.title}`);
    lines.push(`${fmtCloses(p.voting_ends_at_iso)}`);
    lines.push(`Cast your vote: ${SITE_URL}/governance/proposal/${p.id}`);
    lines.push("");
  }
  lines.push(`Check your voting weight: /votingpower`);
  return ctx.reply(lines.join("\n"), { parse_mode: "Markdown", disable_web_page_preview: true });
}

export async function handleVotingPower(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);
  let wallet;
  try {
    const w = await ensureWallet(user.id);
    wallet = w.publicKey;
  } catch (err) {
    return ctx.reply("Couldn't load your wallet — try /start first.");
  }

  const active = activeProposals();
  // Also include the most recent CLOSED proposal so users can see their historical weight
  const allRecent = listProposalIds()
    .map(getProposal)
    .filter((p) => p.voting_ends_at_iso)
    .sort((a, b) => new Date(b.voting_ends_at_iso) - new Date(a.voting_ends_at_iso))
    .slice(0, 3);

  const proposalsToShow = active.length > 0 ? active : allRecent;
  if (proposalsToShow.length === 0) {
    return ctx.reply("No governance proposals are active or recent.");
  }

  const lines = ["⚖️ *Your Voting Weight*", "", `Wallet: \`${wallet.slice(0, 8)}...${wallet.slice(-4)}\``, ""];
  for (const p of proposalsToShow) {
    const power = getVotingPower({ wallet, proposalId: p.id, snapshotId: p.snapshot_id });
    lines.push(`*${p.id}* — ${p.title}`);
    if (!power.eligible) {
      lines.push(`  ❌ Not eligible — ${power.reason}`);
    } else {
      lines.push(`  Weight: *${fmtMagpie(power.raw_weight)} $MAGPIE*`);
      lines.push(`  (${(power.weight_pct_of_pool).toFixed(4)}% of eligible pool)`);
      if (power.was_capped) {
        lines.push(`  ⚠️ Whale-capped at ${(power.cap_fraction * 100).toFixed(0)}% — voting power counted as ${(power.capped_pct_of_pool).toFixed(4)}%`);
      }
      if (Number(power.collateralized_raw) > 0) {
        lines.push(`  Held: ${fmtMagpie(power.held_raw)} · Locked as collateral: ${fmtMagpie(power.collateralized_raw)}`);
      }
    }
    lines.push("");
  }
  lines.push(`Cast your vote: ${SITE_URL}/governance`);
  return ctx.reply(lines.join("\n"), { parse_mode: "Markdown", disable_web_page_preview: true });
}
