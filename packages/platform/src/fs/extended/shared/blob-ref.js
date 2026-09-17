// @ts-check
/**
 * `BlobRef` exo factory — a content-addressed handle over a
 * captured `Uint8Array` snapshot (DESIGN.md §6).
 *
 * Identical across the in-memory, node-fs, and from-mount
 * `Filesystem` implementations: defensively copy the bytes,
 * SHA-256 them, return an exo whose `getInfo()` carries
 * the algorithm / hash / size triple and whose `fetch(offset,
 * length)` returns a `PassableBytesReader` over the captured
 * range.
 */

import { makeExo } from '@endo/exo';
import { encodeBase64 } from '@endo/base64';
import { sha256 } from '@endo/sha256';
import { q } from '@endo/errors';

import { BlobRefInterface } from '../type-guards.js';
import {
  EMPTY_BYTES,
  makeBytesReaderFromBytes,
  toSafeNumber,
} from './helpers.js';
import {
  assertByteRange,
  assertLineRange,
  composeByteInterval,
  lineRangeToByteSlice,
} from '../../range-attenuation.js';

/** @import { BlobInfo, BlobRef } from '../types.js' */

const textDecoder = new TextDecoder();

/**
 * Mint a `BlobRef` from a captured `Uint8Array`. The `BlobRef`'s
 * identity (algorithm + hash + size) is computed at construction;
 * subsequent mutations to the originating file are independent.
 *
 * When `infoOverride` is supplied, its `{ algorithm, hash }` are used
 * verbatim instead of the default SHA-256-over-captured-bytes — a
 * content-address backend (e.g. the git-tree FsBackend) supplies the
 * native hash it already knows (`git-sha1` blob OID), which git computes
 * over the framed payload `blob <size>\0<bytes>`, NOT the raw bytes, so a
 * consumer comparing hashes across sources must distinguish the two.
 * `size` is always the captured byte length regardless of the override.
 *
 * @param {Uint8Array} bytes
 * @param {string} [help]  optional override for the `help()` body
 * @param {{ algorithm: string, hash: string }} [infoOverride]
 *   optional backend-supplied algorithm + hash
 * @returns {BlobRef}
 */
/**
 * Inner factory shared by the public `makeBlobRefExo` and its derived range
 * attenuations. `captured` is the immutable source snapshot; `[start, end)` is
 * the absolute byte interval this handle exposes over it (the source cap plus a
 * composed interval — a range of a range intersects and can never regain
 * authority outside its parent). A derived range drops any `infoOverride`
 * (which named the whole source's content address) and reports the selected
 * content's own SHA-256, so `getInfo()` always describes the bytes actually
 * readable through the handle.
 *
 * @param {Uint8Array} captured
 * @param {string | undefined} help
 * @param {{ algorithm: string, hash: string } | undefined} infoOverride
 * @param {number} start
 * @param {number} end
 * @returns {BlobRef}
 */
const makeBlobRefRange = (captured, help, infoOverride, start, end) => {
  // `subarray` is an O(1) view over the shared snapshot — no fresh copy, so
  // constructing a range neither reads nor persists bytes.
  const view = captured.subarray(start, end);
  /** @type {BlobInfo} */
  let info;
  if (infoOverride !== undefined) {
    info = harden({
      algorithm: infoOverride.algorithm,
      hash: infoOverride.hash,
      size: BigInt(view.length),
    });
  } else {
    // `@endo/sha256` rather than `node:crypto`: this module is on the XS
    // daemon bundle's compartment graph, and a static `node:crypto` import
    // is unresolvable there (`designs/platform-neutral-hash.md`).  The
    // digest bytes are identical either way.
    const hashBytes = sha256(view);
    info = harden({
      algorithm: 'sha256',
      // `encodeBase64` over the raw digest bytes matches the base64 hash
      // spelling every other implementer uses, rather than the Node-only
      // `Buffer.prototype.toString('base64')`.
      hash: encodeBase64(hashBytes),
      size: BigInt(view.length),
    });
  }

  return makeExo('BlobRef', BlobRefInterface, {
    getInfo() {
      return info;
    },
    async fetch(offset, length) {
      const off = toSafeNumber(offset, 'offset');
      const len = toSafeNumber(length, 'length');
      const sliceEnd = Math.min(off + len, view.length);
      const slice = off >= view.length ? EMPTY_BYTES : view.slice(off, sliceEnd);
      return makeBytesReaderFromBytes(slice);
    },
    // Range *attenuation*: `range` returns a new `BlobRef` over the composed
    // interval intersected with this handle's authority; `textRange` selects a
    // line range of the current bytes and returns the corresponding byte slice.
    // Both derive from the same shared snapshot, so nested ranges intersect.
    range(rangeStart, rangeEnd) {
      const { start: s, end: e } = assertByteRange(rangeStart, rangeEnd);
      const composed = composeByteInterval(start, end, s, e);
      return makeBlobRefRange(
        captured,
        undefined,
        undefined,
        composed.start,
        /** @type {number} */ (composed.end),
      );
    },
    async textRange(startLine, endLine) {
      const { startLine: s, endLine: e } = assertLineRange(startLine, endLine);
      if (e <= s) {
        return makeBlobRefRange(captured, undefined, undefined, start, start);
      }
      const slice = lineRangeToByteSlice(view, s, e);
      const composed = composeByteInterval(start, end, slice.start, slice.end);
      return makeBlobRefRange(
        captured,
        undefined,
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

export const makeBlobRefExo = (bytes, help, infoOverride) => {
  // The COPY is what makes these bytes immutable to the caller.
  // `harden` on a typed array does not freeze its elements, so it
  // buys nothing here beyond consistency with the rest of the file.
  const captured = harden(new Uint8Array(bytes));
  return makeBlobRefRange(captured, help, infoOverride, 0, captured.length);
};
harden(makeBlobRefExo);
