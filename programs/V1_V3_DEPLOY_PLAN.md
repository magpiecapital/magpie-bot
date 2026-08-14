# V1 + V3 Hardened Redeploy — Deploy & Migration Plan

**What this deploys.** The Sec3-hardened V1 (memecoin, `magpie-lending`) and V3 (RWA,
`magpie-lending-v3`) programs — the branch merged in PR #674, carrying the ported Sec3 V4
findings (see `SEC3_V4_COVERAGE_MATRIX.md`).

**Status: NOT STARTED. This is a plan, not an action.** Nothing here runs without explicit
operator go on each privileged step.

---

## 0. The one rule this whole plan exists to guarantee

**Never redeploy at the same program id, and never strand an existing loan.** The hardened
programs deploy at **NEW program ids**. Existing loans keep running on the OLD ids
(`4FEFPeMH…` / `B8AwYzFm…`) and repay/extend/liquidate against their own stored `program_id`
untouched. Only NEW borrows route to the new hardened ids. This is the exact lane-separation
model V4→V4.1 uses.

---

## 1. Current on-chain state (verified 2026-08-14 — re-verify at deploy time)

| Pool | Old program id | Active loans now | Migration weight |
|---|---|---|---|
| V1 memecoin | `4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh` | **3** (all memecoin, none overdue) | Old id must keep serving 3 live loans |
| V3 RWA | `B8AwYzFmc3ZB5EWWVtJcJhJtEmKL78W5i3kZrL1uMCmP` | **0** | **Clean slate — lowest-risk deploy** |

**Implication:** V3 is the safer one to deploy first — no live loans to protect. V1 needs the old
program left running until its 3 loans settle (max ~149h out), but new borrows can route to V1.x
immediately.

---

## 2. Security sign-off — the exploit/vulnerability question, answered honestly

**Against the Sec3 V4 report:** all 24 findings are accounted for in V1 and V3 — 5 ported,
9 already-covered (verified), 7 not-applicable (no auto-sell engine), 3 documented design
choices, 1 open design decision (M-01). Evidence per finding: `SEC3_V4_COVERAGE_MATRIX.md`.

**⚠️ The honest limit of that statement.** "All Sec3 V4 findings addressed" is **not** "V1/V3 are
audited." Sec3 audited V4 only. V1 and V3 have code V4 never had, and Sec3 never looked at them.
Porting the V4 findings closes the *known* class; it cannot rule out a V1/V3-specific issue nobody
has reviewed. **Strong recommendation: submit the hardened V1.x/V3.x to Sec3 (or another auditor)
before, or immediately alongside, widening past the canary.** Sec3 offered unlimited re-review
within the original scope — worth asking whether V1/V3 fall under it. Do not describe V1/V3 as
"audited" on any public surface until they are.

**Two operator decisions embedded in the merged code:**
- **M-01 (extend health-check):** not ported. Extending never extracts value, so it is not a
  vulnerability — but decide consciously whether V1.x/V3.x should re-check health on extend.
- **Q-02 (overdue extend):** the merged code REFUSES extending an overdue loan. This is a live-UX
  change (a late borrower is liquidated instead of extending). Confirm you want it before deploy.

---

## 3. Pre-flight (build + program id)

For **each** program, standalone (they are excluded from the active Anchor workspace):

1. Generate a FRESH program keypair — `solana-keygen new -o magpie-lending-v1x-keypair.json`
   (and `-v3x-`). Never reuse the live ids.
2. Set `declare_id!` in each `src/lib.rs` to the new pubkey. **`declare_id` must equal the
   deployed id** — mismatch is a silent footgun.
3. Reproducible build: record the sha256 of the built `.so`. `anchor build` (V1 needs the
   temporary-workspace-member trick from the coverage work, or build via its own manifest).
4. Confirm the `anchor-spl features=["token_2022"]` addition is present (needed for H-01's
   extension parsing) and the build picks it up.
5. Upgrade authority → the **multisig + timelock**, never a single hot key.

---

## 4. Devnet full-lifecycle smoke test (must pass every case, both programs)

Init a pool + price feed for a test mint, then exercise EVERY instruction the fixes touch:

- **Borrow** (Token + Token-2022): funds correctly; H-01 rejects a mint with the pool's forbidden
  extension (V1: PermanentDelegate → refused; V3: PermanentDelegate → **accepted**, NonTransferable
  → refused); a fee-on-transfer mint → `CollateralTransferFeeUnsupported`.
- **update_price**: >100× jump → `PriceChangeExceedsBound`; backwards timestamp →
  `PriceTimestampWentBackwards`; normal move → ok.
- **extend_loan**: healthy in-term → ok, fee rounds up + > 0 (L-06); **overdue → `LoanOverdueForExtension`** (Q-02).
- **repay / partial_repay**: settles; a repaid loan → **not** liquidatable (M-02).
- **liquidate_loan**: only when `status=Active` AND `now > due_timestamp`; collateral to authority,
  keeper bounty paid.
- **deposit / withdraw**: shares from the internal counter; a rounds-to-zero deposit → rejected (L-07).
- **request tiny loan**: fee rounds up + > 0 (I-04).

---

## 5. Mainnet deploy (privileged — operator signs)

**Order: V3 first (0 live loans), then V1.** For each:
1. Operator deploys the built `.so` to the new id. Program is live but INERT until routing points
   at it.
2. Verify on-chain: deployed id == `declare_id` == keypair pubkey; upgrade authority == multisig;
   build hash matches §3.

---

## 6. Bot migration (must ship IN LOCKSTEP with routing)

The bot's `chooseProgramId` decides where a NEW borrow lands.
- Add `PROGRAM_ID_V1X` / `PROGRAM_ID_V3X` env + `ROUTE_MEMECOINS_TO_V1X` / `ROUTE_RWA_TO_V3X`
  flags, defaulting **OFF** (routing byte-identical to today until flipped).
- **Version-aware everything:** repay/extend/liquidate/withdraw must resolve each loan's program
  from `loans.program_id`, so the 3 live V1 loans keep hitting the OLD program. Confirm by decoding
  one old-id loan and one new-id loan and checking fields are sane.
- **PDA pre-warm:** the new programs need their pool + price-feed PDAs initialized before any
  borrow, or the first borrow fails `AccountNotInitialized` (the FARM/SPCX incident). Warm on
  enable.

---

## 7. Staged rollout

1. **Canary:** flip routing for a single mint (or a `CANARY_WALLET`). Do ONE real small borrow →
   repay on each new program. Verify §8 invariants.
2. **Widen** only after the canary lifecycle is green and (recommended) the auditor has eyes on it.
3. V1: leave the old program serving its 3 live loans; retire it only after they all settle.

---

## 8. Funds-safety invariants — verify ALL before widening past canary

- A new borrow locks exactly the collateral it records (H-01 receipt check holds on-chain).
- An old-id loan repays/liquidates against the OLD program, unaffected by the new deploy.
- No loan can be liquidated while `Repaid`, or before `due_timestamp`.
- `update_price` on the new programs rejects out-of-bound / backwards updates.
- Pool share accounting: a donation to the vault cannot dilute a depositor (internal counter).
- Total collateral locked on-chain == sum of active-loan collateral in the DB, per program.

---

## 9. Rollback / kill-switch

- Routing flags OFF → new borrows revert to the current programs instantly; nothing deployed is
  destroyed and no existing loan is touched.
- Each program keeps its `set_paused` — a compromised new program can be frozen for new borrows
  while existing loans still repay.
- Because old ids keep running, rollback is "stop routing to the new id," not "undo a deploy."

---

## 10. Sign-off checklist (all required before user-facing enable)

- [ ] Operator explicit go for the deploy.
- [ ] (Recommended) auditor engaged on hardened V1.x/V3.x, or a conscious decision to deploy ahead
      of audit with the §2 caveat understood.
- [ ] M-01 decision made; Q-02 overdue-extend behavior accepted.
- [ ] Fresh keypairs; `declare_id` == deployed id; upgrade authority == multisig+timelock; build
      hash recorded — all verified on-chain.
- [ ] Devnet lifecycle green (§4) for BOTH programs.
- [ ] Bot version-aware routing in place and verified against one old + one new loan (§6).
- [ ] PDAs pre-warmed on the new programs.
- [ ] Mainnet canary lifecycle green (§7).
- [ ] §8 invariants checked on mainnet.
- [ ] Public copy does NOT call V1/V3 "audited".

---

## 11. Strategic note (worth a decision, not a blocker)

The protocol is moving exits to V4/V4.1. V1/V3 are the *plain-borrow* (no auto-sell) pools. Before
investing in two more program deploys, consider whether new plain borrows should instead route
through V4/V4.1 (which already carries the audited fixes), retiring V1/V3 rather than redeploying
them. The operator's stated intent is to harden and keep V1/V3 — this plan serves that — but the
alternative (consolidate on V4) would give the audited-code benefit without two more unaudited
deploys. A one-paragraph decision either way belongs above §3.
