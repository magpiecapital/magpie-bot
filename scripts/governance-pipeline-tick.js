#!/usr/bin/env node
/**
 * Cron entrypoint for the governance autopilot.
 *
 * Schedule this every 5 minutes:
 *   ＊／5  ＊  ＊  ＊  ＊   node scripts/governance-pipeline-tick.js
 *
 * Or run on-demand:
 *   node scripts/governance-pipeline-tick.js
 *
 * The pipeline takes a Postgres advisory lock internally, so it's safe
 * to run more frequently or to overlap with other scheduler runs.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(REPO_ROOT, ".env") });

const { runPipelineTick } = await import("../src/governance/pipeline.js");

try {
  const r = await runPipelineTick();
  console.log("[gov-pipeline]", JSON.stringify(r));
  process.exit(0);
} catch (err) {
  console.error("[gov-pipeline] tick failed:", err.message);
  process.exit(1);
}
