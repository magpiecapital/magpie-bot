#!/usr/bin/env node
/**
 * Print the ticket queue pulse — counts + IDs only, NO message contents,
 * NO usernames/wallets. Safe to call from the agent's loop tick.
 *
 * The full content read is /tickets in TG (admin-only) or
 * scripts/read-open-tickets.js --id <N> (operator-authorized, one at a time).
 */
import "dotenv/config";
import { getTicketPulse } from "../src/commands/ticket-pulse.js";

const p = await getTicketPulse();
console.log(JSON.stringify(p, null, 2));
process.exit(0);
