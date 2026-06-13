/**
 * POST /api/v1/cosign-borrow
 *
 * The site builds a borrow tx client-side (with the user signing as
 * borrower), then sends the partial-signed tx here for the lender
 * authority to add its signature. We submit the fully-signed tx and
 * return the signature.
 *
 * SECURITY — read this before changing anything in this file:
 *
 * The lender keypair is the same authority that controls admin_withdraw,
 * set_paused, set_keeper_reward, update_price, etc. Blindly signing
 * arbitrary txs sent by the site would let an attacker drain the pool.
 * This endpoint is HARD-RESTRICTED to one specific instruction:
 *
 *   request_and_fund_loan (discriminator [21,217,199,183,6,96,200,52])
 *
 * Any tx whose magpie-program instructions don't ALL match that
 * discriminator is rejected outright. Other programs (Compute Budget,
 * System, Token, ATA) are unrestricted — they have no privileged
 * relationship with the lender wallet.
 *
 * Defense in depth:
 *   - Tx must include exactly one instruction to v1 OR v2b program
 *   - That instruction's discriminator MUST match request_and_fund_loan
 *   - Borrower signature must already be on the tx (we sign last)
 *   - Lender authority must be in the tx as a signer (sanity check)
 *
 * Anyone reading this should re-verify each check before approving
 * a PR that touches it.
 */
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  Keypair,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import { connection } from "../solana/connection.js";
import { isWalletBanned } from "../services/bans.js";
import { preBorrowAntiExploitCheck } from "../services/anti-exploit.js";
import { collateralValueLamports as fetchValueLamports } from "../services/price.js";
import { query } from "../db/pool.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";
import { rejectIfLocked } from "../services/site-lock.js";
import { getTierByOption } from "../services/loan-tier-resolver.js";

// Programs the lender authority has privileges over
const V1_PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh",
);
const V2_PROGRAM_ID = process.env.PROGRAM_ID_V2
  ? new PublicKey(process.env.PROGRAM_ID_V2)
  : null;

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);

// Strict allowlist of instruction discriminators we'll co-sign for the
// magpie programs. Anything else → reject.
const ALLOWED_DISCRIMINATORS = [
  // request_and_fund_loan (verified from src/solana/idl/magpie_lending.json)
  Buffer.from([21, 217, 199, 183, 6, 96, 200, 52]),
];

// CRITICAL — drain-exploit prevention (2026-06-07):
//
// An attacker crafted a borrow tx that included a System.transfer at
// the OUTER instruction level, source = LENDER, draining 0.71 SOL per
// tx. The previous gates only validated magpie-program instructions —
// every non-magpie instruction passed through unchecked. The attacker
// abused this by including the magpie.request_and_fund_loan to pass
// gate 1, then attaching SystemProgram.transfer { source: LENDER }
// to drain SOL on the same tx the lender co-signed.
//
// Fix: program allowlist. Every outer instruction's programId must
// be in this set. SystemProgram is INTENTIONALLY excluded — borrow.ts
// never emits a System instruction at the outer level (System CPIs
// happen INSIDE the magpie program / ATA program, not outer).
//
// If you ever change borrow.ts to emit a System instruction at the
// outer level (e.g. a tip / fee transfer), add SystemProgram here AND
// add an instruction-level check that source !== LENDER_PUBKEY.
const OUTER_INSTRUCTION_PROGRAM_ALLOWLIST = new Set([
  V1_PROGRAM_ID.toBase58(),
  ...(V2_PROGRAM_ID ? [V2_PROGRAM_ID.toBase58()] : []),
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // Associated Token Account
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  // Token-2022
  // Lighthouse — Phantom's transaction-integrity assertion program.
  // Modern Phantom (Standard Wallet path) injects assertion guards
  // BEFORE signing to defend users against rugs / sandwich attacks
  // / unexpected state mutations. These instructions are read-only:
  // they only check on-chain state and abort the tx if assertions
  // fail. They CANNOT move funds, sign anything, or alter the
  // outcome — they're purely a safety wrapper.
  //
  // SAFE to allowlist:
  //   - Lighthouse never holds privileged signers
  //   - Its instructions cannot CPI into other programs
  //   - Failure mode is "tx aborts with assertion error" — never
  //     "tx succeeds with extra effect"
  //
  // Without this, every Phantom-signed borrow fails Gate 0 with
  // "instruction program not allowed in co-signed tx".
  "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95",
]);

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  // Fail closed when neither env var is set. The previous behavior fell
  // back to ./lender-keypair.json in CWD, which is a defaultable path —
  // a misconfigured deploy from a different CWD could silently load the
  // wrong keypair (or a stray file someone planted). Explicit is safer.
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) {
    throw new Error(
      "[cosign-borrow] LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set — refusing to fall back to a CWD-relative default",
    );
  }
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

function isMagpieProgram(programIdPk) {
  if (programIdPk.equals(V1_PROGRAM_ID)) return true;
  if (V2_PROGRAM_ID && programIdPk.equals(V2_PROGRAM_ID)) return true;
  return false;
}

function instructionAllowed(ixData) {
  const head = Buffer.from(ixData.slice(0, 8));
  return ALLOWED_DISCRIMINATORS.some((d) => d.equals(head));
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export async function handleCosignBorrow(req) {
  // Trace every hit so the operator can confirm in Railway logs whether
  // failed site borrows are even reaching the bot. The token after
  // COSIGN_HIT is the precise UTC timestamp — easy to grep.
  console.log(`[cosign-borrow] COSIGN_HIT ${new Date().toISOString()} method=${req.method}`);
  if (req.method !== "POST") {
    return { status: 405, body: { error: "POST only" } };
  }

  // KILL SWITCH — set COSIGN_BORROW_DISABLED=true on Railway to disable
  // all site-borrow co-signing without redeploying. Useful if we ever
  // detect another anomaly: flip the env var, the next request returns
  // 503, the drain stops in seconds.
  if (process.env.COSIGN_BORROW_DISABLED === "true") {
    console.warn("[cosign-borrow] disabled via COSIGN_BORROW_DISABLED env var");
    return {
      status: 503,
      body: {
        error: "Site-borrow co-signing is temporarily disabled",
        detail: "Use the Telegram bot for borrows while this is paused.",
      },
    };
  }

  // Protocol-wide pause check (set via /pause_site command). The borrow
  // kill switch above is borrow-specific; this is a global circuit
  // breaker that also disables withdraw/repay/etc. Defense-in-depth so
  // we don't have to remember to flip every per-endpoint switch in an
  // incident.
  const globalReject = await rejectIfSiteDisabled();
  if (globalReject) return globalReject;

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }
  const partialSignedTxBase64 = body?.partialSignedTxBase64;
  if (typeof partialSignedTxBase64 !== "string" || !partialSignedTxBase64) {
    return { status: 400, body: { error: "Missing partialSignedTxBase64" } };
  }

  // Deserialize. Try legacy Transaction first (matches what the site builds).
  let tx;
  try {
    tx = Transaction.from(Buffer.from(partialSignedTxBase64, "base64"));
  } catch {
    try {
      const v = VersionedTransaction.deserialize(Buffer.from(partialSignedTxBase64, "base64"));
      // Versioned tx support requires v0 message handling — not implemented here.
      // Reject to stay safe and force the site to use legacy txs (which the
      // existing borrow.ts builder produces anyway).
      void v;
      return { status: 400, body: { error: "Versioned txs not supported by this endpoint yet" } };
    } catch {
      return { status: 400, body: { error: "Failed to deserialize transaction" } };
    }
  }

  // ── SECURITY GATES ──────────────────────────────────────────────

  // Gate 0 (NEW, post-2026-06-07 exploit): outer-program allowlist.
  // Every outer instruction's program must be on the allowlist. This is
  // the drain-prevention gate: SystemProgram is intentionally NOT on
  // the list, so an attacker cannot attach a SystemProgram.transfer
  // { source: LENDER } to a tx the lender co-signs.
  //
  // Belt-and-suspenders: even if we add SystemProgram to the allowlist
  // in the future, the immediate-rejection check below catches any
  // System.transfer where source === LENDER, regardless of allowlist.
  for (let i = 0; i < tx.instructions.length; i++) {
    const ix = tx.instructions[i];
    const programIdStr = ix.programId.toBase58();

    if (!OUTER_INSTRUCTION_PROGRAM_ALLOWLIST.has(programIdStr)) {
      console.error(`[cosign-borrow] DRAIN-ATTEMPT BLOCKED: outer ix[${i}] program ${programIdStr} not on allowlist`);
      return {
        status: 403,
        body: {
          // Inline the rejected program ID in `error` so it surfaces in
          // the user-visible toast — otherwise debugging requires the
          // dev-tools Network tab.
          error: `instruction program not allowed in co-signed tx: outer ix[${i}] targets ${programIdStr}`,
          detail: `outer instruction ${i} targets program ${programIdStr}; allowed: ${[...OUTER_INSTRUCTION_PROGRAM_ALLOWLIST].join(", ")}`,
          rejected_program_id: programIdStr,
          rejected_index: i,
        },
      };
    }

    // Defense-in-depth — if System ever gets re-added to the allowlist,
    // still reject any System.transfer where the lender is the source.
    if (programIdStr === SYSTEM_PROGRAM_ID) {
      // System.transfer = u32 discriminator [2,0,0,0] then u64 lamports.
      // Account 0 is the source. We don't deserialize amount here — the
      // mere fact that LENDER is account 0 of a System ix on the outer
      // tx is enough to reject.
      const sourceAccountIdx = ix.keys?.[0]?.pubkey;
      if (sourceAccountIdx && sourceAccountIdx.equals(LENDER_PUBKEY)) {
        console.error(`[cosign-borrow] DRAIN-ATTEMPT BLOCKED: outer System ix[${i}] sources from LENDER`);
        return {
          status: 403,
          body: {
            error: "System instruction with LENDER as source is not allowed",
            detail: `outer instruction ${i} is a System call where account[0] = lender authority — would drain SOL`,
          },
        };
      }
    }
  }

  // Gate 1: at least one magpie-program instruction must be present,
  //          and ALL magpie-program instructions must be allowed.
  //          Additionally: if the program is v2 (RWA pool), the
  //          collateral mint's category must be RWA. The borrow ix
  //          encodes the collateral mint in its accounts; we sniff
  //          out the program version + cross-check against DB.
  let magpieIxCount = 0;
  let chosenProgramId = null;
  let collateralMintInTx = null;
  for (const ix of tx.instructions) {
    if (!isMagpieProgram(ix.programId)) continue;
    magpieIxCount++;
    chosenProgramId = ix.programId;
    // request_and_fund_loan accounts layout: see IDL — collateral mint
    // is one of the accounts. We find it by intersecting tx accounts
    // with supported_mints. Anchor's account ordering is stable but
    // version-dependent; the DB lookup is the authoritative bind.
    // Batch the lookup: gather all tx account pubkeys, query
    // supported_mints once. The mint among them tells us category.
    const txKeys = ix.keys.map((m) => m.pubkey.toBase58());
    try {
      const { rows } = await query(
        `SELECT mint, category FROM supported_mints WHERE mint = ANY($1::text[]) LIMIT 1`,
        [txKeys],
      );
      if (rows.length) {
        collateralMintInTx = { mint: rows[0].mint, category: rows[0].category };
      }
    } catch {
      // DB lookup failure → fail-open here (other gates still apply)
    }
    if (!instructionAllowed(ix.data)) {
      return {
        status: 403,
        body: {
          error: "instruction not allowed",
          detail: `instruction discriminator ${[...ix.data.slice(0, 8)].join(",")} is not on the co-sign allowlist (request_and_fund_loan only)`,
        },
      };
    }
  }

  // POST-$FATHER GATE: hard-stop on v2 (RWA pool) borrows of memecoins.
  // The v2 pool is RWA-only by policy. If the tx's program is v2 BUT the
  // collateral mint's category is not in {stock, etf, metal}, refuse to
  // co-sign — even if every other gate passes.
  if (chosenProgramId && V2_PROGRAM_ID && chosenProgramId.equals(V2_PROGRAM_ID)) {
    const cat = collateralMintInTx?.category;
    const RWA_OK = cat === "stock" || cat === "etf" || cat === "metal";
    if (!RWA_OK) {
      console.error(
        `[cosign-borrow] V2-MEMECOIN BLOCK: v2 pool requested with collateral ` +
          `${collateralMintInTx?.mint ?? "<unknown>"} category=${cat ?? "<null>"}`,
      );
      return {
        status: 403,
        body: {
          error: "v2 pool is RWA-only",
          detail: `collateral category "${cat ?? "<null>"}" is not in {stock,etf,metal}; memecoins must use v1`,
        },
      };
    }
  }
  if (magpieIxCount === 0) {
    return { status: 400, body: { error: "No magpie-program instruction found in transaction" } };
  }
  if (magpieIxCount > 1) {
    // Defense in depth: even if all instructions match the allowlist, more
    // than one borrow per tx is suspicious. Reject.
    return { status: 400, body: { error: "Multiple magpie instructions in one tx — refusing to co-sign" } };
  }

  // Gate 2: lender authority must be a required signer in the tx.
  //          (If they're not, signing does nothing — but we also want to
  //          fail loudly rather than waste compute.)
  const lenderIsSigner = tx.signatures.some(
    (s) => s.publicKey.equals(LENDER_PUBKEY),
  );
  if (!lenderIsSigner) {
    return { status: 400, body: { error: "Lender authority is not a signer in this transaction" } };
  }

  // Gate 3: borrower (the user) must have already signed. If we sign first
  //          and return, an attacker could submit the bot's signature
  //          without ever paying for the rent/setup ixs. Requiring the
  //          borrower sig means the tx is already authorized end-to-end
  //          when we add ours.
  const borrowerAlreadySigned = tx.signatures.some(
    (s) => !s.publicKey.equals(LENDER_PUBKEY) && s.signature !== null,
  );
  if (!borrowerAlreadySigned) {
    return { status: 400, body: { error: "Borrower has not signed yet — co-sign endpoint signs last" } };
  }

  // Gate 4 (NEW, 2026-06-07): borrower wallet must not be on the ban list.
  // Catches the case where a banned wallet attempts to open a loan via
  // the web path. Wallet-level ban applies regardless of which TG account
  // (if any) owns it.
  const borrowerSig = tx.signatures.find(
    (s) => !s.publicKey.equals(LENDER_PUBKEY) && s.signature !== null,
  );
  if (borrowerSig) {
    const borrowerPubkey = borrowerSig.publicKey.toBase58();
    try {
      if (await isWalletBanned(borrowerPubkey)) {
        console.warn(`[cosign-borrow] refused — banned wallet ${borrowerPubkey}`);
        return {
          status: 403,
          body: {
            error: "This wallet is restricted from opening new loans.",
            detail: "Contact support if you believe this is in error.",
          },
        };
      }
    } catch (banErr) {
      // Fail open — don't break legit borrows on transient DB issues.
      console.warn("[cosign-borrow] ban check failed (fail-open):", banErr.message);
    }
  }

  // Gate 5 (2026-06-08): full anti-exploit gauntlet — per-token cap,
  // imported-wallet cooldown, rapid-fire cap, new-account cap, pool-pct
  // cap, $50k live-liquidity floor, off-chain TWAP, cross-source price
  // agreement. Same gates the TG bot and agent x402 paths run; without
  // this, the site was a soft underbelly that could re-open the
  // $FATHER-style attack surface.
  //
  // We decode the request_and_fund_loan args to compute the proposed
  // loan size in lamports, then re-derive collateral value via the
  // cross-sourced oracle (don't trust the client's claimed value).
  try {
    const magpieIx = tx.instructions.find(
      (ix) => ix.programId.equals(V1_PROGRAM_ID) || (V2_PROGRAM_ID && ix.programId.equals(V2_PROGRAM_ID)),
    );
    if (magpieIx && borrowerSig) {
      const data = magpieIx.data; // Buffer
      // Layout: 8-byte discriminator | amount u64 LE | option u8 | value_lamports u64 LE | loan_id u64 LE
      if (data.length >= 8 + 8 + 1 + 8 + 8) {
        const collateralAmountRaw = data.readBigUInt64LE(8);
        const tierOption = data.readUInt8(8 + 8);
        const collateralMintKey = magpieIx.keys[4]?.pubkey;
        const borrowerPubkeyStr = borrowerSig.publicKey.toBase58();
        if (collateralMintKey) {
          const collateralMintStr = collateralMintKey.toBase58();
          // Look up mint metadata: decimals (for valuation) AND category
          // (for LTV ladder selection — see below). Single SELECT so we
          // can resolve both without a second round-trip.
          const { rows: [mintRow] } = await query(
            `SELECT decimals, category, symbol FROM supported_mints WHERE mint = $1`,
            [collateralMintStr],
          );
          if (!mintRow) {
            return {
              status: 400,
              body: { error: "Unsupported collateral mint", detail: `mint ${collateralMintStr} not in supported_mints` },
            };
          }
          // ── LTV ladder resolution (category-aware) ─────────────────
          // 2026-06-13 root cause: this endpoint previously hardcoded the
          // memecoin ladder `{0:30, 1:25, 2:20}` for every borrow, regardless
          // of collateral category. RWA users picking "RWA Standard" (option
          // 2 = 70% LTV per rwa_loan_tiers) were silently downgraded to
          // memecoin Standard (20%) — they got ~29% of the advertised loan
          // amount. Affected SPCX loans #680, #687, #668, #655.
          //
          // The fix routes through loan-tier-resolver.getTierByOption, which
          // is the same path the TG bot, x402 agent, and dashboard quote use.
          // RWA categories (stock/etf/metal) get rwa_loan_tiers ladder
          // (50%/60%/70% LTV); memecoin (and default) get MEMECOIN_TIERS
          // (30%/25%/20%). When the operator tunes either ladder in the DB,
          // all four surfaces stay in sync.
          const tier = await getTierByOption({
            category: mintRow.category,
            option: tierOption,
          });
          if (!tier) {
            return {
              status: 400,
              body: {
                error: "Invalid tier option",
                detail: `tier option ${tierOption} not in the ${mintRow.category || "memecoin"} ladder`,
              },
            };
          }
          const ltv = tier.ltv;
          // Re-value collateral with our own cross-sourced oracle.
          // Three-layer fallback so a momentary rate-limit blip doesn't
          // block a legit borrow:
          //   1. Try fresh quote — up to 3 attempts with exponential backoff.
          //   2. On total failure, fall back to a recent trailing snapshot
          //      (within STALE_SNAPSHOT_MAX_AGE_MS) — the snapshotter
          //      stores every supported mint's price every ~2 min, so
          //      this is a sub-2-minute-stale read. Conservative pricing
          //      because the gate against fresh-pump exploits remains
          //      enforced elsewhere.
          //   3. Only on no-snapshot-and-no-fresh — return the 502.
          //
          // This closes the "Price oracle unavailable" UX failure where
          // both Jupiter + DexScreener happen to rate-limit at the same
          // moment. Operator-stated mandate 2026-06-13: protocol must
          // operate at the highest level; momentary oracle blips can't
          // block borrows.
          const PRICE_RETRY_DELAYS_MS = [0, 800, 2200];
          const STALE_SNAPSHOT_MAX_AGE_MS = 3 * 60_000; // 3 min — snapshotter runs every ~2 min
          let valueLamports;
          let lastErr;
          for (const delayMs of PRICE_RETRY_DELAYS_MS) {
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            try {
              valueLamports = await fetchValueLamports(
                collateralMintStr,
                collateralAmountRaw,
                Number(mintRow.decimals),
              );
              if (valueLamports && valueLamports > 0) break;
            } catch (err) {
              lastErr = err;
            }
          }
          // Snapshot fallback when all three live attempts failed.
          // mint_price_snapshots has (mint, snapshot_at, price_usd,
          // liquidity_usd) — we convert price_usd → lamports value
          // by dividing by a fresh SOL/USD quote. If THAT also fails
          // we surrender. This is the same "we know the recent price"
          // posture the limit-close engine takes per [[feedback_exploit_prevention_load_bearing]]
          // — a 2-min-stale snapshot is safer than blocking a legit
          // borrow on a transient oracle blip.
          if (!valueLamports || valueLamports <= 0) {
            try {
              const { rows: [snap] } = await query(
                `SELECT price_usd, snapshot_at
                   FROM mint_price_snapshots
                  WHERE mint = $1
                    AND snapshot_at > NOW() - ($2 || ' milliseconds')::INTERVAL
                  ORDER BY snapshot_at DESC LIMIT 1`,
                [collateralMintStr, String(STALE_SNAPSHOT_MAX_AGE_MS)],
              );
              if (snap?.price_usd) {
                // SOL/USD also from snapshotter — snapshotter records SOL
                // every cycle, so a recent snapshot is the source of
                // truth during oracle blip.
                let solUsd = null;
                const { rows: [solSnap] } = await query(
                  `SELECT price_usd FROM mint_price_snapshots
                    WHERE mint = 'So11111111111111111111111111111111111111112'
                      AND snapshot_at > NOW() - INTERVAL '10 minutes'
                    ORDER BY snapshot_at DESC LIMIT 1`,
                );
                if (solSnap?.price_usd) solUsd = Number(solSnap.price_usd);
                if (solUsd && solUsd > 0) {
                  // value_in_sol = (collateral_units * price_usd) / sol_usd
                  // collateral_units = collateralAmountRaw / 10^decimals
                  const decimals = Number(mintRow.decimals);
                  const units = Number(collateralAmountRaw) / Math.pow(10, decimals);
                  const valueSol = (units * Number(snap.price_usd)) / solUsd;
                  valueLamports = Math.floor(valueSol * 1e9);
                  const ageSec = Math.round((Date.now() - new Date(snap.snapshot_at).getTime()) / 1000);
                  console.warn(`[cosign-borrow] live oracle failed for ${collateralMintStr.slice(0, 8)}…, fell back to ${ageSec}s-old snapshot (price_usd=${snap.price_usd}, sol_usd=${solUsd.toFixed(2)}). valueLamports=${valueLamports}`);
                }
              }
            } catch (snapErr) {
              console.warn(`[cosign-borrow] snapshot fallback failed: ${snapErr.message?.slice(0, 80)}`);
            }
          }
          if (!valueLamports || valueLamports <= 0) {
            return {
              status: 502,
              body: {
                error: "Price oracle briefly unavailable — please retry in a moment",
                detail: lastErr?.message?.slice(0, 200) || "no fresh quote AND no recent snapshot",
              },
            };
          }
          if (!valueLamports || valueLamports <= 0) {
            return { status: 400, body: { error: "Collateral value computed to zero" } };
          }
          const proposedLoanLamports = Math.floor((Number(valueLamports) * ltv) / 100);
          // Resolve user_id (linked wallet → user; or null if standalone)
          const { rows: [walletRow] } = await query(
            `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
            [borrowerPubkeyStr],
          );
          // Per-user soft-lock check (operator can lock individual
          // users via /lock_user during investigations). Fires only if
          // we resolved a user_id — unlinked wallets can't be locked
          // by definition. Defense-in-depth around the existing
          // ban-registry check at gate 4.
          if (walletRow?.user_id) {
            const lockReject = await rejectIfLocked(walletRow.user_id);
            if (lockReject) {
              console.warn(`[cosign-borrow] refused — user ${walletRow.user_id} is locked`);
              return lockReject;
            }
          }
          const exploitCheck = await preBorrowAntiExploitCheck({
            userId: walletRow?.user_id ?? null,
            collateralMint: collateralMintStr,
            proposedLoanLamports,
            walletPubkey: borrowerPubkeyStr,
          });
          if (exploitCheck?.blocked) {
            console.warn(
              `[cosign-borrow] anti-exploit refused — ${exploitCheck.reason} (wallet ${borrowerPubkeyStr.slice(0, 8)}…, mint ${collateralMintStr.slice(0, 8)}…)`,
            );
            return {
              status: 403,
              body: {
                error: exploitCheck.message || "Borrow refused by anti-exploit policy",
                reason: exploitCheck.reason,
              },
            };
          }
        }
      }
    }
  } catch (err) {
    // Fail CLOSED on unexpected anti-exploit infrastructure errors —
    // unlike the ban check which fails open. The whole point of these
    // gates is to refuse borrows we can't safely verify.
    console.error("[cosign-borrow] anti-exploit gate threw:", err.message);
    return {
      status: 503,
      body: { error: "Borrow safety checks temporarily unavailable — please retry shortly" },
    };
  }

  // Just-in-time on-chain price refresh. The Anchor program rejects
  // request_and_fund_loan with StalePriceAttestation (0x177d / 6013)
  // if the on-chain price-feed timestamp is > 120s old. Background
  // attestor only keeps feeds fresh for mints backing active loans or
  // marked protected — every other mint relies on this JIT refresh.
  //
  // Mirrors TG's commands/borrow.js — 60s threshold leaves headroom
  // before the contract's 120s wall. If the price feed PDA hasn't
  // been initialized yet, init + attest in one shot.
  try {
    const magpieIxForAttest = tx.instructions.find(
      (ix) => ix.programId.equals(V1_PROGRAM_ID) || (V2_PROGRAM_ID && ix.programId.equals(V2_PROGRAM_ID)),
    );
    const mintKey = magpieIxForAttest?.keys?.[4]?.pubkey;
    if (mintKey) {
      const mintStr = mintKey.toBase58();
      const { rows: [mintRow] } = await query(
        `SELECT decimals FROM supported_mints WHERE mint = $1`,
        [mintStr],
      );
      if (mintRow) {
        const { attestPrice, initializePriceFeed, getPriceFeedAgeSeconds } =
          await import("../services/price-attestor.js");
        const FRESH_THRESHOLD_SEC = 60;
        const age = await getPriceFeedAgeSeconds(mintStr);
        if (age === null || age > FRESH_THRESHOLD_SEC) {
          try {
            await attestPrice(mintStr, Number(mintRow.decimals));
          } catch (attestErr) {
            if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(attestErr.message)) {
              await initializePriceFeed(mintStr);
              await attestPrice(mintStr, Number(mintRow.decimals));
            } else {
              throw attestErr;
            }
          }
        }
      }
    }
  } catch (attestErr) {
    console.error("[cosign-borrow] JIT price attestation failed:", attestErr.message);
    return {
      status: 502,
      body: {
        error: `Couldn't refresh on-chain price (try again in a moment): ${attestErr.message?.slice(0, 200)}`,
      },
    };
  }

  // All gates passed. Add the lender signature.
  let lender;
  try {
    lender = loadLenderKeypair();
  } catch (e) {
    console.error("[cosign-borrow] keypair load failed:", e.message);
    return { status: 500, body: { error: "Lender keypair unavailable" } };
  }

  tx.partialSign(lender);

  // Submit the fully-signed tx ourselves so the site doesn't need
  // submit/confirm logic for what's now a fully-signed payload.
  let signature;
  try {
    const raw = tx.serialize();
    signature = await sendAndConfirmRawTransaction(connection, raw, {
      commitment: "confirmed",
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (e) {
    // Surface every possible field on the error object — message can be
    // empty when the cluster rejects via a non-Error throw or websocket
    // failure. Also log the full JSON server-side for debugging.
    const message = (e && e.message) || "";
    const code = (e && e.code) || "";
    const logs = (e && Array.isArray(e.logs)) ? e.logs.slice(-5).join(" | ") : "";
    const stringified = (() => {
      try { return JSON.stringify(e, Object.getOwnPropertyNames(e ?? {})).slice(0, 400); }
      catch { return String(e).slice(0, 400); }
    })();
    const detail = [message, code, logs, stringified].filter(Boolean).join(" :: ").slice(0, 600) || "unknown_submission_error";
    console.error("[cosign-borrow] SUBMISSION_FAILED:", stringified, "logs:", logs);
    return {
      status: 500,
      body: { error: `Submission failed: ${detail}`, detail, message, code, logs },
    };
  }

  // Persist the loan to the DB inline. Without this, site borrows
  // land on-chain but never surface in the activity feed, /stats
  // lifetime totals, leaderboards, or referral / $MAGPIE-holder /
  // LP-loyalty fee accrual. Fail-soft — if any step here fails, the
  // /api/v1/sync-loan endpoint (called by the site post-submit) will
  // catch the row up. Also returns loan_pda in the response so the
  // site can call sync-loan as a safety net.
  let recordedLoanPda = null;
  try {
    const { getReadOnlyProgram } = await import("../solana/program.js");
    const { recordLoan } = await import("../services/loans.js");
    const program = getReadOnlyProgram(chosenProgramId);
    const magpieIx = tx.instructions.find((ix) =>
      ix.programId.equals(V1_PROGRAM_ID) || (V2_PROGRAM_ID && ix.programId.equals(V2_PROGRAM_ID)),
    );
    if (magpieIx) {
      // Loan PDA is at index 2 in the request_and_fund_loan accounts
      // (pool, loan_token_vault, loan, ...). We've already validated
      // there's exactly one magpie ix above, so grab it directly.
      const loanAccountKey = magpieIx.keys[2]?.pubkey;
      const borrowerAccountKey = magpieIx.keys[8]?.pubkey;
      if (loanAccountKey && borrowerAccountKey) {
        recordedLoanPda = loanAccountKey.toBase58();
        const onChainLoan = await program.account.loan.fetch(loanAccountKey);
        const borrowerStr = borrowerAccountKey.toBase58();
        const { rows: [walletRow] } = await query(
          `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
          [borrowerStr],
        );
        if (walletRow) {
          await recordLoan({
            userId: walletRow.user_id,
            loanId: onChainLoan.loanId.toString(),
            loanPda: recordedLoanPda,
            collateralMint: onChainLoan.collateralMint.toBase58(),
            collateralAmount: onChainLoan.collateralAmount.toString(),
            loanAmountLamports: onChainLoan.loanAmount.toString(),
            originalLoanAmountLamports: onChainLoan.repayAmount.toString(),
            ltvPercentage: Math.round(Number(onChainLoan.ltvBps) / 100),
            durationDays: Number(onChainLoan.durationDays),
            txSignature: signature,
            programId: chosenProgramId.toBase58(),
            borrowerWallet: borrowerStr,
          });
        } else {
          console.warn(
            `[cosign-borrow] no wallet row for borrower ${borrowerStr} — site sync-loan will catch up`,
          );
        }
      }
    }
  } catch (err) {
    // Don't fail the request — the on-chain tx already succeeded.
    // sync-loan from the site (or the every-5-min reconciler) will
    // fold this into DB shortly.
    console.warn("[cosign-borrow] post-submit recordLoan failed (sync-loan will catch up):", err.message);
  }

  return {
    status: 200,
    body: { ok: true, signature, loan_pda: recordedLoanPda },
  };
}
