# Blowfish False-Positive Outreach Package

**Status:** Draft — for operator review before sending.

Blowfish is the malicious-dapp detection service Phantom uses. They flag
`magpie.capital` (or possibly the cosign-borrow API host) which is what
triggers Phantom's "Malicious dApp" warning. Their formal contact is a
single Typeform; reputation is slow + opaque. Best play: submit via
Typeform AND a public-but-measured X post (parallel channels), with a
Phantom dev-Discord intro as the backup.

---

## Channel 1 — Blowfish Typeform (primary submission)

**URL:** https://form.typeform.com/to/BHue5Hg0
(Linked from the "Contact Us" CTA on blowfish.xyz)

Use the message template below. Paste each section into the
corresponding field (Typeform usually asks: name, email, company, role,
message — fill what's required; everything else goes in the message).

### Suggested form-field answers

| Field | Suggested answer |
|---|---|
| Name | Magpie Capital team |
| Email | *(your project email — e.g. `team@magpie.capital` if you have one set up; if not, use a project-side address you check)* |
| Company / Project | Magpie Capital |
| Role | Operator |
| Subject / Reason | False-positive flag on legitimate Solana lending dApp |

### Message body (paste verbatim)

> Hi Blowfish team —
>
> We're reaching out because Phantom is currently flagging
> `magpie.capital` as a malicious dApp. We've confirmed Phantom users
> are blocked from connecting, which is breaking the protocol for a
> real and growing user base. We believe this is a false positive and
> would like to work with you on the appeal.
>
> **Project: Magpie Capital**
>
> A permissionless Solana lending protocol. Users deposit approved
> tokens as collateral, receive SOL co-signed by the protocol in
> seconds, and repay to reclaim their collateral. Permissionless,
> non-custodial-by-export (users can `/export` their private key any
> time), and entirely on-chain verifiable.
>
> **Why this is likely a false positive**
>
> Our co-sign flow legitimately submits user-initiated borrow
> transactions where the protocol authority co-signs the disbursement
> instruction. To a heuristic detector this pattern can resemble a
> wallet drainer (server-side signing of a user-touched transaction),
> but the on-chain reality is the opposite:
>
> - Every transaction we co-sign is gated by strict outer-instruction
>   allowlisting (our program ID, ComputeBudget, ATA, SPL Token, and
>   Token-2022 only — any other outer instruction is rejected)
> - The lender authority can never `SystemProgram::transfer` to a
>   user-controlled address as part of a co-signed transaction (this
>   is enforced server-side as defense-in-depth)
> - The borrower-side flow is fully visible on-chain via the Magpie
>   program (`4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh`)
> - Both repos are public and the security architecture is documented
>   at magpie.capital/security
>
> **Evidence of legitimacy**
>
> - Site: https://magpie.capital
> - Linktree (all four official surfaces): https://magpie.capital/links
> - Public stats: https://magpie.capital/stats
> - Security doc: https://magpie.capital/security
> - Source code (both repos public): https://github.com/magpiecapital
> - Live protocol stats (verifiable on-chain via solscan.io):
>   - 240+ SOL borrowed lifetime
>   - 300+ loans issued
>   - 250+ loans repaid
>   - 0 LP losses to date
>   - Zero liquidations (by design — short terms, conservative LTV,
>     active token-health watcher)
>
> **What we're asking**
>
> Could you please review the flag on `magpie.capital` and unflag if
> appropriate? Happy to provide any additional info — full transaction
> traces, program source, security architecture walkthrough — directly
> to your team.
>
> Thanks for your time. We respect the work Blowfish does protecting
> Solana users and we'd like to ensure Magpie is on the right side of
> that protection.
>
> — Magpie Capital team

---

## Channel 2 — Public X post (parallel, measured)

Post from `@MagpieLoans`. Don't tag @phantom; only tag @blowfishxyz.
The tone is professional and factual — *not* a complaint thread.

### Tweet template

> Filed a Blowfish appeal today re: a false-positive flag on
> `magpie.capital`. We're a permissionless Solana lending protocol —
> 240+ SOL lifetime borrowed, zero LP losses, both repos open-source,
> security architecture published at magpie.capital/security.
>
> Hoping for a quick review from @blowfishxyz — we know you're
> protecting Solana users and we want to be on the right side of that.
>
> Builders affected: switch to @magpie\_capital\_bot in the meantime,
> same protocol, fully working.

*(Within X's 280-char limit — adjust line breaks as needed. Avoid emoji
to keep the tone professional.)*

---

## Channel 3 — Phantom dApp Developer Discord (backup, ~3 days later if no Blowfish response)

**URL:** https://discord.gg/phantom → join → look for `#dapp-developers`
(or similar; channel names occasionally shift)

### Intro message template

> Hey team — Magpie Capital here, a permissionless Solana lending
> protocol. We're currently flagged as a malicious dApp via Blowfish
> (we've filed a formal appeal). Wondering if there's a Phantom-side
> path to get the flag reviewed in parallel.
>
> Context: magpie.capital · github.com/magpiecapital ·
> magpie.capital/security · 240+ SOL borrowed lifetime, all on-chain
> verifiable.
>
> Happy to share full architecture details or hop on a call. Thanks.

---

## What NOT to include (per operator's public-info-only policy)

- Don't mention the May 18 cosign-borrow drain unless asked. It's
  documented in `docs/INCIDENT_2026-05-18.md` for our records but
  bringing it up unprompted muddies "this is a legit protocol" with
  "they had an exploit."
- Don't reveal the operator's real identity. The project is operated
  pseudonymously by design.
- Don't mention team size, revenue, or internal plans.
- Don't reveal the deployer wallet or any operator-controlled
  addresses by hand; on-chain explorers can show those publicly but
  we don't volunteer them in support requests.

---

## Follow-up cadence

- **Day 0 (today):** Send the Typeform + tweet at @blowfishxyz
- **Day 3:** If no response, post the Discord intro in
  `#dapp-developers`
- **Day 5:** If still no response, escalate via @0xMert_ (Helius CEO,
  known to help connect legit projects with Phantom) — DM first, don't
  tag publicly
- **Day 7:** If still nothing, more public X follow-up tagging
  @brandonmillman (Phantom CEO) with a polite "any update?"
- **Day 10+:** If still stuck, the budget audit path becomes a strong
  consideration — Sec3 / Otter quick reviews often clear blocklist
  flags via underlying-system updates

## What you need to actually send this

1. A project email address (if `team@magpie.capital` or similar isn't
   set up yet, create one — many of these channels require an email)
2. Operator-side X account access to @MagpieLoans for the tweet
3. A Phantom-team Discord account if you want to use Channel 3

Everything in this doc uses *only* public info. Nothing here exposes
operator identity, internal numbers, or unpublished plans.
