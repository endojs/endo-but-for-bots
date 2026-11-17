// @ts-check
/**
 * `BlobRef` exo factory — a content-addressed handle over a
 * captured `Uint8Array` snapshot (DESIGN.md §6).
 *
 * Identical across the in-memory, node-fs, and from-mount
 * `Filesystem` implementations: defensively copy the bytes,
 * SHA-256 them, and return an exo with separate digest, size, byte-stream, and
 * range-attenuation methods.
 */

import { makeExo } from '@endo/exo';
import { encodeBase64 } from '@endo/base64';
import { sha256 } from '@endo/sha256';
import { q } from '@endo/errors';

import { BlobRefInterface } from '../type-guards.js';
import { makeBytesReaderFromBytes } from './helpers.js';
import {
  assertByteRange,
  assertLineRange,
  composeByteInterval,
  lineRangeToByteSlice,
} from '../../range-attenuation.js';

/** @import { BlobRef } from '../types.js' */

const textDecoder = new TextDecoder();

/**
 * Inner factory shared by the public `makeBlobRefExo` and its derived range
 * attenuations. `captured` is the immutable source snapshot; `[start, end)` is
 * the absolute byte interval this handle exposes over it (the source cap plus a
 * composed interval — a range of a range intersects and can never regain
 * authority outside its parent). Every view reports the selected content's own
 * SHA-256.
 *
 * @param {Uint8Array} captured
 * @param {string | undefined} help
 * @param {number} start
 * @param {number} end
 * @returns {BlobRef}
 */
const makeBlobRefRange = (captured, help, start, end) => {
  // `subarray` is an O(1) view over the shared snapshot — no fresh copy, so
  // constructing a range neither reads nor persists bytes.
  const view = captured.subarray(start, end);
  // `@endo/sha256` rather than `node:crypto`: this module is on the XS daemon
  // bundle's compartment graph. The digest is over the bytes this attenuated
  // capability can read, independent of any source backend address.
  const hash = encodeBase64(sha256(view));

  return makeExo('BlobRef', BlobRefInterface, {
    async sha256() {
      return hash;
    },
    async size() {
      return BigInt(view.length);
    },
    async bytes() {
      return makeBytesReaderFromBytes(view);
    },
    // Range *attenuation*: `byteRange` returns a new `BlobRef` over the composed
    // interval intersected with this handle's authority; `textRange` selects a
    // line range of the current bytes and returns the corresponding byte slice.
    // Both derive from the same shared snapshot, so nested ranges intersect.
    byteRange(rangeStart, rangeEnd) {
      const { start: s, end: e } = assertByteRange(rangeStart, rangeEnd);
      const composed = composeByteInterval(start, end, s, e);
      return makeBlobRefRange(
        captured,
        undefined,
        composed.start,
        /** @type {number} */ (composed.end),
      );
    },
    async textRange(startLine, endLine) {
      const { startLine: s, endLine: e } = assertLineRange(startLine, endLine);
      if (e <= s) {
        return makeBlobRefRange(captured, undefined, start, start);
      }
      const slice = lineRangeToByteSlice(view, s, e);
      const composed = composeByteInterval(start, end, slice.start, slice.end);
      return makeBlobRefRange(
        captured,
        undefined,
        composed.start,
        /** @type {number} */ (composed.end),
      );
    },
    // Whole-value conveniences mirroring the daemon `EndoBlob` / lite
    // `SnapshotBlob` surface, decoding the selected bytes as UTF-8.
    async text() {
      return textDecoder.decode(view);
    },
    async json() {
      return JSON.parse(textDecoder.decode(view));
    },
    help(method) {
      if (method === undefined) {
        return help ?? 'BlobRef: content-addressed handle (DESIGN.md §6).';
      }
      return `No documentation available for method ${q(method)}.`;
    },
  });
};
harden(makeBlobRefRange);

/**
 * Mint a `BlobRef` from captured bytes. Its SHA-256 digest and size describe
 * those bytes; subsequent mutations to the originating file are independent.
 *
 * @param {Uint8Array} bytes
 * @param {string} [help] optional override for the `help()` body
 * @returns {BlobRef}
 */
export const makeBlobRefExo = (bytes, help) => {
  // The COPY is what makes these bytes immutable to the caller.
  // `harden` on a typed array does not freeze its elements, so it
  // buys nothing here beyond consistency with the rest of the file.
  const captured = harden(new Uint8Array(bytes));
  return makeBlobRefRange(captured, help, 0, captured.length);
};
harden(makeBlobRefExo);
