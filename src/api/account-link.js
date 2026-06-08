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

export async function findOrCreateSiteUser(walletPubkey) {
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
  // Bond the wallet. ON CONFLICT (public_key) DO NOTHING means if
  // the wallet was already linked to a different user (real TG
  // account), we leave that bond untouched.
  await query(
    `INSERT INTO wallets (user_id, public_key, encrypted_secret, nonce, auth_tag, source, is_active)
     VALUES ($1, $2, '', '', '', 'site_native', TRUE)
     ON CONFLICT (public_key) DO NOTHING`,
    [userId, walletPubkey],
  );
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
export async function handleLinkStatus(req, url) {
  const wallet = url.searchParams.get("wallet");
  if (!isValidPubkey(wallet)) {
    return { status: 400, body: { error: "Invalid wallet pubkey" } };
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
    try {
      await findOrCreateSiteUser(wallet);
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
  return {
    status: 200,
    body: {
      linked: true,
      telegram_username: u.telegram_username ? `@${u.telegram_username}` : null,
      active_custodial_wallet: activeRows[0]?.public_key ?? null,
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
