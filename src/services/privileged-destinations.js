/**
 * Privileged-keypair destination allowlists.
 *
 * Every service that signs with a protocol-privileged keypair AND moves
 * funds to a configurable destination MUST validate the destination
 * against the allowlist below. The allowlist is hardcoded at the source
 * level — an attacker who flips an env var on Railway can still only
 * redirect to a pre-approved destination.
 *
 * Env var override is allowed only for testnet/dev scoped builds. In
 * production, the env var value MUST be one of the source-level
 * allowlist entries.
 *
 * To add a new destination:
 *   1. Add the pubkey to the appropriate Set below
 *   2. Document who controls the destination + why it's in the allowlist
 *   3. Reference the project memory or PR that approved it
 *
 * Operator-mandated 2026-06-18 PM as part of the post-cosign-borrow-
 * exploit hardening pass. See
 * feedback_cosign_borrow_token_drain_exploit_2026_06_18.md.
 */
import { PublicKey } from "@solana/web3.js";

// ─────────────────────────────────────────────────────────────────
// treasury-sweeper
//
// The treasury-sweeper moves accumulated fees from the hot lender
// wallet (4JSSSa…) to a cold-storage vault to bound the lifetime
// drain a hot-key compromise could cause.
//
// Allowed destinations:
//   6foLvbG… — Squads-controlled cold treasury vault deployed
//                2026-06-18 PM. Multi-sig with the operator's hardware
//                wallet + a 48h timelock + immutable config.
//                Documented in project_treasury_vault_2026_06_18.
// ─────────────────────────────────────────────────────────────────
const TREASURY_SWEEPER_ALLOWED = new Set([
  "6foLvbGkB3Joqrj9TZRhoFwEmkSW4AbyREoYWCaHqgVk",
]);

// ─────────────────────────────────────────────────────────────────
// fee-wallet-sweeper
//
// The fee-wallet-sweeper drains the V4 program's protocol_fee_wallet
// PDA into the rewards-distributor wallet so the holder/LP/protocol
// share lands somewhere the snapshot distributors can read.
//
// Allowed destinations:
//   CHCAMWtn… — REWARDS_DISTRIBUTOR_PUBKEY. The hot wallet the
//                holder-rewards / LP-loyalty / referral payout services
//                draw from at snapshot time. Documented in
//                project_magpie.
// ─────────────────────────────────────────────────────────────────
const FEE_WALLET_SWEEPER_ALLOWED = new Set([
  "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac",
]);

// ─────────────────────────────────────────────────────────────────
// liquidation-distribution-watcher
//
// Moves distributed liquidation proceeds from the lender wallet to
// the rewards-distributor wallet so the per-distribution shares are
// available at snapshot time.
//
// Allowed destinations:
//   CHCAMWtn… — same REWARDS_DISTRIBUTOR_PUBKEY as fee-wallet-sweeper.
// ─────────────────────────────────────────────────────────────────
const LIQUIDATION_DISTRIBUTION_ALLOWED = new Set([
  "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac",
]);

// ─────────────────────────────────────────────────────────────────
// distribution-auto-funder
//
// Demand-driven top-up of the rewards-distribution wallet. Moves
// EXACTLY the funding gap (owed across holder/LP/protocol pools +
// reserve, minus the wallet's spendable native SOL) off the hot lender
// wallet (4JSSSa…) so holder/LP/referral snapshots are always payable
// without the operator hand-carrying SOL each week. The funder is
// gap-bounded and reserve-protected — it can never overshoot the owed
// amount nor drain the lender's operational reserve.
//
// Allowed destinations:
//   CHCAMWtn… — REWARDS_DISTRIBUTOR_PUBKEY. The exact wallet the
//                holder-rewards / LP-loyalty / referral distributors
//                pay holders from (native SOL via SystemProgram.transfer).
//                Same wallet as fee-wallet-sweeper + liquidation-distribution.
// ─────────────────────────────────────────────────────────────────
const DISTRIBUTION_FUNDER_ALLOWED = new Set([
  "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac",
]);

const ALLOWLISTS = {
  "treasury-sweeper": TREASURY_SWEEPER_ALLOWED,
  "fee-wallet-sweeper": FEE_WALLET_SWEEPER_ALLOWED,
  "liquidation-distribution-watcher": LIQUIDATION_DISTRIBUTION_ALLOWED,
  "distribution-auto-funder": DISTRIBUTION_FUNDER_ALLOWED,
};

/**
 * Throws if `destinationPubkey` isn't on the allowlist for `service`.
 * Call this BEFORE building the tx — fail fast.
 *
 * @param {string} service
 * @param {PublicKey|string} destinationPubkey
 */
export function assertAllowedDestination(service, destinationPubkey) {
  const list = ALLOWLISTS[service];
  if (!list) {
    throw new Error(
      `[privileged-destinations] no allowlist configured for service '${service}'. Add one to privileged-destinations.js before signing.`,
    );
  }
  const dest =
    destinationPubkey instanceof PublicKey
      ? destinationPubkey.toBase58()
      : String(destinationPubkey);
  if (!list.has(dest)) {
    throw new Error(
      `[privileged-destinations] destination ${dest} is NOT on the allowlist for service '${service}'. Allowed: ${Array.from(list).join(", ")}`,
    );
  }
}

/**
 * Returns the canonical (first) destination for a service. Useful when
 * a service needs a default without env-var overriding.
 */
export function canonicalDestinationFor(service) {
  const list = ALLOWLISTS[service];
  if (!list || list.size === 0) {
    throw new Error(`[privileged-destinations] no canonical destination for '${service}'`);
  }
  return new PublicKey([...list][0]);
}
