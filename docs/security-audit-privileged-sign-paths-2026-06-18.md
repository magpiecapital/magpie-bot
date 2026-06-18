# Privileged-Sign-Paths Audit — 2026-06-18 PM

Triggered by the 2026-06-18 cosign-borrow Token-2022 drain exploit. The
operator asked: "think of any other potential similar exploits, put the
same safeguards in place, run the audit, and kill whatever needs to be
killed."

## Threat model

A "privileged sign path" is any code in the bot that signs a Solana tx
with a protocol-controlled keypair (LENDER_PRIVATE_KEY, the protocol-fee
wallet, the rewards distributor, the engine V4 authority, etc.) AND
broadcasts it. The exploit class we're defending against:

1. The path either accepts external input (tx bytes, user params) OR
   has its destination governed by an env var
2. Insufficient validation lets the signed tx have a side-effect that
   decreases a privileged account's balance (drain) or routes funds to
   an unauthorized destination

The universal defense doctrine (shipped earlier today via PR #377):

- **Source-level destination allowlist** — env vars can only override
  to a pre-approved pubkey, killed at compile time otherwise
- **Universal sign guard** — every privileged sign goes through
  `runPrivilegedSign` which signs, simulates, and rejects any
  unauthorized balance decrease on a signer-owned account
- **Audit log** — every privileged sign emits a `privileged_sign_audit`
  row; a self-monitor probe (future) verifies the lender wallet
  trajectory matches the audit log sum

## Path-by-path audit

### Hardened end-to-end (no further work)

| Path | Defense |
|---|---|
| `/api/v1/cosign-borrow` | Layers 1–5 of the cosign-borrow exploit doctrine. Per-ix gate + balance-delta sim + kill switch + monitor + auto-sweep. |
| `services/treasury-sweeper.js` | PR #377 — uses `runPrivilegedSign` + `assertAllowedDestination`. Canonical example. |
| `services/fee-wallet-sweeper.js` | THIS PR — wired through universal guard. Allowlisted dest, bounded SOL fee budget. |

### Adopts the bespoke-sim pattern (acceptable, marked for migration)

| Path | Status | Migration priority |
|---|---|---|
| `services/liquidation-collateral-sweeper.js` | Has its own pre-flight `simulateTransaction` check (Layer 5). Could be migrated to `runPrivilegedSign` for consistency + audit-log uniformity. | Medium |

### Need the universal guard (follow-up PR)

| Path | What signs | Why prioritized this way |
|---|---|---|
| `services/liquidation-distribution-watcher.js` | Lender keypair signing SOL transfers to rewards distributor | High — sends distribution payouts |
| `services/magpie-holder-rewards.js` | Lender + distributor keypair signing SOL payouts to MAGPIE holders | High — distributes investor rewards |
| `services/lp-loyalty.js` | Distributor keypair signing SOL payouts to LP loyalty | High — distributes investor rewards |
| `services/referral-rewards.js` | Distributor keypair signing claim payouts | Medium — user-claim flow |
| `services/protocol-fee-sweeper.js` | Protocol-fee wallet keypair sweeping to LENDER (hardcoded dest) | Low — destination hardcoded, amount capped at 5 SOL, source != lender so any drain doesn't hit the at-risk wallet |

### Low risk by construction (skipped)

| Path | Why |
|---|---|
| `services/price-attestor.js` | High volume (every 35s × 2 programs) but only writes to a Magpie PriceHistory PDA. Can't drain anything; PDA is data-only. Adding audit-log per attest would create ~4k rows/day. Not worth the cost. |
| `api/credit-attest.js`, `services/credit-oracle-publisher.js` | Sign credit attestations / publish credit scores. Output is a signed attestation, not a fund transfer. No drain surface. |
| `api/withdraw.js`, `commands/withdraw.js` | Sign with the USER'S OWN custodial keypair, not a privileged keypair. Max damage = user moves their own funds (which they can already do via /export). Different blast radius. |
| `commands/admin.js` | Admin TG-ID-gated. Doesn't accept external input from non-operator callers. |

### Killed (nothing this round)

The audit didn't surface any dead code in the signing-path category.
All identified services are imported and started in `index.js` (or have
clear callers like `/refer` for `referral-rewards.js`). Nothing to
remove right now.

## Open items

1. Wire the four "need the universal guard" rows into `runPrivilegedSign`
   in the next PR
2. Add a self-monitor probe that consumes the `privileged_sign_audit`
   table and crit-alerts when the lender wallet's actual balance
   trajectory diverges from the sum-of-expected-deltas in the audit log
   (the smoking gun for a leaked keypair: a tx lands on-chain without
   a matching audit row)
3. Once all sweepers + distributors are migrated, remove the bespoke
   pre-flight `simulateTransaction` blocks they currently use, since
   the universal guard supersedes them
