#!/usr/bin/env node
import "dotenv/config";
import { query } from "../src/db/pool.js";

const { rows } = await query(
  `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
    WHERE table_schema='public' AND table_name='loans'
    ORDER BY ordinal_position`,
);

for (const r of rows) {
  console.log(`  ${r.column_name.padEnd(34)} ${r.data_type}`);
}
process.exit(0);
