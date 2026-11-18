// @ts-check
/**
 * Slot rendering for the new-session dialog (`newSession.field`;
 * m3-interfaces.md 6.2; W3.5): the shell's `Slot` (slot order, `when`,
 * a feature that throws shows an error line). It was a local copy while
 * `selectSlot` lived in `features.js` (a Node module-graph deadlock); it
 * now lives in `slot-order.js` (M3-FIX).
 */
export { Slot as SessionsSlot } from '../shell/Slot.js';
