// @ts-check

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import harden from '@endo/harden';
import { encodeBase64 } from '@endo/base64';
import { bytesToText } from '@endo/bytes/to-string.js';
import { makeExo } from '@endo/exo';
import { makeReaderPump } from '@endo/exo-stream/reader-pump.js';
import { mapReader } from '@endo/stream';
import { makeNodeReader } from '@endo/stream-node';

// `LocalBlob` exposes the whole-value read surface plus the rich `ReadableBlob`
// content-address + attenuation surface (`getInfo` / `range` / `textRange`) so
// a remote reader can learn the content hash + size in one round-trip and
// attenuate to byte windows without streaming the whole file (a `range` reads
// only its window; a `textRange` line window still scans the current content to
// locate LFs). See designs/readableblob-range-attenuation.md.
import { RichReadableBlobInterface } from '../fs/interfaces.js';
import { makeBlobRangeMethods } from '../fs/blob-range.js';
import { toSafeNumber } from '../fs/extended/shared/helpers.js';

/** @import { RichReadableBlob } from '../fs/types.js' */

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read the absolute half-open byte interval `[start, end)` from `filePath` as a
 * `Uint8Array`, clamped at end-of-content (`end === undefined` reads to EOF).
 * Reads only the requested window from disk rather than the whole file. This is
 * the `readWindow` primitive the shared range attenuator
 * (`makeBlobRangeMethods`) drives.
 *
 * The window length is **not** derived from `stat().size`: virtual files
 * (`/proc`, `sysfs`) and FIFOs report `size: 0` (or a stale size) while still
 * yielding real bytes, and a single `fs.read` can return short. Deriving the
 * length from `size` there would silently truncate the window to nothing and
 * let `getInfo`/`text` mint a false content address (the SHA-256 of the empty
 * string) for a file that has content. Instead we read in a loop from the
 * requested position until the requested byte count is satisfied or the source
 * signals EOF (`bytesRead === 0`).
 *
 * @param {string} filePath
 * @param {bigint} start
 * @param {bigint | undefined} end
 * @returns {Promise<Uint8Array>}
 */
const readFileWindow = async (filePath, start, end) => {
  // Validate at the bigint→Number boundary (same `toSafeNumber` the daemon
  // and `BlobRef` paths use) so negative / out-of-range windows throw
  // `EINVAL` rather than reaching `fs.read` with a bad position.
  const from = toSafeNumber(start, 'start');
  const to = end === undefined ? undefined : toSafeNumber(end, 'end');
  if (to !== undefined && to <= from) {
    return new Uint8Array(0);
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    /** @type {Uint8Array[]} */
    const parts = [];
    let total = 0;
    let position = from;
    for (;;) {
      const remaining =
        to === undefined
          ? READ_CHUNK_BYTES
          : Math.min(READ_CHUNK_BYTES, to - from - total);
      if (remaining <= 0) {
        break;
      }
      const buffer = new Uint8Array(remaining);
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await handle.read(buffer, 0, remaining, position);
      if (bytesRead === 0) {
        break;
      }
      parts.push(
        bytesRead === remaining ? buffer : buffer.subarray(0, bytesRead),
      );
      total += bytesRead;
      position += bytesRead;
    }
    if (parts.length === 1) {
      return parts[0];
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  } finally {
    await handle.close();
  }
};

/**
 * Creates a ReadableBlob Exo from a local file.
 * Streams file content as base64 via @endo/stream-node.
 *
 * @param {string} filePath
 * @returns {RichReadableBlob}
 */
export const makeLocalBlob = filePath => {
  const { range, textRange } = makeBlobRangeMethods({
    readWindow: (start, end) => readFileWindow(filePath, start, end),
    hashBytes: bytes => createHash('sha256').update(bytes).digest(),
    label: 'LocalBlob range',
  });
  /** @satisfies {RichReadableBlob} */
  const localBlobMethods = {
    /** @param {import('@endo/eventual-send').ERef<unknown>} synPromise */
    streamBase64(synPromise) {
      const nodeReadStream = fs.createReadStream(filePath);
      const reader = makeNodeReader(nodeReadStream);
      const pump = makeReaderPump(mapReader(reader, encodeBase64));
      return pump(/** @type {any} */ (synPromise));
    },
    // Decode via `bytesToText` (the same UTF-8 path the derived ranges use)
    // rather than `readFile(path, 'utf-8')`: Node's string decode retains a
    // leading BOM while the `TextDecoder` the range path uses strips it, so the
    // two diverged on a BOM'd file and `range(0n, size).text()` no longer
    // equaled the whole-value `text()`. Reading bytes and decoding through one
    // shared path restores that attenuation identity.
    text: async () => bytesToText(await fs.promises.readFile(filePath)),
    json: async () =>
      JSON.parse(bytesToText(await fs.promises.readFile(filePath))),
    // The `{ algorithm, hash, size }` content-address triple. `hash` is base64
    // to match the extended `BlobRef`. Computed over the current file content.
    async getInfo() {
      const bytes = await fs.promises.readFile(filePath);
      const hash = encodeBase64(createHash('sha256').update(bytes).digest());
      return harden({
        algorithm: 'sha256',
        hash,
        size: BigInt(bytes.length),
      });
    },
    // Byte-window and line-window attenuation: return a new `ReadableBlob` with
    // exactly the authority to read the selected portion of this file. See
    // designs/readableblob-range-attenuation.md.
    range,
    textRange,
    help: method =>
      method === undefined
        ? 'LocalBlob: read-only handle to a host file (text, json, streamBase64, getInfo, range, textRange).'
        : `No documentation for method ${method}.`,
  };
  return makeExo('LocalBlob', RichReadableBlobInterface, localBlobMethods);
};
harden(makeLocalBlob);
