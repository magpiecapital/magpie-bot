#!/usr/bin/env node
/**
 * Take a governance vote-weight snapshot for a specific proposal.
 *
 * Captures THREE categories of eligible wallets at a single point
 * in time + a deduplicated combined set. Operator decides the
 * distribution model from there:
 *
 *   1. holders                  — on-chain $MAGPIE holders
 *   2. collateralized_borrowers — wallets whose $MAGPIE is locked
 *                                  in active loan vaults (economic
 *                                  owners; not punished for engaging)
 *   3. lp_providers             — wallets supplying SOL to the
 *                                  LendingPool (lp_positions.shares > 0)
 *
 * Categories 1 + 2 inherit the same exempt-list + PDA-sweep that
 * protects the holder-rewards path. Category 3 uses DB-tracked
 * positions (already filtered upstream).
 *
 * Privacy contract:
 *   - Output path comes from $GOVERNANCE_SNAPSHOT_OUT_DIR (no
 *     default committed). Must be a private directory outside any
 *     git tree.
 *   - Per-wallet data goes ONLY to the output file. stdout receives
 *     counts, totals, and a SHA-256 hash — never wallet addresses
 *     or balances.
 *   - The exact moment this fires is sensitive. Do not log it
 *     anywhere besides the output file's own timestamped name.
 *
 * Usage:
 *   GOVERNANCE_SNAPSHOT_OUT_DIR=$HOME/.magpie-private/snapshots \
 *     node scripts/governance-snapshot.js MGP-XXX
 */
import { createHash } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import dotenv from "dotenv";
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: join(REPO_ROOT, ".env") });

import { snapshotForGovernance } from "../src/services/governance-snapshot.js";

const proposalId = process.argv[2];
if (!proposalId || !/^MGP-\d{3}$/.test(proposalId)) {
  console.error("Usage: node scripts/governance-snapshot.js <PROPOSAL_ID>");
  console.error("       Proposal ID must match /^MGP-\\d{3}$/");
  process.exit(1);
}

const outDir = process.env.GOVERNANCE_SNAPSHOT_OUT_DIR;
if (!outDir) {
  console.error(
    "Refusing to run: GOVERNANCE_SNAPSHOT_OUT_DIR is not set.\n" +
      "Set it to a private directory outside any git tree before invoking.",
  );
  process.exit(1);
}

// Defense against env-var injection or operator misconfiguration:
// the output dir MUST be absolute (no relative paths that could resolve
// outside intended trees) and resolve under one of an allowlist of
// operator-controlled prefixes. Any attempt to write under /etc, /var,
// or anywhere world-readable is rejected.
if (!isAbsolute(outDir)) {
  console.error(`Refusing to run: GOVERNANCE_SNAPSHOT_OUT_DIR must be absolute (got ${outDir})`);
  process.exit(1);
}
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
}
const resolvedOutDir = realpathSync(outDir);
// Resolve allowlist prefixes too — macOS aliases /tmp → /private/tmp,
// so a direct string prefix comparison against literal "/tmp/" would
// reject every legitimate macOS /tmp/ path. realpath-ing both sides
// normalizes the comparison.
const allowedPrefixes = [
  realpathSync(resolve(process.env.HOME || "/", ".magpie-private")),
  realpathSync("/tmp"),
].filter(Boolean);
const insideAllowed = allowedPrefixes.some(
  (p) => resolvedOutDir === p || resolvedOutDir.startsWith(p + "/"),
);
if (!insideAllowed) {
  console.error(
    `Refusing to run: GOVERNANCE_SNAPSHOT_OUT_DIR (${resolvedOutDir}) is not under ` +
      `~/.magpie-private or /tmp/. Snapshot contains per-wallet eligibility data ` +
      `— it must land in a private, operator-controlled directory.`,
  );
  process.exit(1);
}

(async () => {
  const tookAt = new Date().toISOString();
  const stamp = tookAt.replace(/[:.]/g, "-");
  const outFile = join(outDir, `${proposalId}-${stamp}.json`);

  let snap;
  try {
    snap = await snapshotForGovernance();
  } catch (err) {
    console.error("Snapshot failed:", err.message);
    process.exit(2);
  }

  // Deterministic sort per category — same eligible set must always
  // hash to the same value regardless of RPC / DB row order.
  const sortByWallet = (a, b) =>
    a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  snap.holders.sort(sortByWallet);
  snap.collateralized_borrowers.sort(sortByWallet);
  snap.lp_providers.sort(sortByWallet);
  // combined_eligible_set is already sorted by the service.

  const canonical = JSON.stringify({
    proposal_id: proposalId,
    taken_at_utc: tookAt,
    scope_version: "v2-categorized",
    totals: snap.totals,
    categories: {
      holders: snap.holders,
      collateralized_borrowers: snap.collateralized_borrowers,
      lp_providers: snap.lp_providers,
    },
    combined_eligible_set: snap.combined_eligible_set,
  });

  const hash = createHash("sha256").update(canonical).digest("hex");

  writeFileSync(outFile, canonical, { mode: 0o600 });

  // stdout: counts + totals + hash only. NO wallet addresses, NO
  // balances. Enough to confirm "snapshot fired and looks sane"
  // without leaking eligibility.
  console.log(
    JSON.stringify({
      ok: true,
      proposal_id: proposalId,
      taken_at_utc: tookAt,
      scope_version: "v2-categorized",
      totals: snap.totals,
      hash_sha256: hash,
      output_basename: outFile.split("/").pop(),
    }),
  );

  process.exit(0);
})();
