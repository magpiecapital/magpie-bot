/**
 * Site-facing support endpoints.
 *
 *   GET /api/v1/support/tickets?wallet=<pubkey>
 *     Returns the linked user's recent tickets — open + awaiting + recently
 *     closed. Same shape as /mytickets in the bot, just enriched with
 *     timestamps so the site can sort/age them client-side.
 *
 * Lookup is by wallet → user_id via the `wallets` table. If the wallet
 * isn't linked, we return an empty list rather than an error so the
 * dashboard can render a "link your account to see tickets" prompt
 * gracefully.
 *
 * No PII beyond what's already exposed by /api/v1/loans is returned.
 * No auth gate at the HTTP layer — anyone with a wallet address could
 * query, but the result set is bound to that specific wallet's linked
 * user (and the messages are the user's own messages back to themselves
 * via the site). Same risk envelope as /loans.
 */
import { query } from "../db/pool.js";

function isValidPubkey(pubkey) {
  if (typeof pubkey !== "string") return false;
  if (pubkey.length < 32 || pubkey.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(pubkey);
}

export async function handleSupportTickets(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!isValidPubkey(wallet)) {
    return { status: 400, body: { error: "Invalid wallet pubkey" } };
  }

  const { rows: [u] } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [wallet],
  );
  if (!u) {
    return { status: 200, body: { linked: false, tickets: [] } };
  }

  const { rows } = await query(
    `SELECT id, message, status, admin_reply, admin_replied_at,
            auto_resolved_at, last_user_followup_at, followup_count,
            closed_at, created_at
       FROM support_tickets
      WHERE user_id = $1
      ORDER BY status = 'closed' ASC, created_at DESC
      LIMIT 20`,
    [u.user_id],
  );

  return {
    status: 200,
    body: {
      linked: true,
      tickets: rows.map((r) => ({
        id: r.id,
        message: r.message,
        status: r.status,
        admin_reply: r.admin_reply,
        admin_replied_at: r.admin_replied_at,
        auto_resolved_at: r.auto_resolved_at,
        last_user_followup_at: r.last_user_followup_at,
        followup_count: r.followup_count ?? 0,
        closed_at: r.closed_at,
        created_at: r.created_at,
      })),
    },
  };
}
