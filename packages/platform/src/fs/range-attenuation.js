// @ts-check
/**
 * Shared attenuation logic for the `ReadableBlob` `range` / `textRange`
 * surface (designs/readableblob-range-attenuation.md).
 *
 * `range(start, end)` and `textRange(startLine, endLine)` do not read or
 * persist bytes at construction; they compose a half-open interval over a
 * source blob and return a new, ephemeral `ReadableBlob` with exactly the
 * authority to read the selected portion. These pure helpers carry the parts
 * that every rich-blob implementation shares — argument validation, interval
 * composition (so a range of a range intersects and can never regain authority
 * outside its parent), and the LF line-boundary math that keeps `textRange`
 * byte-for-byte consistent with the older `rangeReadText` spelling.
 *
 * Each producer keeps its own source cap (a file path, captured bytes, a
 * content-store address, a live mount file, a Git blob OID) and re-invokes its
 * own factory with a composed interval, so the derived cap has the same
 * interface as its parent and retains only the source cap plus the interval.
 */

import { makeError, X, q } from '@endo/errors';
import { toSafeNumber } from './extended/shared/helpers.js';

/**
 * Validate a byte-range `[start, end)` attenuation request. Both bounds must
 * be non-negative safe offsets (`bigint`, matching the backing safe-offset
 * domain) and `start <= end`; a negative, non-safe, or inverted request
 * rejects with `EINVAL`. `start === end` is valid and selects nothing.
 *
 * No size is consulted: selection clamps at the receiver's end lazily at read
 * time, so constructing a range neither reads nor persists bytes. Returns the
 * validated numeric bounds relative to the receiver.
 *
 * @param {bigint} start
 * @param {bigint} end
 * @returns {{ start: number, end: number }}
 */
export const assertByteRange = (start, end) => {
  const startNum = toSafeNumber(start, 'start');
  const endNum = toSafeNumber(end, 'end');
  if (endNum < startNum) {
    throw makeError(
      X`EINVAL: range end ${q(end)} is before start ${q(start)}`,
    );
  }
  return harden({ start: startNum, end: endNum });
};
harden(assertByteRange);

/**
 * Validate a line-range `[startLine, endLine)` request. Zero-based,
 * end-exclusive, plain non-negative safe-integer line indices, matching the
 * `rangeReadText` addressing convention; a negative, fractional, non-safe, or
 * inverted request rejects with `EINVAL`. An equal interval is valid and
 * selects nothing.
 *
 * @param {number} startLine
 * @param {number} endLine
 * @returns {{ startLine: number, endLine: number }}
 */
export const assertLineRange = (startLine, endLine) => {
  const startNum = toSafeNumber(startLine, 'startLine');
  const endNum = toSafeNumber(endLine, 'endLine');
  if (endNum < startNum) {
    throw makeError(
      X`EINVAL: textRange end ${q(endLine)} is before start ${q(startLine)}`,
    );
  }
  return harden({ startLine: startNum, endLine: endNum });
};
harden(assertLineRange);

/**
 * Compose a child byte interval `[start, end)` — expressed relative to a
 * parent attenuation whose absolute bounds over the source are `[parentStart,
 * parentEnd)` — into absolute bounds over the source, intersected with the
 * parent so a range of a range can never regain authority outside its parent.
 * `parentEnd === undefined` means "to the source's end" (an unattenuated
 * blob); the child then inherits the concrete `end` bound.
 *
 * @param {number} parentStart
 * @param {number | undefined} parentEnd
 * @param {number} start  child start, relative to `parentStart`
 * @param {number} end    child end, relative to `parentStart`
 * @returns {{ start: number, end: number | undefined }}
 */
export const composeByteInterval = (parentStart, parentEnd, start, end) => {
  const absStart = parentStart + start;
  const absEnd = parentStart + end;
  if (parentEnd === undefined) {
    return harden({ start: absStart, end: absEnd });
  }
  // `start <= end` (validated) so `absStart <= absEnd`; clamping both at the
  // parent's end preserves that ordering and yields an empty interval when the
  // child begins at or past the parent's end.
  return harden({
    start: Math.min(absStart, parentEnd),
    end: Math.min(absEnd, parentEnd),
  });
};
harden(composeByteInterval);

/**
 * Map a validated line range `[startLine, endLine)` to the half-open byte
 * slice `[start, end)` of `bytes` that a text-line selection designates,
 * relative to `bytes` (the receiver's current content).
 *
 * Line boundaries are LF (`0x0a`); a CR before LF stays content, so CRLF is
 * preserved. `bytes.split('\n')` yields `(#LF) + 1` lines — a final LF creates
 * the terminal empty line. The returned slice decodes byte-for-byte to
 * `lines.slice(startLine, endLine).join('\n')`, so `textRange(a, b).text()`
 * agrees with `rangeReadText(a, b)`: line `i` spans `[lineStart(i),
 * lineEnd(i))` where the LF separating two selected lines is exactly the
 * `join('\n')` separator. `startLine` at or beyond the last line, or an equal
 * interval, yields an empty slice; `endLine` past the last line clamps.
 *
 * The caller must have validated the range (`assertLineRange`) and short-circuited
 * the empty `endLine <= startLine` case; this walks `bytes` once and never
 * decodes or materializes unrelated bytes.
 *
 * @param {Uint8Array} bytes
 * @param {number} startLine
 * @param {number} endLine
 * @returns {{ start: number, end: number }}
 */
export const lineRangeToByteSlice = (bytes, startLine, endLine) => {
  const len = bytes.length;
  const lastSelected = endLine - 1; // last line index the selection includes
  let byteStart = startLine === 0 ? 0 : -1;
  let byteEnd = -1;
  let line = 0; // index of the line whose content is being scanned
  for (let i = 0; i < len; i += 1) {
    if (bytes[i] === 0x0a) {
      // Line `line` spans `[curStart, i)`; the LF at `i` terminates it.
      if (line === lastSelected) {
        byteEnd = i;
      }
      line += 1;
      if (line === startLine) {
        // Line `startLine` starts just past this LF.
        byteStart = i + 1;
      }
    }
  }
  const numLines = line + 1; // the final line follows the last LF (maybe empty)
  if (startLine >= numLines) {
    // The whole selection begins at or past the last line: empty at EOF.
    return harden({ start: len, end: len });
  }
  if (byteStart === -1) {
    // `startLine` is the final (post-last-LF) line; its start is EOF only when
    // empty, else the position after the last LF — which the loop set. Reaching
    // here means an empty trailing line selected as its own start.
    byteStart = len;
  }
  if (byteEnd === -1) {
    // `lastSelected` is at or past the final line: clamp to EOF.
    byteEnd = len;
  }
  if (byteEnd < byteStart) {
    byteEnd = byteStart;
  }
  return harden({ start: byteStart, end: byteEnd });
};
harden(lineRangeToByteSlice);
