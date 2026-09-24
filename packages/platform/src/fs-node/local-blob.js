// @ts-check

import fs from 'node:fs';
import harden from '@endo/harden';
import { encodeBase64 } from '@endo/base64';
import { makeExo } from '@endo/exo';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { makeNodeReader } from '@endo/stream-node';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { sha256 } from '@endo/sha256';

// `LocalBlob` exposes the whole-value read surface plus the richer `BlobRef`
// named read surface (`sha256` / `size` / `bytes`) so a remote reader can learn
// content hash + size in one round-trip and read byte ranges without
// streaming the whole file. See designs/fs-interface-consolidation.md § C4.
// It also carries the range *attenuation* surface (`byteRange` / `textRange`),
// which returns a new `LocalBlob` over a selected byte or line interval — the
// same interface, so ranges compose. See
// designs/readableblob-range-attenuation.md.
import { byteChunks } from '../blob.js';
import { ReadableBlobRangeInterface } from '../fs/interfaces.js';
import {
  assertByteRange,
  assertLineRange,
  composeByteInterval,
  lineRangeToByteSlice,
} from '../fs/range-attenuation.js';
/** @import { ReadableBlobRange } from '../fs/types.js' */
/** @import { ERef } from '@endo/eventual-send' */

/**
 * Read the byte window `[off, off + len)` from `filePath` as a `Uint8Array`,
 * clamped at EOF. `len === undefined` reads to EOF. Reads only the requested
 * window from disk rather than the whole file, and bounds the allocation by
 * the file size so a huge `len` against a small file cannot drive a multi-GB
 * allocation.
 *
 * @param {string} filePath
 * @param {number} off  a validated safe non-negative offset
 * @param {number | undefined} len  a validated safe non-negative length, or
 *   `undefined` to read to EOF
 * @returns {Promise<Uint8Array>}
 */
const readWindowNumber = async (filePath, off, len) => {
  if (len !== undefined && len <= 0) {
    return new Uint8Array(0);
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const available = Math.max(0, size - off);
    const clamped = len === undefined ? available : Math.min(len, available);
    if (clamped <= 0) {
      return new Uint8Array(0);
    }
    const buffer = new Uint8Array(clamped);
    const { bytesRead } = await handle.read(buffer, 0, clamped, off);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/**
 * Wrap a byte range as a `PassableBytesReader`. Empty ranges yield a reader
 * that is immediately done.
 *
 * @param {Uint8Array} bytes
 */
const bytesFromRange = bytes => {
  function* generator() {
    if (bytes.length > 0) {
      yield bytes;
    }
  }
  return bytesReaderFromIterator(generator());
};

/**
 * Creates a ReadableBlob Exo from a local file.
 * Streams file content as passable immutable byte arrays.
 *
 * `interval` is the absolute byte interval over the file this handle exposes:
 * `{ start, end }` with `end === undefined` meaning "to EOF" — an unattenuated
 * blob over the whole file. A `byteRange` / `textRange` attenuation re-invokes this
 * factory with a composed interval (the source path plus the interval), so the
 * derived handle has the same interface and a range of a range intersects.
 *
 * @param {string} filePath
 * @param {{ start: number, end: number | undefined }} [interval]
 * @returns {ReadableBlobRange}
 */
export const makeLocalBlob = (
  filePath,
  interval = { start: 0, end: undefined },
) => {
  const { start, end } = interval;
  // The whole-file fast paths (native `readFile` / streaming) are correct only
  // for the unattenuated handle; an attenuated view reads its selected bytes.
  const isFull = start === 0 && end === undefined;
  const selectedLength = end === undefined ? undefined : end - start;
  /** @returns {Promise<Uint8Array>} the receiver's currently selected bytes */
  const readSelected = () => readWindowNumber(filePath, start, selectedLength);

  /** @satisfies {ReadableBlobRange} */
  const localBlobMethods = {
    /** @param {ERef<unknown>} synPromise */
    stream(synPromise) {
      if (isFull) {
        const nodeReadStream = fs.createReadStream(filePath);
        const reader = makeNodeReader(nodeReadStream);
        return bytesReaderFromIterator(reader).stream(
          /** @type {any} */ (synPromise),
        );
      }
      // Attenuated view: stream the selected bytes in reader-sized frames.
      return bytesReaderFromIterator(byteChunks(readSelected())).stream(
        /** @type {any} */ (synPromise),
      );
    },
    text: async () =>
      isFull
        ? fs.promises.readFile(filePath, 'utf-8')
        : decodeUtf8(await readSelected()),
    json: async () =>
      JSON.parse(
        isFull
          ? await fs.promises.readFile(filePath, 'utf-8')
          : decodeUtf8(await readSelected()),
      ),
    // The `{ algorithm, hash, size }` content-address triple. `hash` is base64
    // to match the extended `BlobRef`. Computed over the currently selected
    // content — for an attenuated view, the selected bytes' own SHA-256.
    async sha256() {
      const bytes = isFull
        ? await fs.promises.readFile(filePath)
        : await readSelected();
      return encodeBase64(sha256(bytes));
    },
    async size() {
      return isFull
        ? BigInt((await fs.promises.stat(filePath)).size)
        : BigInt((await readSelected()).length);
    },
    async bytes() {
      return bytesFromRange(await readSelected());
    },
    // Range *attenuation*: `byteRange` resolves synchronously (no bytes read) to a
    // new `LocalBlob` over the composed byte interval, intersected with this
    // handle's authority.
    /**
     * @param {bigint} rangeStart
     * @param {bigint} rangeEnd
     */
    byteRange(rangeStart, rangeEnd) {
      const { start: s, end: e } = assertByteRange(rangeStart, rangeEnd);
      const composed = composeByteInterval(start, end, s, e);
      return makeLocalBlob(filePath, composed);
    },
    // `textRange` reads the selected bytes to find LF line boundaries, then
    // returns a `LocalBlob` over the corresponding byte slice.
    /**
     * @param {number} startLine
     * @param {number} endLine
     */
    async textRange(startLine, endLine) {
      const { startLine: s, endLine: e } = assertLineRange(startLine, endLine);
      if (e <= s) {
        return makeLocalBlob(filePath, { start, end: start });
      }
      const bytes = await readSelected();
      const slice = lineRangeToByteSlice(bytes, s, e);
      const composed = composeByteInterval(start, end, slice.start, slice.end);
      return makeLocalBlob(filePath, composed);
    },
    help: method =>
      method === undefined
        ? 'LocalBlob: read-only handle to a host file (bytes, byteRange, text, textRange, json, sha256, size, stream).'
        : `No documentation for method ${method}.`,
  };

  return makeExo('LocalBlob', ReadableBlobRangeInterface, localBlobMethods);
};
harden(makeLocalBlob);
