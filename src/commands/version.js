/**
 * /version — print bot version, uptime, and last deploy info.
 *
 * Useful when verifying a deploy went through, or debugging "is this
 * the version with the new feature?" Anyone can run it — just exposes
 * boot info that's already in the health endpoint.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { getStartedAt } from "../lib/heartbeat.js";

let pkgVersion = "unknown";
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"),
  );
  pkgVersion = pkg.version || "unknown";
} catch { /* non-critical */ }

// Compute the git short SHA once at module load. On Railway the
// repo is checked out, so git is usually available. Fall back to env
// vars (RAILWAY_GIT_COMMIT_SHA, GIT_COMMIT) for hosts that don't.
let gitSha = "unknown";
try {
  gitSha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
    .toString().trim();
} catch {
  gitSha = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || "unknown").slice(0, 7);
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export async function handleVersion(ctx) {
  const startedAt = getStartedAt();
  const uptime = Date.now() - startedAt;
  const lines = [
    "🤖 *Pip · Magpie's AI agent*",
    "",
    `Version: ${pkgVersion}`,
    `Commit:  \`${gitSha}\``,
    `Node:    ${process.version}`,
    `Started: ${new Date(startedAt).toISOString().replace("T", " ").slice(0, 19)} UTC`,
    `Uptime:  ${fmtDuration(uptime)}`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
