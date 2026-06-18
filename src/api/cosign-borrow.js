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
// V2 deprecated + purged 2026-06-17 PM. Forced null so cosign-borrow's
// program allowlist never accepts V2 borrows. Existing V2 loans are
// historical-only in DB. See feedback_v2_purged_from_protocol.
const V2_PROGRAM_ID = null;
// V3 program — once routing flips for RWA (ROUTE_RWA_TO_V3=true), the site
// builds borrow txs targeting this program. Without including it in the
// allowlist + magpie-program check, every V3 borrow returns 403 with
// "instruction program not allowed in co-signed tx". Discovered 2026-06-14
// when SPCX borrows started failing immediately after V3 routing went live.
const V3_PROGRAM_ID = process.env.PROGRAM_ID_V3
  ? new PublicKey(process.env.PROGRAM_ID_V3)
  : null;
const ROUTE_RWA_TO_V3 = process.env.ROUTE_RWA_TO_V3 === "true";

// V4 program — adds in-vault auto-sell. Once routing flips, the site builds
// borrow txs targeting this program; including it here prevents the same
// 403 cosign rejection class we hit on V3 launch day.
const V4_PROGRAM_ID = process.env.PROGRAM_ID_V4
  ? new PublicKey(process.env.PROGRAM_ID_V4)
  : null;
const ROUTE_MEMECOINS_TO_V4 = process.env.ROUTE_MEMECOINS_TO_V4 === "true";
const ROUTE_RWA_TO_V4 = process.env.ROUTE_RWA_TO_V4 === "true";

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
  ...(V3_PROGRAM_ID ? [V3_PROGRAM_ID.toBase58()] : []),
  ...(V4_PROGRAM_ID ? [V4_PROGRAM_ID.toBase58()] : []),
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

/**
 * Pre-flight balance-delta simulation (Layer 2 of the 2026-06-18 drain
 * defense). Returns `{ ok: true }` if no lender-owned balance would
 * decrease, or `{ ok: false, error, detail }` if a drain is detected.
 *
 * The tx must ALREADY be lender-signed before calling this — we use
 * `simulateTransaction` with `sigVerify: false` so the simulation reads
 * the post-state as if the tx had run.
 *
 * Algorithm:
 *   1. Read pre-state of every account referenced in the tx.
 *   2. Identify which referenced accounts are owned by LENDER_PUBKEY
 *      (the SOL wallet itself + any SPL/Token-2022 ATA whose `owner`
 *      field is LENDER_PUBKEY).
 *   3. If zero such accounts → no drain surface, return ok.
 *   4. Simulate the tx, requesting post-state for those accounts.
 *   5. Compare pre vs post. ANY decrease → drain detected.
 *
 * SAFETY: legit borrows NEVER decrease lender balances. Lender SOL is
 * the pool PDA's source, not the wallet. Borrower pays all fees.
 * Lender ATAs only receive tokens via liquidation (admin path) and
 * lose them only via authorized sale (which doesn't go through
 * cosign-borrow).
 */
async function detectLenderBalanceDrain(connection, tx, LENDER_PUBKEY) {
  const TOKEN_PROGRAM_KEG = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const TOKEN_PROGRAM_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

  // Step 1+2: enumerate accounts in tx + identify lender-owned ones.
  const msg = tx.compileMessage();
  const accountKeys = msg.accountKeys; // PublicKey[]
  if (accountKeys.length === 0) return { ok: true }; // empty tx

  let preInfos;
  try {
    preInfos = await connection.getMultipleAccountsInfo(accountKeys, "confirmed");
  } catch (err) {
    throw new Error(`pre-state read failed: ${err.message?.slice(0, 100)}`);
  }

  const lenderTouched = [];
  for (let i = 0; i < accountKeys.length; i++) {
    const info = preInfos[i];
    if (!info) continue;
    // (a) the lender wallet itself (SOL balance)
    if (accountKeys[i].equals(LENDER_PUBKEY)) {
      lenderTouched.push({ idx: i, type: "sol", preLamports: info.lamports });
      continue;
    }
    // (b) token account whose `owner` field is LENDER. SPL Token + T22
    // share the same offset layout: mint(32) + owner(32) + amount(8) + ...
    const ownerProg = info.owner;
    if (!ownerProg.equals(TOKEN_PROGRAM_KEG) && !ownerProg.equals(TOKEN_PROGRAM_2022)) continue;
    if (info.data.length < 72) continue; // not a parseable token account
    const tokenOwner = new PublicKey(info.data.subarray(32, 64));
    if (!tokenOwner.equals(LENDER_PUBKEY)) continue;
    const mint = new PublicKey(info.data.subarray(0, 32)).toBase58();
    const preAmount = info.data.readBigUInt64LE(64);
    lenderTouched.push({ idx: i, type: "token", mint, preAmount });
  }

  if (lenderTouched.length === 0) {
    // No lender-owned account in this tx — nothing can drain from us.
    return { ok: true, skipped: "no_lender_accounts_in_tx" };
  }

  // Step 4: simulate, requesting post-state for the touched lender accounts.
  let sim;
  try {
    sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      commitment: "confirmed",
      accounts: {
        encoding: "base64",
        addresses: lenderTouched.map((t) => accountKeys[t.idx].toBase58()),
      },
    });
  } catch (err) {
    throw new Error(`simulateTransaction failed: ${err.message?.slice(0, 100)}`);
  }

  if (sim.value.err) {
    // Simulation says the tx would fail on-chain. Don't broadcast a tx
    // that's going to fail anyway, but don't flag this as a drain — let
    // the caller see the underlying error so they can fix their tx.
    return {
      ok: false,
      error: "Tx would fail on-chain (pre-flight simulation rejected)",
      detail: `simulated err=${JSON.stringify(sim.value.err).slice(0, 160)} logs=${(sim.value.logs || []).slice(-4).join(" | ").slice(0, 200)}`,
    };
  }

  // Step 5: compare pre/post for each tracked lender account.
  const postAccounts = sim.value.accounts || [];
  for (let i = 0; i < lenderTouched.length; i++) {
    const meta = lenderTouched[i];
    const post = postAccounts[i];
    if (!post) continue; // RPC didn't return — treat as no change

    if (meta.type === "sol") {
      if (post.lamports < meta.preLamports) {
        const delta = meta.preLamports - post.lamports;
        return {
          ok: false,
          error: "Lender wallet SOL would decrease",
          detail: `pre=${meta.preLamports} post=${post.lamports} delta=-${delta} lamports`,
        };
      }
    } else if (meta.type === "token") {
      // post.data is [string, encoding] — decode base64
      const postBytes = Buffer.from(post.data[0], "base64");
      if (postBytes.length < 72) {
        // ATA was closed or post-state is malformed — treat as drain
        return {
          ok: false,
          error: "Lender token ATA post-state malformed or closed",
          detail: `mint=${meta.mint.slice(0, 8)}… preAmount=${meta.preAmount} postDataLen=${postBytes.length}`,
        };
      }
      const postAmount = postBytes.readBigUInt64LE(64);
      if (postAmount < meta.preAmount) {
        const delta = meta.preAmount - postAmount;
        return {
          ok: false,
          error: "Lender token balance would decrease",
          detail: `mint=${meta.mint.slice(0, 8)}… pre=${meta.preAmount} post=${postAmount} delta=-${delta}`,
        };
      }
    }
  }

  return { ok: true, checked: lenderTouched.length };
}

function isMagpieProgram(programIdPk) {
  if (programIdPk.equals(V1_PROGRAM_ID)) return true;
  if (V2_PROGRAM_ID && programIdPk.equals(V2_PROGRAM_ID)) return true;
  if (V3_PROGRAM_ID && programIdPk.equals(V3_PROGRAM_ID)) return true;
  if (V4_PROGRAM_ID && programIdPk.equals(V4_PROGRAM_ID)) return true;
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

  // Gate 0b (NEW, post-2026-06-18 exploit): generalized token-drain check.
  //
  // The 2026-06-18 PUMP-drain exploit bundled a `Token-2022 TransferChecked`
  // with a legit-looking V1 RequestAndFundLoan in the same tx. Token
  // programs were on the allowlist for legitimate collateral movement,
  // but no check ensured the SOURCE wasn't a lender-owned ATA. The lender
  // signature added by tx.partialSign(lender) below would have authorized
  // both the borrow AND the drain in the same atomic op.
  //
  // Fix: for every outer Tokenkeg or Token-2022 transfer/transferChecked,
  // resolve the source account on-chain and reject if it's owned by
  // LENDER_PUBKEY. Burn / Approve / SetAuthority / CloseAccount also count
  // because they all let the authority drain or relinquish control. We
  // reject them by instruction discriminator too.
  //
  // See feedback_cosign_borrow_token_drain_exploit_2026_06_18.md
  // (also Layer 2 below: pre-flight balance-delta simulation).
  const TOKEN_PROGRAM_STRS = new Set([
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ]);
  // Instruction discriminators (first byte of data) that touch the source
  // account's balance/authority. SPL Token + Token-2022 share these codes.
  //   3  Transfer            (legacy — deprecated but still works)
  //   4  Approve             (delegates authority)
  //   5  Revoke
  //   6  SetAuthority
  //   7  MintTo              (skipping — source is mint, not an ATA)
  //   8  Burn
  //   9  CloseAccount
  //  12  TransferChecked
  //  13  ApproveChecked
  //  14  MintToChecked       (skipping for same reason)
  //  15  BurnChecked
  // Token-2022 adds:
  //  27  TransferCheckedWithFee
  // Approve / Revoke / SetAuthority give a future drain capability even
  // if no immediate balance change — we treat them as if they drained.
  const DRAIN_CAPABLE_OPS = new Set([3, 4, 5, 6, 8, 9, 12, 13, 15, 27]);
  const lenderSourceIxs = [];
  for (let i = 0; i < tx.instructions.length; i++) {
    const ix = tx.instructions[i];
    const programIdStr = ix.programId.toBase58();
    if (!TOKEN_PROGRAM_STRS.has(programIdStr)) continue;
    if (!ix.data || ix.data.length < 1) continue;
    const code = ix.data[0];
    if (!DRAIN_CAPABLE_OPS.has(code)) continue;
    const sourceAccount = ix.keys?.[0]?.pubkey;
    if (!sourceAccount) continue;
    lenderSourceIxs.push({ index: i, source: sourceAccount, code, program: programIdStr });
  }

  if (lenderSourceIxs.length > 0) {
    let infos;
    try {
      infos = await connection.getMultipleAccountsInfo(
        lenderSourceIxs.map((t) => t.source),
        "confirmed",
      );
    } catch (rpcErr) {
      // Fail CLOSED — if we can't verify the sources, refuse the cosign.
      // Operator can retry; an RPC blip is preferable to a drain.
      console.error("[cosign-borrow] DRAIN-CHECK RPC failure — failing closed:", rpcErr.message);
      return {
        status: 503,
        body: {
          error: "Couldn't verify token-source ownership (RPC blip) — please retry in a few seconds",
          detail: rpcErr.message?.slice(0, 160),
        },
      };
    }
    for (let i = 0; i < lenderSourceIxs.length; i++) {
      const t = lenderSourceIxs[i];
      const info = infos[i];
      if (!info) {
        // Source ATA doesn't exist on-chain yet. Either it's being
        // created in this same tx (CreateATA earlier in the ix list) or
        // the tx will fail when the program tries to read from a missing
        // account. Either way it can't drain anything that isn't there.
        continue;
      }
      // SPL Token and Token-2022 token-account layouts both have:
      //   mint  (32 bytes, offset 0)
      //   owner (32 bytes, offset 32)
      // The minimum token account size is 165 bytes; T22 with extensions
      // can be larger. Anything smaller isn't a token account at all.
      if (info.data.length < 165) {
        console.error(`[cosign-borrow] DRAIN-CHECK: ix[${t.index}] source ${t.source.toBase58().slice(0, 8)}… data too small (${info.data.length} bytes) — not a token account, rejecting`);
        return {
          status: 403,
          body: {
            error: "Token instruction with non-token-account source is not allowed",
            detail: `outer ix[${t.index}] source account is not a parseable token account (size ${info.data.length} < 165)`,
            rejected_index: t.index,
          },
        };
      }
      const sourceOwner = new PublicKey(info.data.subarray(32, 64));
      if (sourceOwner.equals(LENDER_PUBKEY)) {
        console.error(`[cosign-borrow] DRAIN-ATTEMPT BLOCKED: outer token ix[${t.index}] code=${t.code} sources from lender-owned ATA ${t.source.toBase58()}`);
        return {
          status: 403,
          body: {
            error: "Token instruction sourcing from lender-owned account is not allowed",
            detail: `outer instruction ${t.index} (program=${t.program.slice(0, 8)}… code=${t.code}) targets a token account owned by the lender authority — would drain tokens (same exploit class as the 2026-06-07 SystemProgram drain and the 2026-06-18 Token-2022 drain)`,
            rejected_index: t.index,
            rejected_source: t.source.toBase58(),
            rejected_op_code: t.code,
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

  // POST-$FATHER GATE: hard-stop on RWA-pool borrows of memecoins.
  // V2 and V3 are RWA-only by policy. If the tx's program is V2 or V3 BUT
  // the collateral mint's category is not in {stock, etf, metal}, refuse
  // to co-sign — even if every other gate passes.
  const v2Targeted = chosenProgramId && V2_PROGRAM_ID && chosenProgramId.equals(V2_PROGRAM_ID);
  const v3Targeted = chosenProgramId && V3_PROGRAM_ID && chosenProgramId.equals(V3_PROGRAM_ID);
  if (v2Targeted || v3Targeted) {
    const cat = collateralMintInTx?.category;
    const RWA_OK = cat === "stock" || cat === "etf" || cat === "metal";
    if (!RWA_OK) {
      const poolLabel = v3Targeted ? "V3" : "V2";
      console.error(
        `[cosign-borrow] ${poolLabel}-MEMECOIN BLOCK: ${poolLabel} pool requested with collateral ` +
          `${collateralMintInTx?.mint ?? "<unknown>"} category=${cat ?? "<null>"}`,
      );
      return {
        status: 403,
        body: {
          error: `${poolLabel} pool is RWA-only`,
          detail: `collateral category "${cat ?? "<null>"}" is not in {stock,etf,metal}; memecoins must use V1`,
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
    const magpieIx = tx.instructions.find((ix) => isMagpieProgram(ix.programId));
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
          // ── RWA/program routing enforcement (2026-06-13) ───────────
          // Defense-in-depth against stale client bundles. The site's
          // buildBorrowTransaction picks V1 or V2 based on the client-
          // side category lookup. A user with a cached old JS bundle
          // (especially in mobile webview wallets like Phantom mobile)
          // may construct a tx that targets V1 program against an RWA
          // mint — V1 then applies its memecoin 20% LTV ladder and
          // delivers ~29% of what the dashboard advertised.
          //
          // PRs #58, #61, #63 fix the client-side flow but cannot help
          // a user whose browser is serving cached JS. This server-side
          // refusal is the structural guarantee: even with stale client
          // code, a wrong-program borrow CANNOT be signed by the lender.
          // The user sees a clear error and is forced to refresh.
          const isRwaMint = ["stock", "etf", "metal"].includes(mintRow.category);
          const ixProgramId = magpieIx.programId;
          // V4-exclusive routing (2026-06-15): V4 is the only pool that
          // services exit-armed borrows, regardless of category. Routing
          // is exit-arming-driven, not category/flag-driven. So a borrow
          // tx targeting V4 is valid for ANY category (memecoin OR RWA) —
          // skip the category gate when the tx is V4. The arm-side gate
          // (limit-close-arm-core's exits_require_v4_loan refusal) is
          // what enforces "V4 loans are the only ones that can host
          // exits"; this endpoint just signs the borrow.
          const isV4Borrow = V4_PROGRAM_ID && ixProgramId.equals(V4_PROGRAM_ID);
          if (!isV4Borrow) {
            // V1/V2/V3 category gates — plain borrows still follow category routing.
            let expectedRwaProgram = V2_PROGRAM_ID;
            let expectedRwaLabel = "V2";
            if (V3_PROGRAM_ID && ROUTE_RWA_TO_V3) {
              expectedRwaProgram = V3_PROGRAM_ID;
              expectedRwaLabel = "V3";
            }
            if (isRwaMint && ixProgramId.equals(V1_PROGRAM_ID)) {
              return {
                status: 400,
                body: {
                  error: "wrong_program_for_collateral",
                  detail: `${mintRow.symbol || "Collateral"} (${mintRow.category}) must borrow against the ${expectedRwaLabel} RWA pool, but the tx targets V1. Hard-refresh your browser (Cmd+Shift+R / Ctrl+Shift+R) and try again — a stale page is constructing the wrong tx.`,
                },
              };
            }
            if (isRwaMint && expectedRwaProgram && !ixProgramId.equals(expectedRwaProgram)) {
              return {
                status: 400,
                body: {
                  error: "wrong_program_for_collateral",
                  detail: `${mintRow.symbol || "Collateral"} (${mintRow.category}) must borrow against the ${expectedRwaLabel} RWA pool. Hard-refresh your browser (Cmd+Shift+R / Ctrl+Shift+R) and try again.`,
                },
              };
            }
            // Memecoin routing mirror. V2 is RWA-only (legacy). V3 is
            // dual-tier so memecoin → V3 is FINE iff ROUTE_MEMECOINS_TO_V3
            // is on. V4 is now exit-armed-only and handled above.
            const memeOnV2 = !isRwaMint && V2_PROGRAM_ID && ixProgramId.equals(V2_PROGRAM_ID);
            const memeOnV3WhenDisabled =
              !isRwaMint &&
              V3_PROGRAM_ID && ixProgramId.equals(V3_PROGRAM_ID) &&
              process.env.ROUTE_MEMECOINS_TO_V3 !== "true";
            const memeOnRwaPool = memeOnV2 || memeOnV3WhenDisabled;
            if (memeOnRwaPool) {
              const targetedLabel = V3_PROGRAM_ID && ixProgramId.equals(V3_PROGRAM_ID) ? "V3" : "V2";
              return {
                status: 400,
                body: {
                  error: "wrong_program_for_collateral",
                  detail: `${mintRow.symbol || "Collateral"} (${mintRow.category}) must borrow against the V1 pool, but the tx targets ${targetedLabel}.`,
                },
              };
            }
          }

          // ── V4 canary borrow cap ──────────────────────────────────
          // During the V4 canary phase the operator funds the pool with
          // a small amount (e.g., 1 SOL) and sets V4_BORROW_CAP_LAMPORTS
          // as a belt-and-suspenders ceiling on top of pool liquidity.
          // Once on-chain pool.totalBorrowed reaches the cap, the bot
          // refuses to cosign additional V4 borrows. Removed (env unset)
          // after the operator promotes V4 past canary.
          if (V4_PROGRAM_ID && ixProgramId.equals(V4_PROGRAM_ID) && process.env.V4_BORROW_CAP_LAMPORTS) {
            try {
              const cap = BigInt(process.env.V4_BORROW_CAP_LAMPORTS);
              const { getReadOnlyProgram } = await import("../solana/program.js");
              const v4Program = getReadOnlyProgram(V4_PROGRAM_ID);
              const [v4PoolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("pool"), new PublicKey(process.env.LENDER_PUBKEY).toBuffer()],
                V4_PROGRAM_ID,
              );
              const v4Pool = await v4Program.account.lendingPool.fetch(v4PoolPda);
              const totalBorrowed = BigInt(v4Pool.totalBorrowed.toString());
              if (totalBorrowed >= cap) {
                console.warn(`[cosign-borrow] V4 canary cap reached: totalBorrowed=${totalBorrowed} >= cap=${cap}`);
                return {
                  status: 503,
                  body: {
                    error: "v4_canary_cap_reached",
                    detail: `V4 pool has reached the operator-set canary borrow cap. New V4 borrows are paused until the cap is raised. V1/V2/V3 are unaffected.`,
                  },
                };
              }
            } catch (capErr) {
              // Fail-open here — if we can't fetch pool state at borrow
              // time, the pool's own liquidity check is still the hard
              // backstop (you can't borrow what isn't there). Log so
              // ops can see it.
              console.warn(`[cosign-borrow] V4 cap check failed (allowing borrow): ${capErr.message}`);
            }
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
          // Operator hit "Price oracle briefly unavailable" on hard-refresh
          // V1 borrows 2026-06-15 PM despite the existing 3-retry +
          // 3-min-snapshot fallback. Widen both: 5 retries instead of 3
          // (covers longer rate-limit windows from Jupiter/DexScreener)
          // and the snapshot cap goes 3min→15min so a delayed snapshotter
          // run doesn't manifest as a borrow rejection. The cap is still
          // far below any pump-and-front-run window — the LTV math and
          // the pre-existing fresh-pump gates downstream protect against
          // adversarial mispricing even on a 15-min-old snapshot.
          // 2026-06-16 PM: widened again after operator hit the banned
          // "Price oracle briefly unavailable" copy on a V4 laddered borrow
          // despite the 5-retry + 15-min snapshot fallback. Laddered borrows
          // craft for longer than typical, so the feed has more time to go
          // stale. Bump to 7 attempts (+ longer trailing delays) AND extend
          // the snapshot ceiling to 30 min — still well below any pump-and-
          // front-run window. Per [[feedback_oracle_briefly_unavailable_banned_recurrence]].
          const PRICE_RETRY_DELAYS_MS = [0, 500, 1200, 2500, 4500, 7000, 10000];
          const STALE_SNAPSHOT_MAX_AGE_MS = 30 * 60_000; // 30 min — was 15
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
            // 2026-06-16 PM: the banned "briefly unavailable" copy was
            // surfacing on V4 laddered borrows where the user crafted
            // for longer than typical. We've already widened the retry
            // budget + snapshot window above; if we STILL land here it
            // means every layer failed in a window measured in minutes,
            // which is exceptional. Surface a soft "refreshing — re-sign"
            // tone instead of the banned copy. Per
            // [[feedback_oracle_briefly_unavailable_banned_recurrence]].
            return {
              status: 502,
              body: {
                error: "Refreshing market data — please tap Sign once more.",
                detail: lastErr?.message?.slice(0, 200) || "no fresh quote AND no recent snapshot",
                retry_after_ms: 1500,
              },
            };
          }
          if (!valueLamports || valueLamports <= 0) {
            return { status: 400, body: { error: "Collateral value computed to zero" } };
          }
          const proposedLoanLamports = Math.floor((Number(valueLamports) * ltv) / 100);
          // Resolve user_id (linked wallet → user; or null if standalone).
          // Uses the canonical resolver so we ALWAYS pick the TG-linked
          // user_id when one exists. Without this, a wallet that has
          // both a site_native row and an imported-into-TG row would
          // attribute the loan to the older site_native user — and the
          // user wouldn't see the loan in TG /repay. Caused operator
          // report on V3 SPCX loan id=720 on 2026-06-14.
          const { resolveWalletOwner } = await import("../services/wallet-owner-resolver.js");
          const resolvedUserId = await resolveWalletOwner(borrowerPubkeyStr);
          const walletRow = resolvedUserId ? { user_id: resolvedUserId } : null;
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
    const magpieIxForAttest = tx.instructions.find((ix) => isMagpieProgram(ix.programId));
    const mintKey = magpieIxForAttest?.keys?.[4]?.pubkey;
    if (mintKey) {
      const mintStr = mintKey.toBase58();
      const { rows: [mintRow] } = await query(
        `SELECT decimals FROM supported_mints WHERE mint = $1`,
        [mintStr],
      );
      if (mintRow) {
        const { attestPrice, initializePriceFeed, getPriceFeedAgeSeconds, ensureV4TwapReady } =
          await import("../services/price-attestor.js");
        const FRESH_THRESHOLD_SEC = 60;
        // V4-aware JIT attestation (2026-06-15): use the borrow tx's
        // own programId so V4 borrows attest V4's PriceHistory PDA
        // (not the category-default V1/V3). Without this, V4 borrows
        // surface as "Account state mismatch" because V4's price_feed
        // PDA was never initialized — bot's category routing never
        // reaches V4.
        const borrowProgramId = magpieIxForAttest.programId;
        // V3 AND V4 both use the price_v3 PriceHistory layout with the
        // same TWAP gate (>= 8 samples in 300s). Originally I only
        // JIT-warmed V4, which left SPCX (RWA, defaults to V3 borrow
        // routing) exposed. Operator hit TwapInsufficientHistory on an
        // SPCX V3 borrow 2026-06-18 PM — see
        // [[feedback_twap_insufficient_history_never_again]] for the
        // mandate that this MUST cover every program with TWAP.
        const usesTwapGate =
          (process.env.PROGRAM_ID_V4 &&
            borrowProgramId.toBase58() === process.env.PROGRAM_ID_V4) ||
          (process.env.PROGRAM_ID_V3 &&
            borrowProgramId.toBase58() === process.env.PROGRAM_ID_V3);

        if (usesTwapGate) {
          // Program's TWAP gate needs >= 8 samples within 300s OR
          // `TwapInsufficientHistory` (Anchor 6016 / 0x1780) rejects
          // the borrow. The single-shot freshness attest below is
          // necessary but not sufficient — we MUST loop until the
          // PriceHistory PDA has the count it needs.
          const warm = await ensureV4TwapReady(
            mintStr,
            Number(mintRow.decimals),
            { programIdOverride: borrowProgramId },
          );
          if (!warm.ok) {
            console.warn(
              `[cosign-borrow] TWAP warming TIMED OUT prog=${borrowProgramId.toBase58().slice(0, 8)}… mint=${mintStr.slice(0, 8)} inWindow=${warm.inWindow}/8 waited=${warm.waitedMs}ms attests=${warm.attests} reason=${warm.reason}`,
            );
            return {
              status: 503,
              body: {
                error:
                  "Price oracle is warming up for this token (we need a few more samples in the rolling 5-min window). This usually clears in 30–45 seconds — please tap Borrow again.",
                oracle_warming: true,
                in_window: warm.inWindow,
                required_in_window: 8,
                retry_after_seconds: 30,
              },
            };
          }
          console.log(
            `[cosign-borrow] TWAP ready prog=${borrowProgramId.toBase58().slice(0, 8)}… mint=${mintStr.slice(0, 8)} inWindow=${warm.inWindow}/8 waited=${warm.waitedMs}ms attests=${warm.attests}`,
          );
        } else {
          // V1/V3 path: single-shot freshness check (PR was already
          // adequate — no TWAP gate on legacy programs).
          const age = await getPriceFeedAgeSeconds(mintStr, borrowProgramId);
          if (age === null || age > FRESH_THRESHOLD_SEC) {
            try {
              await attestPrice(mintStr, Number(mintRow.decimals), undefined, borrowProgramId);
            } catch (attestErr) {
              if (/AccountNotInitialized|account.*does not exist|0xbc4|3012/i.test(attestErr.message)) {
                await initializePriceFeed(mintStr, borrowProgramId);
                await attestPrice(mintStr, Number(mintRow.decimals), undefined, borrowProgramId);
              } else {
                throw attestErr;
              }
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

  // All explicit gates passed. Add the lender signature.
  let lender;
  try {
    lender = loadLenderKeypair();
  } catch (e) {
    console.error("[cosign-borrow] keypair load failed:", e.message);
    return { status: 500, body: { error: "Lender keypair unavailable" } };
  }

  tx.partialSign(lender);

  // Gate 0c (Layer 2 of the 2026-06-18 exploit defense): pre-flight
  // balance-delta simulation. Even after Gate 0b's discriminator
  // enumeration, a yet-unknown instruction shape on an allowlisted
  // program could decrease a lender-owned balance. Belt-and-suspenders:
  // simulate the now-fully-signed tx and reject if ANY lender SOL or
  // token balance would decrease.
  //
  // Legitimate borrows NEVER decrease lender balances — the protocol
  // sources principal SOL from the pool PDA, not the lender wallet,
  // and the borrower pays all fees. ANY decrease in the lender wallet
  // during cosign-borrow is suspicious.
  //
  // The check is read-only on-chain (simulateTransaction). On RPC
  // failure we fail CLOSED — refuse to broadcast — because the cost of
  // a missed drain is much higher than a transient unavailability.
  try {
    const drainCheck = await detectLenderBalanceDrain(connection, tx, LENDER_PUBKEY);
    if (!drainCheck.ok) {
      // tx is now signed but we never broadcast — the lender signature
      // is wasted but the funds stay safe. The attacker learned nothing
      // they couldn't have learned from any other failed tx.
      console.error(`[cosign-borrow] LAYER-2 BLOCK: ${drainCheck.error}. detail=${drainCheck.detail}`);
      return {
        status: 403,
        body: {
          error: "Pre-flight simulation detected a lender-account balance decrease — refusing to broadcast",
          detail: drainCheck.detail,
          layer: "L2-pre-flight-sim",
        },
      };
    }
  } catch (simErr) {
    // Simulation infrastructure errored. Fail closed.
    console.error(`[cosign-borrow] LAYER-2 SIM-ERROR: ${simErr.message?.slice(0, 200)}`);
    return {
      status: 503,
      body: {
        error: "Pre-flight balance-drain check failed (RPC/simulation error) — please retry in a few seconds",
        detail: simErr.message?.slice(0, 160),
      },
    };
  }

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
    const magpieIx = tx.instructions.find((ix) => isMagpieProgram(ix.programId));
    if (magpieIx) {
      // Loan PDA is at index 2 in the request_and_fund_loan accounts
      // (pool, loan_token_vault, loan, ...). We've already validated
      // there's exactly one magpie ix above, so grab it directly.
      const loanAccountKey = magpieIx.keys[2]?.pubkey;
      const borrowerAccountKey = magpieIx.keys[8]?.pubkey;
      if (loanAccountKey && borrowerAccountKey) {
        recordedLoanPda = loanAccountKey.toBase58();
        // RPC propagation race: the tx confirmed but our read RPC
        // may still return null for ~1-3s. Single-shot was responsible
        // for the 2026-06-18 V4 SPCX silent-loan loss (operator's
        // wallet 3LfT7WLc — loan_id 116769228150579532, loan_pda
        // 3FkFJ91i...). Retry 4× with exponential backoff (0.5s, 1s,
        // 2s, 4s = ~7.5s total) before falling back to the warn path.
        // See feedback_no_loan_slips_through.md.
        let onChainLoan = null;
        let fetchErr = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            onChainLoan = await program.account.loan.fetch(loanAccountKey);
            break;
          } catch (e) {
            fetchErr = e;
            const delayMs = 500 * Math.pow(2, attempt);
            console.warn(
              `[cosign-borrow] loan.fetch attempt ${attempt + 1}/4 for ${recordedLoanPda.slice(0, 8)}… failed (${e.message?.slice(0, 60)}) — retrying in ${delayMs}ms`,
            );
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
        if (!onChainLoan) {
          // Final failure. Throw so the outer catch surfaces the
          // sig + loan_pda LOUDLY in logs — invisible loans must be
          // diagnosable in retrospect.
          throw new Error(
            `loan.fetch failed after 4 retries for loan_pda=${recordedLoanPda} sig=${signature}: ${fetchErr?.message?.slice(0, 120)}`,
          );
        }
        const borrowerStr = borrowerAccountKey.toBase58();
        // Same TG-preferring resolver as the proposed-loan-lamports gate
        // above. Both must agree or recordLoan attributes to a different
        // user than the gates validated.
        // 2026-06-17 PM — for V4 anonymous borrowers (Phantom-only
        // wallets with no `wallets` row), auto-link instead of skipping
        // recordLoan. Without this, the borrow succeeds on chain but
        // the dashboard's Active Loans tab is empty — operator hit
        // exactly that scenario on wallet 3J1Ut4tK1... See
        // feedback_cosign_borrow_must_auto_link_anonymous_wallets.md.
        const { resolveOrAutoLinkWalletOwner } = await import("../services/wallet-owner-resolver.js");
        const recordUserId = await resolveOrAutoLinkWalletOwner(
          borrowerStr,
          "cosign_borrow_autolink",
        );
        const walletRow = recordUserId ? { user_id: recordUserId } : null;
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
    // sync-loan from the site (or the wallet-backfill safety net)
    // will fold this into DB shortly. Log LOUDLY with sig + loan_pda
    // + chosenProgramId so the next operator search ("why didn't my
    // loan land?") can find this in logs. See
    // feedback_no_loan_slips_through.md.
    console.error(
      `[cosign-borrow] CRITICAL post-submit recordLoan failed — silent-loan risk. sig=${signature} loan_pda=${recordedLoanPda} program=${chosenProgramId.toBase58()} err=${err.message?.slice(0, 200)}\nstack=${err.stack?.slice(0, 400)}`,
    );
  }

  return {
    status: 200,
    body: { ok: true, signature, loan_pda: recordedLoanPda },
  };
}
