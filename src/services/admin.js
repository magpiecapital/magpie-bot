/**
 * Admin authorization + a tiny in-memory "borrowing paused" flag.
 *
 * ADMIN_TELEGRAM_IDS is a comma-separated list of telegram user IDs with
 * elevated privileges (stats, pause/resume, mint management).
 */
const admins = new Set(
  (process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
);

export function isAdmin(telegramId) {
  return admins.has(Number(telegramId));
}

let borrowingPaused = false;
export function pauseBorrowing() {
  borrowingPaused = true;
}
export function resumeBorrowing() {
  borrowingPaused = false;
}
export function isBorrowingPaused() {
  return borrowingPaused;
}
