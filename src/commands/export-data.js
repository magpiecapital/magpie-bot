/**
 * /exportdata — sends the user a JSON file dump of their account.
 *
 * Mirrors the site's "Download my data" button (POST /api/v1/me/export)
 * but accessible from TG without needing a linked Phantom. Useful for
 * users who never connected the site, or who want a quick local copy.
 *
 * The JSON shape matches the site export so anyone diffing the two
 * sees the same content. Wallet secrets are NEVER included — only
 * public addresses + encrypted columns omitted.
 */
import { InputFile } from "grammy";
import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";
import { getPrefs } from "../services/prefs.js";

export async function handleExportData(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  // Best-effort progress note since the dump can take a second or two.
  let progressMsgId = null;
  try {
    const m = await ctx.reply("📦 Building your data export…");
    progressMsgId = m.message_id;
  } catch { /* non-critical */ }

  const [
    { rows: wallets },
    { rows: loans },
    { rows: tickets },
    { rows: withdraws },
    { rows: refs },
    { rows: holder },
    { rows: lp },
    { rows: apActions },
    { rows: lockEvents },
    prefs,
  ] = await Promise.all([
    query(
      `SELECT id, public_key, source, is_active, created_at
         FROM wallets WHERE user_id = $1 ORDER BY created_at ASC`,
      [user.id],
    ),
    query(
      `SELECT id, loan_id, loan_pda, collateral_mint, collateral_amount,
              loan_amount_lamports, original_loan_amount_lamports,
              ltv_percentage, duration_days, start_timestamp, due_timestamp,
              status, tx_signature, updated_at
         FROM loans WHERE user_id = $1 ORDER BY start_timestamp ASC`,
      [user.id],
    ),
    query(
      `SELECT id, message, status, admin_reply, admin_replied_at,
              auto_resolved_at, last_user_followup_at, followup_count,
              closed_at, created_at
         FROM support_tickets WHERE user_id = $1 ORDER BY created_at ASC`,
      [user.id],
    ),
    query(
      `SELECT id, signer_pubkey, from_pubkey, to_pubkey, asset,
              raw_amount::text AS raw_amount, decimals, tx_signature,
              status, error_text, created_at
         FROM site_withdrawals WHERE user_id = $1 ORDER BY created_at ASC`,
      [user.id],
    ),
    query(
      `SELECT id, referee_user_id, loan_db_id, event_type,
              fee_lamports::text AS fee_lamports,
              reward_lamports::text AS reward_lamports,
              reward_bps, status, paid_tx_signature, created_at
         FROM referral_earnings WHERE referrer_user_id = $1 ORDER BY created_at ASC`,
      [user.id],
    ),
    query(
      `SELECT mhr.id, mhr.wallet_address, mhr.reward_lamports::text AS reward_lamports,
              mhr.status, mhr.paid_tx_signature, mhr.created_at
         FROM magpie_holder_rewards mhr
         JOIN wallets w ON w.public_key = mhr.wallet_address
        WHERE w.user_id = $1
        ORDER BY mhr.created_at ASC`,
      [user.id],
    ),
    query(
      `SELECT llr.id, llr.wallet_address, llr.reward_lamports::text AS reward_lamports,
              llr.status, llr.paid_tx_signature, llr.created_at
         FROM lp_loyalty_rewards llr
         JOIN wallets w ON w.public_key = llr.wallet_address
        WHERE w.user_id = $1
        ORDER BY llr.created_at ASC`,
      [user.id],
    ),
    query(
      `SELECT id, loan_id, action_type, amount_lamports::text AS amount_lamports,
              health_before, health_after, signature, error, created_at
         FROM auto_protect_actions WHERE user_id = $1 ORDER BY created_at ASC`,
      [user.id],
    ),
    query(
      `SELECT id, action, hours, set_by, reason, created_at
         FROM site_lock_events WHERE user_id = $1 ORDER BY created_at ASC`,
      [user.id],
    ),
    getPrefs(user.id),
  ]);

  const dump = {
    generated_at: new Date().toISOString(),
    schema_version: "me/export/v1",
    account: {
      telegram_username: tgUser.username ? `@${tgUser.username}` : null,
    },
    wallets,
    loans,
    support_tickets: tickets,
    site_withdrawals: withdraws,
    referral_earnings: refs,
    holder_rewards: holder,
    lp_loyalty_rewards: lp,
    auto_protect_actions: apActions,
    site_lock_events: lockEvents,
    prefs,
    _notes: [
      "This export contains every piece of personal data Magpie holds for your account.",
      "Wallet secrets are NEVER included — only public addresses.",
      "Telegram ID is intentionally omitted to reduce identifiability of the dump file.",
    ],
  };

  // Build a buffer and send as a document attachment.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `magpie-export-${stamp}.json`;
  const buf = Buffer.from(JSON.stringify(dump, null, 2), "utf-8");

  try {
    await ctx.replyWithDocument(new InputFile(buf, filename), {
      caption:
        "Your full Magpie data export. No private keys are included — just public addresses + activity history.",
    });
  } catch (err) {
    console.error("[exportdata] send failed:", err.message);
    await ctx.reply(`❌ Couldn't send the file: ${err.message?.slice(0, 100)}`);
    return;
  }

  if (progressMsgId) {
    try { await ctx.api.deleteMessage(ctx.chat.id, progressMsgId); } catch {}
  }
}
