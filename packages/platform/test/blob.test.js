// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { fc } from '@fast-check/ava';

import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

import { blobFromBytes } from '../src/blob.js';

test('blobFromBytes exposes bytes through the ReadableBlob surface', async t => {
  const bytes = new TextEncoder().encode('{"answer":42}');
  const blob = blobFromBytes(Promise.resolve(bytes));

  await null;
  t.is(await blob.text(), '{"answer":42}');
  t.deepEqual(await blob.json(), { answer: 42 });

  /** @type {number[]} */
  const recovered = [];
  for await (const chunk of iterateBytesReader(/** @type {any} */ (blob))) {
    recovered.push(...chunk);
  }
  t.deepEqual(recovered, [...bytes]);
});

// The `byteChunks` rewrite slices the source with
// `bytes.subarray(offset, min(offset + CHUNK_BYTES, length))`, feeding
// non-zero-`byteOffset` views into the exo-stream wire boundary for any
// payload larger than one 48 KiB chunk. A single-chunk fixture never crosses
// that boundary, so exercise it over generated payloads that span many chunks
// (up to ~3× CHUNK_BYTES) and confirm the drained bytes round-trip exactly —
// which would fail if a windowed slice leaked a pooled buffer's neighbouring
// bytes or dropped the final short chunk.
test('blobFromBytes round-trips arbitrary multi-chunk payloads', async t => {
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 150_000 }), async sample => {
      const blob = blobFromBytes(Promise.resolve(sample));
      /** @type {number[]} */
      const recovered = [];
      for await (const chunk of iterateBytesReader(/** @type {any} */ (blob))) {
        recovered.push(...chunk);
      }
      t.deepEqual(recovered, [...sample]);
    }),
    { numRuns: 200 },
  );
});
