/**
 * Image OCR + classification for community moderation.
 *
 * When a user posts a photo, we:
 *   1. Download the highest-resolution variant from Telegram
 *   2. Send it to Claude Haiku (4.5) with a vision prompt asking it
 *      to extract any visible text + flag obvious scam patterns
 *   3. Run the extracted text back through the same scam-pattern +
 *      URL-allowlist + handle-impersonation gates the text pipeline uses
 *
 * Cost-conscious design:
 *   - Only runs on images posted in moderated groups (not DMs)
 *   - Skips for verified accounts (operator + bot)
 *   - Single Haiku call per image (~$0.0005)
 *   - Times out at 12s — if Anthropic is slow, fail-open
 *   - We do NOT cache; rare enough that caching adds complexity
 *     without meaningful savings
 *
 * Fail-open philosophy (same as text classifier):
 *   - Any error → return null → caller treats as "no flag" → image stays
 *   - Better to let one screenshot-scam slide than to delete an innocent
 *     user's meme on a transient API hiccup
 */

const MODEL = "claude-haiku-4-5-20251001";
const MAX_OUTPUT_TOKENS = 400;
const TIMEOUT_MS = 12_000;

const SYSTEM_PROMPT = `You are a moderation vision model for the Magpie Capital community Telegram group. Magpie is a permissionless Solana lending protocol.

A user has posted an image. Your job:
  1. Transcribe any visible text in the image.
  2. Classify the image's INTENT into one bucket.

Output STRICTLY this JSON object, no surrounding text:
{
  "extracted_text": "<every text fragment you can read, joined with spaces>",
  "verdict": "<bucket>",
  "confidence": 0.0-1.0,
  "reason": "<one short sentence>"
}

BUCKETS:

"none"
  Default. Memes about crypto, screenshots of legit charts/tweets/UIs,
  photos of food/animals/anything unrelated, casual sharing.
  When in doubt, "none".

"scam_screenshot"
  Image clearly designed to phish or steal:
  - Screenshot of a fake "Magpie airdrop" or "claim free SOL" landing page
  - Screenshot of a wallet-connect popup luring users to a malicious site
  - QR code that leads to an unfamiliar URL
  - "Send 1 SOL to this address to get 10 SOL back" type promises
  - Fake "support" account claiming to help users with their wallets

"impersonation_screenshot"
  Image trying to look like an official Magpie communication but isn't:
  - Screenshot of a tweet from a Magpie-flavored handle that ISN'T
    @MagpieLoans (e.g. @MagpieLoansSupport, @MagpieCapitalOfficial)
  - Screenshot of a Telegram chat with a bot/user pretending to be
    Magpie support
  - Edited / fabricated screenshot of a "Magpie team" message

"fud_screenshot"
  Image whose primary purpose is to spread FUD about Magpie:
  - "MAGPIE IS A RUG, EXIT NOW" overlaid on a chart
  - Edited screenshot of fake "team dumping" data
  - Screenshot of a "expose thread" attacking the protocol
  Subjective criticism of crypto in general is NOT this.

"nsfw_or_violence"
  NSFW imagery, threats of violence, slurs visible in image.

If you're unsure between two buckets, pick the LESS severe one (or
"none"). Honest criticism, opinions, memes, even harsh ones, are NOT
flag-worthy — only clear scam / impersonation / coordinated FUD.

Confidence floor: 0.75 is the bar for action. Below that, return
your best guess but the caller will skip it.`;

/**
 * Download an image from Telegram and return its base64 + media_type.
 * Uses the bot's getFile + getFileLink-equivalent fetch.
 */
async function fetchTelegramImage(ctx, fileId) {
  // grammy: ctx.api.getFile() returns a File with file_path; we then
  // build the download URL from the bot token.
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!token) throw new Error("bot token not in env");

  const file = await ctx.api.getFile(fileId);
  if (!file?.file_path) throw new Error("no file_path returned from getFile");

  const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const arrayBuf = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuf).toString("base64");

  // Guess media_type from file extension
  const ext = (file.file_path.split(".").pop() || "").toLowerCase();
  const mediaType =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
    ext === "png" ? "image/png" :
    ext === "webp" ? "image/webp" :
    ext === "gif" ? "image/gif" :
    "image/jpeg"; // sensible default

  return { base64, mediaType, sizeBytes: arrayBuf.byteLength };
}

/**
 * Pick the best image from a TG message. Telegram returns a photo as an
 * array of thumbnails + a full-res version; we want the largest one for
 * best OCR accuracy.
 *
 * Returns the largest file_id, or null if no usable image.
 */
function pickBestPhoto(msg) {
  // 1. Plain photo
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    // Photos come sorted small→large; take the last
    const largest = msg.photo[msg.photo.length - 1];
    return largest.file_id;
  }
  // 2. Image-document attachment (Telegram allows sending an image as
  // a "document" to bypass auto-compression — common in scam payloads)
  if (msg.document && /^image\//.test(msg.document.mime_type || "")) {
    return msg.document.file_id;
  }
  // 3. Sticker — could carry scam text in some cases, but rare. Skip
  // for now to keep cost down; can add later if needed.
  return null;
}

/**
 * Classify an image. Returns { verdict, confidence, reason, extracted_text }
 * on success, or null on any failure (fail-open).
 */
export async function classifyImage(ctx, msg) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const fileId = pickBestPhoto(msg);
  if (!fileId) return null;

  let imgData;
  try {
    imgData = await fetchTelegramImage(ctx, fileId);
  } catch (err) {
    console.warn("[image-ocr] download failed → fail-open:", err.message);
    return null;
  }

  // Cap at 5MB — Anthropic's per-image limit. Larger = skip.
  if (imgData.sizeBytes > 5 * 1024 * 1024) {
    console.warn(`[image-ocr] image too large (${imgData.sizeBytes}B) → fail-open`);
    return null;
  }

  // Include the message's caption (if any) as additional context.
  const caption = msg.caption ? `\n\nUser's caption: ${msg.caption.slice(0, 500)}` : "";

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: imgData.mediaType, data: imgData.base64 },
              },
              { type: "text", text: `Please classify this image.${caption}` },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[image-ocr] HTTP ${res.status} → fail-open`);
      return null;
    }
    const body = await res.json();
    const txt = Array.isArray(body?.content) ? body.content[0]?.text : null;
    if (!txt) return null;

    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    const verdict = String(parsed.verdict || "none").toLowerCase();
    const confidence = Number(parsed.confidence) || 0;
    const reason = String(parsed.reason || "").slice(0, 300);
    const extractedText = String(parsed.extracted_text || "").slice(0, 2000);

    const valid = ["none", "scam_screenshot", "impersonation_screenshot", "fud_screenshot", "nsfw_or_violence"];
    if (!valid.includes(verdict)) return null;

    return { verdict, confidence, reason, extractedText };
  } catch (err) {
    console.warn("[image-ocr] error → fail-open:", err.message);
    return null;
  }
}

/**
 * Action mapping for image verdicts. Same conservative bar as the
 * text classifier — 0.75 confidence floor, never auto-permaban.
 */
export function actionForImageVerdict({ verdict, confidence }) {
  const HIGH_CONFIDENCE = 0.75;
  if (confidence < HIGH_CONFIDENCE) {
    return { action: "skip", warn: false, mute_sec: 0, flag_operator: false };
  }
  switch (verdict) {
    case "scam_screenshot":
      // Phishing screenshots are the most dangerous image attacks — these
      // route users to seed-stealing landing pages. Delete + flag.
      return { action: "delete", warn: true, mute_sec: 60 * 60, flag_operator: true };
    case "impersonation_screenshot":
      return { action: "delete", warn: true, mute_sec: 0, flag_operator: true };
    case "fud_screenshot":
      return { action: "delete", warn: false, mute_sec: 0, flag_operator: true };
    case "nsfw_or_violence":
      return { action: "delete", warn: false, mute_sec: 24 * 3600, flag_operator: true };
    case "none":
    default:
      return { action: "skip", warn: false, mute_sec: 0, flag_operator: false };
  }
}
