/**
 * /submissions — operator-only review queue for collectible submissions.
 *
 * The public gate at magpie.capital/collectibles#submit does the triage it can
 * do from a form and records the result. It deliberately CANNOT approve a card
 * for a loan: the liquidity proof needs realized multi-venue sold data, and the
 * cert still has to be checked against the grader's own records. That last mile
 * is a human decision, and this command is where it gets made.
 *
 * Usage:
 *   /submissions                  — the queue, newest first
 *   /submissions <id>             — full detail, including internal flags
 *   /submissions review  <id> …   — mark as being worked on
 *   /submissions approve <id> …   — approved as collateral-eligible
 *   /submissions reject  <id> …   — rejected, with the reason
 *
 * The machine verdict is NEVER overwritten — approving sets `status`, and the
 * gate's original `verdict` stays exactly as it was so the two can be audited
 * against each other later.
 */
import { isAdmin } from "../services/admin.js";
import { query } from "../db/pool.js";

const STATUSES = { review: "in_review", approve: "approved", reject: "rejected" };

/** How many days of demand the /submissions demand view covers. */
const DEMAND_DAYS = 30;

/** Telegram truncates long messages; keep the queue readable. */
const QUEUE_LIMIT = 15;

function when(ts) {
  return new Date(ts).toISOString().slice(5, 16).replace("T", " ");
}

function describe(r) {
  return [
    r.card,
    r.card_set,
    r.card_year,
    `${r.grader} ${r.cert}`,
    r.grade ? `grade ${r.grade}` : null,
    r.auto_grade ? `auto ${r.auto_grade}` : null,
    r.platform || "not vaulted",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The signals that decide whether this is worth a human's time. */
function riskLine(flags) {
  const f = flags || {};
  const bits = [];
  if (f.ownership === "proven") bits.push("✅ holds it on-chain");
  else if (f.ownership === "mismatch") bits.push("⚠️ does NOT hold it");
  if (f.cert_claimed_by_other_wallet) bits.push("⚠️ cert claimed by another wallet");
  else if (f.cert_seen_before) bits.push("↺ cert seen before");
  return bits.length ? bits.join(" · ") : null;
}

async function showQueue(ctx) {
  const { rows } = await query(
    `SELECT id, card, card_set, card_year, grader, cert, grade, auto_grade,
            platform, verdict, tier, status, flags, created_at
       FROM collectible_submissions
      WHERE status IN ('submitted', 'in_review')
        AND verdict <> 'DECLINED'
      ORDER BY created_at DESC
      LIMIT ${QUEUE_LIMIT}`,
  );

  if (!rows.length) {
    await ctx.reply(
      "No collectible submissions waiting.\n\n" +
        "Declines are filtered out — they need no decision. Use /submissions <id> to open any single one.",
    );
    return;
  }

  const lines = rows.map((r) => {
    const risk = riskLine(r.flags);
    return (
      `#${r.id} · ${when(r.created_at)} · ${r.status}\n` +
      `  ${describe(r)}\n` +
      `  gate: ${r.verdict}${r.tier ? ` (Tier ${r.tier})` : ""}` +
      (risk ? `\n  ${risk}` : "")
    );
  });

  await ctx.reply(
    `🃏 Collectible submissions awaiting a decision (${rows.length}):\n\n` +
      lines.join("\n\n") +
      "\n\n/submissions <id> for detail · approve|reject|review <id> <note>",
    { disable_web_page_preview: true },
  );
}

async function showOne(ctx, id) {
  const { rows } = await query(
    `SELECT * FROM collectible_submissions WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) {
    await ctx.reply(`No submission #${id}.`);
    return;
  }

  const checks = (r.checks || [])
    .map((c) => `  ${c.pass === true ? "✓" : c.pass === false ? "✕" : "…"} ${c.name} — ${c.detail}`)
    .join("\n");

  const risk = riskLine(r.flags);

  await ctx.reply(
    [
      `🃏 Submission #${r.id} · ${when(r.created_at)}`,
      "",
      describe(r),
      "",
      `Gate verdict: ${r.verdict}${r.tier ? ` (Tier ${r.tier})` : ""}  [${r.gate_version}]`,
      `Status: ${r.status}${r.reviewed_at ? ` · reviewed ${when(r.reviewed_at)}` : ""}`,
      r.reviewer_note ? `Note: ${r.reviewer_note}` : "",
      risk ? `Signals: ${risk}` : "",
      r.wallet ? `Wallet: ${r.wallet}` : "Wallet: not connected",
      r.contact ? `Contact: ${r.contact}` : "",
      "",
      "Checks:",
      checks || "  (none recorded)",
      "",
      "Before approving: cert verified with the grader, and a real multi-venue sold record.",
    ]
      .filter((l) => l !== "")
      .join("\n"),
    { disable_web_page_preview: true },
  );
}

async function setStatus(ctx, action, id, note) {
  const status = STATUSES[action];
  const { rows } = await query(
    `UPDATE collectible_submissions
        SET status = $1,
            reviewer_note = COALESCE(NULLIF($2, ''), reviewer_note),
            reviewed_at = NOW(),
            updated_at = NOW()
      WHERE id = $3
      RETURNING id, card, verdict, status`,
    [status, note || "", id],
  );
  const r = rows[0];
  if (!r) {
    await ctx.reply(`No submission #${id}.`);
    return;
  }
  await ctx.reply(
    `#${r.id} → ${r.status}\n${r.card}\n\n` +
      `Gate verdict is unchanged (${r.verdict}) — it's kept so the machine and human calls stay auditable against each other.`,
  );
}

/**
 * The demand signal — what collectors are asking for, and what we turn away.
 *
 * Reads the DURABLE rollup (migration 098), not the live rows, so the picture
 * stays intact after retention reduces old declines. The declines are the more
 * valuable half here: they map the edge of the book and show which categories
 * are worth underwriting next.
 */
async function showDemand(ctx) {
  const { rows } = await query(
    `SELECT verdict,
            SUM(submissions)::int AS n,
            SUM(wallets)::int     AS w
       FROM collectible_submission_daily
      WHERE day > CURRENT_DATE - $1::int
      GROUP BY verdict
      ORDER BY n DESC`,
    [DEMAND_DAYS],
  );

  if (!rows.length) {
    await ctx.reply(`No submissions in the last ${DEMAND_DAYS} days.`);
    return;
  }

  const total = rows.reduce((a, r) => a + r.n, 0);
  const pct = (n) => `${Math.round((n / total) * 100)}%`;
  const lines = rows.map((r) => `  ${r.verdict.padEnd(20)} ${String(r.n).padStart(4)}  (${pct(r.n)})`);

  const { rows: plat } = await query(
    `SELECT platform, SUM(submissions)::int AS n
       FROM collectible_submission_daily
      WHERE day > CURRENT_DATE - $1::int
      GROUP BY platform
      ORDER BY n DESC
      LIMIT 6`,
    [DEMAND_DAYS],
  );

  await ctx.reply(
    [
      `📊 Collectible demand · last ${DEMAND_DAYS} days`,
      "",
      `Total submissions: ${total}`,
      "",
      "By outcome:",
      ...lines,
      "",
      "Where the cards are held:",
      ...plat.map((p) => `  ${String(p.platform).padEnd(20)} ${String(p.n).padStart(4)}`),
      "",
      "Declines are the useful half — they map the edge of the book.",
    ].join("\n"),
    { disable_web_page_preview: true },
  );
}

export async function handleCollectibleSubmissions(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("This command is operator-only.");
    return;
  }

  const parts = String(ctx.message?.text || "").trim().split(/\s+/).slice(1);
  const first = (parts[0] || "").toLowerCase();

  try {
    if (!first) return await showQueue(ctx);

    if (first === "demand") return await showDemand(ctx);

    if (/^\d+$/.test(first)) return await showOne(ctx, Number(first));

    if (first in STATUSES) {
      const id = Number(parts[1]);
      if (!Number.isInteger(id)) {
        await ctx.reply(`Usage: /submissions ${first} <id> [note]`);
        return;
      }
      return await setStatus(ctx, first, id, parts.slice(2).join(" ").slice(0, 500));
    }

    await ctx.reply(
      "Usage:\n" +
        "/submissions — the queue\n" +
        "/submissions <id> — detail\n" +
        "/submissions review|approve|reject <id> [note]\n" +
        "/submissions demand — what collectors ask for, and what we decline",
    );
  } catch (e) {
    await ctx.reply(`Couldn't load submissions: ${e.message}`);
  }
}
