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
import { parseStrike } from "../lib/strike-price-parser.js";

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
  // TP/SL ladder slice (migration 064). Default 100% (10000 bps) =
  // single-leg full close, matching pre-ladder behavior. User opts in
  // with `slice=25%` to arm a 25% leg, leaving 75% available for
  // additional legs at other price targets.
  let slice_pct = 10000;

  // Natural-language path: "at <value>" — the value can be ANY shape
  // the shared strike-price parser accepts. Examples:
  //   at 17M                  →  $17M MC (bare big numbers default to MC)
  //   at 17m mc               →  $17M MC (explicit kind word)
  //   at 17,000,000 MC        →  $17M MC (commas tolerated)
  //   at 17 million market cap →  $17M MC (number words tolerated)
  //   at $0.005               →  $0.005 USD price
  //   at 0.0025 sol           →  0.0025 SOL price
  //   at 2x / 0.7x            →  multiplier (resolved to USD price downstream)
  //   at -30% / down 30%      →  -30% multiplier (SL only)
  //   at +50% / up 50%        →  +50% multiplier (TP only)
  // Operator mandate (2026-06-14): all these forms MUST work the same
  // across TG, Pip, and the site. See src/lib/strike-price-parser.js.
  for (let i = 1; i < filtered.length; i++) {
    const t = filtered[i];

    // Handle "at <value [more words]>" — slurp everything until we hit
    // a key=value token or end of input. That way "at 17 million market
    // cap" works as one logical value even though it's 4 tokens.
    if (t.toLowerCase() === "at" && i + 1 < filtered.length) {
      const slurpedParts = [];
      let j = i + 1;
      while (j < filtered.length) {
        const next = filtered[j];
        // key=value tokens end the slurp.
        if (/^([a-z_]+)=/i.test(next)) break;
        slurpedParts.push(next);
        j++;
      }
      const rawValue = slurpedParts.join(" ");
      // bareNumberDefaultKind hint: SL uses price_usd by default (most
      // SL targets are USD price drops), TP uses mc_usd for big numbers.
      // The parser only uses this when the input is bare ("17"); explicit
      // kind words always win.
      const parsed = parseStrike(rawValue, {
        bareNumberDefaultKind: direction === "below" ? "price_usd" : undefined,
      });
      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }
      // Direction sanity: percent-move and multiplier targets carry
      // their own implied direction. Reject mismatches loudly.
      if (parsed.impliedDirection && parsed.impliedDirection !== direction) {
        return {
          ok: false,
          error: parsed.impliedDirection === "below"
            ? "That's a downside target — use /stoploss, not /takeprofit."
            : "That's an upside target — use /takeprofit, not /stoploss.",
        };
      }
      if (parsed.kind === "multiplier") {
        // Caller resolves to USD price using cross-sourced oracle.
        multiplier = parsed.multiplier;
        trigger_kind = "price_usd";
      } else {
        trigger_kind = parsed.kind;
        trigger_value_micro = parsed.valueMicro;
      }
      i = j - 1; // outer loop increment will move us past the consumed slurp
      continue;
    }

    // Power-user path: key=value
    const m = t.match(/^([a-z_]+)=(.+)$/i);
    if (!m) return { ok: false, error: `Unrecognized token: \`${t}\`. Use natural syntax (e.g. \`at 2x\`) or key=value pairs.` };
    const k = m[1].toLowerCase();
    const v = m[2];
    if (k === "mc") {
      // Route through the shared parser so commas, kind words, and
      // magnitude words all work in key=value form too.
      const parsed = parseStrike(v, { bareNumberDefaultKind: "mc_usd" });
      if (!parsed.ok) return { ok: false, error: parsed.error };
      if (parsed.kind === "multiplier") {
        return { ok: false, error: "Use `at 2x` syntax for multipliers (not `mc=`)." };
      }
      trigger_kind = parsed.kind;
      trigger_value_micro = parsed.valueMicro;
    } else if (k === "price") {
      const parsed = parseStrike(v, { bareNumberDefaultKind: "price_usd" });
      if (!parsed.ok) return { ok: false, error: parsed.error };
      if (parsed.kind === "multiplier") {
        return { ok: false, error: "Use `at 2x` syntax for multipliers (not `price=`)." };
      }
      trigger_kind = parsed.kind;
      trigger_value_micro = parsed.valueMicro;
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
    } else if (k === "slice") {
      // Accepted forms: "25%", "25", "2500bps". Bps stored as integer
      // 1..10000. Sum across armed legs per (loan_id, direction) is
      // enforced at INSERT time by migration 064's trigger.
      const raw = String(v).replace(/%$/, "").replace(/bps$/i, "").trim();
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `Invalid slice: \`${v}\`. Use a percent like \`slice=25%\`.` };
      }
      slice_pct = /bps$/i.test(v) ? Math.round(n) : Math.round(n * 100);
      if (slice_pct < 1 || slice_pct > 10000) {
        return { ok: false, error: "Slice must be between 0.01% and 100%." };
      }
    } else {
      return { ok: false, error: `Unknown option \`${k}=\`. Allowed: mc=, price=, slip=, dest=, expire=, slice=` };
    }
  }

  if (!trigger_kind && multiplier == null) {
    return { ok: false, error: "Specify a target: `at 2x`, `at $150m`, or `at $0.005`." };
  }
  return {
    ok: true,
    parsed: { loan_id, trigger_kind, trigger_value_micro, slippage_bps, dest, expire_iso, multiplier, slice_pct },
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

export async function handleLimitClose(ctx, direction = "above", opts = {}) {
  // opts.dryRun (operator-mandated 2026-06-16 PM,
  // feedback_tg_must_follow_v4_at_highest_level.md): run every
  // validation, oracle quote, slice/ladder check, and arm-core gate
  // — but skip the INSERT. Mirror of the x402 preflight endpoint;
  // closes the "did this arm actually validate?" question on TG
  // BEFORE the user gets a confusing failure DM.
  const dryRun = opts.dryRun === true;
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
    slicePct: parseResult.parsed.slice_pct,
    dryRun,
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
        case "invalid_slice_pct":
          return `Slice must be between 0.01% and 100%. Try \`slice=25%\` for a 25% leg.`;
        case "fractional_slice_not_supported_today":
          return `Partial-slice TP/SL is rolling out. For now, slice must be 100%. Multi-target arming at different prices IS supported today — e.g. \`/takeprofit ${loan_id} at 1.5x\` AND \`/takeprofit ${loan_id} at 2x\`.`;
        case "ladder_sum_exceeds_100":
          return `You already have armed legs on this loan/direction totaling near 100%. Cancel one or shrink your slice.`;
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

  // Dry-run preview — operator-mandated 2026-06-16 PM,
  // feedback_tg_must_follow_v4_at_highest_level.md. armOrder with
  // dryRun:true returned ok=true having validated every gate without
  // persisting. Tell the user explicitly that nothing was armed, then
  // show what WOULD have armed so they can choose to commit.
  if (dryRun && armed.ok) {
    const loanD = armed.loan;
    const mintD = armed.mint;
    const triggerLabelD = fmtTrigger(trigger_kind, trigger_value_micro);
    const isSlD = direction === "below";
    const symD = mintD?.symbol || "your collateral";
    const owedSolD = loanD?.owed ? (Number(loanD.owed) / 1e9).toFixed(4) : "?";
    const appliedD = armed.initialSlippageBpsApplied ?? slippage_bps;
    const originalD = armed.initialSlippageBpsRequested ?? slippage_bps;
    const bumpedD = appliedD !== originalD;
    return ctx.reply(
      [
        `*Preview only — nothing armed.*`,
        ``,
        `Loan: #${loanD?.loan_id || loan_id} (${symD}) · owes ${owedSolD} SOL`,
        `Direction: ${isSlD ? "stop-loss" : "take-profit"}`,
        `Trigger: ${triggerLabelD}`,
        multiplierContextLine ? `_${multiplierContextLine}_` : null,
        `Slippage: ${(appliedD / 100).toFixed(2)}%${bumpedD ? ` _(would be bumped from ${(originalD / 100).toFixed(2)}%)_` : ""}`,
        `Destination: ${dest.toUpperCase()}`,
        ``,
        `All gates passed at this moment. Run \`/${isSlD ? "stoploss" : "takeprofit"} ${loan_id} at ${multiplier ? `${multiplier}x` : triggerLabelD}\` (without "preview") to actually arm it.`,
        `_Liquidity can shift between now and a real arm._`,
      ].filter(Boolean).join("\n"),
      { parse_mode: "Markdown" },
    );
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
  // V4 in-vault behavior vs V1/V2/V3 fire-and-close behavior. The
  // operator-mandated V4 thesis is non-negotiable
  // (feedback_v4_in_vault_thesis_non_negotiable): on V4 fires, SOL
  // accumulates inside the per-loan sol_proceeds_vault and the loan
  // STAYS ACTIVE; the only path to the user's wallet is borrower-
  // signed repay. Legacy programs sell + repay + close in one shot.
  // The success DM must describe what will actually happen so users
  // know to repay when they want their SOL.
  const v4ProgramId = process.env.PROGRAM_ID_V4 || null;
  const isV4 = !!v4ProgramId && loan?.program_id === v4ProgramId;
  const purpose = isV4
    ? (isStopLoss
        ? `If ${symbol} ${triggerVerb} your floor, I'll sell that slice into SOL on-chain — the proceeds accumulate inside your loan's vault (V4 in-vault auto-sell). The loan stays Active; run /repay when you want the SOL released to your wallet.`
        : `When ${symbol} ${triggerVerb} your target, I'll sell that slice into SOL on-chain — the proceeds accumulate inside your loan's vault (V4 in-vault auto-sell). The loan stays Active; run /repay when you want the SOL released to your wallet.`)
    : (isStopLoss
        ? `If ${symbol} ${triggerVerb} your floor, I'll cut the position before liquidation: repay the ${owedSol} SOL loan + sell the collateral into ${dest.toUpperCase()}.`
        : `When ${symbol} ${triggerVerb} your target, I'll repay the ${owedSol} SOL loan + sell the collateral into ${dest.toUpperCase()}.`);
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
export async function handleStopLoss(ctx, opts = {}) {
  return handleLimitClose(ctx, "below", opts);
}

/* ─── /preview ─────────────────────────────────────────────────── */
// TG arm pre-flight (operator-mandated 2026-06-16 PM,
// feedback_tg_must_follow_v4_at_highest_level.md). Mirror of the
// site / x402 dry-run endpoints — runs the entire validation +
// oracle + slice / cap stack against the user's loan and reports
// whether an arm WOULD succeed right now, without persisting.
// Lets the user catch "trigger would fire immediately" / "loan
// below minimum size" / "ladder sum exceeds 100" before they
// commit a slot.
export async function handlePreviewTp(ctx) {
  return handleLimitClose(ctx, "above", { dryRun: true });
}
export async function handlePreviewSl(ctx) {
  return handleLimitClose(ctx, "below", { dryRun: true });
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

/* ─── /bracket ─────────────────────────────────────────────────── */
//
// One-shot TP + SL pair on the same loan. Schema (migration 047) and
// engine (execution.js sibling-cancel) already allow this — /bracket
// is just the UX surface that arms BOTH legs atomically from a single
// command, with rollback if leg 2 fails so the user never ends up in
// a half-armed state.
//
// Forms accepted:
//   /bracket 1234 tp=2x sl=0.7x
//   /bracket 1234 tp=$0.005 sl=$0.001 slip=3% dest=usdc
//   /bracket 1234 tp=$150m sl=$50m
//
// Mixed targets are fine — tp can be a multiplier while sl is an
// explicit price. The "first to fire wins; sibling auto-cancels" rule
// is documented in the confirmation reply.
export async function handleBracket(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const text = (ctx.message?.text || "").trim();
  const m = text.match(/^\/\S+\s+(.+)$/);
  if (!m) {
    return ctx.reply(
      "*Usage*\n\n" +
      "`/bracket <loan_id> tp=<target> sl=<floor> [slip=2% dest=sol]`\n\n" +
      "Examples:\n" +
      "`/bracket 1234 tp=2x sl=0.7x`\n" +
      "`/bracket 1234 tp=$0.005 sl=$0.001 slip=3%`\n" +
      "`/bracket 1234 tp=$150m sl=$50m dest=usdc`\n" +
      "`/bracket 1234 tp=2x sl=0.7x expire=30d` (both legs expire in 30 days)\n\n" +
      "Arms BOTH a take-profit and stop-loss. First to fire closes the loan; the other auto-cancels.",
      { parse_mode: "Markdown" },
    );
  }
  const rest = m[1].trim().split(/\s+/);
  const loan_id = rest[0];
  if (!/^\d+$/.test(loan_id)) {
    return ctx.reply("`<loan_id>` must be a positive integer. Try `/positions` to see your loans.", { parse_mode: "Markdown" });
  }

  // Parse the kv args. tp and sl can each be:
  //   multiplier: "2x", "0.7x"
  //   USD price:  "$0.005", "0.005"
  //   MC:         "$150m", "50M"
  function parseLeg(raw) {
    const v = raw.toLowerCase();
    // multiplier "<N>x"
    const mMul = v.match(/^([0-9]+(?:\.[0-9]+)?)x$/);
    if (mMul) return { kind: "multiplier", value: Number(mMul[1]) };
    // market cap "<N>[kmb]"
    const mMc = v.match(/^\$?([0-9]+(?:\.[0-9]+)?)([kmb])$/);
    if (mMc) {
      const mult = mMc[2] === "k" ? 1e3 : mMc[2] === "m" ? 1e6 : 1e9;
      return { kind: "mc_usd", value: Number(mMc[1]) * mult };
    }
    // USD price (bare or $-prefixed)
    const mPrice = v.match(/^\$?([0-9]+(?:\.[0-9]+)?)$/);
    if (mPrice) return { kind: "price_usd", value: Number(mPrice[1]) };
    return null;
  }

  let tpRaw = null;
  let slRaw = null;
  let slippage_bps = 200;
  let sell_destination = "sol";
  let expiresAtIso = null;
  for (const tok of rest.slice(1)) {
    const kv = tok.match(/^([a-z_]+)=(.+)$/i);
    if (!kv) continue;
    const k = kv[1].toLowerCase();
    const v = kv[2];
    if (k === "tp") tpRaw = v;
    else if (k === "sl") slRaw = v;
    else if (k === "slip") {
      const sm = v.match(/^(\d+(?:\.\d+)?)(%|bps)?$/i);
      if (!sm) return ctx.reply(`\`slip=${v}\` couldn't be parsed.`, { parse_mode: "Markdown" });
      const unit = (sm[2] || "%").toLowerCase();
      const bps = unit === "bps" ? Math.round(Number(sm[1])) : Math.round(Number(sm[1]) * 100);
      if (bps < 10 || bps > 2500) {
        return ctx.reply("`slip=` must be in 0.1%-25% (10-2500 bps).", { parse_mode: "Markdown" });
      }
      slippage_bps = bps;
    } else if (k === "dest") {
      const dv = v.toLowerCase();
      if (dv !== "sol" && dv !== "usdc") return ctx.reply("`dest=` must be sol or usdc.", { parse_mode: "Markdown" });
      sell_destination = dv;
    } else if (k === "expire" || k === "expires") {
      // Accept relative forms (30d, 12h) or an ISO date. Applies to
      // BOTH legs — the engine cancels each independently when its
      // own expires_at hits.
      const m = v.match(/^(\d+)([dh])$/i);
      if (m) {
        const n = Number(m[1]);
        const ms = m[2].toLowerCase() === "d" ? n * 86_400_000 : n * 3_600_000;
        expiresAtIso = new Date(Date.now() + ms).toISOString();
      } else if (!Number.isNaN(Date.parse(v))) {
        expiresAtIso = new Date(v).toISOString();
      } else {
        return ctx.reply(`\`expire=${v}\` couldn't be parsed. Try \`30d\`, \`12h\`, or an ISO date.`, { parse_mode: "Markdown" });
      }
    }
  }
  if (!tpRaw || !slRaw) {
    return ctx.reply("Both `tp=` and `sl=` are required. Try `/bracket 1234 tp=2x sl=0.7x`.", { parse_mode: "Markdown" });
  }
  const tp = parseLeg(tpRaw);
  const sl = parseLeg(slRaw);
  if (!tp) return ctx.reply(`Couldn't parse \`tp=${tpRaw}\`. Try \`2x\`, \`$0.005\`, or \`$150m\`.`, { parse_mode: "Markdown" });
  if (!sl) return ctx.reply(`Couldn't parse \`sl=${slRaw}\`. Try \`0.7x\`, \`$0.001\`, or \`$50m\`.`, { parse_mode: "Markdown" });
  if (tp.kind === "multiplier" && tp.value <= 1) {
    return ctx.reply("`tp=` multiplier must be > 1 (e.g. `2x`). For downside, use `sl=`.", { parse_mode: "Markdown" });
  }
  if (sl.kind === "multiplier" && sl.value >= 1) {
    return ctx.reply("`sl=` multiplier must be < 1 (e.g. `0.7x` = 70% of current). For upside, use `tp=`.", { parse_mode: "Markdown" });
  }

  const user = await upsertUser(tgUser.id, tgUser.username);

  // Resolve multipliers to concrete trigger values. Two oracle reads
  // (one per leg) — accepts the small cost for clearer error surface
  // and to avoid passing rawLevel through arm-core (which would push
  // the resolution into the inner critical path).
  const { rows: [loanForMint] } = await query(
    `SELECT collateral_mint FROM loans WHERE user_id = $1 AND loan_id = $2`,
    [user.id, loan_id],
  );
  if (!loanForMint) {
    return ctx.reply(`Loan #${loan_id} not found in your account.`);
  }

  async function resolveLeg(leg, allowBelowOne) {
    if (leg.kind === "multiplier") {
      const r = await resolveMultiplierToPrice(loanForMint.collateral_mint, leg.value, { allowBelowOne });
      if (!r.ok) return r;
      return { ok: true, triggerKind: "price_usd", triggerValueMicro: r.triggerValueMicro.toString(), currentUsd: r.currentUsd, resolvedUsd: r.targetUsd };
    }
    if (leg.kind === "price_usd") {
      return { ok: true, triggerKind: "price_usd", triggerValueMicro: BigInt(Math.round(leg.value * 1e6)).toString(), resolvedUsd: leg.value };
    }
    if (leg.kind === "mc_usd") {
      return { ok: true, triggerKind: "mc_usd", triggerValueMicro: BigInt(Math.round(leg.value * 1e6)).toString(), resolvedMc: leg.value };
    }
    return { ok: false, error: "Unhandled leg kind." };
  }

  const tpResolved = await resolveLeg(tp, false);
  if (!tpResolved.ok) return ctx.reply(`TP leg: ${tpResolved.error}`, { parse_mode: "Markdown" });
  const slResolved = await resolveLeg(sl, true);
  if (!slResolved.ok) return ctx.reply(`SL leg: ${slResolved.error}`, { parse_mode: "Markdown" });

  // Shared friendly mapper for arm-core error codes — surfaces the
  // common cases in plain language so users don't see raw enum
  // strings. Defaults to a generic fallback that names the leg.
  function legFriendly(leg, err) {
    switch (err) {
      case "loan_already_has_active_order_in_direction":
        return `${leg} leg failed — there's already a ${leg === "TP" ? "take-profit" : "stop-loss / trailing stop"} armed on this loan. Cancel it first with /cancellimitorder, or use /modifyorder to adjust in place.`;
      case "trigger_would_fire_immediately":
        return `${leg} leg failed — that trigger would fire RIGHT NOW. Pick a target on the unfired side.`;
      case "sl_below_solvency":
        return `${leg} leg failed — the SL floor is below what's needed to cover the loan (you'd liquidate before SL fires). Pick a tighter floor.`;
      case "loan_not_found_for_user":
        return `${leg} leg failed — loan #${loan_id} not found in your account.`;
      case "loan_not_active":
        return `${leg} leg failed — this loan isn't active.`;
      case "loan_below_minimum_size":
        return `${leg} leg failed — loan is below the 1 SOL minimum for limit-close orders.`;
      case "user_concurrency_cap_reached":
        return `${leg} leg failed — you've hit the active-order cap. Cancel one first.`;
      case "collateral_not_enabled":
        return `${leg} leg failed — this collateral isn't currently enabled in the protocol.`;
      case "invalid_slippage_bps":
        return `${leg} leg failed — slippage value is out of range.`;
      case "preflight_failed":
        return `${leg} leg failed — Jupiter pre-flight couldn't price the sell. Try again or use looser slippage.`;
      default:
        return `${leg} leg failed: \`${err || "unknown"}\``;
    }
  }

  // Arm leg 1 (TP). If this fails for ANY reason — duplicate-direction
  // index hit, oracle disagreement, etc. — bail before touching SL.
  const tpArm = await armOrder({
    userId: user.id,
    source: "tg",
    loanIdChain: String(loan_id),
    triggerKind: tpResolved.triggerKind,
    triggerValueMicro: tpResolved.triggerValueMicro,
    triggerDirection: "above",
    slippageBps: slippage_bps,
    sellDestination: sell_destination,
    expiresAt: expiresAtIso,
  });
  if (!tpArm.ok) {
    return ctx.reply(`${legFriendly("TP", tpArm.error)}\n\n_Bracket NOT armed._`, { parse_mode: "Markdown" });
  }

  // Arm leg 2 (SL). If this fails, roll back TP via cancelOrder so the
  // user never ends up with a half-armed bracket.
  const slArm = await armOrder({
    userId: user.id,
    source: "tg",
    loanIdChain: String(loan_id),
    triggerKind: slResolved.triggerKind,
    triggerValueMicro: slResolved.triggerValueMicro,
    triggerDirection: "below",
    slippageBps: slippage_bps,
    sellDestination: sell_destination,
    expiresAt: expiresAtIso,
  });
  if (!slArm.ok) {
    const { cancelOrder } = await import("../services/limit-close-arm-core.js");
    try {
      await cancelOrder({ orderId: tpArm.orderId, userId: user.id, reason: "bracket_partial_rollback" });
    } catch (err) {
      console.warn(`[bracket] rollback of TP ${tpArm.orderId} failed:`, err.message?.slice(0, 100));
    }
    return ctx.reply(
      `${legFriendly("SL", slArm.error)}\n\n_TP leg #${tpArm.orderId} was rolled back so you're not half-armed._`,
      { parse_mode: "Markdown" },
    );
  }

  const fmt = (n) => n < 0.01 ? n.toFixed(8) : n < 1 ? n.toFixed(6) : n.toFixed(4);
  const tpHuman = tp.kind === "multiplier"
    ? `${tp.value}× ($${fmt(tpResolved.resolvedUsd)})`
    : tp.kind === "mc_usd"
      ? `MC $${(tpResolved.resolvedMc / 1e6).toFixed(1)}M`
      : `$${fmt(tpResolved.resolvedUsd)}`;
  const slHuman = sl.kind === "multiplier"
    ? `${sl.value}× ($${fmt(slResolved.resolvedUsd)})`
    : sl.kind === "mc_usd"
      ? `MC $${(slResolved.resolvedMc / 1e6).toFixed(1)}M`
      : `$${fmt(slResolved.resolvedUsd)}`;
  return ctx.reply([
    `*Bracket armed* on loan #${loan_id}`,
    "",
    `TP: ${tpHuman} · order #${tpArm.orderId}`,
    `SL: ${slHuman} · order #${slArm.orderId}`,
    `Slippage: ${(slippage_bps / 100).toFixed(2)}% · proceeds → ${sell_destination.toUpperCase()}`,
    expiresAtIso ? `Both legs expire: ${new Date(expiresAtIso).toISOString().slice(0, 10)}` : null,
    "",
    `First leg to fire closes the loan and auto-cancels the other.`,
    `\`/limitorders\` to view, \`/cancellimitorder <id>\` to cancel either leg.`,
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
            lc.trailing_distance_bps,
            lc.peak_price_micros::text AS peak_price_micros,
            COALESCE(lc.slice_pct, 10000) AS slice_pct,
            lc.ladder_group_id,
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
    // Trailing stops get their own pill so users can spot them at a glance.
    // Direction is always 'below' for trailing — checked in the schema —
    // so the trailing pill replaces the bare SL one rather than stacking.
    const isTrailing = r.trailing_distance_bps != null;
    const directionPill = isTrailing
      ? `*TRAIL ${(r.trailing_distance_bps / 100).toFixed(1)}%*`
      : (r.trigger_direction === "below" ? "*SL*" : "*TP*");
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
    // Trailing peak line — surfaces the moving high so users see what
    // their effective floor is tracking. Watcher refreshes peak each tick.
    let peakLine = "";
    if (isTrailing && r.peak_price_micros) {
      const peakUsd = Number(r.peak_price_micros) / 1e6;
      const fmt = (n) => n < 0.01 ? n.toFixed(8) : n < 1 ? n.toFixed(6) : n.toFixed(4);
      peakLine = `\n   ~ peak $${fmt(peakUsd)} (floor floats with each new high)`;
    }
    // Slice badge — surfaces ladder legs. Hidden for the default 100%
    // case to keep single-leg display unchanged. Showing "slice 25%"
    // tells the user this is one rung of a multi-target plan.
    const slicePct = Number(r.slice_pct) || 10000;
    const sliceBadge = slicePct < 10000 ? ` · slice ${(slicePct / 100).toFixed(slicePct % 100 === 0 ? 0 : 1)}%` : "";
    // Ladder badge — when the row belongs to a ladder_group_id, surface a
    // short 4-char prefix so the user can visually tie sibling legs
    // together. Same prefix appears on every leg of the same ladder.
    const ladderBadge = r.ladder_group_id ? ` · ladder ${r.ladder_group_id.slice(0, 4)}` : "";
    lines.push(
      `${directionPill}${rwaBadge}  #${r.id} · loan ${r.chain_loan_id}${sym}`,
      `   → ${trig}  ·  slip ${slip}%  ·  ${r.sell_destination.toUpperCase()}${sliceBadge}${ladderBadge}  ·  armed ${ageLabel(r.armed_at)}${expiry}${peakLine}${distLine}`,
      "",
    );
  }

  // Ladder summary — for any ladder_group_id with multiple legs, add a
  // one-line "Ladder X: total Y% across N legs" so the user can see the
  // aggregate at a glance. Sorted by group so legs of the same ladder
  // appear consecutive in the message.
  const groups = new Map();
  for (const r of rows) {
    if (!r.ladder_group_id) continue;
    const g = groups.get(r.ladder_group_id) || { count: 0, totalSlice: 0, sym: r.collateral_symbol || "?" };
    g.count++;
    g.totalSlice += Number(r.slice_pct) / 100;
    groups.set(r.ladder_group_id, g);
  }
  if (groups.size > 0) {
    lines.push("_Ladders armed:_");
    for (const [gid, g] of groups) {
      lines.push(`  ${gid.slice(0, 4)}  ${g.sym}  ${g.count} legs  ${g.totalSlice.toFixed(0)}% total`);
    }
    lines.push("");
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
 *   trailing=<10%|1000bps>     — converts SL to trailing (SL only),
 *                                or "none" to clear back to regular SL
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
        "• `/modifyorder 412 trailing=10%` (convert SL → trailing 10%)",
        "• `/modifyorder 412 trailing=none` (back to regular SL)",
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
    } else if (key === "trailing" || key === "trail") {
      // trailing=10%   set/update trailing distance (SL only)
      // trailing=1000bps   same in bps
      // trailing=none   clear trailing (back to regular SL)
      const lower = val.toLowerCase();
      if (lower === "none" || lower === "off" || lower === "0") {
        updates.trailingDistanceBps = null;
      } else {
        let bps;
        if (lower.endsWith("%")) bps = Math.round(parseFloat(lower) * 100);
        else if (lower.endsWith("bps")) bps = Math.round(parseFloat(lower));
        else bps = Math.round(parseFloat(lower) * 100); // bare number → percent
        if (!Number.isFinite(bps) || bps < 50 || bps > 5000) {
          return ctx.reply(`\`trailing=${val}\` must be 0.5%–50% (50–5000 bps).`, { parse_mode: "Markdown" });
        }
        updates.trailingDistanceBps = bps;
      }
    } else {
      return ctx.reply(`Unknown field \`${key}\`. Supported: price, mc, slip, dest, expires, trailing.`, { parse_mode: "Markdown" });
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
      invalid_trailing_distance_bps: "Trailing must be 0.5%–50% (50–5000 bps).",
      trailing_only_valid_on_stop_loss: "Trailing only makes sense on a stop-loss (direction=below). This order is a take-profit.",
    };
    return ctx.reply(friendly[result.error] || `Modify failed: \`${result.error}\``, { parse_mode: "Markdown" });
  }

  const o = result.order;
  // Trailing line — surfaces the new floating-floor distance + the
  // seeded peak so the user can sanity-check the conversion.
  let trailingLine = null;
  if (o.trailing_distance_bps != null) {
    const pct = (o.trailing_distance_bps / 100).toFixed(1);
    if (o.peak_price_micros) {
      const peakUsd = Number(o.peak_price_micros) / 1e6;
      const fmt = (n) => n < 0.01 ? n.toFixed(8) : n < 1 ? n.toFixed(6) : n.toFixed(4);
      trailingLine = `Trailing: ${pct}% (peak $${fmt(peakUsd)} — floor floats with each new high)`;
    } else {
      trailingLine = `Trailing: ${pct}%`;
    }
  } else if (result.changedFields.includes("trailing_distance_bps")) {
    // Trailing was just CLEARED — show that explicitly so the user
    // doesn't wonder if their /modifyorder did nothing.
    trailingLine = "Trailing: cleared (regular stop-loss)";
  }
  return ctx.reply(
    [
      `*Order #${o.id} updated.*`,
      "",
      `Changed: ${result.changedFields.join(", ")}`,
      o.trigger_value_micro ? `New trigger: \`${o.trigger_value_micro}\` micros` : null,
      `Slippage: ${(o.slippage_bps / 100).toFixed(2)}%`,
      `Destination: ${(o.sell_destination || "").toUpperCase()}`,
      trailingLine,
      o.expires_at ? `Expires: ${new Date(o.expires_at).toISOString().slice(0, 10)}` : "Expires: never",
      "",
      "_Order stays armed — engine picks up new values on its next tick._",
    ].filter(Boolean).join("\n"),
    { parse_mode: "Markdown" },
  );
}

/* ─── /cancelbracket ───────────────────────────────────────────── */
//
// Cancels ALL armed limit-close orders on a single loan in one shot.
// Companion to /bracket — if a user runs /bracket and changes their
// mind, today they'd need /cancellimitorder twice (once per leg).
//
//   /cancelbracket 1234
//
// Returns a summary of which orders were cancelled. WHERE status='armed'
// is the race guard against the engine flipping an order to 'firing' on
// this tick — too-late cancels become "0 orders cancelled" with the
// same audit trail as a single /cancellimitorder race.
export async function handleCancelBracket(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const text = (ctx.message?.text || "").trim();
  const m = text.match(/^\/\S+\s+(\d+)/);
  if (!m) {
    return ctx.reply("Usage: `/cancelbracket <loan_id>`", { parse_mode: "Markdown" });
  }
  const loanIdChain = m[1];
  const user = await upsertUser(tgUser.id, tgUser.username);

  // Scope by user_id at the SQL layer so a stale or guessed loan_id
  // can't cancel another user's orders. Loan match is via the FK
  // resolved from the chain loan_id the user typed.
  const { rows } = await query(
    `UPDATE limit_close_orders
        SET status = 'cancelled',
            cancellation_reason = 'user_cancelled_bracket',
            updated_at = NOW()
      WHERE user_id = $1
        AND status = 'armed'
        AND loan_id = (SELECT id FROM loans WHERE user_id = $1 AND loan_id = $2 LIMIT 1)
      RETURNING id, COALESCE(trigger_direction, 'above') AS trigger_direction,
                trailing_distance_bps`,
    [user.id, loanIdChain],
  );
  if (rows.length === 0) {
    return ctx.reply(
      `No armed orders found on loan #${loanIdChain}. (Either no bracket was set, or it already fired/cancelled.)`,
    );
  }
  const lines = rows.map((r) => {
    const label = r.trailing_distance_bps != null
      ? `TRAIL ${(r.trailing_distance_bps / 100).toFixed(1)}%`
      : r.trigger_direction === "below" ? "SL" : "TP";
    return `• ${label} #${r.id}`;
  });
  return ctx.reply(
    [`*Cancelled ${rows.length} order${rows.length === 1 ? "" : "s"}* on loan #${loanIdChain}:`, "", ...lines].join("\n"),
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

/* ─────────────────────────────────────────────────────────────────
 * /fixarm — TG analog of the site's V4 silent-arm-recovery banner.
 *
 * Operator-mandated 2026-06-16 PM. Loan 800 PUMP V4 silent auto-arm
 * failure exposed a UX gap: when arming chain dies silently, a TG
 * user has no way to retry one-tap. This command:
 *
 *   1. Looks up the user's V4 active loans
 *   2. For each loan with zero armed orders, renders inline preset
 *      buttons: [Sell at 2x] [Sell at 3x] [Sell at 0.7x] [Bracket]
 *   3. Tapping a button calls armOrder() directly through the same
 *      arm-core that powers /takeprofit + /bracket
 *
 * Companion to the site recovery banner (PR #147) so TG-only users
 * get the same one-tap rescue path.
 *
 * Per feedback_v4_loans_never_show_exit_not_set.md +
 *     feedback_every_exit_click_must_arm.md.
 * ───────────────────────────────────────────────────────────────── */
export async function handleFixArm(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);
  const v4ProgramId = process.env.PROGRAM_ID_V4 ?? null;
  if (!v4ProgramId) {
    return ctx.reply("V4 routing is not configured on this bot instance.");
  }

  // Find user's active V4 loans whose only "armed" status count is
  // zero. These are the candidates for the silent-arm recovery flow.
  const { rows: loans } = await query(
    `SELECT l.id AS db_id, l.loan_id::text AS loan_id_chain,
            l.collateral_mint, sm.symbol AS symbol,
            sm.decimals AS decimals
       FROM loans l
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE l.user_id = $1
        AND l.status = 'active'
        AND l.program_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM limit_close_orders o
           WHERE o.loan_id = l.id
             AND o.status IN ('armed','firing','twap_in_progress','awaiting_user')
        )
      ORDER BY l.id DESC
      LIMIT 5`,
    [user.id, v4ProgramId],
  );

  if (loans.length === 0) {
    return ctx.reply(
      "No V4 loans need recovery. Either you have no V4 loans, or every active V4 loan already has at least one armed order. Use /limitorders to inspect.",
    );
  }

  // Lazy-load grammy InlineKeyboard so this file's existing callers
  // don't pay the import on warm paths.
  const { InlineKeyboard } = await import("grammy");

  // Intent-aware retry (operator-mandated 2026-06-16 PM,
  // feedback_tg_v4_must_match_site_quality.md). For each candidate
  // loan, look up pending arm_intents and surface the EXACT requested
  // strike as the primary retry button — not generic 2x/3x/0.7x
  // defaults. The hardcoded presets render only as a SECONDARY tier
  // when no intent exists for the loan.
  const loanChainIds = loans.map((l) => l.loan_id_chain);
  const intentsByLoanChain = new Map();
  if (loanChainIds.length > 0) {
    try {
      const { rows: intents } = await query(
        `SELECT id, loan_id_chain, direction, target_kind,
                target_value_micro::text AS target_value_micro,
                slice_pct_bps
           FROM arm_intents
          WHERE wallet IN (
            SELECT public_key FROM wallets WHERE user_id = $1
          )
            AND status = 'pending'
            AND loan_id_chain = ANY($2::text[])
            AND created_at > NOW() - INTERVAL '24 hour'
          ORDER BY created_at DESC`,
        [user.id, loanChainIds],
      );
      for (const r of intents) {
        const arr = intentsByLoanChain.get(r.loan_id_chain) || [];
        arr.push(r);
        intentsByLoanChain.set(r.loan_id_chain, arr);
      }
    } catch (e) {
      console.warn(`[fixarm] intent lookup failed (continuing with defaults): ${e.message?.slice(0, 100)}`);
    }
  }

  for (const ln of loans) {
    const sym = ln.symbol || ln.collateral_mint.slice(0, 4) + "…";
    const intents = intentsByLoanChain.get(ln.loan_id_chain) || [];

    const kb = new InlineKeyboard();
    let intentButtonsRendered = 0;
    for (const intent of intents) {
      const v = Number(intent.target_value_micro) / 1e6;
      const sliceBps = intent.slice_pct_bps ?? 10000;
      let label;
      // Callback shape: fixarm:intent:<loan_id_chain>:<intent_id> —
      // handler reads the intent row to drive the arm. Stays under
      // Telegram's 64-byte callback_data limit.
      if (intent.target_kind === "multiplier") {
        const verb = intent.direction === "above" ? "Sell at" : "Stop at";
        label = `${verb} ${v}x`;
        if (sliceBps < 10000) label += ` (${(sliceBps / 100).toFixed(0)}%)`;
      } else if (intent.target_kind === "price_usd") {
        const usd =
          v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(8)}`;
        label = `${intent.direction === "above" ? "Sell at" : "Stop at"} ${usd}`;
      } else if (intent.target_kind === "mc_usd") {
        const mc =
          v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B mc` : `$${(v / 1e6).toFixed(2)}M mc`;
        label = `${intent.direction === "above" ? "Sell at" : "Stop at"} ${mc}`;
      } else {
        label = `Retry ${intent.target_kind} ${v}`;
      }
      kb.text(label, `fixarm:intent:${ln.loan_id_chain}:${intent.id}`).row();
      intentButtonsRendered += 1;
    }

    if (intentButtonsRendered === 0) {
      kb.text("Sell at 2x", `fixarm:tp:${ln.loan_id_chain}:2`)
        .text("Sell at 3x", `fixarm:tp:${ln.loan_id_chain}:3`)
        .row()
        .text("Sell at 0.7x", `fixarm:sl:${ln.loan_id_chain}:0.7`)
        .text("Bracket 2x / 0.7x", `fixarm:br:${ln.loan_id_chain}`)
        .row();
    }
    kb.text("Skip this loan", `fixarm:skip:${ln.loan_id_chain}`);

    const headline =
      intentButtonsRendered > 0
        ? `*V4 loan on ${sym}* — your auto-sell didn't finish arming.\n\nWe have your exact strike on file. One tap retries it without losing the original target.`
        : `*V4 loan on ${sym}* — no armed exit found.\n\nThis loan landed on V4 because you set up an auto-sell, but the arming step didn't complete. Pick a preset to retry now — single Telegram tap:`;

    await ctx.reply(headline, { parse_mode: "Markdown", reply_markup: kb });
  }
}

export function registerFixArmCallbacks(bot) {
  bot.callbackQuery(/^fixarm:skip:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Skipped.");
    await ctx.editMessageText("Skipped — you can re-run /fixarm anytime.");
  });

  bot.callbackQuery(/^fixarm:(tp|sl):(\d+):([\d.]+)$/, async (ctx) => {
    const [, side, loanIdChain, mulStr] = ctx.match;
    const multiplier = Number(mulStr);
    const direction = side === "sl" ? "below" : "above";
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      await ctx.answerCallbackQuery("Invalid multiplier.");
      return;
    }
    await ctx.answerCallbackQuery("Arming…");

    const tgUser = ctx.from;
    const user = await upsertUser(tgUser.id, tgUser.username);

    // Find the loan's collateral mint so we can resolve the multiplier
    // through the same cross-source oracle the site uses.
    const { rows: [loan] } = await query(
      `SELECT collateral_mint FROM loans WHERE user_id = $1 AND loan_id::text = $2 LIMIT 1`,
      [user.id, loanIdChain],
    );
    if (!loan) {
      await ctx.editMessageText(`Loan #${loanIdChain} not found in your account.`);
      return;
    }

    const r = await resolveMultiplierToPrice(loan.collateral_mint, multiplier, {
      allowBelowOne: direction === "below",
    });
    if (!r.ok) {
      await ctx.editMessageText(
        `Couldn't resolve ${multiplier}x target: ${r.detail || r.error}\n\nTry again in a few seconds.`,
      );
      return;
    }

    const armed = await armOrder({
      userId: user.id,
      source: "tg",
      loanIdChain,
      triggerKind: "price_usd",
      triggerValueMicro: r.triggerValueMicro.toString(),
      triggerDirection: direction,
      slippageBps: direction === "below" ? 300 : 200,
      sellDestination: "sol",
    });

    if (!armed.ok) {
      await ctx.editMessageText(
        `❌ Arm failed (${armed.error}). ${armed.detail || ""}\n\nUse /limitclose ${loanIdChain} at ${multiplier}x to retry manually.`,
      );
      return;
    }

    const fmt = (n) => n < 0.01 ? n.toFixed(8) : n < 1 ? n.toFixed(6) : n.toFixed(4);
    const sideLabel = side === "tp" ? "Take-profit" : "Stop-loss";
    await ctx.editMessageText(
      `✓ ${sideLabel} armed at *${multiplier}x* — fires at $${fmt(r.targetUsd)}.\n\n` +
        `Order #${armed.orderId}. Manage via /limitorders.`,
      { parse_mode: "Markdown" },
    );
  });

  // Intent-aware retry handler (operator-mandated 2026-06-16 PM,
  // feedback_tg_v4_must_match_site_quality.md). Loads the pending
  // arm_intent row, resolves to a concrete trigger, calls armOrder
  // with intentId so the existing reconcile path marks the intent
  // 'armed' on success and the banner auto-hides.
  bot.callbackQuery(/^fixarm:intent:(\d+):(\d+)$/, async (ctx) => {
    const [, loanIdChain, intentIdStr] = ctx.match;
    const intentId = Number(intentIdStr);
    if (!Number.isInteger(intentId) || intentId <= 0) {
      await ctx.answerCallbackQuery("Invalid intent.");
      return;
    }
    await ctx.answerCallbackQuery("Arming…");

    const tgUser = ctx.from;
    const user = await upsertUser(tgUser.id, tgUser.username);

    const { rows: [intent] } = await query(
      `SELECT ai.id, ai.loan_id_chain, ai.direction, ai.target_kind,
              ai.target_value_micro::text AS target_value_micro,
              ai.slice_pct_bps
         FROM arm_intents ai
         JOIN wallets w ON w.public_key = ai.wallet AND w.user_id = $1
        WHERE ai.id = $2
          AND ai.loan_id_chain = $3
          AND ai.status = 'pending'
        LIMIT 1`,
      [user.id, intentId, loanIdChain],
    );
    if (!intent) {
      await ctx.editMessageText(
        `That intent isn't pending anymore — it may have already armed. /limitorders to inspect.`,
      );
      return;
    }

    const { rows: [loan] } = await query(
      `SELECT collateral_mint FROM loans WHERE user_id = $1 AND loan_id::text = $2 LIMIT 1`,
      [user.id, loanIdChain],
    );
    if (!loan) {
      await ctx.editMessageText(`Loan #${loanIdChain} not found in your account.`);
      return;
    }

    let triggerKind;
    let triggerValueMicro;
    let labelForUser;
    const targetVal = Number(intent.target_value_micro) / 1e6;
    if (intent.target_kind === "multiplier") {
      const r = await resolveMultiplierToPrice(loan.collateral_mint, targetVal, {
        allowBelowOne: intent.direction === "below",
      });
      if (!r.ok) {
        await ctx.editMessageText(
          `Couldn't resolve ${targetVal}x target: ${r.detail || r.error}\n\nTry again in a few seconds.`,
        );
        return;
      }
      triggerKind = "price_usd";
      triggerValueMicro = r.triggerValueMicro.toString();
      labelForUser = `${targetVal}x`;
    } else if (
      intent.target_kind === "price_usd" ||
      intent.target_kind === "mc_usd" ||
      intent.target_kind === "price_sol"
    ) {
      triggerKind = intent.target_kind;
      triggerValueMicro = intent.target_value_micro;
      if (intent.target_kind === "mc_usd") {
        labelForUser =
          targetVal >= 1e9 ? `$${(targetVal / 1e9).toFixed(2)}B mc` : `$${(targetVal / 1e6).toFixed(2)}M mc`;
      } else if (intent.target_kind === "price_usd") {
        labelForUser =
          targetVal >= 1 ? `$${targetVal.toFixed(2)}` : targetVal >= 0.01 ? `$${targetVal.toFixed(4)}` : `$${targetVal.toFixed(8)}`;
      } else {
        labelForUser = `${targetVal.toFixed(6)} SOL`;
      }
    } else {
      await ctx.editMessageText(`Intent kind \`${intent.target_kind}\` not retryable here yet. Use /limitclose ${loanIdChain} ${targetVal} manually.`);
      return;
    }

    const sliceBps = intent.slice_pct_bps && intent.slice_pct_bps < 10000 ? intent.slice_pct_bps : 10000;

    const armed = await armOrder({
      userId: user.id,
      source: "tg",
      loanIdChain,
      triggerKind,
      triggerValueMicro,
      triggerDirection: intent.direction,
      slicePct: sliceBps,
      slippageBps: intent.direction === "below" ? 300 : 200,
      sellDestination: "sol",
      intentId,
    });

    if (!armed.ok) {
      await ctx.editMessageText(
        `Arm failed (${armed.error}). ${armed.detail || ""}\n\nUse /limitclose ${loanIdChain} ${targetVal}${intent.target_kind === "multiplier" ? "x" : ""} to retry manually.`,
      );
      return;
    }

    const verb = intent.direction === "above" ? "Take-profit" : "Stop-loss";
    await ctx.editMessageText(
      `✓ ${verb} armed at *${labelForUser}* — exact strike you asked for.\n\nOrder #${armed.orderId}. Manage via /limitorders.`,
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery(/^fixarm:br:(\d+)$/, async (ctx) => {
    const [, loanIdChain] = ctx.match;
    await ctx.answerCallbackQuery("Arming bracket…");

    const tgUser = ctx.from;
    const user = await upsertUser(tgUser.id, tgUser.username);

    const { rows: [loan] } = await query(
      `SELECT collateral_mint FROM loans WHERE user_id = $1 AND loan_id::text = $2 LIMIT 1`,
      [user.id, loanIdChain],
    );
    if (!loan) {
      await ctx.editMessageText(`Loan #${loanIdChain} not found.`);
      return;
    }

    const tpR = await resolveMultiplierToPrice(loan.collateral_mint, 2, { allowBelowOne: false });
    const slR = await resolveMultiplierToPrice(loan.collateral_mint, 0.7, { allowBelowOne: true });
    if (!tpR.ok || !slR.ok) {
      await ctx.editMessageText(
        `Couldn't resolve bracket prices: ${tpR.detail || slR.detail || "oracle blip"}. Try again in a few seconds.`,
      );
      return;
    }

    // Arm TP first, then SL. If SL fails, we leave TP armed (still
    // protective on the upside) and tell the user. Matches /bracket
    // best-effort semantics.
    const tpArm = await armOrder({
      userId: user.id, source: "tg", loanIdChain,
      triggerKind: "price_usd",
      triggerValueMicro: tpR.triggerValueMicro.toString(),
      triggerDirection: "above",
      slippageBps: 200,
      sellDestination: "sol",
    });
    if (!tpArm.ok) {
      await ctx.editMessageText(`❌ TP arm failed (${tpArm.error}). Bracket aborted.`);
      return;
    }
    const slArm = await armOrder({
      userId: user.id, source: "tg", loanIdChain,
      triggerKind: "price_usd",
      triggerValueMicro: slR.triggerValueMicro.toString(),
      triggerDirection: "below",
      slippageBps: 300,
      sellDestination: "sol",
    });
    if (!slArm.ok) {
      await ctx.editMessageText(
        `✓ TP armed (order #${tpArm.orderId}) at 2x.\n` +
          `❌ SL failed (${slArm.error}). Re-try with /sl ${loanIdChain} at 0.7x.`,
      );
      return;
    }

    await ctx.editMessageText(
      `✓ Bracket armed — TP order #${tpArm.orderId} at 2x, SL order #${slArm.orderId} at 0.7x. Manage via /limitorders.`,
    );
  });
}
