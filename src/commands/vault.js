/**
 * /vault — Agent Vault management via Telegram.
 *
 * Usage:
 *   /vault              → Show your vault status
 *   /vault create       → Create a new agent vault
 *   /vault fund <SOL>   → Deposit SOL into your vault
 *   /vault policy       → Update spending policy
 *   /vault revoke       → Revoke agent access
 *   /vault withdraw     → Withdraw SOL from vault
 */
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bs58 from "bs58";
import "dotenv/config";

import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idlPath = path.join(__dirname, "..", "solana", "idl", "agent-vault.json");
const idl = JSON.parse(readFileSync(idlPath, "utf8"));

const PROGRAM_ID = new PublicKey(
  process.env.AGENT_VAULT_PROGRAM_ID || idl.address,
);

const VAULT_SEED = Buffer.from("vault");

function deriveVaultPDA(owner, agent) {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, owner.toBuffer(), agent.toBuffer()],
    PROGRAM_ID,
  );
}

function loadAuthority() {
  if (process.env.LENDER_PRIVATE_KEY) {
    return Keypair.fromSecretKey(bs58.decode(process.env.LENDER_PRIVATE_KEY));
  }
  throw new Error("No keypair available for vault operations");
}

function getProgram(signer) {
  const provider = new AnchorProvider(connection, new Wallet(signer), {
    commitment: "confirmed",
  });
  return new Program(idl, provider);
}

function solDisplay(lamports) {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4);
}

export async function handleVault(ctx) {
  const text = ctx.message?.text || "";
  const parts = text.split(/\s+/).slice(1);
  const sub = (parts[0] || "").toLowerCase();

  if (sub === "create") return handleVaultCreate(ctx);
  if (sub === "fund") return handleVaultFund(ctx, parts[1]);
  if (sub === "policy") return handleVaultPolicy(ctx, parts[1], parts[2]);
  if (sub === "revoke") return handleVaultRevoke(ctx);
  if (sub === "withdraw") return handleVaultWithdraw(ctx, parts[1]);

  return handleVaultStatus(ctx);
}

async function handleVaultStatus(ctx) {
  const tgId = String(ctx.from.id);

  const { rows: [user] } = await query(
    `SELECT id FROM users WHERE telegram_id = $1`,
    [tgId],
  );
  if (!user) return ctx.reply("Register first with /start");

  const { rows: [wallet] } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1`,
    [user.id],
  );
  if (!wallet) return ctx.reply("No wallet found. Use /deposit to create one.");

  const authority = loadAuthority();
  const ownerPk = new PublicKey(wallet.public_key);
  const agentPk = authority.publicKey;
  const [vaultPda] = deriveVaultPDA(ownerPk, agentPk);

  try {
    const program = getProgram(authority);
    const info = await connection.getAccountInfo(vaultPda);
    if (!info) {
      return ctx.reply(
        `🔐 *Agent Vault*\n\nNo vault found for your wallet.\nUse /vault create to get started.`,
        { parse_mode: "Markdown" },
      );
    }

    const vault = program.coder.accounts.decode("Vault", info.data);
    const balance = info.lamports;
    const rent = 1_600_000; // ~0.0016 SOL rent-exempt
    const available = Math.max(0, balance - rent);

    const now = Date.now() / 1000;
    const sessionActive = vault.isActive && (vault.sessionExpiry.toNumber() === 0 || now < vault.sessionExpiry.toNumber());
    const dailyRemaining = (now - vault.periodStart.toNumber() >= 86400)
      ? vault.dailyLimit.toNumber()
      : Math.max(0, vault.dailyLimit.toNumber() - vault.spentToday.toNumber());

    const lines = [
      `🔐 *Agent Vault*`,
      ``,
      `Status: ${sessionActive ? "✅ Active" : "🔴 Inactive"}`,
      `Balance: ${solDisplay(available)} SOL`,
      ``,
      `📋 *Policy*`,
      `Per-tx limit: ${solDisplay(vault.spendLimit.toNumber())} SOL`,
      `Daily limit: ${solDisplay(vault.dailyLimit.toNumber())} SOL`,
      `Daily remaining: ${solDisplay(dailyRemaining)} SOL`,
      ``,
      `📊 *Stats*`,
      `Total spent: ${solDisplay(vault.totalSpent.toNumber())} SOL`,
      `Transactions: ${vault.txCount.toNumber()}`,
    ];

    if (vault.sessionExpiry.toNumber() > 0) {
      const exp = new Date(vault.sessionExpiry.toNumber() * 1000);
      lines.push(`Session expires: ${exp.toISOString().slice(0, 16)}Z`);
    }

    return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[vault] status error:", err.message);
    return ctx.reply("Could not fetch vault status. The program may not be deployed yet.");
  }
}

async function handleVaultCreate(ctx) {
  const tgId = String(ctx.from.id);

  const { rows: [user] } = await query(
    `SELECT id FROM users WHERE telegram_id = $1`,
    [tgId],
  );
  if (!user) return ctx.reply("Register first with /start");

  const { rows: [wallet] } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1`,
    [user.id],
  );
  if (!wallet) return ctx.reply("No wallet found. Use /deposit to create one.");

  const authority = loadAuthority();
  const ownerPk = new PublicKey(wallet.public_key);
  const agentPk = authority.publicKey;
  const [vaultPda] = deriveVaultPDA(ownerPk, agentPk);

  // Check if vault already exists
  const existing = await connection.getAccountInfo(vaultPda);
  if (existing) return ctx.reply("You already have a vault! Use /vault to check status.");

  try {
    const program = getProgram(authority);

    // Default policy: 0.1 SOL per tx, 1 SOL per day, 7-day session
    const spendLimit = new BN(0.1 * LAMPORTS_PER_SOL);
    const dailyLimit = new BN(1 * LAMPORTS_PER_SOL);
    const sessionDuration = new BN(7 * 86400);

    const sig = await program.methods
      .createVault(agentPk, spendLimit, dailyLimit, sessionDuration)
      .accounts({
        vault: vaultPda,
        owner: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const lines = [
      `✅ *Agent Vault Created*`,
      ``,
      `Vault: \`${vaultPda.toBase58().slice(0, 16)}...\``,
      ``,
      `📋 *Default Policy*`,
      `Per-tx limit: 0.1 SOL`,
      `Daily limit: 1 SOL`,
      `Session: 7 days`,
      ``,
      `Fund it with /vault fund <SOL>`,
    ];

    return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[vault] create error:", err.message);
    return ctx.reply("Failed to create vault. The program may not be deployed yet.");
  }
}

async function handleVaultFund(ctx, amountStr) {
  if (!amountStr || isNaN(parseFloat(amountStr))) {
    return ctx.reply("Usage: /vault fund <SOL amount>\nExample: /vault fund 0.5");
  }

  const amount = parseFloat(amountStr);
  if (amount <= 0 || amount > 100) {
    return ctx.reply("Amount must be between 0 and 100 SOL.");
  }

  const tgId = String(ctx.from.id);
  const { rows: [user] } = await query(
    `SELECT id FROM users WHERE telegram_id = $1`,
    [tgId],
  );
  if (!user) return ctx.reply("Register first with /start");

  const { rows: [wallet] } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1`,
    [user.id],
  );
  if (!wallet) return ctx.reply("No wallet found.");

  const authority = loadAuthority();
  const ownerPk = new PublicKey(wallet.public_key);
  const [vaultPda] = deriveVaultPDA(ownerPk, authority.publicKey);

  try {
    const program = getProgram(authority);
    const lamports = Math.round(amount * LAMPORTS_PER_SOL);

    const sig = await program.methods
      .deposit(new BN(lamports))
      .accounts({
        vault: vaultPda,
        depositor: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    return ctx.reply(
      `✅ Deposited ${amount} SOL into your vault.\n\nTx: \`${sig.slice(0, 20)}...\``,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    console.error("[vault] fund error:", err.message);
    return ctx.reply("Failed to fund vault.");
  }
}

async function handleVaultPolicy(ctx, spendStr, dailyStr) {
  if (!spendStr || !dailyStr) {
    return ctx.reply(
      "Usage: /vault policy <per-tx SOL> <daily SOL>\nExample: /vault policy 0.05 0.5",
    );
  }

  const spend = parseFloat(spendStr);
  const daily = parseFloat(dailyStr);
  if (isNaN(spend) || isNaN(daily) || spend <= 0 || daily < spend) {
    return ctx.reply("Daily limit must be ≥ per-tx limit, both > 0.");
  }

  const tgId = String(ctx.from.id);
  const { rows: [user] } = await query(
    `SELECT id FROM users WHERE telegram_id = $1`, [tgId],
  );
  if (!user) return ctx.reply("Register first with /start");
  const { rows: [wallet] } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1`, [user.id],
  );
  if (!wallet) return ctx.reply("No wallet found.");

  const authority = loadAuthority();
  const [vaultPda] = deriveVaultPDA(
    new PublicKey(wallet.public_key),
    authority.publicKey,
  );

  try {
    const program = getProgram(authority);
    await program.methods
      .updatePolicy(
        new BN(Math.round(spend * LAMPORTS_PER_SOL)),
        new BN(Math.round(daily * LAMPORTS_PER_SOL)),
      )
      .accounts({ vault: vaultPda, owner: authority.publicKey })
      .rpc({ commitment: "confirmed" });

    return ctx.reply(
      `✅ Policy updated.\nPer-tx: ${spend} SOL | Daily: ${daily} SOL`,
    );
  } catch (err) {
    console.error("[vault] policy error:", err.message);
    return ctx.reply("Failed to update policy.");
  }
}

async function handleVaultRevoke(ctx) {
  const tgId = String(ctx.from.id);
  const { rows: [user] } = await query(
    `SELECT id FROM users WHERE telegram_id = $1`, [tgId],
  );
  if (!user) return ctx.reply("Register first with /start");
  const { rows: [wallet] } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1`, [user.id],
  );
  if (!wallet) return ctx.reply("No wallet found.");

  const authority = loadAuthority();
  const [vaultPda] = deriveVaultPDA(
    new PublicKey(wallet.public_key),
    authority.publicKey,
  );

  try {
    const program = getProgram(authority);
    await program.methods
      .revokeAgent()
      .accounts({ vault: vaultPda, owner: authority.publicKey })
      .rpc({ commitment: "confirmed" });

    return ctx.reply("🔴 Agent access revoked. Use /vault create to reactivate.");
  } catch (err) {
    console.error("[vault] revoke error:", err.message);
    return ctx.reply("Failed to revoke agent.");
  }
}

async function handleVaultWithdraw(ctx, amountStr) {
  if (!amountStr || isNaN(parseFloat(amountStr))) {
    return ctx.reply("Usage: /vault withdraw <SOL amount>");
  }

  const amount = parseFloat(amountStr);
  if (amount <= 0) return ctx.reply("Amount must be > 0.");

  const tgId = String(ctx.from.id);
  const { rows: [user] } = await query(
    `SELECT id FROM users WHERE telegram_id = $1`, [tgId],
  );
  if (!user) return ctx.reply("Register first with /start");
  const { rows: [wallet] } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1`, [user.id],
  );
  if (!wallet) return ctx.reply("No wallet found.");

  const authority = loadAuthority();
  const [vaultPda] = deriveVaultPDA(
    new PublicKey(wallet.public_key),
    authority.publicKey,
  );

  try {
    const program = getProgram(authority);
    await program.methods
      .ownerWithdraw(new BN(Math.round(amount * LAMPORTS_PER_SOL)))
      .accounts({ vault: vaultPda, owner: authority.publicKey })
      .rpc({ commitment: "confirmed" });

    return ctx.reply(`✅ Withdrew ${amount} SOL from vault.`);
  } catch (err) {
    console.error("[vault] withdraw error:", err.message);
    return ctx.reply("Failed to withdraw. Check vault balance.");
  }
}
