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
function parseLimitCloseArgs(text, direction = "above") {
  // strip command word, normalize "/cmd 1234 at 2x" or "/cmd 1234 sell at 2x"
  const raw = text.trim();
  const tokens = raw.split(/\s+/).slice(1); // drop the /command word

  // Allow "sell" as an optional ignorable word: "/tp 1234 sell at 2x"
  // — makes the english read more naturally.
  const filtered = tokens.filter((t) => t.toLowerCase() !== "sell");
  if (filtered.length < 2) {
    return {
      ok: false,
      error: direction === "below"
        ? "*Usage:*\n" +
          "`/stoploss <loan_id> at -30%`  (sell if price drops 30%)\n" +
          "`/stoploss <loan_id> at 0.7x`  (sell at 70% of current price)\n" +
          "`/stoploss <loan_id> at $0.002 slip=3%`  (USD price floor)\n\n" +
          "Find your loan_id with /loans."
        : "*Usage:*\n" +
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
      // Stop-loss percent: "-30%" / "-5%"
      const mPct = v.match(/^-([0-9]+(?:\.[0-9]+)?)%$/);
      if (mPct) {
        if (direction !== "below") {
          return { ok: false, error: "Percent-drop targets (e.g. `at -30%`) are only valid for /stoploss." };
        }
        const p = Number(mPct[1]);
        if (!Number.isFinite(p) || p <= 0 || p >= 100) {
          return { ok: false, error: "Stop-loss percent must be between 0% and 100% (e.g. `at -30%`)." };
        }
        multiplier = 1 - (p / 100); // 30% drop → 0.7x of current
        trigger_kind = "price_usd";
        i++; continue;
      }
      // multiplier: "2x", "1.5x" (TP) or "0.7x", "0.5x" (SL)
      const mMul = v.match(/^([0-9]+(?:\.[0-9]+)?)x$/i);
      if (mMul) {
        const n = Number(mMul[1]);
        if (!Number.isFinite(n) || n <= 0) {
          return { ok: false, error: "Multiplier must be a positive number (e.g. `at 2x`, `at 0.7x`)." };
        }
        if (direction === "below") {
          if (n >= 1) {
            return { ok: false, error: "Stop-loss multiplier must be < 1x (e.g. `at 0.7x` = sell at 70% of current). Use /takeprofit for upside targets." };
          }
        } else {
          if (n <= 1) {
            return { ok: false, error: "Take-profit multiplier must be > 1x (e.g. `at 2x`). Use /stoploss for downside targets." };
          }
        }
        multiplier = n;
        trigger_kind = "price_usd"; // resolved to actual USD value before INSERT
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

export async function handleLimitClose(ctx, direction = "above") {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const text = ctx.message?.text ?? "";

  const parseResult = parseLimitCloseArgs(text, direction);
  if (!parseResult.ok) {
    return ctx.reply(parseResult.error, { parse_mode: "Markdown" });
  }
  let { loan_id, trigger_kind, trigger_value_micro, slippage_bps, dest, expire_iso } = parseResult.parsed;
  const { multiplier } = parseResult.parsed;

  const user = await upsertUser(tgUser.id, tgUser.username);

  // Multiplier path: resolve "at 2x" / "at 0.7x" / "at -30%" to a concrete
  // USD micros price BEFORE calling armOrder. armOrder takes a concrete
  // trigger_value_micro — the multiplier-to-price resolution is a TG-specific
  // UX concern.
  let multiplierContextLine = null;
  if (multiplier != null && trigger_value_micro == null) {
    const { rows: [loanForMint] } = await query(
      `SELECT collateral_mint FROM loans WHERE user_id = $1 AND loan_id = $2`,
      [user.id, loan_id],
    );
    if (!loanForMint) {
      return ctx.reply(`Loan #${loan_id} not found in your account.`);
    }
    const r = await resolveMultiplierToPrice(loanForMint.collateral_mint, multiplier, {
      allowBelowOne: direction === "below",
    });
    if (!r.ok) {
      return ctx.reply(r.error, { parse_mode: "Markdown" });
    }
    trigger_value_micro = r.triggerValueMicro;
    trigger_kind = "price_usd";
    const fmt = (n) => n < 0.01 ? n.toFixed(8) : n < 1 ? n.toFixed(6) : n.toFixed(4);
    const arrow = direction === "below" ? "↓" : "↑";
    multiplierContextLine = `Current: $${fmt(r.currentUsd)} ${arrow} target: $${fmt(r.targetUsd)} (${multiplier}×)`;
  }

  // Hand off to arm-core. Direction-aware: arm-core's immediate-fire guard
  // rejects an 'above' arm whose trigger is <= current, or a 'below' arm
  // whose trigger is >= current.
  const armed = await armOrder({
    userId: user.id,
    source: "tg",
    loanIdChain: String(loan_id),
    triggerKind: trigger_kind,
    triggerValueMicro: trigger_value_micro.toString(),
    triggerDirection: direction,
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
          // Unreachable since 2026-06-13 (PR C flipped the arm-core
          // gate; RWA collateral is now arm-eligible end-to-end via the
          // V2 fill path). Kept for back-compat with cached agent SDKs
          // that pattern-match on this error string.
          return `Limit-close on RWA collateral is now live — please try again.`;
        case "user_concurrency_cap_reached":
          return `You have ${armed.detail?.active} active limit orders (max ${armed.detail?.cap}). Cancel one with /cancellimitorder first.`;
        case "loan_already_has_active_order":
          // Legacy code from before per-direction UNIQUE shipped — kept
          // so any cached agent code that key-matches on it still gets
          // a friendly message.
          return `This loan already has an active limit order. Cancel it first with /cancellimitorder, or use /modifyorder to adjust it in place.`;
        case "loan_already_has_active_order_in_direction": {
          // Post-multi-leg (migration 047). Tells the user precisely
          // which side is occupied so they can choose: modify the
          // existing one, cancel it, OR arm the OPPOSITE side
          // (TP+SL on same loan is now supported).
          const existingDirection = armed.detail?.direction;
          const existingLabel = existingDirection === "below" ? "stop-loss" : "take-profit";
          const otherCmd = existingDirection === "below" ? "/takeprofit" : "/stoploss";
          const otherLabel = existingDirection === "below" ? "take-profit" : "stop-loss";
          return [
            `*You already have an active ${existingLabel} on this loan.*`,
            ``,
            `Options:`,
            `• \`/modifyorder <id> ...\` — adjust the existing one in place (no cancel/re-arm gap)`,
            `• \`/cancellimitorder <id>\` — cancel + re-arm`,
            `• \`${otherCmd} <loan_id> ...\` — arm a ${otherLabel} alongside it (TP+SL on same loan is now supported)`,
          ].join("\n");
        }
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
        case "trigger_would_fire_immediately":
          return direction === "below"
            ? `Stop-loss target is already at or above the current price — the order would fire immediately. Set a lower target.`
            : `Take-profit target is already at or below the current price — the order would fire immediately. Set a higher target.`;
        case "invalid_trigger_direction":
          return `Internal error — invalid trigger direction. Try again.`;
        case "sl_below_solvency": {
          // arm-core returned the math; surface it to the user clearly.
          const d = armed.detail || {};
          return [
            `*Stop-loss target is too low — would leave you owing more than the sale covers.*`,
            ``,
            `At that trigger, the engine estimates your collateral sells for about *${d.estimated_proceeds_at_trigger_sol} SOL*, but the loan repay needs *${d.required_proceeds_sol} SOL* (owed ${d.owed_sol} SOL + 5% safety buffer).`,
            `Shortfall: *${d.shortfall_sol} SOL*.`,
            ``,
            `Raise your stop-loss target so estimated proceeds cover the repay, OR repay part of the loan first to lower what you owe.`,
          ].join("\n");
        }
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

  const isStopLoss = direction === "below";
  const headline = isStopLoss
    ? `*Stop-loss armed* — order #${orderId}${expiryLabel}`
    : `*Take-profit armed* — order #${orderId}${expiryLabel}`;
  const triggerVerb = isStopLoss ? "drops to" : "hits";
  const purpose = isStopLoss
    ? `If ${symbol} ${triggerVerb} your floor, I'll cut the position before liquidation: repay the ${owedSol} SOL loan + sell the collateral into ${dest.toUpperCase()}.`
    : `When ${symbol} ${triggerVerb} your target, I'll repay the ${owedSol} SOL loan + sell the collateral into ${dest.toUpperCase()}.`;
  const listCmd = isStopLoss ? "/stoplosses" : "/takeprofitorders";

  await ctx.reply(
    [
      headline,
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
      purpose,
      `The 1% execution fee applies in both directions and covers protocol operating costs.`,
      ``,
      `${listCmd} to view all · /cancellimitorder ${orderId} to cancel`,
    ].filter(Boolean).join("\n"),
    { parse_mode: "Markdown" },
  );
}

/* ─── /stoploss ────────────────────────────────────────────────── */
// Thin wrapper that delegates to handleLimitClose with direction='below'.
// Shares every gate, fill-guarantee, and 1% fee — only the trigger
// comparator flips at fire time (see magpie-limitclose isTriggerHit).
export async function handleStopLoss(ctx) {
  return handleLimitClose(ctx, "below");
}

/* ─── /trailingstop ────────────────────────────────────────────── */
//
// Trailing-stop variant of /stoploss. Floor floats with the highest
// observed price; fires when price retraces from peak by the user's
// distance. The watcher updates peak_price_micros each tick (see
// magpie-limitclose watcher trailing block + migration 057).
//
// Forms accepted:
//   /trailingstop 1234 10%
//   /trailingstop 1234 trail=10%
//   /trailingstop 1234 trail=1000bps
//   /trailingstop 1234 10% slip=3%
//
// Implementation is intentionally direct rather than delegating to
// handleLimitClose because trailing changes the shape of "target":
// there isn't an explicit price/multiplier — the trail distance is
// the whole thing.
export async function handleTrailingStop(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const text = (ctx.message?.text || "").trim();

  // Pull /trailingstop off the front. Everything after is args.
  const m = text.match(/^\/\S+\s+(.+)$/);
  if (!m) {
    return ctx.reply(
      "*Usage*\n\n" +
      "`/trailingstop <loan_id> <distance>`\n\n" +
      "Examples:\n" +
      "`/trailingstop 1234 10%`  (sell if price retraces 10% from peak)\n" +
      "`/trailingstop 1234 trail=15% slip=3%`\n\n" +
      "Distance must be 0.5%-50%. Floor floats with each new high — fires when price drops that % from the peak observed since arm.",
      { parse_mode: "Markdown" },
    );
  }
  const rest = m[1].trim().split(/\s+/);
  const loan_id = rest[0];
  if (!/^\d+$/.test(loan_id)) {
    return ctx.reply("`<loan_id>` must be a positive integer. Try `/positions` to see your loans.", { parse_mode: "Markdown" });
  }

  // Trailing distance can be the bare token (e.g. "10%") or trail=...
  let trailingDistanceBps = null;
  let slippage_bps = 200; // default 2%
  for (const tok of rest.slice(1)) {
    const trailM = tok.match(/^(?:trail=)?(\d+(?:\.\d+)?)(%|bps)?$/i);
    const slipM = tok.match(/^slip=(\d+(?:\.\d+)?)(%|bps)?$/i);
    if (slipM) {
      const v = Number(slipM[1]);
      const unit = (slipM[2] || "%").toLowerCase();
      const bps = unit === "bps" ? Math.round(v) : Math.round(v * 100);
      if (!Number.isInteger(bps) || bps < 10 || bps > 2500) {
        return ctx.reply("`slip=` must be in 0.1%-25% (10-2500 bps).", { parse_mode: "Markdown" });
      }
      slippage_bps = bps;
    } else if (trailingDistanceBps == null && trailM) {
      const v = Number(trailM[1]);
      const unit = (trailM[2] || "%").toLowerCase();
      const bps = unit === "bps" ? Math.round(v) : Math.round(v * 100);
      if (!Number.isInteger(bps) || bps < 50 || bps > 5000) {
        return ctx.reply("Trailing distance must be 0.5%-50% (50-5000 bps).", { parse_mode: "Markdown" });
      }
      trailingDistanceBps = bps;
    }
  }
  if (trailingDistanceBps == null) {
    return ctx.reply("Missing trailing distance. Try `/trailingstop 1234 10%`.", { parse_mode: "Markdown" });
  }

  const user = await upsertUser(tgUser.id, tgUser.username);

  // Trailing arms need a starting trigger value. Same pattern as the
  // site endpoint: synthetic multiplier = 1 - trailing/10000 resolved
  // against current price seeds triggerValueMicro and peak_price_micros.
  const { rows: [loanForMint] } = await query(
    `SELECT collateral_mint FROM loans WHERE user_id = $1 AND loan_id = $2`,
    [user.id, loan_id],
  );
  if (!loanForMint) {
    return ctx.reply(`Loan #${loan_id} not found in your account.`);
  }
  const multiplier = 1 - (trailingDistanceBps / 10_000);
  const r = await resolveMultiplierToPrice(loanForMint.collateral_mint, multiplier, { allowBelowOne: true });
  if (!r.ok) {
    return ctx.reply(r.error, { parse_mode: "Markdown" });
  }

  const armed = await armOrder({
    userId: user.id,
    source: "tg",
    loanIdChain: String(loan_id),
    triggerKind: "price_usd",
    triggerValueMicro: r.triggerValueMicro.toString(),
    triggerDirection: "below",
    trailingDistanceBps,
    slippageBps: slippage_bps,
    sellDestination: "sol",
  });

  if (!armed.ok) {
    const friendly = (() => {
      switch (armed.error) {
        case "trailing_only_valid_on_stop_loss":
          return "Internal error — trailing was sent with wrong direction.";
        case "invalid_trailing_distance_bps":
          return "Trailing distance must be 0.5%-50% (50-5000 bps).";
        case "loan_already_has_active_order_in_direction":
          return `You already have a stop-loss on loan #${loan_id}. \`/cancellimitorder <id>\` first, OR \`/modifyorder <id>\` in place.`;
        case "loan_not_found_for_user":
          return `Loan #${loan_id} not found in your account.`;
        case "loan_below_minimum_size":
          return "Loan is below the 1 SOL minimum for limit-close orders.";
        case "user_concurrency_cap_reached":
          return `You have ${armed.detail?.active} active limit orders (max ${armed.detail?.cap}). Cancel one first.`;
        default:
          return `Couldn't arm trailing stop: ${armed.error}`;
      }
    })();
    return ctx.reply(friendly, { parse_mode: "Markdown" });
  }

  const fmt = (n) => n < 0.01 ? n.toFixed(8) : n < 1 ? n.toFixed(6) : n.toFixed(4);
  return ctx.reply([
    `*Trailing stop armed* on loan #${loan_id}`,
    "",
    `Distance: *${(trailingDistanceBps / 100).toFixed(1)}%* below peak`,
    `Current price: $${fmt(r.currentUsd)}`,
    `Initial floor: $${fmt(r.targetUsd)} (-${(trailingDistanceBps / 100).toFixed(1)}%)`,
    `Slippage: ${(slippage_bps / 100).toFixed(2)}%`,
    "",
    `Floor rises with each new high. Fires when price retraces ${(trailingDistanceBps / 100).toFixed(1)}% from peak.`,
    `Order ID: \`${armed.orderId}\` — \`/limitorders\` to view, \`/cancellimitorder ${armed.orderId}\` to cancel.`,
  ].join("\n"), { parse_mode: "Markdown" });
}

/* ─── /limitorders ─────────────────────────────────────────────── */

// Age tag: "3d ago" / "5h ago" / "12m ago"
function ageLabel(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// Signed distance from current → trigger, expressed as a percentage in
// the order's fire direction. Positive = the price needs to move N% in
// the trigger's favor before this fires. Returns null if we can't
// compute (price_sol triggers, missing supply for mc_usd, oracle hiccup).
async function distancePctToTrigger(row) {
  try {
    if (row.trigger_kind !== "price_usd" && row.trigger_kind !== "mc_usd") return null;
    const { getPriceInUsdCrossSourced } = await import("../services/price.js");
    const usd = await getPriceInUsdCrossSourced(row.collateral_mint);
    if (!usd || usd <= 0) return null;
    let currentMicros = null;
    if (row.trigger_kind === "price_usd") {
      currentMicros = BigInt(Math.round(usd * 1e6));
    } else if (row.trigger_kind === "mc_usd") {
      const { rows: [m] } = await query(
        `SELECT supply FROM supported_mints WHERE mint = $1`,
        [row.collateral_mint],
      );
      if (!m?.supply) return null;
      currentMicros = BigInt(Math.round(usd * 1e6)) * BigInt(m.supply);
    }
    if (currentMicros == null || currentMicros === 0n) return null;
    const triggerMicros = BigInt(row.trigger_value_micro);
    const diff = triggerMicros - currentMicros;
    const pct = Number(diff) / Number(currentMicros) * 100;
    const direction = row.trigger_direction || "above";
    return direction === "above" ? pct : -pct;
  } catch {
    return null;
  }
}

export async function handleLimitOrders(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows } = await query(
    `SELECT lc.id, lc.trigger_kind, lc.trigger_value_micro::text AS trigger_value_micro,
            COALESCE(lc.trigger_direction, 'above') AS trigger_direction,
            lc.slippage_bps, lc.sell_destination, lc.status,
            lc.armed_at, lc.expires_at,
            l.loan_id AS chain_loan_id,
            l.collateral_mint,
            m.symbol AS collateral_symbol,
            m.category AS collateral_category
       FROM limit_close_orders lc
       JOIN loans l ON l.id = lc.loan_id
       LEFT JOIN supported_mints m ON m.mint = l.collateral_mint
      WHERE lc.user_id = $1 AND lc.status = 'armed'
      ORDER BY lc.armed_at DESC`,
    [user.id],
  );
  if (rows.length === 0) {
    return ctx.reply(
      [
        "*No active limit-close orders.*",
        "",
        "Set one with `/limitclose <loan_id> mc=130M` (take-profit) or `/stoploss <loan_id> 0.7x` (stop-loss).",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  // Fetch distance for each order in parallel — they're independent
  // and the cross-sourced oracle has its own caching.
  const distances = await Promise.all(rows.map(distancePctToTrigger));

  const { InlineKeyboard } = await import("grammy");
  const lines = [`*Your active limit-close orders* (${rows.length})`, ""];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const trig = fmtTrigger(r.trigger_kind, BigInt(r.trigger_value_micro));
    const slip = (r.slippage_bps / 100).toFixed(r.slippage_bps < 200 ? 2 : 1);
    const directionPill = r.trigger_direction === "below" ? "*SL*" : "*TP*";
    // RWA badge — visible cue that this order routes through the V2
    // pool. Helps users mentally model why their stock-token TP might
    // pause Sat/Sun (engine weekend-fire skip for RWA TPs, PR #18 in
    // the engine repo).
    const isRwa = ["stock", "etf", "metal"].includes(r.collateral_category);
    const rwaBadge = isRwa ? " `[RWA]`" : "";
    const sym = r.collateral_symbol ? ` (${r.collateral_symbol})` : "";
    const expiry = r.expires_at ? ` · expires ${new Date(r.expires_at).toISOString().slice(0, 10)}` : "";
    const distPct = distances[i];
    let distLine = "";
    if (distPct != null) {
      const abs = Math.abs(distPct);
      // If distance is negative, the order should be firing on the next
      // engine tick. Make that visible to the user.
      if (distPct <= 0) distLine = `\n   ~ trigger reached — firing on next tick`;
      else if (abs < 1) distLine = `\n   ~ ${abs.toFixed(2)}% from trigger`;
      else if (abs < 10) distLine = `\n   ~ ${abs.toFixed(1)}% from trigger`;
      else distLine = `\n   ~ ${Math.round(abs)}% from trigger`;
    }
    lines.push(
      `${directionPill}${rwaBadge}  #${r.id} · loan ${r.chain_loan_id}${sym}`,
      `   → ${trig}  ·  slip ${slip}%  ·  ${r.sell_destination.toUpperCase()}  ·  armed ${ageLabel(r.armed_at)}${expiry}${distLine}`,
      "",
    );
  }

  // One inline cancel button per order — keeps the keyboard compact
  // even when the user has many orders. Reuses the staleness-nudge
  // callback so the cancel path is consistent across surfaces.
  const kb = new InlineKeyboard();
  for (let i = 0; i < rows.length; i++) {
    kb.text(`Cancel #${rows[i].id}`, `lcstale:cancel:${rows[i].id}`);
    if (i % 2 === 1) kb.row();
  }
  if (rows.length % 2 === 1) kb.row();

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: kb,
  });
}

/* ─── /modifyorder ─────────────────────────────────────────────── */

/**
 * /modifyorder <order_id> price=0.0030 slip=3% dest=usdc expires=2026-06-30
 *
 * All but order_id are optional — pass only what's changing. The
 * order stays armed throughout (no cancel/re-arm gap where the
 * market can move past the trigger).
 *
 * Accepted shortcuts (mirror /takeprofit):
 *   price=<usd_per_token>     — sets trigger_value_micro for price_usd
 *   mc=<$130M | 130_000_000>  — sets trigger_value_micro for mc_usd
 *   slip=<2%|200bps|200>       — sets slippage_bps
 *   dest=<sol|usdc>            — sets sell_destination
 *   expires=<YYYY-MM-DD|ISO>   — sets expires_at, or "none" to clear
 *
 * To change trigger_kind, trigger_direction, or loan_id: use /cancel + /takeprofit.
 */
export async function handleModifyLimitOrder(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const text = ctx.message?.text ?? "";
  const parts = text.trim().split(/\s+/).slice(1);
  if (parts.length < 1 || !/^\d+$/.test(parts[0])) {
    return ctx.reply(
      [
        "Usage: `/modifyorder <order_id> <changes…>`",
        "",
        "Examples:",
        "• `/modifyorder 412 price=0.0030`",
        "• `/modifyorder 412 slip=3% dest=usdc`",
        "• `/modifyorder 412 expires=2026-06-30`",
        "• `/modifyorder 412 expires=none` (clear expiration)",
        "",
        "_Order stays armed — no cancel/re-arm gap._",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  const orderId = Number(parts[0]);
  const args = parts.slice(1);
  const user = await upsertUser(tgUser.id, tgUser.username);

  // Parse kv args
  const updates = {};
  for (const a of args) {
    const m = a.match(/^([a-z_]+)=(.+)$/i);
    if (!m) return ctx.reply(`Couldn't parse \`${a}\` — use \`key=value\` form.`, { parse_mode: "Markdown" });
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === "price") {
      const usd = parseFloat(val);
      if (!Number.isFinite(usd) || usd <= 0) return ctx.reply(`\`price=${val}\` is invalid.`, { parse_mode: "Markdown" });
      updates.triggerValueMicro = BigInt(Math.round(usd * 1e6)).toString();
    } else if (key === "mc") {
      // Accept "130M", "130_000_000", "$130000000"
      const raw = val.replace(/[$_,]/g, "").toLowerCase();
      let usd;
      if (raw.endsWith("b")) usd = parseFloat(raw) * 1e9;
      else if (raw.endsWith("m")) usd = parseFloat(raw) * 1e6;
      else if (raw.endsWith("k")) usd = parseFloat(raw) * 1e3;
      else usd = parseFloat(raw);
      if (!Number.isFinite(usd) || usd <= 0) return ctx.reply(`\`mc=${val}\` is invalid.`, { parse_mode: "Markdown" });
      updates.triggerValueMicro = BigInt(Math.round(usd * 1e6)).toString();
    } else if (key === "slip") {
      let bps;
      if (val.endsWith("%")) bps = Math.round(parseFloat(val) * 100);
      else if (val.endsWith("bps")) bps = Math.round(parseFloat(val));
      else bps = Math.round(parseFloat(val));
      if (!Number.isFinite(bps) || bps < 10) return ctx.reply(`\`slip=${val}\` is invalid.`, { parse_mode: "Markdown" });
      updates.slippageBps = bps;
    } else if (key === "dest") {
      const v = val.toLowerCase();
      if (v !== "sol" && v !== "usdc") return ctx.reply(`\`dest=${val}\` must be sol or usdc.`, { parse_mode: "Markdown" });
      updates.sellDestination = v;
    } else if (key === "expires") {
      if (val.toLowerCase() === "none") updates.expiresAt = null;
      else if (Number.isNaN(Date.parse(val))) return ctx.reply(`\`expires=${val}\` couldn't be parsed.`, { parse_mode: "Markdown" });
      else updates.expiresAt = new Date(val).toISOString();
    } else {
      return ctx.reply(`Unknown field \`${key}\`. Supported: price, mc, slip, dest, expires.`, { parse_mode: "Markdown" });
    }
  }

  if (Object.keys(updates).length === 0) {
    return ctx.reply("No changes supplied. See /modifyorder for usage.", { parse_mode: "Markdown" });
  }

  const { modifyOrder } = await import("../services/limit-close-arm-core.js");
  const result = await modifyOrder({
    orderId,
    userId: user.id,
    ...updates,
  });
  if (!result.ok) {
    const friendly = {
      not_modifiable_or_not_found: "That order isn't yours, or it's already firing / closed.",
      invalid_trigger_value: "Trigger value is out of range.",
      invalid_slippage_bps: "Slippage must be 10–2500 bps (0.1%–25%).",
      slippage_exceeds_order_cap: result.detail
        ? `Slippage above this order's cap (${(result.detail.cap_bps / 100).toFixed(2)}%). Cancel + re-arm if you need more headroom.`
        : "Slippage above this order's cap. Cancel + re-arm if you need more.",
      invalid_sell_destination: "Destination must be sol or usdc.",
      invalid_expires_at: "Expires couldn't be parsed.",
      trigger_would_fire_immediately: "That new trigger would fire RIGHT NOW. Pick a target on the unfired side.",
      no_changes_supplied: "No changes supplied.",
    };
    return ctx.reply(friendly[result.error] || `Modify failed: \`${result.error}\``, { parse_mode: "Markdown" });
  }

  const o = result.order;
  return ctx.reply(
    [
      `*Order #${o.id} updated.*`,
      "",
      `Changed: ${result.changedFields.join(", ")}`,
      o.trigger_value_micro ? `New trigger: \`${o.trigger_value_micro}\` micros` : null,
      `Slippage: ${(o.slippage_bps / 100).toFixed(2)}%`,
      `Destination: ${(o.sell_destination || "").toUpperCase()}`,
      o.expires_at ? `Expires: ${new Date(o.expires_at).toISOString().slice(0, 10)}` : "Expires: never",
      "",
      "_Order stays armed — engine picks up new values on its next tick._",
    ].filter(Boolean).join("\n"),
    { parse_mode: "Markdown" },
  );
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
