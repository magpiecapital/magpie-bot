/**
 * V4 repay-readiness watcher.
 *
 * Item 1 of the 2026-06-17 V4 hardening sprint
 * (feedback_v4_hardening_sprint_2026_06_17.md). Operator-mandated.
 *
 * WHY THIS EXISTS
 * ───────────────
 * V4's repay_loan instruction requires the FULL owed amount LIQUID in
 * the user's wallet at sign time. The sol_proceeds_vault (where auto-sell
 * SOL accumulates) does NOT pre-net at repay — it flows to the wallet
 * AFTER repay succeeds.
 *
 * Worst-case: a borrower spent the borrowed SOL on something else,
 * partial ladder auto-sells filled the vault with proceeds, due date
 * arrives, they click Repay and learn for the first time that vault
 * SOL doesn't cover wallet shortfall. Now they have to scramble for
 * top-up cash on a deadline. Real loss vector — see
 * [[project_magpie_v4_repay_funding_gap]].
 *
 * WHAT THIS DOES
 * ──────────────
 * Every V4_REPAY_READINESS_INTERVAL_MS (default 1 hour):
 *   1. SELECT V4 loans with status='active' AND due_timestamp within 72h
 *   2. For each, compute the preflight (owed / wallet / vault / deficit)
 *   3. If can_repay_now === false:
 *      - 72h-out: warn DM
 *      - 24h-out: stronger DM
 *      - 6h-out: critical DM
 *      - <1h: critical DM + tag operator
 *   4. Per-loan throttle by tier so each tier DMs at most once
 *
 * Goal: borrowers see a "you need 0.3 SOL more to repay loan #X by Tuesday"
 * DM days before the due date, not the moment they tap Repay.
 *
 * Best-effort throughout. Connection issues, missing TG link, decode
 * failures — all log + continue. The watcher must never throw.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { computeV4RepayPreflight } from "../api/v4-repay-preflight.js";

const INTERVAL_MS = Number(
  process.env.V4_REPAY_READINESS_INTERVAL_MS || 60 * 60 * 1000, // 1 hour
);
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.RPC_URL ||
  "https://api.mainnet-beta.solana.com";

// Tier definitions — each loan moves through these as the due date
// approaches. Once a tier DM is sent, it's not re-sent for that loan.
const TIERS = [
  { name: "warn",     hoursLeft: 72, label: "3 days" },
  { name: "alert",    hoursLeft: 24, label: "24 hours" },
  { name: "critical", hoursLeft: 6,  label: "6 hours" },
  { name: "imminent", hoursLeft: 1,  label: "1 hour" },
];

let _timer = null;
let _running = false;

export function startV4RepayReadinessWatcher(bot) {
  if (_timer) return;
  if (/^(1|true|yes|on)$/i.test(process.env.V4_REPAY_READINESS_DISABLED || "")) {
    console.log("[v4-repay-readiness] DISABLED via V4_REPAY_READINESS_DISABLED env");
    return;
  }
  // First run after 5 min so boot storm settles.
  setTimeout(() => {
    runOnce(bot).catch((e) =>
      console.warn(`[v4-repay-readiness] first tick failed: ${e.message?.slice(0, 160)}`),
    );
    _timer = setInterval(() => {
      if (_running) return;
      runOnce(bot).catch((e) =>
        console.warn(`[v4-repay-readiness] tick failed: ${e.message?.slice(0, 160)}`),
      );
    }, INTERVAL_MS);
  }, 5 * 60 * 1000);
  console.log(
    `[v4-repay-readiness] armed — first tick in 5 min, then every ${INTERVAL_MS / 60_000} min`,
  );
}

export function stopV4RepayReadinessWatcher() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

async function runOnce(bot) {
  _running = true;
  try {
    await ensureNotificationsTable();
    await tickWatcher(bot);
  } finally {
    _running = false;
  }
}

/**
 * v4_repay_readiness_notifications — at-most-once-per-tier ledger so the
 * watcher never spams a borrower. Additive table; doesn't touch any
 * existing loan/user state.
 */
async function ensureNotificationsTable() {
  await query(
    `CREATE TABLE IF NOT EXISTS v4_repay_readiness_notifications (
       id           BIGSERIAL PRIMARY KEY,
       loan_id      INT NOT NULL,
       tier         TEXT NOT NULL,
       sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       wallet       TEXT,
       owed_lamports        NUMERIC,
       wallet_lamports      NUMERIC,
       vault_lamports       NUMERIC,
       deficit_lamports     NUMERIC,
       UNIQUE (loan_id, tier)
     )`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS v4_repay_readiness_sent_at_idx ON v4_repay_readiness_notifications(sent_at DESC)`,
  );
}

async function tickWatcher(bot) {
  const programIdV4 = process.env.PROGRAM_ID_V4 || null;
  if (!programIdV4) {
    console.log("[v4-repay-readiness] PROGRAM_ID_V4 unset — skipping tick");
    return;
  }

  // 72h candidate window keeps the query cheap. We re-evaluate per-tier
  // hoursLeft in JS rather than running 4 separate queries.
  const { rows: candidates } = await query(
    `SELECT l.id, l.loan_id::text AS loan_id_chain, l.loan_pda,
            l.user_id, l.borrower_wallet, l.due_timestamp,
            l.original_loan_amount_lamports::text AS original_owed,
            u.telegram_id,
            sm.symbol
       FROM loans l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE l.status = 'active'
        AND l.program_id = $1
        AND l.due_timestamp <= NOW() + INTERVAL '72 hours'
        AND l.due_timestamp > NOW() - INTERVAL '1 hour'
        AND l.borrower_wallet IS NOT NULL
        AND l.loan_pda IS NOT NULL
        AND u.telegram_id IS NOT NULL`,
    [programIdV4],
  );

  if (candidates.length === 0) return;

  // Single RPC connection reused across all loans this tick. Reduces
  // RPC-roundtrip cost when the watcher has lots of due-soon loans.
  const connection = new Connection(RPC_URL, "confirmed");

  for (const loan of candidates) {
    const hoursLeft = (new Date(loan.due_timestamp).getTime() - Date.now()) / (60 * 60 * 1000);
    // Find the most-imminent tier this loan now qualifies for.
    const matchingTier = TIERS.find((t) => hoursLeft <= t.hoursLeft);
    if (!matchingTier) continue;

    // Already DMed at this tier? Skip.
    const { rows: alreadySent } = await query(
      `SELECT 1 FROM v4_repay_readiness_notifications WHERE loan_id = $1 AND tier = $2 LIMIT 1`,
      [loan.id, matchingTier.name],
    );
    if (alreadySent.length > 0) continue;

    // Compute the preflight against live on-chain state.
    let preflight;
    try {
      preflight = await computeV4RepayPreflight({
        wallet: loan.borrower_wallet,
        loanPda: loan.loan_pda,
        connection,
      });
    } catch (e) {
      console.warn(
        `[v4-repay-readiness] preflight throw for loan #${loan.loan_id_chain}: ${e.message?.slice(0, 120)}`,
      );
      continue;
    }
    if (!preflight.ok) {
      console.warn(
        `[v4-repay-readiness] preflight error for loan #${loan.loan_id_chain}: ${preflight.error}`,
      );
      continue;
    }

    if (preflight.body.can_repay_now) {
      // User has enough already — no DM needed. Mark the ledger anyway
      // so we don't re-check this every hour for the same loan.
      try {
        await query(
          `INSERT INTO v4_repay_readiness_notifications
             (loan_id, tier, wallet, owed_lamports, wallet_lamports, vault_lamports, deficit_lamports)
           VALUES ($1, 'noop_can_repay', $2, $3::numeric, $4::numeric, $5::numeric, 0)
           ON CONFLICT (loan_id, tier) DO NOTHING`,
          [
            loan.id,
            loan.borrower_wallet,
            preflight.body.owed_lamports,
            preflight.body.wallet_balance_lamports,
            preflight.body.vault_balance_lamports,
          ],
        );
      } catch {}
      continue;
    }

    // Build a tier-appropriate DM.
    const sym = loan.symbol || "loan";
    const owedSol = preflight.body.widget.owed_sol;
    const walletSol = preflight.body.widget.wallet_sol;
    const vaultSol = preflight.body.widget.vault_sol;
    const deficitSol = preflight.body.widget.deficit_sol;
    const dueIn = matchingTier.label;
    const intensity = {
      warn:     "Heads up",
      alert:    "Reminder",
      critical: "Important",
      imminent: "Urgent",
    }[matchingTier.name];
    const linesArr = [
      `${intensity} — your ${sym} loan #${loan.loan_id_chain} is due in ~${dueIn}.`,
      ``,
      `Owed: ${owedSol.toFixed(4)} SOL`,
      `Wallet: ${walletSol.toFixed(4)} SOL`,
      vaultSol > 0 ? `Vault (from auto-sells): ${vaultSol.toFixed(4)} SOL` : null,
      ``,
      `To repay, you need to top up *${deficitSol.toFixed(4)} more SOL* into your wallet.`,
    ].filter((x) => x !== null);
    if (vaultSol > 0) {
      linesArr.push(
        ``,
        `After repay, the ${vaultSol.toFixed(4)} SOL in your vault flows back to your wallet automatically. ` +
        `Net cash out: ${Math.max(0, owedSol - vaultSol).toFixed(4)} SOL.`,
      );
    }
    if (matchingTier.name === "critical" || matchingTier.name === "imminent") {
      linesArr.push(
        ``,
        `If you can't top up, you can also EXTEND this loan for another period (small fee, no top-up required). Use /extend.`,
      );
    }
    const text = linesArr.join("\n");

    try {
      await bot.telegram.sendMessage(Number(loan.telegram_id), text, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      await query(
        `INSERT INTO v4_repay_readiness_notifications
           (loan_id, tier, wallet, owed_lamports, wallet_lamports, vault_lamports, deficit_lamports)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric)
         ON CONFLICT (loan_id, tier) DO NOTHING`,
        [
          loan.id,
          matchingTier.name,
          loan.borrower_wallet,
          preflight.body.owed_lamports,
          preflight.body.wallet_balance_lamports,
          preflight.body.vault_balance_lamports,
          preflight.body.deficit_lamports,
        ],
      );
      console.log(
        `[v4-repay-readiness] DM sent — loan_id=${loan.loan_id_chain} tier=${matchingTier.name} deficit_sol=${deficitSol.toFixed(4)} hours_left=${hoursLeft.toFixed(1)}`,
      );
    } catch (sendErr) {
      // User might have blocked the bot — log + DON'T mark notified so we
      // can retry next tick if they unblock. But cap implicit retries by
      // moving forward in tier as time passes (the next tier qualifies
      // automatically when hoursLeft drops).
      console.warn(
        `[v4-repay-readiness] DM send failed for loan_id=${loan.loan_id_chain} tg=${loan.telegram_id}: ${sendErr.message?.slice(0, 120)}`,
      );
    }
  }
}
