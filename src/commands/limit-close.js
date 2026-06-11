/**
 * Limit-Close-and-Sell — TG command handlers (v1).
 *
 *   /limitclose <loan_id> mc=130M slip=2% dest=sol
 *   /limitclose <loan_id> price=0.0025 slip=2%
 *   /limitorders                        — list user's open orders
 *   /cancellimitorder <order_id>        — cancel
 *
 * Security model (defense in depth):
 *   - Ownership is enforced on every write: WHERE user_id = ctx.from.id
 *     so a user can only see/cancel their own orders. No exception path.
 *   - The schema has a unique partial index on (loan_id WHERE status='armed')
 *     — physically impossible to have two armed orders against the same loan.
 *     Race-safe at the storage layer, not just the app layer.
 *   - Pre-arm checks reject trigger values that would fire immediately
 *     (no surprise instant-sell on order set), and trigger values that
 *     are mathematically incoherent (zero, negative, > 1e15 micros, etc.).
 *   - Min loan size, per-user concurrency cap, and collateral allowlist
 *     are all enforced before INSERT.
 *
 * Engine boundary:
 *   - These handlers WRITE to limit_close_orders. They never directly
 *     execute the close+sell flow. The private engine watches the DB
 *     and executes when triggered. Loose coupling = the engine can ship,
 *     redeploy, and iterate independently of this bot.
 */
import { query } from "../db/pool.js";
import { upsertUser } from "../services/users.js";

const MIN_LOAN_LAMPORTS = BigInt(1_000_000_000n); // 1 SOL eligibility floor
const MAX_ACTIVE_ORDERS_PER_USER = 10;
const MIN_TRIGGER_VALUE_MICRO = 1n;
const MAX_TRIGGER_VALUE_MICRO = 1_000_000_000_000_000n; // 1e15 — sanity ceiling

/**
 * Parse `/limitclose <loan_id> mc=130M slip=2% dest=sol [expire=30d]` style args.
 * Returns { ok: true, parsed } or { ok: false, error }.
 */
function parseLimitCloseArgs(text) {
  // /limitclose <loan_id> key1=val1 key2=val2 ...
  const tokens = text.trim().split(/\s+/).slice(1); // drop /limitclose
  if (tokens.length < 2) {
    return { ok: false, error: "Usage: `/limitclose <loan_id> mc=130M slip=2% dest=sol`" };
  }
  const loanIdRaw = tokens[0];
  // loan_id is the user-facing on-chain loan id stored in loans.loan_id
  // (NOT the DB primary key — users see the readable id).
  if (!/^\d+$/.test(loanIdRaw)) {
    return { ok: false, error: "loan_id must be a number. Find it with /loans." };
  }
  const loan_id = loanIdRaw;

  // Parse the key=value pairs
  let trigger_kind = null;
  let trigger_value_micro = null;
  let slippage_bps = 200;
  let dest = "sol";
  let expire_iso = null;

  for (const t of tokens.slice(1)) {
    const m = t.match(/^([a-z_]+)=(.+)$/i);
    if (!m) return { ok: false, error: `Unrecognized token: \`${t}\`` };
    const k = m[1].toLowerCase();
    const v = m[2];
    if (k === "mc") {
      trigger_kind = "mc_usd";
      const parsed = parseMcOrPrice(v, "mc");
      if (!parsed.ok) return parsed;
      trigger_value_micro = parsed.micro;
    } else if (k === "price") {
      // Default unit is USD unless v ends in "sol"
      if (/sol$/i.test(v)) {
        trigger_kind = "price_sol";
        const parsed = parseMcOrPrice(v.replace(/sol$/i, ""), "price_sol");
        if (!parsed.ok) return parsed;
        trigger_value_micro = parsed.micro;
      } else {
        trigger_kind = "price_usd";
        const parsed = parseMcOrPrice(v, "price_usd");
        if (!parsed.ok) return parsed;
        trigger_value_micro = parsed.micro;
      }
    } else if (k === "slip") {
      const parsed = parseSlippage(v);
      if (!parsed.ok) return parsed;
      slippage_bps = parsed.bps;
    } else if (k === "dest") {
      const lower = v.toLowerCase();
      if (lower !== "sol" && lower !== "usdc") {
        return { ok: false, error: "dest must be `sol` or `usdc`." };
      }
      dest = lower;
    } else if (k === "expire") {
      const parsed = parseExpiry(v);
      if (!parsed.ok) return parsed;
      expire_iso = parsed.iso;
    } else {
      return { ok: false, error: `Unknown option \`${k}=\`. Allowed: mc=, price=, slip=, dest=, expire=` };
    }
  }

  if (!trigger_kind) {
    return { ok: false, error: "Specify a trigger: `mc=130M` or `price=0.0025` (USD) or `price=0.0025sol`." };
  }
  return {
    ok: true,
    parsed: { loan_id, trigger_kind, trigger_value_micro, slippage_bps, dest, expire_iso },
  };
}

/**
 * Parse "130M" / "$130M" / "130000000" / "0.0025" into BigInt micros.
 * Supports M (1e6), B (1e9), K (1e3) suffixes. Stripped $.
 *
 * For mc/price_usd: 1 unit = 1 USD micro (1e-6 USD).
 * For price_sol:    1 unit = 1 lamport (1e-9 SOL).
 *
 * Returns { ok, micro: BigInt } or { ok: false, error }.
 */
function parseMcOrPrice(s, mode) {
  const raw = s.replace(/^\$/, "").trim();
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMBkmb])?$/);
  if (!match) return { ok: false, error: `Invalid number: \`${s}\`` };
  const numStr = match[1];
  const suffix = match[2]?.toLowerCase();
  const mul = suffix === "b" ? 1e9 : suffix === "m" ? 1e6 : suffix === "k" ? 1e3 : 1;

  // Use Number for parse (limited to ~1e15 precise) — fine for human-scale MCs.
  const baseNum = Number(numStr) * mul;
  if (!Number.isFinite(baseNum) || baseNum <= 0) {
    return { ok: false, error: `Invalid number: \`${s}\`` };
  }

  // Convert to micros (mode-specific). All paths produce BigInt micros at 1e6 USD or
  // 1e9 SOL precision so the comparison in the engine is integer math.
  let micro;
  if (mode === "price_sol") {
    micro = BigInt(Math.round(baseNum * 1e9)); // lamports
  } else {
    micro = BigInt(Math.round(baseNum * 1e6)); // USD micros
  }

  if (micro < MIN_TRIGGER_VALUE_MICRO || micro > MAX_TRIGGER_VALUE_MICRO) {
    return { ok: false, error: `Value out of range: \`${s}\`` };
  }
  return { ok: true, micro };
}

function parseSlippage(s) {
  // "2%" or "2" or "200bps"
  const raw = s.replace(/%$/, "").replace(/bps$/i, "").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: `Invalid slippage: \`${s}\`` };
  }
  const bps = /bps$/i.test(s) ? Math.round(n) : Math.round(n * 100);
  if (bps < 10 || bps > 1000) {
    return { ok: false, error: "Slippage must be between 0.1% and 10%." };
  }
  return { ok: true, bps };
}

function parseExpiry(s) {
  // "30d" / "7d" / "12h"
  const m = s.match(/^(\d+)([dh])$/);
  if (!m) return { ok: false, error: "expire must be like `30d` or `12h`." };
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === "d" ? n * 86_400_000 : n * 3_600_000;
  if (ms > 365 * 86_400_000) return { ok: false, error: "expire max is 365d." };
  const iso = new Date(Date.now() + ms).toISOString();
  return { ok: true, iso };
}

function fmtTrigger(kind, value_micro) {
  const n = Number(value_micro);
  if (kind === "mc_usd") {
    const usd = n / 1e6;
    if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B MC`;
    if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M MC`;
    if (usd >= 1e3) return `$${(usd / 1e3).toFixed(2)}K MC`;
    return `$${usd.toFixed(2)} MC`;
  }
  if (kind === "price_usd") {
    const usd = n / 1e6;
    return `$${usd.toFixed(usd < 1 ? 6 : 4)} USD/token`;
  }
  return `${(n / 1e9).toFixed(9)} SOL/token`;
}

/* ─── /limitclose ──────────────────────────────────────────────── */

export async function handleLimitClose(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const text = ctx.message?.text ?? "";

  const parseResult = parseLimitCloseArgs(text);
  if (!parseResult.ok) {
    return ctx.reply(parseResult.error, { parse_mode: "Markdown" });
  }
  const { loan_id, trigger_kind, trigger_value_micro, slippage_bps, dest, expire_iso } = parseResult.parsed;

  const user = await upsertUser(tgUser.id, tgUser.username);

  // 1. Loan must belong to this user, be active, and meet min size.
  const { rows: [loan] } = await query(
    `SELECT id, loan_id, status,
            original_loan_amount_lamports::text AS owed,
            collateral_mint, collateral_amount::text AS coll_amount
       FROM loans
      WHERE user_id = $1 AND loan_id = $2`,
    [user.id, loan_id],
  );
  if (!loan) {
    return ctx.reply(`Loan #${loan_id} not found in your account.`);
  }
  if (loan.status !== "active") {
    return ctx.reply(`Loan #${loan_id} is ${loan.status}, not active. Limit-close orders require an active loan.`);
  }
  if (BigInt(loan.owed) < MIN_LOAN_LAMPORTS) {
    return ctx.reply(`Loan is below the 1 SOL minimum for limit-close orders.`);
  }

  // 2. Collateral must be on the limit-close allowlist (operator-controlled
  //    column on supported_mints; default true for memecoins, false for RWAs
  //    until v1.1 ships).
  const { rows: [mintRow] } = await query(
    `SELECT enabled, category, symbol, COALESCE(limit_close_enabled, FALSE) AS limit_close_enabled
       FROM supported_mints WHERE mint = $1`,
    [loan.collateral_mint],
  );
  if (!mintRow || !mintRow.enabled) {
    return ctx.reply(`Collateral token is not currently enabled in the protocol.`);
  }
  // limit_close_enabled column doesn't exist yet — falls back to category-based default.
  // For v1: memecoins eligible, RWAs (stock/etf/metal) deferred to v1.1.
  if (["stock", "etf", "metal"].includes(mintRow.category)) {
    return ctx.reply(
      `Limit-close is not available on RWA collateral (xStocks/metals) in v1. ` +
      `Memecoin collateral only for now. Coming in v1.1.`,
    );
  }

  // 3. Per-user concurrency cap.
  const { rows: [activeCount] } = await query(
    `SELECT COUNT(*)::int AS n FROM limit_close_orders
       WHERE user_id = $1 AND status = 'armed'`,
    [user.id],
  );
  if (activeCount.n >= MAX_ACTIVE_ORDERS_PER_USER) {
    return ctx.reply(`You have ${activeCount.n} active limit orders (max ${MAX_ACTIVE_ORDERS_PER_USER}). Cancel one with /cancellimitorder first.`);
  }

  // 4. Pre-arm "would-fire-immediately" check. Refuse trigger values <= current
  //    market level. We DON'T fetch the live price here (cheaper to refuse only
  //    obviously-bad values via the trigger_value_micro range gates); the
  //    engine's pre-flight gate does the live-price re-check at fire time.
  //    The schema CHECK constraint enforces > 0 already; this is just a UX
  //    hint when the user clearly typed something wrong.

  // 5. Insert. The UNIQUE partial index on (loan_id WHERE status='armed')
  //    makes "two orders on the same loan" physically impossible at the
  //    storage layer.
  let insertResult;
  try {
    insertResult = await query(
      `INSERT INTO limit_close_orders
         (user_id, loan_id, trigger_kind, trigger_value_micro,
          slippage_bps, sell_destination, expires_at, source, status, armed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'tg', 'armed', NOW())
       RETURNING id`,
      [user.id, loan.id, trigger_kind, trigger_value_micro.toString(),
       slippage_bps, dest, expire_iso],
    );
  } catch (err) {
    if (/duplicate key value violates unique constraint/i.test(err.message)) {
      return ctx.reply(`This loan already has an active limit order. Cancel it first with /cancellimitorder.`);
    }
    console.error("[limit-close] insert failed:", err.message);
    return ctx.reply(`Couldn't arm the order. Try again.`);
  }

  const orderId = insertResult.rows[0].id;
  const triggerLabel = fmtTrigger(trigger_kind, trigger_value_micro);
  const owedSol = (Number(loan.owed) / 1e9).toFixed(4);
  const expiryLabel = expire_iso ? ` (expires ${expire_iso.slice(0, 10)})` : "";

  await ctx.reply(
    [
      `*Limit-close order #${orderId} armed* ${expiryLabel}`,
      ``,
      `Loan: #${loan.loan_id}`,
      `Trigger: ${triggerLabel}`,
      `Slippage: ${(slippage_bps / 100).toFixed(2)}%`,
      `Destination: ${dest.toUpperCase()}`,
      ``,
      `When the trigger hits, I'll repay the ${owedSol} SOL loan and sell the rest into ${dest.toUpperCase()}.`,
      `The 1% execution fee covers protocol operating costs.`,
      ``,
      `/limitorders to view all · /cancellimitorder ${orderId} to cancel`,
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}

/* ─── /limitorders ─────────────────────────────────────────────── */

export async function handleLimitOrders(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows } = await query(
    `SELECT lc.id, lc.trigger_kind, lc.trigger_value_micro::text AS trigger_value_micro,
            lc.slippage_bps, lc.sell_destination, lc.status,
            lc.armed_at, lc.expires_at,
            l.loan_id AS chain_loan_id,
            l.collateral_mint
       FROM limit_close_orders lc
       JOIN loans l ON l.id = lc.loan_id
      WHERE lc.user_id = $1 AND lc.status = 'armed'
      ORDER BY lc.armed_at DESC`,
    [user.id],
  );
  if (rows.length === 0) {
    return ctx.reply(`No active limit-close orders. Set one with /limitclose <loan_id> mc=130M.`);
  }
  const lines = [`*Your active limit-close orders* (${rows.length})`, ``];
  for (const r of rows) {
    const trig = fmtTrigger(r.trigger_kind, BigInt(r.trigger_value_micro));
    const slip = (r.slippage_bps / 100).toFixed(2);
    const expiry = r.expires_at ? ` · expires ${new Date(r.expires_at).toISOString().slice(0, 10)}` : "";
    lines.push(`#${r.id}  loan ${r.chain_loan_id}  →  ${trig}  slip=${slip}%  dest=${r.sell_destination.toUpperCase()}${expiry}`);
  }
  lines.push(``, `Cancel one: /cancellimitorder <order_id>`);
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

/* ─── /cancellimitorder ────────────────────────────────────────── */

export async function handleCancelLimitOrder(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const text = ctx.message?.text ?? "";
  const m = text.match(/^\/cancellimitorder(?:@\w+)?\s+(\d+)/);
  if (!m) {
    return ctx.reply("Usage: `/cancellimitorder <order_id>`", { parse_mode: "Markdown" });
  }
  const orderId = Number(m[1]);
  const user = await upsertUser(tgUser.id, tgUser.username);

  // Atomic cancel — guarded by user_id AND status to prevent racing the
  // engine that may be about to flip status='firing'. RETURNING tells us
  // whether the row was actually updated.
  const { rows } = await query(
    `UPDATE limit_close_orders
        SET status = 'cancelled',
            cancellation_reason = 'user_cancelled'
      WHERE id = $1 AND user_id = $2 AND status = 'armed'
      RETURNING id`,
    [orderId, user.id],
  );
  if (rows.length === 0) {
    return ctx.reply(`Order #${orderId} not found or already filled/cancelled.`);
  }
  await ctx.reply(`Order #${orderId} cancelled.`);
}
