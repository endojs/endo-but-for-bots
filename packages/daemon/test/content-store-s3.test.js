// @ts-check

/**
 * Proves the S3-backed `ContentStore` (`src/content-store-s3.js`)
 * against the in-memory blob-power emulation in `aws-emulator.js`.
 * Design: `designs/endo-daemon-aws-storage.md` § Test plan.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'crypto';

import { bytesFromText } from '@endo/bytes/from-string.js';
import { makeCryptoPowers } from '../src/daemon-node-powers.js';
import { makeS3ContentStore } from '../src/content-store-s3.js';
import { makeBlobEmulator } from './aws-emulator.js';

const cryptoPowers = makeCryptoPowers(crypto);

const makeStore = () => {
  const blobs = makeBlobEmulator();
  const contentStore = makeS3ContentStore({ blobPowers: blobs, cryptoPowers });
  return { blobs, contentStore };
};

/** @param {Uint8Array} bytes */
const chunked = bytes =>
  (async function* readable() {
    // Deliberately many small chunks, to exercise streaming.
    for (let offset = 0; offset < bytes.byteLength; offset += 3) {
      yield bytes.subarray(offset, offset + 3);
    }
  })();

/** @param {AsyncIterable<Uint8Array> | AsyncIterator<Uint8Array>} reader */
const collectReader = async reader => {
  // No synchronous preamble.
  await null;

  const chunks = [];
  const iterator =
    Symbol.asyncIterator in reader
      ? /** @type {AsyncIterable<Uint8Array>} */ (reader)[
          Symbol.asyncIterator
        ]()
      : /** @type {AsyncIterator<Uint8Array>} */ (reader);
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await iterator.next(undefined);
    if (result.done) {
      break;
    }
    chunks.push(result.value);
  }
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

test('content store round-trips text, json, and streamed bytes', async t => {
  const { contentStore } = makeStore();
  const content = JSON.stringify({ hello: 'aws' });
  const contentBytes = bytesFromText(content);
  const expectedSha256 = crypto
    .createHash('sha256')
    .update(contentBytes)
    .digest('hex');

  const sha256 = await contentStore.store(chunked(contentBytes));
  t.is(sha256, expectedSha256);

  const blob = contentStore.fetch(sha256);
  t.is(await blob.text(), content);
  t.deepEqual(await blob.json(), { hello: 'aws' });
  t.deepEqual(await collectReader(blob.makeFileReader()), contentBytes);
});

test('content store deduplicates and leaves no staging keys', async t => {
  const { contentStore, blobs } = makeStore();
  const contentBytes = bytesFromText('same content twice');

  const first = await contentStore.store(chunked(contentBytes));
  const second = await contentStore.store(chunked(contentBytes));
  t.is(first, second);
  t.deepEqual(blobs.keys(), [`store-sha256/${first}`]);
});

test('content store reports size and serves clamped ranges', async t => {
  const { contentStore } = makeStore();
  const contentBytes = bytesFromText('0123456789');
  const sha256 = await contentStore.store(chunked(contentBytes));

  const blob = contentStore.fetch(sha256);
  const { size, readRange } = blob;
  t.truthy(size);
  t.truthy(readRange);
  t.is(
    await /** @type {NonNullable<typeof size>} */ (size)(),
    BigInt(contentBytes.byteLength),
  );
  const range = /** @type {NonNullable<typeof readRange>} */ (readRange);
  t.deepEqual(await range(2, 3), bytesFromText('234'));
  // Clamped at EOF.
  t.deepEqual(await range(8, 10), bytesFromText('89'));
  // Starting at or past EOF is empty, not an error.
  t.deepEqual(await range(10, 4), new Uint8Array(0));
});

test('content store has and remove are honest and idempotent', async t => {
  const { contentStore } = makeStore();
  const contentBytes = bytesFromText('removable');
  const sha256 = await contentStore.store(chunked(contentBytes));

  t.true(await contentStore.has(sha256));
  t.false(await contentStore.has('0'.repeat(64)));
  await contentStore.remove(sha256);
  t.false(await contentStore.has(sha256));
  // Removing a missing blob is not an error.
  await t.notThrowsAsync(() => contentStore.remove(sha256));
});
