// @ts-check
// Pure helpers for the state a Floot session pushes through `watch()`.
// Kept apart from the component so they can be tested without a DOM.

import harden from '@endo/harden';

/**
 * Apply a transcript event (`{ version, base, keep, append }`) to the
 * transcript a view holds: keep the first `keep` messages, append the rest.
 * Returns undefined when the event does not follow from what is held — one
 * was missed — which means reopen the view rather than guess.
 *
 * The mirror of `applyTranscript` in `@endo/floot`'s `src/session-watch.js`,
 * which is the authority on the wire format.
 *
 * @template T
 * @param {{ version: number, messages: readonly T[] } | null} held
 * @param {{ version: number, base: number, keep: number, append: readonly T[] }} event
 * @returns {{ version: number, messages: T[] } | undefined}
 */
export const applyTranscriptEvent = (held, event) => {
  if (
    !event ||
    typeof event.version !== 'number' ||
    typeof event.base !== 'number' ||
    typeof event.keep !== 'number' ||
    !Array.isArray(event.append)
  )
    return undefined;
  if (!held) {
    if (event.base !== 0 || event.keep !== 0) return undefined;
    return { version: event.version, messages: [...event.append] };
  }
  if (event.version <= held.version)
    return { version: held.version, messages: [...held.messages] };
  if (event.base !== held.version || event.keep > held.messages.length)
    return undefined;
  return {
    version: event.version,
    messages: [...held.messages.slice(0, event.keep), ...event.append],
  };
};
harden(applyTranscriptEvent);

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
