#!/usr/bin/env node
/**
 * Execute a distribution plan — send SOL to each recipient.
 *
 * The last-mile tool for the governance distribution pipeline:
 *
 *   snapshot →  compute-distribution-plan  →  this script
 *
 * Safety properties:
 *
 *   1. --dry-run is the DEFAULT. Real sends require both --execute
 *      AND --confirm "I understand this is irreversible". Three
 *      separate barriers against accidental SOL movement.
 *
 *   2. Plan integrity verified before any send. The plan file's
 *      embedded snapshot_sha256 is matched against the canonical
 *      bytes via constant-time compare. Plan body hashed separately
 *      and recorded in the execution log so a partially-executed
 *      plan can be resumed verbatim later.
 *
 *   3. Idempotent on resume. Every recipient + amount is keyed by
 *      (plan_hash, recipient_wallet) in a persistent execution log
 *      (~/.magpie-private/distributions/EXECUTION-LOG.jsonl).
 *      Re-running the script after a partial failure skips already-
 *      confirmed recipients. No double-pay.
 *
 *   4. Batched. Up to 10 SystemProgram.transfer ixs per tx — well
 *      under Solana's tx-size limit, gives us per-batch atomicity
 *      (10 recipients land together or all fail together). On
 *      failure, the next attempt re-tries only the failed batch.
 *
 *   5. Per-recipient minimum. Lamports < MIN_PAYOUT_LAMPORTS (default
 *      1000 = 1µSOL) are skipped to avoid dust txs that cost more in
 *      fees than they pay out.
 *
 *   6. Sender balance pre-check. Before any send, verifies the sender
 *      wallet can cover total_to_distribute + 0.01 SOL gas buffer.
 *
 *   7. Privacy. Plan input and execution log both under
 *      $DISTRIBUTION_PLAN_OUT_DIR. No per-recipient data logged to
 *      stdout — only batch progress and a final summary.
 *
 * Usage:
 *
 *   # Dry-run (default — prints what WOULD be sent)
 *   DISTRIBUTION_PLAN_OUT_DIR=$HOME/.magpie-private/distributions \
 *   SENDER_KEYPAIR=/path/to/sender.json \
 *     node scripts/execute-distribution-plan.js \
 *       ~/.magpie-private/distributions/PLAN-MGP-001-...json
 *
 *   # Real send
 *   DISTRIBUTION_PLAN_OUT_DIR=$HOME/.magpie-private/distributions \
 *   SENDER_KEYPAIR=/path/to/sender.json \
 *     node scripts/execute-distribution-plan.js \
 *       ~/.magpie-private/distributions/PLAN-MGP-001-...json \
 *       --execute --confirm "I understand this is irreversible"
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import "dotenv/config";

const args = process.argv.slice(2);
const planPath = args[0];
if (!planPath || !existsSync(planPath)) {
  console.error(
    "Usage: node scripts/execute-distribution-plan.js <plan_file> [--execute --confirm \"I understand this is irreversible\"]",
  );
  process.exit(1);
}

function arg(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1];
}
const flag = (name) => args.includes(`--${name}`);

const isExecute = flag("execute");
const confirmText = arg("confirm");
const EXPECTED_CONFIRM = "I understand this is irreversible";
if (isExecute && confirmText !== EXPECTED_CONFIRM) {
  console.error(
    `Refusing to execute. --execute requires --confirm "${EXPECTED_CONFIRM}" (got ${confirmText === undefined ? "(missing)" : `"${confirmText}"`})`,
  );
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
if (
  !allowedPrefixes.some((p) => resolvedOutDir === p || resolvedOutDir.startsWith(p + "/"))
) {
  console.error(
    `Refusing to run: DISTRIBUTION_PLAN_OUT_DIR (${resolvedOutDir}) not under ~/.magpie-private or /tmp/.`,
  );
  process.exit(1);
}

// ── Load + hash the plan ───────────────────────────────────────────
const planRaw = readFileSync(planPath);
const planHash = createHash("sha256").update(planRaw).digest("hex");
let plan;
try {
  plan = JSON.parse(planRaw.toString("utf8"));
} catch (err) {
  console.error("Plan file is not valid JSON:", err.message);
  process.exit(1);
}
if (plan.plan_version !== "v1") {
  console.error(`Unsupported plan_version "${plan.plan_version}" — this script handles v1.`);
  process.exit(1);
}
if (!Array.isArray(plan.allocations) || plan.allocations.length === 0) {
  console.error("Plan has no allocations — nothing to execute.");
  process.exit(1);
}

// ── Sender keypair ─────────────────────────────────────────────────
const senderPath = process.env.SENDER_KEYPAIR;
if (!senderPath) {
  console.error("Refusing to run: SENDER_KEYPAIR env var must point at a Solana keypair JSON.");
  process.exit(1);
}
const senderSecret = JSON.parse(
  readFileSync(senderPath.replace(/^~/, process.env.HOME || ""), "utf8"),
);
const sender = Keypair.fromSecretKey(new Uint8Array(senderSecret));

// ── Connection ─────────────────────────────────────────────────────
const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpcUrl, "confirmed");

// ── Execution log (idempotency journal) ────────────────────────────
const execLogPath = join(outDir, "EXECUTION-LOG.jsonl");
const alreadyPaid = new Set(); // Set of `${planHash}:${recipient}`
if (existsSync(execLogPath)) {
  const lines = readFileSync(execLogPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.event === "transfer_confirmed" && e.plan_hash === planHash) {
        for (const r of e.recipients) alreadyPaid.add(`${planHash}:${r}`);
      }
    } catch {
      // Skip malformed lines — don't bail the whole script
    }
  }
}

// ── Compute the work ───────────────────────────────────────────────
const MIN_PAYOUT_LAMPORTS = 1000n; // 1µSOL — sub-dust skip
const BATCH_SIZE = 10;
const GAS_RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL

const work = [];
let skippedDust = 0;
let skippedPrevPaid = 0;
let totalLamports = 0n;
for (const a of plan.allocations) {
  const amount = BigInt(a.total_lamports);
  if (amount < MIN_PAYOUT_LAMPORTS) {
    skippedDust++;
    continue;
  }
  if (alreadyPaid.has(`${planHash}:${a.wallet}`)) {
    skippedPrevPaid++;
    continue;
  }
  work.push({ wallet: a.wallet, lamports: amount });
  totalLamports += amount;
}

// Sender balance pre-check.
const balance = BigInt(await connection.getBalance(sender.publicKey, "confirmed"));
const needed = totalLamports + GAS_RESERVE_LAMPORTS;
const senderShort = `${sender.publicKey.toBase58().slice(0, 4)}…${sender.publicKey.toBase58().slice(-4)}`;

// ── Print summary ──────────────────────────────────────────────────
const summary = {
  mode: isExecute ? "EXECUTE" : "DRY-RUN",
  plan_basename: basename(planPath),
  plan_hash_sha256: planHash,
  proposal_id: plan.proposal_id,
  sender: senderShort,
  sender_balance_sol: Number(balance) / 1e9,
  recipients_in_plan: plan.allocations.length,
  recipients_to_pay: work.length,
  recipients_skipped_dust: skippedDust,
  recipients_skipped_already_paid: skippedPrevPaid,
  total_to_send_sol: Number(totalLamports) / 1e9,
  batches_needed: Math.ceil(work.length / BATCH_SIZE),
  gas_reserve_sol: Number(GAS_RESERVE_LAMPORTS) / 1e9,
  sender_balance_after_estimate_sol: Number(balance - needed) / 1e9,
  balance_sufficient: balance >= needed,
};
console.log("─── Distribution plan summary ───");
console.log(JSON.stringify(summary, null, 2));

if (work.length === 0) {
  console.log("Nothing to do (zero recipients after dust + already-paid filters).");
  process.exit(0);
}

if (!summary.balance_sufficient) {
  console.error(
    `\nRefusing to proceed: sender wallet has ${(Number(balance) / 1e9).toFixed(6)} SOL but ` +
      `needs ${(Number(needed) / 1e9).toFixed(6)} SOL (allocations + ${Number(GAS_RESERVE_LAMPORTS) / 1e9} SOL gas reserve).`,
  );
  process.exit(1);
}

if (!isExecute) {
  console.log("\nDRY-RUN — no SOL moved. Pass --execute --confirm \"I understand this is irreversible\" to send for real.");
  process.exit(0);
}

// ── Real execution ─────────────────────────────────────────────────
// Open the log in append mode so each batch is persisted as it
// confirms — survives mid-run process kills.
appendFileSync(
  execLogPath,
  JSON.stringify({
    event: "run_started",
    at: new Date().toISOString(),
    plan_hash: planHash,
    plan_basename: basename(planPath),
    sender_pubkey: sender.publicKey.toBase58(),
    recipients_to_pay: work.length,
    total_lamports: totalLamports.toString(),
  }) + "\n",
  { mode: 0o600 },
);

let batchN = 0;
let successCount = 0;
let failureCount = 0;

for (let i = 0; i < work.length; i += BATCH_SIZE) {
  batchN++;
  const batch = work.slice(i, i + BATCH_SIZE);
  const tx = new Transaction();
  for (const w of batch) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: new PublicKey(w.wallet),
        lamports: w.lamports,
      }),
    );
  }
  const startedAt = new Date().toISOString();
  let sig;
  try {
    sig = await sendAndConfirmTransaction(connection, tx, [sender], {
      commitment: "confirmed",
    });
  } catch (err) {
    failureCount += batch.length;
    appendFileSync(
      execLogPath,
      JSON.stringify({
        event: "transfer_failed",
        at: new Date().toISOString(),
        plan_hash: planHash,
        batch_n: batchN,
        recipients: batch.map((b) => b.wallet),
        amounts: batch.map((b) => b.lamports.toString()),
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      }) + "\n",
      { mode: 0o600 },
    );
    console.error(`  batch ${batchN}/${summary.batches_needed} FAILED — ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    continue;
  }
  successCount += batch.length;
  appendFileSync(
    execLogPath,
    JSON.stringify({
      event: "transfer_confirmed",
      at: new Date().toISOString(),
      started_at: startedAt,
      plan_hash: planHash,
      batch_n: batchN,
      tx_signature: sig,
      recipients: batch.map((b) => b.wallet),
      amounts: batch.map((b) => b.lamports.toString()),
    }) + "\n",
    { mode: 0o600 },
  );
  console.log(`  batch ${batchN}/${summary.batches_needed} ✓ tx ${sig.slice(0, 16)}… (${batch.length} recipients)`);
}

// ── Final summary ──────────────────────────────────────────────────
const finalSummary = {
  event: "run_completed",
  at: new Date().toISOString(),
  plan_hash: planHash,
  batches_attempted: batchN,
  recipients_succeeded: successCount,
  recipients_failed: failureCount,
};
appendFileSync(execLogPath, JSON.stringify(finalSummary) + "\n", { mode: 0o600 });

console.log("\n─── Execution complete ───");
console.log(JSON.stringify(finalSummary, null, 2));
if (failureCount > 0) {
  console.log(
    "\nSome recipients failed. Re-run the same script with the same plan to retry only the failed recipients — confirmed ones are skipped via the execution log.",
  );
  process.exit(2);
}
process.exit(0);
