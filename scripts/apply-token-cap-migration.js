#!/usr/bin/env node
/**
 * One-shot: ensure supported_mints.max_open_lamports column exists.
 * Idempotent — uses ADD COLUMN IF NOT EXISTS so safe to re-run.
 *
 * Normally the boot patches list (src/db/pool.js) does this, but the
 * bot needs to restart to pick it up. This applies the migration
 * immediately so the operator can set token caps without waiting.
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

await query(
  `ALTER TABLE supported_mints ADD COLUMN IF NOT EXISTS max_open_lamports NUMERIC(20,0)`,
);
console.log("✓ max_open_lamports column ensured on supported_mints");
process.exit(0);
