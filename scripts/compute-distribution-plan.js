#!/usr/bin/env node
/**
 * Compute a per-wallet distribution plan from a categorized
 * governance snapshot.
 *
 * Reads a snapshot file produced by scripts/governance-snapshot.js
 * (scope_version: v2-categorized) and computes per-wallet
 * allocations for one or both of two distinct budget pools:
 *
 *   HOLDER POOL    — pro-rata across (held + collateralized) $MAGPIE.
 *                    Operator-controlled manual additions go here.
 *                    LP-only wallets receive NOTHING from this pool.
 *
 *   LP POOL        — pro-rata across LP shares. No manual additions
 *                    by policy. Holders not in lp_positions receive
 *                    NOTHING from this pool.
 *
 * A wallet appearing in multiple categories is credited from both
 * pools by its respective contribution. Each pool is computed
 * independently — no cross-subsidy.
 *
 * The plan file is the operator's review artifact. SOL doesn't move
 * until the operator explicitly executes (a separate step, not in
 * this script). The hash on the plan is the integrity commit — if
 * the same snapshot + same pool sizes produce a different hash, the
 * input changed.
 *
 * Privacy contract:
 *   - Output goes to $DISTRIBUTION_PLAN_OUT_DIR (no committed default).
 *   - stdout emits counts + totals + hash only. No wallet addresses.
 *
 * Usage:
 *   DISTRIBUTION_PLAN_OUT_DIR=$HOME/.magpie-private/distributions \
 *     node scripts/compute-distribution-plan.js \
 *       <snapshot_file> \
 *       --holder-pool-sol <N> \
 *       [--lp-pool-sol <N>] \
 *       [--manual-added-sol <N>] \
 *       [--memo "..."]
 *
 * Example (just the holder pool, with a manual top-up):
 *   ... compute-distribution-plan.js \
 *     ~/.magpie-private/snapshots/MGP-001-2026-06-10T18-00-00-000Z.json \
 *     --holder-pool-sol 12.5 --manual-added-sol 5.0 --memo "MGP-001 R1"
 *
 * --manual-added-sol is informational only — it's recorded in the
 * plan for auditability. The total holder-pool-sol IS the budget
 * that gets allocated. Pass the COMBINED amount as --holder-pool-sol.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const args = process.argv.slice(2);
const snapshotPath = args[0];
if (!snapshotPath || !existsSync(snapshotPath)) {
  console.error("Usage: node scripts/compute-distribution-plan.js <snapshot_file> [options]");
  console.error("       snapshot_file must exist and be a v2-categorized snapshot JSON.");
  process.exit(1);
}

function arg(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1];
}

const holderPoolSol = arg("holder-pool-sol");
const lpPoolSol = arg("lp-pool-sol");
const manualAddedSol = arg("manual-added-sol");
const memo = arg("memo");
if (holderPoolSol === undefined && lpPoolSol === undefined) {
  console.error("At least one of --holder-pool-sol or --lp-pool-sol must be provided.");
  process.exit(1);
}

const outDir = process.env.DISTRIBUTION_PLAN_OUT_DIR;
if (!outDir) {
  console.error("Refusing to run: DISTRIBUTION_PLAN_OUT_DIR is not set.");
  process.exit(1);
}
if (!isAbsolute(outDir)) {
  console.error(`Refusing to run: DISTRIBUTION_PLAN_OUT_DIR must be absolute (got ${outDir})`);
  process.exit(1);
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 });
const resolvedOutDir = realpathSync(outDir);
const allowedPrefixes = [
  realpathSync(resolve(process.env.HOME || "/", ".magpie-private")),
  realpathSync("/tmp"),
].filter(Boolean);
const insideAllowed = allowedPrefixes.some(
  (p) => resolvedOutDir === p || resolvedOutDir.startsWith(p + "/"),
);
if (!insideAllowed) {
  console.error(
    `Refusing to run: DISTRIBUTION_PLAN_OUT_DIR (${resolvedOutDir}) is not under ` +
      `~/.magpie-private or /tmp/. Plans contain per-wallet allocations ` +
      `— they must land in a private, operator-controlled directory.`,
  );
  process.exit(1);
}

// Read snapshot bytes so we can hash + parse from the same buffer.
// Hashing the parsed-then-canonical form would let an attacker
// insert whitespace/key-order differences that don't affect parsing
// but DO change the hash they think they're verifying against. The
// only safe integrity check is over the raw bytes.
const snapshotRaw = readFileSync(snapshotPath);
const snapshotHash = createHash("sha256").update(snapshotRaw).digest("hex");

// Opt-in: --expected-snapshot-hash <hex> performs constant-time
// verification before any allocation math runs. The operator can
// note the hash from the snapshot's stdout (which is also written
// into the snapshot's own canonical body, but printed to stdout at
// snapshot fire time) and pass it here.
const expectedHash = arg("expected-snapshot-hash");
if (expectedHash !== undefined) {
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    console.error(`Invalid --expected-snapshot-hash format (must be 64 hex chars)`);
    process.exit(1);
  }
  const a = Buffer.from(expectedHash, "hex");
  const b = Buffer.from(snapshotHash, "hex");
  if (!timingSafeEqual(a, b)) {
    console.error(
      `Snapshot hash mismatch.\n` +
        `  expected: ${expectedHash}\n` +
        `  actual:   ${snapshotHash}\n` +
        `Refusing to compute a plan against an unverified snapshot.`,
    );
    process.exit(1);
  }
}

const snap = JSON.parse(snapshotRaw.toString("utf8"));
if (snap.scope_version !== "v2-categorized") {
  console.error(
    `Snapshot scope_version "${snap.scope_version}" is not v2-categorized. ` +
      `This script requires the categorized snapshot format.`,
  );
  process.exit(1);
}

// Parse a SOL amount (number-as-string) into lamports BigInt with
// full 9-decimal precision. No floats.
function parseSolToLamports(s) {
  if (s === undefined) return 0n;
  const str = String(s).trim();
  if (!/^\d+(\.\d{0,9})?$/.test(str)) {
    throw new Error(`Invalid SOL amount "${s}" — must be a positive decimal with ≤9 fractional digits`);
  }
  const [intPart, fracPart = ""] = str.split(".");
  const fracPadded = (fracPart + "000000000").slice(0, 9);
  return BigInt(intPart) * 1_000_000_000n + BigInt(fracPadded);
}

const holderPoolLamports = parseSolToLamports(holderPoolSol);
const lpPoolLamports = parseSolToLamports(lpPoolSol);
const manualAddedLamports = parseSolToLamports(manualAddedSol);
if (manualAddedLamports > holderPoolLamports) {
  console.error(
    `--manual-added-sol (${manualAddedSol}) cannot exceed --holder-pool-sol (${holderPoolSol}). ` +
      `Manual is informational; pass the COMBINED amount as --holder-pool-sol.`,
  );
  process.exit(1);
}

// ── Build per-wallet contribution buckets ──────────────────────────
// Holder weighting = held + collateralized (same economic owner of $MAGPIE
// regardless of where the tokens sit). LP weighting = shares.
const holderWeight = new Map(); // wallet -> BigInt held+collateralized
const lpWeight = new Map(); // wallet -> BigInt shares

for (const h of snap.categories.holders) {
  const cur = holderWeight.get(h.wallet) ?? 0n;
  holderWeight.set(h.wallet, cur + BigInt(h.magpie_balance_raw));
}
for (const c of snap.categories.collateralized_borrowers) {
  const cur = holderWeight.get(c.wallet) ?? 0n;
  holderWeight.set(c.wallet, cur + BigInt(c.magpie_collateralized_raw));
}
for (const l of snap.categories.lp_providers) {
  const cur = lpWeight.get(l.wallet) ?? 0n;
  lpWeight.set(l.wallet, cur + BigInt(l.shares));
}

const totalHolderWeight = Array.from(holderWeight.values()).reduce(
  (acc, v) => acc + v,
  0n,
);
const totalLpWeight = Array.from(lpWeight.values()).reduce(
  (acc, v) => acc + v,
  0n,
);

// ── Compute per-wallet allocations ──────────────────────────────────
// Pro-rata by weight, with deterministic remainder tracking so we
// don't lose lamports to rounding. The remainder goes to the
// highest-weight wallet so a single rounding loss isn't dispersed.
function allocate(weights, totalWeight, poolLamports) {
  if (totalWeight === 0n || poolLamports === 0n) return new Map();
  const entries = Array.from(weights.entries()).sort((a, b) =>
    b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const result = new Map();
  let allocated = 0n;
  for (const [wallet, weight] of entries) {
    const share = (poolLamports * weight) / totalWeight;
    if (share > 0n) {
      result.set(wallet, share);
      allocated += share;
    }
  }
  const remainder = poolLamports - allocated;
  if (remainder > 0n && entries.length > 0) {
    const [topWallet] = entries[0];
    result.set(topWallet, (result.get(topWallet) ?? 0n) + remainder);
  }
  return result;
}

const holderAllocations = allocate(holderWeight, totalHolderWeight, holderPoolLamports);
const lpAllocations = allocate(lpWeight, totalLpWeight, lpPoolLamports);

// ── Combine into per-wallet plan rows ───────────────────────────────
const allWallets = new Set([
  ...holderAllocations.keys(),
  ...lpAllocations.keys(),
]);
const planRows = Array.from(allWallets)
  .map((wallet) => {
    const h = holderAllocations.get(wallet) ?? 0n;
    const l = lpAllocations.get(wallet) ?? 0n;
    return {
      wallet,
      holder_pool_lamports: h.toString(),
      lp_pool_lamports: l.toString(),
      total_lamports: (h + l).toString(),
    };
  })
  .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));

const totalAllocatedLamports = planRows.reduce(
  (acc, r) => acc + BigInt(r.total_lamports),
  0n,
);

// ── Write plan file + emit summary ──────────────────────────────────
const generatedAt = new Date().toISOString();
const stamp = generatedAt.replace(/[:.]/g, "-");
const proposalId = snap.proposal_id ?? "UNKNOWN";
const outFile = join(outDir, `PLAN-${proposalId}-${stamp}.json`);

const canonical = JSON.stringify({
  plan_version: "v1",
  proposal_id: proposalId,
  generated_at_utc: generatedAt,
  snapshot_source: basename(snapshotPath),
  snapshot_sha256: snapshotHash,
  snapshot_taken_at_utc: snap.taken_at_utc,
  memo: memo ?? null,
  pools: {
    holder_pool_lamports: holderPoolLamports.toString(),
    lp_pool_lamports: lpPoolLamports.toString(),
    manual_added_lamports: manualAddedLamports.toString(),
    holder_pool_auto_accrued_lamports:
      (holderPoolLamports - manualAddedLamports).toString(),
  },
  totals: {
    holder_recipients: holderAllocations.size,
    lp_recipients: lpAllocations.size,
    unique_recipients: allWallets.size,
    total_holder_weight: totalHolderWeight.toString(),
    total_lp_weight: totalLpWeight.toString(),
    total_allocated_lamports: totalAllocatedLamports.toString(),
  },
  allocations: planRows,
});

const hash = createHash("sha256").update(canonical).digest("hex");

writeFileSync(outFile, canonical, { mode: 0o600 });

console.log(
  JSON.stringify({
    ok: true,
    proposal_id: proposalId,
    generated_at_utc: generatedAt,
    memo: memo ?? null,
    snapshot_sha256: snapshotHash,
    pools_sol: {
      holder_pool: Number(holderPoolLamports) / 1e9,
      lp_pool: Number(lpPoolLamports) / 1e9,
      manual_added: Number(manualAddedLamports) / 1e9,
      holder_pool_auto_accrued:
        Number(holderPoolLamports - manualAddedLamports) / 1e9,
    },
    totals: {
      holder_recipients: holderAllocations.size,
      lp_recipients: lpAllocations.size,
      unique_recipients: allWallets.size,
      total_allocated_sol: Number(totalAllocatedLamports) / 1e9,
    },
    hash_sha256: hash,
    output_basename: basename(outFile),
  }),
);
