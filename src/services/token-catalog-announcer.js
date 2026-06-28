/**
 * token-catalog-announcer.js — auto-announces @MagpieLoans when a token is
 * ADDED or REMOVED from the approved-collateral catalog (the /tokens page).
 *
 * DESIGN (reconciliation worker, matching the protocol-uniformity pattern):
 * every tick we read the live supported_mints.enabled set and diff it
 * against token_catalog_announce_state (migration 089). A disabled→enabled
 * flip = "added" tweet; enabled→disabled = "removed" tweet. Because we diff
 * STATE rather than hook the screener's code paths, this catches EVERY
 * change — the RWA screener's auto-add/auto-disable, a manual /tier, an
 * admin disable — so the X feed can never drift from /tokens.
 *
 * SAFETY:
 *  - First run (empty state table) SEEDS every mint silently — deploying
 *    this never tweet-storms the existing catalog. Only post-seed changes
 *    announce.
 *  - Per-tick announce cap (anti-spam) — if many mints flip at once (a bulk
 *    backfill or a screener mass-disable) we post at most N and seed the
 *    rest silently, so we never look like a spam bot.
 *  - Idempotent — the state row is upserted in the same pass as the post,
 *    so a crash/restart never re-tweets an already-announced change.
 *  - Symbol SANITIZATION — a token symbol is attacker-influenceable, so it
 *    is stripped to a safe charset + length before it ever enters a tweet
 *    (no newline/URL/@handle/$cashtag injection into our public feed).
 *  - Read-only on supported_mints; writes ONLY its own state table. Never
 *    touches loans/collateral/user state.
 */
import { query } from "../db/pool.js";
import { postTweet, xPosterConfigured } from "./x-poster.js";
import { crosspostTweet } from "./community-x-crosspost.js";

const POLL_MS = Number(process.env.TOKEN_ANNOUNCE_POLL_MS || 5 * 60_000);
const MAX_PER_TICK = Number(process.env.TOKEN_ANNOUNCE_MAX_PER_TICK || 3);
// Removals are NOT announced (operator 2026-06-28: "only post about new
// approvals" — a "$X is no longer accepted" post like $SPETTRO reads as bad
// news and isn't wanted). Default OFF; opt back in with
// TOKEN_ANNOUNCE_REMOVALS=true. When off, a disabled mint is recorded silently
// (no X tweet, no TG post) so the catalog state still tracks it.
const ANNOUNCE_REMOVALS = process.env.TOKEN_ANNOUNCE_REMOVALS === "true";
const TOKENS_URL = "https://www.magpie.capital/tokens";

// Bot API handle — set by startTokenCatalogAnnouncer(bot). When present,
// every tweet we post is ALSO autonomously cross-posted into the Magpie
// community TG chats via the shared /crosspost primitive (operator 2026-06-28).
let _botApi = null;

/** Strip a token symbol to a tweet-safe token. Removes anything that could
 *  hijack the post (newlines, @, #, $, URLs, control chars) and caps length.
 *  Returns "" if nothing safe remains (caller falls back to neutral copy).
 *  SECURITY (audit 2026-06-28): also drop '.' and spaces — an attacker-controlled
 *  symbol like "evilsite.com" otherwise survives and X AUTO-LINKIFIES it into a
 *  clickable phishing link on the verified @MagpieLoans feed. Charset is now
 *  strictly [A-Za-z0-9_-], which cannot form a linkifiable URL/handle/cashtag. */
function safeSymbol(raw) {
  return String(raw || "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 16);
}

function isRwaCategory(category) {
  return category === "stock" || category === "rwa";
}

function composeAdded(row) {
  const sym = safeSymbol(row.symbol);
  const label = sym ? `$${sym}` : "A new token";
  const kind = isRwaCategory(row.category) ? "tokenized stock / RWA" : "token";
  return (
    `🦅 New collateral on Magpie\n\n` +
    `${label} (${kind}) is now borrowable — deposit it, borrow SOL against it, and set auto-sell exits that fire in-vault.\n\n` +
    `All approved collateral → ${TOKENS_URL}`
  );
}

function composeRemoved(row) {
  const sym = safeSymbol(row.symbol);
  const label = sym ? `$${sym}` : "A token";
  return (
    `Collateral update on Magpie\n\n` +
    `${label} is no longer accepted as NEW collateral. Existing loans are unaffected and continue under their original terms.\n\n` +
    `Current approved collateral → ${TOKENS_URL}`
  );
}

async function upsertState(row, enabled, changeType, tweetId) {
  await query(
    `INSERT INTO token_catalog_announce_state
        (mint, symbol, category, last_enabled, last_change_type, last_announced_at, last_tweet_id, updated_at)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $5 IN ('added','removed') THEN now() ELSE NULL END,
             $6, now())
     ON CONFLICT (mint) DO UPDATE SET
        symbol            = EXCLUDED.symbol,
        category          = EXCLUDED.category,
        last_enabled      = EXCLUDED.last_enabled,
        last_change_type  = EXCLUDED.last_change_type,
        last_announced_at = COALESCE(EXCLUDED.last_announced_at, token_catalog_announce_state.last_announced_at),
        last_tweet_id     = COALESCE(EXCLUDED.last_tweet_id, token_catalog_announce_state.last_tweet_id),
        updated_at        = now()`,
    [row.mint, row.symbol ?? null, row.category ?? null, enabled, changeType, tweetId],
  );
}

async function tick() {
  const { rows: current } = await query(
    `SELECT mint, symbol, category, enabled FROM supported_mints`,
  );
  const { rows: stateRows } = await query(
    `SELECT mint, last_enabled FROM token_catalog_announce_state`,
  );
  const stateMap = new Map(stateRows.map((r) => [r.mint, r.last_enabled]));
  const firstRun = stateRows.length === 0;

  // Collect real transitions first; seed everything else silently.
  const transitions = [];
  for (const row of current) {
    const prev = stateMap.get(row.mint);
    if (prev === undefined) {
      // Never tracked. On first run, seed silently. After first run, a
      // brand-new ENABLED mint is a genuine "added"; a new disabled mint
      // just seeds (nothing to announce).
      if (firstRun || !row.enabled) {
        await upsertState(row, row.enabled, "seed", null);
      } else {
        transitions.push({ row, type: "added" });
      }
    } else if (prev !== row.enabled) {
      transitions.push({ row, type: row.enabled ? "added" : "removed" });
    }
  }

  let posted = 0;
  for (const t of transitions) {
    if (t.type === "removed" && !ANNOUNCE_REMOVALS) {
      await upsertState(t.row, t.row.enabled, "seed", null); // record silently
      continue;
    }
    if (posted >= MAX_PER_TICK) {
      // Anti-spam overflow — record the new state so we don't re-announce,
      // but skip the tweet. (Mass flips shouldn't tweet-storm.)
      await upsertState(t.row, t.row.enabled, "seed_overflow", null);
      continue;
    }
    const text = t.type === "added" ? composeAdded(t.row) : composeRemoved(t.row);
    const res = await postTweet(text);
    await upsertState(
      t.row,
      t.row.enabled,
      res.ok ? t.type : `${t.type}_failed`,
      res.tweetId ?? null,
    );
    if (res.ok) posted++;

    // AUTONOMOUS TG ANNOUNCEMENT (operator 2026-06-28): the community MUST get
    // every catalog change in MagPie Talk REGARDLESS of X's state. The X
    // account can be credit-depleted (402 CreditsDepleted) — and we never want
    // that to silence the TG announcement. So this is DECOUPLED from the tweet:
    //   • tweet succeeded → cross-post its card (richer, renders inline)
    //   • tweet failed/skipped (no creds, 402, rate-limit) → post the
    //     announcement TEXT directly so MagPie Talk still gets it.
    // Best-effort: a TG failure never blocks the announce loop or state write.
    if (_botApi) {
      try {
        if (res.ok && res.tweetId) {
          await crosspostTweet(
            _botApi,
            `https://x.com/MagpieLoans/status/${res.tweetId}`,
            "auto",
          );
        } else {
          await postAnnouncementToCommunity(_botApi, text);
        }
      } catch (e) {
        console.warn(
          `[token-announcer] TG announce failed: ${e.message?.slice(0, 120)}`,
        );
      }
    }
  }

  if (transitions.length > 0) {
    console.log(
      `[token-announcer] ${transitions.length} catalog change(s); ${posted} tweeted` +
        (firstRun ? " (first run seeded silently)" : ""),
    );
  }
}

/** Post the announcement TEXT directly to the enabled community chats
 *  (MagPie Talk). Used as the fallback when the tweet didn't post (X
 *  credit-depleted / rate-limited / no creds) so the community is never
 *  starved of a catalog change. Plain text (no parse_mode) so a token
 *  symbol containing a Markdown char can never break or hijack the post;
 *  Telegram still auto-links the /tokens URL and renders its preview. */
async function postAnnouncementToCommunity(botApi, text) {
  const { listEnabledChats } = await import("./community-moderation.js");
  let chats = [];
  try { chats = await listEnabledChats(); } catch (e) {
    console.warn(`[token-announcer] listEnabledChats failed: ${e.message?.slice(0, 90)}`);
    return;
  }
  for (const c of chats) {
    try {
      await botApi.sendMessage(Number(c.chat_id), text, { disable_web_page_preview: false });
    } catch (e) {
      console.warn(`[token-announcer] TG send to ${c.chat_id} failed: ${e.message?.slice(0, 90)}`);
    }
  }
}

export function startTokenCatalogAnnouncer(bot) {
  _botApi = bot?.api ?? null;
  // Run the loop even WITHOUT X creds so the state table tracks the catalog
  // (seeding). Then the day creds are added, only FUTURE changes announce —
  // never a backlog dump of everything that changed while creds were absent.
  const run = () =>
    tick().catch((e) =>
      console.warn("[token-announcer] tick failed:", e.message?.slice(0, 160)),
    );
  setTimeout(run, 60_000); // delayed first run (let boot settle)
  setInterval(run, POLL_MS);
  console.log(
    `[token-announcer] armed — polls every ${Math.round(POLL_MS / 1000)}s; ` +
      `X posting ${xPosterConfigured() ? "ENABLED" : "disabled (no creds — seeding only)"}; ` +
      `TG mirror ${_botApi ? "ENABLED (MagPie Talk always gets the post, even if X is depleted)" : "disabled (no bot)"}; ` +
      `removals ${ANNOUNCE_REMOVALS ? "on" : "off"}`,
  );
}
