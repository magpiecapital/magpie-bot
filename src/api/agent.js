/**
 * Agent-facing borrow API.
 *
 * Lets AI agents (or any non-TG, non-site caller) initiate a borrow
 * via x402. The flow:
 *
 *   1. Agent's wallet holds collateral on-chain.
 *   2. Agent calls magpie-x402 with payment → x402 verifies payment →
 *      x402 calls THIS endpoint with the bot's INTERNAL_API_TOKEN.
 *   3. We run every borrow gate the human flow runs (ban registry,
 *      anti-exploit, price cross-source, etc.) against the agent's
 *      wallet. NO exemptions.
 *   4. If all gates pass, we build the request_and_fund_loan ix into
 *      a Transaction with the agent as fee payer + borrower. We do
 *      NOT sign — agent signs with their own wallet.
 *   5. Return the serialized partial-signed tx (base64) + a summary.
 *   6. Agent signs + submits to /api/v1/cosign-borrow (the existing
 *      lender-cosign endpoint validates + cosigns + submits to chain).
 *
 * Security model:
 *   - Caller must present X-Internal-Token: ${INTERNAL_API_TOKEN}.
 *     Only the x402 service knows this token (operator config).
 *   - The agent's WALLET is the borrower. The bot does NOT custody
 *     anything on the agent's behalf.
 *   - Every gate that runs on human borrows runs here. Agents get
 *     the same protections (e.g. imported-wallet cooldown, pool
 *     liquidity floor, TWAP, per-token cap, ban list).
 *   - We auto-create a Magpie user record for each wallet (synthetic
 *     negative telegram_id derived from a wallet-pubkey hash) so the
 *     gates have a user_id to evaluate against. The synthetic ID is
 *     deterministic — same wallet always maps to the same user_id.
 *   - Builds the tx but DOES NOT submit. Agent submits after signing.
 *
 * What this endpoint does NOT do:
 *   - Sign on behalf of the agent
 *   - Submit the tx
 *   - Hold any funds custodially
 *   - Bypass any anti-exploit gate
 */
import { createHash } from "node:crypto";
import { constantTimeEqual } from "./auth-utils.js";
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { query } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import {
  PROGRAM_ID,
  PROGRAM_ID_V2,
  PROGRAM_ID_V3,
  PROGRAM_ID_V4,
  chooseProgramIdForCategory,
  chooseProgramId,
  assertProgramMatchesCategory,
  getProgramForSigner,
} from "../solana/program.js";
import {
  lendingPoolPda,
  loanTokenVaultPda,
  loanPda,
  collateralVaultPda,
  priceFeedPda,
} from "../solana/pdas.js";
import { collateralValueLamports as fetchValueLamports } from "../services/price.js";
import { preBorrowBanCheck } from "../services/bans.js";
import { preBorrowAntiExploitCheck } from "../services/anti-exploit.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";
import { Keypair } from "@solana/web3.js";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

// Legacy memecoin tier map — kept for back-compat callers that still
// import TIERS directly. NEW code should use the category-aware
// resolveTierForAgent helper below, which picks the right schedule
// (memecoin vs RWA) based on the collateral's supported_mints.category.
//
// On-chain program's TIER_LTV_BPS / TIER_DURATION_DAYS / TIER_FEE_BPS
// were derived from these defaults at v1; RWA borrows on V2 use the
// resolver so the higher 50/60/70% RWA tiers flow through correctly.
export const TIERS = {
  0: { ltv: 30, days: 2, feeBps: 300 }, // express (memecoin)
  1: { ltv: 25, days: 3, feeBps: 200 }, // quick (memecoin)
  2: { ltv: 20, days: 7, feeBps: 150 }, // standard (memecoin)
};

import { getTierByOption } from "../services/loan-tier-resolver.js";

/**
 * Resolve a tier from (category, option). Returns shape compatible with
 * the legacy TIERS map entries: { ltv, days, feeBps }. RWA categories
 * route to rwa_loan_tiers; memecoin path matches the legacy TIERS map.
 *
 * Used by buildBorrowTx so x402 agent borrows respect the same
 * category-aware tier schedule as TG /borrow.
 */
export async function resolveTierForAgent({ category, option }) {
  const tier = await getTierByOption({ category, option });
  if (!tier) return null;
  return { ltv: tier.ltv, days: tier.days, feeBps: tier.feeBps };
}

/**
 * Deterministic synthetic telegram_id for a wallet pubkey.
 * Negative range (real TG IDs are positive int32-or-int64 positive),
 * so collisions with actual TG users are impossible. Same wallet always
 * maps to the same id — idempotent.
 */
function syntheticTelegramId(walletPubkey) {
  const h = createHash("sha256").update(walletPubkey).digest();
  // Take low 6 bytes and negate. 2^48 = ~2.8e14 distinct values — plenty.
  const low48 = h.readUIntBE(0, 6);
  return -(low48 + 1); // +1 so we never produce 0
}

export async function findOrCreateAgentUser(walletPubkey) {
  const synthTg = syntheticTelegramId(walletPubkey);
  // Try insert; on conflict (already exists for this wallet), select.
  const { rows } = await query(
    `INSERT INTO users (telegram_id, telegram_username)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id) DO UPDATE
         SET telegram_username = EXCLUDED.telegram_username
       RETURNING id`,
    [synthTg, `agent_${walletPubkey.slice(0, 8)}`],
  );
  const userId = rows[0].id;
  // Ensure a wallets row exists for this pubkey (source='agent_x402')
  await query(
    `INSERT INTO wallets (user_id, public_key, encrypted_secret, nonce, auth_tag, source, is_active)
     VALUES ($1, $2, '', '', '', 'agent_x402', TRUE)
     ON CONFLICT (public_key) DO NOTHING`,
    [userId, walletPubkey],
  );
  return userId;
}

/**
 * Run the full borrow gauntlet (ban → valuation → anti-exploit) and
 * build the unsigned tx. Used by both /agent/build-borrow (direct
 * agent flow) and the conditional-borrow watcher (when an intent
 * matches its trigger).
 *
 * On block: returns { blocked: true, status, body }.
 * On success: returns { blocked: false, txB64, loanIdStr, loanAccountStr,
 *                        collateralValLamports, principalLamports, feeLamports, tierCfg, mint }.
 *
 * The same security model applies: no keypair loaded, no signing,
 * no submission. Caller assembles the response or stores the result.
 */
export async function buildBorrowTx({
  borrowerPk,
  collateralMintPk,
  collateralAmountRaw,   // string
  tier,                  // 0 | 1 | 2
  userId,                // already resolved
  mintRow,               // already resolved from supported_mints
  // V4-exclusive routing (2026-06-15): agents that ALSO plan to arm
  // an exit (TP / SL / trailing / bracket / ladder) immediately after
  // funding the loan should pass hasExitArming=true so the borrow
  // lands on V4. Plain borrows (no exit) take the legacy V1/V2/V3
  // category routing. Default false to preserve the pre-V4
  // contract — callers must explicitly opt in to V4 routing.
  hasExitArming = false,
}) {
  // Category-aware tier resolution. RWA mints get the higher-LTV
  // schedule out of rwa_loan_tiers; memecoin falls back to TIERS.
  // Defense-in-depth: if resolver returns null (bad option), surface
  // an error rather than silently picking the wrong tier.
  const tierCfg = (await resolveTierForAgent({ category: mintRow?.category, option: Number(tier) })) ?? TIERS[Number(tier)];
  if (!tierCfg) {
    return { blocked: true, status: 400, body: { error: "invalid_tier", detail: `tier ${tier} not available for category ${mintRow?.category}` } };
  }
  const collateralMintStr = collateralMintPk.toBase58();
  const borrowerWalletStr = borrowerPk.toBase58();

  // Ban check
  const banCheck = await preBorrowBanCheck({
    userId, telegramId: null, walletPubkey: borrowerWalletStr,
  });
  if (banCheck?.blocked) {
    return { blocked: true, status: 403, body: { error: "banned", reason: banCheck.reason } };
  }

  // Cross-sourced valuation
  let collateralValLamports;
  try {
    collateralValLamports = await fetchValueLamports(
      collateralMintStr,
      BigInt(collateralAmountRaw),
      Number(mintRow.decimals),
    );
  } catch (err) {
    return {
      blocked: true, status: 502,
      body: { error: "price_oracle_failed", detail: err.message?.slice(0, 200) },
    };
  }
  if (!collateralValLamports || collateralValLamports <= 0) {
    return { blocked: true, status: 400, body: { error: "collateral_value_zero" } };
  }

  const proposedLoanLamports = Math.floor((collateralValLamports * tierCfg.ltv) / 100);
  const exploitCheck = await preBorrowAntiExploitCheck({
    userId,
    collateralMint: collateralMintStr,
    proposedLoanLamports,
    walletPubkey: borrowerWalletStr,
  });
  if (exploitCheck?.blocked) {
    return {
      blocked: true, status: 403,
      body: { error: "refused", reason: exploitCheck.reason, message: exploitCheck.message },
    };
  }

  // Exit-armed borrows force V4; plain borrows take the category path.
  let programId;
  try {
    programId = chooseProgramId(mintRow.category, { hasExitArming });
  } catch (err) {
    return { blocked: true, status: 503, body: { error: "v4_not_available", detail: err.message } };
  }
  try {
    assertProgramMatchesCategory(programId, mintRow.category);
  } catch (err) {
    return { blocked: true, status: 500, body: { error: "program_routing", detail: err.message } };
  }

  let txB64, loanIdStr, loanAccountStr;
  try {
    const dummySigner = Keypair.generate();
    const program = getProgramForSigner(dummySigner, programId);
    const [lendingPool] = lendingPoolPda(LENDER_PUBKEY, programId);
    const [loanTokenVault] = loanTokenVaultPda(lendingPool, programId);

    const collateralTokenProgram = await getMintTokenProgram(collateralMintStr);
    const loanTokenProgram = TOKEN_PROGRAM_ID;

    const randomSuffix = Math.floor(Math.random() * 0x10000);
    const loanId = new BN(Date.now()).muln(0x10000).addn(randomSuffix);
    const [loanAccount] = loanPda(borrowerPk, loanId, programId);
    const [collateralVault] = collateralVaultPda(loanAccount, programId);

    const borrowerCollateralAta = getAssociatedTokenAddressSync(
      collateralMintPk, borrowerPk, false, collateralTokenProgram,
    );
    const borrowerWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT, borrowerPk, false, loanTokenProgram,
    );
    const feeWalletWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT, LENDER_PUBKEY, false, loanTokenProgram,
    );

    const preIxs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        borrowerPk, borrowerWsolAta, borrowerPk, NATIVE_MINT, loanTokenProgram,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        borrowerPk, feeWalletWsolAta, LENDER_PUBKEY, NATIVE_MINT, loanTokenProgram,
      ),
    ];
    const postIxs = [
      createCloseAccountInstruction(
        borrowerWsolAta, borrowerPk, borrowerPk, [], loanTokenProgram,
      ),
    ];

    // V3 and V4 take an extra `category` u8 arg (5 args); V1/V2 take 4.
    // V4 inherits V3's dual-tier instruction shape with the new in-vault
    // auto-sell semantics layered on top. See src/services/loans.js for
    // the symmetric branch on the TG borrow path. Without this, V3/V4
    // borrows fail with InstructionDidNotDeserialize.
    const RWA_CATEGORIES = new Set(["stock", "etf", "metal"]);
    const programIdB58 = programId.toBase58();
    const isV3 = process.env.PROGRAM_ID_V3 && programIdB58 === process.env.PROGRAM_ID_V3;
    const isV4 = process.env.PROGRAM_ID_V4 && programIdB58 === process.env.PROGRAM_ID_V4;
    const needsCategoryArg = isV3 || isV4;
    const categoryByte = RWA_CATEGORIES.has(mintRow.category) ? 1 : 0;
    const ixArgs = needsCategoryArg
      ? [new BN(collateralAmountRaw), Number(tier), new BN(collateralValLamports.toString()), loanId, categoryByte]
      : [new BN(collateralAmountRaw), Number(tier), new BN(collateralValLamports.toString()), loanId];
    const ix = await program.methods
      .requestAndFundLoan(...ixArgs)
      .accounts({
        pool: lendingPool,
        loanTokenVault,
        loan: loanAccount,
        collateralVault,
        collateralMint: collateralMintPk,
        borrowerCollateralAccount: borrowerCollateralAta,
        borrowerLoanTokenAccount: borrowerWsolAta,
        feeWalletTokenAccount: feeWalletWsolAta,
        borrower: borrowerPk,
        authority: LENDER_PUBKEY,
        priceFeed: priceFeedPda(collateralMintPk, lendingPool, programId)[0],
        systemProgram: SystemProgram.programId,
        tokenProgram: collateralTokenProgram,
        loanTokenProgram,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .preInstructions(preIxs)
      .postInstructions(postIxs)
      .instruction();

    const tx = new Transaction();
    tx.add(...preIxs, ix, ...postIxs);
    tx.feePayer = borrowerPk;
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    txB64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    loanIdStr = loanId.toString();
    loanAccountStr = loanAccount.toBase58();
  } catch (err) {
    console.error("[buildBorrowTx] tx build failed:", err);
    return {
      blocked: true, status: 500,
      body: { error: "tx_build_failed", detail: err.message?.slice(0, 200) },
    };
  }

  const feeLamports = Math.floor((proposedLoanLamports * tierCfg.feeBps) / 10_000);
  const principalLamports = proposedLoanLamports - feeLamports;

  return {
    blocked: false,
    txB64,
    loanIdStr,
    loanAccountStr,
    collateralValLamports,
    principalLamports,
    feeLamports,
    tierCfg,
    programId,
  };
}

async function getMintTokenProgram(mintStr) {
  const info = await connection.getAccountInfo(new PublicKey(mintStr));
  if (!info) throw new Error(`Mint ${mintStr} not found on-chain`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
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

/**
 * POST /api/v1/agent/build-borrow
 *
 * Body: {
 *   borrower_wallet:   string (Solana pubkey, base58),
 *   collateral_mint:   string (Solana mint pubkey, base58),
 *   collateral_amount: string (raw u64, smallest token unit, e.g. "1000000" for 1 token at 6 decimals),
 *   tier:              number (0=express, 1=quick, 2=standard)
 * }
 *
 * Returns: {
 *   ok:                  true,
 *   partial_signed_tx_b64: string (the unsigned tx — agent signs with their wallet),
 *   summary: {
 *     program_id:                  string,
 *     loan_id:                     string,
 *     loan_pda:                    string,
 *     principal_sol:               number,
 *     fee_sol:                     number,
 *     due_unix:                    number,
 *     collateral_value_sol:        number
 *   },
 *   next_step: "Sign with borrower_wallet, then POST partial_signed_tx_b64 to /api/v1/cosign-borrow"
 * }
 */
export async function handleAgentBuildBorrow(req) {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "POST only" } };
  }
  // Kill switch — flip AGENT_API_DISABLED=true on Railway to disable
  // the entire agent surface without redeploying.
  if (process.env.AGENT_API_DISABLED === "true") {
    return {
      status: 503,
      body: { error: "Agent API temporarily disabled", detail: "Use the TG bot or magpie.capital site." },
    };
  }
  // DB-driven global site pause (separate from the env kill switch).
  // agent-manage.js and agent-repay.js both check this; build-borrow
  // was the lone gap. During an incident the operator flips this to
  // halt all borrow activity instantly without a redeploy.
  const globalReject = await rejectIfSiteDisabled();
  if (globalReject) return globalReject;
  // Auth: x402 service must present the shared internal token.
  if (!INTERNAL_API_TOKEN) {
    console.error("[agent/build-borrow] INTERNAL_API_TOKEN not configured");
    return { status: 500, body: { error: "Agent API not configured (server-side)" } };
  }
  const auth = req.headers["x-internal-token"] || req.headers["authorization"] || "";
  const presented = String(auth).replace(/^Bearer\s+/i, "");
  if (!constantTimeEqual(presented, INTERNAL_API_TOKEN)) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }

  // ── Validation ──
  const { borrower_wallet, collateral_mint, collateral_amount, tier, has_exit_arming } = body ?? {};
  if (!borrower_wallet || !collateral_mint || !collateral_amount || tier == null) {
    return {
      status: 400,
      body: {
        error: "missing_params",
        required: ["borrower_wallet", "collateral_mint", "collateral_amount", "tier"],
      },
    };
  }
  let borrowerPk, collateralMintPk;
  try {
    borrowerPk = new PublicKey(borrower_wallet);
    collateralMintPk = new PublicKey(collateral_mint);
  } catch {
    return { status: 400, body: { error: "invalid_pubkey" } };
  }
  if (!/^\d+$/.test(String(collateral_amount))) {
    return { status: 400, body: { error: "collateral_amount must be a u64 string in raw units" } };
  }
  if (![0, 1, 2].includes(Number(tier))) {
    return { status: 400, body: { error: "tier must be 0 (express), 1 (quick), or 2 (standard)" } };
  }
  const tierCfg = TIERS[Number(tier)];

  // ── Resolve mint metadata (decimals + category + enabled) ──
  const { rows: mintRows } = await query(
    `SELECT mint, decimals, category, enabled, symbol FROM supported_mints WHERE mint = $1`,
    [collateral_mint],
  );
  if (!mintRows[0]) {
    return { status: 400, body: { error: "collateral_mint not supported on Magpie" } };
  }
  if (!mintRows[0].enabled) {
    return { status: 403, body: { error: "This token is currently disabled for new borrows" } };
  }
  const mint = mintRows[0];

  // ── User + gate evaluation ──
  let userId;
  try {
    userId = await findOrCreateAgentUser(borrower_wallet);
  } catch (err) {
    console.error("[agent/build-borrow] user create failed:", err.message);
    return { status: 500, body: { error: "user_create_failed", detail: err.message?.slice(0, 200) } };
  }

  const built = await buildBorrowTx({
    borrowerPk,
    collateralMintPk,
    collateralAmountRaw: String(collateral_amount),
    tier: Number(tier),
    userId,
    mintRow: mint,
    hasExitArming: has_exit_arming === true,
  });
  if (built.blocked) {
    return { status: built.status, body: built.body };
  }

  const collateralValueSol = Number(built.collateralValLamports) / 1e9;

  return {
    status: 200,
    body: {
      ok: true,
      partial_signed_tx_b64: built.txB64,
      summary: {
        program_id: built.programId.toBase58(),
        loan_id: built.loanIdStr,
        loan_pda: built.loanAccountStr,
        collateral_mint: collateral_mint,
        collateral_symbol: mint.symbol,
        collateral_amount_raw: String(collateral_amount),
        collateral_value_sol: collateralValueSol,
        principal_sol: built.principalLamports / 1e9,
        fee_sol: built.feeLamports / 1e9,
        ltv_pct: built.tierCfg.ltv,
        duration_days: built.tierCfg.days,
        due_unix: Math.floor(Date.now() / 1000) + built.tierCfg.days * 86400,
      },
      next_step:
        "Sign partial_signed_tx_b64 with borrower_wallet's private key, then POST it to /api/v1/cosign-borrow as { partialSignedTxBase64 }. That endpoint runs final validation, adds the lender authority signature, and submits to chain.",
    },
  };
}

// (Lender keypair is NOT loaded here. Only the cosign endpoint at
// /api/v1/cosign-borrow touches it. Keeping the agent build path
// keypair-free reduces the lender-key's memory exposure surface.)
