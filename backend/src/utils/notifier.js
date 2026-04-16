/**
 * Thin Telegram notifier for the liquidation backend.
 *
 * We don't need grammY's full runtime here — just `sendMessage`. Using axios
 * directly avoids starting a bot long-poll loop from the backend process.
 *
 * Lookups map a borrower's Solana pubkey → telegram_id via the wallets table.
 */
import axios from "axios";
import pg from "pg";
import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  : null;

export async function telegramIdForBorrower(borrowerPubkey) {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT u.telegram_id
       FROM wallets w JOIN users u ON u.id = w.user_id
       WHERE w.public_key = $1`,
      [borrowerPubkey],
    );
    return rows[0]?.telegram_id ?? null;
  } catch (err) {
    console.error("[notifier] DB lookup failed:", err.message);
    return null;
  }
}

/**
 * Lookup user id + whether they want to be notified about liquidations.
 */
export async function userContextForBorrower(borrowerPubkey) {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.telegram_id,
              COALESCE(p.notify_liquidations, TRUE) AS notify_liquidations
       FROM wallets w
       JOIN users u ON u.id = w.user_id
       LEFT JOIN user_prefs p ON p.user_id = u.id
       WHERE w.public_key = $1`,
      [borrowerPubkey],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("[notifier] user context lookup failed:", err.message);
    return null;
  }
}

export async function incrementLiquidatedCount(userId) {
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE users SET liquidated_count = liquidated_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [userId],
    );
  } catch (err) {
    console.error("[notifier] liquidated_count update failed:", err.message);
  }
}

export async function notify(telegramId, text) {
  if (!token || !telegramId) return false;
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: telegramId, text, parse_mode: "Markdown" },
      { timeout: 10_000 },
    );
    return true;
  } catch (err) {
    console.error("[notifier] sendMessage failed:", err.message);
    return false;
  }
}

export async function markLiquidatedInDb(loanPda, txSignature) {
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE loans SET status = 'liquidated',
                        tx_signature = COALESCE(tx_signature, $2),
                        liquidated_notified_at = NOW(),
                        updated_at = NOW()
       WHERE loan_pda = $1 AND status = 'active'`,
      [loanPda, txSignature],
    );
  } catch (err) {
    console.error("[notifier] mark liquidated failed:", err.message);
  }
}
