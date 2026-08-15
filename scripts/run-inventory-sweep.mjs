#!/usr/bin/env node
/** One-off manual sweep. Run: railway run node scripts/run-inventory-sweep.mjs */
import { runInventorySweep } from "../src/services/collectible-inventory-indexer.js";
await runInventorySweep();
const { query } = await import("../src/db/pool.js");
const { rows } = await query(`SELECT platform, COUNT(*)::int AS total, COUNT(catalog_slug)::int AS matched FROM collectible_tokenized_inventory GROUP BY platform`);
console.log("inventory:", JSON.stringify(rows));
const { rows: top } = await query(`SELECT catalog_slug, platform, COUNT(*)::int AS n FROM collectible_tokenized_inventory WHERE catalog_slug IS NOT NULL GROUP BY 1,2 ORDER BY n DESC LIMIT 12`);
console.log("top matches:", JSON.stringify(top));
process.exit(0);
