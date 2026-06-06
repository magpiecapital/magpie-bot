/**
 * /version — print bot version, uptime, and last deploy info.
 *
 * Useful when verifying a deploy went through, or debugging "is this
 * the version with the new feature?" Anyone can run it — just exposes
 * boot info that's already in the health endpoint.
 */
import fs from "node:fs";
import path from "node:path";
import { getStartedAt } from "../lib/heartbeat.js";

let pkgVersion = "unknown";
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"),
  );
  pkgVersion = pkg.version || "unknown";
} catch { /* non-critical */ }

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
    "🤖 *Magpie bot*",
    "",
    `Version: ${pkgVersion}`,
    `Node:    ${process.version}`,
    `Started: ${new Date(startedAt).toISOString().replace("T", " ").slice(0, 19)} UTC`,
    `Uptime:  ${fmtDuration(uptime)}`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
