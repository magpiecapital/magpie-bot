/**
 * Funding-graph tracer + sybil-ban extension.
 *
 * When the exploit-detector (or operator) auto-bans a wallet, this
 * service traces its recent on-chain SOL inflows, identifies the
 * funding sources, filters out exchanges / well-known infrastructure
 * pubkeys, and bans the remaining funders. This defeats the simple
 * wallet-swap evasion (attacker creates a new wallet, funds from the
 * same source as the banned one, comes back).
 *
 * The traversal is deliberately shallow (single hop, last 7 days)
 * because deeper hops false-positive: every wallet eventually traces
 * back to a CEX, and we don't want to ban CEX hot wallets. One hop
 * catches the attacker's funding rail without that risk.
 *
 * All actions logged to funding_traces for auditability. Manual unban
 * (`/unban_wallet <pubkey>`) is the operator escape hatch if a
 * heuristic misfires.
 *
 * Safety:
 *   - Hard cap on number of funders banned per trace (default 5).
 *   - Min lamports threshold — dust transfers are ignored.
 *   - CEX/infra allowlist (Binance, Coinbase, Jupiter, etc.) is
 *     consulted before banning anything.
 *   - All RPC calls fail-soft — a failed trace logs and returns,
 *     never blocks the calling auto-ban.
 */
import { PublicKey } from "@solana/web3.js";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";
import { banWallet, isWalletBanned } from "./bans.js";

const TRACE_LOOKBACK_DAYS = Math.max(
  1,
  Number(process.env.FUNDING_GRAPH_LOOKBACK_DAYS) || 7,
);
const MIN_FUNDING_LAMPORTS = BigInt(
  Math.floor((Number(process.env.FUNDING_GRAPH_MIN_SOL) || 0.05) * 1e9),
);
const MAX_FUNDERS_PER_TRACE = Math.max(
  1,
  Math.min(20, Number(process.env.FUNDING_GRAPH_MAX_FUNDERS) || 5),
);
const MAX_SIGS_PER_FETCH = 100;

const DISABLED = process.env.FUNDING_GRAPH_DISABLED === "true";

/**
 * Well-known pubkeys we should NEVER auto-ban. Centralized exchanges,
 * common DEX routers, native programs. False positives here would be
 * catastrophic.
 *
 * (This list is conservative — adding to it is reversible; banning a
 * CEX hot wallet would burn legit users.)
 */
const NEVER_BAN = new Set([
  // Native + common programs
  "11111111111111111111111111111111", // System
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // ATA
  "ComputeBudget111111111111111111111111111111",
  // Binance hot wallets (public-knowledge addresses)
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S",
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "FxteHmLwG9nk1eL4pjNve3Eub2goGkkz6g6TbvdmW46a",
  // Coinbase
  "BSAcZS97jaW73tQGHwUgmTZNphjg7s58yQGKzqsZv5Sb",
  // Kraken
  "FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5",
  // Crypto.com
  "6QJzieMYfp7yr3EdrePaQoG3Ghxs2wM98xSLRu8Xh56U",
  // Jupiter aggregator
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
  // Magpie's own lender + keeper — never auto-ban our own infrastructure
  process.env.LENDER_PUBKEY || "",
  process.env.KEEPER_PUBKEY || "",
]);

function shouldNeverBan(pubkeyStr) {
  if (!pubkeyStr) return true;
  if (NEVER_BAN.has(pubkeyStr)) return true;
  return false;
}

async function logTrace({ tracedWallet, funder, lamports, txSig, blockTime, action }) {
  try {
    await query(
      `INSERT INTO funding_traces
         (traced_wallet, funder_wallet, lamports_received, tx_signature, block_time, action)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(tracedWallet),
        String(funder),
        lamports.toString(),
        txSig ?? null,
        blockTime ? new Date(blockTime * 1000) : null,
        action,
      ],
    );
  } catch (err) {
    console.warn("[funding-graph] log failed:", err.message);
  }
}

/**
 * Trace a single wallet's SOL inflows over the lookback window.
 * Returns a Map<funderPubkey, { lamports, lastTxSig, lastBlockTime }>.
 *
 * Uses connection.getSignaturesForAddress + getParsedTransaction.
 * This costs RPC credits — caller should rate-limit invocations.
 */
async function traceInflows(walletPubkey) {
  const pk = new PublicKey(walletPubkey);
  const cutoff = Math.floor(Date.now() / 1000) - TRACE_LOOKBACK_DAYS * 24 * 60 * 60;

  const sigs = await connection.getSignaturesForAddress(pk, { limit: MAX_SIGS_PER_FETCH });
  const relevantSigs = sigs.filter((s) => (s.blockTime ?? 0) >= cutoff && !s.err);
  const funders = new Map(); // funder → { lamports, lastTxSig, lastBlockTime }

  for (const sigInfo of relevantSigs) {
    let tx;
    try {
      tx = await connection.getParsedTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      continue;
    }
    if (!tx?.meta || !tx.transaction) continue;

    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.pubkey.toBase58(),
    );
    const tracedIdx = accountKeys.indexOf(walletPubkey);
    if (tracedIdx === -1) continue;

    const preBal = tx.meta.preBalances[tracedIdx] ?? 0;
    const postBal = tx.meta.postBalances[tracedIdx] ?? 0;
    const delta = postBal - preBal;
    if (delta <= 0) continue; // wallet sent or paid fees; not an inflow

    // Identify the funder: the account whose balance decreased by
    // (roughly) the inflow amount. Pick the largest decrease.
    let funder = null;
    let largestDecrease = 0;
    for (let i = 0; i < accountKeys.length; i++) {
      if (i === tracedIdx) continue;
      const pre = tx.meta.preBalances[i] ?? 0;
      const post = tx.meta.postBalances[i] ?? 0;
      const decrease = pre - post;
      if (decrease > largestDecrease) {
        largestDecrease = decrease;
        funder = accountKeys[i];
      }
    }
    if (!funder) continue;

    const lamports = BigInt(delta);
    const prev = funders.get(funder);
    if (prev) {
      prev.lamports += lamports;
      if ((sigInfo.blockTime ?? 0) > (prev.lastBlockTime ?? 0)) {
        prev.lastTxSig = sigInfo.signature;
        prev.lastBlockTime = sigInfo.blockTime;
      }
    } else {
      funders.set(funder, {
        lamports,
        lastTxSig: sigInfo.signature,
        lastBlockTime: sigInfo.blockTime,
      });
    }
  }

  return funders;
}

/**
 * Trace the given wallet's funding sources and ban any meaningful
 * funder that isn't on the NEVER_BAN list.
 *
 * Returns { banned: [], skipped: [] } for caller visibility.
 *
 * @param {string} walletPubkey  the wallet we already banned
 * @param {string} reason        ban reason copied to the funders
 * @param {string} relatedUserId optional — links the funder ban back
 *                                 to the same user audit trail
 */
export async function traceAndBanFunders(walletPubkey, reason, relatedUserId = null) {
  if (DISABLED) {
    console.log(`[funding-graph] disabled — skipping trace for ${walletPubkey}`);
    return { banned: [], skipped: [], disabled: true };
  }
  if (!walletPubkey) return { banned: [], skipped: [] };

  let funders;
  try {
    funders = await traceInflows(walletPubkey);
  } catch (err) {
    console.error(`[funding-graph] trace failed for ${walletPubkey}: ${err.message}`);
    return { banned: [], skipped: [], error: err.message };
  }

  // Sort by lamports desc, take the top N candidates.
  const ranked = [...funders.entries()]
    .sort((a, b) => Number(b[1].lamports - a[1].lamports))
    .slice(0, MAX_FUNDERS_PER_TRACE);

  const banned = [];
  const skipped = [];

  for (const [funder, info] of ranked) {
    if (info.lamports < MIN_FUNDING_LAMPORTS) {
      await logTrace({
        tracedWallet: walletPubkey,
        funder,
        lamports: info.lamports,
        txSig: info.lastTxSig,
        blockTime: info.lastBlockTime,
        action: "skipped_cex", // reuse — could split but the dust case is rare
      });
      skipped.push({ funder, reason: "below_min" });
      continue;
    }
    if (shouldNeverBan(funder)) {
      await logTrace({
        tracedWallet: walletPubkey,
        funder,
        lamports: info.lamports,
        txSig: info.lastTxSig,
        blockTime: info.lastBlockTime,
        action: "skipped_cex",
      });
      skipped.push({ funder, reason: "never_ban_list" });
      continue;
    }
    if (await isWalletBanned(funder)) {
      await logTrace({
        tracedWallet: walletPubkey,
        funder,
        lamports: info.lamports,
        txSig: info.lastTxSig,
        blockTime: info.lastBlockTime,
        action: "skipped_already_banned",
      });
      skipped.push({ funder, reason: "already_banned" });
      continue;
    }
    try {
      await banWallet({
        pubkey: funder,
        reason: `funding-graph: traced from ${walletPubkey.slice(0, 8)}… — ${reason}`,
        bannedBy: "funding-graph",
        relatedUserId,
        notes: `inflow ${(Number(info.lamports) / 1e9).toFixed(4)} SOL via ${info.lastTxSig?.slice(0, 16)}…`,
      });
      await logTrace({
        tracedWallet: walletPubkey,
        funder,
        lamports: info.lamports,
        txSig: info.lastTxSig,
        blockTime: info.lastBlockTime,
        action: "banned",
      });
      banned.push(funder);
    } catch (err) {
      console.warn(`[funding-graph] ban funder ${funder} failed: ${err.message}`);
    }
  }

  return { banned, skipped };
}
