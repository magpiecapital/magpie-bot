/**
 * Security-alert DMs for site-initiated actions.
 *
 * When a signed action fires through the HTTP API (withdraw,
 * set-active, delete-ticket, etc.), we DM the user via Telegram with
 * an audit line they can react to. The goal: if someone phishes a
 * user's Phantom seed and starts taking actions on the site, the user
 * gets an immediate notification on a DIFFERENT surface (TG) so they
 * can lock down before more damage is done.
 *
 * The bot reference is set once at startup via setSecurityAlertBot().
 * If unset (e.g. tests, scripts), alerts are silently skipped — they
 * are defense-in-depth, not a hard dependency.
 *
 * Notifications IGNORE user prefs deliberately: these are security
 * events, not marketing. A user who turned off notify_deposits still
 * gets a withdraw alert.
 */
import { query } from "../db/pool.js";

let botRef = null;

export function setSecurityAlertBot(bot) {
  botRef = bot;
}

function shortAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

async function lookupTelegramId(userId) {
  try {
    const { rows: [u] } = await query(
      `SELECT telegram_id FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    return u?.telegram_id ?? null;
  } catch (err) {
    console.warn("[security-alerts] tg lookup failed:", err.message);
    return null;
  }
}

// Inline keyboard with one-tap lock buttons. Each callback_data carries
// the lock duration (or "0" to clear). Handled in commands/lock.js via
// registerLockCallbacks(bot).
function lockKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔒 Lock 24h", callback_data: "sec:lock:24" },
        { text: "🔒 Lock 7d", callback_data: "sec:lock:168" },
      ],
      [
        { text: "Status", callback_data: "sec:lock:status" },
      ],
    ],
  };
}

async function dm(telegramId, lines, { withLockButtons = false } = {}) {
  if (!botRef || !telegramId) return;
  try {
    await botRef.api.sendMessage(Number(telegramId), lines.join("\n"), {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: withLockButtons ? lockKeyboard() : undefined,
    });
  } catch (err) {
    // Blocked / deactivated / chat-not-found are normal — don't spam logs.
    if (!/blocked|deactivated|chat not found|user is deactivated/i.test(err.message || "")) {
      console.warn("[security-alerts] dm failed:", err.message);
    }
  }
}

export async function alertWithdraw({ userId, asset, displayAmount, destination, txSig }) {
  const tgId = await lookupTelegramId(userId);
  if (!tgId) return;
  const lines = [
    `🛡 *Site withdraw confirmed*`,
    "",
    `Amount: \`${displayAmount} ${asset === "SOL" ? "SOL" : shortAddr(asset)}\``,
    `To: \`${shortAddr(destination)}\``,
    txSig ? `Tx: [view on Solscan](https://solscan.io/tx/${txSig})` : "",
    "",
    "_If this wasn't you, tap a button below to freeze site actions immediately, then move funds to a fresh wallet._",
  ].filter(Boolean);
  await dm(tgId, lines, { withLockButtons: true });
}

export async function alertSetActiveWallet({ userId, newActivePubkey }) {
  const tgId = await lookupTelegramId(userId);
  if (!tgId) return;
  const lines = [
    `⚙️ *Active wallet changed via site*`,
    "",
    `New active: \`${shortAddr(newActivePubkey)}\``,
    "",
    "_If this wasn't you, tap a button below to freeze site actions, then check /wallets._",
  ];
  await dm(tgId, lines, { withLockButtons: true });
}

export async function alertTicketDeleted({ userId, ticketId }) {
  const tgId = await lookupTelegramId(userId);
  if (!tgId) return;
  const lines = [
    `🗑 *Support ticket deleted via site*`,
    "",
    `Ticket #${ticketId}`,
    "",
    "_If this wasn't you, tap a button below — your Phantom signature may have been used by someone else._",
  ];
  await dm(tgId, lines, { withLockButtons: true });
}

export async function alertPrefChanged({ userId, key, value }) {
  // Only alert on auto_protect changes — the other prefs are notification
  // toggles, not safety controls. Spamming a DM for every toggle would
  // train users to ignore these alerts.
  if (key !== "auto_protect") return;
  const tgId = await lookupTelegramId(userId);
  if (!tgId) return;
  const lines = [
    `⚙️ *Auto-Protect ${value ? "enabled" : "DISABLED"} via site*`,
    "",
    value
      ? "_Auto-Protect will now auto-pay-down loans at risk of liquidation._"
      : "_Auto-Protect is now off. If this wasn't you, tap a button below and re-enable via /autoprotect once you've rotated keys._",
  ];
  await dm(tgId, lines, { withLockButtons: !value });
}
