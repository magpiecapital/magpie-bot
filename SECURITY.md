# Security Policy

Magpie Capital is a lending protocol on Solana. We take the security of the
protocol and its users seriously. This document explains how to report a
vulnerability and the current status of our independent security review.

## Reporting a vulnerability

If you believe you have found a security vulnerability in any Magpie Capital
repository, program, or service, please report it privately. **Do not open a
public issue, pull request, or disclosure for a suspected vulnerability.**

- Preferred: open a private report via the **Security** tab of the affected
  repository ("Report a vulnerability" — GitHub private vulnerability reporting).
- Alternatively, use the contact path at **https://magpie.capital/security**.

Please include:

- a description of the issue and its potential impact,
- step-by-step reproduction details or a proof of concept,
- the affected component, program ID, transaction signatures, or addresses
  where relevant.

We aim to acknowledge new reports within **24 hours** and will keep you updated
as we investigate. We support coordinated, responsible disclosure and ask that
you give us a reasonable opportunity to remediate before any public disclosure.
We will not pursue or support legal action against good-faith security research
conducted in line with this policy.

## Audits

**Sec3's security assessment of V4 is COMPLETE.** The final report was delivered
**2026-08-09** against audited commit `33ebdc5`: **24 findings — 20 resolved, 4
acknowledged** (accepted with documented rationale), and **none left open**.
**Both High-severity findings are resolved.**

**Read this carefully:** the remediated build deploys at a **new program ID**
once signed off, so the audited code is **not the live program yet**. We say
*"V4's security assessment is complete"* — we do **not** say Magpie is
"audited", and we won't until the audited build is the one you are borrowing
against. An audit reduces risk; it does not eliminate it.

Full summary and the report itself: https://github.com/magpiecapital/audits

| Firm | Engagement status |
| --- | --- |
| **Sec3** | **V4 assessment COMPLETE — final report 2026-08-09 · 20 resolved · 4 acknowledged · 0 open.** V3 + credit-oracle next. |
| **Hashlock** | Read-only repository access granted; engagement not yet started. |
| **QuillAudits** | Read-only repository access granted; engagement not yet started. |
| **OtterSec**, **Neodyme** | Contacted; no engagement and no repository access at this time. |

The audit-target program, `magpiecapital/magpie-v4`, is kept **private** during
pre-audit review, and every engaged firm is granted **read-only** access. The
table reflects verified repository access — we would rather understate an
engagement than imply a review that is not happening.

Completed reports will be published at:
**https://github.com/magpiecapital/audits**

## Scope

This policy applies to Magpie Capital's public repositories
(`magpie-bot`, `magpie-site`, `magpie-x402`) and to the protocol's on-chain
lending programs. The on-chain program is the final authority on protocol
behavior; off-chain services defer to it.

---

_This policy is maintained as a single source of truth and updated across all
Magpie surfaces together. Status: Sec3 V4 assessment COMPLETE (final report 2026-08-09) · audited build not yet live · firms engaged for
review · report shared when complete._
