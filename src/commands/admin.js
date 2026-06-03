import {
  isAdmin,
  pauseBorrowing,
  resumeBorrowing,
  isBorrowingPaused,
} from "../services/admin.js";
import { query } from "../db/pool.js";

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
