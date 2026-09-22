// @ts-check

/**
 * How a settled transcript travels: the daemon publishes each change as
 * "keep the first `keep` messages and append the rest" under a version, and a
 * viewer applies it to the messages it holds. Both ends run this code, so
 * what the viewer holds after applying is what the daemon published, and a
 * gap between versions is detected the same way on both.
 *
 * The results are plain so a viewer can hold and extend them; the functions
 * are hardened through the shim that resolves to the realm's `harden` under
 * lockdown on either side, and the daemon hardens what it publishes.
 *
 * @module
 */

import harden from '@endo/harden';

/**
 * The comparison the diff uses: structural. History metadata passes through
 * unfiltered, so a bigint may one day ride in it; `JSON.stringify` throws on
 * one, and a throw here would stop a sync, so bigints are spelled instead.
 *
 * @param {unknown} value
 */
const canonical = value =>
  JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? `${item}n` : item,
  );

/**
 * @param {unknown} left
 * @param {unknown} right
 */
export const sameData = (left, right) =>
  left === right || canonical(left) === canonical(right);
harden(sameData);

/**
 * How to turn one transcript into another: keep the first `keep` messages and
 * append the rest. A finished turn appends; a resolution rewrites the tail.
 *
 * @param {readonly unknown[]} previous
 * @param {readonly unknown[]} next
 * @returns {{ keep: number, append: unknown[] }}
 */
export const diffTranscript = (previous, next) => {
  const limit = Math.min(previous.length, next.length);
  let keep = 0;
  while (keep < limit && sameData(previous[keep], next[keep])) keep += 1;
  return { keep, append: next.slice(keep) };
};
harden(diffTranscript);

/**
 * Apply a transcript event to the messages a viewer holds. Returns undefined
 * when the event does not follow from what the viewer has (a gap, or an
 * event of the wrong shape), which means the viewer must reopen its view
 * rather than guess.
 *
 * @template T
 * @param {{ version: number, messages: readonly T[] } | null} held
 * @param {{ version: number, base: number, keep: number, append: readonly T[] }} event
 * @returns {{ version: number, messages: T[] } | undefined}
 */
export const applyTranscript = (held, event) => {
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
harden(applyTranscript);
