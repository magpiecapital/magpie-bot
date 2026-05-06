/**
 * Deposit watcher.
 *
 * Polls every custodial wallet at a fixed interval, diffs against the
 * `wallet_balances` table, and DMs the user when a positive delta appears
 * for SOL or a supported SPL mint.
 *
 * Design notes:
 * - We only record/notify for mints the user already holds OR the SOL
 *   sentinel. Untracked SPL mints are stored as 0 on first sight and
 *   announced on subsequent increases (so the first deposit is still caught).
 * - Decreases (withdraws, borrows) update the stored amount silently.
 * - All writes happen in a transaction per-user to avoid races with other
 *   bot operations that touch the same wallet.
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "../solana/connection.js";
import { query, pool } from "../db/pool.js";
import { getPrefs } from "./prefs.js";
import { maybeAutoRepay } from "./auto-repay.js";

const SOL_SENTINEL = "SOL";
const POLL_INTERVAL_MS = Number(process.env.DEPOSIT_POLL_MS) || 60_000;

function fmt(raw, decimals) {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

async function snapshotWallet(walletPubkey) {
  const owner = new PublicKey(walletPubkey);
  const [lamports, std, t22] = await Promise.all([
    connection.getBalance(owner),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const snapshot = new Map();
  snapshot.set(SOL_SENTINEL, { rawAmount: BigInt(lamports), decimals: 9 });
  for (const acc of [...std.value, ...t22.value]) {
    const info = acc.account.data.parsed.info;
    const raw = BigInt(info.tokenAmount.amount);
    const prev = snapshot.get(info.mint)?.rawAmount ?? 0n;
    snapshot.set(info.mint, {
      rawAmount: prev + raw,
      decimals: info.tokenAmount.decimals,
    });
  }
  return snapshot;
}

async function getSupportedMintsMap() {
  const { rows } = await query(
    `SELECT mint, symbol, decimals FROM supported_mints WHERE enabled = TRUE`,
  );
  const m = new Map();
  for (const r of rows) m.set(r.mint, r);
  return m;
}

async function processWallet(bot, user, supportedMints) {
  let snapshot;
  try {
    snapshot = await snapshotWallet(user.public_key);
  } catch (err) {
    console.error(`[deposit-watcher] snapshot failed for ${user.public_key}: ${err.message}`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: prevRows } = await client.query(
      `SELECT mint, raw_amount FROM wallet_balances WHERE user_id = $1`,
      [user.id],
    );
    const prev = new Map(prevRows.map((r) => [r.mint, BigInt(r.raw_amount)]));

    const notifications = [];

    for (const [mint, data] of snapshot.entries()) {
      const prevAmount = prev.get(mint) ?? 0n;
      const delta = data.rawAmount - prevAmount;

      if (delta > 0n && prev.has(mint)) {
        // Known mint with positive delta — this is a deposit.
        if (mint === SOL_SENTINEL) {
          notifications.push({ symbol: "SOL", delta, decimals: 9 });
        } else if (supportedMints.has(mint)) {
          const meta = supportedMints.get(mint);
          notifications.push({ symbol: meta.symbol, delta, decimals: meta.decimals });
        }
      }

      if (data.rawAmount !== prevAmount) {
        await client.query(
          `INSERT INTO wallet_balances (user_id, mint, raw_amount, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id, mint)
           DO UPDATE SET raw_amount = EXCLUDED.raw_amount, updated_at = NOW()`,
          [user.id, mint, data.rawAmount.toString()],
        );
      }
    }

    await client.query("COMMIT");

    if (notifications.length > 0) {
      const prefs = await getPrefs(user.id);
      if (prefs.notify_deposits) {
        for (const n of notifications) {
          const msg = `💵 *Deposit received*\n\n+${fmt(n.delta, n.decimals)} ${n.symbol}`;
          try {
            await bot.api.sendMessage(user.telegram_id, msg, { parse_mode: "Markdown" });
          } catch (err) {
            console.error(`[deposit-watcher] DM failed for ${user.telegram_id}: ${err.message}`);
          }
        }
      }

      // If this batch included a SOL deposit, consider triggering auto-repay.
      const hadSolDeposit = notifications.some((n) => n.symbol === "SOL");
      if (hadSolDeposit) {
        await maybeAutoRepay(bot, {
          userId: user.id,
          telegramId: user.telegram_id,
          publicKey: user.public_key,
        });
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[deposit-watcher] db error for user ${user.id}: ${err.message}`);
  } finally {
    client.release();
  }
}

export function startDepositWatcher(bot) {
  console.log(`👀 Deposit watcher running (every ${POLL_INTERVAL_MS / 1000}s)`);

  let running = false;
  const tick = async () => {
    if (running) return; // skip overlapping cycles
    running = true;
    try {
      const [walletsRes, supportedMints] = await Promise.all([
        query(
          `SELECT u.id, u.telegram_id, w.public_key
           FROM users u JOIN wallets w ON w.user_id = u.id`,
        ),
        getSupportedMintsMap(),
      ]);
      const users = walletsRes.rows;
      // Process sequentially to stay within free RPC rate limits.
      for (const u of users) {
        await processWallet(bot, u, supportedMints);
      }
    } catch (err) {
      console.error("[deposit-watcher] cycle error:", err.message);
    } finally {
      running = false;
    }
  };

  tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}
