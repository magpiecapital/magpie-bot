#!/usr/bin/env node
/**
 * Print the ticket queue pulse — counts + IDs only, NO message contents,
 * NO usernames/wallets. Safe to call from the agent's loop tick.
 *
 * The full content read is /tickets in TG (admin-only) or
 * scripts/read-open-tickets.js --id <N> (operator-authorized, one at a time).
 */
// Load .env from the REPO ROOT regardless of cwd, THEN dynamic-import
// the module that touches DATABASE_URL. Static `import` of that module
// would hoist above dotenv.config() and read process.env.DATABASE_URL
// as undefined → "No database connection available".
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(REPO_ROOT, ".env") });

const { getTicketPulse } = await import("../src/commands/ticket-pulse.js");
const p = await getTicketPulse();
console.log(JSON.stringify(p, null, 2));
process.exit(0);
