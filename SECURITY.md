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

## Audits in progress

Magpie's smart-contract audit process is **actively underway**. Independent
security firms have been **engaged to review** the protocol's on-chain programs;
**reports will be published when complete**. The protocol is **not yet audited** —
please do not treat the absence of a published report as a completed review.

| Firm | Engagement status |
| --- | --- |
| **Sec3** | Repository access granted; review underway (formal scope being finalized). |
| **Hashlock** | Repository access accepted; review underway. |
| **QuillAudits** | Repository access accepted; review underway. |
| **OtterSec** | Invited to audit; awaiting response. |
| **Neodyme** | Invited to audit; awaiting response. |

The audit-target program, `magpiecapital/magpie-v4`, is kept **private** during
pre-audit review, and every engaged firm is granted **read-only** access.

Completed reports will be published at:
**https://github.com/magpiecapital/audits**

## Scope

This policy applies to Magpie Capital's public repositories
(`magpie-bot`, `magpie-site`, `magpie-x402`) and to the protocol's on-chain
lending programs. The on-chain program is the final authority on protocol
behavior; off-chain services defer to it.

---

_This policy is maintained as a single source of truth and updated across all
Magpie surfaces together. Status: audit process underway · firms engaged for
review · report shared when complete._
