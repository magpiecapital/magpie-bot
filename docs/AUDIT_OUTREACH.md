# Audit Firm Outreach — Draft Templates

Two ready-to-send email drafts for the two top Solana audit firms.
Send these from your magpie capital email. Replace the bracketed bits.

---

## Email 1 — OtterSec

**To:** contact@osec.io  
**Subject:** Audit inquiry — Magpie Capital (Solana memecoin lending protocol)

Hi OtterSec team,

We're reaching out to get a quote on a security audit for **Magpie Capital**, a permissionless lending protocol on Solana mainnet. We're focused on memecoin-collateral loans (a niche underserved by existing lenders) and have been live with real TVL for several weeks.

**Protocol summary:**
- Anchor 0.32.0 program, Rust, ~[N] lines of program code
- Token-2022 + classic SPL support via TokenInterface
- Single lender model (no peer-to-peer matching) with share-based LP yield
- Three loan tiers (Express 30%/2d, Quick 25%/3d, Standard 20%/7d)
- Keeper-based liquidation for past-due loans
- On-chain credit score oracle (300-850)
- $MAGPIE holder rewards distributed automatically (10% of all loan fees)

**Repo:** [GitHub repo URL — share when ready, can be private with NDA]  
**Program ID:** [your mainnet program ID]  
**Current TVL / volume:** [N SOL / N loans issued]

**What we'd want covered:**
- Loan request/fund flow + LP share accounting
- Liquidation path and keeper authorization
- Fee distribution math (80% LPs / 10% holders / 5% referrers / 2% LP loyalty / 3% protocol)
- Authority handling (lender keypair, pool init)
- Token-2022 quirks (transfer hooks, etc.)
- Price oracle attestation + freshness checks

**Timeline:** Looking to kick off in the next 2-4 weeks if scope and pricing align.

Can you share availability + a rough quote range? Happy to do an intro call.

Thanks,  
[Your name / handle — [redacted-dev] or similar]  
Magpie Capital  
magpie.capital

---

## Email 2 — Halborn

**To:** info@halborn.com  
**Subject:** Audit inquiry — Magpie Capital (Solana lending protocol)

Hi Halborn,

Reaching out for an audit quote on a Solana lending protocol we've been
running on mainnet.

**Magpie Capital** is a permissionless memecoin-collateral lender — short
terms, low LTV, with a "0 liquidations ever, by design" track record.
Telegram-native UX (chat bot) plus a Next.js dashboard at magpie.capital.

**Stack:**
- Anchor 0.32.0 / Rust program (~[N] LoC)
- Solana mainnet, Helius RPC
- Token-2022 + legacy SPL via TokenInterface
- Off-chain reward accounting + on-chain payouts

**Scope ask:**
- Full program review (borrow/repay/extend/liquidate/topup paths)
- LP share-accounting correctness
- Fee distribution math
- Oracle freshness + price attestation
- Authority + access control
- Token-2022 edge cases

**Status:** Live on mainnet with real users, no incidents to date but
we're hitting the scale where an audit is mandatory before bigger LP flow.

**Timeline:** 2-4 week kickoff, flexible.

Could you share availability and rough pricing? Open to a call to walk
through scope.

Thanks,  
[Your name / handle]  
Magpie Capital · magpie.capital

---

## Also worth filing (no upfront cost)

### Immunefi bug bounty program

- URL: https://immunefi.com/bug-bounty/start/
- Self-serve setup
- Recommended structure for a protocol your size:
  - Critical: $10k-50k (fund-loss exploits)
  - High: $2k-5k (logic bugs that don't drain funds)
  - Medium: $500-1k (DoS, censorship)
  - Low: $100-250 (informational)
- Tie payouts to current TVL — Immunefi will help right-size
- Listing on Immunefi is itself a credibility signal even before any reports

### Sec3 (formerly Soteria)

Also strong on Solana audits, often slightly cheaper:
- Email: contact@sec3.dev
- Use same template as OtterSec above
