import {
  isAdmin,
  pauseBorrowing,
  resumeBorrowing,
  isBorrowingPaused,
} from "../services/admin.js";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { estimateCostUsd } from "../services/ai-support.js";
import { getHealthSnapshot } from "../services/infra-health.js";

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
  const { getGlobalSiteState } = await import("../services/site-global.js");
  const [{ rows }, siteState, lockedRow] = await Promise.all([
    query(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM loans WHERE status = 'active') AS active,
         (SELECT COUNT(*) FROM loans WHERE status = 'liquidated') AS liquidated`,
    ),
    getGlobalSiteState(),
    query(
      `SELECT COUNT(*)::int AS n FROM users
        WHERE site_locked_until IS NOT NULL AND site_locked_until > NOW()`,
    ),
  ]);
  const r = rows[0];
  const lines = [
    "🛠 *Admin*",
    "",
    `Borrowing: ${isBorrowingPaused() ? "⏸ PAUSED" : "▶️ open"}`,
    `Site signed actions: ${siteState.disabled ? "🛑 DISABLED" : "✅ enabled"}`,
    siteState.disabled && siteState.reason ? `  ↳ ${siteState.reason}` : null,
    `Users:        ${r.users}`,
    `Active loans: ${r.active}`,
    `Liquidated:   ${r.liquidated}`,
    `User locks active: ${lockedRow.rows[0].n}`,
  ].filter(Boolean);
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
  // Guard: the typed decimals MUST match what's on-chain. Wrong decimals
  // silently corrupts every borrow value calc for this token. Verify
  // against the mint account before inserting.
  let chainDecimals;
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    chainDecimals = info.value?.data?.parsed?.info?.decimals;
  } catch (err) {
    return ctx.reply(`❌ Couldn't read mint on-chain: ${err.message?.slice(0, 100)}`);
  }
  if (chainDecimals == null) {
    return ctx.reply(`❌ Mint ${mint} not found on-chain or unreadable.`);
  }
  if (chainDecimals !== decimals) {
    return ctx.reply(
      `❌ Decimals mismatch.\n\n` +
      `You typed: \`${decimals}\`\n` +
      `On-chain: \`${chainDecimals}\`\n\n` +
      `Re-run with the correct on-chain value: \`/enablemint ${mint} ${symbol} ${chainDecimals}${nameParts.length ? " " + nameParts.join(" ") : ""}\``,
      { parse_mode: "Markdown" },
    );
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
  await ctx.reply(`✅ ${symbol.toUpperCase()} enabled (decimals=${decimals}, verified on-chain).`);
}

export async function handleBroadcast(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const text = ctx.message.text.replace(/^\/broadcast(\s+|$)/, "").trim();
  if (!text) {
    return ctx.reply("Usage: `/broadcast <message>`", { parse_mode: "Markdown" });
  }
  const { rows } = await query(`SELECT telegram_id FROM users`);
  let ok = 0;
  let fail = 0;
  for (const r of rows) {
    try {
      await ctx.api.sendMessage(r.telegram_id, `📣 *Announcement*\n\n${text}`, {
        parse_mode: "Markdown",
      });
      ok++;
    } catch {
      fail++;
    }
    // Telegram rate-limits ~30 msgs/s; pacing keeps us safe.
    await new Promise((r) => setTimeout(r, 50));
  }
  await ctx.reply(`✅ Sent to ${ok}, failed ${fail}.`);
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

/**
 * Reply to a user's support ticket. Forwards your message via the bot
 * and marks the ticket responded.
 *
 * Usage: /reply <ticket#> <your message>
 */
export async function handleReply(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const text = ctx.message.text || "";
  const match = text.match(/^\/reply\s+(\d+)\s+([\s\S]+)$/);
  if (!match) {
    return ctx.reply("Usage: `/reply <ticket#> <message>`", { parse_mode: "Markdown" });
  }
  const [, ticketIdStr, reply] = match;
  const ticketId = Number(ticketIdStr);

  const { rows } = await query(
    `SELECT s.*, u.telegram_id
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [ticketId],
  );
  if (!rows[0]) {
    return ctx.reply(`Ticket #${ticketId} not found.`);
  }
  const ticket = rows[0];

  const { InlineKeyboard } = await import("grammy");
  const kb = new InlineKeyboard()
    .text("💬 Follow up", `myt:followup:${ticketId}`)
    .text("✅ Resolved", `myt:close:${ticketId}`);

  try {
    await ctx.api.sendMessage(
      ticket.telegram_id,
      [
        `📩 *Magpie support · Ticket #${ticketId}*`,
        "",
        reply,
        "",
        "_Reply via the buttons below — or run /mytickets any time to see all your tickets._",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  } catch (err) {
    return ctx.reply(`Failed to DM user: ${err.message?.slice(0, 100)}`);
  }

  // status='awaiting_user' = admin replied, ball in user's court.
  // Clearing last_alerted_tier so a NEW user follow-up can re-alert from tier 0.
  await query(
    `UPDATE support_tickets
        SET status = 'awaiting_user',
            admin_reply = $2,
            admin_replied_at = NOW(),
            last_alerted_tier = NULL
      WHERE id = $1`,
    [ticketId, reply],
  );

  await ctx.reply(`✅ Reply sent. Ticket #${ticketId} now awaits user response.`);
}

/**
 * List support tickets with aging + filter.
 *
 * Usage:
 *   /tickets          — open tickets (oldest first, urgency-sorted)
 *   /tickets open     — same as above
 *   /tickets awaiting — tickets awaiting user response
 *   /tickets all      — open + awaiting (everything not closed)
 *   /tickets closed   — recently closed
 */
export async function handleTickets(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const rawArg = (ctx.message?.text || "").split(/\s+/)[1];

  // If arg is a number, show full detail on that specific ticket.
  // /tickets 15 → detail · /tickets open → list view
  if (rawArg && /^\d+$/.test(rawArg)) {
    return handleTicket(ctx);
  }

  const arg = rawArg?.toLowerCase() || "open";

  let statusFilter, label;
  if (arg === "open") {
    statusFilter = `status = 'open'`;
    label = "Open · awaiting team reply";
  } else if (arg === "awaiting" || arg === "user") {
    statusFilter = `status = 'awaiting_user'`;
    label = "Awaiting user response";
  } else if (arg === "all") {
    statusFilter = `status IN ('open', 'awaiting_user')`;
    label = "All active tickets";
  } else if (arg === "closed") {
    statusFilter = `status = 'closed'`;
    label = "Recently closed";
  } else {
    return ctx.reply("Usage: `/tickets [open|awaiting|all|closed]`", { parse_mode: "Markdown" });
  }

  // Always: top-line counts so admin knows the full state
  const { rows: [counts] } = await query(
    `SELECT
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END)::int           AS open,
       SUM(CASE WHEN status = 'awaiting_user' THEN 1 ELSE 0 END)::int  AS awaiting,
       SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END)::int         AS closed
     FROM support_tickets`,
  );

  const orderBy = arg === "closed"
    ? "ORDER BY closed_at DESC NULLS LAST"
    // For active tickets, oldest open first (most urgent)
    : "ORDER BY GREATEST(created_at, COALESCE(last_user_followup_at, created_at)) ASC";

  const { rows } = await query(
    `SELECT s.id, s.message, s.status, s.created_at, s.admin_replied_at,
            s.last_user_followup_at, s.followup_count, s.closed_at,
            u.telegram_id, u.telegram_username
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
      WHERE ${statusFilter}
      ${orderBy}
      LIMIT 25`,
  );

  const header = [
    `🎫 *${label} (${rows.length})*`,
    `Counts → open: *${counts.open}* · awaiting user: *${counts.awaiting}* · closed: *${counts.closed}*`,
    "",
  ];

  if (rows.length === 0) {
    return ctx.reply(header.concat(["📭 None."]).join("\n"), { parse_mode: "Markdown" });
  }

  function ageBadge(date) {
    const mins = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60_000));
    if (mins < 60) return { e: "🟢", txt: `${mins}m` };
    const hrs = Math.floor(mins / 60);
    if (hrs < 12) return { e: "🟢", txt: `${hrs}h` };
    if (hrs < 24) return { e: "🟡", txt: `${hrs}h` };
    if (hrs < 48) return { e: "🟠", txt: `${hrs}h` };
    return { e: "🔴", txt: `${Math.floor(hrs / 24)}d` };
  }

  const lines = [...header];
  for (const t of rows) {
    // Reference time = last_user_followup_at if newer, else created_at
    const refTime = t.last_user_followup_at && new Date(t.last_user_followup_at) > new Date(t.created_at)
      ? t.last_user_followup_at
      : t.created_at;
    const a = ageBadge(refTime);
    const from = t.telegram_username ? `@${t.telegram_username}` : `tg://${t.telegram_id}`;
    const msg = (t.message || "").slice(0, 250);
    const fu = t.followup_count > 0 ? ` · ${t.followup_count} follow-up${t.followup_count > 1 ? "s" : ""}` : "";
    lines.push(
      `${a.e} *#${t.id}* · ${from} · ${a.txt}${fu}`,
      msg,
    );
    if (t.status === "open") {
      lines.push(`Reply: \`/reply ${t.id} <message>\` · Close: \`/close ${t.id}\``);
    } else if (t.status === "awaiting_user") {
      lines.push(`Last reply: ${Math.floor((Date.now() - new Date(t.admin_replied_at).getTime()) / 60_000)}m ago · \`/close ${t.id}\``);
    }
    lines.push("");
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {
    // Markdown fallback — user messages can contain unbalanced chars
    return ctx.reply(lines.join("\n").replace(/[*_`]/g, ""));
  });
}

/**
 * Close a ticket as admin (resolved, fixed externally, won't-fix, etc.).
 *
 * Usage: /close <ticket#>
 */
/**
 * /holderpool — admin-only diagnostic for the $MAGPIE holder + LP
 * loyalty reward pools. Shows internal state AND a sanity check:
 * "based on loans in the DB, this pool SHOULD have ~N SOL accrued —
 * does the actual accrued_lamports match?" If they don't match, the
 * fee-routing code path is broken.
 *
 * OPERATOR-PRIVATE. Never expose this data through any public surface.
 */
export async function handleHolderPool(ctx) {
  if (!(await requireAdmin(ctx))) return;

  // Read the LIVE bps from governance_config — flips automatically when
  // MGP-001 ratifies.
  const { getHolderRewardBps } = await import("../services/magpie-holder-rewards.js");
  const HOLDER_REWARD_BPS = await getHolderRewardBps();
  const LP_LOYALTY_BPS = 200;        // 2% (no governance flip planned)

  const { rows: [hp] } = await query(
    `SELECT accrued_lamports::text, last_distribution_at, updated_at,
            next_distribution_at
     FROM magpie_holder_pool WHERE id = 1`,
  );
  const { rows: [lp] } = await query(
    `SELECT accrued_lamports::text, last_distribution_at, updated_at
     FROM lp_loyalty_pool WHERE id = 1`,
  );

  // Expected accrual from loans — fee per loan = loan_amount × tier_bps
  // We approximate tier_bps from ltv_percentage column.
  const sinceClause = hp?.last_distribution_at
    ? `start_timestamp > $1`
    : `start_timestamp IS NOT NULL`;
  const sinceParams = hp?.last_distribution_at ? [hp.last_distribution_at] : [];
  const { rows: [expected] } = await query(
    `SELECT
       COALESCE(SUM(
         CASE
           WHEN ltv_percentage >= 30 THEN loan_amount_lamports::numeric * 300 / 10000
           WHEN ltv_percentage >= 25 THEN loan_amount_lamports::numeric * 200 / 10000
           ELSE loan_amount_lamports::numeric * 150 / 10000
         END
       ), 0)::text AS total_fees_lamports,
       COUNT(*)::int AS loans_counted
     FROM loans WHERE ${sinceClause}`,
    sinceParams,
  );

  const totalFeesLamports = BigInt(expected.total_fees_lamports || "0");
  const expectedHolderAccrual = (totalFeesLamports * BigInt(HOLDER_REWARD_BPS)) / 10_000n;
  const expectedLpAccrual = (totalFeesLamports * BigInt(LP_LOYALTY_BPS)) / 10_000n;
  const actualHolder = BigInt(hp?.accrued_lamports || "0");
  const actualLp = BigInt(lp?.accrued_lamports || "0");
  const holderDelta = expectedHolderAccrual - actualHolder;
  const lpDelta = expectedLpAccrual - actualLp;

  const fmt = (lamports) => (Number(lamports) / 1e9).toFixed(6);
  const sign = (n) => (n >= 0n ? "+" : "");

  const lines = [
    "🔐 *Pool diagnostic (internal — DO NOT share)*",
    "",
    "*$MAGPIE Holder Pool*",
    `  Actual accrued:  \`${fmt(actualHolder)} SOL\``,
    `  Expected (10% of all loan fees${hp?.last_distribution_at ? " since last dist" : ""}):`,
    `                   \`${fmt(expectedHolderAccrual)} SOL\``,
    `  Δ (expected − actual): *\`${sign(holderDelta)}${fmt(holderDelta)} SOL\`*`,
    `  Last distribution:  ${hp?.last_distribution_at ? new Date(hp.last_distribution_at).toISOString() : "_never_"}`,
    `  Next distribution:  ${hp?.next_distribution_at ? new Date(hp.next_distribution_at).toISOString() : "_unscheduled_"}`,
    `  Pool last touched:  ${hp?.updated_at ? new Date(hp.updated_at).toISOString() : "_never_"}`,
    "",
    "*LP Loyalty Pool*",
    `  Actual accrued:  \`${fmt(actualLp)} SOL\``,
    `  Expected (2%):   \`${fmt(expectedLpAccrual)} SOL\``,
    `  Δ: *\`${sign(lpDelta)}${fmt(lpDelta)} SOL\`*`,
    `  Pool last touched: ${lp?.updated_at ? new Date(lp.updated_at).toISOString() : "_never_"}`,
    "",
    `_${expected.loans_counted} loans counted in expected calc._`,
    "",
  ];

  // Diagnosis
  if (holderDelta > 1_000_000n) {
    lines.push(
      "🚨 *Bug detected*: holder pool is missing accrual.",
      "Possible causes:",
      "• recordLoan's `accrueToHolderPool` isn't firing",
      "  (check Railway logs for `[holder-rewards] accrual failed`)",
      "• A redeploy or migration reset the pool row",
      "• Loans created via a path other than recordLoan",
    );
  } else if (holderDelta < -1_000_000n) {
    lines.push("⚠️ Holder pool has MORE than expected — possible double-accrual.");
  } else {
    lines.push("✅ Holder pool accrual matches expected. Healthy.");
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

/**
 * /ticket <id> — pull full detail on a specific ticket. Useful when
 * you get a critical-ticket DM and want to see exactly what the user
 * said + what the agent already tried before deciding how to respond.
 *
 * Shows:
 *   • Status, age, follow-up count, auto-resolve status
 *   • User: handle, account age, loan counts, streak
 *   • Original message (full, untruncated)
 *   • Most-recent admin/auto reply (if any)
 *   • Recent agent conversation if any is still in TTL window
 */
export async function handleTicket(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const arg = (ctx.message?.text || "").split(/\s+/)[1];
  const ticketId = Number(arg);
  if (!arg || !Number.isFinite(ticketId)) {
    return ctx.reply("Usage: `/ticket <id>`", { parse_mode: "Markdown" });
  }

  const { rows } = await query(
    `SELECT s.id, s.user_id, s.message, s.status,
            s.admin_reply, s.admin_replied_at,
            s.auto_resolved_at, s.last_user_followup_at, s.followup_count,
            s.closed_at, s.created_at,
            u.telegram_id, u.telegram_username, u.current_streak, u.created_at AS user_created_at,
            (SELECT COUNT(*) FROM loans WHERE user_id = u.id)::int AS total_loans,
            (SELECT COUNT(*) FROM loans WHERE user_id = u.id AND status = 'active')::int AS active_loans
     FROM support_tickets s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [ticketId],
  );

  if (rows.length === 0) {
    return ctx.reply(`Ticket #${ticketId} not found.`);
  }
  const t = rows[0];
  const ageMin = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 60_000);
  const ageStr = ageMin < 60 ? `${ageMin}m` : ageMin < 60 * 24 ? `${Math.floor(ageMin / 60)}h` : `${Math.floor(ageMin / (60 * 24))}d`;
  const userAgeDays = Math.floor((Date.now() - new Date(t.user_created_at).getTime()) / (24 * 3_600_000));
  const fromTag = t.telegram_username ? `@${t.telegram_username}` : `tg://${t.telegram_id}`;

  const lines = [
    `🎫 *Ticket #${t.id}* · _${t.status}_ · ${ageStr} ago`,
    "",
    `*From:* ${fromTag}`,
    `*User stats:* ${userAgeDays}d account · ${t.total_loans} loans (${t.active_loans} active) · streak ${t.current_streak || 0}`,
    "",
    "*Original message:*",
    "```",
    (t.message || "(empty)").slice(0, 1500),
    "```",
  ];

  if (t.followup_count > 0) {
    lines.push("", `_${t.followup_count} follow-up(s) — see message above for full thread._`);
  }

  if (t.admin_reply) {
    lines.push("", "*Last reply (admin or AI auto-resolver):*");
    if (t.auto_resolved_at) {
      const arAgo = Math.floor((Date.now() - new Date(t.auto_resolved_at).getTime()) / 60_000);
      lines.push(`_AI auto-resolved ${arAgo}m ago_`);
    } else if (t.admin_replied_at) {
      const arAgo = Math.floor((Date.now() - new Date(t.admin_replied_at).getTime()) / 60_000);
      lines.push(`_Admin replied ${arAgo}m ago_`);
    }
    lines.push("```", t.admin_reply.slice(0, 1500), "```");
  }

  // Recent agent conversation if it's still in the TTL window
  const conv = await query(
    `SELECT messages, turns, last_active_at FROM support_conversations WHERE user_id = $1`,
    [t.user_id],
  );
  if (conv.rows.length > 0) {
    const c = conv.rows[0];
    const lastMin = Math.floor((Date.now() - new Date(c.last_active_at).getTime()) / 60_000);
    if (lastMin < 60) {
      lines.push("", `*Live agent conversation* (${c.turns} turns, last active ${lastMin}m ago):`);
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const recent = msgs.slice(-6);
      const transcript = [];
      for (const m of recent) {
        if (m.role === "user") {
          const text = typeof m.content === "string" ? m.content : "[tool_result]";
          transcript.push(`👤 ${text.slice(0, 200)}`);
        } else if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === "text") transcript.push(`🤖 ${b.text.slice(0, 200)}`);
            else if (b.type === "tool_use") transcript.push(`🛠 ${b.name}`);
          }
        }
      }
      lines.push("```", transcript.join("\n").slice(0, 1500), "```");
    }
  }

  lines.push(
    "",
    `*Actions:*`,
    `\`/reply ${t.id} <message>\` — respond to user`,
    `\`/close ${t.id}\` — mark resolved`,
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {
    // Markdown can choke on user-provided content — fallback plaintext
    return ctx.reply(lines.join("\n").replace(/[*_`]/g, ""));
  });
}

export async function handleClose(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const arg = (ctx.message?.text || "").split(/\s+/)[1];
  const ticketId = Number(arg);
  if (!arg || !Number.isFinite(ticketId)) {
    return ctx.reply("Usage: `/close <ticket#>`", { parse_mode: "Markdown" });
  }
  const { rows: [t], rowCount } = await query(
    `UPDATE support_tickets
        SET status = 'closed', closed_at = NOW()
      WHERE id = $1 AND status != 'closed'
      RETURNING id, user_id`,
    [ticketId],
  );
  if (rowCount === 0) {
    return ctx.reply(`Ticket #${ticketId} not found or already closed.`);
  }
  // Notify the user
  const { rows: [user] } = await query(
    `SELECT telegram_id FROM users WHERE id = $1`,
    [t.user_id],
  );
  if (user?.telegram_id) {
    try {
      await ctx.api.sendMessage(
        Number(user.telegram_id),
        `✅ *Ticket #${ticketId} closed by the team.*\n\nIf you need more help, just /support or /mytickets.`,
        { parse_mode: "Markdown" },
      );
    } catch {}
  }
  await ctx.reply(`✅ Ticket #${ticketId} closed.`);
}

/**
 * /closeall — bulk-close every currently-open ticket with a single
 * canned message routing users to the AI agent. Useful when admin
 * has been flooded with tickets and wants to clear the backlog by
 * routing everyone to the now-capable AI.
 *
 * Usage:
 *   /closeall                  — closes all open + awaiting_user tickets
 *                                 with the default "try /support agent" reply
 *   /closeall <custom message> — uses your custom message instead
 *
 * Each user gets a DM with the reply. Tickets marked closed in DB.
 */
export async function handleCloseAll(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const customMsg = (ctx.message?.text || "")
    .replace(/^\/closeall(\s+|$)/, "")
    .trim();
  const reply = customMsg || [
    "Thanks for your patience — we've upgraded our support agent and it should now be able to answer most questions instantly.",
    "",
    "Please run /support → *Chat with our agent* and re-ask. If anything still isn't resolved after that, your follow-up will reach me directly.",
  ].join("\n");

  // Confirm before nuking — bulk operations deserve a sanity check.
  const argv = (ctx.message?.text || "").split(/\s+/);
  if (argv[1] !== "--confirm" && !customMsg) {
    const { rows: [c] } = await query(
      `SELECT COUNT(*)::int AS n FROM support_tickets
        WHERE status IN ('open', 'awaiting_user')`,
    );
    return ctx.reply(
      [
        `⚠️ This will close *${c.n}* open + awaiting tickets and DM each user the default "try the agent" message.`,
        "",
        "To proceed, run: `/closeall --confirm`",
        "",
        "Or pass your own message: `/closeall <your message>`",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  const { rows } = await query(
    `SELECT s.id, u.telegram_id
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
      WHERE s.status IN ('open', 'awaiting_user')`,
  );

  if (rows.length === 0) {
    return ctx.reply("📭 No open tickets to close.");
  }

  await ctx.reply(`⏳ Closing ${rows.length} tickets and notifying users…`);

  let ok = 0;
  let fail = 0;
  for (const r of rows) {
    try {
      await ctx.api.sendMessage(
        Number(r.telegram_id),
        `📩 *Ticket #${r.id}*\n\n${reply}`,
        { parse_mode: "Markdown" },
      );
      ok++;
    } catch {
      fail++;
    }
    // Telegram rate limit ~30 msgs/sec — pace at 50ms
    await new Promise((res) => setTimeout(res, 50));
  }
  await query(
    `UPDATE support_tickets
        SET status = 'closed',
            closed_at = NOW(),
            admin_reply = $1,
            admin_replied_at = NOW()
      WHERE status IN ('open', 'awaiting_user')`,
    [reply],
  );

  await ctx.reply(`✅ Closed ${rows.length} tickets. Notified ${ok}, ${fail} failed.`);
}

/**
 * Manually trigger the loan reconciler. Returns drift-fix count.
 * Useful when a user reports stale data and you want to force a sweep
 * without waiting for the next 5-min tick.
 *
 * Usage: /reconcile
 */
export async function handleReconcile(ctx) {
  if (!(await requireAdmin(ctx))) return;
  await ctx.reply("⏳ Running loan reconciliation sweep...");
  try {
    const { runLoanReconciliation, getReconcilerHeartbeat } = await import(
      "../services/loan-reconciler.js"
    );
    const result = await runLoanReconciliation();
    const hb = getReconcilerHeartbeat();
    await ctx.reply(
      [
        "✅ *Reconciliation complete*",
        "",
        `Loans checked: ${result.checked}`,
        `Drift fixes applied: ${result.fixed}`,
        result.error ? `\nError: \`${result.error}\`` : "",
        "",
        `Last automatic run: ${hb.lastRunAt ? new Date(hb.lastRunAt).toISOString() : "never"}`,
      ].filter(Boolean).join("\n"),
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    await ctx.reply(`❌ Reconcile failed: ${err.message?.slice(0, 200)}`);
  }
}

/**
 * Deposit SOL from the lender wallet directly into the lending pool.
 * Increases pool TVL → enables more loans. Lender wallet retains
 * whatever's left for ops + payouts.
 *
 * Usage: /fundpool <sol_amount>
 */
export async function handleFundPool(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const rawArg = parts[0];
  const poolArg = (parts[1] || "v1").toLowerCase();
  if (!rawArg) {
    return ctx.reply(
      "Usage: `/fundpool <sol_amount|max|N%> [pool]`\n\n" +
      "• `/fundpool 5` → 5 SOL into memecoin pool (v1)\n" +
      "• `/fundpool max v2` → all lender SOL (minus 0.2 reserve) into RWA pool\n" +
      "• `/fundpool 50% v2` → half of lender SOL into RWA pool",
      { parse_mode: "Markdown" },
    );
  }
  const isV2 = ["v2", "v2b", "rwa", "rwas", "stocks"].includes(poolArg);
  const poolLabel = isV2 ? "RWA pool (v2b)" : "memecoin pool (v1)";

  try {
    const { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram } = await import("@solana/web3.js");
    const {
      TOKEN_PROGRAM_ID,
      NATIVE_MINT,
      getAssociatedTokenAddressSync,
      createAssociatedTokenAccountIdempotentInstruction,
      createSyncNativeInstruction,
      createCloseAccountInstruction,
    } = await import("@solana/spl-token");
    const BNmod = await import("bn.js");
    const BN = BNmod.default || BNmod;
    const bs58mod = await import("bs58");
    const bs58 = bs58mod.default || bs58mod;
    const fs = await import("node:fs");
    const path = await import("node:path");

    // Load lender keypair the same way the rest of the bot does
    let lender;
    if (process.env.LENDER_PRIVATE_KEY) {
      lender = Keypair.fromSecretKey(bs58.decode(process.env.LENDER_PRIVATE_KEY));
    } else {
      const kpPath = process.env.LENDER_KEYPAIR_PATH;
      if (!kpPath) throw new Error("LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set — refusing the CWD-relative fallback.");
      lender = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(kpPath, "utf-8"))));
    }

    const { connection } = await import("../solana/connection.js");
    const { getProgramForSigner, PROGRAM_ID, PROGRAM_ID_V2 } = await import("../solana/program.js");
    const { lendingPoolPda, loanTokenVaultPda } = await import("../solana/pdas.js");
    const { parseAmountInput, clampToMax } = await import("../lib/amount-input.js");

    // Route to v1 or v2b based on the pool arg. If v2 was requested but
    // PROGRAM_ID_V2 isn't configured (e.g., local dev), fail clearly.
    if (isV2 && !PROGRAM_ID_V2) {
      return ctx.reply("❌ v2 pool requested but `PROGRAM_ID_V2` env not set. Configure it first.");
    }
    const programId = isV2 ? PROGRAM_ID_V2 : PROGRAM_ID;
    const program = getProgramForSigner(lender, programId);

    // Read actual on-chain balance, parse input against it (handles "max"/"50%"
    // keywords using exact lamports — never round-tripped through display).
    const balance = BigInt(await connection.getBalance(lender.publicKey));
    const RESERVE = 200_000_000n; // 0.2 SOL safety floor for ops
    const maxFundable = balance > RESERVE ? balance - RESERVE : 0n;
    if (maxFundable <= 0n) {
      return ctx.reply(`❌ Lender balance ${Number(balance) / 1e9} SOL is at or below the 0.2 SOL reserve. Top up first.`);
    }
    const parsed = parseAmountInput(rawArg, { maxLamports: maxFundable });
    if (parsed.kind === "invalid") {
      return ctx.reply(`❌ Invalid amount: ${parsed.reason}. Try \`5\`, \`max\`, or \`50%\`.`, { parse_mode: "Markdown" });
    }
    const clamp = clampToMax(parsed.lamports, maxFundable);
    if (!clamp.ok) {
      return ctx.reply(
        `❌ Asked for ${(Number(clamp.lamports) / 1e9).toFixed(4)} SOL but only ${(Number(clamp.max) / 1e9).toFixed(4)} SOL is fundable (lender balance ${(Number(balance) / 1e9).toFixed(4)} SOL minus 0.2 SOL reserve).`,
      );
    }
    const lamports = clamp.lamports;
    const amountSol = Number(lamports) / 1e9;
    if (lamports > 100_000_000_000n) {
      return ctx.reply("❌ Refusing to deposit > 100 SOL in a single call. Split it up.");
    }
    await ctx.reply(`⏳ Depositing ${amountSol.toFixed(4)} SOL into the ${poolLabel} from lender wallet…`);

    const [pool] = lendingPoolPda(lender.publicKey, programId);
    const [loanTokenVault] = loanTokenVaultPda(pool, programId);
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), pool.toBuffer(), lender.publicKey.toBuffer()],
      programId,
    );

    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, lender.publicKey);

    const preIxs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        lender.publicKey,
        wsolAta,
        lender.publicKey,
        NATIVE_MINT,
      ),
      SystemProgram.transfer({
        fromPubkey: lender.publicKey,
        toPubkey: wsolAta,
        lamports,
      }),
      createSyncNativeInstruction(wsolAta),
    ];
    const postIxs = [createCloseAccountInstruction(wsolAta, lender.publicKey, lender.publicKey)];

    const sig = await program.methods
      .deposit(new BN(lamports.toString()))
      .accounts({
        pool,
        loanTokenVault,
        position,
        depositorTokenAccount: wsolAta,
        depositor: lender.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(preIxs)
      .postInstructions(postIxs)
      .rpc({ commitment: "confirmed" });

    // Fetch fresh pool state for the reply
    const p = await program.account.lendingPool.fetch(pool);
    const newTvl = Number(p.totalDeposits) / 1e9;

    // Sync the lender's lp_positions row immediately. Without this,
    // the row stays at its old shares value until the next 6h lp-loyalty
    // tick, leaving every read of "operator's LP share" wrong post-/fundpool.
    let syncedShares = null;
    try {
      const { syncPositionsForWallet } = await import("../services/lp-loyalty.js");
      const updates = await syncPositionsForWallet(lender.publicKey);
      const match = updates.find((u) => u.pool === pool.toBase58());
      if (match) syncedShares = match.shares;
    } catch (err) {
      console.warn("[fundpool] post-deposit lp_positions sync failed:", err.message);
    }

    await ctx.reply(
      [
        `✅ *${poolLabel} funded*`,
        "",
        `Deposited: \`${amountSol} SOL\``,
        `New pool TVL: \`${newTvl.toFixed(4)} SOL\``,
        syncedShares ? `Your shares now: \`${syncedShares}\`` : null,
        "",
        `[View tx](https://solscan.io/tx/${sig})`,
      ].filter(Boolean).join("\n"),
      { parse_mode: "Markdown", disable_web_page_preview: true },
    );
  } catch (err) {
    console.error("[fundpool] error:", err);
    await ctx.reply(`❌ Deposit failed: ${err.message?.slice(0, 150) || "unknown error"}`);
  }
}

/**
 * /snapshotonly — arm the next holder distribution to be snapshot-only.
 *
 * When `next_distribution_at` fires next, the cron captures the holder
 * set and pro-rata allocations into rows with status='snapshot_pending'
 * but does NOT send SOL. Operator reviews + triggers payouts via
 * `/distribute <id>` when ready. Flag auto-resets after the next run.
 */
export async function handleSnapshotOnly(ctx) {
  if (!(await requireAdmin(ctx))) return;
  await query(
    `UPDATE magpie_holder_pool SET next_run_snapshot_only = TRUE WHERE id = 1`,
  );
  await ctx.reply(
    [
      "*Next holder distribution armed as SNAPSHOT-ONLY.*",
      "",
      "When the scheduled distribution time arrives, the bot will:",
      "  1. Capture the holder set + pro-rata allocations",
      "  2. Write rows with status `snapshot_pending`",
      "  3. NOT send any SOL",
      "  4. DM you with the distribution ID + summary",
      "",
      "Trigger payouts later with `/distribute <distribution_id>`.",
      "",
      "_Flag auto-resets to FALSE after this run._",
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}

/**
 * /distribute <distribution_id> — execute payouts for a snapshot-pending
 * distribution. Flips rows from 'snapshot_pending' to 'accrued', which
 * the holder-rewards retry loop will pick up and pay out in batches.
 *
 * Also decrements the pool's accrued_lamports by the allocated total so
 * the accounting matches what would have happened in the normal auto-pay
 * path. Idempotent — re-running on the same id is a no-op.
 */
export async function handleDistribute(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const distId = parseInt(parts[0], 10);
  const overrideSol = parts[1] ? parseFloat(parts[1]) : null;
  if (!parts[0] || isNaN(distId)) {
    return ctx.reply(
      "Usage: `/distribute <distribution_id> [sol_amount]`\n\n" +
      "• `/distribute 42` — pay out what was allocated at snapshot time\n" +
      "• `/distribute 42 1.5` — recompute pro-rata using 1.5 SOL total, pay that instead",
      { parse_mode: "Markdown" },
    );
  }
  if (overrideSol !== null && (isNaN(overrideSol) || overrideSol <= 0)) {
    return ctx.reply("❌ Override amount must be a positive SOL number.");
  }

  const { rows: dist } = await query(
    `SELECT id, pool_lamports, snapshot_at FROM magpie_holder_distributions WHERE id = $1`,
    [distId],
  );
  if (dist.length === 0) {
    return ctx.reply(`❌ Distribution ID \`${distId}\` not found.`, { parse_mode: "Markdown" });
  }

  // Recompute pro-rata if operator passed an override amount
  if (overrideSol !== null) {
    const overrideLamports = BigInt(Math.floor(overrideSol * 1e9));
    const { rows: snapshotRows } = await query(
      `SELECT id, balance_at_snapshot FROM magpie_holder_rewards
        WHERE distribution_id = $1 AND status = 'snapshot_pending'`,
      [distId],
    );
    if (snapshotRows.length === 0) {
      return ctx.reply(`No \`snapshot_pending\` rows found for \`${distId}\`. Already triggered or no eligible holders captured?`, { parse_mode: "Markdown" });
    }
    const totalBalance = snapshotRows.reduce((s, r) => s + BigInt(r.balance_at_snapshot), 0n);
    if (totalBalance <= 0n) {
      return ctx.reply(`❌ Captured holder balances sum to 0 — nothing to allocate.`);
    }
    // Update each row's reward_lamports to its pro-rata share of the override
    const { pool: dbPool } = await import("../db/pool.js");
    const client = await dbPool.connect();
    try {
      await client.query("BEGIN");
      for (const row of snapshotRows) {
        const share = (overrideLamports * BigInt(row.balance_at_snapshot)) / totalBalance;
        await client.query(
          `UPDATE magpie_holder_rewards SET reward_lamports = $1 WHERE id = $2`,
          [share.toString(), row.id],
        );
      }
      await client.query(
        `UPDATE magpie_holder_distributions SET pool_lamports = $1 WHERE id = $2`,
        [overrideLamports.toString(), distId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      return ctx.reply(`❌ Pro-rata recompute failed: ${err.message?.slice(0, 200)}`);
    }
    client.release();
  }

  const { rows: pending } = await query(
    `SELECT id, reward_lamports FROM magpie_holder_rewards
      WHERE distribution_id = $1 AND status = 'snapshot_pending'`,
    [distId],
  );
  if (pending.length === 0) {
    return ctx.reply(`No \`snapshot_pending\` rows found for distribution \`${distId}\`. Already triggered or already paid?`, { parse_mode: "Markdown" });
  }

  const totalAllocated = pending.reduce((s, r) => s + BigInt(r.reward_lamports), 0n);
  if (totalAllocated <= 0n) {
    return ctx.reply(
      `Distribution \`${distId}\` has \`snapshot_pending\` rows but total allocation is 0 SOL.\n\n` +
      "Pass an override amount: `/distribute " + distId + " <sol_amount>`",
      { parse_mode: "Markdown" },
    );
  }

  // Pre-flight: lender must cover the total payout
  const { Keypair, Connection } = await import("@solana/web3.js");
  const bs58mod = await import("bs58");
  const bs58 = bs58mod.default || bs58mod;
  const fs = await import("node:fs");
  const path = await import("node:path");
  let lender;
  if (process.env.LENDER_PRIVATE_KEY) {
    lender = Keypair.fromSecretKey(bs58.decode(process.env.LENDER_PRIVATE_KEY));
  } else {
    const kpPath = process.env.LENDER_KEYPAIR_PATH;
    if (!kpPath) throw new Error("LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set — refusing the CWD-relative fallback.");
    lender = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(kpPath, "utf-8"))));
  }
  const { connection } = await import("../solana/connection.js");
  const balance = BigInt(await connection.getBalance(lender.publicKey));
  const RESERVE = 200_000_000n;
  if (balance < totalAllocated + RESERVE) {
    const balSol = (Number(balance) / 1e9).toFixed(4);
    const needSol = (Number(totalAllocated + RESERVE) / 1e9).toFixed(4);
    return ctx.reply(`❌ Lender balance ${balSol} SOL can't cover ${needSol} SOL (payout + 0.2 SOL reserve). Top up the lender wallet first.`);
  }

  const { pool: dbPool } = await import("../db/pool.js");
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE magpie_holder_rewards
          SET status = 'accrued'
        WHERE distribution_id = $1 AND status = 'snapshot_pending'`,
      [distId],
    );
    // Decrement pool by what's about to be paid out (matches the
    // accounting the auto-pay path would have done at snapshot time).
    await client.query(
      `UPDATE magpie_holder_pool
          SET accrued_lamports = accrued_lamports - $1::numeric,
              last_distribution_at = NOW(),
              updated_at = NOW()
        WHERE id = 1`,
      [totalAllocated.toString()],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    return ctx.reply(`❌ Flip failed: ${err.message?.slice(0, 200)}`);
  }
  client.release();

  const allocSol = (Number(totalAllocated) / 1e9).toFixed(6);
  await ctx.reply(
    [
      `✅ *Distribution ${distId} armed for payout*`,
      "",
      `Rows flipped: ${pending.length}`,
      `Total to pay: \`${allocSol} SOL\``,
      "",
      "_The holder-rewards retry loop runs every 6h and will pay these out in batches of 10. First batch usually lands within minutes. You'll get a final DM when all batches confirm._",
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}

/**
 * /aistats — last-24h snapshot of the AI support agent.
 *
 * Shows total conversations, turns, tool usage breakdown,
 * tickets opened by the AI, and an estimated USD cost. Useful
 * for spotting cost spikes, looping conversations, or quality issues.
 */
export async function handleAiStats(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    // 24h aggregates from support_conversations (token + turn counts)
    const { rows: [agg] } = await query(
      `SELECT
         COUNT(*)::int                                          AS conversations,
         COALESCE(SUM(turns), 0)::int                           AS turns,
         COALESCE(SUM(total_input_tokens), 0)::bigint           AS input_tok,
         COALESCE(SUM(total_output_tokens), 0)::bigint          AS output_tok,
         COUNT(DISTINCT user_id)::int                           AS unique_users
       FROM support_conversations
       WHERE last_active_at >= NOW() - INTERVAL '24 hours'`,
    );

    // AI-escalated tickets in last 24h
    const { rows: [tix] } = await query(
      `SELECT COUNT(*)::int AS count
         FROM support_tickets
        WHERE created_at >= NOW() - INTERVAL '24 hours'
          AND message LIKE '[AI-escalated]%'`,
    );

    // Today (UTC) for spend cap comparison
    const { rows: [today] } = await query(
      `SELECT
         COALESCE(SUM(total_input_tokens), 0)::bigint  AS input_tok,
         COALESCE(SUM(total_output_tokens), 0)::bigint AS output_tok
       FROM support_conversations
       WHERE last_active_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    );

    const cost24h = estimateCostUsd({
      input_tokens: Number(agg.input_tok),
      output_tokens: Number(agg.output_tok),
    });
    const costToday = estimateCostUsd({
      input_tokens: Number(today.input_tok),
      output_tokens: Number(today.output_tok),
    });
    const cap = Number(process.env.AI_DAILY_SPEND_USD) || 20;
    const capPct = ((costToday / cap) * 100).toFixed(0);

    const avgTurns = agg.conversations > 0 ? (agg.turns / agg.conversations).toFixed(1) : "0";

    const lines = [
      "🤖 *AI support · 24h*",
      "",
      `Conversations:   *${agg.conversations}*  (${agg.unique_users} unique users)`,
      `Total turns:     *${agg.turns}*  (avg ${avgTurns}/convo)`,
      `Input tokens:    \`${Number(agg.input_tok).toLocaleString()}\``,
      `Output tokens:   \`${Number(agg.output_tok).toLocaleString()}\``,
      `Cost (24h):      *$${cost24h.toFixed(3)}*`,
      "",
      `AI-escalated tickets: *${tix.count}*`,
      "",
      `Today (UTC): *$${costToday.toFixed(3)}* / $${cap} cap (${capPct}%)`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[aistats] error:", err);
    await ctx.reply(`❌ /aistats failed: ${err.message?.slice(0, 150) || "unknown error"}`);
  }
}

/**
 * /health — instant infra status snapshot.
 *
 * Shows current status + latency + error rate for each external
 * dependency (Anthropic, Helius RPC, public RPC fallback, DB).
 * The infra-health watcher updates these every 5 min in the
 * background.
 */
export async function handleInfraHealth(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const snap = getHealthSnapshot();
  const lines = ["🏥 *Infra health*", ""];
  function emoji(s) {
    return s === "healthy" ? "🟢" : s === "degraded" ? "🟡" : s === "down" ? "🔴" : "⚪️";
  }
  for (const key of Object.keys(snap)) {
    const p = snap[key];
    const ageMin = p.lastCheckedAt
      ? Math.max(0, Math.floor((Date.now() - p.lastCheckedAt) / 60_000))
      : null;
    const lat = p.lastLatencyMs != null ? `${p.lastLatencyMs}ms` : "n/a";
    const avg1h = p.avgLatencyMs_1h != null ? ` · 1h avg: ${p.avgLatencyMs_1h}ms` : "";
    const errPct = (p.errorRate_1h * 100).toFixed(0);
    const errLine = p.errorRate_1h > 0 ? ` · errors 1h: ${errPct}%` : "";
    lines.push(`${emoji(p.status)} *${p.name}* · ${p.status}`);
    lines.push(`  Last: ${lat}${avg1h}${errLine}`);
    if (ageMin != null) lines.push(`  Checked: ${ageMin}m ago`);
    if (p.lastError) lines.push(`  Last error: \`${p.lastError.slice(0, 120)}\``);
    lines.push("");
  }
  lines.push("_Probes run every 5 min in background. Alerts fire only after 15+ min sustained issues._");
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" }).catch(() => {
    ctx.reply(lines.join("\n").replace(/[*_`]/g, ""));
  });
}
