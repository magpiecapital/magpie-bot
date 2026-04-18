import pg from "pg";
import "dotenv/config";

const useSSL = process.env.DB_SSL !== "false";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
});

export async function query(text, params) {
  return pool.query(text, params);
}
