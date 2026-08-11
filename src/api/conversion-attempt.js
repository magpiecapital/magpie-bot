/**
 * Was a cosign request ever actually a borrow attempt?
 *
 * PURE — zero imports, no side effects — so it can be unit-tested without
 * booting the bot (same pattern as src/solana/arming-caps.js).
 *
 * WHY THIS EXISTS. The conversion wrapper recorded an event for EVERY request
 * to /api/v1/cosign-borrow, including ones rejected before a transaction was
 * even supplied. The endpoint is public and unauthenticated, and something
 * polls it every 5 minutes with an invalid body — so each poll logged a
 * "customer borrow failure".
 *
 * Measured 2026-08-11: 14,842 borrow events recorded, and ZERO had a wallet
 * attached. Not one real borrow had ever been recorded, while 106 real loans
 * closed in the same 30 days. The metric read 0.0% success permanently, so it
 * could never report a REAL degradation — which is the only thing it was built
 * for ("without this, the operator only learns about failures from user
 * complaints — too late").
 *
 * THE LINE: if no transaction was supplied, there was no borrow to convert.
 * Anything that DID supply a tx stays recorded — including a tx we could not
 * deserialize or do not support. Those are genuine failed attempts by a real
 * caller and are exactly what the metric must catch. Excluding them would make
 * the metric falsely GREEN, which is worse than falsely red.
 *
 * @param {{status?: number, body?: any}} result
 * @returns {boolean} true when the request never constituted a borrow attempt
 */
export function isNonBorrowAttempt(result) {
  try {
    const status = result?.status;
    const err = result?.body?.error;
    if (status === 405) return true; // GET/HEAD probe — not an attempt
    if (status === 400 && (err === "Missing partialSignedTxBase64" || err === "Invalid JSON body")) {
      return true; // no transaction supplied at all
    }
    return false;
  } catch {
    // Never let this decide wrongly by throwing. Recording a spurious event is
    // far less harmful than dropping a real one.
    return false;
  }
}
