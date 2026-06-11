/**
 * POST /api/v1/wallet/backfill-loans
 *
 * Scan the on-chain program for every loan owned by a wallet, and
 * insert any that aren't yet in the bot's DB. Drift-recovery for
 * site borrows that landed on-chain but never made it into the
 * loans table (e.g. RPC propagation race that even sync-loan's
 * retries couldn't catch).
 *
 * Body: { wallet: <pubkey> }
 *
 * Public on purpose: the endpoint can ONLY pull DB toward on-chain
 * truth (never writes anything that isn't already on-chain), and
 * only operates on the wallet's own loans. Rate-limited per wallet
 * to bound RPC cost.
 *
 * Idempotent: re-running it for the same wallet is a no-op once
 * every on-chain loan is already in DB.
 */
import { PublicKey } from "@solana/web3.js";
import {
  getReadOnlyProgram,
  PROGRAM_ID,
  PROGRAM_ID_V2,
  PROGRAM_ID_V3,
} from "../solana/program.js";
import { query } from "../db/pool.js";
import { recordLoan } from "../services/loans.js";

const PER_WALLET_MIN_INTERVAL_MS = 15_000;
const lastByWallet = new Map();

// Per-IP global throttle — prevents an attacker from spraying
// different wallets to burn through our RPC quota / DB capacity.
// 20 calls per 60s per IP is plenty for normal users (one dashboard
// load triggers exactly one call) but kills aggressive spray.
const PER_IP_WINDOW_MS = 60_000;
const PER_IP_MAX = 20;
const ipBuckets = new Map();
function ipKey(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}
function checkIpRate(ip) {
  const now = Date.now();
  const bucket = ipBuckets.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < PER_IP_WINDOW_MS);
  if (fresh.length >= PER_IP_MAX) {
    return { ok: false };
  }
  fresh.push(now);
  ipBuckets.set(ip, fresh);
  // Light cleanup — every ~256 calls, evict stale buckets.
  if (ipBuckets.size > 1000 && Math.random() < 0.004) {
    for (const [k, v] of ipBuckets.entries()) {
      if (v.length === 0 || now - v[v.length - 1] > PER_IP_WINDOW_MS) ipBuckets.delete(k);
    }
  }
  return { ok: true };
}

// Loan account layout: 8-byte Anchor discriminator + loan_id (u64,
// 8 bytes) + borrower (pubkey, 32 bytes). memcmp at offset 16 filters
// by borrower without pulling every loan account.
const BORROWER_OFFSET = 8 + 8;

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > 4 * 1024) { req.destroy(); reject(new Error("body too large")); return; }
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

async function fetchLoansForBorrowerOnProgram(program, walletPk) {
  try {
    return await program.account.loan.all([
      { memcmp: { offset: BORROWER_OFFSET, bytes: walletPk.toBase58() } },
    ]);
  } catch (err) {
    console.warn(
      `[backfill-loans] getProgramAccounts failed on ${program.programId.toBase58().slice(0, 8)}…: ${err.message}`,
    );
    return [];
  }
}

export async function handleBackfillWalletLoans(req) {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };

  // Per-IP rate limit gates the expensive RPC scan before parsing
  // the body — cheap reject for floods.
  const ipCheck = checkIpRate(ipKey(req));
  if (!ipCheck.ok) {
    return { status: 429, body: { error: "Too many requests from this IP — slow down" } };
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return { status: 400, body: { error: `Invalid body: ${e.message}` } }; }

  const walletStr = body?.wallet;
  if (!walletStr) return { status: 400, body: { error: "wallet required" } };
  let walletPk;
  try { walletPk = new PublicKey(walletStr); }
  catch { return { status: 400, body: { error: "invalid wallet pubkey" } }; }

  // Light per-wallet rate limit. Prevents accidental hot-loops on the
  // dashboard from scanning getProgramAccounts repeatedly.
  const now = Date.now();
  const last = lastByWallet.get(walletStr) || 0;
  if (now - last < PER_WALLET_MIN_INTERVAL_MS) {
    return {
      status: 200,
      body: { ok: true, action: "rate_limited", retry_in_ms: PER_WALLET_MIN_INTERVAL_MS - (now - last) },
    };
  }
  lastByWallet.set(walletStr, now);

  // Resolve user_id (required for recordLoan). Return a UNIFORM
  // "nothing-to-do" response when the wallet isn't linked — never
  // differentiate that case in the public response or an attacker
  // can spray random pubkeys to learn the wallet↔Magpie-account
  // mapping (same fix pattern as sync-loan PR #52). Log internally
  // for ops visibility but stay opaque to the caller.
  const { rows: [walletRow] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [walletStr],
  );
  if (!walletRow) {
    console.error(`[backfill] wallet ${walletStr.slice(0, 8)}... not linked — returning generic noop`);
    return {
      status: 200,
      body: { ok: true, action: "noop", scanned: 0, inserted: 0 },
    };
  }

  // Scan every known program for loans by this borrower.
  const programs = [PROGRAM_ID, PROGRAM_ID_V2, PROGRAM_ID_V3].filter(Boolean);
  const onChainLoans = [];
  for (const programId of programs) {
    const prog = getReadOnlyProgram(programId);
    const found = await fetchLoansForBorrowerOnProgram(prog, walletPk);
    for (const l of found) {
      onChainLoans.push({ programId, loan: l });
    }
  }

  if (onChainLoans.length === 0) {
    return {
      status: 200,
      body: { ok: true, action: "noop", scanned: 0, inserted: 0, reason: "no on-chain loans for wallet" },
    };
  }

  // Bulk-check which loan_pdas are already in DB.
  const pdaStrings = onChainLoans.map(({ loan }) => loan.publicKey.toBase58());
  const { rows: existing } = await query(
    `SELECT loan_pda FROM loans WHERE loan_pda = ANY($1::text[])`,
    [pdaStrings],
  );
  const existingSet = new Set(existing.map((r) => r.loan_pda));

  const toInsert = onChainLoans.filter(({ loan }) => !existingSet.has(loan.publicKey.toBase58()));
  if (toInsert.length === 0) {
    return {
      status: 200,
      body: { ok: true, action: "noop", scanned: onChainLoans.length, inserted: 0, reason: "all on-chain loans already in DB" },
    };
  }

  let inserted = 0;
  const errors = [];
  for (const { programId, loan } of toInsert) {
    const onChain = loan.account;
    try {
      await recordLoan({
        userId: walletRow.user_id,
        loanId: onChain.loanId.toString(),
        loanPda: loan.publicKey.toBase58(),
        collateralMint: onChain.collateralMint.toBase58(),
        collateralAmount: onChain.collateralAmount.toString(),
        loanAmountLamports: onChain.loanAmount.toString(),
        originalLoanAmountLamports: onChain.repayAmount.toString(),
        ltvPercentage: Math.round(Number(onChain.ltvBps) / 100),
        durationDays: Number(onChain.durationDays),
        txSignature: null,
        programId: programId.toBase58(),
        borrowerWallet: walletStr,
      });
      inserted++;
      console.error(`[backfill-loans] inserted loan ${loan.publicKey.toBase58().slice(0, 8)}... for ${walletStr.slice(0, 8)}...`);
    } catch (err) {
      // Unique-constraint races are expected if another path inserted in parallel.
      if (!/duplicate|unique/i.test(err.message)) {
        errors.push({ loan_pda: loan.publicKey.toBase58(), error: err.message?.slice(0, 200) });
        console.error(`[backfill-loans] insert failed for ${loan.publicKey.toBase58().slice(0, 8)}...: ${err.message}`);
      }
    }
  }

  // If the loan was inserted but its on-chain status is repaid /
  // liquidated (i.e. the user already closed it via TG or wallet),
  // sync the row to that status so /stats shows the right history.
  if (inserted > 0) {
    for (const { loan } of toInsert) {
      const onChain = loan.account;
      const status = "repaid" in onChain.status ? "repaid"
        : "liquidated" in onChain.status ? "liquidated"
        : "active";
      if (status !== "active") {
        await query(
          `UPDATE loans SET status = $2, updated_at = NOW() WHERE loan_pda = $1 AND status = 'active'`,
          [loan.publicKey.toBase58(), status],
        );
      }
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: inserted > 0 ? "backfilled" : "noop",
      scanned: onChainLoans.length,
      inserted,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
}
