/**
 * Account-link endpoints — bridge a site-connected wallet to a TG user.
 *
 * Two surfaces, one account:
 *   - On TG: bot generates a custodial wallet under telegram_id. User has
 *     a Magpie account tied to their TG user.
 *   - On site: user connects Phantom (or any wallet). Site sees their
 *     loans (queries by wallet pubkey) but doesn't yet know about their
 *     TG account's referral code, AI conversation history, etc.
 *
 * The link flow makes both surfaces speak about the same user:
 *   1. Site: POST /api/v1/link/request {wallet} → bot stores a code,
 *      returns {code, expires_at} (15 min TTL).
 *   2. User pastes "/link <code>" in TG bot. Bot's command handler
 *      looks up the code, claims it for the user's telegram_id, adds
 *      the wallet to that user's `wallets` table.
 *   3. Site polls GET /api/v1/link/status?wallet=X → returns
 *      {linked: true, telegram_username} once the bond is formed.
 *
 * Codes are short (8 chars, mixed case + digits) for paste-friendliness.
 * Expiry of 15 min minimizes the window for guessing attacks.
 */
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import { query } from "../db/pool.js";

/**
 * Site-native account auto-bootstrap.
 *
 * The original link flow assumed every user started on Telegram and
 * later connected the site. As we migrate to site-first, that
 * assumption inverts: most new users connect Phantom on
 * magpie.capital and never touch Telegram. Forcing them through the
 * /link <code> dance just to chat with Pip is friction we don't
 * want — and it implied TG was mandatory, which it isn't.
 *
 * This helper auto-creates a Magpie user record + wallets row for
 * any site-connected wallet. The user is identified by a synthetic
 * negative telegram_id derived from a sha256 of the wallet pubkey.
 * Real TG users always have POSITIVE int64 ids; using the negative
 * half guarantees we can never collide with a real TG account.
 * Idempotent — calling repeatedly for the same wallet returns the
 * same user_id.
 *
 * TG remains a fully supported BACKUP path. A user can:
 *   - Connect on the site only (auto-bootstrap creates everything)
 *   - Connect on TG only (existing /start flow)
 *   - Use /link to bond an existing site-only account with a TG account
 *     (existing flow unchanged)
 */
function syntheticTelegramIdForWallet(walletPubkey) {
  const h = createHash("sha256").update(walletPubkey).digest();
  // Take low 6 bytes, +1 so we never produce 0, negate. 2^48 ≈ 2.8×10^14
  // distinct values — collision chance is astronomically low.
  const low48 = h.readUIntBE(0, 6);
  return -(low48 + 1);
}

export async function findOrCreateSiteUser(walletPubkey, refCode = null) {
  const synthTg = syntheticTelegramIdForWallet(walletPubkey);
  // SELECT-then-INSERT instead of ON CONFLICT — the production DB
  // has no unique constraint on users.telegram_id, so the upsert
  // syntax fails with "no unique or exclusion constraint matching
  // the ON CONFLICT specification". This pattern is race-tolerant
  // because of the wallets.public_key UNIQUE constraint below: if
  // two requests for the same wallet race, both create user rows
  // but only one wallet bond succeeds. The other user row is
  // harmless (orphaned, never referenced).
  let userId;
  const { rows: existing } = await query(
    `SELECT id FROM users WHERE telegram_id = $1 LIMIT 1`,
    [synthTg],
  );
  if (existing[0]) {
    userId = existing[0].id;
  } else {
    const { rows: inserted } = await query(
      `INSERT INTO users (telegram_id, telegram_username)
         VALUES ($1, $2)
         RETURNING id`,
      [synthTg, `site_${walletPubkey.slice(0, 8)}`],
    );
    userId = inserted[0].id;
  }
  // Bond the wallet. SELECT-then-INSERT (the wallets.public_key
  // column doesn't have a unique constraint either, so the previous
  // ON CONFLICT (public_key) syntax was failing the same way the
  // users one did). If the wallet is already linked to some user
  // (real TG or another site-native), we leave that bond untouched.
  const { rows: walletExists } = await query(
    `SELECT 1 FROM wallets WHERE public_key = $1 LIMIT 1`,
    [walletPubkey],
  );
  if (!walletExists[0]) {
    try {
      await query(
        `INSERT INTO wallets (user_id, public_key, encrypted_secret, nonce, auth_tag, source, is_active)
         VALUES ($1, $2, '', '', '', 'site_native', TRUE)`,
        [userId, walletPubkey],
      );
    } catch (err) {
      // Concurrent insert from a parallel request — safe to ignore;
      // both end up pointing at a wallet row that exists.
      if (!/duplicate|unique|already exists/i.test(err.message)) throw err;
    }
  }

  // If the caller passed a referral code, attribute this freshly-
  // bootstrapped user to the referrer. Idempotent — attribute()
  // refuses if the user is already attributed. This lets the site
  // capture ?ref=CODE from a share link and credit the referrer
  // even though the user never touched Telegram.
  if (refCode) {
    try {
      const { attribute } = await import("../services/referrals.js");
      await attribute(userId, refCode);
    } catch (err) {
      console.warn(
        `[link-status] referral attribution failed for ${walletPubkey.slice(0, 8)}…: ${err.message}`,
      );
      // Non-fatal — the user account still exists, just unattributed.
    }
  }

  return userId;
}

const CODE_LENGTH = 8;
const CODE_TTL_MS = 15 * 60 * 1000;

function generateCode() {
  // ~5 × 10^14 possible codes — guessing within 15 min is infeasible.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function isValidPubkey(pubkey) {
  if (typeof pubkey !== "string") return false;
  if (pubkey.length < 32 || pubkey.length > 44) return false;
  // Base58 alphabet check
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(pubkey);
}

/**
 * POST /api/v1/link/request
 * Body: { wallet: <pubkey> }
 * Returns: { code, expires_at } | { error }
 */
export async function handleLinkRequest(req) {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };

  // Per-IP throttle BEFORE we touch the DB. Without it, an attacker who
  // generates arbitrary pubkeys can spray link/request to fill the
  // account_link_codes table (each call writes one row + sets a 15min TTL).
  // 60/min from any single IP is generous for legitimate use (a user
  // creating a code refreshes maybe once per minute at most).
  if (!checkIpRate(ipKey(req))) {
    return { status: 429, body: { error: "Rate limit exceeded" } };
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: "Invalid JSON" } };
  }
  const wallet = body?.wallet;
  if (!isValidPubkey(wallet)) {
    return { status: 400, body: { error: "Invalid wallet pubkey" } };
  }

  // Throttle: at most 5 unclaimed codes per wallet at any time.
  const unclaimed = await query(
    `SELECT COUNT(*)::int AS n FROM account_link_codes
       WHERE wallet_pubkey = $1 AND claimed_at IS NULL AND expires_at > NOW()`,
    [wallet],
  );
  if (unclaimed.rows[0].n >= 5) {
    return { status: 429, body: { error: "Too many open link codes — claim one or wait" } };
  }

  // Generate a unique code (PK collision is astronomically unlikely with
  // 5e14 keyspace + 15 min TTL, but be safe).
  let code = generateCode();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await query(
        `INSERT INTO account_link_codes (code, wallet_pubkey, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
        [code, wallet],
      );
      break;
    } catch (err) {
      if (err.code === "23505" /* unique_violation */) {
        code = generateCode();
        continue;
      }
      throw err;
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      code,
      expires_in_seconds: Math.floor(CODE_TTL_MS / 1000),
      instruction: `Paste this in @magpie_capital_bot on Telegram: /link ${code}`,
    },
  };
}

/**
 * GET /api/v1/link/status?wallet=<pubkey>
 * Returns the user this wallet is linked to (if any). The site polls this
 * after creating a code; once the user redeems via the bot, this flips
 * to linked=true and the site UI updates.
 */
// Per-IP throttle for auto-bootstrap. Without this, an attacker can
// generate arbitrary wallet pubkeys and spray link/status to bloat
// the users + wallets tables with junk synthetic accounts. 60 calls
// per minute is plenty for normal dashboard polling but kills spray.
const PER_IP_WINDOW_MS = 60_000;
const PER_IP_MAX = 60;
const ipBuckets = new Map();

// Per-IP CREATION cap (separate, much stricter). Reading link/status
// for the same wallet should be free; what we want to bound is how
// many DISTINCT synthetic accounts a single IP can spin up. 8 per
// 24 hours covers a power user with multiple wallets + a small team
// onboarding from one office, but blocks DB-bloat spray attacks
// where an attacker generates thousands of throwaway pubkeys.
const PER_IP_CREATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const PER_IP_CREATE_MAX = 8;
const ipCreateBuckets = new Map();
function ipKey(req) {
  // SECURITY (audit finding #14): the LEFTMOST x-forwarded-for value is
  // client-SUPPLIED and spoofable — trusting xff[0] let an attacker rotate it
  // to defeat the per-IP read/create caps. Trust only the hop our OWN infra
  // appended: Railway's edge appends the real connecting IP as the rightmost
  // entry, so take the PUBLIC_TRUSTED_PROXY_HOPS-th hop from the right
  // (default 1 = rightmost), matching server.js extractClientIp.
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    const hops = xf.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) {
      const trusted = Math.max(1, parseInt(process.env.PUBLIC_TRUSTED_PROXY_HOPS || "1", 10));
      return hops[Math.max(0, hops.length - trusted)];
    }
  }
  return req.socket?.remoteAddress || "unknown";
}
function checkIpRate(ip) {
  const now = Date.now();
  const bucket = ipBuckets.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < PER_IP_WINDOW_MS);
  if (fresh.length >= PER_IP_MAX) return false;
  fresh.push(now);
  ipBuckets.set(ip, fresh);
  if (ipBuckets.size > 1000 && Math.random() < 0.004) {
    for (const [k, v] of ipBuckets.entries()) {
      if (v.length === 0 || now - v[v.length - 1] > PER_IP_WINDOW_MS) ipBuckets.delete(k);
    }
  }
  return true;
}

/**
 * Separate counter for actually-creating a synthetic account (vs just
 * reading status). Returns true if this IP is still allowed to spin
 * up a new account, false if it's hit the daily cap.
 */
function canIpCreateAccount(ip) {
  const now = Date.now();
  const bucket = ipCreateBuckets.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < PER_IP_CREATE_WINDOW_MS);
  ipCreateBuckets.set(ip, fresh);
  return fresh.length < PER_IP_CREATE_MAX;
}
function recordIpCreate(ip) {
  const now = Date.now();
  const bucket = ipCreateBuckets.get(ip) || [];
  bucket.push(now);
  ipCreateBuckets.set(ip, bucket);
  // Opportunistic eviction so the map doesn't grow unbounded.
  if (ipCreateBuckets.size > 5000 && Math.random() < 0.002) {
    for (const [k, v] of ipCreateBuckets.entries()) {
      if (v.length === 0 || now - v[v.length - 1] > PER_IP_CREATE_WINDOW_MS) {
        ipCreateBuckets.delete(k);
      }
    }
  }
}

export async function handleLinkStatus(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!isValidPubkey(wallet)) {
    return { status: 400, body: { error: "Invalid wallet pubkey" } };
  }
  if (!checkIpRate(ipKey(req))) {
    return { status: 429, body: { error: "Too many requests — slow down" } };
  }
  let rows;
  ({ rows } = await query(
    `SELECT u.id, u.telegram_id, u.telegram_username
       FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE w.public_key = $1
      LIMIT 1`,
    [wallet],
  ));
  if (rows.length === 0) {
    // Auto-bootstrap a site-native account so this wallet can chat
    // with Pip + transact immediately, no Telegram required. TG
    // remains a fully supported (but optional) backup identity path.
    //
    // Per-IP creation cap: stops a single IP from spinning up
    // thousands of throwaway synthetic accounts to bloat the users +
    // wallets tables. The READ rate limit (checkIpRate) above is
    // looser because polling an EXISTING wallet's status should be
    // cheap; this is the strict cap on actually creating new rows.
    const ip = ipKey(req);
    if (!canIpCreateAccount(ip)) {
      console.warn(`[link-status] IP ${ip} hit per-IP creation cap for new wallet ${String(wallet).slice(0, 8)}…`);
      return {
        status: 429,
        body: {
          linked: false,
          error: "create_rate_limited",
          message: "Too many new accounts from this IP today. Wait 24h or contact support.",
        },
      };
    }

    // SECURITY (audit finding #14): do NOT attribute a referral here.
    // This endpoint is UNAUTHENTICATED and this GET poll is prefetch-/
    // CSRF-triggerable, while the ?ref=CODE param is fully attacker-
    // controlled — crediting a referrer at this point would let anyone
    // attribute a freshly-bootstrapped account to a code of their choosing.
    // Referral attribution must happen on an authenticated/first-borrow
    // event instead. We still auto-create the account (no ref) so the
    // wallet can chat with Pip immediately, no Telegram required.
    try {
      await findOrCreateSiteUser(wallet);
      recordIpCreate(ip);
      // Re-read the user row we just created so the response shape
      // matches what the chat panel expects.
      ({ rows } = await query(
        `SELECT u.id, u.telegram_id, u.telegram_username
           FROM wallets w JOIN users u ON u.id = w.user_id
          WHERE w.public_key = $1
          LIMIT 1`,
        [wallet],
      ));
    } catch (err) {
      console.error("[link-status] auto-bootstrap failed:", err.message);
      return { status: 200, body: { linked: false, error: "bootstrap_failed" } };
    }
    if (rows.length === 0) {
      // Bootstrap succeeded but the read came back empty — extremely
      // unlikely (write race?). Surface as not-linked so the UI
      // doesn't lie.
      return { status: 200, body: { linked: false } };
    }
  }
  const u = rows[0];
  // Look up the user's currently-active custodial wallet — the one
  // site-withdraw would draw from. Returning its pubkey lets the dashboard
  // show "your custodial holdings" without a separate round-trip. Pubkey-
  // only, never the secret.
  const { rows: activeRows } = await query(
    `SELECT public_key FROM wallets
       WHERE user_id = $1 AND is_active = TRUE
       LIMIT 1`,
    [u.id],
  );
  // PRIVACY: never expose the user's telegram_username in this
  // endpoint. The site only needs to know whether the wallet has a
  // Magpie identity; the TG handle (if any) is private and would
  // otherwise leak to anyone who knows the wallet pubkey.
  //
  // Distinguish site-native (auto-bootstrapped, synthetic negative
  // telegram_id) from real TG-linked accounts via telegram_linked.
  // Negative or null telegram_id → no real TG bond. Positive → real
  // TG user. The dashboard uses this to show "Connect Telegram
  // (optional)" only when there isn't yet a real bond, instead of
  // misleadingly showing every site-native user as "Linked to TG".
  const tgLinked = typeof u.telegram_id === "number"
    ? u.telegram_id > 0
    : typeof u.telegram_id === "string"
    ? Number(u.telegram_id) > 0
    : false;
  return {
    status: 200,
    body: {
      linked: true,
      telegram_linked: tgLinked,
      // active_custodial_wallet pubkey deliberately omitted from the
      // unsigned wallet-keyed status endpoint — exposing the managed
      // wallet's pubkey to anyone holding ONE linked wallet leaks the
      // operator's wallet-routing graph. Boolean existence is fine for
      // the site to know "yes, there's a managed wallet for me"; the
      // actual pubkey is fetched via /api/v1/wallets through the
      // signed-flow widgets (CustodialWithdraw, WalletsList) when
      // they actually need it.
      has_active_custodial_wallet: !!activeRows[0]?.public_key,
    },
  };
}

/**
 * Internal: claim a link code for a user. Called by the /link bot command.
 * Returns the wallet that was just linked, or null if the code is
 * invalid/expired/already-claimed.
 */
export async function claimLinkCode(code, userId) {
  if (typeof code !== "string" || code.length !== CODE_LENGTH) return null;
  const { rows } = await query(
    `UPDATE account_link_codes
        SET claimed_at = NOW(), claimed_by_user_id = $2
      WHERE code = $1
        AND claimed_at IS NULL
        AND expires_at > NOW()
      RETURNING wallet_pubkey`,
    [code, userId],
  );
  return rows[0]?.wallet_pubkey ?? null;
}
