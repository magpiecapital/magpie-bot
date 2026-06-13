/**
 * Engine topup wallet balance monitor — P0 from LIMIT_CLOSE_ENGINE_AUDIT.md.
 *
 * The limit-close engine's ENGINE_TOPUP_KEYPAIR funds 0.03 SOL per fire
 * to top up borrower wallets so they can pay tx fees. If this wallet
 * drains overnight, the engine's ensureSolReserve fails on every fire
 * and orders revert to armed with topup_transfer_failed reason. Users
 * never get their fires; ops doesn't know until users complain.
 *
 * This watcher polls the topup wallet balance and DMs the operator
 * when it crosses tiered thresholds, BEFORE the drain becomes a
 * customer issue.
 *
 * Parallel to lender-balance-watcher.js but for the engine's wallet.
 * Designed identically: same alert tiering, same anti-spam, same
 * recovery semantics.
 */
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { connection } from "../solana/connection.js";
import { getAdminId } from "./admin-notify.js";

const POLL_INTERVAL_MS = Number(process.env.ENGINE_TOPUP_WATCH_MS) || 30 * 60 * 1000; // 30 min

// Tiered thresholds — alert once per tier crossing.
// At 0.03 SOL per fire, the headroom translates to:
//   5 SOL = ~150 fires before drain
//   3 SOL = ~100 fires
//   1 SOL = ~33 fires
//   0.3 SOL = ~10 fires — emergency
const THRESHOLDS = [
  { lamports: 5_000_000_000n, level: "🟡 LOW",      action: "Top up within 24h" },
  { lamports: 3_000_000_000n, level: "🟠 CRITICAL", action: "Top up within 6h — engine fires will start failing soon" },
  { lamports: 1_000_000_000n, level: "🔴 EMERGENCY", action: "Engine fires WILL FAIL imminently. Send SOL to the topup wallet NOW." },
];

let lastAlertedAt = 0;
let lastAlertedTier = null;

function loadTopupPubkey() {
  const secret = process.env.ENGINE_TOPUP_KEYPAIR;
  if (!secret) return null;
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(secret));
    return kp.publicKey;
  } catch (err) {
    console.warn("[engine-topup-watch] keypair parse failed:", err.message?.slice(0, 80));
    return null;
  }
}

async function tick(bot) {
  const adminTgId = getAdminId();
  if (!adminTgId || !bot) return;

  const topupPubkey = loadTopupPubkey();
  if (!topupPubkey) return; // env not set on this deploy; engine fires not gated by this bot anyway

  let lamports;
  try {
    lamports = BigInt(await connection.getBalance(topupPubkey));
  } catch (err) {
    console.warn("[engine-topup-watch] balance fetch failed:", err.message);
    return;
  }

  const crossed = THRESHOLDS.find((t) => lamports < t.lamports);
  if (!crossed) {
    lastAlertedTier = null;
    return;
  }

  // Same-tier dedupe — same pattern as lender-balance-watcher.
  const now = Date.now();
  const sinceLast = now - lastAlertedAt;
  const tierEscalated = lastAlertedTier && THRESHOLDS.indexOf(crossed) > THRESHOLDS.indexOf(lastAlertedTier);
  const enoughTimeElapsed = sinceLast > 12 * 60 * 60 * 1000;
  if (lastAlertedTier === crossed && !tierEscalated && !enoughTimeElapsed) return;

  const sol = (Number(lamports) / 1e9).toFixed(4);
  const fires = Math.floor(Number(lamports) / 30_000_000); // ENGINE_TOPUP_LAMPORTS = 0.03 SOL
  try {
    await bot.api.sendMessage(
      adminTgId,
      [
        `${crossed.level} *Engine topup wallet balance alert*`,
        "",
        `Current: \`${sol} SOL\` (~${fires} fires of headroom)`,
        `Wallet: \`${topupPubkey.toBase58()}\``,
        "",
        `Action: ${crossed.action}`,
        "",
        `Purpose: this wallet funds 0.03 SOL per limit-close fire so the borrower can pay tx fees. If it drains, every fire reverts with topup_transfer_failed and no orders execute.`,
        "",
        `Top up: send SOL directly to \`${topupPubkey.toBase58()}\` from any wallet.`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
    lastAlertedAt = now;
    lastAlertedTier = crossed;
  } catch (err) {
    console.warn("[engine-topup-watch] DM failed:", err.message?.slice(0, 80));
  }
}

export function startEngineTopupWatcher(bot) {
  if (!process.env.ENGINE_TOPUP_KEYPAIR) {
    console.log("[engine-topup-watch] ENGINE_TOPUP_KEYPAIR not set — watcher idle");
    return;
  }
  console.log(`[engine-topup-watch] started; polling every ${POLL_INTERVAL_MS / 60_000}min`);
  // Initial tick after a short delay so it doesn't block startup.
  setTimeout(() => tick(bot).catch((e) => console.error("[engine-topup-watch] tick:", e.message)), 30_000);
  setInterval(() => tick(bot).catch((e) => console.error("[engine-topup-watch] tick:", e.message)), POLL_INTERVAL_MS);
}
