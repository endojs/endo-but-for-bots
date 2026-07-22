// @ts-check
/**
 * `BlobRef` exo factory — a content-addressed handle over a
 * captured `Uint8Array` snapshot (DESIGN.md §6).
 *
 * Identical across the in-memory, node-fs, and from-mount
 * `Filesystem` implementations: defensively copy + harden the
 * bytes, SHA-256 them, return an exo whose `getInfo()` carries
 * the algorithm / hash / size triple and whose `fetch(offset,
 * length)` returns a `PassableBytesReader` over the captured
 * range.
 */

import { createHash } from 'node:crypto';

import { makeExo } from '@endo/exo';
import { encodeBase64 } from '@endo/base64';
import { q } from '@endo/errors';

import { BlobRefInterface } from '../type-guards.js';
import { blobFromBytes } from '../../../blob.js';
import {
  EMPTY_BYTES,
  makeBytesReaderFromBytes,
  toSafeNumber,
} from './helpers.js';

const textDecoder = new TextDecoder();

/**
 * Mint a `BlobRef` from a captured `Uint8Array`. The `BlobRef`'s
 * identity (algorithm + hash + size) is computed at construction;
 * subsequent mutations to the originating file are independent.
 *
 * @param {Uint8Array} bytes
 * @param {string} [help]  optional override for the `help()` body
 */
export const makeBlobRefExo = (bytes, help) => {
  const captured = harden(new Uint8Array(bytes));
  const hashBytes = createHash('sha256').update(captured).digest();
  const info = harden({
    algorithm: 'sha256',
    // `encodeBase64` (over the `Buffer`, a `Uint8Array` subclass) matches the
    // base64 hash spelling every other implementer in this PR uses, rather
    // than the Node-only `Buffer.prototype.toString('base64')`.
    hash: encodeBase64(hashBytes),
    size: BigInt(captured.length),
  });

  return makeExo('BlobRef', BlobRefInterface, {
    getInfo() {
      return info;
    },
    async fetch(offset, length) {
      const off = toSafeNumber(offset, 'offset');
      const len = toSafeNumber(length, 'length');
      const end = Math.min(off + len, captured.length);
      const slice =
        off >= captured.length ? EMPTY_BYTES : captured.slice(off, end);
      return makeBytesReaderFromBytes(slice);
    },
    async range(start, end) {
      const startOffset = toSafeNumber(start, 'start');
      const endOffset = toSafeNumber(end, 'end');
      if (endOffset < startOffset) {
        throw new Error('EINVAL: end must not precede start');
      }
      return blobFromBytes(
        captured.slice(startOffset, Math.min(endOffset, captured.length)),
      );
    },
    async textRange(startLine, endLine) {
      const start = toSafeNumber(startLine, 'startLine');
      const end = toSafeNumber(endLine, 'endLine');
      if (end < start) {
        throw new Error('EINVAL: endLine must not precede startLine');
      }
      const starts = [0];
      for (let offset = 0; offset < captured.length; offset += 1) {
        if (captured[offset] === 0x0a) starts.push(offset + 1);
      }
      return blobFromBytes(
        captured.slice(
          starts[Math.min(start, starts.length - 1)],
          end >= starts.length ? captured.length : starts[end],
        ),
      );
    },
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
