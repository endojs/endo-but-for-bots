// @ts-check

import harden from '@endo/harden';
import { encodeHex } from '@endo/hex/encode.js';
import { createHash } from 'node:crypto';

/** @import { ContentStoreLike } from '../src/types.js' */

/**
 * In-memory ContentStore for unit tests (no filesystem).
 *
 * @returns {ContentStoreLike & { size: () => number }}
 */
export const makeMemoryContentStore = () => {
  /** @type {Map<string, Uint8Array>} */
  const blobs = new Map();

  /**
   * @param {AsyncIterator<Uint8Array> | AsyncIterable<Uint8Array>} readableOrIterator
   */
  const collect = async readableOrIterator => {
    await null;
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    if (
      readableOrIterator &&
      typeof readableOrIterator === 'object' &&
      Symbol.asyncIterator in readableOrIterator
    ) {
      for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
        readableOrIterator
      )) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    } else {
      const iterator = /** @type {AsyncIterator<Uint8Array>} */ (
        readableOrIterator
      );
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        chunks.push(next.value);
        total += next.value.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  };

  return harden({
    size: () => blobs.size,
    /**
     * @param {AsyncIterator<Uint8Array> | AsyncIterable<Uint8Array>} readable
     */
    async store(readable) {
      const bytes = await collect(readable);
      const sha256 = encodeHex(
        new Uint8Array(createHash('sha256').update(bytes).digest()),
      );
      if (!blobs.has(sha256)) {
        blobs.set(sha256, bytes);
      }
      return sha256;
    },
    /** @param {string} sha256 */
    fetch(sha256) {
      const bytes = blobs.get(sha256);
      if (bytes === undefined) {
        throw Error(`CAS missing ${sha256}`);
      }
      return harden({
        makeFileReader: () => ({
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        }),
        text: async () => new TextDecoder().decode(bytes),
        size: async () => BigInt(bytes.byteLength),
        readRange: async (offset, length) =>
          bytes.subarray(offset, offset + length),
      });
    },
    /** @param {string} sha256 */
    async has(sha256) {
      return blobs.has(sha256);
    },
  });
};
harden(makeMemoryContentStore);
