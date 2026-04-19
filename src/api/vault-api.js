/**
 * Agent Vault API
 *
 * REST endpoints for AI agents to interact with their vaults.
 *
 * GET  /api/v1/vault/derive?owner=...&agent=...  — Derive vault PDA
 * GET  /api/v1/vault/info?address=...             — Get vault state
 * POST /api/v1/vault/spend                        — Agent spends from vault
 */
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
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

    // Default: list endpoints
    return respond(res, 200, {
      protocol: "Agent Vault Protocol",
      description: "Programmable wallets for AI agents on Solana",
      programId: PROGRAM_ID.toBase58(),
      endpoints: {
        "GET /api/v1/vault/derive?owner=...&agent=...": "Derive vault PDA address",
        "GET /api/v1/vault/info?address=...": "Get vault state, balance, and policy",
        "POST /api/v1/vault/spend": "Agent spends from vault (body: vault, agentPrivateKey, destination, lamports)",
      },
    });
  } catch (err) {
    const msg = err.message || "Unknown error";
    console.error("[vault-api] Error:", msg);
    return respond(res, 400, { error: msg });
  }
}
