/**
 * POST /api/v1/sync-loan
 *
 * Post-tx sync hook for site-side actions (repay, partial-repay,
 * topup, extend). The site calls this immediately after waitConfirmed
 * lands the on-chain tx so the bot's DB picks up the state change
 * instantly — without waiting for the every-5-min loan-reconciler.
 *
 * The activity feed, /stats lifetime totals, credit score, and
 * on-time streak all read from the bot's DB. Before this endpoint,
 * a site repay landed on-chain but stayed "active" in the DB for up
 * to 5 minutes, which left the user staring at a stale dashboard.
 *
 * Design:
 *   - Fully PUBLIC: no auth required. The endpoint can ONLY pull the
 *     bot's DB toward on-chain truth — it cannot move funds, sign
 *     anything, or write any state that isn't already true on-chain.
 *     Worst case is a wasted RPC fetch.
 *   - On-chain is the source of truth. We fetch the live Loan
 *     account and reconcile the DB row against it, calling the same
 *     handlers the TG bot calls (markLoanRepaid → credit event +
 *     streak + LP loyalty; recordPartialRepay; recordExtendLoan).
 *   - Idempotent. Calling N times for the same tx is safe — the DB
 *     update is conditional (WHERE status='active' / WHERE the
 *     amount differs), and credit-event recording is keyed off the
 *     transition, not the call.
 *   - Rate-limited by loan_pda to bound RPC cost from accidental
 *     hot-loops on the client.
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import {
  getReadOnlyProgram,
  chooseProgramIdForLoan,
  PROGRAM_ID,
  PROGRAM_ID_V2,
  PROGRAM_ID_V3,
  PROGRAM_ID_V4,
} from "../solana/program.js";
import {
  markLoanRepaid,
  recordPartialRepay,
  recordExtendLoan,
  recordLoan,
} from "../services/loans.js";

const PER_LOAN_MIN_INTERVAL_MS = 2_000;
const lastByLoan = new Map();

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > 4 * 1024) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// Per-IP rate limit for sync-loan. The per-loan_pda throttle below is
// not enough — an attacker who can generate arbitrary loan_pda strings
// can spray and bypass the per-loan limit entirely, burning RPC quota
// on getAccountInfo lookups. 120/min per IP covers legitimate use (one
// per tx confirm) by a wide margin.
const IP_WINDOW_MS = 60_000;
const IP_MAX = 120;
const ipBuckets = new Map();
function ipKey(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}
function checkIpRate(ip) {
  const now = Date.now();
  const bucket = ipBuckets.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < IP_WINDOW_MS);
  if (fresh.length >= IP_MAX) return false;
  fresh.push(now);
  ipBuckets.set(ip, fresh);
  if (ipBuckets.size > 1000 && Math.random() < 0.004) {
    for (const [k, v] of ipBuckets.entries()) {
      if (v.every((t) => now - t >= IP_WINDOW_MS)) ipBuckets.delete(k);
    }
  }
  return true;
}

export async function handleSyncLoan(req) {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };

  if (!checkIpRate(ipKey(req))) {
    return { status: 429, body: { error: "Rate limit exceeded" } };
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return { status: 400, body: { error: `Invalid body: ${e.message}` } }; }

  const { loan_pda, signature } = body ?? {};
  if (!loan_pda) {
    return { status: 400, body: { error: "loan_pda required" } };
  }
  let loanPk;
  try { loanPk = new PublicKey(loan_pda); }
  catch { return { status: 400, body: { error: "invalid loan_pda" } }; }

  // Per-loan light rate limit. The site never NEEDS to call this
  // more than once per tx, but if some UI bug or a refresh-while-
  // submitting hits the endpoint twice, we want the second call to
  // be a fast no-op rather than another RPC roundtrip.
  const now = Date.now();
  const last = lastByLoan.get(loan_pda) || 0;
  if (now - last < PER_LOAN_MIN_INTERVAL_MS) {
    return { status: 200, body: { ok: true, skipped: "rate_limit", action: "noop" } };
  }
  lastByLoan.set(loan_pda, now);

  // 1) Find the DB row.
  const { rows: [dbLoan] } = await query(
    `SELECT id, loan_id, loan_pda, user_id, status, program_id,
            original_loan_amount_lamports, due_timestamp, collateral_amount
       FROM loans WHERE loan_pda = $1`,
    [loan_pda],
  );

  // 1b) Loan not yet in DB — this happens for site borrows whose
  // cosign-borrow path doesn't record the row inline. Read live state
  // and insert via the canonical recordLoan() helper (which also fires
  // referral accrual + $MAGPIE holder pool + LP loyalty accrual).
  if (!dbLoan) {
    // Worker-exhaustion defense: the recovery path holds an HTTP worker
    // for up to ~10s of retry sleep. With IP_MAX=120/min an attacker
    // can keep ~21 concurrent workers pinned per IP forever by spraying
    // random loan_pda strings — enough to crowd out legitimate callers
    // on the bot's small worker pool. Two mitigations:
    //   1. Require `signature` to enter the recovery path. The site
    //      always passes signature (it's the just-confirmed tx). An
    //      attacker can mint random tx sig strings, but a legitimate
    //      sync flow always has one. No signature = no retries.
    //   2. Halve the retry budget. RPC propagation lag is normally
    //      under 2s; the previous 10.5s was over-engineered.
    if (!signature) {
      return {
        status: 404,
        body: { error: "loan_pda not found in DB; provide signature to trigger recovery path" },
      };
    }
    let onChainNew = null;
    let resolvedProgramId = null;
    const RETRY_DELAYS_MS = [0, 1000, 2500];
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length && !onChainNew; attempt++) {
      if (RETRY_DELAYS_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
      for (const candidate of [PROGRAM_ID, PROGRAM_ID_V2, PROGRAM_ID_V3, PROGRAM_ID_V4].filter(Boolean)) {
        try {
          const prog = getReadOnlyProgram(candidate);
          onChainNew = await prog.account.loan.fetch(loanPk);
          resolvedProgramId = candidate;
          break;
        } catch { /* try next program / next attempt */ }
      }
    }
    if (!onChainNew) {
      console.error(`[sync-loan] could not decode ${loan_pda.slice(0, 8)}... on any program after retries`);
      return {
        status: 404,
        body: { error: "loan_pda not found in DB and could not decode on any known program" },
      };
    }
    const borrowerStr = onChainNew.borrower.toBase58();
    // Resolve to the TG-linked user_id when available — same wallet
    // can have multiple rows in wallets (site_native + imported); we
    // want the user who'll actually run /repay etc. See
    // src/services/wallet-owner-resolver.js.
    const { resolveWalletOwner } = await import("../services/wallet-owner-resolver.js");
    const resolvedUserId = await resolveWalletOwner(borrowerStr);
    const walletRow = resolvedUserId ? { user_id: resolvedUserId } : null;
    if (!walletRow) {
      // Borrower's wallet isn't linked to a Magpie account — likely an
      // agent borrow whose synthetic user was already created by the
      // agent endpoint. Log internally with the wallet string, but
      // return a GENERIC 404 to the caller. Distinguishing "wallet
      // not linked" from "loan not found" would let anyone probe
      // arbitrary wallets to learn if they're Magpie users (since
      // the loan PDA's on-chain borrower field is publicly readable,
      // the marginal leak is the wallet↔user-id mapping). The site
      // never legitimately hits this branch — site flows always have
      // a linked wallet — so a generic 404 doesn't hurt UX.
      console.error(`[sync-loan] borrower wallet ${borrowerStr} not in wallets table — loan ${loan_pda.slice(0, 8)}... cannot be attributed`);
      return {
        status: 404,
        body: { error: "loan_pda not found" },
      };
    }
    console.error(`[sync-loan] inserting new loan ${loan_pda.slice(0, 8)}... user=${walletRow.user_id} borrower=${borrowerStr.slice(0, 8)}...`);
    try {
      await recordLoan({
        userId: walletRow.user_id,
        loanId: onChainNew.loanId.toString(),
        loanPda: loan_pda,
        collateralMint: onChainNew.collateralMint.toBase58(),
        collateralAmount: onChainNew.collateralAmount.toString(),
        loanAmountLamports: onChainNew.loanAmount.toString(),
        originalLoanAmountLamports: onChainNew.repayAmount.toString(),
        ltvPercentage: Math.round(Number(onChainNew.ltvBps) / 100),
        durationDays: Number(onChainNew.durationDays),
        txSignature: signature ?? null,
        programId: resolvedProgramId.toBase58(),
        borrowerWallet: borrowerStr,
      });
    } catch (err) {
      // Unique-constraint races (someone else recorded first) are fine.
      if (!/duplicate|unique/i.test(err.message)) {
        return {
          status: 500,
          body: { error: "record_loan_failed", detail: err.message?.slice(0, 200) },
        };
      }
    }
    return {
      status: 200,
      body: { ok: true, action: "recorded_new_loan", loan_id: onChainNew.loanId.toString() },
    };
  }

  // 2) Fetch the live on-chain state. The DB row carries program_id
  //    so we hit the right Anchor program (v1 memecoin pool, v2 RWA
  //    pool, etc.) and decode against the matching IDL.
  const programId = chooseProgramIdForLoan(dbLoan);
  const program = getReadOnlyProgram(programId);
  let onChain;
  try {
    onChain = await program.account.loan.fetch(loanPk);
  } catch (err) {
    // Account missing on-chain → likely liquidated + collateral
    // transferred (program closes the loan account in that path).
    // Mirror the reconciler's behavior.
    if (dbLoan.status === "active") {
      await query(
        `UPDATE loans SET status = 'liquidated', updated_at = NOW()
           WHERE id = $1 AND status = 'active'`,
        [dbLoan.id],
      );
      return { status: 200, body: { ok: true, action: "marked_liquidated_account_missing" } };
    }
    return {
      status: 200,
      body: { ok: true, action: "noop", reason: `on-chain fetch failed: ${err.message?.slice(0, 120)}` },
    };
  }

  const onChainStatus =
    "repaid" in onChain.status ? "repaid"
    : "liquidated" in onChain.status ? "liquidated"
    : "active";

  // 3a) Status flipped — call the canonical handler so DB row,
  //     credit event, streak, and LP loyalty all stay consistent
  //     with the TG-bot path.
  if (onChainStatus === "repaid" && dbLoan.status === "active") {
    await markLoanRepaid(dbLoan.id, signature ?? null);
    return { status: 200, body: { ok: true, action: "marked_repaid", loan_id: dbLoan.loan_id } };
  }
  if (onChainStatus === "liquidated" && dbLoan.status === "active") {
    // Liquidation comes through the keeper path which already books
    // its own credit event + streak reset. If a liquidation slipped
    // through and the DB didn't catch up, fall back to a minimal
    // update (don't record credit twice).
    await query(
      `UPDATE loans SET status = 'liquidated', updated_at = NOW()
         WHERE id = $1 AND status = 'active'`,
      [dbLoan.id],
    );
    return { status: 200, body: { ok: true, action: "marked_liquidated", loan_id: dbLoan.loan_id } };
  }

  // 3b) Status still active, but amount drifted — partial repay landed.
  const onChainRepay = BigInt(onChain.repayAmount.toString());
  const dbRepay = BigInt(dbLoan.original_loan_amount_lamports);
  if (onChainStatus === "active" && onChainRepay < dbRepay) {
    const diff = dbRepay - onChainRepay;
    await recordPartialRepay(dbLoan.id, diff, dbLoan.user_id);
    return {
      status: 200,
      body: { ok: true, action: "recorded_partial_repay", paid_sol: Number(diff) / 1e9 },
    };
  }

  // 3c) Status still active, due_timestamp advanced — extend landed.
  // The Anchor due_unix_seconds field is i64 in some IDL versions; coerce.
  const onChainDue = Number(onChain.dueUnixSeconds ?? onChain.dueTimestamp ?? 0) * 1000;
  const dbDue = new Date(dbLoan.due_timestamp).getTime();
  if (onChainStatus === "active" && onChainDue && onChainDue > dbDue + 60_000) {
    await recordExtendLoan(dbLoan.id, dbLoan.user_id);
    return { status: 200, body: { ok: true, action: "recorded_extend", loan_id: dbLoan.loan_id } };
  }

  // 3d) Status still active, collateral amount grew — topup landed.
  const onChainCollateral = BigInt(onChain.collateralAmount?.toString?.() ?? "0");
  const dbCollateral = BigInt(dbLoan.collateral_amount ?? "0");
  if (onChainStatus === "active" && onChainCollateral > dbCollateral) {
    const diff = onChainCollateral - dbCollateral;
    await query(
      `UPDATE loans
         SET collateral_amount = $2::numeric,
             last_health_alert = NULL,
             updated_at = NOW()
         WHERE id = $1`,
      [dbLoan.id, onChainCollateral.toString()],
    );
    // Best-effort credit event for the topup (matches the TG-side recordTopup).
    try {
      const { recordCreditEvent } = await import("../services/credit-score.js");
      await recordCreditEvent(dbLoan.user_id, "topup", dbLoan.id);
    } catch { /* non-critical */ }
    return {
      status: 200,
      body: { ok: true, action: "recorded_topup", added_raw: diff.toString() },
    };
  }

  // 3e) Everything already matches.
  return {
    status: 200,
    body: { ok: true, action: "noop", reason: "DB already in sync with on-chain" },
  };
}
