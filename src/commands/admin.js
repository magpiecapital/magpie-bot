import {
  isAdmin,
  pauseBorrowing,
  resumeBorrowing,
  isBorrowingPaused,
} from "../services/admin.js";
import { query } from "../db/pool.js";
import { estimateCostUsd } from "../services/ai-support.js";

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
  const arg = (ctx.message?.text || "").split(/\s+/)[1]?.toLowerCase() || "open";

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
  const arg = ctx.message.text.split(/\s+/)[1];
  const amountSol = parseFloat(arg);
  if (!arg || isNaN(amountSol) || amountSol <= 0) {
    return ctx.reply("Usage: `/fundpool <sol_amount>` — e.g. `/fundpool 5`", { parse_mode: "Markdown" });
  }
  if (amountSol > 100) {
    return ctx.reply("❌ Refusing to deposit > 100 SOL in a single call. Split it up.");
  }

  await ctx.reply(`⏳ Depositing ${amountSol} SOL into the pool from lender wallet…`);

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
      const kpPath = process.env.LENDER_KEYPAIR_PATH || path.resolve("lender-keypair.json");
      lender = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(kpPath, "utf-8"))));
    }

    const { connection } = await import("../solana/connection.js");
    const { getProgramForSigner } = await import("../solana/program.js");
    const { lendingPoolPda, loanTokenVaultPda } = await import("../solana/pdas.js");
    const program = getProgramForSigner(lender);

    // Pre-flight: lender balance must cover deposit + safety reserve + tx fees
    const lamports = BigInt(Math.floor(amountSol * 1e9));
    const balance = BigInt(await connection.getBalance(lender.publicKey));
    const RESERVE = 200_000_000n; // 0.2 SOL safety floor for ops
    if (balance < lamports + RESERVE) {
      return ctx.reply(
        `❌ Lender balance ${Number(balance) / 1e9} SOL can't cover ${amountSol} SOL deposit + 0.2 SOL reserve. ` +
          `Top up the lender wallet first.`,
      );
    }

    const [pool] = lendingPoolPda(lender.publicKey);
    const [loanTokenVault] = loanTokenVaultPda(pool);
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), pool.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
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

    await ctx.reply(
      [
        "✅ *Pool funded*",
        "",
        `Deposited: \`${amountSol} SOL\``,
        `New pool TVL: \`${newTvl.toFixed(4)} SOL\``,
        "",
        `[View tx](https://solscan.io/tx/${sig})`,
      ].join("\n"),
      { parse_mode: "Markdown", disable_web_page_preview: true },
    );
  } catch (err) {
    console.error("[fundpool] error:", err);
    await ctx.reply(`❌ Deposit failed: ${err.message?.slice(0, 150) || "unknown error"}`);
  }
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
