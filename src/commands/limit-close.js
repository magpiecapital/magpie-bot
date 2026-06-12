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
import { runArmPreflight } from "../services/limit-close-preflight.js";
import { armOrder, resolveMultiplierToPrice } from "../services/limit-close-arm-core.js";

const MIN_LOAN_LAMPORTS = BigInt(1_000_000_000n); // 1 SOL eligibility floor
const MAX_ACTIVE_ORDERS_PER_USER = 10;
const MIN_TRIGGER_VALUE_MICRO = 1n;
const MAX_TRIGGER_VALUE_MICRO = 1_000_000_000_000_000n; // 1e15 — sanity ceiling

/**
 * Parse limit-close args. Supports TWO syntaxes:
 *
 *   1. NATURAL (recommended):
 *        /takeprofit 1234 at 2x
 *        /takeprofit 1234 at 3x slip=3%
 *        /takeprofit 1234 at $150m       (market cap target)
 *        /takeprofit 1234 at $0.005      (USD price target)
 *
 *      "at <N>x" means "when the collateral's USD price hits N times
 *      its current price." Engine computes the trigger at arm time so
 *      we lock in the multiplier semantically, not the raw price.
 *
 *   2. POWER (back-compat for /limitclose):
 *        /limitclose 1234 mc=130M slip=2% dest=sol
 *        /limitclose 1234 price=0.0025 slip=2%
 *
 * Returns { ok: true, parsed } or { ok: false, error }. Parsed includes
 * an optional `multiplier` field — if set, the caller must convert it
 * to a USD price using the live collateral price BEFORE inserting.
 */
function parseLimitCloseArgs(text) {
  // strip command word, normalize "/cmd 1234 at 2x" or "/cmd 1234 sell at 2x"
  const raw = text.trim();
  const tokens = raw.split(/\s+/).slice(1); // drop the /command word

  // Allow "sell" as an optional ignorable word: "/tp 1234 sell at 2x"
  // — makes the english read more naturally.
  const filtered = tokens.filter((t) => t.toLowerCase() !== "sell");
  if (filtered.length < 2) {
    return {
      ok: false,
      error:
        "*Usage:*\n" +
        "`/takeprofit <loan_id> at 2x`  (sell when price doubles)\n" +
        "`/takeprofit <loan_id> at $150m`  (market cap target)\n" +
        "`/takeprofit <loan_id> at $0.005 slip=3%`  (USD price target)\n\n" +
        "Find your loan_id with /loans.",
    };
  }
  const loanIdRaw = filtered[0];
  if (!/^\d+$/.test(loanIdRaw)) {
    return { ok: false, error: "loan_id must be a number. Find it with /loans." };
  }
  const loan_id = loanIdRaw;

  // Parse the key=value pairs
  let trigger_kind = null;
  let trigger_value_micro = null;
  let multiplier = null;            // set when user used "at Nx" — caller resolves to USD price
  let slippage_bps = 200;
  let dest = "sol";
  let expire_iso = null;

  // Natural-language path: "at <value>" where <value> is either:
  //   - "<N>x"     → multiplier semantic
  //   - "$<num>m"  → market cap USD
  //   - "$<num>"   → USD price target
  for (let i = 1; i < filtered.length; i++) {
    const t = filtered[i];

    // Handle "at <value>" — consume i+1 too.
    if (t.toLowerCase() === "at" && i + 1 < filtered.length) {
      const v = filtered[i + 1];
      // multiplier: "2x", "1.5x"
      const mMul = v.match(/^([0-9]+(?:\.[0-9]+)?)x$/i);
      if (mMul) {
        const n = Number(mMul[1]);
        if (!Number.isFinite(n) || n <= 1) {
          return { ok: false, error: "Multiplier must be > 1x (e.g. `at 2x`, `at 1.5x`)." };
        }
        multiplier = n;
        trigger_kind = "price_usd"; // we'll resolve to actual USD value before INSERT
        i++; // consume value
        continue;
      }
      // market cap: "$130m", "150M"
      const mMc = v.match(/^\$?([0-9]+(?:\.[0-9]+)?)([KMBkmb])$/);
      if (mMc) {
        trigger_kind = "mc_usd";
        const parsed = parseMcOrPrice(mMc[1] + mMc[2], "mc");
        if (!parsed.ok) return parsed;
        trigger_value_micro = parsed.micro;
        i++;
        continue;
      }
      // USD price: "$0.005" or "0.005"
      const mPrice = v.match(/^\$?([0-9]+(?:\.[0-9]+)?)$/);
      if (mPrice) {
        trigger_kind = "price_usd";
        const parsed = parseMcOrPrice(mPrice[1], "price_usd");
        if (!parsed.ok) return parsed;
        trigger_value_micro = parsed.micro;
        i++;
        continue;
      }
      return { ok: false, error: `Couldn't parse target after "at": \`${v}\`. Try \`at 2x\` or \`at $150m\` or \`at $0.005\`.` };
    }

    // Power-user path: key=value
    const m = t.match(/^([a-z_]+)=(.+)$/i);
    if (!m) return { ok: false, error: `Unrecognized token: \`${t}\`. Use natural syntax (e.g. \`at 2x\`) or key=value pairs.` };
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

  if (!trigger_kind && multiplier == null) {
    return { ok: false, error: "Specify a target: `at 2x`, `at $150m`, or `at $0.005`." };
  }
  return {
    ok: true,
    parsed: { loan_id, trigger_kind, trigger_value_micro, slippage_bps, dest, expire_iso, multiplier },
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
  // Upper bound matches arm-core's MAX_INITIAL_SLIPPAGE_BPS (25%). Thin-
  // liquidity memecoin pumps regularly want a wider initial slippage so the
  // first attempt fires; arm-core then derives an even wider cap on top.
  if (bps < 10 || bps > 2500) {
    return { ok: false, error: "Slippage must be between 0.1% and 25%." };
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
  let { loan_id, trigger_kind, trigger_value_micro, slippage_bps, dest, expire_iso } = parseResult.parsed;
  const { multiplier } = parseResult.parsed;

  const user = await upsertUser(tgUser.id, tgUser.username);

  // Multiplier path: resolve "at 2x" to a concrete USD micros price BEFORE
  // calling armOrder. armOrder takes a concrete trigger_value_micro — the
  // multiplier-to-price resolution is a TG-specific UX concern.
  let multiplierContextLine = null;
  if (multiplier != null && trigger_value_micro == null) {
    // We need the collateral mint to resolve. armOrder will re-fetch this
    // anyway, but at this stage we only need a cheap loans-table lookup.
    const { rows: [loanForMint] } = await query(
      `SELECT collateral_mint FROM loans WHERE user_id = $1 AND loan_id = $2`,
      [user.id, loan_id],
    );
    if (!loanForMint) {
      // armOrder will surface this same error anyway, but a friendly
      // pre-emptive message reads better than the resolveMultiplier
      // error.
      return ctx.reply(`Loan #${loan_id} not found in your account.`);
    }
    const r = await resolveMultiplierToPrice(loanForMint.collateral_mint, multiplier);
    if (!r.ok) {
      return ctx.reply(r.error, { parse_mode: "Markdown" });
    }
    trigger_value_micro = r.triggerValueMicro;
    trigger_kind = "price_usd";
    const fmt = (n) => n < 0.01 ? n.toFixed(8) : n < 1 ? n.toFixed(6) : n.toFixed(4);
    multiplierContextLine = `Current: $${fmt(r.currentUsd)} → target: $${fmt(r.targetUsd)} (${multiplier}×)`;
  }

  // Hand off to arm-core. This consolidates loan ownership, mint
  // allowlist + RWA exclusion, concurrency cap, fill-guarantee defaults
  // (autoEscalate=true, derived cap), liquidity-aware initial bump,
  // direction sanity check, INSERT, and the unique-index race guard.
  // Any future hardening in arm-core lands here automatically.
  const armed = await armOrder({
    userId: user.id,
    source: "tg",
    loanIdChain: String(loan_id),
    triggerKind: trigger_kind,
    triggerValueMicro: trigger_value_micro.toString(),
    slippageBps: slippage_bps,
    sellDestination: dest,
    expiresAt: expire_iso,
  });

  if (!armed.ok) {
    // Translate arm-core error codes to TG-friendly copy. Anything
    // unrecognized falls through to a generic message rather than
    // echoing the internal code.
    const m = (() => {
      switch (armed.error) {
        case "loan_not_found_for_user":
          return `Loan #${loan_id} not found in your account.`;
        case "loan_not_active":
          return `Loan #${loan_id} is ${armed.detail || "not active"}, not active. Limit-close orders require an active loan.`;
        case "loan_below_minimum_size":
          return `Loan is below the 1 SOL minimum for limit-close orders.`;
        case "collateral_not_enabled":
          return `Collateral token is not currently enabled in the protocol.`;
        case "rwa_collateral_not_supported_in_v1":
          return `Limit-close is not available on RWA collateral (xStocks/metals) in v1. Memecoin collateral only for now. Coming in v1.1.`;
        case "user_concurrency_cap_reached":
          return `You have ${armed.detail?.active} active limit orders (max ${armed.detail?.cap}). Cancel one with /cancellimitorder first.`;
        case "loan_already_has_active_order":
          return `This loan already has an active limit order. Cancel it first with /cancellimitorder.`;
        case "slippage_too_low":
          return [
            `*Order would not fill right now.*`,
            ``,
            `At current liquidity, ${(slippage_bps / 100).toFixed(2)}% slippage can't cover the loan + fee.`,
            armed.suggestedSlippageBps
              ? `A setting of *${(armed.suggestedSlippageBps / 100).toFixed(2)}%* would clear at current prices.`
              : "",
            ``,
            armed.suggestedSlippageBps
              ? `Re-run with \`slip=${(armed.suggestedSlippageBps / 100).toFixed(2)}%\` or wait for deeper liquidity.`
              : "Wait for deeper liquidity or pick a smaller collateral position.",
          ].filter(Boolean).join("\n");
        case "liquidity_insufficient":
          return `*Can't arm this order.*\n\nEven at the protocol's maximum slippage, current Jupiter routes can't cover the loan + fee. Consider a smaller collateral position, lowering your trigger, or waiting for deeper liquidity.`;
        case "no_route_for_collateral":
          return `Jupiter can't route a swap for this collateral right now. Wait a few minutes and try again.`;
        case "trigger_below_current":
        case "trigger_above_current":
          return `${armed.detail || "Trigger is on the wrong side of the current price."}`;
        default:
          console.error(`[limit-close] arm-core returned unrecognized error: ${armed.error}`, armed);
          return `Couldn't arm the order: ${armed.error}. Please try again.`;
      }
    })();
    return ctx.reply(m, { parse_mode: "Markdown" });
  }

  // Success — render the confirmation. arm-core surfaces any liquidity
  // bump via initialSlippageBpsRequested vs initialSlippageBpsApplied
  // so we can show the bump line when relevant.
  const orderId = armed.orderId;
  const loan = armed.loan;
  const mintRow = armed.mint;
  const triggerLabel = fmtTrigger(trigger_kind, trigger_value_micro);
  const owedSol = (Number(loan.owed) / 1e9).toFixed(4);
  const expiryLabel = expire_iso ? ` (expires ${expire_iso.slice(0, 10)})` : "";
  const symbol = mintRow.symbol || "your collateral";

  const appliedInitial = armed.initialSlippageBpsApplied ?? slippage_bps;
  const originalInitial = armed.initialSlippageBpsRequested ?? slippage_bps;
  const bumped = appliedInitial !== originalInitial;

  await ctx.reply(
    [
      `*Take-profit armed* — order #${orderId}${expiryLabel}`,
      ``,
      `Loan: #${loan.loan_id} (${symbol})`,
      `Trigger: ${triggerLabel}`,
      multiplierContextLine ? `_${multiplierContextLine}_` : null,
      `Slippage: ${(appliedInitial / 100).toFixed(2)}%${
        bumped
          ? ` _(bumped from ${(originalInitial / 100).toFixed(2)}% — ${symbol} has thin liquidity)_`
          : ""
      }`,
      `Destination: ${dest.toUpperCase()}`,
      ``,
      `When ${symbol} hits your target, I'll repay the ${owedSol} SOL loan + sell the collateral into ${dest.toUpperCase()}.`,
      `The 1% execution fee covers protocol operating costs.`,
      ``,
      `/takeprofitorders to view all · /cancellimitorder ${orderId} to cancel`,
    ].filter(Boolean).join("\n"),
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
