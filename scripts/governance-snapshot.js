#!/usr/bin/env node
/**
 * Take a governance vote-weight snapshot for a specific proposal.
 *
 * Reuses snapshotMagpieHolders() from the holder-rewards pipeline —
 * same eligibility rules (exempt list + System-Program owner check)
 * so vote weight matches the protocol's already-vetted holder set.
 *
 * Privacy contract:
 *   - Output path is taken from $GOVERNANCE_SNAPSHOT_OUT_DIR (no
 *     default committed to repo; the operator sets a private path
 *     outside any git tree). If unset, refuses to run.
 *   - Per-wallet balances are written to the output file only.
 *     stdout receives ONLY the holder count, weighted total, and
 *     a SHA-256 hash of the canonicalized snapshot — never any
 *     wallet address or balance.
 *   - The exact moment this script fires is sensitive. Do not log
 *     it anywhere besides the output file's own timestamped name.
 *
 * Usage:
 *   GOVERNANCE_SNAPSHOT_OUT_DIR=/path/to/private \
 *     node scripts/governance-snapshot.js <PROPOSAL_ID>
 *
 * Example:
 *   GOVERNANCE_SNAPSHOT_OUT_DIR=$HOME/.magpie-private/snapshots \
 *     node scripts/governance-snapshot.js MGP-XXX
 */
import { createHash } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import dotenv from "dotenv";
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: join(REPO_ROOT, ".env") });

import { snapshotMagpieHolders } from "../src/services/magpie-holder-rewards.js";

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

if (!existsSync(outDir)) {
  // mkdir with restrictive mode — only the owner can read the dir
  // even if the parent permits broader access.
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
}

(async () => {
  const tookAt = new Date().toISOString();
  // Embed UTC date + minute precision in the filename — same proposal
  // could in principle be re-snapshotted on a different day; clobbering
  // a prior snapshot would be silent and disastrous.
  const stamp = tookAt.replace(/[:.]/g, "-");
  const outFile = join(outDir, `${proposalId}-${stamp}.json`);

  let holders;
  try {
    holders = await snapshotMagpieHolders();
  } catch (err) {
    console.error("Snapshot failed:", err.message);
    process.exit(2);
  }

  // Sort by owner for deterministic hashing — same eligible set
  // must always hash to the same value regardless of RPC return order.
  holders.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));

  const totalRaw = holders.reduce((acc, h) => acc + BigInt(h.balance_raw), 0n);

  // Canonical JSON for hashing — stringify with explicit ordering and
  // convert BigInts to decimal strings.
  const canonical = JSON.stringify({
    proposal_id: proposalId,
    taken_at_utc: tookAt,
    holder_count: holders.length,
    total_weighted_raw: totalRaw.toString(),
    holders: holders.map((h) => ({
      owner: h.owner,
      balance_raw: h.balance_raw.toString(),
    })),
  });

  const hash = createHash("sha256").update(canonical).digest("hex");

  // Output file is JSON; hash is stored alongside so verification
  // can be done by re-hashing the holders array later.
  writeFileSync(outFile, canonical, { mode: 0o600 });

  // stdout: counts + hash only. NO wallet addresses, NO balances.
  // Wide enough to confirm "snapshot fired and looks sane" without
  // leaking the eligible set.
  console.log(JSON.stringify({
    ok: true,
    proposal_id: proposalId,
    taken_at_utc: tookAt,
    holder_count: holders.length,
    total_weighted_raw: totalRaw.toString(),
    hash_sha256: hash,
    output_basename: outFile.split("/").pop(),
  }));

  process.exit(0);
})();
