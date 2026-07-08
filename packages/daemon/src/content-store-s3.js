// @ts-check

/**
 * S3-backed content-addressed store for the Endo daemon: the
 * `ContentStore` contract of `@endo/platform/fs/lite/types` (sha-256
 * addressing with `size` and `readRange`) over one S3 bucket, the AWS
 * counterpart of the filesystem store built inside
 * `daemon-persistence-powers.js`.  The daemon flavour wraps the result
 * with `makeSnapshotStore` exactly as the filesystem store is wrapped.
 * Design: `designs/endo-daemon-aws-storage.md`.
 *
 * The store consumes a narrow, pre-authorized `S3BlobPowers` capability
 * rather than an SDK client, so this module carries no AWS dependency
 * and no ambient authority; the SDK adapter lives in
 * `daemon-aws-sdk.js`.
 */

import harden from '@endo/harden';
import { bytesToText } from '@endo/bytes/to-string.js';

/** @import { CryptoPowers } from './types.js' */

/**
 * A capability bound to one S3 bucket and key prefix (or a faithful
 * emulation).  A blob put or copied becomes visible atomically: a
 * reader never observes a partial blob.
 *
 * @typedef {object} S3BlobPowers
 * @property {(args: {
 *   key: string,
 *   readable: AsyncIterable<Uint8Array>,
 * }) => Promise<void>} putBlobStream
 * @property {(args: { key: string }) => Promise<boolean>} hasBlob
 * @property {(args: { key: string }) => Promise<AsyncIterable<Uint8Array>>} getBlobStream
 * @property {(args: {
 *   key: string,
 *   offset: number,
 *   length: number,
 * }) => Promise<Uint8Array>} getBlobRange
 * @property {(args: { key: string }) => Promise<bigint>} blobSize
 * @property {(args: { from: string, to: string }) => Promise<void>} copyBlob
 * @property {(args: { key: string }) => Promise<void>} deleteBlob
 */

/** @param {Array<Uint8Array>} chunks */
const concatChunks = chunks => {
  let byteLength = 0;
  for (const chunk of chunks) {
    byteLength += chunk.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * @param {object} args
 * @param {S3BlobPowers} args.blobPowers
 * @param {CryptoPowers} args.cryptoPowers
 * @returns {import('@endo/platform/fs/lite/types').ContentStore}
 */
export const makeS3ContentStore = ({ blobPowers, cryptoPowers }) => {
  /** @param {string} sha256 */
  const contentKey = sha256 => `store-sha256/${sha256}`;

  return harden({
    /**
     * @param {AsyncIterable<Uint8Array> | AsyncIterator<Uint8Array>} readableOrIterator
     * @returns {Promise<string>}
     */
    async store(readableOrIterator) {
      // No synchronous preamble.
      await null;

      const readable = /** @type {AsyncIterable<Uint8Array>} */ (
        /** @type {unknown} */ (readableOrIterator)
      );
      const digester = cryptoPowers.makeSha256();
      const stagingKey = `staging/${await cryptoPowers.randomHex256()}`;

      // The content hash (the final key) is unknown until the stream
      // ends, so stream to a staging key while digesting, then copy to
      // the content-addressed key, mirroring the filesystem engine's
      // temporary-file-then-atomic-rename dance.
      async function* digestingStream() {
        // No synchronous preamble.
        await null;
        const iterator =
          Symbol.asyncIterator in readable
            ? readable[Symbol.asyncIterator]()
            : /** @type {AsyncIterator<Uint8Array>} */ (
                /** @type {unknown} */ (readable)
              );
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const result = await iterator.next(undefined);
          if (result.done) {
            return;
          }
          digester.update(result.value);
          yield result.value;
        }
      }
      await blobPowers.putBlobStream({
        key: stagingKey,
        readable: digestingStream(),
      });

      const sha256 = digester.digestHex();
      if (!(await blobPowers.hasBlob({ key: contentKey(sha256) }))) {
        await blobPowers.copyBlob({
          from: stagingKey,
          to: contentKey(sha256),
        });
      }
      await blobPowers.deleteBlob({ key: stagingKey });
      return sha256;
    },

    /** @param {string} sha256 */
    fetch(sha256) {
      const key = contentKey(sha256);
      async function* streamContent() {
        // No synchronous preamble.
        await null;
        yield* await blobPowers.getBlobStream({ key });
      }
      const makeFileReader = () =>
        /** @type {import('@endo/stream').Reader<Uint8Array>} */ (
          streamContent()
        );
      const text = async () => {
        // No synchronous preamble.
        await null;
        const chunks = [];
        for await (const chunk of streamContent()) {
          chunks.push(chunk);
        }
        return bytesToText(concatChunks(chunks));
      };
      const json = async () => JSON.parse(await text());
      const size = () => blobPowers.blobSize({ key });
      /**
       * Windowed read of `[offset, offset + length)`, clamped at EOF,
       * matching `filePowers.readFileRange`.
       *
       * @param {number} offset
       * @param {number} length
       */
      const readRange = (offset, length) =>
        blobPowers.getBlobRange({ key, offset, length });
      return harden({ makeFileReader, text, json, size, readRange });
    },

    /**
     * @param {string} sha256
     * @returns {Promise<boolean>}
     */
    async has(sha256) {
      return blobPowers.hasBlob({ key: contentKey(sha256) });
    },

    /**
     * @param {string} sha256
     * @returns {Promise<void>}
     */
    async remove(sha256) {
      // DeleteObject is idempotent, like the filesystem engine's
      // force-remove: removing a missing blob is not an error.
      await blobPowers.deleteBlob({ key: contentKey(sha256) });
    },
  });
};
harden(makeS3ContentStore);
