# Magpie Capital — Security Architecture Packet

**Audience:** Blowfish review team / Phantom dApp-security reviewers / Anyone evaluating Magpie for malicious-dApp blocklist clearance.

**Status:** Public-information-safe one-pager. Attach to Blowfish appeal, share in Phantom dev Discord, or send to any reviewer who asks for more depth.

---

## Project at a glance

Magpie Capital is a permissionless, on-chain lending protocol on Solana. Users deposit approved memecoins or tokenized stocks as collateral and receive SOL co-signed by the protocol in seconds. The protocol is non-custodial-by-export: any user can `/export` their private key at any time and self-custody.

| | |
|---|---|
| Site | https://magpie.capital |
| Linktree | https://magpie.capital/links |
| Public stats | https://magpie.capital/stats |
| Security doc | https://magpie.capital/security |
| Both repos public | https://github.com/magpiecapital |
| On-chain program (v1) | `4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh` |
| On-chain program (v2) | `7tapneCmNwRVEtdeZks4649Q2rf8W1t9tshMN9yHX99P` |
| $MAGPIE mint (Token-2022) | `9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump` |

---

## Why a heuristic detector might trip on us — and why it shouldn't

Magpie's defining UX is one-click borrowing. To make that possible, the borrow transaction is **co-signed** by the protocol's authority: the user signs, the protocol signs, both signatures are required for the on-chain `borrow` instruction to execute.

**To a heuristic detector this can resemble a wallet-drainer pattern** — "server-side signs a transaction touching the user's wallet" is a flag-worthy shape. But the underlying mechanics are the opposite of a drainer:

| Property | Drainer | Magpie co-sign |
|---|---|---|
| Server controls what tx does | ✅ | ❌ — strict outer-instruction allowlist |
| Server can move user's other assets | ✅ | ❌ — co-sign is scoped to the `borrow` ix |
| User can revoke / leave | ❌ | ✅ — `/export` private key any time |
| Funds path | user → unknown wallet | user → protocol on-chain pool, with collateral lock |
| Source code | private, obfuscated | both repos public, MIT licensed |
| Auditable | no | every flow on-chain at solscan.io |

---

## The actual cosign-borrow flow (transaction-level)

```
                                       ┌─────────────────────────┐
                                       │ Borrower wallet         │
                                       │ (Phantom / TG bot)      │
                                       └──────────┬──────────────┘
                                                  │
                            ① User signs borrow tx (their collateral)
                                                  │
                                                  ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │ Magpie cosign-borrow endpoint                                    │
        │                                                                  │
        │  Gate A — Outer-instruction ALLOWLIST                            │
        │    Every outer instruction MUST be one of:                       │
        │      • Magpie program (v1 or v2)                                 │
        │      • ComputeBudget                                             │
        │      • Associated Token Account program                          │
        │      • SPL Token program                                         │
        │      • Token-2022 program                                        │
        │    Any other outer ix → REJECTED, never co-signed.               │
        │                                                                  │
        │  Gate B — System-from-lender BLOCK                               │
        │    Even within allowed programs, the lender authority can NEVER  │
        │    be the source of a SystemProgram::transfer. Hard reject.      │
        │                                                                  │
        │  Gate C — Kill switch                                            │
        │    COSIGN_BORROW_DISABLED env var → endpoint returns 503         │
        │    immediately. Operator can pause the entire surface in <1s.    │
        └──────────┬───────────────────────────────────────────────────────┘
                   │
                   │ ② Server co-signs IFF all three gates pass
                   ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │ Solana mainnet — Anchor program execution                        │
        │                                                                  │
        │  • User collateral locked in program-owned vault                 │
        │  • SOL disbursed to borrower's wallet                            │
        │  • Loan record written to program state                          │
        │  • Every state change emits Anchor events; indexed off-chain     │
        └──────────────────────────────────────────────────────────────────┘
                   │
                   ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │ Helius webhook — real-time outflow alarm                         │
        │                                                                  │
        │  Subscribed to: lender authority wallet                          │
        │  Trigger: any native-SOL outflow not part of a legitimate        │
        │           Magpie program borrow                                  │
        │  Action: operator DM within seconds                              │
        │                                                                  │
        │  Defense-in-depth: even if both gates above had a regression,    │
        │  the operator gets paged on any anomalous outflow.               │
        └──────────────────────────────────────────────────────────────────┘
```

**Verifiable on-chain at any time.** Every co-signed transaction's outer instructions are visible on solscan.io. Anyone can confirm the allowlist holds by spot-checking signatures.

---

## On-chain trust signals (publicly verifiable)

All numbers come from the Magpie program state on Solana mainnet and the `loans` table indexed from on-chain events. Verify at `solscan.io` or `magpie.capital/stats`:

- **240+ SOL** borrowed cumulatively (`SUM(loan_amount_lamports)` across all loan rows)
- **300+ loans** issued lifetime (`pool.totalLoansIssued`)
- **250+ loans** repaid successfully
- **0** LP losses to date — no LP has lost capital due to liquidation slippage
- **0** liquidations — by design (short term lengths, conservative LTVs, active token-health watcher pausing risky tokens proactively)
- **0** custodial-key compromise events — wallets encrypted at rest with AES-256-GCM and per-user initialization vectors

---

## Defensive surface — what we built BEFORE Blowfish ever flagged us

The protocol's safety posture is documented at `magpie.capital/security`. Highlights:

- **Strict permission model** — the on-chain program has no admin-override instruction. There is no key that can drain user collateral, freeze accounts, or unilaterally move user funds.
- **Open source** — both `magpie-bot` and `magpie-site` repos at `github.com/magpiecapital` are MIT-licensed. Every line of the cosign endpoint, the Anchor program, the keeper logic, the moderation pipeline — fully readable.
- **Token allowlist** — only operator-approved tokens can be used as collateral. Each goes through automated screening (liquidity floor, holder distribution, age) before approval. Risky tokens get auto-paused by the token-health watcher.
- **Bug bounty** — `magpie.capital/security` describes the responsible-disclosure policy: report → 24h acknowledgement → 72h initial assessment.
- **Conservative LTV tiers** — 20–30% LTV across the three loan tiers. Combined with short terms (2–7 days max), this is the structural reason liquidations stay at zero.

---

## How users connect (relevant to Phantom flagging context)

Magpie has two equivalent surfaces:

1. **Telegram wallet bot** — `@magpie_capital_bot` — works perfectly, fully unaffected by the current Phantom flag. Most active users today are on this surface.
2. **Web app** — `magpie.capital` — uses standard `@solana/wallet-adapter-react` to connect Phantom (or any other Solana wallet). Each user-initiated action is signed once by the user in their wallet, then co-signed by the protocol's authority via the cosign endpoint described above.

**No drainer-typical patterns:**
- We never request approval to spend arbitrary tokens
- We never set token-program approve/allowance on the user's tokens (Solana doesn't have ERC-20 approve semantics, but the equivalent — pre-authorized token delegate accounts — is also unused)
- We never request a blank-permission signature (e.g., empty-message signing)
- We never request seed phrases or private keys
- We never DM users first; there is no "Magpie support" DM account

---

## What changes if Magpie is on the Blowfish blocklist

Users on Phantom can still use `@magpie_capital_bot` directly, so the protocol continues to operate. The harm is:

- New users discovering Magpie via the web app see a "malicious dApp" warning and leave
- Existing site users can't sign new transactions through Phantom
- Reputational impact disproportionate to actual risk

Magpie has a clean track record (zero LP losses, zero user-fund incidents, sub-1% liquidation rate, $0 of user collateral lost), zero on-chain admin overrides, and fully open source. We'd appreciate the chance to walk a Blowfish reviewer through any specific concern.

---

## Contact

| | |
|---|---|
| Email | *(operator: set up team@magpie.capital or similar before sending)* |
| X / Twitter | @MagpieLoans |
| Telegram (public) | @magpietalk |
| GitHub | github.com/magpiecapital |
| Site security page | magpie.capital/security |

Happy to provide transaction traces, run through a code walk on any specific concern, or hop on a call with the Blowfish security team. Whatever's most useful to get this resolved.

— Magpie Capital team
