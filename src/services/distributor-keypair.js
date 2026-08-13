/**
 * Rewards distributor wallet keypair loader.
 *
 * As of 2026-06-14, the operator wants snapshot payouts to flow OUT of
 * a dedicated rewards distributor wallet — not the lender wallet that
 * holds loan principal. The defaulted-loan profits get pre-moved to
 * the distributor wallet at default-time, so by snapshot time the SOL
 * that's been earmarked for holders / LPs / referrers is already
 * physically segregated from the protocol's working capital.
 *
 * This module is the single source of truth for "which keypair signs
 * snapshot payouts" — every distributor (magpie-holder-rewards,
 * lp-loyalty, referral-rewards) imports getRewardsDistributorKeypair()
 * so a future credential rotation is one change.
 *
 * BACKWARD COMPAT
 * ───────────────
 * If REWARDS_DISTRIBUTOR_PRIVATE_KEY isn't set, we fall back to the
 * existing LENDER_PRIVATE_KEY. This keeps live deploys functional
 * during rollout — the operator can flip the env var when ready and
 * the next snapshot will use the new wallet. A startup log makes the
 * mode explicit so it's never ambiguous from observation alone.
 *
 * INTENDED LIFECYCLE
 * ──────────────────
 * 1. (Today) — REWARDS_DISTRIBUTOR_PRIVATE_KEY unset → fall back to
 *    LENDER_PRIVATE_KEY, log a warning. Behaviour identical to pre-
 *    2026-06-14 — no user-visible change.
 * 2. (Operator action) — set REWARDS_DISTRIBUTOR_PRIVATE_KEY on Railway
 *    (the CHCAM... wallet's secret). The next snapshot will sign + pay
 *    out from CHCAM, which now holds the accrued profits.
 * 3. (Future) — accrueing services that route fees on-chain at fee
 *    time could send directly to the distributor wallet instead of the
 *    lender wallet, removing the manual SOL-move step entirely. Out
 *    of scope for this change.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";

/**
 * Returns the keypair that should sign reward-payout transactions.
 *
 * Lookup order:
 *   1. REWARDS_DISTRIBUTOR_PRIVATE_KEY (base58 secret) — preferred
 *   2. LENDER_PRIVATE_KEY (base58 secret) — backward-compat
 *   3. LENDER_KEYPAIR_PATH (json file) — backward-compat for local dev
 *
 * Throws if none of those is set — distributors are not allowed to
 * silently fall back to CWD-relative defaults (same posture as the
 * cosign-borrow path that signs loan disbursements).
 */
let _cachedKeypair = null;
let _cachedMode = null;
export function getRewardsDistributorKeypair() {
  if (_cachedKeypair) return _cachedKeypair;
  const distSecret = process.env.REWARDS_DISTRIBUTOR_PRIVATE_KEY;
  if (distSecret) {
    _cachedKeypair = Keypair.fromSecretKey(bs58.decode(distSecret));
    _cachedMode = "distributor";
    console.log(
      `[distributor-keypair] using REWARDS_DISTRIBUTOR_PRIVATE_KEY ` +
      `(${_cachedKeypair.publicKey.toBase58().slice(0, 8)}…)`,
    );
    return _cachedKeypair;
  }
  const lenderSecret = process.env.LENDER_PRIVATE_KEY;
  if (lenderSecret) {
    _cachedKeypair = Keypair.fromSecretKey(bs58.decode(lenderSecret));
    _cachedMode = "lender-fallback";
    console.warn(
      `[distributor-keypair] REWARDS_DISTRIBUTOR_PRIVATE_KEY not set — ` +
      `falling back to LENDER_PRIVATE_KEY (${_cachedKeypair.publicKey.toBase58().slice(0, 8)}…). ` +
      `Set REWARDS_DISTRIBUTOR_PRIVATE_KEY to switch payouts to the dedicated wallet.`,
    );
    return _cachedKeypair;
  }
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (kpPath) {
    const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
    _cachedKeypair = Keypair.fromSecretKey(new Uint8Array(raw));
    _cachedMode = "lender-file-fallback";
    return _cachedKeypair;
  }
  throw new Error(
    "[distributor-keypair] No keypair available. Set REWARDS_DISTRIBUTOR_PRIVATE_KEY (preferred) " +
    "or LENDER_PRIVATE_KEY. Refusing to fall back to CWD-relative defaults.",
  );
}

/**
 * "distributor" | "lender-fallback" | "lender-file-fallback".
 * Used by /stats and other introspection paths to surface which mode
 * the snapshot system is currently running in.
 */
export function getRewardsDistributorMode() {
  if (!_cachedKeypair) getRewardsDistributorKeypair();
  return _cachedMode;
}

/**
 * The pubkey users should see for the rewards distributor. Read by
 * /stats, the about page, and Pip's knowledge base so the public
 * always knows which on-chain wallet to verify payouts from.
 */
export function getRewardsDistributorPubkey() {
  return getRewardsDistributorKeypair().publicKey;
}

// The ONE canonical CHCAM rewards wallet pubkey. Its PRIVATE key lives ONLY on
// the operator's machine (~/.magpie-private/distribution-keypairs/MGP-001-sender.json).
// The bot must NEVER hold it — distributions are operator-initiated local ops.
export const CHCAM_REWARDS_PUBKEY = "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac";

/**
 * Boot-time discipline assertion. The entire autonomous-funding safety model
 * depends on the bot running in LENDER-FALLBACK mode (it CANNOT sign for CHCAM):
 * every CHCAM-side unwrap is a guarded no-op, and CHCAM is only ever a transfer
 * DESTINATION. If REWARDS_DISTRIBUTOR_PRIVATE_KEY is ever set, those no-ops
 * INVERT into active CHCAM signing and the bot holds the rewards key — exactly
 * what the off-Railway key custody is designed to prevent.
 *
 * @param {{ hard?: boolean }} [opts] hard=true → throw (refuse to start) on the
 *   dangerous private-key-set condition. Default true.
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function assertDistributorKeyDiscipline({ hard = true } = {}) {
  const issues = [];
  if (process.env.REWARDS_DISTRIBUTOR_PRIVATE_KEY) {
    const msg =
      "REWARDS_DISTRIBUTOR_PRIVATE_KEY is SET — the bot must NEVER hold CHCAM's private key " +
      "(off-Railway custody). Distributions are operator-initiated local ops. Unset it on Railway.";
    issues.push(msg);
    console.error(`[distributor-keypair] FATAL: ${msg}`);
    if (hard) {
      throw new Error(`[distributor-keypair] refusing to start: ${msg}`);
    }
  }
  const pub = process.env.REWARDS_DISTRIBUTOR_PUBKEY;
  if (pub && pub !== CHCAM_REWARDS_PUBKEY) {
    const msg = `REWARDS_DISTRIBUTOR_PUBKEY=${pub} != canonical CHCAM ${CHCAM_REWARDS_PUBKEY}`;
    issues.push(msg);
    console.error(`[distributor-keypair] CRIT: ${msg}`);
  }
  return { ok: issues.length === 0, issues };
}
