# Magpie · Strategy / Outside-the-box Ideas

Draft menu of unique angles the protocol could pursue. Organized by what
I can ship autonomously vs. what needs operator approval / a v3 program.
Each entry: the idea, the user/protocol value, the trade-off, and a
build-effort estimate.

> **Status:** Brainstorm. Nothing here is committed. Operator picks
> what's worth pursuing.

---

## Tier 1 — Autonomous-safe (I can ship without explicit approval)

These don't touch funds, don't change loan mechanics, don't require an
on-chain redeploy. Pure code/UX additions, fully reversible.

### 1A · "Pip-as-coach" advisory in `/positions`
When a user runs `/positions` in the wallet bot, Pip appends a 1-line
suggestion if it sees a clear optimization:
- *"Your $WIF loan is at 1.13 health — consider /topup for a buffer."*
- *"You have 4.2 idle SOL — /lend earns ~X% APR pro-rata."*
- *"Loan due in 14h — /extend or /repay before liquidation kicks in."*

**Value:** Active advisor energy without nag fatigue. Increases
healthy-loan rate.
**Trade-off:** Risk of suggesting something stale if the data lag is bad.
**Build:** ~1 day.

### 1B · "Loan stories" — anonymized success-story rotation on landing page
Every 5 minutes, swap a small testimonial-style stat: *"User repaid 2.3
SOL on $TROLL after 4-day Standard loan. Credit score +12."* All from
DB, no names, no wallets.

**Value:** Strong social proof. Quantitative + recent.
**Trade-off:** Anonymized but if a user does a single distinctive trade,
it could be traced. Mitigate with ranges ("1–3 SOL repaid") + delay
(>1h after the actual tx).
**Build:** ~1 day site-side.

### 1C · Keeper leaderboard
Public board on /earn#keeper showing top liquidators by 30d SOL
rewards. Game theory: more keepers compete → tighter liquidation
response → safer protocol.

**Value:** Bootstraps the keeper network.
**Trade-off:** Doxxes top keeper wallets (publicly identifiable).
Most keepers won't care.
**Build:** ~0.5 day.

### 1D · "Trust ladder" — first-loan tutorial mode
Brand-new users get a guided first loan: dust amount ($0.50 cap), all
fees waived (operator absorbs), Pip walks them through every step.
Removes the "I don't want to lose money learning the UX" barrier.

**Value:** Funnel-top conversion. Removes the biggest objection.
**Trade-off:** Operator eats a small fee for new users. Cap total
giveaway via env var (e.g., 0.1 SOL/month).
**Build:** ~2 days. Pure off-chain (subsidize from a separate operator
wallet → user's wallet).

### 1E · "Health calendar" widget on dashboard
Calendar view of upcoming loan due dates + projected health at due
time (assuming current token prices). Users see "next 14 days" at a
glance.

**Value:** Reduces missed-deadline liquidations.
**Build:** ~1 day, reuses existing /positions data.

### 1F · Pip-on-X — auto-reply to mentions of @MagpieLoans
Pip monitors X for @MagpieLoans mentions and (optionally) auto-replies
with helpful info. *(Requires X API — same access as the
cross-poster.)*

**Value:** Customer support velocity outside TG.
**Trade-off:** X bots can be a bad look. Could be operator-DM-only
("notify me when someone tags us, draft a reply") to keep human
in-the-loop.
**Build:** ~2 days. Reuses the X API plumbing from /crosspost.

---

## Tier 2 — Operator approval, no on-chain change

These need a "go" but don't require redeploying the program. Pure
backend/operations.

### 2A · "Boomerang" fee rebate for fast repayment
If you repay within 50% of the term, you get a 25% fee rebate (paid
post-hoc from the protocol's 3% slice). Encourages capital velocity →
LPs see higher turnover → higher realized APR.

**Value:** Better LP economics. Differentiated UX.
**Trade-off:** Reduces protocol-side revenue ~5–10% (small slice
of small slice). Worth it if velocity uplift > 15%.
**Build:** ~3 days. Rebate runs nightly from a separate operator
wallet → borrower's wallet.

### 2B · "Insurance" opt-in add-on
At loan time, user can pay an extra 0.5% to enroll in an insurance
pool. If their collateral token *rugs* (loses ≥80% in <24h, before
liquidation can run), the pool pays out the borrower's principal.

**Value:** Sells a real fear (memecoin volatility) → drives more
borrows from cautious users.
**Trade-off:** Capital required to seed the pool. Define rug-trigger
precisely so it's not abusable.
**Build:** ~1 week. Off-chain rules engine + payouts from a
dedicated insurance treasury.

### 2C · Pip-curated token approvals with community vote
Token submissions via /submit hit Pip's auto-checks (liq, vol, dev
age, holder distribution). Passing tokens go into a 48h vote where 1
vote = 1k $MAGPIE held. Quorum + threshold trigger auto-approval.

**Value:** Decentralizes token curation. Strong $MAGPIE utility.
**Trade-off:** Whale capture risk; mitigate with quadratic voting
or cap (max 5% voting share per wallet).
**Build:** ~1 week. Off-chain governance + operator-applies-result.

### 2D · Per-token dynamic fees ("AI rates")
Pip analyzes each token nightly (volatility, demand, liquidity) and
sets a per-token fee multiplier (e.g., 0.85x–1.4x base). Volatile
tokens cost more, stable ones less. Transparent: published as a daily
post + on the /tokens page.

**Value:** Better risk-adjusted pricing. LPs win on volatile collateral,
borrowers save on stable collateral.
**Trade-off:** Adds complexity. Some users won't like dynamic pricing.
**Build:** ~1 week.

### 2E · "Rescuer mode" — designated friend can top up your collateral
User opts a second wallet as their *rescuer*. If health drops below
1.12×, Pip DMs the rescuer's TG and offers a one-tap top-up from
their own funds. They get rights to a small SOL bonus if they save
the loan.

**Value:** Cuts liquidations. Creates an in-group "I saved my friend
from getting liqed" story.
**Trade-off:** Off-chain delegation logic; rescuer needs to have funds.
**Build:** ~1 week.

---

## Tier 3 — Requires v3 program (on-chain changes)

These need a parallel program deployment per the no-redeploy rule. Big
strategic moves. Not autonomous.

### 3A · **Graduated liquidation** ("Mercy hours")
Today: binary liquidation at health <1.1×.
Proposed:
- 1.15× → green
- 1.10× → yellow (12h grace if user takes action: topup/repay/extend)
- 1.05× → red (3h grace, then *partial* liquidation — sell just enough
  to restore health to 1.20×, keep the rest of collateral with the user)

**Value:** Biggest UX differentiator in the space. "We liquidate
gracefully" is a story almost no protocol can tell.
**Trade-off:** More complex on-chain logic. Keepers need new
liquidation paths. LP risk slightly higher in flash crashes (mercy
windows could miss fast moves) — bound this with a hard 1.02× kill
switch.
**Effort:** v3 program + audit. Multi-week.

### 3B · **No-collateral trust line** (DeFi credit card)
After repaying N loans (e.g., 5+) with zero liquidations, your credit
score unlocks an UNCOLLATERALIZED line — borrow up to N SOL,
repayable in 24h, at higher fee (10%). Effectively a DeFi credit card.

**Value:** First-of-its-kind in DeFi at retail scale. Massive PR.
**Trade-off:** Pure credit risk for the LP pool. Bound with hard
caps (max 0.5 SOL per user, max 5 SOL outstanding total). Insurance
fund absorbs defaults. Could be a separate program/pool entirely.
**Effort:** v3 program + insurance treasury + audit. Multi-week.

### 3C · **Tranched LP pool** (junior/senior)
Two LP pools: junior absorbs losses first (higher APR), senior is
safer (lower APR). LPs choose risk appetite.

**Value:** Capital efficiency. Attracts both yield-chasers and
conservative LPs.
**Trade-off:** Splits liquidity. More complex.
**Effort:** v3 program. Multi-week.

### 3D · **Loan NFTs / secondary market**
Each active loan is a mintable NFT representing the position. Owner
can sell the position on a marketplace. Buyer takes on the repayment
obligation in exchange for the collateral upside.

**Value:** Liquidity for stuck borrowers. Speculation market.
**Trade-off:** Heavy lift on-chain. Edge cases (who pays the fee,
what if the buyer is a sanctioned wallet, etc.).
**Effort:** v3 + new marketplace contract. Multi-week.

### 3E · **Cross-margin** between a user's loans
A user with 3 loans is treated as a single position — collateral and
debt netted across all loans. One token tanking but others rising →
no liquidation.

**Value:** Mirrors TradFi futures risk management. Rare in DeFi.
**Trade-off:** Complex on-chain accounting; harder to keeper.
**Effort:** v3 program. Multi-week.

### 3F · **Loan pooling** (co-borrowing)
3 friends each have 10% of a token. They co-deposit and split a
single loan with smart-contract logic dividing proceeds and
repayment obligations.

**Value:** Unlocks group-of-friends use case.
**Trade-off:** Coordination + on-chain split logic. Edge cases.
**Effort:** v3 program. Multi-week.

### 3G · **Liquidation Dutch auctions**
Instead of dumping liquidated collateral on a DEX (slippage hurts
LPs), run a 15-min Dutch auction. Anyone in the community can buy.
Lower slippage → better LP returns.

**Value:** Solend-pioneered angle. Magpie could do it better with
TG-native auction UX (1-tap bid from chat).
**Trade-off:** Slower liquidation = LP risk during the auction window
if price keeps dropping. Bound with a hard floor.
**Effort:** v3 program + bidder UI. Multi-week.

---

## Tier 4 — Bigger product bets

These would meaningfully change what Magpie *is*. Stand-alone roadmap
items, multi-month.

### 4A · "Magpie Vault" — earn yield without becoming an LP
Users deposit SOL into managed vaults that Magpie's keepers
auto-strategize across protocols. Magpie takes a perf fee. Aave-style
vaults but Solana-native + TG-native.

### 4B · Magpie for stablecoin pairs
Borrow USDC against SOL (and other blue chips). Different risk
profile, different audience. Could be a parallel sub-protocol.

### 4C · Loan-as-payments rail
Pay merchants in SOL backed by your token bag. The merchant gets
paid; the borrower's loan exists transparently. Treats Magpie as
infrastructure, not just a product.

### 4D · Social-graph-backed lending
After credit score, the next reputation layer: which OTHER users have
co-signed for you, and how those have performed. Sybil-resistant trust
networks.

---

## Recommendation for next 30 days

**Pick 2 from Tier 1 to ship now** (low risk, high learning):
- **1A — Pip-as-coach in /positions** (deep user value, removes friction)
- **1D — First-loan tutorial mode** (top-of-funnel; biggest conversion lift)

**Pick 1 from Tier 2 to scope** (operator approval needed):
- **2A — Boomerang fee rebate** (cheap, headline-grabbing, no on-chain change)

**Plan 1 from Tier 3 for the v3 program**:
- **3A — Graduated liquidation** would be Magpie's *defining differentiator*. "We don't kick you when you're down" is a story almost no protocol can tell.
