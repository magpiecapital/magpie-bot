/**
 * Telegram delivery classification — "will retrying this ever work?"
 *
 * WHY THIS EXISTS. `loan-watcher` warns borrowers 24h and 6h before their loan
 * is due, and correctly refuses to mark a loan as warned unless the DM actually
 * sent. But some failures can NEVER succeed — the borrower blocked the bot, or
 * deleted the chat, or deactivated their account. Production logs showed the
 * real thing, four distinct loans inside one 500-line window:
 *
 *   [pump-watcher] DM failed for loan <id>: Call to 'sendMessage' failed!
 *                  (400: Bad Request: chat not found)
 *
 * Every loan in the database has a non-null `user_id`, so "has a Telegram user"
 * does NOT imply "is reachable". Before this module the consequence was silent:
 * the watcher retried every 60s until the loan expired, nobody was warned, and
 * NOTHING escalated. A borrower could forfeit collateral having never been told
 * it was about to happen.
 *
 * CLASSIFICATION DIRECTION MATTERS, AND IT IS ASYMMETRIC:
 *
 *   - Calling a TRANSIENT failure permanent is the dangerous error: it stops
 *     the retries, and a warning that would have gone through never does.
 *   - Calling a PERMANENT failure transient is cheap: some wasted retries.
 *
 * So this classifier is deliberately CONSERVATIVE. It returns `true` only for
 * an explicit, enumerated Telegram rejection. Anything unrecognised — network
 * error, timeout, 429, 5xx, a description Telegram changes next year — is
 * treated as transient and keeps retrying.
 *
 * That conservatism means misclassification is still possible, which is why
 * `loan-watcher` ALSO runs an unconditional backstop that does not depend on
 * this function being right. See `checkUnwarnedNearDue()`.
 *
 * Pure and synchronous — no I/O, no bot handle, trivially testable.
 */

/**
 * Descriptions Telegram returns that no amount of retrying will fix.
 * Matched case-insensitively as substrings of the API's `description`.
 *
 * Kept as an explicit list rather than a broad pattern on purpose: a regex like
 * /blocked|not found/ would also swallow unrelated future errors and silently
 * suppress warnings, which is the exact failure this module exists to prevent.
 */
const PERMANENT_DESCRIPTIONS = [
  "chat not found",
  "bot was blocked by the user",
  "user is deactivated",
  "bot can't initiate conversation with a user",
  "bot can't send messages to bots",
  "peer_id_invalid",
  "chat_write_forbidden",
  "user_is_blocked",
  "the group chat was deleted",
  "forbidden: bot was kicked",
];

/**
 * Pull an HTTP-ish status code out of a grammY / Telegram error, if present.
 * grammY's GrammyError exposes `error_code`; other shapes are tolerated.
 */
function statusOf(err) {
  const c = err?.error_code ?? err?.status ?? err?.statusCode;
  return Number.isInteger(c) ? c : null;
}

/**
 * Is this delivery failure permanent — i.e. is retrying pointless?
 *
 * @param {unknown} err  the thrown error from `bot.api.sendMessage`
 * @returns {boolean} true ONLY for an enumerated, unambiguous rejection
 */
export function isPermanentDeliveryFailure(err) {
  try {
    const code = statusOf(err);

    // 429 is rate limiting and 5xx is Telegram having a bad day. Both recover.
    if (code === 429) return false;
    if (code !== null && code >= 500) return false;

    const description = String(
      err?.description ?? err?.message ?? "",
    ).toLowerCase();
    if (!description) return false;

    // Only 4xx (or an unlabelled error whose text we recognise) can be
    // permanent. The description is what actually decides.
    if (code !== null && code !== 400 && code !== 403) return false;

    return PERMANENT_DESCRIPTIONS.some((d) => description.includes(d));
  } catch {
    // A classifier bug must never be able to suppress a warning.
    return false;
  }
}

/**
 * Short, stable reason string for the audit column. Never throws, always
 * bounded — this is written to the database and shown to an operator.
 */
export function deliveryFailureReason(err) {
  try {
    const code = statusOf(err);
    const text = String(err?.description ?? err?.message ?? "unknown error");
    return `${code ?? "?"}: ${text}`.slice(0, 200);
  } catch {
    return "unknown error";
  }
}
