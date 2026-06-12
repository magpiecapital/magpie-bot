/**
 * Slippage ceilings — single source of truth.
 *
 * Security audit F-5 (2026-06-12, LOW severity) flagged that slippage
 * constants were scattered across three places (agent-delegations.js
 * capped at 1000, internal-agent-limitclose.js capped at 2500,
 * migration 026 CHECK at 10–1000). Same code-smell as any "magic
 * number in multiple places" — easy to drift, hard to spot drift.
 *
 * The two values are INTENTIONALLY different. They model different
 * layers of consent, not the same boundary:
 *
 * MAX_AGENT_DELEGATION_BPS (1000 = 10%)
 *   The maximum slippage a USER can authorize a delegated x402 agent
 *   to use on their behalf via /agent_authorize. Users picking a
 *   conservative ceiling is normal — most won't want their agent
 *   eating 25% slippage on their position even during a fill-guarantee
 *   escalation. 10% caps the worst-case the agent can ever spend
 *   without the user re-authorizing.
 *
 *   Mirrored in the DB by:
 *     migrations/026_agent_delegations.sql
 *     CHECK (max_slippage_bps >= 10 AND max_slippage_bps <= 1000)
 *
 * MAX_PROTOCOL_SLIPPAGE_BPS (2500 = 25%)
 *   The absolute ceiling the protocol's engine will walk up to during
 *   auto-escalation (Layer A of the fill-guarantee ladder). This is
 *   the PROTOCOL'S worst-case spend during an aggressive moon-pump
 *   fill, not the user's. Limit-close-arm-core also uses this as the
 *   max INITIAL slippage a user can pre-set on a limit-close order.
 *
 * The hierarchy is:
 *   effective_slippage = min(
 *     user-requested,                      // arm-time choice
 *     delegation.max_slippage_bps,         // agent path: user-set ceiling
 *     MAX_PROTOCOL_SLIPPAGE_BPS,           // absolute floor
 *   )
 *
 * If you find yourself wanting to "fix" the difference by raising
 * MAX_AGENT_DELEGATION_BPS to match MAX_PROTOCOL_SLIPPAGE_BPS — DON'T.
 * That's removing the user's consent layer, which is the whole point
 * of agent delegations. The right path is to let users opt in to a
 * higher delegation cap (raise to 2500 bps) via an explicit
 * /agent_authorize_aggressive command that includes a risk warning,
 * not to silently widen everyone's exposure.
 */

// Per-user consent cap on agent-delegated limit-close slippage.
// Mirror in DB: migrations/026_agent_delegations.sql CHECK constraint.
export const MAX_AGENT_DELEGATION_BPS = 1000; // 10%

// Per-user consent floor (anything below this is too tight to clear most
// fills and is more likely a typo than intent).
export const MIN_AGENT_DELEGATION_BPS = 10; // 0.1%

// Protocol-absolute ceiling on engine slippage. Also the max INITIAL
// slippage a user can pre-set on a limit-close order (TG, site, agent).
export const MAX_PROTOCOL_SLIPPAGE_BPS = 2500; // 25%
