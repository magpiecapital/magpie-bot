/**
 * POST /api/v1/site/limit-close/arm-preflight
 *
 * Dry-run validator for a planned arm. Takes the same parameters as the
 * real arm endpoint but does NOT require a signMessage envelope. Returns
 * exactly the same {error, detail} shape the real arm would return when
 * something is wrong, so the dashboard can surface the issue BEFORE
 * asking Phantom to sign.
 *
 * Why this exists (V4 Hardening T2, 2026-06-15 PM):
 *   Operator hit silent arm failures on V4 SPCX loan 781 — three attempts
 *   produced ZERO DB rows. Without a way to validate the request shape
 *   before signing, every Phantom popup was a dice roll. This endpoint
 *   lets the dashboard run `target` / `slippage` / `slice` / `direction` /
 *   eligibility / V4-enforcement through the same checks armOrder would
 *   apply, surface any rejection inline, and only ask Phantom to sign
 *   once we're confident the arm WILL succeed.
 *
 * Security: completely read-only. No DB writes. No envelope signatures
 * involved. Wallet ownership is verified by joining loans on
 * borrower_wallet. The endpoint refuses to reveal anything about a loan
 * the caller doesn't own (404 just like the real arm endpoint).
 *
 * Symmetric with the existing armOrder eligibility logic so a "would arm"
 * response is an honest preview, not a parallel implementation that
 * could drift.
 */
import { query } from "../db/pool.js";
import { PublicKey } from "@solana/web3.js";

/**
 * Handler signature mirrors the rest of the API server:
 *   ({ req, body }) => { status, body }
 */
export async function handleSiteLimitCloseArmPreflight(req) {
  // Parse JSON body — server.js routes pass `req` straight through, so
  // we read + parse here to keep this endpoint self-contained.
  let body;
  try {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  } catch (e) {
    return { status: 400, body: { ok: false, error: "invalid_json", detail: e.message?.slice(0, 80) } };
  }

  const wallet = String(body.wallet || "").trim();
  const loanIdChain = String(body.loan_id_chain || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return { status: 400, body: { ok: false, error: "invalid_wallet" } };
  }
  if (!/^\d+$/.test(loanIdChain)) {
    return { status: 400, body: { ok: false, error: "invalid_loan_id_chain" } };
  }

  // Validate the wallet pubkey parses; getReadOnlyProgram and the like
  // will throw on a bad input later otherwise.
  try { new PublicKey(wallet); } catch { return { status: 400, body: { ok: false, error: "invalid_wallet_format" } }; }

  // ── Resolve the user from the wallet (any linked or site-native row) ──
  // Use the canonical resolver mirror of the real arm path: linked TG
  // user_id takes precedence over site_native so the same loan is
  // visible from both surfaces. We only need user_id to look up the loan
  // by (user_id, loan_id) which mirrors the real arm endpoint's contract.
  const { resolveWalletOwner } = await import("../services/wallet-owner-resolver.js");
  const userId = await resolveWalletOwner(wallet);
  if (!userId) {
    return { status: 404, body: { ok: false, error: "wallet_not_linked", detail: "This wallet isn't linked to any Magpie account yet." } };
  }

  // ── Load the loan ──
  // Matches the real arm endpoint's query exactly so a 404 here means
  // the real arm would also 404. status='active' filter is intentional —
  // exits on a repaid/liquidated loan are nonsense.
  const { rows: [loan] } = await query(
    `SELECT id, loan_id::text AS loan_id, loan_pda, program_id, collateral_mint, status,
            original_loan_amount_lamports::text AS owed_lamports
       FROM loans
      WHERE user_id = $1 AND loan_id = $2 AND status = 'active'`,
    [userId, loanIdChain],
  );
  if (!loan) {
    return { status: 404, body: { ok: false, error: "loan_not_found_for_signer", detail: "No active loan with that loan_id for this wallet." } };
  }

  // ── V4-exclusive enforcement (same gate as arm-core) ──
  // If V4_EXIT_EXCLUSIVE_ENFORCE=true and the loan is non-V4, the real
  // arm WOULD reject. Surface that here so the dashboard knows BEFORE
  // signing.
  const v4Enforce = process.env.V4_EXIT_EXCLUSIVE_ENFORCE === "true";
  const v4ProgramId = process.env.PROGRAM_ID_V4 ?? null;
  if (v4Enforce && v4ProgramId && loan.program_id && loan.program_id !== v4ProgramId) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "exits_require_v4_loan",
        detail: "This loan is on a legacy pool. Repay and re-open the borrow with the exit set; the new loan will land on V4 automatically.",
        loan_program_id: loan.program_id,
        v4_program_id: v4ProgramId,
      },
    };
  }

  // ── Collateral allowlist ──
  const { rows: [mintRow] } = await query(
    `SELECT enabled, symbol, decimals, category FROM supported_mints WHERE mint = $1`,
    [loan.collateral_mint],
  );
  if (!mintRow || !mintRow.enabled) {
    return {
      status: 409,
      body: { ok: false, error: "collateral_not_enabled", detail: "This collateral isn't currently enabled for new arms." },
    };
  }

  // ── Direction ──
  const triggerDirection = String(body.direction || "above").toLowerCase();
  if (triggerDirection !== "above" && triggerDirection !== "below") {
    return { status: 400, body: { ok: false, error: "invalid_direction", detail: "Direction must be 'above' (TP) or 'below' (SL)." } };
  }
  const isSl = triggerDirection === "below";

  // ── Trailing distance (SL only) ──
  let trailingDistanceBps = null;
  if (body.trailing_distance_bps !== undefined && body.trailing_distance_bps !== null) {
    if (!isSl) {
      return { status: 400, body: { ok: false, error: "trailing_only_valid_on_stop_loss" } };
    }
    const t = Number(body.trailing_distance_bps);
    if (!Number.isInteger(t) || t < 50 || t > 5000) {
      return { status: 400, body: { ok: false, error: "invalid_trailing_distance_bps", detail: "Trailing must be 50–5000 bps (0.5%–50%)." } };
    }
    trailingDistanceBps = t;
  }

  // ── Target / Price / MC parsing (mirror arm endpoint) ──
  let triggerKind = null;
  let triggerValueMicro = null;
  let multiplierUsed = null;

  if (body.target) {
    const m = String(body.target).match(/^([0-9]+(?:\.[0-9]+)?)x$/i);
    if (!m) {
      return { status: 400, body: { ok: false, error: "invalid_target", detail: "Target must look like '2x'. Use price or mc for explicit values." } };
    }
    const mult = Number(m[1]);
    if (!Number.isFinite(mult) || mult <= 0) {
      return { status: 400, body: { ok: false, error: "invalid_target_multiplier" } };
    }
    if (!isSl && mult <= 1) {
      return { status: 400, body: { ok: false, error: "invalid_target_multiplier", detail: "Take-profit multiplier must be > 1× (e.g. 2× to fire when price doubles)." } };
    }
    if (isSl && mult >= 1) {
      return { status: 400, body: { ok: false, error: "invalid_target_multiplier", detail: "Stop-loss multiplier must be < 1× (e.g. 0.7× to fire when price drops to 70% of current)." } };
    }
    multiplierUsed = mult;
  } else if (body.price !== undefined) {
    const usd = Number(String(body.price).replace(/^\$/, ""));
    if (!Number.isFinite(usd) || usd <= 0) return { status: 400, body: { ok: false, error: "invalid_price" } };
    triggerKind = "price_usd";
    triggerValueMicro = BigInt(Math.round(usd * 1e6));
  } else if (body.mc !== undefined) {
    const raw = String(body.mc).replace(/^\$/, "");
    const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)([KMBkmb])?$/);
    if (!m) return { status: 400, body: { ok: false, error: "invalid_mc" } };
    const n = Number(m[1]);
    const mul = (m[2] || "").toLowerCase() === "b" ? 1e9 : (m[2] || "").toLowerCase() === "m" ? 1e6 : (m[2] || "").toLowerCase() === "k" ? 1e3 : 1;
    triggerKind = "mc_usd";
    triggerValueMicro = BigInt(Math.round(n * mul * 1e6));
  } else if (trailingDistanceBps != null) {
    triggerKind = "price_usd";
    multiplierUsed = 1 - (trailingDistanceBps / 10_000);
  } else {
    return { status: 400, body: { ok: false, error: "missing_target", detail: "Provide target (e.g. '2x'), price, mc, or trailing_distance_bps." } };
  }

  // ── Slippage ──
  const slippageBps = body.slippage_bps != null ? Number(body.slippage_bps) : 200;
  if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > 2500) {
    return { status: 400, body: { ok: false, error: "invalid_slippage", detail: "slippage_bps must be an integer in [10, 2500]." } };
  }

  // ── Slice (ladder leg) ──
  let slicePctBps = 10000;
  if (body.slice_pct_bps !== undefined && body.slice_pct_bps !== null) {
    const s = Number(body.slice_pct_bps);
    if (!Number.isInteger(s) || s < 1 || s > 10000) {
      return { status: 400, body: { ok: false, error: "invalid_slice_pct", detail: "slice_pct_bps must be an integer in [1, 10000]." } };
    }
    slicePctBps = s;
  }

  // ── Resolve multiplier-to-price using live oracle (mirrors arm path) ──
  let currentUsdRef = null;
  let targetUsdRef = null;
  if (multiplierUsed != null) {
    const { resolveMultiplierToPrice } = await import("../services/limit-close-arm-core.js");
    const r = await resolveMultiplierToPrice(loan.collateral_mint, multiplierUsed, { allowBelowOne: isSl });
    if (!r.ok) {
      return { status: 502, body: { ok: false, error: "multiplier_resolve_failed", detail: r.error } };
    }
    triggerKind = "price_usd";
    triggerValueMicro = r.triggerValueMicro;
    currentUsdRef = r.currentUsd;
    targetUsdRef = r.targetUsd;
  }

  // ── Existing armed orders check (would create a duplicate?) ──
  const { rows: existing } = await query(
    `SELECT id, slice_pct, status FROM limit_close_orders
      WHERE loan_id = $1 AND status = 'armed' AND COALESCE(trigger_direction, 'above') = $2`,
    [loan.id, triggerDirection],
  );
  // Check ladder-sum constraint (migration 065): per-direction slice
  // sums must stay <= 10000 bps. If adding this would overflow, the real
  // arm would reject — surface here.
  const sumExisting = existing.reduce((acc, o) => acc + Number(o.slice_pct || 10000), 0);
  if (sumExisting + slicePctBps > 10000) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "slice_overflow",
        detail: `Existing ${triggerDirection}-direction orders already use ${(sumExisting / 100).toFixed(0)}% of collateral; this leg would overflow.`,
        existing_slice_pct_total: sumExisting,
        requested_slice_pct: slicePctBps,
      },
    };
  }
  // Non-ladder full-collateral arm against an already-armed slot also
  // rejected by the real arm:
  if (slicePctBps === 10000 && existing.length > 0) {
    return {
      status: 409,
      body: {
        ok: false,
        error: isSl ? "stop_loss_already_armed" : "take_profit_already_armed",
        detail: "A non-ladder arm already exists on this direction. Cancel it first or use a ladder slice.",
      },
    };
  }

  // ── Success: this arm WOULD land ──
  // Surface the resolved fields the dashboard can confirm with the user
  // before they sign.
  const distancePct = (currentUsdRef && targetUsdRef && currentUsdRef > 0)
    ? ((targetUsdRef - currentUsdRef) / currentUsdRef) * 100
    : null;

  return {
    status: 200,
    body: {
      ok: true,
      would_arm: {
        loan_db_id: loan.id,
        loan_id_chain: loan.loan_id,
        program_id: loan.program_id,
        is_v4_loan: !!(v4ProgramId && loan.program_id === v4ProgramId),
        collateral_mint: loan.collateral_mint,
        collateral_symbol: mintRow.symbol,
        trigger_kind: triggerKind,
        trigger_value_micro: triggerValueMicro?.toString(),
        trigger_direction: triggerDirection,
        slippage_bps: slippageBps,
        slice_pct_bps: slicePctBps,
        trailing_distance_bps: trailingDistanceBps,
        target_usd: targetUsdRef ?? (triggerKind === "price_usd" && triggerValueMicro ? Number(triggerValueMicro) / 1e6 : null),
        current_usd: currentUsdRef,
        distance_pct: distancePct,
      },
    },
  };
}
