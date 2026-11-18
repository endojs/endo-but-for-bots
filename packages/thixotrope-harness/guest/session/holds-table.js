// @ts-check
/**
 * Queue holds (M2 W2.4; `designs/m2-interfaces.md` 5.2 and 13; spec A.4
 * "Queue", R4-56). A hook table: later milestones append an entry for a new
 * hold and never edit another milestone's entries (M6 `stopped` is already
 * here, as the spec names it; M9 may append).
 *
 * Each entry is `{ reason, text(error?) -> string, releasedBy }`:
 * - `reason` a `HoldReason` (interfaces.js `shapes.HoldReason`);
 * - `text` the A.4 text of the hold, exactly; `refused` and `unavailable`
 *   take the error that caused them;
 * - `releasedBy` `'enqueue'` when a new message or send-now releases it, or
 *   `'decision'` when only a decision about the message it concerns does
 *   (R4-56: every hold but `interrupted`).
 *
 * Which holds this build can reach (5.2): `restart` (recovery.js), `stopped`
 * (M6), `refused` (a refusal in the claim crank; M2 has none), and neither
 * `interrupted` (the claim is atomic, architecture 4.3, so no entry can be
 * found half-sent) nor `unavailable` (the queue is the vat's heap and cannot
 * fail to load): those two keep their texts for the shape.
 *
 * Vat module: prelude globals only.
 */
import { texts, textOf } from '../lib/guards/session.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { harden } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {object} HoldEntry
 * @property {string} reason
 * @property {(error?: string) => string} text
 * @property {'enqueue' | 'decision'} releasedBy
 */

/** @type {readonly HoldEntry[]} */
export const holdsTable = harden([
  {
    reason: 'restart',
    text: () => texts.holdRestart,
    releasedBy: 'enqueue',
  },
  {
    reason: 'stopped',
    text: () => texts.holdStopped,
    releasedBy: 'enqueue',
  },
  {
    reason: 'refused',
    text: error =>
      error === undefined || error === ''
        ? texts.holdRefusedDefault
        : textOf.holdRefused(error),
    releasedBy: 'enqueue',
  },
  {
    reason: 'interrupted',
    text: () => texts.holdInterrupted,
    releasedBy: 'decision',
  },
  {
    reason: 'unavailable',
    text: error => textOf.holdUnavailable(error ?? ''),
    releasedBy: 'enqueue',
  },
]);
