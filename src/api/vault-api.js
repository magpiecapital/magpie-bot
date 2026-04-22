/**
 * Agent Vault API
 *
 * REST endpoints for AI agents to interact with their vaults.
 *
 * GET  /api/v1/vault/derive?owner=...&agent=...               — Derive SOL vault PDA
 * GET  /api/v1/vault/info?address=...                        — Get SOL vault state
 * POST /api/v1/vault/spend                                   — Agent spends SOL from vault
 * GET  /api/v1/vault/token/derive?owner=...&agent=...&mint=... — Derive token vault PDA
 * GET  /api/v1/vault/token/info?address=...                   — Get token vault state
 * POST /api/v1/vault/token/spend                              — Agent spends tokens from vault
 */
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bs58 from "bs58";

import { connection } from "../solana/connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idlPath = path.join(__dirname, "..", "solana", "idl", "agent-vault.json");

let idl;
try {
  idl = JSON.parse(readFileSync(idlPath, "utf8"));
} catch {
  console.warn("[vault-api] IDL not found — vault API routes disabled");
}

const PROGRAM_ID = idl ? new PublicKey(idl.address) : null;
const VAULT_SEED = Buffer.from("vault");
const TOKEN_VAULT_SEED = Buffer.from("token_vault");

function deriveVaultPDA(owner, agent) {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, owner.toBuffer(), agent.toBuffer()],
    PROGRAM_ID,
  );
}

function getProgram(signer) {
  const provider = new AnchorProvider(connection, new Wallet(signer), {
    commitment: "confirmed",
  });
  return new Program(idl, provider);
}

function respond(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export async function handleVaultApi(req, res, url, routePath) {
  if (!idl) {
    return respond(res, 503, { error: "Agent Vault IDL not loaded" });
  }

  try {
    // GET /api/v1/vault/derive
    if (routePath === "/api/v1/vault/derive" && req.method === "GET") {
      const owner = url.searchParams.get("owner");
      const agent = url.searchParams.get("agent");
      if (!owner || !agent) {
        return respond(res, 400, { error: "owner and agent query params required" });
      }
      const [pda, bump] = deriveVaultPDA(new PublicKey(owner), new PublicKey(agent));
      return respond(res, 200, { vault: pda.toBase58(), bump });
    }

    // GET /api/v1/vault/info
    if (routePath === "/api/v1/vault/info" && req.method === "GET") {
      const address = url.searchParams.get("address");
      if (!address) {
        return respond(res, 400, { error: "address query param required" });
      }

      const vaultPk = new PublicKey(address);
      const info = await connection.getAccountInfo(vaultPk);
      if (!info) {
        return respond(res, 404, { error: "Vault not found" });
      }

      const dummy = Keypair.generate();
      const program = getProgram(dummy);
      const vault = program.coder.accounts.decode("Vault", info.data);

      const rent = 1_600_000;
      const available = Math.max(0, info.lamports - rent);
      const now = Date.now() / 1000;
      const sessionValid = Boolean(vault.isActive) &&
        (vault.sessionExpiry.toNumber() === 0 || now < vault.sessionExpiry.toNumber());
      const dailyRemaining = (now - vault.periodStart.toNumber() >= 86400)
        ? vault.dailyLimit.toNumber()
        : Math.max(0, vault.dailyLimit.toNumber() - vault.spentToday.toNumber());

      return respond(res, 200, {
        address: vaultPk.toBase58(),
        owner: vault.owner.toBase58(),
        agent: vault.agent.toBase58(),
        isActive: sessionValid,
        balance: { lamports: available, sol: available / LAMPORTS_PER_SOL },
        policy: {
          spendLimit: { lamports: vault.spendLimit.toNumber(), sol: vault.spendLimit.toNumber() / LAMPORTS_PER_SOL },
          dailyLimit: { lamports: vault.dailyLimit.toNumber(), sol: vault.dailyLimit.toNumber() / LAMPORTS_PER_SOL },
          dailyRemaining: { lamports: dailyRemaining, sol: dailyRemaining / LAMPORTS_PER_SOL },
        },
        session: {
          expiry: vault.sessionExpiry.toNumber(),
          expiryISO: vault.sessionExpiry.toNumber() > 0
            ? new Date(vault.sessionExpiry.toNumber() * 1000).toISOString()
            : null,
          valid: sessionValid,
        },
        stats: {
          totalSpent: { lamports: vault.totalSpent.toNumber(), sol: vault.totalSpent.toNumber() / LAMPORTS_PER_SOL },
          totalReceived: { lamports: vault.totalReceived.toNumber(), sol: vault.totalReceived.toNumber() / LAMPORTS_PER_SOL },
          txCount: vault.txCount.toNumber(),
          createdAt: new Date(vault.createdAt.toNumber() * 1000).toISOString(),
        },
      });
    }

    // POST /api/v1/vault/spend
    if (routePath === "/api/v1/vault/spend" && req.method === "POST") {
      const body = await readBody(req);
      const { vault, agentPrivateKey, destination, lamports } = body;

      if (!vault || !agentPrivateKey || !destination || !lamports) {
        return respond(res, 400, {
          error: "Required fields: vault, agentPrivateKey, destination, lamports",
        });
      }

      const agentKp = Keypair.fromSecretKey(bs58.decode(agentPrivateKey));
      const program = getProgram(agentKp);
      const vaultPk = new PublicKey(vault);
      const destPk = new PublicKey(destination);

      const sig = await program.methods
        .agentSpend(new BN(lamports))
        .accounts({
          vault: vaultPk,
          agent: agentKp.publicKey,
          destination: destPk,
        })
        .rpc({ commitment: "confirmed" });

      return respond(res, 200, {
        success: true,
        signature: sig,
        amount: { lamports, sol: lamports / LAMPORTS_PER_SOL },
        destination: destPk.toBase58(),
      });
    }

    // GET /api/v1/vault/token/derive
    if (routePath === "/api/v1/vault/token/derive" && req.method === "GET") {
      const owner = url.searchParams.get("owner");
      const agent = url.searchParams.get("agent");
      const mint = url.searchParams.get("mint");
      if (!owner || !agent || !mint) {
        return respond(res, 400, { error: "owner, agent, and mint query params required" });
      }
      const [pda, bump] = PublicKey.findProgramAddressSync(
        [TOKEN_VAULT_SEED, new PublicKey(owner).toBuffer(), new PublicKey(agent).toBuffer(), new PublicKey(mint).toBuffer()],
        PROGRAM_ID,
      );
      return respond(res, 200, { tokenVault: pda.toBase58(), bump, mint });
    }

    // GET /api/v1/vault/token/info
    if (routePath === "/api/v1/vault/token/info" && req.method === "GET") {
      const address = url.searchParams.get("address");
      if (!address) {
        return respond(res, 400, { error: "address query param required" });
      }

      const vaultPk = new PublicKey(address);
      const info = await connection.getAccountInfo(vaultPk);
      if (!info) {
        return respond(res, 404, { error: "Token vault not found" });
      }

      const dummy = Keypair.generate();
      const program = getProgram(dummy);
      const tv = program.coder.accounts.decode("TokenVault", info.data);

      let tokenBalance = 0;
      try {
        const ataInfo = await connection.getTokenAccountBalance(tv.tokenAccount);
        tokenBalance = Number(ataInfo.value.amount);
      } catch { /* ATA may not exist */ }

      const now = Date.now() / 1000;
      const sessionValid = Boolean(tv.isActive) &&
        (tv.sessionExpiry.toNumber() === 0 || now < tv.sessionExpiry.toNumber());
      const dailyRemaining = (now - tv.periodStart.toNumber() >= 86400)
        ? tv.dailyLimit.toNumber()
        : Math.max(0, tv.dailyLimit.toNumber() - tv.spentToday.toNumber());

      return respond(res, 200, {
        address: vaultPk.toBase58(),
        type: "token_vault",
        owner: tv.owner.toBase58(),
        agent: tv.agent.toBase58(),
        mint: tv.mint.toBase58(),
        tokenAccount: tv.tokenAccount.toBase58(),
        isActive: sessionValid,
        tokenBalance,
        policy: {
          spendLimit: tv.spendLimit.toNumber(),
          dailyLimit: tv.dailyLimit.toNumber(),
          dailyRemaining,
        },
        session: {
          expiry: tv.sessionExpiry.toNumber(),
          expiryISO: tv.sessionExpiry.toNumber() > 0
            ? new Date(tv.sessionExpiry.toNumber() * 1000).toISOString()
            : null,
          valid: sessionValid,
        },
        stats: {
          totalSpent: tv.totalSpent.toNumber(),
          totalReceived: tv.totalReceived.toNumber(),
          txCount: tv.txCount.toNumber(),
          createdAt: new Date(tv.createdAt.toNumber() * 1000).toISOString(),
        },
      });
    }

    // POST /api/v1/vault/token/spend
    if (routePath === "/api/v1/vault/token/spend" && req.method === "POST") {
      const body = await readBody(req);
      const { tokenVault, agentPrivateKey, destinationTokenAccount, mint, amount } = body;

      if (!tokenVault || !agentPrivateKey || !destinationTokenAccount || !mint || !amount) {
        return respond(res, 400, {
          error: "Required fields: tokenVault, agentPrivateKey, destinationTokenAccount, mint, amount",
        });
      }

      const agentKp = Keypair.fromSecretKey(bs58.decode(agentPrivateKey));
      const program = getProgram(agentKp);
      const vaultPk = new PublicKey(tokenVault);
      const mintPk = new PublicKey(mint);
      const destPk = new PublicKey(destinationTokenAccount);

      // Derive vault's ATA
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      const vaultTokenAccount = getAssociatedTokenAddressSync(mintPk, vaultPk, true);

      const sig = await program.methods
        .agentSpendToken(new BN(amount))
        .accounts({
          tokenVault: vaultPk,
          vaultTokenAccount,
          destinationTokenAccount: destPk,
          mint: mintPk,
          agent: agentKp.publicKey,
          tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        })
        .rpc({ commitment: "confirmed" });

      return respond(res, 200, {
        success: true,
        signature: sig,
        mint: mintPk.toBase58(),
        amount: Number(amount),
        destination: destPk.toBase58(),
      });
    }

    // Default: list endpoints
    return respond(res, 200, {
      protocol: "Agent Vault Protocol",
      description: "Programmable wallets for AI agents on Solana — SOL and SPL tokens",
      programId: PROGRAM_ID.toBase58(),
      endpoints: {
        "GET /api/v1/vault/derive?owner=...&agent=...": "Derive SOL vault PDA",
        "GET /api/v1/vault/info?address=...": "Get SOL vault state and balance",
        "POST /api/v1/vault/spend": "Agent spends SOL (body: vault, agentPrivateKey, destination, lamports)",
        "GET /api/v1/vault/token/derive?owner=...&agent=...&mint=...": "Derive token vault PDA",
        "GET /api/v1/vault/token/info?address=...": "Get token vault state and balance",
        "POST /api/v1/vault/token/spend": "Agent spends tokens (body: tokenVault, agentPrivateKey, destinationTokenAccount, mint, amount)",
      },
    });
  } catch (err) {
    const msg = err.message || "Unknown error";
    console.error("[vault-api] Error:", msg);
    return respond(res, 400, { error: msg });
  }
}
