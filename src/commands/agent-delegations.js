/**
 * Agent delegations — TG commands.
 *
 *   /agent_authorize <agent_pubkey> limit_close [max_per_order_sol=10]
 *                                                [max_active=5]
 *                                                [max_slippage_bps=500]
 *                                                [expires=30d]
 *   /agent_revoke <agent_pubkey> [action]
 *   /agent_list
 *
 * The user is the SOURCE OF TRUTH for what an agent can do on their
 * behalf. Every constraint here flows into agent_delegations and is
 * re-checked at every agent action — the x402 endpoint cannot exceed
 * these bounds, the engine cannot exceed these bounds.
 *
 * Security:
 *   - Ownership enforced on every read AND write (WHERE user_id = ctx.from.id)
 *   - Pubkey validated as base58 + correct length before any write
 *   - Schema CHECK constraints catch anything the parser missed
 *   - Revocation is one-way (status='revoked' is terminal) so audit
 *     trail is preserved
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { upsertUser } from "../services/users.js";
import { MIN_AGENT_DELEGATION_BPS, MAX_AGENT_DELEGATION_BPS } from "../lib/slippage-constants.js";
import { ensureWallet } from "../services/wallet.js";

const VALID_ACTIONS = new Set(["limit_close"]);
const MIN_ORDER_LAMPORTS = BigInt(100_000_000n);          // 0.1 SOL floor
const MAX_ORDER_LAMPORTS_HARD_CAP = BigInt(100_000_000_000n); // 100 SOL hard ceiling

function isValidPubkey(s) {
  if (typeof s !== "string") return false;
  if (s.length < 32 || s.length > 44) return false;
  try { new PublicKey(s); return true; } catch { return false; }
}

function parseDuration(s) {
  // "30d" / "12h" / "7d"
  const m = String(s).match(/^(\d+)([dh])$/);
  if (!m) return null;
  const n = Number(m[1]);
  const ms = m[2] === "d" ? n * 86_400_000 : n * 3_600_000;
  if (ms > 365 * 86_400_000) return null;
  return new Date(Date.now() + ms).toISOString();
}

function parseSolToLamports(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 1e9));
}

/* ─── /agent_authorize ─────────────────────────────────────────── */

export async function handleAgentAuthorize(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const text = ctx.message?.text || "";
  const tokens = text.trim().split(/\s+/).slice(1); // strip /agent_authorize
  if (tokens.length < 2) {
    return ctx.reply(
      "Usage: `/agent_authorize <agent_pubkey> limit_close [max_per_order_sol=10] [max_active=5] [max_slippage_bps=500] [expires=30d]`",
      { parse_mode: "Markdown" },
    );
  }
  const agentPubkeyRaw = tokens[0];
  const action = tokens[1];

  if (!isValidPubkey(agentPubkeyRaw)) {
    return ctx.reply("Invalid agent pubkey. Must be a valid Solana base58 pubkey.");
  }
  if (!VALID_ACTIONS.has(action)) {
    return ctx.reply(`Unknown action \`${action}\`. Allowed: ${[...VALID_ACTIONS].join(", ")}`, { parse_mode: "Markdown" });
  }

  // Parse optional key=value bounds
  let maxPerOrderLamports = BigInt(10_000_000_000n); // 10 SOL default
  let maxActiveOrders = 5;
  let maxSlippageBps = 500;
  let expiresAt = null;
  for (const t of tokens.slice(2)) {
    const m = t.match(/^([a-z_]+)=(.+)$/i);
    if (!m) return ctx.reply(`Unrecognized argument: \`${t}\``, { parse_mode: "Markdown" });
    const k = m[1].toLowerCase();
    const v = m[2];
    if (k === "max_per_order_sol") {
      const lamports = parseSolToLamports(v);
      if (!lamports) return ctx.reply(`Invalid max_per_order_sol: \`${v}\``, { parse_mode: "Markdown" });
      if (lamports < MIN_ORDER_LAMPORTS) {
        return ctx.reply(`max_per_order_sol must be at least ${Number(MIN_ORDER_LAMPORTS) / 1e9} SOL.`);
      }
      if (lamports > MAX_ORDER_LAMPORTS_HARD_CAP) {
        return ctx.reply(`max_per_order_sol cannot exceed ${Number(MAX_ORDER_LAMPORTS_HARD_CAP) / 1e9} SOL.`);
      }
      maxPerOrderLamports = lamports;
    } else if (k === "max_active") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        return ctx.reply("max_active must be an integer between 1 and 50.");
      }
      maxActiveOrders = n;
    } else if (k === "max_slippage_bps") {
      const n = Number(v);
      // User-consent ceiling — see src/lib/slippage-constants.js for why
      // this is lower than MAX_PROTOCOL_SLIPPAGE_BPS.
      if (!Number.isInteger(n) || n < MIN_AGENT_DELEGATION_BPS || n > MAX_AGENT_DELEGATION_BPS) {
        const minPct = (MIN_AGENT_DELEGATION_BPS / 100).toFixed(1);
        const maxPct = (MAX_AGENT_DELEGATION_BPS / 100).toFixed(1);
        return ctx.reply(`max_slippage_bps must be between ${MIN_AGENT_DELEGATION_BPS} and ${MAX_AGENT_DELEGATION_BPS} (${minPct}% to ${maxPct}%).`);
      }
      maxSlippageBps = n;
    } else if (k === "expires") {
      const iso = parseDuration(v);
      if (!iso) return ctx.reply("expires must be like `30d` or `12h` (max 365d).");
      expiresAt = iso;
    } else {
      return ctx.reply(`Unknown option \`${k}=\`. Allowed: max_per_order_sol, max_active, max_slippage_bps, expires.`, { parse_mode: "Markdown" });
    }
  }

  const user = await upsertUser(tgUser.id, tgUser.username);
  const userWallet = await ensureWallet(user.id);

  // UPSERT — overwriting existing active grant for same (wallet, agent, action).
  // The UNIQUE partial index makes "two active grants for the same tuple"
  // physically impossible. ON CONFLICT updates the bounds + extends expiry.
  try {
    await query(
      `INSERT INTO agent_delegations
         (user_id, user_wallet, agent_pubkey, action,
          max_per_order_lamports, max_active_orders, max_slippage_bps,
          status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
       ON CONFLICT (user_wallet, agent_pubkey, action) WHERE status = 'active'
       DO UPDATE SET
         max_per_order_lamports = EXCLUDED.max_per_order_lamports,
         max_active_orders      = EXCLUDED.max_active_orders,
         max_slippage_bps       = EXCLUDED.max_slippage_bps,
         expires_at             = EXCLUDED.expires_at,
         notes                  = COALESCE(agent_delegations.notes, '') || '\nupdated via /agent_authorize ' || NOW()::text`,
      [user.id, userWallet.publicKey, agentPubkeyRaw, action,
       maxPerOrderLamports.toString(), maxActiveOrders, maxSlippageBps,
       expiresAt],
    );
  } catch (err) {
    console.error("[agent-authorize] insert failed:", err.message);
    return ctx.reply(`Couldn't grant: ${err.message?.slice(0, 100)}`);
  }

  const expiryLabel = expiresAt ? `\nExpires: \`${expiresAt.slice(0, 10)}\`` : "";
  await ctx.reply(
    [
      `*Agent authorized*`,
      ``,
      `Agent: \`${agentPubkeyRaw.slice(0, 8)}…\``,
      `Action: \`${action}\``,
      `Max per order: \`${(Number(maxPerOrderLamports) / 1e9).toFixed(2)} SOL\``,
      `Max active orders: \`${maxActiveOrders}\``,
      `Max slippage: \`${(maxSlippageBps / 100).toFixed(2)}%\``,
      expiryLabel,
      ``,
      `The agent can now arm \`${action}\` orders on your custodial wallet within these bounds.`,
      `Revoke any time: \`/agent_revoke ${agentPubkeyRaw.slice(0, 8)}…\``,
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}

/* ─── /agent_revoke ───────────────────────────────────────────── */

export async function handleAgentRevoke(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const text = ctx.message?.text || "";
  const tokens = text.trim().split(/\s+/).slice(1);
  if (tokens.length < 1) {
    return ctx.reply("Usage: `/agent_revoke <agent_pubkey> [action]`", { parse_mode: "Markdown" });
  }
  const agentPubkey = tokens[0];
  const action = tokens[1] || null;
  if (!isValidPubkey(agentPubkey)) {
    return ctx.reply("Invalid agent pubkey.");
  }
  if (action && !VALID_ACTIONS.has(action)) {
    return ctx.reply(`Unknown action \`${action}\`.`, { parse_mode: "Markdown" });
  }
  const user = await upsertUser(tgUser.id, tgUser.username);

  const result = await query(
    `UPDATE agent_delegations
        SET status = 'revoked',
            revoked_at = NOW(),
            revoked_by = 'user'
      WHERE user_id = $1
        AND agent_pubkey = $2
        AND status = 'active'
        AND ($3::text IS NULL OR action = $3)
      RETURNING id, action`,
    [user.id, agentPubkey, action],
  );
  if (result.rows.length === 0) {
    return ctx.reply(`No active grant found for that agent.`);
  }
  const list = result.rows.map((r) => `\`${r.action}\``).join(", ");
  await ctx.reply(`Revoked ${result.rows.length} grant(s) for agent \`${agentPubkey.slice(0, 8)}…\`: ${list}`, { parse_mode: "Markdown" });
}

/* ─── /agent_list ─────────────────────────────────────────────── */

export async function handleAgentList(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);
  const { rows } = await query(
    `SELECT agent_pubkey, action, max_per_order_lamports::text AS cap,
            max_active_orders, max_slippage_bps, expires_at, granted_at
       FROM agent_delegations
      WHERE user_id = $1 AND status = 'active'
      ORDER BY granted_at DESC`,
    [user.id],
  );
  if (rows.length === 0) {
    return ctx.reply("No active agent delegations. Grant one with `/agent_authorize`.", { parse_mode: "Markdown" });
  }
  const lines = [`*Active agent delegations* (${rows.length})`, ``];
  for (const r of rows) {
    const expiry = r.expires_at ? ` · expires ${new Date(r.expires_at).toISOString().slice(0, 10)}` : "";
    const capSol = (Number(r.cap) / 1e9).toFixed(2);
    lines.push(`\`${r.agent_pubkey.slice(0, 8)}…\`  ${r.action}  cap=${capSol} SOL  max_active=${r.max_active_orders}  slip≤${(r.max_slippage_bps / 100).toFixed(1)}%${expiry}`);
  }
  lines.push(``, `Revoke: \`/agent_revoke <agent_pubkey>\``);
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
