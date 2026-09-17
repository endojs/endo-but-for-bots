// @ts-check

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import harden from '@endo/harden';
import { encodeBase64 } from '@endo/base64';
import { makeExo } from '@endo/exo';
import { makeReaderPump } from '@endo/exo-stream/reader-pump.js';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { mapReader } from '@endo/stream';
import { makeNodeReader } from '@endo/stream-node';

// `LocalBlob` exposes the whole-value read surface plus the richer `BlobRef`
// range-I/O surface (`getInfo` / `fetch`) so a remote reader can learn the
// content hash + size in one round-trip and read byte ranges without
// streaming the whole file. See designs/fs-interface-consolidation.md § C4.
// It also carries the range *attenuation* surface (`range` / `textRange`),
// which returns a new `LocalBlob` over a selected byte or line interval — the
// same interface, so ranges compose. See
// designs/readableblob-range-attenuation.md.
import { ReadableBlobRangeReadInterface } from '../fs/interfaces.js';
import {
  assertByteRange,
  assertLineRange,
  composeByteInterval,
  lineRangeToByteSlice,
} from '../fs/range-attenuation.js';
import { toSafeNumber } from '../fs/extended/shared/helpers.js';

/** @import { ReadableBlobRangeRead } from '../fs/types.js' */

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
const readWindowNum = async (filePath, off, len) => {
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
 * Streams file content as base64 via @endo/stream-node.
 *
 * `interval` is the absolute byte interval over the file this handle exposes:
 * `{ start, end }` with `end === undefined` meaning "to EOF" — an unattenuated
 * blob over the whole file. A `range` / `textRange` attenuation re-invokes this
 * factory with a composed interval (the source path plus the interval), so the
 * derived handle has the same interface and a range of a range intersects.
 *
 * @param {string} filePath
 * @param {{ start: number, end: number | undefined }} [interval]
 * @returns {ReadableBlobRangeRead}
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
  const readSelected = () => readWindowNum(filePath, start, selectedLength);

  /**
   * Read a window `[offset, offset + length)` measured within the selected
   * interval, clamped at the interval's end and at EOF.
   *
   * @param {bigint} offset
   * @param {bigint} length
   */
  const readWindowInSelection = async (offset, length) => {
    // Validate at the bigint→Number boundary (same `toSafeNumber` the daemon
    // and `BlobRef` paths use) so negative or out-of-range windows throw
    // `EINVAL` rather than reaching `fs.read` with a bad position.
    const off = toSafeNumber(offset, 'offset');
    const len = toSafeNumber(length, 'length');
    const absOff = start + off;
    // Clamp the requested length at the selected interval's end (if bounded).
    const boundedLen =
      end === undefined ? len : Math.min(len, Math.max(0, end - absOff));
    return readWindowNum(filePath, absOff, boundedLen);
  };

  /** @satisfies {ReadableBlobRangeRead} */
  const localBlobMethods = {
    /** @param {import('@endo/eventual-send').ERef<unknown>} synPromise */
    streamBase64(synPromise) {
      if (isFull) {
        const nodeReadStream = fs.createReadStream(filePath);
        const reader = makeNodeReader(nodeReadStream);
        const pump = makeReaderPump(mapReader(reader, encodeBase64));
        return pump(/** @type {any} */ (synPromise));
      }
      // Attenuated view: stream the selected bytes as one base64 chunk.
      const pump = makeReaderPump(
        mapReader(
          /** @type {any} */ (
            (async function* selected() {
              const bytes = await readSelected();
              if (bytes.length > 0) yield bytes;
            })()
          ),
          encodeBase64,
        ),
      );
      return pump(/** @type {any} */ (synPromise));
    },
    text: async () =>
      isFull
        ? fs.promises.readFile(filePath, 'utf-8')
        : new TextDecoder().decode(await readSelected()),
    json: async () =>
      JSON.parse(
        isFull
          ? await fs.promises.readFile(filePath, 'utf-8')
          : new TextDecoder().decode(await readSelected()),
      ),
    // The `{ algorithm, hash, size }` content-address triple. `hash` is base64
    // to match the extended `BlobRef`. Computed over the currently selected
    // content — for an attenuated view, the selected bytes' own SHA-256.
    async getInfo() {
      const bytes = isFull ? await fs.promises.readFile(filePath) : await readSelected();
      const hash = encodeBase64(createHash('sha256').update(bytes).digest());
      return harden({
        algorithm: 'sha256',
        hash,
        size: BigInt(bytes.length),
      });
    },
    // Windowed read of `[offset, offset + length)` within the selected
    // interval, clamped at EOF — reads only the requested window from disk.
    /**
     * @param {bigint} offset
     * @param {bigint} length
     */
    async fetch(offset, length) {
      return bytesFromRange(await readWindowInSelection(offset, length));
    },
    // Whole-value windowed read: the raw bytes of `[offset, offset + length)`
    // within the selected interval, clamped at EOF, as a `Uint8Array`.
    /**
     * @param {bigint} offset
     * @param {bigint} length
     */
    async rangeRead(offset, length) {
      return readWindowInSelection(offset, length);
    },
    // Whole-value line-range read: decode the selected bytes as UTF-8 and
    // return lines `[startLine, endLine)` (0-based, end-exclusive) joined with
    // '\n'. A negative or non-integer index throws EINVAL (via `toSafeNumber`);
    // an `endLine` past the last line clamps to the end.
    /**
     * @param {number} startLine
     * @param {number} endLine
     */
    async rangeReadText(startLine, endLine) {
      const s = toSafeNumber(startLine, 'startLine');
      const e = toSafeNumber(endLine, 'endLine');
      if (e <= s) {
        return '';
      }
      const text = isFull
        ? await fs.promises.readFile(filePath, 'utf-8')
        : new TextDecoder().decode(await readSelected());
      const lines = text.split('\n');
      return lines.slice(s, e).join('\n');
    },
    // Range *attenuation*: `range` resolves synchronously (no bytes read) to a
    // new `LocalBlob` over the composed byte interval, intersected with this
    // handle's authority.
    /**
     * @param {bigint} rangeStart
     * @param {bigint} rangeEnd
     */
    range(rangeStart, rangeEnd) {
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
        ? 'LocalBlob: read-only handle to a host file (text, json, streamBase64, getInfo, fetch, rangeRead, rangeReadText, range, textRange).'
        : `No documentation for method ${method}.`,
  };

  return makeExo('LocalBlob', ReadableBlobRangeReadInterface, localBlobMethods);
};
harden(makeLocalBlob);
