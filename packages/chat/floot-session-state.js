// @ts-check
// Pure helpers for the state a Floot session pushes through `watch()`.
// Kept apart from the component so they can be tested without a DOM. The
// transcript delta is applied by `@endo/floot/src/transcript-delta.js`, the
// same code the daemon publishes it with.

import harden from '@endo/harden';

/**
 * @typedef {{ id: string, text: string, state: string }} PendingEntry
 * @typedef {{ entries: PendingEntry[], hold: { reason: string, message: string } | null }} PendingState
 */

/** @type {PendingState} */
const NOTHING_PENDING = harden({ entries: [], hold: null });

/**
 * What the session reported as queued, held to the shape the view relies on.
 *
 * @param {unknown} value
 * @returns {PendingState}
 */
export const normalizePending = value => {
  const record = /** @type {any} */ (value);
  if (!record || !Array.isArray(record.entries)) return NOTHING_PENDING;
  return harden({
    entries: record.entries
      .filter(
        (/** @type {any} */ entry) =>
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.text === 'string',
      )
      .map((/** @type {any} */ entry) => ({
        id: entry.id,
        text: entry.text,
        state: `${entry.state || 'queued'}`,
      })),
    hold:
      record.hold && typeof record.hold.message === 'string'
        ? {
            reason: `${record.hold.reason || ''}`,
            message: record.hold.message,
          }
        : null,
  });
};
harden(normalizePending);
