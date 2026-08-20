// @ts-check
/**
 * `BlobRef` exo factory — a content-addressed handle over a
 * captured `Uint8Array` snapshot (DESIGN.md §6).
 *
 * Identical across the in-memory, node-fs, and from-mount
 * `Filesystem` implementations: defensively copy + harden the
 * bytes, SHA-256 them, return an exo whose `getInfo()` carries
 * the algorithm / hash / size triple, whose `text()` / `json()` /
 * `streamBase64()` read the whole captured bytes, and whose
 * `range(start, end)` / `textRange(startLine, endLine)` attenuate to a
 * byte / line window over the captured bytes
 * (designs/readableblob-range-attenuation.md).
 */

import { makeExo } from '@endo/exo';
import { encodeBase64 } from '@endo/base64';
import { sha256 } from '@endo/sha256';
import { makeReaderPump } from '@endo/exo-stream/reader-pump.js';
import { q } from '@endo/errors';

import { BlobRefInterface } from '../type-guards.js';
import { makeBlobRangeMethods, encodeBase64Chunks } from '../../blob-range.js';
import { toSafeNumber } from './helpers.js';

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
export const makeBlobRefExo = (bytes, help, infoOverride) => {
  // The COPY is what makes these bytes immutable to the caller.
  // `harden` on a typed array does not freeze its elements, so it
  // buys nothing here beyond consistency with the rest of the file.
  const captured = harden(new Uint8Array(bytes));
  /** @type {BlobInfo} */
  let info;
  if (infoOverride !== undefined) {
    info = harden({
      algorithm: infoOverride.algorithm,
      hash: infoOverride.hash,
      size: BigInt(captured.length),
    });
  } else {
    // `@endo/sha256` rather than `node:crypto`: this module is on the XS
    // daemon bundle's compartment graph, and a static `node:crypto` import
    // is unresolvable there (`designs/platform-neutral-hash.md`).  The
    // digest bytes are identical either way.
    const hashBytes = sha256(captured);
    info = harden({
      algorithm: 'sha256',
      // `encodeBase64` over the raw digest bytes matches the base64 hash
      // spelling every other implementer uses, rather than the Node-only
      // `Buffer.prototype.toString('base64')`.
      hash: encodeBase64(hashBytes),
      size: BigInt(captured.length),
    });
  }

  // Attenuation over the captured bytes. `getInfo` on a derived range reports
  // the SHA-256 of the *selected* bytes (a stable content address for the
  // selection), independent of this `BlobRef`'s own `infoOverride`-or-computed
  // whole-blob identity above.
  const { range, textRange } = makeBlobRangeMethods({
    readWindow: (start, end) => {
      const from = toSafeNumber(start, 'start');
      const to =
        end === undefined
          ? captured.length
          : Math.min(toSafeNumber(end, 'end'), captured.length);
      return Promise.resolve(
        from >= captured.length || to <= from
          ? new Uint8Array(0)
          : captured.slice(from, to),
      );
    },
    hashBytes: selected => sha256(selected),
    label: 'BlobRef range',
  });

  return makeExo('BlobRef', BlobRefInterface, {
    getInfo() {
      return info;
    },
    /** @param {unknown} synPromise */
    streamBase64(synPromise) {
      return makeReaderPump(encodeBase64Chunks(captured))(
        /** @type {any} */ (synPromise),
      );
    },
    range,
    textRange,
    // Whole-value conveniences mirroring the daemon `EndoBlob` / lite
    // `SnapshotBlob` surface, decoding the captured bytes as UTF-8.
    async text() {
      return textDecoder.decode(captured);
    },
    async json() {
      return JSON.parse(textDecoder.decode(captured));
    },
    help(method) {
      if (method === undefined) {
        return help ?? 'BlobRef: content-addressed handle (DESIGN.md §6).';
      }
      return `No documentation for method ${q(method)}.`;
    },
  });
};
harden(makeBlobRefExo);
