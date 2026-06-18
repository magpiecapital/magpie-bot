/**
 * Governance vote endpoints.
 *
 *   POST /api/v1/governance/vote
 *     Receives a wallet-signed vote payload, verifies the ed25519
 *     signature, validates the proposal + question + vote against
 *     the active-proposal registry, and records it. A voter can
 *     change their vote any time before close — the most recent
 *     valid signature wins at tally.
 *
 *   GET  /api/v1/governance/votes?proposal_id=MGP-001
 *     Returns aggregate counts per question per vote choice. Does
 *     NOT return per-wallet vote choices. Aggregate-only by design
 *     (per the GOVERNANCE.md v0 commitment).
 *
 * Auth posture mirrors prefs-api.js — ed25519 signature against
 * the signer's published pubkey, with payload nonce + issuedAt
 * freshness window to prevent replay.
 */
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);

const FRESH_WINDOW_MS = 10 * 60 * 1000;            // payload issuedAt freshness
const MIN_INTERVAL_MS = 1_000;                      // anti-spam between calls
const MAX_VOTES_PER_WALLET_QUESTION = 20;           // anti-spam DB-fill cap (latest-wins tally already handles re-votes)
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const lastBySigner = new Map();

/**
 * Active-proposal registry. Mirrors the site's PROPOSALS map.
 * Single source of truth would be better long-term; for v0 the
 * site and bot ship in lockstep, so a duplicated registry is
 * acceptable.
 */
const ACTIVE_PROPOSALS = {
  "MGP-001": {
    // Voting window shifted on 2026-06-09 to open 2026-06-10 00:00 UTC
    // so holders get a clean day after the rescope. The activation gate
    // (issuedAt >= activated_at_iso) rejects any vote payload signed
    // before 2026-06-10. Status stays "active" so the proposal page
    // renders as the lead surface, but votes won't be accepted until
    // the gate opens.
    status: "active",
    activated_at_iso: "2026-06-10T00:00:00Z",
    closes_at_iso: "2026-06-13T23:59:59Z",
    questions: {
      Vote: { choices: ["YES", "NO", "ABSTAIN"] },
    },
  },
  "MGP-002": {
    // Withdrawn 2026-06-09. The endpoint rejects new votes against
    // MGP-002 with the "not active" 409. Any votes already recorded
    // before the withdrawal stay in governance_votes for audit but
    // are not tallied (operator decided to ship the Premium tier
    // under Tier B discretion).
    status: "withdrawn",
    activated_at_iso: "2026-06-09T00:00:00Z",
    closes_at_iso: "2026-06-09T23:59:59Z",
    questions: {},
  },
  "MGP-003": {
    // Rescoped + rescheduled 2026-06-18 by operator decision:
    //   - Original 5-option ballot (A=burn, B=re-lock 12mo, C=holders
    //     30d, D=users 30d, E=hybrid) consolidated to 4 options (no
    //     instant releases, burn appears in only one option as a hybrid)
    //   - Voting window pushed to 5 days (Jun 24 → Jun 29 ET)
    // The vote endpoint's time-gate rejects any payload signed before
    // activated_at_iso. Pre-armed: flips itself live at the activation
    // timestamp without an operator-issued config push at that time.
    // status:"active" is the UI label; the on-vote time-gate is the
    // load-bearing piece. See feedback_governance_voting_window_5d.md +
    // feedback_voting_ux_must_feel_solid.md.
    status: "active",
    activated_at_iso: "2026-06-25T00:00:00Z",
    closes_at_iso: "2026-06-30T00:00:00Z",
    questions: {
      Vote: { choices: ["A", "B", "C", "D", "ABSTAIN"] },
    },
  },
};

function isValidPubkey(s) {
  return typeof s === "string" && s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function verifyEd25519(messageBytes, signatureBytes, pubkeyBytes) {
  const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyBytes)]);
  const keyObject = createPublicKey({ key: der, format: "der", type: "spki" });
  return cryptoVerify(null, messageBytes, keyObject, signatureBytes);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > 8 * 1024) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
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

export async function initGovernanceSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS governance_votes (
      id                    BIGSERIAL PRIMARY KEY,
      proposal_id           TEXT NOT NULL,
      question_id           TEXT NOT NULL,
      voter_pubkey          TEXT NOT NULL,
      vote                  TEXT NOT NULL,
      signed_message_base64 TEXT NOT NULL,
      signature_base58      TEXT NOT NULL,
      nonce_hex             TEXT NOT NULL,
      issued_at             TIMESTAMPTZ NOT NULL,
      received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS governance_votes_nonce_uniq
      ON governance_votes (proposal_id, question_id, voter_pubkey, nonce_hex)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS governance_votes_pq_idx
      ON governance_votes (proposal_id, question_id, voter_pubkey, received_at DESC)
  `);
}

export async function handleGovernanceVoteSubmit(req) {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };

  const globalReject = await rejectIfSiteDisabled();
  if (globalReject) return globalReject;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return { status: 400, body: { error: `Invalid body: ${e.message}` } };
  }
  const { signedMessageBase64, signatureBase58, signerPubkey } = body || {};
  if (!signedMessageBase64 || !signatureBase58 || !signerPubkey) {
    return {
      status: 400,
      body: { error: "Missing signedMessageBase64, signatureBase58, or signerPubkey" },
    };
  }

  let signerPk;
  try {
    signerPk = new PublicKey(signerPubkey);
  } catch {
    return { status: 400, body: { error: "Invalid signerPubkey" } };
  }

  // Per-signer rate limit — protect against accidental double-clicks
  // or scripted spam from a single key.
  const now = Date.now();
  const last = lastBySigner.get(signerPubkey) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    return { status: 429, body: { error: "Too many requests from this signer" } };
  }

  let sigBytes;
  try {
    sigBytes = bs58decode(signatureBase58);
    if (sigBytes.length !== 64) throw new Error("bad length");
  } catch {
    return { status: 400, body: { error: "Invalid signatureBase58" } };
  }

  let messageBytes;
  try {
    messageBytes = Buffer.from(signedMessageBase64, "base64");
    if (messageBytes.length === 0 || messageBytes.length > 1024) {
      throw new Error("size out of range");
    }
  } catch {
    return { status: 400, body: { error: "Invalid signedMessageBase64" } };
  }

  let payload;
  try {
    payload = JSON.parse(messageBytes.toString("utf-8"));
  } catch {
    return { status: 400, body: { error: "Signed message is not valid JSON" } };
  }
  if (payload?.magpie !== "gov-vote/v1") {
    return { status: 400, body: { error: "Wrong payload envelope" } };
  }
  const { proposal_id, question_id, vote, nonce, issuedAt } = payload;
  if (typeof proposal_id !== "string" || typeof question_id !== "string" ||
      typeof vote !== "string" || typeof nonce !== "string" || typeof issuedAt !== "string") {
    return { status: 400, body: { error: "Missing payload fields" } };
  }
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    return { status: 400, body: { error: "Invalid nonce shape" } };
  }
  const issuedMs = Date.parse(issuedAt);
  if (Number.isNaN(issuedMs) || Math.abs(now - issuedMs) > FRESH_WINDOW_MS) {
    return { status: 400, body: { error: "Payload outside freshness window" } };
  }

  // Validate proposal + question + vote against the registry.
  const proposal = ACTIVE_PROPOSALS[proposal_id];
  if (!proposal) {
    return { status: 404, body: { error: "Unknown proposal_id" } };
  }
  if (proposal.status !== "active") {
    return { status: 409, body: { error: `Proposal ${proposal_id} is ${proposal.status}, not active` } };
  }
  const question = proposal.questions[question_id];
  if (!question) {
    return { status: 400, body: { error: `Unknown question_id for ${proposal_id}` } };
  }
  if (!question.choices.includes(vote)) {
    return { status: 400, body: { error: `Vote "${vote}" not in choice set for ${proposal_id}/${question_id}` } };
  }
  if (proposal.closes_at_iso && now > Date.parse(proposal.closes_at_iso)) {
    return { status: 409, body: { error: `Voting window for ${proposal_id} has closed` } };
  }
  // Hardening: reject signatures created BEFORE the proposal was activated.
  // Defeats an attacker pre-signing votes against an unknown future
  // proposal_id, or replaying signatures from a previous (now-stale)
  // proposal cycle.
  if (proposal.activated_at_iso && issuedMs < Date.parse(proposal.activated_at_iso)) {
    return { status: 400, body: { error: "Payload signed before proposal activation" } };
  }

  // Verify the signature against the signed message + signer pubkey.
  // Order matters — do this AFTER the cheap validation above so an
  // attacker can't burn server CPU with valid-shape but invalid-
  // signature payloads.
  if (!verifyEd25519(messageBytes, sigBytes, signerPk.toBytes())) {
    return { status: 401, body: { error: "Signature does not match signer" } };
  }

  // Hardening: per-wallet per-(proposal, question) row cap. Prevents a
  // single signer from filling the DB with vote-change spam. Tally
  // uses latest-wins, so any honest voter needs at most a handful of
  // rows; 20 is generous. Beyond the cap, refuse.
  const { rows: [{ n: existingVotes }] } = await query(
    `SELECT COUNT(*)::int AS n FROM governance_votes
       WHERE proposal_id = $1 AND question_id = $2 AND voter_pubkey = $3`,
    [proposal_id, question_id, signerPubkey],
  );
  if (existingVotes >= MAX_VOTES_PER_WALLET_QUESTION) {
    return {
      status: 429,
      body: { error: `Vote change limit reached (${MAX_VOTES_PER_WALLET_QUESTION}) for this wallet on ${proposal_id}/${question_id}` },
    };
  }

  lastBySigner.set(signerPubkey, now);

  // Insert. The unique constraint on (proposal_id, question_id,
  // voter_pubkey, nonce_hex) prevents exact-duplicate submissions
  // (same nonce). A re-vote uses a new nonce and creates a new row
  // — the tally uses the most recent received_at per
  // (proposal_id, question_id, voter_pubkey).
  await query(
    `INSERT INTO governance_votes
       (proposal_id, question_id, voter_pubkey, vote,
        signed_message_base64, signature_base58, nonce_hex, issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))
     ON CONFLICT (proposal_id, question_id, voter_pubkey, nonce_hex) DO NOTHING`,
    [
      proposal_id,
      question_id,
      signerPubkey,
      vote,
      signedMessageBase64,
      signatureBase58,
      nonce,
      issuedMs,
    ],
  );

  return {
    status: 200,
    body: { ok: true, recorded_at: new Date().toISOString() },
  };
}

/**
 * GET /api/v1/governance/votes?proposal_id=MGP-001
 *
 * Returns aggregate vote counts per question per choice. Does NOT
 * return per-wallet votes. Used by the operator to monitor turnout
 * during the voting window.
 *
 * Note: this returns COUNTS, not WEIGHTS. The operator weights at
 * tally time against the activation-time balance basis (operator-
 * internal mechanism per the governance v0 hard rule).
 */
export async function handleGovernanceVotesAggregate(req, url) {
  const proposalId = url.searchParams.get("proposal_id");
  if (!proposalId || !ACTIVE_PROPOSALS[proposalId]) {
    return { status: 400, body: { error: "Missing or invalid proposal_id" } };
  }

  const { rows } = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (proposal_id, question_id, voter_pubkey)
              proposal_id, question_id, voter_pubkey, vote, received_at
         FROM governance_votes
        WHERE proposal_id = $1
        ORDER BY proposal_id, question_id, voter_pubkey, received_at DESC
     )
     SELECT question_id, vote, COUNT(*)::int AS n
       FROM latest
      GROUP BY question_id, vote
      ORDER BY question_id, vote`,
    [proposalId],
  );

  return {
    status: 200,
    body: {
      proposal_id: proposalId,
      counts: rows,
      note: "Counts, not weights. Weighting happens at tally time. Aggregate-only by design.",
    },
  };
}
