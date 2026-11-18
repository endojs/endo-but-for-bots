// @ts-check
/**
 * Sizes on the sending side (M1a W1a.1; architecture rule 12.5,
 * `designs/m1a-interfaces.md` section 1 item 4).
 *
 * The real bound on traffic into and out of a vat is per message: the UTF-8
 * bytes of every string in one message, record keys included, at most
 * `limits.frameBytes`, and per crank `limits.crankOutBytes`. A guard runs
 * only after a frame is decoded, so the sender measures. The cheap estimate
 * is UTF-16 units x 3, an upper bound (a unit is at most 3 bytes; a
 * surrogate pair is 4 bytes for 2 units); the exact count uses the
 * engine's `TextEncoder` (native in Ironhorse vats, about 0.25 computron
 * per byte, J-0110) and is taken only when the estimate is over the budget.
 *
 * Every cut here keeps surrogate pairs whole. A lone surrogate counts as 3
 * bytes, as `TextEncoder` writes it (U+FFFD).
 *
 * New code (no Endo source). Runs in vats and in Node (Node needs the guest
 * prelude installed first, for `interfaces.js`). Guest rules: no clock, no
 * string growth in loops (pieces are collected in arrays), no data-dependent
 * record keys.
 */
import { textOf } from './guards/base.js';
import { limits } from './limits.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Fail, passStyleOf } = /** @type {GuestGlobals} */ (globalThis);

/** @param {number} code */
const isHighSurrogate = code => code >= 0xd800 && code <= 0xdbff;
/** @param {number} code */
const isLowSurrogate = code => code >= 0xdc00 && code <= 0xdfff;

/**
 * Whether cutting `text` at `end` (exclusive) would split a surrogate pair.
 * @param {string} text
 * @param {number} end
 */
const splitsPair = (text, end) =>
  end > 0 &&
  end < text.length &&
  isHighSurrogate(text.charCodeAt(end - 1)) &&
  isLowSurrogate(text.charCodeAt(end));

/** Created on first use: a vat that never measures exactly holds none. */
/** @type {TextEncoder | undefined} */
let encoder;

/**
 * The cheap upper bound on a string's UTF-8 bytes.
 * @param {string} text
 * @returns {number}
 */
export const estimateBytes = text => text.length * 3;
harden(estimateBytes);

/**
 * A string's exact UTF-8 bytes.
 * @param {string} text
 * @returns {number}
 */
export const utf8Bytes = text => {
  if (text.length === 0) return 0;
  if (encoder === undefined) encoder = new TextEncoder();
  return encoder.encode(text).length;
};
harden(utf8Bytes);

/**
 * Visit every string a message would carry: record keys and values, array
 * items, a tagged value's tag and payload, an error's name and message.
 * Remotables, promises, numbers, booleans, bigints, symbols, null and
 * undefined carry no string content and are skipped. Iterative, so a deep
 * tree cannot exhaust the stack.
 *
 * @param {unknown} value
 * @param {(text: string) => void} visit
 */
const eachString = (value, visit) => {
  /** @type {unknown[]} */
  const stack = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') {
      visit(item);
    } else if (typeof item === 'object' && item !== null) {
      // A sender may measure before hardening: an unfrozen object is not
      // passable yet, so its style is read from its structure.
      let style;
      if (Object.isFrozen(item)) {
        style = passStyleOf(item);
      } else if (Array.isArray(item)) {
        style = 'copyArray';
      } else if (item instanceof Error) {
        style = 'error';
      } else {
        style = 'copyRecord';
      }
      if (style === 'copyArray') {
        for (const element of /** @type {unknown[]} */ (item)) {
          stack.push(element);
        }
      } else if (style === 'copyRecord') {
        for (const key of Object.keys(item)) {
          visit(key);
          stack.push(/** @type {Record<string, unknown>} */ (item)[key]);
        }
      } else if (style === 'tagged') {
        visit(/** @type {any} */ (item)[Symbol.toStringTag]);
        stack.push(/** @type {any} */ (item).payload);
      } else if (style === 'error') {
        visit(/** @type {Error} */ (item).name);
        visit(/** @type {Error} */ (item).message);
      }
      // remotable, promise: no string content
    }
  }
};

/**
 * The exact UTF-8 bytes of every string in a passable tree.
 * @param {unknown} value
 * @returns {number}
 */
export const messageBytes = value => {
  let total = 0;
  eachString(value, text => {
    total += utf8Bytes(text);
  });
  return total;
};
harden(messageBytes);

/**
 * Whether a message fits a byte budget: the estimate first, the exact count
 * only when the estimate is over.
 *
 * @param {unknown} value
 * @param {number} [budget]
 * @returns {boolean}
 */
export const fitsFrame = (value, budget = limits.frameBytes) => {
  let units = 0;
  eachString(value, text => {
    units += text.length;
  });
  if (units * 3 <= budget) return true;
  // Each string has at least one byte per unit.
  if (units > budget) return false;
  return messageBytes(value) <= budget;
};
harden(fitsFrame);

/**
 * The longest prefix of `text` within `maxBytes` UTF-8 bytes, never ending
 * inside a surrogate pair. Costs at most one exact measurement for text
 * that fits, and a binary search of exact measurements (natively encoded)
 * over at most `maxBytes` units otherwise.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export const cutText = (text, maxBytes) => {
  (Number.isSafeInteger(maxBytes) && maxBytes >= 0) ||
    Fail`cutText maxBytes must be a non-negative integer`;
  if (text.length * 3 <= maxBytes) return text;
  // A prefix of at most maxBytes bytes has at most maxBytes units.
  let hi = Math.min(text.length, maxBytes);
  if (splitsPair(text, hi)) hi -= 1;
  if (utf8Bytes(text.slice(0, hi)) <= maxBytes) return text.slice(0, hi);
  // Invariant: the prefix of length lo fits, the one of length hi does not.
  let lo = Math.floor(maxBytes / 3);
  if (splitsPair(text, lo)) lo -= 1;
  while (hi - lo > 1) {
    let mid = lo + Math.floor((hi - lo) / 2);
    // Either neighbour of a split point is a code point boundary.
    if (splitsPair(text, mid)) mid = mid + 1 < hi ? mid + 1 : mid - 1;
    if (mid <= lo) break;
    if (utf8Bytes(text.slice(0, mid)) <= maxBytes) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // Here hi = lo + 1, or hi = lo + 2 with a pair between them.
  return text.slice(0, lo);
};
harden(cutText);

/**
 * Consecutive pieces of `text`, each within `maxBytes` UTF-8 bytes, cut
 * between code points; joined they equal `text`. An empty text has no
 * pieces. `maxBytes` must be at least 4, so that every code point fits.
 *
 * @param {string} text
 * @param {number} [maxBytes]
 * @returns {string[]}
 */
export const chunkText = (text, maxBytes = limits.frameBytes) => {
  (Number.isSafeInteger(maxBytes) && maxBytes >= 4) ||
    Fail`chunkText maxBytes must be an integer of at least 4`;
  /** @type {string[]} */
  const pieces = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + maxBytes);
    if (splitsPair(text, end)) end -= 1;
    const piece = cutText(text.slice(offset, end), maxBytes);
    piece.length > 0 || Fail`chunkText made no progress`;
    pieces.push(piece);
    offset += piece.length;
  }
  return harden(pieces);
};
harden(chunkText);

/**
 * A prefix of at most `units` UTF-16 units, never ending inside a
 * surrogate pair, with no marker.
 *
 * @param {string} text
 * @param {number} units
 * @returns {string}
 */
export const previewText = (text, units) => {
  (Number.isSafeInteger(units) && units >= 0) ||
    Fail`previewText units must be a non-negative integer`;
  if (text.length <= units) return text;
  const end = splitsPair(text, units) ? units - 1 : units;
  return text.slice(0, end);
};
harden(previewText);

/**
 * R4-46: a tool output (or error text) unchanged if it is at most `limit`
 * units, else a prefix plus `textOf.truncationMarker(text.length)`, the
 * whole at most `limit` units, never splitting a surrogate pair (Fae
 * `session/tool-output.js` `boundToolOutput`, 1315bef86, without its image
 * exemption: images are not M1a tool output). When `limit` is shorter than
 * the marker itself, the marker is cut too.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export const boundToolOutput = (text, limit = limits.toolOutputUnits) => {
  if (text.length <= limit) return text;
  const marker = textOf.truncationMarker(text.length);
  if (marker.length >= limit) return previewText(marker, limit);
  return `${previewText(text, limit - marker.length)}${marker}`;
};
harden(boundToolOutput);

/**
 * Split events into consecutive groups for publishing: each group has at
 * most `maxEvents` events and at most `maxBytes` bytes of strings. An event
 * that alone is over `maxBytes` is a group of its own (the sender cuts its
 * text fields before calling). Estimates per event, measuring exactly only
 * an event whose estimate does not fit the room left.
 *
 * @template T
 * @param {readonly T[]} events
 * @param {{ maxEvents?: number, maxBytes?: number }} [options]
 * @returns {T[][]}
 */
export const splitBatches = (
  events,
  { maxEvents = limits.publishBatchEvents, maxBytes = limits.frameBytes } = {},
) => {
  (Number.isSafeInteger(maxEvents) && maxEvents >= 1) ||
    Fail`splitBatches maxEvents must be a positive integer`;
  /** @type {T[][]} */
  const groups = [];
  /** @type {T[]} */
  let group = [];
  // `bytes` is an upper bound on the group's bytes: estimates while they
  // fit, the group's exact count (measured once) after the first overflow.
  let bytes = 0;
  let exact = false;
  for (const event of events) {
    let size = 0;
    eachString(event, text => {
      size += text.length;
    });
    size *= 3;
    if (bytes + size > maxBytes) {
      if (!exact) {
        bytes = messageBytes(group);
        exact = true;
      }
      size = messageBytes(event);
    }
    if (
      group.length > 0 &&
      (group.length >= maxEvents || bytes + size > maxBytes)
    ) {
      groups.push(group);
      group = [];
      bytes = 0;
      exact = false;
    }
    group.push(event);
    bytes += size;
  }
  if (group.length > 0) groups.push(group);
  return groups;
};
harden(splitBatches);
