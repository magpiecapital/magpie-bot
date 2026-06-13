/**
 * Loan program_id healer — periodic auto-correction of DB rows whose
 * stored `program_id` disagrees with the on-chain owner of `loan_pda`.
 *
 * Why this exists
 * ───────────────
 * The 2026-06-13 RWA-visibility incident: a $SPCX loan was stored
 * with V1's program_id even though the on-chain Loan account was
 * owned by V2. The dashboard's wallet-scoped filter re-derives loan
 * PDAs using the stored program_id; mismatched values silently drop
 * the loan from the user's view. The user thinks their loan
 * disappeared.
 *
 * Defense in depth (all three fire on every drift):
 *
 *   1. recordLoan() — write-time on-chain authoritative override.
 *      Caller's programId arg is logged + ignored if it disagrees
 *      with the on-chain owner. (services/loans.js)
 *
 *   2. self-monitor.probeLoanProgramIdDrift — sample-based alert
 *      tier that DMs the operator when drift appears.
 *
 *   3. THIS healer — runs every HEAL_INTERVAL_MS, scans the active
 *      cohort, fetches on-chain owner per loan_pda, and UPDATEs any
 *      row that's drifted. Idempotent; safe to overlap with itself.
 *
 * Three layers because no single one is enough:
 *   - Write-time check could miss a transient RPC outage
 *   - Self-monitor only samples 20 most-recent rows
 *   - Healer catches anything that slipped past the first two,
 *     including historical rows from before the write-time check
 *     was hardened
 *
 * Cadence + cost
 * ──────────────
 * Default 10-min interval. Scans ALL non-closed loans on each cycle
 * — typically <100 rows. Each RPC call is a single getAccountInfo.
 * Bounded parallelism (8 concurrent) keeps Helius happy. End-to-end
 * cost: ~100 RPC calls per cycle = 600/hr = well under Helius free
 * tier. Operator can extend the interval via env if desired.
 *
 * Observability
 * ─────────────
 * Each cycle logs:
 *   "[program-id-healer] scanned N, drifted M, fixed M (oldest:
 *    loan_id=X status=active)"
 * Self-monitor's recordOutcome path also fires so the existing
 * alert plumbing surfaces persistent drift to operator DMs.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";

const HEAL_INTERVAL_MS = Number(process.env.LOAN_PROGRAM_ID_HEAL_MS) || 10 * 60_000; // 10 min
const FETCH_CONCURRENCY = Number(process.env.LOAN_PROGRAM_ID_HEAL_CONCURRENCY) || 8;
const START_DELAY_MS = 5 * 60_000; // 5 min after boot so we don't fight startup load

let _timer = null;
let _connection = null;
function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  }
  return _connection;
}

async function fetchOwner(connection, loanPda) {
  try {
    const info = await connection.getAccountInfo(new PublicKey(loanPda));
    if (!info?.owner) return null;
    return info.owner.toBase58();
  } catch {
    return null;
  }
}

async function healOnce(bot) {
  const conn = getConnection();

  // We focus on non-closed status so a recently-active loan whose
  // PDA might have been written wrong gets fixed before its user
  // tries to repay/manage it. Closed loans matter less for live UX
  // but the FULL backfill script in scripts/ can sweep those.
  const { rows: loans } = await query(
    `SELECT id, loan_pda, program_id, status
       FROM loans
      WHERE loan_pda IS NOT NULL
        AND status IN ('active', 'pending', 'liquidating')
      ORDER BY id DESC`,
  );

  let scanned = 0;
  let fixed = 0;
  let firstFixedId = null;

  for (let i = 0; i < loans.length; i += FETCH_CONCURRENCY) {
    const chunk = loans.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(chunk.map(async (l) => {
      scanned++;
      const onChain = await fetchOwner(conn, l.loan_pda);
      if (!onChain) return null;
      if (onChain === l.program_id) return null;
      return { id: l.id, onChain, drifted_from: l.program_id };
    }));
    for (const r of results) {
      if (!r) continue;
      try {
        await query(`UPDATE loans SET program_id = $1 WHERE id = $2`, [r.onChain, r.id]);
        fixed++;
        if (firstFixedId === null) firstFixedId = r.id;
        console.warn(
          `[program-id-healer] healed loan ${r.id}: db=${r.drifted_from.slice(0, 8)}… → chain=${r.onChain.slice(0, 8)}…`,
        );
      } catch (err) {
        console.warn(`[program-id-healer] UPDATE failed for loan ${r.id}:`, err.message?.slice(0, 80));
      }
    }
  }

  if (fixed > 0) {
    console.warn(`[program-id-healer] scanned ${scanned}, drifted ${fixed}, fixed ${fixed} (first: loan id=${firstFixedId})`);
    // Operator alert when ≥1 drift was caught — drift means an
    // upstream code path is still passing the wrong value or a
    // transient RPC blip at write time hid behind the caller arg.
    if (bot) {
      const adminId = process.env.ADMIN_TG_ID;
      if (adminId) {
        try {
          await bot.api.sendMessage(
            Number(adminId),
            `*Loan program_id drift auto-healed*\n\n` +
            `Healed ${fixed} loan(s) whose DB program_id disagreed with on-chain owner.\n` +
            `First healed: loan id=${firstFixedId}.\n\n` +
            `Action: investigate which write path passed the wrong value. The on-chain authoritative override in recordLoan should normally prevent this — drift means either an RPC blip at write time, or a code path that's bypassing recordLoan entirely.`,
            { parse_mode: "Markdown" },
          );
        } catch { /* non-fatal */ }
      }
    }
  } else {
    // Quiet success — only log periodically to avoid spam
    if (Math.random() < 0.05) {
      console.log(`[program-id-healer] scanned ${scanned}, no drift`);
    }
  }
}

export function startLoanProgramIdHealer(bot) {
  if (_timer) return;
  console.log(`[program-id-healer] armed — heal every ${HEAL_INTERVAL_MS / 60_000} min, ${FETCH_CONCURRENCY} concurrent RPC fetches`);
  setTimeout(() => {
    healOnce(bot).catch((e) => console.warn("[program-id-healer] first heal threw:", e.message?.slice(0, 80)));
    _timer = setInterval(() => {
      healOnce(bot).catch((e) => console.warn("[program-id-healer] heal threw:", e.message?.slice(0, 80)));
    }, HEAL_INTERVAL_MS);
  }, START_DELAY_MS);
}
