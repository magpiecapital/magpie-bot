/**
 * Persistent reply keyboard shown at the bottom of every Magpie chat.
 * Users can hit a button on any screen to jump to a primary action.
 *
 * Telegram only needs to be told about the keyboard once per chat —
 * subsequent messages keep showing it because `is_persistent: true`.
 * /start attaches it on first contact.
 */

export const BTN_HOME = "🏠 Home";
export const BTN_WALLET = "💼 Wallet";
export const BTN_BORROW = "💰 Borrow";
export const BTN_POSITIONS = "📊 Positions";

export function mainReplyKeyboard() {
  return {
    keyboard: [
      [{ text: BTN_HOME }, { text: BTN_WALLET }],
      [{ text: BTN_BORROW }, { text: BTN_POSITIONS }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}
