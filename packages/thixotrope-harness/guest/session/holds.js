// @ts-check
/**
 * Hold texts and the release rule (M2 W2.4; `designs/m2-interfaces.md` 5.2;
 * spec A.4 "Queue", R4-56; Fae `session/session-submissions.js` at
 * `1315bef86`, `HOLD_MESSAGES` and `submit`/`sendNow`), read from
 * `holds-table.js`.
 *
 * - `holdTexts.restart()`, `.stopped()`, `.refused(error?)`,
 *   `.interrupted()`, `.unavailable(error)`: the A.4 text of a hold.
 * - `holdText(reason, error?)`: the same by reason (a reason the table does
 *   not know has no text: it throws).
 * - `releaseRule(reason)`: whether a new message or send-now releases a
 *   hold of that reason. A reason the table does not know is never released
 *   that way (a hold someone appended without saying stays until its owner
 *   lifts it).
 *
 * Vat module: prelude globals only; Maps, not data-named properties.
 */
import { holdsTable } from './holds-table.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { HoldEntry } from './holds-table.js' */
const { harden } = /** @type {GuestGlobals} */ (globalThis);

/** @type {Map<string, HoldEntry>} */
const byReason = new Map();
for (const entry of holdsTable) byReason.set(entry.reason, entry);

/**
 * @param {string} reason
 * @param {string} [error]
 * @returns {string}
 */
export const holdText = (reason, error) => {
  const entry = byReason.get(reason);
  if (entry === undefined) throw Error(`no hold ${reason}`);
  return entry.text(error);
};
harden(holdText);

export const holdTexts = harden({
  restart: () => holdText('restart'),
  stopped: () => holdText('stopped'),
  /** @param {string} [error] */
  refused: error => holdText('refused', error),
  interrupted: () => holdText('interrupted'),
  /** @param {string} error */
  unavailable: error => holdText('unavailable', error),
});

/**
 * R4-56: a new message or send-now releases every hold except the ones
 * that need a decision about their message (`interrupted`).
 * @param {string | undefined} reason
 * @returns {boolean}
 */
export const releaseRule = reason =>
  reason !== undefined && byReason.get(reason)?.releasedBy === 'enqueue';
harden(releaseRule);
