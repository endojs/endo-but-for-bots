// @ts-check

// Pins the per-frame bound on readable-blob uploads. `formulateReadableBlob`
// drains the uploader's reader through `iterateReadableBlobUpload`, which these
// tests drive directly. The limit moved from base64 characters to raw bytes in
// the byte-stream change, and an unconverted literal would silently widen the
// bound by a third, so both edges are checked in raw bytes.

// eslint-disable-next-line import/order
import '@endo/init/debug.js';
import test from 'ava';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import {
  READABLE_BLOB_FRAME_BYTE_LENGTH_LIMIT,
  iterateReadableBlobUpload,
} from '../src/manager.js';

/** @param {number} length */
const drainOneFrame = async length => {
  const reader = bytesReaderFromIterator(
    (async function* produce() {
      yield new Uint8Array(length);
    })(),
  );
  let total = 0;
  for await (const chunk of iterateReadableBlobUpload(reader)) {
    total += chunk.length;
  }
  return total;
};

test('readable-blob frame limit is 7_500_000 raw bytes', t => {
  t.is(READABLE_BLOB_FRAME_BYTE_LENGTH_LIMIT, 7_500_000);
});

test('readable-blob upload admits a frame of exactly the limit', async t => {
  t.is(
    await drainOneFrame(READABLE_BLOB_FRAME_BYTE_LENGTH_LIMIT),
    READABLE_BLOB_FRAME_BYTE_LENGTH_LIMIT,
  );
});

test('readable-blob upload rejects a frame one byte over the limit', async t => {
  await t.throwsAsync(() =>
    drainOneFrame(READABLE_BLOB_FRAME_BYTE_LENGTH_LIMIT + 1),
  );
});
