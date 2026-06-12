# F-1 Multisig Migration Runbook

> **Status:** Plan only. No code changes yet — this is the operator-facing playbook for the on-chain authority handover.
>
> **Audit finding:** F-1 (MEDIUM, 2026-06-12 V1/V2 security audit). Lender authority concentration. Today a single `LENDER_PRIVATE_KEY` env var controls every privileged on-chain action (`set_paused`, `set_keeper_reward`, `admin_withdraw`, `update_price`, all borrow cosigns). Compromising that one key = full pool drain.
>
> **Goal:** Move the authority to a 2-of-3 Solana multisig so no single key can act unilaterally.

---

## 1. Decision points (operator-only — needed before any code starts)

### 1a. Which multisig program?

| Option | Pros | Cons |
|---|---|---|
| **Squads Protocol v4** (recommended) | Production-grade, audited (Trail of Bits + Halborn), $1B+ TVL securing it, mature CLI + web app, supports proposal queue + execution windows | Adds a third-party dependency; their program upgrades are on their own schedule |
| **Mean Multisig** | Open source, simpler model | Less battle-tested at scale |
| **Roll your own** | Total control | You're inventing a critical security primitive — **do not do this** |

**Recommendation: Squads v4.** Documented at `https://docs.squads.so/main/v/development/squads-v4-sdk`.

### 1b. Threshold + signer count

Standard tradeoff:

| Setup | Resilience | Friction |
|---|---|---|
| 2-of-3 | Survives 1 key loss; survives 1 key compromise | Manageable |
| 3-of-5 | Survives 2 key losses; survives 2 key compromises | Higher coordination cost; usually overkill until protocol scales |

**Recommendation: 2-of-3.** Three signers, two required to act.

### 1c. Who holds the keys?

The HARDEST decision and the one that actually determines whether the multisig is a real security upgrade or theater. Recommendations:

- **Signer 1**: Operator's primary device (Ledger Nano X). Hardware-signed every time. Air-gapped storage for the 24-word recovery phrase (steel plate, not paper).
- **Signer 2**: Operator's secondary device on a DIFFERENT brand. (If primary is Ledger, secondary should be Trezor or Keystone. Same-brand-on-both = single firmware bug = both compromised.) Geographically separated from Signer 1.
- **Signer 3**: An independent party. Options:
  - A co-founder, lawyer, or accountant the operator trusts personally
  - A multisig-custody service like Coincover or Fireblocks (paid)
  - A close family member with a hardware wallet they don't otherwise use
  - **NOT** another Magpie operator account from the same device

**Anti-pattern to avoid**: three keys on three apps on the same phone. That's a single point of failure (the phone), defeating the purpose.

### 1d. Operational policy

- **Hot signer (Railway bot)**: keeps a Squads-signed permission to call `cosign-borrow` and `update_price` only — those are high-frequency, low-blast-radius (already strict-discriminator-gated in `cosign-borrow.js:62-65`). The bot stays as a member of the multisig with execution rights ONLY for those two instruction discriminators.
- **Authority actions** (`set_paused`, `set_keeper_reward`, `admin_withdraw`): require 2-of-3 human-signer approval through Squads. Execution window: 24-hour timelock recommended for `admin_withdraw` so the community can react if something looks wrong.
- **Daily operations** (price attestation, borrow cosigns): bot's permission is sufficient. No multisig overhead per-borrow.

---

## 2. Migration sequence (no code shipped until 2.5)

### 2.1 Pre-flight — staging dress rehearsal

```
- Deploy Squads v4 multisig on devnet
- Configure 2-of-3 with three test keys (anyone can hold; not the real signers yet)
- Deploy a copy of magpie_lending V1 to devnet
- Initialize a test pool with the multisig as authority (NOT a single key)
- Run through every authority action via the Squads CLI:
    set_paused, set_keeper_reward, admin_withdraw, update_price
- Confirm the bot can cosign borrows via its delegated permission
- Time the proposal-create + 2nd-signer + execute window
- Document the exact CLI commands for each action in OPERATIONS.md
```

**Exit criteria:** every authority action runs end-to-end on devnet via multisig, with timing logged. Operator runs through the full sequence once unaided.

### 2.2 Real signer setup

- Acquire the three hardware wallets (Section 1c). Wipe + re-initialize each. Recovery phrase to steel plate, NOT photo, NOT cloud, NOT password manager.
- Each signer creates one key on their device. They send the operator the **public key only**.
- Operator records the three pubkeys somewhere durable but not internet-public (encrypted note manager is fine; the pubkeys aren't secrets but losing the list is annoying).

### 2.3 Mainnet multisig creation

- Operator uses Squads web app or CLI to create a NEW 2-of-3 multisig on mainnet.
- Three signers (Section 1c) added.
- Multisig PDA address recorded.
- Each signer tests they can submit + sign a no-op transaction (e.g. a 0-lamport SystemProgram transfer to themselves) through their device.

### 2.4 Authority transfer ceremony

The riskiest step. Done once.

| Step | What | Who |
|---|---|---|
| 1 | Operator publishes `/pause` (existing TG command) — borrowing frozen | Operator |
| 2 | Operator drains active liquidations queue — keeper finishes any pending work | Operator + keeper bot |
| 3 | Authority calls `set_authority(new=Multisig PDA)` via the on-chain program. **NOTE: V1 and V2 programs may not currently expose `set_authority` — VERIFY before this step. If not, the migration requires a program redeploy with the new authority hardcoded, which is its own ceremony.** | Lender keypair signs |
| 4 | Two signers verify the on-chain `pool.authority` field now equals the multisig PDA | All three signers |
| 5 | Operator submits + signs a test no-op via Squads (`/resume` would also work as a sanity test of the new authority path) | Two of three signers approve |
| 6 | If test ok, the old `LENDER_PRIVATE_KEY` is destroyed (the keypair file on disk + the env var on Railway — keep a sealed cold-storage copy for 30 days as recovery in case of an unforeseen issue, then destroy that copy too) | Operator |

### 2.5 Code changes

After 2.4 succeeds, ship a PR that updates the bot:

- `src/api/cosign-borrow.js` — the lender authority signer is now the multisig PDA, but the bot still cosigns with its delegated permission. The strict discriminator allowlist already in `cosign-borrow.js:62-65` is unchanged.
- `src/services/keeper.js` — `LENDER_PUBKEY` env var becomes the multisig PDA address. F-6 already removed the keypair-path fallback (PR #106), so this is just an address change.
- `src/services/price-attestor.js` — same delegated-permission model.
- New env: `MULTISIG_AUTHORITY_PUBKEY` = multisig PDA address.
- Old env: `LENDER_PRIVATE_KEY` removed from Railway. `LENDER_KEYPAIR_PATH` already deprecated by F-6.
- Document in `OPERATIONS.md`: how to action a sensitive command via Squads (CLI commands per action).

### 2.6 Post-migration validation

- Confirm `/stats` still rolls up correctly across V1+V2.
- Confirm a normal user borrow flow completes end-to-end (cosign path).
- Confirm price attestation still publishes on its cadence.
- Confirm a test admin action through Squads completes within expected window.
- Operator runs through the V2-specific borrow path (e.g. $SPCX, $TSLAx) to confirm the multisig authority signs V2 ix correctly.
- Run `/admincmds` to verify F-4 audit log captures the multisig-mediated calls correctly.

---

## 3. Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Squads program upgrade breaks our integration | LOW | Pin to a specific Squads version; monitor their changelog. Squads has strong upgrade discipline. |
| Operator loses access to 2 of 3 signers simultaneously | LOW-MED | Treat the 3rd signer (independent party / paid custody) as the redundancy. Run signer-availability drills quarterly. |
| `set_authority` doesn't exist on V1/V2 program | UNKNOWN — verify first | Read the on-chain program IDL + source. If not present, the migration requires a parallel program deploy + loan migration, which is multi-week. |
| Multisig PDA loses access to the SOL it needs for cosign tx fees | LOW | Pre-fund the multisig PDA with 1 SOL initially; top up via a recurring transfer from the operator's hot wallet. |
| Bot's delegated cosign permission gets revoked accidentally | LOW | Document the exact CLI sequence to re-grant. Operator practices it once on devnet. |
| Squads frontend phishing attack | MEDIUM | Always use the verified Squads CLI from `npm install -g @sqds/cli` (`pnpm` works too). Never paste a multisig URL from a DM or social media. Bookmark the official squads.so URL. |

---

## 4. Estimated effort

- Section 1 decision-making: **1–2 hours** with the operator.
- Section 2.1 staging rehearsal: **4–6 hours** (most of which is the devnet ceremony — actual code is minimal).
- Section 2.2 signer setup: **1–2 hours per signer**, parallelizable.
- Section 2.3 mainnet creation: **1 hour** including verification.
- Section 2.4 ceremony: **2–3 hours** (this is the slow, careful part).
- Section 2.5 code shipment: **1 day** for the bot-side PR + review.
- Section 2.6 validation: **2–3 hours**.

**Total elapsed:** ~1 week if everything goes smoothly, with most of the time being calendar (signer availability, hardware wallet shipping if needed). Active engineering: 1–2 days.

---

## 5. Blockers / open questions for the operator

1. **Does V1 `magpie_lending` expose `set_authority`?** Source is in private repo `magpiecapital/magpie-lending` — need to confirm. If NOT, migration path is fundamentally different (parallel program deploy).
2. **Same question for V2** (`magpie_lending_v2`).
3. **Who is the third signer?** This determines the timeline more than any other variable.
4. **Acceptable timelock for `admin_withdraw`?** 24h is conservative; 0h is immediate-execute. Recommend 24h.
5. **Devnet TVL test funding?** The staging rehearsal needs a few SOL of devnet faucet — trivial, just flag it.

---

## 6. Out of scope for this runbook

- Migrating $MAGPIE governance multisig (separate proposal).
- Migrating Vercel team ownership (already handled separately — see `feedback_vercel_magpie_capital_only.md`).
- Multisig-gating `/admincmds` itself (it's read-only — not needed).
- Insurance / coverage products (Sherlock, Nexus Mutual) — separate decision; multisig is a prerequisite for most coverage policies.

---

## 7. Why this matters

The security audit estimated cost-to-attacker for lender-keypair compromise as **full pool drain**. Current TVL is ~166 SOL across V1+V2 (per `/stats`); a successful attack today would drain that, plus all collateral.

After multisig migration, the attacker needs to compromise 2 of 3 keys held by different humans on different devices with different recovery phrases. That changes the attack from "phish one operator" to "compromise an independent multi-party human supply chain." It's the single highest-leverage security move on the audit's recommendation list.

---

**Audit reference:** F-1 in the 2026-06-12 V1/V2 security audit. Full context in conversation transcript; this doc is the executable plan.
