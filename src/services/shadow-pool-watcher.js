/**
 * Shadow LendingPool detective control.
 *
 * The 2026-06-10 deep audit identified a structural issue in the live Anchor
 * program: the Loan PDA has no `pool` field binding it to the canonical
 * LendingPool, and InitializeLendingPool has no admin gate, which means any
 * wallet can create a "shadow" LendingPool with themselves as `lender` and
 * then substitute it in repay/liquidate/extend calls to drain collateral and
 * principal. The structural fix lives in a v3 program (external-audit-gated).
 *
 * Until v3 ships, this watcher is the detective control: poll mainnet for
 * LendingPool accounts owned by the program; alert the operator immediately
 * if any LendingPool exists with a `lender` field that is NOT the canonical
 * operator pubkey. Time-to-detect is on the order of the poll interval.
 *
 * Read-only. No on-chain writes. Operator DM only.
 */

import { PublicKey } from "@solana/web3.js";
import { connection } from "../solana/connection.js";

// LendingPool struct (from bagbank-program/programs/magpie/src/state.rs):
//   8  bytes  Anchor discriminator
//   32 bytes  lender              <- the field we check
//   32 bytes  loan_token_vault
//   32 bytes  fee_wallet
//   8  bytes  total_loans_issued
//   8  bytes  total_liquidations
//   1  byte   bump
// Total: 121 bytes
const LENDING_POOL_DISCRIMINATOR = Buffer.from([208, 40, 242, 82, 186, 18, 75, 36]);
const LENDER_OFFSET = 8;
const LENDER_LEN = 32;
const LENDING_POOL_ACCOUNT_SIZE = 121;

const POLL_INTERVAL_MS = Math.max(60_000, Number(process.env.SHADOW_POOL_POLL_MS) || 90_000);
const PROGRAM_ID_STR = process.env.PROGRAM_ID;
const CANONICAL_LENDER_STR = process.env.LENDER_PUBKEY;
const OPERATOR_DM_CHAT_ID = process.env.OPERATOR_DM_CHAT_ID;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// In-memory de-dup so the same shadow pool doesn't fire an alert on every
// tick. Maps shadow_pool_pubkey -> first_seen_iso. Cleared on restart, which
// is fine — restart re-alerts, ensuring operator never silently loses the
// signal if the bot crashed before they read the first alert.
const _firedAlerts = new Map();

async function operatorDm(text) {
  if (!OPERATOR_DM_CHAT_ID || !BOT_TOKEN) {
    console.error("[shadow-pool-watcher] OPERATOR_DM_CHAT_ID or TELEGRAM_BOT_TOKEN unset — alerts cannot fire. Set them in Railway env.");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: OPERATOR_DM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
    const body = await res.json();
    if (!body.ok) {
      console.error("[shadow-pool-watcher] telegram error:", body.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[shadow-pool-watcher] DM send failed:", err.message);
    return false;
  }
}

async function tick() {
  if (!PROGRAM_ID_STR || !CANONICAL_LENDER_STR) {
    console.error("[shadow-pool-watcher] PROGRAM_ID or LENDER_PUBKEY unset — watcher cannot run.");
    return;
  }

  let programId;
  let canonicalLender;
  try {
    programId = new PublicKey(PROGRAM_ID_STR);
    canonicalLender = new PublicKey(CANONICAL_LENDER_STR);
  } catch (err) {
    console.error("[shadow-pool-watcher] PROGRAM_ID or LENDER_PUBKEY is not a valid pubkey:", err.message);
    return;
  }

  let accounts;
  try {
    accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { dataSize: LENDING_POOL_ACCOUNT_SIZE },
        {
          memcmp: {
            offset: 0,
            bytes: LENDING_POOL_DISCRIMINATOR.toString("base64"),
            encoding: "base64",
          },
        },
      ],
    });
  } catch (err) {
    console.error("[shadow-pool-watcher] getProgramAccounts failed:", err.message);
    return;
  }

  const shadows = [];
  for (const { pubkey, account } of accounts) {
    const lenderBytes = account.data.subarray(LENDER_OFFSET, LENDER_OFFSET + LENDER_LEN);
    const lender = new PublicKey(lenderBytes);
    if (!lender.equals(canonicalLender)) {
      shadows.push({ pool: pubkey.toBase58(), lender: lender.toBase58() });
    }
  }

  if (shadows.length === 0) return;

  for (const s of shadows) {
    if (_firedAlerts.has(s.pool)) continue;
    _firedAlerts.set(s.pool, new Date().toISOString());

    const lines = [
      "SHADOW LENDING POOL DETECTED",
      "",
      "A LendingPool PDA exists on the magpie lending program with a non-canonical lender field.",
      "This is the exploit-prep signature for the loan-pool-substitution drain identified in the 2026-06-10 audit.",
      "",
      `Shadow pool: ${s.pool}`,
      `Shadow lender: ${s.lender}`,
      `Canonical lender: ${CANONICAL_LENDER_STR}`,
      "",
      "Immediate actions to consider:",
      "  1. Pause /api/v1/cosign-borrow to stop new loan exposure.",
      "  2. Inspect the shadow lender's wallet history for prior interactions with the program.",
      "  3. Alert active borrowers via DM if shadow lender shows repay/liquidate intent.",
      "",
      "This alert fires once per shadow pool per bot lifetime. Restart re-alerts.",
    ];
    await operatorDm(lines.join("\n"));
    console.warn(`[shadow-pool-watcher] ALERT FIRED: shadow pool ${s.pool} (lender ${s.lender}) — operator DM sent`);
  }
}

let _timer = null;

export function startShadowPoolWatcher() {
  if (_timer) return;
  if (!PROGRAM_ID_STR || !CANONICAL_LENDER_STR) {
    console.warn(
      "[shadow-pool-watcher] DISABLED — PROGRAM_ID or LENDER_PUBKEY is not set in env. Set both to enable.",
    );
    return;
  }
  console.log(
    `[shadow-pool-watcher] armed — polling program ${PROGRAM_ID_STR} every ${Math.round(POLL_INTERVAL_MS / 1000)}s for non-canonical LendingPool inits`,
  );
  // First tick a bit after startup so we don't race other bot init.
  setTimeout(() => {
    tick().catch((err) => console.error("[shadow-pool-watcher] tick threw:", err.message));
    _timer = setInterval(() => {
      tick().catch((err) => console.error("[shadow-pool-watcher] tick threw:", err.message));
    }, POLL_INTERVAL_MS);
  }, 30_000);
}

export function stopShadowPoolWatcher() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
