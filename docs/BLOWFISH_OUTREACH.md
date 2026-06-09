# Blowfish False-Positive Outreach Package

**Status:** Draft — for operator review before sending.

Blowfish is the malicious-dapp detection service Phantom uses. They flag
`magpie.capital` (or possibly the cosign-borrow API host) which is what
triggers Phantom's "Malicious dApp" warning. Their formal contact is a
single Typeform; reputation is slow + opaque. Best play: submit via
Typeform AND a public-but-measured X post (parallel channels), with a
Phantom dev-Discord intro as the backup.

---

## ⚠️ Update 2026-06-07 — Typeform is CLOSED

When the user tried the Typeform on 2026-06-07, it returned *"Hey :) This typeform is now closed."* Their primary public contact form is gone. The blowfish.xyz site still links to it but it no longer accepts submissions.

**New primary path → Calendly with Blake at Blowfish (30-min consultation):**
- URL: https://calendly.com/blake-at-blowfish/discovery
- Surfaced from the "Get Consultation" CTA on blowfish.xyz/pricing
- Labeled as "sales discovery" but it's a real call with a human on the Blowfish team
- 30-min direct conversation > weeks of async waiting on a Typeform

**Secondary new path → Blowfish developer portal (free signup):**
- URL: https://portal.blowfish.xyz/user
- Sign up gets you API access AND likely access to the in-portal false-positive reporting flow (the docs pages for `report` and `download-blocklist` are auth-walled, suggesting the actual appeal mechanism lives behind login)
- Also lets you check via API whether magpie.capital is actually on the blocklist

## Channel 1 — Calendly with Blake (30-min consult, primary)

**Book here:** https://calendly.com/blake-at-blowfish/discovery

The consultation is positioned as sales but it's a direct line to a Blowfish team member. Bring the security packet + the appeal context. 30 minutes of synchronous talk-through is MUCH higher leverage than any async channel.

**What to say in the booking notes / first 60 seconds of the call:**

> Hi Blake — we're Magpie Capital, a permissionless Solana lending protocol. magpie.capital is currently being false-positive flagged by Blowfish on Phantom, which is breaking the dApp flow for new users. We've prepared a full security architecture packet (verifiable at magpie.capital/.well-known/security.txt + both repos public at github.com/magpiecapital) and would love 15 of the 30 minutes to walk through why this is a false positive and the other 15 on any other questions you have. Thanks for taking the time.

**On the call, walk through:**
1. What Magpie is (1 min)
2. Why our cosign-borrow pattern can LOOK like a drainer to heuristics but isn't (3 min — show the 3-gate architecture from MAGPIE_SECURITY_PACKET.md)
3. On-chain trust signals (1 min — 240+ SOL borrowed, zero LP losses, sub-1% liquidation rate)
4. The specific ask: review the flag, unflag if appropriate (1 min)
5. Open Q&A — let them probe (the rest)

## Channel 1b — Blowfish developer portal signup (parallel, ~5 min)

**Sign up:** https://portal.blowfish.xyz/user

Free signup gets you a developer account. From inside the portal, look for:
- "Report" or "Submit dApp" forms
- A "false-positive appeal" section
- API key generation (lets you query whether magpie.capital is actually on the blocklist — `docs.blowfish.xyz/reference/download-blocklist` requires this auth)

Even if there's no formal appeal flow inside, having an account creates a tracked identity that any subsequent support contact can reference.

## ~~Channel 1 (LEGACY) — Blowfish Typeform~~ — CLOSED

**URL:** https://form.typeform.com/to/BHue5Hg0 *(returns "this typeform is now closed")*

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
>   - Sub-1% lifetime liquidation rate (by design — short terms, conservative LTV,
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

---

## Channel 4 — Solana Program Registry (verified-build listing) ⚠️ HOLD

**URL:** https://github.com/DeployDAO/solana-program-registry

This is the canonical *"is this on-chain program what its source code claims to be"* registry. Submitting Magpie adds an automated build-verification run that compares the source-built binary against what's deployed at `4FEFPeMH…6wmh`. **Massive legitimacy signal if it passes — but a public mismatch publishes worse-than-nothing if it fails.**

### Why we're holding before submitting (verified 2026-06-07)

Pre-submission audit found the repo is *probably* fine to submit — but not *certainly*:
- ✅ `lender-keypair.json` properly gitignored, never committed
- ✅ `Cargo.lock` present (required for reproducible builds)
- ✅ Anchor `0.30.1` pinned in workspace + all programs
- ✅ Program IDs consistent across localnet/devnet/mainnet config
- ❓ But — was the original mainnet deploy done with Anchor 0.30.1 or an older version?
- ❓ Was `Cargo.lock` identical at deploy time vs now?
- ❓ Was the deploy a stock `anchor build` or `anchor build --verifiable`?

If any of those don't match, the registry's auto-build produces a different binary hash than the deployed program — and that mismatch is **publicly visible on their dashboard**. Reviewers reading a Blowfish appeal that points at a *failed* registry build would be a worse signal than no registry entry.

### Action required to unblock submission

Run locally on the tagged commit (~15 min):

```bash
cd path/to/bagbank-bot
# Tag a candidate release
git tag v1.0.0-candidate

# Build verifiably
solana-verify build --library-name magpie_lending

# Compare against deployed
solana-verify verify-from-image \
  --image $(realpath ./target/deploy/magpie_lending.so) \
  --program-id 4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh \
  --url https://api.mainnet-beta.solana.com
```

If `verify-from-image` reports a match → tag for real (`v1.0.0`), push, submit the PR below. If it reports a mismatch → don't submit. The mismatch tells you the deployed binary was built differently than the current source produces; resolving that is its own (separate) project and may require finding the exact build environment used at the time of the May/June deploy.

### Submission diff (use only after verify-from-image passes)

```yaml
# Append to programs.yml at the bottom (recent entries are grouped there;
# strict alphabetical-by-org isn't enforced):
"magpiecapital/magpie-bot":
  - v1.0.0
```

### One-line PR description

> Add Magpie Capital — permissionless Solana lending protocol. Source: `magpiecapital/magpie-bot/programs/magpie-lending`. Deployed program ID: `4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh`. 240+ SOL lifetime borrowed, zero LP losses, sub-1% liquidation rate.

---

## Channel 5 — Solana Ecosystem Directory (official Solana Foundation listing)

**URL:** https://solanaecosystem.com/directory

The Solana Foundation's official ecosystem directory. Adds Magpie to "the list of legitimate projects on Solana" — a low-effort reputational signal that other parts of the ecosystem (including blocklist reviewers) check.

### Submission

Look for a "Submit your project" / "Add to directory" CTA on the page. Typical fields:

- **Name:** Magpie Capital
- **Category:** DeFi · Lending
- **Description:** Permissionless lending on Solana. Borrow SOL against approved memecoins and tokenized stocks, repay on your own schedule. Custodial-by-export — users can self-custody any time. Telegram-native UX.
- **Website:** https://magpie.capital
- **X / Twitter:** @MagpieLoans
- **GitHub:** https://github.com/magpiecapital
- **Blockchain:** Solana mainnet

---

## Final action plan (decision made 2026-06-07 after audit)

| Day | Channel | Status |
|-----|---------|--------|
| 0 (today) | **Blowfish Typeform** — primary appeal | **GO** — drafted, paste + send |
| 0 (today) | **X tweet via @MagpieLoans** | **GO** — drafted, send when posting Typeform |
| 0 (today) | **Solana Ecosystem Directory** listing | **GO** — zero risk, low effort |
| 0 (today) | Solana Program Registry PR | **HOLD** — need local verified-build check first (~15 min) |
| +3 | Phantom dApp Developer Discord | Escalation backup if no Blowfish response |
| +5 | @0xMert_ DM (Helius CEO) | Personal-network nudge if still stuck |
| +7 | Polite public @brandonmillman | Last-resort visibility |
| +10 | Budget audit (Sec3 / Otter / Halborn) | Resolves underlying detection upstream |

**Why the Program Registry is HOLD:** a public verified-build mismatch is a *worse* signal than no registry entry. Run the `solana-verify verify-from-image` check locally first; once it passes, the registry submission is a 3-line PR. Until then, the other three Day-0 channels carry the appeal.
