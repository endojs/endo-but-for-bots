// @ts-check
/**
 * Slot rendering for the conversation views (`composer.addon`,
 * `message.renderer`; m3-interfaces.md 6.2; W3.6): the shell's `Slot` and
 * `visibleFeatures`. They were local copies while `selectSlot` lived in
 * `features.js` (a Node module-graph deadlock); it now lives in
 * `slot-order.js` (M3-FIX).
 */
export {
  Slot as ConversationSlot,
  visibleFeatures as slotFeatures,
} from '../shell/Slot.js';

/**
 * @param {unknown} error
 * @returns {string}
 */
export const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);
