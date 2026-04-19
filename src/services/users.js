import { query } from "../db/pool.js";

export async function findUserByTelegramId(telegramId) {
  const { rows } = await query(
    `SELECT * FROM users WHERE telegram_id = $1`,
    [telegramId],
  );
  return rows[0] || null;
}

export async function upsertUser(telegramId, telegramUsername) {
  const { rows } = await query(
    `INSERT INTO users (telegram_id, telegram_username)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE
       SET telegram_username = EXCLUDED.telegram_username,
           updated_at = NOW()
     RETURNING id, telegram_id, telegram_username`,
    [telegramId, telegramUsername ?? null],
  );
  return rows[0];
}
